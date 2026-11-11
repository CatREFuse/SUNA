<script setup lang="ts">
import type {ObservabilitySummary} from '../conversation-observability'
import {numberText,rateText,costLines,coverageText} from '../observability-format.mjs'
import ToggleSwitch from './ToggleSwitch.vue'
defineProps<{summary?:ObservabilitySummary|null;loading?:boolean;showTurnUsage?:boolean;title?:string}>()
const emit=defineEmits<{'update:showTurnUsage':[boolean]}>()
function scrollTable(event:KeyboardEvent){if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();const node=event.currentTarget as HTMLElement;node.scrollLeft=Math.max(0,Math.min(Math.max(0,node.scrollWidth-node.clientWidth),node.scrollLeft+(event.key==='ArrowRight'?40:-40)))}
</script>
<template>
<section class="usage-summary" aria-label="当前会话消耗" :aria-busy="loading">
 <p class="usage-title">{{title??'当前会话 · 已采集消耗'}}</p><p v-if="summary?.historyCoverage==='partial'||summary?.historyCoverage==='unknown'" class="history-coverage">{{summary.historyCoverage==='partial'?'部分历史记录':'历史覆盖未知'}}</p>
 <div class="usage-table-scroll" role="region" aria-label="消耗统计" tabindex="0" @keydown="scrollTable"><div class="usage-table" role="table" aria-label="Worker 与 Runtime 消耗">
  <div class="usage-heading" role="row"><span role="columnheader"></span><span role="columnheader">总 token</span><span role="columnheader">输入缓存率</span><span role="columnheader">API 参考估算</span></div>
  <div v-for="[label,group] in [['Worker',summary?.worker],['Runtime',summary?.runtime]] as const" :key="label" class="usage-row" role="row">
   <span role="rowheader">{{label}}</span><span role="cell" data-label="总 token">{{numberText(group?.usage.total)}}<small v-if="coverageText(group)">{{coverageText(group)}}</small></span><span role="cell" data-label="输入缓存率">{{rateText(group?.usage.cacheRate)}}</span><span role="cell" data-label="API 参考估算"><span v-for="line in costLines(group)" :key="line" class="cost-line">{{line}}</span></span>
  </div>
 </div></div>
 <label class="turn-toggle"><span>每轮消耗</span><ToggleSwitch :model-value="Boolean(showTurnUsage)" aria-label="显示每轮消耗" @update:model-value="emit('update:showTurnUsage',$event)"/></label>
</section>
</template>
<style scoped>
.usage-summary{padding:12px 16px;border-bottom:.5px solid var(--sand-border-quaternary-translucent,var(--faint));font-size:13px;line-height:20px;container-type:inline-size;container-name:usage-summary;min-width:0;overflow-wrap:anywhere}.usage-title{margin:0 0 8px;font-size:13px;line-height:20px}.history-coverage{font-size:11px;line-height:16px;color:var(--muted);margin:0 0 8px}.usage-table-scroll{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;border-radius:6px}.usage-table-scroll:focus-visible{outline:2px solid var(--sand-border-focus-primary,var(--accent));outline-offset:2px}.usage-table{min-width:320px;width:100%}.usage-row>span{min-width:0;overflow-wrap:anywhere}.usage-heading,.usage-row{display:grid;grid-template-columns:52px minmax(60px,1fr) minmax(65px,.8fr) minmax(90px,1.6fr);gap:8px;align-items:baseline;padding:4px 0}.usage-heading{color:var(--muted);font-size:11px;line-height:16px;white-space:nowrap}.usage-heading>span:not(:first-child),.usage-row>span:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}.usage-row small{display:block;color:var(--muted);font-size:11px;line-height:16px}.cost-line{display:block;overflow-wrap:anywhere}.turn-toggle{display:flex;align-items:center;justify-content:space-between;border-top:.5px solid var(--sand-border-quaternary-translucent,var(--faint));margin-top:8px;padding-top:8px;gap:12px;font-size:13px;line-height:20px}

/* Default sidebars are narrower than the four-column table. Repeat the real
   column labels beside every metric instead of clipping the currency column. */
@container usage-summary (max-width:440px){
 .usage-table{min-width:0}.usage-heading{position:absolute;inline-size:1px;block-size:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
 .usage-row{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;padding:8px 0}.usage-row+.usage-row{border-top:.5px solid var(--sand-border-quaternary-translucent,var(--faint))}
 .usage-row>[role=rowheader]{grid-column:1/-1;font-weight:500;text-align:left}.usage-row>span[role=cell]{text-align:left}.usage-row>[role=cell]::before{content:attr(data-label);display:block;margin-bottom:4px;color:var(--muted);font-size:11px;line-height:16px;font-weight:420}.usage-row>[data-label="API 参考估算"]{grid-column:1/-1}
}
@container usage-summary (max-width:180px){.usage-row{grid-template-columns:minmax(0,1fr)}.usage-row>[role=rowheader],.usage-row>[data-label="API 参考估算"]{grid-column:auto}}
</style>
