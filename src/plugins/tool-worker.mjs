// Explicitly installed trusted Node plugins: process isolation is not an FS/network sandbox.
import {pathToFileURL} from 'node:url';
const calls=new Map(),pending=new Map();let plugin,config,started=false,closing=false,sequence=0;
const send=message=>{if(process.connected)process.send(message)};
function rpc(callId,method,payload){
 const call=calls.get(callId);if(closing||!call||call.signal.aborted)return Promise.reject(new Error('PLUGIN_CALL_CANCELLED'));
 if(pending.size>=32)return Promise.reject(new Error('PLUGIN_BUSY'));
 const id=String(++sequence);return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,callId});send({type:'rpc',id,callId,method,payload});});
}
function cancel(id){const call=calls.get(id);call?.abort();for(const [key,value]of pending)if(value.callId===id){pending.delete(key);value.reject(new Error('PLUGIN_CALL_CANCELLED'));}}
async function stop(){if(closing)return;closing=true;for(const id of calls.keys())cancel(id);try{await plugin?.dispose?.()}catch{}process.exit(0);}
process.on('message',async message=>{
 if(message?.type==='stop')return void stop();
 if(message?.type==='cancel')return cancel(message.callId);
 if(message?.type==='reply'){const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);message.error?entry.reject(Object.assign(new Error(message.error.code),{code:message.error.code})):entry.resolve(message.result);return;}
 if(message?.type==='start'&&!started){started=true;try{plugin=await import(pathToFileURL(message.entry).href);if(typeof plugin.execute!=='function')throw new Error('PLUGIN_EXECUTE_REQUIRED');config=Object.freeze(message.config);send({type:'ready'});}catch{send({type:'failed'});process.exit(1);}return;}
 if(message?.type==='invoke'&&started&&!closing&&typeof message.callId==='string'&&!calls.has(message.callId)){
  const controller=new AbortController();calls.set(message.callId,controller);
  try{const value=await plugin.execute(message.name,message.args,Object.freeze({config,signal:controller.signal,call:(method,payload)=>rpc(message.callId,method,payload)}));if(!controller.signal.aborted)send({type:'result',callId:message.callId,result:value});}
  catch(error){const code=/^[A-Z][A-Z0-9_.:-]{0,100}$/.test(error?.code??'')?error.code:'PLUGIN_EXECUTION_FAILED';if(!controller.signal.aborted)send({type:'result',callId:message.callId,error:{code}});}
  finally{cancel(message.callId);calls.delete(message.callId);}
 }
});
process.on('disconnect',()=>void stop());process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
process.on('uncaughtException',()=>process.exit(1));process.on('unhandledRejection',()=>process.exit(1));
