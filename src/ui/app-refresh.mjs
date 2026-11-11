import {normalizeSnapshotCapabilities} from './snapshot-capabilities.mjs';
/** Read-only application refresh. Mutation/inference requests never pass here. */
export function createAppRefreshController({request,onSnapshot,onRuntime,onError,onSuccess=()=>{},onSettled=()=>{},onBusy=(_busy)=>{},timeoutMs=15000}) {
  let closed=false,bootstrapped=false,active=null,queued=null;
  const cancelled=()=>Object.assign(new Error('应用窗口已关闭'),{code:'APP_REFRESH_CLOSED'});
  function start() {
    const current={abort:new AbortController(),promise:null};
    active=current;onBusy(true);
    current.promise=Promise.resolve().then(async()=>{
      if(closed)return false;
      const signal=current.abort.signal;
      let rejectAbort;
      const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(signal.reason??cancelled());signal.addEventListener('abort',rejectAbort,{once:true});});
      const timeout=setTimeout(()=>current.abort.abort(Object.assign(new Error('应用数据读取超时，请重试。'),{code:'APP_READ_TIMEOUT'})),timeoutMs);
      const read=(path,commit)=>Promise.race([
        Promise.resolve().then(()=>{signal.throwIfAborted();return request(path,undefined,'GET',false,signal);}),aborted,
      ]).then(value=>{if(!closed&&!signal.aborted)commit(value);});
      try {
        const reads=[read('/snapshot',value=>onSnapshot(normalizeSnapshotCapabilities(value))),read('/runtime/status',onRuntime)];
        if(!bootstrapped)reads.push(read('/bootstrap',()=>{bootstrapped=true;}));
        const results=await Promise.allSettled(reads);
        if(closed)return false;
        const failed=results.find(result=>result.status==='rejected');
        if(failed){onError(failed.reason);return false;}
        onSuccess();return true;
      } finally {
        clearTimeout(timeout);signal.removeEventListener('abort',rejectAbort);
        if(!closed)onSettled();
      }
    }).finally(()=>{
      if(active!==current)return;
      active=null;
      if(closed)return;
      if(queued){const waiting=queued;queued=null;start().then(waiting.resolve,waiting.reject);}
      else onBusy(false);
    });
    return current.promise;
  }
  function refresh({queue=true}={}) {
    if(closed)return Promise.resolve(false);
    if(!active)return start();
    // A poll can share the current read; an event after that read began needs
    // one trailing read. Each caller waits for only its wave, never an endless
    // chain when SSE events continue to arrive.
    if(!queue)return active.promise;
    if(!queued){queued={};queued.promise=new Promise((resolve,reject)=>{queued.resolve=resolve;queued.reject=reject;});}
    return queued.promise;
  }
  function close() {
    if(closed)return;
    closed=true;active?.abort.abort(cancelled());queued?.resolve(false);queued=null;
  }
  return {refresh,close};
}
