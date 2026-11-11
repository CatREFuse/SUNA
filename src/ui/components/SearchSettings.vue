<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {request} from '../api'
import CustomSelect from './CustomSelect.vue'
import ToggleSwitch from './ToggleSwitch.vue'
import TooltipButton from './TooltipButton.vue'
import Icon from './Icon.vue'
import SettingsGroup from './SettingsGroup.vue'
import type {OperationState,ProviderId,SearchStatus} from './web-access-types'
type OperationId='search'|'fetch'
type ProviderStatus=SearchStatus['operations'][OperationId]['providers'][number]
type Draft={enabled:boolean;apiKey:string;baseURL:string;baseline:{enabled:boolean;baseURL:string};version:number;loaded:boolean}
const props=defineProps<{active:boolean}>(),emit=defineEmits<{refresh:[];notice:[string]}>()
const operationIds:OperationId[]=['search','fetch']
const supported:Record<OperationId,ProviderId[]>={search:['tavily','deepseek'],fetch:['deepseek']}
const defaultBaseURL={tavily:'https://api.tavily.com/search',deepseek:'https://api.deepseek.com/v1/tools'}
const providerName=(id?:ProviderId)=>id==='deepseek'?'DeepSeek':id==='tavily'?'Tavily':'未记录服务'
const operationName=(id:OperationId)=>id==='search'?'Search':'Fetch'
const drafts=ref<Record<OperationId,Partial<Record<ProviderId,Draft>>>>({search:{},fetch:{}})
const orderDraft=ref<Record<OperationId,ProviderId[]>>({search:[],fetch:[]}),orderBaseline=ref<Record<OperationId,ProviderId[]>>({search:[],fetch:[]}),orderVersion=ref({search:0,fetch:0})
const selectedOperation=ref<OperationId>('search'),selectedProvider=ref<ProviderId>('tavily'),searchStatus=ref<SearchStatus>(),compatible=ref(false),loading=ref(false),saving=ref(false),loadError=ref('')
const errors=ref<Record<OperationId,string>>({search:'',fetch:''}),orderError=ref<Record<OperationId,string>>({search:'',fetch:''})
const addSelection=ref<Record<OperationId,ProviderId>>({search:'tavily',fetch:'deepseek'}),pendingRemoval=ref<{operation:OperationId;provider:ProviderId}>(),announcement=ref(''),orderElement=ref<HTMLElement>()
const busy=computed(()=>loading.value||saving.value)
const draft=computed(()=>drafts.value[selectedOperation.value][selectedProvider.value])
const currentProvider=computed(()=>searchStatus.value?.operations[selectedOperation.value].providers.find(row=>row.id===selectedProvider.value))
const error=computed(()=>errors.value[selectedOperation.value]||loadError.value)
function dirty(value?:Draft){return Boolean(value&&(value.enabled!==value.baseline.enabled||value.baseURL!==value.baseline.baseURL||value.apiKey.trim()))}
const searchDirty=computed(()=>dirty(draft.value))
function orderIsDirty(operation:OperationId){return orderDraft.value[operation].join()!==orderBaseline.value[operation].join()}
const orderDirty=computed(()=>orderIsDirty(selectedOperation.value))
const versionChanged=computed(()=>Boolean(draft.value&&searchStatus.value&&draft.value.version!==searchStatus.value.version))
function orderIsStale(operation:OperationId){return Boolean(searchStatus.value&&orderVersion.value[operation]!==searchStatus.value.version)}
const orderVersionChanged=computed(()=>orderIsStale(selectedOperation.value))
const searchCanEnable=computed(()=>Boolean(currentProvider.value?.hasApiKey||draft.value?.apiKey.trim()))
function baseURLValid(value:string){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash}catch{return false}}
const invalidBaseURL=computed(()=>Boolean(draft.value&&selectedProvider.value==='deepseek'&&!baseURLValid(draft.value.baseURL.trim())))
const canSave=computed(()=>compatible.value&&!busy.value&&Boolean(draft.value?.loaded)&&!versionChanged.value&&!invalidBaseURL.value&&(!draft.value?.enabled||searchCanEnable.value)&&searchDirty.value)
const canSaveOrder=computed(()=>compatible.value&&!busy.value&&Boolean(searchStatus.value)&&orderDirty.value&&!orderVersionChanged.value)
let generation=0,disposed=false
const secrets=new Set<string>()
const reasonLabels:Record<string,string>={
  SEARCH_AUTH_FAILED:'凭据验证失败，请更新 API Key 后重试。',
  SEARCH_BALANCE_REQUIRED:'账户余额不足，请补充余额后重试。',
  SEARCH_FETCH_POLICY_DENIED:'服务安全策略拒绝读取，请尝试其他网页。',
  SEARCH_FETCH_UNAVAILABLE:'网页不可提取，请尝试其他网页。',
  SEARCH_LIMIT_REACHED:'请求过于频繁或额度受限，请检查额度或稍后重试。',
  SEARCH_UPSTREAM_TIMEOUT:'上游请求超时，请稍后重试。',
  SEARCH_TIMEOUT:'请求超时，请稍后重试。',
  SEARCH_RESPONSE_TOO_LARGE:'服务响应过大，请缩小查询范围或尝试其他网页。',
  SEARCH_RESPONSE_INVALID:'服务返回内容无效，请检查 Base URL 或稍后重试。',
  SEARCH_REDIRECT_REJECTED:'服务重定向已拒绝，请检查 Base URL。',
  SEARCH_NETWORK_FAILED:'无法连接服务，请检查网络与 Base URL 后重试。',
  SEARCH_PROVIDER_FAILED:'服务请求失败，请检查配置或稍后重试。',
  SEARCH_BUSY:'请求较多，请稍后重试。',
  SEARCH_CANCELLED:'调用已取消，可重新尝试。',
  SEARCH_CLOSED:'网页服务已关闭，请重新打开设置后重试。',
  SEARCH_API_KEY_REQUIRED:'请填写 API Key 后保存并启用。',
  SEARCH_DISABLED:'网页服务已停用，请保存并启用后重试。',
  WEBFETCH_UNSUPPORTED:'当前 Provider 不支持网页读取，请切换 Provider。',
}
function safeText(error:unknown){
 const code=error&&typeof error==='object'&&'code' in error?String(error.code):''
 let text=reasonLabels[code]??(error&&typeof error==='object'&&'message' in error?String(error.message):String(error))
 for(const [reason,label] of Object.entries(reasonLabels))text=text.split(reason).join(label)
 const values=[...secrets,...Object.values(drafts.value).flatMap(group=>Object.values(group).flatMap(value=>value?[value.apiKey,value.apiKey.trim()]:[]))].filter(Boolean).sort((a,b)=>b.length-a.length)
 for(const value of values)text=text.split(value).join('[已隐藏密钥]')
 return text.replace(/Bearer\s+[^\s,;]+/gi,'Bearer [已隐藏密钥]')
}
function validStatus(value:unknown):value is SearchStatus{
 if(!value||typeof value!=='object')return false
 const status=value as SearchStatus
 if(status.schemaVersion!==4||!Number.isInteger(status.version)||status.version<0||!status.operations)return false
 return operationIds.every(operation=>{const group=status.operations[operation];if(!group||typeof group.enabled!=='boolean'||!Array.isArray(group.order)||!Array.isArray(group.providers)||!Array.isArray(group.supportedProviders)||!group.state)return false
 const ids=group.providers.map(row=>row?.id)
 return new Set(ids).size===ids.length&&ids.every(id=>supported[operation].includes(id))&&group.order.length===ids.length&&new Set(group.order).size===ids.length&&group.order.every(id=>ids.includes(id))&&group.providers.every(row=>typeof row.enabled==='boolean'&&typeof row.hasApiKey==='boolean'&&typeof row.baseURL==='string'&&Boolean(row.state))
 })
}
function copyProvider(provider:ProviderStatus,version:number):Draft{return {enabled:provider.enabled,apiKey:'',baseURL:provider.baseURL,baseline:{enabled:provider.enabled,baseURL:provider.baseURL},version,loaded:true}}
function acceptRead(value:unknown){
 if(!validStatus(value)){compatible.value=false;loadError.value='当前服务版本不支持独立的 Search / Fetch 配置，请更新并重启应用服务后重新读取。已有修改已保留。';return false}
 if(searchStatus.value&&value.version<searchStatus.value.version)return false
 compatible.value=true;loadError.value=''
 for(const operation of operationIds){const group=value.operations[operation]
 if(!orderIsDirty(operation)){orderDraft.value[operation]=[...group.order];orderBaseline.value[operation]=[...group.order];orderVersion.value[operation]=value.version}
 for(const provider of group.providers){const local=drafts.value[operation][provider.id];if(!local||!dirty(local))drafts.value[operation][provider.id]=copyProvider(provider,value.version)}
 for(const id of Object.keys(drafts.value[operation]) as ProviderId[])if(!group.providers.some(row=>row.id===id)&&!dirty(drafts.value[operation][id]))delete drafts.value[operation][id]
 }
 searchStatus.value=value;syncAddSelection();return true
}
async function loadSearch(){
 if(busy.value||disposed)return false
 const key=++generation;loading.value=true;loadError.value=''
 try{const status=await request<unknown>('/search/status');return key===generation&&!disposed?acceptRead(status):false}
 catch(error){if(key===generation&&!disposed)loadError.value=safeText(error);return false}
 finally{if(key===generation&&!disposed)loading.value=false}
}
function applyMutation(status:SearchStatus,previousVersion:number,skip?:{operation:OperationId;provider:ProviderId}){
 for(const operation of operationIds){const group=status.operations[operation]
 if(!orderIsDirty(operation)){orderDraft.value[operation]=[...group.order];orderBaseline.value[operation]=[...group.order];orderVersion.value[operation]=status.version}
 else if(orderVersion.value[operation]===previousVersion){orderBaseline.value[operation]=[...group.order];orderVersion.value[operation]=status.version}
 for(const provider of group.providers){if(skip?.operation===operation&&skip.provider===provider.id)continue
 const local=drafts.value[operation][provider.id]
 if(!local||!dirty(local))drafts.value[operation][provider.id]=copyProvider(provider,status.version)
 else if(local.version===previousVersion)local.version=status.version
 }
 }
 searchStatus.value=status;compatible.value=true;syncAddSelection()
}
async function mutate(operation:OperationId,body:Record<string,unknown>,onSuccess:(status:SearchStatus)=>void){
 if(!compatible.value||busy.value||dragging.value||disposed||!searchStatus.value)return false
 const key=++generation;saving.value=true;errors.value[operation]='';loadError.value=''
 try{const status=await request<unknown>('/search/settings',{operation,...body},'PATCH')
 if(key!==generation||disposed)return false
 if(!validStatus(status)){compatible.value=false;throw new Error('服务返回的配置协议不兼容，请更新并重启应用服务后重新读取。已有修改已保留。')}
 if(status.version<=Number(body.expectedVersion)||(searchStatus.value&&status.version<searchStatus.value.version))throw new Error('保存结果未确认新版本，请刷新状态。已有修改已保留。')
 onSuccess(status);emit('refresh');return true
 }catch(error){if(key===generation&&!disposed)errors.value[operation]=safeText(error);return false}
 finally{if(key===generation&&!disposed)saving.value=false}
}
function selectProvider(operation:OperationId,id:ProviderId){selectedOperation.value=operation;selectedProvider.value=id}
function syncAddSelection(){for(const operation of operationIds){const options=availableOptions(operation);if(!options.some(row=>row.value===addSelection.value[operation])&&options[0])addSelection.value[operation]=options[0].value}}
function availableOptions(operation:OperationId){return supported[operation].filter(id=>!searchStatus.value?.operations[operation].providers.some(row=>row.id===id)).map(value=>({value,label:providerName(value)}))}
async function addProvider(id:ProviderId,operation=selectedOperation.value){
 if(!compatible.value||!searchStatus.value||!supported[operation].includes(id)||searchStatus.value.operations[operation].providers.some(row=>row.id===id))return false
 const expectedVersion=searchStatus.value.version
 const selection={operation:selectedOperation.value,provider:selectedProvider.value}
 return mutate(operation,{action:'add',provider:id,expectedVersion},status=>{if(!status.operations[operation].providers.some(row=>row.id===id))throw new Error('服务未返回新增配置，请刷新状态');applyMutation(status,expectedVersion);if(selectedOperation.value===selection.operation&&selectedProvider.value===selection.provider)selectProvider(operation,id);emit('notice',`${operationName(operation)} 已添加 ${providerName(id)}`)})
}
async function removeProvider(id:ProviderId,operation=selectedOperation.value){
 if(!compatible.value||!searchStatus.value||!searchStatus.value.operations[operation].providers.some(row=>row.id===id))return false
 const expectedVersion=searchStatus.value.version
 return mutate(operation,{action:'remove',provider:id,expectedVersion},status=>{if(status.operations[operation].providers.some(row=>row.id===id))throw new Error('服务未确认移除，请刷新状态');applyMutation(status,expectedVersion);delete drafts.value[operation][id];orderDraft.value[operation]=orderDraft.value[operation].filter(row=>row!==id);pendingRemoval.value=undefined;emit('notice',`${operationName(operation)} 已移除 ${providerName(id)}`)})
}
async function setOperationEnabled(enabled:boolean,operation=selectedOperation.value){
 if(!compatible.value||!searchStatus.value)return false
 const expectedVersion=searchStatus.value.version
 return mutate(operation,{action:'set-enabled',enabled,expectedVersion},status=>applyMutation(status,expectedVersion))
}
async function saveSearch(clearApiKey=false){
 const operation=selectedOperation.value,id=selectedProvider.value,value=drafts.value[operation][id]
 if(!compatible.value||!value||busy.value||disposed||value.version!==searchStatus.value?.version||(!clearApiKey&&!canSave.value))return false
 const submitted={enabled:value.enabled,apiKey:value.apiKey,baseURL:value.baseURL},expectedVersion=value.version
 for(const secret of [submitted.apiKey,submitted.apiKey.trim()])if(secret)secrets.add(secret)
 const body={action:'update',provider:id,expectedVersion,...(clearApiKey?{enabled:false,clearApiKey:true}:{enabled:submitted.enabled,...(id==='deepseek'?{baseURL:submitted.baseURL.trim()}:{}),...(submitted.apiKey.trim()?{apiKey:submitted.apiKey.trim()}:{})})}
 return mutate(operation,body,status=>{const saved=status.operations[operation].providers.find(row=>row.id===id);if(!saved)throw new Error('服务未返回保存的配置，请刷新状态')
 applyMutation(status,expectedVersion,{operation,provider:id})
 if(value.enabled===submitted.enabled)value.enabled=saved.enabled
 if(!clearApiKey&&value.baseURL===submitted.baseURL)value.baseURL=saved.baseURL
 if(value.apiKey===submitted.apiKey)value.apiKey=''
 value.baseline={enabled:saved.enabled,baseURL:saved.baseURL};value.version=status.version;value.loaded=true
 emit('notice',clearApiKey?'密钥已清除':'服务配置已保存')
 })
}
function keepDraftWithLatestVersion(){if(!compatible.value||busy.value||!searchStatus.value||!draft.value||!currentProvider.value)return
 const value=draft.value,saved=currentProvider.value
 if(value.enabled===value.baseline.enabled)value.enabled=saved.enabled
 if(value.baseURL===value.baseline.baseURL)value.baseURL=saved.baseURL
 value.baseline={enabled:saved.enabled,baseURL:saved.baseURL};value.version=searchStatus.value.version;errors.value[selectedOperation.value]=''
}
function discardDraft(){if(compatible.value&&!busy.value&&searchStatus.value&&currentProvider.value){drafts.value[selectedOperation.value][selectedProvider.value]=copyProvider(currentProvider.value,searchStatus.value.version);errors.value[selectedOperation.value]=''}}
function discardOrder(operation=selectedOperation.value){if(!compatible.value||busy.value||!searchStatus.value)return;orderDraft.value[operation]=[...searchStatus.value.operations[operation].order];orderBaseline.value[operation]=[...orderDraft.value[operation]];orderVersion.value[operation]=searchStatus.value.version;orderError.value[operation]=''}
function keepOrderWithLatestVersion(operation=selectedOperation.value){if(!compatible.value||busy.value||!searchStatus.value)return;orderBaseline.value[operation]=[...searchStatus.value.operations[operation].order];orderVersion.value[operation]=searchStatus.value.version;orderError.value[operation]=''}
async function saveOrder(operation=selectedOperation.value){
 if(!compatible.value||busy.value||!searchStatus.value||!orderIsDirty(operation)||orderIsStale(operation))return false
 const submitted=[...orderDraft.value[operation]],expectedVersion=orderVersion.value[operation]
 return mutate(operation,{action:'reorder',order:submitted,expectedVersion},status=>{if(orderDraft.value[operation].join()===submitted.join())orderDraft.value[operation]=[...status.operations[operation].order]
 applyMutation(status,expectedVersion);orderBaseline.value[operation]=[...status.operations[operation].order];orderVersion.value[operation]=status.version;emit('notice',`${operationName(operation)} 顺序已保存`)
 })
}
function moveTo(operation:OperationId,id:ProviderId,to:number){if(!compatible.value||busy.value)return
 const list=orderDraft.value[operation],from=list.indexOf(id);to=Math.max(0,Math.min(list.length-1,to));if(from<0||from===to)return
 list.splice(from,1);list.splice(to,0,id);announcement.value=`${operationName(operation)} ${providerName(id)} 已移至第 ${to+1} 位`
}
async function moveProvider(id:ProviderId,step:number,operation=selectedOperation.value){moveTo(operation,id,orderDraft.value[operation].indexOf(id)+step);await nextTick()}
function reorderKey(event:KeyboardEvent,operation:OperationId,id:ProviderId){if(event.key==='Escape'&&dragging.value){event.preventDefault();finishDrag(undefined,true);return}if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return
 const index=orderDraft.value[operation].indexOf(id),to=event.key==='ArrowUp'?index-1:event.key==='ArrowDown'?index+1:event.key==='Home'?0:event.key==='End'?orderDraft.value[operation].length-1:undefined
 if(to===undefined)return;event.preventDefault();moveTo(operation,id,to);void nextTick(()=>orderElement.value?.querySelector<HTMLButtonElement>(`[data-handle="${operation}:${id}"]`)?.focus())
}
type Drag={operation:OperationId;id:ProviderId;pointerId:number;before:ProviderId[];element:HTMLElement}
const dragging=ref<Drag>()
function beginDrag(event:PointerEvent,operation:OperationId,id:ProviderId){if(dragging.value||!compatible.value||busy.value||event.button!==0||orderDraft.value[operation].length<2)return
 event.preventDefault();const element=orderElement.value&&typeof orderElement.value.setPointerCapture==='function'?orderElement.value:event.currentTarget as HTMLElement;dragging.value={operation,id,pointerId:event.pointerId,before:[...orderDraft.value[operation]],element};element.setPointerCapture(event.pointerId)
}
function dragMove(event:PointerEvent){const drag=dragging.value;if(!drag||event.pointerId!==drag.pointerId)return
 const rows=[...orderElement.value?.querySelectorAll<HTMLElement>(`[data-provider-row="${drag.operation}"]`)??[]]
 const others=rows.filter(row=>row.dataset.provider!==drag.id);let to=0
 for(const row of others){const rect=row.getBoundingClientRect();if(event.clientY>rect.top+rect.height/2)to++}
 moveTo(drag.operation,drag.id,to)
}
function finishDrag(event?:PointerEvent,cancel=false){const drag=dragging.value;if(!drag||(event&&event.pointerId!==drag.pointerId))return
 dragging.value=undefined;if(cancel)orderDraft.value[drag.operation]=[...drag.before]
 if(drag.element.hasPointerCapture(drag.pointerId))drag.element.releasePointerCapture(drag.pointerId)
}
function operationLabel(operation?:OperationState){if(!operation)return loading.value?'读取中…':'未读取';return {unconfigured:'未配置密钥',disabled:'已停用',unverified:'已配置',connected:'已连接',error:'调用失败',unsupported:'不支持网页读取',closed:'已关闭'}[operation.status]??'状态未知'}
function operationReason(operation?:OperationState){return operation?.status==='error'?(reasonLabels[operation.reason??'']??'调用失败，请检查配置或稍后重试。'):''}
function checkedAt(value:string){const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString()}
const recentCalls=computed(()=>operationIds.flatMap(operation=>{const state=searchStatus.value?.operations[operation].state;return state&&['connected','error'].includes(state.status)&&(state.provider||state.lastCheckedAt||state.attempts?.length)?[{name:operationName(operation),state,provider:providerName(state.provider),detail:operationReason(state),attempts:(state.attempts??[]).map(attempt=>({provider:providerName(attempt.provider),result:attempt.ok?'成功':operationReason({available:false,status:'error',reason:attempt.code})}))}]:[]}))
function cancelDrag(){finishDrag(undefined,true)}
function visibilityChanged(){if(document.hidden)cancelDrag()}
onMounted(()=>{window.addEventListener('blur',cancelDrag);document.addEventListener('visibilitychange',visibilityChanged)})
watch(busy,value=>{if(value)cancelDrag()})
watch(compatible,value=>{if(!value)cancelDrag()})
watch(selectedOperation,cancelDrag)
watch(()=>props.active,active=>{if(active)void loadSearch();else finishDrag(undefined,true)},{immediate:true})
onBeforeUnmount(()=>{window.removeEventListener('blur',cancelDrag);document.removeEventListener('visibilitychange',visibilityChanged);disposed=true;++generation;finishDrag(undefined,true);secrets.clear()})
</script>

