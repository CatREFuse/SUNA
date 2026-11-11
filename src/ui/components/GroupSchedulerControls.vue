<script setup lang="ts">
import {computed,reactive,watch,useId,onBeforeUnmount} from 'vue'
import type {Conversation,Character} from '../types'
import {request} from '../api'
import {mergeGroupScheduler,mergeChannelGroupScheduler} from '../../core/group-scheduler.mjs'
import TooltipButton from './TooltipButton.vue'
import Icon from './Icon.vue'
const props=withDefaults(defineProps<{conversation:Conversation;characters?:Character[];supported?:boolean;active?:boolean}>(),{active:true})
const emit=defineEmits<{refresh:[];notice:[text:string]}>()
const legacyFields=[{key:'idleMs',label:'空闲等候',unit:'秒',factor:1000},{key:'maxWaitMs',label:'最长等候',unit:'秒',factor:1000},{key:'cooldownMs',label:'冷却',unit:'秒',factor:1000},{key:'maxAutoTurns',label:'角色自动接话次数',unit:'次',factor:1},{key:'runTimeoutMs',label:'运行超时',unit:'秒',factor:1000}] as const
const channelFields=[{key:'historyLimit',label:'回复回溯最大条数',unit:'条',factor:1,min:1,max:1000},{key:'directDebounceMs',label:'防抖期',unit:'秒',factor:1000,min:0,max:60000},{key:'followupBatches',label:'回复监听',unit:'条',factor:1,min:0,max:20},{key:'idleMs',label:'等待时间',unit:'秒',factor:1000,min:10,max:300000},{key:'messageThreshold',label:'等待条数',unit:'条',factor:1,min:1,max:1000}] as const
const advancedFields=legacyFields.filter(field=>field.key==='maxAutoTurns'||field.key==='runTimeoutMs')
 type Field=typeof legacyFields[number]['key']|typeof channelFields[number]['key']
 type Spec={key:Field;label:string;unit:string;factor:number;min?:number;max?:number}
 type Draft=Partial<Record<Field,string>>
 type Quote='inherit'|'on'|'off'
 const channel=computed(()=>props.conversation.channel!=='desktop')
 const fields=computed<readonly Spec[]>(()=>channel.value?[...channelFields,...advancedFields]:legacyFields)
 const supported=computed(()=>!channel.value||props.supported===true&&channelFields.every(field=>{const value=props.conversation.schedulerEffective?.[field.key];return typeof value==='number'&&Number.isSafeInteger(value)&&value>=field.min&&value<=field.max}))
 type Entry={draft:Draft;quote:Quote;baselineQuote:Quote;baseline:string;version:number;saving:boolean;error:string;latest:Conversation;reloadRequired:boolean;rebaseRequired:boolean}
