import {mkdir,readFile,writeFile,readdir,lstat,readlink,realpath,cp,rm,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const fail=code=>Object.assign(new Error(code),{code});
const inside=(base,file)=>file.startsWith(base+path.sep);
export const NAPCAT_ISOLATION_LOADER=`const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'../../../..');
const required={SUNA_INSTANCE_DIR:base,SUNA_QQ_DATA_DIR:path.join(base,'qq-data'),SUNA_ELECTRON_DATA_DIR:path.join(base,'electron'),NAPCAT_WORKDIR:path.join(base,'work'),HOME:path.join(base,'home'),CFFIXED_USER_HOME:path.join(base,'home')};
for(const [key,value] of Object.entries(required)){if(process.env[key]!==value||!fs.existsSync(value)||fs.realpathSync(value)!==value){app.exit(78);throw new Error('SUNA_NAPCAT_ISOLATION_REQUIRED');}}
app.setPath('userData',required.SUNA_ELECTRON_DATA_DIR);
app.setPath('logs',path.join(base,'logs'));
app.whenReady().then(()=>app.dock?.hide());
import(require('node:url').pathToFileURL(path.join(base,'shell/napcat.mjs')).href).catch(()=>app.exit(1));
`;
async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export async function napcatRuntimeInventory(directory,softwareOnly=false){
 const base=await realpath(directory),files={};
 async function walk(dir){for(const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,item.name),rel=path.relative(base,file).split(path.sep).join('/');if(rel==='manifest.json')continue;if(item.name.startsWith('._'))throw fail('NAPCAT_RUNTIME_METADATA_INVALID');const stat=await lstat(file);if(stat.isSymbolicLink()){const target=await readlink(file);if(path.isAbsolute(target)||!inside(base,path.resolve(path.dirname(file),target))||!inside(base,await realpath(file)))throw fail('NAPCAT_RUNTIME_LINK_INVALID');files[rel]={link:target};}else if(stat.isDirectory())await walk(file);else if(stat.isFile())files[rel]={sha256:await digest(file),size:stat.size,mode:stat.mode&0o777};else throw fail('NAPCAT_RUNTIME_FILE_INVALID');}}
 if(softwareOnly){await walk(path.join(base,'QQ.app'));await walk(path.join(base,'shell'));}else await walk(base);return files;
}
export async function validateNapcatRuntime(directory){
 const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
 if(manifest.schemaVersion!==1||manifest.isolationVersion!==1||manifest.platform!=='darwin'||!['arm64','x64','universal'].includes(manifest.arch)||typeof manifest.qqVersion!=='string'||!manifest.files)throw fail('NAPCAT_RUNTIME_MANIFEST_INVALID');
 const files=await napcatRuntimeInventory(directory);if(JSON.stringify(files)!==JSON.stringify(manifest.files))throw fail('NAPCAT_RUNTIME_INTEGRITY_FAILED');
 for(const key of Object.keys(files))if(!key.startsWith('QQ.app/Contents/')&&!key.startsWith('shell/'))throw fail('NAPCAT_RUNTIME_LAYOUT_INVALID');
 for(const required of ['QQ.app/Contents/MacOS/QQ','QQ.app/Contents/Resources/app/suna-loader.cjs','shell/napcat.mjs','shell/package.json'])if(!files[required]?.sha256)throw fail('NAPCAT_RUNTIME_LAYOUT_INVALID');
 const loader=await readFile(path.join(directory,'QQ.app/Contents/Resources/app/suna-loader.cjs'),'utf8');if(loader!==NAPCAT_ISOLATION_LOADER)throw fail('NAPCAT_RUNTIME_ISOLATION_INVALID');
 const source=await readFile(path.join(directory,'shell/napcat.mjs'),'utf8');if(!source.includes('SUNA_QQ_DATA_DIR')||source.includes('SUNABOT_')||source.includes('/Users/'))throw fail('NAPCAT_RUNTIME_ISOLATION_INVALID');
 for(const forbidden of ['config','logs','cache','plugins','qq-data','home','electron'])if(Object.keys(files).some(file=>file.startsWith('shell/'+forbidden+'/')))throw fail('NAPCAT_RUNTIME_STATE_FORBIDDEN');
 return manifest;
}
function validateKey(value){return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);}
async function unusedPort(){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function processIdentity(pid){try{const {stdout}=await execute('/bin/ps',['-ww','-p',String(pid),'-o','pgid=,lstart=,command=']);return stdout.trim();}catch{return null;}}
const nativeDriver={
 async start(instanceDir,port){
  const executable=path.join(instanceDir,'QQ.app/Contents/MacOS/QQ'),electron=path.join(instanceDir,'electron'),home=path.join(instanceDir,'home'),work=path.join(instanceDir,'work');
  const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:process.env.LANG??'en_US.UTF-8',HOME:home,CFFIXED_USER_HOME:home,TMPDIR:path.join(instanceDir,'tmp'),USER:process.env.USER??'',LOGNAME:process.env.LOGNAME??'',SUNA_INSTANCE_DIR:instanceDir,SUNA_QQ_DATA_DIR:path.join(instanceDir,'qq-data'),SUNA_ELECTRON_DATA_DIR:electron,NAPCAT_WORKDIR:work,NAPCAT_QQ_PACKAGE_INFO_PATH:path.join(instanceDir,'QQ.app/Contents/Resources/app/package.json'),NAPCAT_QQ_VERSION_CONFIG_PATH:path.join(work,'versions.json'),NAPCAT_DISABLE_TIME_SYNC:'1',NAPCAT_DISABLE_PIPE:'1',SUNA_QQ_HOSTNAME:'SUNA-'+path.basename(instanceDir).slice(0,8)};
  const log=await open(path.join(instanceDir,'logs/process.log'),'a',0o600);let child;
  try{child=spawn(executable,['--no-sandbox',`--user-data-dir=${electron}`],{cwd:work,env,detached:true,stdio:['ignore',log.fd,log.fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();const signature=await processIdentity(child.pid);if(!signature)throw fail('NAPCAT_PROCESS_EXITED');return {pid:child.pid,signature};}catch(error){if(child?.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}throw error;}finally{await log.close();}
 },
 async alive(record,instanceDir){if(!Number.isSafeInteger(record?.pid)||record.pid<2||!record.signature)return false;const current=await processIdentity(record.pid);return current===record.signature&&current.startsWith(record.pid+' ')&&current.includes(path.join(instanceDir,'QQ.app/Contents/MacOS/QQ')+' --no-sandbox --user-data-dir='+path.join(instanceDir,'electron'));},
 async stop(record,instanceDir){if(!await this.alive(record,instanceDir))return;try{process.kill(-record.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}for(let i=0;i<50;i++){if(!await this.alive(record,instanceDir))return;await pause(100);}if(await this.alive(record,instanceDir))process.kill(-record.pid,'SIGKILL');},
 async wait(record,instanceDir,port,signal,token){const deadline=Date.now()+60000;while(Date.now()<deadline){if(signal.aborted)throw fail('NAPCAT_START_CANCELLED');if(!await this.alive(record,instanceDir))throw fail('NAPCAT_PROCESS_EXITED');try{const response=await fetch(`http://127.0.0.1:${port}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hash:createHash('sha256').update(token+'.napcat').digest('hex')}),signal:AbortSignal.any([signal,AbortSignal.timeout(1000)]),redirect:'error'});const result=await response.json();if(response.ok&&result.code===0&&typeof result.data?.Credential==='string'&&result.data.Credential.length>0)return;}catch{}await pause(250);}throw fail('NAPCAT_WEBUI_TIMEOUT');}
};
/** Host-only manager. No paths, arguments, environment, or driver options are accepted from plugin RPC. */
export async function createNapcatManaged({dataDir,runtimeDir=path.join(root,'runtime/napcat'),onChanged=()=>{},processDriver=nativeDriver}={}){
 if(!path.isAbsolute(dataDir))throw fail('NAPCAT_DATA_DIR_INVALID');await mkdir(dataDir,{recursive:true,mode:0o700});dataDir=await realpath(dataDir);const base=path.join(dataDir,'napcat-managed'),stateFile=path.join(base,'instances.json');await mkdir(base,{recursive:true,mode:0o700});if(await realpath(base)!==base)throw fail('NAPCAT_DATA_DIR_INVALID');
 let saved={instances:[]};try{saved=JSON.parse(await readFile(stateFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const records=new Map(),jobs=new Map(),controllers=new Map(),lifetime=new AbortController();let closed=false,persistQueue=Promise.resolve(),availabilityTask;
 for(const record of saved.instances??[]){if(!/^[a-f0-9-]{36}$/.test(record.id)||!validateKey(record.characterId)||!validateKey(record.requestId)||!['starting','running','stopped','failed','removed'].includes(record.status)||(record.port!==undefined&&(!Number.isInteger(record.port)||record.port<1024||record.port>65535))||(record.token!==undefined&&!/^[a-f0-9]{64}$/.test(record.token)))throw fail('NAPCAT_STATE_INVALID');records.set(record.id,record);}
 const directory=record=>path.join(base,record.id);
 const persist=()=>{const text=JSON.stringify({version:1,instances:[...records.values()]},null,2);persistQueue=persistQueue.catch(()=>{}).then(async()=>{const temporary=stateFile+'.tmp';await writeFile(temporary,text,{mode:0o600});const {rename}=await import('node:fs/promises');await rename(temporary,stateFile);});return persistQueue;};
 const publicValue=record=>({id:record.id,characterId:record.characterId,requestId:record.requestId,status:record.status,createdAt:record.createdAt,...(record.accountId?{accountId:record.accountId}:{}),...(record.error?{error:record.error}:{})});
 const getRecord=id=>{const record=records.get(id);if(!record)throw fail('NAPCAT_INSTANCE_NOT_FOUND');return record;};
 const notify=async()=>{await persist();await onChanged();};
 for(const record of records.values())if(['starting','running'].includes(record.status)){if(await processDriver.alive(record.process,directory(record)))record.status='running';else{record.status='stopped';delete record.process;}}
 await persist();
 async function availability(){if(process.platform!=='darwin')return {available:false,canCreate:false,reason:'NAPCAT_PLATFORM_UNSUPPORTED'};try{availabilityTask??=validateNapcatRuntime(runtimeDir).catch(error=>{availabilityTask=undefined;throw error;});const manifest=await availabilityTask;return {available:true,canCreate:!closed,version:manifest.napcatVersion??manifest.qqVersion};}catch{return {available:false,canCreate:false,reason:'NAPCAT_RUNTIME_UNAVAILABLE'};}}
 async function startNew(record){
  const dir=directory(record);try{
   const manifest=await validateNapcatRuntime(runtimeDir);await mkdir(dir,{mode:0o700});await writeFile(path.join(dir,'runtime-manifest.json'),JSON.stringify(manifest),{mode:0o600});
   await cp(path.join(runtimeDir,'QQ.app'),path.join(dir,'QQ.app'),{recursive:true,verbatimSymlinks:true});await cp(path.join(runtimeDir,'shell'),path.join(dir,'shell'),{recursive:true,verbatimSymlinks:true});
   for(const name of ['home','electron','qq-data','logs','tmp','work/config','work/logs','work/cache','work/plugins'])await mkdir(path.join(dir,name),{recursive:true,mode:0o700});
   await writeFile(path.join(dir,'work/versions.json'),JSON.stringify({baseVersion:manifest.qqVersion,curVersion:manifest.qqVersion,prevVersion:'',onErrorVersions:[],buildId:manifest.qqVersion.split('-')[1]??''}),{mode:0o600});
   return await launch(record);

  }catch(error){await processDriver.stop(record.process,dir).catch(()=>{});record.status='failed';record.error=['NAPCAT_WEBUI_TIMEOUT','NAPCAT_START_CANCELLED','NAPCAT_PROCESS_EXITED'].includes(error.code)?error.code:'NAPCAT_START_FAILED';delete record.process;await notify();throw fail(record.error);}
 }
 async function launch(record){
  const dir=directory(record);if(closed||controllers.get(record.id)?.signal.aborted)throw fail('NAPCAT_START_CANCELLED');if(await realpath(dir)!==dir)throw fail('NAPCAT_INSTANCE_PATH_INVALID');
  const manifest=JSON.parse(await readFile(path.join(dir,'runtime-manifest.json'),'utf8'));const files=await napcatRuntimeInventory(dir,true);if(JSON.stringify(manifest.files)!==JSON.stringify(files))throw fail('NAPCAT_RUNTIME_INTEGRITY_FAILED');
  // Restarts retain the private endpoint so bound connector configuration stays valid.
  record.port??=await unusedPort();record.token??=randomBytes(32).toString('hex');
  await writeFile(path.join(dir,'work/config/webui.json'),JSON.stringify({host:'127.0.0.1',port:record.port,token:record.token,autoLoginAccount:'',disableWebUI:false,accessControlMode:'whitelist',ipWhitelist:['127.0.0.1','::1'],enableXForwardedFor:false}),{mode:0o600});
  record.process=await processDriver.start(dir,record.port);await notify();await processDriver.wait(record.process,dir,record.port,AbortSignal.any([lifetime.signal,controllers.get(record.id).signal]),record.token);if(closed)throw fail('NAPCAT_START_CANCELLED');record.status='running';delete record.error;await notify();return publicValue(record);
 }
 function start(id){
  if(closed)throw fail('NAPCAT_MANAGER_CLOSED');const record=getRecord(id);if(jobs.has(record.requestId))return jobs.get(record.requestId);if(record.status==='removed'||record.status==='failed')throw fail('NAPCAT_REQUEST_FINISHED');
  controllers.set(id,new AbortController());
  const task=(async()=>{try{
   if(record.status==='running'&&await processDriver.alive(record.process,directory(record)))return publicValue(record);
   record.status='starting';await notify();return await launch(record);
  }catch(error){await processDriver.stop(record.process,directory(record)).catch(()=>{});record.status='failed';record.error=['NAPCAT_WEBUI_TIMEOUT','NAPCAT_START_CANCELLED','NAPCAT_PROCESS_EXITED'].includes(error.code)?error.code:'NAPCAT_START_FAILED';delete record.process;await notify();throw fail(record.error);}})();jobs.set(record.requestId,task);void task.finally(()=>jobs.delete(record.requestId)).catch(()=>{});return task;
 }
 function getByRequest({requestId,characterId}){const record=[...records.values()].find(item=>item.requestId===requestId);if(record&&record.characterId!==characterId)throw fail('NAPCAT_REQUEST_CONFLICT');return record?publicValue(record):null;}
 async function create({characterId,requestId}={}){
  if(closed)throw fail('NAPCAT_MANAGER_CLOSED');if(!validateKey(characterId)||!validateKey(requestId))throw fail('NAPCAT_REQUEST_INVALID');const existing=getByRequest({requestId,characterId});if(existing){if(jobs.has(requestId))return jobs.get(requestId);if(existing.status==='failed'||existing.status==='removed')throw fail(existing.error??'NAPCAT_REQUEST_FINISHED');return start(existing.id);}
  const record={id:randomUUID(),characterId,requestId,status:'starting',createdAt:new Date().toISOString()};records.set(record.id,record);controllers.set(record.id,new AbortController());
  const task=(async()=>{await notify();return startNew(record);})();jobs.set(requestId,task);void task.finally(()=>jobs.delete(requestId)).catch(()=>{});return task;
 }
 async function stop(id){const record=getRecord(id);controllers.get(id)?.abort();await jobs.get(record.requestId)?.catch(()=>{});await processDriver.stop(record.process,directory(record));if(record.status!=='removed')record.status='stopped';delete record.process;await notify();return publicValue(record);}
 return {availability,create,start,getByRequest,list:()=>[...records.values()].map(publicValue),get:id=>publicValue(getRecord(id)),
  connection(id){const record=getRecord(id);if(record.status!=='running'||!record.port||!record.token)throw fail('NAPCAT_INSTANCE_NOT_RUNNING');return {transport:'webui-action',webuiUrl:`http://127.0.0.1:${record.port}`,webuiToken:record.token,receiveEvents:false,autoReply:false};},
  async bindAccount(id,accountId){const record=getRecord(id);if(!validateKey(accountId)||record.accountId&&record.accountId!==accountId)throw fail('NAPCAT_ACCOUNT_BINDING_CONFLICT');record.accountId=accountId;await notify();return publicValue(record);},stop,
  async remove(id){await stop(id);const record=getRecord(id);record.status='removed';await notify();return publicValue(record);},
  async close(){if(closed)return;closed=true;lifetime.abort();await Promise.allSettled([...jobs.values()]);for(const record of records.values())if(record.process)await stop(record.id);await persistQueue;}
 };
}
