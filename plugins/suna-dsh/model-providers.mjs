import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createClientCredentials} from './client-credentials.mjs';
import {createClientRetryPolicy} from './retry-policy.mjs';
import {createNativeImageTransport} from './ephemeral-native.mjs';

// ChatGPT OAuth and API-key requests use the same URL but return different catalogs.
// OAuth order and visibility come from the selected account, not a local model list.
export function parseOpenAIModelCatalog(data){
 const validId=value=>typeof value==='string'&&value.trim().length>0&&value.length<=300&&!/[\u0000-\u0020\u007f]/.test(value);
 let models;
 if(data&&Object.hasOwn(data,'models')){
  if(!Array.isArray(data.models))throw Error('OpenAI 模型列表格式无效');
  models=data.models.filter(m=>m&&m.visibility==='list'&&validId(m.slug)).map(m=>({id:m.slug,name:typeof m.display_name==='string'&&m.display_name.trim()?m.display_name.trim().slice(0,300):m.slug}));
 }else if(Array.isArray(data?.data)){
  models=data.data.filter(m=>m&&validId(m.id)&&/^(gpt-|chatgpt-|o[0-9])/.test(m.id)&&!/audio|realtime|transcri|tts|image|search|embedding|moderation/.test(m.id)).sort((a,b)=>(Number(b.created)||0)-(Number(a.created)||0)).map(m=>({id:m.id,name:m.id}));
 }else throw Error('OpenAI 模型列表格式无效');
 const seen=new Set();return models.filter(m=>{if(seen.has(m.id))return false;seen.add(m.id);return true;});
}

// Capability metadata is obtained from the owning adapter, never inferred from a model name.
export async function describeDshModel(ctx,provider,model){
 const entry={id:model.id,name:model.name||model.id};
 try{const info=await ctx.llm.resolveModelInfo(provider,model.id);return {...entry,...(Array.isArray(info.inputModalities)?{input:[...info.inputModalities]}:{}),...(info.context?.contextWindow?{contextWindow:info.context.contextWindow}:{}),...(info.defaultMaxTokens?{maxTokens:info.defaultMaxTokens}:{}),reasoningEfforts:(info.reasoning?.efforts??[]).map(e=>e.id)};}catch{return entry;}
}
export function nativeModelCapabilities(model){
 if(!model)return {};
 const levels=['off','minimal','low','medium','high','xhigh','max'];
 // Same public metadata contract as PiAiAdapter: null excludes a level; xhigh/max need explicit support.
 const reasoningEfforts=model.reasoning?levels.filter(level=>model.thinkingLevelMap?.[level]!==null&&(!['xhigh','max'].includes(level)||model.thinkingLevelMap?.[level]!==undefined)):[];
 return {reasoningEfforts,...(Array.isArray(model.input)?{input:model.input}:{}),...(model.contextWindow?{contextWindow:model.contextWindow}:{}),...(model.maxTokens?{maxTokens:model.maxTokens}:{})};
}

