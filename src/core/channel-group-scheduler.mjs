/** Channel-only scheduling. No database, model, transport, credentials or UI access. */
export const CHANNEL_GROUP_TIMING_DEFAULTS=Object.freeze({historyLimit:64,directDebounceMs:5000,followupBatches:3,idleMs:30000,messageThreshold:15});
export const CHANNEL_GROUP_MEMORY_LIMITS=Object.freeze({recentEntries:8192,idleContexts:512});
const LIMITS=Object.freeze({historyLimit:[1,1000],directDebounceMs:[0,60000],followupBatches:[0,20],idleMs:[10,300000],messageThreshold:[1,1000]});
const invalid=message=>Object.assign(new Error(message),{code:'INVALID_CHANNEL_GROUP_TIMING'});
const clone=value=>structuredClone(value);
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=512&&value===value.trim()&&!/[\x00-\x1f]/.test(value);
const contextKey=(characterId,conversationId)=>JSON.stringify([characterId,conversationId]);
const actorKey=trigger=>JSON.stringify([trigger.sender.type,trigger.sender.id]);
const iso=value=>new Date(value).toISOString();
function remember(set,key){set.delete(key);set.add(key);if(set.size>CHANNEL_GROUP_MEMORY_LIMITS.recentEntries)set.delete(set.values().next().value);}
function recent(set,key){if(!set.has(key))return false;remember(set,key);return true;}

