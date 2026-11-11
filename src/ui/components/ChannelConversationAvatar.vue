<script setup lang="ts">
import {ref,watch,computed} from 'vue'
import type {Conversation} from '../types'
import Icon from './Icon.vue'
const props=defineProps<{conversation:Conversation}>(),failed=ref(false)
const url=computed(()=>props.conversation.display?.channel?.platform==='qq'?`/api/conversations/${encodeURIComponent(props.conversation.id)}/channel-avatar`:'')
watch(url,()=>{failed.value=false})
</script>
<template><span class="channel-avatar" aria-hidden="true"><img v-if="url&&!failed" :src="url" alt="" loading="lazy" decoding="async" @error="failed=true"/><Icon v-else :name="conversation.kind==='group'?'people':'person'" :size="19"/></span></template>
<style scoped>.channel-avatar{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--sand-bg-secondary,var(--hover));color:var(--sand-text-secondary,var(--muted));overflow:hidden;flex-shrink:0}.channel-avatar img{width:100%;height:100%;object-fit:cover}</style>
