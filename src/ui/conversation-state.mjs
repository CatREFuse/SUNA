import {directInputPolicy,mergeDirectInputs,receiptDirectInput} from './direct-input-state.mjs';
/** Conversation identity is always the server id, never a participant or account id. */
export function conversationScope(conversation) { return conversation.channel === 'desktop' ? 'desktop' : 'channel'; }
/** Channel conversations are viewed from the participating character's side. */
export function messageOnRight(message, conversation) {
  return conversation?.channel === 'desktop' ? message.sender?.type === 'human' : message.sender?.type === 'character';
}
export function conversationTimestamp(conversation) {
  for (const value of [conversation.display?.lastMessageAt, conversation.lastMessageAt, conversation.createdAt]) {
    const parsed = Date.parse(value ?? ''); if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
export function conversationTime(value, dateOnly = false) {
  const parsed = typeof value === 'number' ? value : Date.parse(value ?? ''); if (!Number.isFinite(parsed) || !parsed) return '';
  return new Intl.DateTimeFormat('zh-CN', dateOnly ? {month:'long',day:'numeric'} : {hour:'2-digit',minute:'2-digit'}).format(parsed);
}
export function listConversations(conversations, scope, query = '', kind = 'all', characters = []) {
  const needle = query.trim().toLocaleLowerCase();
  return conversations.filter(conversation => {
    if (conversation.active === false || conversationScope(conversation) !== scope || (kind !== 'all' && conversation.kind !== kind)) return false;
    const channel = conversation.display?.channel ?? {};
    const search = [conversation.title, conversation.display?.preview, ...(conversation.display?.participantNames ?? []), ...conversation.participantIds.map(id => characters.find(person => person.id === id)?.name ?? ''), channel.platform, channel.accountLabel, channel.peerName, channel.groupName, channel.peerId, channel.groupId].join(' ').toLocaleLowerCase();
    return !needle || search.includes(needle);
  }).sort((a,b) => conversationTimestamp(b) - conversationTimestamp(a) || a.id.localeCompare(b.id));
}
/** Pins are conversations, scoped independently of the role that appears in them. */
export function pinnedConversations(conversations,scope) {
  return listConversations(conversations,scope).filter(item=>item.pinned===true).sort((a,b)=>{
    const pinnedAt=item=>{const value=Date.parse(item.pinnedAt??'');return Number.isFinite(value)?value:0;};
    return pinnedAt(b)-pinnedAt(a)||a.id.localeCompare(b.id);
  });
}
export function activeDirectConversation(conversations,characterId) {
  return listConversations(conversations,'desktop','', 'direct').find(item=>item.participantIds.length===1&&item.participantIds[0]===characterId);
}
export function activeConversationTarget(conversation,conversations) {
  if(conversation?.active!==false||conversation.channel!=='desktop'||conversation.kind!=='direct'||conversation.participantIds?.length!==1)return null;
  return conversations.find(item=>item.id===conversation.activeConversationId&&item.active!==false&&item.channel==='desktop'&&item.kind==='direct'&&item.participantIds?.length===1&&item.participantIds[0]===conversation.participantIds[0])??null;
}
/** Apply only an acknowledged CAS response. A conflict or malformed success leaves the list untouched. */
export async function saveConversationPin({id,pinned,getSnapshot,request}) {
  const snapshot=getSnapshot(),conversation=snapshot.conversations.find(item=>item.id===id);
  const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
  if(snapshot.capabilities?.conversationLifecycleV1!==true)fail('CONVERSATION_PIN_UNSUPPORTED','当前后端不支持对话置顶，请更新后重试');
  if(!conversation||conversation.active===false)fail('CONVERSATION_INACTIVE','该历史私聊为只读，不能修改置顶');
  if(typeof pinned!=='boolean'||!Number.isSafeInteger(conversation.version)||conversation.version<1)fail('CONVERSATION_PIN_INVALID','无法确认对话版本，请刷新后重试');
  const expectedVersion=conversation.version;
  const result=await request(`/conversations/${encodeURIComponent(id)}`,{pinned,expectedVersion});
  if(!result||result.id!==id||result.pinned!==pinned||!Number.isSafeInteger(result.version)||result.version<=expectedVersion||(pinned?typeof result.pinnedAt!=='string'||!Number.isFinite(Date.parse(result.pinnedAt))||result.active===false:result.pinnedAt!==null))fail('CONVERSATION_PIN_UNCONFIRMED','后端未确认置顶设置已保存，请刷新后核对');
  const latest=getSnapshot().conversations.find(item=>item.id===id);
  if(latest&&latest.version<=result.version)Object.assign(latest,{pinned:result.pinned,pinnedAt:result.pinnedAt,version:result.version});
  return result;
}
export function initialConversationState() {
  return {scope:'desktop',selected:{desktop:'',channel:''},queries:{desktop:'',channel:''},kinds:{desktop:'all',channel:'all'},drafts:{},sending:{},errors:{},errorAnchors:{},dismissedErrors:{},failedText:{},attachments:{},replyTo:{},failedBundles:{}};
}
export function conversationErrorSignature(conversation) {
  return JSON.stringify([conversation?.lastRunAt??'',conversation?.lastRunStatus??'',conversation?.lastError??'']);
}
/** Only explicit navigation owns focus; asynchronous refresh/send paths never call this. */
export async function selectRelatedConversation(id,{select,afterRender,isCurrent,focus}) {
  if(!select(id))return false;
  await afterRender();
  if(!isCurrent(id))return false;
  focus();return true;
}
export function createConversationController({state,getSnapshot,request,refresh,formatError=error=>String(error?.message??error),requestId=()=>crypto.randomUUID()}) {
  let receiptInputs=[];
  const policyFor=id=>directInputPolicy({...getSnapshot(),directInputs:mergeDirectInputs(receiptInputs,getSnapshot().directInputs??[])},id);
  const httpOwners=new Map();
  const pendingSends=new Map(),pendingKey=(id,requestId)=>JSON.stringify([id,requestId]),draftRevisions=new Map();
  const revisionFor=id=>draftRevisions.get(id)??0;
  function touchDraft(id){if(typeof id!=='string'||!id)return 0;const next=revisionFor(id)+1;draftRevisions.set(id,next);return next;}
  state.attachments??={};state.replyTo??={};state.failedBundles??={};
  const conversation=id=>getSnapshot().conversations.find(item=>item.id===id);
  const signature=id=>conversationErrorSignature(conversation(id));
  function clearLocalError(id){delete state.errors[id];delete state.errorAnchors[id];}
  function errorFor(id){
    const item=conversation(id),version=conversationErrorSignature(item);
    if(state.errorAnchors[id]===version&&state.errors[id])return state.errors[id];
    return state.dismissedErrors[id]!==version&&typeof item?.lastError==='string'?item.lastError:'';
  }
  function dismissError(id){clearLocalError(id);state.dismissedErrors[id]=signature(id);}
  function setLocalError(id,error,anchor){if(signature(id)!==anchor)return;state.errors[id]=formatError(error);state.errorAnchors[id]=anchor;}
  function reconcile() {
    for (const scope of ['desktop','channel']) {
      const items = listConversations(getSnapshot().conversations,scope);
      // Explicitly opened historical duplicates remain readable after refresh.
      if (!getSnapshot().conversations.some(item=>item.id===state.selected[scope]&&conversationScope(item)===scope)) state.selected[scope] = items[0]?.id ?? '';
    }
    for(const item of getSnapshot().conversations){
      const version=conversationErrorSignature(item);
      if(state.errorAnchors[item.id]!==version)clearLocalError(item.id);
      if(state.dismissedErrors[item.id]!==version)delete state.dismissedErrors[item.id];
    }
  }
  function select(id) {
    const conversation=getSnapshot().conversations.find(item=>item.id===id); if(!conversation)return false;
    state.scope=conversationScope(conversation);state.selected[state.scope]=id;return true;
  }
  function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
  const descriptors=value=>JSON.parse(JSON.stringify(Array.isArray(value)?value:[]));
  const receiptSupported=()=>getSnapshot().capabilities?.messageSendReceiptsV1===true||getSnapshot().capabilities?.directChatSteerV1===true;
  function syncFailedText(id){const text=(state.failedBundles[id]??[]).filter(bundle=>!bundle.restoredToDraft&&!bundle.persisted).map(bundle=>bundle.text).filter(Boolean).join('\n');if(text)state.failedText[id]=text;else delete state.failedText[id];}
  function removeFailure(id,requestId){const next=(state.failedBundles[id]??[]).filter(bundle=>bundle.requestId!==requestId);if(next.length)state.failedBundles[id]=next;else delete state.failedBundles[id];syncFailedText(id);}
  function inComposer(id,bundle){return (state.drafts[id]??'')===bundle.text&&JSON.stringify((state.attachments[id]??[]).map(item=>item.id))===JSON.stringify(bundle.attachmentIds)&&((state.replyTo[id]??'')===(bundle.replyToMessageId??''));}
  function canClearRestored(id,bundle){return (state.failedBundles[id]??[]).some(failed=>failed.requestId===bundle.requestId&&failed.restoredToDraft&&failed.restorationRevision===revisionFor(id))&&inComposer(id,bundle);}
  function clearComposer(id,bundle){state.drafts[id]='';state.attachments[id]=(state.attachments[id]??[]).filter(item=>!bundle.attachmentIds.includes(item.id));if(state.replyTo[id]===bundle.replyToMessageId)delete state.replyTo[id];}
  function failBundle(id,bundle,error,classification,{persisted=false}={}){
    let restoredToDraft=false;
    if(!persisted){
      if(revisionFor(id)===(bundle.draftRevision??0)&&!state.drafts[id]&&!(state.attachments[id]?.length)&&!state.replyTo[id]){state.drafts[id]=bundle.text;state.attachments[id]=descriptors(bundle.attachments);if(bundle.replyToMessageId)state.replyTo[id]=bundle.replyToMessageId;restoredToDraft=inComposer(id,bundle);}
      else restoredToDraft=revisionFor(id)===(bundle.draftRevision??0)&&inComposer(id,bundle);
    }
    const failed=freeze({...bundle,classification,error:formatError(error),persisted,restoredToDraft,...(restoredToDraft?{restorationRevision:revisionFor(id)}:{})});
    state.failedBundles[id]=[...(state.failedBundles[id]??[]).filter(item=>item.requestId!==bundle.requestId),failed];syncFailedText(id);return failed;
  }
  async function hook(callback,...args){if(callback)try{await callback(...args);}catch{/* Presentation cannot alter delivery or recovery. */}}
  function payloadFor(bundle){return freeze({text:bundle.text,requestId:bundle.requestId,mentionIds:[...bundle.mentionIds],...(bundle.strategy?{strategy:bundle.strategy}:{}),...(bundle.characterId?{characterId:bundle.characterId}:{}),...(bundle.attachmentIds.length?{attachmentIds:[...bundle.attachmentIds]}:{}),...(bundle.replyToMessageId?{replyToMessageId:bundle.replyToMessageId}:{})});}
  function persistedReceipt(result,bundle){
    if(!result||result.acceptance!=='persisted'||result.conversationId!==bundle.conversationId||result.requestId!==bundle.requestId||!Array.isArray(result.messageIds)||!result.messageIds.length||!result.messageIds.every(id=>typeof id==='string'&&id.length>0))return false;
    if('messages' in result&&!Array.isArray(result.messages))return false;
    const messages=[...(Array.isArray(result.messages)?result.messages:[]),...(result.message?[result.message]:[])];
    return messages.every(message=>message&&message.conversationId===bundle.conversationId&&result.messageIds.includes(message.id)&&(!message.requestId||message.requestId===bundle.requestId));
  }
  function snapshotReceipt(bundle){
    // Only server snapshot identities prove persistence; local echoes and text resemblance do not.
    const messages=(getSnapshot().messages??[]).filter(message=>message.conversationId===bundle.conversationId&&message.requestId===bundle.requestId&&!message.localPending&&typeof message.id==='string'&&message.id&&!message.id.startsWith('client:')&&typeof message.status==='string'&&['human','character'].includes(message.sender?.type));
    if(!messages.length)return null;
    const failed=messages.find(message=>['failed','cancelled','canceled'].includes(message.status)),unsettled=messages.find(message=>message.status!=='delivered'),status=(failed??unsettled??messages[0]).status;
    const directInput=getSnapshot().directInputs?.find(input=>input.conversationId===bundle.conversationId&&input.requestId===bundle.requestId&&messages.some(message=>message.id===input.messageId));
    return {...(directInput?{directInput}:{}),conversationId:bundle.conversationId,requestId:bundle.requestId,acceptance:'persisted',messageIds:[...new Set(messages.map(message=>message.id))],messages,message:messages[0],status,...(failed?.error?{error:failed.error}:{})};
  }
  function quoteError(id,replyToMessageId){
    if(!replyToMessageId)return '';
    if(getSnapshot().capabilities?.messageReferencesV1!==true)return '当前服务尚不支持引用消息';
    const target=getSnapshot().messages?.find(message=>message.id===replyToMessageId&&message.conversationId===id);
    if(!target||target.status!=='delivered'||!['human','character'].includes(target.sender?.type)||target.localPending||target.internal===true||target.hidden===true||target.visible===false||target.role==='system'||['internal','system-error'].includes(target.source?.type))return '引用消息不可用，请重新选择';
    if(conversation(id)?.channel!=='desktop'&&!(typeof target.externalId==='string'&&target.externalId.trim()))return '该消息没有可用的平台引用标识';
    return '';
  }
  async function lookup(bundle){
    if(!receiptSupported())return null;
    try{const result=await request(`/conversations/${encodeURIComponent(bundle.conversationId)}/send-requests/${encodeURIComponent(bundle.requestId)}`);if(result==null||result?.found===false)return null;if(!persistedReceipt(result,bundle))throw new Error('发送回执未确认，请稍后重试查询');return result;}
    catch(error){if(error?.status===404)return null;throw error;}
  }
  function validateBundle(id,options){
    const item=conversation(id);if(!item||state.sending[id])return null;
    const reject=message=>{setLocalError(id,message,signature(id));return null;};
    if(item.active===false)return reject('该历史私聊为只读，请进入活跃对话后发送');
    const policy=policyFor(id);if(policy.unavailable)return reject(policy.unavailable);
    const selected=options.attachments??state.attachments[id]??[];
    if(!Array.isArray(selected)||selected.some(item=>!item||typeof item!=='object'||typeof item.id!=='string'))return reject('附件信息无效，请重新选择');
    const attachmentIds=options.attachmentIds??selected.map(item=>item.id);
    if(!Array.isArray(attachmentIds)||attachmentIds.some(id=>typeof id!=='string'||!id))return reject('附件标识无效，请重新选择');
    if(policy.supported&&policy.busy&&attachmentIds.length)return reject('角色运行中暂不支持发送附件；正文、附件与引用已保留');
    const attachments=descriptors(selected).filter(item=>attachmentIds.includes(item.id));
    if(attachments.some(item=>item.conversationId&&item.conversationId!==id))return reject('附件不属于当前会话');
    const text=state.drafts[id]??'';if(!text.trim()&&!attachmentIds.length)return null;
    const characterId=item.channel!=='desktop'?(options.characterId??(item.participantIds.length===1?item.participantIds[0]:'')):undefined;
    if(item.channel!=='desktop'&&(!characterId||!item.participantIds.includes(characterId)||!getSnapshot().characters.some(person=>person.id===characterId)))return reject('请选择发送角色');
    const replyToMessageId=options.replyToMessageId??state.replyTo[id]??undefined;
    const quoteProblem=quoteError(id,replyToMessageId);if(quoteProblem)return reject(quoteProblem);
    const mentionIds=getSnapshot().characters.filter(person=>item.participantIds.includes(person.id)&&text.includes('@'+person.name)).map(person=>person.id);
    const strategy=policy.supported?'steer':undefined;
    const canonical={text,mentionIds,...(strategy?{strategy}:{}),...(characterId?{characterId}:{}),...(attachmentIds.length?{attachmentIds:[...attachmentIds]}:{}),...(replyToMessageId?{replyToMessageId}:{})},fingerprint=JSON.stringify(canonical);
    const previous=[...pendingSends.values()].find(bundle=>bundle.conversationId===id&&bundle.fingerprint===fingerprint);
    if(previous?.strategy==='steer')return reject('上一条发送结果待确认，请查询原请求状态');
    return previous??freeze({...(strategy?{strategy}:{}),conversationId:id,requestId:requestId(),fingerprint,draftRevision:revisionFor(id),text,mentionIds,attachmentIds:[...attachmentIds],attachments,...(characterId?{characterId}:{}),...(replyToMessageId?{replyToMessageId}:{})});
  }
  async function acceptedResult(id,bundle,result,options,anchor,{reconciled=false}={}){
    const channel=conversation(id)?.channel!=='desktop',modern=receiptSupported()||result?.acceptance==='persisted',persisted=persistedReceipt(result,bundle);
    if(modern&&!persisted)throw new Error('发送回执未确认，请稍后重试查询');
    const input=receiptDirectInput(result);if(input)receiptInputs=mergeDirectInputs(receiptInputs,[input]);
    if(bundle.strategy==='steer'&&persisted&&!input)setLocalError(id,'消息已保存，队列回执待确认，请查询发送状态',anchor);
    const failure=channel?(['failed','cancelled','canceled'].includes(result.status)?{error:result.error??'渠道消息发送失败'}:!modern&&result.status!=='completed'?{error:'发送结果待确认，请重试查询'}:undefined):result.dispatchError?{error:result.dispatchError.message??'角色处理失败'}:result.runs?.find(run=>run.status==='failed');
    if(persisted||!channel||['completed','failed','cancelled','canceled'].includes(result.status))pendingSends.delete(pendingKey(id,bundle.requestId));
    if(persisted&&canClearRestored(id,bundle))clearComposer(id,bundle);
    if(persisted||!failure)removeFailure(id,bundle.requestId);
    if(channel&&failure){if(persisted)failBundle(id,bundle,failure.error,'delivery-failed',{persisted:true});else failBundle(id,bundle,failure.error,'rejected');}
    if(failure)setLocalError(id,failure.error??'角色处理失败',anchor);
    await hook(options.onResult,result,{conversationId:id,payload:payloadFor(bundle),bundle,reconciled});
    // Refresh failure is not a rejected send and must never restore accepted input.
    try{await refresh();}catch(error){setLocalError(id,error,anchor);}
    return !failure;
  }
  async function dispatch(id,bundle,options,{fromComposer=false,retry=false}={}){
    if(state.sending[id])return false;
    const owner=Symbol('http-send');httpOwners.set(id,owner);const releaseHttp=()=>{if(httpOwners.get(id)===owner){httpOwners.delete(id);state.sending[id]=false;}};
    const anchor=signature(id),payload=payloadFor(bundle);state.sending[id]=true;dismissError(id);pendingSends.set(pendingKey(id,bundle.requestId),bundle);
    const composerCleared=fromComposer&&revisionFor(id)===(bundle.draftRevision??0)||canClearRestored(id,bundle);if(composerCleared)clearComposer(id,bundle);
    const accept=(result,extra={})=>{if(bundle.strategy==='steer'&&persistedReceipt(result,bundle))releaseHttp();return acceptedResult(id,bundle,result,options,anchor,extra);};
    let lookupAttempted=false;
    try{
      // Retrying an unknown request first asks the server; it never blindly starts a second send.
      if(retry&&receiptSupported()){
        lookupAttempted=true;const receipt=await lookup(bundle);if(receipt)return await accept(receipt,{reconciled:true});
      }
      const quoteProblem=quoteError(id,bundle.replyToMessageId);if(quoteProblem){setLocalError(id,quoteProblem,anchor);const failed=failBundle(id,bundle,quoteProblem,'rejected');await hook(options.onRejected,new Error(quoteProblem),{conversationId:id,payload,bundle:failed,classification:'rejected'});return false;}
      if(options.onPrepared){try{Promise.resolve(options.onPrepared({conversationId:id,payload,bundle,composerCleared})).catch(()=>{});}catch{/* UI preparation never delays or cancels transport. */}}
      const result=await request(`/conversations/${encodeURIComponent(id)}/messages`,payload);
      return await accept(result);
    }catch(error){
      if(persistedReceipt(error?.receipt,bundle))return await accept(error.receipt,{reconciled:true});
      const known=snapshotReceipt(bundle);if(known)return await accept(known,{reconciled:true});
      const definite=Number.isInteger(error?.status)&&error.status>=400&&error.status<500&&![408,425,429].includes(error.status);
      if(receiptSupported()&&!definite&&!lookupAttempted){
        try{const receipt=await lookup(bundle);if(receipt)return await accept(receipt,{reconciled:true});}catch{/* Still unknown. Keep the same request identity and do not resend. */}
      }
      const updated=snapshotReceipt(bundle);if(updated)return await accept(updated,{reconciled:true});
      const classification=definite?'rejected':'unknown',failed=failBundle(id,bundle,error,classification);
      if(definite)pendingSends.delete(pendingKey(id,bundle.requestId));
      setLocalError(id,error,anchor);await hook(options.onRejected,error,{conversationId:id,payload,bundle:failed,classification});return false;
    }finally{releaseHttp();}
  }
  async function send(id,options={}){const bundle=validateBundle(id,options);return bundle?dispatch(id,bundle,options,{fromComposer:true,retry:pendingSends.has(pendingKey(id,bundle.requestId))}):false;}
  async function retry(id,originalRequestId,options={}){
    if(!conversation(id)||conversation(id).active===false||state.sending[id])return false;
    let bundle=pendingSends.get(pendingKey(id,originalRequestId))??(state.failedBundles[id]??[]).find(bundle=>bundle.requestId===originalRequestId);
    if(!bundle||bundle.conversationId!==id)return false;
    if(bundle.strategy==='steer'&&(pendingSends.has(pendingKey(id,originalRequestId))||bundle.classification==='unknown')){setLocalError(id,'发送结果待确认，请查询原请求状态',signature(id));return false;}
    if(bundle.persisted&&options.newAttempt!==true){setLocalError(id,'消息已受理，投递失败需要明确创建新的发送尝试',signature(id));return false;}
    const {classification,error,persisted,restoredToDraft,restorationRevision,...original}=bundle;bundle=freeze({...original,...(persisted?{requestId:requestId()}:{})});
    return dispatch(id,bundle,options,{retry:receiptSupported()});
  }
  async function reconcileSend(id,originalRequestId,options={}){
    if(!receiptSupported())return null;
    const bundle=pendingSends.get(pendingKey(id,originalRequestId))??(state.failedBundles[id]??[]).find(bundle=>bundle.requestId===originalRequestId);
    if(!bundle||bundle.conversationId!==id)return null;
    const receipt=await lookup(bundle);if(!receipt)return null;
    await acceptedResult(id,bundle,receipt,options,signature(id),{reconciled:true});return receipt;
  }
  function recover(id,originalRequestId){
    const bundles=(state.failedBundles[id]??[]).filter(bundle=>!bundle.persisted&&(originalRequestId?bundle.requestId===originalRequestId:!bundle.restoredToDraft));
    if(!bundles.length){const text=state.failedText[id];if(!text)return false;state.drafts[id]=[text,state.drafts[id]].filter(Boolean).join('\n');delete state.failedText[id];return true;}
    if(bundles.some(bundle=>bundle.attachmentIds.some(id=>!bundle.attachments.some(item=>item.id===id)))){setLocalError(id,'附件信息不可用，请查询发送结果或重试原请求',signature(id));return false;}
    if(new Set(bundles.map(bundle=>bundle.characterId??null)).size>1){setLocalError(id,'待恢复内容来自不同发送角色，请分别恢复',signature(id));return false;}
    const targets=new Set([state.replyTo[id],...bundles.map(bundle=>bundle.replyToMessageId)].filter(Boolean));
    if(targets.size>1){setLocalError(id,'当前草稿与待恢复内容引用不同，请先处理当前草稿',signature(id));return false;}
    for(const bundle of bundles){if(inComposer(id,bundle)){removeFailure(id,bundle.requestId);continue;}state.drafts[id]=[bundle.text,state.drafts[id]].filter(Boolean).join('\n');const existing=state.attachments[id]??[];state.attachments[id]=[...descriptors(bundle.attachments).filter(item=>!existing.some(current=>current.id===item.id)),...existing];if(bundle.replyToMessageId)state.replyTo[id]=bundle.replyToMessageId;removeFailure(id,bundle.requestId);}
    return true;
  }
  async function cancel(id) {if(!id)return;const anchor=signature(id);try{await request(`/conversations/${encodeURIComponent(id)}/cancel`,{});await refresh();}catch(error){setLocalError(id,error,anchor);}}
  return {reconcile,select,send,retry,reconcileSend,recover,cancel,errorFor,dismissError,touchDraft};
}
