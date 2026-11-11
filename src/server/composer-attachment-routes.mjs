import {randomUUID} from 'node:crypto';
import {readJson,httpError} from './security.mjs';
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
const fail=(code,message)=>{throw httpError(400,code,message);};
/** Separate admission for an explicit main-window action; never registers LLM claims. */
export function createComposerAttachmentRoutes({store,book,writeJson,native,captureAvailable=()=>false,capabilities,screenGrant,now=Date.now,ttlMs=60000}){
 const claims=new Map();let closed=false;
 const expire=()=>{for(const [id,c]of claims)if(c.expires<=now()){c.controller.abort();claims.delete(id);}};
 const permission=async input=>{const value=await book.composerCapturePermission({conversationId:input.conversationId,characterId:input.characterId}),grant=screenGrant({conversationId:input.conversationId,characterId:input.characterId});if(!value?.allowed||typeof value.permissionFingerprint!=='string'||!grant?.allowed||!Number.isSafeInteger(grant.revision)||grant.revision<1)throw httpError(403,'CAPTURE_DENIED','当前角色没有截图权限');return {...value,grantRevision:grant.revision};};
 const claimFor=body=>{expire();const c=claims.get(body.claimId);if(!c||c.owner!==body.ownerId||c.requestId!==body.requestId||JSON.stringify(c.binding)!==JSON.stringify(body.binding)||c.controller.signal.aborted)throw httpError(403,'CAPTURE_CLAIM_INVALID','截图请求已失效');return c;};
 const check=async c=>{if(c.expires<=now()){c.controller.abort();throw httpError(403,'CAPTURE_CLAIM_INVALID','截图请求已过期');}const p=await permission(c.binding);if(p.permissionFingerprint!==c.permissionFingerprint||p.grantRevision!==c.binding.grantRevision){c.controller.abort();throw httpError(403,'CAPTURE_REVOKED','截图授权已变更');}c.controller.signal.throwIfAborted();return {allowed:true,revision:c.binding.grantRevision};};
 async function handle({req,res,pathname,method}){
  if(closed)throw httpError(503,'SERVICE_CLOSING','沙之书正在关闭');
  const match=pathname.match(/^\/conversations\/([^/]+)\/(attachments(?:\/([^/]+)\/download)?|composer-capabilities|send-requests\/([^/]+))$/);
  if(match){const conversationId=decodeURIComponent(match[1]);
   if(method==='GET'&&match[2]==='composer-capabilities'){writeJson(res,200,await capabilities(conversationId));return true;}
   if(method==='GET'&&match[4]){const value=await book.getSendReceipt({conversationId,requestId:decodeURIComponent(match[4])});if(!value)throw httpError(404,'NOT_FOUND','发送请求不存在');writeJson(res,200,value);return true;}
   if(method==='POST'&&match[2]==='attachments'){const body=await readJson(req,Math.ceil(Math.max(store.limits.imageBytes,store.limits.fileBytes)/3)*4+4096);if(Object.keys(body).some(k=>!['requestId','name','mime','data'].includes(k)))fail('ATTACHMENT_INVALID','附件参数无效');writeJson(res,200,await store.stage({conversationId,...body}));return true;}
   if(method==='GET'&&match[3]){const {attachment,bytes}=await store.download({conversationId,attachmentId:decodeURIComponent(match[3])});res.writeHead(200,{'content-type':attachment.mime,'content-length':bytes.length,'content-disposition':`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,'x-content-type-options':'nosniff','cache-control':'no-store'});res.end(bytes);return true;}
  }
  const capture=pathname.match(/^\/composer-capture\/(admit|check|complete|cancel)$/);if(!capture)return false;
  native(req,'截图只允许桌面主窗口显式操作');if(method!=='POST')throw httpError(405,'METHOD_NOT_ALLOWED','截图操作仅支持 POST');
  const body=await readJson(req,capture[1]==='complete'?Math.ceil(store.limits.totalBytes/3)*4+65536:8192);expire();
  if(!validId(body.ownerId)||!validId(body.requestId))fail('CAPTURE_INVALID','截图请求标识无效');
  if(capture[1]==='admit'){
   if(Object.keys(body).some(k=>!['ownerId','requestId','conversationId','characterId'].includes(k))||!validId(body.conversationId)||!validId(body.characterId))fail('CAPTURE_INVALID','截图参数无效');
   if(!captureAvailable())throw httpError(409,'CAPTURE_UNAVAILABLE','当前截图服务未连接');
   if([...claims.values()].some(c=>c.owner===body.ownerId&&c.requestId===body.requestId))throw httpError(409,'CAPTURE_BUSY','该截图请求正在执行');
   if(claims.size>=16)throw httpError(409,'CAPTURE_BUSY','截图任务过多');
   const p=await permission(body),claimId=randomUUID(),binding={permissionGranted:true,runId:'composer-'+claimId,characterId:body.characterId,conversationId:body.conversationId,triggerId:body.requestId,provider:'local-user',model:'composer-capture',grantRevision:p.grantRevision};
   claims.set(claimId,{owner:body.ownerId,requestId:body.requestId,binding,expires:now()+ttlMs,controller:new AbortController(),permissionFingerprint:p.permissionFingerprint,completing:false});writeJson(res,200,{claimId,binding});return true;
  }
  const c=claimFor(body);
  if(capture[1]==='cancel'){c.controller.abort();claims.delete(body.claimId);writeJson(res,200,{cancelled:true});return true;}
  if(capture[1]==='check'){writeJson(res,200,await check(c));return true;}
  if(c.completing)throw httpError(409,'CAPTURE_BUSY','截图正在保存');c.completing=true;
  try{await check(c);if(!Array.isArray(body.images)||!body.images.length||body.images.length>store.limits.count||body.images.some(i=>i?.mime!=='image/png'||typeof i.data!=='string'))fail('CAPTURE_INVALID','截图结果无效');
   const result=await store.stageBatch({conversationId:c.binding.conversationId,requestId:'capture_'+body.claimId,files:body.images.map((i,n)=>({name:`截屏-${n+1}.png`,mime:'image/png',data:i.data})),signal:c.controller.signal,beforeCommit:()=>check(c)});writeJson(res,200,result);return true;
  }finally{c.controller.abort();claims.delete(body.claimId);}
 }
 return {handle,close(){closed=true;for(const c of claims.values())c.controller.abort();claims.clear();}};
}
