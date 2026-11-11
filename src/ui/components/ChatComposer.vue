<script lang="ts">
export interface ComposerAttachment {
  key:string
  name:string
  kind:'image'|'file'
  size?:number
  mime?:string
  previewUrl?:string
  previewText?:string
  delivery?:'controlled-url'
  loaded?:number
  total?:number
  status:'error'|'unknown'|'uploading'|'ready'
  error?:string
}
export interface ComposerReply {messageId:string;senderName?:string;text:string}
</script>
<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onMounted,ref,useId,watch} from 'vue'
import {attachmentSize,composerMenuIndex,composerPreviewUrl} from '../composer-attachments.mjs'
import {composerDirection,composerContentHeight,composerAutoExpanded} from '../composer-geometry.mjs'
import {sendMotion} from '../send-motion-tokens.mjs'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
const props=withDefaults(defineProps<{text:string;attachments:ComposerAttachment[];handoff?:boolean;reply?:ComposerReply;disabled?:boolean;sending?:boolean;sendLabel?:string;sendDisabled?:boolean;attachmentsAvailable?:boolean;captureAvailable?:boolean;captureBusy?:boolean;nativePickerAvailable?:boolean;nativePickerBusy?:boolean;nativePickerUnknown?:boolean;active?:boolean;conversationKey?:string}>(),{handoff:false,disabled:false,sending:false,sendLabel:'发送消息',sendDisabled:false,attachmentsAvailable:true,captureAvailable:false,captureBusy:false,active:true})
const emit=defineEmits<{'update:text':[value:string];files:[files:File[],source:'file'|'image',conversationKey?:string];detach:[key:string];retry:[key:string];preview:[key:string];capture:[];nativeFiles:[source:'file'|'image'];cancelNative:[];resumeNative:[];send:[];clearReply:[]}>()
const root=ref<HTMLFormElement>(),shell=ref<HTMLDivElement>(),content=ref<HTMLDivElement>(),fieldHost=ref<HTMLDivElement>(),trailing=ref<HTMLDivElement>(),textarea=ref<HTMLTextAreaElement>(),plus=ref<HTMLButtonElement>(),menu=ref<HTMLDivElement>(),fileInput=ref<HTMLInputElement>(),imageInput=ref<HTMLInputElement>(),attachmentRow=ref<HTMLElement>(),replyRow=ref<HTMLElement>()
const intrinsicField=typeof CSS!=='undefined'&&CSS.supports('field-sizing','content')
const inputBuffer=ref(props.text)
const textModel=computed({get:()=>props.text,set:(value:string)=>emit('update:text',value)})
const initialPayload=props.attachments.length>0||!!props.reply||!!props.nativePickerBusy||!!props.nativePickerUnknown
const morphing=ref(false),motionHeight=ref<number|null>(null)
const placeholderAnimations=new Set<Animation>()
function stopPlaceholder(){for(const animation of placeholderAnimations)animation.cancel();placeholderAnimations.clear()}
function placeholderAnimation(element:Element,done:()=>void,leaving=false){
 if(composing.value||morphing.value||matchMedia('(prefers-reduced-motion:reduce)').matches){done();return}
 const node=element as HTMLElement
 if(leaving)Object.assign(node.style,{maskImage:'linear-gradient(90deg,transparent 40%,#000 60%)',webkitMaskImage:'linear-gradient(90deg,transparent 40%,#000 60%)',maskSize:'250% 100%',webkitMaskSize:'250% 100%'})
 const animation=node.animate(leaving?[{maskPosition:'100% 0%',webkitMaskPosition:'100% 0%',opacity:1},{maskPosition:'0% 0%',webkitMaskPosition:'0% 0%',opacity:0}]:[{opacity:0},{opacity:1}],{duration:sendMotion.placeholderMs,easing:'ease-out',fill:leaving?'forwards':'none'})
 placeholderAnimations.add(animation);animation.finished.then(()=>{placeholderAnimations.delete(animation);done()},()=>{placeholderAnimations.delete(animation);done()})
}
function enterPlaceholder(element:Element,done:()=>void){placeholderAnimation(element,done)}
function leavePlaceholder(element:Element,done:()=>void){placeholderAnimation(element,done,true)}
function startMorph(){stopPlaceholder();motionHeight.value=shell.value?.getBoundingClientRect().height??height.value;morphing.value=true;let closed=false;return {naturalHeight:()=>height.value,setHeight:(value:number)=>{if(closed)return;motionHeight.value=value;if(shell.value)shell.value.style.height=value+'px'},finish:()=>{if(closed)return;closed=true;motionHeight.value=null;morphing.value=false;if(shell.value)shell.value.style.height=height.value+'px'}}}
const restoreHold=ref(false)
let restoreMeasurePending=false
const expandedSettled=ref(initialPayload),autoExpanded=ref(false),rawTextHeight=ref(20),trailingWidth=ref(28)
const fieldDirection=computed(()=>composerDirection(props.text))
const expanded=ref(initialPayload),height=ref(initialPayload?76:44),textHeight=ref(20),composing=ref(false),menuOpen=ref(false),menuIndex=ref(0),menuPosition=ref({left:'0px',top:'0px'}),previewKey=ref(''),failedImages=ref<string[]>([])
const heightSnap=computed(()=>expanded.value&&(expandedSettled.value||composing.value))
const formHoldsOpenHeight=computed(()=>expanded.value&&!heightSnap.value&&restoreHold.value)
watch([expanded,heightSnap],([open,snap])=>{if(!open||snap)restoreHold.value=false},{flush:'sync'})
watch([expanded,composing],([open,ime])=>{if(!open)expandedSettled.value=false;else if(ime)expandedSettled.value=true},{flush:'sync'})
const menuId=`composer-menu-${useId()}`
const previewAttachment=computed(()=>props.attachments.find(item=>item.key===previewKey.value))
const submitDisabled=computed(()=>props.disabled||props.sending||props.sendDisabled||props.nativePickerBusy||props.nativePickerUnknown||(!props.text.trim()&&!props.attachments.length))
const menuItems=computed(()=>[{label:'插入文件',icon:'file',source:'file',disabled:props.disabled||!props.attachmentsAvailable},{label:'插入图片',icon:'image',source:'image',disabled:props.disabled||!props.attachmentsAvailable},{label:props.captureBusy?'正在截屏…':'截屏',icon:'monitor',source:'capture',disabled:props.disabled||!props.captureAvailable||props.captureBusy}])
const pickerConversations=new Map<'file'|'image',string|undefined>()
let resize:ResizeObserver|undefined,lastWidth=0,lastContentHeight=0,lastTrailingWidth=0,lastFieldHeight=0,lastHostWidth=0,layoutMeasureQueued=false,measureRevision=0,measureGeneration=0,disposed=false,previewTrigger:HTMLElement|undefined,restoredSettledFrame:{key:string|undefined;height:number}|undefined
function previewUrl(attachment:ComposerAttachment){return composerPreviewUrl(attachment.previewUrl,location.origin)}
let latestMeasurement:Promise<void>|undefined
function measure(source='edit'){
 const key=props.conversationKey,generation=measureGeneration
 let task=measureFrame(source);latestMeasurement=task
 return (async()=>{await task;while(!disposed&&props.active&&key===props.conversationKey&&generation===measureGeneration&&latestMeasurement&&latestMeasurement!==task){task=latestMeasurement;await task}})()
}
async function measureFrame(source='edit'){
 const conversationKey=props.conversationKey,generation=measureGeneration,revision=++measureRevision
 const valid=()=>!disposed&&props.active&&generation===measureGeneration&&revision===measureRevision&&conversationKey===props.conversationKey
 await nextTick();const field=textarea.value;if(!valid()||!field)return
 const scrollTop=fieldHost.value?.scrollTop??0
 if(!intrinsicField)field.style.height='20px'
 const measured=Math.max(20,field.scrollHeight)
 rawTextHeight.value=measured;textHeight.value=measured;if(!intrinsicField)field.style.height=`${measured}px`
 if(fieldHost.value)fieldHost.value.scrollTop=scrollTop
 autoExpanded.value=composerAutoExpanded(autoExpanded.value,{text:field.value,raw:measured,source})
 expanded.value=autoExpanded.value||props.attachments.length>0||!!props.reply||!!props.nativePickerBusy||!!props.nativePickerUnknown
 const measuredTrailing=trailing.value?.offsetWidth;if(measuredTrailing&&measuredTrailing>0)trailingWidth.value=measuredTrailing
 await nextTick();if(!valid())return
 const measuredContent=composerContentHeight(measured,content.value?.offsetHeight,field.offsetHeight)
 const nextHeight=expanded.value?8+measuredContent+48:44
 if(restoredSettledFrame){if(restoredSettledFrame.key===conversationKey&&expanded.value&&height.value===nextHeight&&restoredSettledFrame.height===nextHeight)expandedSettled.value=true;restoredSettledFrame=undefined}
 if(restoreMeasurePending){restoreHold.value=expanded.value&&!heightSnap.value;restoreMeasurePending=false}
 height.value=nextHeight
}
function queueLayoutMeasure(){if(layoutMeasureQueued||disposed||!props.active)return;layoutMeasureQueued=true;void nextTick(()=>{layoutMeasureQueued=false;if(!disposed&&props.active)void measure('layout')})}
function frameTransitionEnd(event:TransitionEvent){if(!disposed&&event.target===shell.value&&event.propertyName==='height'&&expanded.value)expandedSettled.value=true}
function focus(options:FocusOptions={preventScroll:true}){if(props.active)textarea.value?.focus(options)}
function focusShell(event:MouseEvent){if(!(event.target as Element|null)?.closest?.('button,a,input,textarea,[role=menu]'))focus()}
function submit(){if(submitDisabled.value||composing.value||!props.active)return false;emit('send');return true}
function textKey(event:KeyboardEvent){if(event.isComposing||event.keyCode===229||composing.value)return;if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submit()}}
function compositionStart(){
 composing.value=true;stopPlaceholder()
 // Suppress even a leaving hint synchronously, before the IME paints preedit text.
 for(const hint of root.value?.querySelectorAll<HTMLElement>('.composer-placeholder')??[])hint.style.visibility='hidden'
}
function fieldInput(){inputBuffer.value=textarea.value?.value??'';void measure()}
function compositionEnd(){inputBuffer.value=textarea.value?.value??'';composing.value=false;if(!props.text&&!inputBuffer.value&&!morphing.value)for(const hint of root.value?.querySelectorAll<HTMLElement>('.composer-placeholder')??[])hint.style.visibility='';void measure()}
function dropFiles(event:DragEvent){if(!props.active||props.disabled||!props.attachmentsAvailable)return;const files=Array.from(event.dataTransfer?.files??[]);if(files.length)emit('files',files,'file',props.conversationKey)}
function chooseFiles(event:Event,source:'file'|'image'){
 const input=event.target as HTMLInputElement,files=Array.from(input.files??[]),openedHere=pickerConversations.has(source),conversation=openedHere?pickerConversations.get(source):props.conversationKey;input.value='';pickerConversations.delete(source)
 if(!files.length||!openedHere&&(!props.active||props.disabled||!props.attachmentsAvailable))return
 emit('files',files,source,conversation)
}
function enabledMenu(){return menuItems.value.flatMap((item,index)=>item.disabled?[]:[index])}
function menuButtons(){return Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')??[])}
function focusMenu(index:number){menuIndex.value=index;menuButtons()[index]?.focus({preventScroll:true})}
function placeMenu(){const box=plus.value?.getBoundingClientRect();if(!box||!menu.value)return;const width=Math.min(188,window.innerWidth-16),h=menu.value.offsetHeight;menuPosition.value={left:`${Math.max(8,Math.min(window.innerWidth-width-8,box.left))}px`,top:`${Math.max(8,box.top-h-6>=8?box.top-h-6:Math.min(window.innerHeight-h-8,box.bottom+6))}px`}}
async function openMenu(edge:'first'|'last'='first'){
 if(props.disabled||!props.active||!enabledMenu().length)return;menuOpen.value=true;await nextTick();if(!menuOpen.value)return
 menu.value?.showPopover();placeMenu();const enabled=enabledMenu();focusMenu((edge==='last'?enabled.at(-1):enabled[0])??-1)
}
function closeMenu(restore=false){menuOpen.value=false;menu.value?.hidePopover();if(restore&&props.active)plus.value?.focus({preventScroll:true})}
function toggleMenu(){if(menuOpen.value)closeMenu(true);else void openMenu()}
function triggerKey(event:KeyboardEvent){if(event.isComposing||event.keyCode===229)return;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();void openMenu(event.key==='ArrowUp'?'last':'first')}else if(event.key==='Escape'&&menuOpen.value){event.preventDefault();closeMenu(true)}}
function menuKey(event:KeyboardEvent){
 if(event.isComposing||event.keyCode===229){if(event.key==='Escape'){event.preventDefault();event.stopPropagation()}return}
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu(true);return}
 if(event.key==='Tab'){closeMenu(true);return}
 if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();focusMenu(composerMenuIndex(menuIndex.value,event.key,enabledMenu()));return}
}
function menuAction(index:number){
 const item=menuItems.value[index];if(!props.active||!item||item.disabled)return;closeMenu(true)
 if(item.source==='capture')emit('capture');else if(props.nativePickerAvailable&&(item.source==='file'||item.source==='image'))emit('nativeFiles',item.source);else if(item.source==='image'){pickerConversations.set('image',props.conversationKey);imageInput.value?.click()}else{pickerConversations.set('file',props.conversationKey);fileInput.value?.click()}
}
function outside(event:PointerEvent){const target=event.target as Node;if(menuOpen.value&&!plus.value?.contains(target)&&!menu.value?.contains(target))closeMenu()}
function reposition(){if(menuOpen.value)placeMenu()}
function showPreview(attachment:ComposerAttachment,event?:MouseEvent){if(!props.active)return;closeMenu();previewTrigger=event?.currentTarget as HTMLElement|undefined;previewKey.value=attachment.key;emit('preview',attachment.key)}
function closePreview(){previewKey.value='';void nextTick(()=>{if(!props.active)return;if(previewTrigger?.isConnected)previewTrigger.focus({preventScroll:true});else if(!props.disabled)focus();previewTrigger=undefined})}
function detach(key:string){if(props.disabled)return;if(previewKey.value===key)closePreview();emit('detach',key)}
watch(()=>props.text,()=>{if(!composing.value)inputBuffer.value=props.text;void measure()},{flush:'post'})
watch(()=>[props.attachments,props.reply,props.nativePickerBusy,props.nativePickerUnknown],()=>{failedImages.value=failedImages.value.filter(key=>props.attachments.some(item=>item.key===key));if(previewKey.value&&!previewAttachment.value)closePreview();void measure()},{deep:true,flush:'post'})
watch(()=>props.conversationKey,()=>{
 measureGeneration++
 restoreMeasurePending=true;restoreHold.value=false
 if(fieldHost.value)fieldHost.value.scrollTop=0
 // A stable frame restored to the identical height has no transition-end event.
 const settledHeight=expanded.value&&expandedSettled.value?height.value:restoredSettledFrame?.height===height.value?restoredSettledFrame.height:undefined
 restoredSettledFrame=settledHeight===undefined?undefined:{key:props.conversationKey,height:settledHeight}
 composing.value=false;inputBuffer.value=props.text;closeMenu();previewKey.value='';failedImages.value=[];autoExpanded.value=false;expanded.value=false;void measure()
},{flush:'sync'})
watch(()=>[props.disabled,props.active],()=>{if(props.disabled||!props.active){closeMenu();previewKey.value=''}if(props.active)void measure()})
onMounted(()=>{void measure();if(typeof ResizeObserver!=='undefined'){
 resize=new ResizeObserver(entries=>{let changed=false;for(const entry of entries){if(entry.target===root.value){const width=entry.contentRect.width;if(Math.abs(width-lastWidth)>.5){lastWidth=width;changed=true}}else if(entry.target===content.value){const size=entry.contentRect.height;if(Math.abs(size-lastContentHeight)>.5){lastContentHeight=size;changed=true}}else if(!intrinsicField&&entry.target===fieldHost.value){const width=entry.contentRect.width;if(Math.abs(width-lastHostWidth)>.5){lastHostWidth=width;changed=true}}else if(entry.target===textarea.value){const size=entry.contentRect.height;if(Math.abs(size-lastFieldHeight)>.5){lastFieldHeight=size;changed=true}}else if(entry.target===trailing.value){const width=entry.contentRect.width;if(Math.abs(width-lastTrailingWidth)>.5){lastTrailingWidth=width;changed=true}}}if(changed)queueLayoutMeasure()})
 for(const node of [root.value,content.value,trailing.value,textarea.value,...(!intrinsicField?[fieldHost.value]:[])])if(node)resize.observe(node)
 }document.addEventListener('pointerdown',outside,true);window.addEventListener('resize',reposition);document.addEventListener('scroll',reposition,true)})
