<script setup lang="ts">
import ResizableSidebar from '../components/ResizableSidebar.vue'
import {settingsPages,type SettingsPageId} from '../settings-navigation'
import {ref,watch,computed,onBeforeUnmount,onMounted} from 'vue'
import {version as packageVersion} from '../../../package.json'
import {displayProductVersion} from '../../shared/product-version.mjs'
const appVersion=displayProductVersion(packageVersion)
import type {Snapshot,RuntimeStatus,SettingsTarget,PromptTarget,RoleSettingsTarget} from '../types'
import {request} from '../api'
import CustomSelect from '../components/CustomSelect.vue'
import ToggleSwitch from '../components/ToggleSwitch.vue'
import Icon from '../components/Icon.vue'
import PromptsView from './PromptsView.vue'
import ModelSettings from '../components/ModelSettings.vue'
import SettingsGroup from '../components/SettingsGroup.vue'
import PersonalAvatarSettings from '../components/PersonalAvatarSettings.vue'
import AccentColorPicker from '../components/AccentColorPicker.vue'
import {normalizeAccent,isAccentColor,isAccentTextMode,normalizeAccentTextMode} from '../accent-color.mjs'
import GroupSchedulerSettings from '../components/GroupSchedulerSettings.vue'
import SearchSettings from '../components/SearchSettings.vue'
import RuntimeNativeTools from '../components/RuntimeNativeTools.vue'
const props=defineProps<{state:Snapshot;runtime:RuntimeStatus;active:boolean;externalNavigation?:boolean;navigationTab?:SettingsPageId;target?:{requestId:number;value:SettingsTarget}}>(),emit=defineEmits<{refresh:[];error:[unknown];notice:[string];diagnostics:[];tabChange:[tab:SettingsPageId];roleTarget:[target:RoleSettingsTarget]}>()
type SettingsTab=SettingsPageId
const settingsTab=ref<SettingsTab>('appearance'),settingsContent=ref<HTMLElement>()
const promptTarget=ref<PromptTarget>();let targetRequest=0
function receiveSettingsTarget(target:SettingsTarget){
  if(!target||typeof target!=='object')return
  if(target.scope!==undefined&&!['runtime','worker','tool'].includes(target.scope))return
  if(target.characterId!==undefined&&(typeof target.characterId!=='string'||!target.characterId.trim()||target.characterId.length>200))return
  if(target.name!==undefined&&(typeof target.name!=='string'||!target.name.trim()||target.name.length>200))return
  if(target.tab==='permissions'||target.tab==='screen'){void redirectRolePermission(target);return}
  if(target.tab==='prompts'||target.characterId&&!target.tab){promptTarget.value={scope:target.scope,name:target.name,requestId:++targetRequest};selectSettingsTab('prompts')}
  else if(settingsPages.some(page=>page.id===target.tab))selectSettingsTab(target.tab as SettingsTab)
}
async function redirectRolePermission(target:SettingsTarget){if(!target.characterId){emit('error',new Error('未指定角色'));return}const next:RoleSettingsTarget={characterId:target.characterId,tab:'permissions',...(target.permissionTool||target.tab==='screen'?{tool:target.tab==='screen'?'screenshot':target.permissionTool}:{}),...(target.permissionAccountId?{accountId:target.permissionAccountId}:{}),...(target.permissionConversationId?{conversationId:target.permissionConversationId}:{})};try{if(window.sandbook?.openRoleSettings)await window.sandbook.openRoleSettings(next);else emit('roleTarget',next)}catch(error){emit('error',error)}}
// Category navigation preserves the current prompt target and its unsaved editor.
watch(()=>props.navigationTab,tab=>{if(tab&&tab!==settingsTab.value)selectSettingsTab(tab)},{immediate:true})
watch(()=>props.target,target=>{if(target)receiveSettingsTarget(target.value)},{immediate:true})
const settingsTitle=computed(()=>settingsPages.find(page=>page.id===settingsTab.value)?.label??'设置')
function selectSettingsTab(id:SettingsTab){settingsTab.value=id;emit('tabChange',id);settingsContent.value?.scrollTo({top:0})}
const settingsNavId=computed(()=>props.externalNavigation?`management-settings-${settingsTab.value}-nav`:`settings-${settingsTab.value}-nav`)
const native=Boolean(window.sandbook)
const nativeAppearanceControl=Boolean(window.sandbook?.setWindowAppearance)
const runtimeToolsBusy=ref(false)
const busy=ref(''),discoveryFile=ref(''),dshHome=ref(''),profileName=ref('desktop'),updates=ref<any>()
type WindowAppearance={transparency:number;blur:'off'|'system';accentColor:string;accentTextMode:'auto'|'dark'|'light'}
type AppearanceStatus=Omit<WindowAppearance,'accentColor'|'accentTextMode'>&{effectiveBlur:'off'|'system';reducedTransparency:boolean;nativeBlurSupported:boolean}
const appearanceStatus=ref<AppearanceStatus>()
const stopAppearanceStatus=window.sandbook?.onWindowAppearance?.(value=>{appearanceStatus.value=value})
onBeforeUnmount(()=>stopAppearanceStatus?.())
onMounted(()=>{void window.sandbook?.getWindowAppearance?.().then(value=>{appearanceStatus.value=value}).catch(()=>{})})
const appearanceForm=ref<WindowAppearance>({transparency:50,blur:'system',accentColor:normalizeAccent(undefined),accentTextMode:'auto'}),appearanceBaseline=ref(JSON.stringify(appearanceForm.value)),appearanceBusy=ref(false),appearanceError=ref(''),appearanceVersion=ref<number>()
const accentSupported=computed(()=>isAccentColor(props.state.settings.accentColor))
const accentTextModeSupported=computed(()=>isAccentTextMode(props.state.settings.accentTextMode))
const appearanceLatest=ref<Snapshot['settings']>()
const appearanceVersionChanged=computed(()=>{const version=props.state.settings.version;return typeof version==='number'&&Number.isSafeInteger(version)&&version>(appearanceVersion.value??-1)})
const appearanceDirty=computed(()=>JSON.stringify(appearanceForm.value)!==appearanceBaseline.value)
function appearanceValues(value:Snapshot['settings']):WindowAppearance{return {transparency:Number.isInteger(value.appearance?.transparency)?value.appearance.transparency:50,blur:value.appearance?.blur==='off'?'off':'system',accentColor:normalizeAccent(value.accentColor),accentTextMode:normalizeAccentTextMode(value.accentTextMode)}}
watch(()=>props.state.settings,value=>{if(!appearanceDirty.value&&!appearanceBusy.value){appearanceVersion.value=value.version;appearanceForm.value=appearanceValues(value);appearanceBaseline.value=JSON.stringify(appearanceForm.value)}},{immediate:true})
function matchesSubmittedAppearance(saved:Snapshot['settings'],submitted:WindowAppearance,requireTextMode=false){
  return (!requireTextMode||isAccentTextMode(saved.accentTextMode))&&normalizeAccentTextMode(saved.accentTextMode)===submitted.accentTextMode&&isAccentColor(saved.accentColor)&&normalizeAccent(saved.accentColor)===normalizeAccent(submitted.accentColor)&&saved.appearance?.transparency===submitted.transparency&&saved.appearance?.blur===submitted.blur
}
async function saveAppearance(){
  if(appearanceBusy.value)return false
  if(!accentSupported.value){appearanceError.value='当前服务尚未支持强调色，请更新服务后重试';return false}
  const expectedVersion=appearanceVersion.value
  if(typeof expectedVersion!=='number'||!Number.isSafeInteger(expectedVersion)||expectedVersion<0){appearanceError.value='配置版本无效，请重新读取后保存';return false}
  const submitted={...appearanceForm.value},withTextMode=accentTextModeSupported.value
  if(!withTextMode&&submitted.accentTextMode!=='auto'){appearanceError.value='当前服务尚未支持强调色文字颜色，修改已保留';return false}
  if(!isAccentTextMode(submitted.accentTextMode)||!isAccentColor(submitted.accentColor)||!Number.isInteger(submitted.transparency)||submitted.transparency<0||submitted.transparency>100||!['off','system'].includes(submitted.blur)){appearanceError.value='外观设置无效，请检查颜色和背景参数';return false}
  appearanceBusy.value=true;appearanceError.value=''
  try{
    const saved=await request<Snapshot['settings']>('/settings',{appearance:{transparency:submitted.transparency,blur:submitted.blur},accentColor:normalizeAccent(submitted.accentColor),...(withTextMode?{accentTextMode:submitted.accentTextMode}:{}),expectedVersion},'PATCH')
    const latest=props.state.settings,savedVersion=saved?.version,latestVersion=latest.version
    if(typeof savedVersion!=='number'||!Number.isSafeInteger(savedVersion)||savedVersion<=expectedVersion||!matchesSubmittedAppearance(saved,submitted,withTextMode)||(withTextMode&&!accentTextModeSupported.value)||!accentSupported.value||typeof latestVersion!=='number'||!Number.isSafeInteger(latestVersion)||latestVersion>savedVersion||(latestVersion===savedVersion&&!matchesSubmittedAppearance(latest,submitted,withTextMode)))throw new Error('保存结果未确认，修改已保留；请重新读取配置并确认最新版本')
    const received=appearanceValues(saved)
    appearanceVersion.value=savedVersion
    if(JSON.stringify(appearanceForm.value)===JSON.stringify(submitted))appearanceForm.value=received
    appearanceBaseline.value=JSON.stringify(received);emit('refresh');return true
  }catch(error){appearanceError.value=error instanceof Error?error.message:'外观设置保存失败';return false}
  finally{appearanceBusy.value=false}
}
async function reloadAppearance(){
  if(appearanceBusy.value)return false
  const requireTextMode=accentTextModeSupported.value||JSON.parse(appearanceBaseline.value).accentTextMode!=='auto'
  appearanceBusy.value=true;appearanceError.value=''
  try{
    const latest=await request<Snapshot['settings']>('/settings')
    if(!latest||(requireTextMode&&!isAccentTextMode(latest.accentTextMode))||!Number.isSafeInteger(latest.version)||latest.version!<0||!isAccentColor(latest.accentColor)||!Number.isInteger(latest.appearance?.transparency)||latest.appearance.transparency<0||latest.appearance.transparency>100||!['off','system'].includes(latest.appearance.blur)||latest.version!<(props.state.settings.version??0)||latest.version!<(appearanceLatest.value?.version??0))throw new Error('未取得有效的最新配置，修改已保留，请重新读取')
    appearanceLatest.value=latest;emit('refresh');return true
  }catch(error){appearanceError.value=error instanceof Error?error.message:'配置读取失败，修改已保留';return false}
  finally{appearanceBusy.value=false}
}
function keepAppearanceWithLatestVersion(){
  if(appearanceBusy.value||!appearanceLatest.value)return false
  const latest=appearanceLatest.value
  if(!accentSupported.value||((accentTextModeSupported.value||JSON.parse(appearanceBaseline.value).accentTextMode!=='auto')&&!isAccentTextMode(latest.accentTextMode))||latest.version!<(props.state.settings.version??0)){appearanceError.value='配置再次更新，请重新读取后确认';return false}
  const baseline=JSON.parse(appearanceBaseline.value) as WindowAppearance,received=appearanceValues(latest),current=appearanceForm.value
  if(current.transparency===baseline.transparency)current.transparency=received.transparency
  if(current.blur===baseline.blur)current.blur=received.blur
  if(normalizeAccent(current.accentColor)===normalizeAccent(baseline.accentColor))current.accentColor=received.accentColor
  if(current.accentTextMode===baseline.accentTextMode)current.accentTextMode=received.accentTextMode
  appearanceBaseline.value=JSON.stringify(received);appearanceVersion.value=latest.version;appearanceLatest.value=undefined;appearanceError.value='';return true
}
function discardAppearance(){const latest=appearanceLatest.value&&(appearanceLatest.value.version??0)>=(props.state.settings.version??0)?appearanceLatest.value:props.state.settings;appearanceForm.value=appearanceValues(latest);appearanceBaseline.value=JSON.stringify(appearanceForm.value);appearanceVersion.value=latest.version;appearanceLatest.value=undefined;appearanceError.value=''}
type BackgroundForm={enabled:boolean;diaryEnabled:boolean;dreamCron:string;timeZone:string}
const backgroundForm=ref<BackgroundForm>({enabled:true,diaryEnabled:true,dreamCron:'',timeZone:'UTC'}),backgroundBaseline=ref(JSON.stringify(backgroundForm.value)),backgroundVersion=ref<number>(),backgroundError=ref('')
let backgroundLoaded=false
const backgroundDirty=computed(()=>JSON.stringify(backgroundForm.value)!==backgroundBaseline.value)
const timeZones=computed(()=>[...new Set(['UTC',...Intl.supportedValuesOf('timeZone'),backgroundForm.value.timeZone])].sort().map(value=>({value,label:value})))
function backgroundValues(value:Snapshot['settings']):BackgroundForm{return {enabled:value.background?.enabled!==false,diaryEnabled:value.background?.diaryEnabled!==false,dreamCron:value.background?.dreamCron??'',timeZone:value.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone}}
function loadBackground(value:Snapshot['settings']){backgroundForm.value=backgroundValues(value);backgroundBaseline.value=JSON.stringify(backgroundForm.value);backgroundVersion.value=value.version;backgroundLoaded=true}
watch(()=>props.state.settings,value=>{if(!backgroundLoaded||(!backgroundDirty.value&&!busy.value.startsWith('background')))loadBackground(value)},{immediate:true})
async function saveBackground(){
  if(busy.value)return false
  const before=JSON.stringify(backgroundForm.value),form={...backgroundForm.value,dreamCron:backgroundForm.value.dreamCron.trim(),timeZone:backgroundForm.value.timeZone.trim()}
  backgroundError.value='';busy.value='background'
  try{
    const saved=await request<Snapshot['settings']>('/settings',{background:{enabled:form.enabled,diaryEnabled:form.diaryEnabled,dreamCron:form.dreamCron},timeZone:form.timeZone,expectedVersion:backgroundVersion.value},'PATCH')
    const result=backgroundValues(saved);backgroundBaseline.value=JSON.stringify(result);backgroundVersion.value=saved.version
    if(JSON.stringify(backgroundForm.value)===before)backgroundForm.value=result
    emit('refresh');emit('notice','后台任务设置已保存');return !backgroundDirty.value
  }catch(error){backgroundError.value=error&&typeof error==='object'&&'message' in error?String(error.message):String(error);return false}finally{busy.value=''}
}
async function reloadBackground(){if(busy.value)return;busy.value='background-load';try{loadBackground(await request<Snapshot['settings']>('/settings'));backgroundError.value=''}catch(error){backgroundError.value=error&&typeof error==='object'&&'message' in error?String(error.message):String(error)}finally{busy.value=''}}
async function action(name:string,body:unknown={},notice?:string){if(runtimeToolsBusy.value)return;busy.value=name;try{const result=await request(`/runtime/${name}`,body);emit('refresh');if(notice)emit('notice',notice);return result}catch(e){emit('error',e)}finally{busy.value=''}}
async function settings(patch:unknown){try{await request('/settings',patch,'PATCH');emit('refresh')}catch(e){emit('error',e)}}
async function checkUpdate(){if(runtimeToolsBusy.value)return;busy.value='check';try{updates.value=await request('/runtime/updates')}catch(e){emit('error',e)}finally{busy.value=''}}
async function chooseExternal(){if(runtimeToolsBusy.value||busy.value)return;busy.value='external';try{const result=await window.sandbook?.chooseRuntimeConnection();if(result){emit('refresh');emit('notice','已连接外部 DSH')}}catch(e){emit('error',e)}finally{busy.value=''}}
async function installExternal(){if(runtimeToolsBusy.value||busy.value)return;busy.value='install-plugin';try{const result=await window.sandbook?.installRuntimePlugin();if(result)emit('notice','桥接插件已安装')}catch(e){emit('error',e)}finally{busy.value=''}}
async function gui(){if(runtimeToolsBusy.value||busy.value)return;if(window.sandbook){busy.value='gui';try{await window.sandbook.openRuntimeGui()}catch(e){emit('error',e)}finally{busy.value=''}}else{const result=await action('gui');if(result?.url)window.open(result.url,'_blank','noopener,noreferrer')}}
</script>
<template>
  <section class="page-view settings-page business-page">
    <ResizableSidebar v-if="!externalNavigation" class="settings-sidebar-frame" name="设置导航" storage-key="settings" :width="198" :min="156" :max="360"><aside class="settings-sidebar">
      <h1>设置</h1>
      <nav aria-label="设置分类">
        <button v-for="page in settingsPages" :id="`settings-${page.id}-nav`" :key="page.id" type="button" :aria-current="settingsTab===page.id?'page':undefined" :aria-controls="page.id==='prompts'?'settings-prompts':'settings-general'" @click="selectSettingsTab(page.id)"><Icon stateful :name="page.icon" :size="17"/>{{page.label}}</button>
      </nav>
    </aside></ResizableSidebar>
    <div class="settings-panels">
    <section id="settings-general" v-show="settingsTab!=='prompts'" class="settings-general" :aria-labelledby="settingsNavId">
      <header class="page-header"><h2>{{settingsTitle}}</h2></header>
      <div ref="settingsContent" class="settings-content">
      <section v-show="settingsTab==='appearance'" class="settings-group" aria-label="外观"><PersonalAvatarSettings :settings="state.settings" :active="active&&settingsTab==='appearance'" @refresh="emit('refresh')"/><SettingsGroup title="显示"><div class="setting-row"><strong>主题</strong><div class="segmented"><button v-for="t in [{id:'system',label:'自动',icon:'monitor'},{id:'light',label:'浅色',icon:'sun'},{id:'dark',label:'深色',icon:'moon'}]" :key="t.id" :aria-pressed="state.settings.theme===t.id" @click="settings({theme:t.id})"><Icon :name="t.icon" :size="16"/>{{t.label}}</button></div></div><div class="setting-row accent-setting"><span id="accent-color-label">强调色</span><AccentColorPicker v-model="appearanceForm.accentColor" :text-mode="appearanceForm.accentTextMode" :disabled="appearanceBusy||!accentSupported" aria-labelledby="accent-color-label"/></div><div class="setting-row appearance-setting"><span id="accent-text-mode-label">强调色上的文字颜色</span><div class="segmented" role="group" aria-labelledby="accent-text-mode-label"><button v-for="mode in [{id:'dark',label:'深色'},{id:'light',label:'浅色'},{id:'auto',label:'自动'}] as const" :key="mode.id" type="button" :aria-pressed="appearanceForm.accentTextMode===mode.id" :disabled="appearanceBusy||!accentTextModeSupported" @click="appearanceForm.accentTextMode=mode.id">{{mode.label}}</button></div></div><div class="setting-row appearance-setting"><label for="window-transparency">背景透明度</label><div class="appearance-range"><input id="window-transparency" v-model.number="appearanceForm.transparency" type="range" min="0" max="100" step="1" :disabled="appearanceBusy" :style="{'--range-progress':`${appearanceForm.transparency}%`}"/><output for="window-transparency">{{appearanceForm.transparency}}%</output></div></div><div class="setting-row appearance-setting"><label id="window-blur-label">背景模糊</label><CustomSelect v-model="appearanceForm.blur" aria-labelledby="window-blur-label" :options="[{value:'off',label:'关闭'},{value:'system',label:'系统模糊'}]" :disabled="appearanceBusy||(native&&(!nativeAppearanceControl||appearanceStatus?.nativeBlurSupported===false))"/></div><template #footer><p v-if="!accentSupported" class="appearance-status" role="status">当前服务尚未支持强调色</p><p v-if="!accentTextModeSupported" class="appearance-status" role="status">当前服务尚未支持强调色文字颜色</p><p v-if="native&&appearanceStatus?.reducedTransparency" class="appearance-status" role="status">系统已启用减少透明度，背景模糊已关闭</p><p v-else-if="native&&appearanceStatus?.nativeBlurSupported===false" class="appearance-status" role="status">当前平台不支持窗口背景模糊</p><p v-if="appearanceError" class="appearance-error" role="alert">{{appearanceError}}</p><div v-if="appearanceError||appearanceVersionChanged||appearanceLatest" class="appearance-recovery"><button type="button" class="text-button" :disabled="appearanceBusy" @click="reloadAppearance"><Icon name="refresh" :size="16"/>重新读取配置</button><button v-if="appearanceLatest" type="button" class="text-button" :disabled="appearanceBusy" @click="keepAppearanceWithLatestVersion">保留修改并使用最新版本</button></div><div v-if="appearanceDirty" class="appearance-actions"><button type="button" class="button" :disabled="appearanceBusy" @click="discardAppearance">放弃</button><button type="button" class="button primary" :disabled="appearanceBusy" @click="saveAppearance"><Icon name="save" :size="16"/>{{appearanceBusy?'保存中…':'保存外观'}}</button></div></template></SettingsGroup></section>
      <ModelSettings v-show="settingsTab==='model'||settingsTab==='model-scheduling'" :page="settingsTab==='model-scheduling'?'scheduling':'providers'" :active="active&&(settingsTab==='model'||settingsTab==='model-scheduling')" @refresh="emit('refresh')" @error="emit('error',$event)" @notice="emit('notice',$event)"/>
      <SearchSettings v-show="settingsTab==='search'" :active="props.active&&settingsTab==='search'" @refresh="emit('refresh')" @notice="emit('notice',$event)"/>
      <section v-show="settingsTab==='runtime'" class="settings-group" aria-label="DSH 运行时"><div class="group-content"><SettingsGroup title="运行状态">
        <div class="setting-row"><div class="runtime-summary"><strong>{{runtime.mode==='external'?'外部 DSH':'内置 DSH'}}</strong><span class="status-label"><i class="status-dot" :class="{online:runtime.ok}"/>{{runtime.ok?'运行中':'未连接'}}</span><span v-if="runtime.version" class="muted">{{runtime.version}}</span></div><div class="button-row"><button class="button" :disabled="Boolean(busy)||runtimeToolsBusy" @click="gui"><Icon name="monitor" :size="16"/>打开 GUI</button><button class="button" :disabled="Boolean(busy)||runtimeToolsBusy" @click="action(runtime.ok?'stop':'start')"><Icon :name="runtime.ok?'stop':'play'" :size="16"/>{{busy==='start'?'启动中…':runtime.ok?'停止':'启动'}}</button></div></div>
        
        <div class="setting-row"><div><strong>运行时更新</strong><p v-if="updates">{{updates.updateAvailable?'有新版本':'当前版本已检查'}}{{updates.latestVersion?` · ${updates.latestVersion}`:''}}</p></div><div class="button-row"><button class="button" :disabled="Boolean(busy)||runtimeToolsBusy" @click="checkUpdate"><Icon name="refresh" :size="16"/>{{busy==='check'?'检查中…':'检查更新'}}</button><button v-if="updates?.updateAvailable" class="button primary" :disabled="Boolean(busy)||runtimeToolsBusy" @click="action('update',{version:updates.latestVersion},'DSH 已更新')"><Icon name="download" :size="16"/>{{busy==='update'?'更新中…':'安装更新'}}</button></div></div>
        <template v-if="runtime.lastError" #footer><p class="inline-error">{{runtime.lastError}}</p></template></SettingsGroup>
        <RuntimeNativeTools class="settings-runtime-tools" :developer="state.settings.developerMode" :active="active&&settingsTab==='runtime'" :runtime="runtime" :disabled="Boolean(busy)" @busy="runtimeToolsBusy=$event" @refresh="emit('refresh')" @notice="emit('notice',$event)"/>
        <SettingsGroup title="外部连接"><div class="runtime-connection"><details class="disclosure"><summary>连接其他 DSH<Icon class="disclosure-arrow" name="down" :size="14"/></summary><p class="functional-note">在目标 DSH 安装桥接插件，再选择生成的 connection.json。</p><div class="external-connect"><div v-if="native" class="button-row"><button class="button" :disabled="Boolean(busy)||runtimeToolsBusy" @click="chooseExternal"><Icon name="folder" :size="16"/>选择连接文件</button><button class="button" :disabled="Boolean(busy)||runtimeToolsBusy" @click="installExternal"><Icon name="plugin" :size="16"/>安装桥接插件</button></div><template v-else><label class="field">连接文件路径<input v-model="discoveryFile" placeholder="/…/connection.json"/></label><button class="button" :disabled="!discoveryFile.trim()||Boolean(busy)||runtimeToolsBusy" @click="action('external',{discoveryFile},'已切换到外部 DSH')"><Icon name="plug" :size="16"/>连接</button></template><div class="button-row"><button v-if="runtime.mode==='external'" class="button" :disabled="Boolean(busy)||runtimeToolsBusy" @click="action('bundled',{},'已切回内置 DSH')"><Icon name="terminal" :size="16"/>使用内置 DSH</button><a class="button" href="/api/runtime/plugin" download><Icon name="download" :size="15"/>下载插件</a></div></div><details v-if="!native" class="disclosure"><summary>安装到指定目录<Icon class="disclosure-arrow" name="down" :size="14"/></summary><div class="bridge-form"><label class="field">DSH_HOME<input v-model="dshHome" placeholder="目标 DSH 数据目录"/></label><label class="field">Profile<input v-model="profileName"/></label><button class="button" :disabled="!dshHome.trim()||!profileName.trim()||Boolean(busy)||runtimeToolsBusy" @click="action('install-plugin',{dshHome,profileName},'桥接插件已安装')"><Icon name="download" :size="16"/>安装</button></div></details></details></div></SettingsGroup>
      </div></section>
      <section v-show="settingsTab==='background'" class="settings-group" aria-label="后台任务"><form class="group-content background-form" @submit.prevent="saveBackground">
        <SettingsGroup title="任务计划">
          <div class="settings-card-row"><label for="background-enabled">自动后台任务</label><ToggleSwitch id="background-enabled" v-model="backgroundForm.enabled" aria-label="自动后台任务" :disabled="Boolean(busy)"/></div>
          <div class="settings-card-row"><label for="background-diary">自动生成日记</label><ToggleSwitch id="background-diary" v-model="backgroundForm.diaryEnabled" aria-label="自动生成日记" :disabled="Boolean(busy)"/></div>
          <div class="settings-card-row"><label for="background-cron">梦境任务周期（Cron）</label><input id="background-cron" v-model="backgroundForm.dreamCron" maxlength="256" placeholder="分 时 日 月 周；留空关闭" :disabled="Boolean(busy)" :aria-describedby="backgroundError?'background-error':undefined"/></div>
          <div class="settings-card-row"><label id="background-zone-label">时区</label><CustomSelect v-model="backgroundForm.timeZone" aria-labelledby="background-zone-label" :options="timeZones" :disabled="Boolean(busy)"/></div>
          <template #footer><div v-if="backgroundError" class="background-feedback"><p id="background-error" class="inline-error" role="alert">{{backgroundError}}</p><button type="button" class="text-button" :disabled="Boolean(busy)" @click="reloadBackground"><Icon name="refresh" :size="16"/>放弃编辑并重新读取</button></div><button class="button primary" :disabled="Boolean(busy)||!backgroundDirty"><Icon name="save" :size="16"/>{{busy==='background'?'保存中…':'保存'}}</button></template>
        </SettingsGroup>
      </form></section>
      <GroupSchedulerSettings v-show="settingsTab==='group'" :settings="state.settings" :supported="state.capabilities?.channelGroupSchedulerV2===true" :active="active&&settingsTab==='group'" @refresh="emit('refresh')" @notice="emit('notice',$event)"/>
      <section v-show="settingsTab==='developer'" class="settings-group" aria-label="开发者模式"><SettingsGroup title="诊断"><div class="setting-row"><strong>隔离测试、执行详情与诊断导出</strong><ToggleSwitch :model-value="state.settings.developerMode" aria-label="开发者模式" @update:model-value="settings({developerMode:$event})"/></div><div v-if="state.settings.developerMode" class="setting-row"><strong>运行日志与隔离测试</strong><button class="button" @click="emit('diagnostics')"><Icon name="terminal" :size="16"/>打开诊断</button></div></SettingsGroup></section>
      <p v-show="settingsTab==='appearance'" class="version-caption">沙之书 {{appVersion}}</p>
      </div>
    </section>
    <PromptsView id="settings-prompts" v-show="settingsTab==='prompts'" class="settings-prompts" :state="state" :active="active&&settingsTab==='prompts'" :prompt-target="promptTarget" :global-only="true" title="系统提示词" :aria-labelledby="externalNavigation?'management-settings-prompts-nav':'settings-prompts-nav'" @refresh="emit('refresh')" @error="emit('error',$event)" @notice="emit('notice',$event)"/>
    </div>
  </section>
</template>
<style src="../business-components.css"></style>
