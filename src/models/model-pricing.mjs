import {createHash} from 'node:crypto';
import {OPENAI_PRICE_ROWS, OFFICIAL_PRICES_VERIFIED_AT} from './official-model-prices.mjs';

export const PRICING_SCHEMA_VERSION = 1;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const copy = value => structuredClone(value);
const own = (value, key) => Object.hasOwn(value, key);
const fields = new Set(['schemaVersion', 'basis', 'basisLabel', 'currency', 'unitTokens', 'inputPer1M', 'cacheReadPer1M', 'cacheWritePer1M', 'outputPer1M', 'serviceTier', 'cacheWriteDefaultTTL', 'contextRule', 'source', 'supportingSources', 'verifiedAt', 'effectiveFrom', 'reviewAfter', 'origin', 'userOverride', 'modelId', 'providerBrand']);
function invalid() { throw Object.assign(new Error('模型价格配置无效'), {code: 'MODEL_PRICING_INVALID', status: 400}); }
function keys(value, allowed) { if (!plain(value) || Object.keys(value).some(key => !allowed.has(key))) invalid(); }
function rate(value) { if (value === undefined || value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) invalid(); return value; }
function date(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) invalid();
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function source(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 2048) invalid();
  let url; try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) invalid();
  return url.href;
}
function nullableEnum(value, allowed, fallback = null) { if (value === undefined) return fallback; if (value === null || allowed.includes(value)) return value; invalid(); }

// An explicit null means unconfigured and deliberately suppresses automatic
// defaults. Unknown fields are rejected, so no credentials can ride a snapshot.
export function normalizePricing(value) {
  if (value === null || value === undefined) return null;
  keys(value, fields);
  if (value.schemaVersion !== undefined && value.schemaVersion !== PRICING_SCHEMA_VERSION) invalid();
  if (value.unitTokens !== undefined && value.unitTokens !== 1000000) invalid();
  if (value.currency !== undefined && value.currency !== null && (typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency))) invalid();
  if (value.basisLabel !== undefined && value.basisLabel !== 'API 参考估算') invalid();
  if (value.userOverride !== undefined && typeof value.userOverride !== 'boolean') invalid();
  const write = value.cacheWritePer1M ?? {};
  keys(write, new Set(['30m', '12h']));
  let contextRule = null;
  if (value.contextRule !== undefined && value.contextRule !== null) {
    const c = value.contextRule;
    keys(c, new Set(['inputTokensAbove', 'appliesTo', 'inputMultiplier', 'cacheReadMultiplier', 'cacheWriteMultiplier', 'outputMultiplier']));
    if (!Number.isSafeInteger(c.inputTokensAbove) || c.inputTokensAbove < 0 || c.inputTokensAbove > 1e8 || c.appliesTo !== 'full-request') invalid();
    contextRule = {inputTokensAbove: c.inputTokensAbove, appliesTo: 'full-request', inputMultiplier: rate(c.inputMultiplier), cacheReadMultiplier: rate(c.cacheReadMultiplier), cacheWriteMultiplier: rate(c.cacheWriteMultiplier), outputMultiplier: rate(c.outputMultiplier)};
  }
  if (value.supportingSources !== undefined && (!Array.isArray(value.supportingSources) || value.supportingSources.length > 10)) invalid();
  const result = {
    schemaVersion: PRICING_SCHEMA_VERSION,
    basis: nullableEnum(value.basis, ['official-api-reference', 'custom'], 'custom'),
    basisLabel: 'API 参考估算', currency: value.currency ?? null, unitTokens: 1000000,
    inputPer1M: rate(value.inputPer1M), cacheReadPer1M: rate(value.cacheReadPer1M),
    cacheWritePer1M: {'30m': rate(write['30m']), '12h': rate(write['12h'])}, outputPer1M: rate(value.outputPer1M),
    serviceTier: nullableEnum(value.serviceTier, ['standard', 'fast', 'batch', 'flex', 'ultrafast']),
    cacheWriteDefaultTTL: nullableEnum(value.cacheWriteDefaultTTL, ['30m', '12h']),
    contextRule, source: source(value.source), supportingSources: (value.supportingSources ?? []).map(source),
    verifiedAt: date(value.verifiedAt), effectiveFrom: date(value.effectiveFrom), reviewAfter: date(value.reviewAfter),
    origin: nullableEnum(value.origin, ['official-preset', 'custom'], 'custom'), userOverride: value.userOverride ?? true,
  };
  for (const field of ['modelId', 'providerBrand']) if (value[field] !== undefined) {
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 2048 || /[\u0000-\u001f\u007f]/u.test(value[field])) invalid();
    result[field] = value[field];
  }
  return result;
}

