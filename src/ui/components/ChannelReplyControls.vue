<script setup lang="ts">
import {computed,reactive} from 'vue'
import {request} from '../api'
import type {Conversation} from '../types'
import ToggleSwitch from './ToggleSwitch.vue'
const props=withDefaults(defineProps<{conversation:Conversation;schedulerEnabled:boolean;active?:boolean}>(),{active:true})
const emit=defineEmits<{refresh:[];notice:[text:string];error:[cause:unknown]}>()
const operations=reactive<Record<string,{saving:boolean;error:string;saved?:Conversation}>>({})
const operation=computed(()=>operations[props.conversation.id])
const current=computed(()=>{const saved=operation.value?.saved;return saved&&saved.version>props.conversation.version?saved:props.conversation})
const replyEnabled=computed(()=>current.value.replyEnabled===true)
const saving=computed(()=>operation.value?.saving===true)
const proactiveDisabled=computed(()=>!props.active||saving.value||!replyEnabled.value||!props.schedulerEnabled)
async function save(field:'replyEnabled'|'scheduler',enabled:boolean){
  if(!props.active||saving.value||props.conversation.channel==='desktop'||field==='scheduler'&&(props.conversation.kind!=='group'||proactiveDisabled.value))return false
  const conversation=current.value,id=conversation.id
  operations[id]??={saving:false,error:''}
  const entry=operations[id]
  entry.saving=true;entry.error=''
  try{
    const saved=await request<Conversation>(`/conversations/${encodeURIComponent(id)}`,{...(field==='replyEnabled'?{replyEnabled:enabled}:{scheduler:{enabled}}),expectedVersion:conversation.version},'PATCH')
    if(saved.id!==id||!Number.isInteger(saved.version)||saved.version<=conversation.version)throw new Error('回复设置保存结果无效，请刷新后重试')
    entry.saved={...conversation,...saved,replyEnabled:typeof saved.replyEnabled==='boolean'?saved.replyEnabled:conversation.replyEnabled,scheduler:{...conversation.scheduler,...saved.scheduler}}
    emit('refresh')
    if(props.conversation.id===id)emit('notice','回复设置已保存')
    return true
  }catch(cause){
    entry.error=cause instanceof Error?cause.message:String(cause)
    emit('refresh')
    if(props.conversation.id===id)emit('error',cause)
    return false
  }finally{entry.saving=false}
}
</script>
<template><section v-if="conversation.channel!=='desktop'" class="channel-reply-controls" aria-label="Channel 回复设置" :aria-busy="saving">
  <div class="channel-reply-row"><span>允许回复</span><ToggleSwitch :model-value="replyEnabled" :disabled="saving||!active" aria-label="允许回复" @update:model-value="save('replyEnabled',$event)"/></div>
  <template v-if="conversation.kind==='group'"><div class="channel-reply-row"><span>主动回复</span><ToggleSwitch :model-value="current.scheduler.enabled" :disabled="proactiveDisabled" aria-label="主动回复" :aria-describedby="!schedulerEnabled?'channel-scheduler-status':undefined" @update:model-value="save('scheduler',$event)"/></div><p v-if="!schedulerEnabled" id="channel-scheduler-status" class="channel-reply-status">群聊调度未启用，请在设置中开启</p></template>
  <p v-if="saving" class="channel-reply-status" role="status">正在保存…</p><p v-if="operation?.error" class="channel-reply-error" role="alert">{{operation.error}}</p>
</section></template>
<style scoped>
.channel-reply-controls{margin:0 0 16px;padding:0 0 12px;border-bottom:.5px solid var(--sand-border-quaternary-translucent)}.channel-reply-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px;font-size:13px}.channel-reply-row>span{min-width:0;overflow-wrap:anywhere}.channel-reply-status,.channel-reply-error{margin:4px 0 0;font-size:13px;line-height:1.5;overflow-wrap:anywhere}.channel-reply-status{color:var(--sand-text-secondary)}.channel-reply-error{color:var(--sand-text-primary)}
</style>

<style scoped src="../form-controls.css"></style>
