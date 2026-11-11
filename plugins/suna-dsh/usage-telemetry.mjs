// Read-only accounting at DSH's public LLM and assistant-stream seams. This
// module never retains prompts, output text, tool arguments, or credentials.
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = value => typeof value === 'string' && value.length ? value.slice(0, 400) : null;
const iso = value => value === null ? null : new Date(value).toISOString();
const usageKeys = {input:'inputTokens',cacheRead:'cacheReadTokens',cacheWrite:'cacheWriteTokens',output:'outputTokens',reasoning:'reasoningTokens',total:'totalTokens'};

export function normalizeDshUsage(value, {final = true} = {}) {
  const result = {input:null,cacheRead:null,cacheWrite:null,cacheWrite1h:null,output:null,reasoning:null,total:null,source:'unavailable',observedFields:[],coverage:'unknown'};
  if (!value || typeof value !== 'object') return result;
  for (const [key, original] of Object.entries(usageKeys)) {
    const number = count(value[original]);
    if (number !== null) { result[key] = number; result.observedFields.push(key); }
  }
  // pi-ai's DSH adapter always emits its SDK-initialized zero object, even
  // when no provider usage was received. There is no public provenance bit.
  // Refuse to turn that indistinguishable default into measured free usage.
  if (!result.observedFields.some(key => result[key] > 0)) {
    for (const key of Object.keys(usageKeys)) result[key] = null;
    result.observedFields = [];
    return result;
  }
  result.source = 'provider';
  if (result.reasoning !== null && result.output !== null && result.reasoning > result.output) result.reasoning = null;
  const required = ['input','cacheRead','cacheWrite','output'];
  const known = required.reduce((sum,key) => sum + (result[key] ?? 0), 0);
  if (result.total !== null && required.every(key => result[key] !== null) && result.total !== known) result.total = null;
  // A consistent authoritative aggregate proves omitted cache counters are 0.
  // Without that aggregate, absent counters remain unknown.
  if (result.total !== null && result.input !== null && result.output !== null && result.total === known) {
    for (const key of ['cacheRead','cacheWrite']) if (result[key] === null) { result[key] = 0; result.observedFields.push(key); result.source = 'derived-provider'; }
  }
  if (required.every(key => result[key] !== null)) {
    if (result.total === null) { result.total = required.reduce((sum,key) => sum + result[key], 0); result.source = 'derived-provider'; }
    result.coverage = 'complete';
  } else result.coverage = 'partial';
  if (!final && result.coverage === 'complete') result.coverage = 'partial';
  return result;
}

export function isDshTokenDelta(chunk) {
  if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') return typeof chunk.text === 'string' && chunk.text !== '';
  return chunk?.type === 'tool-call-delta' && (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '' || chunk.name !== undefined);
}

