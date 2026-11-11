<script setup lang="ts">
import type {Snapshot,PluginConfigField,PluginConfigValue} from '../types'
import {channelConversationName} from '../../core/channel-display.mjs'
import CustomSelect from './CustomSelect.vue'
import ToggleSwitch from './ToggleSwitch.vue'
const props=defineProps<{schema:Record<string,PluginConfigField>;modelValue:Record<string,PluginConfigValue>;state:Snapshot;hasSecrets?:string[]}>()
const emit=defineEmits<{'update:modelValue':[Record<string,PluginConfigValue>]}>()
function set(key:string,value:PluginConfigValue){emit('update:modelValue',{...props.modelValue,[key]:value})}
function options(key:string,field:PluginConfigField){
  let result:Array<{value:PluginConfigValue;label:string;disabled?:boolean}>=[]
  if(field.type==='character')result=props.state.characters.map(c=>({value:c.id,label:c.name}))
  else if(['conversation','channel-conversation'].includes(field.type))result=props.state.conversations.filter(c=>field.type!=='channel-conversation'||c.channel!=='desktop').map(c=>({value:c.id,label:channelConversationName(c)||'对话'}))
  else result=(field.options??[]).map(option=>typeof option==='object'?option:{value:option,label:String(option)})
  if(!field.required&&!result.some(option=>option.value===''))result.unshift({value:'',label:'未选择'})
  const value=props.modelValue[key];if(value!==undefined&&value!==''&&!result.some(option=>Object.is(option.value,value)))result.unshift({value,label:['conversation','channel-conversation'].includes(field.type)?'会话不可用（当前值不可选）':`${value}（当前值不可选）`,disabled:true})
  return result
}
</script>
<template><div class="plugin-fields"><label v-for="(field,key) in schema" :key="key" class="field" :class="{'plugin-boolean':field.type==='boolean','plugin-wide':field.type==='textarea'}"><span>{{field.label??key}}{{field.required?' *':''}}</span>
<ToggleSwitch v-if="field.type==='boolean'" :model-value="modelValue[key]===true" :aria-label="field.label??key" @update:model-value="set(key,$event)"/>
<CustomSelect v-else-if="['select','character','conversation','channel-conversation'].includes(field.type)" :model-value="modelValue[key]" :aria-label="field.label??key" :options="options(key,field)" @update:model-value="set(key,$event)"/>
<textarea v-else-if="field.type==='textarea'" :value="String(modelValue[key]??'')" rows="4" :required="field.required" @input="set(key,($event.target as HTMLTextAreaElement).value)"/>
<input v-else :value="modelValue[key]" :type="field.type==='secret'?'password':field.type==='number'?'number':'text'" :step="field.type==='number'?'any':undefined" :required="field.required&&!(field.type==='secret'&&hasSecrets?.includes(key))" :autocomplete="field.type==='secret'?'new-password':'off'" :placeholder="field.type==='secret'&&hasSecrets?.includes(key)?'留空保留已保存的值':undefined" @input="set(key,($event.target as HTMLInputElement).value)"/>
</label></div></template>
<style scoped>
.plugin-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px;align-items:end}.field{margin:0;min-width:0;font-size:13px;font-weight:420}.field input,.field textarea{font-size:13px;font-weight:420;min-height:40px}.plugin-wide{grid-column:1/-1}.plugin-boolean{flex-direction:row;align-items:center;justify-content:space-between;min-height:40px}@media(max-width:760px){.plugin-fields{grid-template-columns:1fr}}
</style>
<style scoped src="../form-controls.css"></style>
