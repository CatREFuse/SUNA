import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {registryProviderRoute,registryModelThinking} from '../../plugins/suna-dsh/registry-providers.mjs';
import {resolveRuntimeModelDependencies} from '../runtime/runtime-dependencies.mjs';
import {normalizeUsage} from '../core/conversation-observability.mjs';
import {estimateCall,normalizePricing} from '../models/model-pricing.mjs';
import {temperatureCapability} from '../models/model-temperature.mjs';

const apis=new Set(['openai-completions','openai-responses','anthropic-messages','google-generative-ai']);
function validSavedApi(config){
 if(typeof config?.model!=='string'||!config.model.trim()||typeof config.apiKey!=='string'||!config.apiKey.trim()||!apis.has(config.api||'openai-completions'))return false;
 try{const url=new URL(config.baseURL||'https://api.deepseek.com/v1');return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}
}
const failure=code=>Object.assign(new Error({WORKER_CLIENT_CONFIG:'Worker 客户端模型未配置',WORKER_CLIENT_TEMPERATURE_UNSUPPORTED:'当前模型或协议不支持所设温度，请使用默认温度',WORKER_CLIENT_PROVIDER:'Worker 模型与客户端提供商不匹配',WORKER_CLIENT_AUTH:'Worker 客户端授权不可用，请重新授权',WORKER_CLIENT_FAILED:'Worker 客户端请求失败',WORKER_CLIENT_CANCELLED:'Worker 客户端请求已取消',WORKER_CLIENT_TIMEOUT:'Worker 客户端请求超时',WORKER_CLIENT_FORMAT:'Worker 返回格式配置无效',WORKER_CLIENT_RESULT:'Worker 返回结果不符合格式要求',WORKER_CLIENT_SELECTION_CHANGED:'Worker 模型配置已变化，本批重试已停止'}[code]),{code});