function isOfficialOpenAI(provider) {
  if (provider?.kind === 'openai-auth') return true;
  if (provider?.kind !== 'api-key' || typeof provider.baseURL !== 'string' || !['openai-completions', 'openai-responses'].includes(provider.api ?? 'openai-completions')) return false;
  try {
    const url = new URL(provider.baseURL);
    return url.protocol === 'https:' && url.hostname === 'api.openai.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && ['/', '/v1', '/v1/'].includes(url.pathname);
  } catch { return false; }
}

export function officialPricingFor(provider, model) {
  const modelId = typeof model === 'string' ? model : model?.id;
  if (!isOfficialOpenAI(provider)) return null;
  const row = OPENAI_PRICE_ROWS.find(item => item[0] === modelId);
  if (!row) return null;
  const [, input, read, write30m, write12h, output] = row, legacy = modelId.startsWith('gpt-5.6-');
  return normalizePricing({schemaVersion: 1, modelId, providerBrand: 'openai', basis: 'official-api-reference', currency: 'USD', unitTokens: 1000000,
    inputPer1M: input, cacheReadPer1M: read, cacheWritePer1M: {'30m': write30m, '12h': write12h}, outputPer1M: output,
    serviceTier: 'standard', cacheWriteDefaultTTL: '30m',
    contextRule: {inputTokensAbove: 272000, appliesTo: 'full-request', inputMultiplier: 2, cacheReadMultiplier: legacy ? null : 2, cacheWriteMultiplier: legacy ? null : 2, outputMultiplier: 1.5},
    source: `https://developers.openai.com/api/docs/models/${modelId}`, supportingSources: ['https://developers.openai.com/api/docs/pricing', 'https://developers.openai.com/api/docs/guides/prompt-caching'],
    verifiedAt: OFFICIAL_PRICES_VERIFIED_AT, effectiveFrom: null, reviewAfter: modelId === 'gpt-5.6-sol' ? '2026-11-21' : null,
    origin: 'official-preset', userOverride: false});
}

export function fillOfficialPricing(provider) {
  let changed = false;
  for (const list of ['models', 'catalogModels']) for (const model of provider[list] ?? []) {
    if (own(model, 'pricing')) continue;
    const pricing = officialPricingFor(provider, model);
    if (pricing) { model.pricing = pricing; changed = true; }
  }
  return changed;
}

const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function normalizeUsage(value, format) {
  const u = plain(value) ? value : {}, observed = Array.isArray(u.observedFields) ? new Set(u.observedFields) : null;
  const get = key => observed && !observed.has(key) ? null : count(u[key]);
  const result = {input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, cacheWrite30m: null, cacheWrite12h: null, totalInput: null, invalidFields: []};
  if (format === 'openai') {
    const details = plain(u.input_tokens_details) ? u.input_tokens_details : {}, split = plain(details.cache_write_tokens_details) ? details.cache_write_tokens_details : {};
    result.totalInput = count(u.input_tokens); result.cacheRead = count(details.cached_tokens); result.cacheWrite = count(details.cache_write_tokens);
    result.cacheWrite30m = count(split.ttl_30m_tokens); result.cacheWrite12h = count(split.ttl_12h_tokens);
    result.output = count(u.output_tokens); result.reasoning = count(u.output_tokens_details?.reasoning_tokens);
    if (result.totalInput !== null && result.cacheRead !== null && result.cacheWrite !== null) {
      if (result.totalInput >= result.cacheRead + result.cacheWrite) result.input = result.totalInput - result.cacheRead - result.cacheWrite;
      else { result.invalidFields.push('usage.inputCategories'); result.cacheRead = null; result.cacheWrite = null; result.cacheWrite30m = null; result.cacheWrite12h = null; }
    }
  } else {
    for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'cacheWrite30m', 'cacheWrite12h']) result[key] = get(key);
    if (result.input !== null && result.cacheRead !== null && result.cacheWrite !== null) {
      result.totalInput = count(result.input + result.cacheRead + result.cacheWrite);
      if (get('totalInput') !== null && result.totalInput !== get('totalInput')) result.invalidFields.push('usage.totalInput');
    }
    else result.totalInput = get('totalInput');
  }
  return result;
}
const rounded = value => Math.round(value * 1e12) / 1e12;

