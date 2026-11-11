<script setup lang="ts">
import {computed} from 'vue'
import type {DirectChatInput,Message} from '../types'
import {directInputLabel,directInputNeedsQuery,validDirectInput} from '../direct-input-state.mjs'
const props=defineProps<{inputs:DirectChatInput[];messages:Message[];canQuery:boolean}>()
const emit=defineEmits<{query:[DirectChatInput]}>()
const visible=computed(()=>props.inputs.filter(input=>validDirectInput(input)&&input.status!=='admitted'))
function preview(input:DirectChatInput){const message=props.messages.find(message=>message.id===input.messageId||message.conversationId===input.conversationId&&message.requestId===input.requestId);return message?.text||'附件消息'}
</script>
<template><div v-if="visible.length" class="direct-input-queue" aria-label="私聊发送队列"><div v-for="input in visible" :key="input.id" class="direct-input-item" :class="{'has-error':['failed','unknown','unconsumed'].includes(input.status)}"><span class="direct-input-preview" :title="preview(input)">{{preview(input)}}</span><span role="status">{{directInputLabel(input)}}<span v-if="input.error">：{{input.error}}</span></span><button v-if="canQuery&&directInputNeedsQuery(input)" type="button" class="text-button" @click="emit('query',input)">查询状态</button></div></div></template>
<style scoped>
.direct-input-queue{display:flex;flex-direction:column;gap:8px;max-height:128px;overflow:auto;min-width:0;padding:4px 0 8px;font-size:13px;line-height:20px;color:var(--sand-text-secondary)}
.direct-input-item{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;min-width:0;overflow-wrap:anywhere}.direct-input-preview{flex:0 1 180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--sand-text-tertiary)}.has-error{color:var(--danger)}.direct-input-item .text-button{flex:none;font-size:13px;line-height:20px}.direct-input-item button:focus-visible{outline:2px solid var(--sand-border-focus-primary);outline-offset:2px}
</style>
