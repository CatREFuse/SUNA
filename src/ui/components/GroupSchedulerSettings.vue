<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import type {Snapshot,ChannelGroupSchedulerSettings} from '../types'
import {request} from '../api'
import SettingsGroup from './SettingsGroup.vue'
import ToggleSwitch from './ToggleSwitch.vue'
import Icon from './Icon.vue'
const props=defineProps<{settings:Snapshot['settings'];active:boolean;supported?:boolean}>()
const emit=defineEmits<{refresh:[];notice:[string]}>()
type Key=keyof ChannelGroupSchedulerSettings
type NumericKey='historyLimit'|'directDebounceMs'|'followupBatches'|'idleMs'|'messageThreshold'|'maxAutoTurns'|'runTimeoutMs'|'decisionTimeoutMs'|'decisionRetryCount'
type Draft=Partial<Record<Key,string|boolean|null>>
const switches=[{key:'enabled',label:'启用调度器'},{key:'humanMessages',label:'人类普通消息触发'},{key:'characterMessages',label:'角色消息触发'}] as const
const numbers:Array<{key:NumericKey;label:string;min:number;max:number;unit:string;factor:number}>=[
 {key:'historyLimit',label:'回复回溯最大条数',min:1,max:1000,unit:'条',factor:1},
 {key:'directDebounceMs',label:'防抖期',min:0,max:60000,unit:'秒',factor:1000},
 {key:'followupBatches',label:'回复监听',min:0,max:20,unit:'条',factor:1},
 {key:'idleMs',label:'等待时间',min:10,max:300000,unit:'秒',factor:1000},
 {key:'messageThreshold',label:'等待条数',min:1,max:1000,unit:'条',factor:1},
 {key:'maxAutoTurns',label:'角色自动接话次数',min:0,max:20,unit:'次',factor:1},
 {key:'runTimeoutMs',label:'角色运行超时',min:1000,max:900000,unit:'秒',factor:1000},
 {key:'decisionTimeoutMs',label:'单次判断超时',min:1000,max:120000,unit:'秒',factor:1000},
 {key:'decisionRetryCount',label:'失败重试次数',min:0,max:3,unit:'次',factor:1},
]
const keys:Key[]=[...switches.map(item=>item.key),...numbers.map(item=>item.key),'decisionPrompt']
const baseline=ref<Snapshot['settings']>(),latest=ref<Snapshot['settings']>(),draft=ref<Draft>({}),busy=ref(false),error=ref(''),reloadRequired=ref(false),rebaseRequired=ref(false)
let disposed=false,operation:AbortController|undefined
onBeforeUnmount(()=>{disposed=true;operation?.abort(new Error('页面已关闭'))})
async function boundedRequest(body?:unknown,method?:string){
 const controller=new AbortController();operation=controller
 let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{}
 const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(controller.signal.reason??new Error('请求已取消'));controller.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>controller.abort(new Error('请求超时，请重新读取')),15000)})
 try{return await Promise.race([request<Snapshot['settings']>('/settings',body,method,false,controller.signal),cancelled])}
 finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);if(operation===controller)operation=undefined}
}
const ready=computed(()=>props.supported===true&&Boolean(baseline.value)),dirty=computed(()=>Object.keys(draft.value).length>0)
const newerVersion=computed(()=>Boolean(latest.value&&baseline.value&&latest.value.version!>baseline.value.version!))
const conflicted=computed(()=>reloadRequired.value||rebaseRequired.value||newerVersion.value)
const effective=computed(()=>baseline.value?.channelGroupSchedulerEffective)
function validRetryPolicy(policy:ChannelGroupSchedulerSettings|undefined){return typeof policy?.decisionRetryCount==='number'&&Number.isSafeInteger(policy.decisionRetryCount)&&policy.decisionRetryCount>=0&&policy.decisionRetryCount<=3}
const retrySupported=computed(()=>validRetryPolicy(latest.value?.channelGroupSchedulerEffective))
const retryUnavailableDraft=computed(()=>Object.hasOwn(draft.value,'decisionRetryCount')&&!retrySupported.value)
function supportedKey(key:Key){return key!=='decisionRetryCount'||retrySupported.value}
function validSettings(value:Snapshot['settings']|undefined):value is Snapshot['settings']{
 const policy=value?.channelGroupSchedulerEffective
 return Boolean(value&&Number.isSafeInteger(value.version)&&policy&&switches.every(item=>typeof policy[item.key]==='boolean')&&numbers.every(item=>{const saved=policy[item.key];return item.key==='decisionRetryCount'&&saved===undefined||typeof saved==='number'&&Number.isSafeInteger(saved)&&saved>=item.min&&saved<=item.max})&&typeof policy.decisionPrompt==='string'&&policy.decisionPrompt.trim()&&policy.decisionPrompt.length<=8000)
}
function copySettings(value:Snapshot['settings']){return {...value,channelGroupScheduler:{...value.channelGroupScheduler},channelGroupSchedulerEffective:{...value.channelGroupSchedulerEffective!}}}
function adopt(value:Snapshot['settings']){baseline.value=copySettings(value);draft.value={};reloadRequired.value=false;rebaseRequired.value=false;error.value=''}
function receive(value:Snapshot['settings']){
 if(!validSettings(value))return false
 if(latest.value&&value.version!<latest.value.version!)return false
 latest.value=copySettings(value)
 if(!baseline.value||(!dirty.value&&!busy.value))adopt(value)
 return true
}
watch(()=>props.settings,value=>{receive(value)},{immediate:true,deep:true})
watch(()=>[props.active,props.supported],()=>{if(props.active&&props.supported===true&&!ready.value)void reload()},{immediate:true})
function formatValue(key:Key,value:unknown){return typeof value==='number'?String(value/(numbers.find(item=>item.key===key)?.factor??1)):value as string|boolean}
function value(key:Key){return Object.hasOwn(draft.value,key)?draft.value[key]:formatValue(key,effective.value?.[key])}
function update(key:Key,next:string|boolean){
 if(busy.value||!ready.value||!supportedKey(key))return
 const changed={...draft.value}
 if(next===formatValue(key,effective.value?.[key]))delete changed[key]
 else changed[key]=next
 draft.value=changed
}
function isInherited(key:Key){return draft.value[key]===null}
function canRestore(key:Key){return supportedKey(key)&&!isInherited(key)&&(Object.hasOwn(draft.value,key)||Object.hasOwn(baseline.value?.channelGroupScheduler??{},key))}
function restore(key:Key){
 if(busy.value||!ready.value||!supportedKey(key))return
 const changed={...draft.value}
 if(Object.hasOwn(baseline.value?.channelGroupScheduler??{},key))changed[key]=null
 else delete changed[key]
 draft.value=changed
}
function undoRestore(key:Key){if(!busy.value){const changed={...draft.value};delete changed[key];draft.value=changed}}
function restoreAll(){for(const key of keys)restore(key)}
const restorable=computed(()=>keys.some(canRestore))
const validation=computed(()=>{
 const issues:Partial<Record<Key,string>>={},patch:Partial<Record<Key,number|string|boolean|null>>={}
 for(const key of keys){
  if(!supportedKey(key))continue
  if(!Object.hasOwn(draft.value,key))continue
  const raw=draft.value[key]
  if(raw===null){patch[key]=null;continue}
  const spec=numbers.find(item=>item.key===key)
  if(spec){
   const text=String(raw).trim(),scale=spec.factor,numeric=Number(text)*scale,rounded=Math.round(numeric)
   if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)||!Number.isSafeInteger(rounded)||Math.abs(numeric-rounded)>1e-7||rounded<spec.min||rounded>spec.max){issues[key]=`请输入 ${spec.min/scale}–${spec.max/scale} ${spec.unit}${scale===1?'的整数':'，最多三位小数'}`;continue}
   patch[key]=rounded
  }else if(key==='decisionPrompt'){
   if(typeof raw!=='string'||!raw.trim()||raw.length>8000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(raw))issues[key]='请输入 1–8000 字符的非空提示词'
   else patch[key]=raw
  }else if(typeof raw==='boolean')patch[key]=raw
 }

 return {issues,patch,valid:!retryUnavailableDraft.value&&Object.keys(issues).length===0}
})
function message(cause:unknown){return cause instanceof Error?cause.message:typeof cause==='object'&&cause&&'message' in cause?String(cause.message):String(cause)}
async function reload(){
 if(busy.value)return false
 busy.value=true;error.value=''
 try{
  const received=await boundedRequest()
  if(disposed)return false
  if(!validSettings(received))throw new Error('当前服务尚未提供 Channel 群聊调度设置')
  if(latest.value&&received.version!<latest.value.version!)throw new Error('读取到较旧的设置，请重新读取')
  latest.value=copySettings(received)
  if(!dirty.value)adopt(received)
  reloadRequired.value=false
  return true
 }catch(cause){if(!disposed)error.value=message(cause);return false}
 finally{if(!disposed)busy.value=false}
}
function keepDraft(){
 if(busy.value||reloadRequired.value||!latest.value||(!newerVersion.value&&!rebaseRequired.value))return
 baseline.value=copySettings(latest.value);rebaseRequired.value=false;error.value=''
}
function discard(){if(!busy.value&&latest.value)adopt(latest.value)}
async function save(){
 if(busy.value||!ready.value||!dirty.value||conflicted.value||!validation.value.valid)return false
 const expectedVersion=baseline.value!.version!,patch={...validation.value.patch}
 busy.value=true;error.value=''
 try{
  const saved=await boundedRequest({channelGroupScheduler:patch,expectedVersion},'PATCH')
  if(disposed)return false
  if(!validSettings(saved)||saved.version!<=expectedVersion||Object.entries(patch).some(([key,value])=>value===null?Object.hasOwn(saved.channelGroupScheduler??{},key):saved.channelGroupScheduler?.[key as Key]!==value))throw new Error('服务未确认群聊设置已保存，请重新读取')
   if(props.supported!==true)throw new Error('当前后端不支持新版群聊设置，保存结果请在恢复连接后重新读取')
   if(!latest.value||saved.version!>=latest.value.version!)latest.value=copySettings(saved)
  adopt(latest.value!);emit('refresh');emit('notice','Channel 群聊设置已保存');return true
 }catch(cause){
  if(!disposed){
   const status=cause&&typeof cause==='object'&&'status' in cause?Number(cause.status):0
   const versionConflict=status===409||(cause&&typeof cause==='object'&&'code' in cause&&String(cause.code).includes('CONFLICT'))
   const uncertain=!status||status>=500
   error.value=uncertain?'保存结果未确认，请重新读取。'+message(cause):message(cause)
   if(versionConflict||uncertain){reloadRequired.value=true;rebaseRequired.value=true}
  }
  return false
 }finally{if(!disposed)busy.value=false}
}
</script>
<template>
 <section class="group-scheduler-settings" aria-label="Channel 群聊调度设置">
  <template v-if="!ready"><div class="scheduler-unavailable"><p role="status">{{busy?'正在读取群聊设置…':error||'当前服务尚未提供 Channel 群聊调度设置'}}</p><button type="button" class="button" :disabled="busy" @click="reload"><Icon name="refresh" :size="16"/>重新读取</button></div></template>
  <form v-else @submit.prevent="save">
   <p class="scheduler-scope">仅用于 Channel 群聊。@ 和唤醒词等待触发者补充后直接回复。</p>
   <SettingsGroup title="Channel 群聊">
    <div v-for="item in switches" :key="item.key" class="settings-card-row">
     <label :for="`scheduler-${item.key}`">{{item.label}}</label>
     <div class="scheduler-control"><template v-if="isInherited(item.key)"><span class="inherit-pending">保存后恢复继承</span><button type="button" class="text-button" :disabled="busy" @click="undoRestore(item.key)">撤销</button></template><template v-else><button v-if="canRestore(item.key)" type="button" class="text-button restore-field" :aria-label="`${item.label}恢复继承`" :disabled="busy" @click="restore(item.key)">恢复继承</button><ToggleSwitch :id="`scheduler-${item.key}`" :model-value="Boolean(value(item.key))" :aria-label="item.label" :disabled="busy" @update:model-value="update(item.key,$event)"/></template></div>
    </div>
   </SettingsGroup>
   <SettingsGroup title="群聊调度">
    <div v-for="item in numbers.slice(0,5)" :key="item.key" class="settings-card-row numeric-row">
     <label :for="`scheduler-${item.key}`">{{item.label}}</label>
     <div class="scheduler-field"><div class="scheduler-control"><template v-if="isInherited(item.key)"><span class="inherit-pending">保存后恢复继承</span><button type="button" class="text-button" :disabled="busy" @click="undoRestore(item.key)">撤销</button></template><template v-else><button v-if="canRestore(item.key)" type="button" class="text-button restore-field" :aria-label="`${item.label}恢复继承`" :disabled="busy" @click="restore(item.key)">恢复继承</button><input :id="`scheduler-${item.key}`" :value="value(item.key)" :inputmode="item.factor===1?'numeric':'decimal'" :disabled="busy" :aria-invalid="Boolean(validation.issues[item.key])" :aria-describedby="validation.issues[item.key]?`scheduler-${item.key}-error`:undefined" @input="update(item.key,($event.target as HTMLInputElement).value)"/><span class="scheduler-unit">{{item.unit}}</span></template></div><p v-if="validation.issues[item.key]" :id="`scheduler-${item.key}-error`" class="scheduler-error" role="alert">{{validation.issues[item.key]}}</p></div>
    </div>
   </SettingsGroup>
   <SettingsGroup title="运行限制">
    <div v-for="item in numbers.slice(5,7)" :key="item.key" class="settings-card-row numeric-row"><label :for="`scheduler-${item.key}`">{{item.label}}</label><div class="scheduler-field"><div class="scheduler-control"><template v-if="isInherited(item.key)"><span class="inherit-pending">保存后恢复继承</span><button type="button" class="text-button" :disabled="busy" @click="undoRestore(item.key)">撤销</button></template><template v-else><button v-if="canRestore(item.key)" type="button" class="text-button restore-field" :aria-label="`${item.label}恢复继承`" :disabled="busy" @click="restore(item.key)">恢复继承</button><input :id="`scheduler-${item.key}`" :value="value(item.key)" :inputmode="item.factor===1?'numeric':'decimal'" :disabled="busy" :aria-invalid="Boolean(validation.issues[item.key])" @input="update(item.key,($event.target as HTMLInputElement).value)"/><span class="scheduler-unit">{{item.unit}}</span></template></div><p v-if="validation.issues[item.key]" class="scheduler-error" role="alert">{{validation.issues[item.key]}}</p></div></div>
   </SettingsGroup>
   <SettingsGroup title="参与判断">
    <div class="settings-card-row numeric-row"><label for="scheduler-decisionTimeoutMs">单次判断超时</label><div class="scheduler-field"><div class="scheduler-control"><template v-if="isInherited('decisionTimeoutMs')"><span class="inherit-pending">保存后恢复继承</span><button type="button" class="text-button" :disabled="busy" @click="undoRestore('decisionTimeoutMs')">撤销</button></template><template v-else><button v-if="canRestore('decisionTimeoutMs')" type="button" class="text-button restore-field" aria-label="单次判断超时恢复继承" :disabled="busy" @click="restore('decisionTimeoutMs')">恢复继承</button><input id="scheduler-decisionTimeoutMs" :value="value('decisionTimeoutMs')" inputmode="decimal" :disabled="busy" :aria-invalid="Boolean(validation.issues.decisionTimeoutMs)" :aria-describedby="validation.issues.decisionTimeoutMs?'scheduler-decisionTimeoutMs-error':undefined" @input="update('decisionTimeoutMs',($event.target as HTMLInputElement).value)"/><span class="scheduler-unit">秒</span></template></div><p v-if="validation.issues.decisionTimeoutMs" id="scheduler-decisionTimeoutMs-error" class="scheduler-error" role="alert">{{validation.issues.decisionTimeoutMs}}</p></div></div>
    <div v-if="retrySupported" class="settings-card-row numeric-row">
     <label for="scheduler-decisionRetryCount">失败重试次数</label>
     <div class="scheduler-field"><div class="scheduler-control"><template v-if="isInherited('decisionRetryCount')"><span class="inherit-pending">保存后恢复继承</span><button type="button" class="text-button" :disabled="busy" @click="undoRestore('decisionRetryCount')">撤销</button></template><template v-else><button v-if="canRestore('decisionRetryCount')" type="button" class="text-button restore-field" aria-label="失败重试次数恢复继承" :disabled="busy" @click="restore('decisionRetryCount')">恢复继承</button><input id="scheduler-decisionRetryCount" :value="value('decisionRetryCount')" inputmode="numeric" :disabled="busy" :aria-invalid="Boolean(validation.issues.decisionRetryCount)" :aria-describedby="validation.issues.decisionRetryCount?'scheduler-decisionRetryCount-error':undefined" @input="update('decisionRetryCount',($event.target as HTMLInputElement).value)"/><span class="scheduler-unit">次</span></template></div><p v-if="validation.issues.decisionRetryCount" id="scheduler-decisionRetryCount-error" class="scheduler-error" role="alert">{{validation.issues.decisionRetryCount}}</p></div>
    </div>
    <div class="scheduler-prompt"><div class="scheduler-prompt-heading"><label for="scheduler-decisionPrompt">调度提示词</label><button v-if="canRestore('decisionPrompt')" type="button" class="text-button" :disabled="busy" @click="restore('decisionPrompt')"><Icon name="refresh" :size="16"/>恢复默认</button></div><div v-if="isInherited('decisionPrompt')" class="scheduler-control"><span class="inherit-pending">保存后恢复默认</span><button type="button" class="text-button" :disabled="busy" @click="undoRestore('decisionPrompt')">撤销</button></div><textarea v-else id="scheduler-decisionPrompt" :value="String(value('decisionPrompt')??'')" rows="5" maxlength="8000" :disabled="busy" :aria-invalid="Boolean(validation.issues.decisionPrompt)" :aria-describedby="validation.issues.decisionPrompt?'scheduler-prompt-error':undefined" @input="update('decisionPrompt',($event.target as HTMLTextAreaElement).value)"/><p v-if="validation.issues.decisionPrompt" id="scheduler-prompt-error" class="scheduler-error" role="alert">{{validation.issues.decisionPrompt}}</p></div>
   </SettingsGroup>
   <div class="scheduler-feedback" aria-live="polite"><p v-if="error" class="scheduler-error" role="alert">{{error}}</p><p v-if="retryUnavailableDraft" class="scheduler-error" role="alert">当前服务尚未提供失败重试设置，修改已保留，请重新读取。</p><p v-if="conflicted" class="scheduler-conflict">当前修改尚未确认保存。</p><div v-if="error||conflicted||retryUnavailableDraft" class="scheduler-recovery"><button type="button" class="text-button" :disabled="busy" @click="reload"><Icon name="refresh" :size="16"/>重新读取</button><button v-if="(newerVersion||rebaseRequired)&&!reloadRequired" type="button" class="button" :disabled="busy" @click="keepDraft">保留本地修改并更新版本</button></div></div>
   <div class="scheduler-actions"><button type="button" class="text-button" :disabled="busy||!restorable" @click="restoreAll">恢复继承</button><span class="scheduler-spacer"/><button type="button" class="button" :disabled="busy||!dirty" @click="discard">放弃</button><button type="submit" class="button primary" :disabled="busy||!dirty||conflicted||!validation.valid"><Icon name="save" :size="16"/>{{busy?'处理中…':'保存'}}</button></div>
  </form>
 </section>
