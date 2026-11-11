import {displayProductVersion} from './shared/product-version.mjs';
import {createInteractionRoutes} from './server/interaction-routes.mjs';
import {createControlledAttachmentRoutes} from './server/controlled-attachment-routes.mjs';
import {createStartupNotifier,loadStartupNotes} from './server/startup-notifier.mjs';
import {createStartupNotificationChannel} from './server/startup-notification-channel.mjs';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir,readFile,writeFile,rm,stat,realpath,readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { randomBytes,randomUUID } from 'node:crypto';
import {createComposerAttachments} from './core/composer-attachments.mjs';
import {createComposerAttachmentRoutes} from './server/composer-attachment-routes.mjs';
import { createBookService } from './core/book-service.mjs';
import { createCharacterLibrary } from './core/character-library.mjs';
import { createCharacterResourceRoutes } from './server/character-resources.mjs';
import {createPersonProfileRoutes} from './server/person-profile-routes.mjs';
import {createLocalRoleRoutes} from './server/local-role-routes.mjs';
import { createScreenPermissions } from './core/screen-permissions.mjs';
import { createWebsearchService } from './core/websearch.mjs';
import { createWorkspacePreviewService } from './core/workspace-preview.mjs';
import { createDshRuntime } from './runtime/dsh-runtime.mjs';
import { createWorkerClientRequest } from './client/worker-request.mjs';
import { createProviderRegistry } from './models/provider-registry.mjs';
import { createModelProviderService } from './models/provider-service.mjs';
import { ChannelHost } from './channels/core.mjs';
import { createZip,readZip } from './channels/archive.mjs';
import { createChannelAvatars, channelMessageAvatarId } from './server/channel-avatars.mjs';
import { createPluginUIService } from './plugins/ui-service.mjs';
import {createDshClientPlugin,DSH_CLIENT_PLUGIN_ID} from './plugins/dsh-client-plugin.mjs';
import {parseDshPluginManagement,isDshPluginManagementRead} from './runtime/dsh-plugin-management-contract.mjs';
import { createCharacterAvatars } from './plugins/character-avatars.mjs';
import { createNapcatManaged } from './plugins/napcat-managed.mjs';
import { TtufHost } from './plugins/ttuf-host.mjs';
import {ToolPluginHost} from './plugins/tool-host.mjs';
import {createCodexImageService} from './client/codex-image-service.mjs';
import {prepareSelfieReference} from './client/selfie-reference-preparation.mjs';
import {createCodexCliImageBackend} from './client/codex-cli-image-backend.mjs';
import {createSelfieRewriter} from './client/selfie-rewrite.mjs';
import {createSelfieLibrary} from './plugins/selfie-library.mjs';
import {createSelfieLibraryRoutes} from './server/selfie-library-routes.mjs';
import { createAssetStore } from './assets/asset-store.mjs';
import { byteRange } from './server/channel-media.mjs';
import { createChannelRouter } from './server/channel-router.mjs';
import { atomicJson,loadJson,readBody,readJson,equalSecret,httpError,safeError,sanitize,mimeTypes } from './server/security.mjs';

const defaultProject=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uploadLimit=224*1024*1024;
const codeStatus=code=>({ATTACHMENT_NOT_FOUND:404,ATTACHMENT_LIMIT:413,CONVERSATION_INACTIVE:409,IDEMPOTENCY_CONFLICT:409,TASK_ID_CONFLICT:409,WORKER_BUSY:409,TARGET_DENIED:403,VERSION_CONFLICT:409,DEVELOPER_MODE_REQUIRED:403,CHARACTER_NOT_FOUND:404,CONVERSATION_NOT_FOUND:404,TEST_NOT_FOUND:404,TASK_NOT_FOUND:404,CHECKPOINT_NOT_FOUND:404,TEST_BUSY:409,TEST_ONLY:403}[code]??400);

