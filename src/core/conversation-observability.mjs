import {usageDashboard} from './usage-dashboard.mjs';
// This ledger contains structured facts only. It is independent of the bounded
// diagnostic log and never accepts prompts, tool arguments, credentials or raw events.
import {normalizePricing} from '../models/model-pricing.mjs';
const fields = ['input', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'cacheWrite30m', 'cacheWrite12h', 'output', 'reasoning', 'total'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value, max = 300) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
const redactText=value=>value
  .replace(/\b(?:Bearer|Basic)\s+\S+|\bsk-[\w-]{12,}\b/gi,'[已隐藏]')
  // Quoted values are consumed before their surrounding whitespace can be
  // normalized or truncated. This is intentionally log-only sanitization.
  .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|token|password|secret|credential|authorization)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi,'$1[已隐藏]')
  .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[已隐藏]@')
  .replace(/([?&](?:token|key|secret|password|access_token|refresh_token|api_key|credential)=)[^\s&]+/gi,'$1[已隐藏]');
const safeText = (value, max = 300) => {
  const result = text(value, max);
  return result === null ? null : redactText(result);
};
const summaryText=value=>typeof value==='string'?redactText(value).replace(/\s+/gu,' ').trim().slice(0,500):null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const sources = new Set(['provider', 'derived-provider', 'adapter', 'unavailable']);
const identity = ['conversationId', 'characterId', 'runId', 'triggerId', 'roundId', 'taskId', 'stage', 'sessionId', 'attemptId', 'compactionId'];
const aliases = {input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadTokens', cacheWrite: 'cacheWriteTokens', cacheWrite1h: 'cacheWrite1hTokens', cacheWrite30m: 'cacheWrite30mTokens', cacheWrite12h: 'cacheWrite12hTokens', reasoning: 'reasoningTokens', total: 'totalTokens'};

export function normalizeUsage(value, options = {}) {
  value = value && typeof value === 'object' ? value : {};
  const supplied = options.observedFields ?? value.observedFields;
  const observed = Array.isArray(supplied) ? new Set(supplied.map(key => fields.includes(key) ? key : Object.keys(aliases).find(name => aliases[name] === key)).filter(Boolean)) : null;
  const result = {};
  for (const key of fields) result[key] = observed && !observed.has(key) ? null : count(value[key] ?? value[aliases[key]]);
  const input = ['input', 'cacheRead', 'cacheWrite'].map(key => result[key]);
  const issues=Array.isArray(value.issues)?value.issues.filter(issue=>issue==='total-mismatch'):[];
  if(result.total!==null&&input.every(value=>value!==null)&&result.output!==null&&result.total!==input.reduce((sum,value)=>sum+value,result.output)){result.total=null;issues.push('total-mismatch');}
  let derived = false;
  if (!issues.length && result.total === null && input.every(value => value !== null) && result.output !== null) {
    const total = input.reduce((sum, value) => sum + value, result.output);
    if (Number.isSafeInteger(total)) { result.total = total; derived = true; }
  }
  if (result.reasoning !== null && result.output !== null && result.reasoning > result.output) result.reasoning = null;
  if (result.cacheWrite1h !== null && result.cacheWrite !== null && result.cacheWrite1h > result.cacheWrite) result.cacheWrite1h = null;
  const known = fields.filter(key => result[key] !== null);
  const source = options.source ?? value.source;
  result.source = known.length ? derived ? 'derived-provider' : sources.has(source) && source !== 'unavailable' ? source : 'adapter' : 'unavailable';
  result.observedFields = known.filter(key => !(derived && key === 'total'));
  result.coverage = !known.length ? 'unknown' : ['input', 'cacheRead', 'cacheWrite', 'output', 'total'].every(key => result[key] !== null) ? 'complete' : 'partial';
  if(known.length&&value.coverage==='partial')result.coverage='partial';
  if(issues.length)result.issues=[...new Set(issues)];
  return result;
}

function timing(value = {}) {
  return {...Object.fromEntries(['ttftMs', 'generationMs', 'totalMs', 'tps'].map(key => [key, positive(value?.[key])])), scope: safeText(value?.scope, 100)};
}
function cost(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    amount: positive(value.amount), knownSubtotal: positive(value.knownSubtotal), currency: /^[A-Z]{3}$/.test(value.currency) ? value.currency : null,
    status: ['complete', 'partial', 'unconfigured'].includes(value.status) ? value.status : 'unconfigured',
    coverage: ['complete', 'partial', 'unknown'].includes(value.coverage) ? value.coverage : 'unknown',
    billingMode: ['subscription-reference', 'api-estimate'].includes(value.billingMode) ? value.billingMode : 'api-estimate',
    basis: ['official-api-reference', 'custom'].includes(value.basis) ? value.basis : null,
    basisLabel: safeText(value.basisLabel, 100),
    missingFields: Array.isArray(value.missingFields) ? value.missingFields.map(value => safeText(value, 100)).filter(Boolean).slice(0, 30) : [],
    // The normalized model price is copied by the trusted caller at dispatch.
    // An optional module-level sanitizer prevents arbitrary extension data here.
    pricingRevision: safeText(value.pricingRevision ?? value.pricingSnapshot?.revision, 200),
  };
}
function base(record, clock, allowUnscoped = false) {
  const id = text(record?.id, 1000), conversationId = text(record?.conversationId, 300);
  if (!id || !conversationId && !allowUnscoped) throw Object.assign(new Error('遥测必须绑定调用与会话'), {code: 'OBSERVABILITY_SCOPE_REQUIRED'});
  return {id, ...Object.fromEntries(identity.map(key => [key, safeText(record[key], key === 'attemptId' ? 500 : 300)])), conversationId,
    time: date(record.finishedAt ?? record.time) ?? date(clock()) ?? new Date().toISOString(),
    dispatchedAt: date(record.dispatchedAt), finishedAt: date(record.finishedAt),
    status: ['running', 'completed', 'failed', 'cancelled', 'canceled', 'timeout', 'interrupted', 'accepted', 'delivered', 'passed', 'rejected', 'unknown'].includes(record.status) ? record.status : 'failed'};
}
export function normalizeCallRecord(record, {clock = () => new Date().toISOString(), sanitizePricing = normalizePricing, allowUnscoped = false} = {}) {
  if (!['client-worker', 'runtime-loop'].includes(record?.category)) throw new TypeError('Invalid model call category');
  const result = {...base(record, clock, allowUnscoped), category: record.category, kind: record.kind === 'compaction' ? 'compaction' : 'model',
    providerId: safeText(record.providerId), upstreamProvider: safeText(record.upstreamProvider), providerKind: ['api-key', 'openai-auth', 'dsh'].includes(record.providerKind) ? record.providerKind : null,
    modelId: safeText(record.modelId, 2048), configuredModelId:safeText(record.configuredModelId,2048), responseModel: safeText(record.responseModel, 2048), reasoningEffort: safeText(record.reasoningEffort, 100), providerThinkingLevel: safeText(record.providerThinkingLevel, 100),
    turn: count(record.turn), step: count(record.step), sessionSequence:count(record.sessionSequence), code: safeText(record.code, 100), usage: normalizeUsage(record.usage), timing: timing(record.timing), estimate: cost(record.estimate)};
  const snapshot=record.pricingSnapshot??record.estimate?.pricingSnapshot;
  result.pricingSnapshot = snapshot && sanitizePricing ? sanitizePricing(snapshot) : null;
  return result;
}
export function normalizeFunctionRecord(record, {clock = () => new Date().toISOString()} = {}) {
  const result = {...base(record, clock), category: 'client-function', kind: record.kind === 'send' ? 'send' : record.kind === 'check' ? 'check' : 'function',
    name: safeText(record.name, 100), code: safeText(record.code, 100), summary: summaryText(record.summary),
    messageId: safeText(record.messageId), receiptStatus: ['accepted', 'sending', 'delivered', 'failed', 'cancelled'].includes(record.receiptStatus) ? record.receiptStatus : null,
    checks: Array.isArray(record.checks) ? record.checks.slice(0, 30).map(check => ({name: safeText(check.name, 100), passed: typeof check.passed === 'boolean' ? check.passed : null})).filter(check => check.name) : [],
    timing: timing(record.timing)};
  return result;
}

