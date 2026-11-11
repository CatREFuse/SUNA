<script setup lang="ts">
import ResizableSidebar from '../components/ResizableSidebar.vue'
import {ref,watch,computed,onBeforeUnmount} from 'vue'
import type {Snapshot,Character,Personality,SettingsTarget,PromptTarget,PermissionTarget,RoleSettingsTarget} from '../types'
import {request,upload} from '../api'
import Icon from '../components/Icon.vue'
import TooltipButton from '../components/TooltipButton.vue'
import CharacterAvatar from '../components/CharacterAvatar.vue'
import Modal from '../components/Modal.vue'
import CharacterResources from '../components/CharacterResources.vue'
import PersonProfiles from '../components/PersonProfiles.vue'
import ToggleSwitch from '../components/ToggleSwitch.vue'
import CustomSelect from '../components/CustomSelect.vue'
import PromptsView from './PromptsView.vue'
import PermissionSettings from '../components/PermissionSettings.vue'
const props=withDefaults(defineProps<{state:Snapshot;active?:boolean}>(),{active:true}),emit=defineEmits<{refresh:[];error:[unknown];notice:[string];chat:[characterId:string]}>()
type PageAction={type:'select'|'edit'|'view'|'create'|'chat'|'pet'|'list'|'permissions';id?:string;permissionTarget?:PermissionTarget}
const discardOpen=ref(false),pendingAction=ref<PageAction>(),original=ref(''),loadedId=ref(''),savingId=ref(''),mobileDetail=ref(false),query=ref('')
function emptyPersonality():Personality{return {immutable:{backgrounds:'',temper:''},mutable:{trait:'',habit:'',dialogue:''}}}
const selected=ref(props.state.characters[0]?.id??''),name=ref(''),personality=ref<Personality>(emptyPersonality()),provider=ref(''),model=ref(''),pet=ref<Character['pet']>(),version=ref(0),newOpen=ref(false),newName=ref(''),newPersona=ref(''),busy=ref(false),file=ref<HTMLInputElement>()
const personalityInputs=[{id:'backgrounds',group:'immutable',label:'背景故事'},{id:'temper',group:'immutable',label:'气质'},{id:'trait',group:'mutable',label:'特质'},{id:'habit',group:'mutable',label:'习惯'},{id:'dialogue',group:'mutable',label:'对话样例'}] as const
const personalitySlot=ref<typeof personalityInputs[number]['id']>('backgrounds')
function onPersonalityTabKey(event:KeyboardEvent){
  if(event.isComposing||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
  const tabs=(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
  if(!tabs?.length)return
  event.preventDefault()
  const current=Math.max(0,Array.from(tabs).indexOf(event.currentTarget as HTMLButtonElement))
  const index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length
  tabs[index]?.focus();tabs[index]?.scrollIntoView({block:'nearest',inline:'nearest'})
}
function personalityDraft(field:typeof personalityInputs[number]){return field.group==='immutable'?personality.value.immutable[field.id]:personality.value.mutable[field.id]}
function updatePersonalityDraft(field:typeof personalityInputs[number],value:string){if(field.group==='immutable')personality.value.immutable[field.id]=value;else personality.value.mutable[field.id]=value}
const detailContent=ref<HTMLElement>()
watch(selected,()=>{rolePromptScope.value=undefined;personalitySlot.value='backgrounds';detailContent.value?.scrollTo({top:0})},{flush:'post'})
const detailTab=ref('identity'),toneEnabled=ref(true),diaryEnabled=ref(true),dreamCron=ref('')
const dreamTimeDraft=ref<string>(),dreamCustomMode=ref(false),dreamScheduleError=ref('')
function dailyDreamTime(cron:string){const match=/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/u.exec(cron.trim());if(!match||Number(match[1])>59||Number(match[2])>23)return undefined;return `${match[2]!.padStart(2,'0')}:${match[1]!.padStart(2,'0')}`}
function dailyDreamCron(time:string){if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time))return undefined;const [hour,minute]=time.split(':');return `${Number(minute)} ${Number(hour)} * * *`}
const dreamScheduleMode=computed({get:()=>dreamCustomMode.value?'custom':dreamTimeDraft.value!==undefined?'daily':!dreamCron.value.trim()?'off':dailyDreamTime(dreamCron.value)?'daily':'custom',set:(mode:string)=>{if(busy.value)return;dreamScheduleError.value='';dreamTimeDraft.value=undefined;dreamCustomMode.value=mode==='custom';if(mode==='off')dreamCron.value='';else if(mode==='daily')dreamCron.value=dailyDreamCron(dailyDreamTime(dreamCron.value)??'04:00')!}})
const dreamTime=computed({get:()=>dreamTimeDraft.value??dailyDreamTime(dreamCron.value)??'04:00',set:(time:string)=>{if(busy.value)return;dreamScheduleError.value='';dreamTimeDraft.value=time;const cron=dailyDreamCron(time);if(cron)dreamCron.value=cron}})
const dreamTimeZone=computed(()=>selectedPerson.value?.backgroundEffective?.timeZone??props.state.settings?.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone)
const dreamAutoDisabled=computed(()=>dreamScheduleMode.value!=='off'&&(props.state.settings?.background?.enabled===false||backgroundBase.value.enabled===false||selectedPerson.value?.backgroundEffective?.enabled===false))
function dreamCronValue(){return dreamTimeDraft.value!==undefined&&!dailyDreamCron(dreamTimeDraft.value)?dreamTimeDraft.value:dreamCron.value.trim()}
const groupWakeWordsText=ref(''),replyToTrigger=ref(true),groupReplyDraftSupported=ref(false),groupReplyError=ref('')
const supportsGroupReply=computed(()=>props.state.capabilities?.channelGroupSchedulerV2===true)
const backgroundBase=ref<Record<string,unknown>>({})
watch(detailTab,()=>{detailContent.value?.scrollTo({top:0})},{flush:'post'})
const resourceKinds=['memories','dreams','emojis','knowledge'] as const
const resourceKind=computed(()=>resourceKinds.find(kind=>kind===detailTab.value)??'memories')
const allDetailPages=[{id:'identity',label:'身份与人格',group:'身份与回复'},{id:'reply',label:'行为设置',group:'身份与回复'},{id:'background',label:'记忆处理',group:'记忆与梦境'},{id:'memories',label:'记忆',group:'记忆与梦境'},{id:'dreams',label:'梦境',group:'记忆与梦境'},{id:'profiles',label:'人物画像',group:'记忆与梦境'},{id:'emojis',label:'表情包',group:'能力与资料'},{id:'knowledge',label:'知识库',group:'能力与资料'},{id:'prompts',label:'提示词',group:'能力与资料'},{id:'tools',label:'工具',group:'能力与资料'},{id:'permissions',label:'权限管理',group:'能力与资料'},{id:'appearance',label:'桌面形象',group:'能力与资料'}]
const supportsPersonProfiles=computed(()=>props.state.capabilities?.personProfiles===true)
const detailPages=computed(()=>allDetailPages.filter(page=>page.id!=='profiles'||supportsPersonProfiles.value))
watch(supportsPersonProfiles,supported=>{if(!supported&&detailTab.value==='profiles')detailTab.value='identity'},{flush:'sync'})
const rolePromptScope=ref<PromptTarget['scope']>(),rolePromptRequest=ref(0),rolePromptEditor=ref<InstanceType<typeof PromptsView>>()
const rolePermissionEditor=ref<InstanceType<typeof PermissionSettings>>(),rolePermissionTarget=ref<PermissionTarget>()
let promptTransitionPending=false
async function confirmEditorsLeave(){if(rolePermissionEditor.value&&!await rolePermissionEditor.value.confirmLeave()){emit('notice','请先处理未保存的权限修改');return false}return rolePromptEditor.value?rolePromptEditor.value.confirmLeave():true}
async function openPermissionTarget(target:RoleSettingsTarget,isCurrent:()=>boolean=()=>true){if(target.tab!=='permissions'||!props.state.characters.some(person=>person.id===target.characterId)){emit('error',new Error('角色不存在'));return false}if(promptTransitionPending||busy.value)return false;promptTransitionPending=true;let allowed=false;try{allowed=await confirmEditorsLeave()}finally{promptTransitionPending=false}if(!allowed||!isCurrent())return false;transition({type:'permissions',id:target.characterId,permissionTarget:{characterId:target.characterId,tool:target.tool,accountId:target.accountId,conversationId:target.conversationId,requestId:target.requestId}},false,true);return true}

