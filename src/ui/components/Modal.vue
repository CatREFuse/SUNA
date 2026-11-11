<script setup lang="ts">
import {ref,watch,nextTick} from 'vue'
import Icon from './Icon.vue'
const props=defineProps<{open:boolean;title:string}>(),emit=defineEmits<{close:[]}>(),dialog=ref<HTMLDialogElement>()
let previous:HTMLElement|null=null
watch(()=>props.open,async open=>{await nextTick();if(open){previous=document.activeElement as HTMLElement;dialog.value?.showModal()}else{dialog.value?.close();previous?.focus()}},{immediate:true})
function composingKey(event:KeyboardEvent){if(event.key==='Escape'&&(event.isComposing||event.keyCode===229)){event.preventDefault();event.stopPropagation()}}
function click(e:MouseEvent){if(e.target===dialog.value){const r=dialog.value.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)emit('close')}}
</script>
<template><dialog ref="dialog" class="modal" :aria-label="title" @keydown.capture="composingKey" @cancel.prevent="emit('close')" @click="click"><header class="modal-heading"><h2>{{title}}</h2><button class="icon-button close-button" aria-label="关闭" @click="emit('close')"><Icon name="close"/></button></header><div class="modal-content"><slot/></div></dialog></template>

<style scoped src="../form-controls.css"></style>
