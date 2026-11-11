import {createHash} from 'node:crypto';
const invalid=message=>Object.assign(new Error(message),{status:400});
const field=(value,name,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw invalid(`Invalid user input ${name}`);return value;};
/** Only the authenticated SUNA host calls this separate human-input endpoint. */
export function userInput(value){
 const contextId=field(value.contextId,'contextId',300),expectedRunId=field(value.expectedRunId,'expectedRunId',200),deliveryId=field(value.deliveryId,'deliveryId',200),content=field(value.content,'content',65536);
 if(Buffer.byteLength(content,'utf8')>65536)throw invalid('User input exceeds 65536 bytes');
 const id='human-'+createHash('sha256').update(JSON.stringify([contextId,deliveryId])).digest('hex');
 let reviewMessage;
 if(value.reviewInstruction!==undefined){const instruction=value.reviewInstruction;if(!instruction||typeof instruction!=='object'||Array.isArray(instruction)||Object.keys(instruction).some(key=>!['id','text'].includes(key)))throw invalid('Invalid review instruction');field(instruction.id,'review id',200);if(typeof instruction.text!=='string'||Buffer.byteLength(instruction.text,'utf8')>65536)throw invalid('Invalid review instruction text');reviewMessage={id:id+'-instruction',role:'user',content:[{type:'text',text:instruction.text}],source:{kind:'user',rpcId:'suna:'+deliveryId}};}
 return {contextId,expectedRunId,deliveryId,mode:'steer',trustedHuman:true,reviewMessage,message:{id,role:'user',content:[{type:'text',text:content}],source:{kind:'suna-context',form:'notice',summary:'Client conversation supplement'}}};
}
export function admitUserInput(run,item,push){
 if(!run||run.id!==item.expectedRunId)return Promise.resolve({accepted:false,reason:'idle',deliveryId:item.deliveryId});
 run.deliveries ||=new Map();const prior=run.deliveries.get(item.message.id);
 if(prior){if(JSON.stringify([prior.message,prior.reviewMessage])!==JSON.stringify([item.message,item.reviewMessage]))throw Object.assign(new Error('User input ID already used for different content'),{status:409});return prior.ready.then(value=>({...value,duplicate:true}));}
 if(run.canceled||run.settling||run.status!=='running'||run.acceptingInput!==true||run.inputAdmitted!==true)return Promise.resolve({accepted:false,reason:'settling',deliveryId:item.deliveryId});
 if(run.deliveries.size>=200)throw Object.assign(new Error('Too many inputs in this run'),{status:429});
 run.deliveries.set(item.message.id,item);
 item.ready=Promise.resolve().then(()=>{
  if(run.canceled||run.settling||run.acceptingInput!==true)return {accepted:false,reason:'settling',deliveryId:item.deliveryId};
  // Preserve any earlier restriction. Human input neither downgrades nor upgrades it.
  if(item.reviewMessage&&!run.authorityRestricted)run.handle.agent.inject(item.reviewMessage);
  run.handle.agent.steer(item.message);
  item.receipt={accepted:true,runId:run.id,deliveryId:item.deliveryId,appliedMode:'steer'};
  push(run,'user-input-accepted',{...item.receipt,contextId:item.contextId});return item.receipt;
 });return item.ready;
}
