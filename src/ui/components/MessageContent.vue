<script setup lang="ts">
import InteractionCard from './InteractionCard.vue'
import LocalRoleCommunication from './LocalRoleCommunication.vue'
import {localRoleMarker} from '../local-role-ui.mjs'
import {inject,computed,ref,watch,onMounted,onBeforeUnmount,nextTick} from 'vue'
import type {Message} from '../types'
import {messageBlocks} from '../message-content.mjs'
import {renderMessageText} from '../message-markdown.mjs'
import Modal from './Modal.vue'
import Icon from './Icon.vue'
import {request} from '../api'
import {adoptMessageText} from '../message-text-entity.mjs'
import {attachmentSize} from '../composer-attachments.mjs'

const downloadControlled=inject<((conversationId:string,attachmentId:string)=>void)>('downloadControlledAttachment')
const controlledError=ref('')
function controlledFile(block:{attachmentId?:string;url?:string}){return /^url_[a-f0-9]{48}$/.test(block.attachmentId??'')&&block.url===`/api/conversations/${encodeURIComponent(props.message.conversationId)}/controlled-attachments/${block.attachmentId}/download`}
function downloadFile(event:MouseEvent,block:{attachmentId?:string;url?:string}){if(!controlledFile(block))return;event.preventDefault();if(!downloadControlled){controlledError.value='请通过桌面应用下载附件';return}downloadControlled(props.message.conversationId,block.attachmentId!)}
const props=withDefaults(defineProps<{message:Message;people?:Array<{id:string;name:string}>;channel?:boolean;active?:boolean;localPending?:boolean;localAttachments?:Array<{key?:string;name:string;kind?:string;previewUrl?:string;width?:number;height?:number}>;textEntity?:HTMLElement;textFlying?:boolean}>(),{channel:false,active:true,localPending:false,textFlying:false})
const vPersistentText={mounted:(element:HTMLElement,binding:any)=>adoptMessageText(element,binding.value),updated:(element:HTMLElement,binding:any)=>adoptMessageText(element,binding.value)}
const host=ref<HTMLElement>(),recovered=ref<Message|null>(null),recovery=ref<'idle'|'loading'|'failed'|'done'>('idle'),recoveryError=ref('')
const mentionAttempted=ref(false)
const failed=ref(new Set<string>())
const marker=computed(()=>localRoleMarker(props.message))
const channelMedia=computed(()=>!marker.value&&!props.localPending&&props.channel&&!props.message.taskId&&props.message.source?.type!=='manual')
const legacyPattern=/\[CQ:(?:image|video),[^\]]*\]/g
const legacy=computed(()=>channelMedia.value&&!props.message.blocks?.some(block=>block.type==='image'||block.type==='video')&&[props.message.text,...(props.message.blocks??[]).filter(block=>block.type==='text').map(block=>block.text)].some(text=>/\[CQ:(?:image|video),/.test(text??'')))
const mentionCandidate=computed(()=>channelMedia.value&&typeof props.message.externalId==='string'&&!!props.message.externalId&&!props.message.blocks?.some(block=>block.type==='mention')&&[props.message.text,...(props.message.blocks??[]).filter(block=>block.type==='text').map(block=>block.text)].some(text=>/@\d{1,20}(?!\d)|\[CQ:at,/.test(text??'')))
const blocks=computed(()=>{
  if(marker.value)return []
  if(recovered.value)return messageBlocks(recovered.value)
  if(legacy.value)return messageBlocks(props.message).map((block:ReturnType<typeof messageBlocks>[number])=>block.type==='text'?{...block,text:block.text.replace(legacyPattern,(token:string)=>token.startsWith('[CQ:video,')?'[视频]':'[图片]')}:block)
  return messageBlocks(props.message)
})
const emojiOnly=computed(()=>blocks.value.length===1&&blocks.value[0]?.type==='text'&&Boolean(blocks.value[0].text.trim())&&/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\u200d\ufe0f\s]+$/u.test(blocks.value[0].text))
const retryable=computed(()=>channelMedia.value&&(legacy.value||blocks.value.some((block:ReturnType<typeof messageBlocks>[number])=>block.type==='unavailable'&&['图片无法加载','视频无法加载','媒体无法加载'].includes(block.text)||['image','video'].includes(block.type)&&failed.value.has(block.url))))
let observer:IntersectionObserver|undefined,generation=0,disposed=false,recoveryController:AbortController|undefined
async function recoverMedia(){
  const mediaNeeded=retryable.value,mentionNeeded=mentionCandidate.value&&!mentionAttempted.value
  if((!mediaNeeded&&!mentionNeeded)||recovery.value==='loading'||!props.active)return
  if(mentionNeeded)mentionAttempted.value=true
  const token=++generation,id=props.message.id,conversationId=props.message.conversationId;recovery.value='loading';recoveryError.value='';observer?.disconnect()
  recoveryController=typeof AbortController==='function'?new AbortController():undefined
  try{const result=await request<{messages:Message[]}>(`/conversations/${encodeURIComponent(conversationId)}/media`,{messageIds:[id]},undefined,false,recoveryController?.signal);if(disposed||token!==generation)return;const message=result.messages?.find(item=>item.id===id&&item.conversationId===conversationId);if(!message)throw Error('消息无法读取');if(!message.blocks?.length){if(mediaNeeded)throw Error('媒体无法加载');recovery.value='done';return}const previous=(recovered.value??props.message).blocks??[],previousMedia=previous.filter(block=>['image','video','unavailable'].includes(block.type));let ordinal=0;const merged=message.blocks.map(block=>{if(!['image','video','unavailable'].includes(block.type))return block;const old=previousMedia[ordinal++];return block.type==='unavailable'&&['image','video'].includes(old?.type)?old:block});recovered.value={...message,blocks:merged};failed.value=new Set();recovery.value=merged.some(block=>block.type==='unavailable')?'failed':'done'}catch(cause){if(!disposed&&token===generation){recovery.value='failed';recoveryError.value=cause&&typeof cause==='object'&&'message' in cause&&typeof cause.message==='string'?cause.message:'媒体无法加载'}}
}
function observeMedia(){observer?.disconnect();if((!legacy.value&&(!mentionCandidate.value||mentionAttempted.value))||recovery.value!=='idle'||!props.active||!host.value)return;observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer?.disconnect();void recoverMedia()}},{rootMargin:'160px'});observer.observe(host.value)}
onMounted(observeMedia)
onBeforeUnmount(()=>{disposed=true;generation++;recoveryController?.abort();observer?.disconnect()})
watch([()=>props.message.id,()=>props.message.conversationId,()=>props.channel],async()=>{generation++;recoveryController?.abort();mentionAttempted.value=false;recovered.value=null;recovery.value='idle';recoveryError.value='';await nextTick();observeMedia()})
watch(()=>props.message.blocks,blocks=>{if(blocks?.some(block=>block.type==='image'||block.type==='video')&&!blocks.some(block=>block.type==='unavailable')){recovered.value=null;recovery.value='done';recoveryError.value='';observer?.disconnect()}})
watch(()=>props.active,async active=>{if(!active){expanded.value=null;generation++;recoveryController?.abort();if(recovery.value==='loading')recovery.value='idle';observer?.disconnect()}else{await nextTick();observeMedia()}})
const expanded=ref<{type:string;url:string;alt:string;poster?:string}|null>(null)
function previewFrame(event:Event){const video=event.target as HTMLVideoElement;if(Number.isFinite(video.duration)&&video.duration>0)video.currentTime=Math.min(.1,video.duration/2)}
function fail(url:string){failed.value.add(url);if(expanded.value?.url===url)expanded.value=null}
watch(()=>props.message.id,()=>{failed.value=new Set();expanded.value=null})
</script>

