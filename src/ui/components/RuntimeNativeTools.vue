<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue'
import type {RuntimeStatus,RuntimeNativeTool,RuntimeNativeToolsState,RuntimeNativeToolsChange} from '../types'
import {request} from '../api'
import Icon from './Icon.vue'
import ToggleSwitch from './ToggleSwitch.vue'
const props=defineProps<{active:boolean;runtime:RuntimeStatus;disabled?:boolean;developer?:boolean}>()
const emit=defineEmits<{refresh:[];notice:[string];busy:[boolean]}>()
const state=ref<RuntimeNativeToolsState>(),loading=ref(false),saving=ref(''),error=ref(''),query=ref('')
let sequence=0,disposed=false
const pending=computed(()=>loading.value||Boolean(saving.value))
const nativeWrite=()=> (window.sandbook as unknown as {setRuntimeNativeTools?:(change:RuntimeNativeToolsChange)=>Promise<RuntimeNativeToolsState>}|undefined)?.setRuntimeNativeTools
const writable=computed(()=>Boolean(nativeWrite()))
const connected=computed(()=>state.value?.status==='connected'&&props.runtime.ok)
const tools=computed(()=>{const text=query.value.trim().toLocaleLowerCase();return (state.value?.tools??[]).filter(tool=>!text||`${tool.name} ${tool.description}`.toLocaleLowerCase().includes(text))})
const statusLabel=computed(()=>!state.value?(loading.value?'读取中…':'尚未读取'):state.value.status==='connected'?'':state.value.status==='disconnected'?'DSH 未连接':state.value.status==='unsupported'?'当前 DSH 不支持原生工具管理':'工具目录不可用')
function binding(value:RuntimeNativeToolsState){return JSON.stringify([value.targetId,value.generation,value.catalogRevision])}
function runtimeIdentity(){return JSON.stringify([props.runtime.mode,props.runtime.status,props.runtime.ok,props.runtime.version])}
function message(cause:unknown){return cause instanceof Error?cause.message:String(cause)}
function canChange(tool:RuntimeNativeTool){return !props.disabled&&!pending.value&&writable.value&&(tool.configuredEnabled||connected.value&&tool.available)}
function toolStatus(tool:RuntimeNativeTool){if(!tool.registered)return '未注册';if(!tool.available)return '不可用';if(tool.configuredEnabled)return tool.effectiveEnabled?'已启用':'已启用，尚未生效';return tool.effectiveEnabled?'已关闭，仍在生效':'已关闭'}
const reasonLabels:Record<string,string>={
 'native.ui_backend_unavailable':'当前运行环境不支持此工具的界面交互。',
 'native.host_management_unavailable':'当前运行环境不支持管理 DSH 服务或插件。',
 'native.pwsh_backend_unavailable':'当前运行环境不支持 PowerShell 命令。',
 'native.pty_backend_unavailable':'当前运行环境不支持交互式终端。',
 'native.background_jobs_unavailable':'当前运行环境不支持后台任务。',
 'native.network_backend_unavailable':'当前运行环境不支持此工具的网络访问。',
 'native.scheduler_backend_unavailable':'当前运行环境不支持此工具的定时任务。',
 'native.session_access_backend_unavailable':'当前运行环境不支持此工具的会话访问。',
 'native.delegation_backend_unavailable':'当前运行环境不支持此工具的子任务协作。',
 'native.workspace_binding_fixed':'工作目录已绑定到角色，不能通过此工具切换。',
 'native.host_resource_backend_unavailable':'当前运行环境不支持此工具的资源加载。',
 'native.sandbox_unavailable':'安全执行环境不可用。',
 'native.dependencies_unavailable':'工具所需的依赖不可用。',
 'native.catalog_api_unavailable':'当前 DSH 不支持读取工具目录。',
 'native.not_registered':'当前 DSH 尚未注册此工具。',
 'native.transport_reserved':'此工具由 DSH 内部调用，不能单独启用。',
 'native.client_owned':'此工具由沙之书管理，不通过原生工具开关启用。',
 'native.execution_backend_unavailable':'此工具的执行服务不可用。',
 'native.execution_not_connected':'此工具尚未连接执行服务。',
 BRIDGE_UNSUPPORTED:'当前 DSH 不支持原生工具管理。',
 BRIDGE_NATIVE_AUTH_UNSUPPORTED:'当前 DSH 不支持原生工具执行授权。',
 RUNTIME_DISCONNECTED:'DSH 未连接。',
 TOOL_NOT_REGISTERED:'当前 DSH 尚未注册此工具。',
}
function toolReason(reason:string){return Object.hasOwn(reasonLabels,reason)?reasonLabels[reason]:'工具不可用'}
async function load(){
 if(disposed||saving.value||props.disabled)return false
 const ticket=++sequence,identity=runtimeIdentity();loading.value=true;error.value=''
 try{const next=await request<RuntimeNativeToolsState>('/runtime/native-tools');if(disposed||ticket!==sequence||identity!==runtimeIdentity())return false;state.value=next;return true}
 catch(cause){if(!disposed&&ticket===sequence){state.value=undefined;error.value=message(cause)}return false}
 finally{if(ticket===sequence)loading.value=false}
}
async function change(tool:RuntimeNativeTool,enabled:boolean){
 const write=nativeWrite(),before=state.value;if(!write||!before||!canChange(tool)||enabled===tool.configuredEnabled||enabled&&!tool.available)return false
 const ticket=++sequence,identity=runtimeIdentity(),target=binding(before)
 saving.value=tool.id;error.value='';emit('busy',true)
 try{
  const next=await write({expectedVersion:before.version,targetId:before.targetId,generation:before.generation,catalogRevision:before.catalogRevision,changes:[{id:tool.id,enabled}]})
  if(disposed||ticket!==sequence||identity!==runtimeIdentity()||!state.value||binding(state.value)!==target)return false
  if(next.targetId!==before.targetId||next.generation!==before.generation){state.value=undefined;error.value='DSH 实例已改变，请重新读取工具目录。';return false}
  state.value=next;emit('refresh');emit('notice',`${tool.name} ${enabled?'已启用':'已关闭'}`);return true
 }catch(cause){if(!disposed&&ticket===sequence)error.value=message(cause);return false}
 finally{saving.value='';emit('busy',false);if(!disposed&&props.active&&!state.value&&!props.disabled)void load()}
}
function invalidate(){sequence++;state.value=undefined;loading.value=false;error.value='';emit('busy',Boolean(saving.value))}
watch([()=>props.active,runtimeIdentity] as const,([active],previous)=>{if(!active){invalidate();return}if(previous?.[0])invalidate();if(!props.disabled)void load()},{immediate:true})
watch(()=>props.disabled,disabled=>{if(disabled&&!saving.value){sequence++;loading.value=false;state.value=undefined}else if(!disabled&&props.active&&!pending.value)void load()})
onBeforeUnmount(()=>{disposed=true;invalidate()})
</script>
<template>
 <section class="runtime-native-tools" aria-label="Core Tools" :aria-busy="pending">
  <div class="native-tools-heading"><h3>Core Tools</h3><button type="button" class="button" :disabled="pending||disabled" @click="load"><Icon name="refresh" :size="16"/>重新读取</button></div>
  <p v-if="error" class="inline-error native-tools-error" role="alert">{{error}}</p>
  <p v-if="statusLabel" class="native-tools-note" role="status">{{statusLabel}}</p>
  <template v-if="state">
   <p v-if="!writable" class="native-tools-note">请在桌面设置窗口修改工具开关。</p>
   <div v-if="state.tools.length" class="native-tools-search"><Icon name="search" :size="16"/><input v-model="query" type="search" aria-label="搜索 Core Tools" placeholder="搜索工具"/></div>
   <ul class="native-tools-list"><li v-for="tool in tools" :key="tool.id" class="native-tool-row"><div class="native-tool-copy"><div class="native-tool-title"><Icon :name="'tool:'+tool.name" :size="17"/><span>{{tool.name}}</span><span class="native-tool-status" role="status">{{saving===tool.id?'保存中…':toolStatus(tool)}}</span></div><p v-if="tool.description" class="native-tool-description">{{tool.description}}</p><p v-if="tool.reason" class="native-tool-reason">{{toolReason(tool.reason)}}</p><details v-if="developer&&tool.reason" class="native-tool-details"><summary>开发者详情</summary><code>{{tool.reason}}</code></details></div><ToggleSwitch :model-value="tool.configuredEnabled" :aria-label="`启用 ${tool.name}`" :disabled="!canChange(tool)" @update:model-value="change(tool,$event)"/></li></ul>
   <p v-if="state.status==='connected'&&!state.tools.length" class="native-tools-note" role="status">当前 DSH 没有注册原生工具。</p><p v-else-if="state.tools.length&&!tools.length" class="native-tools-note" role="status">没有匹配的工具。</p>
   <p v-if="state.tools.length" class="native-tools-note native-tools-policy">启用后，仍按角色、频道账号和会话权限执行。</p>
  </template>
 </section>
