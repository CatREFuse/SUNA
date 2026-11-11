<script setup lang="ts">
import {ref,computed,watch,onBeforeUnmount} from 'vue'
import type {Snapshot,ClientPlugin,PluginConfigField,PluginConfigValue} from '../types'
import {request,upload} from '../api'
import Icon from '../components/Icon.vue'
import CustomSelect from '../components/CustomSelect.vue'
import PluginConfigFields from '../components/PluginConfigFields.vue'
import ResizableSidebar from '../components/ResizableSidebar.vue'
import Modal from '../components/Modal.vue'
import PluginFrame from '../components/PluginFrame.vue'

const props=defineProps<{state:Snapshot;active:boolean;targetPluginId?:string;targetRequest?:number;refreshKey?:number}>(),emit=defineEmits<{refresh:[];error:[unknown];notice:[string];manageChannels:[]}>()
const plugins=ref<ClientPlugin[]>([]),loaded=ref(false),loading=ref(false),loadError=ref(''),importBusy=ref(false),importError=ref(''),file=ref<HTMLInputElement>(),opened=ref('')
const drafts=ref<Record<string,Record<string,PluginConfigValue>>>({}),busy=ref<Record<string,string>>({}),errors=ref<Record<string,string>>({})
function platformLogo(id:string){return ['suna-napcat','suna-qq-official'].includes(id)?'/brands/qq.png':id==='suna-weixin-official'?'/brands/wechat.png':''}
const statusLabels:Record<string,string>={installed:'已安装',stopped:'已停止',starting:'启动中',stopping:'停止中',running:'运行中',failed:'运行失败'}
const fieldTypes=new Set(['text','string','secret','number','boolean','textarea','select','conversation','character','channel-conversation'])
const qrOpen=ref(false),qrImage=ref(''),qrStatus=ref(''),qrAccount=ref(''),qrPlugin=ref<ClientPlugin>()
const mobileDetail=ref(false),managerDirty=ref(false),pendingManagerTarget=ref<ClientPlugin>()
function discardManagerAndLeave(){const target=pendingManagerTarget.value;pendingManagerTarget.value=undefined;managerDirty.value=false;if(target)selectPlugin(target)}
const query=ref(''),editing=ref(false),accountId=ref<string>(),characterId=ref(''),channelDraft=ref<Record<string,PluginConfigValue>>({}),channelSecrets=ref<string[]>([]),channelBusy=ref(false),channelError=ref(''),channelAccounts=ref<any[]>([])
const administratorUid=ref(''),administratorBaseline=ref(''),administratorSupported=ref(false),administratorError=ref(''),boundCharacterId=ref('')
const channelSchema=computed(()=>Object.fromEntries(Object.entries(selected.value?.configSchema??{}).filter(([key])=>!['administratorUid','administratorUids'].includes(key))))
const canSaveAdministrator=computed(()=>Boolean(editing.value&&selected.value?.kind==='channel'&&accountId.value&&characterId.value===boundCharacterId.value&&administratorSupported.value&&window.sandbook?.setChannelAdministrator&&!channelBusy.value&&administratorUid.value.trim()!==administratorBaseline.value))
const nativeAdministrator=computed(()=>Boolean(window.sandbook?.setChannelAdministrator))
const administratorHint=computed(()=>!administratorSupported.value?'插件未提供管理员协议，频道权限不可启用。':!accountId.value?'先保存账号，再设置管理员 UID。':characterId.value!==boundCharacterId.value?'先保存角色绑定，再设置管理员 UID。':!window.sandbook?.setChannelAdministrator?'请在桌面应用中设置管理员。':administratorBaseline.value?'已绑定管理员 UID':'未设置管理员 UID，频道权限不可启用。')
watch(characterId,(value,previous)=>{if(editing.value&&value!==previous){administratorUid.value='';administratorError.value=''}},{flush:'sync'})
function supportsAdministratorProtocol(value:any){return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===4&&value.version===1&&value.field==='administratorUid'&&value.scope==='character-account'&&value.managedBy==='host')}
const selected=computed(()=>plugins.value.find(plugin=>plugin.id===opened.value)),filtered=computed(()=>plugins.value.filter(plugin=>`${plugin.name} ${plugin.id}`.toLowerCase().includes(query.value.toLowerCase())))
const isEmpty=computed(()=>loaded.value&&!plugins.value.length)
let pendingPluginTarget=Boolean(props.targetPluginId)
function consumePluginTarget(){if(!pendingPluginTarget)return;const target=plugins.value.find(plugin=>plugin.id===props.targetPluginId);if(target){pendingPluginTarget=false;selectPlugin(target)}}
watch(()=>[props.targetPluginId,props.targetRequest],()=>{pendingPluginTarget=true;consumePluginTarget()},{flush:'post'})
watch(plugins,consumePluginTarget,{flush:'post'})
let refreshQueued=false
let sequence=0,disposed=false,poll:ReturnType<typeof setInterval>|undefined
function message(error:unknown,extra:string[]=[]){let result=error&&typeof error==='object'&&'message' in error?String(error.message):String(error);const secrets=[...extra];for(const plugin of plugins.value)for(const [key,schema] of Object.entries(plugin.configSchema??{}))if(schema.type==='secret'&&drafts.value[plugin.id]?.[key])secrets.push(String(drafts.value[plugin.id][key]));for(const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length))result=result.split(secret).join('[已隐藏密钥]');return result}
async function load(){
  const current=++sequence;loading.value=true
  try{const previousSelection=opened.value;const result=await request<{plugins:ClientPlugin[]}>('/plugins');if(disposed||current!==sequence)return false;if(!Array.isArray(result.plugins))throw new Error('插件列表格式无效');plugins.value=result.plugins;if(!plugins.value.some(plugin=>plugin.id===opened.value)&&plugins.value.length){selectPlugin(plugins.value[0]);mobileDetail.value=false}loaded.value=true;loadError.value='';const currentPlugin=selected.value;if(currentPlugin?.id===previousSelection&&currentPlugin?.kind==='channel'&&!currentPlugin.ui)void loadAccounts(currentPlugin);return true}
  catch(error){if(!disposed&&current===sequence)loadError.value=message(error);return false}
  finally{if(current===sequence){loading.value=false;const queued=refreshQueued;refreshQueued=false;if(queued&&!disposed&&props.active)void load()}}
}
function refreshPlugins(){if(loading.value){refreshQueued=true;return}void load()}
watch(()=>props.active,active=>{clearInterval(poll);if(active){void load();poll=setInterval(()=>{if(!loading.value)void load()},5000)}},{immediate:true})
watch(()=>props.refreshKey,()=>{if(props.active)refreshPlugins()})
onBeforeUnmount(()=>{disposed=true;sequence++;clearInterval(poll)})
function initialConfig(plugin:ClientPlugin){return Object.fromEntries(Object.entries(plugin.configSchema??{}).map(([key,schema])=>[key,schema.type==='secret'?'':plugin.config?.[key]??schema.default??(schema.type==='boolean'?false:'')]))}
function selectPlugin(plugin:ClientPlugin){if(channelBusy.value)return;if(selected.value?.id==='suna-dsh-plugins'&&plugin.id!==opened.value&&managerDirty.value){pendingManagerTarget.value=plugin;mobileDetail.value=true;return}pendingManagerTarget.value=undefined;if(editing.value&&selected.value?.kind==='channel'){if(opened.value!==plugin.id)emit('notice','请先保存或取消当前配置');mobileDetail.value=true;return}mobileDetail.value=true;opened.value=plugin.id;editing.value=false;channelError.value='';if(!drafts.value[plugin.id])drafts.value[plugin.id]=initialConfig(plugin);if(plugin.kind==='channel'&&!plugin.ui)void loadAccounts(plugin)}
async function rpc(plugin:ClientPlugin,method:string,params:Record<string,unknown>={}){return request(`/plugins/${encodeURIComponent(plugin.id)}/ui/rpc`,{method,params})}
async function loadAccounts(plugin:ClientPlugin){try{const result=await rpc(plugin,'context');if(!disposed&&selected.value?.id===plugin.id)channelAccounts.value=result.accounts}catch(error){channelError.value=message(error)}}
async function configureChannel(key?:string){if(editing.value)return;const plugin=selected.value;if(!plugin)return;if(plugin.kind==='ttuf'){editing.value=true;return}channelError.value='';try{const context=await rpc(plugin,'context');if(selected.value?.id!==plugin.id)return;const account=key?context.accounts.find((item:any)=>item.accountId===key):undefined;if(key&&!account)throw new Error('账号不存在');accountId.value=key;characterId.value=account?.characterId??props.state.characters[0]?.id??'';boundCharacterId.value=characterId.value;administratorSupported.value=account?account.administratorStatus?.supported===true:supportsAdministratorProtocol(context.plugin?.administratorProtocol);administratorUid.value=typeof account?.administratorUid==='string'?account.administratorUid:'';administratorBaseline.value=administratorUid.value;administratorError.value='';channelSecrets.value=account?.configuredSecrets??[];channelDraft.value=initialConfig({...plugin,config:account?.config??{}});editing.value=true}catch(error){channelError.value=message(error)}}
async function saveChannel(){const plugin=selected.value;if(!plugin||channelBusy.value)return;channelBusy.value=true;channelError.value='';try{const config=Object.fromEntries(Object.entries(channelDraft.value).filter(([key,value])=>!['administratorUid','administratorUids'].includes(key)&&(plugin.configSchema[key]?.type!=='secret'||value!=='')));await rpc(plugin,accountId.value?'channels.update':'channels.create',{accountId:accountId.value,characterId:characterId.value,config});const keepAdministratorDraft=Boolean(accountId.value&&characterId.value===boundCharacterId.value&&administratorUid.value.trim()!==administratorBaseline.value);editing.value=keepAdministratorDraft;if(!keepAdministratorDraft)channelDraft.value={};emit('refresh');emit('notice',keepAdministratorDraft?'渠道配置已保存，管理员 UID 尚未保存':'渠道配置已保存');await loadAccounts(plugin)}catch(error){channelError.value=message(error,Object.entries(plugin.configSchema).filter(([,field])=>field.type==='secret').map(([key])=>String(channelDraft.value[key]??'')))}finally{channelBusy.value=false}}
async function saveAdministrator(){
 const write=window.sandbook?.setChannelAdministrator,plugin=selected.value;if(!canSaveAdministrator.value||!write||!plugin||!accountId.value)return false
 const binding={pluginId:plugin.id,accountId:accountId.value,characterId:boundCharacterId.value,administratorUid:administratorUid.value.trim()};channelBusy.value=true;administratorError.value=''
 try{const saved=await write(binding);if(!saved||saved.accountId!==binding.accountId||saved.characterId!==binding.characterId||typeof saved.administratorUid!=='string')throw new Error('管理员保存回执无效，请重新读取账号。');if(!disposed&&selected.value?.id===binding.pluginId&&accountId.value===binding.accountId&&boundCharacterId.value===binding.characterId){administratorBaseline.value=saved.administratorUid;administratorUid.value=saved.administratorUid;channelAccounts.value=channelAccounts.value.map(account=>account.accountId===saved.accountId?{...account,...saved}:account);emit('refresh');emit('notice',saved.administratorUid?'管理员 UID 已保存':'管理员 UID 已清除')}return true}catch(error){if(!disposed)administratorError.value=message(error);return false}finally{channelBusy.value=false}
}
async function accountCommand(key:string,action:string){const plugin=selected.value;if(!plugin)return;channelBusy.value=true;try{await rpc(plugin,`channels.${action}`,{accountId:key});await loadAccounts(plugin);emit('refresh')}catch(error){channelError.value=message(error)}finally{channelBusy.value=false}}
async function showQr(key:string,refresh=true){const plugin=qrOpen.value?qrPlugin.value:selected.value;if(!plugin)return;channelBusy.value=true;channelError.value='';try{const result=await rpc(plugin,refresh?'channels.qr':'channels.poll',{accountId:key});qrPlugin.value=plugin;qrAccount.value=key;qrOpen.value=true;qrStatus.value=result.status;qrImage.value='';if(result.qrImage?.startsWith('data:image/'))qrImage.value=result.qrImage;else if(result.qrContent){const QRCode=await import('qrcode');qrImage.value=await QRCode.toDataURL(result.qrContent,{width:240,margin:2})}if(result.error)channelError.value=result.error}catch(error){channelError.value=message(error)}finally{channelBusy.value=false}}
function canStart(plugin:ClientPlugin){return plugin.kind==='ttuf'&&['stopped','failed','installed'].includes(plugin.status)}
function configPayload(plugin:ClientPlugin){
  const config:Record<string,PluginConfigValue>={}
  for(const [key,schema] of Object.entries(plugin.configSchema??{})){
    if(!fieldTypes.has(schema.type))throw new Error(`不支持的配置字段：${schema.label??key}`)
    const value=drafts.value[plugin.id]?.[key]??''
    if(schema.type==='secret'&&value===''){if(schema.required&&!plugin.hasSecrets?.includes(key))throw new Error(`请填写${schema.label??key}`);continue}
    if(schema.required&&value==='')throw new Error(`请填写${schema.label??key}`)
    if(schema.type==='number'){if(value==='')continue;const number=Number(value);if(!Number.isFinite(number))throw new Error(`${schema.label??key}必须是数字`);config[key]=number}
    else if(schema.type==='boolean')config[key]=value===true
    else config[key]=value
  }
  return config
}
async function saveConfig(plugin:ClientPlugin){
  if(busy.value[plugin.id]||plugin.kind!=='ttuf')return false
  errors.value[plugin.id]='';let config:Record<string,PluginConfigValue>
  try{config=configPayload(plugin)}catch(error){errors.value[plugin.id]=message(error);return false}
  const before={...drafts.value[plugin.id]},secrets=Object.entries(plugin.configSchema??{}).filter(([,schema])=>schema.type==='secret').map(([key])=>String(config[key]??''))
  busy.value[plugin.id]='save'
  try{
    await request(`/plugins/${encodeURIComponent(plugin.id)}/config`,{config},'PATCH')
    if(disposed)return false
    const refreshed=await load(),saved=plugins.value.find(item=>item.id===plugin.id)
    if(refreshed&&saved){const values=initialConfig(saved);for(const key of Object.keys(before))if(Object.is(drafts.value[plugin.id][key],before[key]))drafts.value[plugin.id][key]=values[key]??''}
    emit('refresh');emit('notice','插件配置已保存');return true
  }catch(error){if(!disposed)errors.value[plugin.id]=message(error,secrets);return false}
  finally{delete busy.value[plugin.id]}
}
async function command(plugin:ClientPlugin,action:'start'|'stop'){
  if(busy.value[plugin.id]||plugin.kind!=='ttuf'||(action==='start'?!canStart(plugin):plugin.status!=='running'))return false
  busy.value[plugin.id]=action;errors.value[plugin.id]=''
  try{await request(`/plugins/${encodeURIComponent(plugin.id)}/${action}`,{});if(disposed)return false;await load();emit('refresh');return true}
  catch(error){if(!disposed)errors.value[plugin.id]=message(error);return false}
  finally{delete busy.value[plugin.id]}
}
async function install(event:Event){
  const input=event.target as HTMLInputElement,selected=input.files?.[0];if(!selected||importBusy.value)return
  importBusy.value=true;importError.value=''
  try{await upload('/plugins/import',selected);if(disposed)return;await load();emit('refresh');emit('notice','插件已导入')}
  catch(error){if(!disposed)importError.value=message(error)}
  finally{importBusy.value=false;input.value=''}
}
</script>
<template>
<section class="plugins-page page-view business-page" :class="{'show-detail':mobileDetail}">
 <ResizableSidebar name="插件列表" storage-key="plugins" :width="238" :min="180" :max="380"><aside class="plugin-list" aria-label="插件列表">
  <div class="plugin-search-row"><label class="plugin-search"><Icon name="search" :size="16"/><input v-model="query" aria-label="搜索插件" placeholder="搜索插件"/></label><button class="icon-button" aria-label="导入插件" data-tooltip="导入插件" :disabled="importBusy" @click="file?.click()"><Icon name="plus" :size="18"/></button><button class="icon-button" aria-label="刷新插件" data-tooltip="刷新" :disabled="loading" @click="load"><Icon name="refresh" :size="16"/></button><input ref="file" hidden type="file" accept=".zip" @change="install"/></div>
  <p v-if="loadError||importError" class="inline-error" role="alert">{{loadError||importError}}</p>
  <div class="plugin-list-items"><button v-for="plugin in filtered" :key="plugin.id" class="plugin-cell" :class="{selected:opened===plugin.id}" :aria-current="opened===plugin.id?'true':undefined" @click="selectPlugin(plugin)"><span class="plugin-symbol"><img v-if="platformLogo(plugin.id)" class="plugin-logo" :src="platformLogo(plugin.id)" alt="" width="28" height="28"/><Icon v-else class="plugin-fallback-icon" name="plugin" :size="24"/><span class="plugin-type-badge" role="img" :aria-label="plugin.kind==='client'?'管理插件':plugin.kind==='channel'?'Channel 插件':'TTUF 插件'"><Icon :name="plugin.kind==='client'?'settings':plugin.kind==='channel'?'plug':'code'" :size="11"/></span></span><span class="plugin-cell-copy"><span>{{plugin.name}}</span><small>{{statusLabels[plugin.status]??plugin.status}}</small></span></button><p v-if="!filtered.length" class="plugin-empty">{{isEmpty?'未安装插件':loaded?'没有匹配的插件':'正在读取插件…'}}</p></div>
 </aside></ResizableSidebar>
 <section v-if="selected" :key="selected.id" class="plugin-detail" aria-label="插件详情">
  <header class="plugin-detail-heading"><button class="icon-button mobile-back" aria-label="返回插件列表" @click="mobileDetail=false"><Icon name="back" :size="18"/></button><div><h1>{{selected.name}}</h1><span class="plugin-meta">{{selected.version}} · {{selected.kind==='client'?'管理插件':selected.kind==='channel'?'渠道插件':'脚本插件'}} · {{statusLabels[selected.status]}}</span></div><div class="button-row"><button v-if="selected.kind==='channel'&&selected.id!=='suna-napcat'" class="button" :disabled="editing" @click="configureChannel()"><Icon name="plus" :size="16"/>添加账号</button><button v-if="selected.ui&&selected.kind==='ttuf'" class="button" @click="editing=!editing"><Icon :name="editing?'back':'settings'" :size="16"/>{{editing?'返回详情':'配置'}}</button><button v-if="selected.kind==='ttuf'" class="button" :disabled="Boolean(busy[selected.id])||(!canStart(selected)&&selected.status!=='running')" @click="command(selected,selected.status==='running'?'stop':'start')"><Icon :name="selected.status==='running'?'stop':'play'" :size="15"/>{{selected.status==='running'?'停止':'启动'}}</button></div></header>
  <div v-if="pendingManagerTarget" class="manager-leave-guard" role="group" aria-label="未保存修改"><p>有未保存的修改</p><div class="button-row"><button class="button" @click="pendingManagerTarget=undefined">继续编辑</button><button class="button" @click="discardManagerAndLeave">放弃修改并离开</button></div></div>
  <p v-if="selected.error||errors[selected.id]||channelError" class="detail-error inline-error" role="alert">{{selected.error?message(selected.error):errors[selected.id]||channelError}}</p>
  <div v-if="editing&&selected.kind==='channel'" class="plugin-detail-scroll"><form class="plugin-config" @submit.prevent="saveChannel"><div class="form-heading"><h2>{{accountId?'编辑账号':'添加账号'}}</h2><button type="button" class="button" :disabled="channelBusy" @click="editing=false;channelDraft={}">取消</button><button class="button primary" :disabled="channelBusy||!characterId"><Icon name="save" :size="16"/>{{channelBusy?'保存中…':'保存配置'}}</button></div><label class="field character-field">绑定角色<CustomSelect v-model="characterId" aria-label="绑定角色" :options="state.characters.map(person=>({value:person.id,label:person.name}))" :disabled="channelBusy"/></label><section class="channel-administrator" aria-label="频道管理员"><div class="administrator-fields"><label class="field">管理员 UID<input v-model="administratorUid" type="text" maxlength="128" autocomplete="off" placeholder="未设置" :disabled="channelBusy||!administratorSupported||!accountId||characterId!==boundCharacterId||!nativeAdministrator"/></label><button type="button" class="button" :disabled="!canSaveAdministrator" @click="saveAdministrator"><Icon name="save" :size="16"/>保存管理员</button></div><p class="administrator-hint" role="status">{{administratorHint}}</p><p v-if="administratorError" class="inline-error" role="alert">{{administratorError}}</p></section><PluginConfigFields v-model="channelDraft" :schema="channelSchema" :state="state" :has-secrets="channelSecrets"/></form></div>
  <PluginFrame v-else-if="selected.ui&&(active||selected.id==='suna-dsh-plugins')&&!editing" :key="`${selected.id}-${selected.version}`" :plugin-id="selected.id" :version="selected.version" :active="active" @dirty="managerDirty=$event" @configure="configureChannel" @changed="emit('refresh')"/>
  <div v-else class="plugin-detail-scroll">
   <template v-if="selected.kind==='ttuf'"><p v-if="selected.description" class="plugin-description">{{selected.description}}</p><form v-if="drafts[selected.id]" class="plugin-config" @submit.prevent="saveConfig(selected)"><div class="form-heading"><h2>配置</h2><button type="submit" class="button primary" :disabled="Boolean(busy[selected.id])||selected.status==='running'"><Icon name="save" :size="16"/>{{busy[selected.id]==='save'?'保存中…':'保存配置'}}</button></div><PluginConfigFields v-model="drafts[selected.id]" :schema="selected.configSchema" :state="state" :has-secrets="selected.hasSecrets"/></form></template>
   <template v-else><p v-if="!channelAccounts.length" class="plugin-empty">未添加账号</p><article v-for="account in channelAccounts" :key="account.accountId" class="channel-row"><div>{{state.characters.find(c=>c.id===account.characterId)?.name??account.accountId}}<span class="plugin-meta">{{account.status==='connected'?'已连接':'未连接'}}</span></div><button class="button" @click="configureChannel(account.accountId)"><Icon name="settings" :size="16"/>配置</button><button class="button" :disabled="channelBusy" @click="accountCommand(account.accountId,account.status==='connected'?'disconnect':'connect')"><Icon :name="account.status==='connected'?'disconnect':'plug'" :size="16"/>{{account.status==='connected'?'断开连接':'连接'}}</button><button v-if="selected.capabilities?.includes('login-qr')" class="button" :disabled="channelBusy" @click="showQr(account.accountId)"><Icon name="qr" :size="16"/>扫码登录</button></article></template>
  </div>
 </section>
 <div v-else class="plugin-empty">选择插件</div>
<Modal :open="qrOpen" title="账号登录" @close="qrOpen=false"><div class="qr-content"><img v-if="qrImage" :src="qrImage" alt="账号登录二维码" width="240" height="240"/><p>{{({wait:'等待扫码',scaned:'已扫码，等待确认',confirmed:'已确认登录',connected:'已连接',expired:'二维码已过期'} as Record<string,string>)[qrStatus]??qrStatus}}</p><div class="button-row"><button class="button" :disabled="channelBusy" @click="showQr(qrAccount)"><Icon name="refresh" :size="16"/>刷新二维码</button><button class="button" :disabled="channelBusy" @click="showQr(qrAccount,false)"><Icon name="shield" :size="16"/>检查登录</button></div></div></Modal>
</section>
</template>
<style src="../business-components.css"></style>

<style scoped>
.manager-leave-guard{padding:12px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.manager-leave-guard p{margin:0;font-size:14px;line-height:20px}
</style>
