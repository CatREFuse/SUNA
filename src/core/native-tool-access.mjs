import {randomUUID} from 'node:crypto';

export const isNativeToolId=value=>typeof value==='string'&&/^native:[A-Za-z_][A-Za-z0-9_.:/-]{0,199}$/.test(value);
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const fields=new Set(['stage','toolId','callId','rootCallId','argsDigest','leaseId','permissionRevision']);
const sameCall=(left,right)=>['toolId','callId','rootCallId','argsDigest'].every(key=>left[key]===right[key]);

// One instance belongs to one server-owned run. Callers never supply a role,
// conversation, sender, workspace, or permission policy through this protocol.
export function createNativeToolAccess({checkPermission,isToolEnabled,assertCurrent=()=>{},signal,now=Date.now,leaseMs=3000,maxCalls=128}={}){
  if(typeof checkPermission!=='function'||typeof isToolEnabled!=='function'||!Number.isSafeInteger(leaseMs)||leaseMs<100||leaseMs>30000)throw new TypeError('Invalid native tool access dependencies');
  const controller=new AbortController(),leases=new Map(),calls=new Set();let closed=false,epoch=0;
  const deny=reason=>({allowed:false,reason});
  function revoke(){epoch++;leases.clear();controller.abort();}
  const abort=()=>revoke();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)revoke();
  const live=()=>!closed&&!controller.signal.aborted&&!signal?.aborted;
  async function authorize(spec,{signal:requestSignal}={}){
    if(!spec||typeof spec!=='object'||Array.isArray(spec)||![Object.prototype,null].includes(Object.getPrototypeOf(spec))||Reflect.ownKeys(spec).some(key=>typeof key!=='string'||!fields.has(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(spec,key),'value'))||!['before','recheck','after'].includes(spec.stage)||!isNativeToolId(spec.toolId)||!identifier(spec.callId)||!identifier(spec.rootCallId)||typeof spec.argsDigest!=='string'||!/^([a-f0-9]{64})$/.test(spec.argsDigest))return deny('NATIVE_AUTH_INVALID');
    spec=Object.freeze({...spec});
    const finishing=spec.stage==='after'?leases.get(spec.leaseId):undefined;
    if(finishing&&sameCall(finishing,spec)&&finishing.permissionRevision===spec.permissionRevision)leases.delete(finishing.leaseId);
    if(!live()||requestSignal?.aborted)return deny('NATIVE_AUTH_REVOKED');
    const revision=epoch;
    try{
      assertCurrent();
      if(!await isToolEnabled(spec.toolId))return deny('NATIVE_TOOL_DISABLED');
      if(!live()||requestSignal?.aborted||revision!==epoch)return deny('NATIVE_AUTH_REVOKED');
      assertCurrent();
      const permission=checkPermission(spec.toolId);
      const allowed=permission?.allowed,permissionRevision=permission?.revision;
      if(!allowed||!Number.isSafeInteger(permissionRevision)||permissionRevision<0)return deny('NATIVE_PERMISSION_DENIED');
      const at=now();if(!Number.isFinite(at))return deny('NATIVE_AUTH_INVALID');
      if(!live()||requestSignal?.aborted||revision!==epoch)return deny('NATIVE_AUTH_REVOKED');
      let lease;
      if(spec.stage==='before'){
        if(spec.leaseId!==undefined||spec.permissionRevision!==undefined||calls.has(spec.callId)||calls.size>=maxCalls)return deny('NATIVE_AUTH_INVALID');
        lease={...spec,leaseId:randomUUID(),permissionRevision,expiresAt:at+leaseMs};
        leases.set(lease.leaseId,lease);calls.add(spec.callId);
      }else{
        lease=spec.stage==='after'?finishing:leases.get(spec.leaseId);
        if(!lease||!sameCall(lease,spec)||lease.permissionRevision!==spec.permissionRevision||lease.permissionRevision!==permissionRevision||lease.expiresAt<=at){if(lease)leases.delete(lease.leaseId);return deny('NATIVE_AUTH_STALE');}
        if(spec.stage==='after')leases.delete(lease.leaseId);else lease.expiresAt=at+leaseMs;
      }
      return {allowed:true,leaseId:lease.leaseId,permissionRevision:lease.permissionRevision,expiresAt:lease.expiresAt};
    }catch{return deny('NATIVE_PERMISSION_DENIED');}
  }
  return {authorize,signal:controller.signal,revoke,close(){if(closed)return;closed=true;revoke();calls.clear();signal?.removeEventListener('abort',abort);}};
}
