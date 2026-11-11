import {displayProductVersion} from '../src/shared/product-version.mjs';
import {createClipboardTextHandler} from './clipboard-text.mjs';
import {createCredentialSubmissionHandler} from './credential-submission.mjs';
import {createDshPluginManagementHandler} from './dsh-plugin-management.mjs';
import {createControlledAttachmentPicker} from './controlled-attachment-picker.mjs';
import {createControlledAttachmentDownload} from './controlled-attachment-download.mjs';
import {app,BrowserWindow,Tray,Menu,nativeImage,nativeTheme,ipcMain,clipboard,dialog,shell,screen,desktopCapturer,systemPreferences} from 'electron';
import {fork} from 'node:child_process';
import {mkdir,readFile,writeFile,stat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createComposerCapture} from './composer-capture.mjs';
import {createScreenCaptureHost} from './screen-capture.mjs';
import {createPetCaptureHost} from './pet-capture.mjs';
import {installDshPopups} from './dsh-window.mjs';
import {runtimeNativeToolsInput} from './runtime-native-tools-input.mjs';
import {createWindowAppearance} from './window-appearance.mjs';
import {createConversationBrowser} from './conversation-browser.mjs';
import {installNativeWindowControls} from './native-window-controls.mjs';
import {requireApplicationFrame} from './management-target.mjs';
import {createManagementNavigation} from './management-navigation.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const packaged=app.isPackaged;
const backendRoot=packaged?path.join(process.resourcesPath,'backend'):root;
const runtimeRoot=packaged?path.join(process.resourcesPath,'dsh'):path.join(root,'runtime/dsh');
const pluginRoot=packaged?path.join(process.resourcesPath,'plugins/suna-dsh'):path.join(root,'plugins/suna-dsh');
const preload=path.join(path.dirname(fileURLToPath(import.meta.url)),'preload.cjs');
const applicationIcon=path.join(path.dirname(fileURLToPath(import.meta.url)),'assets/icon.png');
const dataDir=process.env.SAND_DATA_DIR || app.getPath('userData');
const developmentUrl=!packaged?process.env.SAND_RENDERER_URL:undefined;
let backend,apiUrl,rendererUrl,nativeHeaders={},mainWindow,petWindow,guiWindow,tray,quitting=false,shutdownTask,petCharacter='default-character',clickThrough=false;
let managementNavigation;
const nativeWindows=new Set();
const windowAppearance=createWindowAppearance({nativeTheme,windows:()=>[mainWindow,managementNavigation?.getWindow()]});
const guiDiagnostics={console:[],network:[]};
const petDiagnostics=[];
let browserCommands=Promise.resolve();
const conversationBrowser=createConversationBrowser({deniedOrigins:()=>[rendererUrl,apiUrl],onState:state=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('sandbook:browser-state',state);}});
const captureHost=createPetCaptureHost({rendererUrl:()=>rendererUrl,readCharacter:async id=>(await api('/snapshot')).characters.find(person=>person.id===id),existingPet:id=>id===petCharacter?petWindow:undefined,secure,contract:await import(pathToFileURL(path.join(backendRoot,'src/runtime/pet-capture-contract.mjs')).href)});
const screenCaptureHost=createScreenCaptureHost({desktopCapturer:{getSources:options=>desktopCapturer.getSources(options)},screen:{getPrimaryDisplay:()=>screen.getPrimaryDisplay(),getAllDisplays:()=>screen.getAllDisplays()},systemPreferences:{getMediaAccessStatus:type=>systemPreferences.getMediaAccessStatus(type)},authorize:({binding})=>api('/screen-permissions/check',binding)});
const controlledAttachmentPicker=createControlledAttachmentPicker({api,dialog});
const downloadControlledAttachment=createControlledAttachmentDownload({api,getApiUrl:()=>apiUrl});
const composerCapture=createComposerCapture({api,desktopCapturer:{getSources:options=>desktopCapturer.getSources(options)},screen:{getPrimaryDisplay:()=>screen.getPrimaryDisplay(),getAllDisplays:()=>screen.getAllDisplays()},systemPreferences:{getMediaAccessStatus:type=>systemPreferences.getMediaAccessStatus(type)}});
const pendingScreenCaptures=new Map();
async function handleScreenMessage(message){
  if(message?.type==='screen-capture-cancel'){pendingScreenCaptures.get(message.id)?.abort();return;}
  if(message?.type==='screen-capture-release-run'){screenCaptureHost.releaseRun(message.runId);return;}
  if(message?.type==='screen-capture-revoke'){screenCaptureHost.revoke(message);return;}
  if(message?.type!=='screen-capture'||quitting||!apiUrl||typeof message.id!=='string'||pendingScreenCaptures.has(message.id))return;
  const controller=new AbortController();pendingScreenCaptures.set(message.id,controller);
  const reply=value=>{if(backend?.connected&&!quitting)backend.send({type:'screen-capture-result',id:message.id,binding:message.binding,...value},()=>{});};
  try{const result=await screenCaptureHost.capture({...message.binding,signal:controller.signal});if(!controller.signal.aborted)reply({ok:true,result});}
  catch(error){reply({ok:false,error:{code:error.code??'capture.unavailable',reason:error.reason??'capture.failed'}});}
  finally{pendingScreenCaptures.delete(message.id);}
}
app.setName('沙之书');
if(process.env.SAND_DATA_DIR)app.setPath('userData',dataDir);
const exists=async file=>{try{await stat(file);return true;}catch{return false;}};
const safeError=error=>String(error?.message || error).replace(/([?&]token=)[^\s&]+/g,'$1[隐藏]');

