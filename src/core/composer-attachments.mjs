import path from 'node:path';
import {createControlledAttachments} from './controlled-attachments.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {constants,linkSync,unlinkSync,openSync,closeSync,writeFileSync,fsyncSync,renameSync,readSync,fstatSync} from 'node:fs';
import {mkdir,open,lstat,realpath,rename,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createWorkbenchMedia} from './workbench-media.mjs';

export const COMPOSER_ATTACHMENT_LIMITS=Object.freeze({count:16,imageBytes:32*1024*1024,fileBytes:16*1024*1024,totalBytes:64*1024*1024});
const idPattern=/^att_[a-f0-9]{32}$/,hashPattern=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const check=signal=>signal?.throwIfAborted();
const imageSignature=bytes=>bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||bytes[0]===0xff&&bytes[1]===0xd8||/^GIF8[79]a$/.test(bytes.toString('ascii',0,6))||bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
function safeName(value){if(typeof value!=='string'||!value.trim()||value.length>255||/[\x00-\x1f\x7f/\\]/u.test(value)||value==='.'||value==='..')fail('ATTACHMENT_INVALID','附件名称无效');return value;}
function requestId(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(value))fail('ATTACHMENT_INVALID','附件请求标识无效');return value;}
function decode(value){if(typeof value!=='string'||!value.length||value.length>Math.ceil(Math.max(COMPOSER_ATTACHMENT_LIMITS.imageBytes,COMPOSER_ATTACHMENT_LIMITS.fileBytes)/3)*4||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))fail('ATTACHMENT_INVALID','附件编码无效或超过大小限制');const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)fail('ATTACHMENT_INVALID','附件编码无效');return bytes;}
async function directory(value){const parent=path.dirname(value);if(parent!==value){let parentStat;try{parentStat=await lstat(parent);}catch(e){if(e.code!=='ENOENT')throw e;await directory(parent);parentStat=await lstat(parent);}if(!parentStat.isDirectory()||parentStat.isSymbolicLink()||await realpath(parent)!==parent)fail('ATTACHMENT_STORAGE_INVALID','附件存储父目录无效');}await mkdir(value,{recursive:true,mode:0o700});const s=await lstat(value);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(value)!==value)fail('ATTACHMENT_STORAGE_INVALID','附件存储目录无效');return value;}
async function verifiedBytes(file,maxBytes,expected){let h,data;try{h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=await h.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size<0n||before.size>BigInt(maxBytes))fail('ATTACHMENT_STORAGE_INVALID','附件文件无效');data=Buffer.alloc(Number(before.size)+1);let used=0;while(used<data.length){const {bytesRead}=await h.read(data,used,data.length-used,used);if(!bytesRead)break;used+=bytesRead;}const after=await h.stat({bigint:true});if(used!==Number(before.size)||['dev','ino','size','mtimeNs','ctimeNs','nlink'].some(k=>before[k]!==after[k])||expected&&hash(data.subarray(0,used))!==expected)fail('ATTACHMENT_CHANGED','附件在读取期间发生变化');const result=Buffer.from(data.subarray(0,used));data.fill(0);return result;}catch(e){data?.fill(0);throw e;}finally{await h?.close();}}
async function atomic(file,bytes){const temp=file+'.'+randomUUID()+'.tmp';let h;try{h=await open(temp,'wx',0o600);await h.writeFile(bytes);await h.sync();await h.close();h=undefined;await rename(temp,file);}finally{await h?.close();await rm(temp,{force:true});}}
const dto=record=>Object.fromEntries(['id','conversationId','kind','name','mime','size','url','width','height'].filter(k=>record[k]!==undefined).map(k=>[k,record[k]]));

