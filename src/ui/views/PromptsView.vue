<script setup lang="ts">
import ResizableSidebar from '../components/ResizableSidebar.vue'
import {ref,computed,watch,onBeforeUnmount,nextTick} from 'vue'
import type {Snapshot,Prompt,PromptMetadata,PromptCheckpoint,PromptTarget} from '../types'
import {request,download} from '../api'
import CustomSelect from '../components/CustomSelect.vue'
import CheckboxControl from '../components/CheckboxControl.vue'
import ToggleSwitch from '../components/ToggleSwitch.vue'
import Icon from '../components/Icon.vue'
import TooltipButton from '../components/TooltipButton.vue'
import Modal from '../components/Modal.vue'
import PromptWorkerEditor from '../components/PromptWorkerEditor.vue'
import {VARIABLE_NAMES} from '../../core/prompts.mjs'
import {insertPromptVariable} from '../prompt-editor.mjs'
import variableMetadata from '../prompt-variables.json'
const props=withDefaults(defineProps<{state:Snapshot;active:boolean;title?:string;promptTarget?:PromptTarget;globalOnly?:boolean;characterOnly?:boolean}>(),{title:'提示词',globalOnly:false,characterOnly:false}),emit=defineEmits<{refresh:[];error:[unknown];notice:[string]}>()
const overrideOpen=ref(false),overrideCharacter=ref('default-character'),importOpen=ref(false),importEnvelope=ref<any>(),importPreview=ref<any>()
const originalOpen=ref(false),originalRole=ref(''),originalError=ref('')
let originalEpoch=0
let automaticOriginal:{fingerprint:string;role:string;scopeRole:string|undefined}|undefined
const originalFingerprint=(p:Prompt)=>JSON.stringify({key:p.key,version:p.version,revision:p.revision,content:p.content,draft:p.draft,label:p.label,draftLabel:p.draftLabel,metadata:p.metadata,draftMetadata:p.draftMetadata})
const originalScopeRole=(p:Prompt)=>p.characterId??targetContext.value?.characterId??characterId.value
const baseVersion=ref(0),baseRevision=ref(0),savingKey=ref('')
const selected=ref(''),scope=ref('runtime'),text=ref(''),baseline=ref(''),search=ref(''),busy=ref(false),preview=ref<any>(),previewOpen=ref(false),history=ref<Prompt[]>([]),historyOpen=ref(false),characterId=ref('default-character'),importFile=ref<HTMLInputElement>(),editor=ref<HTMLTextAreaElement>(),pendingSelection=ref(''),discardOpen=ref(false)
const entryLabel=ref(''),metadata=ref<PromptMetadata>({}),metadataBaseline=ref(JSON.stringify({label:'',metadata:{}})),xml=ref(false),workerEditor=ref<InstanceType<typeof PromptWorkerEditor>>()
const historyTab=ref<'versions'|'checkpoints'>('versions'),checkpoints=ref<PromptCheckpoint[]>([]),checkpointOpen=ref(false),checkpointName=ref(''),checkpointDetail=ref<PromptCheckpoint>(),checkpointDelete=ref<PromptCheckpoint>()
const checkpointTarget=ref<Record<string,unknown>>()
type RolePromptTarget=PromptTarget&{characterId:string}
const targetContext=ref<RolePromptTarget>(),pendingTarget=ref<RolePromptTarget>(),pendingGlobal=ref(false),targetError=ref(''),createdEntry=ref<Prompt>(),awaitingTarget=ref(false),pendingEpoch=ref(0)
let pendingLeave:((allowed:boolean)=>void)|undefined
let lifecycleEpoch=0,disposed=false
const operationAlive=(epoch:number)=>!disposed&&epoch===lifecycleEpoch&&props.active&&!document.hidden
watch(()=>props.active,active=>{if(!active)lifecycleEpoch++})
function visibilityChanged(){if(document.hidden)lifecycleEpoch++}
document.addEventListener('visibilitychange',visibilityChanged)
function confirmLeave():Promise<boolean>{if(busy.value)return Promise.resolve(false);if(!dirty.value)return Promise.resolve(true);if(pendingLeave||discardOpen.value)return Promise.resolve(false);return new Promise(resolve=>{pendingLeave=resolve;pendingEpoch.value++;discardOpen.value=true})}
defineExpose({confirmLeave})
function allowedEntry(p:Prompt){return props.globalOnly?!p.characterId:props.characterOnly?Boolean(targetContext.value)&&(!p.characterId||p.characterId===targetContext.value?.characterId):!targetContext.value||!p.characterId||p.characterId===targetContext.value.characterId}
const current=computed(()=>props.state.prompts.find(p=>p.key===selected.value&&allowedEntry(p))??(createdEntry.value?.key===selected.value&&allowedEntry(createdEntry.value)?createdEntry.value:undefined))
const schedulerEntry=computed(()=>current.value?.scope==='worker'&&['group_scheduler','group_moderator'].includes(current.value.name))
const inherited=computed(()=>Boolean(targetContext.value&&current.value&&!current.value.characterId))
const targetCharacterName=computed(()=>props.state.characters.find(person=>person.id===targetContext.value?.characterId)?.name??targetContext.value?.characterId??'')
function metadataState(){return JSON.stringify({label:entryLabel.value,metadata:metadata.value})}
const dirty=computed(()=>text.value!==baseline.value||metadataState()!==metadataBaseline.value)
const entries=computed(()=>props.state.prompts.filter(p=>p.scope===scope.value&&allowedEntry(p)&&(!targetContext.value||!['group_scheduler','group_moderator'].includes(p.name))&&(!search.value||`${p.name} ${p.draftLabel??p.label}`.toLowerCase().includes(search.value.toLowerCase()))))
function loadEntry(entry:Prompt){const p=targetContext.value&&!entry.characterId?{...entry,draft:entry.content,draftLabel:entry.label,draftMetadata:entry.metadata}:entry;if(!dirty.value&&automaticOriginal&&automaticOriginal.fingerprint===originalFingerprint(p)&&automaticOriginal.role===originalScopeRole(p)&&automaticOriginal.scopeRole===targetContext.value?.characterId)return;const refreshAutomatic=Boolean(automaticOriginal);automaticOriginal=undefined;text.value=p.draft??p.content;baseline.value=text.value;entryLabel.value=p.draftLabel??p.label??p.name;metadata.value=JSON.parse(JSON.stringify(p.draftMetadata??p.metadata??{}));if((metadata.value.terminate as unknown)==='worker')metadata.value.terminate='dynamic';metadataBaseline.value=metadataState();baseVersion.value=p.version;baseRevision.value=p.revision;if(refreshAutomatic)void nextTick(loadOriginalIfEmpty)}
function resolveTarget(target:PromptTarget){
  const desiredScope=target.scope??'runtime',desiredName=target.name??(desiredScope==='runtime'?'system':undefined)
  const matching=props.state.prompts.filter(p=>p.scope===desiredScope&&(!desiredName||p.name===desiredName))
  return matching.find(p=>p.characterId===target.characterId)??matching.find(p=>!p.characterId)
}
function applyTarget(target:PromptTarget){
  if(props.globalOnly){applyGlobalTarget(target);return}
  const role=target.characterId
  if(typeof role!=='string'||!role.trim()){selected.value='';targetContext.value=undefined;targetError.value='请选择有效角色';return}
  preview.value=undefined;previewOpen.value=false;historyOpen.value=false;checkpointOpen.value=false;checkpointDetail.value=undefined;overrideOpen.value=false
  targetContext.value={...target,characterId:role};characterId.value=role;overrideCharacter.value=role;search.value='';targetError.value=''
  if(!props.state.characters.some(person=>person.id===role)){selected.value='';awaitingTarget.value=props.state.characters.length===0;if(!awaitingTarget.value)targetError.value='角色不存在';return}
  const entry=resolveTarget(target)
  awaitingTarget.value=!entry&&props.state.prompts.length===0
  if(entry)select(entry.key,true)
  else {selected.value='';scope.value=target.scope??'runtime';if(!awaitingTarget.value)targetError.value='未找到对应提示词'}
}
function applyGlobalTarget(target:PromptTarget){
  const entry=props.state.prompts.find(p=>!p.characterId&&p.scope===(target.scope??'runtime')&&p.name===(target.name??(target.scope&&target.scope!=='runtime'?p.name:'system')))
  if(dirty.value&&entry?.key!==selected.value){pendingGlobal.value=true;pendingTarget.value=undefined;pendingSelection.value=entry?.key??'';pendingEpoch.value++;discardOpen.value=true;return}
  if(dirty.value)return
  clearTarget(entry?.key??'');scope.value=target.scope??'runtime';if(!entry)targetError.value='未找到对应共有提示词'
}
function receivePromptTarget(target?:PromptTarget){
  if(props.globalOnly){if(target&&(target.scope===undefined||['runtime','worker','tool'].includes(target.scope)))applyGlobalTarget(target);return}
  if(!target||typeof target.characterId!=='string'||!target.characterId.trim()){if(props.characterOnly){selected.value='';targetContext.value=undefined;targetError.value='请选择有效角色'}return}
  if(target.scope!==undefined&&!['runtime','worker','tool'].includes(target.scope))return
  const roleTarget:RolePromptTarget={...target,characterId:target.characterId}
  const entry=resolveTarget(target),sameContext=targetContext.value?.characterId===target.characterId
  if(dirty.value&&(!sameContext||entry?.key!==selected.value)){pendingGlobal.value=false;pendingTarget.value=roleTarget;pendingSelection.value=entry?.key??'';pendingEpoch.value++;discardOpen.value=true;return}
  if(dirty.value){cancelPending();return}
  applyTarget(target)
}
watch(()=>props.state.prompts,()=>{if(awaitingTarget.value&&targetContext.value){applyTarget(targetContext.value);return}if(!selected.value&&props.state.prompts.length&&!targetContext.value)select(props.state.prompts.find(allowedEntry)?.key??'');else if(!dirty.value&&current.value&&selected.value!==savingKey.value)loadEntry(current.value)},{immediate:true})
watch(()=>props.promptTarget,receivePromptTarget,{immediate:true})
function select(key:string,force=false){const candidate=props.state.prompts.find(p=>p.key===key)??(createdEntry.value?.key===key?createdEntry.value:undefined);if(candidate&&!allowedEntry(candidate))return;if(!candidate&&key)return;if(dirty.value&&!force){pendingGlobal.value=false;pendingTarget.value=undefined;pendingSelection.value=key;pendingEpoch.value++;discardOpen.value=true;return}selected.value=key;const p=props.state.prompts.find(p=>p.key===key)??(createdEntry.value?.key===key?createdEntry.value:undefined);if(p){scope.value=p.scope;loadEntry(p);preview.value=undefined}}
function changeScope(value:string){const first=props.state.prompts.find(p=>p.scope===value&&allowedEntry(p)&&(!targetContext.value||p.characterId===targetContext.value.characterId))??props.state.prompts.find(p=>p.scope===value&&!p.characterId);if(first)select(first.key);else scope.value=value}
function finishPending(){if(pendingLeave){const resolve=pendingLeave;pendingLeave=undefined;if(dirty.value&&current.value)loadEntry(current.value);discardOpen.value=false;resolve(true);return}const target=pendingTarget.value,key=pendingSelection.value,global=pendingGlobal.value;pendingGlobal.value=false;pendingTarget.value=undefined;pendingSelection.value='';discardOpen.value=false;if(global)clearTarget(key);else if(target)applyTarget(target);else select(key,true)}
function cancelPending(){pendingLeave?.(false);pendingLeave=undefined;pendingEpoch.value++;pendingGlobal.value=false;pendingTarget.value=undefined;pendingSelection.value='';discardOpen.value=false}
function clearTarget(key:string){if(props.characterOnly&&!props.globalOnly)return;targetContext.value=undefined;targetError.value='';awaitingTarget.value=false;search.value='';previewOpen.value=false;historyOpen.value=false;overrideOpen.value=false;select(key,true)}
function viewGlobal(){if(props.characterOnly&&!props.globalOnly)return;const entry=props.state.prompts.find(p=>!p.characterId&&p.scope===(current.value?.scope??scope.value)&&p.name===(current.value?.name??'system'))??props.state.prompts.find(p=>!p.characterId);if(dirty.value){pendingGlobal.value=true;pendingTarget.value=undefined;pendingSelection.value=entry?.key??'';pendingEpoch.value++;discardOpen.value=true;return}clearTarget(entry?.key??'')}
function openOverride(){if(props.globalOnly)return;if(targetContext.value)overrideCharacter.value=targetContext.value.characterId;overrideOpen.value=true}
function createInheritedOverride(){if(!targetContext.value)return;overrideCharacter.value=targetContext.value.characterId;return createOverride()}
function input(){preview.value=undefined;if(current.value?.scope==='runtime'&&current.value.name==='dev'&&metadata.value.developerSource==='dsh-original'){metadata.value.developerSource='custom';delete metadata.value.developerSourceSha256;delete metadata.value.developerSourceVersion}}
function openOriginal(){if(busy.value||!props.state.settings.developerMode||inherited.value||current.value?.scope!=='runtime'||current.value.name!=='dev')return;originalRole.value=current.value.characterId??targetContext.value?.characterId??(props.state.characters.some(p=>p.id===characterId.value)?characterId.value:props.state.characters[0]?.id??'');originalError.value='';originalOpen.value=true}
function closeOriginal(){originalEpoch++;originalOpen.value=false;originalError.value=''}
function loadOriginalIfEmpty(){if(!operationAlive(lifecycleEpoch)||busy.value||dirty.value||!props.state.settings.developerMode||current.value?.scope!=='runtime'||current.value.name!=='dev'||metadata.value.developerSource!=='dsh-original'||text.value)return;originalRole.value=current.value.characterId??targetContext.value?.characterId??characterId.value;void readOriginal(true)}
watch(()=>[selected.value,targetContext.value?.characterId,props.active,characterId.value],()=>{closeOriginal();if(automaticOriginal&&!dirty.value&&current.value)loadEntry(current.value);void nextTick(loadOriginalIfEmpty)},{immediate:true})
async function readOriginal(automatic=false){
  if(busy.value||!props.state.settings.developerMode||(!automatic&&inherited.value)||(!automatic&&!originalOpen.value)||current.value?.scope!=='runtime'||current.value.name!=='dev'||!props.state.characters.some(p=>p.id===originalRole.value))return
  const epoch=lifecycleEpoch,generation=++originalEpoch,key=selected.value,role=originalRole.value,scopeRole=targetContext.value?.characterId,content=text.value,metaState=metadataState(),version=baseVersion.value,revision=baseRevision.value;busy.value=true;originalError.value=''
  try{
    const value=await request<{text:string;sha256:string;source:{kind:string;runtimeVersion:string}}>('/prompts/dsh-original',{characterId:role})
    if(!operationAlive(epoch)||!props.state.settings.developerMode||originalRole.value!==role||generation!==originalEpoch||(!automatic&&!originalOpen.value)||selected.value!==key||targetContext.value?.characterId!==scopeRole||text.value!==content||metadataState()!==metaState||baseVersion.value!==version||baseRevision.value!==revision)return
    if(typeof value.text!=='string'||!value.text||!/^([a-f0-9]{64})$/.test(value.sha256)||value.source?.kind!=='dsh-system-prompt'||typeof value.source.runtimeVersion!=='string')throw new Error('DSH 原版提示词读取结果无效')
    text.value=value.text;metadata.value={...metadata.value,developerSource:'dsh-original',developerSourceSha256:value.sha256,developerSourceVersion:value.source.runtimeVersion};preview.value=undefined;if(automatic){baseline.value=text.value;metadataBaseline.value=metadataState();const entry=current.value!;const p=targetContext.value&&!entry.characterId?{...entry,draft:entry.content,draftLabel:entry.label,draftMetadata:entry.metadata}:entry;automaticOriginal={fingerprint:originalFingerprint(p),role,scopeRole}}closeOriginal()
  }catch(e){if(operationAlive(epoch)&&generation===originalEpoch&&(automatic||originalOpen.value)&&selected.value===key)originalError.value=typeof (e as {message?:unknown})?.message==='string'?(e as Error).message:'读取失败，请重试'}finally{busy.value=false;if(automatic&&operationAlive(epoch)&&current.value&&(baseVersion.value!==version||baseRevision.value!==revision||originalScopeRole(current.value)!==role))void nextTick(loadOriginalIfEmpty)}
}
function descriptor(p?:Prompt){return p?{scope:p.scope,name:p.name,...(p.characterId?{characterId:p.characterId}:{})}:{}}
async function save(publish=true){
  if(!current.value||busy.value||!operationAlive(lifecycleEpoch))return false
  if(inherited.value){emit('error',new Error('请先创建角色专用配置'));return false}
  const epoch=lifecycleEpoch,key=selected.value,target=descriptor(current.value),content=text.value,label=entryLabel.value,savedMetadata=JSON.parse(JSON.stringify(metadata.value)),savedMetaState=metadataState(),expectedVersion=baseVersion.value,expectedRevision=baseRevision.value
  busy.value=true;savingKey.value=key
  try{
    const saved=await request<Prompt>('/prompts/draft',{...target,content,label,metadata:savedMetadata,expectedVersion})
    if(!operationAlive(epoch))return false
    if(selected.value===key)baseVersion.value=saved.version
    if(publish){const published=await request<Prompt>('/prompts/publish',{...target,content,label,metadata:savedMetadata,expectedRevision,expectedVersion:saved.version});if(!operationAlive(epoch))return false;if(selected.value===key){baseVersion.value=published.version;baseRevision.value=published.revision}}
    if(selected.value===key){baseline.value=content;metadataBaseline.value=savedMetaState}
    emit('refresh');emit('notice',publish?'提示词已发布':'草稿已保存')
    return selected.value===key&&text.value===content&&metadataState()===savedMetaState
  }catch(e){if(operationAlive(epoch))emit('error',e);return false}finally{savingKey.value='';busy.value=false}
}
async function saveAndSelectPending(){const key=selected.value,epoch=pendingEpoch.value;if(await save(false)){if(selected.value===key&&pendingEpoch.value===epoch)finishPending()}}
async function showPreview(){const key=selected.value,role=characterId.value;try{const result=await request('/prompts/preview',{...descriptor(current.value),characterId:role,conversationId:props.state.conversations.find(c=>c.participantIds.includes(role))?.id,content:text.value,metadata:metadata.value});if(selected.value!==key||characterId.value!==role)return;preview.value=result;previewOpen.value=true}catch(e){if(selected.value===key&&characterId.value===role)emit('error',e)}}
function checkpointQuery(){return new URLSearchParams(descriptor(current.value) as Record<string,string>).toString()}
async function showHistory(){const key=selected.value;try{const [versions,snapshots]=await Promise.all([request<Prompt[]>('/prompts/history',descriptor(current.value)),request<PromptCheckpoint[]>(`/prompts/checkpoints?${checkpointQuery()}`)]);if(selected.value!==key)return;history.value=versions;checkpoints.value=snapshots;checkpointDetail.value=undefined;historyOpen.value=true}catch(e){emit('error',e)}}
async function restore(revision:number){if(!current.value||busy.value||inherited.value)return;const key=selected.value,target=descriptor(current.value),before=text.value,metaBefore=metadataState();busy.value=true;try{const result=await request<Prompt>('/prompts/rollback',{...target,revision,expectedRevision:baseRevision.value});if(selected.value===key&&text.value===before&&metadataState()===metaBefore)loadEntry(result);historyOpen.value=false;emit('refresh');emit('notice','已恢复为新的当前版本')}catch(e){emit('error',e)}finally{busy.value=false}}
async function openCheckpoint(){if(!current.value)return;const key=selected.value,target={...descriptor(current.value),entryLabel:entryLabel.value,content:text.value,metadata:JSON.parse(JSON.stringify(metadata.value))};try{const snapshots=await request<PromptCheckpoint[]>(`/prompts/checkpoints?${checkpointQuery()}`);if(selected.value!==key)return;checkpoints.value=snapshots;checkpointTarget.value=target;checkpointName.value=`#${checkpoints.value.length+1}`;checkpointOpen.value=true}catch(e){emit('error',e)}}
async function saveCheckpoint(){if(!checkpointTarget.value||busy.value)return;busy.value=true;try{await request('/prompts/checkpoints',{...checkpointTarget.value,label:checkpointName.value.trim()||undefined});checkpointOpen.value=false;emit('notice','Checkpoint 已创建')}catch(e){emit('error',e)}finally{busy.value=false}}
async function readCheckpoint(id:string){try{checkpointDetail.value=await request(`/prompts/checkpoints/${encodeURIComponent(id)}`)}catch(e){emit('error',e)}}
async function copyCheckpoint(){if(!checkpointDetail.value)return;try{await navigator.clipboard.writeText(checkpointDetail.value.content);emit('notice','已复制 Checkpoint 内容')}catch(e){emit('error',e)}}
async function deleteCheckpoint(){if(!checkpointDelete.value||busy.value)return;const id=checkpointDelete.value.id;busy.value=true;try{await request(`/prompts/checkpoints/${encodeURIComponent(id)}`,undefined,'DELETE');checkpoints.value=checkpoints.value.filter(p=>p.id!==id);if(checkpointDetail.value?.id===id)checkpointDetail.value=undefined;checkpointDelete.value=undefined;emit('notice','Checkpoint 已删除')}catch(e){emit('error',e)}finally{busy.value=false}}
function scopedEnvelope(envelope:any,importing=false){
  if(!envelope||!Array.isArray(envelope.prompts))throw new Error('提示词配置格式无效')
  const belongs=(p:Prompt)=>props.globalOnly?!p.characterId:props.characterOnly?Boolean(targetContext.value)&&p.characterId===targetContext.value?.characterId:true
  if(importing&&envelope.prompts.some((p:Prompt)=>!belongs(p)))throw new Error(props.globalOnly?'系统设置仅支持共有提示词配置':'只能导入当前角色的专用提示词配置')
  return {...envelope,prompts:envelope.prompts.filter(belongs)}
}
async function exportConfig(){try{download('沙之书-提示词.json',scopedEnvelope(await request('/prompts/export')))}catch(e){emit('error',e)}}
async function importConfig(e:Event){const input=e.target as HTMLInputElement,file=input.files?.[0];if(!file)return;try{importEnvelope.value=scopedEnvelope(JSON.parse(await file.text()),true);importPreview.value=await request('/prompts/import',{envelope:importEnvelope.value,preview:true});importOpen.value=true}catch(e){emit('error',e)}finally{input.value=''}}
async function confirmImport(){busy.value=true;try{await request('/prompts/import',{envelope:scopedEnvelope(importEnvelope.value,true),expectedVersion:importPreview.value.revision});importOpen.value=false;emit('refresh');emit('notice','配置已导入')}catch(e){emit('error',e)}finally{busy.value=false}}
async function createOverride(){if(props.globalOnly||!current.value||busy.value||!operationAlive(lifecycleEpoch))return;if(props.characterOnly&&(!targetContext.value||overrideCharacter.value!==targetContext.value.characterId))return;const epoch=lifecycleEpoch,sourceKey=selected.value,role=overrideCharacter.value,contextRole=targetContext.value?.characterId,existing=props.state.prompts.find(p=>p.characterId===role&&p.scope===current.value!.scope&&p.name===current.value!.name);if(existing){overrideOpen.value=false;select(existing.key);return}const content=text.value,metaState=metadataState();busy.value=true;try{const p=await request<Prompt>('/prompts/publish',{scope:current.value.scope,name:current.value.name,characterId:role,content,label:entryLabel.value,metadata:JSON.parse(JSON.stringify(metadata.value)),expectedRevision:0});if(!operationAlive(epoch))return;if(selected.value===sourceKey&&text.value===content&&metadataState()===metaState&&targetContext.value?.characterId===contextRole){createdEntry.value=p;selected.value=p.key;loadEntry(p)}overrideOpen.value=false;emit('refresh');emit('notice','已创建角色专用提示词')}catch(e){if(operationAlive(epoch))emit('error',e)}finally{busy.value=false}}
async function insert(variable:string){if(inherited.value)return;if(current.value?.scope==='worker'){await workerEditor.value?.insertVariable(variable,xml.value);return}const el=editor.value;if(!el)return;const result=insertPromptVariable(text.value,el.selectionStart,el.selectionEnd,variable,xml.value);text.value=result.text;input();await nextTick();el.focus();el.setSelectionRange(result.cursor,result.cursor)}
function variableTitle(name:string){return (variableMetadata as Record<string,{description:string}>)[name]?.description??name}
function key(e:KeyboardEvent){if(props.active&&(e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();void save()}}
function beforeLeave(e:BeforeUnloadEvent){if(dirty.value){e.preventDefault();e.returnValue=''}}
window.addEventListener('keydown',key);window.addEventListener('beforeunload',beforeLeave);onBeforeUnmount(()=>{disposed=true;lifecycleEpoch++;document.removeEventListener('visibilitychange',visibilityChanged);pendingLeave?.(false);window.removeEventListener('keydown',key);window.removeEventListener('beforeunload',beforeLeave)})
const variables=VARIABLE_NAMES
</script>

<template>
<section class="page-view prompt-page business-page">
  <header class="page-header"><div><h1>{{title}}</h1></div><div class="button-row"><TooltipButton label="导入提示词配置" icon="upload" @click="importFile?.click()"/><TooltipButton label="导出提示词配置" icon="download" @click="exportConfig"/></div><input ref="importFile" hidden aria-hidden="true" tabindex="-1" type="file" accept=".json" @change="importConfig"/></header>
  <div class="prompt-workspace">
    <ResizableSidebar class="prompts-sidebar-frame" name="提示词列表" storage-key="prompts" :width="220" :min="156" :max="360"><aside class="prompt-library"><div class="segmented"><button v-for="s in [{id:'runtime',name:'主对话'},{id:'worker',name:'Workers'},{id:'tool',name:'工具'}]" :key="s.id" :aria-pressed="scope===s.id" @click="changeScope(s.id)"><Icon :name="s.id==='tool'?'tool':s.id==='worker'?'worker':'chat'" :size="14"/>{{s.name}}</button></div><div class="search-field"><Icon name="search" :size="16"/><input v-model="search" placeholder="查找提示词" aria-label="查找提示词"/></div><div class="prompt-list"><button v-for="p in entries" :key="p.key" :class="{selected:selected===p.key}" @click="select(p.key)"><Icon :name="p.scope==='tool'?'tool:'+p.name:p.scope==='worker'?'worker:'+p.name:p.name==='a2a'?'people':'chat'" :size="18"/><span class="prompt-entry-text"><strong>{{p.draftLabel??p.label??p.name}}<small v-if="p.characterId" class="prompt-owner">{{state.characters.find(c=>c.id===p.characterId)?.name}}</small></strong><span>{{p.name}}</span></span></button><p v-if="!entries.length" class="prompt-list-empty">{{search.trim()?'没有匹配的提示词':'暂无提示词'}}</p></div></aside></ResizableSidebar>
    <div class="prompt-main">
      <div class="editor-toolbar"><div><strong>{{entryLabel||current?.name||'选择一条提示词'}}</strong><span v-if="current?.scope==='tool'" class="quiet-chip">{{state.capabilities?.tools.includes(current.name)?'已接入':'仅配置'}}</span><span v-if="current" class="muted">{{current.characterId?(state.characters.find(c=>c.id===current?.characterId)?.name+'专用'):'全局'}} · 版本 {{baseRevision}}{{dirty?' · 未保存':''}}</span></div><TooltipButton label="创建 Checkpoint" icon="plus" :size="18" :disabled="!current||busy" @click="openCheckpoint"/><TooltipButton v-if="!globalOnly" label="为角色单独配置" icon="people" :size="18" :disabled="!current||busy||schedulerEntry" @click="openOverride"/><TooltipButton label="历史版本" tooltip="历史版本与 Checkpoint" icon="history" :size="18" :disabled="!current" @click="showHistory"/></div>
      <p v-if="targetError" class="inline-error prompt-target-error" role="alert">{{targetError}}</p>
      <div v-if="targetContext" class="prompt-inheritance"><span>{{targetCharacterName}} · {{inherited?'继承全局配置':'角色专用配置'}}</span><div class="button-row"><button v-if="inherited" class="button" :disabled="busy" @click="createInheritedOverride"><Icon name="plus" :size="16"/>创建角色专用配置</button><button v-if="!characterOnly" class="text-button" @click="viewGlobal"><Icon name="globe" :size="16"/>查看全局配置</button></div></div>
      <pre v-if="inherited" class="prompt-scroll inherited-content" aria-label="继承的提示词正文">{{text}}</pre>
      <div v-else-if="current" class="prompt-scroll">
        <details class="prompt-details"><summary>{{schedulerEntry?'基础信息':'基础信息与模型'}}<Icon class="disclosure-arrow" name="down" :size="14"/></summary><div class="prompt-detail-fields"><div class="form-grid two"><label class="field">名称<input v-model="entryLabel" maxlength="120"/></label><label v-if="current.scope==='tool'" class="field">返回模式<CustomSelect v-model="metadata.mode" aria-label="返回模式" :options="[{value:'sync',label:'同步'},{value:'async',label:'异步'}]"/></label><label v-if="current.scope==='tool'" class="field">Terminate<CustomSelect v-model="metadata.terminate" aria-label="Terminate" :options="[{value:false,label:'继续处理'},{value:true,label:'结束本次回执'},{value:'dynamic',label:'Worker 决定'}]"/></label></div><label class="field">作用<textarea v-model="metadata.description" rows="2"/></label><div v-if="current.scope!=='runtime'&&!schedulerEntry" class="form-grid two"><label class="field">输入<textarea v-model="metadata.input" rows="3"/></label><label class="field">输出<textarea v-model="metadata.output" rows="3"/></label></div><div v-if="current.scope==='worker'&&!schedulerEntry" class="form-grid two"><label class="field">触发<textarea v-model="metadata.trigger" rows="2"/></label><label class="field">写入目标<textarea v-model="metadata.writeTarget" rows="2"/></label></div><div v-if="!schedulerEntry&&(current.scope==='worker'||(current.scope==='runtime'&&current.name==='system'))" class="form-grid two"><label class="field">Provider<input v-model="metadata.provider" placeholder="继承角色或默认服务" autocomplete="off"/></label><label class="field">模型<input v-model="metadata.model" placeholder="继承角色或默认模型" autocomplete="off"/></label></div></div></details>
        <label v-if="schedulerEntry" class="toggle-label"><span>启用</span><ToggleSwitch :model-value="metadata.enabled!==false" aria-label="启用群聊调度提示词" @update:model-value="metadata.enabled=$event"/></label>
        <PromptWorkerEditor v-if="current.scope==='worker'" :key="current.key" :guidance-only="schedulerEntry" ref="workerEditor" v-model="text" v-model:xml="xml" @update:model-value="input"/>
        <template v-else><div class="plain-options" :class="{'prompt-original-options':current.scope==='runtime'&&current.name==='dev'}"><label v-if="current.scope==='runtime'&&['dev','a2a'].includes(current.name)" class="toggle-label"><span>{{current.name==='a2a'?'A2A 提示词':'Developer'}}</span><ToggleSwitch :model-value="metadata.enabled===true" :aria-label="current.name==='a2a'?'启用 A2A 提示词':'启用开发提示词'" @update:model-value="metadata.enabled=$event"/></label><button v-if="current.scope==='runtime'&&current.name==='dev'" class="button" :disabled="busy||!state.characters.length||!state.settings.developerMode" :title="state.settings.developerMode?undefined:'请先打开开发者模式'" @click="openOriginal">读取 DSH 原版</button><span v-if="current.scope==='runtime'&&current.name==='dev'&&metadata.developerSource==='dsh-original'" class="muted" :title="String(metadata.developerSourceSha256??'')">DSH {{metadata.developerSourceVersion}} · {{String(metadata.developerSourceSha256??'').slice(0,12)}}<template v-if="originalRole"> · {{state.characters.find(p=>p.id===originalRole)?.name??originalRole}}</template></span><CheckboxControl v-model="xml">XML 包装</CheckboxControl></div><span v-if="current.scope==='runtime'&&current.name==='dev'&&busy" class="muted" role="status">读取 DSH 原版中…</span><p v-if="current.scope==='runtime'&&current.name==='dev'&&originalError&&!originalOpen" class="inline-error" role="alert">{{originalError}} <button class="text-button" :disabled="busy" @click="loadOriginalIfEmpty">重试</button></p><textarea ref="editor" v-model="text" class="prompt-text" spellcheck="false" aria-label="提示词正文" @input="input"/></template>
      </div>
      <div v-else class="prompt-empty">选择一条提示词</div>
      <div v-if="!inherited&&!schedulerEntry" class="variable-strip"><span>插入变量</span><TooltipButton v-for="v in variables" :key="v" :label="v" :tooltip="variableTitle(v)" @click="insert(v)">{{v}}</TooltipButton></div>
      <footer class="editor-footer"><button class="button" :disabled="!current" @click="showPreview"><Icon name="eye" :size="16"/>预览</button><span class="spacer"/><button class="text-button" :disabled="busy||!dirty||inherited" @click="save(false)"><Icon name="save" :size="16"/>存为草稿</button><button class="button primary" :disabled="busy||!current||inherited" @click="save()"><Icon name="save" :size="16"/>{{busy?'保存中…':'保存并生效'}}</button></footer>
    </div>
  </div>
  <Modal :open="originalOpen" title="读取 DSH 原版" @close="closeOriginal"><label class="field">角色<CustomSelect v-model="originalRole" aria-label="DSH 原版提示词角色" :disabled="busy||Boolean(current?.characterId)" :options="state.characters.map(p=>({value:p.id,label:p.name}))"/></label><p v-if="dirty">读取结果将替换当前未保存的草稿。</p><p v-if="originalError" class="inline-error" role="alert">{{originalError}}</p><footer class="form-footer"><button class="button" :disabled="busy" @click="closeOriginal">取消</button><button class="button primary" :disabled="busy||!originalRole" @click="readOriginal(false)">{{busy?'读取中…':dirty?'替换当前草稿':'读取原版'}}</button></footer></Modal>
  <Modal :open="previewOpen" title="上下文预览" @close="previewOpen=false"><label v-if="!globalOnly&&!characterOnly" class="field">预览角色<CustomSelect v-model="characterId" aria-label="预览角色" :options="state.characters.map(p=>({value:p.id,label:p.name}))" @change="showPreview"/></label><div v-if="preview?.validation?.errors?.length" class="inline-error">{{preview.validation.errors.join('\n')}}</div><pre class="preview-code">{{preview?.text??preview?.content}}</pre></Modal>
  <Modal :open="historyOpen" title="历史版本" @close="historyOpen=false"><div class="segmented history-tabs"><button :aria-pressed="historyTab==='versions'" @click="historyTab='versions'">发布版本</button><button :aria-pressed="historyTab==='checkpoints'" @click="historyTab='checkpoints'">Checkpoints</button></div><div v-if="historyTab==='versions'" class="history-list"><details v-for="h in history" :key="h.revision" class="version-detail"><summary>版本 {{h.revision}} · {{h.publishedAt??h.updatedAt??h.createdAt}}<Icon class="disclosure-arrow" name="down" :size="14"/></summary><pre class="preview-code">{{h.content}}</pre><button class="button" :disabled="busy||inherited" @click="restore(h.revision)"><Icon name="reset" :size="16"/>恢复此版本</button></details><p v-if="!history.length" class="muted">暂无发布版本</p></div><template v-else><div class="history-list"><div v-for="item in checkpoints" :key="item.id"><button class="text-button checkpoint-title" @click="readCheckpoint(item.id)"><strong>{{item.label}}</strong><span>{{item.createdAt}}</span></button><button class="text-button" :disabled="busy" @click="checkpointDelete=item"><Icon name="delete" :size="16"/>删除</button></div><p v-if="!checkpoints.length" class="muted">暂无 Checkpoint</p></div><div v-if="checkpointDetail" class="checkpoint-detail"><div class="section-heading"><h3>{{checkpointDetail.label}}</h3><button class="button" @click="copyCheckpoint"><Icon name="copy" :size="16"/>复制内容</button></div><pre class="preview-code">{{checkpointDetail.content}}</pre><details v-if="checkpointDetail.metadata"><summary>配置<Icon class="disclosure-arrow" name="down" :size="14"/></summary><pre class="preview-code">{{JSON.stringify(checkpointDetail.metadata,null,2)}}</pre></details></div></template></Modal>
  <Modal :open="checkpointOpen" title="创建 Checkpoint" @close="checkpointOpen=false"><form @submit.prevent="saveCheckpoint"><label class="field">名称<input v-model="checkpointName" maxlength="120" autofocus/></label><footer class="form-footer"><button class="button primary" :disabled="busy"><Icon name="save" :size="16"/>保存当前条目</button></footer></form></Modal>
  <Modal :open="Boolean(checkpointDelete)" title="删除 Checkpoint？" @close="checkpointDelete=undefined"><p>{{checkpointDelete?.label}}</p><footer class="form-footer"><button class="button" @click="checkpointDelete=undefined">取消</button><button class="button primary" :disabled="busy" @click="deleteCheckpoint"><Icon name="delete" :size="16"/>确认删除</button></footer></Modal>
  <Modal :open="discardOpen" title="保留这次编辑？" @close="cancelPending"><p>当前内容还没有保存。可以先存为草稿，或放弃本次修改。</p><div class="form-footer"><button class="button" @click="finishPending">放弃修改</button><button class="button primary" :disabled="busy" @click="saveAndSelectPending"><Icon name="save" :size="16"/>保存草稿</button></div></Modal>
  <Modal :open="!globalOnly&&overrideOpen" title="为角色单独配置" @close="overrideOpen=false"><label class="field">角色<CustomSelect v-model="overrideCharacter" aria-label="角色" :options="state.characters.filter(person=>!targetContext||person.id===targetContext.characterId).map(person=>({value:person.id,label:person.name}))"/></label><footer class="form-footer"><button class="button primary" :disabled="busy" @click="createOverride"><Icon name="person" :size="16"/>打开专用配置</button></footer></Modal>
  <Modal :open="importOpen" title="导入提示词配置" @close="importOpen=false"><div class="import-changes"><div v-for="change in importPreview?.changes" :key="change.key"><span>{{change.label??change.name}}</span><small>{{({add:'新增',replace:'更新',unchanged:'不变'} as Record<string,string>)[change.change]}}<span v-if="change.overwritesDraft&&change.change!=='unchanged'"> · 含未发布草稿</span></small></div></div><footer class="form-footer"><button class="button" @click="importOpen=false">取消</button><button class="button primary" :disabled="busy" @click="confirmImport"><Icon name="upload" :size="16"/>确认导入</button></footer></Modal>
</section>
</template>
<style src="../business-components.css"></style>

<style scoped>
.prompt-original-options{flex-wrap:wrap;gap:8px 16px}.prompt-original-options .muted{overflow-wrap:anywhere}
</style>
