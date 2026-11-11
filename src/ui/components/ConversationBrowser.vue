<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {Globe,LoaderCircle} from '@lucide/vue'
import Icon from './Icon.vue'
import TooltipButton from './TooltipButton.vue'
type BrowserState={conversationId?:string,url:string,title:string,loading:boolean,canGoBack:boolean,canGoForward:boolean,error:string,visible:boolean}
type BrowserBridge={command:(payload:Record<string,unknown>)=>Promise<BrowserState>,onState:(callback:(state:BrowserState)=>void)=>()=>void}
const props=defineProps<{conversationId?:string,active:boolean,overlayBlocked?:boolean}>()
const emit=defineEmits<{error:[message:string]}>()
const bridge=(window.sandbook as (typeof window.sandbook & {browser?:BrowserBridge}))?.browser
const surface=ref<HTMLElement>(),address=ref(''),editing=ref(false),failure=ref('')
const empty=():BrowserState=>({url:'',title:'',loading:false,canGoBack:false,canGoForward:false,error:'',visible:false})
const state=ref<BrowserState>(empty())
const blocked=computed(()=>!props.active||props.overlayBlocked||!props.conversationId)
let observer:ResizeObserver|undefined,unsubscribe:(()=>void)|undefined,frame=0,disposed=false,lastShown:string|undefined
function accept(value:BrowserState){if(value.conversationId!==props.conversationId)return;state.value=value;if(!editing.value)address.value=value.url}
async function command(action:string,extra:Record<string,unknown>={}){
  const id=props.conversationId;if(!bridge||!id)return
  try{failure.value='';const value=await bridge.command({action,conversationId:id,...extra});if(!disposed&&id===props.conversationId)accept(value)}catch(error){if(!disposed&&id===props.conversationId){failure.value=String((error as Error).message||error).replace(/^Error invoking remote method '[^']+': Error: /,'');emit('error',failure.value)}}
}
function hide(id=lastShown){if(id&&bridge)void bridge.command({action:'hide',conversationId:id}).catch(()=>{});lastShown=undefined}
async function layout(){
  frame=0;if(disposed||!bridge)return
  const node=surface.value,rect=node?.getBoundingClientRect()
  if(blocked.value||document.hidden||!rect||!node?.getClientRects().length||rect.width<40||rect.height<40){hide();return}
  // Match the visible portion if an ancestor scrolls/clips the panel.
  const x=Math.max(0,rect.left),y=Math.max(0,rect.top),right=Math.min(innerWidth,rect.right),bottom=Math.min(innerHeight,rect.bottom)
  lastShown=props.conversationId
  await command('show',{bounds:{x,y,width:right-x,height:bottom-y}})
}
function schedule(){if(!disposed){cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>void layout())}}
async function navigate(){if(!address.value.trim())return;editing.value=false;await command('navigate',{url:address.value});schedule()}
async function closePage(){hide();await command('close');address.value='';schedule()}
watch(()=>[props.conversationId,props.active,props.overlayBlocked],async(value,previous)=>{
  hide(previous?.[0] as string|undefined)
  if(value[0]!==previous?.[0]){state.value=empty();address.value='';failure.value='';editing.value=false;await command('state')}
  await nextTick();schedule()
},{flush:'sync'})
onMounted(()=>{if(!bridge)return;unsubscribe=bridge.onState(accept);observer=new ResizeObserver(schedule);if(surface.value)observer.observe(surface.value);window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);window.addEventListener('focus',schedule);document.addEventListener('visibilitychange',schedule);void command('state');schedule()})
onBeforeUnmount(()=>{disposed=true;cancelAnimationFrame(frame);hide();observer?.disconnect();unsubscribe?.();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);window.removeEventListener('focus',schedule);document.removeEventListener('visibilitychange',schedule)})
</script>

