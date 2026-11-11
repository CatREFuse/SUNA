const {contextBridge,ipcRenderer}=require('electron');
// Subscribe before Vue mounts. Only undelivered payloads are buffered; native
// Electron events and credentials never cross the context bridge.
function bufferedTargets(channel){
 const pending=[],listeners=new Set();let draining=false;
 function drain(){
  if(draining)return;draining=true;
  try{while(pending.length&&listeners.size){const target=pending.shift();let delivered=false;
   for(const callback of [...listeners]){if(!listeners.has(callback))continue;try{const result=callback(target);delivered=true;if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>listeners.delete(callback));}catch{listeners.delete(callback);}}
   if(!delivered){pending.unshift(target);pending.splice(0,Math.max(0,pending.length-64));break;}
  }}finally{draining=false;}
 }
 ipcRenderer.on?.(channel,(_event,target)=>{pending.push(target);pending.splice(0,Math.max(0,pending.length-64));drain();});
 return callback=>{if(typeof callback!=='function')throw new TypeError('Expected callback');listeners.add(callback);drain();return()=>listeners.delete(callback);};
}
const onSettingsTarget=bufferedTargets('sandbook:settings-target');
const onManagementTarget=bufferedTargets('sandbook:management-target');
const onConversationTarget=bufferedTargets('sandbook:conversation-target');
contextBridge.exposeInMainWorld('sandbook',Object.freeze({
  platform:process.platform,
  writeClipboardText:text=>ipcRenderer.invoke('sandbook:write-clipboard-text',text),
  chooseControlledAttachments:input=>ipcRenderer.invoke('sandbook:choose-controlled-attachments',input),
  resumeControlledAttachments:input=>ipcRenderer.invoke('sandbook:resume-controlled-attachments',input),
  cancelControlledAttachments:input=>ipcRenderer.invoke('sandbook:cancel-controlled-attachments',input),
  downloadControlledAttachment:input=>ipcRenderer.invoke('sandbook:download-controlled-attachment',input),
  captureComposerAttachments:input=>ipcRenderer.invoke('sandbook:capture-composer-attachments',input),
  cancelComposerCapture:input=>ipcRenderer.invoke('sandbook:cancel-composer-capture',input),
  setWindowAppearance:value=>ipcRenderer.invoke('sandbook:set-window-appearance',value),
  getWindowAppearance:()=>ipcRenderer.invoke('sandbook:get-window-appearance'),
  onWindowAppearance:callback=>{if(typeof callback!=='function')throw new TypeError('Expected callback');const listener=(_event,state)=>callback(state);ipcRenderer.on('sandbook:window-appearance',listener);return()=>ipcRenderer.removeListener('sandbook:window-appearance',listener);},
  setTheme:theme=>ipcRenderer.invoke('sandbook:set-theme',theme),
  showMain:()=>ipcRenderer.invoke('sandbook:show-main'),
  openManagement:target=>ipcRenderer.invoke('sandbook:open-management',target),
  openConversation:conversationId=>ipcRenderer.invoke('sandbook:open-conversation',conversationId),
  onManagementTarget,
  onConversationTarget,
  openSettings:options=>ipcRenderer.invoke('sandbook:open-settings',options),
  openRoleSettings:target=>ipcRenderer.invoke('sandbook:open-role-settings',target),
  onRoleSettingsTarget:callback=>{if(typeof callback!=='function')throw new TypeError('Expected callback');const listener=(_event,target)=>callback(target);ipcRenderer.on('sandbook:role-settings-target',listener);return()=>ipcRenderer.removeListener('sandbook:role-settings-target',listener);},
  onSettingsTarget,
  createManagedChannel:change=>ipcRenderer.invoke('sandbook:create-managed-channel',change),
  setChannelAdministrator:change=>ipcRenderer.invoke('sandbook:set-channel-administrator',change),
  setRuntimeNativeTools:change=>ipcRenderer.invoke('sandbook:set-runtime-native-tools',change),
  submitCredentials:input=>ipcRenderer.invoke('sandbook:submit-credentials',input).then(reply=>{if(!reply||reply.ok!==true)throw Object.assign(new Error(reply?.error?.message??'凭证保存失败，请重试'),{code:reply?.error?.code??'CREDENTIAL_SUBMIT_FAILED'});return reply.result;}),
  manageDshPlugins:input=>ipcRenderer.invoke('sandbook:manage-dsh-plugins',input).then(reply=>{if(!reply||reply.ok!==true)throw {message:reply?.error?.message??'操作结果待确认',code:reply?.error?.code??'DSH_PLUGIN_OPERATION_UNKNOWN'};return reply.result;}),
  setRuntimePermission:change=>ipcRenderer.invoke('sandbook:set-runtime-permission',change),
  setToolPermission:change=>ipcRenderer.invoke('sandbook:set-tool-permission',change),
  adoptScreenPolicy:change=>ipcRenderer.invoke('sandbook:adopt-screen-policy',change),
  setScreenPermission:change=>ipcRenderer.invoke('sandbook:set-screen-permission',change),
  togglePet:characterId=>ipcRenderer.invoke('sandbook:toggle-pet',characterId),
  setPetClickThrough:enabled=>ipcRenderer.invoke('sandbook:pet-click-through',!!enabled),
  openRuntimeGui:()=>ipcRenderer.invoke('sandbook:runtime-gui'),
  importAsset:()=>ipcRenderer.invoke('sandbook:import-asset'),
  saveExport:(name,content)=>ipcRenderer.invoke('sandbook:save-export',{name,content}),
  installRuntimePlugin:()=>ipcRenderer.invoke('sandbook:install-runtime-plugin'),
  chooseRuntimeConnection:()=>ipcRenderer.invoke('sandbook:choose-runtime-connection'),
  browser:Object.freeze({
    command:payload=>ipcRenderer.invoke('sandbook:browser-command',payload),
    onState:callback=>{if(typeof callback!=='function')throw new TypeError('Expected callback');const listener=(_event,state)=>callback(state);ipcRenderer.on('sandbook:browser-state',listener);return()=>ipcRenderer.removeListener('sandbook:browser-state',listener);},
  }),
}));
