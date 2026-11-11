<script setup lang="ts">
import {ref,watch,nextTick,onMounted,onBeforeUnmount} from 'vue'
import Icon from './Icon.vue'
import {createSidebarTransition} from '../sidebar-navigation.mjs'
type Route='conversations'|'channels'
const props=defineProps<{route:Route}>()
const emit=defineEmits<{back:[]}>()
const element=ref<HTMLElement>(),conversations=ref<HTMLElement>(),channels=ref<HTMLElement>(),back=ref<HTMLButtonElement>()
const visible=ref<Route[]>([props.route])
let sourceFocus:Element|null=null,media:MediaQueryList|undefined
const panes=()=>({conversations:conversations.value,channels:channels.value})
function focusActive(){
 const node=props.route==='channels'?back.value:conversations.value?.querySelector<HTMLElement>('[data-channel-entry]')
 node?.focus({preventScroll:true})
}
const transition=createSidebarTransition({initialRoute:props.route,getPanes:panes,onVisible:(value:Route[])=>{visible.value=value},afterRender:nextTick,reduced:()=>media?.matches??false,onSettled:()=>{
 // Do not steal focus if the user has already moved to a search field or composer.
 const focused=document.activeElement
 if(sourceFocus&&(focused===sourceFocus||focused===document.body||element.value?.querySelector('[inert]')?.contains(focused)))focusActive()
 sourceFocus=null
}})
watch(()=>props.route,()=>{const focused=document.activeElement;sourceFocus=element.value?.contains(focused)?focused:focused===document.body?sourceFocus:null;void transition.go(props.route)})
function motionChanged(){if(media?.matches)transition.finishNow()}
onMounted(()=>{media=matchMedia('(prefers-reduced-motion:reduce)');media.addEventListener('change',motionChanged)})
onBeforeUnmount(()=>{transition.close();media?.removeEventListener('change',motionChanged)})
defineExpose({element,focusActive})
</script>
<template>
 <div ref="element" class="conversation-sidebar-router" :data-sidebar-route="route">
  <section ref="conversations" class="sidebar-route-pane" data-sidebar-page="conversations" :hidden="!visible.includes('conversations')" :inert="route!=='conversations'" :aria-hidden="route!=='conversations'" aria-label="对话列表"><slot/></section>
  <section ref="channels" class="sidebar-route-pane" data-sidebar-page="channels" :hidden="!visible.includes('channels')" :inert="route!=='channels'" :aria-hidden="route!=='channels'" aria-label="频道列表">
   <header class="sidebar-route-toolbar"><button ref="back" type="button" class="text-button" data-channel-back @click="emit('back')"><Icon name="back" :size="16"/><span>频道</span></button><slot name="channel-actions"/></header>
   <slot name="channels"/>
  </section>
 </div>
</template>
<style scoped>
.conversation-sidebar-router{position:relative;display:flex;flex:1;min-width:0;min-height:0;overflow:hidden;background:var(--sand-bg-sidebar)}
.sidebar-route-pane{position:absolute;inset:0;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:var(--sand-bg-sidebar)}
.sidebar-route-pane :deep(.conversation-list){overflow:hidden;flex:1;min-height:0}
.sidebar-route-pane :deep(.conversation-rows){overflow:auto;flex:1;min-height:0}
.sidebar-route-pane[hidden]{display:none}.sidebar-route-pane[inert]{pointer-events:none}
.sidebar-route-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;min-height:44px;padding:4px 12px 8px}
.sidebar-route-toolbar>.text-button{display:inline-flex;align-items:center;gap:8px;min-width:0;min-height:30px;padding:4px 8px;font-size:14px;line-height:20px;font-weight:500;border-radius:6px}
.sidebar-route-toolbar>.text-button:hover{background:var(--sand-bg-hover)}
.sidebar-route-toolbar>.text-button:focus-visible{outline:2px solid var(--sand-border-focus-primary);outline-offset:-2px}
</style>
