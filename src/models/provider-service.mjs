const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (message, code = 'MODEL_PROVIDER_UNAVAILABLE', status = 503) => Object.assign(new Error(message), {code, status});
const identifier = value => typeof value === 'string' && value.trim() && value.length <= 300 && !/[\u0000-\u001f\u007f]/u.test(value);
function modelMetadata(model) {
  if (!plain(model) || !identifier(model.id)) throw failure('模型目录格式无效', 'MODEL_CATALOG_INVALID', 502);
  const result = {id: model.id};
  if (identifier(model.name)) result.name = model.name;
  const efforts = model.reasoningEfforts ?? model.reasoning?.efforts?.map(e => e.id);
  if (Array.isArray(efforts)) result.reasoningEfforts = [...new Set(efforts.filter(e => typeof e === 'string' && (e === '' || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(e))))];
  for (const field of ['contextWindow', 'maxTokens']) if (Number.isSafeInteger(model[field]) && model[field] > 0 && model[field] <= 100000000) result[field] = model[field];
  if (Array.isArray(model.input)) {
    const input = [...new Set(model.input.filter(type => ['text', 'image'].includes(type)))];
    if (input.length) result.input = input;
  }
  if (typeof model.imageInput === 'boolean') result.imageInput = model.imageInput;
  else if (result.input) result.imageInput = result.input.includes('image');
  return result;
}
function catalogModels(catalog, kind) {
  if (!plain(catalog) || !Array.isArray(catalog.providers) || catalog.providers.length > 200) throw failure('模型目录格式无效', 'MODEL_CATALOG_INVALID', 502);
  const models = [], ids = new Set();
  for (const provider of catalog.providers) {
    if (!plain(provider) || !identifier(provider.id) || !Array.isArray(provider.models)) throw failure('模型目录格式无效', 'MODEL_CATALOG_INVALID', 502);
    if (kind === 'dsh' && provider.id.startsWith('suna-')) continue;
    if (kind === 'openai-auth' && !['openai', 'suna-openai'].includes(provider.id)) continue;
    for (const entry of provider.models) {
      const model = modelMetadata(entry);
      if (kind === 'dsh') Object.assign(model, {id: `${encodeURIComponent(provider.id)}::${encodeURIComponent(entry.id)}`, upstreamProvider: provider.id, upstreamModel: entry.id});
      if (ids.has(model.id)) continue;
      ids.add(model.id); models.push(model);
      if (models.length > 500) throw failure('模型目录过大', 'MODEL_CATALOG_INVALID', 502);
    }
  }
  return models;
}
function runtimeError(error, fallback) {
  if (error?.code === 'MODEL_PROVIDERS_BUSY') return failure('模型正在使用中，请稍后修改', error.code, 409);
  return failure(fallback);
}

export function createModelProviderService({registry, runtime} = {}) {
  if (!registry) throw new Error('registry is required');
  async function available() {
    try { const health = await runtime?.health?.(); return !!(health?.bundled || health?.mode === 'external' && health?.version); } catch { return false; }
  }
  async function enrich(saved) {
    const dshAvailable = await available();
    return {...saved, providers: saved.providers.map(provider => ({...provider, available: provider.kind === 'dsh' ? dshAvailable : true}))};
  }
  async function state() { return enrich(await registry.publicState()); }
  async function configure(action) {
    if (typeof runtime?.configureModelProviders !== 'function') return enrich(await action());
    let registryFailure, committed = false;
    try {
      const saved = await runtime.configureModelProviders(async () => {
        try { const result = await action(); committed = true; return result; } catch (error) { registryFailure = error; throw error; }
      });
      return enrich(saved);
    } catch (error) {
      if (registryFailure === error) throw error;
      throw runtimeError(error, committed ? '模型配置已提交，但运行时无法应用，请检查运行时状态' : '无法修改模型配置，请检查运行时状态');
    }
  }
  return {
    state,
    saveProvider: body => configure(() => registry.saveProvider(body)),
    deleteProvider: body => configure(() => registry.deleteProvider(body?.id, {expectedVersion: body?.expectedVersion})),
    saveAssignments: body => configure(() => registry.saveAssignments(body)),
    async catalog({id, expectedVersion} = {}) {
      const saved = await registry.publicState(), provider = saved.providers.find(item => item.id === id);
      if (expectedVersion !== undefined && expectedVersion !== saved.version) throw failure('配置已更新，请重新加载', 'PROVIDER_VERSION_CONFLICT', 409);
      if (!provider) throw failure('Provider 不存在', 'PROVIDER_NOT_FOUND', 404);
      if (provider.kind === 'api-key') throw failure('API Key Provider 的模型列表需手动设置', 'MODEL_CATALOG_UNSUPPORTED', 400);
      if (provider.kind === 'dsh' && !await available() || typeof runtime?.modelCatalog !== 'function') throw failure('模型目录不可用');
      let catalog;
      try { catalog = await runtime.modelCatalog(provider.kind); } catch (error) { throw runtimeError(error, '无法读取模型目录，请检查连接与授权'); }
      const models = catalogModels(catalog, provider.kind);
      if (provider.kind === 'dsh') {
        let next = 0;
        await Promise.all(Array.from({length: Math.min(4, models.length)}, async () => {
          while (next < models.length) {
            const model = models[next++]; model.workerSupported = false;
            if (typeof runtime.getClientModelConfig === 'function') try {
              const config = await runtime.getClientModelConfig({provider: model.upstreamProvider, model: model.upstreamModel});
              model.workerSupported = !!config;
            } catch {}
          }
        }));
      }
      return enrich(await registry.updateCatalog(id, models, {expectedVersion: saved.version}));
    },
    async openaiAuth(body) {
      if (typeof runtime?.openaiAuth !== 'function') throw failure('OpenAI 授权不可用');
      let result;
      try { result = await runtime.openaiAuth(body); } catch (error) { throw runtimeError(error, 'OpenAI 授权失败，请检查运行时状态'); }
      if (!plain(result)) throw failure('OpenAI 授权状态无效');
      const safe = {authorized: result.authorized === true};
      if (typeof result.status === 'string' && ['idle', 'stored', 'pending', 'completed', 'failed', 'canceled', 'cancelled'].includes(result.status)) safe.status = result.status;
      for (const field of ['id', 'userCode']) if (typeof result[field] === 'string' && result[field].length <= 16000) safe[field] = result[field];
      if (plain(result.prompt)) {
        safe.prompt = {};
        for (const field of ['message', 'placeholder', 'type']) if (typeof result.prompt[field] === 'string' && result.prompt[field].length <= 16000) safe.prompt[field] = result.prompt[field];
      }
      if (typeof result.url === 'string') {
        try { const url = new URL(result.url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) safe.url = url.href; } catch {}
      }
      if (result.error) safe.error = 'OpenAI 授权失败，请重试';
      return safe;
    },
  };
}
