<script setup lang="ts">
import {ref,computed,watch,nextTick} from 'vue'
import CustomSelect from './CustomSelect.vue'
import CheckboxControl from './CheckboxControl.vue'
import ToggleSwitch from './ToggleSwitch.vue'
import Icon from './Icon.vue'
import {parseWorkerContent,serializeWorkerContent,withDeveloperMessages,insertPromptVariable} from '../prompt-editor.mjs'
type ChatMessage={role:'system'|'developer'|'user'|'assistant';content:string;[key:string]:unknown}
type WorkerConfig={messages:ChatMessage[];response_format?:{type:string;json_schema?:{name?:string;strict?:boolean;schema?:unknown;[key:string]:unknown};[key:string]:unknown};[key:string]:unknown}
const props=defineProps<{modelValue:string;xml?:boolean;guidanceOnly?:boolean}>(),emit=defineEmits<{'update:modelValue':[string];'update:xml':[boolean]}>()
const config=ref<WorkerConfig>(),error=ref(''),raw=ref(false),schemaText=ref('{}'),cachedDeveloper=ref<ChatMessage[]>([]),activeIndex=ref(0),rawEditor=ref<HTMLTextAreaElement>(),cachedSchema=ref<NonNullable<WorkerConfig['response_format']>['json_schema']>()
let lastEmitted:string|undefined,activeEditor:HTMLTextAreaElement|undefined
function load(value:string){const parsed=parseWorkerContent(value);error.value=parsed.error;if(parsed.config){config.value=parsed.config;schemaText.value=JSON.stringify(parsed.config.response_format?.json_schema?.schema??{},null,2);cachedSchema.value=parsed.config.response_format?.json_schema;cachedDeveloper.value=parsed.config.messages.filter((m:ChatMessage)=>m.role==='developer')}else{config.value=undefined;raw.value=true}}
watch(()=>props.modelValue,value=>{if(value!==lastEmitted)load(value)},{immediate:true})
const developer=computed(()=>Boolean(config.value?.messages.some(message=>message.role==='developer')))
const format=computed(()=>config.value?.response_format?.type??'text')
function commit(){if(!config.value)return;const value=serializeWorkerContent(config.value,schemaText.value);error.value=parseWorkerContent(value).error;lastEmitted=value;emit('update:modelValue',value)}
function toggleDeveloper(){if(!config.value)return;const next=withDeveloperMessages(config.value.messages,!developer.value,cachedDeveloper.value);config.value.messages=next.messages;cachedDeveloper.value=next.cached;commit()}
function changeFormat(type:string){if(!config.value)return;if(config.value.response_format?.json_schema)cachedSchema.value=config.value.response_format.json_schema;config.value.response_format={...config.value.response_format,type};if(type==='json_schema')config.value.response_format.json_schema=cachedSchema.value??{name:'worker_result',schema:{}};else delete config.value.response_format.json_schema;commit()}
function setSchemaName(value:string){if(!config.value?.response_format)return;config.value.response_format.json_schema={...config.value.response_format.json_schema,name:value};commit()}
function setStrict(value:boolean){if(!config.value?.response_format)return;config.value.response_format.json_schema={...config.value.response_format.json_schema,strict:value};commit()}
function changeMessage(index:number,value:string){if(!config.value)return;config.value.messages[index].content=value;commit()}
function addMessage(){config.value?.messages.push({role:props.guidanceOnly?'system':'user',content:''});commit()}
function removeMessage(index:number){config.value?.messages.splice(index,1);commit()}
function moveMessage(index:number,offset:number){if(!config.value)return;const messages=config.value.messages;if(index+offset<0||index+offset>=messages.length)return;const [message]=messages.splice(index,1);messages.splice(index+offset,0,message);commit()}
function rawInput(event:Event){const value=(event.target as HTMLTextAreaElement).value;lastEmitted=value;error.value=parseWorkerContent(value).error;emit('update:modelValue',value)}
function changeMode(){if(raw.value){const parsed=parseWorkerContent(props.modelValue);if(!parsed.config){error.value=parsed.error;return}load(props.modelValue)}raw.value=!raw.value}
function focusMessage(index:number,event:FocusEvent){activeIndex.value=index;activeEditor=event.target as HTMLTextAreaElement}
async function insertVariable(name:string,xml=false){
  if(raw.value){const el=rawEditor.value,start=el?.selectionStart??props.modelValue.length,end=el?.selectionEnd??start;const result=insertPromptVariable(props.modelValue,start,end,name,xml);lastEmitted=result.text;error.value=parseWorkerContent(result.text).error;emit('update:modelValue',result.text);await nextTick();el?.focus();el?.setSelectionRange(result.cursor,result.cursor);return true}
  if(!config.value)return false
  const index=Math.min(activeIndex.value,config.value.messages.length-1),message=config.value.messages[index];if(!message)return false
  const editor=activeEditor,start=editor?.selectionStart??message.content.length,end=editor?.selectionEnd??start
  const result=insertPromptVariable(message.content,start,end,name,xml);message.content=result.text;commit();await nextTick();editor?.focus();editor?.setSelectionRange(result.cursor,result.cursor);return true
}
defineExpose({insertVariable})
</script>

