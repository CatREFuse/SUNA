import { createChannelMentionResolver } from './channel-mentions.mjs';
import { channelMention, mentionContextText } from '../core/channel-mentions.mjs';
import { createChannelRichContent } from './channel-rich-content.mjs';
import { supportsAdministratorProtocol } from '../channels/archive.mjs';
import { channelMessageAvatarResolver, channelMessageAvatarUrl } from './channel-avatars.mjs';
import { createChannelMedia, channelSegments, validateQQMediaURL } from './channel-media.mjs';
import {createChannelNameResolver} from './channel-names.mjs';
import {channelAccountName} from '../core/channel-display.mjs';
import {channelAccountMemberships} from './channel-account-membership.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { atomicJson,loadJson,httpError,sanitize } from './security.mjs';

// This host-owned field is deliberately separate from untrusted connector config.
const withoutAdministrators=config=>Object.fromEntries(Object.entries(config??{}).filter(([key])=>!['administratorUid','administratorUids'].includes(key)));
function administratorUid(value,platform){
  if(typeof value!=='string')throw httpError(400,'CHANNEL_ADMINISTRATOR_INVALID','管理员 UID 必须是文本');
  const uid=value.trim();if(uid&&!((platform==='qq'?/^\d{5,20}$/:/^[A-Za-z0-9_.:@+-]{1,128}$/).test(uid)))throw httpError(400,'CHANNEL_ADMINISTRATOR_INVALID',platform==='qq'?'QQ 管理员 UID 必须是 5～20 位数字':'管理员 UID 格式无效');
  return uid;
}

