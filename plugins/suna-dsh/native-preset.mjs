import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createNativeBackends} from './native-backends.mjs';
import {systemMetricsInstructions} from './system-metrics.mjs';
import {createNativeWebBackend,loadNativeWebDependencies,NATIVE_WEB_TOOL_CONFIG} from './native-web-fetch.mjs';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const bindings=new Map();
// Each resource owns independent teardown. Starting thunks through promises
// also contains synchronous throws, so one failed or pending resource cannot
// prevent the web binding from retiring. Unknown machine ownership stays
// pending; this composition neither invents a deadline nor reports it closed.
async function closeOwnedResources(callbacks,primaryFailures=[]){
  const settled=await Promise.allSettled(callbacks.map(callback=>Promise.resolve().then(callback)));
  const failures=[...primaryFailures,...settled.filter(result=>result.status==='rejected').map(result=>result.reason)];
  if(failures.length===1)throw failures[0];
  if(failures.length>1)throw new AggregateError(failures,'Native execution preset cleanup failed');
}
export const name='suna-native-execution-owner';
export const inject=['tools','systemPrompt'];
// The execution preset can be discovered by the official GUI. Its ancestor
// guard admits only the exact unpublished Agent to which this run binds it.
export async function apply(ctx,config={}) {
  ctx.tools.guard(exec=>{const binding=bindings.get(config.bindingId);return binding?.active&&binding.agent===exec.agent?undefined:'Native execution preset belongs to another SUNA run.';});
  const backend=bindings.get(config.bindingId)?.backend;if(!backend)return;
  const resolve=createRequire(pathToFileURL(await realpath(process.argv[1])));
  const load=async name=>import(pathToFileURL(resolve.resolve(name)).href);
  const [{FileSystem},{SandboxProvider},{ShellExecutor},{ShellEnvRegistry}]=await Promise.all(['@deepseek-ai/dsh-fs','@deepseek-ai/dsh-sandbox','@deepseek-ai/dsh-shell','@deepseek-ai/dsh-shell-env'].map(load));
  class RestrictedFs extends FileSystem {get sandboxMode(){return backend.fs.sandboxMode;}}
  for(const method of ['resolve','processPath','processPathFromHostPath','fileUrl','contains','stat','lstat','readText','streamText','readBytes','readByteRange','listDir','writeText','editText'])Object.defineProperty(RestrictedFs.prototype,method,{value:function(...args){return backend.fs[method](...args);},configurable:true});
  class RestrictedSandbox extends SandboxProvider {confine(...args){return backend.sandbox.confine(...args);}}
  class RestrictedShell extends ShellExecutor {get sandboxMode(){return backend.shell.sandboxMode;}resolve(request){return backend.shell.resolve(withoutManagedShellFacts(request));}execute(request){return backend.shell.execute(withoutManagedShellFacts(request));}}
  class EmptyShellEnv extends ShellEnvRegistry {collect(){return {};}list(){return [];}}
  new RestrictedFs(ctx);new RestrictedSandbox(ctx);new RestrictedShell(ctx);new EmptyShellEnv(ctx);
  ctx.systemPrompt.section({name:'suna:restricted-system-metrics',order:ctx.systemPrompt.getSectionOrder('TOOL_BASH'),text:systemMetricsInstructions});
}

// DSH supplies its own DSH_HOME/session facts to official shell tools. Those
// facts must never become environment variables in the confined command. Keep
// explicit `env` untouched so the backend continues to reject caller overrides.
export function withoutManagedShellFacts(request){if(!request||typeof request!=='object')return request;const safe={...request};delete safe.dshEnv;return safe;}

const groups=[
  {names:['todo_write'],module:'@deepseek-ai/dsh-tool-todo',config:{allowParallelInProgress:false}},
  {names:['get_goal','create_goal','update_goal'],module:'@deepseek-ai/dsh-tool-goal'},
];
export const memoryNativeNames=Object.freeze(groups.flatMap(group=>group.names));
const machineGroups=[{names:['read','write','edit','read_image'],module:'@deepseek-ai/dsh-tool-fs'},{names:['bash'],module:'@deepseek-ai/dsh-tool-bash',config:{enableRunInBackground:false,promoteOnTimeout:false}}];
export function nativeBackendUnavailableReason(name){
  if(name==='pwsh')return 'native.pwsh_backend_unavailable';
  if(name.startsWith('terminal_'))return 'native.pty_backend_unavailable';
  if(name.startsWith('job_'))return 'native.background_jobs_unavailable';
  if(name==='web_search')return 'native.network_backend_unavailable';
  if(name==='web_fetch')return process.env.SUNA_NATIVE_WEB_PROXY_UNAVAILABLE==='1'?'native.proxy_configuration_invalid':'native.web_fetch_backend_unavailable';
  if(name.startsWith('schedule_'))return 'native.scheduler_backend_unavailable';
  if(name.startsWith('session_'))return 'native.session_access_backend_unavailable';
  if(name.startsWith('cordis_')||name.startsWith('plugin_'))return 'native.host_management_unavailable';
  if(['subagent','subagent_fork','list_subagent_models','spawn_teammate','list_agents','wait_agent','interrupt_agent','ralph','create_worktree'].includes(name)||name.startsWith('team_task_'))return 'native.delegation_backend_unavailable';
  if(name==='working_directory')return 'native.workspace_binding_fixed';
  if(['skill','load_workspace_dependencies','workflow'].includes(name))return 'native.host_resource_backend_unavailable';
  if(['present','ask_user_question','exit_plan_mode'].includes(name))return 'native.ui_backend_unavailable';
  return undefined;
}

