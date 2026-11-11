import {createScreenCaptureHost} from './screen-capture.mjs';
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
/** Main process only. Raw screen data only goes to the private native API. */
export function createComposerCapture({api,desktopCapturer,screen,systemPreferences,timeoutMs=55000}){
 const pending=new Map();let closed=false;
 const host=createScreenCaptureHost({desktopCapturer,screen,systemPreferences,authorize:async({binding,signal})=>{const item=[...pending.values()].find(x=>x.admission?.binding.runId===binding.runId);if(!item)throw new Error('截图请求已取消');return api('/composer-capture/check',{...item.admission,ownerId:item.ownerId,requestId:item.requestId},{signal});}});
 const key=(ownerId,requestId)=>JSON.stringify([ownerId,requestId]);
 async function cancelClaim(item){if(item.admission)await api('/composer-capture/cancel',{...item.admission,ownerId:item.ownerId,requestId:item.requestId}).catch(()=>{});}
 function cancel(ownerId,{requestId}={}){if(!valid(requestId))throw new Error('截图请求标识无效');const item=pending.get(key(ownerId,requestId));if(item){item.controller.abort();void cancelClaim(item);}return {cancelled:true};}
 async function capture(ownerId,input){
  if(closed||!valid(ownerId)||!input||Object.keys(input).some(k=>!['conversationId','characterId','requestId'].includes(k))||!['conversationId','characterId','requestId'].every(k=>valid(input[k])))throw new Error('截图请求无效');
  const identity=key(ownerId,input.requestId);if(pending.has(identity))throw new Error('截图请求正在执行');
  const item={ownerId,requestId:input.requestId,controller:new AbortController()},signal=item.controller.signal;pending.set(identity,item);
  const timer=setTimeout(()=>item.controller.abort(),timeoutMs);timer.unref?.();
  try{item.admission=await api('/composer-capture/admit',{ownerId,...input},{signal});signal.throwIfAborted();
   const result=await host.capture({...item.admission.binding,signal});signal.throwIfAborted();
   try{const response=await api('/composer-capture/complete',{...item.admission,ownerId,requestId:input.requestId,images:result.images},{signal});signal.throwIfAborted();if(!Array.isArray(response?.attachments)||response.attachments.length!==result.images.length)throw new Error('截图保存未完成');return {attachments:response.attachments};}
   finally{for(const image of result.images)image.data='';}
  }finally{clearTimeout(timer);item.controller.abort();if(item.admission)host.releaseRun(item.admission.binding.runId);await cancelClaim(item);pending.delete(identity);}
 }
 return {capture,cancel,cancelOwner(ownerId){for(const item of pending.values())if(item.ownerId===ownerId)cancel(ownerId,item);},async close(){closed=true;for(const item of pending.values()){item.controller.abort();await cancelClaim(item);}await host.close();}};
}
