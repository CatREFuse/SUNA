import fs from 'node:fs/promises';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sha256} from '../channels/archive.mjs';
import {readTtufPackage,validateTtufPackage,validateTtufConfig} from './ttuf-package.mjs';

const worker=fileURLToPath(new URL('./ttuf-worker.mjs',import.meta.url));
const code=error=>/^[A-Z][A-Z0-9_:.-]{0,160}$/.test(error?.message??'')?error.message:'PLUGIN_EXECUTION_FAILED';
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=200;
const stopped=()=>new Error('PLUGIN_STOPPED');
function cancellable(operation,signal){
  if(signal.aborted)return Promise.reject(stopped());
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(stopped());signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{if(signal.aborted)throw stopped();return operation()}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort)).catch(()=>{});
  });
}
function cleanPayload(method,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Buffer.byteLength(JSON.stringify(input))>64000)throw new Error('PLUGIN_SEND_INVALID');
  const keys=method==='runtime.ttm'?['characterId','conversationId','content','mode','deliveryId']:['characterId','conversationId','content','deliveryId'];
  if(Object.keys(input).some(key=>!keys.includes(key))||!identifier(input.characterId)||!identifier(input.conversationId)||!identifier(input.deliveryId)||typeof input.content!=='string'||!input.content.trim()||input.content.length>50000||method==='runtime.ttm'&&!['steer','queue'].includes(input.mode))throw new Error('PLUGIN_SEND_INVALID');
  return Object.fromEntries(keys.filter(key=>input[key]!==undefined).map(key=>[key,input[key]]));
}