const id=useId(),entries=reactive<Record<string,Entry>>({})
const clone=<T,>(value:T):T=>JSON.parse(JSON.stringify(value))
function quoteValue(conversation:Conversation):Quote{return typeof conversation.replyToTrigger==='boolean'?(conversation.replyToTrigger?'on':'off'):'inherit'}
function values(conversation:Conversation):Draft{return Object.fromEntries((conversation.channel==='desktop'?legacyFields:[...channelFields,...advancedFields]).map(field=>[field.key,typeof conversation.scheduler[field.key]==='number'?String(conversation.scheduler[field.key]!/field.factor):''])) as Draft}
function sync(conversation:Conversation){
 const existing=entries[conversation.id]
 if(!existing){const draft=values(conversation);entries[conversation.id]={draft,quote:quoteValue(conversation),baselineQuote:quoteValue(conversation),baseline:JSON.stringify(draft),version:conversation.version,saving:false,error:'',latest:clone(conversation),reloadRequired:false,rebaseRequired:false};return}
 if(conversation.version<existing.latest.version)return
 existing.latest=clone(conversation)
 if(!existing.saving&&JSON.stringify(existing.draft)===existing.baseline&&existing.quote===existing.baselineQuote){existing.draft=values(conversation);existing.baseline=JSON.stringify(existing.draft);existing.version=conversation.version;existing.quote=quoteValue(conversation);existing.baselineQuote=existing.quote}
}
watch(()=>props.conversation,sync,{immediate:true,deep:true})
const entry=computed(()=>entries[props.conversation.id]),dirty=computed(()=>!!entry.value&&(JSON.stringify(entry.value.draft)!==entry.value.baseline||entry.value.quote!==entry.value.baselineQuote))
const newerVersion=computed(()=>!!entry.value&&entry.value.latest.version>entry.value.version)
const conflicted=computed(()=>newerVersion.value||entry.value?.reloadRequired||entry.value?.rebaseRequired)
const operations=new Set<AbortController>();let disposed=false
onBeforeUnmount(()=>{disposed=true;for(const operation of operations)operation.abort(new Error('页面已关闭'))})
async function boundedRequest<T>(url:string,body?:unknown,method?:string){
 const controller=new AbortController();operations.add(controller);let timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{}
 const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(controller.signal.reason??new Error('请求已取消'));controller.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>controller.abort(new Error('请求超时，请重新读取')),15000)})
 try{return await Promise.race([request<T>(url,body,method,false,controller.signal),cancelled])}finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);operations.delete(controller)}
}
async function reload(){
 const target=entry.value;if(!target||target.saving)return false;target.saving=true;target.error=''
 try{const snapshot=await boundedRequest<{conversations:Conversation[]}>('/snapshot'),latest=snapshot.conversations?.find(item=>item.id===target.latest.id);if(disposed)return false;if(!latest||!Number.isSafeInteger(latest.version)||latest.version<target.latest.version)throw new Error('读取到无效或较旧的会话，请重新读取');target.latest=clone(latest);target.reloadRequired=false;emit('refresh');return true}catch(error){if(!disposed)target.error=errorMessage(error);return false}finally{if(!disposed)target.saving=false}
}