export function createNativeExecutionCapabilities() {
  const abort=new AbortController();let probe,closed=false;
  return {
    read(){if(!probe)probe=(async()=>{let directory,backend,web=false;try{await loadNativeWebDependencies();web=true;}catch{}try{directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'suna-native-capability-')));backend=await createNativeBackends({workspaceRoot:directory,signal:abort.signal,authorize:()=>!closed});return {names:[...memoryNativeNames,...machineGroups.flatMap(group=>group.names),...(web?['web_fetch']:[])],reasonFor:nativeBackendUnavailableReason};}catch{return {names:[...memoryNativeNames,...(web?['web_fetch']:[])],reasonFor:name=>machineGroups.some(group=>group.names.includes(name))?'native.sandbox_unavailable':nativeBackendUnavailableReason(name)};}finally{await backend?.close();if(directory)await rm(directory,{recursive:true,force:true});}})();return probe;},
    async close(){closed=true;abort.abort();await probe;},
  };
}

/** A run-private execution composition. It has no standard persona or catalog
 * guard and never inherits the user's GUI preset. Host-machine tool families
 * are deliberately absent until a confined backend is mounted for this run.
 */
export async function prepareNativeExecutionPreset(ctx,{allow=[],workspaceRoot,signal,authorize,permissionPreset}={}) {
  if(!Array.isArray(allow)||allow.some(value=>typeof value!=='string'))throw new TypeError('Invalid native tool allow list');
  const requested=new Set(allow),selected=groups.filter(group=>group.names.some(name=>requested.has(name)));
  let backend,webBackend;const official=permissionPreset!==undefined;
  if(official){if(!ctx.get?.('permissionPresets')?.names.includes(permissionPreset))throw new Error('Runtime permission preset is unavailable');selected.push(...machineGroups.filter(group=>group.names.some(name=>requested.has(name))));}
  if(requested.has('web_fetch')&&signal&&typeof authorize==='function')try{webBackend=await createNativeWebBackend({signal,authorize});}catch{/* Missing reviewed HTTP dependencies do not enable fetch. */}
  if(!official&&machineGroups.some(group=>group.names.some(name=>requested.has(name)))&&workspaceRoot&&signal&&typeof authorize==='function')try{backend=await createNativeBackends({workspaceRoot,signal,authorize});selected.push(...machineGroups.filter(group=>group.names.some(name=>requested.has(name))));}catch{/* No fallback to unconfined host services. */}
  let presets;try{presets=typeof ctx.get==='function'?ctx.get('agentPresets'):ctx.agentPresets;}catch{}
  if(!selected.length&&!webBackend||typeof presets?.register!=='function'||typeof presets?.mount!=='function'){await closeOwnedResources([()=>backend?.close(),()=>webBackend?.close()]);return {mount:async()=>({enabledNames:[],unavailable:allow.map(name=>({name,reason:'native.execution_backend_unavailable'}))}),close:async()=>{}};}
  const bindingId=randomUUID(),binding={active:true,agent:null,backend};bindings.set(bindingId,binding);
  const isolation=backend||official||webBackend?{...(backend||official?{fs:bindingId,sandbox:bindingId,shell:bindingId,shellEnv:bindingId}:{}),...(webBackend?{web:bindingId}:{})}:undefined;
  const id=`suna-native-execution-${bindingId}`;let dispose;
  try{dispose=await presets.register({id,name:'SUNA native execution',plugins:[...(official?[{id:'official-env',name:'@deepseek-ai/dsh-shell-env',isolate:isolation},{id:'official-fs',name:'@deepseek-ai/dsh-fs-sandbox',config:{cwd:workspaceRoot},isolate:isolation},{id:'official-sandbox',name:'@deepseek-ai/dsh-sandbox-local',isolate:isolation},{id:'official-shell',name:'@deepseek-ai/dsh-bash-sandbox',config:{cwd:workspaceRoot,timeoutMs:60000,maxTimeoutMs:120000},isolate:isolation}]:[]),{id:'owner',name:new URL('./native-preset.mjs',import.meta.url).href,config:{bindingId},...(isolation?{isolate:isolation}:{})},...(webBackend?[{id:'web-service',name:'@deepseek-ai/dsh-web',config:{fetchProvider:'http'},isolate:isolation},{id:'web-provider',name:new URL('./native-web-fetch.mjs',import.meta.url).href,config:{bindingId:webBackend.bindingId},isolate:isolation},{id:'web-tool',name:'@deepseek-ai/dsh-tool-web',config:NATIVE_WEB_TOOL_CONFIG,isolate:isolation}]:[]),...selected.map((group,index)=>({id:`native-${index}`,name:group.module,...(group.config?{config:group.config}:{}),...(isolation?{isolate:isolation}:{})}))]});}
  catch(error){bindings.delete(bindingId);await closeOwnedResources([()=>backend?.close(),()=>webBackend?.close()],[error]);throw error;}
  let closed=false,closeTask;
  return {
    async mount(agentCtx,agent){
      if(closed||binding.agent&&binding.agent!==agent)throw new Error('Native execution preset is unavailable');
      binding.agent=agent;webBackend?.bindAgent(agent);await presets.mount(agentCtx,id);
      const actual=new Set(agentCtx.tools.schemas(agent).map(schema=>schema.name));
      const supported=[...selected.flatMap(group=>group.names),...(webBackend?['web_fetch']:[])];const enabledNames=allow.filter(name=>supported.includes(name)&&actual.has(name));
      return {enabledNames,unavailable:allow.filter(name=>!enabledNames.includes(name)).map(name=>({name,reason:'native.execution_backend_unavailable'}))};
    },
    close(){if(closeTask)return closeTask;closed=true;binding.active=false;bindings.delete(bindingId);return closeTask=closeOwnedResources([()=>dispose(),()=>backend?.close(),()=>webBackend?.close()]);},
  };
}
