import {randomUUID,createHash} from 'node:crypto';

const field=(value,label,max=200)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Object.assign(new Error(`Invalid ${label}`),{status:400});return value.trim();};
export function ttmSource(value={}){
  return {kind:'suna-ttuf',form:'notice',summary:'TTUF plugin message',pluginId:field(value.pluginId,'pluginId'),...(value.taskId?{taskId:field(value.taskId,'taskId')}:{}),...(value.deliveryId?{deliveryId:field(value.deliveryId,'deliveryId')}:{})};
}
export function ttmInput(value){
  if(!['steer','queue'].includes(value.mode))throw Object.assign(new Error('TTM mode must be steer or queue'),{status:400});
  if(typeof value.content!=='string'||!value.content.trim()||Buffer.byteLength(value.content,'utf8')>65536)throw Object.assign(new Error('TTM content must be 1–65536 UTF-8 bytes'),{status:400});
  const id=value.deliveryId===undefined?randomUUID():field(value.deliveryId,'deliveryId');
  const source=ttmSource({...value.source,deliveryId:id}),messageId='ttuf-'+createHash('sha256').update(JSON.stringify([source.pluginId,id])).digest('hex');
  return {mode:value.mode,message:{id:messageId,role:'user',content:[{type:'text',text:value.content}],source},deliveryId:id};
}
export function dispatchTtm(run,item){
  if(item.mode==='steer')run.handle.agent.steer(item.message);else run.handle.agent.followup(item.message);
}