// Client authorization has its own credential file and adapter route, separate from DSH credentials.
export function createModelProviders(ctx,{piDist,adapterPath,model,models:enabledModels,credentialDir,ephemeral},root){
 let attempt,serial=Promise.resolve();
 const imageAdapter=createNativeImageTransport(ctx,ephemeral);
 root=credentialDir||root;
 const credentials=createClientCredentials({root});

 const modules=Promise.all([import(pathToFileURL(path.join(piDist,'providers/openai.js')).href),import(pathToFileURL(adapterPath).href)]);
 async function status(){const [,adapter]=await modules;const record=await credentials.readRecord(adapter.recordKeyFor('openai'));return {authorized:record?.kind==='grant',...(attempt?{id:attempt.id,status:attempt.status,url:attempt.url,userCode:attempt.userCode,prompt:attempt.prompt,error:attempt.error}:{status:'idle'})};}
 async function start(){
  if(attempt?.status==='pending')return status();
  const [pi,adapter]=await modules;
  const file=path.join(root,'openai-device-id');let deviceId;try{deviceId=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;deviceId=randomUUID();await writeFile(file,deviceId,{mode:0o600});}
  const current=attempt={id:randomUUID(),status:'pending',controller:new AbortController()};
  const timer=setTimeout(()=>current.controller.abort(),10*60*1000);timer.unref?.();
  current.controller.signal.addEventListener('abort',()=>current.reject?.(Error('授权已取消')),{once:true});
  void pi.openaiProvider().auth.oauth.login({signal:current.controller.signal,notify:event=>{if(event.type==='auth_url')current.url=event.url;if(event.type==='device_code'){current.url=event.verificationUri;current.userCode=event.userCode;}},prompt:prompt=>new Promise((resolve,reject)=>{current.prompt={message:prompt.message,placeholder:prompt.placeholder,type:prompt.type};current.resolve=resolve;current.reject=reject;})},{getDeviceId:()=>deviceId,agentName:'Sandbook'}).then(async grant=>{
   if(current.controller.signal.aborted)return;
   await credentials.modifyRecord(adapter.recordKeyFor('openai'),async()=>{if(attempt!==current||current.controller.signal.aborted)throw Error('授权已取消');return {kind:'grant',payload:JSON.parse(JSON.stringify(grant))};},{signal:current.controller.signal});if(attempt!==current||current.controller.signal.aborted)throw Error('授权已取消');current.status='completed';
  }).catch(()=>{current.status=current.controller.signal.aborted?'cancelled':'failed';current.error=current.status==='failed'?'OpenAI 授权失败，请重试':undefined;}).finally(()=>{clearTimeout(timer);delete current.url;delete current.prompt;delete current.userCode;delete current.resolve;delete current.reject;});
  return status();
 }
 async function liveModels(){
  const [pi,adapter]=await modules;const oauth=pi.openaiProvider().auth.oauth,signal=AbortSignal.timeout(20000);
  const record=await credentials.modifyRecord(adapter.recordKeyFor('openai'),async current=>{if(current?.kind!=='grant')throw Error('请先授权 OpenAI');if(current.payload.expires>Date.now()+60000)return current;return {kind:'grant',payload:await oauth.refresh(current.payload,signal)};},{signal});
  const auth=await oauth.toAuth(record.payload);
  const response=await fetch('https://api.openai.com/v1/models',{headers:{...auth.headers,...(auth.apiKey?{authorization:'Bearer '+auth.apiKey}:{})},signal});
  if(!response.ok){await response.body?.cancel();throw Error(response.status===401?'OpenAI 授权已失效，请重新授权':'无法读取 OpenAI 模型列表，请检查授权后重试');}
  let data;try{data=await response.json();}catch{throw Error('OpenAI 模型列表格式无效');}
  const known=await pi.openaiProvider().getModels?.()??[];
  const models=parseOpenAIModelCatalog(data).map(entry=>({...entry,...nativeModelCapabilities(known.find(model=>model.id===entry.id))}));
  return {providers:[{id:'openai',name:'OpenAI',models}],source:'live'};
 }
 async function ready(){
  const [pi,{PiAiAdapter}]=await modules;const route='suna-openai',original=pi.openaiProvider();
  if(imageAdapter&&typeof ctx.on==='function'){const llm=await import(pathToFileURL(createRequire(adapterPath).resolve('@deepseek-ai/dsh-llm')).href);imageAdapter.installMainClassifier(llm.isAgentLoopRequest);}
  const stored=await original.getModels();
  const ids=[...new Set(Array.isArray(enabledModels)?enabledModels.map(entry=>typeof entry==='string'?entry:entry.id):model?[model]:[])];
  const models=ids.map(id=>({...(stored.find(entry=>entry.id===id)||{id,name:id,api:'openai-responses',baseUrl:'https://api.openai.com/v1',input:['text'],reasoning:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:262144,maxTokens:32768}),provider:route}));
  // The client route owns authorization and durable history. The native provider must
  // still see "openai": pi-ai uses that identity for ChatGPT request restrictions,
  // encrypted reasoning replay and paired Responses tool-call IDs.
  const nativeContext=context=>({...context,messages:context.messages.map(message=>message.role==='assistant'&&message.provider===route?{...message,provider:original.id}:message)});
  const routedMessage=message=>message?.provider===original.id?{...message,provider:route}:message;
  function nativeStream(method,selected,context,options,boundFetch){
   const upstream=original[method]({...selected,provider:original.id},nativeContext(context),boundFetch?{...options,fetch:boundFetch}:options);
   return {
    async *[Symbol.asyncIterator](){for await(const event of upstream)yield {...event,...(event.partial?{partial:routedMessage(event.partial)}:{}),...(event.message?{message:routedMessage(event.message)}:{}),...(event.error?{error:routedMessage(event.error)}:{})};},
    async result(){return routedMessage(await upstream.result());}
   };
  }
  const piProvider={...original,id:route,name:'Client OpenAI',getModels:()=>models,getAllModels:()=>models,stream:(...args)=>nativeStream('stream',...args),streamSimple:(...args)=>nativeStream('streamSimple',...args)};
  const profile={provider:route,displayName:'Client OpenAI',piProvider,modelErrors:new Map(),configuredMaxTokens:new Map(),streamIdleTimeoutMs:300000,maxRequestImageBytes:8*1024*1024,requestImagePixelBudget:4096*4096,requestImageMaxBytes:8*1024*1024,retryPolicy:createClientRetryPolicy()};
  const profiles=new Map([[route,profile]]);
  const store={read:async()=> (await credentials.readRecord())?.payload,list:async()=> (await credentials.readRecord())?[{providerId:route,type:'oauth'}]:[],modify:async(_id,fn,options)=>(await credentials.modifyRecord('',async current=>{const next=await fn(current?.payload);return next===undefined?current:{kind:'grant',payload:next};},options))?.payload,delete:(_id,options)=>credentials.deleteRecord(options)};
  const options={profiles:()=>profiles,resolveApiKey:async()=>undefined,auth:{credentials:store,authContext:{env:async()=>undefined,fileExists:async()=>false}}};
  class NativeBoundAdapter extends PiAiAdapter{
   async prepareCall(provider,model,signal){const prepared=await super.prepareCall(provider,model,signal);return {model:prepared.model,stream:request=>this.stream(request)};}
   stream(request){const boundFetch=imageAdapter?.fetchFor(request);if(!boundFetch)return super.stream(request);const boundProvider={...piProvider,stream:(...args)=>nativeStream('stream',...args,boundFetch),streamSimple:(...args)=>nativeStream('streamSimple',...args,boundFetch)};return new PiAiAdapter({...options,profiles:()=>new Map([[route,{...profile,piProvider:boundProvider}]])}).stream(request);}
  }
  ctx.llm.registerAdapter([route],new NativeBoundAdapter(options));
 }
 return {imageAdapter,ready,status,liveModels,start:()=>{const next=serial.then(start);serial=next.catch(()=>{});return next;},async respond({id,value,cancel}={}){if(!attempt||attempt.id!==id||attempt.status!=='pending')throw Error('授权请求已失效');if(cancel)attempt.controller.abort();else{if(!attempt.resolve||typeof value!=='string'||value.length>16000)throw Error('无效授权输入');const resolve=attempt.resolve;delete attempt.resolve;delete attempt.prompt;resolve(value);}return status();},close(){attempt?.controller.abort();},async catalog(){const providers=[];for(const p of ctx.llm.listProviders()){try{const models=await ctx.llm.listModels(p.id);providers.push({id:p.id,name:p.name,models:await Promise.all(models.map(m=>describeDshModel(ctx,p.id,m)))});}catch{providers.push({id:p.id,name:p.name,models:[],unavailable:true});}}return {providers};}};
}