function aggregate(calls) {
  const coverage = {complete: 0, partial: 0, unknown: 0}, fieldCoverage = {}, usage = {};
  for (const key of fields) {
    const values = calls.map(call => call.usage[key]).filter(value => value !== null);
    fieldCoverage[key] = {known: values.length, unknown: calls.length - values.length};
    usage[key] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  for (const call of calls) coverage[call.usage.coverage]++;
  const inputCalls = calls.filter(call => ['input', 'cacheRead', 'cacheWrite'].every(key => call.usage[key] !== null));
  const denominator = inputCalls.reduce((sum, call) => sum + call.usage.input + call.usage.cacheRead + call.usage.cacheWrite, 0);
  usage.cacheRate = denominator > 0 ? inputCalls.reduce((sum, call) => sum + call.usage.cacheRead, 0) / denominator : null;
  fieldCoverage.cacheRate = {known: inputCalls.length, unknown: calls.length - inputCalls.length};
  const currencies = new Map(); let pricedCalls = 0;
  for (const call of calls) {
    const item = call.estimate;
    if (!item?.currency || item.knownSubtotal === null && item.amount === null) continue;
    pricedCalls++;
    const group = currencies.get(item.currency) ?? {currency: item.currency, knownSubtotal: 0, amount: 0, completeCalls: 0, partialCalls: 0};
    group.knownSubtotal += item.knownSubtotal ?? item.amount;
    if (item.coverage === 'complete' && item.amount !== null) { group.completeCalls++; if (group.amount !== null) group.amount += item.amount; }
    else { group.partialCalls++; group.amount = null; }
    currencies.set(item.currency, group);
  }
  const unpricedCalls = calls.length - pricedCalls;
  if (unpricedCalls) for (const item of currencies.values()) item.amount = null;
  return {calls: calls.length, usage, usageCoverage: coverage, fieldCoverage,
    cost: {byCurrency: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)), pricedCalls, unpricedCalls,
      coverage: calls.length && !unpricedCalls && [...currencies.values()].every(item => !item.partialCalls) ? 'complete' : pricedCalls ? 'partial' : 'unknown'}};
}