onBeforeUnmount(()=>{stopPlaceholder();disposed=true;resize?.disconnect();closeMenu();document.removeEventListener('pointerdown',outside,true);window.removeEventListener('resize',reposition);document.removeEventListener('scroll',reposition,true)})
defineExpose({root,shell,textarea,focus,measure,startMorph})
</script>
<template>
 <form ref="root" class="chat-composer-form" :data-holds-open-height="formHoldsOpenHeight||undefined" :style="{minHeight:formHoldsOpenHeight?`${height}px`:undefined}" @submit.prevent="submit" @dragover.prevent @drop.prevent="dropFiles">
 <div ref="shell" @click="focusShell" :data-snap-height="heightSnap||undefined" @transitionend="frameTransitionEnd" class="chat-composer" :class="{'is-expanded':expanded,'is-disabled':disabled,'is-handoff':handoff,'is-morphing':morphing,'is-morph-empty':morphing&&!text&&!inputBuffer&&!composing}" :style="{height:`${motionHeight??height}px`,'--composer-trailing':`${Math.max(28,trailingWidth)}px`}">
  <div class="chat-composer-pad"><div ref="content" class="chat-composer-content">
  <div v-if="reply" ref="replyRow" class="chat-composer-reply"><div><strong>{{reply.senderName?`回复 ${reply.senderName}`:'回复消息'}}</strong><p>{{reply.text}}</p></div><button type="button" class="composer-small-button" :disabled="disabled" aria-label="取消引用" @click="emit('clearReply')"><Icon name="close" :size="14"/></button></div>
   <div v-if="nativePickerBusy||nativePickerUnknown" class="composer-native-upload" role="status"><span>{{nativePickerUnknown&&!nativePickerBusy?'上传结果待确认':'正在上传附件…'}}</span><button v-if="nativePickerUnknown&&!nativePickerBusy" type="button" class="text-button" @click="emit('resumeNative')">查询上传结果</button><button type="button" class="text-button" @click="emit('cancelNative')">取消</button></div>
  <div v-if="attachments.length" ref="attachmentRow" class="chat-composer-attachments" aria-label="待发送附件">

   <article v-for="attachment in attachments" :key="attachment.key" class="composer-attachment" :class="{'is-image':attachment.kind==='image','has-error':attachment.status==='error','is-uploading':attachment.status==='uploading'}">
    <button type="button" class="composer-attachment-preview" :aria-label="`预览附件：${attachment.name}`" @click="showPreview(attachment,$event)">
     <span v-if="attachment.kind==='image'" class="composer-image-preview"><img v-if="previewUrl(attachment)&&!failedImages.includes(attachment.key)" :src="previewUrl(attachment)" alt="" @error="failedImages.push(attachment.key)"/><Icon v-else name="image" :size="24"/></span><Icon v-else class="composer-file-icon" name="file" :size="24"/>
     <span class="composer-attachment-copy"><strong>{{attachment.name}}</strong><small>{{attachment.status==='uploading'?`正在上传${attachment.total?' '+Math.floor((attachment.loaded??0)/attachment.total*100)+'%':'…'}`:attachment.status==='unknown'?'上传结果待确认':attachment.status==='error'?'上传失败':(attachment.delivery==='controlled-url'?'本机链接 · ':'')+attachmentSize(attachment.size)}}</small></span>
    </button>
    <button type="button" class="composer-small-button composer-detach" :disabled="disabled" :aria-label="`移除附件：${attachment.name}`" @click="detach(attachment.key)"><Icon name="close" :size="12"/></button>
    <button v-if="attachment.status==='unknown'" type="button" class="composer-small-button composer-query" :disabled="disabled" aria-label="查询附件上传结果" @click="emit('retry',attachment.key)"><Icon name="refresh" :size="12"/></button>
    <span v-if="attachment.status==='error'" class="composer-attachment-error" role="status">{{attachment.error??'上传失败'}}</span>
   </article>
  </div>
  <div :dir="fieldDirection" class="chat-composer-field-direction"><div ref="fieldHost" class="chat-composer-field-host" :class="{'is-scrollable':rawTextHeight>120}"><textarea ref="textarea" v-model="textModel" class="chat-composer-textarea" :style="{height:intrinsicField?'auto':`${textHeight}px`}" :disabled="disabled" rows="1" aria-label="输入消息" placeholder="" @input="fieldInput" @keydown="textKey" @compositionstart="compositionStart" @compositionend="compositionEnd"/></div></div>
  </div></div>
  <Transition :css="false" @enter="enterPlaceholder" @leave="leavePlaceholder"><span v-if="!text&&!inputBuffer&&!composing&&!morphing" class="composer-placeholder" aria-hidden="true">消息…</span></Transition>
  <div class="chat-composer-controls"><div class="composer-leading"><button ref="plus" type="button" class="composer-plus" :disabled="disabled||!enabledMenu().length" aria-label="插入附件" aria-haspopup="menu" :aria-expanded="menuOpen" :aria-controls="menuOpen?menuId:undefined" @click="toggleMenu" @keydown="triggerKey"><Icon name="plus" :size="16"/></button></div><div ref="trailing" class="composer-trailing"><button type="submit" class="composer-send" :disabled="submitDisabled" :aria-label="sendLabel" :title="sendLabel"><Icon name="send" :size="16"/></button></div></div>
  <input ref="fileInput" hidden tabindex="-1" aria-hidden="true" type="file" multiple :disabled="disabled||!attachmentsAvailable" @change="chooseFiles($event,'file')"/><input ref="imageInput" hidden tabindex="-1" aria-hidden="true" type="file" accept="image/*" multiple :disabled="disabled||!attachmentsAvailable" @change="chooseFiles($event,'image')"/>
 </div>
 </form>
 <Teleport to="body"><div v-if="menuOpen" :id="menuId" ref="menu" popover="manual" role="menu" aria-label="插入附件" class="chat-composer-menu" :style="menuPosition" @keydown="menuKey"><button v-for="(item,index) in menuItems" :key="item.source" type="button" role="menuitem" :disabled="item.disabled" :tabindex="menuIndex===index?0:-1" @click="menuAction(index)"><Icon :name="item.icon" :size="16"/>{{item.label}}</button></div></Teleport>
 <Modal :open="Boolean(previewAttachment)" :title="previewAttachment?.name??'附件预览'" class="composer-preview-dialog" @close="closePreview"><template v-if="previewAttachment"><img v-if="previewAttachment.kind==='image'&&previewUrl(previewAttachment)&&!failedImages.includes(previewAttachment.key)" class="composer-expanded-image" :src="previewUrl(previewAttachment)" :alt="previewAttachment.name" @error="failedImages.push(previewAttachment.key)"/><pre v-else-if="previewAttachment.previewText!==undefined" class="composer-expanded-text">{{previewAttachment.previewText}}</pre><div v-else class="composer-preview-unavailable"><Icon :name="previewAttachment.kind==='image'?'image':'file'" :size="32"/><p>{{previewAttachment.kind==='image'?'图片暂时无法预览。':'此文件暂不支持预览。'}}</p></div><p class="composer-preview-metadata">{{[previewAttachment.mime,attachmentSize(previewAttachment.size)].filter(Boolean).join(' · ')}}</p><p v-if="previewAttachment.error" class="composer-preview-error" role="alert">{{previewAttachment.error}}</p></template></Modal>
