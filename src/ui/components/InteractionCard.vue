<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount,onMounted} from 'vue'
import type {ConversationInteraction} from '../types'
import {request} from '../api'
import Icon from './Icon.vue'
const props=withDefaults(defineProps<{interaction:ConversationInteraction;active?:boolean}>(),{active:true})
const current=ref(props.interaction),selected=ref<string[]>([]),custom=ref(''),values=ref<Record<string,string>>({}),revealed=ref(new Set<string>()),busy=ref(false),error=ref('')
let generation=0,disposed=false,controller:AbortController|undefined
const nativeReady=computed(()=>typeof window.sandbook?.submitCredentials==='function')
const pending=computed(()=>current.value.status==='pending'),credential=computed(()=>current.value.kind==='request_credentials')
const ready=computed(()=>credential.value?nativeReady.value&&(current.value.fields??[]).every(f=>!f.required||values.value[f.key]?.length)&&Object.values(values.value).some(v=>v.length):selected.value.length>0||custom.value.trim().length>0)
const sameInteraction=(a:ConversationInteraction,b:ConversationInteraction)=>a.id===b.id&&a.conversationId===b.conversationId&&a.characterId===b.characterId&&a.kind===b.kind
function clearCredentials(){values.value={};revealed.value=new Set()}
function retire(){generation++;controller?.abort();busy.value=false;clearCredentials()}
watch(()=>props.interaction,value=>{if(!sameInteraction(value,current.value)){retire();selected.value=[];custom.value='';error.value=''}current.value=value;if(value.status!=='pending')clearCredentials()},{deep:true})
watch(()=>props.active,active=>{if(!active)retire()})
function visibility(){if(document.hidden)retire()}
onMounted(()=>document.addEventListener('visibilitychange',visibility))
onBeforeUnmount(()=>{disposed=true;retire();document.removeEventListener('visibilitychange',visibility)})
function choose(id:string){if(disposed||!props.active||document.hidden||busy.value||!pending.value)return;if(!current.value.multiple){selected.value=[id];custom.value=''}else selected.value=selected.value.includes(id)?selected.value.filter(v=>v!==id):[...selected.value,id]}
function toggle(key:string){if(disposed||!props.active||document.hidden||busy.value||!pending.value)return;const next=new Set(revealed.value);next.has(key)?next.delete(key):next.add(key);revealed.value=next}
async function action(cancel=false){
 if(disposed||!props.active||document.hidden||busy.value||!pending.value||!cancel&&!ready.value||!sameInteraction(current.value,props.interaction))return
 const scope=Object.freeze({id:current.value.id,conversationId:current.value.conversationId,characterId:current.value.characterId,kind:current.value.kind})
 const url=`/conversations/${encodeURIComponent(scope.conversationId)}/interactions/${encodeURIComponent(scope.id)}`
 const token=++generation,operation=new AbortController()
 controller=operation;busy.value=true;error.value=''
 let payload:Record<string,unknown>|undefined
 const matches=(value:ConversationInteraction)=>value&&value.id===scope.id&&value.conversationId===scope.conversationId&&value.characterId===scope.characterId&&value.kind===scope.kind
 const owns=()=>!disposed&&token===generation&&!operation.signal.aborted&&props.active&&!document.hidden&&matches(current.value)&&matches(props.interaction)
 const adopt=(value:ConversationInteraction)=>{if(!owns()||!matches(value)||value.version<current.value.version)return false;current.value=value;return true}
 try{
  // Every continuation belongs to the immutable original card and controller.
  const latest=cancel?current.value:await request<ConversationInteraction>(url,undefined,undefined,false,operation.signal)
  if(!adopt(latest))return
  if(latest.status!=='pending'){if(owns())clearCredentials();return}
  const credentialRequest=scope.kind==='request_credentials'
  payload={expectedVersion:latest.version,...(!cancel?(credentialRequest?{values:{...values.value},credentialVersion:latest.credentialVersion}:{selected:[...selected.value],custom:custom.value}):{})}
  const result=!cancel&&credentialRequest
   ?await window.sandbook!.submitCredentials!({conversationId:scope.conversationId,characterId:scope.characterId,id:scope.id,expectedVersion:latest.version,credentialVersion:latest.credentialVersion!,values:payload.values as Record<string,string>})
   :await request<{interaction?:ConversationInteraction}&ConversationInteraction>(url+(cancel?'/cancel':'/answer'),payload,undefined,false,operation.signal)
  if(!owns())return
  const updated=(result as {interaction?:ConversationInteraction}).interaction??(result as ConversationInteraction)
  if(!adopt(updated))return
  if(owns())clearCredentials()
 }catch(cause){
  if(!owns())return
  const code=(cause as {code?:string})?.code
  if(code==='VERSION_CONFLICT'||code==='INTERACTION_CLOSED'){
   try{
    const refreshed=await request<ConversationInteraction>(url,undefined,undefined,false,operation.signal)
    if(!adopt(refreshed))return
    if(refreshed.status!=='pending'){if(owns())clearCredentials();return}
   }catch{if(!owns())return}
  }
  if(owns())error.value=(cause as Error)?.message??'提交失败，请重试'
 }finally{
  // Only this operation's private payload is erased after retirement.
  if(payload&&'values'in payload)for(const key of Object.keys(payload.values as object))delete (payload.values as Record<string,string>)[key]
  if(owns())busy.value=false
 }
}
</script>
<template>
 <section class="interaction-card" :class="{credential}" :aria-label="credential?'填写凭证':'回答问题'" :aria-busy="busy">
  <header><h3>{{credential?current.title:current.question}}</h3><span v-if="pending&&!credential" class="selection-mode">{{current.multiple?'多选':'单选'}}</span><Icon v-if="!pending&&current.status!=='cancelled'" name="check" :size="18"/></header>
  <form v-if="pending" @submit.prevent="action()">
   <fieldset v-if="!credential" :disabled="busy||!active" :aria-label="current.question" class="choices">
    <label v-for="option in current.options" :key="option.id" class="choice" :class="{selected:selected.includes(option.id)}"><input :type="current.multiple?'checkbox':'radio'" :name="current.id" :checked="selected.includes(option.id)" @change="choose(option.id)"/><span class="choice-mark" :class="{radio:!current.multiple}"><Icon v-if="selected.includes(option.id)&&current.multiple" name="check" :size="12"/></span><span>{{option.label}}</span></label>
    <label class="custom-answer"><span>自定义回答</span><textarea v-model="custom" @input="!current.multiple&&custom.trim()&&(selected=[])" rows="2" maxlength="5000" placeholder="填写回答"/></label>
   </fieldset>
   <fieldset v-else :disabled="busy||!active||!nativeReady" class="credentials-fields">
    <label v-for="field in current.fields" :key="field.key" class="credential-field"><span class="field-label"><span class="field-name">{{field.label}}</span><span v-if="!field.required" class="optional">选填</span></span><span class="credential-input"><input v-model="values[field.key]" :type="field.type==='password'&&!revealed.has(field.key)?'password':'text'" :required="field.required" maxlength="16384" autocomplete="off" autocapitalize="off" :spellcheck="false" :aria-label="field.label"/><button v-if="field.type==='password'" type="button" class="reveal" :aria-label="revealed.has(field.key)?'隐藏'+field.label:'显示'+field.label" :aria-pressed="revealed.has(field.key)" @click="toggle(field.key)"><Icon name="eye" :size="16"/></button></span><code class="credential-key">{{field.key}}</code></label>
   </fieldset>
   <p v-if="error" class="interaction-error" role="alert">{{error}}</p>
   <footer><button type="button" class="button" :disabled="busy||!active" @click="action(true)">取消</button><button class="button primary" type="submit" :disabled="busy||!active||!ready">{{busy?'提交中…':credential?'保存凭证':'提交回答'}}</button></footer>
  </form>
  <div v-else-if="current.status==='answered'" class="answer-summary"><p v-for="(answer,index) in current.answer?.selected" :key="index">{{answer}}</p><p v-if="current.answer?.custom">{{current.answer.custom}}</p></div>
  <div v-else-if="current.status==='saved'" class="saved-summary"><span>已保存</span><code v-for="key in current.savedKeys" :key="key">{{key}}</code></div>
  <p v-else class="cancelled-summary">已取消</p>
 </section>