<template>
  <div class="worker-editor">
    <div class="worker-options"><div class="worker-option-toggles"><label class="toggle-label"><span>Developer</span><ToggleSwitch :model-value="developer" aria-label="启用 Worker Developer 消息" :disabled="!config||raw" @update:model-value="toggleDeveloper"/></label><CheckboxControl v-if="!guidanceOnly" :model-value="xml" @update:model-value="emit('update:xml',$event)">XML 包装</CheckboxControl></div><button v-if="!guidanceOnly" class="text-button" :aria-pressed="raw" @click="changeMode"><Icon name="schema" :size="16"/>{{raw?'结构化编辑':'JSON'}}</button></div>
    <p v-if="error" class="inline-error" role="alert">{{error}}</p>
    <textarea v-if="raw" ref="rawEditor" :value="modelValue" class="worker-raw" aria-label="Worker JSON" spellcheck="false" @input="rawInput"/>
    <template v-else-if="config">
      <div class="worker-messages">
        <section v-for="(message,index) in config.messages" :key="index" class="worker-message">
          <header><label class="message-role">消息 {{index+1}}<CustomSelect v-model="message.role" :aria-label="`消息 ${index+1} 角色`" :options="[{value:'system',label:'System'},...(developer?[{value:'developer' as const,label:'Developer'}]:[]),...(!guidanceOnly?[{value:'user',label:'User'},{value:'assistant',label:'Assistant'}]:[])]" @change="commit"/></label><div class="message-actions"><button class="text-button" :disabled="index===0" :aria-label="`上移消息 ${index+1}`" @click="moveMessage(index,-1)"><Icon name="move-up" :size="16"/>上移</button><button class="text-button" :disabled="index===config.messages.length-1" :aria-label="`下移消息 ${index+1}`" @click="moveMessage(index,1)"><Icon name="move-down" :size="16"/>下移</button><button class="icon-button" :aria-label="`删除消息 ${index+1}`" :disabled="config.messages.length===1" @click="removeMessage(index)"><Icon name="close" :size="16"/></button></div></header>
          <textarea :value="message.content" :aria-label="`${message.role} 消息正文 ${index+1}`" spellcheck="false" @input="changeMessage(index,($event.target as HTMLTextAreaElement).value)" @focus="focusMessage(index,$event)"/>
        </section>
      </div>
      <button class="text-button add-message" @click="addMessage"><Icon name="plus" :size="16"/>添加消息</button>
      <section v-if="!guidanceOnly" class="worker-format"><label class="field">输出格式<CustomSelect :model-value="format" aria-label="输出格式" :options="[{value:'text',label:'Text'},{value:'json_object',label:'JSON object'},{value:'json_schema',label:'JSON schema'}]" @update:model-value="changeFormat"/></label><template v-if="format==='json_schema'"><div class="schema-options"><label class="field">Schema 名称<input :value="config.response_format?.json_schema?.name??''" @input="setSchemaName(($event.target as HTMLInputElement).value)"/></label><CheckboxControl :model-value="config.response_format?.json_schema?.strict===true" @update:model-value="setStrict">Strict</CheckboxControl></div><label class="field">Schema<textarea v-model="schemaText" spellcheck="false" rows="10" @input="commit"/></label></template></section>
    </template>
  </div>
</template>

<style scoped>
.worker-editor{padding:0 24px 24px;min-width:0}.worker-options{display:flex;justify-content:space-between;align-items:center;gap:16px;min-height:58px}.worker-option-toggles{display:flex;align-items:center;gap:24px;flex-wrap:wrap}.toggle-label{display:flex;align-items:center;gap:16px;font-size:var(--settings-function-size,12px)}.worker-messages{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.worker-message{min-width:0}.worker-message header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.message-role{display:flex;align-items:center;gap:8px;font-size:var(--settings-function-size,12px);color:var(--sand-text-secondary)}.message-role .custom-select{width:125px;font-size:var(--settings-content-size,12px)}.message-actions{display:flex;align-items:center;gap:4px}.message-actions .text-button{font-size:var(--settings-function-size,12px);padding:4px}.worker-message textarea,.worker-raw{width:100%;min-height:300px;resize:vertical;background:var(--sand-bg-secondary);border:1px solid var(--sand-border-quaternary-translucent);border-radius:8px;padding:8px;font-family:'SFMono-Regular',Consolas,monospace;font-size:13px;line-height:20px;color:var(--sand-text-primary)}.worker-raw{min-height:420px}.add-message{margin:16px 0 24px}.worker-format{border-top:.5px solid var(--sand-border-quaternary-translucent);padding-top:24px}.worker-format>.field:first-child{max-width:260px}.schema-options{display:flex;align-items:center;gap:24px}.schema-options .field{flex:1}.strict-option{display:flex;align-items:center;gap:8px;font-size:var(--settings-function-size,12px)}.worker-format textarea{font-family:'SFMono-Regular',Consolas,monospace;font-size:13px}.inline-error{margin-bottom:12px}@media(max-width:1100px){.worker-messages{grid-template-columns:1fr}.worker-message textarea{min-height:220px}}@media(max-width:760px){.worker-editor{padding:0 20px 20px}.worker-message header{flex-wrap:wrap}.worker-message textarea,.worker-raw{font-size:var(--settings-content-size,13px)}.message-actions .text-button{min-width:44px;min-height:28px}.schema-options{gap:12px}}
</style>

<style scoped src="../form-controls.css"></style>
