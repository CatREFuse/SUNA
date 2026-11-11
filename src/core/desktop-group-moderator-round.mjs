const failure=(code,message)=>Object.assign(new Error(message),{code});
const notify=(sink,value)=>{try{Promise.resolve(sink?.(structuredClone(value))).catch(()=>{});}catch{}};
/** A turn is a settled real role run, never a count of emitted text chunks. */
export async function runDesktopModeratorRound({roundId,maxTurns,signal,isCurrent,getCandidates,decide,dispatch,onState}={}){
 if(!Number.isSafeInteger(maxTurns)||maxTurns<1||maxTurns>21)throw failure('GROUP_DECISION_INPUT','群聊主持发言上限无效');
 const turns=[],used=new Set();let lastSpeaker;
 const current=()=>{if(signal?.aborted)throw signal.reason??failure('GROUP_DECISION_CANCELLED','群聊主持已停止');if(isCurrent?.()!==true)throw failure('GROUP_DECISION_STALE','群聊主持批次已失效');};
 const state=(status,extra={})=>notify(onState,{id:roundId,status,turns,...extra});
 try{
  for(let step=1;step<=maxTurns;step++){
   current();const jobs=getCandidates({step,lastSpeaker,turns}).filter(j=>j.characterId!==lastSpeaker&&!used.has(JSON.stringify([j.characterId,j.triggerIds])));
   if(!jobs.length){state('completed',{stopReason:'no-candidates'});return {status:'completed',turns,stopReason:'no-candidates'};}
   state('deciding',{step});const decision=await decide({step,jobs,turns});current();
   if(decision.nextCharacterId===null){state('completed',{stopReason:'moderator-finished'});return {status:'completed',turns,stopReason:'moderator-finished'};}
   const job=jobs.find(j=>j.characterId===decision.nextCharacterId);if(!job)throw failure('GROUP_DECISION_RESULT','群聊主持选择了无效角色');
   used.add(JSON.stringify([job.characterId,job.triggerIds]));state('running',{step,characterId:job.characterId});
   const run=await dispatch(job,{step});current();
   if(!run||run.status==='cancelled')throw failure('GROUP_DECISION_STALE','角色运行资格已失效，主持已停止');
   if(run.status==='skipped'){state('completed',{stopReason:'role-not-started'});return {status:'completed',turns,stopReason:'role-not-started'};}
   if(!['completed','silent'].includes(run.status))throw failure(run.code??'DESKTOP_MODERATOR_ROLE_FAILED','角色回复失败，主持已停止');
   turns.push({step,characterId:job.characterId,runId:run.id,status:run.status,inputUpperSequence:run.inputUpperSequence});lastSpeaker=job.characterId;state('ready',{step});
  }
  state('completed',{stopReason:'turn-limit'});return {status:'completed',turns,stopReason:'turn-limit'};
 }catch(error){state(signal?.aborted||['GROUP_DECISION_STALE','WORKER_CLIENT_SELECTION_CHANGED'].includes(error?.code)?'cancelled':'failed',{code:error?.code??'GROUP_DECISION_FAILED'});throw error;}
}
