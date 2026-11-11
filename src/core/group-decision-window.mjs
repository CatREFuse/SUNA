const fail=message=>{throw Object.assign(new Error(message),{code:'GROUP_DECISION_INPUT'});};

/** Freeze public context independently of the character reply history limit. */
export function selectGroupDecisionWindow(messages,{conversationId,anchorIds,upperSequence}={}){
  if(!Array.isArray(messages)||typeof conversationId!=='string'||!conversationId||!Array.isArray(anchorIds)||!anchorIds.length||anchorIds.some(id=>typeof id!=='string'||!id)||!Number.isSafeInteger(upperSequence)||upperSequence<0)fail('群聊调度输入窗口无效');
  const byId=new Map();
  for(const message of messages){
    if(!message||message.conversationId!==conversationId||!Number.isSafeInteger(message.sequence)||message.sequence<0||message.sequence>upperSequence||message.status==='failed'||!['human','character'].includes(message.sender?.type)||message.source?.internal===true||['ttm','system'].includes(message.source?.type)||typeof message.id!=='string'||!message.id)continue;
    const previous=byId.get(message.id);
    if(previous&&previous.sequence!==message.sequence)fail('群聊调度消息标识重复');
    byId.set(message.id,structuredClone(message));
  }
  const ordered=[...byId.values()].sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id));
  if(new Set(ordered.map(message=>message.sequence)).size!==ordered.length)fail('群聊调度消息序号重复');
  if(anchorIds.some(id=>!byId.has(id)))fail('群聊调度触发消息不在冻结窗口');
  const anchorSequence=Math.min(...anchorIds.map(id=>byId.get(id).sequence));
  const index=ordered.findIndex(message=>message.sequence===anchorSequence);
  return {anchorMessageId:ordered[index].id,upperSequence,messages:ordered.slice(Math.max(0,index-16))};
}