function durableChunks(stream) {
  const chunks = [];
  for (const record of Array.isArray(stream) ? stream : []) {
    if (record?.type === 'chunk') { chunks.push({time:timestamp(record.time),chunk:record.chunk}); continue; }
    if (!['text-chunks','reasoning-chunks','tool-call-chunks'].includes(record?.type)) continue;
    const fragments = record.type === 'tool-call-chunks' ? record.args : record.texts;
    let time = timestamp(record.time0);
    for (let index = 0; Array.isArray(fragments) && index < fragments.length; index++) {
      if (index > 0) { const dt = count(record.dt?.[index - 1]); time = time === null || dt === null ? null : time + dt; }
      const chunk = record.type === 'tool-call-chunks'
        ? {type:'tool-call-delta',argumentsDelta:fragments[index],...(index === 0 && record.name !== undefined ? {name:record.name} : {})}
        : {type:record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta',text:fragments[index]};
      chunks.push({time,chunk});
    }
  }
  return chunks;
}

function statusFor(reason, fallback = 'completed') {
  if (reason?.kind === 'aborted') return 'canceled';
  if (reason?.kind === 'error') return 'failed';
  return fallback;
}

export function createRuntimeUsageTelemetry({runId,sessionId,provider,model,reasoningEffort,clock = Date.now,onCall = () => {}}) {
  let enabled = false, currentAttempt = null, auxiliary = 0, compaction = null;
  const records = new Map(), attempts = new Map(), durableSeen = new Set();
  function create(key, values = {}) {
    const record = {id:`dsh:${runId}:${key}`,category:'runtime-loop',kind:'model',sessionId,attemptId:null,turn:null,step:null,
      providerId:null,upstreamProvider:label(provider),modelId:label(model),reasoningEffort:label(reasoningEffort),status:'running',
      start:null,first:null,end:null,scope:'dsh-attempt-start',rawUsage:null,terminalObserved:false,emitted:false,...values};
    records.set(record.id,record); return record;
  }
  function snapshot(record) {
    const usage = normalizeDshUsage(record.rawUsage,{final:record.terminalObserved});
    const totalMs = record.start !== null && record.end !== null && record.end >= record.start ? record.end - record.start : null;
    const ttftMs = record.start !== null && record.first !== null && record.first >= record.start ? record.first - record.start : null;
    const generationMs = record.first !== null && record.end !== null && record.end > record.first ? record.end - record.first : null;
    return {id:record.id,category:record.category,kind:record.kind,stage:record.stage ?? null,sessionId,attemptId:record.attemptId,
      turn:record.turn,step:record.step,compactionId:record.compactionId ?? null,sessionSequence:record.sessionSequence ?? null,
      providerId:null,upstreamProvider:record.upstreamProvider,modelId:record.modelId,reasoningEffort:record.reasoningEffort,status:record.status,
      dispatchedAt:iso(record.start),finishedAt:iso(record.end),usage,
      timing:{ttftMs,generationMs,totalMs,tps:usage.output !== null && generationMs !== null ? usage.output * 1000 / generationMs : null,scope:record.scope}};
  }
  function emit(record, fallback) {
    if (record.emitted) return;
    record.status = record.status === 'running' ? fallback ?? 'unknown' : record.status;
    record.end ??= timestamp(clock());
    record.emitted = true;
    onCall(snapshot(record));
  }
  function chunk(record, value, time) {
    if (value?.type === 'usage' && value.usage && typeof value.usage === 'object') record.rawUsage = {...value.usage};
    if (isDshTokenDelta(value) && time !== null && (record.first === null || time < record.first)) record.first = time;
    if (value?.type === 'finish') { record.terminalObserved = true; record.status = statusFor(value.reason); record.end = time ?? timestamp(clock()); }
  }
  function frame(value) {
    if (!enabled || !value || !label(value.attemptId)) return;
    if (value.type === 'start') {
      let record = attempts.get(value.attemptId);
      if (!record) { record = create(`attempt:${value.attemptId}`,{attemptId:label(value.attemptId),turn:count(value.turn),step:count(value.step),start:timestamp(clock())}); attempts.set(value.attemptId,record); }
      currentAttempt = record;
    } else {
      const record = attempts.get(value.attemptId); if (!record || record.emitted) return;
      if (value.type === 'chunk') chunk(record,value.chunk,timestamp(value.time));
      if (value.type === 'end') { record.sessionSequence = count(value.outcome?.seq); emit(record,value.outcome?.kind === 'abandoned' ? 'unknown' : 'completed'); }
    }
  }
  function session(event) {
    if (!enabled || !event) return;
    const seq = count(event.seq), key = seq === null ? null : `${event.type}:${seq}`;
    if (key && durableSeen.has(key)) return;
    if (key) durableSeen.add(key);
    const data = event.data ?? {};
    if (event.type === 'compaction/start') compaction = {id:label(data.compactionId),turn:count(data.turn),calls:[]};
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      let record = currentAttempt;
      if (!record || record.emitted || record.turn !== count(data.turn) || record.step !== count(data.step)) {
        record = create(`durable:${seq ?? ++auxiliary}`,{turn:count(data.turn),step:count(data.step)});
      }
      const source = data.message?.source;
      if (source?.provider) record.upstreamProvider = label(source.provider);
      if (source?.model) record.modelId = label(source.model);
      for (const item of durableChunks(data.stream)) chunk(record,item.chunk,item.time);
      if (data.usage) record.rawUsage = {...data.usage};
      if (data.interrupted === true) record.status = 'canceled';
      record.sessionSequence = seq;
      // Normal live calls settle on their matching end frame; fallback durable
      // records have no such frame and can settle immediately.
      if (!record.attemptId) emit(record,event.type === 'assistant/attempt' ? 'unknown' : 'completed');
    }
    if (event.type === 'compaction/summary') {
      const matching = [...records.values()].filter(record => record.kind === 'compaction' && record.compactionId === label(data.compactionId));
      if (!matching.length) {
        const record = create(`summary:${seq ?? ++auxiliary}`,{kind:'compaction',compactionId:label(data.compactionId),upstreamProvider:label(data.provider),modelId:label(data.model),reasoningEffort:null,rawUsage:data.usage,terminalObserved:true,sessionSequence:seq,status:'completed'});
        emit(record);
      }
    }
    if (event.type === 'compaction/end' && compaction?.id === label(data.compactionId)) compaction = null;
  }
  function stream(options,next) {
    return (async function* () {
      if (!enabled || String(options?.sessionId) !== String(sessionId)) { yield* next(); return; }
      const purpose = options.purpose;
      const record = purpose || !currentAttempt || currentAttempt.emitted
        ? create(`auxiliary:${++auxiliary}`,{kind:purpose === 'compaction' ? 'compaction' : 'model',stage:purpose ?? null,compactionId:purpose === 'compaction' ? compaction?.id ?? null : null,turn:purpose === 'compaction' ? compaction?.turn ?? null : null})
        : currentAttempt;
      record.upstreamProvider = label(options.provider); record.modelId = label(options.model); record.reasoningEffort = label(options.reasoningEffort);
      record.start = timestamp(clock()); record.scope = 'dsh-llm-stream';
      try { for await (const value of next()) { chunk(record,value,timestamp(clock())); yield value; } }
      catch (error) { record.status = options.signal?.aborted ? 'canceled' : 'failed'; throw error; }
      finally {
        record.end ??= timestamp(clock());
        if (options.signal?.aborted) record.status = 'canceled';
        if (!record.attemptId) emit(record,record.status === 'running' ? 'unknown' : record.status);
      }
    })();
  }
  return {activate(){enabled = true;},frame,session,stream,
    finish(status){for (const record of records.values()) if (!record.emitted) emit(record,status); enabled = false;},
    calls(){return [...records.values()].filter(record => record.emitted).map(snapshot);}};
}
