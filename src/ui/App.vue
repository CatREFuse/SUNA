<script setup lang="ts">
import {ref,reactive,computed,onMounted,onBeforeUnmount,watch,nextTick,provide} from 'vue'
import type {Snapshot,RuntimeStatus,Character,Conversation,ConversationWorkspaceState,RoleSettingsTarget,ConversationTarget,AttachmentDescriptor,ComposerCapabilities,SendBundle,DirectChatInput} from './types'
import {request} from './api'
import {createAppRefreshController} from './app-refresh.mjs'
import {createConversationController,initialConversationState,listConversations,selectRelatedConversation,activeDirectConversation,activeConversationTarget,saveConversationPin,conversationTimestamp} from './conversation-state.mjs'
import Icon from './components/Icon.vue'
import TooltipButton from './components/TooltipButton.vue'
import {channelConversationName} from '../core/channel-display.mjs'
import CharacterAvatar from './components/CharacterAvatar.vue'
import CustomSelect from './components/CustomSelect.vue'
import Modal from './components/Modal.vue'
import ResizableSidebar from './components/ResizableSidebar.vue'
import MessageTimeline from './components/MessageTimeline.vue'
import ChatComposer from './components/ChatComposer.vue'
import type {ComposerAttachment} from './components/ChatComposer.vue'
import {bindComposerOcclusion} from './composer-occlusion.mjs'
import {createSendAnimation} from './composer-morph.mjs'
import {createControlledUploader} from './controlled-attachment-upload.mjs'
import {createComposerDrafts} from './composer-drafts.mjs'
import {directInputPolicy,mergeDirectInputs,receiptDirectInput} from './direct-input-state.mjs'
import {createConversationOutbox} from './conversation-outbox.mjs'
import ConversationTitle from './components/ConversationTitle.vue'
import {readChatLayout,writeChatLayout} from './chat-layout.mjs'
import {fitConversationAside} from './chat-geometry.mjs'
import {createObservabilityController} from './observability-controller.mjs'
import type {ObservabilityPage,ObservabilityFilter} from './conversation-observability'
import ConversationList from './components/ConversationList.vue'
import ConversationSidebarRouter from './components/ConversationSidebarRouter.vue'
import {normalizeManagementTarget,managementUrl} from './management-navigation.mjs'
import ConversationDetails from './components/ConversationDetails.vue'
import FixedClip from './components/FixedClip.vue'
import PetView from './views/PetView.vue'
import {preview} from './preview'
import {createWindowAppearanceBinding} from './window-appearance.mjs'
import {createAccentPalette,isAccentColor} from './accent-color.mjs'
import type {SettingsTarget} from './types'
import {navigationMotion,motionConstants,prefersReducedMotion,sanitizeSnapshotIds} from './ui-motion.mjs'

