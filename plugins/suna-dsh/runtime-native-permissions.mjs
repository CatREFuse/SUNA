// The DSH ToolRuntime owns native sandbox/approval decisions. This adapter only
// binds execution and result delivery to the live, explicitly mounted SUNA run.
export const RUNTIME_NATIVE_PROTOCOL='SUNA_RUNTIME_NATIVE_V2';
const DENIED='本轮原生执行已失效。';
const blocked=()=>({kind:'block',feedback:[{type:'text',text:DENIED}]});
export function installRuntimeNativeExecution(ctx,{run,agent,enabledNames=[],clientNames=[],signal,maxCalls=128}={}){
 if(!run||!agent||!Number.isSafeInteger(maxCalls)||maxCalls<1)throw new TypeError('Runtime execution binding required');
 const enabled=new Set(enabledNames),clients=new Set(clientNames),states=new Map(),seen=new Set(),abort=new AbortController(),disposers=[];let closed=false;
 const native=exec=>!clients.has(exec.name);
 const current=exec=>!closed&&!abort.signal.aborted&&!signal?.aborted&&!run.canceled&&!run.settling&&!run.nativeRevoked&&!run.authorityRestricted&&run.nativeLifecycle?.alive()!==false&&exec.agent===agent&&!exec.signal.aborted&&enabled.has(exec.name);
 const bound=(exec,state)=>current(exec)&&state&&state.token===exec.token&&state.agent===exec.agent&&state.name===exec.name&&state.callId===exec.callId&&state.rootCallId===exec.rootCallId;
 const revoke=()=>abort.abort(new Error(DENIED));
 signal?.addEventListener('abort',revoke,{once:true});if(signal?.aborted)revoke();
 disposers.push(ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!native(exec))return next();
  if(!current(exec)||seen.has(exec.token)||seen.size>=maxCalls)return {kind:'deny',reason:DENIED};
  seen.add(exec.token);const state={token:exec.token,agent:exec.agent,name:exec.name,callId:exec.callId,rootCallId:exec.rootCallId,phase:'checking'};states.set(exec.token,state);
  const decision=await next();
  if(!bound(exec,state))return {kind:'deny',reason:DENIED};
  state.phase=['allow','ask'].includes(decision.kind)?'admitted':'denied';
  return decision;
 },{prepend:true}));
 disposers.push(ctx.tools.guard(exec=>native(exec)&&!bound(exec,states.get(exec.token))?DENIED:undefined));
 disposers.push(ctx.on('tools/execute',async(exec,next)=>{
  if(!native(exec))return next();
  const state=states.get(exec.token);if(!bound(exec,state)||state.phase!=='admitted')throw new Error(DENIED);
  const original=exec.signal;exec.signal=AbortSignal.any([original,abort.signal,...signal?[signal]:[]]);
  try{const result=await next();if(!bound(exec,state))throw new Error(DENIED);return result;}finally{exec.signal=original;}
 },{prepend:true}));
 disposers.push(ctx.on('tools/post-execute',async(exec,_result,next)=>{
  if(!native(exec))return next();
  const state=states.get(exec.token);if(!bound(exec,state))return blocked();
  const decision=await next();return bound(exec,state)?decision:blocked();
 },{prepend:true}));
 disposers.push(ctx.on('tools/result',exec=>states.delete(exec.token)));
 const close=async()=>{if(closed)return;closed=true;revoke();signal?.removeEventListener('abort',revoke);for(const dispose of disposers.reverse())await dispose();states.clear();seen.clear();};
 ctx.on('dispose',close);return {revoke,close};
}

// A run-liveness lease is not a tool permission. It prevents an orphaned native
// process from outliving its Client connection, without asking Client to judge
// a tool, arguments, sender, sandbox mode or approval outcome.
export function createRuntimeNativeLifecycle({onExpired,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,ttlMs=10000}={}){
 if(typeof onExpired!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>60000)throw new TypeError('Invalid native lifecycle');
 let closed=false,timer,expiresAt=0;
 const close=()=>{closed=true;clearTimer(timer);};
 const expire=()=>{if(closed)return;close();onExpired();};
 const alive=()=>{if(closed)return false;if(!Number.isFinite(now())||expiresAt&&now()>=expiresAt){expire();return false;}return true;};
 function heartbeat(){if(!alive())return{ok:false,active:false};expiresAt=now()+ttlMs;clearTimer(timer);timer=setTimer(expire,ttlMs);timer?.unref?.();return{ok:true,active:true,expiresAt};}
 heartbeat();return{alive,heartbeat,close};
}
