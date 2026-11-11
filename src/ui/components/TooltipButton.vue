<script setup lang="ts">
import {ref,shallowRef,useId,watch,onBeforeUnmount,nextTick} from 'vue'
import Icon from './Icon.vue'
defineOptions({inheritAttrs:false})
withDefaults(defineProps<{label:string;icon?:string;tooltip?:string;size?:number;stateful?:boolean}>(),{size:20})
const button=ref<HTMLButtonElement>(),visible=ref(false),position=ref({left:'0px',top:'0px'}),id=useId()
const hovered=ref(false),focused=ref(false),tip=ref<HTMLElement>(),teleportTarget=shallowRef<Element|string>('body')
let openTimer:ReturnType<typeof setTimeout>|undefined,closeTimer:ReturnType<typeof setTimeout>|undefined
function clearDelays(){clearTimeout(openTimer);clearTimeout(closeTimer)}
function dismissNow(){clearDelays();visible.value=false}
let observer:MutationObserver|undefined
function available(){const node=button.value;return !!node?.isConnected&&!document.hidden&&!node.closest('[inert],[hidden],[aria-hidden="true"]')&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden'}
function place(){const box=button.value?.getBoundingClientRect();if(!box)return;const width=tip.value?.offsetWidth??148,height=tip.value?.offsetHeight??24;const above=box.top-height-8;position.value={left:`${Math.max(8,Math.min(window.innerWidth-width-8,box.left+(box.width-width)/2))}px`,top:`${Math.max(8,Math.min(window.innerHeight-height-8,above>=8?above:box.bottom+8))}px`}}
function check(){if(!available()){dismissNow();hovered.value=false;focused.value=false}else place()}
function show(){clearDelays();if(!available())return;if(visible.value){place();return}openTimer=setTimeout(()=>{if(!available()||(!hovered.value&&!focused.value))return;teleportTarget.value=button.value?.closest('dialog[open]')??'body';place();visible.value=true;void nextTick(()=>{if(!visible.value||!available())return;tip.value?.showPopover();place()})},300)}
function scheduleClose(){clearTimeout(openTimer);clearTimeout(closeTimer);closeTimer=setTimeout(()=>{if(!hovered.value&&!focused.value)visible.value=false},100)}
function stopObserving(){observer?.disconnect();observer=undefined;window.removeEventListener('resize',check);window.removeEventListener('scroll',check,true);document.removeEventListener('visibilitychange',check)}
// Teleport is outside a v-show/inert ancestor; blur alone does not cover those changes.
watch(visible,open=>{stopObserving();if(!open)return;observer=new MutationObserver(check);for(let node:HTMLElement|null=button.value??null;node;node=node.parentElement)observer.observe(node,{attributes:true,attributeFilter:['style','class','hidden','inert','aria-hidden']});window.addEventListener('resize',check);window.addEventListener('scroll',check,true);document.addEventListener('visibilitychange',check)},{flush:'sync'})
function leave(){hovered.value=false;if(!focused.value)scheduleClose()}
function blur(){focused.value=false;if(!hovered.value)scheduleClose()}
function dismiss(event:KeyboardEvent){if(event.key==='Escape')dismissNow()}
defineExpose({focus:()=>button.value?.focus()})
onBeforeUnmount(()=>{clearDelays();stopObserving();visible.value=false})
</script>
<template><button ref="button" type="button" class="icon-button" :class="{'text-tooltip-button':!icon}" v-bind="$attrs" :aria-label="label" :aria-describedby="visible?id:undefined" @mouseenter="hovered=true;show()" @mouseleave="leave" @focus="focused=true;show()" @blur="blur" @keydown="dismiss" @click="dismissNow"><Icon v-if="icon" :name="icon" :size="size" :stateful="stateful"/><slot/></button><Teleport :to="teleportTarget"><span v-if="visible" popover="manual" ref="tip" :id="id" role="tooltip" class="control-tooltip" :style="position">{{tooltip??label}}</span></Teleport></template>
<style scoped>
.icon-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;min-width:28px;min-height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--sand-icon-secondary);transition:background-color 120ms ease-out,color 120ms ease-out}.icon-button:not(:disabled):hover{background:var(--sand-bg-secondary);color:var(--sand-icon-primary)}.icon-button:not(:disabled):active{background:var(--sand-bg-secondary-hover)}.icon-button:is(.selected,[aria-pressed=true],[aria-selected=true]){background:var(--sand-bg-secondary-hover)}.icon-button:focus-visible{outline:2px solid var(--sand-border-focus-primary);outline-offset:1px}.icon-button:disabled{color:var(--sand-icon-quaternary);opacity:1;cursor:default}.text-tooltip-button{width:auto;min-width:0;flex-shrink:0;padding-inline:4px}.control-tooltip{position:fixed;inset:auto;margin:0;z-index:2000;max-width:220px;padding:4px 4px;border:.5px solid var(--sand-border-secondary-translucent);border-radius:6px;background:var(--sand-bg-elevated);color:var(--sand-text-primary);font-size:12px;line-height:16px;font-weight:420;pointer-events:none;overflow-wrap:anywhere;box-shadow:0 4px 12px -1px var(--sand-shadow-inline-ambient,#0002),0 2px 4px -2px var(--sand-shadow-inline-key,#0002)}.control-tooltip::backdrop{background:transparent;pointer-events:none}@media(prefers-reduced-motion:reduce){.icon-button{transition:none}}
</style>
