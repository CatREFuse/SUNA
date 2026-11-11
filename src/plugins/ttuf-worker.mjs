// Dedicated process for an explicitly started, trusted Node.js plugin.
// Process separation is lifecycle/fault isolation, not a filesystem sandbox.
import {pathToFileURL} from 'node:url';
const pending=new Map(),lifetime=new AbortController();let sequence=0,dispose,started=false,closing=false;
function send(value){if(process.connected)process.send(value);}
function call(method,payload){if(closing)return Promise.reject(new Error('PLUGIN_STOPPED'));if(pending.size>=32)return Promise.reject(new Error('PLUGIN_BUSY'));const id=String(++sequence);return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('PLUGIN_SEND_TIMEOUT'))},65000);pending.set(id,{resolve,reject,timeout});send({type:'call',id,method,payload});});}
async function stop(){if(closing)return;closing=true;lifetime.abort();for(const task of pending.values()){clearTimeout(task.timeout);task.reject(new Error('PLUGIN_STOPPED'))}pending.clear();try{await dispose?.()}catch{}send({type:'stopped'});process.exit(0);}
process.on('message',async message=>{
  if(message?.type==='reply'){const task=pending.get(message.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timeout);if(message.error)task.reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else task.resolve(message.result);return;}
  if(message?.type==='stop'){void stop();return;}
  if(message?.type!=='start'||started||closing)return;started=true;
  try{const plugin=await import(pathToFileURL(message.entry).href);if(typeof plugin.activate!=='function')throw new Error('PLUGIN_ACTIVATE_REQUIRED');
    const result=await plugin.activate(Object.freeze({config:Object.freeze(message.config),signal:lifetime.signal,sendTTM:payload=>call('runtime.ttm',payload),sendChannel:payload=>call('channel.send',payload),log:(event,detail)=>send({type:'log',event:String(event).slice(0,100),detail})}));
    dispose=typeof result==='function'?result:result?.dispose?.bind(result);if(closing){await dispose?.();return;}send({type:'ready'});
  }catch(error){send({type:'failed',message:String(error?.message??error)});process.exitCode=1;setTimeout(()=>process.exit(1),20);}
});
process.on('disconnect',()=>void stop());process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
process.on('uncaughtException',error=>{send({type:'failed',message:String(error?.message??error)});process.exit(1)});
process.on('unhandledRejection',error=>{send({type:'failed',message:String(error?.message??error)});process.exit(1)});