<template>
  <section class="conversation-browser" aria-label="会话浏览器">
    <template v-if="bridge">
      <form class="browser-toolbar" @submit.prevent="navigate">
        <div class="browser-navigation">
          <TooltipButton label="后退" icon="back" :size="16" :disabled="!state.canGoBack" @click="command('back')"/>
          <TooltipButton label="前进" icon="arrow" :size="16" :disabled="!state.canGoForward" @click="command('forward')"/>
          <TooltipButton v-if="state.loading" label="停止加载" icon="stop" :size="14" @click="command('stop')"/>
          <TooltipButton v-else label="刷新网页" icon="refresh" :size="15" :disabled="!state.url" @click="command('reload')"/>
          <span class="browser-title">{{state.title||'会话浏览器'}}</span>
          <TooltipButton label="关闭当前网页" icon="close" :size="15" :disabled="!state.url" @click="closePage"/>
        </div>
        <label class="browser-address"><Globe :size="15"/><input v-model="address" aria-label="网页地址" placeholder="输入网址" :disabled="!conversationId" autocomplete="off" spellcheck="false" @focus="editing=true" @blur="editing=false"><button type="submit" :disabled="!address.trim()||!conversationId"><Icon name="arrow" :size="15"/>前往</button></label>
      </form>
      <p v-if="failure||state.error" class="browser-error" role="alert">{{failure||state.error}}</p>
      <div ref="surface" class="browser-surface" :aria-label="state.title||'网页内容'">
        <div v-if="!state.url" class="browser-empty"><Globe :size="25"/><strong>{{conversationId?'在此会话中浏览网页':'请先选择会话'}}</strong><span>每个会话的页面与登录状态独立。关闭网页后清除。</span></div>
        <div v-else-if="state.loading" class="browser-empty"><LoaderCircle :size="22"/><span>正在载入网页…</span></div>
      </div>
    </template>
    <div v-else class="browser-empty browser-unavailable"><Globe :size="27"/><strong>在桌面应用中浏览网页</strong><span>网页版暂不提供内嵌浏览器。</span></div>
  </section>
</template>
<style scoped>
.conversation-browser{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;height:100%;color:var(--text);font-size:13px;line-height:20px;background:var(--sand-bg-pane,var(--surface))}
.browser-toolbar{padding:8px;border-bottom:.5px solid var(--sand-border-quaternary-translucent,var(--faint));display:grid;gap:8px;flex:none;min-width:0}
.browser-navigation{display:flex;align-items:center;gap:4px;min-width:0}.browser-navigation :deep(.icon-button){display:grid;place-items:center;flex:none;width:28px;height:28px;min-width:28px;min-height:28px;padding:0;border:0;border-radius:6px}.browser-navigation :deep(.icon-button:disabled){opacity:1;color:var(--sand-icon-quaternary,var(--muted));background:transparent;cursor:default}
.browser-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12px;line-height:16px;padding:0 4px}
.browser-address{display:flex;align-items:center;gap:8px;min-width:0;height:28px;border:.5px solid var(--sand-border-secondary-translucent,var(--faint));border-radius:10px;padding:0 8px;color:var(--muted);background:var(--sand-bg-secondary,var(--surface));transition:border-color 150ms ease,background-color 150ms ease}.browser-address>svg{flex:none}.browser-address input{border:0;background:transparent;box-shadow:none;min-width:0;width:100%;height:26px;padding:4px 0;color:var(--text);font:inherit;font-size:13px;line-height:18px}.browser-address button{display:flex;align-items:center;gap:4px;min-height:24px;border:0;border-radius:6px;background:transparent;color:var(--muted);font-size:13px;line-height:18px;white-space:nowrap;padding:4px 4px;flex:none}.browser-address button:hover:enabled{background:var(--sand-bg-hover,var(--hover));color:var(--text)}.browser-address button:disabled{color:var(--sand-text-quaternary,var(--muted));cursor:default}.browser-address:focus-within{border-color:var(--sand-border-primary-translucent,var(--faint))}
/* Native WebContentsView cannot inherit CSS clipping: retain the exact
   14px right/bottom clearance used by its measured bounds. */
.browser-surface{flex:1;min-height:80px;margin-right:16px;margin-bottom:16px;position:relative;overflow:hidden}.browser-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:24px;text-align:center;color:var(--muted);font-size:13px;line-height:20px}.browser-empty strong{font-size:14px;line-height:20px;color:var(--text);font-weight:500}.browser-empty span{max-width:260px}.browser-unavailable{position:relative;flex:1}.browser-error{margin:0;padding:8px 12px;border-bottom:.5px solid var(--sand-border-quaternary-translucent,var(--faint));color:var(--error);font-size:12px;line-height:18px;flex:none;overflow-wrap:anywhere}
@media(max-width:700px){.browser-toolbar{padding:8px}.browser-navigation{gap:4px}}
.browser-address input:focus-visible{outline:none}.keyboard .browser-address:has(input:focus-visible){outline:2px solid var(--sand-border-focus-primary,var(--focus));outline-offset:2px}
</style>
