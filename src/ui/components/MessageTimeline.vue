<script setup lang="ts">
import {computed,shallowReactive,nextTick,onMounted,onBeforeUnmount,ref,watch} from 'vue'
import {directInputForMessage,directInputLabel,directInputNeedsQuery,directInputVisible} from '../direct-input-state.mjs'
import type {Message,Conversation,Character,SchedulerThought} from '../types'
import type {ObservabilityRound,ObservabilityItem} from '../conversation-observability'
import {conversationTime,messageOnRight} from '../conversation-state.mjs'
import {roundMessages} from '../round-message-association.mjs'
import {visibleSchedulerThoughts,schedulerTimelineItems} from '../channel-scheduler-projection.mjs'
import CharacterAvatar from './CharacterAvatar.vue'
import MessageContent from './MessageContent.vue'
import RoundUsage from './RoundUsage.vue'
import TooltipButton from './TooltipButton.vue'
import {localRoleMarker} from '../local-role-ui.mjs'
import {replyMotion,replyMask,createReplyQueue,paceReply,firstReplyBubble} from '../reply-motion.mjs'
import {sendMotion,bezier,clamp} from '../send-motion-tokens.mjs'
import {FollowController,motionConstants,holdTranscript} from '../ui-motion.mjs'
type TimelineMessage=Message&{renderKey?:string;localPending?:boolean;localStatus?:string;deliveryUncertain?:boolean;localAttachments?:Array<{key?:string;name:string;kind?:string;previewUrl?:string;width?:number;height?:number}>;replyPreview?:{messageId:string;sender:{name:string};text:string;kind:string}}
const props=withDefaults(defineProps<{messages:TimelineMessage[];directInputs?:import('../types').DirectChatInput[];conversation?:Conversation;characters:Character[];activeRuns:Array<{characterId:string;conversationId?:string;runId?:string}>;pending:Array<{characterId:string;conversationId?:string}>;active:boolean;canReply?:boolean;canQueryReceipt?:boolean;sendProgressVisible?:boolean;designPreview?:boolean;rounds?:ObservabilityRound[];perRound?:boolean;records?:ObservabilityItem[];schedulerThoughts?:SchedulerThought[]}>(),{rounds:()=>[],records:()=>[],schedulerThoughts:()=>[],perRound:false,canReply:false,canQueryReceipt:false,designPreview:false})
const emit=defineEmits<{scroll:[Event];reply:[Message];queryReceipt:[Message]}>()
const element=ref<HTMLElement>()
const character=(id:string)=>props.characters.find(person=>person.id===id)
const associatedRounds=computed(()=>props.perRound?roundMessages(props.messages,props.rounds,props.records):new Map())
const thoughts=computed(()=>visibleSchedulerThoughts(props.schedulerThoughts,props.conversation,props.characters))
const thoughtsOnRight=computed(()=>messageOnRight({sender:{type:'character'}},props.conversation))
const queuedReplyKeys=ref(new Set<string>())
const visibleMessages=computed(()=>props.messages.filter(item=>!queuedReplyKeys.value.has(item.renderKey??item.id)))
const timelineItems=computed(()=>schedulerTimelineItems(visibleMessages.value,thoughts.value).map((item:any)=>item.kind==='message'?{...item,key:item.message.renderKey??item.key}:item))
const content=ref<HTMLElement>(),pinned=ref(true),dismissed=ref(''),actionNotice=ref('')
let handoff:ReturnType<typeof holdTranscript>,processingTimer:ReturnType<typeof setTimeout>|undefined
const showProcessing=ref(false),pageVisible=ref(typeof document==='undefined'||!document.hidden)
function pageVisibility(){pageVisible.value=!document.hidden;if(!pageVisible.value)retireEntries()}
onMounted(()=>document.addEventListener('visibilitychange',pageVisibility))
onBeforeUnmount(()=>document.removeEventListener('visibilitychange',pageVisibility))
let renderedConversationId='',restorationPending=true,copyEpoch=0
let follow:FollowController|undefined,disposed=false,generation=0,dismissTimer:ReturnType<typeof setTimeout>|undefined
const enteringKeys=ref(new Set<string>()),morphKey=ref('')
const messageNodes=new Map<string,HTMLElement>()
const textEntities=shallowReactive(new Map<string,HTMLElement>())
function bindMessageNode(key:string,node:unknown){if(node&&typeof (node as HTMLElement).getBoundingClientRect==='function')messageNodes.set(key,node as HTMLElement);else messageNodes.delete(key)}
function reserveSendMorph(key:string){
 if(!element.value||!props.active||restorationPending)return null
 retireEntries();morphKey.value=key;follow?.cancel();follow?.setActive(false)
 const viewport=element.value,conversationId=props.conversation?.id
 let released=false
 const row=()=>messageNodes.get(key)
 const gap=()=>{const node=row();return node?.classList.contains('same')?4:16}
 return {viewport,row,gap,adoptEntity:(node:HTMLElement)=>{textEntities.set(key,node)},release:(completed=false)=>{
  if(released)return;released=true;const node=row()
  if(morphKey.value===key)morphKey.value=''
  void nextTick(()=>{
   if(node){node.style.removeProperty('height');node.style.removeProperty('margin-top')}
   if(props.active&&props.conversation?.id===conversationId&&!restorationPending&&!morphKey.value){if(enteringKeys.value.size)startFlowReveal();else{follow?.setActive(true);if(completed)follow?.immediate();else if(follow){follow.pinned=follow.bottomDistance()<=motionConstants.nearBottom;follow.capture()}}}
  })
 }}
}
let entryMedia:MediaQueryList|undefined
let flowFrame=0,flowRunning=false,flowTop=0,flowPinned=true
const replyQueue=createReplyQueue({onReady:(key:string)=>{const keys=new Set(queuedReplyKeys.value);keys.delete(key);queuedReplyKeys.value=keys;if(disposed||!props.active||document.hidden||entryMedia?.matches)return;enteringKeys.value=new Set([...enteringKeys.value,key]);void nextTick(()=>startFlowReveal())}})
const flowRows=new Map<string,{node:HTMLElement;start?:number}>()
function clearFlowStyles(node:HTMLElement){node.style.removeProperty('height');node.style.removeProperty('margin-top');for(const target of node.querySelectorAll<HTMLElement>('.entry-content,.message-body,.message-avatar'))for(const name of ['mask-image','-webkit-mask-image','transform','opacity'])target.style.removeProperty(name)}
function paintReplyReveal(node:HTMLElement,natural:number,progress:number){
 const inner=node.querySelector<HTMLElement>('.entry-content'),body=node.querySelector<HTMLElement>('.message-body'),avatar=node.querySelector<HTMLElement>('.message-avatar');if(!inner||!body)return;
 const contentHeight=inner.getBoundingClientRect().height||natural;
 inner.style.opacity='1';
 if(node.dataset.replyFirst==='true'){inner.style.maskImage=replyMask(natural,progress);inner.style.webkitMaskImage=inner.style.maskImage;}
 else{body.style.maskImage=replyMask(natural,progress);body.style.webkitMaskImage=body.style.maskImage;if(avatar)avatar.style.transform=`translateY(${-contentHeight*(1-progress)}px)`;}
}
function retireEntries(){replyQueue.reset();queuedReplyKeys.value=new Set();cancelAnimationFrame(flowFrame);flowFrame=0;flowRunning=false;for(const {node} of flowRows.values())clearFlowStyles(node);flowRows.clear();enteringKeys.value=new Set();if(!disposed&&!morphKey.value&&props.active&&!restorationPending)follow?.setActive(true)}
function startFlowReveal(){
 if(morphKey.value||!element.value||!props.active||restorationPending||entryMedia?.matches)return
 const viewport=element.value
 for(const key of enteringKeys.value){if(flowRows.has(key))continue;const node=messageNodes.get(key);if(node)flowRows.set(key,{node})}
 if(flowRunning||!flowRows.size)return
 flowRunning=true;flowTop=viewport.scrollTop;flowPinned=follow?.pinned??true;follow?.cancel();follow?.setActive(false)
 const conversationId=props.conversation?.id
 const tick=(now:number)=>{
  if(disposed||!props.active||document.hidden||props.conversation?.id!==conversationId||entryMedia?.matches){retireEntries();return}
  const finished:string[]=[]
  for(const [key,item] of flowRows){if(!item.node.isConnected){finished.push(key);continue}if(item.start===undefined)item.start=now
   const p=clamp((now-item.start)/replyMotion.durationMs),progress=bezier(p,replyMotion.curve),top=item.node.getBoundingClientRect().top,natural=Math.max(0,...[...item.node.children].map(child=>child.getBoundingClientRect().bottom-top)),gap=item.node.classList.contains('same')?4:16
   item.node.style.height=natural*progress+'px';item.node.style.marginTop=gap*progress+'px';paintReplyReveal(item.node,natural,progress)
   if(p===1)finished.push(key)
  }
  viewport.scrollTop=flowPinned?Math.max(0,viewport.scrollHeight-viewport.clientHeight):flowTop
  for(const key of finished){flowRows.delete(key);const next=new Set(enteringKeys.value);next.delete(key);enteringKeys.value=next}
  void nextTick(()=>{for(const key of finished){const node=messageNodes.get(key);if(node)clearFlowStyles(node)}})
  if(flowRows.size)flowFrame=requestAnimationFrame(tick);else{flowRunning=false;follow?.setActive(true);if(flowPinned)follow?.immediate();else follow?.capture()}
 };flowFrame=requestAnimationFrame(tick)
}
function flowInput(event?:Event){if(event?.type==='keydown'&&!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes((event as KeyboardEvent).key))return;if(!flowRunning)return;retireEntries();if(follow){follow.pinned=false;follow.capture()}}