</template>
<style scoped>
.interaction-card{width:360px;max-width:100%;box-sizing:border-box;border:1px solid var(--faint);border-radius:14px;padding:16px;background:var(--surface);color:var(--text);font-size:14px;line-height:20px;text-align:left}
header{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px}h3{flex:1;min-width:0;margin:0;font-size:15px;line-height:22px;font-weight:500;overflow-wrap:anywhere}.selection-mode{flex:none;font-size:12px;line-height:22px;color:var(--muted)}header>svg{flex:none;align-self:center}
fieldset{min-width:0;padding:0;margin:0;border:0}.choices{display:grid;gap:8px}.choice{display:flex;align-items:center;gap:8px;position:relative;min-height:36px;padding:8px 12px;box-sizing:border-box;background:var(--hover);border-radius:10px;cursor:pointer;overflow-wrap:anywhere}.choice:hover{background:var(--selected)}.choice.selected{background:var(--selected)}.choice input{position:absolute;width:1px;height:1px;opacity:0}.keyboard .choice:has(input:focus-visible){outline:2px solid var(--focus);outline-offset:2px}.choice-mark{display:grid;place-items:center;flex:none;width:16px;height:16px;box-sizing:border-box;border:1px solid var(--muted);border-radius:4px}.choice-mark.radio{border-radius:50%}.selected .choice-mark{border-color:var(--text);background:var(--text);color:var(--surface)}.selected .radio::after{content:'';width:6px;height:6px;background:var(--surface);border-radius:50%}
.custom-answer{display:grid;gap:8px;margin-top:8px;font-size:13px}.custom-answer textarea{resize:vertical;min-height:64px;width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--faint);border-radius:10px;background:var(--input);color:var(--text);font:inherit;line-height:20px}.custom-answer textarea::placeholder{color:var(--muted)}
.credentials-fields{display:grid;gap:16px}.credential-field{display:grid;gap:8px;min-width:0}.field-label{display:flex;align-items:flex-start;gap:8px;min-width:0;margin:0;font-size:13px}.field-name{flex:1;min-width:0;overflow-wrap:anywhere}.optional{flex:none;font-size:12px;color:var(--muted)}.credential-input{display:flex;align-items:center;gap:4px;min-height:36px;border-radius:10px;background:var(--input);border:1px solid var(--faint);padding:0 8px 0 12px}.keyboard .credential-input:has(input:focus-visible){outline:2px solid var(--focus);outline-offset:2px}.credential-input input{flex:1;min-width:0;width:100%;height:32px;padding:0;border:0;border-radius:0;background:transparent;color:var(--text);font:inherit;outline:none}.credential-input input:focus-visible{outline:none}.credential-key{font-size:11px;line-height:16px;color:var(--muted);overflow-wrap:anywhere}.reveal{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;color:var(--muted);background:transparent;cursor:pointer}.reveal:hover{background:var(--hover);color:var(--text)}
footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}footer button{padding-inline:12px;font-size:13px;line-height:18px}.interaction-error{margin:12px 0 0;color:var(--error);font-size:13px;line-height:18px}.answer-summary p{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.saved-summary{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.saved-summary span{font-size:13px}.saved-summary code{min-width:0;max-width:100%;font-size:12px;overflow-wrap:anywhere;color:var(--muted)}.cancelled-summary{margin:0;color:var(--muted);font-size:13px}fieldset:disabled .choice{cursor:default}button:disabled{cursor:default}.interaction-card :is(button,input,textarea):focus:not(:focus-visible){outline:none}@media(max-width:480px){.interaction-card{width:100%;padding:12px}}
</style>
