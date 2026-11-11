import {mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {temperatureCapability} from './model-temperature.mjs';
import {fillOfficialPricing, normalizePricing, officialPricingFor, PRICING_SCHEMA_VERSION} from './model-pricing.mjs';

export const REASONING_EFFORTS = ['', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const validEffort = value => typeof value === 'string' && (value === '' || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(value));
const apis = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
const workers = new Set(['emotion_update', 'env_update', 'work_memory_convolution', 'memory_dream', 'persona_dream', 'dream', 'diary', 'speech', 'associate_memory', 'tone']);
const queues = new Map();
const limit = 2 * 1024 * 1024;
const copy = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fail(message, code = 'PROVIDER_CONFIG_INVALID', status = 400) { throw Object.assign(new Error(message), {code, status}); }
function text(value, name, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${name}无效`);
  return value.trim();
}
function id(value) { const result = text(value, 'Provider ID', 100); if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(result)) fail('Provider ID 无效'); return result; }
function bounded(value) { let encoded; try { encoded = JSON.stringify(value); } catch { fail('配置格式无效'); } if (!encoded || Buffer.byteLength(encoded) > limit) fail('配置过大'); }
function parse(bytes) { try { return JSON.parse(bytes); } catch { fail('模型配置文件 JSON 无效', 'PROVIDER_FILE_INVALID'); } }
function normalizeModels(value, previous = []) {
  if (!Array.isArray(value) || value.length > 500) fail('模型列表无效');
  const seen = new Set();
  return value.map(entry => {
    if (typeof entry === 'string') entry = {id: entry};
    if (!plain(entry)) fail('模型配置无效');
    const model = {id: text(entry.id, '模型 ID', 2048)};
    if (seen.has(model.id)) fail('模型 ID 重复'); seen.add(model.id);
    for (const key of ['name', 'upstreamProvider', 'upstreamModel']) if (entry[key] !== undefined) model[key] = text(entry[key], key);
    if (entry.imageInput !== undefined) {
      if (typeof entry.imageInput !== 'boolean') fail('模型图像能力无效');
      model.imageInput = entry.imageInput;
    }
    if (entry.workerSupported !== undefined) {
      if (typeof entry.workerSupported !== 'boolean') fail('模型 Worker 支持状态无效');
      model.workerSupported = entry.workerSupported;
    }
    for (const key of ['contextWindow', 'maxTokens']) if (entry[key] !== undefined) {
      if (!Number.isSafeInteger(entry[key]) || entry[key] < 1 || entry[key] > 100000000) fail('模型 Token 限制无效');
      model[key] = entry[key];
    }
    if (entry.reasoningEfforts !== undefined) {
      if (!Array.isArray(entry.reasoningEfforts) || entry.reasoningEfforts.length > 50 || entry.reasoningEfforts.some(e => !validEffort(e)) || new Set(entry.reasoningEfforts).size !== entry.reasoningEfforts.length) fail('思考深度列表无效');
      model.reasoningEfforts = [...entry.reasoningEfforts];
    }
    if (entry.input !== undefined) {
      if (!Array.isArray(entry.input) || !entry.input.length || entry.input.some(e => !['text', 'image'].includes(e))) fail('模型输入类型无效');
      model.input = [...new Set(entry.input)];
    }
    if (entry.temperatureSupported !== undefined) {
      if (typeof entry.temperatureSupported !== 'boolean') fail('模型温度支持状态无效');
      model.temperatureSupported = entry.temperatureSupported;
    }
    if (entry.compat !== undefined) {
      if (!plain(entry.compat)) fail('模型兼容能力无效');
      const compat = {};
      for (const key of ['supportsTemperature', 'supportsMidConvoEffort']) if (entry.compat[key] !== undefined) {
        if (typeof entry.compat[key] !== 'boolean') fail('模型温度兼容能力无效');
        compat[key] = entry.compat[key];
      }
      if (Object.keys(compat).length) model.compat = compat;
    }
    const old = previous.find(item => item.id === model.id);
    if (Object.hasOwn(entry, 'pricing')) model.pricing = normalizePricing(entry.pricing);
    else if (old && Object.hasOwn(old, 'pricing')) model.pricing = copy(old.pricing);
    if (model.pricing?.modelId && model.pricing.modelId !== model.id) fail('价格与模型不匹配', 'MODEL_PRICING_INVALID');
    return model;
  });
}
function normalizeProvider(input, previous) {
  if (!plain(input)) fail('Provider 配置无效');
  const p = {...previous, ...input}, result = {id: id(p.id), kind: p.kind, name: text(p.name, 'Provider 名称', 100)};
  if (!['api-key', 'openai-auth', 'dsh'].includes(p.kind)) fail('Provider 类型无效');
  if (previous && previous.kind !== p.kind) fail('不能更改 Provider 类型');
  if (p.kind !== 'api-key' && p.id !== p.kind || p.kind === 'api-key' && ['openai-auth', 'dsh'].includes(p.id)) fail('内置 Provider ID 无效');
  result.models = normalizeModels(p.models ?? [], [...(previous?.models ?? []), ...(previous?.catalogModels ?? [])]);
  result.catalogModels = normalizeModels(previous?.catalogModels ?? p.catalogModels ?? []);
  if (p.kind === 'api-key') {
    result.api = p.api ?? 'openai-completions';
    if (!apis.has(result.api)) fail('API 类型无效');
    if (p.baseURL) {
      result.baseURL = text(p.baseURL, 'API 地址', 2048);
      let url; try { url = new URL(result.baseURL); } catch { fail('API 地址无效'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('API 地址必须是无凭据的 HTTP(S) 地址');
    }
    if (p.apiKey !== undefined) {
      if (typeof p.apiKey !== 'string' || p.apiKey.length > 16384 || /[\r\n\u0000]/u.test(p.apiKey)) fail('API Key 无效');
      result.apiKey = p.apiKey;
    }
    if (p.upstreamProvider !== undefined) result.upstreamProvider = text(p.upstreamProvider, '上游 Provider');
  } else if (Object.hasOwn(input, 'apiKey')) fail('此 Provider 不接受 API Key');
  for (const model of result.models) {
    if (!model.pricing || model.pricing.origin !== 'official-preset') continue;
    if (JSON.stringify(model.pricing) !== JSON.stringify(officialPricingFor(result, model))) {
      model.pricing = {...model.pricing, basis: 'custom', origin: 'custom', userOverride: true};
    }
  }
  // An enabled model and its catalog entry share one user price. Catalog
  // refreshes and deselect/reselect must not restore an upstream default.
  for (const model of result.catalogModels) {
    const configured = result.models.find(item => item.id === model.id) ?? previous?.models.find(item => item.id === model.id);
    if (configured && Object.hasOwn(configured, 'pricing')) model.pricing = copy(configured.pricing);
  }
  return result;
}
function normalizeSelection(value, state, use, {capabilities = true} = {}) {
  if (value === null) return null;
  if (!plain(value)) fail('模型选择无效');
  const selection = {providerId: id(value.providerId), modelId: text(value.modelId, '模型 ID', 2048), reasoningEffort: value.reasoningEffort ?? ''};
  if (!validEffort(selection.reasoningEffort)) fail('思考深度无效');
  // null clears the optional override; absence preserves provider defaults.
  if (value.temperature !== undefined && value.temperature !== null) {
    if (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) fail('温度必须为 0 到 2 的有限数值');
    selection.temperature = value.temperature;
  }
  const provider = state.providers.find(p => p.id === selection.providerId);
  if (!provider) fail('所选 Provider 不存在');
  const model = provider.models.find(m => m.id === selection.modelId);
  if (!model) fail('所选模型不在可用列表中');
  if (capabilities && selection.temperature !== undefined) {
    const capability = temperatureCapability(provider, model, selection);
    if (!capability.supported || selection.temperature > capability.max || selection.temperature < capability.min) fail(capability.reason ?? '该模型不支持所设温度', 'MODEL_TEMPERATURE_UNSUPPORTED');
  }
  if (capabilities && use !== 'conversation' && model.workerSupported === false) fail('该模型不支持 Client Worker 请求', 'WORKER_MODEL_UNSUPPORTED');
  if (capabilities && !REASONING_EFFORTS.includes(selection.reasoningEffort) && !model.reasoningEfforts?.includes(selection.reasoningEffort)) fail('思考深度无效');
  if (capabilities && selection.reasoningEffort && model.reasoningEfforts && !model.reasoningEfforts.includes(selection.reasoningEffort)) fail('模型不支持该思考深度');
  return selection;
}
function validateAssignments(state) {
  // Catalog changes may invalidate capabilities of a saved route. Keep its
  // explicit selection readable; execution and new selections fail closed.
  for (const use of ['conversation', 'tone', 'worker', 'groupScheduler']) state.assignments[use] = normalizeSelection(state.assignments[use], state, use, {capabilities: false});
  for (const [name, selection] of Object.entries(state.assignments.workerOverrides)) {
    if (!workers.has(name) || name === 'tone') fail('Worker 名称无效');
    state.assignments.workerOverrides[name] = normalizeSelection(selection, state, 'worker', {capabilities: false});
  }
}
function publicView(state) {
  return {...copy(state), capabilities: {temperatureV1: true}, providers: state.providers.map(p => { const {apiKey, ...safe} = copy(p); return {...safe, hasApiKey: !!apiKey}; })};
}
function migrate(legacy) {
  const state = {version: 1, pricingSchemaVersion: PRICING_SCHEMA_VERSION, providers: [], assignments: {conversation: null, tone: null, worker: null, groupScheduler: null, workerOverrides: {}}};
  const api = legacy.clientConfig || (!legacy.source || legacy.source === 'client' ? legacy : {});
  const apiIds = [...new Set([api.model, ...(api.models || []).map(m => typeof m === 'string' ? m : m.id)].filter(Boolean))];
  if (apiIds.length || api.apiKey || api.baseURL) state.providers.push(normalizeProvider({id: 'client-api', kind: 'api-key', name: 'Client API', api: api.api || 'openai-completions', ...(api.baseURL ? {baseURL: api.baseURL} : {}), apiKey: api.apiKey, ...(api.provider ? {upstreamProvider: api.provider} : {}), models: apiIds.map(id => ({id, imageInput: !!api.imageModels?.includes(id), input: api.imageModels?.includes(id) ? ['text', 'image'] : ['text']}))}));
  const auth = legacy.source === 'openai-auth' ? legacy : legacy.clientOpenAI || {};
  const dsh = legacy.source === 'dsh' ? legacy : legacy.dshConfig || {};
  state.providers.push(normalizeProvider({id: 'openai-auth', kind: 'openai-auth', name: 'OpenAI 授权', models: auth.model ? [{id: auth.model}] : []}));
  const dshId = dsh.model ? `${encodeURIComponent(dsh.provider || 'deepseek-official')}::${encodeURIComponent(dsh.model)}` : null;
  state.providers.push(normalizeProvider({id: 'dsh', kind: 'dsh', name: 'DeepSeek Harness', models: dshId ? [{id: dshId, upstreamProvider: dsh.provider || 'deepseek-official', upstreamModel: dsh.model}] : []}));
  const selection = (providerId, value) => value.model ? {providerId, modelId: value.model, reasoningEffort: REASONING_EFFORTS.includes(value.reasoningEffort) ? value.reasoningEffort : ''} : null;
  state.assignments.conversation = legacy.source === 'dsh' ? selection('dsh', {...dsh, model: dshId}) : legacy.source === 'openai-auth' ? selection('openai-auth', auth) : selection('client-api', api);
  const client = legacy.source === 'openai-auth' || legacy.clientSource === 'openai-auth' ? selection('openai-auth', auth) : legacy.clientSource === 'client' || api.model && api.apiKey ? selection('client-api', api) : selection('openai-auth', auth);
  state.assignments.tone = copy(client); state.assignments.worker = copy(client);
  for (const provider of state.providers) fillOfficialPricing(provider);
  validateAssignments(state);
  return state;
}

// All registry instances for one path share a queue. The server is the sole
// writer; callers use expectedVersion to reject stale UI drafts.
export function createProviderRegistry({dataDir} = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('dataDir is required');
  const file = path.resolve(dataDir, 'model-providers.json');
  const serial = action => {
    const task = (queues.get(file) || Promise.resolve()).then(action);
    const tail = task.catch(() => {}); queues.set(file, tail);
    void tail.then(() => { if (queues.get(file) === tail) queues.delete(file); });
    return task;
  };
  async function persist(state) {
    bounded(state); await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(state, null, 2), {mode: 0o600, flag: 'wx'}); await rename(temp, file); }
    finally { await rm(temp, {force: true}); }
  }
  async function load() {
    try {
      const bytes = await readFile(file, 'utf8'); if (Buffer.byteLength(bytes) > limit) fail('配置文件过大');
      const state = parse(bytes);
      if (!plain(state) || !Number.isSafeInteger(state.version) || state.version < 1 || !Array.isArray(state.providers) || state.providers.length > 52 || !plain(state.assignments) || !plain(state.assignments.workerOverrides)) fail('配置文件格式无效');
      if (!Object.hasOwn(state.assignments, 'groupScheduler')) state.assignments.groupScheduler = null;
      state.providers = state.providers.map(p => normalizeProvider(p));
      validateProviders(state); validateAssignments(state);
      if (state.pricingSchemaVersion !== undefined && state.pricingSchemaVersion !== PRICING_SCHEMA_VERSION) fail('模型价格配置版本不支持');
      if (state.pricingSchemaVersion === undefined) {
        for (const provider of state.providers) fillOfficialPricing(provider);
        state.pricingSchemaVersion = PRICING_SCHEMA_VERSION;
        if (state.version === Number.MAX_SAFE_INTEGER) fail('模型配置版本无效');
        state.version++; await persist(state);
      }
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      let legacy = {}; try { const bytes = await readFile(path.join(dataDir, 'runtime-model.json'), 'utf8'); if (Buffer.byteLength(bytes) > limit) fail('旧配置文件过大'); legacy = parse(bytes); if (!plain(legacy)) fail('旧配置文件格式无效'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const state = migrate(legacy); await persist(state); return state;
    }
  }
  function validateProviders(state) {
    if (state.providers.length > 52) fail('Provider 数量不能超过 52');
    if (new Set(state.providers.map(p => p.id)).size !== state.providers.length) fail('Provider ID 重复');
    if (new Set(state.providers.map(p => p.name.normalize('NFKC').toLowerCase())).size !== state.providers.length) fail('Provider 名称重复');
  }
  const mutate = (input, change) => serial(async () => {
    bounded(input); const state = await load();
    if (input?.expectedVersion !== undefined && input.expectedVersion !== state.version) fail('配置已更新，请重新加载', 'PROVIDER_VERSION_CONFLICT', 409);
    await change(state);
    for (const provider of state.providers) fillOfficialPricing(provider);
    validateProviders(state); validateAssignments(state);
    state.version++; await persist(state); return publicView(state);
  });
  return {
    publicState: () => serial(async () => publicView(await load())),
    internalState: () => serial(async () => copy(await load())),
    saveProvider: input => mutate(input, state => {
      if (!plain(input)) fail('Provider 配置无效');
      const providerId = input.id === undefined ? `api-${randomUUID()}` : id(input.id);
      const index = state.providers.findIndex(p => p.id === providerId), previous = state.providers[index];
      const provider = normalizeProvider({...input, id: providerId, kind: input.kind ?? previous?.kind ?? 'api-key'}, previous);
      if (index < 0) state.providers.push(provider); else state.providers[index] = provider;
    }),
    deleteProvider: (providerId, options = {}) => mutate(options, state => {
      id(providerId); if (['dsh', 'openai-auth'].includes(providerId)) fail('不能删除内置 Provider');
      if (!state.providers.some(p => p.id === providerId)) fail('Provider 不存在', 'PROVIDER_NOT_FOUND', 404);
      state.providers = state.providers.filter(p => p.id !== providerId);
    }),
    saveAssignments: input => mutate(input, state => {
      if (!plain(input)) fail('模型分配无效');
      const assignments = input.assignments ?? input;
      if (!plain(assignments)) fail('模型分配无效');
      for (const use of ['conversation', 'tone', 'worker', 'groupScheduler']) if (Object.hasOwn(assignments, use)) state.assignments[use] = normalizeSelection(assignments[use], state, use);
      if (Object.hasOwn(assignments, 'workerOverrides')) {
        if (!plain(assignments.workerOverrides) || Object.keys(assignments.workerOverrides).length > workers.size) fail('Worker 覆盖配置无效');
        for (const [name, selection] of Object.entries(assignments.workerOverrides)) {
          if (!workers.has(name) || name === 'tone') fail('Worker 名称无效');
          if (selection === null) delete state.assignments.workerOverrides[name];
          else state.assignments.workerOverrides[name] = normalizeSelection(selection, state, 'worker');
        }
      }
    }),
    updateCatalog: (providerId, models, options = {}) => mutate({...options, models}, state => {
      const provider = state.providers.find(p => p.id === providerId);
      if (!provider) fail('Provider 不存在', 'PROVIDER_NOT_FOUND', 404);
      const previous = provider.catalogModels;
      // Catalog responses are capability metadata, never a source of user
      // price overrides (even when called directly without the service).
      provider.catalogModels = normalizeModels(models.map(entry => {
        if (!plain(entry)) return entry;
        const {pricing, ...metadata} = entry; return metadata;
      }), previous);
      for (const model of provider.catalogModels) {
        const configured = provider.models.find(item => item.id === model.id);
        if (configured && Object.hasOwn(configured, 'pricing')) model.pricing = copy(configured.pricing);
      }
      const catalog = new Map(provider.catalogModels.map(model => [model.id, model]));
      for (const model of provider.models) {
        const latest = catalog.get(model.id); if (!latest) continue;
        for (const key of ['reasoningEfforts', 'input', 'imageInput', 'workerSupported', 'contextWindow', 'maxTokens', 'temperatureSupported', 'compat']) {
          if (Object.hasOwn(latest, key)) model[key] = copy(latest[key]);
        }
      }
    }),
    resolve: (use, name) => serial(async () => {
      if (!['conversation', 'tone', 'worker', 'groupScheduler'].includes(use)) fail('模型用途无效');
      if (name !== undefined && (use !== 'worker' || !workers.has(name) || name === 'tone')) fail('Worker 名称无效');
      const state = await load(), selected = use === 'worker' && name ? state.assignments.workerOverrides[name] ?? state.assignments.worker : use === 'groupScheduler' ? state.assignments.groupScheduler ?? state.assignments.worker : state.assignments[use];
      if (!selected) fail('尚未设置模型', 'MODEL_NOT_CONFIGURED');
      const selection = normalizeSelection(selected, state, use);
      const provider = state.providers.find(p => p.id === selection.providerId);
      return copy({provider, selection, model: provider.models.find(m => m.id === selection.modelId), revision:state.version});
    }),
  };
}