/** Server-owned bytes only. This store has no model, network, native path or SQLite access. */
export async function createComposerAttachments({root,mediaDir,getConversation,clock=()=>new Date().toISOString()}={}){
 if(!path.isAbsolute(root??'')||!path.isAbsolute(mediaDir??'')||typeof getConversation!=='function')throw new TypeError('Composer attachments require trusted storage and conversation lookup');
 root=path.resolve(root);mediaDir=path.resolve(mediaDir);await mkdir(path.dirname(root),{recursive:true,mode:0o700});await mkdir(path.dirname(mediaDir),{recursive:true,mode:0o700});root=path.join(await realpath(path.dirname(root)),path.basename(root));mediaDir=path.join(await realpath(path.dirname(mediaDir)),path.basename(mediaDir));await directory(root);await directory(mediaDir);const filesRoot=await directory(path.join(root,'files')),indexFile=path.join(root,'index.json');
 const controlled=await createControlledAttachments({root:path.join(root,'controlled'),getConversation});
 const images=createWorkbenchMedia({workspace:root,mediaDir,maxBytes:COMPOSER_ATTACHMENT_LIMITS.imageBytes});let state={schemaVersion:1,records:[],requests:{}},tail=Promise.resolve(),closed=false;
 try{const raw=await verifiedBytes(indexFile,4*1024*1024);const x=JSON.parse(raw);if(x.schemaVersion!==1||!Array.isArray(x.records)||!plain(x.requests)||x.records.length>4096||x.records.some(r=>!idPattern.test(r.id)||!hashPattern.test(r.sha256)||!['image','file'].includes(r.kind)||typeof r.conversationId!=='string'||!Number.isSafeInteger(r.size)||r.size<0||r.size>(r.kind==='image'?COMPOSER_ATTACHMENT_LIMITS.imageBytes:COMPOSER_ATTACHMENT_LIMITS.fileBytes)||typeof r.url!=='string'||typeof r.relativePath!=='string'||safeName(r.name)!==r.name||r.mime!==(r.kind==='file'?'application/octet-stream':r.mime)||r.kind==='file'&&(r.relativePath!==r.sha256+'.blob'||r.url!==`/api/conversations/${encodeURIComponent(r.conversationId)}/attachments/${r.id}/download`)||r.kind==='image'&&(!/^image\/(png|jpeg|gif|webp)$/.test(r.mime)||r.url!=='/media-local/'+r.relativePath||!new RegExp('^'+r.sha256+'\\.(png|jpg|gif|webp)$').test(r.relativePath))))fail('ATTACHMENT_STORAGE_INVALID','附件索引无效');state=x;}catch(e){if(e.code!=='ENOENT')throw e;}
 const serial=fn=>{const p=tail.catch(()=>{}).then(()=>{if(closed)fail('ATTACHMENT_CLOSED','附件存储已关闭');return fn();});tail=p;return p;};
 function conversation(id,{write=false}={}){const c=getConversation(id);if(!c||c.id!==id)fail('CONVERSATION_NOT_FOUND','会话不存在');if(write&&c.active===false)fail('CONVERSATION_INACTIVE','历史只读会话不能添加附件');return c;}
 function list(ids,conversationId,{bundle=true}={}){if(!Array.isArray(ids)||ids.length>(bundle?COMPOSER_ATTACHMENT_LIMITS.count:4096)||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!idPattern.test(id)))fail('ATTACHMENT_INVALID','附件列表无效');const records=ids.map(id=>state.records.find(r=>r.id===id&&r.conversationId===conversationId));if(records.some(x=>!x))fail('ATTACHMENT_NOT_FOUND','当前会话的附件不存在');if(bundle&&records.reduce((n,x)=>n+x.size,0)>COMPOSER_ATTACHMENT_LIMITS.totalBytes)fail('ATTACHMENT_LIMIT','附件总大小超过限制');return records;}
 async function readRecord(r,signal){check(signal);const b=r.kind==='image'?(await images.readStored(r.relativePath,{maxBytes:COMPOSER_ATTACHMENT_LIMITS.imageBytes,signal})).data:await verifiedBytes(path.join(filesRoot,r.sha256+'.blob'),COMPOSER_ATTACHMENT_LIMITS.fileBytes,r.sha256);try{check(signal);if(b.length!==r.size||hash(b)!==r.sha256)fail('ATTACHMENT_CHANGED','附件校验失败');return b;}catch(error){b.fill(0);throw error;}}
 async function stageBatch({conversationId,requestId:request,files,signal,beforeCommit}={}){
  conversation(conversationId,{write:true});requestId(request);if(!Array.isArray(files)||!files.length||files.length>COMPOSER_ATTACHMENT_LIMITS.count)fail('ATTACHMENT_INVALID','附件列表无效');const prepared=[];
  try{
   for(const f of files){if(!plain(f)||Object.keys(f).some(k=>!['name','mime','data'].includes(k)))fail('ATTACHMENT_INVALID','附件参数无效');const name=safeName(f.name),bytes=decode(f.data),kind=imageSignature(bytes)?'image':'file';prepared.push({name,bytes,kind,mime:kind==='file'?'application/octet-stream':undefined,sha256:hash(bytes)});if(typeof f.mime==='string'&&f.mime.startsWith('image/')&&kind!=='image')fail('ATTACHMENT_INVALID','图片内容与类型不符');if(f.mime!==undefined&&(typeof f.mime!=='string'||f.mime.length>120||/[\x00-\x20\x7f]/.test(f.mime)))fail('ATTACHMENT_INVALID','附件类型无效');if(bytes.length>(kind==='image'?COMPOSER_ATTACHMENT_LIMITS.imageBytes:COMPOSER_ATTACHMENT_LIMITS.fileBytes))fail('ATTACHMENT_LIMIT','附件超过大小限制');}
   if(prepared.reduce((n,x)=>n+x.bytes.length,0)>COMPOSER_ATTACHMENT_LIMITS.totalBytes)fail('ATTACHMENT_LIMIT','附件总大小超过限制');
   const key=hash(Buffer.from(JSON.stringify([conversationId,request]))),fingerprint=hash(Buffer.from(JSON.stringify(prepared.map(x=>[x.name,x.kind,x.sha256]))));
   return await serial(async()=>{
    check(signal);conversation(conversationId,{write:true});const previous=state.requests[key];if(previous){if(previous.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','附件请求标识已用于不同内容');return {attachments:list(previous.ids,conversationId).map(dto),duplicate:true};}
    if(state.records.length+prepared.length>4096||state.records.reduce((n,r)=>n+r.size,0)+prepared.reduce((n,r)=>n+r.bytes.length,0)>4*1024*1024*1024)fail('ATTACHMENT_LIMIT','附件存储已达到上限');
    const pending=await directory(path.join(root,'pending-'+randomUUID())),temporaryImages=createWorkbenchMedia({workspace:root,mediaDir:pending,maxBytes:COMPOSER_ATTACHMENT_LIMITS.imageBytes}),records=[],publications=new Map();
    try{
     for(const f of prepared){check(signal);let stored;if(f.kind==='image')stored=await temporaryImages.persistBytes(f.bytes);else{const name=f.sha256+'.blob';await atomic(path.join(pending,name),f.bytes);stored={relativePath:name,mime:f.mime,sha256:f.sha256};}
      const id='att_'+randomUUID().replaceAll('-','');records.push({id,conversationId,kind:f.kind,name:f.name,mime:stored.mime,size:f.bytes.length,sha256:f.sha256,relativePath:stored.relativePath,url:f.kind==='image'?'/media-local/'+stored.relativePath:`/api/conversations/${encodeURIComponent(conversationId)}/attachments/${id}/download`,...(stored.width?{width:stored.width,height:stored.height}:{}),createdAt:clock()});
      const target=path.join(f.kind==='image'?mediaDir:filesRoot,stored.relativePath);publications.set(target,{source:path.join(pending,stored.relativePath),target,sha256:f.sha256,size:f.bytes.length});
     }
     check(signal);conversation(conversationId,{write:true});await beforeCommit?.();check(signal);
     const next={schemaVersion:1,records:[...state.records,...records],requests:{...state.requests,[key]:{fingerprint,ids:records.map(r=>r.id)}}},indexTemp=path.join(pending,'index.json'),created=[];
     // No await inside publication: cancel/revoke is ordered before this commit or after it.
     // New links are rolled back before any app code can adopt them if commit fails.
     try{
      let fd;try{fd=openSync(indexTemp,'wx',0o600);writeFileSync(fd,JSON.stringify(next));fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
      for(const item of publications.values()){
       try{linkSync(item.source,item.target);created.push(item.target);}catch(error){if(error.code!=='EEXIST')throw error;let fd,bytes;try{fd=openSync(item.target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(item.size))fail('ATTACHMENT_STORAGE_INVALID','附件存储文件无效');bytes=Buffer.alloc(item.size+1);let used=0;while(used<bytes.length){const n=readSync(fd,bytes,used,bytes.length-used,used);if(!n)break;used+=n;}const after=fstatSync(fd,{bigint:true});if(used!==item.size||hash(bytes.subarray(0,used))!==item.sha256||['dev','ino','size','mtimeNs','ctimeNs','nlink'].some(k=>before[k]!==after[k]))fail('ATTACHMENT_CHANGED','附件存储文件已变化');}finally{bytes?.fill(0);if(fd!==undefined)closeSync(fd);}}
       unlinkSync(item.source);
      }
      renameSync(indexTemp,indexFile);state=next;
     }catch(error){for(const target of created)try{unlinkSync(target);}catch{}throw error;}
     return {attachments:records.map(dto)};
    }finally{await rm(pending,{recursive:true,force:true});}
   });
  }finally{for(const f of prepared)f.bytes.fill(0);}
 }

 async function resolve({conversationId,attachmentIds=[],signal}={}){conversation(conversationId);const records=list(attachmentIds,conversationId),blocks=[];for(const r of records){const b=await readRecord(r,signal);b.fill(0);blocks.push(r.kind==='image'?{type:'image',attachmentId:r.id,url:r.url,alt:r.name,mime:r.mime,sha256:r.sha256,relativePath:r.relativePath}:{type:'file',attachmentId:r.id,url:r.url,name:r.name,mime:r.mime,size:r.size,sha256:r.sha256});}return {attachments:records.map(dto),blocks};}
 async function resolveFileForChannel({conversationId,attachmentId,signal}){conversation(conversationId);const r=list([attachmentId],conversationId)[0];if(r.kind!=='file')fail('ATTACHMENT_INVALID','附件不是文件');const b=await readRecord(r,signal);b.fill(0);return {attachment:dto(r),path:path.join(filesRoot,r.sha256+'.blob')};}
 async function download({conversationId,attachmentId,signal}){conversation(conversationId);const r=list([attachmentId],conversationId)[0];return {attachment:dto(r),bytes:await readRecord(r,signal)};}
 function projectForRun({conversationId,attachments=[]}={}){conversation(conversationId);return list(attachments.map(x=>typeof x==='string'?x:x?.id),conversationId,{bundle:false}).filter(r=>r.kind==='file').map(r=>{const extension=path.extname(r.name).slice(1),name=/^[A-Za-z0-9]{1,12}$/.test(extension)?'attachment.'+extension:'attachment.bin';return {attachmentId:r.id,relativePath:path.posix.join('.suna-attachments',r.id,name),name:r.name,mime:r.mime,size:r.size};});}
 async function materializeForRun({conversationId,attachments=[],workspace,signal}={}){
  conversation(conversationId);check(signal);if(!path.isAbsolute(workspace??''))fail('ATTACHMENT_STORAGE_INVALID','角色工作区无效');
  const records=list(attachments.map(x=>typeof x==='string'?x:x?.id),conversationId,{bundle:false}).filter(r=>r.kind==='file');if(!records.length)return [];
  const ws=await lstat(workspace,{bigint:true});if(!ws.isDirectory()||ws.isSymbolicLink())fail('ATTACHMENT_STORAGE_INVALID','角色工作区无效');const base=await realpath(workspace),descriptors=projectForRun({conversationId,attachments});
  const files=records.map((r,i)=>({id:r.id,source:path.join(filesRoot,r.sha256+'.blob'),sha256:r.sha256,size:r.size,targetName:path.posix.basename(descriptors[i].relativePath)}));
  await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[fileURLToPath(new URL('./composer-materialize-child.mjs',import.meta.url))],{cwd:base,stdio:['pipe','pipe','ignore'],env:{},windowsHide:true});let output='',finished=false;const timer=setTimeout(()=>{child.kill();finish(Object.assign(new Error('附件复制超时'),{code:'ATTACHMENT_STORAGE_INVALID'}));},30000);timer.unref?.();
   const abort=()=>{child.kill();finish(signal.reason??new Error('附件复制已取消'));};function finish(error){if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();}
   child.on('error',finish);child.stdout.on('data',chunk=>{output+=chunk;if(output.length>128){child.kill();finish(Object.assign(new Error('附件复制响应无效'),{code:'ATTACHMENT_STORAGE_INVALID'}));}});child.on('close',code=>{if(code===0&&output==='{"ok":true}')finish();else finish(Object.assign(new Error('附件文件或工作区无效'),{code:'ATTACHMENT_STORAGE_INVALID'}));});child.stdin.on('error',()=>{});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}child.stdin.end(JSON.stringify({workspaceIdentity:{dev:String(ws.dev),ino:String(ws.ino)},files}));
  });check(signal);return descriptors;
 }

 return {controlled,stage:async input=>{if(!plain(input)||Object.keys(input).some(k=>!['conversationId','requestId','name','mime','data','signal'].includes(k)))fail('ATTACHMENT_INVALID','附件参数无效');const {conversationId,requestId,signal,...file}=input;const value=await stageBatch({conversationId,requestId,signal,files:[file]});return {attachment:value.attachments[0],...(value.duplicate?{duplicate:true}:{})};},stageBatch,async resolve(input){
  const ids=input.attachmentIds??[];if(ids.length>16||new Set(ids).size!==ids.length)fail('ATTACHMENT_INVALID','附件列表无效');
  const localIds=ids.filter(id=>!controlled.isControlled(id)),urlIds=ids.filter(id=>controlled.isControlled(id));
  const small=await resolve({...input,attachmentIds:localIds}),large=await controlled.resolve({...input,attachmentIds:urlIds});
  if([...small.attachments,...large.attachments].reduce((n,a)=>n+a.size,0)>controlled.limits.totalBytes)fail('ATTACHMENT_LIMIT','附件总量超过限制');
  const attachments=new Map([...small.attachments,...large.attachments].map(a=>[a.id,a])),blocks=new Map([...small.blocks,...large.blocks].map(a=>[a.attachmentId,a]));return {attachments:ids.map(id=>attachments.get(id)),blocks:ids.map(id=>blocks.get(id))};
 },download,resolveFileForChannel,projectForRun(input){const items=input.attachments??[];return [...projectForRun({...input,attachments:items.filter(a=>!controlled.isControlled(typeof a==='string'?a:a.id))}),...controlled.projectForRun({...input,attachments:items.filter(a=>controlled.isControlled(typeof a==='string'?a:a.id))})];},materializeForRun(input){return materializeForRun({...input,attachments:(input.attachments??[]).filter(a=>!controlled.isControlled(typeof a==='string'?a:a.id))});},limits:COMPOSER_ATTACHMENT_LIMITS,close:async()=>{closed=true;await controlled.close();await tail.catch(()=>{});}};
}
