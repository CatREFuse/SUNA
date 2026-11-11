import {prepareMessageImageAccess} from './message-image-access.mjs';

const fail = (code,message) => {throw Object.assign(new Error(message),{code});};
export const estimateInputTokens = value => Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value??null),'utf8');
const cap = (value,fallback) => Number.isSafeInteger(value)&&value>=0?Math.min(value,fallback):fallback;

/** Projects this invocation only. Protected claimed sources are never partly admitted. */
export async function prepareRunInput({messages,protectedMessageIds,limits,measure,render,images,signal,assertCurrent=()=>{},historyMaxMessages,historyMaxTokens}) {
  const check=()=>{signal?.throwIfAborted();assertCurrent();};
  check();
  const protectedIds=new Set(protectedMessageIds),original=structuredClone(messages);
  if([...protectedIds].some(id=>!original.some(message=>message.id===id)))fail('RUN_INPUT_SOURCE_MISSING','本轮消息批次不完整');
  let selected=original;
  const text=limits?.text??{},historyCount=historyMaxMessages===undefined?cap(text.historyMaxMessages,32):historyMaxMessages,historyTokens=historyMaxTokens===undefined?cap(text.historyMaxTokens,4096):historyMaxTokens;
  if(!Number.isSafeInteger(historyCount)||historyCount<0||historyCount>1000||!Number.isSafeInteger(historyTokens)||historyTokens<0)fail('RUN_INPUT_BUDGET_INVALID','历史消息预算无效');
  const budget=Number.isSafeInteger(text.maxInputTokens)&&text.maxInputTokens>=0?text.maxInputTokens:null;
  if(budget===null||typeof measure!=='function')fail('RUN_INPUT_BUDGET_INVALID','模型输入预算无效');
  const history=()=>selected.filter(message=>!protectedIds.has(message.id));
  const removeOldest=()=>{const oldest=history()[0];if(!oldest)return false;selected=selected.filter(message=>message.id!==oldest.id);return true;};
  while(history().length>historyCount||history().reduce((sum,message)=>sum+estimateInputTokens(message.text??'')+estimateInputTokens(message.blocks??[]),0)>historyTokens)removeOldest();
  let rendered;
  const fits=async()=>{check();rendered=render(selected);const measured=await measure({...rendered,messages:selected});check();if(!Number.isSafeInteger(measured)||measured<0)fail('RUN_INPUT_BUDGET_INVALID','模型输入预算无效');return measured<=budget;};
  let prepared;
  try {
    if(images){prepared=await prepareMessageImageAccess({...images,messages:selected,protectedMessageIds:[...protectedIds],limits:limits?.images,signal});selected=prepared.messages;}
    while(!await fits()){
      if(!removeOldest())fail('RUN_INPUT_TOO_LARGE','本轮消息或必要规则超过模型输入限制');
      prepared?.retainMessages(selected.map(message=>message.id));
    }
    check();
    return {...rendered,messages:selected,messageImageAccess:prepared?.access,dispose:()=>prepared?.dispose(),retainedMessageIds:selected.map(message=>message.id),protectedMessageIds:[...protectedIds]};
  }catch(error){prepared?.dispose();throw error;}
}
