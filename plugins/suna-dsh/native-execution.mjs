import {createHash} from 'node:crypto';

const DENIED='原生工具未获授权或授权已失效。';
const SANDBOX_CHANGE_DENIED='当前 SUNA 受限执行环境不支持 sandbox_permissions 权限变更，此请求未进入审批。请移除 sandbox_permissions 与 justification，使用当前沙箱权限执行。';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const nativeArgsDigest=args=>createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex');
const block=(reason=DENIED)=>({kind:'block',feedback:[{type:'text',text:reason}]});

/** Per-Agent, per-call gates around the official ToolRuntime pipeline. Neither
 * arguments nor result content crosses the authorization transport boundary.
 * A lease is indexed by the registry-owned token, never a model-supplied id.
 */
export function installNativeExecution(ctx,{officialPermissions=false,run,agent,enabledNames=[],clientNames=[],authorize,signal,now=Date.now,heartbeatMs=1000,authorizationTimeoutMs=5000,maxLeaseMs=30000}={}) {
  const enabled=new Set(enabledNames),clients=new Set(clientNames),records=new Map(),sandboxDenials=new Map(),reviewDenials=new Map(),runAbort=new AbortController(),disposers=[];
  let closed=false;
  const native=exec=>!clients.has(exec.name);
  const globallyValid=exec=>!closed&&!runAbort.signal.aborted&&!signal?.aborted&&!run.canceled&&!run.settling&&run.authorityRestricted!==true&&exec.agent===agent&&!exec.signal.aborted&&enabled.has(exec.name);
  const valid=(exec,state)=>globallyValid(exec)&&state&&!state.abort.signal.aborted&&state.exec.token===exec.token&&state.exec.name===exec.name&&state.exec.callId===exec.callId&&state.expiresAt>now();
  function sandboxChangeReason(exec){
    if(exec.arguments?.sandbox_permissions===undefined)return;
    if(officialPermissions&&['workspace-write','danger-full-access'].includes(exec.arguments.sandbox_permissions))return;
    // Official bash / mutating FS tools resolve escalation in their execute
    // bodies, after pre-execute. Only repeating a verified workspace-write mode
    // is a no-op there. Do not infer it from the backend's maximum capability:
    // a Session may currently be read-only, making the same argument widening.
    if(['bash','write','edit'].includes(exec.name)&&exec.arguments.sandbox_permissions==='workspace-write')try{
      const policy=(typeof ctx.get==='function'?ctx.get('sandboxPolicy'):ctx.sandboxPolicy)?.resolve({session:exec.agent.session});
      if(policy?.mode==='workspace-write')return;
    }catch{/* An unresolved policy cannot prove this is a same-mode call. */}
    // read-only is not an official escalation target. Passing it must not be
    // treated as an applied downgrade; omit the fields to honor standing policy.
    return SANDBOX_CHANGE_DENIED;
  }
  function rejectSandbox(exec,reason){sandboxDenials.set(exec.token,{name:exec.name,callId:exec.callId,reason});return {kind:'deny',reason};}
  function sandboxDenial(exec){const state=sandboxDenials.get(exec.token);return state?.name===exec.name&&state.callId===exec.callId?state.reason:undefined;}
  function stop(state){clearTimeout(state.expiry);clearTimeout(state.heartbeat);state.abort.abort(new Error(DENIED));}
  function armExpiry(state){clearTimeout(state.expiry);state.expiry=setTimeout(()=>stop(state),Math.max(0,state.expiresAt-now()));state.expiry.unref?.();}
  async function ask(exec,state,stage) {
    if(typeof authorize!=='function'||!globallyValid(exec)||stage!=='before'&&!valid(exec,state))return false;
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(new Error(DENIED)),authorizationTimeoutMs);timer.unref?.();
    const combined=AbortSignal.any([exec.signal,runAbort.signal,...(signal?[signal]:[]),state.abort.signal,timeout.signal]);
    const payload={stage,toolId:`native:${exec.name}`,callId:exec.callId,rootCallId:exec.rootCallId,argsDigest:state.digest,...(stage!=='before'?{leaseId:state.leaseId,permissionRevision:state.permissionRevision}:{})};
    let onAbort;
    try {
      const canceled=new Promise((_,reject)=>{onAbort=()=>reject(new Error(DENIED));combined.addEventListener('abort',onAbort,{once:true});if(combined.aborted)onAbort();});
      const result=await Promise.race([Promise.resolve().then(()=>authorize(payload,{signal:combined})),canceled]);
      if(!globallyValid(exec)||combined.aborted||!result||result.allowed!==true||result.authorityRestricted===true||typeof result.leaseId!=='string'||!result.leaseId||result.leaseId.length>200||!['string','number'].includes(typeof result.permissionRevision)||!Number.isFinite(result.expiresAt)||result.expiresAt<=now()||result.expiresAt>now()+maxLeaseMs)return false;
      if(stage!=='before'&&(result.leaseId!==state.leaseId||result.permissionRevision!==state.permissionRevision))return false;
      state.leaseId=result.leaseId;state.permissionRevision=result.permissionRevision;state.expiresAt=result.expiresAt;armExpiry(state);return true;
    }catch{return false;}
    finally{clearTimeout(timer);if(onAbort)combined.removeEventListener('abort',onAbort);}
  }
  function scheduleHeartbeat(exec,state) {
    if(state.finishing)return;
    if(!valid(exec,state))return stop(state);
    state.heartbeat=setTimeout(async()=>{
      if(state.finishing)return;
      state.heartbeatTask=ask(exec,state,'recheck');
      if(!await state.heartbeatTask)return stop(state);
      scheduleHeartbeat(exec,state);
    },Math.max(1,Math.min(heartbeatMs,Math.floor((state.expiresAt-now())/2))));state.heartbeat.unref?.();
  }
  disposers.push(ctx.on('tools/pre-execute',async(exec,next)=>{
    if(!native(exec))return next();
    if(!globallyValid(exec)||records.has(exec.token))return {kind:'deny',reason:DENIED};
    const reason=sandboxChangeReason(exec);if(reason)return rejectSandbox(exec,reason);
    const state={exec,digest:nativeArgsDigest(exec.arguments),abort:new AbortController(),expiresAt:0};records.set(exec.token,state);
    if(!await ask(exec,state,'before')){stop(state);records.delete(exec.token);return {kind:'deny',reason:DENIED};}
    scheduleHeartbeat(exec,state);
    let decision;try{decision=await next();}catch(error){stop(state);records.delete(exec.token);throw error;}
    if(!['allow','ask'].includes(decision.kind)){if(officialPermissions&&String(decision.reason??'').startsWith('Auto review'))reviewDenials.set(exec.token,{name:exec.name,callId:exec.callId,reason:decision.info?.code==='AUTO_REVIEW_DENIED'?'运行权限审核拒绝了此操作。':'运行权限审核失败，请检查模型连接。'});stop(state);records.delete(exec.token);return decision;}
    return valid(exec,state)?decision:{kind:'deny',reason:DENIED};
  },{prepend:true}));
  disposers.push(ctx.on('tools/result',exec=>{const state=records.get(exec.token);if(state)stop(state);records.delete(exec.token);sandboxDenials.delete(exec.token);reviewDenials.delete(exec.token);}));
  disposers.push(ctx.tools.guard(exec=>{
    if(!native(exec))return;
    const reason=sandboxDenial(exec)??sandboxChangeReason(exec);if(reason){rejectSandbox(exec,reason);return reason;}
    if(!valid(exec,records.get(exec.token)))return DENIED;
  }));
  disposers.push(ctx.on('tools/execute',async(exec,next)=>{
    if(!native(exec))return next();
    const reason=sandboxDenial(exec)??sandboxChangeReason(exec);if(reason){rejectSandbox(exec,reason);throw new Error(reason);}
    const state=records.get(exec.token);if(!valid(exec,state))throw new Error(DENIED);
    const original=exec.signal;exec.signal=AbortSignal.any([original,runAbort.signal,state.abort.signal,...(signal?[signal]:[])]);
    if(!state.heartbeat)scheduleHeartbeat(state.exec,state);
    try{return await next();}
    finally{state.finishing=true;clearTimeout(state.heartbeat);try{await state.heartbeatTask;}finally{exec.signal=original;}}
  },{prepend:true}));
  disposers.push(ctx.on('tools/post-execute',async(exec,_result,next)=>{
    if(!native(exec))return next();
    // Pre-execute denials also traverse the official post-execute pipeline. Keep
    // a composition rejection distinct from an absent/expired authorization.
    const reviewed=reviewDenials.get(exec.token);if(reviewed?.name===exec.name&&reviewed.callId===exec.callId){reviewDenials.delete(exec.token);return block(reviewed.reason);}
    const denied=sandboxDenial(exec);if(denied){const state=records.get(exec.token);if(state)stop(state);records.delete(exec.token);sandboxDenials.delete(exec.token);return block(denied);}
    const state=records.get(exec.token);
    try {
      if(!valid(exec,state))return block();
      const decision=await next();
      if(decision.kind==='block')return decision;
      if(!await ask(exec,state,'after')||!valid(exec,state))return block();
      return decision;
    }catch{return block();}
    finally{if(state)stop(state);records.delete(exec.token);}
  },{prepend:true}));
  const revoke=()=>{runAbort.abort(new Error(DENIED));for(const state of records.values())stop(state);};
  const close=async()=>{if(closed)return;closed=true;revoke();for(const dispose of disposers.reverse())await dispose();records.clear();sandboxDenials.clear();reviewDenials.clear();};
  ctx.on('dispose',close);
  return {revoke,close};
}
