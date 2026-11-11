<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,ref,watch} from 'vue'
import type {Character,PersonProfile,PersonProfilePage} from '../types'
import {request} from '../api'
import Icon from './Icon.vue'
import CustomSelect from './CustomSelect.vue'
import CharacterAvatar from './CharacterAvatar.vue'
import TooltipButton from './TooltipButton.vue'

const props=withDefaults(defineProps<{characterId:string;active:boolean;characters?:Character[];scrollContainer?:HTMLElement}>(),{characters:()=>[]})
interface BrowseState {search:string;query:string;kind:string;offset:number;scrollTop:number;result?:PersonProfilePage}
const search=ref(''),query=ref(''),kind=ref(''),offset=ref(0),result=ref<PersonProfilePage>(),loading=ref(false),error=ref('')
const selected=ref<PersonProfile>(),detail=ref<PersonProfile>(),detailBusy=ref(false),detailError=ref(''),copyStatus=ref('')
const detailHeading=ref<HTMLElement>(),rowButtons=new Map<string,HTMLElement>(),views=new Map<string,BrowseState>()
const pageSize=30
let observer=props.characterId,listGeneration=0,detailGeneration=0,listController:AbortController|undefined,detailController:AbortController|undefined,listScrollTop=0,lastTriggerId=''
const title=computed(()=>selected.value?subjectName(selected.value):'人物画像')
const visibleItems=computed(()=>result.value?.items??[])
const profileAliases=computed(()=>{const aliases=detail.value?.aliases;return Array.isArray(aliases)?aliases:[]})
const filterOptions=[{value:'',label:'全部对象'},{value:'human',label:'联系人'},{value:'character',label:'角色'}]
function subjectName(item:PersonProfile){return item.subject.name?.trim()||item.subject.id}
function platformName(value:string){return ({qq:'QQ',desktop:'本机',suna:'SUNA',weixin:'微信',wechat:'微信'} as Record<string,string>)[value]??value}
function subjectType(item:PersonProfile){return item.subject.kind==='character'?'角色':'联系人'}
function personFor(item:PersonProfile){return item.subject.kind==='character'&&item.subject.platform==='suna'?props.characters.find(person=>person.id===item.subject.id):undefined}
function date(value?:string){if(!value)return '未记录';const parsed=new Date(value);return Number.isNaN(parsed.valueOf())?'未记录':parsed.toLocaleString('zh-CN',{hour12:false})}
function rowDate(item:PersonProfile){const parsed=new Date(item.updatedAt);return `${item.source?.kind==='sunabot'?'导入':'更新'} ${Number.isNaN(parsed.valueOf())?'未记录':parsed.toLocaleDateString('zh-CN')}`}
function sourceName(item:PersonProfile){return item.source?({tool:'工具记录',manual:'手动记录',sunabot:'Sunabot 导入'}[item.source.kind]):'未保留来源'}
function errorText(cause:unknown){return cause&&typeof cause==='object'&&'message' in cause?String(cause.message):'人物画像读取失败'}
function base(id=props.characterId){return `/characters/${encodeURIComponent(id)}/profiles`}
function remember(){if(!observer)return;views.set(observer,{search:search.value,query:query.value,kind:kind.value,offset:offset.value,scrollTop:selected.value?listScrollTop:props.scrollContainer?.scrollTop??0,result:result.value})}
function cancelList(){++listGeneration;listController?.abort();listController=undefined;loading.value=false}
function resetDetail(){++detailGeneration;detailController?.abort();detailController=undefined;selected.value=undefined;detail.value=undefined;detailBusy.value=false;detailError.value='';copyStatus.value=''}
function isCurrent(id:string,generation:number){return props.active&&props.characterId===id&&generation===listGeneration}
async function restoreScroll(id:string,generation:number){await nextTick();if(isCurrent(id,generation)&&!selected.value)props.scrollContainer?.scrollTo({top:listScrollTop})}
async function load(keep=false){
  if(!props.active||!props.characterId)return
  cancelList();const generation=listGeneration,id=props.characterId,controller=new AbortController();listController=controller
  if(!keep){result.value=undefined;props.scrollContainer?.scrollTo({top:0})}
  error.value='';loading.value=true
  const params=new URLSearchParams({offset:String(offset.value),limit:String(pageSize)});if(query.value)params.set('query',query.value);if(kind.value)params.set('kind',kind.value)
  try{
    const value=await request<PersonProfilePage>(`${base(id)}?${params}`,undefined,undefined,false,controller.signal)
    if(!isCurrent(id,generation))return
    if(!Array.isArray(value.items)||value.items.some(item=>item.characterId!==id))throw new Error('人物画像所属角色不一致')
    if(value.total>0&&offset.value>=value.total){offset.value=Math.floor((value.total-1)/pageSize)*pageSize;listScrollTop=0;void load();return}
    result.value=value;remember();void restoreScroll(id,generation)
  }catch(cause){if(isCurrent(id,generation)&&!controller.signal.aborted)error.value=errorText(cause)}
  finally{if(isCurrent(id,generation)){loading.value=false;if(listController===controller)listController=undefined}}
}
function refresh(){if(selected.value)void openEntry(selected.value);else void load(true)}
function runSearch(){query.value=search.value.trim();offset.value=0;listScrollTop=0;resetDetail();void load()}
function clearSearch(){search.value='';runSearch()}
function changeKind(){offset.value=0;listScrollTop=0;resetDetail();void load()}
function changePage(step:number){offset.value=Math.max(0,offset.value+step*pageSize);listScrollTop=0;void load()}
function setRowRef(id:string,node:unknown){if(node)rowButtons.set(id,node as HTMLElement);else rowButtons.delete(id)}
async function openEntry(item:PersonProfile,event?:Event){
  if(!props.active||item.characterId!==props.characterId)return
  if(!selected.value){listScrollTop=props.scrollContainer?.scrollTop??0;lastTriggerId=item.id}
  if(event?.currentTarget)lastTriggerId=item.id
  resetDetail();selected.value=item;detailBusy.value=true
  const generation=detailGeneration,id=props.characterId,controller=new AbortController();detailController=controller
  await nextTick();if(generation===detailGeneration&&props.active&&props.characterId===id){detailHeading.value?.focus({preventScroll:true});props.scrollContainer?.scrollTo({top:0})}
  if(generation!==detailGeneration||!props.active||props.characterId!==id||controller.signal.aborted)return
  try{
    const value=await request<PersonProfile>(`${base(id)}/${encodeURIComponent(item.id)}`,undefined,undefined,false,controller.signal)
    if(generation!==detailGeneration||props.characterId!==id||!props.active)return
    if(value.characterId!==id||value.id!==item.id)throw new Error('人物画像所属对象不一致')
    detail.value=value
  }catch(cause){if(generation===detailGeneration&&props.characterId===id&&props.active&&!controller.signal.aborted)detailError.value=(cause as {status?:number})?.status===404?'人物画像已不存在':errorText(cause)}
  finally{if(generation===detailGeneration&&props.characterId===id&&props.active){detailBusy.value=false;if(detailController===controller)detailController=undefined}}
}
async function closeDetail(){
  const id=props.characterId,trigger=lastTriggerId;resetDetail();const generation=detailGeneration
  await nextTick();if(generation!==detailGeneration||id!==props.characterId||!props.active)return
  rowButtons.get(trigger)?.focus({preventScroll:true});props.scrollContainer?.scrollTo({top:listScrollTop})
}
function onKey(event:KeyboardEvent){if(event.key==='Escape'&&selected.value){event.preventDefault();event.stopPropagation();void closeDetail()}}
async function copySubjectId(){
  const item=detail.value,generation=detailGeneration,id=props.characterId;if(!item)return
  try{await navigator.clipboard.writeText(item.subject.id);if(generation===detailGeneration&&id===props.characterId&&props.active)copyStatus.value='标识已复制'}
  catch{if(generation===detailGeneration&&id===props.characterId&&props.active)copyStatus.value='复制失败'}
}
watch(()=>[props.characterId,props.active] as const,([id,active])=>{
  remember();cancelList();resetDetail();observer=id;rowButtons.clear();lastTriggerId=''
  const saved=views.get(id);search.value=saved?.search??'';query.value=saved?.query??'';kind.value=saved?.kind??'';offset.value=saved?.offset??0;result.value=saved?.result;listScrollTop=saved?.scrollTop??0;error.value=''
  if(active)void load(Boolean(result.value))
},{immediate:true,flush:'sync'})
onBeforeUnmount(()=>{cancelList();resetDetail()})
</script>