// A code-native monochrome book glyph; no external image or font is required.
function trayImage(){const size=18,raw=Buffer.alloc((size*4+1)*size);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const ink=(x===3||x===14)&&y>=4&&y<=14 || (y===4||y===14)&&x>=3&&x<=14 || x===8&&y>=3&&y<=14 || y===3&&x>=4&&x<=7 || y===5&&x>=9&&x<=13;const at=y*(size*4+1)+1+x*4;raw[at+3]=ink?255:0;}const crc=bytes=>{let c=0xffffffff;for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};const chunk=(type,data)=>{const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([length,name,data,checksum]);};const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;const image=nativeImage.createFromBuffer(Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));image.setTemplateImage(true);return image;}

async function startBackend(){
  if(process.env.SAND_API_URL&&!packaged){apiUrl=process.env.SAND_API_URL;rendererUrl=developmentUrl || apiUrl;const bootstrap=await fetch(new URL('/api/bootstrap',apiUrl)).then(r=>r.json());nativeHeaders={'x-sandbook-csrf':bootstrap.csrfToken};return;}
  const executable=path.join(runtimeRoot,'bin',process.platform==='win32'?'node.exe':'node');
  if(!await exists(executable))throw new Error('安装包缺少内置 Node 运行环境，请重新安装完整的沙之书。');
  await mkdir(dataDir,{recursive:true,mode:0o700});
  const env={PATH:path.join(runtimeRoot,'bin')+path.delimiter+(process.env.PATH || ''),HOME:process.env.HOME || '',LANG:process.env.LANG || 'zh_CN.UTF-8',TMPDIR:process.env.TMPDIR || '',SystemRoot:process.env.SystemRoot || '',SAND_DATA_DIR:dataDir,SAND_RUNTIME_DIR:runtimeRoot,SAND_NAPCAT_RUNTIME_DIR:packaged?path.join(process.resourcesPath,'napcat'):path.join(root,'runtime/napcat'),SAND_PLUGIN_DIR:pluginRoot,SAND_UI_DIR:path.join(backendRoot,'dist'),SAND_PORT:process.env.SAND_PORT || (developmentUrl?'4261':'0'),SAND_PROJECT_ROOT:backendRoot,SAND_DEVELOPMENT:developmentUrl?'1':'0',SAND_NATIVE_CAPTURE:'1'};
  backend=fork(path.join(backendRoot,'src/server.mjs'),[],{execPath:executable,execArgv:[],cwd:backendRoot,env,stdio:['ignore','pipe','pipe','ipc']});
  backend.on('message',message=>{captureHost.handle(message,result=>{if(backend?.connected&&!quitting)backend.send(result,()=>{});});void handleScreenMessage(message).catch(()=>{});});
  let tail='';for(const stream of [backend.stdout,backend.stderr])stream.on('data',b=>{tail=(tail+safeError(b.toString())).slice(-4000);});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('后台服务启动超时。'+tail)),30000);backend.once('error',error=>{clearTimeout(timer);reject(error);});backend.on('message',message=>{if(message?.type==='ready'){clearTimeout(timer);apiUrl=message.url;rendererUrl=developmentUrl || apiUrl;nativeHeaders=message.nativeHeaders || {};resolve();}});backend.once('exit',code=>{clearTimeout(timer);if(!apiUrl)reject(new Error('后台服务未能启动。'+tail));else if(!quitting)void dialog.showMessageBox({type:'error',title:'沙之书',message:'后台服务已停止',detail:'请退出后重新打开应用。',buttons:['知道了']});});});
}
async function api(route,body,{signal}={}){const response=await fetch(new URL('/api'+route,apiUrl),{signal,method:body===undefined?'GET':'POST',headers:{...nativeHeaders,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error || `请求失败 ${response.status}`),{status:response.status,code:value.code});return value;}
async function restoreWindowAppearance(){const saved=await api('/settings');return windowAppearance.set(saved.appearance??{transparency:50,blur:'system'});}
function trusted(event){if(!nativeWindows.has(event.sender.id)||event.senderFrame!==event.sender.mainFrame)throw new Error('Native capability unavailable');const url=new URL(event.senderFrame.url);const expected=new URL(rendererUrl);if(!['http:','https:'].includes(expected.protocol)||url.origin!==expected.origin||url.pathname!==expected.pathname||url.username||url.password)throw new Error('Unexpected renderer origin');}
function applicationFrame(event){trusted(event);return requireApplicationFrame(event,[mainWindow,managementNavigation.getWindow()],rendererUrl);}
function secure(window,origin,{native=false}={}){
  const contentsId=window.webContents.id;if(native){window.webContents.on('destroyed',()=>composerCapture.cancelOwner(String(contentsId)));window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)composerCapture.cancelOwner(String(contentsId));});}if(native)nativeWindows.add(contentsId);
  window.on('closed',()=>nativeWindows.delete(contentsId));
  window.webContents.setWindowOpenHandler(({url})=>{void openExternal(url);return{action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{try{if(new URL(url).origin!==origin){event.preventDefault();void openExternal(url);}}catch{event.preventDefault();}});
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
}
async function openExternal(url){try{const parsed=new URL(url);if(['https:','http:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password)await shell.openExternal(parsed.href);}catch{}}
function showMain(){if(!mainWindow||mainWindow.isDestroyed())createMain();if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}
const managementDiagnostics={events:[]};let managementReportWrites=Promise.resolve();
function reportManagementNavigation(event){
 if(packaged||!process.env.SAND_MANAGEMENT_REPORT)return;
 if(!path.isAbsolute(process.env.SAND_MANAGEMENT_REPORT))return;
 const location=path.resolve(process.env.SAND_MANAGEMENT_REPORT),privateRoots=[path.resolve(tmpdir()),path.resolve('/private/tmp')];
 if(!privateRoots.some(root=>location.startsWith(root+path.sep)))return;
 const describe=window=>{if(!window||window.isDestroyed())return null;let ready=false;try{ready=!window.webContents.isLoadingMainFrame()&&new URL(window.webContents.getURL()).origin===new URL(rendererUrl).origin;}catch{}return {windowId:window.id,webContentsId:window.webContents.id,visible:window.isVisible(),focused:window.isFocused(),loading:window.webContents.isLoadingMainFrame(),ready};};
 managementDiagnostics.events.push(event);managementDiagnostics.events.splice(0,Math.max(0,managementDiagnostics.events.length-64));
 const current=managementNavigation?.getWindow(),requests=managementDiagnostics.events.filter(item=>item.kind==='management'&&item.phase==='queued'&&item.windowId===current?.id),last=requests.at(-1);
 const value={checkedAt:new Date().toISOString(),main:describe(mainWindow),management:describe(current),reuseCount:Math.max(0,requests.length-1),lastSection:last?.section,lastRequestId:last?.requestId,events:[...managementDiagnostics.events]};
 managementReportWrites=managementReportWrites.then(async()=>{await writeFile(location,JSON.stringify(value,null,2),{mode:0o600});await chmod(location,0o600);}).catch(()=>{});
}
managementNavigation=createManagementNavigation({
 createManagementWindow(){
  const window=new BrowserWindow({title:'沙之书 · 管理',modal:false,icon:applicationIcon,width:1120,height:800,minWidth:720,minHeight:560,show:false,backgroundColor:process.platform==='darwin'?'#00000000':'#e9e9e9',...windowAppearance.windowOptions(),titleBarStyle:process.platform==='darwin'?'hiddenInset':'default',trafficLightPosition:{x:16,y:15},webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});
  window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
  for(const event of ['show','hide','focus','blur','closed'])window.on(event,()=>reportManagementNavigation({kind:'management',phase:event,windowId:window.id,webContentsId:window.webContents.id}));
  secure(window,new URL(rendererUrl).origin,{native:true});windowAppearance.apply(window);installNativeWindowControls(window,{railWidth:92,scale:1,gap:9,centerY:22});
  return window;
 },
 rendererUrl:()=>rendererUrl,showMain,getMainWindow:()=>mainWindow,readSnapshot:()=>api('/snapshot'),readChannels:()=>api('/channels'),isQuitting:()=>quitting,onError:error=>void showError(error),onNavigation:reportManagementNavigation,
});
const openManagement=input=>managementNavigation.openManagement(input);
const openConversation=id=>managementNavigation.openConversation(id);
const openSettings=options=>managementNavigation.openSettings(options);
const openRoleSettings=target=>managementNavigation.openRoleSettings(target);
function createMain(){mainWindow=new BrowserWindow({title:'沙之书',icon:applicationIcon,width:1180,height:820,minWidth:720,minHeight:560,show:false,backgroundColor:process.platform==='darwin'?'#00000000':'#e9e9e9',...windowAppearance.windowOptions(),titleBarStyle:process.platform==='darwin'?'hiddenInset':'default',trafficLightPosition:{x:16,y:15},webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});windowAppearance.apply(mainWindow);const nativeControls=installNativeWindowControls(mainWindow,{railWidth:92,scale:1,gap:9,centerY:22});let nativeReportTimer;const reportNativeControls=()=>{if(packaged||!process.env.SAND_NATIVE_CONTROLS_REPORT)return;let value;try{value=nativeControls.inspect();}catch{value={available:false,reason:'NATIVE_CONTROLS_INSPECT_FAILED'};}void writeFile(process.env.SAND_NATIVE_CONTROLS_REPORT,JSON.stringify({checkedAt:new Date().toISOString(),...value},null,2),{mode:0o600}).catch(()=>{});};const queueNativeReport=()=>{clearTimeout(nativeReportTimer);nativeReportTimer=setTimeout(reportNativeControls,80);nativeReportTimer.unref();};mainWindow.on('resize',queueNativeReport);mainWindow.once('closed',()=>clearTimeout(nativeReportTimer));secure(mainWindow,new URL(rendererUrl).origin,{native:true});conversationBrowser.attachWindow(mainWindow);mainWindow.once('ready-to-show',()=>{mainWindow.show();queueNativeReport();});mainWindow.on('close',event=>{if(!quitting){event.preventDefault();mainWindow.hide();}});managementNavigation.attachMain(mainWindow);void mainWindow.loadURL(rendererUrl);return mainWindow;}
async function togglePet(characterId){if(characterId!==undefined&&(typeof characterId!=='string'||characterId.length>200))throw new Error('角色标识无效');const chosen=characterId || petCharacter;if(petWindow&&!petWindow.isDestroyed()){if(chosen===petCharacter){petWindow.close();petWindow=undefined;refreshTray();return false;}petCharacter=chosen;const url=new URL(rendererUrl);url.searchParams.set('pet','');url.searchParams.set('character',petCharacter);await petWindow.loadURL(url.href);return true;}
  petCharacter=chosen;const area=screen.getPrimaryDisplay().workArea;petWindow=new BrowserWindow({title:'沙之书 · 桌宠',width:340,height:420,x:area.x+area.width-370,y:area.y+area.height-450,transparent:true,frame:false,hasShadow:false,alwaysOnTop:true,skipTaskbar:true,resizable:true,minWidth:180,minHeight:220,show:false,backgroundColor:'#00000000',webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});secure(petWindow,new URL(rendererUrl).origin,{native:true});petWindow.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});petWindow.setAlwaysOnTop(true,'floating');petWindow.on('closed',()=>{petWindow=undefined;clickThrough=false;refreshTray();});const url=new URL(rendererUrl);url.searchParams.set('pet','');url.searchParams.set('character',petCharacter);await petWindow.loadURL(url.href);petWindow.showInactive();refreshTray();return true;
}
function setPetClickThrough(value){clickThrough=!!value;if(petWindow&&!petWindow.isDestroyed())petWindow.setIgnoreMouseEvents(clickThrough,{forward:true});refreshTray();}
async function openRuntimeGui(){const {url}=await api('/runtime/gui',{});const parsed=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||!['http:','https:'].includes(parsed.protocol))throw new Error('DSH GUI 地址不属于本机运行环境');if(guiWindow&&!guiWindow.isDestroyed()){await guiWindow.loadURL(url);guiWindow.show();guiWindow.focus();return;}guiWindow=new BrowserWindow({title:'DeepSeek Harness (suna)',titleBarStyle:'default',width:1180,height:820,minWidth:720,minHeight:520,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,preload:path.join(root,'desktop/dsh-preload.cjs'),partition:'persist:sandbook-dsh'}});secure(guiWindow,parsed.origin);guiWindow.on('page-title-updated',event=>{event.preventDefault();guiWindow.setTitle('DeepSeek Harness (suna)');});installDshPopups(guiWindow,{openExternal:url=>shell.openExternal(url),onError:()=>showError(new Error('无法打开登录链接，请检查系统默认浏览器。'))});await guiWindow.loadURL(url);}
function refreshTray(){if(!tray)return;tray.setContextMenu(Menu.buildFromTemplate([{label:'打开沙之书',click:showMain},{label:'设置…',click:()=>void openSettings().catch(showError)},{label:petWindow?'隐藏桌宠':'显示桌宠',click:()=>void togglePet().catch(showError)},{label:'恢复桌宠鼠标交互',enabled:!!petWindow&&clickThrough,click:()=>setPetClickThrough(false)},{type:'separator'},{label:'打开 DSH',click:()=>void openRuntimeGui().catch(showError)},{type:'separator'},{label:'退出沙之书',click:()=>app.quit()}]));}
const showError=error=>dialog.showMessageBox({type:'error',title:'沙之书',message:safeError(error),buttons:['知道了']});
function setupIpc(){
  ipcMain.handle('sandbook:write-clipboard-text',createClipboardTextHandler({applicationFrame,clipboard}));
  ipcMain.handle('sandbook:submit-credentials',createCredentialSubmissionHandler({applicationFrame,api}));
  ipcMain.handle('sandbook:manage-dsh-plugins',createDshPluginManagementHandler({applicationFrame,api}));
  ipcMain.handle('sandbook:open-management',async(event,target)=>{applicationFrame(event);return openManagement(target);});
  ipcMain.handle('sandbook:open-conversation',async(event,id)=>{applicationFrame(event);return openConversation(id);});
  ipcMain.handle('sandbook:set-runtime-native-tools',async(event,change)=>{
    applicationFrame(event);
    return api('/runtime/native-tools',runtimeNativeToolsInput(change));
  });
  for(const [method,operation] of [['set-window-appearance',value=>windowAppearance.set(value)],['get-window-appearance',()=>windowAppearance.status()]])ipcMain.handle('sandbook:'+method,async(event,value)=>{
    applicationFrame(event);
    return operation(value);
  });
  ipcMain.handle('sandbook:create-managed-channel',async(event,change)=>{
    applicationFrame(event);
    if(!change||change.pluginId!=='suna-napcat'||typeof change.characterId!=='string'||change.characterId.length>200||! /^[A-Za-z0-9_-]{1,128}$/.test(change.requestId??''))throw new Error('账号创建参数无效');
    return api('/plugins/suna-napcat/ui/rpc',{method:'channels.managed.create',params:{characterId:change.characterId,requestId:change.requestId}});
  });
  ipcMain.handle('sandbook:set-channel-administrator',async(event,change)=>{
    applicationFrame(event);
    if(!change||!/^suna-[a-z0-9-]{1,58}$/.test(change.pluginId??'')||['accountId','characterId','administratorUid'].some(key=>typeof change[key]!=='string'||change[key].length>200))throw new Error('管理员设置无效');
    return api('/plugins/'+encodeURIComponent(change.pluginId)+'/ui/rpc',{method:'channels.administrator.save',params:{accountId:change.accountId,characterId:change.characterId,administratorUid:change.administratorUid}});
  });
  ipcMain.handle('sandbook:open-role-settings',async(event,target)=>{applicationFrame(event);return openRoleSettings(target);});
  ipcMain.handle('sandbook:open-settings',async(event,target)=>{applicationFrame(event);return openSettings(target);});
  for(const [name,route] of [['set-runtime-permission','/permissions/runtime'],['set-tool-permission','/permissions'],['adopt-screen-policy','/permissions/adopt-screen-policy']])ipcMain.handle('sandbook:'+name,async(event,change)=>{applicationFrame(event);return api(route,change);});
  const composerFrame=event=>{applicationFrame(event);if(!mainWindow||mainWindow.isDestroyed()||event.sender!==mainWindow.webContents)throw new Error('截图只允许桌面主窗口');return String(event.sender.id);};
  ipcMain.handle('sandbook:choose-controlled-attachments',(event,input)=>{const owner=composerFrame(event);const closed=()=>controlledAttachmentPicker.cancelOwner(owner);event.sender.once('destroyed',closed);return controlledAttachmentPicker.choose(owner,input).then(result=>{if(result.status!=='unknown'&&!event.sender.isDestroyed())event.sender.removeListener('destroyed',closed);return result;},error=>{if(!event.sender.isDestroyed())event.sender.removeListener('destroyed',closed);throw error;});});
  ipcMain.handle('sandbook:resume-controlled-attachments',(event,input)=>controlledAttachmentPicker.resume(composerFrame(event),input));
  ipcMain.handle('sandbook:cancel-controlled-attachments',(event,input)=>controlledAttachmentPicker.cancel(composerFrame(event),input));
  ipcMain.handle('sandbook:download-controlled-attachment',(event,input)=>{composerFrame(event);return downloadControlledAttachment(event.sender,input);});
  ipcMain.handle('sandbook:capture-composer-attachments',(event,input)=>composerCapture.capture(composerFrame(event),input));
  ipcMain.handle('sandbook:cancel-composer-capture',(event,input)=>composerCapture.cancel(composerFrame(event),input));
  ipcMain.handle('sandbook:set-screen-permission',async(event,change)=>{applicationFrame(event);return api('/screen-permissions',change);});const handle=(name,fn)=>ipcMain.handle('sandbook:'+name,async(event,...args)=>{trusted(event);return fn(...args);});
  ipcMain.handle('sandbook:browser-command',(event,payload)=>{
    trusted(event);if(event.sender!==mainWindow?.webContents||event.senderFrame!==mainWindow.webContents.mainFrame)throw new Error('Browser capability is restricted to the main window.');
    // Keep validation and mutation ordered: a delayed show must never overtake a
    // newer hide caused by opening an application dialog or changing a panel.
    const task=browserCommands.then(async()=>{if(quitting)throw new Error('应用正在关闭。');const snapshot=await api('/snapshot');if(!snapshot.conversations.some(conversation=>conversation.id===payload?.conversationId))throw new Error('会话不存在。');return conversationBrowser.command(payload);});
    browserCommands=task.catch(()=>{});return task;
  });
  handle('show-main',showMain);handle('toggle-pet',togglePet);handle('pet-click-through',setPetClickThrough);handle('runtime-gui',openRuntimeGui);
  handle('import-asset',async()=>{const chosen=await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || mainWindow,{title:'导入角色形象',properties:['openFile'],filters:[{name:'角色形象',extensions:['png','webp','gif','vrm','zip']}]});if(chosen.canceled)return null;return api('/assets/import',{path:chosen.filePaths[0]});});
  handle('set-theme',value=>{if(!['system','light','dark'].includes(value))throw new Error('无效主题');nativeTheme.themeSource=value;});
  handle('save-export',async({name,content}={})=>{if(typeof content!=='string'||Buffer.byteLength(content)>32*1024*1024)throw new Error('导出内容无效或过大');const filename=typeof name==='string'?path.basename(name).slice(0,150):'sandbook-export.json';const chosen=await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() || mainWindow,{title:'保存导出文件',defaultPath:path.join(app.getPath('downloads'),filename)});if(chosen.canceled)return null;await writeFile(chosen.filePath,content,{mode:0o600});return {path:chosen.filePath};});
  handle('choose-runtime-connection',async()=>{const selected=await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || mainWindow,{title:'选择 DSH 插件连接文件',defaultPath:path.join(app.getPath('home'),'.dsh/suna-bridge/connection.json'),properties:['openFile','showHiddenFiles'],filters:[{name:'DSH connection.json',extensions:['json']}]});if(selected.canceled)return null;return api('/runtime/connect',{discoveryFile:selected.filePaths[0]});});
  handle('install-runtime-plugin',async()=>{
    const home=await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || mainWindow,{title:'选择目标 DSH 的数据目录（DSH_HOME）',defaultPath:path.join(app.getPath('home'),'.dsh'),properties:['openDirectory','showHiddenFiles']});if(home.canceled)return null;
    const target=await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || mainWindow,{title:'选择已有 DeepSeek Harness 应用或 CLI 入口',defaultPath:process.platform==='darwin'?'/Applications/DeepSeek Harness.app':undefined,properties:['openFile','showHiddenFiles'],filters:[{name:'DeepSeek Harness',extensions:['app','exe','js','mjs']}]});if(target.canceled)return null;
    const chosen=target.filePaths[0];let executable=path.join(runtimeRoot,'bin',process.platform==='win32'?'node.exe':'node'),cliPath=chosen,profileName='web';
    if(process.platform==='darwin'&&chosen.endsWith('.app')){executable=path.join(chosen,'Contents/MacOS/DeepSeek Harness');cliPath=path.join(chosen,'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');profileName='desktop';if(!await exists(executable)||!await exists(cliPath))throw new Error('所选应用不包含受支持的 DSH 桌面 CLI。');}
    else if(process.platform==='win32'&&chosen.toLowerCase().endsWith('.exe')){executable=chosen;cliPath=path.join(path.dirname(chosen),'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');profileName='desktop';if(!await exists(cliPath))throw new Error('所选程序不包含受支持的 DSH 桌面 CLI。');}
    return api('/runtime/install-plugin',{dshHome:home.filePaths[0],profileName,executable,cliPath});
  });
}
async function shutdown(){if(shutdownTask)return shutdownTask;quitting=true;shutdownTask=(async()=>{managementNavigation.close();windowAppearance.close();await conversationBrowser.close();await captureHost.close();controlledAttachmentPicker.close();await composerCapture.close();await screenCaptureHost.close();for(const w of BrowserWindow.getAllWindows())w.destroy();tray?.destroy();if(backend&&backend.exitCode===null){await new Promise(resolve=>{const processToClose=backend;const timer=setTimeout(()=>processToClose.kill('SIGTERM'),8000),kill=setTimeout(()=>processToClose.kill('SIGKILL'),12000);processToClose.once('exit',()=>{clearTimeout(timer);clearTimeout(kill);resolve();});if(processToClose.connected)processToClose.send({type:'shutdown'},error=>{if(error)processToClose.kill('SIGTERM');});else processToClose.kill('SIGTERM');});}})();return shutdownTask;}



if(!app.requestSingleInstanceLock()){app.quit();}else{
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void app.whenReady().then(shutdown).finally(()=>app.exit());});
  app.on('second-instance',()=>{if(rendererUrl)showMain();});
  app.on('activate',()=>{if(rendererUrl)showMain();});
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{if(!shutdownTask){event.preventDefault();void shutdown().finally(()=>app.exit());}});
  app.whenReady().then(async()=>{app.dock?.setIcon(applicationIcon);await startBackend();await restoreWindowAppearance();setupIpc();Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'沙之书',submenu:[{label:'关于沙之书',role:'about'},{type:'separator'},{label:'设置…',accelerator:'CommandOrControl+,',click:()=>void openSettings().catch(showError)},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{label:'退出沙之书',role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]}]));app.setAboutPanelOptions({applicationName:'沙之书',applicationVersion:displayProductVersion(app.getVersion()),copyright:'沙之书 · SUNA'});tray=new Tray(trayImage());tray.setToolTip('沙之书');tray.on('click',showMain);refreshTray();createMain();}).catch(async error=>{await showError(error);await shutdown();app.exit(1);});
}
