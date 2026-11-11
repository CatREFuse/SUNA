<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import type {Snapshot,PermissionState,PermissionChange,PermissionField,PermissionPolicy,PermissionRecord,PermissionTarget} from '../types'
import {channelConversationName} from '../../core/channel-display.mjs'
import {request} from '../api'
import {managedTool} from '../../core/tool-permissions.mjs'
import CustomSelect from './CustomSelect.vue'
import Icon from './Icon.vue'
import RuntimePermissionSettings from './RuntimePermissionSettings.vue'
const runtimePermissionSettings=ref<InstanceType<typeof RuntimePermissionSettings>>()
const props=defineProps<{state:Snapshot;active:boolean;characterId:string;target?:PermissionTarget}>()
const emit=defineEmits<{refresh:[];notice:[string]}>()
const status=ref<PermissionState>(),loading=ref(false),writing=ref(false),error=ref(''),accountId=ref(''),conversationId=ref(''),toolFilter=ref('')
const characterId=computed(()=>typeof props.characterId==='string'?props.characterId:'')
const attemptedChange=ref<PermissionChange>(),retryReady=ref(false)
let generation=0,readSequence=0
const configurationFilter=ref('configurable')
const configurationOptions=[{value:'configurable',label:'可配置'},{value:'unconfigurable',label:'不可配置'},{value:'all',label:'全部'}]
const connections=ref<Array<{accountId:string;characterId?:string;name?:string;label?:string;accountLabel?:string;pluginId?:string;platform?:string}>>([])
const canWrite=computed(()=>Boolean(window.sandbook?.setToolPermission)&&Boolean(currentCharacter.value))
const fields=[{id:'local',label:'本地聊天'},{id:'group',label:'频道群聊'},{id:'direct',label:'频道私聊'}] as const
const currentCharacter=computed(()=>props.state.characters.find(person=>person.id===characterId.value))
const allTools=computed(()=>{const roleTools=status.value?.roleTools?.find(role=>role.characterId===characterId.value)?.tools;return (status.value?.tools??[]).filter(tool=>managedTool(tool.id)).map(tool=>{const role=roleTools?.find(item=>item.id===tool.id);return {...tool,available:tool.available&&role?.available===true,reason:!tool.available?tool.reason:role?.available===true?undefined:role?'此角色已停用该工具':'尚未读取角色工具状态'}})})
const filteredTools=computed(()=>allTools.value.filter(tool=>configurationFilter.value==='all'||tool.available===(configurationFilter.value==='configurable')))
const toolOptions=computed(()=>[{value:'',label:'全部工具'},...filteredTools.value.map(tool=>({value:tool.id,label:tool.label}))])
const tools=computed(()=>filteredTools.value.filter(tool=>!toolFilter.value||tool.id===toolFilter.value))
const emptyToolsLabel=computed(()=>configurationFilter.value==='configurable'?'此角色暂无可配置权限的工具。':configurationFilter.value==='unconfigurable'?'此角色暂无不可配置权限的工具。':'此角色暂无工具。')
const readiness=computed(()=>status.value?.channelReadiness??[])
const roleReadiness=computed(()=>readiness.value.filter(binding=>binding.characterId===characterId.value))
const accountOptions=computed(()=>{const names=roleReadiness.value.map((binding,index)=>{const connection=connections.value.find(item=>item.accountId===binding.accountId);return connection?.accountLabel||connection?.name||connection?.label||`${connection?.platform||'频道'}账号 ${index+1}`});return [{value:'',label:'选择频道账号'},...roleReadiness.value.map((binding,index)=>({value:binding.accountId,label:names.filter(name=>name===names[index]).length>1?`${names[index]} ${names.slice(0,index+1).filter(name=>name===names[index]).length}`:names[index]!}))]})
const currentReadiness=computed(()=>roleReadiness.value.find(binding=>binding.accountId===accountId.value))
const roleChannelReady=computed(()=>roleReadiness.value.some(binding=>binding.ready))
const conversationReadiness=computed(()=>status.value?.conversationReadiness?.filter(binding=>binding.characterId===characterId.value)??[])
const conversations=computed(()=>props.state.conversations.filter(conversation=>conversation.channel!=='desktop'&&conversation.participantIds.includes(characterId.value)&&(conversationReadiness.value.find(binding=>binding.conversationId===conversation.id)?.accountId??conversation.channelTarget?.accountId)===accountId.value))
const currentConversationReadiness=computed(()=>conversationReadiness.value.find(binding=>binding.conversationId===conversationId.value))
const conversationOptions=computed(()=>{const names=conversations.value.map(channelConversationName);return [{value:'',label:'选择群聊或私聊'},...conversations.value.map((conversation,index)=>({value:conversation.id,label:names.filter(name=>name===names[index]).length>1?`${names[index]} · ${conversation.kind==='group'?'群聊':'私聊'} ${conversations.value.slice(0,index+1).filter((_,position)=>names[position]===names[index]).length}`:names[index]!}))]})
const conversation=computed(()=>conversations.value.find(item=>item.id===conversationId.value))
const conversationField=computed<PermissionField>(()=>conversation.value?.kind==='group'?'group':'direct')
const blockedLegacy=computed(()=>status.value?.legacyScreenDenials.filter(pair=>pair.characterId===characterId.value)??[])
const pending=computed(()=>loading.value||writing.value)
function findRecord(scope:PermissionRecord['scope'],tool:string){return status.value?.records.find(record=>record.characterId===characterId.value&&record.tool===tool&&record.scope===scope&&(scope!=='account'||record.accountId===accountId.value)&&(scope!=='conversation'||record.conversationId===conversationId.value))}
function inherited(scope:PermissionRecord['scope'],tool:string,field:PermissionField):PermissionPolicy{
 const role=findRecord('role',tool)?.policy[field]??status.value?.defaults[field]??(field==='local'?'allow':'admins')
 return scope==='role'?status.value?.defaults[field]??(field==='local'?'allow':'admins'):scope==='account'?role:findRecord('account',tool)?.policy[field]??role
}
function value(scope:PermissionRecord['scope'],tool:string,field:PermissionField){const draft=attemptedChange.value;return !writing.value&&draft&&draft.characterId===characterId.value&&draft.scope===scope&&draft.tool===tool&&draft.field===field&&(scope!=='account'||draft.accountId===accountId.value)&&(scope!=='conversation'||draft.conversationId===conversationId.value)?draft.value??'':findRecord(scope,tool)?.policy[field]??''}
function policyLabel(field:PermissionField,policy:PermissionPolicy){return policy==='admins'?'仅管理员可用':policy==='deny'?'不可用':field==='local'?'可用':'所有人可用'}
function options(scope:PermissionRecord['scope'],tool:string,field:PermissionField){return [{value:'',label:`${scope==='role'?'默认':'继承'} · ${policyLabel(field,inherited(scope,tool,field))}`},...[{value:field==='local'?'allow':'everyone',label:field==='local'?'可用':'所有人可用'},...(field==='local'?[]:[{value:'admins',label:'仅管理员可用'}]),...(field==='direct'?[]:[{value:'deny',label:'不可用'}])]]}
function disabled(scope:PermissionRecord['scope'],tool:string,field:PermissionField){return pending.value||Boolean(attemptedChange.value)||!canWrite.value||!currentCharacter.value||!allTools.value.find(item=>item.id===tool)?.available||(field!=='local'&&(scope==='role'?false:scope==='conversation'?!currentConversationReadiness.value?.ready||currentConversationReadiness.value.accountId!==accountId.value:!currentReadiness.value?.ready))||(scope==='account'&&!accountId.value)||(scope==='conversation'&&!conversation.value)}
function readinessReason(reason?:string){return ({'protocol-unsupported':'插件未提供管理员协议','administrator-missing':'插件尚未配置此角色的管理员 UID','character-unavailable':'角色不可用','account-disabled':'频道账号已停用','account-unavailable':'频道账号不可用','character-mismatch':'频道账号未绑定此角色','account-ambiguous':'频道账号绑定不明确'} as Record<string,string>)[reason??'']||'插件未提供有效管理员绑定，频道覆盖不可设置。'}
function errorText(cause:unknown){return cause instanceof Error?cause.message:String(cause)}
async function load(){
 if(pending.value)return false
 const role=characterId.value,epoch=generation,sequence=++readSequence
 loading.value=true;error.value=''
 try{const [next,channels]=await Promise.all([request<PermissionState>('/permissions'),request<{connections:typeof connections.value}>('/channels')]);if(epoch!==generation||role!==characterId.value||sequence!==readSequence)return false;if(status.value&&next.version<status.value.version)throw new Error('权限版本已过期，请重新读取');status.value=next;connections.value=channels.connections??[];retryReady.value=Boolean(attemptedChange.value);return true}catch(cause){if(epoch===generation&&sequence===readSequence)error.value=errorText(cause);return false}finally{if(sequence===readSequence)loading.value=false}
}
async function submit(body:PermissionChange){
 const write=window.sandbook?.setToolPermission;if(!write||body.characterId!==characterId.value||!currentCharacter.value)return false
 const epoch=generation,role=characterId.value
 writing.value=true;error.value='';retryReady.value=false
 try{const next=await write(body);if(epoch!==generation||role!==characterId.value)return false;if(!Number.isInteger(next.version)||next.version<=body.expectedVersion||(status.value&&next.version<status.value.version))throw new Error('权限保存回执无效，请重新读取');status.value=next;attemptedChange.value=undefined;emit('refresh');emit('notice',body.value===null?'已恢复继承':'权限已保存');return true}catch(cause){if(epoch===generation)error.value=errorText(cause);return false}finally{writing.value=false}
}
async function change(scope:PermissionRecord['scope'],tool:string,field:PermissionField,policy:string){
 if(disabled(scope,tool,field)||!status.value)return false
 const body:PermissionChange={expectedVersion:status.value.version,characterId:characterId.value,tool,scope,field,value:policy===''?null:policy as PermissionPolicy,...(scope==='account'?{accountId:accountId.value}:{}),...(scope==='conversation'?{conversationId:conversationId.value}:{})}
 attemptedChange.value=body
 return submit(body)
}
function discardChange(){if(pending.value)return;attemptedChange.value=undefined;retryReady.value=false;error.value=''}
async function retryChange(){if(pending.value||!retryReady.value||!attemptedChange.value||!status.value)return false;const draft={...attemptedChange.value,expectedVersion:status.value.version};attemptedChange.value=undefined;const unavailable=disabled(draft.scope,draft.tool,draft.field);attemptedChange.value=draft;if(unavailable){error.value='当前权限不可配置';return false}return submit(draft)}
const adoptionConfirm=ref('')
async function adopt(conversationId:string){
 const write=window.sandbook?.adoptScreenPolicy;if(pending.value||attemptedChange.value||!status.value||!write||!currentCharacter.value||!blockedLegacy.value.some(pair=>pair.conversationId===conversationId))return false
 const epoch=generation,role=characterId.value,expectedVersion=status.value.version;writing.value=true;error.value=''
 try{const next=await write({expectedVersion,characterId:role,conversationId});if(epoch!==generation||role!==characterId.value)return false;if(!Number.isInteger(next.version)||next.version<=expectedVersion||(status.value&&next.version<status.value.version))throw new Error('权限保存回执无效，请重新读取');status.value=next;adoptionConfirm.value='';emit('refresh');emit('notice','已采用当前权限策略');return true}catch(cause){if(epoch===generation)error.value=errorText(cause);return false}finally{writing.value=false}
}
async function confirmLeave(){return !pending.value&&!attemptedChange.value&&(await runtimePermissionSettings.value?.confirmLeave()??true)}
defineExpose({confirmLeave})
function legacyName(id:string){const item=props.state.conversations.find(item=>item.id===id);return item?channelConversationName(item):'已移除的会话'}
watch(()=>props.target,target=>{if(!target||target.characterId!==characterId.value||writing.value||attemptedChange.value)return;if(target.tool!==undefined){toolFilter.value=target.tool;if(target.tool)configurationFilter.value='all'}if(target.accountId!==undefined)accountId.value=target.accountId;if(target.conversationId!==undefined)conversationId.value=target.conversationId},{immediate:true,flush:'post'})
watch(characterId,()=>{generation++;readSequence++;loading.value=false;attemptedChange.value=undefined;retryReady.value=false;adoptionConfirm.value='';accountId.value='';conversationId.value='';toolFilter.value='';error.value='';if(props.active&&!writing.value)void load()})
watch(toolOptions,options=>{if(status.value&&toolFilter.value&&!options.some(option=>option.value===toolFilter.value))toolFilter.value=''})
watch(accountOptions,options=>{if(!status.value||!currentCharacter.value||props.target?.characterId===characterId.value&&props.target.accountId===accountId.value)return;if(accountId.value&&!options.some(item=>item.value===accountId.value))accountId.value=''} )
watch(conversationOptions,options=>{if(!status.value||!currentCharacter.value||props.target?.characterId===characterId.value&&props.target.conversationId===conversationId.value)return;if(conversationId.value&&!options.some(item=>item.value===conversationId.value))conversationId.value=''} )
watch(()=>props.active,active=>{if(active&&!pending.value)void load()},{immediate:true})
watch(writing,value=>{if(!value&&props.active&&!status.value&&!loading.value)void load()})
</script>
<template>
 <div class="permission-settings" :aria-busy="pending">
  <RuntimePermissionSettings ref="runtimePermissionSettings" :character-id="characterId" :active="active" @notice="emit('notice',$event)" @refresh="emit('refresh')"/>
  <div class="permission-filters"><div class="permission-field">配置状态<CustomSelect v-model="configurationFilter" aria-label="权限配置状态" :options="configurationOptions" :disabled="pending||!!attemptedChange"/></div><div class="permission-field">工具<CustomSelect v-model="toolFilter" aria-label="权限工具" :options="toolOptions" :disabled="pending||!!attemptedChange"/></div><button type="button" class="button" :disabled="pending" @click="load"><Icon name="refresh" :size="16"/>重新读取</button></div>
  <p v-if="error" class="inline-error" role="alert">{{error}}</p>
  <div v-if="attemptedChange" class="permission-draft" role="status"><span>{{writing?'正在保存权限…':'权限未保存'}}</span><button type="button" class="button" :disabled="pending" @click="discardChange">放弃修改</button><button v-if="retryReady" type="button" class="button" :disabled="pending||!canWrite" @click="retryChange">确认并重新提交</button><span v-else-if="!pending">重新读取后可确认并重新提交</span></div>
  <p v-if="!canWrite" class="permission-note">请在桌面应用的角色资料中修改权限。</p>
  <p v-if="!status" class="permission-note" role="status">{{loading?'读取权限中…':'尚未读取权限'}}</p>
  <template v-else-if="currentCharacter">
   <p v-if="!roleChannelReady" class="permission-note" role="status">频道插件尚未提供此角色的管理员 UID，频道覆盖不可设置。</p>
   <p v-if="!tools.length" class="permission-note" role="status">{{emptyToolsLabel}}</p>
   <section v-else class="permission-role-group" aria-label="角色权限"><h3>角色权限</h3><div class="permission-table" role="table" aria-label="角色工具权限"><div class="permission-row permission-table-heading" role="row"><span role="columnheader">工具</span><span v-for="field in fields" :key="field.id" role="columnheader">{{field.label}}</span></div>
    <div v-for="tool in tools" :key="tool.id" class="permission-row" role="row"><div class="permission-tool" role="rowheader"><span><Icon :name="'tool:'+tool.id" :size="17"/>{{tool.label}}</span><span v-if="!tool.available" class="permission-note">{{tool.reason||'执行器不可用'}}</span></div><div v-for="field in fields" :key="field.id" class="permission-cell" role="cell"><span class="permission-label">{{field.label}}</span><CustomSelect :model-value="value('role',tool.id,field.id)" :aria-label="`${tool.label} ${field.label}`" :options="options('role',tool.id,field.id)" :disabled="disabled('role',tool.id,field.id)" @update:model-value="change('role',tool.id,field.id,$event)"/></div></div>
   </div></section>
   <section class="permission-overrides" aria-label="频道账号覆盖"><h3>频道账号覆盖</h3><div class="permission-field permission-account">频道账号<CustomSelect v-model="accountId" aria-label="权限频道账号" :options="accountOptions" :disabled="pending||!!attemptedChange"/></div>
    <template v-if="accountId"><p class="permission-note" :role="currentReadiness?.ready?undefined:'status'">{{currentReadiness?.ready?`管理员 UID：${currentReadiness.administratorUid}`:readinessReason(currentReadiness?.reason)}}</p>
     <div class="permission-table" role="table" aria-label="频道账号工具权限"><div v-for="tool in tools" :key="tool.id" class="permission-row permission-channel-row" role="row"><div class="permission-tool" role="rowheader">{{tool.label}}</div><div v-for="field in fields.filter(item=>item.id!=='local')" :key="field.id" class="permission-cell" role="cell"><span class="permission-scope-label">{{field.label}}</span><CustomSelect :model-value="value('account',tool.id,field.id)" :aria-label="`${tool.label} 账号${field.label}`" :options="options('account',tool.id,field.id)" :disabled="disabled('account',tool.id,field.id)" @update:model-value="change('account',tool.id,field.id,$event)"/></div></div></div>
     <section class="permission-overrides" aria-label="频道会话覆盖"><h3>频道会话覆盖</h3><div class="permission-field permission-account">群聊或私聊<CustomSelect v-model="conversationId" aria-label="权限频道会话" :options="conversationOptions" :disabled="pending||!!attemptedChange"/></div>
      <p v-if="conversation&&!currentConversationReadiness?.ready" class="permission-note" role="status">{{readinessReason(currentConversationReadiness?.reason)}}</p>
      <div v-if="conversation" class="permission-table" role="table" aria-label="频道会话工具权限"><div v-for="tool in tools" :key="tool.id" class="permission-row permission-conversation-row" role="row"><div class="permission-tool" role="rowheader">{{tool.label}}</div><div class="permission-cell" role="cell"><span class="permission-scope-label">{{conversationField==='group'?'频道群聊':'频道私聊'}}</span><CustomSelect :model-value="value('conversation',tool.id,conversationField)" :aria-label="`${tool.label} 会话权限`" :options="options('conversation',tool.id,conversationField)" :disabled="disabled('conversation',tool.id,conversationField)" @update:model-value="change('conversation',tool.id,conversationField,$event)"/></div></div></div>
     </section>
    </template>
   </section>
   <section v-if="blockedLegacy.length" class="permission-overrides" aria-label="旧截图撤回"><h3>旧截图撤回</h3><div class="permission-legacy-list"><div v-for="pair in blockedLegacy" :key="pair.conversationId" class="permission-legacy"><span>{{legacyName(pair.conversationId)}}</span><button type="button" class="button" :disabled="pending||!canWrite||!!attemptedChange" @click="adoptionConfirm=pair.conversationId">采用当前权限策略</button></div></div></section>
  </template>
  <div v-if="adoptionConfirm" class="permission-draft"><span>采用当前权限策略后，此会话可能恢复截图权限。</span><button type="button" class="button" :disabled="pending" @click="adoptionConfirm=''">取消</button><button type="button" class="button" :disabled="pending||!canWrite" @click="adopt(adoptionConfirm)">确认采用当前权限策略</button></div>
  <p v-if="!currentCharacter" class="permission-note" role="status">{{characterId?'所选角色不存在或尚未载入。':'暂无角色。'}}</p>
 </div>