let managementPage:Window|null=null
const query=new URLSearchParams(location.search)
let initialConversationId=query.get('conversationId')
const designPreview=import.meta.env.DEV&&query.has('preview'),settingsWindow=['settings','management'].includes(query.get('window')??''),nativeMac=window.sandbook?.platform==='darwin',petWindow=!settingsWindow&&query.has('pet')
const state=ref<Snapshot>(designPreview?structuredClone(preview):{characters:[],conversations:[],messages:[],prompts:[],settings:{developerMode:false,theme:'system',petEnabled:false},activity:[]})
if(designPreview&&['light','dark','system'].includes(query.get('theme')??''))state.value.settings.theme=query.get('theme')!
const runtime=ref<RuntimeStatus>({status:'stopped',mode:'bundled',ok:false}),loading=ref(!designPreview),error=ref(''),notice=ref(''),section=ref('chat')
const snapshotReady=ref(designPreview),refreshing=ref(false),settingsOpen=ref(false)
const sidebarRoute=ref<'conversations'|'channels'>('conversations'),sidebarRouter=ref<InstanceType<typeof ConversationSidebarRouter>>()
const personalAvatarFailed=ref(false)
watch(()=>state.value.settings.personalAvatarUrl,()=>{personalAvatarFailed.value=false})
const workspaceMenu=ref<HTMLElement>(),userMenuTrigger=ref<HTMLButtonElement>(),searchOpen=ref(false)
const pinBusyIds=ref<string[]>([])
let lastConversationRequest=0
const workspace=reactive(initialConversationState() as ConversationWorkspaceState)
const outbox=createConversationOutbox({entries:reactive<any[]>([])})
const directReceipts=ref<DirectChatInput[]>([])
const directInputs=computed(()=>mergeDirectInputs(directReceipts.value,state.value.directInputs??[]))
const directPolicy=computed(()=>directInputPolicy({...state.value,directInputs:directInputs.value},selected.value))
function rememberDirectReceipt(receipt:any){const input=receiptDirectInput(receipt);if(input)directReceipts.value=mergeDirectInputs(directReceipts.value,[input])}
watch(()=>state.value.messages,messages=>outbox.reconcile(messages),{flush:'sync'})
const newOpen=ref(false),addOpen=ref(false),addTargetId=ref(''),newTitle=ref(''),chosen=ref<string[]>([]),conversationBusy=ref(false),conversationError=ref('')
const timelineView=ref<InstanceType<typeof MessageTimeline>>()
const timeline=computed(()=>timelineView.value?.element)
const chatPreferences=reactive(readChatLayout(localStorage))
const conversationSidebar=ref<InstanceType<typeof ResizableSidebar>>(),conversationListWidth=ref(280)
const detailsWidth=ref(320),workspaceCard=ref<HTMLElement>(),workspaceSize=ref({width:Math.max(0,innerWidth),height:Math.max(0,innerHeight),narrow:matchMedia('(max-width:768px)').matches})
let workspaceResize:ResizeObserver|undefined
watch(chatPreferences,value=>writeChatLayout(localStorage,value),{deep:true})
const sendProgressVisible=ref(false);let sendProgressTimer:ReturnType<typeof setTimeout>|undefined
const chatSurface=ref<HTMLElement>()
let stopComposerOcclusion:(()=>void)|undefined
const composerView=ref<InstanceType<typeof ChatComposer>>()
const composer=computed(()=>composerView.value?.textarea)
function receiveRoleTarget(target:RoleSettingsTarget){if(petWindow||!target||target.tab!=='permissions')return;void openManagement({section:'characters',characterId:target.characterId,roleSettingsTarget:target})}
const stopRoleTarget=window.sandbook?.onRoleSettingsTarget?.(receiveRoleTarget)
if(query.get('roleSettings')==='permissions'&&query.get('characterId'))receiveRoleTarget({characterId:query.get('characterId')!,tab:'permissions',...(query.get('permissionTool')?{tool:query.get('permissionTool')!}:{}),...(query.get('permissionAccountId')?{accountId:query.get('permissionAccountId')!}:{}),...(query.get('permissionConversationId')?{conversationId:query.get('permissionConversationId')!}:{})})
const panelToggle=ref<InstanceType<typeof TooltipButton>>(),detailsPanel=ref<InstanceType<typeof ConversationDetails>>()
const mobileChat=ref(false),sideOpen=ref(chatPreferences.open),sideOverlay=ref(false),sideTab=ref('appearance'),compact=ref(matchMedia('(max-width:1100px)').matches),modalOpen=ref(false)
const nav=[{id:'chat',label:'对话',icon:'chat'},{id:'channels',label:'频道',icon:'channels'},{id:'characters',label:'角色',icon:'people'},{id:'plugins',label:'插件',icon:'plugin'}]
const chatSection=computed(()=>!settingsWindow),selected=computed(()=>workspace.selected[workspace.scope])
const current=computed(()=>state.value.conversations.find(c=>c.id===selected.value)),participants=computed(()=>state.value.characters.filter(c=>current.value?.participantIds.includes(c.id))),messages=computed(()=>outbox.messages(selected.value,state.value.messages))
const currentReadOnly=computed(()=>current.value?.active===false),activeConversation=computed(()=>activeConversationTarget(current.value,state.value.conversations))
const channelConversations=computed(()=>listConversations(state.value.conversations,'channel',workspace.queries.channel,'all',state.value.characters))
const mainConversations=computed(()=>[...listConversations(state.value.conversations,'desktop',workspace.queries.desktop,'all',state.value.characters),...listConversations(state.value.conversations,'channel',workspace.queries.desktop,'all',state.value.characters).filter((item:Conversation)=>(item as Conversation&{showInMainList?:boolean}).showInMainList===true)].sort((a,b)=>conversationTimestamp(b)-conversationTimestamp(a)||a.id.localeCompare(b.id)))
const conversations=computed(()=>sidebarRoute.value==='channels'?channelConversations.value:mainConversations.value)
const sidebarQuery=computed({get:()=>workspace.queries[sidebarRoute.value==='channels'?'channel':'desktop'],set:(value:string)=>{workspace.queries[sidebarRoute.value==='channels'?'channel':'desktop']=value}})
const active=computed(()=>state.value.activity.filter(a=>a.conversationId===selected.value)),pending=computed(()=>state.value.pending?.filter(a=>a.conversationId===selected.value)??[])
const busyIds=computed(()=>[...new Set([...state.value.activity.map(run=>run.conversationId),...(state.value.pending??[]).map(run=>run.conversationId),...Object.keys(workspace.sending).filter(id=>workspace.sending[id])])])
const channelSenders=reactive<Record<string,string>>({})
const channelSenderId=computed({get:()=>participants.value.length===1?participants.value[0].id:participants.value.some(person=>person.id===channelSenders[selected.value])?channelSenders[selected.value]:'',set:(id:string)=>{conversationController.touchDraft(selected.value);channelSenders[selected.value]=id}})
const channelSender=computed(()=>participants.value.find(person=>person.id===channelSenderId.value))
const channelSendBlocked=computed(()=>!!current.value&&current.value.channel!=='desktop'&&!channelSender.value)
const currentError=computed(()=>conversationController.errorFor(selected.value))
const errorIds=computed(()=>state.value.conversations.filter(item=>conversationController.errorFor(item.id)).map(item=>item.id))
const participantAction=computed(()=>current.value?.kind==='direct'?'创建群聊':'添加角色'),canAddParticipants=computed(()=>!!current.value&&!currentReadOnly.value&&(current.value.channel==='desktop'||current.value.kind==='group'))
const participantTarget=computed(()=>state.value.conversations.find(item=>item.id===addTargetId.value)),modalAction=computed(()=>addOpen.value?(participantTarget.value?.kind==='direct'?'创建群聊':'添加角色'):'新建对话')
const draft=computed({get:()=>workspace.drafts[selected.value]??'',set:(value:string)=>{conversationController.touchDraft(selected.value);workspace.drafts[selected.value]=value}})
type InputAttachment=ComposerAttachment&Partial<AttachmentDescriptor>
const inputWorkspace=workspace
const stagedDrafts=reactive<Record<string,InputAttachment[]>>({})
function attachmentsFor(id:string):InputAttachment[]{return [...(workspace.attachments[id]??[]).map(item=>({...item,...stagedDrafts[id]?.find(draft=>draft.id===item.id),key:stagedDrafts[id]?.find(draft=>draft.id===item.id)?.key??item.id,status:'ready' as const,previewUrl:stagedDrafts[id]?.find(draft=>draft.id===item.id)?.previewUrl??item.url})),...(stagedDrafts[id]??[]).filter(item=>item.status!=='ready')]}
function writeAttachments(id:string,items:InputAttachment[]){stagedDrafts[id]=items;workspace.attachments[id]=items.filter((item):item is InputAttachment&AttachmentDescriptor=>item.status==='ready'&&!!item.id).map(({id,conversationId,kind,name,mime,size,url,width,height})=>({id,conversationId,kind,name,mime,size,url,...(width?{width}:{}),...(height?{height}:{})}))}
const composerAttachments=computed(()=>attachmentsFor(selected.value))
const recoverableBundles=computed(()=>(workspace.failedBundles[selected.value]??[]).filter(bundle=>!bundle.persisted))
const composerReply=computed(()=>{const id=workspace.replyTo[selected.value];if(!id)return undefined;const message=state.value.messages.find(message=>message.id===id&&message.conversationId===selected.value);return {messageId:id,senderName:message?.sender.name??'引用消息',text:message?.text??'原消息不在当前记录中'}})
const inputCapabilities=computed(()=>state.value.capabilities)
const inputConfiguration=ref<ComposerCapabilities|null>(null)
let inputConfigurationRevision=0
async function loadInputConfiguration(id=selected.value){const ticket=++inputConfigurationRevision;if(!state.value.capabilities?.composerAttachmentsV1||!id){inputConfiguration.value=null;return null}try{const result=await request<ComposerCapabilities>(`/conversations/${encodeURIComponent(id)}/composer-capabilities`);if(ticket===inputConfigurationRevision&&id===selected.value)inputConfiguration.value=result;return result}catch{if(ticket===inputConfigurationRevision)inputConfiguration.value=null;return null}}
watch(()=>[selected.value,state.value.capabilities?.composerAttachmentsV1],()=>{inputConfiguration.value=null;void loadInputConfiguration()},{immediate:true})
const attachmentsAvailable=computed(()=>!!inputCapabilities.value?.composerAttachmentsV1&&!!inputConfiguration.value&&(inputConfiguration.value.attachments.images||inputConfiguration.value.attachments.files))
const captureAvailable=computed(()=>!!inputCapabilities.value?.composerScreenCaptureV1&&!!window.sandbook?.captureComposerAttachments&&!!inputConfiguration.value?.attachments.capture&&!!inputConfiguration.value?.eligibleCaptureCharacterIds.length)
const captureBusy=ref(false),captureRoleOpen=ref(false),captureRoleId=ref('')
const captureRoles=computed(()=>participants.value.filter(person=>inputConfiguration.value?.eligibleCaptureCharacterIds.includes(person.id)))
const senderCapability=computed(()=>inputConfiguration.value?.senders.find(sender=>sender.characterId===channelSenderId.value))
const attachmentSendError=computed(()=>{
 if(directPolicy.value.supported&&directPolicy.value.busy&&composerAttachments.value.length)return '角色回复期间暂不支持发送附件；正文、附件与引用已保留'
 if(!current.value||current.value.channel==='desktop'||!composerAttachments.value.length)return ''
 const sender=senderCapability.value;if(!sender)return '请选择可发送附件的角色'
 if(composerAttachments.value.some(item=>item.delivery==='controlled-url'))return '本机受控附件链接仅支持本地会话；内容已保留'
 const files=composerAttachments.value.filter(item=>item.kind==='file'),images=composerAttachments.value.filter(item=>item.kind==='image')
 if(files.length&&!sender.files||images.length&&!sender.images)return sender.reason||'当前渠道不支持发送此附件类型'
 if(files.length&&sender.fileMode==='single'&&(files.length!==1||images.length>0||!!draft.value.trim()||!!composerReply.value))return '当前渠道仅支持单独发送一个文件'
 return ''
})
const nativePickerAvailable=computed(()=>!!window.sandbook?.chooseControlledAttachments&&current.value?.channel==='desktop'&&participants.value.length===1&&!!inputConfiguration.value?.controlledAttachments?.available)
type NativePickerOperation={requestId:string;conversationId:string;busy:boolean;unknown:boolean}
const nativePickerRequest=ref<NativePickerOperation>()
const nativePickerBusy=computed(()=>nativePickerRequest.value?.busy===true)
const nativePickerUnknown=computed(()=>nativePickerRequest.value?.unknown===true)
const nativePickerPending=computed(()=>nativePickerRequest.value?.conversationId===selected.value&&(nativePickerBusy.value||nativePickerUnknown.value))
function cancelNativePicker(){const op=nativePickerRequest.value;if(!op)return;nativePickerRequest.value=undefined;void window.sandbook?.cancelControlledAttachments?.({requestId:op.requestId}).catch(()=>{})}
async function acceptNativeAttachments(result:{status?:string;cancelled?:boolean;attachments:AttachmentDescriptor[]},op:NativePickerOperation){
 if(nativePickerRequest.value!==op)return
 if(result.cancelled){nativePickerRequest.value=undefined;return}
 if(result.status==='unknown'){op.unknown=true;return}
 const attachments=result.attachments.map(a=>verifiedAttachment(a,op.conversationId)),previous=attachmentsFor(op.conversationId)
 if(previous.length+attachments.length>16||[...previous,...attachments].reduce((n,a)=>n+(a.size??0),0)>1024*1024*1024)throw Error('附件数量或总大小超出限制；原草稿已保留')
 writeAttachments(op.conversationId,[...previous,...attachments.map(a=>({...a,key:crypto.randomUUID(),status:'ready' as const}))]);conversationController.touchDraft(op.conversationId);nativePickerRequest.value=undefined
}
async function resumeNativePicker(){const op=nativePickerRequest.value;if(!op||op.busy||!window.sandbook?.resumeControlledAttachments)return;op.busy=true;try{await acceptNativeAttachments(await window.sandbook.resumeControlledAttachments({requestId:op.requestId}),op)}catch(error){if(nativePickerRequest.value===op)toast(error instanceof Error?error.message:'附件查询失败')}finally{if(nativePickerRequest.value===op)op.busy=false}}
async function chooseNativeFiles(source:'file'|'image'){
 const conv=current.value;if(!conv||conv.participantIds.length!==1||!window.sandbook?.chooseControlledAttachments||nativePickerRequest.value)return
 const op=reactive<NativePickerOperation>({requestId:crypto.randomUUID(),conversationId:conv.id,busy:true,unknown:false});nativePickerRequest.value=op
 try{await acceptNativeAttachments(await window.sandbook.chooseControlledAttachments({requestId:op.requestId,conversationId:op.conversationId,characterId:conv.participantIds[0],imagesOnly:source==='image'}),op)}catch(error){if(nativePickerRequest.value===op){toast(error instanceof Error?error.message:'附件上传失败');nativePickerRequest.value=undefined}}finally{if(nativePickerRequest.value===op)op.busy=false}
}
const attachmentDownload=ref<{conversationId:string;attachmentId:string}|null>(null),downloadRoleId=ref('')
async function startAttachmentDownload(conversationId:string,attachmentId:string,characterId:string){
 if(!window.sandbook?.downloadControlledAttachment){toast('请通过桌面应用下载附件');return}
 try{await window.sandbook.downloadControlledAttachment({conversationId,attachmentId,characterId,requestId:crypto.randomUUID()});attachmentDownload.value=null}catch(error){toast(error instanceof Error?error.message:'附件下载失败')}
}
provide('downloadControlledAttachment',(conversationId:string,attachmentId:string)=>{const conv=state.value.conversations.find(c=>c.id===conversationId);if(!conv||!window.sandbook?.downloadControlledAttachment){toast('请通过桌面应用下载附件');return}if(conv.participantIds.length===1)void startAttachmentDownload(conversationId,attachmentId,conv.participantIds[0]);else{attachmentDownload.value={conversationId,attachmentId};downloadRoleId.value=''}})
const downloadRoleOptions=computed(()=>{const conv=state.value.conversations.find(c=>c.id===attachmentDownload.value?.conversationId);return [{value:'',label:'选择角色'},...(conv?.participantIds??[]).map(id=>({value:id,label:state.value.characters.find(c=>c.id===id)?.name??id}))]})
let captureOperation:{requestId:string;conversationId:string;cancelled:boolean}|undefined
function quoteMessage(message:Snapshot['messages'][number]){if(message.conversationId!==selected.value||!inputCapabilities.value?.messageReferencesV1)return;conversationController.touchDraft(selected.value);workspace.replyTo[selected.value]=message.id;void nextTick(()=>composerView.value?.focus())}
function clearReply(){conversationController.touchDraft(selected.value);delete workspace.replyTo[selected.value]}
function verifiedAttachment(value:AttachmentDescriptor,id:string){if(!value||value.conversationId!==id||!value.id||!['image','file'].includes(value.kind)||!Number.isSafeInteger(value.size)||value.size<0)throw Error('附件返回信息无效');const validUrl=value.delivery==='controlled-url'?value.kind==='file'&&/^url_[a-f0-9]{48}$/.test(value.id)&&value.url===`/api/conversations/${encodeURIComponent(id)}/controlled-attachments/${value.id}/download`:value.kind==='image'?/^\/media-local\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/.test(value.url):value.url===`/api/conversations/${encodeURIComponent(id)}/attachments/${encodeURIComponent(value.id)}/download`;if(!validUrl)throw Error('附件地址无效');return value}
const controlledFiles=new WeakSet<File>()
const controlledUploader=createControlledUploader({request})
const attachmentDrafts=createComposerDrafts({read:attachmentsFor,write:writeAttachments,stage:async(id:string,file:File,signal:AbortSignal,key:string,progress:(value:{loaded:number;total:number})=>void)=>{
 const limit=file.type.startsWith('image/')?32*1024*1024:16*1024*1024;if(file.size===0||file.type.startsWith('image/')&&!/^image\/(png|jpeg|gif|webp)$/.test(file.type)||file.size>limit||controlledFiles.has(file)){const result=await controlledUploader.stage(id,file,signal,key,progress);return verifiedAttachment(result,id)}
 const bytes=new Uint8Array(await file.arrayBuffer());if(signal.aborted)throw Error('已取消');let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192))
 const result=await request<{attachment:AttachmentDescriptor}>(`/conversations/${encodeURIComponent(id)}/attachments`,{requestId:crypto.randomUUID(),name:file.name,mime:file.type,data:btoa(binary)},undefined,false,signal);return verifiedAttachment(result.attachment,id)
}})
async function insertFiles(files:File[],source:string,conversationId=selected.value){
 const conversation=state.value.conversations.find(item=>item.id===conversationId);if(!conversation||conversation.active===false||!inputCapabilities.value?.composerAttachmentsV1)return
 const config=conversationId===selected.value?inputConfiguration.value:await request<ComposerCapabilities>(`/conversations/${encodeURIComponent(conversationId)}/composer-capabilities`).catch(()=>null);if(!config)return
 const limits=config.attachments.limits,existing=attachmentsFor(conversationId),total=existing.reduce((sum,item)=>sum+(item.size??0),0)+files.reduce((sum,file)=>sum+file.size,0)
 if(existing.length+files.length>limits.maxAttachments||total>(config.controlledAttachments?.available?config.controlledAttachments.limits.totalBytes:limits.maxTotalBytes)){toast('附件数量或总大小超出限制');return}
 if(files.some(file=>{const image=file.type.startsWith('image/');return image?!config.attachments.images||file.size>(config.controlledAttachments?.available?config.controlledAttachments.limits.fileBytes:limits.maxImageBytes):!config.attachments.files||file.size>(config.controlledAttachments?.available?config.controlledAttachments.limits.fileBytes:limits.maxFileBytes)})){toast('该附件类型不可用或文件过大');return}
 if(source==='image'&&files.some(file=>!file.type.startsWith('image/'))){toast('请选择图片文件');return}
 let inlineBytes=existing.filter(item=>item.delivery!=='controlled-url').reduce((n,item)=>n+(item.size??0),0);for(const file of files){const threshold=file.type.startsWith('image/')?limits.maxImageBytes:limits.maxFileBytes;if(file.size===0||file.type.startsWith('image/')&&!/^image\/(png|jpeg|gif|webp)$/.test(file.type)||file.size>threshold||inlineBytes+file.size>limits.maxTotalBytes){if(!config.controlledAttachments?.available){toast('附件总大小超出限制');return}controlledFiles.add(file)}else inlineBytes+=file.size}
 conversationController.touchDraft(conversationId);await attachmentDrafts.add(conversationId,files)
}
function retryAttachment(key:string){void attachmentDrafts.retry(selected.value,key)}
function detachAttachment(key:string){controlledUploader.forget(key);conversationController.touchDraft(selected.value);attachmentDrafts.detach(selected.value,key)}
function cancelCapture(){const operation=captureOperation;if(!operation)return;operation.cancelled=true;captureOperation=undefined;captureBusy.value=false;void window.sandbook?.cancelComposerCapture?.({requestId:operation.requestId}).catch(()=>{})}
async function captureAttachment(){if(!captureAvailable.value||captureBusy.value)return;const id=selected.value,config=await loadInputConfiguration(id);if(id!==selected.value||!config?.attachments.capture)return;if(participants.value.length!==1){captureRoleId.value='';captureRoleOpen.value=true;return}await performCapture(participants.value[0].id)}
async function performCapture(characterId=captureRoleId.value){
 if(!captureAvailable.value||captureBusy.value||!inputConfiguration.value?.eligibleCaptureCharacterIds.includes(characterId)||!window.sandbook?.captureComposerAttachments)return
 captureRoleOpen.value=false;const id=selected.value,operation={requestId:crypto.randomUUID(),conversationId:id,cancelled:false};captureOperation=operation;captureBusy.value=true
 try{const result=await window.sandbook.captureComposerAttachments({conversationId:id,characterId,requestId:operation.requestId});if(operation.cancelled||captureOperation!==operation)return;const incoming=result.attachments.map(item=>verifiedAttachment(item,id)),existing=attachmentsFor(id),limits=inputConfiguration.value?.attachments.limits;if(!limits||existing.length+incoming.length>limits.maxAttachments||[...existing,...incoming].reduce((sum,item)=>sum+(item.size??0),0)>limits.maxTotalBytes)throw Error('截屏数量或大小超出附件限制');conversationController.touchDraft(id);writeAttachments(id,[...existing,...incoming.map(item=>({...item,key:item.id,previewUrl:item.url,status:'ready' as const}))])}catch(cause){if(!operation.cancelled)toast(friendlyError(cause))}finally{if(captureOperation===operation){captureOperation=undefined;captureBusy.value=false}}
}
function recoverBundle(bundle:any){const id=bundle.conversationId;if(bundle.characterId&&id===selected.value&&draft.value.trim()&&channelSenderId.value!==bundle.characterId){toast('当前草稿使用其他发送身份，请先处理当前草稿');return}if(conversationController.recover(id,bundle.requestId)&&bundle.characterId)channelSenders[id]=bundle.characterId}
async function queryMessageReceipt(message:Snapshot['messages'][number]){if(!message.requestId||!(inputCapabilities.value?.messageSendReceiptsV1||inputCapabilities.value?.directChatSteerV1))return;try{const receipt=await request(`/conversations/${encodeURIComponent(message.conversationId)}/send-requests/${encodeURIComponent(message.requestId)}`);if(receipt.conversationId!==message.conversationId||receipt.requestId!==message.requestId)throw Error('发送回执不匹配');rememberDirectReceipt(receipt);outbox.reconcile(state.value.messages,[receipt]);await refresh();if(receipt.status==='unknown')toast('发送结果仍待确认')}catch(cause){toast(friendlyError(cause))}}
async function querySend(bundle:any){try{const receipt=await conversationController.reconcileSend(bundle.conversationId,bundle.requestId,{onResult:(result:any)=>{rememberDirectReceipt(result);outbox.reconcile(state.value.messages,[result])}});if(!receipt)toast('尚未查到发送记录，请稍后查询或重试相同内容')}catch(cause){toast(friendlyError(cause))}}
const sidebarGeometry=computed(()=>({width:fitConversationAside({workspaceWidth:workspaceSize.value.width,listWidth:conversationListWidth.value,preferredWidth:detailsWidth.value,narrow:workspaceSize.value.narrow,overlay:compact.value}),height:workspaceSize.value.height}))
const panelVisible=computed(()=>chatSection.value&&!!current.value&&(compact.value?sideOverlay.value:sideOpen.value))
watch(sideOpen,value=>{chatPreferences.open=value})
const observability=ref<ObservabilityPage|null>(null),observabilityLoading=ref(false),observabilityError=ref(''),logCategory=ref<ObservabilityFilter>('all'),logRound=ref('latest'),logRounds=ref<NonNullable<ObservabilityPage['rounds']>>([]),logUnassignedCount=ref(0)
const observabilityContext=()=>({enabled:!designPreview&&!settingsWindow&&!petWindow&&state.value.settings.developerMode&&chatSection.value&&Boolean(current.value)&&(panelVisible.value||chatPreferences.perRound),conversationId:current.value?.id??'',category:logCategory.value,roundSelection:logRound.value})
const observabilityController=createObservabilityController({request,readContext:observabilityContext,onChange:(value:{page:ObservabilityPage|null;loading:boolean;error:string})=>{observability.value=value.page;if(value.page?.rounds){logRounds.value=value.page.rounds;logUnassignedCount.value=value.page.unassignedCount??0}else if(!value.page&&value.error){logRounds.value=[];logUnassignedCount.value=0}observabilityLoading.value=value.loading;observabilityError.value=value.error}})
watch(selected,()=>{logRound.value='latest';logRounds.value=[];logUnassignedCount.value=0},{flush:'sync'})
watch(()=>state.value.settings.developerMode,value=>{if(!value){logRounds.value=[];logUnassignedCount.value=0;logRound.value='latest'}},{flush:'sync'})
watch(()=>[observabilityContext().enabled,selected.value,logCategory.value,logRound.value],()=>{void observabilityController.setContext()},{immediate:true})
function updateChatPreferences(value:Partial<typeof chatPreferences>){Object.assign(chatPreferences,value)}
const conversationName=computed(()=>current.value?.kind==='direct'&&current.value.channel==='desktop'?participants.value[0]?.name??current.value.title:current.value?channelConversationName(current.value):workspace.scope==='channel'?'Channel':'对话')
const unreadTotals=computed(()=>({chat:state.value.conversations.filter(c=>c.channel==='desktop').reduce((n,c)=>n+(c.unreadCount??0),0),channels:state.value.conversations.filter(c=>c.channel!=='desktop').reduce((n,c)=>n+(c.unreadCount??0),0)} as Record<string,number>))
let reading=false
async function readVisible(){if(reading||designPreview||settingsWindow||petWindow||document.hidden||!document.hasFocus()||!chatSection.value||modalOpen.value||newOpen.value||addOpen.value||!current.value?.unreadCount)return;if(matchMedia('(max-width:768px)').matches&&!mobileChat.value)return;if(timeline.value&&timeline.value.scrollHeight-timeline.value.scrollTop-timeline.value.clientHeight>48)return;const conversation=current.value,sequence=conversation.lastSequence??0;reading=true;try{await request(`/conversations/${encodeURIComponent(conversation.id)}/read`,{sequence});if(conversation.lastSequence===sequence)conversation.unreadCount=0;}catch{}finally{reading=false}}
watch([()=>state.value.messages,selected,section],async()=>{await nextTick();void readVisible()},{flush:'post'})
let events:EventSource|undefined,timer:ReturnType<typeof setTimeout>|undefined,noticeTimer:ReturnType<typeof setTimeout>,poll:ReturnType<typeof setInterval>,media:MediaQueryList,layoutMedia:MediaQueryList,modalObserver:MutationObserver|undefined
function toast(text:string){notice.value=text;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>notice.value='',3500)}
function friendlyError(cause:unknown){const value=cause instanceof Error?cause.message:String(cause);return /no API key|MODEL_NOT_CONFIGURED|model.*not configured/i.test(value)?'未配置模型，请在设置中填写接口与密钥。':value}
function report(cause:unknown){error.value=friendlyError(cause)}
const conversationController=createConversationController({state:workspace,getSnapshot:()=>state.value,request,refresh,formatError:friendlyError})
let refreshError=''
const appRefresh=createAppRefreshController({request,
 onSnapshot:(snapshot:Snapshot)=>{state.value=snapshot;snapshotReady.value=true;loading.value=false;conversationController.reconcile();selectInitialConversation();if(!snapshot.settings.developerMode&&section.value==='developer')changeSection(workspace.scope==='desktop'?'chat':'channels')},
 onRuntime:(status:RuntimeStatus)=>{runtime.value=status},
 onError:(cause:unknown)=>{refreshError=friendlyError(cause);report(cause)},
 onSuccess:()=>{if(error.value===refreshError)error.value='';refreshError=''},
 onSettled:()=>{loading.value=false},onBusy:(busy:boolean)=>{refreshing.value=busy},
})
function refresh(){if(designPreview)return Promise.resolve(false);return appRefresh.refresh()}
async function openSettings(){workspaceMenu.value?.hidePopover();await openManagement({section:'settings'})}
function receiveSettingsTarget(target:SettingsTarget){if(!petWindow)void openManagement({section:'settings',settingsTarget:target})}
const stopSettingsTarget=window.sandbook?.onSettingsTarget?.(receiveSettingsTarget)
function menuSection(value:string){workspaceMenu.value?.hidePopover();userMenuTrigger.value?.focus();if(value==='chat'){setSidebarRoute('conversations');return}if(value==='developer'){void openManagement({section:'settings',settingsTarget:{tab:'developer'}});return}void openManagement({section:value==='channel-admin'?'channels':value})}
async function toggleWorkspaceMenu(){const node=workspaceMenu.value;if(!node)return;const open=node.matches(':popover-open');node.togglePopover();await nextTick();if(!open)node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();else userMenuTrigger.value?.focus()}
function outsideWorkspaceMenu(event:PointerEvent){const target=event.target as Node|null;if(target&&workspaceMenu.value?.matches(':popover-open')&&!workspaceMenu.value.contains(target)&&!userMenuTrigger.value?.contains(target))workspaceMenu.value.hidePopover()}
function workspaceMenuKey(event:KeyboardEvent){if(event.isComposing||event.keyCode===229)return;const items=Array.from(workspaceMenu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);if(event.key==='Escape'){event.preventDefault();workspaceMenu.value?.hidePopover();userMenuTrigger.value?.focus();return}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||!items.length)return;event.preventDefault();const index=items.indexOf(document.activeElement as HTMLButtonElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,index+(event.key==='ArrowDown'?1:-1)));items[next]?.focus()}
async function showSearch(){const fromMenu=workspaceMenu.value?.matches(':popover-open');workspaceMenu.value?.hidePopover();if(fromMenu)userMenuTrigger.value?.focus();searchOpen.value=true;await nextTick();document.querySelector<HTMLInputElement>('.workspace-search-input input')?.focus()}
function searchConversationName(conversation:Conversation){return conversation.channel==='desktop'&&conversation.kind==='direct'?character(conversation.participantIds[0])?.name??conversation.title:channelConversationName(conversation)}
async function chooseSearchConversation(id:string){searchOpen.value=false;selectConversation(id);await nextTick();await nextTick();composer.value?.focus({preventScroll:true})}

