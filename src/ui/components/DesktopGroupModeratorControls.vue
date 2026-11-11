<script setup lang="ts">
import {computed,onBeforeUnmount,reactive,useId,watch} from 'vue'
import type {Conversation,DesktopGroupSchedulerSettings} from '../types'
import {request} from '../api'
import CustomSelect from './CustomSelect.vue'
const props=withDefaults(defineProps<{conversation:Conversation;supported?:boolean;active?:boolean}>(),{active:true,supported:false})
const emit=defineEmits<{refresh:[];notice:[text:string]}>()
type Draft={mode:'existing'|'moderated';decisionTimeoutMs:string;decisionPrompt:string}
type Entry={draft:Draft;baseline:string;version:number;latest:Conversation;reset:boolean;saving:boolean;error:string;reloadRequired:boolean;rebaseRequired:boolean}
const entries=reactive<Record<string,Entry>>({}),id=useId(),operations=new Set<AbortController>();let disposed=false
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v))
function valid(p:DesktopGroupSchedulerSettings|undefined):p is DesktopGroupSchedulerSettings{return !!p&&['existing','moderated'].includes(p.mode)&&Number.isSafeInteger(p.decisionTimeoutMs)&&p.decisionTimeoutMs>=1000&&p.decisionTimeoutMs<=120000&&Number.isSafeInteger(p.historyLimit)&&p.historyLimit>=1&&p.historyLimit<=200&&typeof p.decisionPrompt==='string'&&!!p.decisionPrompt.trim()&&p.decisionPrompt.length<=8000}
function values(c:Conversation):Draft|undefined{const p=c.desktopGroupSchedulerEffective;if(!valid(p))return;return {mode:p.mode,decisionTimeoutMs:String(p.decisionTimeoutMs/1000),decisionPrompt:p.decisionPrompt}}
function sync(c:Conversation){
 const draft=values(c);if(!draft)return
 const entry=entries[c.id]
 if(!entry){entries[c.id]={draft,baseline:JSON.stringify(draft),version:c.version,latest:clone(c),reset:false,saving:false,error:'',reloadRequired:false,rebaseRequired:false};return}
 if(c.version<entry.latest.version)return;entry.latest=clone(c)
 if(!entry.saving&&!entry.reset&&JSON.stringify(entry.draft)===entry.baseline){entry.draft=draft;entry.baseline=JSON.stringify(draft);entry.version=c.version}
}
watch(()=>props.conversation,sync,{immediate:true,deep:true})
const entry=computed(()=>entries[props.conversation.id]),scope=computed(()=>props.conversation.channel==='desktop'&&props.conversation.kind==='group')
const dirty=computed(()=>!!entry.value&&(entry.value.reset||JSON.stringify(entry.value.draft)!==entry.value.baseline))
const ready=computed(()=>scope.value&&props.supported&&valid(props.conversation.desktopGroupSchedulerEffective)&&!!entry.value)
const conflict=computed(()=>!!entry.value&&(entry.value.reloadRequired||entry.value.rebaseRequired||entry.value.latest.version>entry.value.version))
const disabled=computed(()=>!props.active||entry.value?.saving||!ready.value)
const modes=[{value:'existing',label:'当前调度'},{value:'moderated',label:'智能主持'}] as const
const fields=[{key:'decisionTimeoutMs',label:'单次判断超时',unit:'秒'}] as const
const issues=computed(()=>{
 const result:Record<string,string>={},draft=entry.value?.draft;if(!draft||entry.value.reset)return result
 if(!['existing','moderated'].includes(draft.mode))result.mode='请选择调度方式'
 if(!/^(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/.test(draft.decisionTimeoutMs)||!Number.isSafeInteger(Number(draft.decisionTimeoutMs)*1000)||Number(draft.decisionTimeoutMs)<1||Number(draft.decisionTimeoutMs)>120)result.decisionTimeoutMs='请输入 1–120 秒，最多三位小数'
 if(!draft.decisionPrompt.trim()||draft.decisionPrompt.length>8000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(draft.decisionPrompt))result.decisionPrompt='请输入 1–8000 字符的主持提示词'
 return result
})
function update(key:keyof Draft,value:string){if(disabled.value||!entry.value)return;if(key==='mode'){if(value==='existing'||value==='moderated')entry.value.draft.mode=value}else entry.value.draft[key]=value}
function restore(){if(!disabled.value&&entry.value)entry.value.reset=!entry.value.reset}
function discard(){const e=entry.value;if(!e||e.saving)return;const draft=values(e.latest);if(!draft)return;e.draft=draft;e.baseline=JSON.stringify(draft);e.version=e.latest.version;e.reset=false;e.error='';e.reloadRequired=false;e.rebaseRequired=false}
function keepDraft(){const e=entry.value;if(!props.active||!e||e.saving||e.reloadRequired)return;const next=values(e.latest);if(!next)return;const old=JSON.parse(e.baseline) as Draft;for(const key of Object.keys(next) as (keyof Draft)[])if(e.draft[key]!==old[key])Object.assign(next,{[key]:e.draft[key]});e.draft=next;e.baseline=JSON.stringify(values(e.latest));e.version=e.latest.version;e.rebaseRequired=false;e.error=''}
onBeforeUnmount(()=>{disposed=true;for(const c of operations)c.abort(new Error('页面已关闭'))})
async function bounded<T>(url:string,body?:unknown,method?:string){
 const controller=new AbortController();operations.add(controller);let timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{}
 const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(controller.signal.reason??new Error('请求已取消'));controller.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>controller.abort(new Error('请求超时，请重新读取')),15000)})
 try{return await Promise.race([request<T>(url,body,method,false,controller.signal),cancelled])}finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);operations.delete(controller)}
}
async function reread(target:Entry){const state=await bounded<{conversations:Conversation[]}>('/snapshot'),latest=state.conversations.find(c=>c.id===target.latest.id);if(!latest||!values(latest)||latest.version<target.latest.version)throw Error('读取群聊调度失败，请重试');if(disposed)return false;target.latest=clone(latest);target.reloadRequired=false;target.rebaseRequired=true;emit('refresh');return true}
async function reload(){const e=entry.value;if(!e||e.saving)return false;e.saving=true;e.error='';try{return await reread(e)}catch(error){if(!disposed)e.error=error instanceof Error?error.message:String(error);return false}finally{if(!disposed)e.saving=false}}
async function save(){
 const e=entry.value;if(disabled.value||!e||!dirty.value||Object.keys(issues.value).length)return false
 if(conflict.value){e.error='群聊设置已有更新，请先重新读取并保留修改';return false}
 const original=JSON.parse(e.baseline) as Draft,submitted=clone(e.draft),reset=e.reset,change:Record<string,unknown>={}
 for(const key of Object.keys(submitted) as (keyof Draft)[])if(submitted[key]!==original[key])change[key]=key==='decisionTimeoutMs'?Number(submitted[key])*1000:submitted[key]
 const version=e.version;e.saving=true;e.error=''
 try{
  const saved=await bounded<Conversation>(`/conversations/${encodeURIComponent(e.latest.id)}`,{desktopGroupScheduler:reset?null:change,expectedVersion:version},'PATCH')
  if(disposed)return false
  if(saved.id!==e.latest.id||!Number.isSafeInteger(saved.version)||saved.version<=version||!values(saved)||reset&&Object.keys(saved.desktopGroupScheduler??{}).length||!reset&&Object.entries(change).some(([k,v])=>(saved.desktopGroupScheduler as Record<string,unknown>|undefined)?.[k]!==v))throw Error('群聊调度保存结果未确认，请重新读取')
  if(saved.version>=e.latest.version)e.latest=clone(saved)
  const untouched=JSON.stringify(e.draft)===JSON.stringify(submitted)&&e.reset===reset,next=values(untouched?e.latest:saved)!
  e.baseline=JSON.stringify(next);e.version=untouched?e.latest.version:saved.version;e.reset=false;e.reloadRequired=false;e.rebaseRequired=false;if(untouched)e.draft=next;emit('refresh');if(props.conversation.id===e.latest.id)emit('notice','群聊调度已保存');return true
 }catch(error){
  if(disposed)return false;e.error=error instanceof Error?error.message:String(error);e.reloadRequired=true;e.rebaseRequired=true
  if((error as {code?:string})?.code==='VERSION_CONFLICT')try{await reread(e)}catch{}
  return false
 }finally{if(!disposed)e.saving=false}
}
</script>