// This estimates model token costs only. It never reports a subscription debit
// or a provider invoice. Missing usage is not silently converted into free use.
export function estimateCall({usage, pricing, providerKind, modelId, usageFormat = 'pi', cacheWriteTTL} = {}) {
  const u = normalizeUsage(usage, usageFormat), missing = new Set(u.invalidFields);
  // Early stream observations may contain every numeric counter while still
  // omitting the terminal billable usage. Preserve their known subtotal only.
  if (['partial', 'unknown'].includes(usage?.coverage)) missing.add('usage.final');
  let p; try { p = normalizePricing(pricing); } catch { p = null; }
  if (p?.modelId && p.modelId !== modelId) p = null;
  const billingMode = providerKind === 'openai-auth' ? 'subscription-reference' : 'api-estimate';
  const result = {amount: null, knownSubtotal: null, currency: p?.currency ?? null, status: 'unconfigured', coverage: 'unknown',
    billingMode, kind: providerKind === 'openai-auth' ? 'api-equivalent' : 'api-estimate', basis: p?.basis ?? null, basisLabel: 'API 参考估算',
    pricingSnapshot: p ? copy(p) : null, pricingRevision: p ? createHash('sha256').update(JSON.stringify(p)).digest('hex') : null,
    missingFields: [], usage: u, contextTier: null, components: {input: null, cacheRead: null, cacheWrite: null, output: null}};
  if (!p || !p.currency || ![p.inputPer1M, p.cacheReadPer1M, p.cacheWritePer1M['30m'], p.cacheWritePer1M['12h'], p.outputPer1M].some(value => value !== null)) {
    result.missingFields = ['pricing', ...['input', 'cacheRead', 'cacheWrite', 'output'].filter(key => u[key] === null).map(key => `usage.${key}`), ...missing]; return result;
  }
  const c = p.contextRule;
  result.contextTier = !c ? 'flat' : u.totalInput === null ? 'unknown' : u.totalInput > c.inputTokensAbove ? 'long' : 'short';
  if (result.contextTier === 'unknown') missing.add('usage.totalInput');
  if (p.serviceTier === null) missing.add('pricing.serviceTier');
  function effectiveRate(base, multiplier) {
    if (base === null) return null;
    if (base === 0 || !c || result.contextTier === 'short') return base;
    if (result.contextTier === 'unknown') return multiplier === 1 ? base : null;
    return multiplier === null ? null : base * multiplier;
  }
  let subtotal = 0, known = 0;
  function add(component, tokens, price) {
    if (tokens === null) {
      if (price === 0) { result.components[component] = (result.components[component] ?? 0); known++; return; }
      missing.add(`usage.${component}`); return;
    }
    if (tokens === 0) { result.components[component] = (result.components[component] ?? 0); known++; return; }
    if (price === null) { missing.add(`pricing.${component}`); return; }
    const amount = tokens * price / p.unitTokens;
    subtotal += amount; known++; result.components[component] = rounded((result.components[component] ?? 0) + amount);
  }
  add('input', u.input, effectiveRate(p.inputPer1M, c?.inputMultiplier));
  add('cacheRead', u.cacheRead, effectiveRate(p.cacheReadPer1M, c?.cacheReadMultiplier));
  add('output', u.output, effectiveRate(p.outputPer1M, c?.outputMultiplier));
  const write30 = effectiveRate(p.cacheWritePer1M['30m'], c?.cacheWriteMultiplier), write12 = effectiveRate(p.cacheWritePer1M['12h'], c?.cacheWriteMultiplier);
  let w30 = u.cacheWrite30m, w12 = u.cacheWrite12h;
  const invalidWriteSplit = u.cacheWrite !== null && (w30 !== null && w30 > u.cacheWrite || w12 !== null && w12 > u.cacheWrite || w30 !== null && w12 !== null && w30 + w12 !== u.cacheWrite);
  if (invalidWriteSplit) { missing.add('usage.cacheWriteTTL'); }
  else if (u.cacheWrite === 0) { w30 = 0; w12 = 0; }
  else if (u.cacheWrite !== null && w30 !== null && w12 === null && w30 <= u.cacheWrite) w12 = u.cacheWrite - w30;
  else if (u.cacheWrite !== null && w12 !== null && w30 === null && w12 <= u.cacheWrite) w30 = u.cacheWrite - w12;
  if (invalidWriteSplit) { /* Do not price a contradictory provider breakdown. */ }
  else if (w30 !== null && w12 !== null && (u.cacheWrite === null || w30 + w12 === u.cacheWrite)) {
    add('cacheWrite', w30, write30); add('cacheWrite', w12, write12);
  } else if (w30 !== null || w12 !== null) missing.add('usage.cacheWriteTTL');
  else {
    const ttl = cacheWriteTTL === undefined ? p.cacheWriteDefaultTTL : cacheWriteTTL;
    if (ttl === '30m') add('cacheWrite', u.cacheWrite, write30);
    else if (ttl === '12h') add('cacheWrite', u.cacheWrite, write12);
    else if (write30 === write12 && write30 !== null) add('cacheWrite', u.cacheWrite, write30);
    else missing.add('usage.cacheWriteTTL');
  }
  result.knownSubtotal = known ? rounded(subtotal) : null;
  result.missingFields = [...missing]; result.status = missing.size ? 'partial' : 'complete'; result.coverage = result.status;
  if (result.status === 'complete') result.amount = rounded(subtotal);
  return result;
}
export const estimateModelCost = estimateCall;

