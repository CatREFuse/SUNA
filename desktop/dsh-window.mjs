export function externalWebUrl(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
// DSH preopens about:blank synchronously, then replaces its location after OAuth RPC.
export function installDshPopups(window,{openExternal,onError=()=>{}}){
 const pending=new Set();
 const launch=url=>{const target=externalWebUrl(url);if(target)void Promise.resolve().then(()=>openExternal(target)).catch(onError);};
 window.webContents.setWindowOpenHandler(({url})=>url==='about:blank'?{action:'allow',overrideBrowserWindowOptions:{show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,preload:undefined}}}:(launch(url),{action:'deny'}));
 window.webContents.on('did-create-window',child=>{
  pending.add(child);let dispatched=false;
  const navigate=(event,url)=>{if(url==='about:blank')return;event.preventDefault();if(!dispatched){dispatched=true;launch(url);}setImmediate(()=>{if(!child.isDestroyed())child.close();});};
  child.webContents.on('will-navigate',navigate);child.webContents.on('will-redirect',navigate);
  child.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  child.webContents.session.setPermissionRequestHandler((_wc,_permission,reply)=>reply(false));
  const timer=setTimeout(()=>{if(!child.isDestroyed())child.close();},300000);timer.unref?.();child.on('closed',()=>{clearTimeout(timer);pending.delete(child);});
 });
 window.on('closed',()=>{for(const child of pending)if(!child.isDestroyed())child.close();pending.clear();});
}
