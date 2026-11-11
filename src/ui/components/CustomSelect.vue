<script setup lang="ts" generic="T extends string | number | boolean">
import {computed,nextTick,onBeforeUnmount,onMounted,ref,useId,watch} from 'vue'
import Icon from './Icon.vue'

defineOptions({inheritAttrs:false})
const props=withDefaults(defineProps<{modelValue?:T;options:ReadonlyArray<{value:T;label:string;disabled?:boolean;icon?:string}>;icon?:string;disabled?:boolean;placeholder?:string}>(),{placeholder:'请选择'})
const emit=defineEmits<{'update:modelValue':[T];change:[T]}>()
const button=ref<HTMLButtonElement>(),menu=ref<HTMLDivElement>(),opened=ref(false),active=ref(-1),position=ref<Record<string,string>>({})
const id=`select-${useId()}`,label=computed(()=>props.options.find(option=>Object.is(option.value,props.modelValue))?.label??props.placeholder)
const selectedIcon=computed(()=>props.options.find(option=>Object.is(option.value,props.modelValue))?.icon??props.icon)
let typed='',typedAt=0
function enabled(){return props.options.map((option,index)=>option.disabled?-1:index).filter(index=>index>=0)}
function place(){
  if(!button.value||!menu.value)return
  const anchor=button.value.getBoundingClientRect(),gap=8,padding=8,width=Math.min(Math.max(anchor.width,160),window.innerWidth-padding*2)
  const below=window.innerHeight-anchor.bottom-gap-padding,above=anchor.top-gap-padding,up=below<180&&above>below
  position.value={left:`${Math.max(padding,Math.min(anchor.left,window.innerWidth-width-padding))}px`,width:`${width}px`,maxHeight:`${Math.max(44,Math.min(280,up?above:below))}px`,...(up?{bottom:`${window.innerHeight-anchor.top+gap}px`,top:'auto'}:{top:`${anchor.bottom+gap}px`,bottom:'auto'})}
}
async function highlight(index:number){active.value=index;await nextTick();menu.value?.querySelector<HTMLElement>(`[data-option-index="${index}"]`)?.scrollIntoView({block:'nearest'})}
async function open(edge?:'first'|'last'){
  if(props.disabled||opened.value)return
  opened.value=true
  const choices=enabled(),selected=props.options.findIndex(option=>!option.disabled&&Object.is(option.value,props.modelValue))
  active.value=edge==='last'?choices.at(-1)??-1:edge==='first'?choices[0]??-1:selected>=0?selected:choices[0]??-1
  await nextTick();if(!opened.value)return
  place();menu.value?.showPopover();void highlight(active.value)
}
function close(restore=false){opened.value=false;typed='';menu.value?.hidePopover();if(restore)button.value?.focus()}
function choose(index:number){const option=props.options[index];if(props.disabled||!option||option.disabled)return;emit('update:modelValue',option.value);emit('change',option.value);close(true)}
function move(step:number){const choices=enabled();if(!choices.length)return;const current=choices.indexOf(active.value);void highlight(choices[Math.max(0,Math.min(choices.length-1,current+step))])}
function keydown(event:KeyboardEvent){
  if(event.isComposing||event.keyCode===229){if(event.key==='Escape'){event.preventDefault();event.stopPropagation()}return}
  if(props.disabled)return
  if(event.key==='Tab'){close();return}
  if(event.key==='Escape'&&opened.value){event.preventDefault();event.stopPropagation();close(true);return}
  if(['ArrowDown','ArrowUp','Home','End','Enter',' '].includes(event.key)){
    event.preventDefault();event.stopPropagation()
    if(event.key==='Home'||event.key==='End'){if(!opened.value)void open(event.key==='Home'?'first':'last');else{const choices=enabled();void highlight((event.key==='Home'?choices[0]:choices.at(-1))??-1)}return}
    if(!opened.value){void open(event.key==='ArrowUp'?'last':undefined);return}
    if(event.key==='ArrowDown'||event.key==='ArrowUp')move(event.key==='ArrowDown'?1:-1);else choose(active.value)
    return
  }
  if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
    event.preventDefault();const now=Date.now();typed=now-typedAt>700?'':typed;typed+=event.key.toLocaleLowerCase();typedAt=now
    const query=[...typed].every(value=>value===typed[0])?typed[0]:typed,choices=enabled(),start=choices.indexOf(active.value)
    const ordered=[...choices.slice(start+1),...choices.slice(0,start+1)],match=ordered.find(index=>props.options[index].label.toLocaleLowerCase().startsWith(query))
    if(!opened.value)void open();if(match!==undefined)void highlight(match)
  }
}
function pointer(event:PointerEvent){const target=event.target as Node;if(opened.value&&!button.value?.contains(target)&&!menu.value?.contains(target))close()}
function reposition(event?:Event){if(opened.value&&!(event?.target instanceof Node&&menu.value?.contains(event.target)))place()}
watch(()=>props.disabled,disabled=>{if(disabled)close()})
watch(()=>props.options,()=>{if(opened.value&&!props.options[active.value])void highlight(enabled()[0]??-1)})
onMounted(()=>{document.addEventListener('pointerdown',pointer,true);window.addEventListener('resize',reposition);document.addEventListener('scroll',reposition,true)})
onBeforeUnmount(()=>{close();document.removeEventListener('pointerdown',pointer,true);window.removeEventListener('resize',reposition);document.removeEventListener('scroll',reposition,true)})
</script>

