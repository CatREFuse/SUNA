/** Renderer-local presentation only. Entries never become authoritative Snapshot messages. */
const localStates=new Set(['preparing','sending','accepted','unknown','failed']);
const validId=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value);
const keyFor=(conversationId,requestId)=>`local:${encodeURIComponent(conversationId)}:${encodeURIComponent(requestId)}`;
const isLocal=message=>message?.localPending===true||message?.source?.type==='local-outbox';
const validMessage=message=>message&&validId(message.id)&&validId(message.conversationId)&&!isLocal(message);

/** Copy data, not File/Blob handles or mutable Vue proxy objects. Preview ownership stays outside this helper. */
function copyData(value,seen=new Set()){
 if(value===null||value===undefined||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'&&Number.isFinite(value))return value;
 if(typeof value!=='object'||Object.prototype.toString.call(value)!=='[object Object]'&&!Array.isArray(value))throw new TypeError('Outbox payload must contain data references, not File/Blob handles');
 if(seen.has(value))throw new TypeError('Outbox payload must not be cyclic');
 seen.add(value);
 const copied=Array.isArray(value)?value.map(item=>copyData(item,seen)):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,copyData(item,seen)]));
 seen.delete(value);return copied;
}
function freezeData(value){if(value&&typeof value==='object'){for(const item of Object.values(value))freezeData(item);Object.freeze(value);}return value;}
function fingerprint(value){
 if(Array.isArray(value))return `[${value.map(fingerprint).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>`${JSON.stringify(key)}:${fingerprint(value[key])}`).join(',')}}`;
 return JSON.stringify(value);
}
function dateString(now){const value=typeof now==='function'?now():now??Date.now();const date=new Date(value);if(!Number.isFinite(date.getTime()))throw new TypeError('Invalid outbox clock');return date.toISOString();}
function defaultMatch(entry,message){return message.requestId===entry.requestId;}
function matches(entry,message,match=defaultMatch){return validMessage(message)&&message.conversationId===entry.conversationId&&match(entry,message)===true;}
function syncLocal(entry){entry.localMessage={...entry.localMessage,status:entry.status==='failed'?'failed':'sending',localPending:true,localStatus:entry.status,...(entry.error?{error:entry.error}:{error:undefined})};}
function fail(code,message){throw Object.assign(new Error(message),{code});}

/** Pending text is safe for MessageContent; local attachments have their own trusted preview renderer. */
export function createLocalMessage(payload,conversation,sender,/** @type {{now?: any,localAttachments?: any[]}} */{now,localAttachments=[]}={}){
 if(!validId(conversation?.id)||!validId(payload?.requestId)||payload.conversationId!==undefined&&payload.conversationId!==conversation.id)fail('OUTBOX_INVALID_TARGET','会话或请求标识无效');
 if(!sender||!validId(sender.id)||!['human','character'].includes(sender.type)||typeof sender.name!=='string')fail('OUTBOX_INVALID_SENDER','发送身份无效');
 if(typeof payload.text!=='string')fail('OUTBOX_INVALID_TEXT','消息正文无效');
 const text=payload.text;
 const renderKey=keyFor(conversation.id,payload.requestId);
 return {id:renderKey,renderKey,conversationId:conversation.id,requestId:payload.requestId,text,blocks:text?[{type:'text',text}]:[],role:sender.type==='character'?'assistant':'user',sender:copyData(sender),createdAt:dateString(now),status:'sending',source:{type:'local-outbox'},...(validId(payload.replyToMessageId)?{replyToMessageId:payload.replyToMessageId}:{}),localPending:true,localStatus:'sending',localAttachments:copyData(localAttachments)};
}

function receiptMessages(receipt){
 const all=[...(Array.isArray(receipt.messages)?receipt.messages:[]),...(receipt.message?[receipt.message]:[])];
 return all.filter((message,index)=>all.findIndex(item=>item?.id===message?.id)===index);
}
function applyReceipt(entry,receipt){
 if(!receipt||receipt.conversationId!==entry.conversationId||receipt.requestId!==entry.requestId||receipt.acceptance!=='persisted'||!Array.isArray(receipt.messageIds)||!receipt.messageIds.length||!receipt.messageIds.every(validId))return;
 const messages=receiptMessages(receipt);
 // An inconsistent response must not route another conversation into this outbox.
 if(messages.some(message=>!validMessage(message)||message.conversationId!==entry.conversationId||message.requestId!==undefined&&message.requestId!==entry.requestId||!receipt.messageIds.includes(message.id)))return;
 entry.persisted=true;
 for(const id of receipt.messageIds)if(!entry.messageIds.includes(id))entry.messageIds.push(id);
 entry.primaryMessageId??=receipt.messageIds[0];
 for(const message of messages){if(entry.observedMessageIds.includes(message.id))continue;const index=entry.receiptMessages.findIndex(item=>item.id===message.id);if(index<0)entry.receiptMessages.push(copyData(message));else entry.receiptMessages[index]=copyData(message);}
 if(!entry.confirmed){entry.status='accepted';entry.error=null;syncLocal(entry);}
}