<template>
 <section ref="orderElement" class="search-settings" aria-label="网页工具设置" :aria-busy="busy" @pointermove="dragMove" @pointerup="finishDrag($event)" @pointercancel="finishDrag($event,true)" @lostpointercapture="finishDrag($event,true)">
  <div v-if="loadError" class="compatibility-feedback" role="alert"><p>{{loadError}}</p><button type="button" class="button" :disabled="busy" @click="loadSearch"><Icon name="refresh" :size="16"/>重新读取</button></div>
  <SettingsGroup v-for="operation in operationIds" :key="operation" :title="operationName(operation)">
   <div class="settings-card-row"><span>启用 {{operationName(operation)}}</span><ToggleSwitch :model-value="searchStatus?.operations[operation].enabled??false" :aria-label="`启用 ${operationName(operation)}`" :disabled="!compatible||busy" @update:model-value="setOperationEnabled($event,operation)"/></div>
   <div v-for="(id,index) in orderDraft[operation]" :key="id" class="settings-card-row provider-row" :class="{'is-dragging':dragging?.operation===operation&&dragging.id===id}" :data-provider-row="operation" :data-provider="id">
    <TooltipButton v-if="orderDraft[operation].length>1" class="drag-handle" :data-handle="`${operation}:${id}`" :label="`调整 ${operationName(operation)} ${providerName(id)} 顺序`" tooltip="拖动调整顺序；方向键、Home、End 排序" icon="grip-vertical" :size="18" :disabled="!compatible||busy||orderDraft[operation].length<2" @pointerdown="beginDrag($event,operation,id)" @keydown="reorderKey($event,operation,id)"/>
    <div class="settings-card-copy"><div class="provider-name"><Icon :name="id==='deepseek'?'brand:deepseek':'search'" :size="19"/><span>{{providerName(id)}}</span><span class="order-position">{{index+1}}</span></div><p>{{operationLabel(searchStatus?.operations[operation].providers.find(row=>row.id===id)?.state)}}</p></div>
    <div v-if="pendingRemoval?.operation===operation&&pendingRemoval.provider===id" class="provider-actions"><button type="button" class="text-button" :disabled="busy||!compatible" @click="removeProvider(id,operation)">移除并清除密钥</button><button type="button" class="text-button" :disabled="busy" @click="pendingRemoval=undefined">取消</button></div>
    <div v-else class="provider-actions"><button type="button" class="button" :aria-pressed="selectedOperation===operation&&selectedProvider===id" :disabled="!compatible" @click="selectProvider(operation,id)"><Icon name="pen" :size="16"/>编辑</button><TooltipButton :label="`移除 ${operationName(operation)} ${providerName(id)}`" icon="delete" :size="17" :disabled="!compatible||busy" @click="pendingRemoval={operation,provider:id}"/></div>
   </div>
   <div v-if="!orderDraft[operation].length" class="settings-card-row empty-provider"><span>{{loading?'读取中…':compatible?'尚未添加服务商':'等待兼容的服务配置'}}</span></div>
   <template #footer><div class="group-footer"><div class="operation-footer"><div v-if="availableOptions(operation).length" class="add-provider"><CustomSelect v-model="addSelection[operation]" :aria-label="`${operationName(operation)} 添加服务商`" :options="availableOptions(operation)" :disabled="!compatible||busy"/><button type="button" class="button" :disabled="!compatible||busy||!availableOptions(operation).some(row=>row.value===addSelection[operation])" @click="addProvider(addSelection[operation],operation)"><Icon name="plus" :size="16"/>添加服务商</button></div><div v-if="orderIsDirty(operation)" class="order-actions"><span class="muted">顺序未保存</span><button type="button" class="text-button" :disabled="busy||!compatible" @click="discardOrder(operation)">放弃</button><button type="button" class="button" :disabled="busy||!compatible||orderIsStale(operation)" @click="saveOrder(operation)"><Icon name="save" :size="16"/>保存顺序</button></div></div><div v-if="orderIsStale(operation)" class="version-feedback"><span>配置版本已更新，顺序修改已保留。</span><button type="button" class="text-button" :disabled="busy||!compatible" @click="keepOrderWithLatestVersion(operation)">保留顺序并使用最新版本</button></div><p v-if="errors[operation]" class="search-error" role="alert">{{errors[operation]}}</p></div></template>
  </SettingsGroup>
  <span class="visually-hidden" role="status" aria-live="polite">{{announcement}}</span>
  <form v-if="draft" class="search-form" @submit.prevent="saveSearch()">
   <SettingsGroup :title="`${operationName(selectedOperation)} · ${providerName(selectedProvider)}`">
    <div class="settings-card-row"><label for="web-access-enabled">启用服务商</label><ToggleSwitch id="web-access-enabled" v-model="draft.enabled" aria-label="启用服务商" :disabled="!compatible||(!searchCanEnable&&!draft.enabled)"/></div>
    <div class="settings-card-row"><label for="web-access-key">API Key</label><input id="web-access-key" v-model="draft.apiKey" type="password" autocomplete="new-password" spellcheck="false" :placeholder="currentProvider?.hasApiKey?'留空保留原密钥':`输入 ${providerName(selectedProvider)} API Key`" :disabled="!compatible"/></div>
    <div class="settings-card-row"><label for="web-access-url">Base URL</label><input id="web-access-url" v-model="draft.baseURL" type="text" inputmode="url" spellcheck="false" autocomplete="off" :readonly="selectedProvider==='tavily'" :disabled="!compatible" :aria-invalid="invalidBaseURL||undefined" :aria-describedby="invalidBaseURL?'web-access-url-error':undefined"/></div>
    <div class="settings-card-row"><span>已保存状态</span><div class="operation-state" role="status"><span>{{operationLabel(currentProvider?.state)}}</span><span v-if="operationReason(currentProvider?.state)">{{operationReason(currentProvider?.state)}}</span></div></div>
    <template #footer><div class="group-footer"><p v-if="invalidBaseURL" id="web-access-url-error" class="search-error" role="alert">Base URL 必须为 HTTPS 地址，不能包含账号、密码、查询参数或片段。</p><div class="search-actions"><span v-if="searchDirty" class="muted">未保存</span><button v-if="searchDirty" type="button" class="text-button" :disabled="busy||!compatible" @click="discardDraft">放弃修改</button><button type="submit" class="button primary" :disabled="!canSave"><Icon name="save" :size="16"/>{{saving?'保存中…':'保存配置'}}</button><button v-if="currentProvider?.hasApiKey" type="button" class="button" :disabled="busy||!compatible||versionChanged" @click="saveSearch(true)"><Icon name="delete" :size="16"/>清除密钥</button><button type="button" class="button" :disabled="busy" @click="loadSearch"><Icon name="refresh" :size="16"/>刷新状态</button></div><div v-if="versionChanged" class="version-feedback"><span>配置版本已更新，本地修改已保留。</span><button type="button" class="text-button" :disabled="busy||!compatible" @click="keepDraftWithLatestVersion">保留修改并使用最新版本</button></div></div></template>
   </SettingsGroup>
  </form>
  <SettingsGroup v-if="recentCalls.length" title="最近调用"><div v-for="call in recentCalls" :key="call.name" class="settings-card-row recent-call"><span>{{call.name}}</span><div class="receipt-body"><div>{{operationLabel(call.state)}} · {{call.provider}}</div><time v-if="call.state.lastCheckedAt&&checkedAt(call.state.lastCheckedAt)" :datetime="call.state.lastCheckedAt">{{checkedAt(call.state.lastCheckedAt)}}</time><ol v-if="call.attempts.length"><li v-for="(attempt,index) in call.attempts" :key="index">{{attempt.provider}} · {{attempt.result}}</li></ol><p v-else-if="call.detail">{{call.detail}}</p></div></div></SettingsGroup>
 </section>