export async function createChannelRouter({dataDir,host,book,log,changed,media:mediaOverride,richContent:richOverride,onPermissionsChanged=()=>{},composerAttachments}){
  const media=mediaOverride??createChannelMedia({dataDir}),richContent=richOverride??createChannelRichContent();
  const filename=path.join(dataDir,'channels/accounts.json');
  const saved=await loadJson(filename,{version:1,accounts:[]});
  const accounts=new Map((saved.accounts??[]).map(record=>{let uid='';try{uid=administratorUid(record.administratorUid??'',record.platform);}catch{}const {administratorUids:_obsolete,...rest}=record;return [record.accountId,{...rest,config:withoutAdministrators(record.config),administratorUid:uid}];}));let saveQueue=Promise.resolve(),closing=false,closeTask;
  const activeTasks=new Set(),mutations=new Map(),suspended=new Set(),administratorPending=new Set(),lifetime=new AbortController();let names;const requireOpen=()=>{if(closing)throw httpError(503,'SERVICE_CLOSING','渠道正在关闭');};
  // Never persist authority leases: a process restart invalidates every old run.
  const generations=new Map(),connectionStates=new Map();
  const generation=accountId=>{if(!generations.has(accountId))generations.set(accountId,randomUUID());return generations.get(accountId);};
  const invalidateReplyLease=accountId=>generations.set(accountId,randomUUID());
  const budget=()=>AbortSignal.any([AbortSignal.timeout(20000),lifetime.signal]);
  const mentions=createChannelMentionResolver({host,getAccounts:()=>accounts.values(),cleanName:(value,record)=>typeof value==='string'?sanitize(value,secretValues(record)):''});
  function invalidateNames(accountId){names?.invalidate(accountId);mentions.invalidate(accountId);}
  function mutate(accountId,operation){const pending=(mutations.get(accountId)??Promise.resolve()).catch(()=>{}).then(operation);mutations.set(accountId,pending);void pending.finally(()=>{if(mutations.get(accountId)===pending)mutations.delete(accountId);}).catch(()=>{});return pending;}
  // Build from the committed in-memory state when this queued write starts.
  // A previous failed edit must roll back before another account can persist it.
  const persist=()=>{saveQueue=saveQueue.catch(()=>{}).then(()=>atomicJson(filename,{version:1,accounts:[...accounts.values()]}));return saveQueue;};
  const plugin=id=>{const result=host.listPlugins().find(p=>p.id===id);if(!result)throw httpError(404,'PLUGIN_NOT_INSTALLED','先导入这个渠道插件');return result;};
  const account=id=>{const result=accounts.get(id);if(!result)throw httpError(404,'CHANNEL_ACCOUNT_NOT_FOUND','渠道账号不存在');return result;};
  function secretValues(record){const definition=host.listPlugins().find(p=>p.id===record.pluginId)??{};return Object.entries(record.config??{}).filter(([key])=>definition.configSchema?.[key]?.type==='secret'||/token|secret|password|credential|api.?key/i.test(key)).map(([,value])=>value);}
  function maskedConfig(record){const definition=host.listPlugins().find(p=>p.id===record.pluginId)??{};const secrets=[];const config={};for(const [key,value] of Object.entries(record.config??{})){if(definition.configSchema?.[key]?.type==='secret'||/token|secret|password|credential|api.?key/i.test(key)){secrets.push(key);continue;}config[key]=sanitize(value,secretValues(record));}return {config,configuredSecrets:secrets};}
  function decorateSnapshot(snapshot){const avatarId=channelMessageAvatarResolver(snapshot),memberships=channelAccountMemberships(snapshot,accounts);return {...snapshot,messages:snapshot.messages.map(message=>avatarId(message.conversationId,message.id)?{...message,sender:{...message.sender,avatarUrl:channelMessageAvatarUrl(message.conversationId,message.id)}}:message),conversations:snapshot.conversations.map(original=>{if(original.channel==='desktop')return original;const conversation={...original,channelAccountIds:memberships.get(original.id)??[]};const target=conversation.channelTarget??{},record=accounts.get(target.accountId);if(!record||record.platform!==target.platform)return {...conversation,replyEnabled:typeof conversation.replyEnabled==='boolean'?conversation.replyEnabled:false,replySource:typeof conversation.replyEnabled==='boolean'?'conversation':'account'};const safe=sanitize({title:conversation.title,channelDetails:conversation.channelDetails,display:conversation.display},secretValues(record));const channel=sanitize({...safe.display?.channel,platform:target.platform,accountId:record.accountId,accountLabel:channelAccountName(record),...(record.selfId?{selfId:record.selfId}:{})},secretValues(record));return {...conversation,...safe,replyEnabled:typeof conversation.replyEnabled==='boolean'?conversation.replyEnabled:record.config?.autoReply!==false,replySource:typeof conversation.replyEnabled==='boolean'?'conversation':'account',display:{...safe.display,channel}};})};}
  function list(){return {plugins:host.listPlugins(),connections:[...accounts.values()].map(record=>{const live=host.listConnections().find(c=>c.accountId===record.accountId);return {accountId:record.accountId,pluginId:record.pluginId,characterId:record.characterId,platform:record.platform,administratorUid:record.administratorUid??'',administratorStatus:recordAdministratorStatus(record),autoConnect:!!record.autoConnect,accountLabel:sanitize(channelAccountName(record),secretValues(record)),...maskedConfig(record),status:live?.status??'error',detail:sanitize(live?.detail??record.restoreError??'',secretValues(record)),selfId:record.selfId};})};}
  function bindIdentity(record,selfId,selfName){
    if(!selfId)return;if(record.selfId&&record.selfId!==String(selfId)){invalidateNames(record.accountId);invalidateReplyLease(record.accountId);}record.selfId=String(selfId);if(typeof selfName==='string'&&selfName.trim())record.selfName=sanitize(selfName.slice(0,256),secretValues(record));const state=book.snapshot();
    for(const character of state.characters){const old=character.accounts??[];const next=old.filter(a=>a.accountId!==record.accountId);if(character.id===record.characterId)next.push({channel:'onebot',platform:record.platform,accountId:record.accountId,userId:String(selfId)});if(JSON.stringify(old)!==JSON.stringify(next))book.updateCharacter(character.id,{accounts:next});}
  }
  function validateConfig(definition,value,previous={}){const result=withoutAdministrators(previous);for(const [key,field] of Object.entries(definition.configSchema??{})){if(['administratorUid','administratorUids'].includes(key))continue;if(value[key]!==undefined){if(typeof value[key]!=='string'&&typeof value[key]!=='number'&&typeof value[key]!=='boolean')throw httpError(400,'CHANNEL_CONFIG_INVALID',`配置 ${field.label??key} 格式无效`);if(field.type==='boolean'&&typeof value[key]!=='boolean')throw httpError(400,'CHANNEL_CONFIG_INVALID',`配置 ${field.label??key} 必须为布尔值`);if(field.type==='select'&&!field.options.some(option=>option.value===value[key]))throw httpError(400,'CHANNEL_CONFIG_INVALID',`配置 ${field.label??key} 选项无效`);result[key]=value[key];}else if(result[key]===undefined&&field.default!==undefined)result[key]=field.default;if(field.required&&!String(result[key]??'').trim())throw httpError(400,'CHANNEL_CONFIG_REQUIRED',`请填写${field.label??key}`);}return result;}
  async function invalidateAccountPermissions(accountId,...characterIds){
    const affected=new Set(characterIds.filter(Boolean));
    for(const conversation of book.snapshot().conversations)if(conversation.channel!=='desktop'&&conversation.channelTarget?.accountId===accountId)for(const id of conversation.participantIds??[])affected.add(id);
    await Promise.all([...affected].map(characterId=>onPermissionsChanged({accountId,characterId})));
  }
  async function invalidateConnectionPermissions(accountId,characterId){
    const affected=new Set(characterId?[characterId]:[]);
    const snapshot=book.snapshot();
    for(const conversation of snapshot.conversations)if(conversation.channel!=='desktop')for(const id of conversation.participantIds??[]){
      const character=snapshot.characters.find(person=>person.id===id);
      if(character&&deliveryAccount({conversation,character})?.accountId===accountId)affected.add(id);
    }
    await Promise.all([...affected].map(characterId=>onPermissionsChanged({accountId,characterId})));
  }
  async function create(input){const definition=plugin(input.pluginId);const characterId=input.characterId??'default-character';if(!book.snapshot().characters.some(c=>c.id===characterId))throw httpError(404,'CHARACTER_NOT_FOUND','角色不存在');const accountId=input.accountId??randomUUID();if(accounts.has(accountId))throw httpError(409,'CHANNEL_ACCOUNT_EXISTS','渠道账号已存在');const config=validateConfig(definition,input.config??{});const record={accountId,pluginId:definition.id,platform:definition.platform??definition.id,characterId,config,administratorUid:'',autoConnect:!!input.autoConnect,createdAt:new Date().toISOString()};await host.createConnection({accountId,pluginId:definition.id,config});accounts.set(accountId,record);await persist();await invalidateAccountPermissions(accountId,characterId);changed();return list().connections.find(c=>c.accountId===accountId);}
  async function update(accountId,input){
    invalidateNames(accountId);const current=account(accountId),definition=plugin(current.pluginId),originalConfig=current.config;
    const next={...current,config:validateConfig(definition,input.config??{},current.config),characterId:input.characterId??current.characterId,autoConnect:input.autoConnect??current.autoConnect};
    if(!book.snapshot().characters.some(c=>c.id===next.characterId))throw httpError(404,'CHARACTER_NOT_FOUND','角色不存在');
    invalidateReplyLease(accountId);
    suspended.add(accountId);
    try{
      await invalidateAccountPermissions(accountId,current.characterId,next.characterId);await host.removeConnection(accountId);
      try{await host.createConnection(next);}catch(error){await host.createConnection(current);throw error;}
      // Administrator edits are immediate even while an adapter is reconnecting.
      // Never restore the UID captured before an awaited lifecycle operation.
      const latest=account(accountId);next.administratorUid=next.characterId===latest.characterId?latest.administratorUid:'';
      // Adapter config callbacks can disable an account while reconnection awaits.
      for(const key of ['enabled','disabled'])if(latest.config[key]!==originalConfig[key])if(Object.hasOwn(latest.config,key))next.config[key]=latest.config[key];
      accounts.set(accountId,next);bindIdentity(next,next.selfId);await persist();suspended.delete(accountId);changed();return list().connections.find(c=>c.accountId===accountId);
    }finally{suspended.delete(accountId);}
  }
  async function remove(accountId){
    invalidateNames(accountId);const record=account(accountId);suspended.add(accountId);
    invalidateReplyLease(accountId);
    try{await invalidateAccountPermissions(accountId,record.characterId);await host.removeConnection(accountId);accounts.delete(accountId);for(const character of book.snapshot().characters){const old=character.accounts??[],next=old.filter(a=>a.accountId!==accountId);if(next.length!==old.length)book.updateCharacter(character.id,{accounts:next});}await persist();changed();return {removed:true};}finally{suspended.delete(accountId);}
  }
  async function connect(accountId){const record=account(accountId);invalidateReplyLease(accountId);const result=await host.connect(accountId);record.autoConnect=true;try{const identity=await host.execute(accountId,'get_login_info');if(identity?.status==='ok'&&Number(identity.retcode??0)===0)bindIdentity(record,identity.data?.user_id,identity.data?.nickname);}catch(error){log('channel.identity.unavailable',{accountId,error:error.message});}await persist();if(!closing)await names?.refresh(accountId);changed();return result;}
  async function disconnect(accountId){invalidateNames(accountId);const record=account(accountId);invalidateReplyLease(accountId);record.autoConnect=false;await invalidateConnectionPermissions(accountId,record.characterId);await host.disconnect(accountId);await persist();changed();return {disconnected:true};}
  async function reloadPlugin(pluginId){
    const affected=[...accounts.values()].filter(record=>record.pluginId===pluginId);
    await Promise.all(affected.map(record=>mutate(record.accountId,async()=>{
      const current=accounts.get(record.accountId);if(!current||current.pluginId!==pluginId)return;suspended.add(current.accountId);
      invalidateReplyLease(current.accountId);
      try{await invalidateAccountPermissions(current.accountId,current.characterId);names?.invalidate(current.accountId);if(host.listConnections().some(c=>c.accountId===current.accountId))await host.removeConnection(current.accountId);try{await host.createConnection(current);delete current.restoreError;}catch(error){current.restoreError=sanitize(error.message);throw error;}}finally{suspended.delete(current.accountId);}
    })));changed();
  }
  async function saveConfig(accountId,patch){const record=accounts.get(accountId);if(!record)return;const previous=record.config;record.config=withoutAdministrators({...previous,...patch});invalidateNames(accountId);if(Object.keys(patch).some(key=>previous[key]!==record.config[key]))invalidateReplyLease(accountId);if(previous.enabled!==record.config.enabled||previous.disabled!==record.config.disabled)await invalidateAccountPermissions(accountId,record.characterId);await persist();changed();}
  function recordAdministratorStatus(record){
    const base={accountId:record.accountId,characterId:record.characterId,supported:supportsAdministratorProtocol(host.listPlugins().find(item=>item.id===record.pluginId)),ready:false};
    if(suspended.has(record.accountId)||administratorPending.has(record.accountId))return {...base,reason:'account-changing'};
    if(!base.supported)return {...base,reason:'protocol-unsupported'};
    // Called for every projected human message. Do not materialize the entire
    // book merely to check this one role; use the uncached Core existence port.
    let characterExists=false;
    try{characterExists=typeof book.hasCharacter==='function'?book.hasCharacter(record.characterId)===true:book.snapshot().characters.some(item=>item.id===record.characterId);}catch{}
    if(!characterExists)return {...base,reason:'character-unavailable'};
    if(record.enabled===false||record.disabled===true||record.config?.enabled===false||record.config?.disabled===true)return {...base,reason:'account-disabled'};
    if(!record.administratorUid)return {...base,reason:'administrator-missing'};
    return {...base,ready:true,reason:'ready',administratorUid:record.administratorUid};
  }
  function permissionStatus({conversation,character,accountId,characterId=character?.id}={}){
    const unavailable=reason=>({supported:false,ready:false,reason,...(accountId?{accountId}:{}),...(characterId?{characterId}:{})});
    if(!characterId)return unavailable('character-unavailable');
    if(conversation){
      if(conversation.channel!=='onebot'||!conversation.participantIds?.includes(characterId))return unavailable('channel-unavailable');
      const target=conversation.channelTarget,origin=target&&accounts.get(target.accountId);
      if(!target||!['group','private'].includes(target.kind)||!origin||origin.platform!==target.platform||suspended.has(origin.accountId)||origin.enabled===false||origin.disabled===true||origin.config?.enabled===false||origin.config?.disabled===true)return unavailable('account-unavailable');
      const candidates=[...accounts.values()].filter(record=>record.characterId===characterId&&record.platform===target.platform);
      const exact=candidates.find(record=>record.accountId===target.accountId);
      if(accountId&&accountId!==exact?.accountId&&!(target.kind==='group'&&candidates.length===1&&candidates[0].accountId===accountId))return unavailable('account-binding-mismatch');
      if(exact)return recordAdministratorStatus(exact);
      if(target.kind!=='group'||!candidates.length)return unavailable('account-unavailable');
      if(candidates.length!==1)return unavailable('account-ambiguous');
      return recordAdministratorStatus(candidates[0]);
    }
    const record=accounts.get(accountId);if(!record)return unavailable('account-unavailable');
    if(record.characterId!==characterId)return unavailable('account-binding-mismatch');
    return recordAdministratorStatus(record);
  }
  async function setAdministrator(accountId,{characterId,administratorUid:uid}={}){
    return mutate(accountId,async()=>{
      const record=account(accountId);
      if(typeof characterId!=='string'||record.characterId!==characterId)throw httpError(409,'CHANNEL_ACCOUNT_CHANGED','账号绑定角色已改变，请重新加载');
      if(!supportsAdministratorProtocol(plugin(record.pluginId)))throw httpError(400,'CHANNEL_ADMINISTRATOR_UNSUPPORTED','插件未声明管理员协议');
      const next={...record,administratorUid:administratorUid(uid,record.platform)};
      if(next.administratorUid===record.administratorUid&&!administratorPending.has(accountId))return list().connections.find(item=>item.accountId===accountId);
      // Pending authority must not become a trusted identity before persistence
      // and invalidation of existing execution ports have both completed.
      const wasPending=administratorPending.has(accountId);administratorPending.add(accountId);
      suspended.add(accountId);invalidateReplyLease(accountId);
      try{
        accounts.set(accountId,next);
        try{await persist();}catch(error){if(accounts.get(accountId)===next)accounts.set(accountId,record);if(!wasPending)administratorPending.delete(accountId);throw error;}
        await onPermissionsChanged({accountId,characterId});
        administratorPending.delete(accountId);
      }finally{suspended.delete(accountId);}
      changed({type:'channel.permissions.changed'});return list().connections.find(item=>item.accountId===accountId);
    });
  }
  function primaryUserAliases({characterId}={}){
    if(closing)return [];
    return [...accounts.values()]
      .filter(record=>record.characterId===characterId&&recordAdministratorStatus(record).ready)
      .map(record=>({accountId:record.accountId,platform:record.platform,id:record.administratorUid}));
  }
  function isAdministrator({conversation,character,sender}={}){
    if(sender?.type!=='human'||sender.automatic===true||(sender.source!==undefined&&!['channel','onebot'].includes(sender.source))||typeof sender.id!=='string')return false;
    const status=permissionStatus({conversation,character});return status.ready&&status.administratorUid===sender.id;
  }
  const mediaIdentifier=value=>typeof value==='string'&&/^[A-Za-z0-9_=-][A-Za-z0-9_.=-]{0,511}$/.test(value)&&value!=='.'&&value!=='..'?value:null;
  function accountActionReader(record){
    const selfId=record.selfId;
    const eligible=()=>!closing&&accounts.get(record.accountId)===record&&record.selfId===selfId&&record.pluginId==='suna-napcat'&&record.platform==='qq'&&host.listConnections().some(item=>item.accountId===record.accountId&&['connected','waiting-webhook'].includes(item.status));
    return async function query(action,params,signal){
      if(!eligible()||signal?.aborted)return null;
      let abort;
      const stopped=new Promise(resolve=>{abort=()=>resolve(null);signal?.addEventListener('abort',abort,{once:true});});
      try{const result=await Promise.race([host.execute(record.accountId,action,params),stopped]);if(!eligible()||signal?.aborted||result?.status!=='ok'||Number(result.retcode??0)!==0)return null;return result.data;}catch{return null;}finally{signal?.removeEventListener('abort',abort);}
    };
  }
  function mediaResolver(record,{conversation,message}={}){
    let latest;const query=accountActionReader(record);
    const source=data=>{for(const value of [data?.url,data?.file]){if(typeof value!=='string'||!value.startsWith('https://'))continue;try{return validateQQMediaURL(value).href;}catch{}}return null;};
    return async(segment,{signal}={})=>{
      if(signal?.aborted||!['image','video'].includes(segment?.type))return null;
      const ids=[segment.data?.file_id,segment.data?.file].map(mediaIdentifier).filter(Boolean);if(!ids.length)return null;
      if(message?.externalId&&conversation){
        latest??=query('get_msg',{message_id:message.externalId},signal).then(data=>verifiedMessageSegments(data,message,conversation,record)??[]);
        const matches=(await latest).filter(item=>item?.type===segment.type&&[item.data?.file_id,item.data?.file].some(value=>ids.includes(value)));
        if(matches.length===1){const url=source(matches[0].data);if(url)return url;}
      }
      const data=await query(segment.type==='image'?'get_image':'get_file',segment.type==='image'?{file:ids[0]}:{file_id:ids[0]},signal);return source(data);
    };
  }
  function verifiedMessageSegments(data,message,conversation,record){
    const target=conversation.channelTarget;if(!data||String(data.message_id??'')!==String(message.externalId))return null;
    if(data.message_type&&data.message_type!==target.kind)return null;
    if(target.kind==='group'&&String(data.group_id??'')!==String(target.externalTargetId))return null;
    if(target.kind==='private'&&data.group_id!==undefined&&String(data.group_id)!=='0')return null;
    const expected=message.sender?.type==='human'?message.sender.id:record.selfId;
    const senders=[data.user_id,data.sender?.user_id].filter(value=>value!==undefined&&value!==null);
    if(!expected||!senders.length||senders.some(value=>String(value)!==String(expected)))return null;
    if(target.kind==='private'&&message.sender?.type==='human'&&String(expected)!==String(target.externalTargetId))return null;
    return channelSegments(data);
  }
  async function expandChannelEvent(event,record,signal){
    const query=record&&accountActionReader(record);
    return richContent.expand(event,{signal,...(query?{resolveForward:(id,{signal:budget})=>query('get_forward_msg',{message_id:id},budget)}:{})});
  }
  async function convertLegacyMessage(message){
    const conversation=book.snapshot().conversations.find(item=>item.id===message.conversationId),target=conversation?.channelTarget,record=target&&accounts.get(target.accountId),signal=budget();
    const usable=record&&record.platform===target.platform?record:null;
    if(message.blocks?.some(block=>['image','video'].includes(block.type))&&!message.blocks.some(block=>block.type==='unavailable'))return {text:message.text,blocks:message.blocks};
    let event={raw_message:message.text};
    if(!/\[CQ:/.test(message.text??'')&&message.blocks?.some(block=>block.type==='unavailable')&&message.externalId&&usable){
      const data=await accountActionReader(usable)('get_msg',{message_id:message.externalId},signal);
      const segments=verifiedMessageSegments(data,message,conversation,usable);if(!segments?.length)return {text:message.text,blocks:message.blocks};event={message:segments};
    }
    const expanded=await expandChannelEvent(event,usable,signal);
    return media.convert(expanded,{signal,...(usable?{resolveMedia:mediaResolver(usable,{conversation,message})}:{})});
  }
  async function recoverMentions(message,{signal:parentSignal}={}){
    const conversation=book.snapshot().conversations.find(item=>item.id===message?.conversationId),target=conversation?.channelTarget,record=target&&accounts.get(target.accountId);
    if(!record||record.platform!=='qq'||record.pluginId!=='suna-napcat'||!message.externalId||message.taskId||message.source?.type==='manual'||conversation.channel!=='onebot')return null;
    const stamp={selfId:record.selfId,config:record.config,target:JSON.stringify(target)},signal=AbortSignal.any([budget(),...(parentSignal?[parentSignal]:[])]);
    const valid=()=>!signal.aborted&&!closing&&!suspended.has(record.accountId)&&accounts.get(record.accountId)===record&&record.selfId===stamp.selfId&&record.config===stamp.config&&JSON.stringify(book.snapshot().conversations.find(item=>item.id===message.conversationId)?.channelTarget)===stamp.target;
    const data=await accountActionReader(record)('get_msg',{message_id:message.externalId},signal);
    if(!valid())return null;
    const segments=verifiedMessageSegments(data,message,conversation,record);
    if(!segments?.length||segments.length>128||!segments.some(segment=>segment.type==='at')||segments.some(segment=>!['text','at','reply','image','video'].includes(segment.type)))return null;
    const original=segments.map(segment=>segment.type==='text'?String(segment.data?.text??''):segment.type==='at'?mentionContextText(channelMention(segment.data?.qq??segment.data?.id)):segment.type==='image'?'[图片]':segment.type==='video'?'[视频]':'').join('');
    if(original.trim()!==String(message.text??'').trim())return null;
    const previous=(message.blocks??[]).filter(block=>['image','video','unavailable'].includes(block.type)),sourceMedia=segments.filter(segment=>['image','video'].includes(segment.type));
    if(previous.length!==sourceMedia.length||previous.some((block,index)=>(block.type==='unavailable'?(block.mediaType??(block.text==='视频无法加载'?'video':'image')):block.type)!==sourceMedia[index].type))return null;
    const blocks=[],resolveMention=mentions.forEvent(record,{message_type:target.kind,group_id:target.externalTargetId});let batch=[],ordinal=0;
    async function flush(){if(!batch.length)return;const converted=await media.convert({message:batch},{resolveMention,signal});blocks.push(...converted.blocks);batch=[];}
    for(const segment of segments){if(['image','video'].includes(segment.type)){await flush();blocks.push(previous[ordinal++]);}else batch.push(segment);}
    await flush();if(!valid()||!blocks.some(block=>block.type==='mention'))return null;
    return {verified:true,source:{conversationId:conversation.id,channel:conversation.channel,platform:target.platform,accountId:record.accountId,kind:target.kind,targetId:target.targetId,externalTargetId:target.externalTargetId,messageId:String(data.message_id),senderId:message.sender.id},text:blocks.map(block=>block.type==='mention'?mentionContextText(block):['text','unavailable'].includes(block.type)?block.text:block.type==='image'?'[图片]':'[视频]').join(''),blocks};
  }
  const incomingQueues=new Map();
  function incoming(input){
    const event=input.event??{},record=accounts.get(input.accountId),kind=event.message_type==='group'?'group':'private';
    const key=JSON.stringify([record?.platform,kind,kind==='group'?event.group_id:input.accountId,kind==='group'?'':event.user_id]);
    const pending=(incomingQueues.get(key)??Promise.resolve()).catch(()=>{}).then(()=>processIncoming(input));
    incomingQueues.set(key,pending);void pending.finally(()=>{if(incomingQueues.get(key)===pending)incomingQueues.delete(key);}).catch(()=>{});
    // Queue only media preparation and the call that admits the message. Model work
    // (and a self-echo waiting for its outbound receipt) remains tracked by callers.
    return pending.then(result=>result?.completion);
  }
  async function processIncoming({accountId,pluginId,event}){
    if(closing||event.post_type!=='message')return;const record=accounts.get(accountId);if(!record||record.pluginId!==pluginId)return;bindIdentity(record,event.self_id);await persist();if(closing||accounts.get(accountId)!==record||suspended.has(accountId))return;const kind=event.message_type==='group'?'group':'private',externalTargetId=String(kind==='group'?event.group_id:event.user_id);const canonicalTarget=`${record.platform}:${kind}:${kind==='private'?accountId+':':''}${externalTargetId}`;
    let conversation=book.snapshot().conversations.find(c=>c.channel==='onebot'&&c.channelTarget?.targetId===canonicalTarget&&(kind==='group'||(c.kind==='direct'&&c.participantIds.length===1&&c.participantIds[0]===record.characterId)));
    if(!conversation)conversation=book.createConversation({replyEnabled:false,scheduler:{enabled:false},channelTitleSource:'automatic',title:kind==='group'?`${event.group_name??'群聊'} ${externalTargetId}`:event.sender?.card||event.sender?.nickname||externalTargetId,kind:kind==='group'?'group':'direct',participantIds:[record.characterId],channel:'onebot',channelTarget:{accountId,platform:record.platform,kind,targetId:canonicalTarget,externalTargetId}});
    else if(!conversation.participantIds.includes(record.characterId))conversation=book.addParticipants(conversation.id,[record.characterId]);
    const displayName=kind==='group'?event.group_name:event.sender?.card||event.sender?.nickname;
    if(typeof displayName==='string'&&displayName.trim())book.setChannelDetails(conversation.id,{[kind==='group'?'groupName':'peerName']:sanitize(displayName.slice(0,256),secretValues(record))});
    names?.apply(book.snapshot().conversations.find(item=>item.id===conversation.id)??conversation);
    if(!closing&&names)void track(names.refresh(accountId));
    const admittedSelfId=record.selfId,admittedGeneration=generation(accountId),admittedStatus=host.listConnections().find(item=>item.accountId===accountId)?.status,segments=channelSegments(event),topLevelTextSegments=segments.filter(segment=>segment?.type==='text'&&typeof segment.data?.text==='string').map(segment=>segment.data.text),mediaSignal=budget();const expanded=await expandChannelEvent(event,record,mediaSignal);const {text,blocks}=await media.convert(expanded,{resolveMedia:mediaResolver(record),resolveMention:mentions.forEvent(record,event),signal:mediaSignal});if(closing||accounts.get(accountId)!==record||record.selfId!==admittedSelfId||generation(accountId)!==admittedGeneration||suspended.has(accountId)||host.listConnections().find(item=>item.accountId===accountId)?.status!==admittedStatus||!String(text).trim())return;
    const ats=segments.filter(s=>s?.type==='at').map(s=>String(s.data?.qq??s.data?.id??'')),mentionPeople=book.snapshot().characters;
    const roleSender=mentionPeople.some(c=>c.accounts?.some(a=>a.platform===record.platform&&String(a.userId)===String(event.user_id)));
    const allMembers=kind==='group'&&ats.includes('all')&&!roleSender&&String(event.user_id)!==String(event.self_id);
    const mentioned=mentionPeople.filter(c=>allMembers&&conversation.participantIds.includes(c.id)||c.accounts?.some(a=>a.platform===record.platform&&ats.includes(String(a.userId)))).map(c=>c.id);const reply=segments.find(s=>s?.type==='reply')?.data?.id;
    const connected=host.listConnections().some(connection=>connection.accountId===record.accountId&&['connected','waiting-webhook'].includes(connection.status));
    const accountAllowed=record.enabled!==false&&record.disabled!==true&&record.config?.enabled!==false&&record.config?.disabled!==true;
    const replyAllowed=typeof conversation.replyEnabled==='boolean'?conversation.replyEnabled:record.config.autoReply!==false;
    const ingressAllowed=connected&&accountAllowed&&replyAllowed,roleEligibility={},replyLeases={};
    const people=book.snapshot().characters;
    for(const characterId of conversation.participantIds){
      // An unavailable ingress can tombstone its own role, not another account's
      // future delivery. A healthy ingress retains the existing shared-group fanout.
      if(!ingressAllowed&&characterId!==record.characterId)continue;
      const person=people.find(item=>item.id===characterId),lease=person&&replyLease({conversation,character:person});
      const outlet=lease&&accounts.get(lease.accountId),enabled=typeof conversation.replyEnabled==='boolean'?conversation.replyEnabled:outlet?.config.autoReply!==false;
      roleEligibility[characterId]=!!(ingressAllowed&&lease&&enabled);
      if(roleEligibility[characterId])replyLeases[characterId]=lease;
    }
    const completion=Promise.resolve(book.ingestChannelEvent({dispatch:ingressAllowed,admissionAccountId:accountId,admissionCharacterId:record.characterId,roleEligibility,replyLeases,conversationId:conversation.id,messageId:String(event.message_id),text:String(text),blocks,topLevelTextSegments,sender:{id:String(event.user_id),name:event.sender?.card||event.sender?.nickname||String(event.user_id)},mentionIds:mentioned,replyToMessageId:reply?String(reply):null,selfEcho:String(event.user_id)===String(event.self_id)}));
    void completion.catch(()=>{});return {completion};
  }
  function deliveryAccount({conversation,character,strictAccount=false}){const target=conversation.channelTarget;if(!target||!conversation.participantIds?.includes(character.id))return null;const candidates=[...accounts.values()].filter(record=>record.characterId===character.id&&record.platform===target.platform);return candidates.find(record=>record.accountId===target.accountId)??(!strictAccount&&target.kind==='group'&&candidates.length===1?candidates[0]:null);}
  function accountCanReply(record){return !closing&&!!record&&!suspended.has(record.accountId)&&record.enabled!==false&&record.disabled!==true&&record.config?.enabled!==false&&record.config?.disabled!==true&&host.listConnections().some(connection=>connection.accountId===record.accountId&&['connected','waiting-webhook'].includes(connection.status));}
  function replyLease(request){
    const record=deliveryAccount(request);if(!accountCanReply(record))return null;
    const {conversation,character}=request,target=conversation.channelTarget;
    return {accountId:record.accountId,generation:generation(record.accountId),characterId:character.id,conversationId:conversation.id,platform:target.platform,targetId:target.targetId,externalTargetId:target.externalTargetId,kind:target.kind,selfId:record.selfId??null};
  }
  function canReply(request){
    const record=deliveryAccount(request);if(!accountCanReply(record))return false;
    if(request.replyLease!==undefined){const actual=replyLease(request),expected=request.replyLease;return !!actual&&!!expected&&Object.keys(actual).every(key=>actual[key]===expected[key]);}
    return true;
  }
  function localNapcat(record){if(record?.pluginId!=='suna-napcat'||record.config?.transport!=='webui-action')return false;try{const url=new URL(record.config.webuiUrl);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);}catch{return false;}}
  function filePluginReady(record){const version=host.listConnections().find(c=>c.accountId===record?.accountId)?.pluginVersion;if(typeof version!=='string'||!/^\d+\.\d+\.\d+$/.test(version))return false;const [major,minor,patch]=version.split('.').map(Number);return major>0||minor>3||minor===3&&patch>=9;}
  function composerCapabilities({conversation,character,strictAccount=false}){
    const record=deliveryAccount({conversation,character,strictAccount}),ready=accountCanReply(record),images=ready&&record.pluginId==='suna-napcat',files=ready&&localNapcat(record)&&filePluginReady(record)&&!!composerAttachments;
    return {images,files,fileMode:files?'mixed':'none',reply:ready&&record.pluginId==='suna-napcat',...(!ready?{reason:'CHANNEL_ROUTE_UNAVAILABLE'}:!files?{reason:localNapcat(record)&&!filePluginReady(record)?'CHANNEL_PLUGIN_UPDATE_REQUIRED':'CHANNEL_FILE_UNSUPPORTED'}:{})};
  }
  async function preflight({conversation,character,blocks=[],message,replyToMessageId=message?.replyToMessageId,strictAccount=false,replyLease:lease,signal}){
    blocks=message?.blocks??blocks;signal?.throwIfAborted();
    const record=deliveryAccount({conversation,character,strictAccount});
    if(!record)throw Object.assign(new Error('这个角色已不再绑定原会话的平台账号'),{code:'CHANNEL_ROUTE_UNAVAILABLE'});
    if(record.enabled===false||record.disabled===true||record.config?.enabled===false||record.config?.disabled===true)throw Object.assign(new Error('渠道账号已停用'),{code:'CHANNEL_ACCOUNT_DISABLED'});
    if(!accountCanReply(record))throw Object.assign(new Error('渠道账号尚未连接'),{code:'CHANNEL_ACCOUNT_DISCONNECTED'});
    if(lease!==undefined&&!canReply({conversation,character,strictAccount,replyLease:lease}))throw Object.assign(new Error('本轮渠道账号绑定已失效'),{code:'CHANNEL_LEASE_EXPIRED'});
    const capability=composerCapabilities({conversation,character,strictAccount});
    for(const block of blocks){if(block.type==='text')continue;if(block.type==='image'){if(!capability.images||!block.relativePath)throw Object.assign(new Error('该渠道不支持本条图片'),{code:'CHANNEL_MEDIA_UNSUPPORTED'});await book.resolveMedia(block.relativePath);}else if(block.type==='file'){if(block.delivery==='controlled-url'||/^url_[a-f0-9]{48}$/.test(block.attachmentId??''))throw Object.assign(new Error('本机受控附件链接仅支持本地会话；请保留附件并切换到本地会话'),{code:'CHANNEL_CONTROLLED_ATTACHMENT_UNSUPPORTED'});if(!capability.files||!block.attachmentId)throw Object.assign(new Error('该渠道当前不支持发送文件'),{code:'CHANNEL_FILE_UNSUPPORTED'});await composerAttachments.resolveFileForChannel({conversationId:conversation.id,attachmentId:block.attachmentId,signal});}else throw Object.assign(new Error('该渠道不支持本条媒体'),{code:'CHANNEL_MEDIA_UNSUPPORTED'});}
    let original=null;if(replyToMessageId){if(!capability.reply)throw Object.assign(new Error('该渠道不支持引用回复'),{code:'CHANNEL_REPLY_UNSUPPORTED'});original=await book.resolveReplyMessage({conversationId:conversation.id,messageId:replyToMessageId});if(!original?.externalId)throw Object.assign(new Error('被引用消息缺少渠道消息标识'),{code:'CHANNEL_REPLY_UNSUPPORTED'});}
    signal?.throwIfAborted();return {original};
  }
  async function send({conversation,character,message,signal,strictAccount=false,replyLease:lease,automatic=false}){
    const target=conversation.channelTarget,record=deliveryAccount({conversation,character,strictAccount}),sendGeneration=record&&generation(record.accountId);
    if(!target||!record)throw Object.assign(new Error('渠道投递目标不存在'),{code:'CHANNEL_ROUTE_UNAVAILABLE'});
    const {original}=await preflight({conversation,character,message,strictAccount,replyLease:lease,signal});
    const blocks=message.blocks??[{type:'text',text:message.text}],segments=[];
    if(original)segments.push({type:'reply',data:{id:original.externalId}});
    for(const block of blocks){signal?.throwIfAborted();
      if(block.type==='text')segments.push({type:'text',data:{text:block.text}});
      else if(block.type==='image'){const attachment=await book.resolveMedia(block.relativePath),file=localNapcat(record)?pathToFileURL(attachment).href:`base64://${(await readFile(attachment)).toString('base64')}`;segments.push({type:'image',data:{file}});}
      else if(block.type==='file'){const attachment=await composerAttachments.resolveFileForChannel({conversationId:conversation.id,attachmentId:block.attachmentId,signal});segments.push({type:'file',data:{file:pathToFileURL(attachment.path).href,name:attachment.attachment.name}});}
    }
    signal?.throwIfAborted();
    if(deliveryAccount({conversation,character,strictAccount})!==record||generation(record.accountId)!==sendGeneration||!canReply({conversation,character,strictAccount,...(lease!==undefined?{replyLease:lease}:{})}))throw Object.assign(new Error('渠道账号或投递绑定已改变'),{code:'CHANNEL_ROUTE_UNAVAILABLE'});
    let response;try{response=await host.execute(record.accountId,'send_msg',{message_type:target.kind,[target.kind==='group'?'group_id':'user_id']:target.externalTargetId,message:segments,...(original?{reply_to:original.externalId}:{})});}catch(error){throw Object.assign(new Error('渠道发送结果未知，请勿直接重发'),{code:'CHANNEL_DELIVERY_UNCERTAIN',deliveryUncertain:true,cause:error});}
    if(response?.status!=='ok'||response.retcode!==0)throw Object.assign(new Error(`渠道发送失败：${response?.message??response?.retcode??'无成功回执'}`),{code:'CHANNEL_SEND_FAILED'});
    if(!response.data?.message_id)throw Object.assign(new Error('渠道未返回消息标识，发送结果未知，请勿直接重发'),{code:'CHANNEL_DELIVERY_UNCERTAIN',deliveryUncertain:true});
    return {ok:true,status:response.data?.accepted?'accepted':'completed',messageId:response.data.message_id,accountId:record.accountId};
  }
  for(const record of accounts.values()){try{await host.createConnection(record);bindIdentity(record,record.selfId);}catch(error){record.restoreError=sanitize(error.message);log('channel.restore.failed',{accountId:record.accountId,error:error.message});}}
  const track=task=>{activeTasks.add(task);void task.finally(()=>activeTasks.delete(task)).catch(()=>{});return task;};
  names=createChannelNameResolver({host,getAccounts:()=>accounts.values(),listConversations:()=>book.snapshot().conversations,setDetails:(id,details)=>book.setChannelDetails(id,details),cleanName:(value,record)=>typeof value==='string'?sanitize(value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,256),secretValues(record)):'',onChanged:changed});
  const statusListener=event=>{if(event?.accountId){const prior=connectionStates.get(event.accountId);if(prior!==undefined&&prior!==event.status){invalidateReplyLease(event.accountId);void invalidateConnectionPermissions(event.accountId,accounts.get(event.accountId)?.characterId).catch(()=>log('channel.permissions.unavailable',{accountId:event.accountId}));}connectionStates.set(event.accountId,event.status);}changed();if(closing||event?.status!=='connected'||!accounts.get(event.accountId)?.selfId)return;void track(names.refresh(event.accountId)).catch(()=>log('channel.names.unavailable',{accountId:event.accountId}));};
  const eventListener=event=>{if(closing)return;void track(incoming(event)).catch(error=>log('channel.incoming.failed',{error:sanitize(error.message,secretValues(accounts.get(event.accountId)??{})),accountId:event.accountId}));};host.on('event',eventListener);host.on('status',statusListener);
  const methods={setAdministrator,primaryUserAliases,permissionStatus,administratorStatus:permissionStatus,isAdministrator,resolveVideo:media.resolveVideo,convertLegacyMessage,recoverMentions,list,decorateSnapshot,composerCapabilities,preflight,canReply,replyLease,create,update,remove,connect,disconnect,reloadPlugin,saveConfig,incoming,send,account,refreshNames:(accountId,options)=>names.refresh(accountId,options)};
  return {...Object.fromEntries(Object.entries(methods).map(([name,method])=>[name,(...args)=>{requireOpen();const result=['update','remove'].includes(name)?mutate(args[0],()=>method(...args)):method(...args);return result instanceof Promise?track(result):result;}])),close(){if(closeTask)return closeTask;closing=true;lifetime.abort();names.close();mentions.close();host.off('event',eventListener);host.off('status',statusListener);closeTask=(async()=>{await host.close();await Promise.allSettled([...activeTasks]);await saveQueue;})();return closeTask;}};
}
