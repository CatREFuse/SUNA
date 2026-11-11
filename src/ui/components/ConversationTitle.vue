<script setup lang="ts">
import {computed,nextTick,reactive,ref,watch} from 'vue'
import type {Conversation,Character} from '../types'
import {request} from '../api'
import TooltipButton from './TooltipButton.vue'
import CharacterAvatar from './CharacterAvatar.vue'
const props=defineProps<{conversation?:Conversation;name:string;disabled?:boolean;person?:Character;markState?:string}>()
const emit=defineEmits<{refresh:[];notice:[string];details:[]}>()
type Entry={value:string;baseline:string;version:number;editing:boolean;saving:boolean;error:string;latest?:Conversation}
const entries=reactive<Record<string,Entry>>({}),input=ref<HTMLInputElement>(),trigger=ref<InstanceType<typeof TooltipButton>>()
const entry=computed(()=>props.conversation?entries[props.conversation.id]:undefined)
watch(()=>props.conversation,conversation=>{if(!conversation)return;const current=entries[conversation.id];if(!current){entries[conversation.id]={value:props.name,baseline:props.name,version:conversation.version,editing:false,saving:false,error:'',latest:conversation};return}if((current.latest?.version??0)>conversation.version)return;current.latest=conversation;if(!current.editing&&!current.saving){current.value=props.name;current.baseline=props.name;current.version=conversation.version}},{immediate:true,deep:true})
const stale=computed(()=>!!entry.value&&!!entry.value.latest&&entry.value.latest.version>entry.value.version)
async function edit(){if(!entry.value||props.disabled||entry.value.saving||props.conversation?.kind!=='group')return;entry.value.editing=true;await nextTick();input.value?.focus();input.value?.select()}
async function cancel(){if(!entry.value||entry.value.saving)return;entry.value.editing=false;entry.value.error='';const latest=entry.value.latest??props.conversation!;const title=latest.title?.trim()||props.name;entry.value.value=title;entry.value.baseline=title;entry.value.version=latest.version;await nextTick();trigger.value?.focus()}
function updateVersion(){if(!entry.value||!entry.value.latest||entry.value.saving)return;entry.value.version=entry.value.latest.version;entry.value.error=''}
async function save(event?:KeyboardEvent){
 if(event?.isComposing)return false
 if(!entry.value||!props.conversation||props.conversation.kind!=='group'||props.disabled||entry.value.saving)return false
 const target=entry.value,conversationId=props.conversation.id,title=target.value.trim(),version=target.version
 if(!title||title.length>80){target.error='群名须为 1–80 个字符';return false}
 if(stale.value){target.error='群名已有更新，请确认后使用最新版本继续编辑';return false}
 target.saving=true;target.error=''
 try{const saved=await request<Conversation>(`/conversations/${encodeURIComponent(conversationId)}`,{title,expectedVersion:version},'PATCH');if(saved.id!==conversationId||!Number.isInteger(saved.version)||saved.version<=version||saved.title!==title)throw new Error('群名保存结果无效');target.latest=saved;target.version=saved.version;target.baseline=title;target.value=title;target.editing=false;emit('refresh');if(props.conversation?.id===conversationId){emit('notice','群名已保存');await nextTick();trigger.value?.focus()}return true}catch(error){target.error=error&&typeof error==='object'&&'message' in error?String(error.message):String(error);emit('refresh');return false}finally{target.saving=false}
}
</script>
<template><div class="conversation-title"><template v-if="entry?.editing"><input ref="input" v-model="entry.value" class="conversation-title-input" aria-label="群聊名字" maxlength="80" :disabled="entry.saving" @keydown.enter.prevent="save" @keydown.esc.prevent.stop="cancel"/><TooltipButton label="保存群名" icon="check" :size="16" :disabled="entry.saving||stale" @click="save"/><TooltipButton label="放弃修改群名" icon="close" :size="16" :disabled="entry.saving" @click="cancel"/></template><template v-else><button type="button" class="conversation-heading" :disabled="!conversation" @click="emit('details')"><CharacterAvatar v-if="person" :person="person" :mark-state="markState"/><span>{{name}}</span></button><TooltipButton v-if="conversation?.kind==='group'" ref="trigger" label="修改群聊名字" icon="pen" :size="16" :disabled="disabled" @click="edit"/></template><div v-if="entry?.editing&&(entry.error||stale)" class="title-feedback" role="alert"><span>{{entry.error||'群名已有更新'}}</span><button v-if="stale" type="button" class="text-button" @click="updateVersion">使用最新版本继续编辑</button></div></div></template>
<style scoped>
.conversation-title{position:relative;display:flex;align-items:center;gap:8px;min-width:0;flex:1;justify-content:center}.conversation-heading{display:inline-flex;align-items:center;justify-content:center;gap:8px;max-width:min(100%,400px);min-height:36px;padding:4px 16px 4px 8px;border-radius:999px;background:var(--sand-bg-elevated,var(--surface));box-shadow:inset 0 0 0 .5px var(--sand-border-secondary-translucent,var(--faint));cursor:pointer}.conversation-heading:hover{background:var(--sand-bg-elevated-hover,var(--hover))}.conversation-heading>.avatar{width:24px;height:24px}.conversation-heading>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px}.conversation-title-input{min-width:0;width:100%;max-width:420px;height:28px;background:var(--sand-bg-input,var(--input));border:.5px solid var(--sand-border-secondary-translucent,var(--faint));border-radius:10px;outline:0;font:inherit;font-size:13px;line-height:18px;padding:4px 8px}.title-feedback{position:absolute;left:0;top:calc(100% + 8px);z-index:25;display:flex;flex-wrap:wrap;gap:8px;max-width:min(400px,80vw);padding:8px 12px;border-radius:12px;background:var(--sand-bg-elevated,var(--surface));box-shadow:var(--shadow);color:var(--error);font-size:13px}.title-feedback .text-button{font-size:13px;color:var(--text)}
</style>