<template>
<section class="person-profiles" aria-label="人物画像" @keydown="onKey">
  <header class="profiles-heading">
    <div class="profiles-title"><button v-if="selected" type="button" class="text-button" @click="closeDetail"><Icon name="back" :size="16"/>返回列表</button><h3 ref="detailHeading" :tabindex="selected?-1:undefined">{{title}}</h3></div>
    <TooltipButton label="刷新人物画像" icon="refresh" :disabled="loading||detailBusy" @click="refresh"/>
  </header>
  <template v-if="!selected">
    <form class="profiles-tools" role="search" @submit.prevent="runSearch">
      <label class="profiles-search"><Icon name="search" :size="16"/><input v-model="search" type="search" maxlength="500" placeholder="搜索人物、称呼或认知" aria-label="搜索人物画像"/></label>
      <button type="submit" class="button" :disabled="loading"><Icon name="search" :size="16"/>搜索</button>
      <CustomSelect v-model="kind" :options="filterOptions" aria-label="画像对象类型" @change="changeKind"/>
    </form>
    <p v-if="loading" class="profiles-status" role="status">{{result?'刷新中…':'读取中…'}}</p>
    <div v-if="error" class="profiles-error" role="alert"><p>{{error}}</p><button type="button" class="button" @click="refresh"><Icon name="refresh" :size="16"/>重试</button></div>
    <template v-if="result">
      <div v-if="!visibleItems.length&&!loading" class="profiles-state"><p>{{query||kind?'没有匹配的人物':'暂无人物画像'}}</p><button v-if="query" type="button" class="text-button" @click="clearSearch">清除搜索</button></div>
      <div v-else-if="visibleItems.length" class="profiles-list">
        <button v-for="item in visibleItems" :key="item.id" :ref="node=>setRowRef(item.id,node)" type="button" class="profile-row" @click="openEntry(item,$event)">
          <CharacterAvatar v-if="personFor(item)" :person="personFor(item)"/>
          <span v-else class="profile-avatar" :class="{'profile-role-avatar':item.subject.kind==='character'}" aria-hidden="true"><Icon :name="item.subject.kind==='character'?'people':'person'" :size="20"/></span>
          <span class="profile-row-content"><span class="profile-row-main"><span class="profile-row-name">{{subjectName(item)}}</span><time :datetime="item.updatedAt">{{rowDate(item)}}</time></span><span class="profile-row-meta"><span v-if="item.addressNames[0]" class="profile-address">{{item.addressNames[0]}}</span><span class="profile-row-identity">{{platformName(item.subject.platform)}} · {{item.subject.id}}</span></span></span><Icon name="chevron" :size="16"/>
        </button>
      </div>
      <footer v-if="result.total>pageSize" class="profiles-pagination"><button type="button" class="button" :disabled="offset===0||loading" @click="changePage(-1)"><Icon name="back" :size="16"/>上一页</button><span>{{offset+1}}–{{Math.min(offset+pageSize,result.total)}} / {{result.total}}</span><button type="button" class="button" :disabled="offset+pageSize>=result.total||loading" @click="changePage(1)">下一页<Icon name="chevron" :size="16"/></button></footer>
    </template>
  </template>
  <section v-else class="profile-detail" :aria-busy="detailBusy" aria-label="人物画像详情">
    <p v-if="detailBusy" class="profiles-status" role="status">读取中…</p>
    <div v-else-if="detailError" class="profiles-error" role="alert"><p>{{detailError}}</p><button type="button" class="button" @click="openEntry(selected)"><Icon name="refresh" :size="16"/>重试</button></div>
    <template v-else-if="detail">
      <section class="profile-section"><h4>认知</h4><p class="profile-body">{{detail.profile||'未记录认知'}}</p></section>
      <section class="profile-section"><h4>称呼</h4><ol v-if="detail.addressNames.length" class="profile-addresses"><li v-for="(address,index) in detail.addressNames" :key="index">{{address}}<span v-if="index===0" class="profile-preferred">首选</span></li></ol><p v-else class="profiles-status">未记录称呼</p></section>
      <section class="profile-section"><h4>身份记录</h4><dl class="profile-facts"><div><dt>显示名</dt><dd>{{detail.subject.name||'未记录'}}</dd></div><div><dt>对象类型</dt><dd>{{subjectType(detail)}}</dd></div><div><dt>平台</dt><dd>{{platformName(detail.subject.platform)}}</dd></div><div><dt>对象标识</dt><dd class="profile-id"><span>{{detail.subject.id}}</span><TooltipButton label="复制对象标识" icon="copy" :size="16" @click="copySubjectId"/></dd></div><div v-if="profileAliases.length"><dt>关联身份</dt><dd><ul class="profile-aliases"><li v-for="(alias,index) in profileAliases" :key="index"><span class="profile-alias-platform">{{platformName(alias.platform)}}</span><span>{{alias.id}}</span></li></ul></dd></div><div><dt>记录更新</dt><dd><time :datetime="detail.updatedAt">{{date(detail.updatedAt)}}</time></dd></div></dl><p v-if="copyStatus" class="profiles-status" role="status">{{copyStatus}}</p></section>
      <section class="profile-section"><h4>来源</h4><dl class="profile-facts"><div><dt>来源类型</dt><dd>{{sourceName(detail)}}</dd></div><template v-if="detail.source"><div v-if="detail.source.time"><dt>原记录时间</dt><dd>{{date(detail.source.time)}}</dd></div><div v-if="detail.source.conversationId"><dt>来源会话</dt><dd>{{detail.source.conversationId}}</dd></div><div v-if="detail.source.messageId"><dt>来源消息</dt><dd>{{detail.source.messageId}}</dd></div><div v-if="detail.source.recordId"><dt>导入记录</dt><dd>{{detail.source.recordId}}</dd></div><div v-if="detail.source.sourceProfileId"><dt>原画像标识</dt><dd>{{detail.source.sourceProfileId}}</dd></div></template></dl></section>
    </template>
  </section>
