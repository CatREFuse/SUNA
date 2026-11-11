<script setup lang="ts">
import {computed,ref,watch,useId} from 'vue'
import {channelConversationName,channelPlatformName,channelAccountName} from '../../core/channel-display.mjs'
import type {Snapshot,Conversation} from '../types'
import type {ObservabilityPage,ObservabilityFilter,ObservabilityRoundOption} from '../conversation-observability'
import Icon from './Icon.vue'
import TooltipButton from './TooltipButton.vue'
import CharacterAvatar from './CharacterAvatar.vue'
import PetRenderer from './PetRenderer.vue'
import ChannelReplyControls from './ChannelReplyControls.vue'
import GroupSchedulerControls from './GroupSchedulerControls.vue'
import DesktopGroupModeratorControls from './DesktopGroupModeratorControls.vue'
import ConversationUsageDashboard from './ConversationUsageDashboard.vue'
import ChannelSchedulerStatus from './ChannelSchedulerStatus.vue'
import ConversationObservability from './ConversationObservability.vue'
import {conversationScope} from '../conversation-state.mjs'
type Pane='details'|'groups'|'logs'
type Preferences={layout:string;collapsed:Record<string,boolean>;perRound:boolean;open:boolean}
const props=withDefaults(defineProps<{state:Snapshot;conversation?:Conversation;tab:string;active:boolean;presented?:boolean;overlayBlocked:boolean;readOnly?:boolean;preferences?:Preferences;observability?:ObservabilityPage|null;observabilityLoading?:boolean;observabilityError?:string;logCategory?:ObservabilityFilter;logRound?:string;logRounds?:ObservabilityRoundOption[];logUnassignedCount?:number}>(),{presented:undefined})
const emit=defineEmits<{'update:tab':[string];'update:preferences':[Partial<Preferences>];close:[];add:[];select:[string];showPet:[string];error:[unknown];refresh:[];notice:[string];filterLogs:[ObservabilityFilter];moreLogs:[];retryLogs:[];selectLogRound:[string]}>()
const petSelections=ref<Record<string,string>>({}),panel=ref<HTMLElement>(),panelId=useId()
const participants=computed(()=>props.state.characters.filter(person=>props.conversation?.participantIds.includes(person.id)))
const currentPet=computed(()=>participants.value.find(person=>person.id===petSelections.value[props.conversation?.id??''])??participants.value[0])
const related=computed(()=>props.state.conversations.filter(item=>item.id!==props.conversation?.id&&item.kind==='group'&&conversationScope(item)===conversationScope(props.conversation??{channel:'desktop'})&&item.participantIds.some(id=>props.conversation?.participantIds.includes(id))))
const channel=computed(()=>props.conversation&&props.conversation.channel!=='desktop'?{...props.conversation.channelTarget,...props.conversation.channelDetails,...props.conversation.display?.channel}:undefined)
const channelLabel=computed(()=>channel.value?[channelPlatformName(channel.value.platform),channelAccountName(channel.value)].filter(Boolean).join(' · '):'本地会话')
const channelName=computed(()=>channelConversationName(props.conversation))
const panes=[{id:'details' as Pane,label:'详情'},{id:'groups' as Pane,label:'成员'},{id:'logs' as Pane,label:'日志'}]
const tabs=computed(()=>panes.filter(pane=>pane.id!=='groups'||props.conversation?.kind==='group').filter(pane=>pane.id!=='logs'||props.state.settings.developerMode))
const selectedTab=computed(()=>tabs.value.some(pane=>pane.id===props.tab)?props.tab:'details')
function available(id:Pane){return tabs.value.some(pane=>pane.id===id)}
function paneVisible(id:Pane){return available(id)&&selectedTab.value===id}
function running(id:Pane){return props.active&&!props.overlayBlocked&&paneVisible(id)}
function chooseTab(id:Pane){if(available(id))emit('update:tab',id)}
watch(selectedTab,value=>{if(value!==props.tab)emit('update:tab',value)},{immediate:true})
function focusSelectedTab(){panel.value?.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')?.focus({preventScroll:true})}
defineExpose({focusSelectedTab})
const petFailures=ref<Record<string,boolean>>({})
const petKey=computed(()=>currentPet.value?.pet?JSON.stringify([currentPet.value.id,currentPet.value.pet.type,currentPet.value.pet.url,currentPet.value.pet.columns??1,currentPet.value.pet.rows??1,currentPet.value.pet.fps??8]):'')
function petError(key:string,cause:unknown){if(key!==petKey.value)return;petFailures.value[key]=true;emit('error',cause)}
const petRenderHandlers=computed(()=>{const key=petKey.value;return{error:(cause:unknown)=>petError(key,cause)}})
const petRunning=computed(()=>(props.presented??props.active)&&!props.overlayBlocked)
function tabKey(event:KeyboardEvent){const target=event.currentTarget as HTMLButtonElement,nodes=[...target.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')??[]],focused=nodes.indexOf(target);let next=focused>=0?focused:0;if(event.key==='ArrowRight')next=(next+1)%nodes.length;else if(event.key==='ArrowLeft')next=(next+nodes.length-1)%nodes.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=nodes.length-1;else return;event.preventDefault();nodes[next]?.focus()}
</script>

<template>
 <aside ref="panel" class="conversation-details redesigned-details" aria-label="对话侧栏">
  <div class="details-toolbar"><TooltipButton label="关闭侧栏" icon="close" :size="20" @click="emit('close')"/></div>
  <header class="details-identity">
   <div class="details-portrait">
    <PetRenderer v-if="petRunning&&currentPet?.pet&&!petFailures[petKey]" :key="petKey" :pet="currentPet.pet" :speaking="state.activity.some(run=>run.characterId===currentPet?.id&&run.conversationId===conversation?.id)" :emotion="currentPet.state?.emotion" v-on="petRenderHandlers"/>
    <CharacterAvatar v-else-if="currentPet" :person="currentPet" :active="petRunning"/>
    <Icon v-else name="person" :size="48"/>
   </div>
   <button v-if="petFailures[petKey]" type="button" class="text-button details-pet-retry" :disabled="!petRunning" @click="petFailures[petKey]=false">重试形象</button>
   <h2 :title="currentPet?.name||channelName||'未选择角色'">{{currentPet?.name||channelName||'未选择角色'}}</h2>
   <div v-if="participants.length>1" class="details-role-picker" role="group" aria-label="显示的角色形象">
    <button v-for="person in participants" :key="person.id" type="button" :aria-label="`显示${person.name}的形象`" :aria-pressed="currentPet?.id===person.id" @click="petSelections[conversation!.id]=person.id"><CharacterAvatar :person="person" :active="petRunning"/></button>
   </div>
  </header>
  <nav class="details-tabs" role="tablist" aria-label="对话功能">
   <button v-for="item in tabs" :id="`${panelId}-${item.id}-tab`" :key="item.id" type="button" role="tab" :aria-controls="`${panelId}-${item.id}`" :aria-selected="selectedTab===item.id" :tabindex="selectedTab===item.id?0:-1" @keydown="tabKey" @click="chooseTab(item.id)">{{item.label}}</button>
  </nav>
  <div class="details-panels">
   <section v-show="paneVisible('details')" :id="`${panelId}-details`" class="details-content" role="tabpanel" :aria-labelledby="`${panelId}-details-tab`" :inert="!paneVisible('details')" tabindex="0">
    <section v-if="conversation" class="details-section">
     <h3>会话</h3>
     <dl class="details-rows">
      <div v-if="conversation.kind==='group'"><dt>名称</dt><dd>{{channelName}}</dd></div>
      <div><dt>来源</dt><dd>{{channelLabel}}</dd></div>
      <div v-if="currentPet?.role"><dt>身份</dt><dd>{{currentPet.role}}</dd></div>
      <div v-if="currentPet?.state?.emotion"><dt>情绪</dt><dd>{{currentPet.state.emotion}}</dd></div>
      <div v-if="currentPet?.state?.environment"><dt>环境</dt><dd>{{currentPet.state.environment}}</dd></div>
     </dl>
    </section>
    <section v-if="currentPet?.pet" class="details-section">
     <h3>形象</h3>
     <button type="button" class="details-action" :disabled="!active||overlayBlocked" @click="emit('showPet',currentPet.id)"><Icon name="pet" :size="18"/><span>显示桌宠</span><Icon name="chevron" :size="16"/></button>
    </section>
    <section v-if="conversation?.kind==='group'" class="details-section details-reply-settings">
     <h3>回复设置</h3>
     <ChannelReplyControls v-if="channel" :conversation="conversation" :scheduler-enabled="state.capabilities?.channelGroupSchedulerV2?state.settings.channelGroupSchedulerEffective?.enabled===true:state.settings.groupScheduler?.enabled===true" :active="running('details')&&!readOnly" @refresh="emit('refresh')" @notice="emit('notice',$event)" @error="emit('error',$event)"/>
    <DesktopGroupModeratorControls v-if="conversation.channel==='desktop'&&conversation.kind==='group'" :conversation="conversation" :supported="state.capabilities?.desktopGroupModeratorV1===true" :active="running('details')&&!readOnly" @refresh="emit('refresh')" @notice="emit('notice',$event)"/>
     <GroupSchedulerControls :conversation="conversation" :characters="state.characters" :supported="state.capabilities?.channelGroupSchedulerV2===true" :active="running('details')&&!readOnly" @refresh="emit('refresh')" @notice="emit('notice',$event)"/>
    </section>
   </section>
   <section v-if="available('groups')" v-show="paneVisible('groups')" :id="`${panelId}-groups`" class="details-content" role="tabpanel" :aria-labelledby="`${panelId}-groups-tab`" :inert="!paneVisible('groups')" tabindex="0">
    <section class="details-section">
     <div class="details-section-heading"><h3>参与角色</h3><TooltipButton label="添加角色" icon="plus" :size="18" :disabled="!running('groups')||readOnly" @click="emit('add')"/></div>
     <div class="details-member-list"><div v-for="person in participants" :key="person.id" class="details-member"><CharacterAvatar :person="person" :active="active&&!overlayBlocked"/><span>{{person.name}}</span></div></div>
     <p v-if="!participants.length" class="details-empty">暂无参与角色</p>
    </section>
    <section v-if="related.length" class="details-section details-related"><h3>相关群聊</h3><button v-for="group in related" :key="group.id" type="button" class="details-action" :disabled="!running('groups')" @click="emit('select',group.id)"><Icon name="people" :size="18"/><span>{{channelConversationName(group)}}</span><Icon name="chevron" :size="16"/></button></section>
   </section>
   <section v-if="available('logs')" v-show="paneVisible('logs')" :id="`${panelId}-logs`" class="details-content details-logs" role="tabpanel" :aria-labelledby="`${panelId}-logs-tab`" :inert="!paneVisible('logs')" tabindex="0">
    <ConversationUsageDashboard v-if="conversation" :conversation-id="conversation.id" :active="running('logs')" :revision="observability?.summary" :summary="observability?.summary" :items="observability?.items??[]" :loading="observabilityLoading" :has-more="observability?.hasMore" :show-turn-usage="preferences?.perRound" @round="emit('selectLogRound',$event)" @more="emit('moreLogs')" @update:show-turn-usage="emit('update:preferences',{perRound:$event})"/>
    <ChannelSchedulerStatus v-if="state.capabilities?.channelGroupSchedulerV2&&conversation?.channel!=='desktop'&&conversation?.kind==='group'" :conversation="conversation" :characters="state.characters" :states="state.channelScheduler??[]" :active="running('logs')"/>
    <ConversationObservability :key="conversation?.id" :items="observability?.items??[]" :loading="observabilityLoading" :error="observabilityError" :has-more="observability?.hasMore" :category="logCategory??'all'" :rounds="logRounds??[]" :round-selection="logRound??'latest'" :unassigned-count="logUnassignedCount??0" @round="emit('selectLogRound',$event)" @filter="emit('filterLogs',$event as ObservabilityFilter)" @more="emit('moreLogs')" @retry="emit('retryLogs')"/>
   </section>
  </div>
 </aside>
</template>

<style scoped>
.redesigned-details{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.details-toolbar{display:flex;justify-content:flex-end;align-items:center;padding:8px 12px 0;flex:none}
.details-toolbar :deep(.icon-button){width:32px;height:32px;min-width:32px;min-height:32px;border-radius:50%}
.details-identity{display:flex;flex:none;flex-direction:column;align-items:center;padding:0 16px 20px;gap:12px;min-width:0}
.details-portrait{width:96px;height:96px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--muted)}
.details-portrait :deep(.avatar){width:72px;height:72px;flex:0 0 72px}
.details-portrait :deep(.pet-renderer){width:100%;height:100%}
.details-pet-retry{font-size:13px;line-height:20px;padding:0 8px}
.details-identity h2{font-size:18px;line-height:24px;font-weight:500;margin:0;max-width:100%;text-align:center;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;max-height:72px;overflow:hidden}
.details-role-picker{display:flex;flex-wrap:nowrap;justify-content:flex-start;gap:8px;width:max-content;max-width:100%;padding:4px;overflow-x:auto;scrollbar-width:thin}
.details-role-picker button{display:flex;align-items:center;justify-content:center;width:40px;height:40px;flex:none;border-radius:50%;border:2px solid transparent;padding:0}
.details-role-picker :deep(.avatar){width:32px;height:32px;flex:0 0 32px}
.details-role-picker button[aria-pressed=true]{border-color:var(--sand-accent,var(--accent));background:var(--selected)}
.details-tabs{display:flex;flex:none;align-items:center;justify-content:center;gap:8px;padding:0 16px 16px;min-width:0}
.details-tabs>button{font-size:14px;line-height:20px;font-weight:500;padding:4px 12px;border-radius:9999px;white-space:nowrap;color:var(--sand-text-secondary,var(--muted));min-width:0}
.details-tabs>button:hover{background:var(--hover);color:var(--text)}
.details-tabs>button[aria-selected=true]{background:var(--selected);color:var(--sand-text-primary,var(--text))}
.details-panels{min-height:0;min-width:0;flex:1;display:flex;overflow:hidden}
.details-content{height:100%;width:100%;min-width:0;overflow:auto;overscroll-behavior:contain;padding:8px 16px 24px;scrollbar-gutter:stable}
.details-content:focus{outline:none}
.details-content:focus-visible{outline:2px solid var(--sand-focus,var(--accent));outline-offset:-4px}
.details-reply-settings :deep(.channel-reply-controls),.details-reply-settings :deep(.group-scheduler-controls){background:var(--sand-bg-secondary,var(--hover));border-radius:14px;padding:12px;border-bottom:0}
.details-section+.details-section{margin-top:24px}
.details-section>h3,.details-section-heading h3{font-size:13px;line-height:20px;font-weight:500;color:var(--sand-text-secondary,var(--muted));margin:0 0 8px}
.details-rows{border-radius:14px;background:var(--sand-bg-secondary,var(--hover));margin:0;padding:0 12px}
.details-rows>div{display:grid;grid-template-columns:minmax(48px,auto) minmax(0,1fr);align-items:start;gap:16px;padding:12px 0;font-size:14px;line-height:20px}
.details-rows>div+div{border-top:.5px solid var(--faint)}
.details-rows dt{color:var(--sand-text-secondary,var(--muted))}.details-rows dd{margin:0;text-align:right;overflow-wrap:anywhere}
.details-action{display:flex;align-items:center;width:100%;gap:8px;padding:12px;min-width:0;text-align:left;border-radius:14px;background:var(--sand-bg-secondary,var(--hover));font-size:14px;line-height:20px}
.details-action>span{flex:1;min-width:0;overflow-wrap:anywhere}.details-action>svg{flex:none}.details-action:hover{background:var(--hover)}
.details-action+.details-action{margin-top:4px}
.details-section-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.details-section-heading h3{margin:0}
.details-member-list{border-radius:14px;background:var(--sand-bg-secondary,var(--hover));padding:0 12px}
.details-member{display:flex;align-items:center;gap:12px;min-height:56px;padding:8px 0;min-width:0;font-size:14px;line-height:20px}
.details-member+.details-member{border-top:.5px solid var(--faint)}.details-member :deep(.avatar){width:36px;height:36px;flex:0 0 36px}.details-member>span:not(.avatar){min-width:0;overflow-wrap:anywhere}
.details-empty{font-size:14px;line-height:20px;color:var(--muted);margin:8px 0}
.details-logs{padding:0}
@media(max-height:600px){.details-portrait{width:64px;height:64px}.details-portrait :deep(.avatar){width:56px;height:56px;flex-basis:56px}.details-identity{gap:8px;padding-bottom:12px}.details-role-picker button{width:32px;height:32px}.details-role-picker :deep(.avatar){width:24px;height:24px;flex-basis:24px}.details-tabs{padding-bottom:8px}}
</style>