export function summarizeEstimates(calls = []) {
  const currencies = new Map(); let unpricedCallCount = 0, partialCallCount = 0, missingUsageCallCount = 0;
  for (const item of calls) {
    const estimate = item?.estimate ?? item;
    if (!estimate || estimate.status === 'unconfigured') unpricedCallCount++;
    else if (estimate.status !== 'complete') partialCallCount++;
    if (estimate?.missingFields?.some(field => field.startsWith('usage.'))) missingUsageCallCount++;
    if (typeof estimate?.currency !== 'string' || !/^[A-Z]{3}$/u.test(estimate.currency) || typeof estimate.knownSubtotal !== 'number' || !Number.isFinite(estimate.knownSubtotal) || estimate.knownSubtotal < 0) continue;
    const row = currencies.get(estimate.currency) ?? {currency: estimate.currency, knownSubtotal: 0, callCount: 0};
    row.knownSubtotal += estimate.knownSubtotal; row.callCount++; currencies.set(row.currency, row);
  }
  const byCurrency = [...currencies.values()].map(row => ({...row, knownSubtotal: rounded(row.knownSubtotal)}));
  const status = unpricedCallCount === calls.length && calls.length ? 'unconfigured' : unpricedCallCount || partialCallCount ? 'partial' : 'complete';
  return {status, byCurrency, amount: status === 'complete' && byCurrency.length === 1 ? byCurrency[0].knownSubtotal : null,
    currency: byCurrency.length === 1 ? byCurrency[0].currency : null, unpricedCallCount, partialCallCount, missingUsageCallCount, callCount: calls.length};
}