<template>
 <section v-if="scope&&(supported||dirty)" class="desktop-moderator-controls">
  <template v-if="entry">
   <div class="moderator-row"><label :for="`${id}-mode`">调度方式</label><span v-if="entry.reset" class="pending-reset">保存后恢复默认</span><CustomSelect v-else :id="`${id}-mode`" :model-value="entry.draft.mode" :options="modes" :disabled="disabled" aria-label="群聊调度方式" @update:model-value="update('mode',$event)"/></div>
   <template v-if="!entry.reset&&entry.draft.mode==='moderated'">
    <div v-for="field in fields" :key="field.key" class="moderator-row"><label :for="`${id}-${field.key}`">{{field.label}}</label><div class="moderator-field"><div class="moderator-number"><input :id="`${id}-${field.key}`" :value="entry.draft[field.key]" inputmode="decimal" :disabled="disabled" :aria-invalid="!!issues[field.key]" :aria-describedby="issues[field.key]?`${id}-${field.key}-error`:undefined" @input="update(field.key,($event.target as HTMLInputElement).value)"/><span>{{field.unit}}</span></div><p v-if="issues[field.key]" :id="`${id}-${field.key}-error`" class="error">{{issues[field.key]}}</p></div></div>
    <div class="moderator-prompt"><label :for="`${id}-prompt`">主持提示词</label><textarea :id="`${id}-prompt`" :value="entry.draft.decisionPrompt" :disabled="disabled" :aria-invalid="!!issues.decisionPrompt" :aria-describedby="issues.decisionPrompt?`${id}-prompt-error`:undefined" @input="update('decisionPrompt',($event.target as HTMLTextAreaElement).value)"/><p v-if="issues.decisionPrompt" :id="`${id}-prompt-error`" class="error">{{issues.decisionPrompt}}</p></div>
   </template>
   <p v-if="!ready" class="error">当前服务未提供内置群聊主持设置</p><p v-if="entry.error" class="error" role="alert">{{entry.error}}</p>
   <div v-if="conflict" class="moderator-actions"><button type="button" :disabled="!active||entry.saving" @click="reload">重新读取</button><button type="button" :disabled="!active||entry.saving||entry.reloadRequired" @click="keepDraft">保留修改并更新版本</button></div>
   <div class="moderator-actions"><button type="button" :disabled="disabled" @click="restore">{{entry.reset?'撤销恢复':'恢复默认'}}</button><button v-if="dirty" type="button" :disabled="!active||entry.saving" @click="discard">放弃修改</button><span class="spacer"/><button type="button" class="save" :disabled="disabled||!dirty||conflict||!!Object.keys(issues).length" @click="save">{{entry.saving?'保存中':'保存'}}</button></div>
  </template>
  <p v-else class="error">读取群聊调度失败</p>
 </section>
