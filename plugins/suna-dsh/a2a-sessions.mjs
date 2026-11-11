const intrinsicRoleTools=['suna_self','suna_memory','suna_contacts','suna_create_bot','suna_create_group','suna_invite','suna_peer_message','suna_role_capabilities'];
import {randomUUID} from 'node:crypto';
const invalid=()=>{throw Object.assign(new Error('Invalid Host-owned A2A scope'),{code:'A2A_SCOPE_INVALID'});};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const context=v=>typeof v==='string'&&/^suna-a2a-[a-f0-9-]{36}$/.test(v);
/** Plugin-only watchdog. It never stops the shared runtime or a normal context. */
export function createA2aSessions({now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,isOwnedSession=()=>false,runtimeId=randomUUID(),restoredContexts=[],restoredChains=[],persist=async()=>{}}={}){
 const contexts=new Map(),chains=new Map(restoredChains.map(id=>[id,{closed:true,expiresAt:0}])),retiredContexts=new Set(restoredContexts);let closed=false,persistTail=Promise.resolve();
 const save=()=>{const snapshot={contexts:[...contexts.values()].map(scope=>({contextId:scope.contextId,chainId:scope.chainId,characterId:scope.characterId})),closedChains:[...chains].filter(([,value])=>value.closed).map(([id])=>id)};const task=persistTail.catch(()=>{}).then(()=>persist(snapshot));persistTail=task;void task.catch(()=>{});return task;};
 function prepare(request){
  if(!request.a2a){if(request.contextId?.startsWith('suna-a2a-'))invalid();return;}
  const s=request.a2a;if(retiredContexts.has(request.contextId)||closed||!s||Object.keys(s).some(k=>!['protocol','chainId','characterId','senderSessionId','runtimeId','expiresAt'].includes(k))||s.protocol!=='SUNA_A2A_V1'||s.runtimeId!==runtimeId||!id(s.chainId)||!id(s.characterId)||!id(s.senderSessionId)||!isOwnedSession(s.senderSessionId)||!context(request.contextId)||!Number.isSafeInteger(s.expiresAt)||s.expiresAt<=now()||s.expiresAt>now()+300000||!Array.isArray(request.tools)||request.tools.some(name=>!['send_message','end_a2a_session',...intrinsicRoleTools].includes(name))||request.nativeTools?.allow?.length||request.runtimePermission||request.inputSource||request.runtimeReviewInstruction)invalid();
  const chain=chains.get(s.chainId);if(chain?.closed||chain&&chain.expiresAt!==s.expiresAt)invalid();
  const owned=contexts.get(request.contextId);if(owned&&(owned.chainId!==s.chainId||owned.characterId!==s.characterId))invalid();
  if(!chain)chains.set(s.chainId,{expiresAt:s.expiresAt,closed:false});if(!owned)contexts.set(request.contextId,{...s,contextId:request.contextId,run:null});return save();
 }
 function closeChain(chainId){const chain=chains.get(chainId);if(chain)chain.closed=true;for(const scope of contexts.values())if(scope.chainId===chainId&&scope.run&&!scope.run.settled&&!scope.run.canceled)scope.cancel(scope.run);return save();}
 function bind(run,request,cancel){if(!request.a2a)return;const scope=contexts.get(request.contextId);scope.run=run;scope.cancel=cancel;run.a2a={...request.a2a};run.a2aTimer=setTimer(()=>{void closeChain(scope.chainId).catch(()=>{});},Math.max(1,scope.expiresAt-now()));run.a2aTimer?.unref?.();}
 function settled(run){if(!run.a2a)return;clearTimer(run.a2aTimer);delete run.a2aTimer;const scope=contexts.get(run.contextId);if(scope?.run===run)scope.lastSessionId=run.sessionId;void save().catch(()=>{});}
 async function end(input){
  if(!input||Object.keys(input).some(k=>!['chainId','contextIds','runtimeId'].includes(k))||input.runtimeId!==runtimeId||!id(input.chainId)||!Array.isArray(input.contextIds)||input.contextIds.length>20||input.contextIds.some(c=>!context(c)))invalid();
  for(const c of input.contextIds){const scope=contexts.get(c);if(scope&&scope.chainId!==input.chainId)invalid();}
  if(!chains.has(input.chainId))chains.set(input.chainId,{closed:true,expiresAt:now()});const sealed=closeChain(input.chainId);
  const owned=[...contexts.values()].filter(s=>s.chainId===input.chainId&&s.run);await Promise.allSettled(owned.map(s=>s.run.execution));
  try{await sealed;await save();}catch{return {ok:false,settled:false,closed:true,reason:'state-unconfirmed'};}return {ok:true,settled:owned.every(s=>s.run.settled===true&&!s.run.a2aCleanupFailed),closed:true};
 }
 function close(){closed=true;for(const chainId of chains.keys())void closeChain(chainId).catch(()=>{});for(const scope of contexts.values())if(scope.run)clearTimer(scope.run.a2aTimer);}
 return {runtimeId,prepare,bind,settled,end,close,flush:()=>persistTail};
}
