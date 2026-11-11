const unavailable=()=>{throw Object.assign(new Error('引用的消息不可用，请重新选择当前会话中已发送的消息'),{code:'REPLY_REFERENCE_UNAVAILABLE'});};

export const REPLY_PREVIEW_MAX_CHARACTERS=500;
const bounded=(value,max=REPLY_PREVIEW_MAX_CHARACTERS)=>Array.from(String(value??'')).slice(0,max).join('');

export function normalizeReplyMessageId(value){
  if(value===undefined||value===null)return null;
  if(typeof value!=='string'||!value.trim()||value.length>200||value!==value.trim())unavailable();
  return value;
}

/** Only trusted persisted data is projected; a quote never grants access to media bytes. */
export function resolveMessageReply({conversationId,messageId,maxSequence=Infinity,findMessage,requireExternalId=false}={}){
  const id=normalizeReplyMessageId(messageId);if(id===null)return null;
  if(typeof conversationId!=='string'||typeof findMessage!=='function')unavailable();
  const message=findMessage(id);
  if(!message||message.id!==id||message.conversationId!==conversationId||message.status!=='delivered'||message.internal||message.source?.internal||!['human','character'].includes(message.sender?.type)||typeof message.sender?.id!=='string'||!message.sender.id||!Number.isSafeInteger(message.sequence)||message.sequence<1||message.sequence>maxSequence)unavailable();
  if(requireExternalId&&(typeof message.externalId!=='string'||!message.externalId))unavailable();
  const blocks=Array.isArray(message.blocks)?message.blocks:[];
  const kinds=new Set(blocks.flatMap(block=>block?.type==='image'?['image']:['file','video'].includes(block?.type)?['file']:['text','mention'].includes(block?.type)?['text']:[]));
  const kind=kinds.size>1?'mixed':kinds.values().next().value??'text';
  const fallback=blocks.map(block=>block?.type==='image'?block.alt||'图片':block?.type==='file'?block.name||'文件':block?.type==='video'?block.alt||'视频':block?.type==='text'?block.text??'':'').filter(Boolean).join('\n');
  const preview={messageId:id,sender:{id:message.sender.id,name:bounded(message.sender.name,256),type:message.sender.type},text:bounded(message.text||fallback),kind};
  return {message,preview};
}