export function createConversationObservability({db, clock = () => new Date().toISOString(), emit = () => {}, isDeveloper = () => false, sanitizePricing = normalizePricing} = {}) {
  if (!db?.prepare || !db?.exec) throw new TypeError('A SQLite database is required');
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_telemetry (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL, category TEXT NOT NULL, round_id TEXT, trigger_id TEXT,
    time TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS conversation_telemetry_scope ON conversation_telemetry(conversation_id,sequence);
    CREATE INDEX IF NOT EXISTS conversation_telemetry_round ON conversation_telemetry(conversation_id,round_id,trigger_id);
    CREATE TABLE IF NOT EXISTS conversation_telemetry_meta (key TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation_telemetry_boundary (conversation_id TEXT PRIMARY KEY,had_prior_activity INTEGER NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO conversation_telemetry_meta(key,payload) VALUES(?,?)').run('tracking', JSON.stringify({schemaVersion: 1, trackingStartedAt: date(clock()) ?? new Date().toISOString()}));
  const tracking = JSON.parse(db.prepare('SELECT payload FROM conversation_telemetry_meta WHERE key=?').get('tracking').payload);
  const developer = () => { if (!isDeveloper()) throw Object.assign(new Error('请先打开开发者模式'), {code: 'DEVELOPER_MODE_REQUIRED', status: 403}); };
  const parse = row => row ? {...JSON.parse(row.payload), sequence: row.sequence} : null;
  function record(value) {
    const previous = parse(db.prepare('SELECT sequence,payload FROM conversation_telemetry WHERE id=?').get(value.id));
    if (previous) {
      if (previous.conversationId !== value.conversationId || previous.category !== value.category || [...identity,'providerId','modelId','configuredModelId'].some(key => previous[key] && value[key] && previous[key] !== value[key])) throw Object.assign(new Error('遥测调用身份冲突'), {code: 'OBSERVABILITY_ID_CONFLICT'});
      // Terminal observations are immutable: reconnect/replay cannot reprice or
      // move a call. A provisional record may settle once under the same id.
      if (previous.status !== 'running' || value.status === 'running') return previous;
      db.prepare('UPDATE conversation_telemetry SET time=?,round_id=?,trigger_id=?,payload=? WHERE id=?').run(value.time, value.roundId, value.triggerId, JSON.stringify(value), value.id);
      const result = {...value, sequence: previous.sequence}; emit({type: 'conversation-observability.changed', conversationId: value.conversationId, sequence: previous.sequence, category: value.category}); return result;
    }
    const result = db.prepare('INSERT INTO conversation_telemetry(id,conversation_id,category,round_id,trigger_id,time,payload) VALUES(?,?,?,?,?,?,?)').run(value.id, value.conversationId, value.category, value.roundId, value.triggerId, value.time, JSON.stringify(value));
    emit({type: 'conversation-observability.changed', conversationId: value.conversationId, sequence: Number(result.lastInsertRowid), category: value.category});
    return {...value, sequence: Number(result.lastInsertRowid)};
  }
  function scoped(options = {}) {
    developer();
    const conversationId = text(options.conversationId, 300);
    if (!conversationId) throw Object.assign(new Error('请选择对话'), {code: 'OBSERVABILITY_SCOPE_REQUIRED', status: 400});
    const where = ['conversation_id=?'], values = [conversationId];
    for (const [key, column] of [['roundId', 'round_id'], ['triggerId', 'trigger_id']]) if (options[key] !== undefined && options[key] !== null) { const value = text(options[key]); if (!value) throw new TypeError('Invalid round filter'); where.push(`${column}=?`); values.push(value); }
    if (options.category !== undefined) { if (!['client-function', 'client-worker', 'runtime-loop'].includes(options.category)) throw new TypeError('Invalid category'); where.push('category=?'); values.push(options.category); }
    return {conversationId, where, values};
  }
  function query(options = {}) {
    const {conversationId, where, values} = scoped(options.roundScope === undefined ? options : {...options, roundId: undefined}), limit = Math.max(1, Math.min(200, Math.trunc(Number(options.limit)) || 50));
    let selection = {};
    if (options.roundScope !== undefined) {
      if (!['latest', 'round', 'unassigned'].includes(options.roundScope)) throw new TypeError('Invalid round scope');
      // Discover rounds across every source, including function-only failures.
      // MIN(sequence) orders starts, so a late settlement cannot make an old round latest.
      const rounds = db.prepare(`SELECT COALESCE(round_id,trigger_id) AS roundId, MIN(sequence) AS firstSequence, MAX(sequence) AS lastSequence, MIN(time) AS startedAt, COUNT(*) AS count FROM conversation_telemetry WHERE conversation_id=? AND COALESCE(round_id,trigger_id) IS NOT NULL GROUP BY COALESCE(round_id,trigger_id) ORDER BY firstSequence DESC`).all(conversationId);
      const unassignedCount = db.prepare('SELECT COUNT(*) AS count FROM conversation_telemetry WHERE conversation_id=? AND round_id IS NULL AND trigger_id IS NULL').get(conversationId).count;
      const selectedRoundId = options.roundScope === 'latest' ? rounds[0]?.roundId ?? null : options.roundScope === 'round' ? text(options.roundId) : null;
      if (options.roundScope === 'round' && !selectedRoundId) throw new TypeError('Invalid round filter');
      if (selectedRoundId) { where.push('COALESCE(round_id,trigger_id)=?'); values.push(selectedRoundId); }
      else if (options.roundScope === 'unassigned') where.push('round_id IS NULL AND trigger_id IS NULL');
      else where.push('0');
      selection = {rounds, selectedRoundId, unassignedCount};
    }
    if (options.beforeSequence !== undefined) { if (!Number.isSafeInteger(options.beforeSequence) || options.beforeSequence < 1) throw new TypeError('Invalid cursor'); where.push('sequence<?'); values.push(options.beforeSequence); }
    const rows = db.prepare(`SELECT sequence,payload FROM conversation_telemetry WHERE ${where.join(' AND ')} ORDER BY sequence DESC LIMIT ?`).all(...values, limit + 1);
    const hasMore = rows.length > limit, items = rows.slice(0, limit).map(parse);
    return {items, hasMore, nextBeforeSequence: hasMore ? items.at(-1).sequence : null, ...selection};
  }
  function summary(options = {}) {
    const {conversationId, where, values} = scoped(options);
    const calls = db.prepare(`SELECT sequence,payload FROM conversation_telemetry WHERE ${where.join(' AND ')} AND category IN ('client-worker','runtime-loop') ORDER BY sequence`).all(...values).map(parse);
    const grouped = list => ({worker: aggregate(list.filter(call => call.category === 'client-worker')), runtime: aggregate(list.filter(call => call.category === 'runtime-loop'))});
    const rounds = new Map();
    for (const call of calls) { const key = call.roundId ?? call.triggerId; if (!key) continue; const list = rounds.get(key) ?? []; list.push(call); rounds.set(key, list); }
    const boundary = db.prepare('SELECT had_prior_activity FROM conversation_telemetry_boundary WHERE conversation_id=?').get(conversationId);
    return {conversationId, ...tracking, historyCoverage: boundary ? boundary.had_prior_activity ? 'partial' : 'tracked' : 'unknown', roundId: options.roundId ?? null, triggerId: options.triggerId ?? null, ...grouped(calls),
      rounds: [...rounds].map(([roundId, list]) => ({roundId, triggerId: list[0].triggerId, conversationId, runIds: [...new Set(list.map(call => call.runId).filter(Boolean))], ...grouped(list)}))};
  }
  function dashboard(options={}) {
    const {where,values}=scoped({conversationId:options.conversationId});
    const records=db.prepare(`SELECT sequence,payload FROM conversation_telemetry WHERE ${where.join(' AND ')} ORDER BY sequence`).all(...values).map(parse);
    return {...usageDashboard(records,{range:options.range,timeZone:options.timeZone,now:clock(),aggregate}),conversationId:options.conversationId,...tracking};
  }
  function setHistoryBoundary({conversationId, hadPriorActivity}) {
    if (!text(conversationId) || typeof hadPriorActivity !== 'boolean') throw new TypeError('Invalid telemetry history boundary');
    // This boundary is write-once. New tracked conversations remain complete
    // after a restart even though they now contain their own post-upgrade work.
    db.prepare('INSERT OR IGNORE INTO conversation_telemetry_boundary(conversation_id,had_prior_activity) VALUES(?,?)').run(conversationId, hadPriorActivity ? 1 : 0);
  }
  return {recordCall: value => record(normalizeCallRecord(value, {clock, sanitizePricing})), recordFunction: value => record(normalizeFunctionRecord(value, {clock})), setHistoryBoundary, query, summary, dashboard};
}
