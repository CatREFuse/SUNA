<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import type {ObservabilityItem,ObservabilityFilter,ObservabilityRoundOption} from '../conversation-observability'
import {categories,numberText,rateText,callCacheRate,estimateText,statusText,timeText} from '../observability-format.mjs'
import Icon from './Icon.vue'
import CustomSelect from './CustomSelect.vue'
const props=withDefaults(defineProps<{items:ObservabilityItem[];loading?:boolean;error?:string;hasMore?:boolean;category?:ObservabilityFilter;rounds?:ObservabilityRoundOption[];roundSelection?:string;unassignedCount?:number}>(),{category:'all',roundSelection:'latest',unassignedCount:0})
const emit=defineEmits<{filter:[ObservabilityFilter];more:[];retry:[];round:[string]}>()
const expanded=ref(new Set<string>())
const orderedItems=computed(()=>[...props.items].sort((a,b)=>a.sequence-b.sequence))
function roundTime(value:string){const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'时间未采集'}
const roundOptions=computed(()=>[
 {value:'latest',label:'最新一轮对话'},
 ...(props.rounds??[]).map((round,index)=>({value:`round:${round.roundId}`,label:`${roundTime(round.startedAt)} · 第 ${(props.rounds?.length??0)-index} 轮`})),
 ...(props.unassignedCount?[{value:'unassigned',label:'未归属轮次的日志'}]:[]),
])
const roundLabel=computed(()=>roundOptions.value.find(option=>option.value===props.roundSelection)?.label??'所选对话')
watch(()=>props.roundSelection,()=>{expanded.value=new Set()})
watch(()=>props.items,items=>{const ids=new Set(items.map(item=>item.id));expanded.value=new Set([...expanded.value].filter(id=>ids.has(id)))})
function toggle(id:string){const next=new Set(expanded.value);next.has(id)?next.delete(id):next.add(id);expanded.value=next}
function filterKey(event:KeyboardEvent,index:number){const count=categories.length,next=event.key==='Home'?0:event.key==='End'?count-1:event.key==='ArrowRight'?(index+1)%count:event.key==='ArrowLeft'?(index+count-1)%count:-1;if(next<0)return;event.preventDefault();emit('filter',categories[next]!.id as ObservabilityFilter);const target=event.currentTarget as HTMLElement;const buttons=target.parentElement?.querySelectorAll<HTMLButtonElement>('button');buttons?.[next]?.focus()}
function detailRows(item:ObservabilityItem){return [['运行',item.runId],['轮次',item.roundId],['任务',item.taskId],['会话',item.sessionId],['Provider',item.providerId],['模型',item.modelId],['思考深度',item.reasoningEffort],['回执',item.receiptStatus?statusText(item.receiptStatus):null],['消息',item.messageId],['计量来源',item.usage?.source],['计量范围',item.timing?.scope==='dsh-llm-stream'?'DSH 模型流：请求开始至首个输出片段':item.timing?.scope==='client-dispatch'?'Client 调用：发起请求至首个输出片段':item.timing?.scope]].filter((row):row is [string,string]=>Boolean(row[1]))}
</script>
<template>
<section class="conversation-observability" aria-label="对话日志" :aria-busy="loading">
 <div class="log-toolbar"><div class="round-picker"><span>对话轮次</span><CustomSelect :model-value="roundSelection" :options="roundOptions" aria-label="选择对话轮次" :placeholder="roundLabel" @update:model-value="emit('round',$event)"/></div>
 <div class="log-filters" role="tablist" aria-label="日志来源"><button v-for="(item,index) in categories" :key="item.id" type="button" role="tab" :aria-selected="category===item.id" :tabindex="category===item.id||(category==='all'&&index===0)?0:-1" @click="emit('filter',item.id as ObservabilityFilter)" @keydown="filterKey($event,index)">{{item.label}}</button></div></div>
 <div v-if="error" class="log-feedback" role="alert"><span>{{error}}</span><button type="button" class="text-button" :disabled="loading" @click="emit('retry')">重试</button></div>
 <p v-if="loading&&!items.length" class="log-feedback" role="status">正在读取日志…</p>
 <p v-else-if="!items.length&&!error" class="log-feedback">{{roundSelection==='latest'&&!rounds?.length?'暂无对话日志':'本轮暂无此类日志'}}</p>
 <button v-if="hasMore" type="button" class="text-button load-more" :disabled="loading" @click="emit('more')">{{loading?'正在读取…':'加载更早日志'}}</button>
 <div class="log-rows">
  <article v-for="item in orderedItems" :key="item.id" class="observation-row" :class="{'record-failed':item.status==='failed'||item.status==='timeout'}">
   <button type="button" class="observation-heading" :aria-expanded="expanded.has(item.id)" :aria-label="`${expanded.has(item.id)?'收起':'展开'}${item.stage||item.name||item.kind}详情`" @click="toggle(item.id)"><span class="stage">{{item.stage||item.name||item.kind}}</span><time :datetime="item.time">{{timeText(item.time)}}</time><Icon :name="expanded.has(item.id)?'down':'chevron'" :size="16"/></button>
   <div class="record-context"><span class="record-status">{{statusText(item.status)}}</span><span v-if="item.receiptStatus">{{statusText(item.receiptStatus)}}</span></div>
   <p v-if="item.summary" class="record-summary">{{item.summary}}</p><ul v-if="item.checks?.length" class="check-results"><li v-for="check in item.checks" :key="check.name"><span>{{check.name}}</span><span>{{check.passed===true?'通过':check.passed===false?'未通过':'未采集'}}</span></li></ul>
   <template v-if="item.category!=='client-function'">
    <div class="model-line"><span>模型 {{item.modelId||'—'}}</span><span>推理强度 {{item.reasoningEffort||'—'}}</span></div>
    <dl class="metric-strip"><div><dt>输入 / 输出</dt><dd>{{numberText(item.usage?.input)}} / {{numberText(item.usage?.output)}}</dd></div><div><dt>总 token</dt><dd>{{numberText(item.usage?.total)}}</dd></div><div><dt>输入缓存率</dt><dd>{{rateText(callCacheRate(item.usage))}}</dd></div><div><dt>TTFT</dt><dd>{{numberText(item.timing?.ttftMs)}}<template v-if="item.timing?.ttftMs!=null"> ms</template></dd></div><div><dt>TPS</dt><dd>{{numberText(item.timing?.tps)}}</dd></div><div><dt>API 参考估算</dt><dd>{{estimateText(item.estimate)}}</dd></div></dl>
    <p v-if="item.usage?.coverage==='partial'||item.usage?.coverage==='unknown'||!item.usage" class="coverage-note">{{item.usage?.coverage==='partial'?'部分记录':'用量未采集'}}</p>
   </template>
   <section v-if="expanded.has(item.id)" class="observation-detail" aria-label="日志详情"><dl><template v-for="[label,value] in detailRows(item)" :key="label"><dt>{{label}}</dt><dd>{{value}}</dd></template><template v-if="item.category!=='client-function'"><dt>输入 / 输出</dt><dd>{{numberText(item.usage?.input)}} / {{numberText(item.usage?.output)}}</dd><dt>TTFT</dt><dd>{{numberText(item.timing?.ttftMs)}}<template v-if="item.timing?.ttftMs!=null"> ms</template></dd><dt>TPS</dt><dd>{{numberText(item.timing?.tps)}}</dd><dt>缓存读取</dt><dd>{{numberText(item.usage?.cacheRead)}}</dd><dt>缓存写入</dt><dd>{{numberText(item.usage?.cacheWrite)}}</dd><dt>推理输出</dt><dd>{{numberText(item.usage?.reasoning)}}</dd><dt>总耗时</dt><dd>{{numberText(item.timing?.totalMs)}}<template v-if="item.timing?.totalMs!=null"> ms</template></dd><dt>价格标注</dt><dd>API 参考估算</dd></template></dl></section>
  </article>
 </div>
