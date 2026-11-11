import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readJson,httpError} from './security.mjs';
const valid=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(x);
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
/** Cookie issuance has no public/CSRF route: only trusted Main can call mint. */
export function createControlledAttachmentRoutes({store,book,native,writeJson,now=Date.now}){
 const grants=new Map();let closed=false,inflight=0,downloads=0;
 const expire=()=>{for(const [k,g]of grants)if(g.expires<=now())grants.delete(k);};
 async function permission(binding){const p=await book.composerAttachmentPermission(binding);if(!p?.allowed)throw httpError(403,'ATTACHMENT_DENIED','当前角色或会话不允许读取附件');return p;}
 async function handle({req,res,pathname,method}){if(!pathname.startsWith('/controlled-attachments/')&&!/^\/conversations\/[^/]+\/controlled-attachments(?:\/|$)/.test(pathname))return false;if(closed)throw httpError(503,'SERVICE_CLOSING','附件服务已关闭');expire();
  if(pathname==='/controlled-attachments/native-upload-admit'){native(req,'附件选择只允许桌面主窗口显式操作');if(method!=='POST')throw httpError(405,'METHOD_NOT_ALLOWED','仅支持POST');const body=await readJson(req,4096);if(Object.keys(body).some(k=>!['conversationId','characterId'].includes(k))||!valid(body.conversationId)||!valid(body.characterId))throw httpError(400,'ATTACHMENT_INVALID','附件参数无效');await permission(body);writeJson(res,200,{allowed:true});return true;}
  if(pathname==='/controlled-attachments/native-download'){
   native(req,'附件下载只允许桌面主窗口显式操作');if(method!=='POST')throw httpError(405,'METHOD_NOT_ALLOWED','仅支持POST');const body=await readJson(req,4096);
   if(Object.keys(body).some(k=>!['characterId','conversationId','attachmentId','requestId'].includes(k))||!['characterId','conversationId','attachmentId','requestId'].every(k=>valid(body[k])))throw httpError(400,'ATTACHMENT_INVALID','附件参数无效');
   const p=await permission(body),[attachment]=await store.metadata(body.conversationId,[body.attachmentId]);if(grants.size>=64)throw httpError(409,'ATTACHMENT_BUSY','附件下载授权过多');const cookie=randomBytes(32).toString('hex'),expires=now()+60000,path=attachment.url;grants.set(cookie,{...body,expires,permissionFingerprint:p.permissionFingerprint});
   // This response is native-header protected; Main installs it without exposing the token to renderer.
   writeJson(res,200,{url:path,cookie:{name:'suna_attachment_download',value:cookie,path,expirationDate:expires/1000,httpOnly:true,sameSite:'strict'}});return true;
  }
  const match=pathname.match(/^\/conversations\/([^/]+)\/controlled-attachments(?:\/(begin|status|chunk|commit|cancel)|\/(url_[a-f0-9]{48})\/(download|remove))$/);if(!match)throw httpError(404,'NOT_FOUND','附件端点不存在');const conversationId=decodeURIComponent(match[1]);
  if(match[2]){if(method!=='POST')throw httpError(405,'METHOD_NOT_ALLOWED','仅支持POST');if(inflight>=2)throw httpError(429,'ATTACHMENT_BUSY','附件上传繁忙，请稍后查询状态');inflight++;const timer=setTimeout(()=>req.destroy(),30000);timer.unref?.();try{const body=await readJson(req,match[2]==='chunk'?Math.ceil(store.limits.chunkBytes/3)*4+4096:4096);const fields=['begin','status'].includes(match[2])?['requestId','name','mime','size']:match[2]==='chunk'?['uploadId','offset','data']:['uploadId'];if(Object.keys(body).some(k=>!fields.includes(k)))throw httpError(400,'ATTACHMENT_INVALID','会话参数无效');writeJson(res,200,await store[match[2]]({conversationId,...body}));return true;}finally{clearTimeout(timer);inflight--;}}
  const attachmentId=match[3];if(match[4]==='remove'){native(req,'附件删除只允许桌面主窗口显式操作');if(method!=='POST')throw httpError(405,'METHOD_NOT_ALLOWED','仅支持POST');const body=await readJson(req,4096);await permission({conversationId,characterId:body.characterId});writeJson(res,200,await store.remove({conversationId,attachmentId}));return true;}
  if(method!=='GET')throw httpError(405,'METHOD_NOT_ALLOWED','仅支持GET');
  const cookie=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('suna_attachment_download='))?.slice(25),entry=[...grants].find(([token,g])=>equal(token,cookie)&&g.conversationId===conversationId&&g.attachmentId===attachmentId),grant=entry?.[1];if(!grant)throw httpError(403,'ATTACHMENT_SESSION_REQUIRED','请通过桌面应用下载附件');
  if(grant.inUse||downloads>=4)throw httpError(409,'ATTACHMENT_BUSY','附件下载正在进行');grant.inUse=true;downloads++;
  const current=async()=>{if(grant.expires<=now()||!grants.has(entry[0]))throw httpError(403,'ATTACHMENT_EXPIRED','附件下载授权已过期');const p=await permission(grant);if(p.permissionFingerprint!==grant.permissionFingerprint){grants.delete(entry[0]);throw httpError(403,'ATTACHMENT_REVOKED','附件权限已变更');}};
  const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);let reader;
  try{reader=await store.openRead({conversationId,attachmentId,signal:controller.signal,assertCurrent:current});await current();const a=reader.attachment;res.writeHead(200,{'content-type':'application/octet-stream','content-length':a.size,'content-disposition':`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(a.name)}`,'x-content-type-options':'nosniff','cache-control':'no-store','content-security-policy':"default-src 'none'; sandbox"});let offset=0;while(offset<a.size){const chunk=await reader.read(offset,Math.min(store.limits.readBytes,a.size-offset));offset+=chunk.length;if(!res.write(Buffer.from(chunk.data,'base64')))await new Promise((resolve,reject)=>{const cleanup=()=>{res.removeListener('drain',drain);res.removeListener('close',close);res.removeListener('error',error);};const drain=()=>{cleanup();resolve();},close=()=>{cleanup();reject(new Error('Download closed'));},error=e=>{cleanup();reject(e);};res.once('drain',drain);res.once('close',close);res.once('error',error);});}res.end();}
  finally{downloads--;req.removeListener('aborted',abort);res.removeListener('close',abort);await reader?.dispose();grants.delete(entry[0]);}return true;
 }
 return {handle,close(){closed=true;grants.clear();}};
}
