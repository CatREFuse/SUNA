import {fork} from 'node:child_process';
import {createInterface} from 'node:readline';
const fail=code=>Object.assign(new Error(code),{code});
/** Real stdio MCP client. Privileged operations only use a parent-owned bound port. */
export async function createLocalRoleMcpBinding({port,signal,timeoutMs=10000,forkServer=fork,preserveTermination=false}={}){
 if(!port)return null;if(typeof port.execute!=='function'||!Array.isArray(port.definitions))throw TypeError('Bound role port required');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<20||timeoutMs>30000)throw TypeError('Invalid MCP timeout');
 let child;try{child=forkServer(new URL('./local-role-server.mjs',import.meta.url),[],{silent:true,execArgv:[],env:{PATH:process.env.PATH??'',LANG:'en_US.UTF-8',ELECTRON_RUN_AS_NODE:'1'},serialization:'json'});}catch{port.dispose();throw fail('LOCAL_ROLE_MCP_FAILED');}
 const calls=new Map();let next=0,disposed=false,readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});
 const exit=new Promise(resolve=>child.once('exit',resolve));
 function rejectAll(code){readyReject(fail(code));for(const call of calls.values())call.reject(fail(code));calls.clear();}
 child.on('error',()=>rejectAll('LOCAL_ROLE_MCP_FAILED'));
 child.on('exit',()=>{disposed=true;signal?.removeEventListener('abort',abort);port.dispose();rejectAll('LOCAL_ROLE_MCP_CLOSED');});
 child.on('message',async message=>{
  if(message?.kind==='ready'){readyResolve();return;}
  if(message?.kind!=='call'||!Number.isSafeInteger(message.id)||disposed)return;
  let result;try{if(signal?.aborted)throw fail('RUN_CANCELLED');const data=await port.execute(message.name,message.args);if(signal?.aborted)throw fail('RUN_CANCELLED');result={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:false};}
  catch(error){result={content:[{type:'text',text:JSON.stringify({ok:false,error:{code:error.code??'LOCAL_ROLE_FAILED',message:error.code?error.message:'角色操作失败'}})}],isError:true};}
  if(child.connected&&!disposed)child.send({kind:'result',id:message.id,result},()=>{});
 });
 const rl=createInterface({input:child.stdout,crlfDelay:Infinity});
 rl.on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}const call=calls.get(message.id);if(!call)return;calls.delete(message.id);message.error?call.reject(fail('LOCAL_ROLE_MCP_PROTOCOL')):call.resolve(message.result);});
 child.stderr.on('data',()=>{}); // Never forward subprocess diagnostics into model/UI logs.
 async function dispose(){if(disposed)return exit;disposed=true;port.dispose();signal?.removeEventListener('abort',abort);rejectAll('RUN_CANCELLED');child.stdin.end();child.kill('SIGTERM');await exit;}
 const abort=()=>{void dispose();};signal?.addEventListener('abort',abort,{once:true});
 function request(method,params){if(disposed||signal?.aborted)return Promise.reject(fail('RUN_CANCELLED'));const id=++next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{calls.delete(id);reject(fail('LOCAL_ROLE_MCP_TIMEOUT'));void dispose();},timeoutMs);calls.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');});}
 try{
  if(signal?.aborted)throw fail('RUN_CANCELLED');
  child.send({kind:'bind',tools:port.definitions});
  let timer;try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('LOCAL_ROLE_MCP_TIMEOUT')),timeoutMs);})]);}finally{clearTimeout(timer);}
  const initialized=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'SUNA-Client',version:'1.0.0'}});
  if(initialized.protocolVersion!=='2025-11-25')throw fail('LOCAL_ROLE_MCP_VERSION');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const [{tools},resource]=await Promise.all([request('tools/list'),request('resources/read',{uri:'suna-skill://role-social'})]);
  if(JSON.stringify(tools)!==JSON.stringify(port.definitions))throw fail('LOCAL_ROLE_MCP_CATALOG');
  const definitions=tools.map(tool=>({name:tool.name,description:tool.description,parameters:tool.inputSchema,terminate:false}));
  return {definitions,skill:resource.contents[0].text,protocolVersion:initialized.protocolVersion,request,handlers:Object.fromEntries(definitions.map(tool=>[tool.name,async args=>{const result=await request('tools/call',{name:tool.name,arguments:args});if(result.isError){const data=JSON.parse(result.content[0].text);throw Object.assign(new Error(data.error.message),{code:data.error.code});}return {...result.structuredContent,terminate:preserveTermination&&typeof result.structuredContent?.terminate==='boolean'?result.structuredContent.terminate:false};}])),dispose};
 }catch(error){await dispose();throw error;}
}
