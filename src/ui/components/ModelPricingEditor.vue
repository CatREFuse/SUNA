<script setup lang="ts">
import {computed, reactive, ref, watch, toRaw} from 'vue'
import {pricingFields, pricingDraft, updatePricing} from '../pricing-editor.mjs'
type Pricing={currency?:string|null;origin?:string|null;basis?:string|null;source?:string|null;verifiedAt?:string|null;serviceTier?:string|null;contextRule?:{inputTokensAbove:number;inputMultiplier?:number|null;cacheReadMultiplier?:number|null;cacheWriteMultiplier?:number|null;outputMultiplier?:number|null}|null;[key:string]:unknown}
const props=defineProps<{modelValue?:Pricing|null;disabled?:boolean}>()
const emit=defineEmits<{'update:modelValue':[Pricing|null];validity:[boolean]}>()
const values=reactive<Record<string,string>>(pricingDraft(props.modelValue))
const currency=ref(props.modelValue?.currency??'')
const error=ref('')
const source=computed(()=>{try{const url=new URL(props.modelValue?.source??'');return url.protocol==='https:'&&!url.username&&!url.password?url.href:null}catch{return null}})
const origin=computed(()=>!props.modelValue?'未配置':props.modelValue.origin==='official-preset'&&props.modelValue.basis==='official-api-reference'?'官方预设':'自定义')
// Parent echo of our own value must not reset a temporarily invalid field.
let emitted:Pricing|null|undefined
watch(()=>props.modelValue,value=>{if(toRaw(value)===toRaw(emitted))return;Object.assign(values,pricingDraft(value));currency.value=value?.currency??'';error.value='';emit('validity',true)})
function edit(){try{const next=updatePricing(props.modelValue,values,currency.value);error.value='';emit('validity',true);emitted=next;emit('update:modelValue',next)}catch(cause){error.value=cause instanceof Error?cause.message:String(cause);emit('validity',false)}}
function clear(){Object.assign(values,pricingDraft(null));currency.value='';error.value='';emit('validity',true);emitted=null;emit('update:modelValue',null)}
</script>
<template>
  <section class="model-pricing-editor" aria-label="模型价格">
    <div class="pricing-heading"><span>模型价格</span><span class="pricing-muted">{{origin}} · API 参考估算</span></div>
    <div class="pricing-meta">
      <a v-if="source" :href="source" target="_blank" rel="noopener noreferrer">参考来源</a>
      <span v-if="modelValue?.verifiedAt">核验于 {{modelValue.verifiedAt}}</span>
      <span v-if="modelValue?.serviceTier">{{modelValue.serviceTier}}</span>
    </div>
    <label class="pricing-row"><span>币种 / 100 万 token</span><input :value="currency" :disabled="disabled" aria-label="价格币种" maxlength="3" placeholder="未配置" autocomplete="off" @input="currency=($event.target as HTMLInputElement).value;edit()"></label>
    <label v-for="field in pricingFields" :key="field.key" class="pricing-row"><span>{{field.label}}</span><input v-model="values[field.key]" :disabled="disabled" type="text" inputmode="decimal" :aria-label="field.label+'价格'" :aria-invalid="Boolean(error)" placeholder="未配置" autocomplete="off" @input="edit"></label>
    <p v-if="modelValue?.contextRule" class="pricing-condition">输入超过 {{modelValue.contextRule.inputTokensAbove.toLocaleString()}} token 时按已保存的长上下文条件估算；编辑费率保留该条件。</p>
    <p v-if="error" class="pricing-error" role="alert">{{error}}</p>
    <div class="pricing-footer"><span class="pricing-muted">空白表示未配置，0 表示零费率。</span><button type="button" :disabled="disabled||(!modelValue&&!error)" @click="clear">清除费率</button></div>
  </section>
</template>
<style scoped>
.model-pricing-editor{display:grid;gap:12px;border-top:.5px solid var(--sand-border-quaternary-translucent);padding-top:16px;min-width:0}
.pricing-heading{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;font-size:13px;font-weight:420}
.pricing-muted,.pricing-meta,.pricing-condition{color:var(--sand-text-secondary);font-size:13px;font-weight:420}
.pricing-meta{display:flex;flex-wrap:wrap;gap:8px}.pricing-meta:empty{display:none}.pricing-meta a{color:inherit;text-underline-offset:3px;overflow-wrap:anywhere}
.pricing-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(100px,180px);gap:16px;align-items:center;font-size:13px}
.pricing-row input{appearance:none;box-sizing:border-box;min-width:0;width:100%;font-family:inherit;font-size:13px;font-weight:420;font-variant-numeric:tabular-nums;border:1px solid var(--sand-border-quaternary-translucent);border-radius:8px;padding:4px 8px;background:var(--sand-bg-secondary);color:var(--sand-text-primary);outline:0;box-shadow:none;height:28px;min-height:28px;box-sizing:border-box}.pricing-row input:focus{outline:0;box-shadow:none}.pricing-row input:disabled{opacity:.45}.pricing-footer button{appearance:none;border:0;background:transparent;color:var(--sand-text-secondary);padding:8px;border-radius:8px;font-family:inherit;cursor:pointer}.pricing-footer button:hover,.pricing-footer button:focus-visible{background:var(--sand-bg-hover);color:var(--sand-text-primary);outline:2px solid var(--sand-border-focus-primary);outline-offset:1px}.pricing-footer button:disabled{opacity:.45;cursor:default}
.pricing-condition,.pricing-error{margin:0;line-height:1.6;font-size:13px}.pricing-error{color:var(--sand-text-danger-primary)}
.pricing-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.pricing-footer button{font-size:13px}
@media(max-width:440px){.pricing-row{grid-template-columns:minmax(0,1fr) 110px;gap:8px}.pricing-heading{align-items:flex-start}}
</style>

<style scoped src="../form-controls.css"></style>
