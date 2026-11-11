<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import Icon from './Icon.vue'
import {localRoleMarkerStatus} from '../local-role-ui.mjs'
import type {LocalRoleCommunicationSource} from '../local-role-contract'
const props=withDefaults(defineProps<{source:LocalRoleCommunicationSource;people?:Array<{id:string;name:string}>}>(),{people:()=>[]})
const open=ref(false),events=computed(()=>[...props.source.events].sort((a,b)=>a.ordinal-b.ordinal))
const name=(id:string)=>props.people.find(p=>p.id===id)?.name??'角色'
watch(()=>props.source.anchorId,()=>open.value=false)
</script>
<template><section class="local-role-marker" aria-label="角色通信"><button type="button" class="marker-heading" :aria-expanded="open" @click="open=!open"><Icon name="people" :size="18"/><span class="marker-parties">{{name(source.rootActorId)}}<Icon name="arrow" :size="14"/>{{name(source.rootTargetId)}}</span><span class="marker-status">{{localRoleMarkerStatus(source.status)}}</span><Icon name="down" :size="14" :class="{open}"/></button><ol v-if="open" class="marker-events"><li v-for="event in events" :key="event.id"><div class="event-parties"><span>{{name(event.actorId)}}</span><Icon name="arrow" :size="14"/><span>{{name(event.targetId)}}</span></div><p>{{event.content}}</p></li><li v-if="!events.length" class="marker-empty">暂无通信内容</li></ol></section></template>
<style scoped>
.local-role-marker{width:100%;min-width:0;color:var(--sand-text-secondary);font-size:13px;line-height:20px}.marker-heading{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:8px 0;text-align:left;border-radius:8px}.marker-heading:hover{color:var(--text)}.marker-parties{display:flex;align-items:center;gap:4px;flex:1;min-width:0;overflow-wrap:anywhere}.marker-status{flex:none;font-size:12px}.marker-heading>svg{flex:none}.marker-heading>svg.open{transform:rotate(180deg)}.marker-events{display:grid;gap:16px;list-style:none;margin:0;padding:8px 0 8px 24px;border-left:1px solid var(--faint)}.marker-events li{min-width:0}.event-parties{display:flex;align-items:center;gap:8px;font-size:12px;overflow-wrap:anywhere}.marker-events p{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}.marker-empty{font-size:12px}
</style>
