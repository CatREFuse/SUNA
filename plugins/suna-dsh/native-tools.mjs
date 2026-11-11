import {createHash} from 'node:crypto';

// This plugin is mounted only inside catalog preset scopes. It never supplies
// an execution grant, including when a catalog preset is selected in DSH GUI.
export const name='suna-native-catalog-guard';
export const inject=['tools'];
export function apply(ctx){ctx.tools.guard(()=> 'SUNA native tool catalog is read-only; execution has not been authorized.');}

const row=(id,module,config)=>({id,name:module,...(config?{config}:{})});
const family=(id,modules,names)=>({id,modules,names});
const families=[
  family('fs',[row('fs','@deepseek-ai/dsh-tool-fs')],['read','write','edit','read_image']),
  family('fs-search',[row('fs-search','@deepseek-ai/dsh-tool-fs-search')],['glob','grep']),
  family('str-replace',[row('str-replace','@deepseek-ai/dsh-tool-str-replace-editor')],['str_replace_editor']),
  family('bash',[row('bash','@deepseek-ai/dsh-tool-bash',{enableRunInBackground:false,promoteOnTimeout:false})],['bash']),
  family('bash-persistent',[row('bash-persistent','@deepseek-ai/dsh-tool-bash-persistent')],['bash']),
  family('pwsh',[row('pwsh','@deepseek-ai/dsh-tool-pwsh')],['pwsh']),
  family('pwsh-persistent',[row('pwsh-persistent','@deepseek-ai/dsh-tool-pwsh-persistent')],['pwsh']),
  family('jobs',[row('jobs','@deepseek-ai/dsh-tool-jobs')],['job_output','job_list','job_kill']),
  family('web',[row('web','@deepseek-ai/dsh-tool-web',{fetch:true})],['web_search','web_fetch']),
  family('subagent',[row('subagent','@deepseek-ai/dsh-tool-subagent',{provider:'spawn',toolName:'subagent',modelSelectionSettings:true}),row('subagent-fork','@deepseek-ai/dsh-tool-subagent',{provider:'fork',toolName:'subagent_fork'})],['subagent','subagent_fork','list_subagent_models']),
  family('subagent-control',[row('subagent-control','@deepseek-ai/dsh-tool-subagent-control'),row('subagent-list','@deepseek-ai/dsh-tool-subagent-control/list-agents')],['send_message','interrupt_agent','list_agents']),
  family('todo',[row('todo','@deepseek-ai/dsh-tool-todo',{allowParallelInProgress:false})],['todo_write']),
  family('goal',[row('goal','@deepseek-ai/dsh-tool-goal')],['get_goal','create_goal','update_goal']),
  family('schedule',[row('schedule','@deepseek-ai/dsh-tool-schedule')],['schedule_create','schedule_list','schedule_update','schedule_delete']),
  family('skill',[row('skill','@deepseek-ai/dsh-tool-skill')],['skill']),
  family('present',[row('present','@deepseek-ai/dsh-tool-present')],['present']),
  family('cordis',[row('cordis','@deepseek-ai/dsh-tool-cordis')],['cordis_inspect_list','cordis_inspect_query']),
  family('workflow',[row('workflow','@deepseek-ai/dsh-tool-workflow',{toolName:'workflow'})],['workflow']),
  family('dependencies',[row('dependencies','@deepseek-ai/dsh-tool-workspace-dependencies')],['load_workspace_dependencies']),
  family('ask-user',[row('ask-user','@deepseek-ai/dsh-tool-ask-user')],['ask_user_question']),
  family('terminal',[row('terminal','@deepseek-ai/dsh-tool-terminal')],['terminal_open','terminal_send','terminal_read','terminal_signal','terminal_close','terminal_list']),
  family('working-directory',[row('working-directory','@deepseek-ai/dsh-tool-working-directory')],['working_directory']),
  family('session-query',[row('session-query','@deepseek-ai/dsh-tool-session-query')],['session_search','session_event_search','session_trace','session_event_trace','session_event_read']),
  family('ralph',[row('ralph','@deepseek-ai/dsh-tool-ralph')],['ralph']),
  family('worktree',[row('worktree','@deepseek-ai/dsh-experimental-tool-worktree')],['create_worktree']),
  family('agent-team',[row('agent-team','@deepseek-ai/dsh-experimental-tool-agent-team')],['spawn_teammate','send_message','list_agents','wait_agent','interrupt_agent','team_task_create','team_task_list','team_task_get','team_task_update']),
  family('plan',[row('plan','@deepseek-ai/dsh-plan-mode')],['exit_plan_mode']),
  family('plugin-manager',[row('plugin-manager','@deepseek-ai/dsh-plugin-manager/tools')],['plugin_manager']),
  family('plugin-market',[row('plugin-market','@deepseek-ai/dsh-plugin-market/tools')],['plugin_market']),
  // PTC is an official presentation transport, not an independently enabled
  // capability. Listing its declared name never opts the Agent into PTC mode.
  family('ptc',[],['run_code']),
];
const clientNames=new Set(['send_message','no_reply','screenshot','get_selfie','websearch','webfetch','cron','interact_env','recall_memory','add_work_memory','update_emotion','image_gen','list_emojis']);
const validName=value=>typeof value==='string'&&/^[a-zA-Z_][a-zA-Z0-9_.:-]{0,199}$/.test(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function description(value){
  let text=typeof value==='string'?value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,4000):'';
  for(const [key,secret]of Object.entries(process.env))if(/KEY|TOKEN|SECRET|PASSWORD/i.test(key)&&typeof secret==='string'&&secret.length>=8)text=text.split(secret).join('[redacted]');
  return text;
}
const closedError=()=>Object.assign(new Error('Native tool catalog is closed'),{code:'NATIVE_CATALOG_CLOSED'});

