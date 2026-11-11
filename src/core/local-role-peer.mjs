import {randomUUID,createHash} from 'node:crypto';
import {createLocalRoleMcpBinding} from '../mcp/local-role-client.mjs';
import {escapeA2aXml,projectA2aMarker,a2aInputXml} from './local-role-xml.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=structuredClone;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const deny=()=>fail('LOCAL_ROLE_INVALID_TARGET','通信目标必须是另一个实际角色');
const text={type:'string',minLength:1,maxLength:12000};
const sendSchema={type:'object',properties:{content:text,idempotencyKey:{type:'string',minLength:1,maxLength:160},terminate:{type:'boolean'}},required:['content','idempotencyKey'],additionalProperties:false};
const emptySchema={type:'object',properties:{},additionalProperties:false};
/** Host-only persistent A2A routes. No user conversation history is an input port. */
export function createLocalRolePeers({read,list,put,transaction,capabilities,character,project,assertOrigin,buildPrompts,workspace,executeKernel,endKernel,bindRoleTools,clock=()=>new Date().toISOString(),now=Date.now,lifetimeMs=60000,onModelCall=()=>{},changed=()=>{},deliveriesFor,queuedRows,sessionsFor,openRows}){
 let closed=false,draining;const active=new Map(),closing=new Map(),signals=new Map();
 const deliveries=deliveriesFor??(id=>list('local-role-delivery').filter(row=>row.chainId===id));const pending=queuedRows??(()=>list('local-role-delivery').filter(row=>row.status==='queued'));const liveChains=openRows??(()=>list('local-role-chain').filter(row=>row.status!=='ended'));const peerSessions=sessionsFor??(id=>list('local-role-peer-session').filter(row=>row.chainId===id));
 const chain=id=>{const row=read('local-role-chain',id);if(!row)fail('A2A_NOT_FOUND','通信会话不存在');return row;};
 function pair(actor,target){character(actor);character(target);const from=capabilities(actor),to=capabilities(target);if(actor===target)deny();return {from,to};}
 function origin(c){assertOrigin(c.rootActorId,c.originConversationId,c.anchorCreated?{id:c.anchorId,sequence:c.anchorSequence}:null);const budget=read('local-role-root-budget',c.rootBudgetId);if(budget?.cancelled)fail('RUN_CANCELLED','通信已取消');}
 function updateMarker(c){origin(c);const record=project({...projectA2aMarker(c,deliveries(c.id)),allowCreate:c.anchorCreated!==true,expectedSequence:c.anchorSequence});if(!c.anchorCreated){if(!Number.isSafeInteger(record?.sequence))fail('A2A_ANCHOR_NOT_FOUND','通信标记未建立');put('local-role-chain',c.id,{...c,anchorCreated:true,anchorSequence:record.sequence});}changed('local-role-communication.changed',{conversationId:c.originConversationId,anchorId:c.anchorId});}
 function updateMarkerIfPresent(c){try{project({...projectA2aMarker(c,deliveries(c.id)),allowCreate:false,expectedSequence:c.anchorSequence});changed('local-role-communication.changed',{conversationId:c.originConversationId,anchorId:c.anchorId});}catch(error){if(!['CONVERSATION_NOT_FOUND','CONVERSATION_INACTIVE','TARGET_DENIED','A2A_ANCHOR_NOT_FOUND'].includes(error.code))throw error;}}
 function queue(c,{actorId,targetId,content,hop,runId,triggerId,senderSessionId}){
  if(typeof senderSessionId!=='string'||!senderSessionId.length||senderSessionId.length>160)fail('A2A_SOURCE_UNVERIFIED','内核角色来源尚未确认');
  escapeA2aXml(content);origin(c);const {from,to}=pair(actorId,targetId),root=read('local-role-root-budget',c.rootBudgetId);
  if(c.status!=='active'||now()>=c.deadlineMs)fail('A2A_ENDED','通信会话已结束');
  if(hop>Math.min(c.maxHops,from.limits.maxHops)||c.used>=Math.min(c.maxMessages,from.limits.chainMessages)||root.used>=root.maxMessages)fail('LOCAL_ROLE_CHAIN_LIMIT','通信链已达到限制');
  const day=clock().slice(0,10),quotaId=hash([actorId,day]),quota=read('local-role-daily',quotaId);if((quota?.used??0)>=from.limits.dailyMessages)fail('LOCAL_ROLE_QUOTA','已达到今日通信数量限制');
  put('local-role-daily',quotaId,{characterId:actorId,day,used:(quota?.used??0)+1});put('local-role-root-budget',root.id,{...root,used:root.used+1});
  const next=put('local-role-chain',c.id,{...c,used:c.used+1});
  const row=put('local-role-delivery',`a2a_${randomUUID()}`,{chainId:c.id,anchorId:c.anchorId,originConversationId:c.originConversationId,actorId,targetId,content,senderSessionId,hop,ordinal:next.used,runId,triggerId,status:'queued',createdAt:clock()});updateMarker(next);return row;
 }
 const receipt=row=>({deliveryId:row.id,anchorId:row.anchorId,chainId:row.chainId,targetId:row.targetId,status:row.status,hop:row.hop});
 function enqueue({actorId,targetId,originConversationId,runId,triggerId,requestId,content,senderSessionId,signal}){
  const result=transaction(()=>{
   const {from}=pair(actorId,targetId);assertOrigin(actorId,originConversationId);const requestKey=hash([actorId,requestId]),fingerprint=hash(['suna_peer_message',originConversationId,targetId,content]);const previous=read('local-role-request',requestKey);
   if(previous){if(previous.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','requestId 已用于其他操作');return {...previous.result,duplicate:true};}
   const rootBudgetId=hash([actorId,originConversationId,triggerId]),budget=read('local-role-root-budget',rootBudgetId);if(budget?.cancelled)fail('RUN_CANCELLED','本轮通信已取消');
   if(!budget)put('local-role-root-budget',rootBudgetId,{rootActorId:actorId,originConversationId,triggerId,used:0,maxMessages:from.limits.chainMessages});
   const id=`a2a_${randomUUID()}`,c=put('local-role-chain',id,{rootActorId:actorId,rootTargetId:targetId,originConversationId,rootTriggerId:triggerId,rootBudgetId,anchorId:`a2a_marker_${randomUUID()}`,status:'active',used:0,maxHops:from.limits.maxHops,maxMessages:from.limits.chainMessages,deadlineMs:now()+lifetimeMs,closedCount:0,createdAt:clock()});
   const row=queue(c,{actorId,targetId,content,hop:1,runId,triggerId,senderSessionId});const value={...receipt(row),markerXml:projectA2aMarker(chain(c.id),deliveries(c.id)).text};put('local-role-request',requestKey,{characterId:actorId,runId,triggerId,operation:'suna_peer_message',fingerprint,result:value});return value;
  });
  if(!result.duplicate&&signal){const abort=()=>cancelChain(result.chainId,'cancelled');signals.set(result.chainId,{signal,abort});signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}
  queueMicrotask(()=>{void drain().catch(()=>{});});return result;
 }
 function markEnding(id,reason){return transaction(()=>{const c=chain(id);if(['ended','ending','closing_pending'].includes(c.status))return c;const saved=put('local-role-chain',id,{...c,status:'ending',endReason:reason});for(const row of deliveries(id))if(row.status==='queued')put('local-role-delivery',row.id,{...row,status:'cancelled'});updateMarkerIfPresent(saved);return saved;});}
 async function finish(id,reason){
  if(closing.has(id))return closing.get(id);if(chain(id).status==='ended')return;
  const task=(async()=>{let c=markEnding(id,reason);const contexts=peerSessions(id).filter(row=>row.neverDispatched!==true);let ended=false,closeProof=null;
   try{const groups=new Map();for(const row of contexts){const key=row.runtimeId??'unknown';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}const acks=await Promise.all([...groups.values()].map(rows=>endKernel({chainId:id,contextIds:rows.map(row=>row.contextId),runtimeId:rows[0].runtimeId,runtimePid:rows[0].runtimePid})));ended=acks.length>0&&acks.every(ack=>ack?.ok===true&&ack.settled===true);if(!contexts.length){ended=true;closeProof='never-dispatched';}else if(ended)closeProof=acks.every(ack=>ack.proof==='runtime-exited')?'runtime-exited':'kernel-settled';}catch{}
   transaction(()=>{c=chain(id);if(c.status==='ended')return;for(const row of deliveries(id))if(['claimed','queued'].includes(row.status))put('local-role-delivery',row.id,{...row,status:row.status==='claimed'&&reason==='restart'?'unknown':'cancelled'});
    if(ended)for(const row of contexts)put('local-role-peer-session',row.id,{...row,status:'closed',closedAt:clock()});
    const saved=put('local-role-chain',id,{...c,status:ended?'ended':'closing_pending',endReason:c.endReason??reason,...(ended?{closedAt:clock(),closedCount:1,closeProof}:{})});updateMarkerIfPresent(saved);
   });
   const entry=signals.get(id);entry?.signal.removeEventListener('abort',entry.abort);signals.delete(id);
  })().finally(()=>closing.delete(id));closing.set(id,task);return task;
 }
 function cancelChain(id,reason){if(closed)return;const c=chain(id);if(c.status==='ended')return;markEnding(id,reason);const run=active.get(id);if(run)run.controller.abort(Object.assign(new Error(reason),{code:'RUN_CANCELLED'}));else void finish(id,reason).catch(()=>{});}
 function cancelOrigin(conversationId){for(const c of liveChains().filter(c=>c.originConversationId===conversationId)){const root=read('local-role-root-budget',c.rootBudgetId);if(root)put('local-role-root-budget',root.id,{...root,cancelled:true});cancelChain(c.id,'cancelled');}}
 function revokeRole(id){for(const c of liveChains().filter(c=>[c.rootActorId,c.rootTargetId].includes(id)))cancelChain(c.id,'revoked');}
 function currentDelivery(row){const c=chain(row.chainId);origin(c);if(c.status!=='active'||closed||now()>=c.deadlineMs||signals.get(c.id)?.signal.aborted)fail('RUN_CANCELLED','通信已结束或取消');pair(row.actorId,row.targetId);if(read('local-role-delivery',row.id)?.status!=='claimed')fail('RUN_CANCELLED','通信记录状态已改变');return c;}
 async function processDelivery(row){
  let c;try{c=currentDelivery(row);}catch{await finish(row.chainId,'revoked');return;}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Object.assign(new Error('A2A timeout'),{code:'A2A_TIMEOUT'})),Math.max(1,c.deadlineMs-now()));active.set(c.id,{controller});
  const seenCalls=new Set(),recordCall=call=>{if(!call?.id||seenCalls.has(call.id))return;seenCalls.add(call.id);onModelCall(call,{originConversationId:c.originConversationId,chainId:c.id,characterId:row.targetId,runId:`a2a:${row.id}`,triggerId:row.id});};
  let binding,intrinsicPort,endingReason='completed';const sessionKey=hash([c.id,row.targetId]);let session=read('local-role-peer-session',sessionKey);
  if(!session)session=put('local-role-peer-session',sessionKey,{chainId:c.id,characterId:row.targetId,contextId:`suna-a2a-${randomUUID()}`,sessionId:null,status:'idle'});
  const check=()=>{if(controller.signal.aborted)throw controller.signal.reason;return currentDelivery(row);};
  let canReply=true;try{pair(row.targetId,row.actorId);}catch{canReply=false;}
  const enqueuePeer=args=>transaction(()=>{check();const key=hash([row.id,'intrinsic-peer',args.requestId]),fingerprint=hash(args),prior=read('local-role-peer-reply',key);if(prior){if(prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','消息标识已用于其他内容');return {...prior.receipt,duplicate:true};}const next=queue(chain(c.id),{actorId:row.targetId,targetId:args.targetId,content:args.content,hop:row.hop+1,runId:`a2a:${row.id}`,triggerId:row.id,senderSessionId:read('local-role-peer-session',sessionKey)?.sessionId});const result=receipt(next);put('local-role-peer-reply',key,{fingerprint,receipt:result});return result;});
  const bindIntrinsic=()=>typeof bindRoleTools==='function'?bindRoleTools({characterId:row.targetId,conversationId:`a2a:${c.id}`,runId:`a2a:${row.id}`,trigger:{id:row.id,kind:'a2a',sender:{type:'character',id:row.actorId}},peerAvailable:true,assertCurrent:check,assertContext:()=>{check();character(row.targetId);return true;},signal:controller.signal,sessionSource:()=>read('local-role-peer-session',sessionKey)?.sessionId,peerEnqueue:enqueuePeer}):null;
  const port={definitions:[{name:'send_message',description:'以纯文本向当前 A2A 另一角色发消息。目的地由 Host 固定；每条使用唯一 idempotencyKey。',inputSchema:sendSchema},{name:'end_a2a_session',description:'结束当前 A2A 会话，不影响主用户对话。',inputSchema:emptySchema}].filter(tool=>tool.name!=='send_message'||canReply),execute:async(name,args)=>{
   check();if(intrinsicPort?.definitions.some(tool=>tool.name===name))return intrinsicPort.execute(name,args);if(name==='end_a2a_session'){if(Object.keys(args??{}).length)fail('LOCAL_ROLE_INVALID','结束工具不接受会话或身份参数');markEnding(c.id,'agent_end');endingReason='agent_end';return {ok:true,status:'ending',terminate:true};}
   if(name!=='send_message'||!args||Object.keys(args).some(k=>!['content','idempotencyKey','terminate'].includes(k))||typeof args.content!=='string'||!args.content.length||args.content.length>12000||typeof args.idempotencyKey!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(args.idempotencyKey)||args.terminate!==undefined&&typeof args.terminate!=='boolean')fail('LOCAL_ROLE_INVALID','A2A 消息参数无效');
   return transaction(()=>{check();const key=hash([row.id,args.idempotencyKey]),fingerprint=hash(args),prior=read('local-role-peer-reply',key);if(prior){if(prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','消息标识已用于其他内容');return {...prior.receipt,duplicate:true};}
    let reply;try{reply=queue(chain(c.id),{actorId:row.targetId,targetId:row.actorId,content:args.content,hop:row.hop+1,runId:`a2a:${row.id}`,triggerId:row.id,senderSessionId:read('local-role-peer-session',sessionKey)?.sessionId});}
    catch(error){if(['LOCAL_ROLE_CHAIN_LIMIT','LOCAL_ROLE_QUOTA'].includes(error.code)){const latest=chain(c.id);put('local-role-chain',c.id,{...latest,status:'ending',endReason:'budget'});endingReason='budget';updateMarkerIfPresent(chain(c.id));return {ok:true,status:'ended',reason:'budget',terminate:true};}throw error;}
    const result={ok:true,...receipt(reply),terminate:args.terminate??true};put('local-role-peer-reply',key,{fingerprint,receipt:result});return result;
   });
  },dispose:()=>{}};
  try{
   check();intrinsicPort=bindIntrinsic();port.definitions.push(...(intrinsicPort?.definitions??[]));binding=await createLocalRoleMcpBinding({port,signal:controller.signal,preserveTermination:true});check();const role=character(row.targetId),prompts=buildPrompts(row.targetId);check();put('local-role-peer-session',sessionKey,{...session,status:'running'});
   const inputPrompt=(prompts.a2aPrefix?prompts.a2aPrefix+'\n\n':'')+a2aInputXml(row);
   const result=await executeKernel({runId:`a2a:${row.id}`,contextId:session.contextId,character:{id:role.id,name:role.name},conversation:{id:`a2a:${c.id}`,channel:'a2a',kind:'direct',participantIds:[row.actorId,row.targetId]},messages:[],prompt:prompts.prompt,developerPrompt:prompts.developerPrompt+'\n\n'+binding.skill+'\n本轮仅使用 A2A 路由。本地角色固有能力始终可用；没有主用户身份或原生系统操作权限。',inputPrompt,tools:binding.handlers,toolDefinitions:binding.definitions,authority:{isOwner:false,sender:{type:'character',id:row.actorId},computerOperationsAllowed:false},a2a:{protocol:'SUNA_A2A_V1',chainId:c.id,characterId:row.targetId,senderSessionId:row.senderSessionId,expiresAt:c.deadlineMs},workspace:workspace(session.contextId),signal:controller.signal,maxSteps:6,terminalTools:['end_a2a_session'],provider:role.provider,model:role.model,onEvent:event=>{if(event.type==='runtime-capabilities'){const owned=read('local-role-peer-session',sessionKey);put('local-role-peer-session',sessionKey,{...owned,runtimeId:event.capabilities.a2aRuntimeId,runtimePid:event.capabilities.a2aRuntimePid});}if(event.type==='input-admitted'&&event.contextId===session.contextId&&typeof event.sessionId==='string'){const observed=event.a2aSource;if(observed?.kind!=='agent-message'||observed.senderSessionId!==row.senderSessionId||observed.hasPrincipal!==false||observed.hasRpcId!==false){controller.abort(Object.assign(new Error('Untrusted A2A ingress'),{code:'A2A_SOURCE_UNVERIFIED'}));fail('A2A_SOURCE_UNVERIFIED','内核没有确认 Agent 来源');}const owned=read('local-role-peer-session',sessionKey);if(owned.sessionId&&owned.sessionId!==event.sessionId)fail('A2A_SESSION_MISMATCH','内核通信身份改变');put('local-role-peer-session',sessionKey,{...owned,sessionId:event.sessionId,sourceKind:observed.kind,senderSessionId:observed.senderSessionId});}if(event.type==='model-call')recordCall(event.call);}});
   for(const call of result?.modelCalls??[])recordCall(call);
   if(result?.sessionId){if(session.sessionId&&session.sessionId!==result.sessionId)fail('A2A_SESSION_MISMATCH','内核通信会话身份改变');put('local-role-peer-session',sessionKey,{...read('local-role-peer-session',sessionKey),sessionId:result.sessionId,status:'idle'});}
   transaction(()=>{const latest=read('local-role-delivery',row.id);if(latest.status==='claimed')put('local-role-delivery',row.id,{...latest,status:'completed'});updateMarkerIfPresent(chain(c.id));});
  }catch(error){for(const call of error?.modelCalls??[])recordCall(call);const known=read('local-role-peer-session',sessionKey);if(!known.runtimeId&&!known.sessionId)put('local-role-peer-session',sessionKey,{...known,status:'closed',neverDispatched:true});endingReason=controller.signal.aborted?(controller.signal.reason?.code==='A2A_TIMEOUT'?'timeout':chain(c.id).endReason??'cancelled'):'error';transaction(()=>{const latest=read('local-role-delivery',row.id);if(latest.status==='claimed')put('local-role-delivery',row.id,{...latest,status:endingReason==='error'?'failed':'cancelled'});updateMarkerIfPresent(chain(c.id));});}
  finally{clearTimeout(timer);await binding?.dispose();intrinsicPort?.dispose();active.delete(c.id);}
  if(chain(c.id).status!=='active'||!deliveries(c.id).some(item=>item.status==='queued'))await finish(c.id,chain(c.id).endReason??endingReason);
 }
 async function drain(){if(closed)return;if(draining)return draining;draining=(async()=>{while(!closed){const queued=pending();if(!queued.length)break;for(const row of queued){if(closed)break;const c=chain(row.chainId);if(c.status!=='active'||now()>=c.deadlineMs){await finish(c.id,'timeout');continue;}const claimed=transaction(()=>{const fresh=read('local-role-delivery',row.id);return fresh?.status==='queued'?put('local-role-delivery',row.id,{...fresh,status:'claimed'}):null;});if(claimed)await processDelivery(claimed);}}})().finally(()=>draining=null);return draining;}
 async function recover(){for(const c of liveChains()){if(c.status!=='active'||deliveries(c.id).some(row=>row.status==='claimed'))await finish(c.id,'restart');}void drain().catch(()=>{});}
 async function reconcile(){if(closed)return;for(const c of liveChains().filter(row=>row.status==='closing_pending'))await finish(c.id,c.endReason??'reconcile');}
 async function close(){for(const c of liveChains())cancelChain(c.id,'shutdown');await draining;await Promise.allSettled([...closing.values()]);closed=true;}
 return {enqueue,drain,recover,reconcile,cancelOrigin,revokeRole,close,getMarker:id=>{const c=chain(id);return projectA2aMarker(c,deliveries(id));}};
}
