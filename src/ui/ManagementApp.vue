<script setup lang="ts">
import {ref,watch,nextTick,onMounted,onBeforeUnmount,provide} from 'vue'
import type {Snapshot,RuntimeStatus,SettingsTarget,RoleSettingsTarget,ManagementTarget} from './types'
import {request} from './api'
import type {SettingsPageId} from './settings-navigation'
import {createAppRefreshController} from './app-refresh.mjs'
import {createWindowAppearanceBinding} from './window-appearance.mjs'
import {createAccentPalette,isAccentColor} from './accent-color.mjs'
import {normalizeManagementTarget,managementTargetFromSearch} from './management-navigation.mjs'
import {saveChannelMainList} from './conversation-display.mjs'
import {activeDirectConversation} from './conversation-state.mjs'
import ManagementWorkspace from './components/ManagementWorkspace.vue'
import Icon from './components/Icon.vue'
import CharactersView from './views/CharactersView.vue'
import ChannelsView from './views/ChannelsView.vue'
import PluginsView from './views/PluginsView.vue'
import SettingsView from './views/SettingsView.vue'
import DeveloperView from './views/DeveloperView.vue'

// This renderer never creates the chat controller, draft storage, read receipts or composer.
const nativeMac=window.sandbook?.platform==='darwin'
const state=ref<Snapshot>({characters:[],conversations:[],messages:[],prompts:[],settings:{developerMode:false,theme:'system',petEnabled:false},activity:[]})
const runtime=ref<RuntimeStatus>({status:'stopped',mode:'bundled',ok:false}),loading=ref(true),ready=ref(false),refreshing=ref(false),error=ref(''),notice=ref('')
const settingsPage=ref<SettingsPageId>('appearance')
const section=ref<ManagementTarget['section']>(managementTargetFromSearch(location.search).section)
const characterEditor=ref<InstanceType<typeof CharactersView>>(),channelTarget=ref<{accountId?:string;conversationId?:string}>(),pluginTarget=ref('')
const diagnosticsOpen=ref(false),pluginRequest=ref(0),managementRefreshKey=ref(0)
const settingsTarget=ref<{requestId:number;value:SettingsTarget}>();let settingsSequence=0,lastRequest=0,dispatchSequence=0
let pendingTarget:ManagementTarget|null=managementTargetFromSearch(location.search)
const displayBusy=ref<string[]>([]),displayErrors=ref<Record<string,string>>({}),displayDrafts=ref<Record<string,boolean>>({})
let events:EventSource|undefined,poll:ReturnType<typeof setInterval>|undefined,eventTimer:ReturnType<typeof setTimeout>|undefined,noticeTimer:ReturnType<typeof setTimeout>|undefined,themeMedia:MediaQueryList|undefined,closed=false
function report(cause:unknown){error.value=cause instanceof Error?cause.message:String(cause)}
function toast(value:string){notice.value=value;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>notice.value='',3500)}
const reader=createAppRefreshController({request,onSnapshot:(snapshot:Snapshot)=>{state.value=snapshot;ready.value=true;loading.value=false;void dispatchTarget()},onRuntime:(value:RuntimeStatus)=>runtime.value=value,onError:report,onSettled:()=>loading.value=false,onBusy:(busy:boolean)=>refreshing.value=busy})
function refresh(){return reader.refresh()}
async function dispatchTarget(){
 const target=pendingTarget;if(!ready.value||!target||closed)return
 const roleId=target.characterId??target.roleSettingsTarget?.characterId
 if(target.section==='characters'&&roleId&&!state.value.characters.some(role=>role.id===roleId)){section.value='characters';return}
 if(target.section==='characters'&&!characterEditor.value){section.value='characters';return}
 pendingTarget=null;const revision=++dispatchSequence;section.value=target.section;diagnosticsOpen.value=false
 if(target.section==='settings'&&target.settingsTarget)settingsTarget.value={requestId:++settingsSequence,value:target.settingsTarget}
 if(target.section==='channels')channelTarget.value={accountId:target.accountId,conversationId:target.conversationId}
 if(target.section==='characters'){
  await nextTick();if(revision!==dispatchSequence||closed)return
  if(target.roleSettingsTarget)await characterEditor.value?.openPermissionTarget(target.roleSettingsTarget,()=>revision===dispatchSequence)
  else if(target.characterId)characterEditor.value?.selectPerson(target.characterId)
 }
}
watch(characterEditor,()=>void dispatchTarget(),{flush:'post'})
function receiveTarget(value:unknown){const target=normalizeManagementTarget(value);if(!target)return;if(target.requestId!==undefined){if(target.requestId<=lastRequest)return;lastRequest=target.requestId}pendingTarget=target;void dispatchTarget();const roleId=target.characterId??target.roleSettingsTarget?.characterId;if(ready.value&&target.section==='characters'&&roleId&&!state.value.characters.some(role=>role.id===roleId))void refresh()}
function navigate(value:string){receiveTarget({section:value})}
function navigateSettings(id:SettingsPageId){settingsPage.value=id;receiveTarget({section:'settings'})}
function receiveSettings(value:SettingsTarget){receiveTarget({section:'settings',settingsTarget:value})}
function receiveRole(value:RoleSettingsTarget){receiveTarget({section:'characters',characterId:value.characterId,roleSettingsTarget:value})}
const stopTarget=window.sandbook?.onManagementTarget?.(receiveTarget),stopSettings=window.sandbook?.onSettingsTarget?.(receiveSettings),stopRole=window.sandbook?.onRoleSettingsTarget?.(receiveRole)
async function openConversation(id?:string){
 try{if(window.sandbook){if(id){if(!window.sandbook.openConversation)throw new Error('当前桌面版本不支持打开对话');await window.sandbook.openConversation(id)}else await window.sandbook.showMain();return}
 if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'suna:conversation-target',conversationId:id},location.origin);window.opener.focus()}else{const url=new URL(location.href);url.search='';if(id)url.searchParams.set('conversationId',id);window.open(url.href,'suna-main')}
 }catch(cause){report(cause)}
}
async function chatWithCharacter(id:string){
 const existing=activeDirectConversation(state.value.conversations,id);if(existing){await openConversation(existing.id);return}
 try{const role=state.value.characters.find(person=>person.id===id);if(!role)throw new Error('角色不存在');const result=await request('/conversations',{title:`与${role.name}的对话`,kind:'direct',participantIds:[id],channel:'desktop'});await refresh();await openConversation(result.id)}catch(cause){report(cause)}
}
function openPlugin(id:string){pluginTarget.value=id;pluginRequest.value++;section.value='plugins'}
async function setDisplay(id:string,shown:boolean){
 if(displayBusy.value.includes(id))return
 displayDrafts.value={...displayDrafts.value,[id]:shown};delete displayErrors.value[id];displayBusy.value=[...displayBusy.value,id]
 try{await saveChannelMainList({id,shown,getSnapshot:()=>state.value,request});delete displayDrafts.value[id];await refresh();toast(shown?'已在主列表展示':'已从主列表隐藏')}
 catch(cause){displayErrors.value[id]=cause instanceof Error?cause.message:String(cause);await refresh()}
 finally{displayBusy.value=displayBusy.value.filter(value=>value!==id)}
}
function theme(){const chosen=state.value.settings.theme;const dark=chosen==='system'?(themeMedia?.matches??false):chosen==='dark';document.documentElement.dataset.theme=dark?'dark':'light';void window.sandbook?.setTheme?.(chosen==='light'||chosen==='dark'?chosen:'system').catch(()=>{});const style=document.documentElement.style,keys=['--sand-bg-accent-primary','--sand-bg-accent-primary-hover','--sand-bg-accent-secondary','--sand-text-accent-primary','--sand-icon-accent-primary','--sand-border-accent-primary','--on-accent'];if(isAccentColor(state.value.settings.accentColor)){const palette=createAccentPalette(state.value.settings.accentColor,dark,state.value.settings.accentTextMode),values=[palette['--accent'],palette['--accent-hover'],palette['--accent-soft'],palette['--accent-ink'],palette['--accent'],palette['--accent'],palette['--on-accent']];keys.forEach((key,index)=>style.setProperty(key,values[index]))}else keys.forEach(key=>style.removeProperty(key))}
const appearance=createWindowAppearanceBinding({bridge:window.sandbook,readPreference:()=>state.value.settings.appearance,style:document.documentElement.style,onError:report})
watch([()=>state.value.settings.theme,()=>state.value.settings.accentColor,()=>state.value.settings.accentTextMode],theme)
watch(()=>JSON.stringify(state.value.settings.appearance??null),appearance.applyPreferences)
function onFocus(){managementRefreshKey.value++;void reader.refresh({queue:false})}
function onMessage(event:MessageEvent){if(event.origin===location.origin&&event.source===window.opener&&event.data?.type==='suna:management-target')receiveTarget(event.data.target)}
onMounted(()=>{if(nativeMac)document.documentElement.classList.add('native-material-host');document.title='沙之书 · 管理';themeMedia=matchMedia('(prefers-color-scheme: dark)');themeMedia.addEventListener('change',theme);theme();appearance.start();window.addEventListener('focus',onFocus);window.addEventListener('message',onMessage);events=new EventSource('/api/events');events.onmessage=event=>{let update;try{update=JSON.parse(event.data)}catch{}if(update?.type==='changed'||update?.type==='connected'||/^(channels|channel-accounts|plugins)[.:-]/.test(update?.type??''))managementRefreshKey.value++;if(!eventTimer)eventTimer=setTimeout(()=>{eventTimer=undefined;void refresh()},80)};events.onopen=()=>managementRefreshKey.value++;poll=setInterval(()=>void reader.refresh({queue:false}),10000);void refresh()})
onBeforeUnmount(()=>{if(nativeMac)document.documentElement.classList.remove('native-material-host');closed=true;dispatchSequence++;reader.close();stopTarget?.();stopSettings?.();stopRole?.();events?.close();clearInterval(poll);clearTimeout(eventTimer);clearTimeout(noticeTimer);themeMedia?.removeEventListener('change',theme);appearance.close();window.removeEventListener('focus',onFocus);window.removeEventListener('message',onMessage)})
</script>
<template>
 <div class="management-window-shell">
  <ManagementWorkspace :section="section" :settings-page="settingsPage" @settings="navigateSettings" :native-mac="nativeMac" :developer-mode="state.settings.developerMode" @navigate="navigate" @conversation="openConversation()">
   <div v-if="loading" class="loading-content" aria-live="polite">正在加载…</div>
   <div v-else-if="!ready" class="loading-content" role="status"><span>管理页面加载失败</span><button class="button" :disabled="refreshing" @click="refresh">{{refreshing?'正在重试…':'重试'}}</button></div>
   <template v-else>
    <CharactersView ref="characterEditor" v-show="section==='characters'" :active="section==='characters'" :state="state" @refresh="refresh" @error="report" @notice="toast" @chat="chatWithCharacter"/>
    <ChannelsView v-show="section==='channels'" :target="channelTarget" :refresh-key="managementRefreshKey" :state="state" :active="section==='channels'" :display-supported="state.capabilities?.channelConversationMainListV1===true" :display-busy-ids="displayBusy" :display-errors="displayErrors" :display-drafts="displayDrafts" @display="setDisplay" @refresh="refresh" @error="report" @notice="toast" @open-conversation="openConversation" @open-plugin="openPlugin"/>
    <PluginsView v-show="section==='plugins'" :refresh-key="managementRefreshKey" :target-plugin-id="pluginTarget" :target-request="pluginRequest" :state="state" :active="section==='plugins'" @refresh="refresh" @error="report" @notice="toast" @manage-channels="navigate('channels')"/>
    <SettingsView external-navigation :navigation-tab="settingsPage" @tab-change="settingsPage=$event" v-show="section==='settings'&&!diagnosticsOpen" :target="settingsTarget" :state="state" :runtime="runtime" :active="section==='settings'&&!diagnosticsOpen" @diagnostics="diagnosticsOpen=true" @role-target="receiveRole" @refresh="refresh" @error="report" @notice="toast"/>
    <section v-if="state.settings.developerMode" v-show="section==='settings'&&diagnosticsOpen" class="management-diagnostics"><header><button class="text-button" @click="diagnosticsOpen=false"><Icon name="back" :size="16"/>返回设置</button></header><DeveloperView :state="state" :active="section==='settings'&&diagnosticsOpen" @refresh="refresh" @error="report" @notice="toast"/></section>
   </template>
  </ManagementWorkspace>
  <div v-if="error" class="global-error" role="alert"><span>{{error}}</span><button class="icon-button" aria-label="关闭错误提示" @click="error=''"><Icon name="close" :size="16"/></button></div>
  <Transition name="toast"><div v-if="notice" class="toast" role="status"><Icon name="check" :size="16"/>{{notice}}</div></Transition>
 </div>
</template>
<style scoped>
.management-diagnostics{display:flex;flex-direction:column;min-width:0;min-height:0}.management-diagnostics>header{flex:none;padding:12px 16px}.management-diagnostics>header button{display:flex;gap:8px;align-items:center}.management-diagnostics>:last-child{flex:1;min-height:0}
.management-window-shell{height:100dvh;min-width:0;min-height:0;overflow:hidden}
</style>
