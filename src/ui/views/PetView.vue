<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Snapshot } from '../types'
import PetRenderer from '../components/PetRenderer.vue'
import Icon from '../components/Icon.vue'
import TooltipButton from '../components/TooltipButton.vue'

const props = defineProps<{ state: Snapshot }>()
const emit = defineEmits<{ error: [error: unknown] }>()
const requested = new URLSearchParams(location.search).get('character'), clickThrough = ref(false)
const renderer = ref<InstanceType<typeof PetRenderer>>()
const captureWindow = window as unknown as { __sandbookCapturePet?: () => unknown }
const character = computed(() => props.state.characters.find(person => person.id === requested) ?? props.state.characters.find(person => person.id === 'default-character') ?? props.state.characters[0])
const speaking = computed(() => props.state.activity.some(run => run.characterId === character.value?.id))
const desktop = () => window.sandbook as (NonNullable<typeof window.sandbook> & { setPetClickThrough?: (enabled: boolean) => Promise<void> }) | undefined
async function action(task: () => Promise<unknown> | undefined) { try { await task() } catch (error) { emit('error', error) } }
async function toggleThrough() {
  const api = desktop(); if (!api?.setPetClickThrough) { emit('error', Error('点击穿透需要桌面应用支持。')); return }
  await action(async () => { await api.setPetClickThrough!(!clickThrough.value); clickThrough.value = !clickThrough.value })
}
onMounted(() => { document.documentElement.classList.add('pet-window'); captureWindow.__sandbookCapturePet = () => { if (!character.value?.pet || !renderer.value) throw Error('当前角色没有可用形象'); const result = renderer.value.capture(); return { ...result, source: { ...result.source, characterId: character.value.id } } } })
onBeforeUnmount(() => { document.documentElement.classList.remove('pet-window'); delete captureWindow.__sandbookCapturePet })
</script>

<template>
  <main class="desktop-pet" :aria-label="`${character?.name ?? '角色'}的桌宠`">
    <div class="pet-window-drag" aria-hidden="true"/>
    <PetRenderer v-if="character?.pet" ref="renderer" :pet="character.pet" :speaking="speaking" :emotion="character.state?.emotion" @error="emit('error',$event)"/>
    <div v-else class="pet-empty"><p>未设置桌面形象</p><button type="button" @click="action(()=>desktop()?.showMain())">前往角色设置</button></div>
    <nav class="pet-toolbar" aria-label="桌宠操作">
      <TooltipButton label="打开主窗口" icon="chat" :size="18" @click="action(()=>desktop()?.showMain())"/>
      <TooltipButton :label="clickThrough?'恢复鼠标交互':'开启点击穿透，可从状态栏恢复'" icon="eye" :size="18" :aria-pressed="clickThrough" @click="toggleThrough"/>
      <TooltipButton label="隐藏桌宠" icon="close" :size="18" @click="action(()=>desktop()?.togglePet(character?.id))"/>
    </nav>
  </main>
</template>
<style scoped>
:global(html.pet-window),:global(html.pet-window body),:global(html.pet-window #app){background:transparent!important;margin:0;overflow:hidden;min-width:0!important;width:100%;height:100%}
.desktop-pet{position:fixed;inset:0;overflow:hidden;background:transparent;user-select:none;padding:24px 8px 8px;color:var(--text)}.pet-window-drag{position:absolute;top:0;left:8px;right:8px;height:24px;-webkit-app-region:drag}
.pet-toolbar{position:absolute;left:50%;top:8px;display:flex;gap:4px;padding:4px;transform:translateX(-50%);border-radius:12px;background:var(--sand-bg-elevated,var(--surface));color:var(--text);box-shadow:0 4px 12px -1px var(--sand-shadow-inline-ambient),0 2px 4px -2px var(--sand-shadow-inline-key),inset 0 0 0 .5px var(--sand-border-secondary-translucent,var(--faint));opacity:0;pointer-events:none;transition:opacity 120ms ease-out;-webkit-app-region:no-drag}
.desktop-pet:hover .pet-toolbar,.desktop-pet:focus-within .pet-toolbar{opacity:1;pointer-events:auto}.pet-toolbar :deep(.icon-button){display:grid;place-items:center;width:28px;height:28px;min-width:28px;min-height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--sand-icon-secondary,var(--muted));cursor:pointer}.pet-toolbar :deep(.icon-button:hover){background:var(--sand-bg-secondary,var(--hover));color:var(--text)}.pet-toolbar :deep(.icon-button[aria-pressed=true]),.pet-toolbar :deep(.icon-button[aria-pressed=true]:hover){background:var(--sand-bg-secondary-hover,var(--selected));color:var(--text)}
.pet-empty{position:absolute;left:20px;right:20px;bottom:24px;padding:16px;border-radius:14px;background:var(--sand-bg-elevated,var(--surface));box-shadow:inset 0 0 0 .5px var(--sand-border-secondary-translucent,var(--faint));color:var(--text);font-size:13px;line-height:20px;text-align:center}.pet-empty p{margin:0 0 8px}.pet-empty button{appearance:none;background:var(--sand-bg-secondary,var(--hover));color:inherit;border:0;border-radius:15px;font:inherit;font-weight:420;min-height:30px;padding:4px 12px;cursor:pointer;transition:background-color 140ms cubic-bezier(.16,1,.3,1)}.pet-empty button:hover{background:var(--sand-bg-secondary-hover,var(--selected))}
@media(hover:none){.pet-toolbar{opacity:1;pointer-events:auto}}@media(prefers-reduced-motion:reduce){.pet-toolbar{transition:none}}
</style>
