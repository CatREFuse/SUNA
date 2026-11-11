<script setup lang="ts">
import {ref,watch,onMounted,onBeforeUnmount} from 'vue'
import {request} from '../api'
const managerId='suna-dsh-plugins'
const managementRead=new Set(['context','dsh.snapshot','dsh.configuration','dsh.operation'])
const managementMethods=new Set([...managementRead,'dsh.inspect','dsh.install','dsh.plugin-enabled','dsh.bundle-enabled','dsh.configure','dsh.remove','dsh.cancel'])
const managerErrors:Record<string,string>={DSH_PLUGIN_CONFLICT:'配置已更新，请读取最新状态后重新确认',DSH_PLUGIN_TARGET_CHANGED:'连接目标已变化，请重新读取',DSH_PLUGIN_NATIVE_REQUIRED:'请在桌面应用中执行此操作',DSH_PLUGIN_PROTECTED:'此项目不能修改',DSH_PLUGIN_UNSUPPORTED:'当前服务不支持插件管理',DSH_PLUGIN_DISCONNECTED:'DSH 未连接',DSH_PLUGIN_OPERATION_UNKNOWN:'操作结果尚未确认，请查询状态',DSH_PLUGIN_BUILD_APPROVAL_REQUIRED:'安装需要审核构建脚本',DSH_PLUGIN_RECEIPT_CAPACITY:'操作记录空间已满',DSH_PLUGIN_RECEIPT_READ_ONLY:'请查询原操作记录'}
const props=withDefaults(defineProps<{pluginId:string;version:string;active?:boolean}>(),{active:true}),emit=defineEmits<{configure:[string|undefined];changed:[];dirty:[boolean]}>()
const frame=ref<HTMLIFrameElement>(),error=ref(''),ready=ref(false),token=crypto.randomUUID()
const src=`/api/plugins/${encodeURIComponent(props.pluginId)}/ui?v=${encodeURIComponent(props.version)}#${token}`
let lifecycle=0,disposed=false,inflight=0,observer:MutationObserver,timeout:ReturnType<typeof setTimeout>
function post(value:unknown){frame.value?.contentWindow?.postMessage({protocol:'suna-ui-v1',token,pluginId:props.pluginId,...value as object},'*')}
function theme(){const style=getComputedStyle(document.documentElement);post({theme:Object.fromEntries(['text','muted','surface','soft','faint','hover','accent','on-accent','focus'].map(key=>[key,style.getPropertyValue(key==='soft'?'--panel':`--${key}`).trim()]))})}
async function receive(event:MessageEvent){
 const data=event.data;if(event.source!==frame.value?.contentWindow||event.origin!=='null'||data?.protocol!=='suna-ui-v1'||data.token!==token)return
 if(props.pluginId===managerId&&data.pluginId===managerId&&typeof data.dirty==='boolean'&&data.id===undefined&&data.method===undefined){emit('dirty',data.dirty);return}
 if(props.pluginId===managerId&&data.pluginId!==managerId)return
 if(data.ready===true){ready.value=true;error.value='';clearTimeout(timeout);theme();if(props.pluginId===managerId)post({active:props.active});return}
 if(!Number.isSafeInteger(data.id)||typeof data.method!=='string'||!data.params||typeof data.params!=='object'||Array.isArray(data.params))return
 if(inflight>=8){post({id:data.id,error:'请求过多，请稍候'});return}
 const requestLifecycle=lifecycle;inflight++;try{if(JSON.stringify(data).length>65536)throw new Error('请求内容过大')
   if(props.pluginId===managerId){
    if(!props.active){post({id:data.id,error:'界面已隐藏，请返回后重新读取',errorCode:'DSH_PLUGIN_INACTIVE'});return}
    if(!managementMethods.has(data.method))throw new Error('界面操作不受支持')
    let result;const native=window.sandbook?.manageDshPlugins
    if(native)result=await native({method:data.method,params:data.params})
    else{if(!managementRead.has(data.method))throw Object.assign(new Error(managerErrors.DSH_PLUGIN_NATIVE_REQUIRED),{code:'DSH_PLUGIN_NATIVE_REQUIRED'});result=await request(`/plugins/${managerId}/ui/rpc`,{method:data.method,params:data.params})}
    if(!disposed&&props.active&&requestLifecycle===lifecycle)post({id:data.id,result});return
   }
   if(data.method==='config.edit'){if(data.params.accountId!==undefined&&typeof data.params.accountId!=='string')throw new Error('账号无效');post({id:data.id,result:{opened:true}});emit('configure',data.params.accountId);return}
   if(!['context','channels.connect','channels.disconnect','channels.qr','channels.poll','channels.remove','channels.avatar','channels.administrator.save','characters.avatar','channels.managed.create'].includes(data.method))throw new Error('界面操作不受支持')
   let result
   if(data.method==='channels.managed.create'){
     if(!window.sandbook?.createManagedChannel)throw new Error('请在桌面应用中创建账号')
     result=await window.sandbook.createManagedChannel({pluginId:props.pluginId,characterId:data.params.characterId,requestId:data.params.requestId})
   }else if(data.method==='channels.administrator.save'){
     if(!window.sandbook?.setChannelAdministrator)throw new Error('请在桌面应用中设置管理员')
     result=await window.sandbook.setChannelAdministrator({pluginId:props.pluginId,accountId:data.params.accountId,characterId:data.params.characterId,administratorUid:data.params.administratorUid})
   }else result=await request(`/plugins/${encodeURIComponent(props.pluginId)}/ui/rpc`,{method:data.method,params:data.params})
   if(data.method==='context'&&result.managedNapcat&&!window.sandbook?.createManagedChannel)result={...result,managedNapcat:{...result.managedNapcat,canCreate:false,reason:'NATIVE_REQUIRED'}}
   if(data.method==='channels.managed.create'&&result.login?.qrContent){const QRCode=await import('qrcode');result={...result,login:{...result.login,qrImage:await QRCode.toDataURL(result.login.qrContent,{width:240,margin:2})}}}
   if(['channels.qr','channels.poll'].includes(data.method)&&result.qrContent){const QRCode=await import('qrcode');result={...result,qrImage:await QRCode.toDataURL(result.qrContent,{width:240,margin:2})}}
   if(!disposed){post({id:data.id,result});if(!['context','channels.poll','channels.avatar','characters.avatar'].includes(data.method))emit('changed')}
 }catch(cause){if(!disposed){if(props.pluginId===managerId){if(!props.active||requestLifecycle!==lifecycle)return;const code=typeof (cause as {code?:unknown})?.code==='string'?String((cause as {code:string}).code):'DSH_PLUGIN_FAILED';post({id:data.id,error:Object.hasOwn(managerErrors,code)?managerErrors[code]:'操作失败，请重新读取状态',errorCode:Object.hasOwn(managerErrors,code)?code:'DSH_PLUGIN_FAILED'})}else post({id:data.id,error:cause instanceof Error?cause.message:'操作失败'})}}finally{inflight--}
}
watch(()=>props.active,active=>{if(props.pluginId===managerId){lifecycle++;post({active})}},{flush:'sync'})
onMounted(()=>{window.addEventListener('message',receive);observer=new MutationObserver(theme);observer.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme']});timeout=setTimeout(()=>{if(!ready.value)error.value='插件界面未能加载，请重新选择插件'},15000)})
onBeforeUnmount(()=>{disposed=true;window.removeEventListener('message',receive);observer?.disconnect();clearTimeout(timeout)})
</script>
<template><div class="plugin-frame"><p v-if="error" role="alert" class="inline-error">{{error}}</p><p v-else-if="!ready" role="status" class="loading">正在加载插件界面…</p><iframe ref="frame" :src="src" title="插件详情" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"/></div></template>
<style scoped>
.plugin-frame{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden;background:var(--sand-bg-pane,var(--surface))}.plugin-frame iframe{display:block;width:100%;flex:1;min-height:280px;border:0;background:var(--sand-bg-pane,var(--surface));color-scheme:inherit}.loading,.inline-error{font-size:13px;line-height:20px;padding:16px 24px;flex-shrink:0}.loading{color:var(--muted)}.inline-error{color:var(--error);overflow-wrap:anywhere}@media(max-width:700px){.loading,.inline-error{padding:16px}}
</style>
