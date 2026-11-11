<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import type {Snapshot} from '../types'
import {request,upload} from '../api'
import Icon from './Icon.vue'
import SettingsGroup from './SettingsGroup.vue'
const props=defineProps<{settings:Snapshot['settings'];active:boolean}>()
const emit=defineEmits<{refresh:[]}>()
const picker=ref<HTMLInputElement>(),busy=ref(false),error=ref('')
let generation=0
watch(()=>props.active,value=>{if(!value)generation++})
onBeforeUnmount(()=>{generation++})
const supported=computed(()=>typeof props.settings.personalAvatarUrl==='string')
async function save(file?:File){
 if(busy.value||!props.active||!supported.value)return false
 const expectedVersion=props.settings.version
 if(!Number.isSafeInteger(expectedVersion)){error.value='请重新打开设置后再试';return false}
 const attempt=++generation
 busy.value=true;error.value=''
 try{
  let url=''
  if(file){
   if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)||file.size>10*1024*1024)throw new Error('请选择 10 MB 以内的 PNG、JPEG、WebP 或 GIF 图片')
   const bitmap=await createImageBitmap(file)
   try{
    if(!bitmap.width||!bitmap.height)throw new Error('无法读取这张图片')
    const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('图片处理失败，请重试')
    const side=Math.min(bitmap.width,bitmap.height);ctx.drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,256,256)
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('图片处理失败，请重试')),'image/png'))
    const imported=await upload('/assets/import',new File([blob],'personal-avatar.png',{type:'image/png'}));url=imported.url
    if(imported.type!=='frames'||!/^\/assets-local\/[a-f0-9-]{36}\/image\.png$/.test(url))throw new Error('头像导入失败，请重试')
   }finally{bitmap.close()}
  }
  if(attempt!==generation||!props.active)return false
  const saved=await request<Snapshot['settings']>('/settings',{personalAvatarUrl:url,expectedVersion},'PATCH')
  if(saved.personalAvatarUrl!==url||!Number.isSafeInteger(saved.version)||saved.version!<=expectedVersion!||(props.settings.version??0)>saved.version!)throw new Error('头像保存未确认，请刷新后重试')
  emit('refresh');return true
 }catch(cause){error.value=cause&&typeof cause==='object'&&'message' in cause?String(cause.message):'头像保存失败，请重试';emit('refresh');return false}
 finally{busy.value=false;if(picker.value)picker.value.value=''}
}
function selected(event:Event){const file=(event.target as HTMLInputElement).files?.[0];if(file)void save(file)}
</script>
<template><SettingsGroup title="个人头像"><div class="setting-row personal-avatar-row"><span class="personal-avatar-preview"><img v-if="settings.personalAvatarUrl" :src="settings.personalAvatarUrl" alt="个人头像"/><Icon v-else name="person" :size="24"/></span><div class="personal-avatar-actions"><button type="button" class="button" :disabled="busy||!active||!supported" @click="picker?.click()"><Icon name="upload" :size="16"/>{{busy?'保存中…':settings.personalAvatarUrl?'更换头像':'上传头像'}}</button><button v-if="settings.personalAvatarUrl" type="button" class="text-button" :disabled="busy||!active||!supported" @click="save()">恢复默认</button></div><input ref="picker" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden @change="selected"/></div><template #footer><p v-if="error" role="alert" class="personal-avatar-error">{{error}}</p></template></SettingsGroup></template>
<style scoped>
.personal-avatar-row{gap:16px}.personal-avatar-preview{width:48px;height:48px;flex:0 0 48px;display:grid;place-items:center;border-radius:50%;overflow:hidden;background:var(--sand-bg-elevated)}.personal-avatar-preview img{width:100%;height:100%;object-fit:cover}.personal-avatar-actions{display:flex;align-items:center;justify-content:flex-end;gap:16px;flex-wrap:wrap}.personal-avatar-error{color:var(--error);font-size:13px;line-height:20px}
</style>
