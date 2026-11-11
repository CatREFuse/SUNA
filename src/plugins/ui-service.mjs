import {readFile} from 'node:fs/promises';
import {readPluginUI,pluginUICsp} from './ui-package.mjs';

// All operations are bound to the installed plugin selected by the host, never
// to an arbitrary URL or plugin ID supplied by iframe code.
export function createPluginUIService({channelHost,channelRouter,pluginHost,clientPluginHost,book,channelAvatars,characterAvatars,managedNapcat}){
  const loginSessions=new Map(),managedJobs=new Map();
  const find=id=>{const record=clientPluginHost?.plugins.get(id)??channelHost.plugins.get(id)??pluginHost.plugins.get(id);if(!record)throw new Error('PLUGIN_NOT_INSTALLED');return record;};
  const accounts=id=>channelRouter.list().connections.filter(account=>account.pluginId===id);
  const ownAccount=(id,key)=>{const account=accounts(id).find(item=>item.accountId===key);if(!account)throw new Error('PLUGIN_ACCOUNT_FORBIDDEN');return account;};
  const cleanSchema=manifest=>Object.fromEntries(Object.entries(manifest.configSchema).map(([key,value])=>{const field={...value};if(field.type==='secret')delete field.default;return [key,field];}));
  const managedAccount=key=>managedNapcat?.list().find(instance=>instance.accountId===key||`napcat-${instance.id}`===key);
  const managedAvailability=async()=>managedNapcat?managedNapcat.availability():{available:false,canCreate:false,reason:'NAPCAT_RUNTIME_UNAVAILABLE'};
  async function createManaged(id,params){
    if(id!=='suna-napcat')throw new Error('PLUGIN_UI_METHOD_UNSUPPORTED');
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(params.requestId??'')||typeof params.characterId!=='string')throw new Error('NAPCAT_REQUEST_INVALID');
    if(!book.snapshot().characters.some(character=>character.id===params.characterId))throw new Error('CHARACTER_NOT_FOUND');
    const key=params.requestId;
    const operation=(managedJobs.get(key)??Promise.resolve()).catch(()=>{}).then(async()=>{
      const availability=await managedAvailability();if(!availability.available||!availability.canCreate)throw new Error(availability.reason??'NAPCAT_RUNTIME_UNAVAILABLE');
      const instance=await managedNapcat.create({characterId:params.characterId,requestId:key});
      const accountId=instance.accountId??`napcat-${instance.id}`;
      let account=channelRouter.list().connections.find(item=>item.accountId===accountId);
      if(account&&(account.pluginId!==id||account.characterId!==params.characterId))throw new Error('NAPCAT_ACCOUNT_BINDING_CONFLICT');
      try{
        if(!account)account=await channelRouter.create({accountId,pluginId:id,characterId:params.characterId,autoConnect:false,config:{...managedNapcat.connection(instance.id),autoReply:false,receiveEvents:false}});
        await managedNapcat.bindAccount(instance.id,accountId);
      }catch(error){await managedNapcat.stop(instance.id).catch(()=>{});throw error;}
      let login;try{const status=await channelHost.getLoginQr(accountId,{refresh:false});login={status:status.status==='confirmed'?'confirmed':status.status==='wait'?'wait':'offline',online:status.online===true,...(typeof status.qrContent==='string'?{qrContent:status.qrContent}:{}),...(typeof status.selfId==='string'?{selfId:status.selfId}:{}),...(typeof status.nickname==='string'?{nickname:status.nickname}:{})};}
      catch{return {accountId,instanceId:instance.id,state:instance.status==='running'?'starting':instance.status,login:{status:'offline'},error:{code:'NAPCAT_LOGIN_UNAVAILABLE',message:'无法读取登录状态'}};}
      return {accountId,instanceId:instance.id,state:instance.status==='running'?(login.status==='confirmed'?'running':'awaiting-login'):instance.status,login};
    });
    managedJobs.set(key,operation);void operation.finally(()=>{if(managedJobs.get(key)===operation)managedJobs.delete(key);}).catch(()=>{});return operation;
  }
  async function rpc(id,input){
    const {manifest}=find(id);
    if(manifest.kind==='client')return clientPluginHost.rpc(id,input);
    if(!input||typeof input.method!=='string'||!input.params||typeof input.params!=='object'||Array.isArray(input.params)||JSON.stringify(input).length>65536)throw new Error('PLUGIN_UI_REQUEST_INVALID');
    const {method,params}=input;
    if(method==='context')return {plugin:{id:manifest.id,name:manifest.name,kind:manifest.kind,version:manifest.version,administratorProtocol:manifest.administratorProtocol,configSchema:cleanSchema(manifest)},characters:book.snapshot().characters.map(({id,name})=>({id,name})),accounts:manifest.kind==='channel'?accounts(id).map(account=>{const instance=managedAccount(account.accountId);return {...account,...(instance?{managed:{instanceId:instance.id,state:instance.status}}:{})}}):[],...(id==='suna-napcat'?{managedNapcat:await managedAvailability()}:{}),configuration:manifest.kind==='ttuf'?pluginHost.listPlugins().find(plugin=>plugin.id===id):undefined};
    if(method==='config.save'&&manifest.kind==='ttuf')return pluginHost.configure(id,params.config);
    if(manifest.kind!=='channel')throw new Error('PLUGIN_UI_METHOD_UNSUPPORTED');
    if(method==='characters.avatar'){if(!accounts(id).some(account=>account.characterId===params.characterId))throw new Error('PLUGIN_CHARACTER_FORBIDDEN');const character=book.snapshot().characters.find(item=>item.id===params.characterId);if(!character)throw new Error('PLUGIN_CHARACTER_FORBIDDEN');return characterAvatars?characterAvatars.get(character):{dataUrl:null};}
    if(method==='channels.managed.create')return createManaged(id,params);
    if(method==='channels.create')return channelRouter.create({pluginId:id,characterId:params.characterId,config:params.config});
    if(!['channels.update','channels.remove','channels.connect','channels.disconnect','channels.qr','channels.poll','channels.avatar','channels.administrator.save'].includes(method))throw new Error('PLUGIN_UI_METHOD_UNSUPPORTED');
    const account=ownAccount(id,params.accountId);
    const key=params.accountId;
    if(['channels.connect','channels.qr'].includes(method)){const instance=managedAccount(key);if(instance&&managedNapcat.start)await managedNapcat.start(instance.id);}
    if(method==='channels.administrator.save')return channelRouter.setAdministrator(key,{characterId:params.characterId,administratorUid:params.administratorUid});
    if(method==='channels.avatar'){if(manifest.platform!=='qq')throw new Error('CHANNEL_AVATAR_UNAVAILABLE');const status=await channelHost.getLoginQr(key,{refresh:false});const avatar=await channelAvatars.get(status?.selfId??account.selfId);return {dataUrl:avatar.dataUrl};}
    if(method==='channels.update'){if(managedAccount(key)&&(params.characterId&&params.characterId!==account.characterId||Object.keys(params.config??{}).some(field=>!['autoReply','receiveEvents'].includes(field))))throw new Error('NAPCAT_MANAGED_CONFIG_PROTECTED');return channelRouter.update(key,{characterId:params.characterId,config:params.config});}
    if(method==='channels.remove'){const instance=managedAccount(key);if(instance)await managedNapcat.remove(instance.id);loginSessions.delete(key);return channelRouter.remove(key);}
    if(method==='channels.connect')return channelRouter.connect(key);
    if(method==='channels.disconnect')return channelRouter.disconnect(key);
    if(method==='channels.qr'){const result=await channelHost.getLoginQr(key,{refresh:true});loginSessions.set(key,result.session??{});const {session,...publicResult}=result;return publicResult;}
    // Polling the view is read-only: a connected login does not automatically
    // connect this application or change persisted auto-connect preferences.
    try{const result=await channelHost.pollLogin(key,loginSessions.get(key)??{});const {session,...publicResult}=result;return publicResult;}catch(error){if(error.message!=='CHANNEL_QR_UNSUPPORTED')throw error;const {session,...result}=await channelHost.getLoginQr(key,{refresh:false});return result;}
  }
  return {rpc,isManagedAccount:key=>Boolean(managedAccount(key)),async document(id){const html=await readPluginUI(find(id));const sdk=await readFile(new URL('./ui-sdk.js',import.meta.url),'utf8');const prefix=`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script${id==='suna-dsh-plugins'?' data-suna-plugin-id="suna-dsh-plugins"':''}>${sdk}</script>`;return {csp:pluginUICsp,html:/<head(?:\s[^>]*)?>/i.test(html)?html.replace(/<head(?:\s[^>]*)?>/i,match=>match+prefix):`<!doctype html><html><head>${prefix}</head><body>${html}</body></html>`};}};
}
