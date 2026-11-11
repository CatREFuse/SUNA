import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createClientRetryPolicy} from './retry-policy.mjs';

// Stable identity belongs to the saved provider, never its display name/model.
export function registryProviderRoute(provider){
  if(provider.kind==='openai-auth')return 'suna-openai';
  if(provider.kind!=='api-key')throw new Error('Provider has no Client route');
  return 'suna-api-'+createHash('sha256').update(provider.id).digest('hex').slice(0,24);
}
export function registryProviderEnv(provider){return 'SUNA_PROVIDER_'+createHash('sha256').update(provider.id).digest('hex').toUpperCase()+'_API_KEY';}
const temperatureCompat=model=>Object.fromEntries(['supportsTemperature','supportsMidConvoEffort'].filter(key=>typeof model?.compat?.[key]==='boolean').map(key=>[key,model.compat[key]]));
export function registryModelThinking(model,base={}){
  if(!Array.isArray(model?.reasoningEfforts))return {};
  const levels=['off','minimal','low','medium','high','xhigh','max'];
  if(!model.reasoningEfforts.some(level=>level!=='off'))return {reasoning:false};
  return {reasoning:true,thinkingLevelMap:Object.fromEntries(levels.filter(level=>level!=='off'||!model.reasoningEfforts.includes('off')||base.thinkingLevelMap?.off!==undefined).map(level=>[level,model.reasoningEfforts.includes(level)?Object.hasOwn(base.thinkingLevelMap||{},level)?base.thinkingLevelMap[level]:level:null]))};
}

// Independent adapters keep Client routes out of the user's llm-pi-ai row:
// DSH home/profile patches replace that row rather than merging providers.
export async function installRegistryAdapters(ctx,config){
  if(!config)return;
  const {PiAiAdapter}=await import(pathToFileURL(config.adapterPath).href);
  const {InMemoryCredentialStore}=await import(pathToFileURL(path.join(config.piDist,'auth/credential-store.js')).href);
  const profiles=new Map();
  for(const [route,spec] of Object.entries(config.providers||{})){
    if(!/^suna-api-[a-f0-9]{24}$/.test(route)||!/^SUNA_PROVIDER_[A-F0-9]{64}_API_KEY$/.test(spec.apiKeyEnv))throw new Error('Invalid Client provider identity');
    const protocol=await import(pathToFileURL(path.join(config.piDist,'api',spec.api+'.js')).href);
    const models=spec.models.map(value=>({id:value.id,name:value.name||value.id,provider:route,api:spec.api,baseUrl:spec.baseURL,input:value.input||['text'],reasoning:false,...(value.compat?{compat:value.compat}:{}),cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:value.contextWindow||128000,maxTokens:value.maxTokens||4096,...registryModelThinking({reasoningEfforts:value.reasoningEfforts===false?['off']:value.reasoningEfforts?Object.keys(value.reasoningEfforts):undefined})}));
    const piProvider={id:route,name:spec.displayName,baseUrl:spec.baseURL,auth:{apiKey:{name:route,resolve:async({credential})=>({auth:credential?.key?{apiKey:credential.key}:{},source:route})}},getModels:()=>models,stream:protocol.stream,streamSimple:protocol.streamSimple};
    profiles.set(route,{provider:route,displayName:spec.displayName,piProvider,apiKeyEnv:spec.apiKeyEnv,modelErrors:new Map(),configuredMaxTokens:new Map(),streamIdleTimeoutMs:300000,maxRequestImageBytes:8*1024*1024,requestImagePixelBudget:4096*4096,requestImageMaxBytes:8*1024*1024,retryPolicy:createClientRetryPolicy()});
  }
  if(profiles.size)ctx.llm.registerAdapter([...profiles.keys()],new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async(_route,profile)=>{const key=process.env[profile.apiKeyEnv];if(!key)throw new Error('Client provider API Key is missing');return key;},auth:{credentials:new InMemoryCredentialStore(),authContext:{env:async()=>undefined,fileExists:async()=>false}}}));
}
export function registryApiProfiles(providers){
  return Object.fromEntries(providers.filter(p=>p.kind==='api-key').map(provider=>[registryProviderRoute(provider),{
    displayName:provider.name,apiKeyEnv:registryProviderEnv(provider),api:provider.api||'openai-completions',baseURL:provider.baseURL||'https://api.deepseek.com/v1',
    defaultContextWindow:128000,defaultMaxTokens:4096,retryPolicy:createClientRetryPolicy(),
    models:(provider.models||[]).map(model=>({id:model.id,name:model.name||model.id,contextWindow:model.contextWindow||128000,...(typeof model.temperatureSupported==='boolean'?{temperatureSupported:model.temperatureSupported}:{}),compat:temperatureCompat(model),
      ...(Array.isArray(model.reasoningEfforts)?{reasoningEfforts:model.reasoningEfforts.some(level=>level!=='off')?Object.fromEntries(model.reasoningEfforts.map(level=>[level,level==='off'?null:level])):false}:{}),input:model.imageInput?['text','image']:model.input||['text']})),
  }]));
}
export function registrySelectionRoute({provider,selection}){
  const model=provider.models?.find(model=>model.id===selection.modelId);
  if(!model)throw Object.assign(new Error('选择的模型不在提供商中'),{code:'MODEL_NOT_CONFIGURED'});
  const route=provider.kind==='dsh'?model.upstreamProvider:registryProviderRoute(provider);
  if(!route)throw Object.assign(new Error('DSH 模型缺少提供商'),{code:'MODEL_NOT_CONFIGURED'});
  return {provider:route,model:provider.kind==='dsh'?(model.upstreamModel||model.id):model.id,reasoningEffort:selection.reasoningEffort,...(selection.temperature!==undefined?{temperature:selection.temperature}:{})};
}
