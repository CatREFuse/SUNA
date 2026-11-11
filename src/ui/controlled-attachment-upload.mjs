const uncertain=error=>!error?.status||error?.code==='ATTACHMENT_UNKNOWN';
const encode=bytes=>{let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);};
/** A request id belongs to one immutable File selection. Never retry a mutating chunk blindly. */
export function createControlledUploader({request,makeId=()=>String(crypto.randomUUID())}){
 const sessions=new Map();let running=0,closed=false;const queue=[];
 function acquire(signal){signal.throwIfAborted();if(running<2){running++;return Promise.resolve();}if(queue.length>=32)return Promise.reject(Object.assign(Error('待上传附件过多，请稍后重试'),{status:429}));return new Promise((resolve,reject)=>{const item={resolve,reject,signal,abort:()=>{const index=queue.indexOf(item);if(index>=0)queue.splice(index,1);reject(signal.reason??Error('已取消'));}};queue.push(item);signal.addEventListener('abort',item.abort,{once:true});});}
 function release(){const next=queue.shift();if(next){next.signal.removeEventListener('abort',next.abort);next.resolve();}else running--;}
 async function stage(conversationId,file,signal,key=makeId(),progress=(_value)=>{}){
  if(closed)throw Object.assign(Error('上传已关闭'),{status:410});let session=sessions.get(key);if(!session){session={conversationId,file,requestId:makeId(),uploadId:undefined};sessions.set(key,session);}if(session.file!==file||session.conversationId!==conversationId)throw Error('附件上传身份不一致');
  if(session.running)throw Object.assign(Error('该附件正在上传'),{status:409});session.running=true;try{await acquire(signal);}catch(error){session.running=false;throw error;}
  const prefix=`/conversations/${encodeURIComponent(conversationId)}/controlled-attachments`,meta={requestId:session.requestId,name:file.name,mime:file.type||'application/octet-stream',size:file.size};
  const abort=()=>{if(session.uploadId)void request(prefix+'/cancel',{uploadId:session.uploadId}).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{signal.throwIfAborted();let state;
   if(session.started){state=await request(prefix+'/status',meta,undefined,false,signal);if(state.status==='missing')throw Object.assign(Error('上传已过期，请移除后重新选择文件'),{code:'UPLOAD_EXPIRED',status:410});}
   else{session.started=true;state=await request(prefix+'/begin',meta,undefined,false,signal);}
   if(state.status==='ready'){sessions.delete(key);return state.attachment;}
   if(state.status!=='uploading'||typeof state.uploadId!=='string'||!Number.isSafeInteger(state.offset)||state.offset<0||state.offset>file.size||!Number.isSafeInteger(state.chunkBytes)||state.chunkBytes<1||state.chunkBytes>2*1024*1024)throw Error('上传状态无效');
   session.uploadId=state.uploadId;let offset=state.offset;progress({loaded:offset,total:file.size});
   while(offset<file.size){signal.throwIfAborted();const bytes=new Uint8Array(await file.slice(offset,Math.min(file.size,offset+state.chunkBytes)).arrayBuffer());try{signal.throwIfAborted();const next=await request(prefix+'/chunk',{uploadId:state.uploadId,offset,data:encode(bytes)},undefined,false,signal);if(next.offset!==offset+bytes.length)throw Error('上传位置不一致');offset=next.offset;progress({loaded:offset,total:file.size});}finally{bytes.fill(0);}}
   const result=await request(prefix+'/commit',{uploadId:state.uploadId},undefined,false,signal);if(result.status!=='ready'||!result.attachment)throw Error('上传结果未确认');sessions.delete(key);return result.attachment;
  }catch(error){if(!signal.aborted&&uncertain(error))throw Object.assign(Error('上传结果待确认，请查询后继续；文件已保留'),{code:'ATTACHMENT_UNKNOWN'});sessions.delete(key);throw error;}finally{signal.removeEventListener('abort',abort);session.running=false;release();}
 }
 return {stage,forget(key){sessions.delete(key);},dispose(){closed=true;for(const item of queue.splice(0)){item.signal.removeEventListener('abort',item.abort);item.reject(Error('上传已关闭'));}sessions.clear();}};
}