<template>
  <div ref="host" class="message-content message-blocks" :class="{'interaction-message':!!message.interaction||!!marker,'emoji-only':emojiOnly,'media-only':blocks.length>0&&blocks.every((block:ReturnType<typeof messageBlocks>[number])=>block.type==='image'||block.type==='video')}">
    <span v-if="controlledError" class="message-unavailable" role="status">{{controlledError}}</span>
    <template v-if="localPending"><div v-for="(attachment,index) in localAttachments??[]" :key="attachment.key??index" class="local-message-attachment"><img v-if="attachment.kind==='image'&&attachment.previewUrl" :src="attachment.previewUrl" :alt="attachment.name" :width="attachment.width??240" :height="attachment.height??180"/><span v-else>{{attachment.name}}</span></div></template>
    <LocalRoleCommunication v-if="marker" :source="marker" :people="people"/><InteractionCard v-else-if="message.interaction" :interaction="message.interaction" :active="active"/>
    <template v-for="(block,index) in marker||message.interaction?[]:blocks" :key="index">
      <div v-if="block.type==='text'" class="message-text" v-persistent-text="{node:index===blocks.findIndex((b:ReturnType<typeof messageBlocks>[number])=>b.type==='text')?textEntity:undefined,active:!textFlying,text:block.text,html:renderMessageText(block.text)}" v-html="renderMessageText(block.text)"/>
      <a v-else-if="block.type==='file'" class="message-file" :href="block.url" :download="block.name" @click="downloadFile($event,block)"><Icon name="file" :size="24"/><span><strong>{{block.name}}</strong><small>{{controlledFile(block)?'本机链接 · ':''}}{{attachmentSize(block.size)}}</small></span><Icon name="download" :size="18"/></a>
      <button v-else-if="block.type==='image'&&!failed.has(block.url)" type="button" class="message-image" aria-label="查看图片" @click="expanded=block">
        <img :src="block.url" :alt="block.alt" loading="lazy" decoding="async" @error="fail(block.url)"/>
      </button>
      <button v-else-if="block.type==='video'&&!failed.has(block.url)" type="button" class="message-video" aria-label="播放视频" @click="expanded=block">
        <video :src="block.url" :poster="block.poster" muted playsinline preload="metadata" @loadedmetadata="previewFrame" @error="fail(block.url)"/>
        <span class="video-play"><Icon name="play" :size="24"/></span><span class="video-label">视频</span>
      </button>
      <div v-else class="message-unavailable" role="status">{{block.type==='image'?'图片无法加载':block.type==='video'?'视频无法加载':block.text}}</div>
    </template>
    <div v-if="channelMedia&&recovery==='loading'" class="message-unavailable" role="status">正在加载媒体…</div>
    <div v-else-if="retryable" class="message-media-error"><span v-if="recoveryError" role="alert">{{recoveryError}}</span><button type="button" class="text-button" @click="recoverMedia"><Icon name="refresh" :size="16"/>重试</button></div>
    <Modal :open="!!expanded" :title="expanded?.type==='video'?'视频':'图片'" @close="expanded=null">
      <video v-if="expanded?.type==='video'" class="expanded-video" :src="expanded.url" :poster="expanded.poster" controls autoplay playsinline @error="fail(expanded.url)"/>
      <img v-else-if="expanded" class="expanded-image" :src="expanded.url" :alt="expanded.alt" @error="fail(expanded.url)"/>
    </Modal>
  </div>