</section>
</template>
<style scoped>
.conversation-observability{min-width:0;font-size:13px;line-height:20px;container-type:inline-size;container-name:observability;overflow-wrap:anywhere}
.log-toolbar{padding:12px 16px;background:var(--sand-bg-pane,var(--panel))}.round-picker{display:grid;gap:8px;font-size:12px;line-height:16px;color:var(--muted)}
.log-filters{display:flex;gap:4px;margin-top:12px;flex-wrap:wrap}.log-filters button{border:0;background:transparent;color:var(--muted);font:inherit;padding:4px 8px;border-radius:6px;min-height:28px;min-width:0;max-width:100%;font-size:12px;line-height:18px;overflow-wrap:anywhere}.log-filters button:hover{background:var(--hover);color:var(--text)}.log-filters button[aria-selected=true]{background:var(--selected);color:var(--text)}
.log-feedback{padding:16px;margin:0;display:flex;gap:8px;align-items:center;color:var(--muted);font-size:13px;line-height:20px}.log-feedback>span{min-width:0}.log-feedback[role=alert]{color:var(--error)}
.log-rows{padding:0 16px}.observation-row{padding:16px 0;border-top:.5px solid var(--faint);min-width:0}.observation-heading{display:flex;align-items:center;gap:8px;width:100%;min-height:28px;padding:4px 0;border:0;border-radius:6px;background:transparent;color:var(--text);font:inherit;text-align:left}.observation-heading:hover{background:var(--hover)}.stage{min-width:0;overflow-wrap:anywhere;flex:1;font-weight:500}.observation-heading time{color:var(--muted);font-size:11px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums}
.record-context,.model-line{display:flex;gap:4px 8px;flex-wrap:wrap;align-items:center;color:var(--muted);margin-top:4px;font-size:12px;line-height:18px}.model-line>span{min-width:0;overflow-wrap:anywhere}.record-failed .record-status{color:var(--error)}.record-summary{font-size:13px;line-height:20px;margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.check-results{list-style:none;padding:0;margin:8px 0}.check-results li{display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:12px;line-height:18px}.check-results li>span:last-child{color:var(--muted);flex-shrink:0}
.metric-strip{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;margin:12px 0 0;font-variant-numeric:tabular-nums}.metric-strip>div{min-width:0}.metric-strip>div:first-child,.metric-strip>div:last-child{grid-column:1/-1}.metric-strip dt{color:var(--muted);font-size:11px;line-height:16px}.metric-strip dd{margin:4px 0 0;overflow-wrap:anywhere;font-size:13px;line-height:18px}.coverage-note{font-size:11px;line-height:16px;color:var(--muted);margin:8px 0 0}
.observation-detail{margin-top:12px;padding:12px;background:var(--sand-bg-secondary,var(--hover));border-radius:10px}.observation-detail dl{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;margin:0;font-size:12px;line-height:18px}.observation-detail dt{color:var(--muted)}.observation-detail dd{margin:0;min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.load-more{display:block;margin:4px auto 12px;font-size:12px}
@container observability (max-width:240px){.metric-strip{grid-template-columns:minmax(0,1fr)}.observation-heading{display:grid;grid-template-columns:minmax(0,1fr) 16px;gap:4px 8px}.observation-heading>.stage{grid-column:1;grid-row:1}.observation-heading>time{grid-column:1/-1;grid-row:2;white-space:normal}.observation-heading>svg:last-child{grid-column:2;grid-row:1}.observation-detail dl{grid-template-columns:minmax(0,1fr);gap:4px}.observation-detail dd+dt{margin-top:4px}}
@container observability (max-width:140px){.log-rows,.log-toolbar{padding-inline:8px}.observation-detail{padding:8px}}
</style>
