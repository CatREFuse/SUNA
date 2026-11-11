import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {mkdirSync,readFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

const error=code=>Object.assign(new Error({CLIENT_AUTH_LOCK_TIMEOUT:'客户端授权正忙，请稍后重试',CLIENT_AUTH_CANCELLED:'客户端授权操作已取消',CLIENT_AUTH_FILE:'客户端授权文件不可用'}[code]),{code});
const dead=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}};
const same=(left,right)=>left?.token===right?.token&&left?.pid===right?.pid;
const valid=owner=>Number.isSafeInteger(owner?.pid)&&owner.pid>0&&typeof owner.token==='string'&&/^[a-f0-9-]{36}$/.test(owner.token);

// Client OAuth is shared by the client transport and the bridge subprocess.
// Every mutation, including login replacement and logout, holds this same lock.
export function createClientCredentials({root,lockTimeoutMs=20000,pollMs=20}={}){
 const file=path.join(root,'client-openai.json'),lock=file+'.lock',recovery=lock+'.recovery';
 async function readRecord(){
  try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return undefined;throw error('CLIENT_AUTH_FILE');}
 }
 async function owner(){try{return JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));}catch{return undefined;}}
 function recover(observed){
  if(!valid(observed)||!dead(observed.pid))return;
  // Only one reaper can remove a dead owner's directory. Acquirers never remove
  // a live holder, and reapers recheck identity while holding this guard. The
  // synchronous, short section cannot overlap another reaper's directory remove.
  // If a reaper itself crashes, leave its guard intact and fail with bounded
  // waiting; never guess that a potentially live recovery operation is stale.
  try{mkdirSync(recovery,{mode:0o700});}catch(e){if(e.code==='EEXIST')return;throw e;}
  try{
   let current;try{current=JSON.parse(readFileSync(path.join(lock,'owner.json'),'utf8'));}catch{return;}
   if(same(current,observed)&&dead(current.pid))rmSync(lock,{recursive:true,force:true});
  }finally{rmSync(recovery,{recursive:true,force:true});}
 }
 async function wait(signal){
  if(signal?.aborted)throw error('CLIENT_AUTH_CANCELLED');
  await new Promise((resolve,reject)=>{
   const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();};
   const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(error('CLIENT_AUTH_CANCELLED'));};
   const timer=setTimeout(finish,pollMs);signal?.addEventListener('abort',abort,{once:true});
  });
 }
 async function locked(fn,{signal}={}){
  const identity={pid:process.pid,token:randomUUID()},deadline=Date.now()+Math.max(1,lockTimeoutMs);
  await mkdir(root,{recursive:true,mode:0o700});
  for(;;){
   if(signal?.aborted)throw error('CLIENT_AUTH_CANCELLED');
   if(Date.now()>=deadline)throw error('CLIENT_AUTH_LOCK_TIMEOUT');
   try{
    await mkdir(lock,{mode:0o700});
    try{await writeFile(path.join(lock,'owner.json'),JSON.stringify(identity),{mode:0o600,flag:'wx'});}catch(e){await rm(lock,{recursive:true,force:true});throw e;}
    break;
   }catch(e){
    if(e.code!=='EEXIST')throw e;
    recover(await owner());await wait(signal);
   }
  }
  try{
   if(signal?.aborted)throw error('CLIENT_AUTH_CANCELLED');
   return await fn();
  }finally{if(same(await owner(),identity))await rm(lock,{recursive:true,force:true});}
 }
 async function modifyRecord(_key,fn,options){return locked(async()=>{
  const next=await fn(await readRecord());
  if(next!==undefined){
   const temporary=file+'.'+randomUUID()+'.tmp';
   try{await writeFile(temporary,JSON.stringify(next),{mode:0o600});await rename(temporary,file);}finally{await rm(temporary,{force:true});}
  }
  return next;
 },options);}
 return {readRecord,modifyRecord,deleteRecord:options=>locked(()=>rm(file,{force:true}),options)};
}
