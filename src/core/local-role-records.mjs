import {createHash} from 'node:crypto';
import {projectA2aMarker,boundedA2aFacts} from './local-role-xml.mjs';

const absent=new Set(['CONVERSATION_NOT_FOUND','CONVERSATION_INACTIVE','TARGET_DENIED','A2A_ANCHOR_NOT_FOUND']);
/** Host-owned projections only. These records never dispatch another role run. */
export function createLocalRoleRecords({read,put,write,findMessage,mainConversation,validateConversation,clock=()=>new Date().toISOString()}){
  function mirror(record){
    const chain=read('local-role-chain',record.source.chainId);
    if(!chain)return;
    for(const characterId of new Set(record.source.events.map(event=>event.targetId))){
      const anchorId='a2a_recipient_'+createHash('sha256').update(JSON.stringify([chain.id,characterId])).digest('hex');
      const existing=read('local-role-record',anchorId);
      const conv=existing?{id:existing.conversationId}:mainConversation(characterId);
      if(!conv||conv.id===chain.originConversationId)continue;
      try{
        validateConversation(characterId,conv.id);
        const projection=projectA2aMarker(chain,record.source.events.map(event=>({...event,chainId:chain.id})),{viewerActorId:characterId,anchorId,originConversationId:conv.id});
        const saved=write({...projection,allowCreate:!existing,expectedSequence:existing?.sequence});
        if(!existing)put('local-role-record',anchorId,{chainId:chain.id,characterId,conversationId:conv.id,anchorId,sequence:saved.sequence});
      }catch(error){if(!absent.has(error.code))throw error;}
    }
  }
  function project(record){
    let saved,error;
    try{saved=write(record);}catch(caught){error=caught;}
    // A removed origin anchor must not strand an already visible recipient at active.
    // The peer's enclosing transaction still rolls this back on queue failures.
    mirror(record);
    if(error)throw error;
    return saved;
  }
  function trusted(message){
    if(message.hidden===true||message.deletedAt||message.status==='deleted')return false;
    const source=message.source;
    if(source?.type!=='local-role-communication'||source.sourceKind!=='agent'||message.sender?.type!=='system'||message.sender?.id!=='local-role-communication'||message.id!==source.anchorId)return false;
    const chain=read('local-role-chain',source.chainId);
    if(!chain)return false;
    if(chain.anchorId===message.id&&chain.originConversationId===message.conversationId)return true;
    const binding=read('local-role-record',message.id);
    return binding?.chainId===chain.id&&binding.anchorId===message.id&&binding.conversationId===message.conversationId&&binding.sequence===message.sequence&&binding.characterId===source.viewerActorId;
  }
  function contextMessages(history){
    return history.filter(message=>{
      if(message.source?.type!=='local-role-communication')return true;
      if(!trusted(message))return false;
      const chain=read('local-role-chain',message.source.chainId);
      return chain.status==='ended'&&chain.closedCount===1&&message.source.status==='ended'&&message.source.closedCount===1;
    });
  }
  const consumptionKey=(characterId,chainId)=>createHash('sha256').update(JSON.stringify([characterId,chainId])).digest('hex');
  function workerFacts(history,{characterId,consumer,date,localDate,through,claimTaskId}={}){
    const byChain=new Map();
    for(const message of contextMessages(history)){
      if(!trusted(message))continue;
      const chain=read('local-role-chain',message.source.chainId),viewer=message.source.viewerActorId;
      if(viewer?viewer!==characterId:chain.rootActorId!==characterId)continue;
      const availableAt=chain.closedAt;
      if(typeof availableAt!=='string'||!Number.isFinite(Date.parse(availableAt))||through&&availableAt>through)continue;
      if(consumer&&read('local-role-fact-consumption',consumptionKey(characterId,chain.id))?.[consumer])continue;
      if(consumer==='diary'&&(!date||localDate(availableAt)>date))continue;
      const previous=byChain.get(chain.id);
      // Prefer this role's private projection if the initiating outlet was a group.
      if(previous&&!viewer)continue;
      const {events,...source}=message.source;
      byChain.set(chain.id,{id:message.id,conversationId:message.conversationId,sequence:message.sequence,createdAt:message.createdAt,availableAt,time:availableAt,role:'fact',speaker:{id:'local-role-communication',type:'agent-communication'},source,text:boundedA2aFacts([message],trusted,{maxMarkers:1,maxEvents:4,maxBytes:8192,contentBytes:1024})});
    }
    const ordered=[...byChain.values()].sort((a,b)=>a.availableAt.localeCompare(b.availableAt)||a.id.localeCompare(b.id));
    const selected=consumer?ordered.slice(0,4):ordered.slice(-4),bounded=[];let bytes=0;
    for(const fact of selected){const size=Buffer.byteLength(JSON.stringify(fact));if(bytes+size>32768)break;bytes+=size;bounded.push(fact);}
    if(claimTaskId)for(const fact of bounded){
      const key=consumptionKey(characterId,fact.source.chainId),current=read('local-role-fact-consumption',key),claim=current?.claims?.[consumer];
      if(claim&&claim.taskId!==claimTaskId&&['queued','running'].includes(read('worker-task',claim.taskId)?.status))throw Object.assign(new Error('该角色的通信事实正在由另一后台任务处理'),{code:'WORKER_BUSY'});
      put('local-role-fact-consumption',key,{...current,characterId,chainId:fact.source.chainId,claims:{...current?.claims,[consumer]:{taskId:claimTaskId,messageId:fact.id,availableAt:fact.availableAt}}});
    }
    return bounded;
  }
  function consumeFacts(characterId,evidence,consumer,{taskId,rootTaskId,date}={}){
    if(!['dream','diary'].includes(consumer))throw new TypeError('Unknown A2A fact consumer');
    if(!evidence?.length)return;
    const task=read('worker-task',rootTaskId),type=consumer==='dream'?'dream_cycle':'diary_cycle';
    const stale=()=>{throw Object.assign(new Error('通信事实的冻结来源或后台消费状态已变化'),{code:'VERSION_CONFLICT'});};
    if(task?.args?.characterId!==characterId||task.type!==type||task.status!=='running'||!taskId.startsWith(rootTaskId+':'))stale();
    for(const {chainId,messageId,availableAt} of evidence){
      const chain=read('local-role-chain',chainId),message=findMessage(messageId);
      if(chain?.status!=='ended'||chain.closedCount!==1||chain.closedAt!==availableAt||!message||!trusted(message)||message.source.chainId!==chainId)stale();
      const key=consumptionKey(characterId,chainId),current=read('local-role-fact-consumption',key);
      const claim=current?.claims?.[consumer];
      if(current?.[consumer]||claim?.taskId!==rootTaskId||claim.messageId!==messageId||claim.availableAt!==availableAt)stale();
      put('local-role-fact-consumption',key,{...current,characterId,chainId,[consumer]:{taskId,at:clock(),...(date?{date}:{})}});
    }
  }
  return {project,trusted,contextMessages,workerFacts,consumeFacts};
}

/** Add Host-verified facts independently of the ordinary human/assistant turn sampler. */
export function withA2aWorkerFacts(projection,{sourceFacts=[],dreamFacts=[],diaryFacts=[]}={}){
  const sample=(ordinary,facts)=>[...(ordinary??[]).slice(-(20-facts.length)),...facts.map(fact=>[fact])];
  projection.sourceMessages=[...new Map([...projection.sourceMessages,...sourceFacts].map(message=>[message.id,message])).values()];
  projection.variables.source_messages=projection.sourceMessages;
  projection.variables.dream_sampled_messages=sample(projection.variables.dream_sampled_messages,dreamFacts);
  projection.variables.diary_sampled_messages=sample(projection.variables.diary_sampled_messages,diaryFacts);
  projection.a2aFactEvidence=sourceFacts.map(fact=>({chainId:fact.source.chainId,messageId:fact.id,availableAt:fact.availableAt}));
  return projection;
}