</template>
<style scoped>
.search-settings{container-type:inline-size;min-width:0;font-size:13px;line-height:1.5}.group-footer{display:flex;flex-direction:column;gap:12px;width:100%;min-width:0}.provider-row{gap:12px!important}.provider-row.is-dragging{background:var(--sand-bg-hover)}.search-settings :deep(.drag-handle){touch-action:none;cursor:grab;width:44px;height:28px;outline:0;flex-shrink:0}.search-settings :deep(.drag-handle:active){cursor:grabbing}.search-settings :deep(.drag-handle:focus-visible){background:var(--sand-bg-active)}.provider-name{display:flex;align-items:center;gap:8px;font-size:13px}.provider-name>svg{flex-shrink:0}.order-position{font-size:12px;color:var(--sand-text-secondary);margin-left:4px}.provider-actions,.operation-footer,.add-provider,.order-actions,.search-actions,.version-feedback{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.provider-actions{justify-content:flex-end;flex-shrink:0}.operation-footer{justify-content:space-between}.add-provider>.custom-select{width:160px}.order-actions{margin-left:auto}.search-actions{justify-content:flex-end}.search-actions>.muted{margin-right:auto}.version-feedback{justify-content:space-between;color:var(--sand-text-secondary)}.operation-state{width:min(320px,55%);min-width:0;text-align:right;display:flex;flex-direction:column;gap:4px;color:var(--sand-text-secondary)}.search-settings .button,.search-settings .text-button{min-height:28px;font-size:13px;font-weight:420}.provider-actions>.icon-button{width:44px;height:28px}.empty-provider{color:var(--sand-text-secondary)}.search-error,.compatibility-feedback{color:var(--sand-text-danger-primary);font-size:13px;overflow-wrap:anywhere}.compatibility-feedback{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px}.compatibility-feedback p{flex:1}.receipt-body{width:70%;min-width:0;color:var(--sand-text-secondary);overflow-wrap:anywhere}.receipt-body time{font-size:13px}.receipt-body ol{padding-left:20px;margin-top:8px}.receipt-body li{margin-top:4px}.search-settings :deep(input){font-size:13px;color:var(--sand-text-primary);height:28px;min-height:28px;box-sizing:border-box}.search-settings :deep(input:focus){background:var(--sand-bg-hover);outline:0;box-shadow:none}.search-settings :deep(input::placeholder){color:var(--sand-text-secondary);opacity:1}.search-settings :deep(input:read-only){color:var(--sand-text-secondary)}@container(max-width:480px){.provider-actions{gap:4px;max-width:146px}.provider-actions .button{padding-inline:8px}.provider-row{padding-inline:8px!important;gap:8px!important}.search-settings :deep(.drag-handle){width:44px}.provider-name{gap:4px}.provider-name>svg{width:17px}.add-provider{width:100%}.add-provider>.custom-select{flex:1;min-width:0}.compatibility-feedback{align-items:flex-start;flex-direction:column}.order-actions{width:100%;justify-content:flex-end}}
</style>
<style scoped src="../form-controls.css"></style>
