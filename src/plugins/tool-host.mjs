import fs from 'node:fs/promises';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sha256} from '../channels/archive.mjs';
import {readToolPackage,validateToolPackage,validateToolConfig,matchesToolSchema} from './tool-package.mjs';
const worker=fileURLToPath(new URL('./tool-worker.mjs',import.meta.url));
const failure=code=>Object.assign(new Error(code),{code});
const code=error=>/^[A-Z][A-Z0-9_.:-]{0,100}$/.test(error?.code??error?.message??'')?(error.code??error.message):'PLUGIN_EXECUTION_FAILED';
const clone=value=>structuredClone(value);
function cancellable(operation,signal){if(signal.aborted)return Promise.reject(failure('PLUGIN_STOPPED'));return new Promise((resolve,reject)=>{const abort=()=>reject(failure('PLUGIN_STOPPED'));signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{if(signal.aborted)throw failure('PLUGIN_STOPPED');return operation()}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort)).catch(()=>{});});}
const bounded=(value,max=65536)=>{const data=JSON.stringify(value);if(data===undefined||Buffer.byteLength(data)>max)throw failure('PLUGIN_PAYLOAD_INVALID');return value;};
export class ToolPluginHost{
 constructor({pluginRoot,services={},log=()=>{},changed=()=>{},forkProcess=fork,clock=Date.now}={}){
  if(typeof pluginRoot!=='string')throw new TypeError('pluginRoot required');
  this.root=path.resolve(pluginRoot);this.services=services;this.log=log;this.changed=changed;this.fork=forkProcess;this.clock=clock;
  this.plugins=new Map();this.queues=new Map();this.startRequests=new Map();this.state={version:1,plugins:{}};this.writes=Promise.resolve();this.bindings=new Set();this.closing=false;
 }
 checkOpen(){if(this.closing)throw failure('PLUGIN_HOST_CLOSED');}
 record(id){const record=this.plugins.get(id);if(!record)throw failure('PLUGIN_NOT_INSTALLED');return record;}
 serialize(id,fn){this.checkOpen();const task=(this.queues.get(id)??Promise.resolve()).catch(()=>{}).then(()=>{this.checkOpen();return fn()});this.queues.set(id,task);void task.finally(()=>{if(this.queues.get(id)===task)this.queues.delete(id)}).catch(()=>{});return task;}
 async init(){
  await fs.mkdir(this.root,{recursive:true,mode:0o700});this.root=await fs.realpath(this.root);this.stateFile=path.join(this.root,'state.json');
  try{const saved=JSON.parse(await fs.readFile(this.stateFile,'utf8'));if(saved.version!==1||!saved.plugins||typeof saved.plugins!=='object'||Array.isArray(saved.plugins))throw failure('PLUGIN_STATE_INVALID');this.state=saved;}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const [id,item]of Object.entries(this.state.plugins))try{if(!/^suna-[a-z0-9-]+-\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(item.directory))throw failure('PLUGIN_DIRECTORY_INVALID');const directory=path.join(this.root,item.directory),manifest=await this.verify(directory);if(id!==manifest.id||item.manifestHash!==sha256(Buffer.from(JSON.stringify(manifest))))throw failure('PLUGIN_FILE_INTEGRITY');this.plugins.set(id,{manifest,directory,config:validateToolConfig(manifest,{},item.config),version:item.version??1,enabled:item.enabled===true,status:'stopped',epoch:0,live:null,error:null});}catch(error){this.log('plugin.invalid',{pluginId:id,code:code(error)});}
  return this.listPlugins();
 }
 async verify(directory,expected){
  if(await fs.realpath(directory)!==directory)throw failure('PLUGIN_FILE_INTEGRITY');
  const filename=path.join(directory,'manifest.json'),stat=await fs.lstat(filename);if(!stat.isFile()||stat.size>65536||await fs.realpath(filename)!==filename)throw failure('PLUGIN_FILE_INTEGRITY');
  const bytes=await fs.readFile(filename),manifest=JSON.parse(bytes);if(expected&&JSON.stringify(manifest)!==JSON.stringify(expected))throw failure('PLUGIN_FILE_INTEGRITY');const files=new Map([['manifest.json',bytes]]);let total=bytes.length;
  for(const name of Object.keys(manifest.files??{})){if(!/^[A-Za-z0-9._/-]+$/.test(name)||name.startsWith('/')||name.split('/').some(s=>!s||s==='.'||s==='..'))throw failure('PLUGIN_FILE_INTEGRITY');const file=path.join(directory,name),s=await fs.lstat(file);if(!s.isFile()||await fs.realpath(file)!==file||(total+=s.size)>8*1024*1024)throw failure('PLUGIN_FILE_INTEGRITY');files.set(name,await fs.readFile(file));}
  validateToolPackage(manifest,files);return manifest;
 }
 persist(id,record){const value=record?{directory:path.basename(record.directory),config:clone(record.config),enabled:record.enabled,version:record.version,manifestHash:sha256(Buffer.from(JSON.stringify(record.manifest)))}:null;this.writes=this.writes.catch(()=>{}).then(async()=>{const state=clone(this.state);if(value)state.plugins[id]=value;else delete state.plugins[id];const temporary=this.stateFile+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,JSON.stringify(state),{mode:0o600,flag:'wx'});await fs.rename(temporary,this.stateFile);this.state=state;}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}});return this.writes;}
 view(record){return {id:record.manifest.id,name:record.manifest.name,version:record.manifest.version,configVersion:record.version,kind:'tool',status:record.status,enabled:record.enabled,config:clone(record.config),configSchema:clone(record.manifest.configSchema),tools:clone(record.manifest.tools),...(record.error?{error:record.error}:{})};}
 listPlugins(){return [...this.plugins.values()].map(record=>this.view(record));}
 async importPlugin(filename){
  this.checkOpen();const stat=await fs.stat(filename);if(!stat.isFile()||stat.size>8*1024*1024)throw failure('PLUGIN_ARCHIVE_SIZE');const bytes=await fs.readFile(filename),{manifest,files}=readToolPackage(bytes);
  return this.serialize(manifest.id,async()=>{const previous=this.plugins.get(manifest.id);if(previous?.live)throw failure('PLUGIN_IN_USE');for(const other of this.plugins.values())if(other.manifest.id!==manifest.id&&other.manifest.tools.some(t=>manifest.tools.some(s=>t.name===s.name)))throw failure('PLUGIN_TOOL_NAME_CONFLICT');
   const directory=path.join(this.root,`${manifest.id}-${manifest.version}-${sha256(bytes).slice(0,16)}`),temporary=await fs.mkdtemp(path.join(this.root,'.install-'));
   try{for(const [name,data]of files){const dest=path.join(temporary,name);await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o700});await fs.writeFile(dest,data,{mode:0o600,flag:'wx'});}try{await fs.rename(temporary,directory)}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}await this.verify(directory,manifest);}finally{await fs.rm(temporary,{recursive:true,force:true});}
   const record={manifest,directory,config:validateToolConfig(manifest,{},previous?.config),version:(previous?.version??0)+1,enabled:false,status:'stopped',epoch:0,live:null,error:null};await this.persist(manifest.id,record);this.plugins.set(manifest.id,record);this.changed();return this.view(record);
  });
 }
 async installBuiltin(sourceDirectory){
  this.checkOpen();if(typeof sourceDirectory!=='string'||!path.isAbsolute(sourceDirectory))throw failure('PLUGIN_DIRECTORY_INVALID');
  const manifest=await this.verify(sourceDirectory),files=new Map([['manifest.json',Buffer.from(JSON.stringify(manifest))]]);
  for(const name of Object.keys(manifest.files))files.set(name,await fs.readFile(path.join(sourceDirectory,name)));
  validateToolPackage(manifest,files);
  const digest=sha256(Buffer.from(JSON.stringify([...files].map(([name,bytes])=>[name,sha256(bytes)]).sort(([a],[b])=>a.localeCompare(b)))));
  return this.serialize(manifest.id,async()=>{
   const previous=this.plugins.get(manifest.id);
   for(const other of this.plugins.values())if(other.manifest.id!==manifest.id&&other.manifest.tools.some(t=>manifest.tools.some(s=>t.name===s.name)))throw failure('PLUGIN_TOOL_NAME_CONFLICT');
   if(previous&&JSON.stringify(previous.manifest)===JSON.stringify(manifest)){await this.verify(previous.directory,previous.manifest);return this.view(previous);}
   if(previous){this.invalidate(previous);await this.stopRecord(previous);}
   const directory=path.join(this.root,`${manifest.id}-${manifest.version}-${digest.slice(0,16)}`),temporary=await fs.mkdtemp(path.join(this.root,'.builtin-'));
   try{for(const [name,bytes]of files){const target=path.join(temporary,name);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,bytes,{mode:0o600,flag:'wx'});}try{await fs.rename(temporary,directory)}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}await this.verify(directory,manifest);}finally{await fs.rm(temporary,{recursive:true,force:true});}
   const record={manifest,directory,config:validateToolConfig(manifest,{},previous?.config),version:(previous?.version??0)+1,enabled:previous?.enabled===true,status:'stopped',epoch:0,live:null,error:null};
   await this.persist(manifest.id,record);this.plugins.set(manifest.id,record);this.changed();return this.view(record);
  });
 }
 configure(id,patch,expectedVersion){this.checkOpen();const current=this.record(id);if(expectedVersion!==undefined&&current.version!==expectedVersion)throw failure('VERSION_CONFLICT');validateToolConfig(current.manifest,patch,current.config);this.cancelStarts(id);return this.serialize(id,async()=>{const record=this.record(id);if(expectedVersion!==undefined&&expectedVersion!==record.version)throw failure('VERSION_CONFLICT');const config=validateToolConfig(record.manifest,patch,record.config);this.invalidate(record);await this.stopRecord(record);const next={...record,config,version:record.version+1,enabled:false};await this.persist(id,next);Object.assign(record,next);this.changed();return this.view(record);});}
 invalidate(record){record.epoch++;record.live?.cancelStart?.();for(const binding of this.bindings)if(binding.records.has(record))binding.abort();for(const call of record.live?.calls.values()??[])call.cancel('PLUGIN_CALL_CANCELLED');}
 cancelStarts(id){for(const request of this.startRequests.get(id)??[])request.abort();}
 start(id){
  this.checkOpen();this.record(id);const request=new AbortController(),requests=this.startRequests.get(id)??new Set();requests.add(request);this.startRequests.set(id,requests);
  const task=this.serialize(id,()=>this.startRecord(id,request.signal));void task.finally(()=>{requests.delete(request);if(!requests.size&&this.startRequests.get(id)===requests)this.startRequests.delete(id)}).catch(()=>{});return task;
 }
 async startRecord(id,signal){const check=()=>{this.checkOpen();if(signal.aborted)throw failure('PLUGIN_STOPPED');};check();const record=this.record(id);if(record.live)return this.view(record);await cancellable(()=>this.verify(record.directory,record.manifest),signal);check();const config=validateToolConfig(record.manifest,{},record.config,true);if(record.manifest.capabilities.some(cap=>typeof this.services[cap]!=='function'))throw failure('PLUGIN_SERVICE_UNAVAILABLE');for(const capability of record.manifest.capabilities){const available=this.services[capability].available;if(typeof available==='function'&&await cancellable(()=>available(clone(config),{signal}),signal)!==true)throw failure('PLUGIN_SERVICE_UNAVAILABLE');}
  check();record.epoch++;record.status='starting';record.error=null;
  let child;try{child=this.fork(worker,[],{cwd:record.directory,env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:process.env.LANG??'en_US.UTF-8'},execArgv:['--max-old-space-size=128'],stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});}catch{record.status='failed';record.error='PLUGIN_PROCESS_FAILED';this.changed();throw failure(record.error);}
  const live={child,calls:new Map(),controller:new AbortController(),stopping:false};record.live=live;live.exit=new Promise(resolve=>child.once('close',resolve));let ready,reject;const started=new Promise((yes,no)=>{ready=yes;reject=no});live.cancelStart=()=>reject(failure('PLUGIN_STOPPED'));const timer=setTimeout(()=>reject(failure('PLUGIN_START_TIMEOUT')),10000);signal.addEventListener('abort',live.cancelStart,{once:true});if(signal.aborted)live.cancelStart();
  child.on('error',()=>reject(failure('PLUGIN_PROCESS_FAILED')));child.on('message',message=>{if(record.live!==live||live.stopping||this.closing)return;if(message?.type==='ready')ready();else if(message?.type==='failed')reject(failure('PLUGIN_PROCESS_FAILED'));else if(message?.type==='result'){const call=live.calls.get(message.callId);if(call)message.error?call.finish(failure(code(message.error))):call.finish(null,message.result);}else if(message?.type==='rpc')void this.rpc(record,live,message);});
  child.once('close',()=>{live.controller.abort();for(const call of [...live.calls.values()])call.finish(failure('PLUGIN_PROCESS_EXITED'));if(record.live===live){record.live=null;record.status=live.stopping?'stopped':'failed';record.error=live.stopping?null:'PLUGIN_PROCESS_EXITED';this.invalidate(record);this.changed();}reject(failure('PLUGIN_PROCESS_EXITED'));});
  try{child.send({type:'start',entry:path.join(record.directory,record.manifest.entry),config});await started;check();await this.persist(id,{...record,enabled:true});record.enabled=true;check();record.status='running';this.changed();return this.view(record);}catch(error){await this.stopRecord(record);record.error=code(error);record.status='failed';throw error;}finally{signal.removeEventListener('abort',live.cancelStart);delete live.cancelStart;clearTimeout(timer);}
 }
 async rpc(record,live,message){
  const call=live.calls.get(message.callId);if(!call||typeof message.id!=='string'||message.id.length>40)return;
  const reply=value=>{if(record.live===live&&!live.stopping&&childConnected(live))live.child.send({type:'reply',id:message.id,...value},()=>{});};
  let operation;
  try{call.check();if(!record.manifest.capabilities.includes(message.method)||typeof this.services[message.method]!=='function')throw failure('PLUGIN_CAPABILITY_DENIED');if(call.seenRpcs.has(message.id)||call.seenRpcs.size>=8)throw failure('PLUGIN_BUSY');call.rpcs.add(message.id);call.seenRpcs.add(message.id);bounded(message.payload);
   const service=this.services[message.method];let result;
   if(service.awaitCancellation===true){operation=Promise.resolve().then(()=>{call.check();return service(clone(message.payload),call.scope);});call.cancellationOperations.add(operation);call.bindingCancellationOperations.add(operation);(record.cancellationOperations??=new Set()).add(operation);result=await operation;}else result=await service(clone(message.payload),call.scope);
   call.check();reply({result:bounded(result)});
  }catch(error){reply({error:{code:code(error)}});}finally{call.rpcs.delete(message.id);if(operation){call.cancellationOperations.delete(operation);call.bindingCancellationOperations.delete(operation);record.cancellationOperations?.delete(operation);}}
 }
 createBindings(input={}){
  input={...input,...(input.replyLease!==undefined?{replyLease:clone(input.replyLease)}:{})};
  this.checkOpen();if(['characterId','conversationId','triggerId','runId'].some(key=>typeof input[key]!=='string'||!input[key])||typeof input.assertCurrent!=='function'||typeof input.allowed!=='function')throw new TypeError('Host run identity and guards required');
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,...(input.signal?[input.signal]:[])]),records=new Set(),definitions=[],handlers={};
  const cancellationOperations=new Set();let disposeTask;const binding={records,abort:()=>controller.abort(),dispose:()=>{if(disposeTask)return disposeTask;controller.abort();this.bindings.delete(binding);disposeTask=Promise.allSettled([...cancellationOperations]);return disposeTask;}};this.bindings.add(binding);
  for(const record of this.plugins.values())if(record.status==='running'&&record.live){
   const epoch=record.epoch,live=record.live;
   for(const tool of record.manifest.tools){const permissionId=`plugin:${record.manifest.id}:${tool.name}`;if(!input.allowed(permissionId))continue;
    if(Object.hasOwn(handlers,tool.name))throw failure('PLUGIN_TOOL_NAME_CONFLICT');records.add(record);definitions.push({...clone(tool),permissionId});
    handlers[tool.name]=async args=>{
     const callController=new AbortController(),deadline=Math.min(this.clock()+tool.timeoutMs,Number.isFinite(input.deadline)?input.deadline:Infinity),callSignal=AbortSignal.any([signal,live.controller.signal,callController.signal]);
     const check=()=>{if(this.closing||callSignal.aborted||record.live!==live||record.epoch!==epoch||record.status!=='running'||this.clock()>=deadline)throw failure('PLUGIN_CALL_CANCELLED');if(input.assertCurrent()===false||!input.allowed(permissionId))throw failure('permission.denied');};
     check();if(!matchesToolSchema(args,tool.parameters))throw failure('PLUGIN_ARGUMENTS_INVALID');bounded(args);if(live.calls.size>=2)throw failure('PLUGIN_BUSY');
     return new Promise((resolve,reject)=>{const callId=randomUUID(),ownedOperations=new Set();let timer,cancelling=false,cancellationReason;
      const finish=(error,result)=>{if(!live.calls.has(callId))return;if(ownedOperations.size){void Promise.allSettled([...ownedOperations]).then(()=>finish(error,result));return;}live.calls.delete(callId);clearTimeout(timer);callSignal.removeEventListener('abort',abort);try{if(cancellationReason)throw cancellationReason;if(error)throw error;check();bounded(result);resolve(result&&typeof result==='object'&&!Array.isArray(result)?{...result,terminate:false}:{result:result??null,terminate:false});}catch(e){reject(e);}};
      const cancel=reason=>{if(cancelling)return;cancelling=true;cancellationReason=failure(reason);callController.abort();if(childConnected(live))live.child.send({type:'cancel',callId},()=>{});finish(cancellationReason);};const abort=()=>cancel('PLUGIN_CALL_CANCELLED');
      const scope=Object.freeze({...input,pluginId:record.manifest.id,toolName:tool.name,permissionId,config:clone(record.config),signal:callSignal,deadline,assertCurrent:check});
      live.calls.set(callId,{check,finish,cancel,scope,cancellationOperations:ownedOperations,bindingCancellationOperations:cancellationOperations,rpcs:new Set(),seenRpcs:new Set()});timer=setTimeout(()=>cancel('PLUGIN_CALL_TIMEOUT'),Math.max(0,deadline-this.clock()));callSignal.addEventListener('abort',abort,{once:true});
      if(childConnected(live))live.child.send({type:'invoke',callId,name:tool.name,args:clone(args)},error=>{if(error)finish(failure('PLUGIN_PROCESS_FAILED'))});else finish(failure('PLUGIN_PROCESS_EXITED'));
     });
    };
   }
  }
  return {definitions,handlers,dispose:binding.dispose};
 }
 async stopRecord(record){const live=record.live;this.invalidate(record);if(!live){await Promise.allSettled([...(record.cancellationOperations??[])]);record.status='stopped';return;}if(live.stopTask)return live.stopTask;live.stopping=true;live.controller.abort();record.status='stopping';live.stopTask=(async()=>{if(live.child.connected)live.child.send({type:'stop'},()=>{});const timer=setTimeout(()=>live.child.kill('SIGKILL'),1500);try{await live.exit;await Promise.allSettled([...(record.cancellationOperations??[])])}finally{clearTimeout(timer);if(record.live===live)record.live=null;record.status='stopped';}})();return live.stopTask;}
 stop(id){this.checkOpen();this.cancelStarts(id);const record=this.record(id);this.invalidate(record);return this.serialize(id,async()=>{await this.stopRecord(record);await this.persist(id,{...record,enabled:false});record.enabled=false;this.changed();return this.view(record);});}
 async resume(){for(const record of this.plugins.values())if(record.enabled)try{await this.start(record.manifest.id)}catch(error){this.log('plugin.start.failed',{pluginId:record.manifest.id,code:code(error)});}}
 close(){if(this.closeTask)return this.closeTask;this.closing=true;for(const id of this.startRequests.keys())this.cancelStarts(id);for(const binding of this.bindings)binding.abort();for(const record of this.plugins.values())this.invalidate(record);this.closeTask=(async()=>{await Promise.allSettled([...this.queues.values()]);await Promise.allSettled([...this.plugins.values()].map(record=>this.stopRecord(record)));await this.writes.catch(()=>{});this.bindings.clear();})();return this.closeTask;}
}
const childConnected=live=>live.child.connected&&!live.stopping;
