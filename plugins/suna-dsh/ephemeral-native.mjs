import {inputBudgetFromModel} from './final-context-budget.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
// Native Responses stays native: only its final HTTP request traverses the
// authenticated Client relay. Pixels never enter the DSH process or transcript.
export function createNativeImageTransport(ctx,config,{fetchImpl=fetch}={}){
 if(!config)return null;
 const token=process.env[config.tokenEnv||'SUNA_OPENAI_IMAGE_TOKEN'];
 const endpoint=new URL(config.endpoint);
 if(!token||token.length<32||endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.username||endpoint.password)throw Error('Invalid native image transport');
 const route='suna-openai',sessions=new Map(),knownSessions=new Set(),mainDispatch=new AsyncLocalStorage();
 // DSH's public marker is checked at llm/stream, before model/tool projections
 // clone the envelope. Only this exact trusted loop invocation gets a main-call
 // context; absent or unknown purpose on unrelated calls remains auxiliary.
 function installMainClassifier(isAgentLoopRequest){
  if(typeof ctx.on!=='function'||typeof isAgentLoopRequest!=='function')return;
  ctx.on('llm/stream',(request,next)=>{
   const binding=sessions.get(String(request.sessionId));
   const main=request.purpose===undefined&&isAgentLoopRequest(request)&&binding&&binding.provider===request.provider&&binding.model===request.model;
   const scope=main?binding:undefined;
   return {[Symbol.asyncIterator](){const iterator=mainDispatch.run(scope,()=>next()[Symbol.asyncIterator]());return {next:value=>mainDispatch.run(scope,()=>iterator.next(value)),return:value=>mainDispatch.run(scope,()=>iterator.return?iterator.return(value):Promise.resolve({done:true,value})),throw:error=>mainDispatch.run(scope,()=>iterator.throw?iterator.throw(error):Promise.reject(error)),[Symbol.asyncIterator](){return this;}};}};
  });
 }
 async function control(kind,value){const response=await fetchImpl(new URL('/control/'+kind,endpoint),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(5000)});if(!response.ok){await response.body?.cancel();throw Error('Native image run binding failed');}await response.body?.cancel();}
 return {
  installMainClassifier,
  supports:provider=>provider===route,
  async start(run,request){if(request.provider!==route)return;if(!request.imageLeaseId)throw Error('Native image lease missing');const info=await ctx.llm.resolveModelInfo(request.provider,request.model);const binding={leaseId:request.imageLeaseId,runId:run.id,sessionId:run.sessionId,contextId:request.contextId,provider:request.provider,model:request.model,inputModalities:info.inputModalities,inputLimits:inputBudgetFromModel(info,{maxTokens:request.maxTokens||4096})};await control('start',binding);sessions.set(run.sessionId,binding);knownSessions.add(run.sessionId);},
    async budgetState(run,{consumeFailure=false,dropOldestHistoryImage=false}={}){const binding=sessions.get(run.sessionId);if(binding?.runId!==run.id)return undefined;const response=await fetchImpl(new URL('/control/budget',endpoint),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({runId:run.id,sessionId:run.sessionId,consumeFailure,dropOldestHistoryImage}),signal:AbortSignal.timeout(3000)});if(!response.ok){await response.body?.cancel();throw Error('Image budget metadata unavailable');}const state=await response.json();if(!Number.isSafeInteger(state.imageTokens)||state.imageTokens<0||state.imageTokens>1000000||typeof state.inputBudgetExceeded!=='boolean')throw Error('Invalid image budget metadata');return state;},
  async restrict(run){const binding=sessions.get(run.sessionId);if(binding?.runId===run.id)await control('restrict',{runId:run.id,sessionId:run.sessionId});},
  async end(run){const binding=sessions.get(run.sessionId);if(binding?.runId!==run.id)return;sessions.delete(run.sessionId);await control('end',{runId:run.id,sessionId:run.sessionId});},
  fetchFor(request){
   const sessionId=String(request.sessionId),binding=sessions.get(sessionId),purpose=request.purpose==='conversation'||(request.purpose===undefined&&binding&&mainDispatch.getStore()===binding&&request.provider===binding.provider&&request.model===binding.model)?'conversation':'auxiliary';
   if(!binding){if(knownSessions.has(sessionId))throw Error('Native image run ended');return undefined;}
   return async(input,init)=>{
    if(sessions.get(sessionId)!==binding)throw Error('Native image run ended');
    const native=new Request(input,init);
    if(native.url!=='https://api.openai.com/v1/responses'||native.method!=='POST')throw Error('Unsupported native Responses endpoint');
    let payload;try{payload=JSON.parse(await native.text());}catch{throw Error('Invalid native Responses request');}
    if(payload.model!==binding.model||!Array.isArray(payload.input))throw Error('Native Responses model binding mismatch');
    if(sessions.get(sessionId)!==binding)throw Error('Native image run ended');
    return fetchImpl(new URL('/v1/responses',endpoint),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-suna-run':binding.runId,'x-suna-session':binding.sessionId,'x-suna-purpose':purpose},body:JSON.stringify({payload,headers:Object.fromEntries(native.headers)}),signal:native.signal});
   };
  }
 };
}