/** Mutates only the supplied local entries. Server DTOs are never annotated in place. */
export function reconcileOutbox(entries,authoritativeMessages,/** @type {any[]|object} */acks=[],{match=defaultMatch}={}){
 const messages=Array.isArray(authoritativeMessages)?authoritativeMessages:[];
 const receipts=Array.isArray(acks)?acks:acks?[acks]:[];
 for(const entry of entries){
  for(const receipt of receipts)applyReceipt(entry,receipt);
  const found=messages.filter(message=>matches(entry,message,match)||validMessage(message)&&message.conversationId===entry.conversationId&&entry.messageIds.includes(message.id));
  for(const message of found){
   if(!entry.messageIds.includes(message.id))entry.messageIds.push(message.id);
   if(!entry.observedMessageIds.includes(message.id))entry.observedMessageIds.push(message.id);
   entry.primaryMessageId??=message.id;
  }
  entry.receiptMessages=entry.receiptMessages.filter(message=>!entry.observedMessageIds.includes(message.id));
  if(found.length||entry.receiptMessages.length){entry.confirmed=true;entry.persisted=true;entry.status='confirmed';entry.error=null;}
 }
 return entries;
}

// Insert only supplemental items; preserve the authoritative array's relative order.
function insertByOrder(list,message){
 const index=list.findIndex(other=>{
  if(Number.isFinite(message.sequence)&&Number.isFinite(other.sequence))return other.sequence>message.sequence;
  const time=Date.parse(message.createdAt??''),otherTime=Date.parse(other.createdAt??'');return Number.isFinite(time)&&Number.isFinite(otherTime)&&otherTime>time;
 });
 if(index<0)list.push(message);else list.splice(index,0,message);
}

/** Stable first-bubble keys prevent a second entrance animation when SSE/HTTP takes over. */
export function messagesWithOutbox(authoritativeMessages,entries,conversationId,{match=defaultMatch}={}){
 const messages=(Array.isArray(authoritativeMessages)?authoritativeMessages:[]).filter(message=>message?.conversationId===conversationId);
 const local=entries.filter(entry=>entry.conversationId===conversationId);
 const result=[...messages],included=new Set(messages.map(message=>message.id));
 for(const entry of local){
  for(const message of entry.receiptMessages){if(!included.has(message.id)&&!entry.observedMessageIds.includes(message.id)){insertByOrder(result,message);included.add(message.id);}}
 }
 const projected=result.map(message=>{
  const entry=local.find(item=>matches(item,message,match)||validMessage(message)&&item.messageIds.includes(message.id));
  if(!entry)return message;
  const first=entry.primaryMessageId??result.find(item=>matches(entry,item,match))?.id;
  return {...message,renderKey:message.id===first?entry.renderKey:message.id,localPending:false};
 });
 for(const entry of local){
  const present=result.some(message=>matches(entry,message,match)||validMessage(message)&&entry.messageIds.includes(message.id));
  // A confirmed message that falls out of a later snapshot must not reappear as local echo.
  if(!entry.confirmed&&!present)insertByOrder(projected,entry.localMessage);
 }
 return projected;
}

/** @param {{entries?: any[], now?: (()=>any), match?: ((entry:any,message:any)=>boolean)}} [options] */
export function createConversationOutbox({entries=[],now=()=>Date.now(),match=defaultMatch}={}){
 if(!Array.isArray(entries))throw new TypeError('Outbox entries must be an array');
 const find=(conversationId,requestId)=>entries.find(entry=>entry.conversationId===conversationId&&entry.requestId===requestId);
 function enqueue(payload,conversation,sender,/** @type {{localAttachments?: any[],status?:string}} */{localAttachments=[],status='sending'}={}){
  if(!localStates.has(status))throw new TypeError('Invalid local outbox status');
  const message=createLocalMessage(payload,conversation,sender,{now,localAttachments});
  const copied=copyData(payload),identity=fingerprint([copied,message.sender]),existing=find(conversation.id,payload.requestId);
  if(existing){if(existing.fingerprint!==identity)fail('OUTBOX_REQUEST_CONFLICT','同一请求标识不能用于不同消息');return existing;}
  const entry={conversationId:conversation.id,requestId:payload.requestId,renderKey:message.renderKey,payload:freezeData(copied),fingerprint:identity,localMessage:message,status,error:null,messageIds:[],observedMessageIds:[],receiptMessages:[],primaryMessageId:null,persisted:false,confirmed:false};
  syncLocal(entry);entries.push(entry);return entries[entries.length-1];
 }
 function mark(conversationId,requestId,status,error){
  if(!localStates.has(status))throw new TypeError('Invalid local outbox status');
  const entry=find(conversationId,requestId);if(!entry||entry.confirmed||entry.persisted)return entry??null;
  entry.status=status;entry.error=error===undefined||error===null?null:String(error?.message??error);syncLocal(entry);return entry;
 }
 function remove(conversationId,requestId){const index=entries.findIndex(entry=>entry.conversationId===conversationId&&entry.requestId===requestId);if(index<0)return false;entries.splice(index,1);return true;}
 return {entries,enqueue,mark,remove,reconcile:(messages,/** @type {any[]|object} */acks=[])=>reconcileOutbox(entries,messages,acks,{match}),messages:(conversationId,messages)=>messagesWithOutbox(messages,entries,conversationId,{match})};
}