</template>
<style scoped>
.runtime-native-tools{container-type:inline-size;padding-top:24px;margin-top:24px;border-top:.5px solid var(--sand-border-secondary-translucent);min-width:0}.native-tools-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.native-tools-heading h3{margin:0;font-size:13px;font-weight:500}.native-tools-heading .button{font-size:13px;font-weight:420}.native-tools-note{font-size:13px;line-height:1.5;color:var(--sand-text-secondary);margin:12px 0}.native-tools-error{font-size:13px;overflow-wrap:anywhere}.native-tools-search{display:flex;align-items:center;gap:8px;max-width:420px;min-height:28px;padding:8px 12px;margin:0 0 8px;border:1px solid var(--sand-border-secondary-translucent);border-radius:8px;background:var(--sand-bg-secondary);color:var(--sand-text-secondary)}.native-tools-search input{width:100%;min-width:0;padding:4px 8px;border:0;border-radius:0;outline:none;box-shadow:none;background:transparent;font-family:inherit;font-size:13px;color:var(--sand-text-primary);appearance:none;height:28px;min-height:28px;box-sizing:border-box}.native-tools-search input::-webkit-search-cancel-button{appearance:none}.native-tools-list{list-style:none;margin:0;padding:0}.native-tool-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:.5px solid var(--sand-border-secondary-translucent)}.native-tool-copy{min-width:0;flex:1}.native-tool-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:420;overflow-wrap:anywhere}.native-tool-title>svg{flex-shrink:0}.native-tool-status{font-size:13px;color:var(--sand-text-secondary);margin-left:auto}.native-tool-description,.native-tool-reason{font-size:13px;color:var(--sand-text-secondary);line-height:1.5;margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.native-tool-details{margin-top:8px;font-size:13px;color:var(--sand-text-secondary);overflow-wrap:anywhere}.native-tool-details summary{cursor:pointer}.native-tool-details code{display:block;margin-top:8px;font:inherit;white-space:pre-wrap}.native-tools-policy{margin-top:16px}@container(max-width:420px){.native-tool-row{gap:8px}.native-tool-status{margin-left:0}.native-tools-search{max-width:none}.native-tool-description{margin-top:8px}}
</style>

<style scoped src="../form-controls.css"></style>
