<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import type {ChannelSchedulerState,Character,Conversation} from '../types'
import {channelSchedulerRows} from '../channel-scheduler-projection.mjs'
const props=withDefaults(defineProps<{states?:ChannelSchedulerState[];conversation:Conversation;characters:Character[];active?:boolean}>(),{states:()=>[],active:false})
const now=ref(Date.now())
const rows=computed(()=>channelSchedulerRows(props.states,props.conversation,props.characters,now.value))
const historyLimit=computed(()=>{const value=props.conversation.schedulerEffective?.historyLimit;return Number.isSafeInteger(value)?value:null})
let ticker:ReturnType<typeof setInterval>|undefined,mounted=false
function stop(){if(ticker!==undefined){clearInterval(ticker);ticker=undefined}}
function sync(){stop();now.value=Date.now();if(mounted&&props.active&&document.visibilityState!=='hidden'&&rows.value.some(row=>row.hasClock))ticker=setInterval(()=>{now.value=Date.now()},1000)}
watch(()=>[props.active,props.conversation.id,props.states],sync,{deep:true})
onMounted(()=>{mounted=true;document.addEventListener('visibilitychange',sync);sync()})
onBeforeUnmount(()=>{mounted=false;stop();document.removeEventListener('visibilitychange',sync)})
</script>
<template>
 <section class="channel-scheduler-status" aria-label="群聊调度器状态">
  <h3>群聊调度器</h3>
  <p v-if="!rows.length" class="scheduler-empty">尚无调度状态</p>
  <section v-for="row in rows" :key="row.characterId" class="scheduler-role" :aria-label="`${row.name}的调度状态`">
   <div class="scheduler-role-heading"><span>{{row.name}}</span><span>{{row.label}}</span></div>
   <dl><div><dt>直接触发消息</dt><dd>{{row.directMessageCount}} 条</dd></div><div><dt>防抖剩余</dt><dd>{{row.debounce}}</dd></div><div><dt>等待消息</dt><dd>{{row.messageCount}}<template v-if="row.threshold!==null"> / {{row.threshold}}</template> 条</dd></div><div><dt>空闲剩余</dt><dd>{{row.idle}}</dd></div><div><dt>回复监听</dt><dd>{{row.watch}}</dd></div><div><dt>最近结果</dt><dd>{{row.lastResult}}</dd></div></dl>
  </section>
  <div class="scheduler-history"><span>回复回溯</span><span>{{historyLimit===null?'—':`最多 ${historyLimit} 条`}}</span></div>
 </section>
</template>
<style scoped>
.channel-scheduler-status{padding:16px;border-bottom:.5px solid var(--sand-border-quaternary-translucent,var(--faint));font-size:13px;line-height:20px;min-width:0}.channel-scheduler-status h3{font-size:12px;line-height:16px;font-weight:420;color:var(--muted);margin:0 0 12px}.scheduler-empty{margin:0 0 12px;color:var(--muted);font-size:13px;line-height:20px}.scheduler-role+.scheduler-role{border-top:.5px solid var(--sand-border-quaternary-translucent,var(--faint));margin-top:16px;padding-top:16px}.scheduler-role-heading{display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:space-between;margin-bottom:8px}.scheduler-role-heading>span{min-width:0;overflow-wrap:anywhere}.scheduler-role-heading>span:first-child{font-weight:500}.scheduler-role-heading>span:last-child{font-size:12px;line-height:20px;color:var(--muted)}.scheduler-role dl{display:grid;gap:8px;margin:0}.scheduler-role dl>div,.scheduler-history{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.scheduler-role dt,.scheduler-history>span:first-child{color:var(--muted);font-size:12px;line-height:20px}.scheduler-role dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;min-width:0}.scheduler-history{margin-top:16px}.scheduler-history>span:last-child{font-variant-numeric:tabular-nums;text-align:right}@media(max-width:700px){.channel-scheduler-status{padding:16px 16px}}
</style>
