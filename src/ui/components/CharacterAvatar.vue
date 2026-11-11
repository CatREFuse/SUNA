<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import type {Character} from '../types'
import {localSenderAvatar} from '../message-avatar.mjs'
const props=withDefaults(defineProps<{person?:Character;fallback?:string;imageUrl?:string;shape?:'role'|'channel';markState?:string;active?:boolean}>(),{active:true})
const failed=ref(false)
const url=computed(()=>props.person?.avatarUrl||localSenderAvatar(props.imageUrl))
const initial=computed(()=>props.person?.avatar||props.person?.name?.slice(0,1)||props.fallback?.slice(0,1)||'·')
watch(url,()=>{failed.value=false})
</script>
<template><span class="avatar" :class="shape==='channel'?'channel-person-avatar':'role-person-avatar'" :style="{'--avatar-color':person?.color}" aria-hidden="true"><img v-if="url&&!failed" :src="url" alt="" decoding="async" @error="failed=true"/><span v-else class="avatar-initial">{{initial}}</span></span></template>
<style scoped>.avatar{overflow:hidden;font-size:13px;font-weight:500;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;background:var(--sand-bg-secondary,var(--hover));color:var(--text)}.avatar.role-person-avatar{border-radius:50%}.avatar.channel-person-avatar{border-radius:10px}.avatar>img{display:block;width:100%;height:100%;object-fit:cover}.avatar-initial{display:grid;place-items:center;width:100%;height:100%}</style>