async function selectDetailTab(id:string){if(id===detailTab.value||!detailPages.value.some(page=>page.id===id))return;if(!await confirmEditorsLeave()||!detailPages.value.some(page=>page.id===id))return;detailTab.value=id}
const rolePromptTarget=computed<PromptTarget>(()=>({characterId:selected.value,scope:rolePromptScope.value,requestId:rolePromptRequest.value}))
async function openRoleSettings(tab:SettingsTarget['tab']='prompts',scope?:SettingsTarget['scope'],permissionTool?:string){if(tab==='permissions'||tab==='screen'){openPermissionTarget({characterId:selected.value,tab:'permissions',tool:permissionTool??(tab==='screen'?'screenshot':undefined),requestId:Date.now()});return}if(tab==='prompts'){rolePromptScope.value=scope;rolePromptRequest.value++;detailTab.value='prompts';return}try{const options:SettingsTarget={tab,characterId:selected.value,...(scope?{scope}:{}),...(permissionTool?{permissionTool}:{})};if(window.sandbook)await window.sandbook.openSettings(options);else{const target=new URL(window.location.href);target.search='';target.hash='';target.searchParams.set('window','settings');for(const [key,value] of Object.entries(options))target.searchParams.set(key,String(value));window.open(target.href,'suna-settings')}}catch(error){emit('error',error)}}
const selectedPerson=computed(()=>props.state.characters.find(person=>person.id===selected.value))
const filteredPeople=computed(()=>{const search=query.value.trim().toLocaleLowerCase();return props.state.characters.filter(person=>!search||person.name.toLocaleLowerCase().includes(search))})

