import {inputBudgetFromModel} from './final-context-budget.mjs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createClientRetryPolicy} from './retry-policy.mjs';
import {registryModelThinking} from './registry-providers.mjs';
import {createMainCallClassifier} from './ephemeral-purpose.mjs';

/** Optional explicit provider. Ordinary external DSH routes remain untouched. */
export async function installEphemeralAdapter(ctx,config){
  if(!config)return null;
  const token=process.env[config.tokenEnv||'SUNA_EPHEMERAL_TOKEN'];
  if(!token||token.length<32)throw new Error('Ephemeral transport authentication is missing');
  const endpoint=new URL(config.endpoint);if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.username||endpoint.password)throw new Error('Ephemeral transport must be local');
  const {PiAiAdapter}=await import(pathToFileURL(config.adapterPath).href);
  const {isAgentLoopRequest}=await import(pathToFileURL(createRequire(config.adapterPath).resolve('@deepseek-ai/dsh-llm')).href);
  const protocol=await import(pathToFileURL(path.join(config.piDist,'api/openai-completions.js')).href);
  const {InMemoryCredentialStore}=await import(pathToFileURL(path.join(config.piDist,'auth/credential-store.js')).href);
  const route=config.provider,sessions=new Map();
  const classifier=createMainCallClassifier(ctx,{isAgentLoopRequest,resolveBinding:request=>sessions.get(request.sessionId)});
  const models=config.models.map(value=>({id:value.id,name:value.id,provider:route,api:'openai-completions',baseUrl:config.endpoint+'/v1',input:value.input,reasoning:false,...registryModelThinking(value),cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:value.contextWindow||32768,maxTokens:value.maxTokens||4096}));
  const piProvider={id:route,name:route,baseUrl:config.endpoint+'/v1',auth:{apiKey:{name:route,resolve:async({credential})=>({auth:credential?.key?{apiKey:credential.key}:{},source:route})}},getModels:()=>models,stream:protocol.stream,streamSimple:protocol.streamSimple};
  const profile={provider:route,displayName:'沙之书模型',piProvider,modelErrors:new Map(),configuredMaxTokens:new Map(),streamIdleTimeoutMs:300000,maxRequestImageBytes:8*1024*1024,requestImagePixelBudget:4096*4096,requestImageMaxBytes:8*1024*1024,retryPolicy:createClientRetryPolicy()};
  const auth={credentials:new InMemoryCredentialStore(),authContext:{env:async()=>undefined,fileExists:async()=>false}};
  const options={profiles:()=>new Map([[route,profile]]),resolveApiKey:async()=>token,auth};
  class BoundAdapter extends PiAiAdapter{
    async prepareCall(provider,model,signal){const prepared=await super.prepareCall(provider,model,signal);return {...prepared,stream:request=>this.stream(request)};}
    stream(request){
      const binding=typeof request.sessionId==='string'?sessions.get(request.sessionId):undefined;if(!binding)throw new Error('No active authenticated model run');
      classifier.assertBinding(request,binding);
      const purpose=classifier.purposeFor(request,binding);
      const bound={...profile,headers:{authorization:'Bearer '+token,'x-suna-run':binding.runId,'x-suna-session':binding.sessionId,'x-suna-purpose':purpose}};
      const stream=new PiAiAdapter({...options,profiles:()=>new Map([[route,bound]])}).stream({...request});
      const current=()=>{if(sessions.get(binding.sessionId)!==binding)throw new Error('Authenticated model run ended');};
      return {[Symbol.asyncIterator](){const iterator=stream[Symbol.asyncIterator]();const cleanup=async()=>{try{await iterator.return?.();}catch{}};return {async next(value){try{current();const result=await iterator.next(value);current();return result;}catch(error){await cleanup();throw error;}},return:value=>iterator.return?iterator.return(value):Promise.resolve({done:true,value}),async throw(error){try{current();return iterator.throw?await iterator.throw(error):Promise.reject(error);}catch(failure){await cleanup();throw failure;}},[Symbol.asyncIterator](){return this;}};}};
    }
  }
  ctx.llm.registerAdapter([route],new BoundAdapter(options));
  async function control(kind,value){const response=await fetch(new URL('/control/'+kind,endpoint),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(5000)});await response.body?.cancel();if(!response.ok)throw new Error('Ephemeral run binding failed');}
  return {
    supports:provider=>provider===route,
    async budgetState(run,{consumeFailure=false,dropOldestHistoryImage=false}={}){const binding=sessions.get(run.sessionId);if(binding?.runId!==run.id)return undefined;const response=await fetch(new URL('/control/budget',endpoint),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({runId:run.id,sessionId:run.sessionId,consumeFailure,dropOldestHistoryImage}),signal:AbortSignal.timeout(3000)});if(!response.ok){await response.body?.cancel();throw Error('Image budget metadata unavailable');}const state=await response.json();if(!Number.isSafeInteger(state.imageTokens)||state.imageTokens<0||state.imageTokens>1000000||typeof state.inputBudgetExceeded!=='boolean')throw Error('Invalid image budget metadata');return state;},
    async restrict(run){const binding=sessions.get(run.sessionId);if(binding?.runId===run.id)await control('restrict',{runId:run.id,sessionId:run.sessionId});},
    async start(run,request){if(request.provider!==route)return;const info=await ctx.llm.resolveModelInfo(request.provider,request.model);const binding=Object.freeze({leaseId:request.imageLeaseId,runId:run.id,sessionId:run.sessionId,contextId:request.contextId,provider:request.provider,model:request.model,inputModalities:info.inputModalities,inputLimits:inputBudgetFromModel(info,{maxTokens:request.maxTokens||4096})});await control('start',binding);sessions.set(run.sessionId,binding);},
    async end(run){const binding=sessions.get(run.sessionId);if(binding?.runId!==run.id)return;sessions.delete(run.sessionId);await control('end',{runId:run.id,sessionId:run.sessionId});}
  };
}