<template>
  <span class="custom-select" :class="{'is-disabled':disabled}">
    <button ref="button" v-bind="$attrs" type="button" class="select-trigger" role="combobox" aria-haspopup="listbox" :aria-expanded="opened" :aria-controls="id" :aria-activedescendant="opened&&active>=0?`${id}-${active}`:undefined" :disabled="disabled" @click="opened?close():open()" @keydown="keydown"><Icon v-if="selectedIcon" :name="selectedIcon" :size="16"/><span class="select-label">{{label}}</span><Icon name="down" :size="16"/></button>
    <div :id="id" ref="menu" class="select-menu" role="listbox" popover="manual" :aria-label="String($attrs['aria-label']??'选项')" :style="position" @keydown="keydown">
      <div v-for="(option,index) in options" :id="`${id}-${index}`" :key="index" role="option" :aria-selected="Object.is(option.value,modelValue)" :aria-disabled="option.disabled||undefined" :data-option-index="index" :class="['select-option',{active:index===active,disabled:option.disabled}]" @pointermove="!option.disabled&&(active=index)" @pointerdown.prevent @click.stop="choose(index)"><Icon v-if="option.icon||icon" :name="option.icon||icon!" :size="16"/><span class="select-label">{{option.label}}</span><Icon v-if="Object.is(option.value,modelValue)" name="check" :size="16"/></div>
      <div v-if="!options.length" class="select-empty">无可选项</div>
    </div>
  </span>
</template>

<style scoped>
.custom-select{display:block;min-width:0;width:100%;color:var(--sand-text-primary);font-size:13px;line-height:18px;font-weight:420}.select-trigger{appearance:none;display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:28px;min-height:28px;padding:4px 8px;border:1px solid transparent;border-radius:10px;background:var(--sand-bg-secondary);color:inherit;text-align:left;box-shadow:none;font:inherit;cursor:pointer}.select-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.select-trigger:not(:disabled):hover,.select-trigger[aria-expanded=true]{background:var(--sand-bg-secondary-hover)}.select-trigger:focus{outline:none}.select-trigger:focus-visible{outline:2px solid var(--sand-border-focus-primary);outline-offset:1px}.select-trigger:disabled{cursor:not-allowed;opacity:.5}.select-menu{position:fixed;inset:auto;margin:0;padding:4px;border:.5px solid var(--sand-border-secondary-translucent);border-radius:12px;overflow-y:auto;overscroll-behavior:contain;box-shadow:0 10px 20px -3px var(--sand-shadow-popover-ambient,#0002),0 4px 6px -4px var(--sand-shadow-popover-key,#0002);background:var(--sand-bg-elevated);color:var(--sand-text-primary);font:inherit;font-size:13px;line-height:18px;z-index:1000;outline:none}.select-menu::backdrop{background:transparent;pointer-events:none}.select-option{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:4px 8px;min-height:30px;border-radius:6px;cursor:pointer;word-break:break-word}.select-option .select-label{white-space:normal;overflow:visible;overflow-wrap:anywhere}.select-option.active{background:var(--sand-bg-hover)}.select-option[aria-selected=true]{font-weight:420}.select-option.disabled{color:var(--sand-text-quaternary);cursor:default}.select-empty{padding:4px 8px;color:var(--sand-text-secondary);font-size:12px;line-height:16px}
</style>