function measureComposer(source='edit'){return composerView.value?.measure(source)}

function settingsShortcut(event:KeyboardEvent){if((event.metaKey||event.ctrlKey)&&event.key==='k'&&!modalOpen.value){event.preventDefault();void showSearch();return}if((event.metaKey||event.ctrlKey)&&event.key===','){event.preventDefault();void openSettings()}}

let transitionRevision=0
const navigationAnimations=new Set<Animation>(),navigationSnapshots=new Set<HTMLElement>(),navigationTimers=new Set<ReturnType<typeof setTimeout>>()
function animateWorkspace(commit:()=>void,options:{mobile?:boolean;back?:boolean}={}){
 const root=workspaceCard.value,revision=++transitionRevision
 for(const animation of navigationAnimations)animation.cancel();navigationAnimations.clear()
 for(const snapshot of navigationSnapshots)snapshot.remove();navigationSnapshots.clear();for(const timer of navigationTimers)clearTimeout(timer);navigationTimers.clear()
 const oldNode=options.mobile?root?.querySelector<HTMLElement>(mobileChat.value?'.workspace-main':'.conversation-sidebar'):root?.querySelector<HTMLElement>('.workspace-main')
 let snapshot:HTMLElement|undefined
 if(root&&oldNode&&oldNode.getClientRects().length&&!prefersReducedMotion()&&!active.value.length&&!pending.value.length&&oldNode.querySelectorAll('*').length<=motionConstants.snapshotMaxNodes&&!oldNode.querySelector('video,canvas')){
  const box=oldNode.getBoundingClientRect(),parent=root.getBoundingClientRect();snapshot=oldNode.cloneNode(true) as HTMLElement;snapshot.inert=true;snapshot.setAttribute('aria-hidden','true');sanitizeSnapshotIds(snapshot);snapshot.classList.add('navigation-snapshot');Object.assign(snapshot.style,{position:'absolute',inset:'auto',left:`${box.left-parent.left}px`,top:`${box.top-parent.top}px`,width:`${box.width}px`,height:`${box.height}px`,margin:'0',maxWidth:'none',pointerEvents:'none',zIndex:'30'});root.append(snapshot);navigationSnapshots.add(snapshot)
 }
 commit()
 void nextTick(()=>{if(revision!==transitionRevision){snapshot?.remove();return}const incoming=options.mobile?root?.querySelector<HTMLElement>(mobileChat.value?'.workspace-main':'.conversation-sidebar'):root?.querySelector<HTMLElement>('.workspace-main');const animations=navigationMotion(incoming,snapshot,{direction:options.back?'pop':'push',variant:options.mobile?'wipe':'crossfade'});for(const animation of animations){navigationAnimations.add(animation);void animation.finished.catch(()=>{}).finally(()=>navigationAnimations.delete(animation))}if(snapshot){const outgoing=snapshot;const done=()=>{outgoing.remove();navigationSnapshots.delete(outgoing);clearTimeout(holdTimer);navigationTimers.delete(holdTimer)};const holdTimer=setTimeout(done,motionConstants.snapshotHold);navigationTimers.add(holdTimer);if(animations.length)void Promise.allSettled(animations.map(animation=>animation.finished)).then(done);else done()}})
}
function setMobileChat(value:boolean){if(mobileChat.value===value)return;animateWorkspace(()=>{mobileChat.value=value;sideOverlay.value=false},{mobile:true,back:!value});if(!value)void nextTick(()=>{const pane=sidebarRouter.value?.element?.querySelector<HTMLElement>(`[data-sidebar-page="${sidebarRoute.value}"]`);const row=pane?.querySelector<HTMLElement>(`[data-conversation-id="${CSS.escape(selected.value)}"]`);if(row)row.focus({preventScroll:true});else sidebarRouter.value?.focusActive()})}
function setSidebarRoute(value:'conversations'|'channels'){sidebarRoute.value=value}
function changeSection(value:string){if(value==='chat'){setSidebarRoute('conversations');return}if(value==='channels'){setSidebarRoute('channels');return}void openManagement({section:value==='channel-admin'?'channels':value})}
function selectConversation(id:string){if(!conversationController.select(id))return false;initialConversationId=null;section.value=workspace.scope==='desktop'?'chat':'channels';setMobileChat(true);sideOverlay.value=false;error.value='';return true}
function selectInitialConversation(){const id=initialConversationId;if(id&&!settingsWindow&&!petWindow)selectConversation(id)}
function selectFromDetails(id:string){return selectRelatedConversation(id,{select:selectConversation,afterRender:nextTick,isCurrent:(target:string)=>selected.value===target&&chatSection.value&&!modalOpen.value,focus:()=>{if(composer.value&&!composer.value.disabled)composer.value.focus({preventScroll:true});else panelToggle.value?.focus()}})}
function character(id:string):Character|undefined{return state.value.characters.find(person=>person.id===id)}
function toggleChoice(id:string){chosen.value=chosen.value.includes(id)?chosen.value.filter(value=>value!==id):[...chosen.value,id]}
function openNew(){chosen.value=[];newTitle.value='';conversationError.value='';newOpen.value=true}
function openAdd(){if(!current.value||!canAddParticipants.value)return;addTargetId.value=current.value.id;chosen.value=[];conversationError.value='';addOpen.value=true}
function closeConversationModal(){if(conversationBusy.value)return;newOpen.value=false;addOpen.value=false;conversationError.value=''}
async function createConversation(){if(conversationBusy.value||!chosen.value.length||designPreview)return;conversationBusy.value=true;conversationError.value='';try{const ids=[...chosen.value],conversation=await request<Conversation>('/conversations',{title:newTitle.value.trim()||(ids.length>1?'新建群聊':`与${character(ids[0])?.name??'角色'}的对话`),kind:ids.length>1?'group':'direct',participantIds:ids,channel:'desktop'});await refresh();if(!state.value.conversations.some(item=>item.id===conversation.id))state.value.conversations.push(conversation);selectConversation(conversation.id);newOpen.value=false;newTitle.value=''}catch(cause){conversationError.value=friendlyError(cause)}finally{conversationBusy.value=false}}
async function addParticipants(){if(conversationBusy.value||!chosen.value.length||designPreview)return;const id=addTargetId.value;conversationBusy.value=true;conversationError.value='';try{const result=await request<Conversation>(`/conversations/${encodeURIComponent(id)}/participants`,{ids:[...chosen.value]});await refresh();if(!state.value.conversations.some(item=>item.id===result.id))state.value.conversations.push(result);if(selected.value===id&&chatSection.value)selectConversation(result.id);addOpen.value=false}catch(cause){conversationError.value=friendlyError(cause)}finally{conversationBusy.value=false}}
let sendAnimationRevision=0
let sendAnimation:ReturnType<typeof createSendAnimation>
function invalidateSendAnimation(){sendAnimationRevision++;sendAnimation?.cancel();sendAnimation=null}
function sendVisibilityChanged(){if(document.hidden)invalidateSendAnimation();void readVisible()}
function send(){
 if(designPreview||nativePickerPending.value||!current.value||workspace.sending[selected.value]||channelSendBlocked.value||attachmentSendError.value||directPolicy.value.unavailable||composerAttachments.value.some(item=>item.status!=='ready'))return
 const id=selected.value,conversation=current.value,person=channelSender.value,outgoingAttachments=composerAttachments.value.map(item=>({...item}))
 const sender=conversation.channel==='desktop'?{id:'local-owner',name:'我',type:'human'}:{id:person!.id,name:person!.name,type:'character'}
 invalidateSendAnimation()
 const sourceComposer=composerView.value,revision=sendAnimationRevision
 const ownsAnimation=()=>revision===sendAnimationRevision&&selected.value===id&&chatSection.value&&(!workspaceSize.value.narrow||mobileChat.value)&&!document.hidden&&composerView.value===sourceComposer&&!!sourceComposer?.root?.isConnected
 const withReceipts=inputCapabilities.value?.messageSendReceiptsV1===true||directPolicy.value.supported
 const options={characterId:channelSenderId.value,
  onPrepared:({payload,composerCleared}:any)=>{
   if(!withReceipts)return
   // Capture the old committed composer before Vue clears it. No awaited UI work gates transport.
   try{sendAnimation=composerCleared!==false&&ownsAnimation()?createSendAnimation(sourceComposer?.shell):null}catch{sendAnimation=null}
   const entry=outbox.enqueue(payload,conversation,sender,{localAttachments:outgoingAttachments})
   outbox.mark(id,payload.requestId,'sending')
   if(composerCleared===false)return
   const animation=sendAnimation
   const lease=(()=>{try{return animation?timelineView.value?.reserveSendMorph(entry.renderKey):null}catch{animation?.cancel();return null}})()
   const composerMotion=(()=>{try{return lease?sourceComposer?.startMorph():null}catch{animation?.cancel();lease?.release(false);return null}})()
   void nextTick().then(async()=>{
    if(!ownsAnimation()){animation?.cancel();lease?.release(false);composerMotion?.finish();return}
    await sourceComposer?.measure('submit');if(!ownsAnimation()){animation?.cancel();lease?.release(false);composerMotion?.finish();return}
    await nextTick()
    if(!ownsAnimation()){animation?.cancel();lease?.release(false);composerMotion?.finish();return}
    if(animation&&lease&&composerMotion)animation.play(lease,composerMotion)
    else {animation?.cancel();lease?.release(false);composerMotion?.finish();timelineView.value?.scrollToEnd({immediate:true,force:true})}
   }).catch(()=>{animation?.cancel();lease?.release(false);composerMotion?.finish()})
  },
  onResult:(result:any,{payload}:any)=>{rememberDirectReceipt(result);outbox.reconcile(state.value.messages,[result]);if(result.acceptance!=='persisted')outbox.mark(id,payload.requestId,['failed','cancelled','canceled'].includes(result.status)?'failed':'unknown',result.error)},
  onRejected:(cause:unknown,{payload,classification}:any)=>{outbox.mark(id,payload.requestId,classification==='rejected'?'failed':'unknown',cause)},
 }
 void conversationController.send(id,options)
}
async function showPet(id?:string){if(!window.sandbook){toast('请在桌面应用中显示桌宠');return}try{await window.sandbook.togglePet(id??participants.value[0]?.id)}catch(cause){report(cause)}}
async function chatWithCharacter(id:string){const existing=activeDirectConversation(state.value.conversations,id);if(existing){selectConversation(existing.id);return}if(designPreview){toast('设计预览未创建对话');return}try{const conversation=await request<Conversation>('/conversations',{title:`与${character(id)?.name??'角色'}的对话`,kind:'direct',participantIds:[id],channel:'desktop'});await refresh();selectConversation(conversation.id)}catch(cause){report(cause)}}
async function setConversationPinned(id:string,pinned:boolean){
 if(designPreview||pinBusyIds.value.includes(id))return false
 pinBusyIds.value=[...pinBusyIds.value,id]
 try{await saveConversationPin({id,pinned,getSnapshot:()=>state.value,request});await refresh();toast(pinned?'对话已置顶':'已取消置顶');return true}
 catch(cause){report(cause);return false}
 finally{pinBusyIds.value=pinBusyIds.value.filter(value=>value!==id)}
}
function editCharacter(id:string){void openManagement({section:'characters',characterId:id})}
async function togglePanel(){if(compact.value){if(sideOverlay.value){closePanel();return}sideOverlay.value=true;await nextTick();detailsPanel.value?.focusSelectedTab()}else sideOpen.value=!sideOpen.value}
async function closePanel(){if(compact.value){sideOverlay.value=false;await nextTick();panelToggle.value?.focus()}else sideOpen.value=false}
function panelKey(event:KeyboardEvent){
 if(event.isComposing||event.keyCode===229)return
 if(!compact.value||!sideOverlay.value||modalOpen.value)return
 if(event.key==='Escape'){event.preventDefault();void closePanel();return}
 if(event.key==='Tab'){
  const root=detailsPanel.value?.$el as HTMLElement|undefined
  const nodes=Array.from(root?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')??[]).filter(node=>node.tabIndex>=0&&node.getClientRects().length&&!node.closest('[inert]'))
  const first=nodes[0],last=nodes.at(-1)
  if(!first)return
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
  else if(!root?.contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first)?.focus()}
 }
}
function keydown(event:KeyboardEvent){if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();send()}}
function theme(){const value=state.value.settings.theme;void window.sandbook?.setTheme?.(value==='light'||value==='dark'?value:'system').catch(()=>{});const dark=value==='system'?(media?.matches??false):value==='dark';document.documentElement.dataset.theme=dark?'dark':'light';const color=state.value.settings.accentColor,style=document.documentElement.style;const keys=['--sand-bg-accent-primary','--sand-bg-accent-primary-hover','--sand-bg-accent-secondary','--sand-text-accent-primary','--sand-icon-accent-primary','--sand-border-accent-primary','--on-accent'];if(isAccentColor(color)){const palette=createAccentPalette(color,dark,state.value.settings.accentTextMode),values=[palette['--accent'],palette['--accent-hover'],palette['--accent-soft'],palette['--accent-ink'],palette['--accent'],palette['--accent'],palette['--on-accent']];keys.forEach((key,index)=>style.setProperty(key,values[index]))}else keys.forEach(key=>style.removeProperty(key))}

