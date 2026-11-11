<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import type {RuntimePermissionState} from '../types'
import {request} from '../api'
import CustomSelect from './CustomSelect.vue'
const props=defineProps<{characterId:string;active:boolean}>()
const emit=defineEmits<{notice:[string];refresh:[]}>()
const state=ref<RuntimePermissionState>(),draft=ref(''),loading=ref(false),saving=ref(false),error=ref(''),retryRequired=ref(false)
const touched=ref(false)
let generation=0
const changed=computed(()=>!!state.value&&(draft.value!==state.value.preset||touched.value&&!state.value.explicit))
const confirmationRequired=computed(()=>state.value?.confirmationRequired===true)
const canWrite=computed(()=>Boolean(window.sandbook?.setRuntimePermission)&&state.value?.catalog.status==='connected')
const presetLabels:Record<string,string>={'auto':'帮我审核','read-only':'只读','workspace-write':'工作区内修改','danger-full-access':'完全访问'}
const options=computed(()=>{
 const values=state.value?.catalog.options.map(option=>({value:option.value,label:option.label}))??[]
 const current=state.value?.preset
 if(current&&!values.some(option=>option.value===current))values.unshift({value:current,label:presetLabels[current]??current})
 return values
})
async function load(){
 if(saving.value)return false
 const epoch=++generation,role=props.characterId,prior=draft.value,keep=changed.value
 loading.value=true;error.value=''
 try{const next=await request<RuntimePermissionState>('/permissions/runtime?'+new URLSearchParams({characterId:role}));if(epoch!==generation||role!==props.characterId)return false
 if(next.characterId!==role||!Number.isInteger(next.version)||state.value&&next.version<state.value.version)throw new Error('运行权限版本已过期，请重新读取')
 state.value=next;draft.value=keep?prior:next.preset;retryRequired.value=keep;return true
 }catch(cause){if(epoch===generation)error.value=cause instanceof Error?cause.message:String(cause);return false}finally{if(epoch===generation)loading.value=false}
}
async function save(){
 const write=window.sandbook?.setRuntimePermission,current=state.value;if(!write||!current||!canWrite.value||(!changed.value&&!confirmationRequired.value)||loading.value||saving.value||!current.catalog.revision)return false
 const epoch=generation,role=props.characterId,selected=draft.value;saving.value=true;error.value=''
 try{const next=await write({characterId:role,expectedVersion:current.version,preset:selected,catalogRevision:current.catalog.revision});if(epoch!==generation||role!==props.characterId)return false
 if(next.characterId!==role||next.preset!==selected||next.confirmationRequired===true||!Number.isInteger(next.version)||next.version<=current.version)throw new Error('运行权限保存回执无效，请重新读取')
 state.value=next;draft.value=next.preset;touched.value=false;retryRequired.value=false;emit('notice','运行权限已保存');emit('refresh');return true
 }catch(cause){if(epoch===generation){error.value=cause instanceof Error?cause.message:String(cause);retryRequired.value=true;}return false}finally{saving.value=false}
}
function discard(){if(saving.value)return;draft.value=state.value?.preset??'';touched.value=false;error.value='';retryRequired.value=false}
function confirmLeave(){return Promise.resolve(!saving.value&&!changed.value)}
defineExpose({confirmLeave})
watch(()=>props.characterId,()=>{generation++;state.value=undefined;draft.value='';touched.value=false;error.value='';loading.value=false;retryRequired.value=false;if(props.active)void load()})
watch(saving,value=>{if(!value&&props.active&&!state.value&&!loading.value)void load()})
watch(()=>props.active,active=>{if(active&&!changed.value&&!saving.value)void load()},{immediate:true})
</script>
<template>
 <section class="runtime-permission" aria-label="运行权限" :aria-busy="loading||saving">
  <div class="runtime-permission-row"><label :for="'runtime-permission-'+characterId">运行权限</label><CustomSelect :id="'runtime-permission-'+characterId" v-model="draft" aria-label="运行权限" @update:model-value="touched=true" :options="options" :disabled="loading||saving||!canWrite"/><button type="button" class="button" :disabled="loading||saving" @click="load">重新读取</button></div>
  <p v-if="loading&&!state" class="runtime-permission-status" role="status">读取运行权限中…</p>
  <p v-else-if="state?.catalog.status==='disconnected'" class="runtime-permission-status" role="status">DSH 未连接</p>
  <p v-else-if="state?.catalog.status==='unsupported'" class="runtime-permission-status" role="status">当前 DSH 不支持运行权限设置</p>
  <p v-if="confirmationRequired&&state?.catalog.status==='connected'" class="runtime-permission-status" role="status">请确认此角色的运行权限</p>
  <p v-if="error" class="inline-error" role="alert">{{error}}</p>
  <div v-if="changed||confirmationRequired" class="runtime-permission-actions"><button v-if="changed" type="button" class="button" :disabled="saving||loading" @click="discard">放弃修改</button><button type="button" class="button primary" :disabled="saving||loading||!canWrite" @click="save">{{saving?'正在保存…':retryRequired?'确认并保存':confirmationRequired?'确认运行权限':'保存'}}</button></div>
 </section>
</template>
<style scoped>
.runtime-permission{margin-bottom:24px;min-width:0}.runtime-permission-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.runtime-permission-row>label{font-size:13px;line-height:18px;color:var(--sand-text-secondary)}.runtime-permission-row>:deep(.custom-select){min-width:180px;max-width:320px;flex:1}.runtime-permission-status{margin:8px 0 0;font-size:13px;color:var(--sand-text-secondary)}.runtime-permission-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.runtime-permission .button{font-size:13px;font-weight:420}
</style>
<style scoped src="../form-controls.css"></style>
