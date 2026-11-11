import {managementDestination,settingsDestination,managementUrl,conversationDestination,validateManagementOwnership} from './management-target.mjs';
import {roleSettingsDestination} from './role-settings-target.mjs';

/** Same-process navigation only: no backend writes and no renderer config/drafts. */
export function createManagementNavigation({createManagementWindow,rendererUrl,showMain,getMainWindow,readSnapshot,readChannels,isQuitting=()=>false,onError=()=>{},onNavigation=()=>{}}){
 let managementWindow,sequence=0,managementRevision=0,conversationRevision=0;
 const records=new WeakMap();
 function observe(window,channel,target,phase){try{onNavigation({kind:channel==='sandbook:management-target'?'management':'conversation',phase,windowId:window.id??null,webContentsId:window.webContents.id,requestId:target.requestId,...(target.section?{section:target.section}:{}),...(target.settingsTarget?.tab?{settingsTab:target.settingsTarget.tab}:{}),rolePermissions:!!target.roleSettingsTarget,hasCharacterTarget:!!(target.characterId||target.settingsTarget?.characterId),hasAccountTarget:!!target.accountId,hasConversationTarget:!!target.conversationId});}catch{/* Observation never controls navigation. */}}
 function attach(window,channel){
  if(records.has(window))return records.get(window);
  const record={ready:false,pending:null,focusWhenReady:false,hasLoaded:false};records.set(window,record);
  window.webContents.on('did-start-loading',()=>{if(window.webContents.isLoadingMainFrame())record.ready=false;});
  window.webContents.on('did-fail-load',(_event,_code,_description,_url,isMainFrame)=>{if(isMainFrame){record.ready=false;if(channel==='sandbook:management-target')failedFirstLoad(window);}});
  window.webContents.on('did-finish-load',()=>{if(window.isDestroyed()||isQuitting())return;record.ready=true;record.hasLoaded=true;settle(window,channel);});
  // Electron may emit did-finish-load before isLoadingMainFrame() clears.
  // Retain the pending target and drain it when the native loading state stops.
  window.webContents.on('did-stop-loading',()=>settle(window,channel));
  return record;
 }
 function settle(window,channel){const record=records.get(window);if(!record?.ready||isQuitting()||window.isDestroyed()||window.webContents.isLoadingMainFrame())return;flush(window,channel);if(record.focusWhenReady){record.focusWhenReady=false;focus(window);}}
 function failedFirstLoad(window){const record=records.get(window);if(!record||record.hasLoaded||window.isDestroyed())return;record.pending=null;if(managementWindow===window)managementWindow=undefined;window.destroy();onError(new Error('管理窗口加载失败，请重新打开管理入口。'));}
 function flush(window,channel){const record=records.get(window);if(isQuitting()||window.isDestroyed()||!record?.ready||window.webContents.isLoadingMainFrame()||!record.pending)return;const target=record.pending;record.pending=null;window.webContents.send(channel,target);observe(window,channel,target,'delivered');}
 function deliver(window,channel,target){const record=records.get(window)??attach(window,channel);record.pending=target;observe(window,channel,target,'queued');flush(window,channel);}
 function focus(window){if(window.isMinimized())window.restore();window.show();window.focus();}
 async function openManagement(input){
  if(isQuitting())return;
  const target=managementDestination(input),revision=++managementRevision,requestId=++sequence;
  const needsSnapshot=!!(target.characterId||target.accountId||target.conversationId||target.settingsTarget?.characterId||target.roleSettingsTarget);
  if(needsSnapshot){const [snapshot,channels]=await Promise.all([readSnapshot(),readChannels()]);if(isQuitting()||revision!==managementRevision)return;validateManagementOwnership(target,snapshot,channels.connections??[]);}
  if(isQuitting()||revision!==managementRevision)return;
  const payload={...target,requestId,...(target.roleSettingsTarget?{roleSettingsTarget:{...target.roleSettingsTarget,requestId}}:{})};
  if(!managementWindow||managementWindow.isDestroyed()){
   managementWindow=createManagementWindow();const current=managementWindow;attach(current,'sandbook:management-target');
   current.once('closed',()=>{if(managementWindow===current)managementWindow=undefined;});
   deliver(current,'sandbook:management-target',payload);
   try{Promise.resolve(current.loadURL(managementUrl(typeof rendererUrl==='function'?rendererUrl():rendererUrl))).catch(()=>failedFirstLoad(current));}catch{failedFirstLoad(current);}
  }else deliver(managementWindow,'sandbook:management-target',payload);
  if(!managementWindow||managementWindow.isDestroyed())return;
  const record=records.get(managementWindow);if(record.ready&&!managementWindow.webContents.isLoadingMainFrame())focus(managementWindow);else record.focusWhenReady=true;
 }
 async function openConversation(input){
  if(isQuitting())return;
  const conversationId=conversationDestination(input),revision=++conversationRevision,requestId=++sequence;
  const snapshot=await readSnapshot();if(isQuitting()||revision!==conversationRevision)return;
  if(!snapshot.conversations?.some(conversation=>conversation.id===conversationId))throw new Error('会话不存在');
  showMain();const window=getMainWindow();if(!window||window.isDestroyed())return;
  deliver(window,'sandbook:conversation-target',{conversationId,requestId});
 }
 return {openManagement,openConversation,openSettings:async input=>openManagement({section:'settings',settingsTarget:settingsDestination(input)}),openRoleSettings:async input=>{const target=roleSettingsDestination(input);return openManagement({section:'characters',characterId:target.characterId,roleSettingsTarget:target});},attachMain:window=>attach(window,'sandbook:conversation-target'),getWindow:()=>managementWindow,close(){managementRevision++;conversationRevision++;}};
}
