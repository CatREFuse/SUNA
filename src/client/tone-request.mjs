import {createWorkerClientRequest} from './worker-request.mjs';

// Compatibility for callers which still expose the dedicated Tone client.
// All model transport and credential ownership lives in the common client.
export function createToneClientRequest(options={}){
 const client=createWorkerClientRequest(options);
 return {async request(input={}){
  try{return await client.request({...input,name:input.name||'tone'});}
  catch(error){
   const suffix=String(error?.code||'WORKER_CLIENT_FAILED').replace(/^WORKER_CLIENT_/,'');
   const category=suffix==='FORMAT'?'CONFIG':suffix==='RESULT'?'FAILED':suffix;
   throw Object.assign(new Error({CONFIG:'Tone 客户端模型未配置',PROVIDER:'Tone 模型与客户端提供商不匹配',AUTH:'Tone 客户端授权不可用，请重新授权',CANCELLED:'Tone 客户端请求已取消',TIMEOUT:'Tone 客户端请求超时'}[category]||'Tone 客户端请求失败'),{code:'TONE_CLIENT_'+category});
  }
 }};
}