export async function createBookServer({projectRoot=defaultProject,dataDir=path.join(projectRoot,'.suna'),port=4261,host='127.0.0.1',runtimeDir,pluginDir,uiDir=path.join(projectRoot,'dist'),development=false,runtime:runtimeOverride,workerClient:workerClientOverride,toneClient:toneClientOverride,channelHost:channelOverride,channelAvatars:channelAvatarsOverride,managedNapcat:managedNapcatOverride,napcatRuntimeDir,assetStore:assetsOverride,toolServices={},searchTransport,codexImageService:codexImageOverride}={}){
  if(host!=='127.0.0.1')throw new Error('沙之书本地服务只允许绑定 127.0.0.1');
  projectRoot=path.resolve(projectRoot);dataDir=path.resolve(dataDir);uiDir=path.resolve(uiDir);await mkdir(dataDir,{recursive:true,mode:0o700});
  const packageMetadata=await loadJson(path.join(projectRoot,'package.json'),{}),productVersion=typeof packageMetadata.version==='string'?packageMetadata.version:'development';
  const csrfToken=randomBytes(32).toString('hex'),nativeToken=randomBytes(32).toString('hex'),sseClients=new Set(),sockets=new Set(),loginSessions=new Map(),requests=new Set();let screenPermissions;let closing=false,closeTask,channelRouter,toolPluginHost,startupNotifier,baseUrl='',persistLogs=Promise.resolve();
  const logsFile=path.join(dataDir,'logs/server.json'),serverLogs=await loadJson(logsFile,[]);let logTimer;
  function log(event,payload={}){const entry={time:new Date().toISOString(),event,payload:sanitize(payload)};serverLogs.push(entry);if(serverLogs.length>1000)serverLogs.splice(0,serverLogs.length-1000);clearTimeout(logTimer);logTimer=setTimeout(()=>{persistLogs=persistLogs.catch(()=>{}).then(()=>atomicJson(logsFile,serverLogs));},150);logTimer.unref?.();}
  function changed(event={}){if(event.type==='conversation-observability.changed'&&(closing||!book.isDeveloperMode()))return;const value=JSON.stringify({type:event.type??'changed',...(event.conversationId?{conversationId:event.conversationId}:{}),...(event.sessionId?{sessionId:event.sessionId}:{})});for(const res of sseClients){if(!res.write(`data: ${value}\n\n`)){res.end();sseClients.delete(res);}}}
  const registry=createProviderRegistry({dataDir:path.join(dataDir,'runtime')});
  await registry.publicState();
  const runtime=runtimeOverride??createDshRuntime({registry,projectRoot,dataDir:path.join(dataDir,'runtime'),runtimeDir,pluginDir,logger:entry=>log('runtime',entry)});
  const workerClient=workerClientOverride??toneClientOverride??createWorkerClientRequest({registry,getDshProviderConfig:runtime.getClientModelConfig,dataDir:path.join(dataDir,'runtime'),runtimeDir:runtimeDir??path.join(projectRoot,'runtime/dsh'),pluginDir:pluginDir??path.join(projectRoot,'plugins/suna-dsh')});
  const modelProviders=createModelProviderService({registry,runtime});
  const channelHost=channelOverride??new ChannelHost({pluginRoot:path.join(dataDir,'channels/plugins'),log,onConfigUpdate:(accountId,patch)=>channelRouter?.saveConfig(accountId,patch)});
  await channelHost.init();
  const assets=assetsOverride??createAssetStore({dataDir});
  const search=await createWebsearchService({dataDir,...(searchTransport?{fetchImpl:searchTransport}:{})});
  const workspacePreview=toolServices.workspacePreview??createWorkspacePreviewService();
  const services=Object.create(toolServices);Object.defineProperty(services,'workspacePreview',{value:workspacePreview});Object.defineProperty(services,'screenAccess',{get:()=>screenPermissions&&typeof toolServices.captureScreen==='function'?{capture:toolServices.captureScreen,releaseRun:toolServices.releaseScreenRun,revoke:toolServices.revokeScreen}:undefined});Object.defineProperty(services,'websearch',{get:()=>search.available?search.search:undefined});Object.defineProperty(services,'webfetch',{get:()=>search.fetchAvailable?search.fetch:undefined});
  Object.defineProperty(services,'toolPlugins',{get:()=>toolPluginHost});
  const composerAttachments=await createComposerAttachments({root:path.join(dataDir,'book/composer-attachments'),mediaDir:path.join(dataDir,'book/attachments'),getConversation:id=>book.snapshot().conversations.find(c=>c.id===id)});
  const book=createBookService({composerAttachments,dataDir:path.join(dataDir,'book'),runtime,workerClient,toolServices:services,media:{assetRoot:path.join(dataDir,'assets'),resolveAsset:url=>assets.resolveUrlPath(url)},channels:{send:request=>channelRouter.send(request),preflight:request=>channelRouter.preflight(request),canReply:request=>channelRouter?.canReply(request)??false,replyLease:request=>channelRouter?.replyLease(request)??null,isAdministrator:request=>channelRouter?.isAdministrator(request)??false,permissionStatus:request=>channelRouter?.permissionStatus(request)??{ready:false,reason:'CHANNEL_PERMISSION_UNAVAILABLE'},primaryUserAliases:input=>channelRouter?.primaryUserAliases(input)??[],permissionChannels:()=>channelRouter?.list().connections.map(account=>({accountId:account.accountId,characterId:account.characterId,...account.administratorStatus}))??[]}});
  const interactionRoutes=createInteractionRoutes({book,writeJson,readJson,native});
  const characterLibrary=await createCharacterLibrary({dataDir,validateCharacter:book.validateCharacter});
  Object.defineProperty(services,'characterLibrary',{get:()=>characterLibrary});
  const characterResourceRoutes=createCharacterResourceRoutes({book,library:characterLibrary,writeJson,isClosing:()=>closing});
  const localRoleRoutes=createLocalRoleRoutes({book,writeJson,requireNative:native,isClosing:()=>closing});
  const personProfileRoutes=createPersonProfileRoutes({profiles:{list:book.listPersonProfiles,detail:book.getPersonProfile},writeJson,isClosing:()=>closing});
  screenPermissions=await createScreenPermissions({file:path.join(dataDir,'permissions/screen.json'),validatePair:pair=>{const snapshot=book.snapshot();return snapshot.characters.some(person=>person.id===pair.characterId)&&snapshot.conversations.some(conv=>conv.id===pair.conversationId&&conv.participantIds.includes(pair.characterId));},onRevoke:async pair=>{book.revokeScreen(pair);await toolServices.revokeScreen?.(pair);changed();}});
  book.migrateScreenPermissions(screenPermissions.migrationRecords());
  const screenSnapshot=()=>({...screenPermissions.snapshot(),available:typeof toolServices.captureScreen==='function'});
  const unsubscribe=book.subscribe(changed);
  // Only verified data archives are imported here; adapter code runs when the user creates an account.
  for(const directory of [path.join(projectRoot,'release/plugins'),path.join(projectRoot,'release/channels'),path.join(uiDir,'plugins')]){
    try{for(const entry of await readdir(directory)){if(!/^suna-(?:napcat|qq-official|weixin-official)-.*\.zip$/.test(entry))continue;const existing=channelHost.listPlugins().some(p=>{if(!entry.startsWith(`${p.id}-`))return false;const candidate=entry.slice(p.id.length+1,-4).split('.').map(Number),current=p.version.split('.').map(Number);return candidate.length===3&&candidate.every(Number.isFinite)&&current.reduce((comparison,n,index)=>comparison||Math.sign(n-candidate[index]),0)>=0;});if(!existing)await channelHost.importPlugin(path.join(directory,entry));}}catch(error){if(error.code!=='ENOENT')log('channel.bundled_import.failed',{error:error.message});}
  }
  channelRouter=await createChannelRouter({dataDir,host:channelHost,book,composerAttachments,log,changed,onPermissionsChanged:change=>book.revokeToolPermissions(change)});
  const pluginHost=new TtufHost({pluginRoot:path.join(dataDir,'plugins/ttuf'),sendTTM:input=>book.sendPluginTTM(input),sendChannel:input=>book.sendPluginChannel(input),log,changed});
  await pluginHost.init();
  const clientPluginHost=await createDshClientPlugin({projectRoot,runtime});
  if([...channelHost.listPlugins(),...pluginHost.listPlugins()].some(plugin=>clientPluginHost.plugins.has(plugin.id)))throw httpError(409,'PLUGIN_ID_CONFLICT','插件标识已被占用');
  const selfieLibrary=createSelfieLibrary({root:path.join(dataDir,'selfie-references')});
  const selfieLibraryRoutes=createSelfieLibraryRoutes({library:selfieLibrary,validateCharacter:book.validateCharacter,writeJson,isClosing:()=>closing});
  const localImage=createCodexCliImageBackend({jobRoot:path.join(dataDir,'codex-image-jobs'),executable:toolServices.codexExecutable,runner:toolServices.codexImageRunner,onDiagnostic:entry=>log('image.cli',entry)});
  const codexImage=codexImageOverride??createCodexImageService({prepareReference:prepareSelfieReference,imageTransport:(payload,scope)=>localImage.generate(payload,scope),rewriteSelfie:createSelfieRewriter({workerClient}),selfieLibrary});
  const imageGenerate=(payload,scope)=>codexImage.generate(payload,{...scope,onDiagnostic:receipt=>log('image.provider.failed',{runId:scope.runId,toolName:scope.toolName,status:receipt.status,error:{code:receipt.error.code,type:receipt.error.type}})});
  imageGenerate.awaitCancellation=true;
  imageGenerate.available=codexImageOverride?.available??((config,scope)=>localImage.available(config,scope));
  toolPluginHost=new ToolPluginHost({pluginRoot:path.join(dataDir,'plugins/tools'),services:{'image.generate':imageGenerate},log,changed});
  await toolPluginHost.init();
  try{if([...channelHost.listPlugins(),...pluginHost.listPlugins()].some(plugin=>plugin.id==='suna-codex-image'))throw httpError(409,'PLUGIN_ID_CONFLICT','插件标识已被占用');await toolPluginHost.installBuiltin(path.join(projectRoot,'plugins/codex-image'));}catch(error){log('plugin.bundled_import.failed',{pluginId:'suna-codex-image',code:error.code??'IMPORT_FAILED'});}

  const controlledAttachmentRoutes=createControlledAttachmentRoutes({store:composerAttachments.controlled,book,native,writeJson});
  const composerAttachmentRoutes=createComposerAttachmentRoutes({store:composerAttachments,book,writeJson,native,screenGrant:pair=>screenPermissions.check(pair),captureAvailable:()=>typeof toolServices.captureScreen==='function',capabilities:async conversationId=>{
    const c=book.snapshot().conversations.find(c=>c.id===conversationId);if(!c)throw httpError(404,'CONVERSATION_NOT_FOUND','会话不存在');
    const senders=(c.participantIds??[]).map(characterId=>({characterId,...(c.channelTarget?channelRouter.composerCapabilities({conversation:c,character:{id:characterId}}):{images:true,files:true,fileMode:'mixed',reply:true})}));
    const eligibleCaptureCharacterIds=[];for(const characterId of c.participantIds??[]){const p=await book.composerCapturePermission?.({conversationId,characterId});if(p?.allowed&&screenPermissions.check({conversationId,characterId}).allowed&&typeof toolServices.captureScreen==='function')eligibleCaptureCharacterIds.push(characterId);}
    return {controlledAttachments:{available:c.channel==='desktop',limits:composerAttachments.controlled.limits},attachments:{images:true,files:true,capture:eligibleCaptureCharacterIds.length>0,limits:{maxImageBytes:composerAttachments.limits.imageBytes,maxFileBytes:composerAttachments.limits.fileBytes,maxTotalBytes:composerAttachments.limits.totalBytes,maxAttachments:composerAttachments.limits.count}},eligibleCaptureCharacterIds,senders};
  }});
  function pluginSnapshot(){return {plugins:[...channelHost.listPlugins().map(plugin=>({id:plugin.id,name:plugin.name,description:plugin.description??'',version:plugin.version,kind:'channel',capabilities:plugin.capabilities,ui:plugin.ui,status:'installed',configSchema:Object.fromEntries(Object.entries(plugin.configSchema).map(([key,value])=>{const field={...value};if(field.type==='secret')delete field.default;return [key,field]})),config:{},hasSecrets:[]})),...pluginHost.listPlugins(),...toolPluginHost.listPlugins(),...clientPluginHost.listPlugins()]};}
  for(const directory of [path.join(projectRoot,'release/plugins'),path.join(uiDir,'plugins')]){try{for(const entry of await readdir(directory)){if(!/^suna-ttuf-.*\.zip$/.test(entry))continue;if(pluginHost.listPlugins().some(plugin=>entry===`${plugin.id}-${plugin.version}.zip`))continue;await pluginHost.importPlugin(path.join(directory,entry));}}catch(error){if(error.code!=='ENOENT')log('plugin.bundled_import.failed',{code:error.code??'IMPORT_FAILED'});}}
  const channelAvatars=channelAvatarsOverride??createChannelAvatars();
  const managedNapcat=managedNapcatOverride??await createNapcatManaged({dataDir,runtimeDir:napcatRuntimeDir??path.join(projectRoot,'runtime/napcat'),onChanged:changed});
  const characterAvatars=createCharacterAvatars({uiDir,resolveAsset:url=>assets.resolveUrlPath(url),resolveMedia:relative=>book.resolveMedia(relative)});
  const pluginUI=createPluginUIService({channelHost,channelRouter,pluginHost,clientPluginHost,book,channelAvatars,characterAvatars,managedNapcat});
  function channelSnapshot(){const result=channelRouter.list();return {...result,connections:result.connections.map(account=>({...account,webhookUrl:result.plugins.find(p=>p.id===account.pluginId)?.capabilities?.includes('webhook')?`${baseUrl}/api/channels/accounts/${encodeURIComponent(account.accountId)}/webhook`:undefined}))};}
  function developer(){if(!book.snapshot().settings.developerMode)throw httpError(403,'DEVELOPER_MODE_REQUIRED','请先打开开发者模式');}
  function writeJson(res,status,value){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));}
  function security(req,res){
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('cross-origin-resource-policy','same-origin');res.setHeader('x-frame-options','DENY');
    const actualPort=server.address()?.port;const hosts=new Set([`127.0.0.1:${actualPort}`,`localhost:${actualPort}`]);if(development){hosts.add('127.0.0.1:4260');hosts.add('localhost:4260');}
    if(!hosts.has(req.headers.host))throw httpError(403,'HOST_REJECTED','请求来源主机无效');
    const origins=new Set([baseUrl,`http://localhost:${actualPort}`]);if(development){origins.add('http://127.0.0.1:4260');origins.add('http://localhost:4260');}
    if(req.headers.origin&&!origins.has(req.headers.origin))throw httpError(403,'ORIGIN_REJECTED','不允许来自其他网站的请求');
    if(req.headers['sec-fetch-site']==='cross-site')throw httpError(403,'ORIGIN_REJECTED','不允许跨站访问本地服务');
    if(!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress))throw httpError(403,'LOCAL_ONLY','只允许本机访问');
  }
  function native(req,message='文件路径导入只允许桌面文件选择器'){if(!equalSecret(req.headers['x-sandbook-native'],nativeToken))throw httpError(403,'NATIVE_REQUIRED',message);}
  async function fileResponse(req,res,filename,{html=false,immutable=false,ranges=false}={}){
    const info=await stat(filename);if(!info.isFile())throw httpError(404,'NOT_FOUND','文件不存在');
    if(html)res.setHeader('content-security-policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    const headers={'content-type':({'.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm'})[path.extname(filename).toLowerCase()]??mimeTypes[path.extname(filename).toLowerCase()]??'application/octet-stream','content-length':info.size,'cache-control':immutable?'private, max-age=31536000, immutable':'no-cache'};
    const range=ranges?byteRange(req.headers.range,info.size):null;
    if(ranges)headers['accept-ranges']='bytes';
    if(range===false){res.writeHead(416,{'content-range':`bytes */${info.size}`,'content-length':0});res.end();return;}
    if(range){headers['content-range']=`bytes ${range.start}-${range.end}/${info.size}`;headers['content-length']=range.end-range.start+1;}
    res.writeHead(range?206:200,headers);if(req.method==='HEAD'){res.end();return;}createReadStream(filename,range??{}).on('error',()=>res.destroy()).pipe(res);
  }
  async function staticResponse(req,res,url){
    if(!['GET','HEAD'].includes(req.method))throw httpError(405,'METHOD_NOT_ALLOWED','请求方法不支持');
    if(url.pathname.startsWith('/assets-local/'))return fileResponse(req,res,await assets.resolveUrlPath(url.pathname),{immutable:true});
    if(url.pathname.startsWith('/media-local/')){const relative=url.pathname.slice('/media-local/'.length),video=/\.(mp4|webm|mov)$/.test(relative);return fileResponse(req,res,await (video?channelRouter.resolveVideo(relative):book.resolveMedia(relative)),{immutable:true,ranges:video});}
    let decoded;try{decoded=decodeURIComponent(url.pathname);}catch{throw httpError(400,'PATH_INVALID','路径无效');}
    if(decoded.includes('\0')||decoded.includes('\\')||decoded.split('/').some(p=>p==='..'||p.startsWith('.')))throw httpError(403,'PATH_INVALID','路径无效');
    const target=path.resolve(uiDir,'.'+decoded);if(target!==uiDir&&!target.startsWith(uiDir+path.sep))throw httpError(403,'PATH_INVALID','路径越界');
    let filename=target;try{if((await stat(filename)).isDirectory())filename=path.join(filename,'index.html');const actual=await realpath(filename),root=await realpath(uiDir);if(!actual.startsWith(root+path.sep))throw httpError(403,'PATH_INVALID','文件路径越界');}catch(error){if(error.code!=='ENOENT')throw error;if(path.extname(decoded))throw httpError(404,'NOT_FOUND','文件不存在');filename=path.join(uiDir,'index.html');}
    try{return await fileResponse(req,res,filename,{html:filename.endsWith('.html')});}catch(error){if(error.code==='ENOENT'){res.writeHead(503,{'content-type':'text/plain; charset=utf-8'});res.end('前端尚未构建。开发时访问 http://127.0.0.1:4260，或先运行 npm run build。');return;}throw error;}
  }
  async function uploadedFile(req,body,extension='.zip'){
    if(body.path){native(req);const info=await stat(body.path);if(!info.isFile()||info.size>uploadLimit)throw httpError(413,'BODY_TOO_LARGE','文件无效或过大');return {filename:path.resolve(body.path),cleanup:async()=>{}};}
    if(typeof body.data!=='string'||body.data.length>12*1024*1024||! /^[A-Za-z0-9+/]*={0,2}$/.test(body.data))throw httpError(400,'UPLOAD_INVALID','上传文件无效');const bytes=Buffer.from(body.data,'base64');if(bytes.toString('base64')!==body.data)throw httpError(400,'UPLOAD_INVALID','上传文件编码无效');const directory=path.join(dataDir,'uploads');await mkdir(directory,{recursive:true,mode:0o700});const filename=path.join(directory,`${randomUUID()}${extension}`);await writeFile(filename,bytes,{mode:0o600});return {filename,cleanup:()=>rm(filename,{force:true})};
  }
  async function route(req,res){
    if(closing)throw httpError(503,'SERVICE_CLOSING','沙之书正在关闭');
    security(req,res);const url=new URL(req.url,baseUrl);if(!url.pathname.startsWith('/api/'))return staticResponse(req,res,url);const pathname=url.pathname.slice(4),method=req.method;
    if(method==='GET'&&pathname==='/bootstrap')return writeJson(res,200,{csrfToken,product:'沙之书',version:productVersion,versionDisplay:displayProductVersion(productVersion)});
    const webhook=pathname.match(/^\/channels\/accounts\/([^/]+)\/webhook$/);
    if(webhook){if(req.headers.origin)throw httpError(403,'WEBHOOK_BROWSER_REJECTED','平台回调不接受浏览器来源');const rawBody=await readBody(req,1024*1024);if(closing)throw httpError(503,'SERVICE_CLOSING','沙之书正在关闭');const result=await channelHost.handleWebhook(decodeURIComponent(webhook[1]),{rawBody,headers:req.headers,method});return writeJson(res,result.status??200,result.body??{});}
    if(!['GET','HEAD'].includes(method)&&!equalSecret(req.headers['x-sandbook-csrf'],csrfToken))throw httpError(403,'CSRF_REQUIRED','页面验证已失效，请刷新后重试');
    if(await interactionRoutes({req,res,pathname,method}))return;
    if(await controlledAttachmentRoutes.handle({req,res,pathname,method}))return;
    if(await composerAttachmentRoutes.handle({req,res,pathname,method}))return;
    const characterDreamRun=pathname.match(/^\/characters\/([^/]+)\/dreams\/run$/);
    if(characterDreamRun){
      if(method!=='POST'){res.setHeader('allow','POST');throw httpError(405,'METHOD_NOT_ALLOWED','梦境运行仅支持 POST');}
      if(closing)throw httpError(503,'SERVICE_CLOSING','沙之书正在关闭');
      const body=await readJson(req,2048);
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='taskId'))throw httpError(400,'INVALID_ARGUMENT','梦境请求只接受可选 taskId');
      let characterId;try{characterId=decodeURIComponent(characterDreamRun[1]);}catch{throw httpError(400,'INVALID_ARGUMENT','角色标识编码无效');}
      const result=await book.runCharacterDream({characterId,...body});
      return writeJson(res,200,result);
    }
    if(await characterResourceRoutes(req,res,url,pathname))return;
    if(await personProfileRoutes(req,res,url,pathname))return;
    if(await localRoleRoutes(req,res,url,pathname))return;
    if(await selfieLibraryRoutes(req,res,url,pathname))return;
    const legacyMedia=pathname.match(/^\/conversations\/([^/]+)\/media$/);
    if(legacyMedia&&method==='POST'){
      const body=await readJson(req),input={conversationId:decodeURIComponent(legacyMedia[1]),messageIds:body.messageIds};
      const conversation=book.snapshot().conversations.find(item=>item.id===input.conversationId),target=conversation?.channelTarget;
      if(conversation?.channel!=='desktop'&&target?.platform==='qq'&&['group','private'].includes(target.kind)&&['accountId','targetId','externalTargetId'].every(key=>typeof target[key]==='string'&&target[key]))await book.materializeChannelMentions(input,channelRouter.recoverMentions);
      return writeJson(res,200,await book.materializeChannelMedia(input,channelRouter.convertLegacyMessage));
    }
    if(method==='GET'&&pathname==='/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});res.write('data: {"type":"connected"}\n\n');sseClients.add(res);const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);heartbeat.unref();req.on('close',()=>{clearInterval(heartbeat);sseClients.delete(res);});return;}
    if(method==='GET'&&pathname==='/permissions/runtime')return writeJson(res,200,await book.getRuntimePermission(url.searchParams.get('characterId')));
    if(method==='GET'&&pathname==='/permissions')return writeJson(res,200,book.getPermissions());
    if(method==='GET'&&pathname==='/screen-permissions')return writeJson(res,200,screenSnapshot());
    const pluginUiRoute=pathname.match(/^\/plugins\/([^/]+)\/ui(?:\/(rpc))?$/);
    if(pluginUiRoute&&method==='GET'&&!pluginUiRoute[2]){const document=await pluginUI.document(decodeURIComponent(pluginUiRoute[1]));res.removeHeader('x-frame-options');res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':document.csp,'cache-control':'no-store'});res.end(document.html);return;}
    const messageAvatar=pathname.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)\/avatar$/);
    if(messageAvatar&&method==='GET'){
      const id=channelMessageAvatarId(book.snapshot(),decodeURIComponent(messageAvatar[1]),decodeURIComponent(messageAvatar[2]));
      if(!id)throw httpError(404,'AVATAR_UNAVAILABLE','无可用头像');
      const avatar=await channelAvatars.get(id,'private');res.writeHead(200,{'content-type':avatar.mime,'cache-control':'private, max-age=3600'});res.end(avatar.bytes);return;
    }
    const channelAvatar=pathname.match(/^\/conversations\/([^/]+)\/channel-avatar$/);
    if(channelAvatar&&method==='GET'){const conv=book.snapshot().conversations.find(item=>item.id===decodeURIComponent(channelAvatar[1]));if(!conv||conv.channel==='desktop'||conv.channelTarget?.platform!=='qq')throw httpError(404,'AVATAR_UNAVAILABLE','无可用头像');const avatar=await channelAvatars.get(conv.channelTarget.externalTargetId,conv.channelTarget.kind);res.writeHead(200,{'content-type':avatar.mime,'cache-control':'private, max-age=3600'});res.end(avatar.bytes);return;}
    if(method==='GET'&&pathname==='/plugins')return writeJson(res,200,pluginSnapshot());
    if(method==='GET'&&pathname==='/snapshot')return writeJson(res,200,{...channelRouter.decorateSnapshot(book.snapshot()),composerAttachmentsV1:true,composerScreenCaptureV1:typeof toolServices.captureScreen==='function'});
    if(method==='GET'&&pathname==='/settings')return writeJson(res,200,book.snapshot().settings);
    if(method==='GET'&&pathname==='/search/status')return writeJson(res,200,search.status());
    if(method==='GET'&&pathname==='/model-providers')return writeJson(res,200,await modelProviders.state());
    if(method==='GET'&&pathname==='/model-providers/openai-auth')return writeJson(res,200,await modelProviders.openaiAuth());
    if(method==='GET'&&pathname==='/runtime/status')return writeJson(res,200,await runtime.health());
    if(method==='GET'&&pathname==='/runtime/native-tools')return writeJson(res,200,await runtime.getNativeTools());
    if(method==='GET'&&pathname==='/runtime/model-catalog')return writeJson(res,200,await runtime.modelCatalog(url.searchParams.get('source')));
    if(method==='GET'&&pathname==='/runtime/openai-auth')return writeJson(res,200,await runtime.openaiAuth());
    if(method==='GET'&&pathname==='/runtime/model')return writeJson(res,200,await runtime.getModelConfig());
    if(method==='GET'&&pathname==='/runtime/updates'){const result=await runtime.checkUpdate();return writeJson(res,200,{...result,updateAvailable:result.available,latestVersion:result.latest});}
    if(method==='GET'&&pathname==='/runtime/plugin'){const source=pluginDir??path.join(projectRoot,'plugins/suna-dsh'),files=new Map();for(const entry of await readdir(source,{withFileTypes:true})){if(entry.isFile())files.set(`suna-dsh-bridge/${entry.name}`,await readFile(path.join(source,entry.name)));}const bytes=createZip(files);res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="suna-dsh-bridge.zip"','content-length':bytes.length,'cache-control':'no-store'});res.end(bytes);return;}
    if(method==='GET'&&pathname==='/channels')return writeJson(res,200,channelSnapshot());
    if(method==='GET'&&pathname==='/prompts/export')return writeJson(res,200,book.exportPromptConfig());
    if(method==='GET'&&pathname==='/activities')return writeJson(res,200,book.listActivities({characterId:url.searchParams.get('characterId')??undefined}));
    if(method==='GET'&&pathname==='/prompts/checkpoints')return writeJson(res,200,book.listPromptCheckpoints({scope:url.searchParams.get('scope')??'runtime',name:url.searchParams.get('name')??'system',characterId:url.searchParams.get('characterId')??undefined}));
    const checkpoint=pathname.match(/^\/prompts\/checkpoints\/([^/]+)$/);
    if(checkpoint&&method==='GET')return writeJson(res,200,book.getPromptCheckpoint(decodeURIComponent(checkpoint[1])));
    if(checkpoint&&method==='DELETE')return writeJson(res,200,book.deletePromptCheckpoint(decodeURIComponent(checkpoint[1]),{expectedVersion:url.searchParams.has('expectedVersion')?Number(url.searchParams.get('expectedVersion')):undefined}));
    const messageTask=pathname.match(/^\/message-tasks\/([^/]+)$/);
    if(messageTask&&method==='GET')return writeJson(res,200,book.getSendTask(decodeURIComponent(messageTask[1])));
    const conversationUsage=pathname.match(/^\/developer\/conversations\/([^/]+)\/usage$/);
    if(method==='GET'&&conversationUsage){developer();return writeJson(res,200,book.getConversationUsage({conversationId:decodeURIComponent(conversationUsage[1]),range:url.searchParams.get('range')??'all'}));}
    const conversationObservability=pathname.match(/^\/developer\/conversations\/([^/]+)\/observability$/);
    if(method==='GET'&&conversationObservability){
      developer();
      return writeJson(res,200,book.getConversationObservability({conversationId:decodeURIComponent(conversationObservability[1]),beforeSequence:url.searchParams.has('beforeSequence')?Number(url.searchParams.get('beforeSequence')):undefined,limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):undefined,category:url.searchParams.get('category')??undefined,roundId:url.searchParams.get('roundId')??undefined,roundScope:url.searchParams.get('roundScope')??undefined}));
    }
    if(method==='GET'&&pathname==='/developer/logs'){developer();const entries=[...book.getLogs({limit:Number(url.searchParams.get('limit')??200),level:url.searchParams.get('level')??undefined}),...serverLogs.slice(-200).map((entry,index)=>({...entry,sequence:`server-${index}`,level:'info'}))].sort((a,b)=>b.time.localeCompare(a.time));return writeJson(res,200,entries);}
    if(method==='GET'&&pathname==='/developer/diagnostics'){developer();return writeJson(res,200,{...book.exportDiagnostics(),serverLogs:serverLogs.slice(-500),runtime:await runtime.health(),channels:channelRouter.list()});}
    if(method==='GET'&&pathname==='/developer/tests'){developer();return writeJson(res,200,book.listTestSessions());}
    const testMatch=pathname.match(/^\/developer\/tests\/([^/]+)(?:\/(run|cancel))?$/);
    if(testMatch&&method==='GET'&&!testMatch[2])return writeJson(res,200,book.getTestSession(decodeURIComponent(testMatch[1])));
    if(testMatch&&method==='DELETE'&&!testMatch[2])return writeJson(res,200,await book.deleteTestSession(decodeURIComponent(testMatch[1])));
    const pluginMatch=pathname.match(/^\/plugins\/([^/]+)\/(config|start|stop)$/);
    const accountMatch=pathname.match(/^\/channels\/accounts\/([^/]+)(?:\/(connect|disconnect|qr|poll))?$/);
    if(accountMatch&&method==='DELETE'&&!accountMatch[2]){const accountId=decodeURIComponent(accountMatch[1]);return writeJson(res,200,pluginUI.isManagedAccount(accountId)?await pluginUI.rpc('suna-napcat',{method:'channels.remove',params:{accountId}}):await channelRouter.remove(accountId));}
    if(!['POST','PATCH'].includes(method))throw httpError(404,'NOT_FOUND','接口不存在');
    const body=await readJson(req,pathname==='/runtime/native-tools'?64*1024:pathname==='/search/settings'?8192:pathname==='/assets/import'?uploadLimit:['/channels/import','/plugins/import'].includes(pathname)?12*1024*1024:4*1024*1024);let result;
    if(closing)throw httpError(503,'SERVICE_CLOSING','沙之书正在关闭');
    if(pluginUiRoute&&pluginUiRoute[2]==='rpc'&&method==='POST'){
      if(decodeURIComponent(pluginUiRoute[1])===DSH_CLIENT_PLUGIN_ID){
        parseDshPluginManagement(body);
        if(!isDshPluginManagementRead(body.method)&&!equalSecret(req.headers['x-sandbook-native'],nativeToken))throw httpError(403,'DSH_PLUGIN_NATIVE_REQUIRED','请在桌面端管理 DSH 插件');
      }
      if(['channels.administrator.save','channels.managed.create'].includes(body?.method))native(req);
      result=await pluginUI.rpc(decodeURIComponent(pluginUiRoute[1]),body);
      // Host context is a read, including for channel plugins without custom UI.
      // Emitting mutation SSE here makes management refresh read context forever.
      if(body.method==='context'||decodeURIComponent(pluginUiRoute[1])===DSH_CLIENT_PLUGIN_ID&&isDshPluginManagementRead(body.method))return writeJson(res,200,result);
    }
    else if(pathname==='/screen-permissions/check'&&method==='POST'){native(req);result=book.checkScreenCapture(body);}
    else if(pathname==='/screen-permissions'&&['PATCH','POST'].includes(method)){native(req);throw httpError(410,'SCREEN_PERMISSION_MIGRATED','请在权限管理中调整截图权限');}
    else if(pathname==='/permissions/runtime'&&method==='POST'){native(req);result=await book.setRuntimePermission(body);}
    else if(pathname==='/permissions'&&['PATCH','POST'].includes(method)){native(req);result=book.setPermission(body);}
    else if(pathname==='/permissions/adopt-screen-policy'&&method==='POST'){native(req);result=book.adoptScreenPolicy(body);}
    else if(pathname==='/runtime/native-tools'&&method==='POST'){native(req,'原生工具开关只能在桌面设置窗口修改');result=await runtime.setNativeTools(body);}
    else if(method==='POST'&&pathname==='/model-providers/save')result=await modelProviders.saveProvider(body);
    else if(method==='POST'&&pathname==='/model-providers/delete')result=await modelProviders.deleteProvider(body);
    else if(method==='POST'&&pathname==='/model-providers/assignments')result=await modelProviders.saveAssignments(body);
    else if(method==='POST'&&pathname==='/model-providers/catalog')result=await modelProviders.catalog(body);
    else if(method==='POST'&&pathname==='/model-providers/openai-auth')result=await modelProviders.openaiAuth(body);
    else if(pathname==='/settings')result=book.setSettings(body);
    else if(pathname==='/search/settings'&&method==='PATCH')result=await search.updateSettings(body);
    else if(pathname==='/characters')result=book.createCharacter(body);
    else if(/^\/characters\/[^/]+$/.test(pathname))result=book.updateCharacter(decodeURIComponent(pathname.split('/')[2]),body,{expectedVersion:body.expectedVersion});
    else if(pathname==='/conversations')result=book.createConversation(body);
    else if(/^\/conversations\/[^/]+$/.test(pathname)){
      const updated=book.updateConversation(decodeURIComponent(pathname.split('/')[2]),body);
      // This low-frequency display mutation returns the same authoritative
      // account membership/aliases as navigation GET, with one snapshot only.
      result=Object.hasOwn(body,'showInMainList')?{...channelRouter.decorateSnapshot(book.snapshot()),composerAttachmentsV1:true,composerScreenCaptureV1:typeof toolServices.captureScreen==='function'}.conversations.find(conversation=>conversation.id===updated.id):updated;
    }
    else if(/^\/conversations\/[^/]+\/(participants|messages|emojis|cancel|read)$/.test(pathname)){
      const [, ,conversationId,action]=pathname.split('/');const key=decodeURIComponent(conversationId);result=action==='emojis'?await book.sendEmoji({...body,conversationId:key}):action==='read'?book.markConversationRead(key,body.sequence):action==='participants'?book.addParticipants(key,body.ids??body.participantIds??[]):action==='cancel'?book.cancelConversation(key):await book.sendMessage({...body,conversationId:key});
    }
    else if(pathname==='/prompts/dsh-original'){developer();result=await book.readOriginalDeveloperPrompt(body);}
    else if(pathname==='/prompts/draft')result=book.savePromptDraft(body);
    else if(pathname==='/prompts/publish')result=book.publishPrompt(body);
    else if(pathname==='/prompts/preview')result=book.previewPrompt(body);
    else if(pathname==='/prompts/history')result=book.promptHistory(body);
    else if(pathname==='/prompts/rollback')result=book.rollbackPrompt(body);
    else if(pathname==='/prompts/import')result=book.importPromptConfig(body.envelope??body,{preview:!!body.preview,expectedVersion:body.expectedVersion});
    else if(pathname==='/prompts/checkpoints')result=book.createPromptCheckpoint(body);
    else if(checkpoint)result=book.updatePromptCheckpoint(decodeURIComponent(checkpoint[1]),body);
    else if(pathname==='/background/run')result=await book.runBackground(body);
    else if(pathname==='/background/resume')result=await book.resumeBackground(body.taskId);
    else if(pathname==='/background/cancel')result=await book.cancelBackground(body.taskId);
    else if(pathname==='/runtime/start')result=await runtime.start();
    else if(pathname==='/runtime/stop'){for(const conversation of book.snapshot().conversations)book.cancelConversation(conversation.id);await runtime.stop();result=await runtime.health();}
    else if(pathname==='/runtime/gui')result={url:await runtime.openGui({workspaces:book.runtimeWorkspaces()})};
    else if(pathname==='/runtime/openai-auth')result=await runtime.openaiAuth(body);
    else if(pathname==='/runtime/model')result=await runtime.setModelConfig(body);
    else if(pathname==='/runtime/update'){if(body.packageManager)native(req);result=await runtime.update(body);}
    else if(pathname==='/runtime/external'||pathname==='/runtime/connect')result=await runtime.connectExternal(body);
    else if(pathname==='/runtime/bundled')result=await runtime.useBundled();
    else if(pathname==='/runtime/install-plugin'){if(body.executable||body.cliPath||body.packagePath||body.packageManager)native(req);const bundled=runtimeDir??path.join(projectRoot,'runtime/dsh');result=await runtime.installExternalPlugin({...body,executable:body.executable??path.join(bundled,'bin',process.platform==='win32'?'node.exe':'node'),cliPath:body.cliPath??path.join(bundled,'node_modules/@deepseek-ai/dsh/lib/bin.js')});}
    else if(pathname==='/plugins/import'&&method==='POST'){const upload=await uploadedFile(req,body);try{const info=await stat(upload.filename);if(info.size>8*1024*1024)throw httpError(413,'PLUGIN_ARCHIVE_SIZE','插件包过大');const files=readZip(await readFile(upload.filename));let manifest;try{manifest=JSON.parse(files.get('manifest.json')?.toString('utf8'));}catch{throw httpError(400,'PLUGIN_MANIFEST_INVALID','插件清单无效');}if(clientPluginHost.plugins.has(manifest.id))throw httpError(409,'PLUGIN_ID_CONFLICT','插件标识已被占用');if(manifest.kind==='tool'){if([...channelHost.listPlugins(),...pluginHost.listPlugins()].some(p=>p.id===manifest.id))throw httpError(409,'PLUGIN_ID_CONFLICT','插件标识已被占用');result=await toolPluginHost.importPlugin(upload.filename);}else if(manifest.kind==='ttuf'){if([...channelHost.listPlugins(),...toolPluginHost.listPlugins()].some(p=>p.id===manifest.id))throw httpError(409,'PLUGIN_ID_CONFLICT','插件标识已被占用');result=await pluginHost.importPlugin(upload.filename);}else{if([...pluginHost.listPlugins(),...toolPluginHost.listPlugins()].some(p=>p.id===manifest.id))throw httpError(409,'PLUGIN_ID_CONFLICT','插件标识已被占用');result=await channelHost.importPlugin(upload.filename);await channelRouter.reloadPlugin(result.id);}}finally{await upload.cleanup();}}
    else if(pluginMatch){const id=decodeURIComponent(pluginMatch[1]),action=pluginMatch[2],tool=toolPluginHost.listPlugins().some(plugin=>plugin.id===id),owner=tool?toolPluginHost:pluginHost;if(action==='config'&&method==='PATCH'){if(tool&&(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1))throw httpError(400,'PLUGIN_VERSION_REQUIRED','请提供插件配置版本');result=await owner.configure(id,body.config,body.expectedVersion);}else if(action==='start'&&method==='POST')result=await owner.start(id);else if(action==='stop'&&method==='POST')result=await owner.stop(id);else throw httpError(405,'METHOD_NOT_ALLOWED','请求方式无效');}
    else if(pathname==='/channels/import'){const upload=await uploadedFile(req,body);try{const manifest=JSON.parse(readZip(await readFile(upload.filename)).get('manifest.json')?.toString('utf8')??'null');if(clientPluginHost.plugins.has(manifest?.id))throw httpError(409,'PLUGIN_ID_CONFLICT','插件标识已被占用');result=await channelHost.importPlugin(upload.filename);await channelRouter.reloadPlugin(result.id);}finally{await upload.cleanup();}}
    else if(pathname==='/channels/accounts')result=await channelRouter.create(body);
    else if(accountMatch){const key=decodeURIComponent(accountMatch[1]),action=accountMatch[2];if(pluginUI.isManagedAccount(key))result=await pluginUI.rpc('suna-napcat',{method:'channels.'+(action??'update'),params:{...body,accountId:key}});else if(!action)result=await channelRouter.update(key,body);else if(action==='connect')result=await channelRouter.connect(key);else if(action==='disconnect')result=await channelRouter.disconnect(key);else if(action==='qr'){result=await channelHost.getLoginQr(key,{refresh:true,...body});loginSessions.set(key,result.session??{});}else {try{result=await channelHost.pollLogin(key,{...loginSessions.get(key),...body});}catch(error){if(error.message!=='CHANNEL_QR_UNSUPPORTED')throw error;result=await channelHost.getLoginQr(key,{refresh:false});}if(result.status==='confirmed'){const connected=await channelRouter.connect(key);result={...result,connectionStatus:connected.status,status:connected.status==='connected'?'connected':'confirmed'};}}}
    else if(pathname==='/assets/import'){if(body.path){native(req);const info=await stat(body.path);if(!info.isFile()||info.size>160*1024*1024)throw httpError(413,'ASSET_TOO_LARGE','素材最多 160 MB');result=await assets.importAsset({...body,name:path.basename(body.path),data:(await readFile(body.path)).toString('base64')});}else result=await assets.importAsset(body);}
    else if(pathname==='/developer/tests')result=book.createTestSession(body);
    else if(testMatch){const key=decodeURIComponent(testMatch[1]);result=testMatch[2]==='run'?await book.runTest({...body,sessionId:key}):testMatch[2]==='cancel'?book.cancelTest(key):undefined;if(result===undefined)throw httpError(404,'NOT_FOUND','接口不存在');}
    else throw httpError(404,'NOT_FOUND','接口不存在');
    changed({type:'changed'});writeJson(res,200,result??{ok:true});
  }
  const server=http.createServer((req,res)=>{const task=route(req,res).catch(error=>{log('http.error',{method:req.method,path:req.url?.split('?')[0],code:error.code,error:safeError(error)});writeJson(res,error.status??(error.code==='ENOENT'?404:codeStatus(error.code)),{error:safeError(error),code:error.code??'REQUEST_FAILED'});});requests.add(task);void task.finally(()=>requests.delete(task)).catch(()=>{});});
  server.headersTimeout=15000;server.requestTimeout=120000;server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host,port},resolve);});}catch(error){unsubscribe();await Promise.allSettled([pluginHost.close(),toolPluginHost.close(),localImage.close()]);await screenPermissions.close();await Promise.allSettled([managedNapcat.close(),channelRouter.close(),book.close(),composerAttachments.close(),search.close(),workspacePreview.close(),runtime.stop()]);clearTimeout(logTimer);throw error;}baseUrl=`http://127.0.0.1:${server.address().port}`;
  try{startupNotifier=createStartupNotifier({file:path.join(dataDir,'channels/startup-notifications.sqlite'),version:productVersion,notes:await loadStartupNotes(path.join(projectRoot,'src/server/startup-release-notes.json'),productVersion),channel:createStartupNotificationChannel({router:channelRouter,host:channelHost}),log});}catch{log('channel.startup-notice.unavailable',{code:'STARTUP_NOTICE_UNAVAILABLE'});}
  for(const account of channelRouter.list().connections)if(account.autoConnect)void channelRouter.connect(account.accountId).catch(error=>log('channel.autoconnect.failed',{accountId:account.accountId,error:error.message}));
  try{await book.start();await pluginHost.resume();await toolPluginHost.resume();void startupNotifier?.start().catch(()=>log('channel.startup-notice.failed',{code:'STARTUP_NOTICE_FAILED'}));}catch(error){await close();throw error;}
  function close(){if(closeTask)return closeTask;closing=true;controlledAttachmentRoutes.close();composerAttachmentRoutes.close();unsubscribe();for(const response of sseClients)response.end();sseClients.clear();const listenerClosed=new Promise(resolve=>server.close(resolve));server.closeIdleConnections?.();for(const socket of sockets)socket.destroy();closeTask=(async()=>{await startupNotifier?.close();const imageCleanup=await Promise.allSettled([pluginHost.close(),toolPluginHost.close(),localImage.close()]);await screenPermissions.close();await Promise.allSettled([managedNapcat.close(),channelRouter.close(),book.close(),composerAttachments.close(),search.close(),workspacePreview.close(),runtime.close?runtime.close():runtime.stop(),...requests]);clearTimeout(logTimer);await persistLogs.catch(()=>{});await atomicJson(logsFile,serverLogs);await listenerClosed;if(imageCleanup[2].status==='rejected')throw imageCleanup[2].reason;})();return closeTask;}
  return {url:baseUrl,port:server.address().port,close,book,runtime,channelHost,channelRouter,pluginHost,toolPluginHost,selfieLibrary,nativeHeaders:{'x-sandbook-csrf':csrfToken,'x-sandbook-native':nativeToken}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  let app,captureClient,screenClient;try{
    if(process.env.SAND_NATIVE_CAPTURE==='1'&&process.send){const {createNativeCaptureClient}=await import('./runtime/native-capture-client.mjs');captureClient=createNativeCaptureClient();const {createNativeScreenClient}=await import('./runtime/native-screen-client.mjs');screenClient=createNativeScreenClient();}
    app=await createBookServer({toolServices:captureClient?{captureSelfie:captureClient.captureSelfie,captureScreen:screenClient.captureScreen,releaseScreenRun:screenClient.releaseRun,revokeScreen:screenClient.revoke}:{},projectRoot:process.env.SAND_PROJECT_ROOT??defaultProject,dataDir:process.env.SAND_DATA_DIR??path.join(defaultProject,'.suna'),runtimeDir:process.env.SAND_RUNTIME_DIR,pluginDir:process.env.SAND_PLUGIN_DIR,napcatRuntimeDir:process.env.SAND_NAPCAT_RUNTIME_DIR,uiDir:process.env.SAND_UI_DIR??path.join(defaultProject,'dist'),port:Number(process.env.SAND_PORT??4261),development:process.env.SAND_DEVELOPMENT==='1'||(!process.send&&process.env.NODE_ENV!=='production')});
    if(process.send)process.send({type:'ready',url:app.url,port:app.port,nativeHeaders:app.nativeHeaders});else console.log(`沙之书本地服务 ${app.url}`);
    let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;captureClient?.close();screenClient?.close();await app.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('message',message=>{if(message?.type==='shutdown')void stop();});
  }catch(error){captureClient?.close();screenClient?.close();if(process.send)process.send({type:'error',message:safeError(error)});else console.error(safeError(error));process.exitCode=1;}
}
