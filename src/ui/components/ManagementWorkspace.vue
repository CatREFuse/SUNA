<script setup lang="ts">
import {ref,watch,nextTick} from 'vue'
import Icon from './Icon.vue'
import {settingsPages,type SettingsPageId} from '../settings-navigation'
import TooltipButton from './TooltipButton.vue'
const props=withDefaults(defineProps<{section:string;settingsPage?:SettingsPageId;nativeMac?:boolean;developerMode?:boolean}>(),{nativeMac:false,developerMode:false})
const emit=defineEmits<{navigate:[section:string];settings:[page:SettingsPageId];conversation:[]}>()
const navigation=ref<HTMLElement>()
watch([()=>props.section,()=>props.settingsPage],async()=>{await nextTick();navigation.value?.querySelector<HTMLElement>('[aria-current=page]')?.scrollIntoView({block:'nearest',inline:'nearest'})},{immediate:true,flush:'post'})
const pages=[{id:'characters',label:'角色',icon:'people'},{id:'channels',label:'频道',icon:'channels'},{id:'plugins',label:'插件',icon:'plugin'}]
</script>
<template>
 <div class="management-workspace" :class="{'native-management':nativeMac}">
  <aside class="management-navigation" aria-label="管理导航">
   <div class="management-drag-space" aria-hidden="true"/>
   <nav ref="navigation" aria-label="管理与设置"><div class="management-pages"><button v-for="page in pages" :key="page.id" type="button" :aria-current="section===page.id?'page':undefined" @click="emit('navigate',page.id)"><Icon :name="page.icon" :size="18"/><span>{{page.label}}</span></button></div><div class="management-settings-pages"><button v-for="page in settingsPages" :id="`management-settings-${page.id}-nav`" :key="page.id" type="button" :aria-current="section==='settings'&&settingsPage===page.id?'page':undefined" :aria-controls="page.id==='prompts'?'settings-prompts':'settings-general'" @click="emit('settings',page.id)"><Icon :name="page.icon" :size="18"/><span>{{page.label}}</span></button></div></nav>
   <footer class="management-footer"><TooltipButton label="打开对话窗口" icon="chat" class="management-main-link" @click="emit('conversation')"/></footer>
  </aside>
  <main class="management-content"><slot/></main>
 </div>
</template>
<style scoped>
.management-workspace{display:flex;width:100%;height:100dvh;min-width:0;min-height:0;overflow:hidden;background:var(--sand-bg-chrome);color:var(--sand-text-primary)}
.native-management.management-workspace,.native-management .management-navigation{background:transparent}
.management-navigation{display:flex;flex-direction:column;flex:none;width:156px;min-width:0;min-height:0;padding:0 12px 16px;background:var(--sand-bg-sidebar);border-right:.5px solid var(--sand-border-primary-translucent)}
.management-drag-space{height:20px;flex:none;-webkit-app-region:drag}.native-management .management-drag-space{height:52px}
.management-navigation nav{display:flex;flex:1;flex-direction:column;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding-bottom:12px}
.management-pages,.management-settings-pages{display:flex;flex:none;flex-direction:column;gap:4px}.management-settings-pages{margin-top:12px;padding-top:12px;border-top:.5px solid var(--sand-border-primary-translucent)}
.management-navigation nav button{display:flex;align-items:center;gap:8px;min-height:36px;padding:8px 8px;border-radius:10px;text-align:left;font-size:14px;line-height:20px}
.management-navigation nav button:hover{background:var(--sand-bg-hover)}.management-navigation nav button[aria-current=page]{background:var(--sand-bg-active)}
.management-footer{margin-top:auto;flex:none;padding-left:8px}
.management-content{flex:1;min-width:0;min-height:0;overflow:hidden;display:flex;flex-direction:column}.management-content :slotted(*){flex:1;min-width:0;min-height:0;height:100%}
@media(max-width:600px){.management-navigation{width:56px;padding-inline:8px}.management-navigation nav button{padding:8px;justify-content:center}.management-navigation nav button span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.management-footer{padding-left:4px}}
</style>
