<script setup lang="ts">
import type {ObservabilityRound} from '../conversation-observability'
import {numberText,costLines,coverageText} from '../observability-format.mjs'
defineProps<{round:ObservabilityRound|null}>()
</script>
<template><div v-if="round" class="round-usage" aria-label="本轮已采集消耗"><span v-for="[label,group] in [['Worker',round.worker],['Runtime',round.runtime]] as const" :key="label">{{label}} {{numberText(group.usage.total)}} token<span v-if="coverageText(group)"> · {{coverageText(group)}}</span><span v-for="line in costLines(group)" :key="line"> · {{line}}</span></span><span>API 参考估算</span></div></template>
<style scoped>
.round-usage{display:flex;gap:4px 8px;flex-wrap:wrap;color:var(--muted);font-size:11px;line-height:16px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;padding:4px 0 8px;min-width:0}.round-usage>span{min-width:0}
</style>
