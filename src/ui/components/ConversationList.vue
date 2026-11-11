<script setup lang="ts">
import {ref,computed,nextTick,watch,onMounted,onBeforeUnmount} from 'vue'
import {channelConversationName,channelPlatformName,channelAccountName} from '../../core/channel-display.mjs'
import ChannelConversationAvatar from './ChannelConversationAvatar.vue'
import type {Conversation,Character} from '../types'
import {conversationTime,conversationTimestamp,pinnedConversations} from '../conversation-state.mjs'
import Icon from './Icon.vue'
import CharacterAvatar from './CharacterAvatar.vue'
import {channelEntryIndex} from '../sidebar-navigation.mjs'
const props=withDefaults(defineProps<{activity?:Array<{characterId:string;conversationId?:string}>;pending?:Array<{characterId:string;conversationId?:string}>;searchOpen?:boolean;active?:boolean;includeChannels?:boolean;channelEntry?:boolean;pinSupported?:boolean;pinBusyIds?:string[];scope:'desktop'|'channel';conversations:Conversation[];characters:Character[];selected:string;query:string;kind:string;drafts:Record<string,string>;busyIds:string[];errorIds:string[];loading:boolean}>(),{active:true,pinSupported:false,pinBusyIds:()=>[],includeChannels:false,channelEntry:false})
const emit=defineEmits<{select:[id:string];pin:[id:string,pinned:boolean];create:[];manage:[];channels:[];'update:query':[value:string];'update:kind':[value:string]}>()
const visibleConversations=computed(()=>props.conversations.filter(conversation=>conversation.active!==false&&(props.scope==='channel'?conversation.channel!=='desktop':conversation.channel==='desktop'||props.includeChannels)))
const ordinaryConversations=computed(()=>visibleConversations.value.filter(conversation=>conversation.pinned!==true))
const channelEntryPosition=computed(()=>channelEntryIndex(ordinaryConversations.value.length))
const pins=computed(()=>{
 const own=pinnedConversations(visibleConversations.value,props.scope)
 if(props.scope!=='desktop'||!props.includeChannels)return own
 // Only explicitly admitted external conversations can join the main pin strip.
 return [...own,...pinnedConversations(visibleConversations.value,'channel')].sort((a,b)=>(Date.parse(b.pinnedAt??'')||0)-(Date.parse(a.pinnedAt??'')||0)||a.id.localeCompare(b.id))
})
const channelRole=(conversation:Conversation)=>props.characters.find(person=>person.id===conversation.participantIds[0])
const conversationName=(conversation:Conversation)=>conversation.channel==='desktop'&&conversation.kind==='direct'?(props.characters.find(person=>person.id===conversation.participantIds[0])?.name??'私聊'):channelConversationName(conversation)
const channelDescription=(conversation:Conversation)=>{const channel=conversation.display?.channel??conversation.channelDetails??{};return [channelRole(conversation)?.name,channelPlatformName(channel.platform??conversation.channelTarget?.platform),channelAccountName(channel)].filter(Boolean).join(' · ')}
const channelBadge=(conversation:Conversation)=>{const platform=conversation.display?.channel?.platform??conversation.channelDetails?.platform??conversation.channelTarget?.platform??conversation.channel;return ['qq','qq-openid'].includes(platform)?{src:'/brands/qq.png',name:'QQ'}:['wechat','weixin','weixin-ilink'].includes(platform)?{src:'/brands/wechat.png',name:'微信'}:null}
function markState(id?:string,conversationId?:string){const matches=(run:{characterId:string;conversationId?:string})=>run.characterId===id&&(!run.conversationId||run.conversationId===conversationId);return props.activity?.some(matches)?'working':props.pending?.some(matches)?'waiting':'idle'}
const listElement=ref<HTMLElement>()
const contextMenu=ref<{id:string;x:number;y:number}|null>(null),menuElement=ref<HTMLElement>()
let menuTrigger:HTMLElement|undefined
const menuConversation=computed(()=>visibleConversations.value.find(conversation=>conversation.id===contextMenu.value?.id))
const pinDisabled=computed(()=>!props.pinSupported||!menuConversation.value||props.pinBusyIds.includes(contextMenu.value?.id??''))
const pinMenuLabel=computed(()=>!props.pinSupported?'当前后端不支持置顶':props.pinBusyIds.includes(contextMenu.value?.id??'')?'正在保存…':menuConversation.value?.pinned?'取消置顶':'置顶对话')
function closeContextMenu(restoreFocus=false){contextMenu.value=null;if(restoreFocus&&menuTrigger?.isConnected)menuTrigger.focus({preventScroll:true});menuTrigger=undefined}
function fitContextMenu(){
  const menu=contextMenu.value,node=menuElement.value;if(!menu||!node)return
  const {width,height}=node.getBoundingClientRect();if(width<=0||height<=0)return
  const x=Math.max(8,Math.min(menu.x,window.innerWidth-width-8)),y=Math.max(8,Math.min(menu.y,window.innerHeight-height-8))
  if(x!==menu.x||y!==menu.y)contextMenu.value={...menu,x,y}
}
async function openContextMenu(event:MouseEvent|KeyboardEvent,conversation:Conversation){
  event.preventDefault();event.stopPropagation()
  if(!props.active||conversation.active===false)return
  menuTrigger=event.currentTarget as HTMLElement
  const keyboard='key' in event,box=menuTrigger.getBoundingClientRect()
  contextMenu.value={id:conversation.id,x:Math.max(8,keyboard?box.left:event.clientX),y:Math.max(8,keyboard?box.bottom+4:event.clientY)}
  await nextTick();fitContextMenu();menuElement.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true})
}
function contextKey(event:KeyboardEvent,conversation:Conversation){if(!event.isComposing&&(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'))void openContextMenu(event,conversation)}
function menuKey(event:KeyboardEvent){if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeContextMenu(true)}else if(event.key==='Tab'){closeContextMenu(true)}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();menuElement.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()}}
function outsideMenu(event:PointerEvent){if(!contextMenu.value)return;const target=event.target as Node|null;if(target&&!menuElement.value?.contains(target))closeContextMenu()}
function contextMenuDocumentKey(event:KeyboardEvent){if(contextMenu.value&&['Escape','Tab'].includes(event.key))menuKey(event)}
function contextMenuResize(){closeContextMenu()}
function changePin(){const conversation=menuConversation.value;if(pinDisabled.value||!conversation)return;emit('pin',conversation.id,conversation.pinned!==true);closeContextMenu(true)}
watch(()=>[props.scope,props.selected,props.active],()=>closeContextMenu())
watch(menuConversation,value=>{if(!value)closeContextMenu()})
watch(pinMenuLabel,fitContextMenu,{flush:'post'})
watch(()=>pins.value.map((item:Conversation)=>item.id).join('\0'),async()=>{
 const focused=document.activeElement as HTMLElement|null,id=focused?.dataset?.conversationId??focused?.dataset?.pinnedConversationId
 if(!props.active||!id||!listElement.value?.contains(focused))return
 await nextTick()
 if(focused?.isConnected||document.activeElement!==focused&&document.activeElement!==document.body)return
 listElement.value?.querySelector<HTMLElement>(`[data-conversation-id="${CSS.escape(id)}"],[data-pinned-conversation-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true})
})
onMounted(()=>{document.addEventListener('pointerdown',outsideMenu);document.addEventListener('keydown',contextMenuDocumentKey,true);window.addEventListener('resize',contextMenuResize)})
onBeforeUnmount(()=>{document.removeEventListener('pointerdown',outsideMenu);document.removeEventListener('keydown',contextMenuDocumentKey,true);window.removeEventListener('resize',contextMenuResize);closeContextMenu()})
</script>
<template><aside ref="listElement" class="conversation-list" :aria-label="scope==='desktop'?'对话列表':'频道对话列表'">
  <div v-if="pins.length" class="pinned-bots pinned-conversations" aria-label="置顶对话"><button v-for="conversation in pins" :key="conversation.id" class="pinned-bot" :data-pinned-conversation-id="conversation.id" :aria-label="`置顶对话：${conversationName(conversation)}`" :aria-pressed="selected===conversation.id" aria-haspopup="menu" @click="emit('select',conversation.id)" @contextmenu="openContextMenu($event,conversation)" @keydown="contextKey($event,conversation)"><span v-if="conversation.channel!=='desktop'" class="pinned-conversation-avatar"><ChannelConversationAvatar :conversation="conversation"/><img v-if="channelBadge(conversation)" class="pinned-platform-badge" :src="channelBadge(conversation)!.src" :alt="channelBadge(conversation)!.name"/></span><span v-else-if="conversation.kind==='group'" class="conversation-avatar is-group pinned-conversation-avatar" aria-hidden="true"><CharacterAvatar v-for="id in conversation.participantIds.slice(0,3)" :key="id" :person="characters.find(person=>person.id===id)" :mark-state="markState(id,conversation.id)"/><Icon v-if="!conversation.participantIds.length" name="people" :size="20"/></span><CharacterAvatar v-else class="pinned-conversation-avatar" :person="characters.find(person=>person.id===conversation.participantIds[0])" :fallback="conversation.title" :mark-state="markState(conversation.participantIds[0],conversation.id)"/><span>{{conversationName(conversation)}}</span></button></div>
  <header v-show="searchOpen||query" class="conversation-list-heading"><label class="conversation-search"><Icon name="search" :size="16"/><input :value="query" :aria-label="scope==='desktop'?'搜索应用对话':'搜索 Channel 对话'" placeholder="搜索" @input="emit('update:query',($event.target as HTMLInputElement).value)"/></label></header>
  <div class="conversation-rows"><template v-for="(conversation,index) in ordinaryConversations" :key="conversation.id"><button v-if="channelEntry&&scope==='desktop'&&index===channelEntryPosition" type="button" class="conversation-row channel-entry" data-channel-entry aria-label="频道" @click="emit('channels')"><span class="conversation-avatar channel-entry-icon"><Icon name="channels" :size="24"/></span><span class="conversation-row-body"><strong>频道</strong></span><Icon name="chevron" :size="16"/></button><button :data-conversation-id="conversation.id" class="conversation-row" :aria-label="conversationName(conversation)" :aria-pressed="selected===conversation.id" aria-haspopup="menu" @click="emit('select',conversation.id)" @contextmenu="openContextMenu($event,conversation)" @keydown="contextKey($event,conversation)">
    <span v-if="conversation.channel!=='desktop'" class="channel-avatar-pair" :aria-label="`${channelRole(conversation)?.name??'角色'} — ${conversationName(conversation)}`"><CharacterAvatar class="role-avatar" :person="channelRole(conversation)" :mark-state="markState(channelRole(conversation)?.id,conversation.id)"/><span class="avatar-link" aria-hidden="true">–</span><span class="channel-avatar-target"><ChannelConversationAvatar :conversation="conversation"/><img v-if="channelBadge(conversation)" class="channel-platform-badge" :src="channelBadge(conversation)!.src" :alt="channelBadge(conversation)!.name" width="14" height="14"/></span></span>
    <span v-else-if="conversation.kind==='group'" class="conversation-avatar is-group" aria-hidden="true"><CharacterAvatar v-for="id in conversation.participantIds.slice(0,3)" :key="id" :person="characters.find(person=>person.id===id)" :mark-state="markState(id,conversation.id)"/><Icon v-if="!conversation.participantIds.length" name="people" :size="20"/></span><CharacterAvatar v-else class="conversation-avatar" :person="characters.find(person=>person.id===conversation.participantIds[0])" :fallback="conversation.title" :mark-state="markState(conversation.participantIds[0],conversation.id)"/>
    <span class="conversation-row-body"><span class="conversation-row-top"><strong>{{conversationName(conversation)}}</strong><time>{{conversationTime(conversationTimestamp(conversation))}}</time></span><span class="conversation-row-preview"><template v-if="drafts[conversation.id]">草稿：{{drafts[conversation.id]}}</template><template v-else-if="errorIds.includes(conversation.id)">处理失败</template><template v-else>{{conversation.display?.preview??conversation.lastMessage??(conversation.kind==='group'?'群聊':'单聊')}}</template></span><span v-if="conversation.channel!=='desktop'&&conversation.display?.channel" class="conversation-row-channel">{{channelDescription(conversation)}}</span></span><span v-if="conversation.unreadCount" class="unread-badge" :aria-label="`${conversation.unreadCount} 条未读消息`">{{conversation.unreadCount>99?'99+':conversation.unreadCount}}</span><span v-if="busyIds.includes(conversation.id)" class="activity-dot" aria-label="正在处理"/>
  </button></template><button v-if="channelEntry&&scope==='desktop'&&ordinaryConversations.length<=channelEntryPosition" type="button" class="conversation-row channel-entry" data-channel-entry aria-label="频道" @click="emit('channels')"><span class="conversation-avatar channel-entry-icon"><Icon name="channels" :size="24"/></span><span class="conversation-row-body"><strong>频道</strong></span><Icon name="chevron" :size="16"/></button><p v-if="!visibleConversations.length" class="conversation-list-empty">{{loading?'正在加载…':query?'没有匹配的对话':scope==='channel'?'暂无渠道对话':'暂无对话'}}</p><button v-if="!loading&&!visibleConversations.length&&scope==='channel'&&!query" class="text-button conversation-empty-action" @click="emit('manage')">管理渠道<Icon name="arrow" :size="15"/></button></div>
</aside><Teleport to="body"><div v-if="contextMenu&&menuConversation" ref="menuElement" class="conversation-context-menu" role="menu" aria-label="对话操作" :style="{left:`${contextMenu.x}px`,top:`${contextMenu.y}px`}" @keydown="menuKey" @contextmenu.prevent><button role="menuitem" :disabled="pinDisabled" @click="changePin">{{pinMenuLabel}}</button></div></Teleport></template>

<style scoped>
.conversation-list{overflow-anchor:none;display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden;background:var(--sand-bg-sidebar)}
.pinned-conversations{max-height:260px;overflow-y:auto;overscroll-behavior:contain}
.pinned-bot>.pinned-conversation-avatar{width:60px;height:60px;flex:none;position:relative}
.pinned-conversation-avatar :deep(.channel-avatar){width:100%;height:100%}
.pinned-platform-badge{position:absolute;right:-2px;bottom:0;width:16px;height:16px;object-fit:contain}
.conversation-context-menu{position:fixed;z-index:1000;width:max-content;min-width:min(144px,calc(100vw - 16px));max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;padding:4px;border-radius:12px;background:var(--sand-bg-elevated);color:var(--sand-text-primary);box-shadow:var(--shadow),inset 0 0 0 .5px var(--sand-border-primary-translucent)}
.conversation-context-menu button{display:block;width:100%;min-height:30px;padding:4px 8px;border-radius:6px;text-align:left;font-size:13px;line-height:18px;white-space:normal;overflow-wrap:anywhere}
.conversation-context-menu button:hover:not(:disabled){background:var(--sand-bg-hover)}
.conversation-context-menu button:focus-visible{outline-offset:-2px}
.conversation-context-menu button:disabled{color:var(--sand-text-tertiary);opacity:1}
.conversation-list-heading{display:flex;gap:8px;align-items:center;flex:none;padding:0 16px 8px}
.conversation-search{display:flex;align-items:center;gap:8px;width:100%;height:28px;border-radius:10px;background:var(--sand-bg-secondary);padding:4px 8px;color:var(--sand-icon-secondary)}
.conversation-search input{width:100%;min-width:0;border:0;padding:0;background:transparent;font-size:13px;line-height:18px;outline:none}
.conversation-rows{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:4px;padding:0 12px 8px}
.conversation-row{display:flex;align-items:center;gap:8px;width:100%;min-width:0;min-height:54px;padding:8px;border-radius:10px;text-align:left;position:relative;flex:none;transition:background-color 140ms var(--ease-control)}
.conversation-row:hover{background:var(--sand-bg-hover)}
.conversation-row[aria-pressed=true],.conversation-row[aria-pressed=true]:hover{background:var(--sand-bg-active)}
.conversation-row:focus-visible{outline-offset:-2px}
.channel-entry-icon{display:flex;align-items:center;justify-content:center;border-radius:10px;background:var(--sand-bg-secondary);color:var(--sand-icon-secondary)}
.channel-entry strong{font-size:14px;line-height:20px;font-weight:500}.channel-entry>.ui-icon{flex:none;color:var(--sand-icon-secondary)}
.conversation-avatar{width:36px;height:36px;flex:none}
.conversation-avatar.is-group{display:block;position:relative;overflow:visible;border-radius:0;clip-path:none;background:transparent}
.conversation-avatar.is-group :deep(.avatar){position:absolute;width:56%;height:56%;min-width:0;min-height:0;left:22%;top:0;z-index:1;border-radius:50%;clip-path:circle(50%);mask-image:none;overflow:hidden;background:transparent}
.conversation-avatar.is-group :deep(.avatar:nth-child(2)){left:0;top:38.105%;z-index:2}
.conversation-avatar.is-group :deep(.avatar:nth-child(3)){left:44%;top:38.105%;z-index:3}
.conversation-avatar.is-group :deep(.avatar:only-child){width:100%;height:100%;left:0;top:0}
.conversation-avatar.is-group :deep(.avatar>img){object-fit:cover}
.conversation-avatar.is-group>.ui-icon{position:absolute;inset:0;margin:auto}
.conversation-row-body{display:flex;flex-direction:column;flex:1;min-width:0;gap:4px}
.conversation-row-top{display:flex;align-items:center;gap:8px;min-width:0}
.conversation-row-top strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;font-weight:500}
.conversation-row-top time{font-size:12px;line-height:16px;color:var(--sand-text-tertiary);font-variant-numeric:tabular-nums;flex:none}
.conversation-row-preview{font-size:13px;line-height:18px;color:var(--sand-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conversation-row-channel{font-size:11px;line-height:16px;color:var(--sand-text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.channel-avatar-pair{position:relative;display:flex;align-items:center;width:36px;height:36px;flex:none}
.channel-avatar-pair .role-avatar{position:absolute;z-index:2;bottom:-2px;left:-3px;width:16px;height:16px;border-radius:50%;box-shadow:0 0 0 1.5px var(--sand-bg-sidebar)}
.avatar-link{display:none}.channel-avatar-pair :deep(.channel-avatar){width:36px;height:36px;border-radius:10px}
.channel-avatar-target{position:relative;display:flex;flex:none}.channel-platform-badge{position:absolute;right:-3px;bottom:-2px;width:12px;height:12px;object-fit:contain;background:var(--sand-bg-sidebar)}
.conversation-row:hover .channel-platform-badge{background:var(--sand-bg-sidebar)}
.conversation-list-empty{padding:20px 8px;color:var(--sand-text-tertiary);font-size:13px;line-height:18px;text-align:center}
.conversation-empty-action{align-self:center}.activity-dot{position:absolute;right:8px;bottom:8px;width:5px;height:5px}
@container workspace-sidebar (max-width:130px){.conversation-row-body{display:none}.conversation-row{justify-content:center;width:54px;margin-inline:auto;padding:8px}.conversation-row>.unread-badge{position:absolute;right:1px;top:1px}}
@container workspace-sidebar (max-width:200px){.pinned-bot>.pinned-conversation-avatar{width:36px;height:36px}}
@media(prefers-reduced-motion:reduce){.conversation-row{transition:none}}
</style>