</template>

<style scoped>
div.message-content.message-blocks.interaction-message{padding:0;background:transparent;border:0;border-radius:14px;max-width:100%;width:360px;box-shadow:none}

.message-text :deep(strong),.message-text :deep(b){font-weight:600}
.message-file{display:flex;align-items:center;gap:8px;min-width:0;max-width:320px;color:inherit;text-decoration:none}.message-file>span{min-width:0;flex:1}.message-file strong{display:block;font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}.message-file small{display:block;font-size:12px;line-height:16px;opacity:.8}.message-file>svg{flex:none}.message-file:hover strong{text-decoration:underline;text-underline-offset:3px}.message-file:focus-visible{outline:2px solid var(--sand-border-focus-primary);outline-offset:4px;border-radius:6px}
.message-blocks{min-width:0}.message-blocks.media-only.message-content{padding:0;background:transparent;width:384px;max-width:100%}
.message-text{white-space:normal;overflow-wrap:anywhere}
.message-text :deep(p){margin:0 0 8px}.message-text :deep(p:last-child){margin-bottom:0}
.message-text :deep(a){color:inherit;text-decoration:underline;text-underline-offset:3px}
.message-text :deep(a:hover),.message-text :deep(a:focus-visible){background:var(--hover)}
.message-text :deep(ul),.message-text :deep(ol){margin:8px 0;padding-left:24px}
.message-text :deep(:is(h1,h2,h3,h4,h5,h6)){font-size:1em;font-weight:600;margin:12px 0 8px}
.message-text :deep(blockquote){margin:8px 0;padding-left:12px;border-left:1px solid var(--muted);color:var(--muted)}
.message-text :deep(pre){max-width:100%;overflow:auto;white-space:pre;padding:8px;background:var(--hover);border-radius:6px}
.message-text :deep(code){font-family:ui-monospace,monospace;font-size:max(12px,.92em);white-space:pre-wrap}
.message-video{position:relative;display:block;width:min(384px,100%);aspect-ratio:16/9;padding:0;border:0;border-radius:12px;overflow:hidden;background:var(--sand-bg-elevated,var(--hover));cursor:pointer}.message-video video{width:100%;height:100%;object-fit:contain;pointer-events:none}.video-play{position:absolute;inset:0;display:grid;place-items:center;background:var(--sand-bg-hover)}.video-play :deep(svg){padding:8px;box-sizing:content-box;border-radius:50%;background:var(--sand-bg-scrim);color:#fff}.video-label{position:absolute;left:12px;bottom:8px;color:#fff;background:var(--sand-bg-scrim);padding:4px 8px;border-radius:6px;font-size:11px;line-height:16px}.expanded-video{display:block;width:100%;max-height:70dvh;background:#111}
.message-image{display:block;max-width:min(100%,384px);padding:0;margin:0;border:0;border-radius:12px;overflow:hidden;line-height:0;background:var(--hover);cursor:zoom-in}
.message-image img{display:block;max-width:100%;max-height:360px;object-fit:contain}
.message-image:focus-visible{filter:brightness(.85)}
.message-media-error{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:14px;margin-top:8px}.message-media-error .text-button{font-size:14px}
.message-unavailable{font-size:14px;color:var(--muted)}
.message-blocks>:is(.message-text,.message-image,.message-video,.message-file,.message-unavailable):not(:first-child){margin-top:8px}
.expanded-image{display:block;width:auto;max-width:100%;max-height:70dvh;object-fit:contain;margin:auto}
.local-message-attachment img{display:block;max-width:min(384px,100%);max-height:360px;height:auto;object-fit:contain;border-radius:8px}.local-message-attachment+.local-message-attachment,.local-message-attachment+.message-text{margin-top:8px}
</style>