</template>
<style scoped>
.group-scheduler-settings{min-width:0;padding:4px 0 20px;font-size:13px;line-height:1.5}.scheduler-scope{margin:0 0 20px;color:var(--sand-text-secondary);font-size:13px}.scheduler-control{display:flex;align-items:center;justify-content:flex-end;gap:12px;min-width:0}.scheduler-field{max-width:64%;min-width:0}.scheduler-control input{width:120px;min-width:72px;max-width:100%;height:28px;padding:4px 8px;border:1px solid var(--sand-border-quaternary-translucent);border-radius:8px;background:var(--sand-bg-secondary);color:var(--sand-text-primary);font-size:13px;text-align:right;font-variant-numeric:tabular-nums;outline:none;box-shadow:none;height:28px;min-height:28px;box-sizing:border-box}.scheduler-unit{min-width:16px;color:var(--sand-text-secondary);font-size:13px}.scheduler-prompt{padding:16px 16px;border-top:.5px solid var(--sand-border-quaternary-translucent)}.scheduler-prompt-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px;font-size:13px}.scheduler-prompt textarea{display:block;box-sizing:border-box;width:100%;min-height:160px;resize:vertical;padding:0;border:0;border-radius:0;outline:none;box-shadow:none;background:transparent;color:var(--sand-text-primary);font-family:inherit;font-size:13px;line-height:20px}.scheduler-error{margin:8px 0 0;color:var(--sand-text-danger-primary);font-size:13px;overflow-wrap:anywhere}.scheduler-field .scheduler-error{text-align:right}.scheduler-feedback{margin-bottom:12px}.scheduler-conflict{margin:8px 0;font-size:13px}.scheduler-recovery{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:8px}.scheduler-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.scheduler-spacer{flex:1}.group-scheduler-settings button{font-size:13px;font-weight:420}.text-button,.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px}.restore-field{white-space:nowrap;flex-shrink:0}.inherit-pending{color:var(--sand-text-secondary);font-size:13px}.scheduler-unavailable{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.scheduler-unavailable p{font-size:13px}.group-scheduler-settings :is(input,textarea):disabled{opacity:.55}.group-scheduler-settings :is(input,textarea):focus-visible{outline:none;box-shadow:none}.group-scheduler-settings button:focus-visible{text-decoration:none;outline:2px solid var(--sand-border-focus-primary);box-shadow:none;outline-offset:1px}@media(max-width:800px){.scheduler-control{gap:8px;flex-wrap:wrap}.scheduler-control input{width:100px}.scheduler-field{max-width:62%}}@media(max-width:600px){.group-scheduler-settings :deep(.settings-card-row){gap:12px;align-items:flex-start}.scheduler-field{max-width:58%}.scheduler-prompt{padding:12px}.scheduler-control input{width:88px;min-height:28px}.text-button,.button{min-height:28px}.scheduler-control .restore-field{order:2;width:100%;justify-content:flex-end}.scheduler-actions .scheduler-spacer{display:none}.scheduler-actions>.text-button{margin-right:auto}}
</style>

<style scoped src="../form-controls.css"></style>
