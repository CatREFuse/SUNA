const phases=Object.freeze({idle:'空闲',closed:'已停止',replying:'处理回复',deciding:'判断是否参与',queued:'已排队','debouncing-direct':'等待触发者补充','waiting-for-run':'等待当前运行结束','debouncing-watch':'等待后续消息补充',watching:'监听触发者后续消息','waiting-ambient':'等待群聊消息'});
const thoughts=Object.freeze({idle:'当前没有待处理的群聊消息。',closed:'群聊调度已停止。',replying:'我正在处理本轮回复。',deciding:'我在判断是否参与本轮讨论。',queued:'本轮群聊回复已排队。','debouncing-direct':'我在等待触发者补充消息。','waiting-for-run':'我在等待当前运行结束。','debouncing-watch':'我在等待触发者的后续消息补充。',watching:'我会继续监听触发者的后续消息。','waiting-ambient':'我在等待新的群聊消息。'});
const results=Object.freeze({participating:'我会参与本轮讨论。','not-participating':'本轮讨论我暂不参与。',failed:'本轮群聊调度失败。',delivered:'本轮回复已发送。'});
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=2048;
const at=value=>typeof value==='string'?Date.parse(value):NaN;
const shortText=(value,limit)=>typeof value==='string'&&value.length<=limit*2&&value.trim().length>0&&[...value].length<=limit;
/** Display-only decision DTO: internal message identities never enter the view. */
export function schedulerDecisionView(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.shouldReply!=='boolean'||!shortText(value.reason,240)||!Array.isArray(value.resolvedReferences)||value.resolvedReferences.length>16)return null;
 const resolvedReferences=[];
 for(const ref of value.resolvedReferences){
  if(!ref||typeof ref!=='object'||Array.isArray(ref)||!shortText(ref.expression,120)||!shortText(ref.referent,240)||!Array.isArray(ref.messageIds)||ref.messageIds.some(id=>!validId(id)))return null;
  resolvedReferences.push({expression:ref.expression,referent:ref.referent});
 }
 return {shouldReply:value.shouldReply,reason:value.reason,resolvedReferences};
}
export const schedulerPhaseText=phase=>Object.hasOwn(phases,phase)?phases[phase]:'状态不可用';
export function schedulerResultText(status){const labels={completed:'本轮调度已结束',delivered:'回复已发送',failed:'调度失败',cancelled:'调度已取消',skipped:'本轮调度已跳过'};return Object.hasOwn(labels,status)?labels[status]:'—';}
export function countdownText(value,now=Date.now()){
 const due=at(value);
 return Number.isFinite(due)&&Number.isFinite(now)?`${Math.max(0,Math.ceil((due-now)/1000))} 秒`:'—';
}
/** Safe, read-only view of actual per-role scheduler state, never a new timer. */
export function channelSchedulerRows(states,conversation,characters,now=Date.now()){
 if(!conversation||conversation.channel==='desktop'||conversation.kind!=='group')return [];
 const people=new Map((characters??[]).map(person=>[person.id,person])),allowed=new Set(conversation.participantIds??[]),byRole=new Map();
 for(const state of Array.isArray(states)?states:[]){
  if(!state||state.conversationId!==conversation.id||!allowed.has(state.characterId)||!people.has(state.characterId)||!Object.hasOwn(phases,state.phase))continue;
  byRole.set(state.characterId,state);
 }
 return [...byRole.values()].map(state=>{
  const direct=Array.isArray(state.pendingDirect)?state.pendingDirect:[],watchers=(Array.isArray(state.watchers)?state.watchers:[]).filter(watch=>integer(watch?.remainingBatches)),ambient=state.ambient;
  const due=direct.map(job=>at(job?.dueAt)).filter(Number.isFinite).sort((a,b)=>a-b)[0],watchCount=watchers.reduce((sum,watch)=>sum+watch.remainingBatches,0),threshold=integer(ambient?.threshold)?ambient.threshold:conversation.schedulerEffective?.messageThreshold;
  return {characterId:state.characterId,name:people.get(state.characterId).name,phase:state.phase,label:schedulerPhaseText(state.phase),debounce:due===undefined?'—':countdownText(new Date(due).toISOString(),now),directMessageCount:direct.reduce((sum,job)=>sum+(integer(job?.messageCount)?job.messageCount:0),0),messageCount:integer(ambient?.messageCount)?ambient.messageCount:0,threshold:integer(threshold)?threshold:null,idle:ambient?countdownText(ambient.dueAt,now):'—',watch:watchers.length?(watchers.length>1?`${watchers.length} 位触发者 · 剩余 ${watchCount} 条`:`剩余 ${watchCount} 条`):'未监听',lastResult:schedulerResultText(state.lastResult?.status),hasClock:due!==undefined||Number.isFinite(at(ambient?.dueAt))};
 });
}
/** Only the server's bounded state/result protocol becomes a role thought. */
export function visibleSchedulerThoughts(items,conversation,characters){
 const channelGroup=typeof conversation?.channel==='string'&&conversation.channel.length>0&&conversation.channel!=='desktop'&&conversation.kind==='group';
 if(!channelGroup||!validId(conversation.id)||!Array.isArray(conversation.participantIds))return [];
 const allowed=new Set(conversation.participantIds??[]),people=new Set((characters??[]).map(person=>person.id)),unique=new Map();
 for(const item of Array.isArray(items)?items:[]){
  if(!item||!validId(item.id)||!validId(item.characterId)||!validId(item.sourceConversationId)||item.sourceConversationId!==conversation.id||!allowed.has(item.characterId)||!people.has(item.characterId)||!Number.isFinite(at(item.updatedAt)))continue;
  const text=item.kind==='state'&&Object.hasOwn(thoughts,item.phase)?thoughts[item.phase]:item.kind==='result'&&Object.hasOwn(results,item.status)?results[item.status]:null;
  if(!text)continue;
  const decision=item.kind==='result'?schedulerDecisionView(item.decision):null;
  const safe={id:item.id,characterId:item.characterId,targetConversationId:item.targetConversationId,sourceConversationId:item.sourceConversationId,sourceConversationName:typeof item.sourceConversationName==='string'?item.sourceConversationName.slice(0,160):'群聊',kind:item.kind,phase:item.phase,status:item.status,updatedAt:item.updatedAt,text,...(decision?{decision}:{})};
  const previous=unique.get(item.id);
  if(!previous||at(previous.updatedAt)<=at(item.updatedAt))unique.set(item.id,safe);
 }
 return [...unique.values()].sort((a,b)=>at(a.updatedAt)-at(b.updatedAt)||a.id.localeCompare(b.id)).slice(-100);
}
/** Interleave thoughts without sorting or mutating the ordered message list. */
export function schedulerTimelineItems(messages,thoughtItems){
 const result=[],thoughts=[...thoughtItems];let next=0;
 for(const message of messages){
  const time=at(message.createdAt);
  while(next<thoughts.length&&Number.isFinite(time)&&at(thoughts[next].updatedAt)<=time){const thought=thoughts[next++];result.push({kind:'thought',key:`thought:${thought.id}`,thought});}
  result.push({kind:'message',key:`message:${message.id}`,message});
 }
 for(;next<thoughts.length;next++){const thought=thoughts[next];result.push({kind:'thought',key:`thought:${thought.id}`,thought});}
 return result;
}
