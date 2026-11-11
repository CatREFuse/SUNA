/** UI policy only; the server remains the authority for eligibility and admission. */
export function isPrimaryDirect(snapshot,id){
 const item=snapshot.conversations?.find(item=>item.id===id);
 if(!item||item.active===false||item.channel!=='desktop'||item.kind!=='direct'||item.participantIds?.length!==1)return false;
 return snapshot.conversations.filter(other=>other.active!==false&&other.channel==='desktop'&&other.kind==='direct'&&other.participantIds?.length===1&&other.participantIds[0]===item.participantIds[0]).length===1;
}
export function directInputPolicy(snapshot,id){
 const primary=isPrimaryDirect(snapshot,id),supported=primary&&snapshot.capabilities?.directChatSteerV1===true;
 const busy=!!snapshot.activity?.some(run=>run.conversationId===id)||!!snapshot.pending?.some(run=>run.conversationId===id)||!!snapshot.directInputs?.some(item=>item.conversationId===id&&['queued','sending'].includes(item.status));
 return {primary,supported,busy,unavailable:primary&&!supported&&busy?'暂不支持补充消息，请稍后再试':''};
}
const labels={queued:'已排队',sending:'正在提交给角色',accepted:'已接纳，等待处理',admitted:'已送入本轮',unconsumed:'消息未能处理',failed:'消息处理失败',unknown:'回复状态待确认',cancelled:'已取消排队'};
export function validDirectInput(value){return !!value&&value.strategy==='steer'&&Object.hasOwn(labels,value.status)&&['id','conversationId','requestId','messageId','characterId'].every(key=>typeof value[key]==='string'&&value[key].length>0)&&Number.isFinite(Date.parse(value.updatedAt??''))&&Number.isFinite(Date.parse(value.createdAt??''));}
// ISO clocks have millisecond precision. At equal time keep consumption/terminal
// evidence over an older progress snapshot; do not rank run phases linearly.
function preferAtSameTime(previous,input){
 if(previous.id!==input.id)return previous;
 if(previous.status==='admitted')return previous;
 if(input.status==='admitted')return input;
 const final=new Set(['unconsumed','failed','cancelled']);
 if(final.has(previous.status)&&!final.has(input.status))return previous;
 if(final.has(input.status)&&!final.has(previous.status))return input;
 if(previous.status==='unknown'&&['queued','sending','accepted'].includes(input.status))return previous;
 if(input.status==='unknown'&&['queued','sending','accepted'].includes(previous.status))return input;
 return input;
}
export function mergeDirectInputs(...sources){
 const items=new Map();
 for(const input of sources.flat()){
  if(!validDirectInput(input))continue;
  const key=JSON.stringify([input.conversationId,input.requestId]),previous=items.get(key);
  if(!previous){items.set(key,{...input});continue;}
  const delta=Date.parse(input.updatedAt)-Date.parse(previous.updatedAt);
  if(delta>0||delta===0&&preferAtSameTime(previous,input)===input)items.set(key,{...input});
 }
 return [...items.values()];
}
export function receiptDirectInput(receipt){const input=receipt?.directInput;return receipt?.acceptance==='persisted'&&validDirectInput(input)&&input.conversationId===receipt.conversationId&&input.requestId===receipt.requestId&&receipt.messageIds?.includes(input.messageId)?input:null;}
export function directInputForMessage(inputs,message){return inputs.find(input=>validDirectInput(input)&&input.conversationId===message.conversationId&&(!message.requestId||input.requestId===message.requestId)&&(input.messageId===message.id||input.requestId===message.requestId));}
export function directInputLabel(input){return labels[input?.status]??'';}
export function directInputNeedsQuery(input){return !!input&&!['admitted','cancelled'].includes(input.status);}

/** Internal lifecycle phases are silent in chat; only actionable failures remain. */
export function directInputVisible(input){return validDirectInput(input)&&['failed','unknown','unconsumed'].includes(input.status);}
