import {WebContentsView,session} from 'electron';
import {createHash,randomUUID} from 'node:crypto';
import {browserUrl,browserBounds,conversationKey} from './browser-policy.mjs';

// Views belong exclusively to the main window. Remote content has no preload or
// app IPC bridge, and each conversation owns a fresh, non-persistent Session.
export function createConversationBrowser({deniedOrigins=()=>[],onState=()=>{},maxPages=12}={}){
  const pages=new Map(),cleanup=new Set();
  let window,active,attached,pendingBounds,closeTask,closed=false;
  const origins=()=>deniedOrigins().filter(Boolean);
  const state=entry=>{
    if(!entry)return {url:'',title:'',loading:false,canGoBack:false,canGoForward:false,error:'',visible:false};
    const wc=entry.view.webContents,alive=!wc.isDestroyed();
    return {conversationId:entry.id,url:alive&&wc.getURL()!=='about:blank'?wc.getURL():'',title:alive?wc.getTitle().slice(0,200):'',loading:alive&&wc.isLoading(),canGoBack:alive&&wc.navigationHistory.canGoBack(),canGoForward:alive&&wc.navigationHistory.canGoForward(),error:entry.error,visible:attached===entry.id};
  };
  const emit=entry=>{if(!closed)onState(state(entry));};
  function detach(){if(!attached)return;const entry=pages.get(attached);attached=undefined;if(entry){entry.view.setVisible(false);if(window&&!window.isDestroyed())window.contentView.removeChildView(entry.view);emit(entry);}}
  function suspend(){active=undefined;pendingBounds=undefined;detach();}
  function attachWindow(next){
    if(window===next)return;
    if(window&&!window.isDestroyed())throw new Error('浏览器已绑定主窗口。');
    window=next;
    for(const event of ['hide','minimize','resize'])next.on(event,suspend);
    next.webContents.on('did-start-navigation',event=>{if(event.isMainFrame)suspend();});
    next.webContents.on('render-process-gone',()=>void close());
    next.on('closed',()=>void close());
  }
  async function release(id){
    const entry=pages.get(id);if(!entry){if(active===id)suspend();return;}
    if(attached===id)detach();if(active===id)active=undefined;pages.delete(id);
    entry.released=true;
    const wc=entry.view.webContents;
    if(!wc.isDestroyed()){wc.stop();wc.close({waitForBeforeUnload:false});}
    const task=Promise.allSettled([entry.session.closeAllConnections(),entry.session.clearStorageData(),entry.session.clearCache()]);
    cleanup.add(task);await task;cleanup.delete(task);
  }
  function create(id){
    if(pages.size>=maxPages)throw new Error(`已打开 ${maxPages} 个会话网页，请先关闭不再使用的网页。`);
    const partition='sandbook-browser-'+createHash('sha256').update(id).digest('hex')+'-'+randomUUID();
    const ses=session.fromPartition(partition,{cache:false});
    const view=new WebContentsView({webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,plugins:false,devTools:false,navigateOnDragDrop:false,disableDialogs:true,safeDialogs:true}});
    view.setBackgroundColor('#ffffff');view.setVisible(false);
    const entry={id,view,session:ses,error:'',released:false,hasNavigation:false,bounds:null};pages.set(id,entry);
    const wc=view.webContents;
    const fail=message=>{entry.error=message;emit(entry);};
    const valid=value=>{try{browserUrl(value,{deniedOrigins:origins()});return true;}catch{return false;}};
    ses.setPermissionCheckHandler(()=>false);
    ses.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    ses.setDevicePermissionHandler(()=>false);
    ses.setDisplayMediaRequestHandler((_request,callback)=>callback({}));
    ses.on('will-download',event=>{event.preventDefault();fail('内嵌网页暂不支持下载文件。');});
    ses.webRequest.onBeforeRequest((details,callback)=>{
      const frame=['mainFrame','subFrame'].includes(details.resourceType);
      let blocked=frame&&!valid(details.url);
      try{const url=new URL(details.url);if(['http:','https:','ws:','wss:'].includes(url.protocol)){if(url.protocol==='ws:')url.protocol='http:';if(url.protocol==='wss:')url.protocol='https:';browserUrl(url.href,{deniedOrigins:origins()});}else if(!['data:','blob:'].includes(url.protocol))blocked=true;}catch{blocked=true;}
      callback({cancel:blocked});
      if(blocked&&details.resourceType==='mainFrame')fail('该地址已被浏览器安全边界阻止。');
    });
    wc.setWindowOpenHandler(()=>{fail('此网页尝试打开新窗口；请在地址栏打开所需链接。');return{action:'deny'};});
    wc.on('will-attach-webview',event=>event.preventDefault());
    for(const event of ['will-navigate','will-frame-navigate','will-redirect'])wc.on(event,details=>{if(!valid(details.url)){details.preventDefault();fail('只允许导航到 HTTP 或 HTTPS 网页。');}});
    wc.on('will-prevent-unload',event=>event.preventDefault());
    wc.on('did-start-navigation',details=>{if(details.isMainFrame){entry.error='';emit(entry);}});
    for(const event of ['did-start-loading','did-stop-loading','did-navigate','did-navigate-in-page','page-title-updated'])wc.on(event,()=>emit(entry));
    wc.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)fail(`网页加载失败（${code}），请检查地址后重试。`);});
    wc.on('render-process-gone',()=>{fail('网页进程已停止，请关闭网页后重新打开。');if(attached===id)detach();});
    return entry;
  }
  function show(entry,bounds){
    detach();active=entry.id;pendingBounds=bounds;entry.bounds=bounds;
    const rect=window&&!window.isDestroyed()?browserBounds(bounds,window.getContentSize(),window.webContents.getZoomFactor()):null;
    if(!entry.hasNavigation||!rect||!window.isVisible()||window.isMinimized())return;
    window.contentView.addChildView(entry.view);entry.view.setBounds(rect);entry.view.setVisible(true);attached=entry.id;
  }
  async function command(payload={}){
    if(closed||!window||window.isDestroyed())throw new Error('浏览器已关闭。');
    if(!payload||typeof payload!=='object')throw new Error('浏览器请求无效。');
    const id=conversationKey(payload.conversationId),action=payload.action;
    if(!['show','hide','navigate','back','forward','reload','stop','close','state'].includes(action))throw new Error('浏览器操作无效。');
    if(action==='hide'){if(active===id)suspend();return state(pages.get(id));}
    if(action==='close'){await release(id);return {...state(),conversationId:id};}
    const url=action==='navigate'?browserUrl(payload.url,{input:true,deniedOrigins:origins()}):undefined;
    let entry=pages.get(id);
    if(!entry&&action==='show'){detach();active=id;pendingBounds=payload.bounds;return {...state(),conversationId:id};}
    if(!entry&&action==='navigate')entry=create(id);
    if(!entry)return {...state(),conversationId:id};
    const wc=entry.view.webContents;
    if(action==='show')show(entry,payload.bounds);
    if(action==='navigate'){
      entry.error='';entry.hasNavigation=true;
      // Do not await navigation: a later hide/switch must not wait for a server.
      void wc.loadURL(url).catch(error=>{if(!entry.released&&!wc.isDestroyed()&&error.code!=='ERR_ABORTED'){entry.error='网页未能加载，请检查地址或网络连接。';emit(entry);}});
      if(active===id)show(entry,pendingBounds);
    }
    if(action==='back'&&wc.navigationHistory.canGoBack())wc.navigationHistory.goBack();
    if(action==='forward'&&wc.navigationHistory.canGoForward())wc.navigationHistory.goForward();
    if(action==='reload'){entry.error='';wc.reload();}
    if(action==='stop')wc.stop();
    const current=state(entry);emit(entry);return current;
  }
  function close(){if(closeTask)return closeTask;closed=true;suspend();closeTask=(async()=>{await Promise.all([...pages.keys()].map(release));await Promise.allSettled([...cleanup]);})();return closeTask;}
  return {attachWindow,command,suspend,close};
}
