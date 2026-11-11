<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount,nextTick} from 'vue'
import {request} from '../api'
import Icon from './Icon.vue'
import CustomSelect from './CustomSelect.vue'

type Kind='memories'|'dreams'|'emojis'|'knowledge'
interface Entry {id:string;name?:string;title?:string;description?:string;desc?:string;text?:string;content?:string;excerpt?:string;createdAt?:string;time?:string;fiction?:boolean;covered?:string;coveredBy?:string[];related?:Array<{id:string;relation:string}>;sourceMessageIds?:string[];sourceConversationId?:string;source?:string;evidence?:Array<{source_message:string;quote:string}>;mime?:string}
interface DreamTask {id:string;characterId?:string;type?:string;status:string;code?:string;error?:string;createdAt?:string}
interface Listing {characterId?:string;items:Entry[];total:number;offset:number;limit:number;taskTotal?:number;workSummary?:string;tasks?:DreamTask[]}
interface DreamReceipt {status:'accepted';task_id:string;duplicate:boolean;characterId:string;conversationId:string;type:'dream_cycle'}
interface DreamSubmission {requestId:string;phase:'requesting'|'accepted'|'uncertain';taskId?:string;task?:DreamTask;error:string;refreshing:boolean}
interface Draft {title:string;description:string;content:string;data:string;mime:string;fileName:string;open:boolean;error:string}
const props=defineProps<{characterId:string;kind:Kind;active:boolean;dreamsSupported?:boolean}>(),emit=defineEmits<{notice:[string]}>()
const result=ref<Listing>(),loading=ref(false),error=ref(''),query=ref(''),search=ref(''),offset=ref(0),source=ref<'working'|'long'>('working'),selected=ref<Entry>(),detail=ref<Entry>(),detailBusy=ref(false),detailError=ref(''),writing=ref(false),fileInput=ref<HTMLInputElement>()
const detailElement=ref<HTMLElement>(),lastTrigger=ref<HTMLElement>()
const drafts=ref<Record<string,Draft>>({}),failedImages=ref<Record<string,boolean>>({})
const dreamSubmissions=ref<Record<string,DreamSubmission>>({})
const dreamSubmission=computed(()=>dreamSubmissions.value[props.characterId])
const dreamTaskFinished=(status:string)=>['completed','succeeded','failed','cancelled','interrupted'].includes(status)
const dreamPending=computed(()=>{const run=dreamSubmission.value;return run?.phase==='requesting'||run?.phase==='accepted'&&(!run.task||!dreamTaskFinished(run.task.status))})
const dreamRunFeedback=computed(()=>{const run=dreamSubmission.value;if(!props.dreamsSupported)return '当前后端不支持主动梦境';if(!run)return '';if(run.phase==='requesting')return '提交中…';if(run.phase==='uncertain')return '提交结果未确认，请刷新状态或重试提交';return run.task?`梦境任务${taskStatus(run.task.status)}`:'梦境任务已受理'})
const draftKey=computed(()=>`${props.characterId}:${props.kind}`)
const draft=computed(()=>drafts.value[draftKey.value]??(drafts.value[draftKey.value]={title:'',description:'',content:'',data:'',mime:'',fileName:'',open:false,error:''}))
const dirty=computed(()=>Object.values(drafts.value).some(item=>Boolean(item.title||item.description||item.content||item.data)))
const names:Record<Kind,string>={memories:'记忆',dreams:'梦境',emojis:'表情包',knowledge:'知识库'}
const pageTotal=computed(()=>Math.max(result.value?.total??0,props.kind==='dreams'?result.value?.taskTotal??0:0))
const title=computed(()=>names[props.kind]),canImport=computed(()=>props.kind==='emojis'||props.kind==='knowledge')
const base=()=>`/characters/${encodeURIComponent(props.characterId)}`
let generation=0,detailGeneration=0,fileGeneration=0,disposed=false
function errorText(cause:unknown){return cause&&typeof cause==='object'&&'message' in cause?String(cause.message):String(cause)}
function date(value?:string){if(!value)return '';const parsed=new Date(value);return Number.isNaN(parsed.valueOf())?value:parsed.toLocaleString('zh-CN',{hour12:false})}
function text(item:Entry){return item.desc??item.description??item.text??item.content??item.excerpt??''}
function taskStatus(value:string){return ({queued:'排队中',pending:'待执行',ready:'待处理',running:'执行中',completed:'已完成',succeeded:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'} as Record<string,string>)[value]??value}
function imageUrl(item:Entry){return `/api${base()}/emojis/${encodeURIComponent(item.id)}/image`}
function updateDreamTask(value:Listing,id:string){const run=dreamSubmissions.value[id];if(!run||value.characterId!==id)return;const task=value.tasks?.find(item=>item.id===(run.taskId??run.requestId)&&item.characterId===id&&['dream','dream_cycle'].includes(item.type??''));if(task){if(run.task&&dreamTaskFinished(run.task.status)&&!dreamTaskFinished(task.status))return;run.task=task;run.taskId=task.id;run.phase='accepted'}}
async function refreshDreamTask(id=props.characterId){
  const run=dreamSubmissions.value[id];if(!run||run.refreshing)return
  run.refreshing=true
  try{const value=await request<Listing>(`/characters/${encodeURIComponent(id)}/dreams?offset=0&limit=30`);if(disposed||dreamSubmissions.value[id]!==run)return;if(value.characterId!==id||!Array.isArray(value.items)||!Array.isArray(value.tasks))throw new Error('后端未确认当前角色的梦境任务状态');updateDreamTask(value,id);if(run.task)run.error='';if(props.characterId===id&&props.kind==='dreams'&&props.active&&!query.value&&offset.value===0&&!loading.value)result.value=value}
  catch(cause){if(!disposed&&dreamSubmissions.value[id]===run)run.error=`读取任务状态失败：${errorText(cause)}`}
  finally{if(!disposed&&dreamSubmissions.value[id]===run)run.refreshing=false}
}
async function runDream(){
  if(disposed||!props.active||props.kind!=='dreams'||props.dreamsSupported!==true||dreamPending.value||writing.value)return false
  const id=props.characterId,previous=dreamSubmissions.value[id]
  // Retrying an uncertain submission keeps its original idempotency key.
  const requestId=previous?.phase==='uncertain'?previous.requestId:`dream-ui:${window.crypto.randomUUID()}`
  dreamSubmissions.value[id]={requestId,phase:'requesting',error:'',refreshing:false}
  const run=dreamSubmissions.value[id]!
  try{
    const receipt=await request<DreamReceipt>(`/characters/${encodeURIComponent(id)}/dreams/run`,{taskId:requestId})
    if(disposed||dreamSubmissions.value[id]!==run)return false
    if(!receipt||receipt.status!=='accepted'||receipt.characterId!==id||receipt.type!=='dream_cycle'||typeof receipt.task_id!=='string'||!receipt.task_id.trim()||typeof receipt.conversationId!=='string'||!receipt.conversationId.trim()||typeof receipt.duplicate!=='boolean')throw new Error('后端未确认梦境任务已受理')
    run.phase='accepted';run.taskId=receipt.task_id
    if(props.characterId===id&&props.kind==='dreams'&&props.active&&props.dreamsSupported)emit('notice','梦境任务已受理')
    await refreshDreamTask(id)
    return true
  }catch(cause){if(!disposed&&dreamSubmissions.value[id]===run){if(run.phase==='accepted'&&run.task)return true;run.phase='uncertain';run.error=errorText(cause)}return false}
}
async function load(){
  const key=++generation,path=base(),kind=props.kind;result.value=undefined;error.value='';loading.value=true
  const params=new URLSearchParams({offset:String(offset.value),limit:'30'});if(query.value.trim())params.set('query',query.value.trim());if(kind==='memories')params.set('source',source.value)
  try{const value=await request<Listing>(`${path}/${kind}?${params}`);if(key===generation){result.value=value;if(kind==='dreams')updateDreamTask(value,props.characterId)}}
  catch(cause){if(key===generation)error.value=errorText(cause)}
  finally{if(key===generation)loading.value=false}
}
function resetDetail(){++detailGeneration;selected.value=undefined;detail.value=undefined;detailError.value='';detailBusy.value=false}
function refresh(){if(props.kind==='emojis'){const prefix=props.characterId+':';for(const key of Object.keys(failedImages.value))if(key.startsWith(prefix))delete failedImages.value[key]}resetDetail();void load();if(props.kind==='dreams'&&dreamSubmission.value)void refreshDreamTask()}
function runSearch(){query.value=search.value.trim();offset.value=0;refresh()}
function changePage(step:number){offset.value=Math.max(0,offset.value+step*30);refresh()}
watch(()=>[props.characterId,props.kind,props.active] as const,()=>{++fileGeneration;resetDetail();query.value='';search.value='';offset.value=0;result.value=undefined;error.value='';++generation;loading.value=false;if(props.active)void load()},{immediate:true})
function changeSource(){offset.value=0;refresh()}
async function focusDetail(key:number){await nextTick();if(key!==detailGeneration||!selected.value)return;detailElement.value?.focus({preventScroll:true});detailElement.value?.scrollIntoView({block:'start'})}
function closeDetail(){const trigger=lastTrigger.value;resetDetail();if(trigger?.isConnected){trigger.focus({preventScroll:true});trigger.scrollIntoView({block:'nearest'})}}
async function openEntry(item:Entry,event?:Event){
  resetDetail();selected.value=item;if(event?.currentTarget)lastTrigger.value=event.currentTarget as HTMLElement;void focusDetail(detailGeneration)
  if(props.kind!=='knowledge'){detail.value=item;return}
  const key=detailGeneration,path=base();detailBusy.value=true
  try{const value=await request<Entry>(`${path}/knowledge/${encodeURIComponent(item.id)}`);if(key===detailGeneration)detail.value=value}
  catch(cause){if(key===detailGeneration)detailError.value=errorText(cause)}
  finally{if(key===detailGeneration)detailBusy.value=false}
}
function discard(){drafts.value[draftKey.value]={title:'',description:'',content:'',data:'',mime:'',fileName:'',open:false,error:''};++fileGeneration}
async function chooseFile(event:Event){
  const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return
  const key=draftKey.value,target=draft.value,kind=props.kind,token=++fileGeneration;target.error=''
  try{
    if(kind==='knowledge'){
      if(!/\.(md|txt)$/i.test(file.name)||file.size>1024*1024)throw new Error('请选择不超过 1 MB 的 TXT 或 Markdown 文档')
      const content=await file.text();if(token!==fileGeneration||draftKey.value!==key)return
      if(content.includes('\0'))throw new Error('文档包含无效文本')
      target.title=file.name.replace(/\.(md|txt)$/i,'');target.content=content;target.fileName=file.name
    }else{
      if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)||file.size>8*1024*1024)throw new Error('请选择不超过 8 MB 的 PNG、JPEG、WebP 或 GIF 图片')
      const bytes=new Uint8Array(await file.arrayBuffer());if(token!==fileGeneration||draftKey.value!==key)return
      let binary='';for(let index=0;index<bytes.length;index+=8192)binary+=String.fromCharCode(...bytes.subarray(index,index+8192))
      target.data=btoa(binary);target.mime=file.type;target.title=file.name.replace(/\.[^.]+$/,'');target.fileName=file.name
    }
    target.open=true
  }catch(cause){if(token===fileGeneration)target.error=errorText(cause)}
}
async function saveImport(){
  if(writing.value)return false
  const target=draft.value,key=draftKey.value,kind=props.kind,path=base(),before=JSON.stringify(target)
  if(!target.title.trim()||(kind==='knowledge'?!target.content.trim():!target.data)){target.error=kind==='knowledge'?'请填写标题和正文':'请选择图片并填写名称';return false}
  writing.value=true;target.error=''
  try{
    await request(`${path}/${kind}`,kind==='knowledge'?{title:target.title.trim(),content:target.content}:{name:target.title.trim(),description:target.description.trim(),data:target.data,mime:target.mime})
    if(JSON.stringify({...target,error:''})===JSON.stringify({...JSON.parse(before),error:''}))delete drafts.value[key]
    emit('notice',kind==='knowledge'?'文档已导入':'表情包已导入')
    if(draftKey.value===key){offset.value=0;resetDetail();await load()}
    return true
  }catch(cause){target.error=errorText(cause);return false}
  finally{writing.value=false}
}
function beforeLeave(event:BeforeUnloadEvent){if(dirty.value){event.preventDefault();event.returnValue=''}}
window.addEventListener('beforeunload',beforeLeave)
onBeforeUnmount(()=>{disposed=true;++generation;++detailGeneration;++fileGeneration;window.removeEventListener('beforeunload',beforeLeave)})
defineExpose({dirty,writing})
</script>

<template>
<section class="character-resources" :aria-label="title">
  <header class="resources-heading"><h3>{{title}}</h3><div class="resources-actions"><button v-if="kind==='dreams'" type="button" class="button primary" :disabled="!active||!dreamsSupported||dreamPending||writing" @click="runDream"><Icon name="moon" :size="16"/>{{dreamSubmission?.phase==='requesting'?'提交中…':dreamSubmission?.phase==='uncertain'?'重试提交':'开始梦境'}}</button><button v-if="canImport" type="button" class="button" :disabled="writing" @click="draft.open=!draft.open"><Icon name="plus" :size="16"/>{{kind==='knowledge'?'添加文档':'导入表情包'}}</button><button type="button" class="button" :disabled="loading||writing||dreamSubmission?.refreshing" @click="refresh"><Icon name="refresh" :size="16"/>刷新</button></div></header>
  <div v-if="kind==='dreams'&&dreamRunFeedback" class="dream-run-feedback" aria-live="polite"><p>{{dreamRunFeedback}}</p><p v-if="dreamSubmission?.error" class="inline-error" role="alert">{{dreamSubmission.error}}</p></div>
  <div v-if="canImport" v-show="draft.open||draft.error" class="resource-import">
    <form @submit.prevent="saveImport">
      <div class="resources-actions"><button type="button" class="button" :disabled="writing" @click="fileInput?.click()"><Icon name="upload" :size="16"/>{{kind==='knowledge'?'选择 TXT / Markdown':'选择图片'}}</button><span class="muted">{{draft.fileName}}</span></div>
      <input ref="fileInput" hidden type="file" :accept="kind==='knowledge'?'.txt,.md':'image/png,image/jpeg,image/webp,image/gif'" @change="chooseFile"/>
      <label class="field">{{kind==='knowledge'?'标题':'名称'}}<input v-model="draft.title" maxlength="200" :disabled="writing" required/></label>
      <label v-if="kind==='knowledge'" class="field">正文<textarea v-model="draft.content" rows="10" maxlength="500000" :disabled="writing" required/></label>
      <label v-else class="field">描述<input v-model="draft.description" maxlength="2000" :disabled="writing"/></label>
      <p v-if="draft.error" class="inline-error" role="alert">{{draft.error}}</p>
      <footer class="resources-actions"><span v-if="draft.title||draft.content||draft.data" class="muted">未保存</span><button type="button" class="button" :disabled="writing" @click="discard">放弃导入</button><button class="button primary" :disabled="writing"><Icon name="save" :size="16"/>{{writing?'导入中…':'保存'}}</button></footer>
    </form>
  </div>
  <form class="resources-toolbar" role="search" @submit.prevent="runSearch"><CustomSelect v-if="kind==='memories'" v-model="source" :options="[{value:'working',label:'工作记忆'},{value:'long',label:'长期记忆'}]" aria-label="记忆类型" @change="changeSource"/><label class="resource-search"><Icon name="search" :size="16"/><input v-model="search" type="search" :placeholder="`搜索${title}`" :aria-label="`搜索${title}`"/></label><button class="button" :disabled="loading"><Icon name="search" :size="16"/>搜索</button></form>
  <p v-if="loading" class="resource-state" role="status">读取中…</p>
  <div v-else-if="error" class="resource-state" role="alert"><p>{{error}}</p><button type="button" class="button" @click="refresh"><Icon name="refresh" :size="16"/>重试</button></div>
  <template v-else-if="result">
    <details v-if="kind==='memories'&&source==='working'&&result.workSummary" class="resource-summary"><summary>工作记忆摘要</summary><p>{{result.workSummary}}</p></details>
    <p v-if="!result.items.length" class="resource-state">{{query?'没有匹配结果':`暂无${title==='知识库'?'知识库文档':title}`}}</p>
    <div v-else :class="kind==='emojis'?'resource-images':'resource-list'">
      <button v-for="item in result.items" :key="item.id" type="button" class="resource-entry" :class="{selected:selected?.id===item.id}" :aria-pressed="selected?.id===item.id" @click="openEntry(item,$event)">
        <template v-if="kind==='emojis'"><img v-if="!failedImages[`${characterId}:${item.id}`]" :src="imageUrl(item)" :alt="item.name??'表情包'" loading="lazy" @error="failedImages[`${characterId}:${item.id}`]=true"/><span v-else class="image-error">图片读取失败</span></template>
        <span class="resource-entry-body"><strong v-if="item.title||item.name">{{item.title??item.name}}</strong><span v-else class="entry-preview">{{text(item).slice(0,180)}}</span><span v-if="item.title||item.name" class="entry-preview muted">{{text(item).slice(0,100)}}</span><span v-if="item.createdAt||item.time" class="entry-date">{{date(item.createdAt??item.time)}}</span><span v-if="kind==='dreams'||item.fiction" class="entry-date">虚构</span></span><Icon v-if="kind!=='emojis'" name="chevron" :size="16"/>
      </button>
    </div>
    <footer v-if="pageTotal>30" class="resources-pagination"><button type="button" class="button" :disabled="offset===0||loading" @click="changePage(-1)"><Icon name="back" :size="16"/>上一页</button><span>{{offset+1}}–{{Math.min(offset+30,pageTotal)}} / {{pageTotal}}</span><button type="button" class="button" :disabled="offset+30>=pageTotal||loading" @click="changePage(1)"><Icon name="chevron" :size="16"/>下一页</button></footer>
    <details v-if="kind==='dreams'&&result.tasks?.length" class="resource-summary"><summary>梦境任务</summary><div v-for="task in result.tasks" :key="task.id" class="dream-task"><span>{{date(task.createdAt)}}</span><span>{{taskStatus(task.status)}}</span><span v-if="task.code">{{task.code}}</span></div></details>
  </template>
  <section v-if="selected" ref="detailElement" tabindex="-1" :aria-busy="detailBusy" class="resource-detail" :aria-label="`${title}详情`"><header class="resources-heading"><h4>{{selected.title??selected.name??`${title}详情`}}</h4><button type="button" class="text-button" @click="closeDetail"><Icon name="close" :size="16"/>关闭详情</button></header><p v-if="detailBusy" role="status">读取正文中…</p><div v-else-if="detailError" role="alert"><p class="inline-error">{{detailError}}</p><button type="button" class="button" @click="openEntry(selected)"><Icon name="refresh" :size="16"/>重试</button></div><template v-else-if="detail"><template v-if="kind==='emojis'"><img v-if="!failedImages[`${characterId}:${detail.id}`]" class="emoji-detail" :src="imageUrl(detail)" :alt="detail.name??'表情包'" @error="failedImages[`${characterId}:${detail.id}`]=true"/><p v-else class="inline-error" role="alert">图片读取失败</p></template><p class="resource-content">{{kind==='knowledge'?detail.content:text(detail)}}</p><p v-if="detail.covered" class="muted">此前版本：{{detail.covered}}</p><p v-if="detail.coveredBy?.length" class="muted">后续版本：{{detail.coveredBy?.join('、')}}</p><p v-if="detail.sourceConversationId" class="muted">来源会话：{{detail.sourceConversationId}}</p><p v-if="detail.sourceMessageIds?.length" class="muted">来源消息：{{detail.sourceMessageIds.join('、')}}</p><div v-if="detail.related?.length" class="resource-summary"><h4>关联记忆</h4><p v-for="related in detail.related" :key="related.id">{{related.relation}} · {{related.id}}</p></div><details v-if="detail.evidence?.length" class="resource-summary"><summary>来源证据</summary><blockquote v-for="(evidence,index) in detail.evidence" :key="index"><p>{{evidence.quote}}</p><span class="muted">消息 {{evidence.source_message}}</span></blockquote></details></template></section>
</section>
</template>
<style scoped>
.character-resources{min-width:0;font-size:14px;line-height:20px;container-type:inline-size}.dream-run-feedback{font-size:13px;line-height:20px;margin:0 0 16px;overflow-wrap:anywhere}.dream-run-feedback p+p{margin-top:4px}.resources-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;min-width:0}.resources-heading h3{font-size:17px;line-height:24px;font-weight:500}.resources-heading h4{margin:0;font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}.resources-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.resources-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:16px 0}.resources-toolbar>.custom-select{flex:0 0 132px;width:132px;min-width:120px}.resource-search{display:flex;align-items:center;gap:8px;min-width:100px;flex:1 1 140px;height:28px;background:var(--sand-bg-secondary,var(--input));border:.5px solid var(--sand-border-secondary-translucent,var(--faint));border-radius:10px;padding:4px 8px;color:var(--muted)}.resource-search:focus-within{border-color:var(--sand-border-primary-translucent,var(--faint))}.resource-search input{width:100%;min-width:0;padding:0;border:0;background:transparent;font-size:13px;line-height:18px}.resource-state{padding:28px 12px;color:var(--muted);font-size:13px;line-height:20px;text-align:center;overflow-wrap:anywhere}.resource-state>.button{margin-top:12px}.resource-state>p{overflow-wrap:anywhere}.resource-list{display:grid;gap:4px;min-width:0}.resource-entry{display:flex;align-items:center;text-align:left;width:100%;min-width:0;gap:12px;padding:8px;border:0;background:transparent;color:var(--text);border-radius:10px;cursor:pointer}.resource-entry:hover{background:var(--sand-bg-hover,var(--hover))}.resource-entry.selected,.resource-entry.selected:hover{background:var(--sand-bg-active,var(--selected))}.resource-entry-body{display:grid;gap:4px;flex:1;min-width:0}.resource-entry-body strong{font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}.entry-preview{font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}.entry-date{color:var(--muted);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}.resource-images{display:grid;grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:8px}.resource-images .resource-entry{display:flex;flex-direction:column;align-items:stretch;border-radius:10px;min-width:0;padding:8px}.resource-images img,.image-error{width:100%;height:116px;object-fit:contain;background:var(--sand-bg-secondary,var(--input));border-radius:10px}.image-error{display:flex;align-items:center;justify-content:center;font-size:12px;line-height:18px;color:var(--muted)}.resource-images .entry-preview{font-size:12px;line-height:18px}.resource-images .resource-entry-body strong{font-size:13px;line-height:18px}
.resource-import{border:.5px solid var(--sand-border-secondary-translucent,var(--faint));border-radius:14px;padding:16px;background:var(--sand-bg-elevated,var(--surface));margin-bottom:16px}.resource-import .field{margin:16px 0}.resource-import textarea{min-height:160px;resize:none;font-size:14px;line-height:22px}.resource-import footer{justify-content:flex-end}.resource-import footer>.muted{margin-right:auto}.muted{color:var(--muted);font-size:12px;line-height:18px;overflow-wrap:anywhere}.resources-pagination{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:16px;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}.resource-detail{padding:16px;margin-top:24px;min-width:0;border:.5px solid var(--sand-border-secondary-translucent,var(--faint));border-radius:14px;background:var(--sand-bg-elevated,var(--surface));scroll-margin-top:12px}.resource-content{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:22px;max-width:75ch}.emoji-detail{display:block;max-width:min(100%,360px);max-height:360px;object-fit:contain;margin-bottom:16px}.resource-summary{margin:16px 0;font-size:13px;line-height:20px;min-width:0}.resource-summary>summary{cursor:pointer;min-height:28px}.resource-summary>p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:22px}.resource-summary blockquote{margin:12px 0;padding:0 12px;border-left:1px solid var(--sand-border-secondary-translucent,var(--faint))}.resource-summary blockquote p{font-size:14px;line-height:22px;white-space:pre-wrap;overflow-wrap:anywhere}.resource-summary h4{font-size:13px;line-height:20px;font-weight:500;margin:0 0 8px}.dream-task{display:flex;flex-wrap:wrap;gap:8px;padding:8px 0;border-top:.5px solid var(--sand-border-quaternary-translucent,var(--faint));font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
@container(max-width:520px){.resources-heading{align-items:flex-start;flex-wrap:wrap}.resources-toolbar{flex-wrap:wrap}.resources-toolbar>.custom-select{flex-basis:100%;width:100%}.resource-images{grid-template-columns:repeat(auto-fill,minmax(104px,1fr))}.resources-pagination{justify-content:space-between;gap:8px}.resource-detail{padding:16px}}
.resource-search input:focus-visible{outline:none}.keyboard .resource-search:has(input:focus-visible){outline:2px solid var(--sand-border-focus-primary,var(--focus));outline-offset:2px}
</style>
