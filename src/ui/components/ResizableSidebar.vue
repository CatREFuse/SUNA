<script setup lang="ts">
import {ref,watch,useId} from 'vue'
const props=withDefaults(defineProps<{name:string;storageKey:string;width?:number;min?:number;max?:number;side?:'left'|'right';contentWidth?:number;contentHeight?:number}>(),{width:280,min:130,max:420,side:'left'})
const emit=defineEmits<{resize:[number]}>()
const id=useId(),size=ref(props.width),collapsed=ref(false),dragging=ref(false)
try{const saved=JSON.parse(localStorage.getItem(`sandbook.sidebar.${props.storageKey}`)||'null');if(saved){if(Number.isFinite(saved.width))size.value=Math.max(props.min,Math.min(props.max,saved.width));collapsed.value=false}}catch{}
watch([size,collapsed],()=>{try{localStorage.setItem(`sandbook.sidebar.${props.storageKey}`,JSON.stringify({width:size.value,collapsed:collapsed.value}))}catch{}})
watch(size,value=>emit('resize',value),{immediate:true})
let startX=0,startWidth=0
function start(event:PointerEvent){if(event.button!==0)return;startX=event.clientX;startWidth=props.contentWidth??size.value;dragging.value=true;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);event.preventDefault()}
function move(event:PointerEvent){if(!dragging.value)return;size.value=Math.max(props.min,Math.min(props.max,startWidth+(event.clientX-startX)*(props.side==='right'?-1:1)))}
function stop(){dragging.value=false}
function key(event:KeyboardEvent){const direction=props.side==='right'?-1:1;if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();size.value=Math.max(props.min,Math.min(props.max,(props.contentWidth??size.value)+(event.key==='ArrowRight'?16:-16)*direction))}else if(event.key==='Home'){event.preventDefault();size.value=props.min}else if(event.key==='End'){event.preventDefault();size.value=props.max}}
</script>
<template><div class="resizable-sidebar" :class="[side,{'is-collapsed':collapsed,'is-resizing':dragging}]" :style="{'--sidebar-size':`${size}px`,width:collapsed?'32px':`${contentWidth??size}px`,height:contentHeight===undefined?undefined:`${contentHeight}px`,flexBasis:collapsed?'32px':`${contentWidth??size}px`}"><div v-show="!collapsed" :id="id" class="sidebar-body"><slot/></div><div v-show="!collapsed" class="sidebar-resize-handle" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="`调整${name}宽度`" :aria-valuemin="min" :aria-valuemax="max" :aria-valuenow="Math.round(size)" @pointerdown="start" @pointermove="move" @pointerup="stop" @pointercancel="stop" @lostpointercapture="stop" @keydown="key" @dblclick="size=width"/></div></template>
<style scoped>
.resizable-sidebar{position:relative;flex-shrink:0;min-width:0;min-height:0;max-width:45%;display:flex;background:var(--sand-bg-sidebar);transition:none!important}.sidebar-body{display:flex;flex:1;min-width:0;min-height:0;overflow:hidden}.sidebar-body :deep(>aside){width:100%;height:100%;flex:1;min-width:0}.sidebar-resize-handle{position:absolute;right:-4px;top:0;bottom:0;width:8px;z-index:20;cursor:col-resize;touch-action:none;outline:none}.right>.sidebar-resize-handle{left:-4px;right:auto}.sidebar-resize-handle:hover,.sidebar-resize-handle:focus-visible,.is-resizing>.sidebar-resize-handle{background:var(--sand-bg-hover)}.sidebar-fold{position:absolute;right:4px;top:18px;z-index:21;width:28px;height:28px;background:transparent;border-radius:6px}.sidebar-fold :deep(button){width:28px;height:28px;min-width:28px;min-height:28px}.right>.sidebar-fold{right:4px;left:auto}.is-collapsed{max-width:none}.is-collapsed>.sidebar-fold{top:8px;bottom:auto}.is-resizing{user-select:none}
@media(max-width:700px){.resizable-sidebar{max-width:100%}.sidebar-resize-handle{display:none}}
</style>