</template>
<style scoped>
.permission-draft{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 16px;font-size:13px}.permission-settings{container-type:inline-size;min-width:0;font-size:13px;font-weight:420}.permission-filters{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin-bottom:24px}.permission-field{display:flex;flex-direction:column;gap:8px;min-width:0;font-size:13px;flex:1}.permission-filters>.permission-field{max-width:280px;min-width:160px}.permission-filters>.button{min-height:28px}.permission-role-group,.permission-overrides{min-width:0;margin:0 0 24px}.permission-role-group h3,.permission-overrides h3{font-size:13px;line-height:1.5;font-weight:420;color:var(--sand-text-secondary);padding:0 4px;margin:0 0 8px}.permission-table,.permission-legacy-list{min-width:0;border:1px solid var(--sand-border-quaternary-translucent);border-radius:12px;background:var(--sand-bg-elevated);overflow:hidden}.permission-row{display:grid;grid-template-columns:minmax(120px,.85fr) repeat(3,minmax(0,1fr));gap:16px;align-items:center;padding:12px 16px;min-height:62px}.permission-row+.permission-row{border-top:.5px solid var(--sand-border-quaternary-translucent)}.permission-table-heading{color:var(--sand-text-secondary);min-height:28px;padding:8px 16px;font-size:13px}.permission-tool{display:flex;flex-direction:column;gap:8px;font-size:13px;min-width:0;overflow-wrap:anywhere}.permission-tool>span:first-child{display:flex;align-items:center;gap:8px}.permission-note{color:var(--sand-text-secondary);font-size:13px;line-height:1.5;margin:0 0 16px}.permission-tool>.permission-note{margin:0}.permission-cell{min-width:0;display:flex;flex-direction:column;gap:8px;font-size:13px}.permission-cell>.permission-label{display:none}.permission-cell>.permission-scope-label{display:block;color:var(--sand-text-secondary)}.permission-overrides{margin-top:24px}.permission-account{max-width:480px;margin-bottom:16px}.permission-channel-row{grid-template-columns:minmax(120px,.85fr) repeat(2,minmax(0,1fr))}.permission-conversation-row{grid-template-columns:minmax(120px,.85fr) minmax(0,2fr)}.permission-legacy{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;min-height:62px}.permission-legacy+.permission-legacy{border-top:.5px solid var(--sand-border-quaternary-translucent)}.permission-settings .button{font-size:13px;font-weight:420}.permission-legacy>span{overflow-wrap:anywhere}@container(max-width:740px){.permission-row{grid-template-columns:repeat(3,minmax(0,1fr));align-items:start}.permission-tool{grid-column:1/-1}.permission-table-heading{display:none}.permission-cell>.permission-label{display:block;color:var(--sand-text-secondary)}.permission-channel-row{grid-template-columns:repeat(2,minmax(0,1fr))}.permission-conversation-row{grid-template-columns:minmax(0,1fr)}}@container(max-width:480px){.permission-row{grid-template-columns:minmax(0,1fr);gap:12px;padding:12px}.permission-tool{margin-bottom:4px}.permission-cell{display:grid;grid-template-columns:88px minmax(0,1fr);align-items:center}.permission-filters>.permission-field{max-width:none;min-width:120px}.permission-filters>.button{width:100%}.permission-legacy{padding:12px;flex-wrap:wrap}.permission-role-group,.permission-overrides{margin-bottom:20px}}
</style>

<style scoped src="../form-controls.css"></style>