/** Metadata only. Each family is a separately owned preset, never an Agent.
 * `read()` returns real ToolRuntime.schemas(lease.key) facts when a family can
 * mount; known but missing families remain explicitly declared/unregistered.
 * No schemas, configs, defaults, handles, scope keys or execution functions are
 * serialized to the Client. Every tool stays unavailable until execution gates
 * and safe backends are implemented by a separate composition.
 */
export function createNativeToolCatalog(ctx,{runtimeVersion='',pluginVersion='',namespace='suna-native-catalog',executionCapabilities}={}){
  if(!/^suna-native-catalog(?:-[a-z0-9-]{1,40})?$/.test(namespace))throw new TypeError('Invalid native catalog namespace');
  const service=key=>{try{return typeof ctx.get==='function'?ctx.get(key):ctx[key];}catch{return undefined;}};
  const presets=service('agentPresets'),tools=service('tools');
  let closed=false,closeTask,initializing;
  const reads=new Set(),disposers=[];
  const supported=typeof presets?.register==='function'&&typeof presets?.acquireScope==='function'&&typeof tools?.schemas==='function';
  const registrations=new Map();
  const assertOpen=()=>{if(closed)throw closedError();};
  async function initialize(){
    if(!supported)return;
    for(const group of families){
      assertOpen();
      const id=`${namespace}-${group.id}`;
      try{
        const dispose=await presets.register({id,name:`沙之书工具目录：${group.id}`,description:'仅供工具目录读取；不可执行，不用于对话。',plugins:[row('catalog-guard',new URL('./native-tools.mjs',import.meta.url).href),...group.modules]});
        disposers.push(dispose);registrations.set(group.id,id);
      }catch{registrations.set(group.id,null);}
    }
  }
  async function collect(){
    assertOpen();if(!initializing)initializing=initialize();await initializing;assertOpen();
    let execution={names:[]};if(typeof executionCapabilities==='function')try{execution=await executionCapabilities();}catch{}
    const executable=new Set(Array.isArray(execution?.names)?execution.names:[]);
    const found=new Map();
    for(const group of families){
      assertOpen();let schemas=[],failure=supported?'native.dependencies_unavailable':'native.catalog_api_unavailable';
      const id=registrations.get(group.id);let lease;
      if(id)try{
        lease=await presets.acquireScope(id);assertOpen();
        schemas=tools.schemas(lease.key).filter(schema=>validName(schema?.name)&&group.names.includes(schema.name));
        failure='native.not_registered';
      }catch(error){if(closed)throw closedError();}
      finally{if(lease)await lease[Symbol.asyncDispose]();}
      assertOpen();
      for(const toolName of group.names){
        const schema=schemas.find(item=>item.name===toolName),registered=!!schema;
        const available=registered&&executable.has(toolName)&&!clientNames.has(toolName)&&toolName!=='run_code';
        const backendReason=typeof execution?.reasonFor==='function'?execution.reasonFor(toolName):undefined;
        const value={name:toolName,description:description(schema?.description),schemaDigest:registered?digest(schema):null,origin:group.modules.map(module=>module.name).join(', ')||'@deepseek-ai/dsh-tools',declared:true,registered,enableAllowed:available,available,reason:toolName==='run_code'?'native.transport_reserved':clientNames.has(toolName)?'native.client_owned':available?null:backendReason??(registered?(execution?.reason||(typeof executionCapabilities==='function'?'native.execution_backend_unavailable':'native.execution_not_connected')):failure)};
        const previous=found.get(toolName);
        // Prefer the fresh executor over a duplicate persistent variant, unless
        // only the latter actually registered. No duplicate names reach the UI.
        if(!previous||!previous.registered&&registered)found.set(toolName,value);
      }
    }
    const rows=[...found.values()].sort((a,b)=>a.name.localeCompare(b.name));
    return {protocolVersion:1,runtimeVersion,pluginVersion,presetId:namespace,catalogRevision:digest({runtimeVersion,pluginVersion,tools:rows}),tools:rows};
  }
  return {
    read(){if(closed)return Promise.reject(closedError());const task=collect();reads.add(task);void task.finally(()=>reads.delete(task)).catch(()=>{});return task;},
    close(){if(closeTask)return closeTask;closed=true;closeTask=(async()=>{await Promise.allSettled([...reads,...(initializing?[initializing]:[])]);const failures=[];for(const dispose of disposers.reverse())try{await dispose();}catch(error){failures.push(error);}disposers.length=0;registrations.clear();if(failures.length)throw new AggregateError(failures,'Native catalog scope disposal failed');})();return closeTask;},
  };
}