/** Only the new numeric fields. Existing decision/security flags remain Host-owned. */
export function validateChannelGroupTiming(patch,{global=false}={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw invalid('群聊调度参数必须为对象');
  const result={};
  for(const [key,value] of Object.entries(patch)){
    if(!Object.hasOwn(LIMITS,key))throw invalid(`未知群聊调度参数：${key}`);
    if(value===null&&!global){result[key]=null;continue;}
    const [min,max]=LIMITS[key];
    if(!Number.isSafeInteger(value)||value<min||value>max)throw invalid(`${key} 必须为 ${min} 至 ${max} 的整数`);
    result[key]=value;
  }
  return result;
}
export function mergeChannelGroupTiming(current={},patch,options){
  const clean=validateChannelGroupTiming(patch,options),result={...current};
  for(const [key,value] of Object.entries(clean))if(value===null)delete result[key];else result[key]=value;
  return result;
}
/** Defensive inheritance without changing legacy or persisted records. */
export function resolveChannelGroupTiming(global={},local={}){
  const result={};
  for(const [key,fallback] of Object.entries(CHANNEL_GROUP_TIMING_DEFAULTS)){
    const [min,max]=LIMITS[key],usable=value=>Number.isSafeInteger(value)&&value>=min&&value<=max;
    result[key]=usable(local?.[key])?local[key]:usable(global?.[key])?global[key]:fallback;
  }
  return result;
}

/**
 * getPolicy=null means genuinely unavailable; enabled=false disables decisions,
 * never a valid explicit direct reply. The Host performs durable admission and
 * claims, validates immutable account leases, and supplies only newly admitted
 * eligible offers. The local 8192-entry LRU is a bounded optimization, never
 * the authoritative replay barrier; durable Host admission owns old duplicates.
 *
 * Direct/watch windows are per role+conversation+sender type/id. A window seals
 * at its actual debounce boundary, even while a previous model run is busy.
 * Direct jobs precede decision jobs. Decision callbacks combine ready roles in
 * the same group, taking at most one job per role in each callback.
 */
export function createChannelGroupScheduler({getPolicy,isBusy=()=>false,onDirectDue,onDecisionDue,onChange=()=>{},onError=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  if(typeof getPolicy!=='function'||typeof onDirectDue!=='function'||typeof onDecisionDue!=='function')throw new TypeError('Channel scheduler requires getPolicy/onDirectDue/onDecisionDue');
  const contexts=new Map(),tasks=new Set();
  let closed=false,nextBatch=0,nextWatch=0,pumpQueued=false,pumpPromise=Promise.resolve();
  function context(characterId,conversationId,create=true){
    const key=contextKey(characterId,conversationId);
    if(!contexts.has(key)&&create)contexts.set(key,{key,characterId,conversationId,seen:new Set(),direct:new Map(),followup:new Map(),watchers:new Map(),ambient:null,ready:[],flight:null,proofs:new Map(),latestDirect:new Map(),known:new Map(),requeued:new Set(),retired:new Set(),lastActivityAt:-Infinity,lastResult:null});
    const ctx=contexts.get(key);if(ctx&&create){contexts.delete(key);contexts.set(key,ctx);}return ctx;
  }
  const idle=ctx=>!ctx.direct.size&&!ctx.followup.size&&!ctx.watchers.size&&!ctx.ambient&&!ctx.ready.length&&!ctx.flight&&!ctx.proofs.size;
  function compact(job){
    const trigger={};for(const key of ['id','conversationId','sequence','kind','automatic','externalId','groupRootId'])if(job.trigger[key]!==undefined)trigger[key]=job.trigger[key];
    trigger.sender={type:job.trigger.sender.type,id:job.trigger.sender.id};
    return {...job,trigger,ids:new Set([job.trigger.id]),timer:undefined};
  }
  function gc(ctx){
    for(const [actor,batchId] of ctx.latestDirect)if(!ctx.proofs.has(batchId)&&ctx.watchers.get(actor)?.batchId!==batchId)ctx.latestDirect.delete(actor);
    const keep=new Set([...(ctx.flight?[ctx.flight.job.batchId]:[]),...ctx.ready.map(job=>job.batchId),...ctx.proofs.keys(),...[...ctx.watchers.values()].map(watch=>watch.batchId)]);
    for(const [batchId,job] of ctx.known)if(!keep.has(batchId))ctx.known.delete(batchId);else if(job.kind==='direct')ctx.known.set(batchId,compact(job));
  }
  function collectIdle(){
    if(contexts.size<=CHANNEL_GROUP_MEMORY_LIMITS.idleContexts)return;
    let count=0;for(const ctx of contexts.values())if(idle(ctx))count++;
    if(count<=CHANNEL_GROUP_MEMORY_LIMITS.idleContexts)return;
    for(const [key,ctx] of contexts)if(idle(ctx)){contexts.delete(key);if(--count<=CHANNEL_GROUP_MEMORY_LIMITS.idleContexts)break;}
  }
  function cleanup(ctx){gc(ctx);collectIdle();}
  const liveSource=(ctx,id)=>[...ctx.direct.values(),...ctx.followup.values(),...(ctx.ambient?[ctx.ambient]:[]),...ctx.ready,...(ctx.flight?[ctx.flight.job]:[])].some(job=>job.ids.has(id));
  function report(error,job){try{onError(error,job);}catch{}}
  function policy(ctx){try{const raw=getPolicy(ctx.characterId,ctx.conversationId);return raw?{...raw,...resolveChannelGroupTiming(raw),enabled:raw.enabled!==false}:null;}catch(error){report(error,{characterId:ctx.characterId,conversationId:ctx.conversationId});return null;}}
  const available=ctx=>!closed&&policy(ctx)!==null;
  function busy(ctx){try{return !!isBusy(ctx.characterId,ctx.conversationId);}catch(error){report(error,{characterId:ctx.characterId,conversationId:ctx.conversationId});return true;}}
  function clear(job){if(job.timer!==undefined)clearTimer(job.timer);job.timer=undefined;}
  function view(job){return {characterId:job.characterId,conversationId:job.conversationId,kind:job.kind,route:job.kind==='direct'?'direct':'ambient',batchId:job.batchId,trigger:clone(job.trigger),replyAnchorId:job.replyAnchorId,triggerIds:[...job.ids],messageCount:job.ids.size,firstAt:job.firstAt,lastAt:job.lastAt,dueAt:iso(job.due),...(job.senderId?{senderId:job.senderId,senderType:job.senderType}:{}),...(job.parentBatchId?{parentBatchId:job.parentBatchId}:{}),waitingForRun:job.sealed===true};}
  function stateFor(ctx){
    let phase='idle';
    if(closed)phase='closed';
    else if(ctx.flight)phase=ctx.flight.started?(ctx.flight.job.kind==='direct'?'replying':'deciding'):'queued';
    else if(ctx.direct.size)phase='debouncing-direct';
    else if(ctx.ready.length)phase=busy(ctx)?'waiting-for-run':'queued';
    else if(ctx.followup.size)phase='debouncing-watch';
    else if(ctx.watchers.size)phase='watching';
    else if(ctx.ambient)phase='waiting-ambient';
    return {characterId:ctx.characterId,conversationId:ctx.conversationId,phase,pendingDirect:[...ctx.direct.values()].map(job=>({senderId:job.senderId,senderType:job.senderType,replyAnchorId:job.replyAnchorId,messageCount:job.ids.size,dueAt:iso(job.due)})),watchers:[...ctx.watchers.values()].map(watch=>({senderId:watch.senderId,senderType:watch.senderType,remainingBatches:watch.remaining,startedByTriggerId:watch.triggerId})),ambient:ctx.ambient?{messageCount:ctx.ambient.ids.size,dueAt:iso(ctx.ambient.due),threshold:policy(ctx)?.messageThreshold??CHANNEL_GROUP_TIMING_DEFAULTS.messageThreshold}:null,readyCount:ctx.ready.length,lastResult:ctx.lastResult?{...ctx.lastResult}:null};
  }
  const changed=ctx=>{try{onChange(stateFor(ctx));}catch(error){report(error,{characterId:ctx.characterId,conversationId:ctx.conversationId});}};
  function result(ctx,job,status,code){ctx.lastResult={kind:job.kind,batchId:job.batchId,status,stage:'dispatch',at:iso(now()),...(code?{code}:{})};}
  function make(ctx,trigger,kind,at,{anchor=trigger.id,ids=[trigger.id],firstAt=at,lastAt=at,parentBatchId}={}){
    const job={characterId:ctx.characterId,conversationId:ctx.conversationId,kind,batchId:`channel-batch-${++nextBatch}`,trigger:clone(trigger),replyAnchorId:anchor,ids:new Set(ids),firstAt,lastAt,due:at,sealed:false,timer:undefined,...(parentBatchId?{parentBatchId}:{})};
    if(kind!=='ambient'){job.actor=actorKey(trigger);job.senderId=trigger.sender.id;job.senderType=trigger.sender.type;}
    return job;
  }
  function update(job,trigger,at,ids=[trigger.id]){
    for(const id of ids)job.ids.add(id);
    if((trigger.sequence??0)>=(job.trigger.sequence??0))job.trigger=clone(trigger);
    job.firstAt=Math.min(job.firstAt,at);job.lastAt=Math.max(job.lastAt,at);
  }
  function removeWaiting(ctx,job){
    clear(job);
    if(job.kind==='direct'&&ctx.direct.get(job.actor)===job)ctx.direct.delete(job.actor);
    if(job.kind==='watch'&&ctx.followup.get(job.actor)===job)ctx.followup.delete(job.actor);
    if(job.kind==='ambient'&&ctx.ambient===job)ctx.ambient=null;
  }
  function arm(ctx,job){
    clear(job);if(closed)return;
    const current=policy(ctx);
    if(!current||job.kind!=='direct'&&!current.enabled){removeWaiting(ctx,job);changed(ctx);return;}
    job.due=job.kind==='ambient'?Math.max(job.lastAt,ctx.lastActivityAt)+current.idleMs:job.lastAt+current.directDebounceMs;
    if(job.kind==='ambient'&&job.ids.size>=current.messageThreshold)job.due=now();
    const delay=job.due-now();
    if(delay<=0){seal(ctx,job);return;}
    job.timer=setTimer(()=>seal(ctx,job),delay);job.timer?.unref?.();
  }
  function seal(ctx,job){
    if(closed||job.sealed)return;
    const waiting=job.kind==='direct'?ctx.direct.get(job.actor):job.kind==='watch'?ctx.followup.get(job.actor):ctx.ambient;
    if(waiting!==job)return;
    const current=policy(ctx);
    if(!current||job.kind!=='direct'&&!current.enabled){removeWaiting(ctx,job);changed(ctx);return;}
    const due=job.kind==='ambient'?Math.max(job.lastAt,ctx.lastActivityAt)+current.idleMs:job.lastAt+current.directDebounceMs;
    if(job.kind==='ambient'&&job.ids.size>=current.messageThreshold)job.due=now();else if(due>now()){arm(ctx,job);return;}else job.due=due;
    removeWaiting(ctx,job);job.sealed=true;
    if(job.kind==='watch'){
      const watch=ctx.watchers.get(job.actor);
      if(!watch||watch.token!==job.watchToken||watch.remaining<=0){changed(ctx);return;}
      watch.remaining--;if(watch.remaining===0)ctx.watchers.delete(job.actor);
    }
    ctx.ready.push(job);changed(ctx);requestPump();
  }
  function absorbAmbient(ctx,job){
    if(ctx.ambient){for(const id of ctx.ambient.ids)job.ids.add(id);removeWaiting(ctx,ctx.ambient);}
    ctx.ready=ctx.ready.filter(candidate=>{if(candidate.kind!=='ambient')return true;for(const id of candidate.ids)job.ids.add(id);return false;});
  }
  function choose(ctx){
    if(ctx.flight||busy(ctx))return null;
    const current=policy(ctx);if(!current)return null;
    const direct=ctx.ready.find(job=>job.kind==='direct');if(direct)return direct;
    // Explicit debouncing has priority over already-due ambient decisions.
    if(ctx.direct.size||!current.enabled)return null;
    return ctx.ready[0]??null;
  }
  function occupy(ctx,job,controller){
    ctx.ready.splice(ctx.ready.indexOf(job),1);
    const task={ctx,job,controller,started:false,cancelled:false,promise:null};ctx.flight=task;ctx.known.set(job.batchId,job.kind==='direct'?compact(job):job);
    if(job.kind==='direct'){
      absorbAmbient(ctx,job);
      const prior=ctx.latestDirect.get(job.actor);if(prior)ctx.proofs.delete(prior);
      ctx.latestDirect.set(job.actor,job.batchId);ctx.proofs.set(job.batchId,{job:compact(job),controller,runId:null,used:false});
    }
    return task;
  }
  function launch(selected,direct){
    const signal=AbortSignal.any(selected.map(task=>task.controller.signal));
    const promise=Promise.resolve().then(()=>{
      const active=selected.filter(task=>{if(closed||task.cancelled||task.controller.signal.aborted)return false;const current=policy(task.ctx);return current&&(task.job.kind==='direct'||current.enabled);});
      if(!active.length||signal.aborted)return;
      for(const task of active){task.started=true;changed(task.ctx);}
      return direct?onDirectDue(view(active[0].job),{signal}):onDecisionDue(active.map(task=>view(task.job)),{signal});
    }).then(()=>{
      // The Host binds a real run synchronously when it creates that run. Once
      // this callback has settled, an unbound proof can no longer acquire a
      // legitimate future delivery; retire it without inferring any success.
      for(const task of selected)if(task.job.kind==='direct'&&task.ctx.proofs.get(task.job.batchId)?.runId===null)task.ctx.proofs.delete(task.job.batchId);
      for(const task of selected)if(!task.cancelled&&!task.controller.signal.aborted&&!(task.ctx.lastResult?.batchId===task.job.batchId&&task.ctx.lastResult.status==='delivered')){
        if(task.started)result(task.ctx,task.job,'completed');else {task.ctx.proofs.delete(task.job.batchId);result(task.ctx,task.job,'skipped','POLICY_UNAVAILABLE');}
      }
    },error=>{
      for(const task of selected){
        if(task.controller.signal.aborted||task.cancelled)continue;
        task.ctx.proofs.delete(task.job.batchId);result(task.ctx,task.job,'failed','CALLBACK_FAILED');
      }
      if(!signal.aborted)report(error,direct?view(selected[0].job):selected.map(task=>view(task.job)));
    }).finally(()=>{
      tasks.delete(promise);
      for(const task of selected){if(task.ctx.flight===task)task.ctx.flight=null;gc(task.ctx);changed(task.ctx);}
      collectIdle();
      requestPump();
    });
    tasks.add(promise);for(const task of selected){task.promise=promise;changed(task.ctx);}
  }
  function pump(){
    if(closed)return;
    // Node drains microtasks between timer callbacks. Seal every already-due
    // peer before choosing a group, so equal deadlines cannot split one batch.
    for(const ctx of contexts.values())for(const job of [...ctx.direct.values(),...ctx.followup.values(),...(ctx.ambient?[ctx.ambient]:[])])if(job.due<=now())seal(ctx,job);
    const considered=new Set();
    // First occupy direct jobs; the decision pass cannot race them in the same role.
    for(const ctx of contexts.values()){
      const job=choose(ctx);if(job?.kind==='direct')launch([occupy(ctx,job,new AbortController())],true);
    }
    for(const ctx of contexts.values()){
      if(considered.has(ctx.conversationId))continue;considered.add(ctx.conversationId);
      const selected=[];
      for(const candidate of contexts.values())if(candidate.conversationId===ctx.conversationId){const job=choose(candidate);if(job&&job.kind!=='direct')selected.push(occupy(candidate,job,new AbortController()));}
      if(selected.length)launch(selected,false);
    }
  }
  function requestPump(){
    if(closed||pumpQueued)return;pumpQueued=true;
    pumpPromise=Promise.resolve().then(()=>{pumpQueued=false;pump();}).catch(error=>report(error));
  }
  function offer({characterId,conversationId,trigger,direct=false,offeredAt=now()}={}){
    if(closed||typeof direct!=='boolean'||!validId(characterId)||!validId(conversationId)||!trigger||!validId(trigger.id)||trigger.conversationId!==undefined&&trigger.conversationId!==conversationId||trigger.sequence!==undefined&&(!Number.isSafeInteger(trigger.sequence)||trigger.sequence<0)||!['human','character'].includes(trigger.sender?.type)||!validId(trigger.sender.id)||!Number.isFinite(offeredAt))return false;
    const ctx=context(characterId,conversationId),current=policy(ctx);if(!current||recent(ctx.seen,trigger.id)||liveSource(ctx,trigger.id)){cleanup(ctx);return false;}
    ctx.lastActivityAt=Math.max(ctx.lastActivityAt,offeredAt);if(ctx.ambient)arm(ctx,ctx.ambient);
    remember(ctx.seen,trigger.id);const actor=actorKey(trigger),prior=ctx.direct.get(actor);
    if(direct||prior){
      const job=prior??make(ctx,trigger,'direct',offeredAt);
      if(prior)update(job,trigger,offeredAt);
      else {
        // A new explicit trigger supersedes its own not-yet-dispatched followups.
        const pending=ctx.followup.get(actor);if(pending){for(const id of pending.ids)job.ids.add(id);removeWaiting(ctx,pending);}
        ctx.ready=ctx.ready.filter(candidate=>{if(candidate.kind!=='watch'||candidate.actor!==actor)return true;for(const id of candidate.ids)job.ids.add(id);return false;});
      }
      ctx.direct.set(actor,job);arm(ctx,job);changed(ctx);cleanup(ctx);return true;
    }
    if(!current.enabled){cleanup(ctx);return false;}
    const watch=ctx.watchers.get(actor);
    if(watch&&watch.remaining>0){
      const job=ctx.followup.get(actor)??make(ctx,trigger,'watch',offeredAt);job.watchToken=watch.token;
      if(ctx.followup.has(actor))update(job,trigger,offeredAt);
      ctx.followup.set(actor,job);arm(ctx,job);changed(ctx);cleanup(ctx);return true;
    }
    // Busy ambient input coalesces into one sealed decision job, never a burst
    // of N/threshold model calls. Do not reopen it or move another sender's clock.
    const ready=ctx.ready.find(job=>job.kind==='ambient');
    if(ready){update(ready,trigger,offeredAt);changed(ctx);cleanup(ctx);requestPump();return true;}
    const job=ctx.ambient??make(ctx,trigger,'ambient',offeredAt);if(ctx.ambient)update(job,trigger,offeredAt);
    ctx.ambient=job;arm(ctx,job);changed(ctx);cleanup(ctx);return true;
  }
  /** Real but filtered group traffic still postpones ordinary group silence. */
  function observe({characterId,conversationId,offeredAt=now()}={}){
    const ctx=context(characterId,conversationId,false);
    if(closed||!ctx||!Number.isFinite(offeredAt)||!available(ctx))return false;
    ctx.lastActivityAt=Math.max(ctx.lastActivityAt,offeredAt);if(ctx.ambient)arm(ctx,ctx.ambient);changed(ctx);cleanup(ctx);return true;
  }
  function bindRun({characterId,conversationId,batchId,runId}={}){
    const ctx=context(characterId,conversationId,false),proof=ctx?.proofs.get(batchId);
    if(closed||!proof||proof.used||proof.controller.signal.aborted||!validId(runId)||!available(ctx)||proof.runId&&proof.runId!==runId)return false;
    proof.runId=runId;return true;
  }
  function delivered({characterId,conversationId,batchId,runId}={}){
    const ctx=context(characterId,conversationId,false),proof=ctx?.proofs.get(batchId);
    if(closed||!proof||proof.used||proof.controller.signal.aborted||!validId(runId)||proof.runId!==runId||ctx.latestDirect.get(proof.job.actor)!==batchId)return false;
    const current=policy(ctx);if(!current)return false;
    proof.used=true;ctx.proofs.delete(batchId);
    if(current.enabled&&current.followupBatches>0)ctx.watchers.set(proof.job.actor,{senderId:proof.job.senderId,senderType:proof.job.senderType,remaining:current.followupBatches,triggerId:proof.job.replyAnchorId,batchId,token:++nextWatch});
    result(ctx,proof.job,'delivered');changed(ctx);cleanup(ctx);return true;
  }
  /** Explicit Host failure/uncertainty settlement; completion never implies delivery. */
  function retireDelivery({characterId,conversationId,batchId,runId}={}){
    const ctx=context(characterId,conversationId,false),proof=ctx?.proofs.get(batchId);
    if(closed||!proof||proof.used||!validId(runId)||proof.runId!==runId)return false;
    proof.used=true;proof.job.retired=true;const known=ctx.known.get(batchId);if(known)known.retired=true;
    ctx.proofs.delete(batchId);remember(ctx.retired,batchId);cleanup(ctx);changed(ctx);return true;
  }
  /** Host-only: requeue only source IDs that the durable dispatch store still owns as pending. */
  function requeue(input){
    const ctx=context(input?.characterId,input?.conversationId,false),original=ctx?.known.get(input?.batchId);
    if(closed||!ctx||!original||original.retired||original.requeued||original.kind==='direct'||original.kind!==input.kind||!['watch','ambient'].includes(input.kind)||!Array.isArray(input.triggerIds)||!input.triggerIds.length||recent(ctx.requeued,input.batchId)||recent(ctx.retired,input.batchId))return false;
    const current=policy(ctx);if(!current?.enabled)return false;
    const allowed=new Set(original.ids);if(input.triggerIds.some(id=>!allowed.has(id)))return false;
    if(!input.trigger||!input.triggerIds.includes(input.trigger.id)||input.trigger.conversationId!==undefined&&input.trigger.conversationId!==ctx.conversationId)return false;
    const job=make(ctx,input.trigger,input.kind,now(),{anchor:input.replyAnchorId,ids:input.triggerIds,firstAt:input.firstAt??now(),lastAt:input.lastAt??now(),parentBatchId:input.batchId});
    original.requeued=true;remember(ctx.requeued,input.batchId);job.sealed=true;job.due=now();ctx.ready.push(job);changed(ctx);cleanup(ctx);requestPump();return true;
  }
  function cancel(predicate=()=>true){
    const removed=[];
    for(const ctx of contexts.values()){
      for(const job of [...ctx.direct.values(),...ctx.followup.values(),...(ctx.ambient?[ctx.ambient]:[])])if(predicate(view(job))){removeWaiting(ctx,job);job.retired=true;remember(ctx.retired,job.batchId);removed.push(view(job));result(ctx,job,'cancelled','CANCELLED');}
      ctx.ready=ctx.ready.filter(job=>{if(!predicate(view(job)))return true;job.retired=true;remember(ctx.retired,job.batchId);removed.push(view(job));result(ctx,job,'cancelled','CANCELLED');return false;});
      if(ctx.flight&&predicate(view(ctx.flight.job))){const task=ctx.flight;task.cancelled=true;task.job.retired=true;const known=ctx.known.get(task.job.batchId);if(known)known.retired=true;remember(ctx.retired,task.job.batchId);task.controller.abort(Object.assign(new Error('Channel scheduler batch cancelled'),{code:'RUN_CANCELLED'}));removed.push(view(task.job));result(ctx,task.job,'cancelled','CANCELLED');}
      for(const [batchId,proof] of ctx.proofs)if(predicate(view(proof.job))){proof.job.retired=true;const known=ctx.known.get(batchId);if(known)known.retired=true;remember(ctx.retired,batchId);proof.controller.abort(Object.assign(new Error('Channel scheduler delivery retired'),{code:'RUN_CANCELLED'}));ctx.proofs.delete(batchId);}
      // A watcher has no admitted message yet; apply the same scope predicate
      // using its verified direct anchor, without manufacturing a new batch.
      for(const [actor,watch] of ctx.watchers){const original=ctx.known.get(watch.batchId);if(original&&predicate(view({...original,kind:'watch'})))ctx.watchers.delete(actor);}
      gc(ctx);changed(ctx);
    }
    collectIdle();requestPump();return removed;
  }
  function reconfigure(conversationId){
    for(const ctx of contexts.values())if(conversationId===undefined||ctx.conversationId===conversationId){
      const current=policy(ctx);
      if(!current){cancel(job=>job.characterId===ctx.characterId&&job.conversationId===ctx.conversationId);continue;}
      if(!current.enabled){cancel(job=>job.characterId===ctx.characterId&&job.conversationId===ctx.conversationId&&job.kind!=='direct');ctx.watchers.clear();}
      for(const job of [...ctx.direct.values(),...ctx.followup.values(),...(ctx.ambient?[ctx.ambient]:[])])arm(ctx,job);
      changed(ctx);
    }
    requestPump();
  }
  function wake(_characterId,conversationId){for(const ctx of contexts.values())if(conversationId===undefined||ctx.conversationId===conversationId)changed(ctx);requestPump();}
  function retention(){
    const counts={contexts:contexts.size,idleContexts:0,seenEntries:0,maxSeenEntries:0,knownJobs:0,fullKnownTriggers:0,proofs:0,fullProofTriggers:0,watchers:0,latestDirect:0,requeuedEntries:0,maxRequeuedEntries:0,retiredEntries:0,maxRetiredEntries:0};
    const full=job=>Object.hasOwn(job.trigger,'text')||Object.hasOwn(job.trigger,'blocks');
    for(const ctx of contexts.values()){counts.idleContexts+=Number(idle(ctx));counts.seenEntries+=ctx.seen.size;counts.maxSeenEntries=Math.max(counts.maxSeenEntries,ctx.seen.size);counts.knownJobs+=ctx.known.size;counts.fullKnownTriggers+=[...ctx.known.values()].filter(full).length;counts.proofs+=ctx.proofs.size;counts.fullProofTriggers+=[...ctx.proofs.values()].filter(proof=>full(proof.job)).length;counts.watchers+=ctx.watchers.size;counts.latestDirect+=ctx.latestDirect.size;counts.requeuedEntries+=ctx.requeued.size;counts.maxRequeuedEntries=Math.max(counts.maxRequeuedEntries,ctx.requeued.size);counts.retiredEntries+=ctx.retired.size;counts.maxRetiredEntries=Math.max(counts.maxRetiredEntries,ctx.retired.size);}
    return counts;
  }
  return {offer,observe,bindRun,delivered,retireDelivery,requeue,cancel,reconfigure,wake,retention,pending:()=>[...contexts.values()].flatMap(ctx=>[...ctx.direct.values(),...ctx.followup.values(),...(ctx.ambient?[ctx.ambient]:[]),...ctx.ready].map(view)),state:({characterId,conversationId}={})=>characterId&&conversationId?(context(characterId,conversationId,false)?stateFor(context(characterId,conversationId,false)):null):[...contexts.values()].map(stateFor),close(){if(closed)return Promise.allSettled([...tasks]);cancel();closed=true;return Promise.allSettled([pumpPromise,...tasks]);}};
}
