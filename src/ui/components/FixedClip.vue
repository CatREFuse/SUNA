<script setup lang="ts">
import {ref,watch,onMounted,onBeforeUnmount} from 'vue'
const props=withDefaults(defineProps<{open:boolean;width:number;height:number;axis?:'x'|'y';collapsedSize?:number}>(),{axis:'x',collapsedSize:0})
const frame=ref<HTMLElement>(),presented=ref(props.open),reduced=ref(false),moving=ref(false)
let motion:MediaQueryList|undefined,timer:ReturnType<typeof setTimeout>|undefined
function settle(){clearTimeout(timer);moving.value=false;if(!props.open)presented.value=false}
function change(){clearTimeout(timer);if(props.open)presented.value=true;moving.value=!reduced.value;if(reduced.value)settle();else timer=setTimeout(settle,240)}
function finish(event:TransitionEvent){if(event.target===frame.value&&event.propertyName===(props.axis==='x'?'width':'height'))settle()}
function preference(){reduced.value=motion?.matches===true;if(reduced.value)settle()}
watch(()=>props.open,change,{flush:'sync'})
// Resizing is direct manipulation: never ease a new geometry towards the pointer.
watch(()=>[props.width,props.height],settle,{flush:'sync'})
onMounted(()=>{motion=matchMedia('(prefers-reduced-motion: reduce)');preference();motion.addEventListener('change',preference)})
onBeforeUnmount(()=>{clearTimeout(timer);motion?.removeEventListener('change',preference)})
</script>
<template><div ref="frame" class="fixed-clip" :class="{'clip-closed':!open,'clip-reduced':reduced,'clip-moving':moving}" :data-axis="axis" :style="{width:`${axis==='x'&&!open?collapsedSize:width}px`,height:`${axis==='y'&&!open?collapsedSize:height}px`}" @transitionend="finish"><div class="fixed-clip-plane" :style="{width:`${width}px`,height:`${height}px`}"><slot :presented="presented"/></div></div></template>
<style scoped>
.fixed-clip{position:relative;flex:none;min-width:0;min-height:0;overflow:hidden;transition:none}.clip-moving{transition:width 200ms cubic-bezier(.22,1,.36,1),height 200ms cubic-bezier(.22,1,.36,1)}.fixed-clip-plane{position:absolute;left:0;top:0;min-width:0;min-height:0;overflow:hidden}.clip-reduced{transition:none}@media(prefers-reduced-motion:reduce){.fixed-clip{transition:none}}
</style>
