import {readFile} from 'node:fs/promises';
const protocolVersion='2025-11-25',maxLine=512*1024;
let tools=[],phase='boot',counter=0;const pending=new Map();
const skill=await readFile(new URL('../skills/role-social/SKILL.md',import.meta.url),'utf8');
const uri='suna-skill://role-social';
const write=value=>process.stdout.write(JSON.stringify(value)+'\n');
const error=(id,code,message)=>write({jsonrpc:'2.0',id,error:{code,message}});
process.on('message',message=>{
 if(message?.kind==='bind'&&phase==='boot'&&Array.isArray(message.tools)){tools=message.tools;phase='initial';process.send?.({kind:'ready'});}
 if(message?.kind==='result'){const call=pending.get(message.id);if(call){pending.delete(message.id);call(message.result);}}
});
process.on('disconnect',()=>process.exit(0));
async function handleLine(line){
 if(Buffer.byteLength(line)>maxLine){error(null,-32600,'Request too large');return;}
 let request;try{request=JSON.parse(line);}catch{error(null,-32700,'Parse error');return;}
 const id=request?.id;
 if(!request||request.jsonrpc!=='2.0'||typeof request.method!=='string'||id!==undefined&&typeof id!=='string'&&!Number.isSafeInteger(id)){error(null,-32600,'Invalid Request');return;}
 if(request.params!==undefined&&(!request.params||typeof request.params!=='object'||Array.isArray(request.params))){if(id!==undefined)error(id,-32602,'Invalid params');return;}
 if(request.method==='notifications/initialized'&&phase==='initializing'){phase='ready';return;}
 if(id===undefined)return;
 if(request.method==='initialize'){
  if(phase!=='initial'){error(id,-32600,'Already initialized or not bound');return;}
  if(typeof request.params?.protocolVersion!=='string'||!request.params?.capabilities||typeof request.params.capabilities!=='object'||Array.isArray(request.params.capabilities)||typeof request.params?.clientInfo?.name!=='string'||typeof request.params?.clientInfo?.version!=='string'){error(id,-32602,'Missing protocolVersion');return;}
  phase='initializing';write({jsonrpc:'2.0',id,result:{protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'suna-local-role',version:'1.0.0'},instructions:'Read suna-skill://role-social before using local role tools. Identity and permissions are bound by the SUNA Host.'}});return;
 }
 if(phase!=='ready'){error(id,-32002,'Not initialized');return;}
 if(request.method==='ping'){write({jsonrpc:'2.0',id,result:{}});return;}
 if(request.method==='tools/list'){write({jsonrpc:'2.0',id,result:{tools}});return;}
 if(request.method==='resources/list'){write({jsonrpc:'2.0',id,result:{resources:[{uri,name:'role-social',mimeType:'text/markdown',description:'本地角色管理与互通信 Skill'}]}});return;}
 if(request.method==='resources/read'){
  if(request.params?.uri!==uri){error(id,-32602,'Unknown resource');return;}
  write({jsonrpc:'2.0',id,result:{contents:[{uri,mimeType:'text/markdown',text:skill}]}});return;
 }
 if(request.method!=='tools/call'){error(id,-32601,'Method not found');return;}
 const name=request.params?.name,args=request.params?.arguments===undefined?{}:request.params.arguments;
 if(typeof name!=='string'||!args||typeof args!=='object'||Array.isArray(args)){error(id,-32602,'Invalid tool arguments');return;}
 if(!tools.some(tool=>tool.name===name)){error(id,-32602,'Unknown tool');return;}
 if(pending.size>=8){error(id,-32000,'Server busy');return;}
 const callId=++counter;
 const result=await new Promise(resolve=>{pending.set(callId,resolve);process.send?.({kind:'call',id:callId,name,args});});
 write({jsonrpc:'2.0',id,result});
}
let buffered='',dropping=false;process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
 const parts=chunk.split('\n');for(let i=0;i<parts.length;i++){const part=parts[i],ended=i<parts.length-1;
  if(!dropping){if(Buffer.byteLength(buffered)+Buffer.byteLength(part)>maxLine){buffered='';dropping=true;error(null,-32600,'Request too large');}else buffered+=part;}
  if(ended){if(!dropping)void handleLine(buffered.replace(/\r$/,''));buffered='';dropping=false;}
 }
});
process.stdin.on('end',()=>{if(!pending.size)process.exit(0);});