</template>

<style scoped>
.desktop-moderator-controls{display:flex;flex-direction:column;gap:16px;margin-bottom:24px;color:var(--sand-text-primary)}.moderator-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:32px}.moderator-row>label,.moderator-prompt>label{font-size:13px;line-height:20px}.moderator-row :deep(.custom-select){width:160px;max-width:60%;flex:none}.moderator-field{max-width:60%}.moderator-number{display:flex;align-items:center;gap:8px}.moderator-number input{width:88px;min-height:28px;padding:4px 8px;border:1px solid var(--sand-border-secondary-translucent);border-radius:8px;background:var(--sand-bg-elevated);color:inherit;font:inherit;font-size:13px;font-variant-numeric:tabular-nums}.moderator-number>span,.pending-reset{font-size:12px;line-height:20px;color:var(--sand-text-secondary)}.moderator-prompt{display:flex;flex-direction:column;gap:8px}.moderator-prompt textarea{width:100%;min-height:128px;resize:vertical;padding:8px;border:1px solid var(--sand-border-secondary-translucent);border-radius:8px;background:var(--sand-bg-elevated);color:inherit;font:inherit;font-size:13px;line-height:20px}.moderator-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.moderator-actions button{min-height:28px;padding:4px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}.moderator-actions button:not(:disabled):hover{background:var(--sand-bg-hover)}.moderator-actions .save{background:var(--sand-bg-primary);color:var(--sand-text-inverted)}.moderator-actions .save:not(:disabled):hover{opacity:.88}.moderator-actions button:disabled{opacity:.5;cursor:default}.spacer{flex:1}.error{margin:0;font-size:12px;line-height:20px;color:var(--sand-text-danger-primary)}.desktop-moderator-controls :is(input,textarea,button):focus{outline:none}.desktop-moderator-controls :is(input,textarea,button):focus-visible{outline:2px solid var(--sand-border-focus-primary);outline-offset:1px}@media(max-width:440px){.moderator-row{align-items:flex-start;gap:8px}.moderator-actions .spacer{display:none}.moderator-actions .save{margin-left:auto}}
</style>