function avatarPerson(person:Character){return person}
function hasToolPermissionEntry(tool:string){return !['send_message','no_reply','add_user_profile'].includes(tool)}
function emotionText(person:Character){const emotion:unknown=person.state?.emotion;return typeof emotion==='string'?emotion:emotion&&typeof emotion==='object'&&'desc' in emotion&&typeof emotion.desc==='string'?emotion.desc:''}
const stateFields=computed(()=>{const person=selectedPerson.value;if(!person)return [];return [{label:'情绪',value:emotionText(person)},{label:'环境',value:person.state?.environment}].filter((field):field is {label:string;value:string}=>typeof field.value==='string'&&Boolean(field.value.trim()))})
function formValue(){return {name:name.value,persona:personality.value.immutable.backgrounds,personality:personality.value,provider:provider.value.trim(),model:model.value.trim(),pet:pet.value,toneEnabled:toneEnabled.value,...(groupReplyDraftSupported.value?{groupWakeWords:groupWakeWordsText.value,replyToTrigger:replyToTrigger.value}:{}),background:{...backgroundBase.value,diaryEnabled:diaryEnabled.value,dreamCron:dreamCronValue()}}}
const dirty=computed(()=>Boolean(loadedId.value)&&JSON.stringify(formValue())!==original.value)
function loadCharacter(c:Character){name.value=c.name;const source=c.personality;personality.value={immutable:{backgrounds:source?.immutable?.backgrounds??(typeof c.persona==='string'?c.persona:''),temper:source?.immutable?.temper??''},mutable:{trait:source?.mutable?.trait??'',habit:source?.mutable?.habit??'',dialogue:source?.mutable?.dialogue??''}};provider.value=c.provider??'';model.value=c.model??'';pet.value=c.pet?JSON.parse(JSON.stringify(c.pet)):undefined;toneEnabled.value=c.toneEnabled??props.state.settings?.toneEnabled!==false;groupWakeWordsText.value=(c.groupWakeWords??[]).join('，');replyToTrigger.value=c.replyToTrigger!==false;groupReplyDraftSupported.value=supportsGroupReply.value;groupReplyError.value='';backgroundBase.value=JSON.parse(JSON.stringify(c.background??{}));diaryEnabled.value=c.background?.diaryEnabled??props.state.settings?.background?.diaryEnabled!==false;dreamTimeDraft.value=undefined;dreamCustomMode.value=false;dreamScheduleError.value='';dreamCron.value=c.backgroundEffective?.dreamCron??c.background?.dreamCron??props.state.settings?.background?.dreamCron??'0 4 * * *';version.value=c.version;original.value=JSON.stringify(formValue());loadedId.value=c.id}
watch(()=>[selected.value,props.state.characters] as const,()=>{if(!selected.value&&props.state.characters.length)selected.value=props.state.characters[0]!.id;const c=props.state.characters.find(p=>p.id===selected.value);if(c&&(loadedId.value!==c.id||(!dirty.value&&savingId.value!==c.id)))loadCharacter(c)},{immediate:true})
function applyAction(action:PageAction){if(action.type==='permissions'){if(action.id)selected.value=action.id;rolePermissionTarget.value=action.permissionTarget;detailTab.value='permissions';mobileDetail.value=true;return}if(action.type==='create'){newOpen.value=true;return}if(action.type==='chat'){if(action.id)emit('chat',action.id);return}if(action.type==='pet'){if(action.id)void launchPet(action.id);return}if(action.id)selected.value=action.id;mobileDetail.value=action.type!=='list'}
function transition(action:PageAction,force=false,promptConfirmed=false){if(busy.value||promptTransitionPending)return;if(!promptConfirmed&&(rolePromptEditor.value||rolePermissionEditor.value)){promptTransitionPending=true;void confirmEditorsLeave().then(allowed=>{promptTransitionPending=false;if(allowed)transition(action,force,true)},error=>{promptTransitionPending=false;emit('error',error)});return}if(dirty.value&&!force){pendingAction.value=action;discardOpen.value=true;return}applyAction(action)}
function selectPerson(id:string,force=false){transition(id==='__new__'?{type:'create'}:{type:'select',id},force)}
function editPerson(id:string){transition({type:'edit',id})}
function viewPerson(){transition({type:'view',id:selected.value})}
function startChat(){transition({type:'chat',id:selected.value})}
function discardAndContinue(){const action=pendingAction.value;if(busy.value||!action)return;const person=selectedPerson.value;if(person)loadCharacter(person);discardOpen.value=false;pendingAction.value=undefined;applyAction(action)}
function beforeLeave(e:BeforeUnloadEvent){if(dirty.value){e.preventDefault();e.returnValue=''}}
window.addEventListener('beforeunload',beforeLeave);onBeforeUnmount(()=>{window.removeEventListener('beforeunload',beforeLeave)})
function validateFrameDraft(){if(pet.value?.type!=='frames')return true;for(const [key,label,max] of [['columns','列数',64],['rows','行数',64],['fps','每秒帧数',60]] as const){const value:unknown=pet.value[key];if(value===undefined||value===null||value==='')continue;if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>max){emit('error',new Error(`${label}必须是 1–${max} 之间的整数`));return false}}return true}
function validateNameDraft(){if(!name.value.trim()){emit('error',new Error('角色名字不能为空'));return false}if(name.value.length>40){emit('error',new Error('角色名字不能超过 40 个字符'));return false}return true}
function normalizedGroupWakeWords(){
  const text=groupWakeWordsText.value,seen=new Set<string>(),words:string[]=[]
  if(text.length>4096)throw new Error('群聊唤醒词输入不能超过 4096 个字符')
  if(/[\u0000-\u001f\u007f-\u009f]/u.test(text))throw new Error('群聊唤醒词不能包含控制字符')
  for(const part of text.split(/[,，]/u)){
    const word=part.trim();if(!word)continue
    if([...word].length>64)throw new Error('每个群聊唤醒词不能超过 64 个字符')
    const key=word.replace(/[A-Z]/g,char=>char.toLowerCase());if(seen.has(key))continue
    seen.add(key);words.push(word)
    if(words.length>32)throw new Error('群聊唤醒词最多设置 32 个')
  }
  return words
}
watch([groupWakeWordsText,replyToTrigger],()=>{groupReplyError.value=''},{flush:'sync'})
async function save(){
  if(busy.value||!validateNameDraft()||!validateFrameDraft())return false
  dreamScheduleError.value=''
  if(dreamScheduleMode.value==='daily'&&!dailyDreamCron(dreamTime.value)){dreamScheduleError.value='请输入 00:00–23:59 的时间';emit('error',new Error(dreamScheduleError.value));return false}
  let words:string[]|undefined
  groupReplyError.value=''
  if(groupReplyDraftSupported.value){
    try{if(!supportsGroupReply.value)throw new Error('当前后端不支持群聊回复设置，修改已保留，请更新后重试');words=normalizedGroupWakeWords()}
    catch(error){groupReplyError.value=error instanceof Error?error.message:'群聊回复设置无效';emit('error',error);return false}
  }
  const id=selected.value,draft=JSON.parse(JSON.stringify(formValue())),content={...draft,...(words?{groupWakeWords:words}:{})},savedDraft={...draft,...(words?{groupWakeWords:words.join('，')}:{})},baseline=JSON.stringify(savedDraft),expectedVersion=version.value,previous=JSON.parse(original.value)
  const dreamChanged=content.background.dreamCron!==previous.background.dreamCron
  // Leave inherited defaults inherited when another role field is saved.
  if(!dreamChanged&&!Object.hasOwn(backgroundBase.value,'dreamCron')){content.background={...content.background};delete content.background.dreamCron}
  // Behavior changes must not create a new persona revision.
  for(const key of ['name','persona','personality'])if(JSON.stringify(content[key])===JSON.stringify(previous[key]))delete content[key]
  busy.value=true;savingId.value=id
  try{
    const result=await request<Character>(`/characters/${id}`,{...content,expectedVersion},'PATCH')
    if(dreamChanged&&(!result||result.id!==id||!Number.isSafeInteger(result.version)||result.version<=expectedVersion||result.background?.dreamCron!==content.background.dreamCron))throw new Error('后端未确认梦境计划已保存，修改已保留，请重新读取配置后核对')
    if(words&&(!result||result.id!==id||!Number.isSafeInteger(result.version)||result.version<=expectedVersion||!Array.isArray(result.groupWakeWords)||result.groupWakeWords.length!==words.length||result.groupWakeWords.some((word,index)=>word!==words[index])||result.replyToTrigger!==content.replyToTrigger))throw new Error('后端未确认群聊回复设置已保存，修改已保留，请重新读取配置后核对')
    if(selected.value===id){if(words&&groupWakeWordsText.value===draft.groupWakeWords)groupWakeWordsText.value=words.join('，');version.value=result.version;original.value=baseline}
    emit('refresh');emit('notice','角色已保存');return selected.value===id&&JSON.stringify(formValue())===baseline
  }
  catch(error){if(groupReplyDraftSupported.value)groupReplyError.value=error instanceof Error?error.message:'角色保存失败，修改已保留';emit('error',error);return false}
  finally{busy.value=false;savingId.value=''}
}
async function saveInline(){if(busy.value||!dirty.value)return false;return await save()}
async function saveAndContinue(){const id=selected.value,action=pendingAction.value;if(action&&await save()){if(selected.value===id&&pendingAction.value===action){discardOpen.value=false;pendingAction.value=undefined;applyAction(action)}}}
async function create(){if(busy.value)return;busy.value=true;try{const result=await request('/characters',{name:newName.value,persona:newPersona.value,personality:{...emptyPersonality(),immutable:{backgrounds:newPersona.value,temper:''}}});emit('refresh');selected.value=result.id;mobileDetail.value=true;newOpen.value=false;newName.value='';newPersona.value='';emit('notice','角色已创建')}catch(e){emit('error',e)}finally{busy.value=false}}
async function importPet(e:Event){const input=e.target as HTMLInputElement,f=input.files?.[0];if(!f||busy.value)return;const id=selected.value;busy.value=true;try{const result=await upload('/assets/import',f);if(selected.value===id){pet.value=result;emit('notice','形象已导入，保存角色后生效')}}catch(e){emit('error',e)}finally{busy.value=false;input.value=''}}
function showPet(){transition({type:'pet',id:selected.value})}
async function launchPet(id:string){try{await window.sandbook?.togglePet(id);if(!window.sandbook)emit('notice','请在桌面应用中显示桌宠')}catch(e){emit('error',e)}}
defineExpose({selectPerson,editPerson,openPermissionTarget})
</script>
<template>
<section class="page-view contacts-page business-page" aria-label="角色通讯录">
  <div class="contacts-layout" :class="{'has-profile':mobileDetail}"><ResizableSidebar class="contacts-sidebar-frame" name="角色列表" storage-key="contacts" :width="240" :min="156" :max="360"><aside class="contacts-list" aria-label="角色列表"><header class="contacts-list-heading"><label class="contacts-search"><Icon name="search" :size="16"/><input v-model="query" type="search" placeholder="搜索" aria-label="搜索角色"/></label><TooltipButton label="新建角色" icon="plus" :disabled="busy" @click="selectPerson('__new__')"/></header><div class="contacts-rows"><button v-for="person in filteredPeople" :key="person.id" class="person-row" :class="{selected:person.id===selected}" :aria-pressed="person.id===selected" :disabled="busy" @click="selectPerson(person.id)"><CharacterAvatar :person="avatarPerson(person)"/><span class="person-row-copy"><strong>{{person.name}}</strong><small v-if="person.role==='administrator'">管理员</small></span><Icon name="chevron" :size="15"/></button><p v-if="!filteredPeople.length" class="contacts-empty">{{query.trim()?'没有匹配的角色':'还没有角色'}}</p></div></aside></ResizableSidebar>
    <article v-if="selectedPerson" class="contact-profile" aria-label="角色资料"><div class="agent-detail-workspace"><div class="agent-detail-navigation"><button class="text-button contacts-back" @click="transition({type:'list'})"><Icon name="back" :size="16"/>角色列表</button><div class="agent-detail-mobile"><CustomSelect :model-value="detailTab" @update:model-value="selectDetailTab" :options="detailPages.map(page=>({value:page.id,label:page.label}))" aria-label="角色功能"/></div><nav class="agent-detail-nav" aria-label="角色功能"><template v-for="(page,index) in detailPages" :key="page.id"><h3 v-if="index===0||detailPages[index-1]?.group!==page.group">{{page.group}}</h3><button type="button" :aria-current="detailTab===page.id?'page':undefined" :class="{selected:detailTab===page.id}" @click="selectDetailTab(page.id)"><Icon stateful :name="page.id==='prompts'?'pen':page.id==='permissions'?'shield':page.id==='profiles'?'people':page.id" :size="16"/>{{page.label}}</button></template></nav><button class="button role-chat-action" :disabled="busy" @click="startChat"><Icon name="chat" :size="16"/>发消息</button></div><div class="agent-detail-main"><div ref="detailContent" class="agent-detail-content"><section v-show="detailTab==='identity'" aria-label="身份与人格"><div class="personality-tabs" role="tablist" aria-label="人格槽位"><button v-for="field in personalityInputs" :id="`personality-tab-${selected}-${field.id}`" :key="field.id" type="button" role="tab" :aria-selected="personalitySlot===field.id" :aria-controls="`personality-panel-${selected}-${field.id}`" :tabindex="personalitySlot===field.id?0:-1" @click="personalitySlot=field.id" @keydown="onPersonalityTabKey">{{field.label}}</button></div><form class="inline-edit-form personality-edit-form" aria-label="身份与人格" @submit.prevent="saveInline"><div v-for="field in personalityInputs" v-show="personalitySlot===field.id" :id="`personality-panel-${selected}-${field.id}`" :key="field.id" class="edit-card personality-slot" role="tabpanel" :aria-labelledby="`personality-tab-${selected}-${field.id}`"><label v-if="field.id==='backgrounds'" class="field role-name-field">名字<input v-model="name" aria-label="角色名字" maxlength="40" :disabled="busy" required/></label><label class="field">{{field.label}}<textarea :value="personalityDraft(field)" :aria-label="field.label" rows="16" :disabled="busy" @input="updatePersonalityDraft(field,($event.target as HTMLTextAreaElement).value)"/></label></div></form><section v-if="stateFields.length" class="profile-state"><h3>当前状态</h3><dl class="profile-fields"><div v-for="field in stateFields" :key="field.label"><dt>{{field.label}}</dt><dd>{{field.value}}</dd></div></dl></section></section>

      <section v-if="detailTab==='reply'" class="agent-detail-section"><div class="section-heading"><h3>行为设置</h3></div><form class="inline-edit-form" aria-label="行为设置" @submit.prevent="saveInline"><div class="inline-settings-grid"><label class="field edit-card">Provider<input v-model="provider" placeholder="使用默认服务" autocomplete="off" :disabled="busy"/></label><label class="field edit-card">模型<input v-model="model" placeholder="使用默认模型" autocomplete="off" :disabled="busy"/></label><fieldset v-if="supportsGroupReply" class="role-group-settings"><legend class="role-group-title">群聊行为</legend><div class="role-group-behavior"><label class="role-behavior-row role-wake-words"><span>群聊唤醒词<small id="group-wake-words-hint">使用中文或英文逗号分隔，英文不区分大小写。留空则不增加额外唤醒词。</small></span><input v-model="groupWakeWordsText" aria-label="群聊唤醒词" aria-describedby="group-wake-words-hint" placeholder="例如：助手，Example" maxlength="4096" autocomplete="off" :disabled="busy"/></label><div class="role-behavior-row"><span>引用触发消息<small>每轮回复仅引用一次触发消息。</small></span><ToggleSwitch v-model="replyToTrigger" aria-label="引用触发消息" :disabled="busy"/></div></div></fieldset><p v-else class="detail-note role-behavior-unsupported" role="status">当前后端不支持群聊回复设置</p><label class="edit-card inline-setting-toggle"><span>语气处理</span><ToggleSwitch v-model="toneEnabled" aria-label="语气处理" :disabled="busy"/></label><div class="role-dream-schedule"><div class="role-behavior-row"><span>梦境计划</span><CustomSelect v-model="dreamScheduleMode" aria-label="梦境计划" :options="[{value:'daily',label:'每日'},{value:'custom',label:'自定义 Cron'},{value:'off',label:'关闭'}]" :disabled="busy"/></div><label v-if="dreamScheduleMode==='daily'" class="role-behavior-row role-dream-time"><span>执行时间<small>{{dreamTimeZone}}</small></span><input v-model="dreamTime" type="text" aria-label="梦境执行时间" placeholder="HH:mm" maxlength="5" autocomplete="off" spellcheck="false" :aria-invalid="Boolean(dreamScheduleError)||undefined" :disabled="busy"/></label><label v-else-if="dreamScheduleMode==='custom'" class="role-behavior-row role-dream-cron"><span>梦境周期（Cron）<small>{{dreamTimeZone}}</small></span><input v-model="dreamCron" type="text" aria-label="梦境周期（Cron）" maxlength="256" autocomplete="off" spellcheck="false" :disabled="busy"/></label></div></div><p v-if="dreamAutoDisabled" class="detail-note role-behavior-unsupported" role="status">后台任务已关闭，自动梦境不会执行</p><p v-if="dreamScheduleError" class="role-behavior-error" role="alert">{{dreamScheduleError}}</p><p v-if="groupReplyError" class="role-behavior-error" role="alert">{{groupReplyError}}</p></form></section>

      <section v-if="detailTab==='background'" class="agent-detail-section"><div class="section-heading"><h3>记忆处理</h3></div><form class="inline-edit-form" aria-label="记忆处理" @submit.prevent="saveInline"><div class="inline-settings-grid"><label class="edit-card inline-setting-toggle"><span>自动日记</span><ToggleSwitch v-model="diaryEnabled" aria-label="自动日记" :disabled="busy"/></label></div></form><div class="profile-actions"><button class="button" @click="detailTab='memories'"><Icon name="book" :size="16"/>查看记忆</button><button class="button" @click="detailTab='dreams'"><Icon name="moon" :size="16"/>查看梦境</button><button class="button" @click="openRoleSettings('prompts','worker')"><Icon name="pen" :size="16"/>编辑记忆处理提示词</button></div></section>
      <CharacterResources :character-id="selected" :kind="resourceKind" :active="active&&resourceKinds.some(kind=>kind===detailTab)" :dreams-supported="state.capabilities?.characterDreams===true" v-show="resourceKinds.some(kind=>kind===detailTab)" @notice="emit('notice',$event)"/>
      <PersonProfiles v-if="supportsPersonProfiles" v-show="detailTab==='profiles'" :character-id="selected" :characters="state.characters" :active="active&&detailTab==='profiles'" :scroll-container="detailContent"/>

      <PromptsView ref="rolePromptEditor" v-show="detailTab==='prompts'" class="role-prompts" :state="state" :active="active&&detailTab==='prompts'" :character-only="true" :prompt-target="rolePromptTarget" title="提示词" @refresh="emit('refresh')" @error="emit('error',$event)" @notice="emit('notice',$event)"/>
      <PermissionSettings ref="rolePermissionEditor" v-show="detailTab==='permissions'" :state="state" :character-id="selected" :active="active&&detailTab==='permissions'" :target="rolePermissionTarget" @refresh="emit('refresh')" @notice="emit('notice',$event)"/>
      <section v-if="detailTab==='tools'" class="agent-detail-section detail-card"><div class="section-heading"><h3>工具</h3><button class="button" @click="openRoleSettings('prompts','tool')"><Icon name="tool" :size="16"/>工具配置</button></div><ul class="agent-tool-list"><li v-for="tool in selectedPerson?.capabilities?.tools??state.capabilities?.tools??[]" :key="tool"><Icon :name="'tool:'+tool" :size="16"/><span>{{tool}}</span><button v-if="hasToolPermissionEntry(tool)" type="button" class="text-button" @click="openRoleSettings('permissions',undefined,tool)">权限</button></li></ul><p v-if="!(selectedPerson?.capabilities?.tools??state.capabilities?.tools)?.length" class="detail-note">暂无可用工具</p><button class="button" @click="openRoleSettings('permissions')"><Icon name="shield" :size="16"/>权限管理</button></section>
      <section v-if="detailTab==='appearance'" class="agent-detail-section"><div class="section-heading"><h3>桌面形象</h3><button type="button" class="button" :disabled="busy" @click="file?.click()"><Icon name="upload" :size="16"/>导入形象</button></div><input ref="file" hidden aria-hidden="true" tabindex="-1" type="file" accept=".vrm,.png,.webp,.gif,.zip" @change="importPet"/><div class="detail-card appearance-asset"><Icon name="pet" :size="28"/><div><strong>{{pet?.name??'未设置桌面形象'}}</strong><p class="detail-note">{{pet?({frames:'帧动画',live2d:'Live2D',vrm:'VRM'}[pet.type]):'支持 Live2D 模型包、VRM 和帧动画图片'}}</p></div><button v-if="pet" type="button" class="button" :disabled="busy" @click="showPet"><Icon name="pet" :size="16"/>显示桌宠</button></div><form v-if="pet?.type==='frames'" class="inline-edit-form" aria-label="帧动画" @submit.prevent="saveInline"><div class="inline-settings-grid"><label class="field edit-card">列数<input v-model.number="pet.columns" type="number" min="1" max="64" :disabled="busy"/></label><label class="field edit-card">行数<input v-model.number="pet.rows" type="number" min="1" max="64" :disabled="busy"/></label><label class="field edit-card">每秒帧数<input v-model.number="pet.fps" type="number" min="1" max="60" :disabled="busy"/></label></div></form></section>
    </div><footer v-if="dirty" class="role-save-actions" aria-label="保存角色修改"><span role="status">未保存</span><button type="button" class="button" :disabled="busy" @click="viewPerson">放弃修改</button><button type="button" class="button primary" :disabled="busy" @click="saveInline"><Icon name="save" :size="16"/>{{busy?'保存中…':'保存'}}</button></footer></div></div></article>
    <div v-if="!selectedPerson" class="contacts-empty contact-profile">选择一个角色</div>
  </div>
  <Modal :open="newOpen" title="新建角色" @close="newOpen=false"><form @submit.prevent="create"><label class="field">名字<input v-model="newName" maxlength="40" autofocus required/></label><label class="field">背景<textarea v-model="newPersona" rows="5" placeholder="身份与经历"/></label><footer class="form-footer"><button class="button primary" :disabled="busy||!newName.trim()"><Icon name="plus" :size="16"/>创建角色</button></footer></form></Modal>
  <Modal :open="discardOpen" title="保存角色的修改？" @close="discardOpen=false"><p>当前角色还有未保存的内容。保存后再继续，或放弃这次修改。</p><footer class="form-footer"><button class="button" :disabled="busy" @click="discardAndContinue">放弃修改</button><button class="button primary" :disabled="busy" @click="saveAndContinue"><Icon name="save" :size="16"/>保存并继续</button></footer></Modal>
</section>
</template>
<style src="../business-components.css"></style>

<style scoped>
.role-group-settings{grid-column:1/-1;min-width:0;margin:0;padding:0;border:0}.role-group-title{margin:0 0 8px;padding:0;font-size:13px;line-height:20px;font-weight:500;color:var(--sand-text-secondary,var(--muted))}
</style>