function rebase(){
 if(!props.active||!entry.value||entry.value.saving||entry.value.reloadRequired||!newerVersion.value&&!entry.value.rebaseRequired)return false
 const target=entry.value,previous=JSON.parse(target.baseline) as Draft,next=values(target.latest),draft={...next}
 for(const field of fields.value)if(target.draft[field.key]!==previous[field.key])draft[field.key]=target.draft[field.key]
 target.quote=target.quote===target.baselineQuote?quoteValue(target.latest):target.quote;target.baselineQuote=quoteValue(target.latest);target.draft=draft;target.baseline=JSON.stringify(next);target.version=target.latest.version;target.error='';target.rebaseRequired=false;return true
}
function inherited(field:Spec){if(entry.value?.draft[field.key]===''&&typeof entry.value?.latest.scheduler[field.key]==='number')return '保存后继承';const value=entry.value?.latest.schedulerEffective?.[field.key];return typeof value==='number'?`继承：${value/field.factor}`:'继承值未获取'}
function restore(field:Field){if(props.active&&!entry.value.saving)entry.value.draft[field]=''}
function override(field:Spec){if(props.active&&!entry.value.saving){const value=entry.value.latest.schedulerEffective?.[field.key];if(typeof value==='number')entry.value.draft[field.key]=String(value/field.factor)}}
function shownValue(field:Spec){const value=entry.value.draft[field.key];if(value!=='')return value;if(typeof entry.value.latest.scheduler[field.key]==='number')return '';const effective=entry.value.latest.schedulerEffective?.[field.key];return typeof effective==='number'?String(effective/field.factor):''}
function setQuote(value:Quote){if(props.active&&!entry.value.saving)entry.value.quote=value}
const quoteInheritance=computed(()=>{const people=props.characters?.filter(person=>props.conversation.participantIds.includes(person.id))??[];return people.length?'继承角色：'+people.map(person=>person.name+(person.replyToTrigger===false?'关闭':'开启')).join('、'):'继承角色设置'})
function discard(){if(!entry.value||entry.value.saving)return;entry.value.draft=values(entry.value.latest);entry.value.baseline=JSON.stringify(entry.value.draft);entry.value.version=entry.value.latest.version;entry.value.quote=quoteValue(entry.value.latest);entry.value.baselineQuote=entry.value.quote;entry.value.error='';entry.value.reloadRequired=false;entry.value.rebaseRequired=false}
function patch(draft:Draft,baseline:string){
 const previous=JSON.parse(baseline) as Draft,result:Partial<Record<Field,number|null>>={}
 for(const field of fields.value){
  const raw=(draft[field.key]??'').trim()
  if(draft[field.key]===previous[field.key])continue
  if(!raw){result[field.key]=null;continue}
  if(!(field.factor===1?/^\d+$/:/^(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/).test(raw))throw new Error(`${field.label}格式无效${field.factor===1?'，请输入整数':'，最多三位小数'}`)
  const value=Math.round(Number(raw)*field.factor);if(!Number.isSafeInteger(value)||field.min!==undefined&&value<field.min||field.max!==undefined&&value>field.max)throw new Error(`${field.label}须在 ${(field.min??0)/field.factor}–${(field.max??0)/field.factor} ${field.unit}之间`);result[field.key]=value
 }
 return result
}
function errorMessage(error:unknown){
 let message=error&&typeof error==='object'&&'message' in error?String(error.message):String(error)
 const range=/^(\w+) 必须是 (\d+) 至 (\d+) 的整数$/.exec(message),field=fields.value.find(item=>item.key===range?.[1])
 if(range&&field)return field.factor===1000?`${field.label}须在 ${Number(range[2])/1000}–${Number(range[3])/1000} 秒之间`:`${field.label}须为 ${range[2]}–${range[3]} 的整数`
 for(const item of fields.value)message=message.replaceAll(item.key,item.label)
 return message.replaceAll('最长等待','最长等候').replaceAll('空闲等待','空闲等候')
}
async function save(){
 if(!props.active||!supported.value||props.conversation.kind!=='group'||!entry.value||entry.value.saving||!dirty.value)return false
 if(conflicted.value){entry.value.error='群调度已有更新，请先保留修改并更新版本';return false}
 const target=entry.value,conversationId=props.conversation.id,submitted=JSON.stringify(target.draft),submittedQuote=target.quote
 target.error=''
 let change:Partial<Record<Field,number|null>>
 try{change=patch(target.draft,target.baseline);const baseline=JSON.parse(target.baseline) as Draft;(channel.value?mergeChannelGroupScheduler:mergeGroupScheduler)(Object.fromEntries(fields.value.filter(field=>baseline[field.key]!=='').map(field=>[field.key,Math.round(Number(baseline[field.key])*field.factor)])),change)}catch(error){target.error=errorMessage(error);return false}
 const quoteChanged=channel.value&&target.quote!==target.baselineQuote
 if(!Object.keys(change).length&&!quoteChanged)return false
 const version=target.version;target.saving=true
 try{
  const saved=await boundedRequest<Conversation>(`/conversations/${encodeURIComponent(conversationId)}`,{...(Object.keys(change).length?{scheduler:change}:{}),...(quoteChanged?{replyToTrigger:submittedQuote==='inherit'?null:submittedQuote==='on'}:{}),expectedVersion:version},'PATCH')
  if(disposed)return false
  if(saved.id!==conversationId||!Number.isInteger(saved.version)||saved.version<=version||!saved.scheduler||Object.entries(change).some(([key,value])=>value===null?Object.hasOwn(saved.scheduler,key):(saved.scheduler as Record<string,unknown>)[key]!==value)||quoteChanged&&(submittedQuote==='inherit'?Object.hasOwn(saved,'replyToTrigger'):saved.replyToTrigger!==(submittedQuote==='on')))throw new Error('群调度保存结果无效，请重新读取')
  const confirmed={...target.latest,...saved};if(!Object.hasOwn(saved,'replyToTrigger'))delete confirmed.replyToTrigger;if(saved.version>=target.latest.version)target.latest=clone(confirmed)
  const untouched=JSON.stringify(target.draft)===submitted&&target.quote===submittedQuote,baseline=values(untouched?target.latest:confirmed);target.version=untouched?target.latest.version:saved.version;target.baseline=JSON.stringify(baseline)
  target.baselineQuote=quoteValue(untouched?target.latest:confirmed);if(untouched){target.draft=baseline;target.quote=target.baselineQuote}
  emit('refresh');if(props.conversation.id===conversationId)emit('notice','群调度已保存');return true
 }catch(error){if(!disposed){target.error=errorMessage(error);const status=error&&typeof error==='object'&&'status' in error?Number(error.status):0;if(!status||status===409||status>=500){target.reloadRequired=true;target.rebaseRequired=true}emit('refresh')}return false}
 finally{if(!disposed)target.saving=false}
}
</script>
<template><section v-if="conversation.kind==='group'&&entry" class="group-scheduler-controls" :class="{channel}" aria-label="群调度">
 <template v-if="!supported"><p class="scheduler-note" role="status">当前服务尚未提供新版群聊调度设置，请更新后重新读取。</p><p v-if="entry.error" class="scheduler-error" role="alert">{{entry.error}}</p><button type="button" class="button" :disabled="!active||entry.saving" @click="reload">重新读取</button></template>
 <template v-else>
 <template v-if="channel"><h3>回复方式</h3><div class="quote-setting"><div><span>引用触发消息</span><p class="scheduler-note">{{entry.quote==='inherit'?quoteInheritance:'已覆盖角色设置'}}</p></div><div class="quote-options" role="group" aria-label="Channel 引用触发消息"><button type="button" :aria-pressed="entry.quote==='inherit'" :disabled="!active||entry.saving" @click="setQuote('inherit')">继承</button><button type="button" :aria-pressed="entry.quote==='on'" :disabled="!active||entry.saving" @click="setQuote('on')">开启</button><button type="button" :aria-pressed="entry.quote==='off'" :disabled="!active||entry.saving" @click="setQuote('off')">关闭</button></div></div></template>
 <h3>群聊调度</h3>
 <div v-for="field in (channel?channelFields:fields)" :key="field.key" class="scheduler-field"><label :for="`${id}-${field.key}`">{{field.label}}</label><div class="scheduler-value"><input :id="`${id}-${field.key}`" :value="shownValue(field)" @input="entry.draft[field.key]=($event.target as HTMLInputElement).value" type="text" :inputmode="field.factor===1?'numeric':'decimal'" :placeholder="inherited(field)" :disabled="!active||entry.saving||channel&&entry.draft[field.key]===''" :aria-describedby="field.key==='maxAutoTurns'?`${id}-auto-help`:undefined"/><span class="scheduler-unit">{{field.unit}}</span><button v-if="channel" type="button" class="text-button inherit-button" :aria-label="`${field.label}${entry.draft[field.key]===''?'覆盖':'恢复继承'}`" :disabled="!active||entry.saving" @click="entry.draft[field.key]===''?override(field):restore(field.key)">{{entry.draft[field.key]===''?'覆盖':'恢复继承'}}</button><TooltipButton v-else :label="`${field.label}恢复继承`" icon="reset" :size="16" :disabled="!active||entry.saving||entry.draft[field.key]===''" @click="restore(field.key)"/></div></div>
 <details v-if="channel" class="scheduler-advanced"><summary>运行限制<Icon name="down" :size="14"/></summary><div v-for="field in advancedFields" :key="field.key" class="scheduler-field"><label :for="`${id}-${field.key}`">{{field.label}}</label><div class="scheduler-value"><input :id="`${id}-${field.key}`" v-model="entry.draft[field.key]" type="text" :inputmode="field.factor===1?'numeric':'decimal'" :placeholder="inherited(field)" :disabled="!active||entry.saving"/><span class="scheduler-unit">{{field.unit}}</span><TooltipButton :label="`${field.label}恢复继承`" icon="reset" :size="16" :disabled="!active||entry.saving||entry.draft[field.key]===''" @click="restore(field.key)"/></div></div></details>
 <p v-if="channel" class="scheduler-note">@ 和唤醒词等待触发者补充后直接回复；同一防抖期内的监听消息合计一次。</p><p v-else :id="`${id}-auto-help`" class="scheduler-note">自动接话次数为 0 时，角色不会互相自动唤起；仍可响应人类 @。</p>
 <p v-if="entry.error" class="scheduler-error" role="alert">{{entry.error}}</p>
 <div v-if="conflicted&&dirty" class="scheduler-conflict"><p class="scheduler-note">保留本地修改，未修改项使用最新值；更新版本后需再次保存。</p><button type="button" class="button" :disabled="!active||entry.saving" @click="reload">重新读取</button><button v-if="!entry.reloadRequired" type="button" class="button" :disabled="!active||entry.saving" @click="rebase"><Icon name="refresh" :size="16"/>保留修改并更新版本</button></div>
 <div v-if="dirty" class="scheduler-actions"><button type="button" class="button" :disabled="entry.saving" @click="discard">放弃修改</button><button type="button" class="button primary" :disabled="!active||entry.saving||conflicted" @click="save"><Icon name="save" :size="16"/>{{entry.saving?'保存中…':'保存'}}</button></div>
</template></section></template>
<style scoped>
.scheduler-advanced{margin-top:16px}.scheduler-advanced summary{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--sand-text-secondary);min-height:28px;cursor:pointer;list-style:none}.scheduler-advanced summary::-webkit-details-marker{display:none}.scheduler-advanced summary:focus-visible{background:var(--sand-bg-hover);outline:none}.quote-setting{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 0;font-size:13px}.quote-setting>div:first-child{min-width:0;overflow-wrap:anywhere}.quote-options{display:flex;flex-shrink:0;background:var(--sand-bg-elevated);border-radius:8px;padding:4px}.quote-options button{background:transparent;border:0;color:var(--sand-text-primary);font:inherit;min-height:28px;padding:8px;border-radius:8px}.quote-options button[aria-pressed=true],.quote-options button:hover,.quote-options button:focus-visible{background:var(--sand-bg-hover);outline:2px solid var(--sand-border-focus-primary);outline-offset:1px}.inherit-button{min-height:28px;min-width:56px;padding:8px 4px;white-space:nowrap;font-size:13px}@container(max-width:400px){.quote-setting{flex-wrap:wrap}.quote-options{margin-left:auto}}
.channel .scheduler-value input{border:0;border-bottom:.5px solid var(--sand-border-quaternary-translucent);border-radius:0;background:transparent;padding:4px 8px;text-align:right;min-height:28px;height:28px;min-height:28px;box-sizing:border-box}.channel .scheduler-field{min-height:62px;border-bottom:.5px solid var(--sand-border-quaternary-translucent)}.channel h3{font-size:13px;font-weight:420;color:var(--sand-text-secondary);margin:16px 0 12px}.channel h3:first-child{margin-top:0}.channel .scheduler-actions .button{min-height:28px}
.group-scheduler-controls{container-type:inline-size;min-width:0;padding:12px 0;border-bottom:.5px solid var(--sand-border-quaternary-translucent)}h3{margin:0 0 12px;font-size:13px;font-weight:500}.scheduler-field{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px}.scheduler-field label{font-size:13px;flex:1;min-width:0}.scheduler-value{display:flex;align-items:center;gap:8px;min-width:0;width:210px;max-width:66%}.scheduler-value input{appearance:none;min-width:0;width:100%;min-height:36px;border:1px solid var(--sand-border-quaternary-translucent);border-radius:8px;padding:4px 8px;background:var(--sand-bg-secondary);color:var(--sand-text-primary);font:inherit;font-size:13px;outline:0;box-shadow:none;height:28px;min-height:28px;box-sizing:border-box}.scheduler-value input:focus{background:var(--sand-bg-hover)}.scheduler-unit{font-size:13px;color:var(--sand-text-secondary);flex-shrink:0}.scheduler-value :deep(.icon-button){width:30px;height:36px;min-width:30px}.scheduler-note,.scheduler-error{font-size:13px;line-height:1.6;margin:8px 0;overflow-wrap:anywhere}.scheduler-note{color:var(--sand-text-secondary)}.scheduler-error{color:var(--sand-text-danger-primary)}.scheduler-conflict .button{font-size:13px;font-weight:420}.scheduler-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:12px}.scheduler-actions .button{font-size:13px;font-weight:420}@media(max-width:360px){.scheduler-field{flex-wrap:wrap;padding:4px 0;gap:8px}.scheduler-value{width:100%;max-width:none}.scheduler-field label{flex-basis:100%}}
</style>

<style scoped src="../form-controls.css"></style>
