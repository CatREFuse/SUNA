const fail=()=>{throw Object.assign(new Error('引用触发消息必须为布尔值'),{code:'INVALID_REPLY_REFERENCE'});};

export function validateReplyToTrigger(value,{inherit=false}={}){
  if(inherit&&value===null)return null;
  if(typeof value!=='boolean')fail();
  return value;
}

export function replyToTriggerEnabled(character,conversation){
  return typeof conversation?.replyToTrigger==='boolean'?conversation.replyToTrigger:character?.replyToTrigger!==false;
}

/** Host-owned anchor only. Neither model arguments nor message text select a quote. */
export function channelReplyReference({character,conversation,anchorId,replyLease,findMessage}={}){
  if(conversation?.channel==='desktop'||conversation?.kind!=='group'||!replyToTriggerEnabled(character,conversation)||!conversation.participantIds?.includes(character?.id))return null;
  const target=conversation.channelTarget;
  if(!target?.accountId||!target.platform||target.kind!=='group'||typeof anchorId!=='string'||!anchorId||typeof findMessage!=='function')return null;
  // Message identifiers obtained by another connection are not transferable.
  if(replyLease&&(replyLease.accountId!==target.accountId||replyLease.platform!==target.platform||replyLease.conversationId!==conversation.id))return null;
  const original=findMessage(anchorId);
  if(!original||original.id!==anchorId||original.conversationId!==conversation.id||!['human','character'].includes(original.sender?.type)||typeof original.externalId!=='string'||!original.externalId)return null;
  return original.id;
}