function entryPreference(){if(entryMedia?.matches)retireEntries()}

const seenByConversation=new Map<string,Set<string>>(),positions=new Map<string,{top:number}>()
function sameSender(a:Message|undefined,b:Message|undefined){return !!a&&!!b&&a.sender.type===b.sender.type&&a.sender.id===b.sender.id&&messageOnRight(a,props.conversation)===messageOnRight(b,props.conversation)}
function joined(message:Message,step:number){
 const index=timelineItems.value.findIndex(item=>item.kind==='message'&&item.message.id===message.id),adjacent=timelineItems.value[index+step]
 if(localRoleMarker(message)||adjacent?.kind==='message'&&localRoleMarker(adjacent.message)||adjacent?.kind!=='message'||!sameSender(message,adjacent.message))return false
 const before=step<0?adjacent.message:message
 return !visibleInputFor(before)&&!(associatedRounds.value.get(before.id)?.length)&&!['failed','unknown'].includes(before.status)
}
function inputFor(message:TimelineMessage){if(props.conversation?.channel!=='desktop'||props.conversation.kind!=='direct')return;const input=directInputForMessage(props.directInputs??[],message);return input&&props.conversation.participantIds.includes(input.characterId)?input:undefined}
function visibleInputFor(message:TimelineMessage){const input=inputFor(message);return directInputVisible(input)?input:undefined}
function queryInput(message:TimelineMessage){const input=inputFor(message);if(input)emit('queryReceipt',{...message,requestId:input.requestId})}
function receiptVisible(message:TimelineMessage){return !message.localPending||props.sendProgressVisible||!['preparing','sending'].includes(message.localStatus??'sending')}
function hasAvatar(message:Message){if(localRoleMarker(message))return false;return message.sender.type==='character'||props.conversation?.kind==='group'&&!messageOnRight(message,props.conversation)}
const isProcessing=computed(()=>showProcessing.value&&props.activeRuns.length>0)
const statusPeople=computed(()=>isProcessing.value?props.activeRuns:props.pending)
const statusNames=computed(()=>statusPeople.value.map(run=>character(run.characterId)?.name).filter(Boolean).join('、'))
const statusText=computed(()=>[statusNames.value,isProcessing.value?'正在处理':'等待处理'].filter(Boolean).join(' '))
const statusOnRight=computed(()=>messageOnRight({sender:{type:'character'}},props.conversation))
function markState(id:string){return props.activeRuns.some(run=>run.characterId===id)?'working':props.pending.some(run=>run.characterId===id)?'waiting':'idle'}
function suppressActions(id:string){clearTimeout(dismissTimer);dismissed.value=id;dismissTimer=setTimeout(()=>{dismissed.value=''},motionConstants.actionDismiss)}
async function copyMessage(message:Message){
 if(disposed||!props.active)return
 const ticket=++copyEpoch,id=props.conversation?.id
 const current=()=>!disposed&&props.active&&ticket===copyEpoch&&id===props.conversation?.id
 try{
  if(typeof window.sandbook?.writeClipboardText==='function')await window.sandbook.writeClipboardText(message.text)
  else await navigator.clipboard.writeText(message.text)
  if(current())actionNotice.value='消息已复制'
 }catch{if(current())actionNotice.value='复制失败，请重试'}
 if(current())suppressActions(message.id)
}
function quotable(message:TimelineMessage){return props.canReply&&!message.localPending&&['human','character'].includes(message.sender.type)&&message.status==='delivered'&&(props.conversation?.channel==='desktop'||!!message.externalId)}
function jumpToQuote(message:TimelineMessage){const id=message.replyPreview?.messageId,node=[...element.value?.querySelectorAll<HTMLElement>('[data-message]')??[]].find(node=>node.dataset.message===id);if(node){node.scrollIntoView({block:'center',behavior:'instant'});node.focus({preventScroll:true})}else actionNotice.value='原消息不在当前记录中'}
function rememberPosition(id=renderedConversationId){const node=element.value;if(!id||id!==renderedConversationId||!node||node.clientHeight<=0||!follow?.initialized||restorationPending)return;positions.set(id,{top:node.scrollTop})}
function restoreVisible(){
 const node=element.value,id=props.conversation?.id??''
 if(disposed||!restorationPending||!props.active||!node||node.clientHeight<=0||renderedConversationId!==id||!follow)return
 follow.setActive(true);follow.restore(positions.get(id)?.top);restorationPending=false
}
function timelineScrolled(event:Event){rememberPosition();emit('scroll',event)}
/** Explicit send/jump actions may follow; selection and activation only restore. */
function scrollToEnd({immediate=false,force=true}={}){if(morphKey.value)return;if(!follow||!props.active||restorationPending)return;if(force)follow.pinned=true;if(immediate&&(force||follow.pinned))follow.immediate();else if(force)follow.contentChanged();else follow.onResize()}
function followLatest(){scrollToEnd({force:true})}
watch(()=>({id:props.conversation?.id??'',busy:props.activeRuns.length>0||props.pending.length>0,active:props.active,ids:props.messages.map(item=>item.renderKey??item.id)}),async(next,previous)=>{
 const ticket=++generation,changed=next.id!==previous?.id,node=element.value
 if(changed){handoff?.cancel();handoff=holdTranscript(node,{busy:previous?.busy===true||next.busy})}
 if(changed||previous?.active&&!next.active)rememberPosition(previous?.id)
 for(const key of textEntities.keys())if(changed||!next.ids.includes(key))textEntities.delete(key)
 const restoring=changed||next.active!==previous?.active
 if(restoring){copyEpoch++;restorationPending=true;follow?.setActive(false)}else if(!follow?.pinned)follow?.capture()
 let seen=seenByConversation.get(next.id),entering:string[]=[]
 if(!seen){seen=new Set(next.ids);seenByConversation.set(next.id,seen)}else{const tail=previous?.id===next.id?(previous.ids.at(-1)??''):null,index=tail?next.ids.indexOf(tail):-1;entering=props.active&&previous?.active&&!changed&&pageVisible.value&&!entryMedia?.matches?next.ids.filter((id,position)=>!seen!.has(id)&&(tail===null?false:tail===''||index>=0&&position>index)):[];for(const id of next.ids)seen.add(id)}
 if(changed){dismissed.value='';actionNotice.value='';if(dismissTimer)clearTimeout(dismissTimer);follow?.cancel();retireEntries()}
 if(restoring||!pageVisible.value||entryMedia?.matches)retireEntries()
 else{
  const delayed=new Set(queuedReplyKeys.value),immediate:string[]=[];
  for(const key of [...delayed]){const message=props.messages.find(item=>(item.renderKey??item.id)===key);if(!message||!paceReply(message)){replyQueue.remove(key);delayed.delete(key)}}
  for(const key of entering){if(key===morphKey.value)continue;const message=props.messages.find(item=>(item.renderKey??item.id)===key);if(message&&paceReply(message)){delayed.add(key);replyQueue.add(key,message)}else immediate.push(key)}
  queuedReplyKeys.value=delayed;enteringKeys.value=new Set([...enteringKeys.value].filter(key=>next.ids.includes(key)).concat(immediate))
 }
 // New rows grow their own flow extent instead of triggering a second follow animation.
 await nextTick();if(disposed||ticket!==generation||!element.value)return
 renderedConversationId=next.id;restoreVisible()

 if(!morphKey.value&&!restorationPending&&props.active){if(enteringKeys.value.size)startFlowReveal();else if(!flowRunning)follow?.onResize()}if(changed)handoff?.ready()
},{immediate:true})
watch(()=>thoughts.value.map(item=>`${item.id}:${item.updatedAt}`).join('|'),async()=>{await nextTick();if(props.active)follow?.onResize()})
watch([()=>props.active,()=>props.conversation?.id,()=>props.activeRuns.length>0],()=>{if(processingTimer)clearTimeout(processingTimer);showProcessing.value=false;const id=props.conversation?.id;if(props.active&&props.activeRuns.length)processingTimer=setTimeout(()=>{if(props.active&&props.conversation?.id===id&&props.activeRuns.length)showProcessing.value=true},motionConstants.loadingReveal)},{immediate:true})
onMounted(()=>{window.addEventListener('resize',retireEntries);entryMedia=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion:reduce)'):undefined;entryMedia?.addEventListener('change',entryPreference);if(!element.value||!content.value)return;follow=new FollowController(element.value,content.value,{active:false,initialized:false,autoFollow:false,onLayout:restoreVisible,onState:(value:boolean)=>{pinned.value=value}});renderedConversationId=props.conversation?.id??'';restoreVisible()})
onBeforeUnmount(()=>{window.removeEventListener('resize',retireEntries);entryMedia?.removeEventListener('change',entryPreference);rememberPosition();disposed=true;generation++;follow?.destroy();handoff?.cancel();if(processingTimer)clearTimeout(processingTimer);retireEntries();replyQueue.close();if(dismissTimer)clearTimeout(dismissTimer)})
defineExpose({element,scrollToEnd,followLatest,reserveSendMorph})
</script>
<template>
<div ref="element" class="timeline chat-timeline" :class="{'motion-paused':!active||!pageVisible}" @scroll="timelineScrolled" @keydown="flowInput" @pointerdown="flowInput" @wheel.passive="flowInput" @touchstart.passive="flowInput" role="log" aria-label="聊天记录" aria-live="polite">
 <div ref="content" class="transcript-content">
 <slot v-if="!conversation||!timelineItems.length" name="empty"><slot/></slot>
 <template v-else>
  <div v-if="conversation.kind==='group'&&messages.length" class="date-divider">{{designPreview?'示例对话 · 仅用于设计预览':conversationTime(messages[0]!.createdAt,true)}}</div>
  <template v-for="item in timelineItems" :key="item.key">
   <article v-if="item.kind==='thought'" class="message scheduler-thought message-has-avatar" :data-message="item.thought.id" :class="{'from-user':thoughtsOnRight,'outgoing-message':thoughtsOnRight}" :aria-label="`${character(item.thought.characterId)?.name??'角色'}的群聊调度状态`">
    <div class="entry-content message-inner"><CharacterAvatar class="small message-avatar" shape="role" :person="character(item.thought.characterId)" :active="active"/>
    <div class="message-body"><div v-if="conversation.kind==='group'" class="message-meta"><span>{{character(item.thought.characterId)?.name}} · {{item.thought.kind==='result'?'调度结果':'调度状态'}}</span></div><div v-else class="scheduler-thought-source">{{item.thought.sourceConversationName}}</div><div class="scheduler-thought-bubble"><p class="scheduler-thought-text">{{item.thought.text}}</p><template v-if="item.thought.kind==='result'"><dl v-if="item.thought.decision" class="scheduler-decision"><div><dt>是否启动回复</dt><dd>{{item.thought.decision.shouldReply?'是':'否'}}</dd></div><div><dt>简短原因</dt><dd>{{item.thought.decision.reason}}</dd></div><div><dt>指代消解</dt><dd><ul v-if="item.thought.decision.resolvedReferences.length"><li v-for="(reference,index) in item.thought.decision.resolvedReferences" :key="index">{{reference.expression}}：{{reference.referent}}</li></ul><span v-else>无待消解指代</span></dd></div></dl><p v-else class="scheduler-decision-missing">原因未记录</p></template></div><span class="scheduler-thought-dot" aria-hidden="true"></span></div></div><div class="message-footer"><time class="scheduler-thought-time" :datetime="item.thought.updatedAt">{{conversationTime(item.thought.updatedAt)}}</time></div>
   </article>
   <template v-else v-for="message in [item.message]" :key="message.renderKey??message.id">
   <article class="message" :ref="node=>bindMessageNode(message.renderKey??message.id,node)" :data-message="message.id" :data-render-key="message.renderKey??message.id" :data-send-morph="morphKey===(message.renderKey??message.id)||undefined" :data-reply-first="firstReplyBubble(message,props.messages)||undefined" :data-flow-enter="enteringKeys.has(message.renderKey??message.id)||undefined" tabindex="-1" :class="{'channel-message':conversation.channel!=='desktop','from-user':messageOnRight(message,conversation),'outgoing-message':messageOnRight(message,conversation),same:joined(message,-1),connected:joined(message,1),'message-has-avatar':hasAvatar(message)}">
    <div class="entry-content message-inner">
    <CharacterAvatar v-if="hasAvatar(message)" class="small message-avatar" shape="role" :person="message.sender.type==='character'?character(message.sender.id):undefined" :mark-state="markState(message.sender.id)" :active="active" :image-url="message.sender.avatarUrl" :fallback="message.sender.name"/>
    <div class="message-body" :class="{dismissed:dismissed===message.id}">
     <div v-if="!localRoleMarker(message)&&conversation.kind==='group'&&!joined(message,-1)&&(message.sender.type==='character'||!messageOnRight(message,conversation))" class="message-meta"><span>{{message.sender.name}}</span></div>
     <button v-if="message.replyPreview" type="button" class="message-quote" @click="jumpToQuote(message)" :aria-label="`查看引用：${message.replyPreview.sender.name}`"><strong>{{message.replyPreview.sender.name}}</strong><span>{{message.replyPreview.text||'附件'}}</span></button>
     <div class="message-bubble-row"><MessageContent data-morph-target :message="message" :people="characters" :local-pending="message.localPending" :local-attachments="message.localAttachments" :text-entity="textEntities.get(message.renderKey??message.id)" :text-flying="morphKey===(message.renderKey??message.id)" :channel="conversation.channel!=='desktop'" :active="active"/><div v-if="!localRoleMarker(message)&&(message.text.trim()||quotable(message))" class="message-actions" aria-label="消息操作"><TooltipButton v-if="message.text.trim()" label="复制消息" icon="copy" :size="16" @click="copyMessage(message)"/><TooltipButton v-if="quotable(message)" label="引用消息" icon="reply" :size="16" @click="emit('reply',message)"/></div><time class="message-time" :datetime="message.createdAt">{{conversationTime(message.createdAt)}}</time></div>
    </div></div>
    <div v-if="visibleInputFor(message)||associatedRounds.get(message.id)?.length||!inputFor(message)&&(message.localPending&&['failed','unknown'].includes(message.localStatus??'')||!message.localPending&&(message.deliveryUncertain||['failed','unknown'].includes(message.status)))" class="message-footer">
     <span v-if="visibleInputFor(message)" class="message-receipt direct-input-receipt inline-error" role="status">{{directInputLabel(inputFor(message))}}<button v-if="canQueryReceipt&&directInputNeedsQuery(inputFor(message))" type="button" class="text-button" @click="queryInput(message)">检查状态</button></span><template v-else-if="!inputFor(message)"><span v-if="message.localPending" class="message-receipt inline-error">{{message.localStatus==='unknown'?'发送结果待确认':'消息发送失败'}}</span><span v-else-if="message.status==='unknown'||message.deliveryUncertain" class="message-receipt">发送结果待确认<button v-if="canQueryReceipt&&message.requestId" type="button" class="text-button" @click="emit('queryReceipt',message)">检查状态</button></span><span v-else-if="message.status==='failed'" class="inline-error">消息发送失败</span></template>
     <RoundUsage v-for="round in associatedRounds.get(message.id)??[]" :key="round.roundId" class="timeline-round-usage" :round="round"/>
    </div>
   </article>
   </template>
  </template>
 </template>
 <div class="timeline-status-slot"><Transition name="reply-status"><div v-if="statusPeople.length" class="timeline-status" :class="{'outgoing-status':statusOnRight,typing:isProcessing,'pending-line':!isProcessing,'processing-held':!!morphKey}">
  <div class="status-content">
   <span v-if="isProcessing" class="processing-capsule" aria-hidden="true"><i class="processing-dot"/><i class="processing-dot"/><i class="processing-dot"/></span>
   <span class="status-copy" :class="{'processing-label':isProcessing}">{{statusText}}</span>
  </div>
 </div></Transition></div>
<p v-if="actionNotice" class="message-action-status" role="status">{{actionNotice}}</p>
</div></div>
</template>
<style src="../chat-timeline.css"></style>

<style scoped>
.timeline-status-slot{height:56px;min-height:56px;flex:none;display:flex;align-items:center}.timeline.chat-timeline .timeline-status{margin-top:0;width:100%}.timeline.chat-timeline .timeline-status-slot .status-copy{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.reply-status-enter-active,.reply-status-leave-active{transition:opacity 180ms ease-out}.reply-status-enter-from,.reply-status-leave-to{opacity:0}@media(prefers-reduced-motion:reduce){.reply-status-enter-active,.reply-status-leave-active{transition:none}}
.timeline-status.processing-held{visibility:hidden}.timeline-status.processing-held :deep(*){animation-play-state:paused!important}

.timeline.chat-timeline .message:is([data-send-morph],[data-flow-enter]){height:0;margin-top:0;min-height:0}.timeline.chat-timeline .message[data-send-morph]{overflow:hidden}.timeline.chat-timeline .message[data-flow-enter]{overflow:visible}.timeline.chat-timeline .message[data-flow-enter] .entry-content{opacity:0}.timeline.chat-timeline .message[data-send-morph]{visibility:hidden}.timeline.chat-timeline .message:is([data-send-morph],[data-flow-enter]) .entry-content{animation:none!important}
.local-message-content p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.local-message-attachment img{display:block;max-width:min(384px,100%);max-height:360px;height:auto;object-fit:contain;border-radius:8px}.local-message-attachment+.local-message-attachment,.local-message-attachment+p{margin-top:8px}.message-quote{display:flex;flex-direction:column;gap:4px;max-width:100%;padding:8px 12px;margin-bottom:4px;text-align:left;background:var(--hover);color:var(--muted);border:0;border-radius:8px;font:inherit;cursor:pointer}.message-quote strong{font-weight:500;color:var(--text)}.message-quote span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
</style>