// Management and chat retain separate Vue trees; refresh events update each from the server.
async function openManagement(value:Record<string,unknown>={section:'channels'}){
 const target=normalizeManagementTarget(value);if(!target){report(new Error('管理页面目标无效'));return}
 try{
  const bridge=window.sandbook as typeof window.sandbook&{openManagement?:(value:unknown)=>Promise<void>}
  if(bridge){if(!bridge.openManagement)throw new Error('当前桌面版本不支持管理窗口，请更新应用');const {requestId,...requestTarget}=target;if(requestTarget.roleSettingsTarget){const {requestId,...role}=requestTarget.roleSettingsTarget;requestTarget.roleSettingsTarget=role}await bridge.openManagement(requestTarget);return}
  if(managementPage&&!managementPage.closed){managementPage.postMessage({type:'suna:management-target',target},location.origin);managementPage.focus();return}
  managementPage=window.open(managementUrl(location.href,target),'suna-management','popup,width=1120,height=800');if(!managementPage)throw new Error('管理窗口未打开，请允许此站点打开窗口')
 }catch(cause){report(cause)}
}
function receiveWindowMessage(event:MessageEvent){if(event.origin!==location.origin)return;if(!settingsWindow&&event.source===managementPage&&event.data?.type==='suna:conversation-target'){const id=event.data.conversationId;if(id===undefined||typeof id==='string'&&state.value.conversations.some(item=>item.id===id)){if(id)selectConversation(id);window.focus()}}}
const managementBridge=window.sandbook as typeof window.sandbook&{onManagementTarget?:(callback:(target:unknown)=>void)=>()=>void;onConversationTarget?:(callback:(target:unknown)=>void)=>()=>void}
function receiveConversationTarget(target:ConversationTarget){
 if(settingsWindow||petWindow||!Number.isSafeInteger(target?.requestId)||target.requestId<=lastConversationRequest||typeof target.conversationId!=='string')return
 lastConversationRequest=target.requestId;initialConversationId=target.conversationId
 if(snapshotReady.value&&selectConversation(target.conversationId))return
 void refresh()
}
const stopConversationTarget=managementBridge?.onConversationTarget?.(target=>receiveConversationTarget(target as ConversationTarget))
window.addEventListener('message',receiveWindowMessage)

