import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {codexImageFailureCode} from './codex-cli-image-errors.mjs';
const error=code=>Object.assign(new Error(code),{code});
/** Private stdio transport. It never logs RPC bodies, stderr or credentials. */
export function openCodexImageRpc({executable,args,cwd,env,signal,spawnProcess=spawn,maxBytes=48*1024*1024}={}){
 if(signal?.aborted)throw error('IMAGE_CANCELLED');
 let child;try{child=spawnProcess(executable,args,{cwd,env,detached:true,shell:false,stdio:['pipe','pipe','pipe']});}catch{throw error('IMAGE_CLI_UNAVAILABLE');}
 const pending=new Map(),listeners=new Set(),errors=new Set(),decoder=new StringDecoder('utf8');let nextId=0,text='',bytes=0,stderr=0,closed=false,closeTask,fault;
 const exited=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;resolve({code,signal});rejectAll(fault??error('IMAGE_CLI_EXITED'));}));
 function rejectAll(reason){for(const item of pending.values())item.reject(reason);pending.clear();for(const callback of errors)callback(reason);}
 function send(value){if(closed||fault)throw fault??error('IMAGE_CLI_EXITED');child.stdin.write(JSON.stringify(value)+'\n');}
 function stop(code){if(fault)return;fault=error(code);rejectAll(fault);void close();}
 function consume(line){
  if(!line.trim())return;let message;try{message=JSON.parse(line)}catch{stop('IMAGE_CLI_PROTOCOL_INVALID');return;}
  if(message===null||typeof message!=='object'||Array.isArray(message)){stop('IMAGE_CLI_PROTOCOL_INVALID');return;}
  if(message.method&&message.id!==undefined){try{send({id:message.id,error:{code:-32601,message:'Image service rejects tool and approval requests'}})}catch{}stop('IMAGE_CLI_UNEXPECTED_TOOL');return;}
  if(message.id!==undefined){const item=pending.get(message.id);if(!item)return;pending.delete(message.id);message.error?item.reject(error(codexImageFailureCode(message.error,'IMAGE_CLI_REQUEST_FAILED'))):item.resolve(message.result);return;}
  if(typeof message.method==='string')for(const callback of listeners)try{callback(message)}catch{stop('IMAGE_CLI_PROTOCOL_INVALID');}
 }
 child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){stop('IMAGE_RESPONSE_TOO_LARGE');return;}text+=decoder.write(chunk);let index;while((index=text.indexOf('\n'))!==-1){consume(text.slice(0,index));text=text.slice(index+1);}});
 child.stderr.on('data',chunk=>{stderr+=chunk.length;if(stderr>256*1024)stop('IMAGE_CLI_PROTOCOL_INVALID')});
 child.stdin.on('error',()=>stop('IMAGE_CLI_EXITED'));child.on('error',()=>stop('IMAGE_CLI_UNAVAILABLE'));
 const abort=()=>stop('IMAGE_CANCELLED');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 function alive(){if(!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch{return false;}}
 function kill(kind){if(!child.pid)return;try{process.platform==='win32'?child.kill(kind):process.kill(-child.pid,kind)}catch{}}
 function close(){
  if(closeTask)return closeTask;
  closeTask=(async()=>{signal?.removeEventListener('abort',abort);try{child.stdin.end()}catch{}if(!closed)kill('SIGTERM');const timer=setTimeout(()=>kill('SIGKILL'),1500);let deadlineTimer;const status=await Promise.race([exited,new Promise(resolve=>{deadlineTimer=setTimeout(()=>resolve({code:null,signal:'EXIT_UNCONFIRMED'}),4000)})]);clearTimeout(timer);clearTimeout(deadlineTimer);const limit=Date.now()+2000;while(alive()&&Date.now()<limit){kill('SIGKILL');await new Promise(resolve=>setTimeout(resolve,25));}text='';return {...status,processGroupGone:closed&&!alive()};})();return closeTask;
 }
 return {
  request(method,params){if(fault||closed)return Promise.reject(fault??error('IMAGE_CLI_EXITED'));return new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});try{send({id,method,params})}catch(e){pending.delete(id);reject(e)}});},
  notify(method,params){send({method,...(params===undefined?{}:{params})});},
  onNotification(callback){listeners.add(callback);return()=>listeners.delete(callback);},
  onError(callback){errors.add(callback);return()=>errors.delete(callback);},
  fail:stop,close,stats:()=>({stdoutBytes:bytes,stderrBytes:stderr}),
 };
}