const transientNetworkCodes=new Set(['EAI_AGAIN','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EPIPE','ENETRESET','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
function networkCause(error){
 const seen=new Set(),pending=[error];
 for(let depth=0;pending.length&&depth<12;depth++){
  const current=pending.shift();if(!current||typeof current!=='object'||seen.has(current))continue;seen.add(current);
  try{if(transientNetworkCodes.has(current.code))return current.code;pending.push(current.cause);if(Array.isArray(current.errors))pending.push(...current.errors.slice(0,4));}catch{}
 }
}
function retryDelay(value){
 if(typeof value!=='string'||!value.trim()||value.length>128)return;
 const text=value.trim();let delay;
 if(/^\d+(?:\.\d+)?$/.test(text))delay=Number(text)*1000;
 else if(/^[+-]?\d+(?:\.\d+)?$/.test(text))return;
 else {const date=Date.parse(text);if(!Number.isFinite(date))return;delay=date-Date.now();}
 if(Number.isFinite(delay))return Math.max(0,Math.min(30000,Math.ceil(delay)));
}
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex');

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const types=new Set(['null','boolean','number','integer','string','array','object']);
const keywords=new Set(['type','enum','const','properties','required','additionalProperties','items','anyOf','allOf','oneOf','not','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','pattern','minItems','maxItems','uniqueItems','minProperties','maxProperties','title','description','default','examples']);
function json(value,seen=new Set()){
 if(value===null||typeof value==='string'||typeof value==='boolean')return true;
 if(typeof value==='number')return Number.isFinite(value);
 if(!Array.isArray(value)&&!plain(value)||seen.has(value))return false;
 seen.add(value);const valid=Object.values(value).every(item=>json(item,seen));seen.delete(value);return valid;
}
function checkSchema(schema,depth=0,ancestors=new Set()){
 if(typeof schema==='boolean')return;
 if(!plain(schema)||depth>64||ancestors.has(schema))throw failure('WORKER_CLIENT_FORMAT');
 ancestors.add(schema);
 const invalid=()=>{throw failure('WORKER_CLIENT_FORMAT');};
 for(const [key,value] of Object.entries(schema)){
  if(!keywords.has(key))invalid();
  if(key==='type'){
   const list=Array.isArray(value)?value:[value];if(!list.length||new Set(list).size!==list.length||list.some(type=>!types.has(type)))invalid();
  }else if(key==='properties'){
   if(!plain(value))invalid();for(const child of Object.values(value))checkSchema(child,depth+1,ancestors);
  }else if(['items','additionalProperties','not'].includes(key))checkSchema(value,depth+1,ancestors);
  else if(['anyOf','allOf','oneOf'].includes(key)){
   if(!Array.isArray(value)||!value.length)invalid();for(const child of value)checkSchema(child,depth+1,ancestors);
  }else if(key==='required'){
   if(!Array.isArray(value)||new Set(value).size!==value.length||value.some(item=>typeof item!=='string'))invalid();
  }else if(key==='enum'){if(!Array.isArray(value)||!value.length||!json(value))invalid();}
  else if(['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf'].includes(key)){if(typeof value!=='number'||!Number.isFinite(value)||(key==='multipleOf'&&value<=0))invalid();}
  else if(['minLength','maxLength','minItems','maxItems','minProperties','maxProperties'].includes(key)){if(!Number.isSafeInteger(value)||value<0)invalid();}
  else if(key==='uniqueItems'){if(typeof value!=='boolean')invalid();}
  else if(key==='pattern'){if(typeof value!=='string')invalid();try{new RegExp(value,'u');}catch{invalid();}}
  else if(['title','description'].includes(key)){if(typeof value!=='string')invalid();}
  else if(!json(value))invalid();
 }
 ancestors.delete(schema);
}
function matches(value,schema){
 if(typeof schema==='boolean')return schema;
 const hasType=type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='object'?plain(value):type==='integer'?typeof value==='number'&&Number.isInteger(value):typeof value===type;
 if(schema.type&&!(Array.isArray(schema.type)?schema.type:[schema.type]).some(hasType))return false;
 if(schema.enum&&!schema.enum.some(item=>isDeepStrictEqual(item,value)))return false;
 if(Object.hasOwn(schema,'const')&&!isDeepStrictEqual(schema.const,value))return false;
 if(schema.anyOf&&!schema.anyOf.some(child=>matches(value,child)))return false;
 if(schema.allOf&&!schema.allOf.every(child=>matches(value,child)))return false;
 if(schema.oneOf&&schema.oneOf.filter(child=>matches(value,child)).length!==1)return false;
 if(schema.not!==undefined&&matches(value,schema.not))return false;
 if(typeof value==='number'){
  if(schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum||schema.exclusiveMinimum!==undefined&&value<=schema.exclusiveMinimum||schema.exclusiveMaximum!==undefined&&value>=schema.exclusiveMaximum)return false;
  if(schema.multipleOf!==undefined){const quotient=value/schema.multipleOf;if(Math.abs(quotient-Math.round(quotient))>Number.EPSILON*8*Math.max(1,Math.abs(quotient)))return false;}
 }
 if(typeof value==='string'){
  const length=[...value].length;if(schema.minLength!==undefined&&length<schema.minLength||schema.maxLength!==undefined&&length>schema.maxLength||schema.pattern!==undefined&&!new RegExp(schema.pattern,'u').test(value))return false;
 }
 if(Array.isArray(value)){
  if(schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems)return false;
  if(schema.uniqueItems&&value.some((item,index)=>value.slice(0,index).some(previous=>isDeepStrictEqual(previous,item))))return false;
  if(schema.items!==undefined&&!value.every(item=>matches(item,schema.items)))return false;
 }
 if(plain(value)){
  const keys=Object.keys(value);
  if(schema.minProperties!==undefined&&keys.length<schema.minProperties||schema.maxProperties!==undefined&&keys.length>schema.maxProperties)return false;
  if(schema.required?.some(key=>!Object.hasOwn(value,key)))return false;
  for(const key of keys){
   if(schema.properties&&Object.hasOwn(schema.properties,key)){if(!matches(value[key],schema.properties[key]))return false;}
   else if(schema.additionalProperties!==undefined&&!matches(value[key],schema.additionalProperties))return false;
  }
 }
 return true;
}
function formatFor(value){
 try{if(typeof value==='string')value=['text','json_object'].includes(value)?{type:value}:JSON.parse(value);}catch{throw failure('WORKER_CLIENT_FORMAT');}
 if(value===undefined||value===null)return {type:'text'};
 if(!plain(value))throw failure('WORKER_CLIENT_FORMAT');
 if(value.type==='text'||value.type==='json_object')return {type:value.type};
 const definition=value.type==='json_schema'?(value.json_schema||value):value;
 if(!plain(definition))throw failure('WORKER_CLIENT_FORMAT');
 const schema=Object.hasOwn(definition,'schema')?definition.schema:value.type==='json_schema'?undefined:value;
 checkSchema(schema);
 if(definition.strict!==undefined&&typeof definition.strict!=='boolean')throw failure('WORKER_CLIENT_FORMAT');
 return {type:'json_schema',schema,name:typeof definition.name==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(definition.name)?definition.name:'worker_result',strict:definition.strict??false};
}

// Deliberately strict supported JSON Schema subset. Unsupported keywords fail
// before inference, including in branches that the returned value would skip.
// Shared with the worker engine so an injected transport cannot bypass checks.
export function validateWorkerResponse(result,responseFormat){
 const format=formatFor(responseFormat);
 if(format.type==='text'){
  if(typeof result!=='string')throw failure('WORKER_CLIENT_RESULT');
 }else if(!json(result)||format.type==='json_object'&&!plain(result)||format.type==='json_schema'&&!matches(result,format.schema))throw failure('WORKER_CLIENT_RESULT');
 return result;
}

function structuredPayload(payload,api,format){
 if(format.type==='text')return payload;
 const schema=format.type==='json_schema'?format.schema:{type:'object',additionalProperties:true};
 if(api==='openai-completions')return {...payload,response_format:format.type==='json_object'?{type:'json_object'}:{type:'json_schema',json_schema:{name:format.name,schema,strict:format.strict}}};
 if(api==='openai-responses')return {...payload,text:{...payload.text,format:format.type==='json_object'?{type:'json_object'}:{type:'json_schema',name:format.name,schema,strict:format.strict}}};
 if(api==='anthropic-messages')return {...payload,output_config:{...payload.output_config,format:{type:'json_schema',schema}}};
 if(api==='google-generative-ai')return {...payload,config:{...payload.config,responseMimeType:'application/json',...(format.type==='json_schema'?{responseJsonSchema:schema}:{})}};
 throw failure('WORKER_CLIENT_FORMAT');
}

// Observe only numeric accounting, never retain provider event bodies. SDKs
// initialize missing usage to zero, so their zero-filled result alone cannot
// prove that the provider reported a free/empty request.
function observeUsage(event,api,state){
 const raw=event?.response?.usage??event?.message?.usage??event?.usage??event?.usageMetadata;
 if(!raw||typeof raw!=='object')return;
 const put=(key,value)=>{if(Number.isSafeInteger(value)&&value>=0){state.values[key]=value;state.seen=true;}};
 if(api==='google-generative-ai'){
  put('aggregateInput',raw.promptTokenCount);put('cacheRead',raw.cachedContentTokenCount);put('reasoning',raw.thoughtsTokenCount);put('total',raw.totalTokenCount);
  put('visibleOutput',raw.candidatesTokenCount);
  // Google cached content creation is a separate operation, not this generation.
  state.values.cacheWrite=0;state.derived=true;
  if(state.values.visibleOutput!==undefined&&state.values.reasoning!==undefined)put('output',state.values.visibleOutput+state.values.reasoning);
 }else if(api==='anthropic-messages'){
  put('input',raw.input_tokens);put('output',raw.output_tokens);put('cacheRead',raw.cache_read_input_tokens);put('cacheWrite',raw.cache_creation_input_tokens);put('cacheWrite1h',raw.cache_creation?.ephemeral_1h_input_tokens);
 }else{
  put('aggregateInput',raw.prompt_tokens??raw.input_tokens);put('input',raw.prompt_cache_miss_tokens);
  put('cacheRead',raw.prompt_tokens_details?.cached_tokens??raw.input_tokens_details?.cached_tokens??raw.prompt_cache_hit_tokens??raw.cached_tokens);
  put('cacheWrite',raw.prompt_tokens_details?.cache_write_tokens??raw.input_tokens_details?.cache_write_tokens);
  const split=raw.prompt_tokens_details?.cache_write_tokens_details??raw.input_tokens_details?.cache_write_tokens_details;
  put('cacheWrite30m',split?.ttl_30m_tokens);put('cacheWrite12h',split?.ttl_12h_tokens);
  put('output',raw.completion_tokens??raw.output_tokens);put('reasoning',raw.completion_tokens_details?.reasoning_tokens??raw.output_tokens_details?.reasoning_tokens);put('total',raw.total_tokens);
 }
 if(state.values.aggregateInput!==undefined&&state.values.cacheRead!==undefined&&state.values.cacheWrite!==undefined){const ordinary=state.values.aggregateInput-state.values.cacheRead-state.values.cacheWrite;if(ordinary>=0){put('input',ordinary);state.derived=true;}}
}
function observedUsage(state,result){
 if(state.seen)return normalizeUsage({...state.values,source:state.derived?'derived-provider':'provider',observedFields:Object.keys(state.values)});
 // A transport without the raw observation hook may still report positive
 // normalized counters. Preserve these as adapter facts, never infer its zeros.
 const value=result?.usage??{},observedFields=Object.keys(value).filter(key=>typeof value[key]==='number'&&value[key]>0);
 return normalizeUsage({...value,source:observedFields.length?'adapter':'unavailable',observedFields});
}

// Only loads this distribution's model library. It never starts or contacts DSH.
export function createWorkerClientRequest({dataDir,projectRoot=path.resolve('.'),pluginDir=path.join(projectRoot,'plugins/suna-dsh'),runtimeDir=path.join(projectRoot,'runtime/dsh'),getDependencies,registry,getDshProviderConfig,fetch:fetchImpl=globalThis.fetch,timeoutMs=30000,clock=()=>new Date().toISOString(),monotonicNow=()=>performance.now()}={}){
 const retryPins=new WeakMap();
 // Explicit opt-in read-only guard for a multi-phase desktop moderator. Other
 // Workers and Channel retry behavior do not call or depend on this API.
 async function createSelectionGuard({name,signal}={}){
  if(name!=='group_scheduler')throw failure('WORKER_CLIENT_CONFIG');
  const check=()=>signal?.throwIfAborted();
  async function snapshot(){
   check();let value;
   if(registry){
    const resolved=await registry.resolve('groupScheduler');check();
    let configuration;
    if(resolved.provider?.kind==='dsh'){
     const model=resolved.model;if(!getDshProviderConfig||!model?.upstreamProvider||!model?.upstreamModel)throw failure('WORKER_CLIENT_CONFIG');
     configuration=await getDshProviderConfig({provider:model.upstreamProvider,model:model.upstreamModel,signal});check();
    }
    const confirmed=await registry.resolve('groupScheduler');check();
    if(fingerprint(resolved)!==fingerprint(confirmed))throw failure('WORKER_CLIENT_SELECTION_CHANGED');
    value={resolved,configuration};
   }else value=JSON.parse(await readFile(path.join(dataDir,'runtime-model.json'),'utf8'));
   check();return fingerprint(value);
  }
  const baseline=await snapshot();
  return Object.freeze({assertCurrent:async()=>{if(await snapshot()!==baseline)throw failure('WORKER_CLIENT_SELECTION_CHANGED');check();}});
 }

 async function dependencies(){
  if(getDependencies)return getDependencies();
  let selected=runtimeDir;
  try{const record=JSON.parse(await readFile(path.join(dataDir,'dsh-selected.json'),'utf8'));if(record.path)selected=record.path;}catch(error){if(error.code!=='ENOENT')throw error;}
  return resolveRuntimeModelDependencies(selected);
 }
 async function request(input={}){
  // Global assignments are authoritative; prompt metadata belongs to legacy routing.
  if(registry)input={...input,provider:undefined,model:undefined,reasoningEffort:undefined,temperature:undefined};
  const controller=new AbortController();let timedOut=false,telemetry,streamResult,started,firstToken,ended,requestError,requestCauseCode,reply,httpStatus,retryAfterMs,fetchNetworkCode;
  const requestedTimeout=input.timeoutMs??timeoutMs;
  const milliseconds=Number.isFinite(requestedTimeout)&&requestedTimeout>0?requestedTimeout:30000;
  const requestStarted=monotonicNow();let phase={stage:registry?'resolve-model':'load-config',startedAt:requestStarted},timeoutPhase,diagnosticClosed=false,modelCallAttempted=false;
  const diagnosticModel={};
  const safeLabel=(value,max=300)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value)?value:undefined;
  const diagnosticCodes=new Set(['WORKER_CLIENT_CONFIG','WORKER_CLIENT_PROVIDER','WORKER_CLIENT_AUTH','WORKER_CLIENT_FAILED','WORKER_CLIENT_CANCELLED','WORKER_CLIENT_TIMEOUT','WORKER_CLIENT_FORMAT','WORKER_CLIENT_RESULT','WORKER_CLIENT_SELECTION_CHANGED','WORKER_CLIENT_TEMPERATURE_UNSUPPORTED']);
  const causeCodes=new Set([...diagnosticCodes,...transientNetworkCodes,'GROUP_DECISION_TIMEOUT','CLIENT_AUTH_LOCK_TIMEOUT','CLIENT_AUTH_CANCELLED','CLIENT_AUTH_FILE','MODEL_NOT_CONFIGURED','PROVIDER_NOT_FOUND','WORKER_MODEL_UNSUPPORTED','ENOENT','EACCES','EPERM','EIO','ENOSPC','ENOTFOUND','ERR_INVALID_URL']);
  function safeCause(error){for(let depth=0;error&&depth<3;depth++,error=error.cause)if(causeCodes.has(error.code))return error.code;}
  function diagnostic(status,{at=phase,code,causeCode,terminal=false}={}){
   if(diagnosticClosed)return;
   const time=monotonicNow(),record={stage:at.stage,status,elapsedMs:Math.max(0,time-requestStarted),durationMs:Math.max(0,time-at.startedAt),timeoutMs:milliseconds,modelCallAttempted,...diagnosticModel,...(diagnosticCodes.has(code)?{code}:{}),...(causeCodes.has(causeCode)?{causeCode}:{})};
   if(terminal)diagnosticClosed=true;
   try{const result=input.onDiagnostic?.(record);if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});}catch{/* Diagnostics never affect inference or create a retry. */}
  }
  const begin=stage=>{check();if(diagnosticClosed)return;phase={stage,startedAt:monotonicNow()};diagnostic('start');check();};
  const complete=()=>{check();diagnostic('completed');};
  async function step(stage,action){begin(stage);const value=await action();check();complete();return value;}
  const observed={seen:false,values:{}};
  const abort=()=>{if(['GROUP_DECISION_TIMEOUT','WORKER_CLIENT_TIMEOUT'].includes(input.signal?.reason?.code)){timedOut=true;timeoutPhase??={...phase};}controller.abort(input.signal?.reason);};
  if(input.signal?.aborted)abort();else input.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;timeoutPhase??={...phase};controller.abort();},milliseconds);
  const check=()=>{if(controller.signal.aborted)throw failure(timedOut?'WORKER_CLIENT_TIMEOUT':'WORKER_CLIENT_CANCELLED');};
  function pin(part,value){
   if(input.retryContext===undefined)return;
   if(!input.retryContext||typeof input.retryContext!=='object')throw failure('WORKER_CLIENT_CONFIG');
   check();const digest=fingerprint(value);check();
   const previous=retryPins.get(input.retryContext);
   if(previous&&Object.hasOwn(previous,part)&&previous[part]!==digest)throw failure('WORKER_CLIENT_SELECTION_CHANGED');
   if(diagnosticClosed)return;
   if(previous)previous[part]=digest;else retryPins.set(input.retryContext,{[part]:digest});
  }
  const requestFetch=async(...args)=>{
   check();httpStatus=undefined;retryAfterMs=undefined;fetchNetworkCode=undefined;
   try{
    const response=await fetchImpl(...args);
    if(!controller.signal.aborted&&!diagnosticClosed){
     if(Number.isInteger(response?.status)&&response.status>=100&&response.status<=599)httpStatus=response.status;
     try{retryAfterMs=retryDelay(response.headers?.get?.('retry-after'));}catch{}
    }
    return response;
   }catch(error){if(!controller.signal.aborted&&!diagnosticClosed)fetchNetworkCode=networkCause(error);throw error;}
  };
  function retryClassification(error,original){
   const hardFailure=['WORKER_CLIENT_CONFIG','WORKER_CLIENT_PROVIDER','WORKER_CLIENT_AUTH','WORKER_CLIENT_FORMAT','WORKER_CLIENT_RESULT','WORKER_CLIENT_SELECTION_CHANGED','WORKER_CLIENT_CANCELLED','WORKER_CLIENT_TEMPERATURE_UNSUPPORTED'].includes(error.code);
   const retryable=controller.signal.aborted?timedOut:hardFailure?false:error.code==='WORKER_CLIENT_TIMEOUT'?true:httpStatus>=400?(httpStatus===408||httpStatus===429||httpStatus>=500):!!fetchNetworkCode||!!networkCause(original);
   return {retryable,...(httpStatus!==undefined?{httpStatus}:{}),...(retryAfterMs!==undefined?{retryAfterMs}:{})};
  }
  // Race even model libraries which fail to settle promptly on abort. Their
  // underlying request still receives the same signal and cannot send a result.
  let rejectAbort;
  const cancelled=new Promise((_,reject)=>{rejectAbort=()=>reject(failure(timedOut?'WORKER_CLIENT_TIMEOUT':'WORKER_CLIENT_CANCELLED'));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
  async function run(){
   check();
   const format=formatFor(input.responseFormat);
   // OpenAI Structured Outputs requires an object at the root. Preserve arbitrary
   // business values through a plain JSON envelope, never a tool invocation.
   const wrapped=format.type==='json_schema'&&format.schema?.type!=='object'&&!(Array.isArray(format.schema?.type)&&format.schema.type.length===1&&format.schema.type[0]==='object');
   const wireFormat=wrapped?{...format,schema:{type:'object',properties:{result:format.schema},required:['result'],additionalProperties:false}}:format;
   let source,config,resolved,dshModel;
   if(registry){
    const use=input.name==='tone'?'tone':input.name==='group_scheduler'?'groupScheduler':'worker';
    resolved=await step('resolve-model',()=>registry.resolve(use,use==='worker'?input.name:undefined));
    if(!resolved||!['api-key','openai-auth','dsh'].includes(resolved.provider?.kind))throw failure('WORKER_CLIENT_CONFIG');
    const {provider,selection}=resolved;
    pin('registry',resolved);
    diagnosticModel.providerKind=provider.kind;
    if(safeLabel(selection?.modelId)!==undefined)diagnosticModel.modelId=selection.modelId;
    if(safeLabel(selection?.reasoningEffort,80)!==undefined)diagnosticModel.reasoningEffort=selection.reasoningEffort;
    source=provider.kind==='openai-auth'?'openai-auth':'client';
    if(provider.kind==='dsh'){
     dshModel=provider.models.find(m=>input.model?(m.id===input.model||m.upstreamModel===input.model):m.id===selection.modelId);
     if(!dshModel?.upstreamProvider||!dshModel.upstreamModel||!getDshProviderConfig)throw failure('WORKER_CLIENT_CONFIG');
     if(input.provider&&![provider.id,dshModel.upstreamProvider].includes(input.provider))throw failure('WORKER_CLIENT_PROVIDER');
     config=await step('load-config',()=>getDshProviderConfig({provider:dshModel.upstreamProvider,model:dshModel.upstreamModel,signal:controller.signal}));
     config={...config,reasoningEffort:selection.reasoningEffort??config.reasoningEffort,temperature:selection.temperature};
    }else config={...provider,provider:registryProviderRoute(provider),model:selection.modelId,reasoningEffort:selection.reasoningEffort,temperature:selection.temperature};
   }else{
    const stored=JSON.parse(await step('load-config',()=>readFile(path.join(dataDir,'runtime-model.json'),'utf8')));
    source=stored.source==='dsh'?(stored.clientSource||(validSavedApi(stored.clientConfig)?'client':stored.clientOpenAI?.model?'openai-auth':undefined)):stored.source||'client';
    if(!['client','openai-auth'].includes(source))throw failure('WORKER_CLIENT_CONFIG');
    config=source==='openai-auth'?{provider:'suna-openai',model:stored.source==='openai-auth'?stored.model:stored.clientOpenAI?.model}:stored.source==='dsh'?stored.clientConfig:stored;
   }
   if(!config?.model)throw failure('WORKER_CLIENT_CONFIG');
   const provider=config.provider||'suna-model';
   if(input.provider&&input.provider!==provider&&input.provider!==resolved?.provider?.id&&!(source==='openai-auth'&&input.provider==='openai'))throw failure('WORKER_CLIENT_PROVIDER');
   const id=dshModel?config.model:input.model||config.model;
   const configuredModel=dshModel?{...dshModel,...config.models?.find(model=>model.id===id)}:resolved?.provider.models.find(model=>model.id===id);
   if(registry&&!configuredModel)throw failure('WORKER_CLIENT_CONFIG');
   const reasoningEffort=input.reasoningEffort??config.reasoningEffort;
   const requestedTemperature=input.temperature===undefined?config.temperature:input.temperature,temperature=requestedTemperature===null?undefined:requestedTemperature;
   if(temperature!==undefined&&(typeof temperature!=='number'||!Number.isFinite(temperature)||temperature<0||temperature>2))throw failure('WORKER_CLIENT_CONFIG');
   const assertTemperature=model=>{if(temperature===undefined)return;const capability=temperatureCapability({...config,kind:resolved?.provider.kind??(source==='openai-auth'?'openai-auth':'api-key')},model,{reasoningEffort:config.nativeDeepSeek?(reasoningEffort||'high'):reasoningEffort});if(!capability.supported||temperature<capability.min||temperature>capability.max)throw failure('WORKER_CLIENT_TEMPERATURE_UNSUPPORTED');};
   assertTemperature(configuredModel);

   if(reasoningEffort&&configuredModel?.reasoningEfforts&&!configuredModel.reasoningEfforts.includes(reasoningEffort))throw failure('WORKER_CLIENT_CONFIG');
   if(typeof id!=='string'||!id.trim()||id.length>300)throw failure('WORKER_CLIENT_CONFIG');
   pin('configuration',{source,config,id,reasoningEffort,temperature});
   diagnosticModel.providerKind=resolved?.provider.kind??(source==='openai-auth'?'openai-auth':'api-key');
   if(safeLabel(id)!==undefined)diagnosticModel.modelId=id;
   const diagnosticEffort=config.nativeDeepSeek?(reasoningEffort||'high'):reasoningEffort;
   if(safeLabel(diagnosticEffort,80)!==undefined)diagnosticModel.reasoningEffort=diagnosticEffort;
   const dep=await step('dependencies',dependencies);
   const loadApi=dep.loadApi||(api=>import(pathToFileURL(path.join(dep.piDist,'api',api+'.js')).href));
   let invoke,model,auth;
   if(source==='openai-auth'){
    const openai=dep.openaiProvider||(await step('load-provider',()=>import(pathToFileURL(path.join(dep.piDist,'providers/openai.js')).href))).openaiProvider;
    const native=openai();
    const known=(await step('load-provider',()=>native.getModels())).find(item=>item.id===id);
    if(!registry&&id!==config.model&&!known)throw failure('WORKER_CLIENT_CONFIG');
    const {createClientCredentials}=await step('load-provider',()=>import(pathToFileURL(path.join(pluginDir,'client-credentials.mjs')).href));
    const credentials=createClientCredentials({root:path.join(dataDir,'client-auth')});
    begin('auth-lock');
    const record=await credentials.modifyRecord('',async record=>{
     check();
     if(record?.kind!=='grant'||!record.payload)throw failure('WORKER_CLIENT_AUTH');
     if(!(record.payload.expires>Date.now()+60000)){
      complete();begin('auth-refresh');const payload=await native.auth.oauth.refresh(record.payload,controller.signal);
      // Refresh can rotate a token just as cancellation arrives. The shared
      // store persists that rotation under its cross-process lock before check.
      // Diagnostic observers may themselves trigger cancellation. Never let a
      // post-refresh check prevent persisting an already rotated credential.
      if(!controller.signal.aborted&&!diagnosticClosed){
       diagnostic('completed');
       if(!controller.signal.aborted&&!diagnosticClosed){phase={stage:'auth-lock',startedAt:monotonicNow()};diagnostic('start');}
      }
      return {...record,payload};
     }
     return record;
    },{signal:controller.signal});check();complete();auth=await step('auth-convert',()=>native.auth.oauth.toAuth(record.payload));
    model={...(known||{}),id,name:known?.name||id,provider:'openai',api:'openai-responses',baseUrl:'https://api.openai.com/v1'};
    invoke=(m,c,o)=>native.streamSimple(m,c,o);
   }else{
    if(!validSavedApi(config))throw failure('WORKER_CLIENT_CONFIG');
    const registered=new Set([config.model,...(Array.isArray(config.models)?config.models.map(item=>typeof item==='string'?item:item?.id):[])]);
    if(!registered.has(id))throw failure('WORKER_CLIENT_CONFIG');
    const api=config.api||'openai-completions';
    const baseUrl=config.baseURL||'https://api.deepseek.com/v1';
    const url=new URL(baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw failure('WORKER_CLIENT_CONFIG');
    auth={apiKey:config.apiKey,...(config.headers?{headers:config.headers}:{})};model={...config.modelDescriptor,id,name:config.modelDescriptor?.name||id,provider,api,baseUrl};
    invoke=(await step('load-provider',()=>loadApi(api))).streamSimple;
   }
   model={reasoning:!!reasoningEffort,input:['text'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},...model,...registryModelThinking(configuredModel,model)};
   assertTemperature(model);
   if(reasoningEffort&&model.thinkingLevelMap?.[reasoningEffort]===null)throw failure('WORKER_CLIENT_CONFIG');
   if(!Array.isArray(input.messages)||!input.messages.length)throw failure('WORKER_CLIENT_CONFIG');
   const context={messages:input.messages.map(message=>{
    if(!['system','developer','user','assistant'].includes(message.role)||typeof message.content!=='string')throw failure('WORKER_CLIENT_CONFIG');
    // Worker receives a fresh transcript, never previous model state or tools.
    return message.role==='assistant'?{role:'assistant',content:[{type:'text',text:message.content}],api:model.api,provider:model.provider,model:id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()}:{role:message.role==='developer'?'system':message.role,content:message.content,timestamp:Date.now()};
   })};
   if(format.type!=='text')context.messages.unshift({role:'system',content:format.type==='json_object'?'Return exactly one JSON object, without Markdown fences or other text. Do not call tools.':`Return exactly one JSON object matching this JSON Schema${wrapped?'; put the requested result in its result property':''}, without Markdown fences or other text. Do not call tools.\n${JSON.stringify(wireFormat.schema)}`,timestamp:Date.now()});
   check();
   const scope=input.telemetryContext??{};
   const pricingSnapshot=normalizePricing(configuredModel?.pricing??null);
   // Logical registry ids may be provider::upstream-model. Preserve both ids;
   // only a frozen exact registry route may bind that logical price identity.
   const configuredModelId=resolved?.model&&resolved.model.id===resolved.selection?.modelId&&(dshModel?resolved.model.id===dshModel.id&&resolved.model.upstreamProvider===dshModel.upstreamProvider&&resolved.model.upstreamModel===id:resolved.model.id===id)?resolved.model.id:null;
   begin('dispatch');
   telemetry={id:`client:${randomUUID()}`,category:'client-worker',kind:'model',...Object.fromEntries(['conversationId','characterId','runId','triggerId','roundId','taskId','stage','attemptId'].map(key=>[key,typeof scope[key]==='string'?scope[key]:null])),providerId:resolved?.provider.id??provider,upstreamProvider:dshModel?.upstreamProvider??model.provider,providerKind:resolved?.provider.kind??(source==='openai-auth'?'openai-auth':'api-key'),modelId:id,configuredModelId,reasoningEffort:(config.nativeDeepSeek?(reasoningEffort||'high'):reasoningEffort)??null,pricingSnapshot,dispatchedAt:clock()};
   started=monotonicNow();
   modelCallAttempted=true;
   const stream=invoke(model,context,{...auth,signal:controller.signal,fetch:requestFetch,maxRetries:0,timeoutMs:milliseconds,maxTokens:4096,...(temperature!==undefined?{temperature}:{}),onProviderStreamEvent:event=>observeUsage(event,model.api,observed),onPayload:payload=>{payload=structuredPayload(payload,model.api,wireFormat);if(temperature!==undefined)payload=model.api==='google-generative-ai'?{...payload,config:{...payload.config,temperature}}:{...payload,temperature};if(config.nativeDeepSeek){const effort=reasoningEffort||'high';payload={...payload,thinking:{type:effort==='off'?'disabled':'enabled'},output_config:{...payload.output_config,...(effort==='off'?{}:{effort})}};if(effort==='off')delete payload.output_config.effort;}return payload;},...(reasoningEffort&&reasoningEffort!=='off'?{reasoning:reasoningEffort}:{})});
   complete();
   const observation=typeof stream?.[Symbol.asyncIterator]==='function'?(async()=>{for await(const event of stream){if(controller.signal.aborted)break;if(firstToken===undefined&&['text_delta','thinking_delta','toolcall_delta'].includes(event.type)&&typeof event.delta==='string'&&event.delta.length)firstToken=monotonicNow();if(event.type==='done'||event.type==='error'){streamResult=event.message??event.error;ended=monotonicNow();}}})().catch(()=>{}):Promise.resolve();
   const result=streamResult=await step('stream',()=>stream.result());ended??=monotonicNow();begin('result');await observation;check();
   telemetry.responseModel=result.responseModel??null;telemetry.providerThinkingLevel=result.providerThinkingLevel??null;
   if(result.stopReason&&result.stopReason!=='stop')throw failure('WORKER_CLIENT_FAILED');
   const text=(result.content||[]).filter(part=>part.type==='text').map(part=>part.text).join('');
   if(!text.trim())throw failure('WORKER_CLIENT_FAILED');
   let value=text;if(format.type!=='text'){try{value=JSON.parse(text);}catch{throw failure('WORKER_CLIENT_RESULT');}}
   if(wrapped){if(!json(value)||!matches(value,wireFormat.schema))throw failure('WORKER_CLIENT_RESULT');value=value.result;}
   validateWorkerResponse(value,input.responseFormat);
   return {text,result:value,provider,model:id,...(result.usage?{usage:result.usage}:{})};
  }
  try{reply=await Promise.race([run(),cancelled]);}
  catch(error){requestCauseCode=safeCause(controller.signal.reason)??fetchNetworkCode??networkCause(error)??safeCause(error);requestError=controller.signal.aborted?failure(timedOut?'WORKER_CLIENT_TIMEOUT':'WORKER_CLIENT_CANCELLED'):error?.code==='MODEL_TEMPERATURE_UNSUPPORTED'?failure('WORKER_CLIENT_TEMPERATURE_UNSUPPORTED'):error?.code?.startsWith('WORKER_CLIENT_')?error:failure('WORKER_CLIENT_FAILED');Object.assign(requestError,retryClassification(requestError,error));}
  finally{
   clearTimeout(timer);input.signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',rejectAbort);
   if(requestError)diagnostic(timedOut?'timeout':controller.signal.aborted?'cancelled':'failed',{at:timeoutPhase??phase,code:requestError.code,causeCode:requestCauseCode,terminal:true});
   else diagnostic('completed',{at:{stage:'complete',startedAt:phase.startedAt},terminal:true});
   if(telemetry){
    const usage=observedUsage(observed,streamResult),finished=ended??monotonicNow(),generationMs=firstToken===undefined?null:Math.max(0,finished-firstToken);
    // Initial/cumulative counters (e.g. Anthropic message_start output=0) are
    // real observations, but aborting before settlement does not make them the
    // complete billed output of the call.
    if(requestError&&streamResult?.stopReason!=='stop'&&usage.coverage!=='unknown')usage.coverage='partial';
    Object.assign(telemetry,{status:requestError?timedOut?'timeout':controller.signal.aborted?'cancelled':'failed':'completed',code:requestError?.code??null,finishedAt:clock(),usage,timing:{ttftMs:firstToken===undefined?null:Math.max(0,firstToken-started),generationMs,totalMs:Math.max(0,finished-started),tps:generationMs>0&&usage.output!==null?usage.output*1000/generationMs:null,scope:'client-dispatch'},estimate:estimateCall({usage,pricing:telemetry.pricingSnapshot,providerKind:telemetry.providerKind,modelId:telemetry.configuredModelId??telemetry.modelId,usageFormat:'pi'})});
    // A late non-cooperating adapter cannot mutate the already returned record.
    telemetry=structuredClone(telemetry);
    if(requestError)requestError.telemetry=telemetry;else reply.telemetry=telemetry;
    try{await input.onTelemetry?.(structuredClone(telemetry));}catch{/* Accounting sinks must not turn a completed inference into an automatic retry. */}
   }
  }
  if(requestError){requestError.modelCallAttempted=!!telemetry;throw requestError;}return reply;
 }
 return {request,createSelectionGuard};
}