const windowAppearance=createWindowAppearanceBinding({bridge:window.sandbook,readPreference:()=>state.value.settings.appearance,style:document.documentElement.style,onError:report})
function layout(){compact.value=layoutMedia.matches;sideOverlay.value=false}
function trackModal(){modalOpen.value=!!document.querySelector('dialog[open]')}
watch([()=>state.value.settings.theme,()=>state.value.settings.accentColor,()=>state.value.settings.accentTextMode],theme)
watch(()=>JSON.stringify(state.value.settings.appearance??null),windowAppearance.applyPreferences)
watch(selected,()=>{invalidateSendAnimation();cancelCapture();captureRoleOpen.value=false;void measureComposer()})
watch(captureAvailable,available=>{if(!available)cancelCapture()})
watch(()=>chatSection.value&&(!workspaceSize.value.narrow||mobileChat.value),visible=>{if(!visible)invalidateSendAnimation()})
watch(draft,()=>measureComposer(),{flush:'post'})
watch(()=>[selected.value,!!workspace.sending[selected.value]],()=>{clearTimeout(sendProgressTimer);sendProgressVisible.value=false;const id=selected.value;if(workspace.sending[id])sendProgressTimer=setTimeout(()=>{if(selected.value===id&&workspace.sending[id])sendProgressVisible.value=true},motionConstants.progressReveal)})
onMounted(async()=>{if(chatSurface.value)stopComposerOcclusion=bindComposerOcclusion(chatSurface.value);if(nativeMac&&!petWindow)document.documentElement.classList.add('native-material-host');if(workspaceCard.value){const list=conversationSidebar.value?.$el as HTMLElement|undefined;const measure=()=>{const node=workspaceCard.value!;conversationListWidth.value=list?.getBoundingClientRect().width??0;workspaceSize.value={width:node.clientWidth,height:node.clientHeight,narrow:matchMedia('(max-width:768px)').matches};void measureComposer('layout')};measure();workspaceResize=new ResizeObserver(measure);workspaceResize.observe(workspaceCard.value);if(list)workspaceResize.observe(list)}window.addEventListener('focus',readVisible);window.addEventListener('keydown',settingsShortcut);document.addEventListener('pointerdown',outsideWorkspaceMenu);document.addEventListener('visibilitychange',sendVisibilityChanged);media=matchMedia('(prefers-color-scheme: dark)');media.addEventListener('change',theme);theme();windowAppearance.start();layoutMedia=matchMedia('(max-width:1100px)');layoutMedia.addEventListener('change',layout);modalObserver=new MutationObserver(trackModal);modalObserver.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open'],childList:true});if(designPreview){runtime.value={status:'stopped',mode:'bundled',ok:false,modelConfigured:false};conversationController.reconcile();return}try{events=new EventSource('/api/events');events.onmessage=event=>{let update;try{update=JSON.parse(event.data)}catch{}if(update?.type==='conversation-observability.changed'){observabilityController.onEvent(update);return}if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh()},80)};events.onerror=()=>{}}catch(cause){report(cause)}poll=setInterval(()=>{void appRefresh.refresh({queue:false})},10000);await refresh()})
onBeforeUnmount(()=>{stopComposerOcclusion?.();inputConfigurationRevision++;cancelCapture();invalidateSendAnimation();attachmentDrafts.dispose();controlledUploader.dispose();cancelNativePicker();document.documentElement.classList.remove('native-material-host');clearTimeout(sendProgressTimer);for(const timer of navigationTimers)clearTimeout(timer);for(const animation of navigationAnimations)animation.cancel();for(const snapshot of navigationSnapshots)snapshot.remove();appRefresh.close();stopRoleTarget?.();stopConversationTarget?.();window.removeEventListener('message',receiveWindowMessage);workspaceResize?.disconnect();observabilityController.close();windowAppearance.close();window.removeEventListener('focus',readVisible);window.removeEventListener('keydown',settingsShortcut);document.removeEventListener('pointerdown',outsideWorkspaceMenu);stopSettingsTarget?.();document.removeEventListener('visibilitychange',sendVisibilityChanged);events?.close();clearInterval(poll);clearTimeout(timer);clearTimeout(noticeTimer);media?.removeEventListener('change',theme);layoutMedia?.removeEventListener('change',layout);modalObserver?.disconnect()})
</script>

<template>
  <PetView v-if="petWindow" :state="state" @error="report"/>
  <div v-else class="workspace-shell" @keydown="panelKey">
    <div class="workspace-layout" :class="{'has-conversations':chatSection,'has-details':panelVisible&&!compact,'mobile-chat':mobileChat,'mobile-details':panelVisible&&compact}">
      <div ref="workspaceCard" class="workspace-content">
      <ResizableSidebar ref="conversationSidebar" :inert="compact&&panelVisible" class="conversation-sidebar" name="会话列表" storage-key="conversations" :width="280" :min="130" :max="420">
       <aside class="workspace-sidebar" aria-label="工作区">
        <header class="sidebar-chrome"><span class="native-title-space" aria-hidden="true"/><TooltipButton label="搜索对话" icon="search" class="elevated circle" @click="showSearch"/><TooltipButton v-if="sidebarRoute==='conversations'" label="新建对话" icon="plus" class="elevated circle" @click="openNew"/></header>

        <ConversationSidebarRouter ref="sidebarRouter" :route="sidebarRoute" @back="setSidebarRoute('conversations')">
         <ConversationList :active="sidebarRoute==='conversations'&&!searchOpen&&!newOpen&&!addOpen&&!(compact&&panelVisible)" :pin-supported="!designPreview&&state.capabilities?.conversationLifecycleV1===true" :pin-busy-ids="pinBusyIds" @pin="setConversationPinned" :activity="state.activity" :pending="state.pending??[]" :search-open="false" scope="desktop" include-channels channel-entry :conversations="mainConversations" :characters="state.characters" :selected="selected" :query="workspace.queries.desktop" kind="all" :drafts="workspace.drafts" :busy-ids="busyIds" :error-ids="errorIds" :loading="loading" @update:query="workspace.queries.desktop=$event" @select="selectConversation" @create="openNew" @channels="setSidebarRoute('channels')"/>
         <template #channels><ConversationList :active="sidebarRoute==='channels'&&!searchOpen&&!newOpen&&!addOpen&&!(compact&&panelVisible)" :pin-supported="!designPreview&&state.capabilities?.conversationLifecycleV1===true" :pin-busy-ids="pinBusyIds" @pin="setConversationPinned" :activity="state.activity" :pending="state.pending??[]" scope="channel" :search-open="true" :conversations="channelConversations" :characters="state.characters" :selected="selected" :query="workspace.queries.channel" kind="all" :drafts="workspace.drafts" :busy-ids="busyIds" :error-ids="errorIds" :loading="loading" @update:query="workspace.queries.channel=$event" @select="selectConversation" @manage="openManagement({section:'channels'})"/></template>
        </ConversationSidebarRouter>
        <footer class="sidebar-footer"><button ref="userMenuTrigger" class="user-menu-button" aria-label="工作区菜单" aria-haspopup="menu" @click="toggleWorkspaceMenu"><span class="user-avatar"><img v-if="state.settings.personalAvatarUrl&&!personalAvatarFailed" :key="state.settings.personalAvatarUrl" :src="state.settings.personalAvatarUrl" alt="" @error="personalAvatarFailed=true"/><Icon v-else name="person" :size="18"/></span><span class="user-menu-copy"><strong>沙之书</strong></span><Icon name="down" :size="14"/></button><TooltipButton label="管理" icon="apps" class="elevated circle management-entry" @click="openManagement({section:'channels'})"/></footer>
        <div ref="workspaceMenu" popover="manual" class="workspace-menu" role="menu" aria-label="工作区菜单" @keydown="workspaceMenuKey"><button v-for="item in nav" :key="item.id" role="menuitem" @click="menuSection(item.id)"><Icon :name="item.icon" :size="16"/>{{item.label}}</button><button v-if="state.settings.developerMode" role="menuitem" @click="menuSection('developer');mobileChat=true"><Icon name="terminal" :size="16"/>开发者</button><hr/><button role="menuitem" @click="openSettings"><Icon name="settings" :size="16"/>设置</button></div>
       </aside>
      </ResizableSidebar>
      <main :inert="compact&&panelVisible" class="workspace-main" :class="{'showing-business':!chatSection}"><header v-if="!chatSection" class="business-mobile-back"><button class="text-button" @click="setMobileChat(false)"><Icon name="back" :size="16"/>返回工作区</button></header>
        <section ref="chatSurface" v-show="chatSection" class="chat-view conversation-chat">
          <header class="chat-header"><TooltipButton label="返回对话列表" icon="back" class="mobile-conversation-back" @click="setMobileChat(false)"/><ConversationTitle :conversation="current" :name="conversationName" :person="participants[0]" @details="togglePanel" :disabled="designPreview||currentReadOnly" @refresh="refresh" @notice="toast"/><TooltipButton ref="panelToggle" v-if="current" :label="panelVisible?'收起附属功能':'打开附属功能'" icon="panel" class="details-trigger" :aria-expanded="panelVisible" @click="togglePanel"/></header>
          <div v-if="loading" class="loading-content" aria-live="polite">正在加载…</div>
          <MessageTimeline v-else ref="timelineView" :messages="messages" :direct-inputs="directInputs" :send-progress-visible="sendProgressVisible" :can-query-receipt="!!(inputCapabilities?.messageSendReceiptsV1||inputCapabilities?.directChatSteerV1)" @query-receipt="queryMessageReceipt" :can-reply="!!inputCapabilities?.messageReferencesV1&&(current?.channel==='desktop'||!!senderCapability?.reply)" @reply="quoteMessage" :conversation="current" :characters="state.characters" :active-runs="active" :pending="pending" :active="chatSection&&(!workspaceSize.narrow||mobileChat)" :design-preview="designPreview" :scheduler-thoughts="state.capabilities?.channelGroupSchedulerV2?state.schedulerThoughts??[]:[]" :rounds="observability?.summary.rounds??[]" :records="observability?.items??[]" :per-round="state.settings.developerMode&&chatPreferences.perRound" @scroll="readVisible">
            <div v-if="!current" class="chat-empty"><Icon name="chat" :size="32"/><h2>{{workspace.scope==='channel'?'暂无渠道对话':'暂无对话'}}</h2><button class="button" @click="workspace.scope==='channel'?changeSection('channel-admin'):openNew()"><Icon :name="workspace.scope==='channel'?'channels':'plus'" :size="16"/>{{workspace.scope==='channel'?'管理渠道':'新建对话'}}</button></div>
            <div v-else-if="!messages.length" class="chat-empty"><Icon name="chat" :size="32"/><h2>暂无消息</h2><p v-if="current.channel==='desktop'&&!runtime.modelConfigured">请先配置模型。</p><button v-if="current.channel==='desktop'&&!runtime.modelConfigured" class="button" @click="openSettings">设置模型<Icon name="arrow" :size="16"/></button></div>
            </MessageTimeline>
          <div v-if="currentReadOnly" class="conversation-readonly" role="status"><span>这是历史私聊，仅供查看。</span><button v-if="activeConversation" class="button" @click="selectConversation(activeConversation.id)">进入活跃对话</button></div>
          <div v-if="current&&!currentReadOnly" class="composer-area"><div v-if="currentError||workspace.failedText[selected]" class="local-error" role="alert"><Icon name="warning" :size="16"/><span>{{currentError}}</span><button v-if="workspace.failedText[selected]" class="text-button" @click="conversationController.recover(selected)"><Icon name="reset" :size="16"/>恢复未发送内容</button><button v-if="currentError" class="icon-button" aria-label="关闭当前对话错误提示" @click="conversationController.dismissError(selected)"><Icon name="close" :size="16"/></button></div><div v-if="current.channel!=='desktop'" class="channel-composer-identity"><CharacterAvatar v-if="channelSender" class="small" :person="channelSender"/><span v-if="participants.length===1" class="channel-sender-name">以 {{channelSender?.name}} 发送</span><label v-else class="channel-sender-picker"><span>发送身份</span><CustomSelect v-model="channelSenderId" aria-label="发送角色" :options="[{value:'',label:'选择角色'},...participants.map(person=>({value:person.id,label:person.name}))]" :disabled="workspace.sending[selected]"/></label></div><div v-for="bundle in recoverableBundles" :key="bundle.requestId" class="composer-recovery"><span>{{bundle.classification==='unknown'?'发送结果待确认':'未发送内容'}}{{bundle.attachments?.length?` · ${bundle.attachments.length} 个附件`:''}}</span><button v-if="bundle.classification==='unknown'" type="button" class="text-button" :disabled="workspace.sending[selected]" @click="querySend(bundle)">查询发送结果</button><button v-if="!bundle.restoredToDraft" type="button" class="text-button" @click="recoverBundle(bundle)">恢复内容</button></div><p v-if="attachmentSendError||directPolicy.unavailable" class="composer-recovery" role="status">{{attachmentSendError||directPolicy.unavailable}}</p><ChatComposer ref="composerView" v-model:text="draft" :attachments="composerAttachments" :reply="composerReply" :conversation-key="selected" :active="chatSection&&(!workspaceSize.narrow||mobileChat)" :disabled="designPreview||currentReadOnly" :sending="!!workspace.sending[selected]" :send-label="directPolicy.supported&&directPolicy.busy?'补充消息':'发送消息'" :send-disabled="channelSendBlocked||!!attachmentSendError||!!directPolicy.unavailable||nativePickerPending||composerAttachments.some(item=>item.status!=='ready')" :attachments-available="attachmentsAvailable" :capture-available="captureAvailable" :capture-busy="captureBusy" :native-picker-available="nativePickerAvailable" :native-picker-busy="nativePickerBusy&&nativePickerRequest?.conversationId===selected" :native-picker-unknown="nativePickerUnknown&&nativePickerRequest?.conversationId===selected" @resume-native="resumeNativePicker" @native-files="chooseNativeFiles" @cancel-native="cancelNativePicker" @files="insertFiles" @detach="detachAttachment" @retry="retryAttachment" @capture="captureAttachment" @clear-reply="clearReply" @send="send"/></div>
        </section>
      </main>
      <button v-if="panelVisible&&compact" class="details-backdrop" aria-label="关闭附属功能" @click="closePanel"/>
      <FixedClip v-slot="{presented:sidebarPresented}" :open="panelVisible" :width="sidebarGeometry.width" :height="sidebarGeometry.height" class="details-shell" :class="{'details-closed':!panelVisible}" :inert="!panelVisible" :aria-hidden="!panelVisible"><ResizableSidebar class="details-sidebar" :content-width="sidebarGeometry.width" :content-height="sidebarGeometry.height" name="附属功能" storage-key="details" side="right" :width="320" :min="280" :max="720" @resize="detailsWidth=$event"><ConversationDetails ref="detailsPanel" :state="state" :conversation="current" :tab="sideTab" :active="panelVisible" :presented="sidebarPresented" :overlay-blocked="modalOpen||newOpen||addOpen" :read-only="designPreview||currentReadOnly" :preferences="chatPreferences" :observability="observability" :observability-loading="observabilityLoading" :observability-error="observabilityError" :log-category="logCategory" :log-round="logRound" :log-rounds="logRounds" :log-unassigned-count="logUnassignedCount" @select-log-round="logRound=$event" @update:tab="sideTab=$event" @update:preferences="updateChatPreferences" @filter-logs="logCategory=$event" @more-logs="observabilityController.more()" @retry-logs="observabilityController.refresh()" @close="closePanel" @add="openAdd" @select="selectFromDetails" @show-pet="showPet" @error="report" @refresh="refresh" @notice="toast"/></ResizableSidebar></FixedClip>
      </div>
    </div>
    <div v-if="error" class="global-error" role="alert"><span>{{error}}</span><button class="icon-button" aria-label="关闭错误提示" @click="error=''"><Icon name="close" :size="16"/></button></div>
    <Transition name="toast"><div v-if="notice" class="toast" role="status"><Icon name="check" :size="16"/>{{notice}}</div></Transition>
    <Modal :open="!!attachmentDownload" title="下载附件" @close="attachmentDownload=null"><form @submit.prevent="attachmentDownload&&startAttachmentDownload(attachmentDownload.conversationId,attachmentDownload.attachmentId,downloadRoleId)"><label class="field">读取角色<CustomSelect v-model="downloadRoleId" aria-label="附件读取角色" :options="downloadRoleOptions"/></label><footer class="form-footer"><button class="button primary" :disabled="!downloadRoleId">下载</button></footer></form></Modal>
    <Modal :open="captureRoleOpen" title="选择截屏角色" @close="captureRoleOpen=false"><form @submit.prevent="performCapture()"><label class="field">角色<CustomSelect v-model="captureRoleId" aria-label="截屏角色" :options="[{value:'',label:'选择角色'},...captureRoles.map(person=>({value:person.id,label:person.name}))]"/></label><footer class="form-footer"><button type="submit" class="button primary" :disabled="!captureRoleId||captureBusy">插入截屏</button></footer></form></Modal>
    <Modal class="workspace-search-dialog" :open="searchOpen" title="搜索对话" @close="searchOpen=false"><label class="workspace-search-input"><Icon name="search" :size="20"/><input v-model="sidebarQuery" aria-label="搜索对话" placeholder="搜索对话" autofocus/><button v-if="sidebarQuery" class="icon-button" aria-label="清除搜索" @click="sidebarQuery=''"><Icon name="close" :size="14"/></button></label><div class="workspace-search-results"><button v-for="conversation in conversations" :key="conversation.id" class="workspace-search-result" @click="chooseSearchConversation(conversation.id)"><CharacterAvatar :person="state.characters.find(person=>person.id===conversation.participantIds[0])"/><span><strong>{{searchConversationName(conversation)}}</strong><small>{{conversation.display?.preview??conversation.lastMessage??(conversation.kind==='group'?'群聊':'单聊')}}</small></span><Icon name="chevron" :size="16"/></button><p v-if="!conversations.length" class="workspace-search-empty">没有匹配的对话</p></div></Modal>
    <Modal :open="newOpen||addOpen" :title="modalAction" @close="closeConversationModal"><form @submit.prevent="addOpen?addParticipants():createConversation()"><label v-if="!addOpen&&chosen.length>1" class="field">群聊名称<input v-model="newTitle" placeholder="输入对话名称" maxlength="80" :disabled="conversationBusy"/></label><p class="field-label">{{addOpen?'选择要添加的角色':'选择参与角色'}}</p><div class="people-choice"><button v-for="person in state.characters.filter(person=>!addOpen||!participantTarget?.participantIds.includes(person.id))" :key="person.id" type="button" :class="{chosen:chosen.includes(person.id)}" :aria-pressed="chosen.includes(person.id)" :disabled="conversationBusy" @click="toggleChoice(person.id)"><CharacterAvatar :person="person"/><span>{{person.name}}</span><Icon v-if="chosen.includes(person.id)" name="check" :size="17"/></button></div><p v-if="!state.characters.some(person=>!addOpen||!participantTarget?.participantIds.includes(person.id))" class="muted">暂无可添加的角色。请先新建角色。</p><p v-if="conversationError" class="inline-error" role="alert">{{conversationError}}</p><footer class="form-footer"><button class="button primary" :disabled="!chosen.length||designPreview||conversationBusy">{{conversationBusy?'正在保存…':addOpen?modalAction:'创建对话'}}<Icon name="arrow" :size="16"/></button></footer></form></Modal>
  </div>
</template>


<style scoped>
.conversation-readonly{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;flex-shrink:0;padding:8px 16px;border-top:1px solid var(--sand-border-primary-translucent);color:var(--sand-text-secondary);font-size:13px;line-height:18px}
.conversation-readonly .button{flex:none}
</style>

<style scoped>
.composer-recovery{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:4px 12px;color:var(--muted);font-size:13px;line-height:18px}.composer-recovery .text-button{font:inherit}
</style>