// Installed plugins are trusted local Node programs. This host isolates crashes,
// bounds IPC and owns lifecycle; it does not claim to sandbox filesystem/network.
export class TtufHost {
  constructor({pluginRoot,sendTTM,sendChannel,log=()=>{},changed=()=>{},forkProcess=fork}){
    this.root=path.resolve(pluginRoot);this.sendTTM=sendTTM;this.sendChannel=sendChannel;this.log=log;this.changed=changed;this.forkProcess=forkProcess;
    this.plugins=new Map();this.queues=new Map();this.startRequests=new Map();this.state={version:1,plugins:{}};this.writes=Promise.resolve();this.closing=false;
  }
  assertOpen(){if(this.closing)throw new Error('PLUGIN_HOST_CLOSED');}
  async init(){
    await fs.mkdir(this.root,{recursive:true,mode:0o700});this.root=await fs.realpath(this.root);this.stateFile=path.join(this.root,'state.json');
    try{const value=JSON.parse(await fs.readFile(this.stateFile,'utf8'));if(value.version!==1||!value.plugins||Array.isArray(value.plugins))throw new Error('PLUGIN_STATE_INVALID');this.state=value;}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const [id,record] of Object.entries(this.state.plugins)){
      try{if(!/^suna-[a-z0-9-]+-\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(record.directory))throw new Error('PLUGIN_DIRECTORY_INVALID');
        const directory=path.join(this.root,record.directory),manifest=await this.verify(directory);
        if(manifest.id!==id)throw new Error('PLUGIN_ID_INVALID');
        this.plugins.set(id,{manifest,directory,config:validateTtufConfig(manifest,{},record.config),enabled:record.enabled===true,status:'stopped',error:null,process:null});
      }catch(error){this.log('plugin.invalid',{pluginId:id,code:code(error)});}
    }
    return this.listPlugins();
  }
  async verify(directory,expected){
    if(await fs.realpath(directory)!==directory)throw new Error('PLUGIN_FILE_INTEGRITY');
    const manifestPath=path.join(directory,'manifest.json');if(!(await fs.lstat(manifestPath)).isFile()||await fs.realpath(manifestPath)!==manifestPath)throw new Error('PLUGIN_FILE_INTEGRITY');
    const bytes=await fs.readFile(manifestPath);if(bytes.length>65536)throw new Error('PLUGIN_MANIFEST_INVALID');
    const manifest=JSON.parse(bytes),files=new Map([['manifest.json',bytes]]);
    if(expected&&sha256(bytes)!==sha256(Buffer.from(JSON.stringify(expected))))throw new Error('PLUGIN_FILE_INTEGRITY');
    let total=bytes.length;
    for(const name of Object.keys(manifest.files??{})){
      if(!/^[a-zA-Z0-9._/-]+$/.test(name)||name.startsWith('/')||name.split('/').some(value=>!value||value==='.'||value==='..'))throw new Error('PLUGIN_FILE_INTEGRITY');
      const filename=path.join(directory,name),stat=await fs.lstat(filename);total+=stat.size;
      if(!stat.isFile()||total>8*1024*1024||await fs.realpath(filename)!==filename)throw new Error('PLUGIN_FILE_INTEGRITY');
      files.set(name,await fs.readFile(filename));
    }
    validateTtufPackage(manifest,files);return manifest;
  }
  serialize(id,action){this.assertOpen();const promise=(this.queues.get(id)??Promise.resolve()).catch(()=>{}).then(()=>{this.assertOpen();return action();});this.queues.set(id,promise);void promise.finally(()=>{if(this.queues.get(id)===promise)this.queues.delete(id);}).catch(()=>{});return promise;}
  record(id){const value=this.plugins.get(id);if(!value)throw new Error('PLUGIN_NOT_INSTALLED');return value;}
  persist(update=state=>state){this.writes=this.writes.catch(()=>{}).then(async()=>{
    // Derive each write from the last successfully committed state, never a
    // provisional mutation from a different plugin's failed configuration.
    const next=update(this.state),bytes=JSON.stringify(next,null,2),temp=`${this.stateFile}.${randomUUID()}.tmp`;
    try{await fs.writeFile(temp,bytes,{mode:0o600,flag:'wx'});await fs.rename(temp,this.stateFile);this.state=next;}
    finally{await fs.rm(temp,{force:true}).catch(()=>{});}
  });return this.writes;}
  save(id,record){const value=structuredClone({directory:path.basename(record.directory),config:record.config,enabled:record.enabled});return this.persist(state=>({...state,plugins:{...state.plugins,[id]:value}}));}
  view(record){const config={},hasSecrets=[];for(const [key,value] of Object.entries(record.config)){if(record.manifest.configSchema[key]?.type==='secret'){if(value)hasSecrets.push(key);}else config[key]=value;}
    const configSchema=structuredClone(record.manifest.configSchema);for(const field of Object.values(configSchema))if(field.type==='secret')delete field.default;
    return {id:record.manifest.id,name:record.manifest.name,description:record.manifest.description??'',version:record.manifest.version,kind:'ttuf',ui:record.manifest.ui,status:record.status,configSchema,config,hasSecrets,...(record.error?{error:record.error}:{})};}
  listPlugins(){return [...this.plugins.values()].map(record=>this.view(record));}
  async importPlugin(filename){
    this.assertOpen();const stat=await fs.stat(filename);if(!stat.isFile()||stat.size>8*1024*1024)throw new Error('PLUGIN_ARCHIVE_SIZE');
    const bytes=await fs.readFile(filename),{manifest,files}=readTtufPackage(bytes);
    return this.serialize(manifest.id,async()=>{
      const prior=this.plugins.get(manifest.id);if(prior?.process)throw new Error('PLUGIN_IN_USE');
      const directory=path.join(this.root,`${manifest.id}-${manifest.version}-${sha256(bytes).slice(0,16)}`),temp=await fs.mkdtemp(path.join(this.root,'.install-'));
      try{for(const [name,buffer] of files){const target=path.join(temp,name);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,name==='manifest.json'?JSON.stringify(manifest):buffer,{mode:0o600,flag:'wx'});}try{await fs.rename(temp,directory);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}await this.verify(directory,manifest);}finally{await fs.rm(temp,{recursive:true,force:true});}
      const config=validateTtufConfig(manifest,{},prior?.config??{}),record={manifest,directory,config,enabled:false,status:'stopped',error:null,process:null};
      await this.save(manifest.id,record);this.plugins.set(manifest.id,record);this.changed();return this.view(record);
    });
  }
  configure(id,patch){return this.serialize(id,async()=>{const record=this.record(id);if(record.process)throw new Error('PLUGIN_IN_USE');const config=validateTtufConfig(record.manifest,patch,record.config);await this.save(id,{...record,config});record.config=config;this.changed();return this.view(record);});}
  start(id){
    this.assertOpen();this.record(id);const request=new AbortController(),requests=this.startRequests.get(id)??new Set();requests.add(request);this.startRequests.set(id,requests);
    const task=this.serialize(id,()=>this.startRecord(id,true,request.signal));
    void task.finally(()=>{requests.delete(request);if(!requests.size&&this.startRequests.get(id)===requests)this.startRequests.delete(id)}).catch(()=>{});return task;
  }
  cancelStarts(id){for(const request of this.startRequests.get(id)??[])request.abort();this.plugins.get(id)?.process?.cancelStartup?.();}
  async startRecord(id,persist,signal=new AbortController().signal){
    const check=()=>{if(signal.aborted||this.closing)throw stopped()};check();
    const record=this.record(id);if(record.process)return this.view(record);
    await cancellable(()=>this.verify(record.directory,record.manifest),signal);check();const config=validateTtufConfig(record.manifest,{},record.config,true);
    // Finish an atomic state write before handling cancellation: a successful
    // commit must be reflected in memory even if close/stop arrived during IO.
    if(persist)await this.save(id,{...record,enabled:true});record.enabled=true;check();record.status='starting';record.error=null;
    let child;try{child=this.forkProcess(worker,[],{cwd:record.directory,env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:process.env.LANG??'en_US.UTF-8',TZ:process.env.TZ??'UTC'},execArgv:['--max-old-space-size=128'],stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});}catch{record.status='failed';record.error='PLUGIN_PROCESS_FAILED';this.changed();throw new Error(record.error)}
    const live={child,controller:new AbortController(),calls:new Map(),stopping:false,starting:true,exit:null};record.process=live;this.changed();
    live.exit=new Promise(resolve=>child.once('close',resolve));
    let ready,failed;const startup=new Promise((resolve,reject)=>{ready=resolve;failed=reject;});const timer=setTimeout(()=>failed(new Error('PLUGIN_START_TIMEOUT')),10000);live.cancelStartup=()=>{if(live.starting){live.controller.abort();failed(stopped())}};
    signal.addEventListener('abort',live.cancelStartup,{once:true});if(signal.aborted)live.cancelStartup();
    child.on('error',()=>failed(new Error('PLUGIN_PROCESS_FAILED')));
    child.on('message',message=>{
      if(record.process!==live||live.stopping||signal.aborted||this.closing)return;
      if(message?.type==='ready'){record.status='running';ready();this.changed();}
      else if(message?.type==='failed'){record.error='PLUGIN_EXECUTION_FAILED';failed(new Error(record.error));void this.stopRecord(record,false,'failed');}
      else if(message?.type==='call')void this.handleCall(record,live,message);
      else if(message?.type==='log'){// Never persist arbitrary plugin data or config values.
        this.log('plugin.event',{pluginId:id});
      }
    });
    child.once('close',()=>{clearTimeout(timer);live.controller.abort();if(record.process===live){record.process=null;if(!live.stopping){record.status='failed';record.error='PLUGIN_PROCESS_EXITED';failed(new Error(record.error));}this.changed();}});
    try{child.send({type:'start',entry:path.join(record.directory,record.manifest.entry),config},error=>{if(error)failed(new Error('PLUGIN_PROCESS_FAILED'));});}catch{failed(new Error('PLUGIN_PROCESS_FAILED'))}
    try{await startup;check();return this.view(record);}catch(error){await this.stopRecord(record,false,'failed');record.error=code(error);throw new Error(record.error);}finally{live.starting=false;signal.removeEventListener('abort',live.cancelStartup);clearTimeout(timer);}
  }
  async handleCall(record,live,message){
    if(typeof message.id!=='string'||message.id.length>40||live.calls.has(message.id))return;
    const reply=value=>{if(record.process===live&&!live.stopping&&!this.closing&&live.child.connected)live.child.send({type:'reply',id:message.id,...value},()=>{});};
    try{
      if(live.calls.size>=32)throw new Error('PLUGIN_BUSY');
      if(!record.manifest.capabilities.includes(message.method))throw new Error('PLUGIN_CAPABILITY_DENIED');
      const payload=cleanPayload(message.method,message.payload),handler=message.method==='runtime.ttm'?this.sendTTM:message.method==='channel.send'?this.sendChannel:null;
      if(typeof handler!=='function')throw new Error('PLUGIN_CAPABILITY_UNAVAILABLE');
      const task=Promise.resolve().then(()=>{if(live.controller.signal.aborted||this.closing)throw new Error('PLUGIN_STOPPED');return handler({...payload,pluginId:record.manifest.id,signal:live.controller.signal});});
      live.calls.set(message.id,task);reply({result:await task});
    }catch(error){reply({error:{code:code(error),message:code(error)}});}finally{live.calls.delete(message.id);}
  }
  stop(id){this.assertOpen();this.record(id);this.cancelStarts(id);return this.serialize(id,async()=>{const record=this.record(id);await this.save(id,{...record,enabled:false});record.enabled=false;await this.stopRecord(record);return this.view(record);});}
  async stopRecord(record,_unused=false,status='stopped'){
    const live=record.process;if(!live){record.status=status;this.changed();return;}
    if(live.stopPromise)return live.stopPromise;
    live.stopping=true;live.controller.abort();record.status='stopping';this.changed();
    live.stopPromise=(async()=>{if(live.child.connected)try{live.child.send({type:'stop'},()=>{})}catch{}const kill=setTimeout(()=>{try{live.child.kill('SIGKILL')}catch{}},1500);await live.exit;clearTimeout(kill);if(record.process===live)record.process=null;record.status=status;this.changed();})();
    return live.stopPromise;
  }
  async resume(){for(const [id,record] of this.plugins)if(record.enabled)try{await this.start(id);}catch(error){this.log('plugin.start.failed',{pluginId:id,code:code(error)});}}
  close(){if(this.closePromise)return this.closePromise;this.closing=true;for(const id of this.startRequests.keys())this.cancelStarts(id);for(const record of this.plugins.values())record.process?.controller.abort();this.closePromise=(async()=>{await Promise.allSettled([...this.queues.values()]);await Promise.allSettled([...this.plugins.values()].map(record=>this.stopRecord(record)));await this.writes.catch(()=>{});})();return this.closePromise;}
}