</template>
<style scoped>
.composer-query{position:absolute;right:4px;bottom:4px}
.composer-native-upload{display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:12px;line-height:16px}

.chat-composer-form{display:block;width:100%;min-width:0;margin:0}
.chat-composer-form[data-holds-open-height]{display:flex;flex-direction:column;justify-content:flex-end}
.chat-composer-form[data-holds-open-height] .chat-composer{anchor-name:--sand-composer-frame}
.chat-composer{overflow:clip;position:relative;display:block;width:100%;min-width:0;min-height:44px;box-sizing:border-box;border:.5px solid var(--sand-border-secondary-translucent);border-radius:22px;background:var(--sand-bg-elevated);color:var(--sand-text-primary);cursor:text;box-shadow:0 2px 8px -1px #0000000d,0 1px 2px #00000008,0 0 0 1px #e4e4e40a;transition:height 300ms var(--spring-fast),border-radius 300ms var(--spring-fast),border-color 150ms ease,background-color 150ms ease}
.chat-composer:hover,.chat-composer:focus-within{border-color:var(--sand-border-primary-translucent)}
.chat-composer[data-snap-height]{transition-duration:0ms,300ms,150ms,150ms}
.chat-composer-pad{display:flex;flex-direction:column;justify-content:center;box-sizing:border-box;height:100%;overflow:clip;overflow-clip-margin:border-box;padding-block:0;padding-inline:44px calc(16px + var(--composer-trailing,28px));transition:padding 300ms var(--spring-fast)}
.chat-composer-content{display:flex;flex-direction:column;align-items:stretch;flex-shrink:0;gap:8px;min-width:0}
.chat-composer-field-direction{min-width:0}
.chat-composer-field-host{width:100%;min-width:0;min-height:20px;max-height:120px;scrollbar-width:thin;overflow-anchor:none}
.chat-composer-field-host.is-scrollable{overflow-y:auto}
.chat-composer-textarea{display:block;width:100%;min-width:0;min-height:20px;resize:none;field-sizing:content;max-width:100%;border:0;padding:0;margin:0;outline:none;overflow:hidden;overflow-anchor:none;white-space:pre-wrap;word-break:break-word;background:transparent;color:var(--sand-text-primary);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:420;line-height:20px;caret-color:var(--sand-text-primary)}
.chat-composer-textarea::placeholder{color:var(--sand-text-tertiary)}.chat-composer-textarea:disabled{color:var(--sand-text-secondary);opacity:1}
.chat-composer-controls{position:absolute;inset-inline:8px;bottom:0;display:flex;align-items:center;justify-content:space-between;height:44px;pointer-events:none}
.composer-leading,.composer-trailing{display:flex;align-items:center;gap:8px;pointer-events:auto}
.composer-plus,.composer-send{display:flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;min-width:28px;padding:0;border:0;border-radius:50%;cursor:pointer;transition:background-color 120ms ease-out,color 120ms ease-out}.composer-plus{color:var(--sand-icon-secondary);background:var(--sand-bg-secondary)}.composer-plus:hover:not(:disabled){background:var(--sand-bg-secondary-hover);color:var(--sand-icon-primary)}.composer-send{background:var(--sand-bg-primary);color:var(--sand-text-inverted)}.composer-send:hover:not(:disabled){background:var(--sand-bg-primary-hover)}.composer-send:disabled{background:var(--sand-bg-secondary);color:var(--sand-icon-quaternary);opacity:1}.composer-plus:disabled{color:var(--sand-icon-quaternary);opacity:1}
.chat-composer.is-handoff,.is-handoff .chat-composer-pad{transition:none!important}.chat-composer.is-expanded{border-radius:18px}.is-expanded .chat-composer-pad{justify-content:flex-start;padding-block:8px 48px;padding-inline:12px}.is-expanded .chat-composer-field-host{box-sizing:border-box;width:calc(100% + 12px);margin-inline-start:-12px;padding-inline-start:12px}.is-expanded .chat-composer-controls{bottom:8px;height:28px}
.chat-composer-reply{display:flex;align-items:flex-start;gap:8px;min-width:0;flex:none;padding:0 0 8px;border-bottom:.5px solid var(--sand-border-primary-translucent)}.chat-composer-reply>div{flex:1;min-width:0}.chat-composer-reply strong{font-size:12px;line-height:16px;font-weight:500;color:var(--sand-text-secondary)}.chat-composer-reply p{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;margin:4px 0 0;font-size:13px;line-height:18px;color:var(--sand-text-secondary)}
.chat-composer-attachments{display:flex;align-items:flex-start;gap:8px;overflow:auto;min-width:0;flex:none;padding:0 0 4px;scrollbar-width:thin;overscroll-behavior:contain}.composer-attachment{position:relative;flex:none;width:176px;min-width:0;border-radius:10px;background:var(--sand-bg-secondary)}.composer-attachment-preview{display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:72px;padding:8px 24px 8px 8px;text-align:left;border-radius:10px}.composer-attachment-preview:hover{background:var(--sand-bg-secondary-hover)}.composer-file-icon{flex:none;color:var(--sand-icon-secondary)}.composer-attachment-copy{min-width:0;flex:1}.composer-attachment-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;font-weight:500}.composer-attachment-copy small{display:block;margin-top:4px;font-size:11px;line-height:16px;color:var(--sand-text-secondary)}.composer-attachment.is-image{width:88px}.is-image .composer-attachment-preview{display:block;height:88px;padding:0;overflow:hidden}.composer-image-preview{display:flex;align-items:center;justify-content:center;width:88px;height:62px;background:var(--sand-bg-secondary);color:var(--sand-icon-secondary)}.composer-image-preview img{width:100%;height:100%;object-fit:cover}.is-image .composer-attachment-copy{display:block;padding:4px 4px}.is-image .composer-attachment-copy strong{font-size:11px;line-height:16px;font-weight:420}.is-image .composer-attachment-copy small{display:none}.is-image:is(.is-uploading,.has-error) .composer-attachment-copy small{display:block;position:absolute;top:2px;left:4px;max-width:54px;margin:0;padding:4px 4px;border-radius:4px;background:var(--sand-bg-elevated);color:var(--sand-text-secondary);font-size:11px;line-height:16px}.composer-small-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;min-width:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--sand-icon-secondary)}.composer-small-button:hover:not(:disabled){background:var(--sand-bg-secondary-hover)}.composer-detach{position:absolute;top:4px;right:4px;border-radius:50%;background:var(--sand-bg-elevated);color:var(--sand-icon-primary)}.composer-attachment-error{display:block;max-width:176px;padding:0 4px 4px;overflow-wrap:anywhere;font-size:11px;line-height:16px;color:var(--danger)}.composer-small-button:disabled{color:var(--sand-icon-quaternary);opacity:1}
.chat-composer-menu{position:fixed;inset:auto;margin:0;z-index:1200;width:min(188px,calc(100vw - 16px));max-height:calc(100dvh - 16px);overflow:auto;padding:4px;border:0;border-radius:12px;background:var(--sand-bg-elevated);color:var(--sand-text-primary);box-shadow:0 6px 20px -5px var(--sand-shadow-inline-ambient,#0005),0 2px 5px -2px var(--sand-shadow-inline-key,#0003),inset 0 0 0 .5px var(--sand-border-primary-translucent)}.chat-composer-menu::backdrop{background:transparent}.chat-composer-menu button{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:4px 8px;border-radius:6px;text-align:left;font-size:13px;line-height:18px}.chat-composer-menu button:hover:not(:disabled){background:var(--sand-bg-hover)}.chat-composer-menu button:disabled{color:var(--sand-text-quaternary);opacity:1}.chat-composer :is(button):focus-visible,.chat-composer-menu button:focus-visible{outline:2px solid var(--sand-border-focus-primary);outline-offset:1px}.chat-composer-textarea:focus-visible{outline:none}.keyboard .chat-composer:has(.chat-composer-textarea:focus-visible){outline:2px solid var(--sand-border-focus-primary);outline-offset:2px}
.composer-expanded-image{display:block;width:100%;max-height:65vh;object-fit:contain;border-radius:6px}.composer-expanded-text{max-height:60vh;overflow:auto;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:20px;color:var(--sand-text-primary)}.composer-preview-metadata{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--sand-text-secondary)}.composer-preview-unavailable{text-align:center;padding:32px 16px;color:var(--sand-text-secondary)}.composer-preview-unavailable svg{margin-inline:auto}.composer-preview-unavailable p{margin:12px 0 0;font-size:13px;line-height:20px}.composer-preview-error{font-size:13px;line-height:18px;color:var(--danger)}
@media(prefers-reduced-motion:reduce){.chat-composer{transition-duration:120ms,120ms,150ms,150ms;transition-timing-function:ease,ease,ease,ease}.chat-composer[data-snap-height]{transition-duration:0ms,120ms,150ms,150ms}.chat-composer-pad{transition-duration:120ms;transition-timing-function:ease}.composer-plus,.composer-send{transition:none}}
.chat-composer.is-morphing,.chat-composer.is-morphing .chat-composer-pad{transition:none!important}
.chat-composer.is-morph-empty textarea{caret-color:transparent}
.composer-placeholder{position:absolute;left:44px;bottom:12px;height:20px;line-height:20px;font-size:14px;font-weight:420;color:var(--sand-text-tertiary);pointer-events:none;white-space:nowrap}
</style>