</section>
</template>
<style scoped>
.person-profiles{min-width:0;color:var(--text);font-size:14px;font-weight:420;line-height:20px;container-type:inline-size}
.profiles-heading,.profiles-title{display:flex;align-items:center;gap:12px;min-width:0}.profiles-heading{justify-content:space-between;margin-bottom:16px}.profiles-title{flex-wrap:wrap;gap:8px 12px}.profiles-title h3{font-size:17px;line-height:24px;font-weight:500;overflow-wrap:anywhere;margin:0}.profiles-title .text-button{flex-shrink:0}
.profiles-tools{display:grid;grid-template-columns:minmax(100px,1fr) auto 132px;gap:8px;margin-bottom:16px;align-items:center}.profiles-search{display:flex;align-items:center;min-width:0;gap:8px;height:28px;padding:4px 8px;border:.5px solid var(--sand-border-secondary-translucent,var(--faint));background:var(--sand-bg-secondary,var(--input));border-radius:10px;color:var(--muted)}.profiles-search:focus-within{border-color:var(--sand-border-primary-translucent,var(--faint))}.profiles-search input{width:100%;min-width:0;border:0;background:transparent;padding:0;font:inherit;font-size:13px;line-height:18px;color:var(--text)}
.profiles-status,.profiles-error,.profiles-state{font-size:13px;line-height:20px;color:var(--muted)}.profiles-status{margin:12px 0}.profiles-error{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0;color:var(--error)}.profiles-error p{margin:0;overflow-wrap:anywhere}.profiles-error .button{flex-shrink:0}.profiles-state{padding:32px 16px;text-align:center}.profiles-state p{margin:0}.profiles-state .text-button{margin-top:8px}
.profiles-list{display:flex;flex-direction:column;min-width:0;gap:0}.profile-row{display:flex;align-items:center;gap:8px;width:100%;min-width:0;min-height:54px;padding:8px;text-align:left;background:transparent;border:0;border-radius:10px;color:var(--text);cursor:pointer}.profile-row:hover{background:var(--sand-bg-hover,var(--hover))}.profile-row>.avatar,.profile-avatar{flex:0 0 36px;width:36px;height:36px}.profile-avatar{display:flex;align-items:center;justify-content:center;background:var(--sand-bg-secondary,var(--input));border-radius:10px;color:var(--muted)}.profile-role-avatar{border-radius:50%}.profile-row-content{flex:1;min-width:0;display:grid;gap:4px}.profile-row-main,.profile-row-meta{display:flex;align-items:center;gap:8px;min-width:0}.profile-row-name{font-size:14px;line-height:20px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.profile-row-main time{flex-shrink:0;margin-left:auto;color:var(--muted);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}.profile-row-meta{color:var(--muted);font-size:13px;line-height:18px}.profile-address{max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.profile-row-identity{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.profiles-pagination{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap;margin-top:16px;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}.profile-detail{min-width:0;padding:16px;border:.5px solid var(--sand-border-secondary-translucent,var(--faint));border-radius:14px;background:var(--sand-bg-elevated,var(--surface))}.profile-section+.profile-section{margin-top:24px;padding-top:20px;border-top:.5px solid var(--sand-border-quaternary-translucent,var(--faint))}.profile-section h4{font-size:12px;font-weight:420;line-height:16px;color:var(--muted);margin:0 0 8px}.profile-body{font-size:14px;font-weight:420;line-height:22px;max-width:75ch;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.profile-addresses{display:flex;flex-wrap:wrap;gap:8px 20px;padding:0;list-style:none;margin:0}.profile-addresses li{display:flex;gap:8px;align-items:baseline;font-size:14px;line-height:22px;overflow-wrap:anywhere}.profile-preferred{font-size:11px;line-height:16px;color:var(--muted)}.profile-facts{margin:0;display:grid;gap:8px}.profile-facts>div{display:grid;grid-template-columns:88px minmax(0,1fr);align-items:start;gap:12px}.profile-facts dt{font-size:12px;font-weight:420;color:var(--muted);line-height:20px}.profile-facts dd{font-size:13px;font-weight:420;line-height:20px;margin:0;overflow-wrap:anywhere;min-width:0}.profile-id{display:flex;align-items:flex-start;gap:8px}.profile-id>span{min-width:0;flex:1}.profile-id :deep(.icon-button){flex-shrink:0;margin-top:-4px}.profile-aliases{display:grid;gap:8px;list-style:none;margin:0;padding:0}.profile-aliases li{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:baseline;gap:8px;font-size:13px;line-height:20px;min-width:0}.profile-aliases li>span{min-width:0;overflow-wrap:anywhere}.profile-aliases .profile-alias-platform{font-size:12px;color:var(--muted)}
@container(max-width:520px){.profiles-tools{grid-template-columns:minmax(0,1fr) auto}.profiles-tools>.custom-select{grid-column:1/-1;width:100%}.profile-row-main{align-items:flex-start;flex-wrap:wrap;gap:4px 8px}.profile-row-main time{margin-left:0;flex-basis:100%;font-size:11px}.profile-row-content{gap:4px}.profile-row{min-height:62px;padding:8px}.profile-detail{padding:16px}.profile-facts>div{grid-template-columns:72px minmax(0,1fr);gap:8px}.profiles-pagination{justify-content:space-between;gap:8px}}
@media(max-width:700px){.profiles-heading{align-items:flex-start}.profiles-title{align-items:flex-start}}
.profiles-search input:focus-visible{outline:none}.keyboard .profiles-search:has(input:focus-visible){outline:2px solid var(--sand-border-focus-primary,var(--focus));outline-offset:2px}
</style>
