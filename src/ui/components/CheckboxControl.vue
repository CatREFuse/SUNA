<script setup lang="ts">
import Icon from './Icon.vue'
defineProps<{modelValue?:boolean;disabled?:boolean}>()
const emit=defineEmits<{'update:modelValue':[boolean]}>()
</script>
<template><button type="button" class="checkbox-control" role="checkbox" :aria-checked="Boolean(modelValue)" :disabled="disabled" @click="emit('update:modelValue',!modelValue)"><span class="checkbox-mark" aria-hidden="true"><Icon v-if="modelValue" name="check" :size="14"/></span><span><slot/></span></button></template>
<style scoped>
.checkbox-control{display:inline-flex;align-items:center;gap:8px;min-height:24px;padding:4px 0;border:0;border-radius:4px;background:transparent;color:var(--sand-text-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;outline:none;box-shadow:none;opacity:1}.checkbox-mark{display:grid;place-items:center;width:16px;height:16px;border:1px solid var(--sand-border-primary-translucent);border-radius:4px;background:var(--sand-bg-elevated);color:var(--sand-text-on-primary);flex-shrink:0;transition:background-color 120ms ease}.checkbox-control[aria-checked=true] .checkbox-mark{border-width:.5px;border-color:var(--sand-border-quaternary-translucent);background:var(--sand-bg-accent-primary);color:var(--on-accent)}.checkbox-control[aria-checked=true]:not(:disabled):hover .checkbox-mark{background:var(--sand-bg-accent-primary-hover)}.checkbox-control:focus-visible{outline:2px solid var(--sand-border-focus-primary);outline-offset:1px}.checkbox-control:disabled{opacity:1;cursor:default;color:var(--sand-text-quaternary)}.checkbox-control[aria-checked=true]:disabled .checkbox-mark{background:var(--sand-bg-accent-primary-disabled);color:var(--sand-text-accent-primary)}@media(prefers-reduced-motion:reduce){.checkbox-mark{transition:none}}
</style>
