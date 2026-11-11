import {createHash,randomUUID} from 'node:crypto';
import {matchesToolSchema} from '../plugins/tool-package.mjs';
import {LOCAL_ROLE_TOOLS,LOCAL_ROLE_CAPABILITIES,LOCAL_ROLE_DEFAULT_LIMITS,LOCAL_ROLE_DISCOVERY_TOOL} from './local-role-schema.mjs';
const copy=structuredClone;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const key=(...v)=>digest(v);
const denied=()=>fail('LOCAL_ROLE_CONTEXT_INVALID','当前角色或会话归属已失效');
const requireVersion=(row,version)=>{if(!row||!Number.isSafeInteger(version)||row.version!==version)fail('VERSION_CONFLICT','内容已变化，请重新查询');};
const openGroup=row=>row?.channel==='desktop'&&row.kind==='group'&&!row.archivedAt&&!row.deletedAt&&row.active!==false;
const publicCharacter=row=>({id:row.id,name:row.name,version:row.version,avatarUrl:row.avatarUrl??null});

/** All storage and domain mutations are injected from the one live Book writer. */
export function createLocalRoleService({read,list,put,remove,transaction,createCharacter,updateCharacter,createConversation,addParticipants,resolveAvatar,peers,clock=()=>new Date().toISOString(),changed=()=>{}}={}){
 for(const f of [read,list,put,remove,transaction,createCharacter,updateCharacter,createConversation,addParticipants])if(typeof f!=='function')throw TypeError('Local role service requires the single Book writer ports');
 let closed=false;const sessions=new Set();
 if(!peers?.enqueue)throw TypeError('A2A peer service required');
 const character=id=>{const row=read('character',id);if(!row)fail('CHARACTER_NOT_FOUND','角色不存在');return row;};
 // Legacy local-role-grant rows are retained as historical data only. Neither
 // capabilities nor business budgets are derived from them, including zeroes.
 function getCapabilities(id){character(id);return {characterId:id,intrinsic:true,capabilities:[...LOCAL_ROLE_CAPABILITIES],limits:{...LOCAL_ROLE_DEFAULT_LIMITS}};}
 const inviteCheck=(actor,ids)=>{for(const target of ids){character(target);if(target===actor)denied();}};
 function bind({characterId,conversationId,runId,trigger,assertCurrent,signal,avatarResolver,peerAvailable=false,sessionSource,assertContext,peerEnqueue}={}){
  if(!validId(characterId)||!validId(conversationId)||!validId(runId)||typeof assertCurrent!=='function')throw TypeError('A fixed current-run binding is required');
  const scope=typeof assertContext==='function'?'a2a':'role';
  if(scope==='a2a'&&(!conversationId.startsWith('a2a:')||!validId(conversationId.slice(4))||peerAvailable&&typeof peerEnqueue!=='function'))throw TypeError('A2A requires Host-bound context and peer routing');
  let revoked=false;character(characterId);
  if(!validId(trigger?.id))return null;
  // These functions are minted by Host run/chain code, never tool parameters.
  function check(){
   if(closed||revoked||signal?.aborted||assertCurrent()===false)fail('RUN_CANCELLED','本轮角色能力已失效');
   character(characterId);
   if(scope==='a2a'){if(assertContext()===false)denied();}
   else {const conv=read('conversation',conversationId);if(!conv||!conv.participantIds.includes(characterId)||conv.active===false||conv.archivedAt||conv.deletedAt)denied();}
   return getCapabilities(characterId);
  }
  check();
  const definitions=[LOCAL_ROLE_DISCOVERY_TOOL,...LOCAL_ROLE_TOOLS.filter(tool=>tool.name!=='suna_peer_message'||peerAvailable===true)].map(tool=>({name:tool.name,description:tool.description,inputSchema:copy(tool.inputSchema)}));
  const session={characterId,revoke:()=>{revoked=true;}};sessions.add(session);
  function mutation(name,args,fn){
   if(!validId(args.requestId))fail('LOCAL_ROLE_INVALID','修改须提供唯一 requestId');
   return transaction(()=>{check();const id=key(characterId,args.requestId),fingerprint=digest([name,args]),prior=read('local-role-request',id);if(prior){if(prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','requestId 已用于其他操作');return {...copy(prior.result),duplicate:true};}
    const result=fn();put('local-role-request',id,{characterId,runId,triggerId:trigger.id,operation:name,fingerprint,result:copy(result),at:clock()});return result;
   });
  }
  const ownMemory=id=>{const row=read('memory',id);if(!row||row.characterId!==characterId)fail('MEMORY_NOT_FOUND','自己的工作记忆中没有此条目');return row;};
  async function execute(name,args={}){
   check();const definition=definitions.find(d=>d.name===name);if(!definition)denied();
   if(!plain(args)||!matchesToolSchema(args,definition.inputSchema))fail('LOCAL_ROLE_INVALID','工具参数无效');
   if(name==='suna_role_capabilities')return {
    scope:scope==='a2a'?'local-a2a':'local-role',intrinsic:true,capabilities:[...LOCAL_ROLE_CAPABILITIES],boundTools:definitions.map(tool=>tool.name),
    communication:{state:peerAvailable===true?'ready':'runtime_unavailable',runtimeReady:peerAvailable===true,recipientAcceptanceRequired:false},
    limits:{...LOCAL_ROLE_DEFAULT_LIMITS},
   };
   let avatar;
   if(name==='suna_self'&&args.avatarRef!==undefined){check();const resolve=avatarResolver??resolveAvatar;if(typeof resolve!=='function')fail('LOCAL_ROLE_AVATAR_UNAVAILABLE','本轮没有可用头像素材');avatar=await resolve({characterId,conversationId,runId,ref:args.avatarRef,signal});check();if(typeof avatar?.url!=='string'||!/^\/media-local\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(avatar.url))fail('LOCAL_ROLE_AVATAR_INVALID','头像素材无效');}
   if(name==='suna_self'&&args.mode==='get'){check();const row=character(characterId);return {...publicCharacter(row),persona:row.persona??'',personality:copy(row.personality??null)};}
   if(name==='suna_memory'&&args.mode==='list'){check();return {items:list('memory').filter(row=>row.characterId===characterId).slice(-(args.limit??20)).reverse().map(row=>({id:row.id,content:row.desc,version:row.version}))};}
   if(name==='suna_contacts'){check();return {characters:list('character').filter(row=>row.id!==characterId).map(publicCharacter),groups:list('conversation').filter(row=>openGroup(row)&&row.participantIds.includes(characterId)).map(row=>({id:row.id,title:row.title,version:row.version,participantIds:copy(row.participantIds)}))};}
   if(name==='suna_peer_message'){check();return (scope==='a2a'?peerEnqueue:peers.enqueue)({actorId:characterId,targetId:args.targetId,originConversationId:conversationId,runId,triggerId:trigger.id,requestId:args.requestId,content:args.content,senderSessionId:sessionSource?.(),signal});}
   const result=mutation(name,args,()=>{
    if(name==='suna_self'){
     if(args.mode!=='update'||!['name','persona','avatarRef'].some(k=>args[k]!==undefined))fail('LOCAL_ROLE_INVALID','请提供要修改的属性');
     if(args.name!==undefined||args.persona!==undefined)check();if(args.avatarRef!==undefined)check();
     const row=character(characterId);requireVersion(row,args.expectedVersion);const patch={};if(args.name!==undefined)patch.name=args.name;
     if(args.persona!==undefined){if(!Object.keys(args.persona).length)fail('LOCAL_ROLE_INVALID','人设字段不能为空');const p=copy(row.personality??{immutable:{backgrounds:row.persona??'',temper:''},mutable:{trait:'',habit:'',dialogue:''}});for(const [k,v]of Object.entries(args.persona))p[['backgrounds','temper'].includes(k)?'immutable':'mutable'][k]=v;patch.personality=p;patch.persona=p.immutable.backgrounds;}
     if(avatar)patch.avatarUrl=avatar.url;
     const saved=updateCharacter(characterId,patch,{expectedVersion:row.version});return {status:'updated',...publicCharacter(saved)};
    }
    if(name==='suna_memory'){
     check();if(!['add','update','remove'].includes(args.mode))fail('LOCAL_ROLE_INVALID','记忆操作无效');
     if(args.mode!=='remove'&&typeof args.content!=='string')fail('LOCAL_ROLE_INVALID','请提供记忆正文');
     const row=args.mode==='add'?null:ownMemory(args.id);if(row)requireVersion(row,args.expectedVersion);
     const id=row?.id??`memory_${randomUUID()}`;
     if(row)put('local-role-memory-history',randomUUID(),{characterId,memoryId:id,previous:copy(row),operation:args.mode,runId,triggerId:trigger.id});
     let saved;if(args.mode==='remove')remove('memory',id);else saved=put('memory',id,{...row,characterId,desc:args.content,source:row?.source??'agent',sourceConversationId:row?.sourceConversationId??conversationId,sourceMessageIds:row?.sourceMessageIds??[trigger.id],time:row?.time??clock(),createdAt:row?.createdAt??clock(),editedBy:{runId,triggerId:trigger.id}});
     const person=character(characterId);put('character',characterId,{...person,memoryVersion:(person.memoryVersion??0)+1});changed('characters.changed');return {status:args.mode==='remove'?'removed':args.mode==='add'?'created':'updated',id,...(saved?{version:saved.version}:{})};
    }
    if(name==='suna_create_bot'){
     const g=check();if(list('local-role-owned-bot').filter(row=>row.characterId===characterId).length>=g.limits.createdBots)fail('LOCAL_ROLE_QUOTA','已达到创建角色数量限制');
     const row=createCharacter({name:args.name,persona:args.persona??''});put('local-role-owned-bot',row.id,{characterId,childId:row.id});return {status:'created',character:publicCharacter(row)};
    }
    if(name==='suna_create_group'){
     const g=check(),ids=[...new Set([characterId,...args.participantIds])];if(ids.length<2||ids.length>g.limits.members)fail('LOCAL_ROLE_QUOTA','群成员数量超出范围');inviteCheck(characterId,ids.filter(id=>id!==characterId));
     if(list('local-role-owned-group').filter(row=>row.characterId===characterId).length>=g.limits.createdGroups)fail('LOCAL_ROLE_QUOTA','已达到创建群聊数量限制');
     const row=createConversation({title:args.title,kind:'group',channel:'desktop',participantIds:ids});put('local-role-owned-group',row.id,{characterId});return {status:'created',group:{id:row.id,title:row.title,version:row.version,participantIds:row.participantIds}};
    }
    if(name==='suna_invite'){
     const g=check(),row=read('conversation',args.groupId);if(!openGroup(row)||!row.participantIds.includes(characterId))denied();requireVersion(row,args.expectedVersion);
     const additions=[...new Set(args.participantIds)].filter(id=>!row.participantIds.includes(id));inviteCheck(characterId,additions);if(row.participantIds.length+additions.length>g.limits.members)fail('LOCAL_ROLE_QUOTA','群成员数量超出范围');
     const saved=addParticipants(row.id,additions);return {status:'updated',group:{id:saved.id,title:saved.title,version:saved.version,participantIds:saved.participantIds}};
    }
    fail('LOCAL_ROLE_INVALID','工具操作无效');
   });
   return result;
  }
  return {definitions,execute,dispose(){session.revoke();sessions.delete(session);}};
 }
 return {getCapabilities,bind,drain:peers.drain,recover:peers.recover,reconcile:peers.reconcile,cancelOrigin:peers.cancelOrigin,async close(){closed=true;for(const session of sessions)session.revoke();sessions.clear();await peers.close();}};
}
