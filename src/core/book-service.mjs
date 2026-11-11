import {schedulerWorkerDefaults} from './scheduler-worker-prompts.mjs';
import {isGeneratedDeveloperContent} from './original-developer-migration.mjs';
import {LOCAL_ROLE_TOOLS,LOCAL_ROLE_DISCOVERY_TOOL} from './local-role-schema.mjs';
const intrinsicRoleTools=new Set([LOCAL_ROLE_DISCOVERY_TOOL.name,...LOCAL_ROLE_TOOLS.map(tool=>tool.name)]);
import {createRoleCredentialStore} from './role-credential-store.mjs';
import {createConversationInteractions,INTERACTION_TOOLS} from './conversation-interactions.mjs';
import {runtimeReviewInstructionFor} from './runtime-review-instruction.mjs';
import {createRoleRuntimePermissions} from './runtime-permissions.mjs';
import {CONTROLLED_READER_SCHEMA} from './controlled-attachments.mjs';
import {createDirectInputQueue,directInputId} from './direct-input-queue.mjs';
import {isDesktopDirect,selectDesktopDirect,normalizeConversationPin} from './conversation-lifecycle.mjs';
import {channelConversationMainListVisible,validateChannelMainListChange} from './conversation-display.mjs';
import {normalizeGroupWakeWords,matchingWakeCharacterIds} from './group-wake-words.mjs';
import {createGroupScheduler,resolveGroupScheduler,mergeGroupScheduler,validateGroupScheduler,resolveChannelGroupScheduler,mergeChannelGroupScheduler} from './group-scheduler.mjs';
import {createGroupDispatchStore} from './group-dispatch-store.mjs';
import {createChannelGroupScheduler,resolveChannelGroupTiming} from './channel-group-scheduler.mjs';
import {selectChannelGroupHistory,withChannelGroupInput} from './channel-group-input.mjs';
import {createGroupMediaReferences} from './group-media-reference.mjs';
import {validateReplyToTrigger,replyToTriggerEnabled,channelReplyReference} from './channel-reply-reference.mjs';
import {normalizeReplyMessageId,resolveMessageReply} from './message-reply-reference.mjs';
import {decideGroupParticipation} from './group-decision.mjs';
import {mergeDesktopGroupScheduler,resolveDesktopGroupScheduler,isDesktopModeratedGroup} from './desktop-group-moderator-policy.mjs';
import {decideDesktopModerator} from './desktop-group-moderator-decision.mjs';
import {runDesktopModeratorRound} from './desktop-group-moderator-round.mjs';
import {withDesktopModeratorInput} from './desktop-group-moderator-input.mjs';
import {selectGroupDecisionWindow} from './group-decision-window.mjs';
import {projectGroupDecision,withGroupDecisionContext} from './group-decision-projection.mjs';
import {TOOL_PERMISSION_DEFAULTS,PERMISSION_TOOLS,permissionChange,permissionRecordKey,resolveToolPolicy,evaluateToolPermission,managedTool,isPluginToolId} from './tool-permissions.mjs';
import {primaryUserSender,withPrimaryUserRules} from './primary-user-label.mjs';
import {channelMessageBlocks} from './channel-message-blocks.mjs';
import {mentionContextText} from './channel-mentions.mjs';
import {channelConversationName} from './channel-display.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { VARIABLE_NAMES, renderPrompt, validatePrompt, assembleRuntimePrompts } from './prompts.mjs';
import { createPromptStore } from './prompt-store.mjs';
import {assembleClientRuntimePrompts} from './runtime-prompt-layers.mjs';
import {loadDefaultPromptConfig,toPromptConfig,snapshotProjection} from './prompt-config.mjs';
import { createMemoryStore } from './memory-store.mjs';
import { createCharacterMemoryView } from './character-memory-view.mjs';
import {createLocalRoleService} from './local-role-service.mjs';
import {createLocalRoleRecords,withA2aWorkerFacts} from './local-role-records.mjs';
import {createLocalRolePeers} from './local-role-peer.mjs';
import {A2A_DEFAULT_PREFIX,withA2aHistoryInput,withA2aRecentMessages,a2aTransportMessages} from './local-role-xml.mjs';
import {createLocalRoleMcpBinding} from '../mcp/local-role-client.mjs';
import {createPersonProfileStore} from './person-profile-store.mjs';
import {createPrimaryProfileView} from './primary-profile-view.mjs';
import {ADD_USER_PROFILE_DESCRIPTION,ADD_USER_PROFILE_PARAMETERS} from './person-profile-tool.mjs';
import {createRunPersonProfile,projectPersonProfile,withPersonProfileContext} from './person-profile-host.mjs';
import { createWorkerEngine, decodeWorkerResponse, validateWorkerResult } from './worker-engine.mjs';
import { createBackgroundScheduler, parseCron, nextRun } from './background.mjs';
import { parseMessageContent } from './message-content.mjs';
import { createWorkbenchMedia } from './workbench-media.mjs';
import { createMessageImageAccess } from './message-image-access.mjs';
import { prepareRunInput } from './run-input-budget.mjs';
import { toolTerminationDescription, toolTerminationSystemRules } from './tool-termination-contract.mjs';
import { runFailureState, runFailureNotice } from './run-failure-notice.mjs';
import { withSemanticBubbleRules } from './chat-bubble-rules.mjs';
import { withGroupReplyStyleRules } from './group-reply-style-rules.mjs';
import { createConversationObservability } from './conversation-observability.mjs';
import { estimateCall } from '../models/model-pricing.mjs';

const DEFAULT_PERSONALITY=JSON.parse(readFileSync(new URL('./data/default-persona.json',import.meta.url),'utf8'));
const DEFAULT_APPEARANCE=Object.freeze({transparency:50,blur:'system'});
const DEFAULT_ACCENT_COLOR='#38bdf8';
const DEFAULT_DREAM_CRON='0 4 * * *';
const validAccentColor=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
function validateAppearance(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['transparency','blur'].includes(key)))fail('INVALID_SETTINGS','外观设置格式无效');
  if(Object.hasOwn(value,'transparency')&&(!Number.isInteger(value.transparency)||value.transparency<0||value.transparency>100))fail('INVALID_SETTINGS','背景透明度必须为0至100的整数');
  if(Object.hasOwn(value,'blur')&&!['off','system'].includes(value.blur))fail('INVALID_SETTINGS','背景模糊仅支持关闭或系统');
  return {...value};
}
const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${randomUUID()}`;
const clone = value => structuredClone(value);
const TOOL_NAMES=Object.freeze({sendMessage:'send_message',ask:'ask',requestCredentials:'request_credentials',noReply:'no_reply',addWorkMemory:'add_work_memory',addUserProfile:'add_user_profile',recallMemory:'recall_memory',updateEmotion:'update_emotion',interactEnv:'interact_env',cron:'cron',getSelfie:'get_selfie'});
// Model-facing Client names are separate from persisted prompt/permission IDs.
// Keep the user-selected spelling of suna_webserach exactly as specified.
const CLIENT_WEB_NAMES=Object.freeze({websearch:'suna_webserach',webfetch:'suna_webfetch'});
const toolConfigName=name=>name===CLIENT_WEB_NAMES.websearch?'websearch':name===CLIENT_WEB_NAMES.webfetch?'webfetch':name;
const exposedToolName=name=>CLIENT_WEB_NAMES[name]??name;
const CLIENT_WEB_PARAMETERS={
  suna_webserach:{type:'object',properties:{query:{type:'string',minLength:1}},required:['query'],additionalProperties:false},
  suna_webfetch:{type:'object',properties:{url:{type:'string',pattern:'^https?://',minLength:1}},required:['url'],additionalProperties:false},
};
const CLIENT_WEB_FAILURE_MESSAGES=Object.freeze({
  SEARCH_AUTH_FAILED:'网页服务凭据验证失败，请检查配置',
  SEARCH_BALANCE_REQUIRED:'网页服务账户余额不足',
  SEARCH_FETCH_POLICY_DENIED:'网页读取被服务安全策略拒绝',
  SEARCH_FETCH_UNAVAILABLE:'该网页暂无法提取内容，或站点不允许读取',
  SEARCH_LIMIT_REACHED:'网页服务请求过于频繁或额度受限，请稍后重试',
  SEARCH_UPSTREAM_TIMEOUT:'网页服务上游请求超时，请稍后重试',
  SEARCH_PROVIDER_FAILED:'网页服务请求失败，请检查配置或稍后重试',
  SEARCH_RESPONSE_TOO_LARGE:'网页服务响应超过大小限制',
  SEARCH_RESPONSE_INVALID:'网页服务返回了无效响应',
  SEARCH_NETWORK_FAILED:'无法连接网页服务',
  SEARCH_REDIRECT_REJECTED:'网页服务重定向已拒绝',
  SEARCH_CANCELLED:'网页请求已取消',
  SEARCH_TIMEOUT:'网页服务请求超时',
  SEARCH_DISABLED:'网页服务尚未启用或配置已改变，请重新调用',
  SEARCH_CLOSED:'网页服务已关闭',
  SEARCH_BUSY:'网页服务正在处理较多请求，请稍后重试',
  INVALID_SEARCH_QUERY:'搜索词无效，请修改后重试',
  INVALID_FETCH_URL:'请输入不含凭据的公开 HTTP(S) 网页地址',
});
function clientWebFailure(error){
  if(!(error instanceof Error))return;
  // Only project the service's bounded receipt contract. Never forward a
  // handler's Error.message, source, accessors or extra provider response data.
  const own=(value,key)=>Object.getOwnPropertyDescriptor(value,key)?.value;
  const code=own(error,'code'),values=own(error,'attempts');
  if(typeof code!=='string'||!Object.hasOwn(CLIENT_WEB_FAILURE_MESSAGES,code)||!Array.isArray(values)||values.length>2)return;
  const attempts=[],seen=new Set();
  for(let index=0;index<values.length;index++){
    const item=own(values,String(index));if(!item||typeof item!=='object'||Array.isArray(item))return;
    const provider=own(item,'provider'),ok=own(item,'ok'),attemptCode=own(item,'code');
    if(!['tavily','deepseek'].includes(provider)||seen.has(provider)||typeof ok!=='boolean'||(attemptCode!==undefined&&(typeof attemptCode!=='string'||!Object.hasOwn(CLIENT_WEB_FAILURE_MESSAGES,attemptCode)))||(!ok&&attemptCode===undefined))return;
    seen.add(provider);attempts.push({provider,ok,...(attemptCode===undefined?{}:{code:attemptCode})});
  }
  return {ok:false,error:{code,message:CLIENT_WEB_FAILURE_MESSAGES[code]},attempts,...(attempts.length?{source:attempts.at(-1).provider}:{})};
}
// Ship extension schemas with every request so already installed bridges can register them.
const EMOJI_TOOL_PARAMETERS = {
  list_emojis:{type:'object',properties:{query:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false},
  send_message:{type:'object',properties:{emojiId:{type:'string',minLength:1},content:{type:'string',minLength:1},text:{type:'string',minLength:1},conversationId:{type:'string'},replyToMessageId:{type:'string'},mentionIds:{type:'array',items:{type:'string'}},idempotencyKey:{type:'string'},idempotency_key:{type:'string'},terminate:{type:'boolean',description:'false 表示发送进度后继续处理；true 表示最终回复后结束本轮；省略沿用配置默认值。'}},anyOf:[{required:['content']},{required:['text']},{required:['emojiId']}],additionalProperties:false}
};
const WORKSPACE_PREVIEW_PARAMETERS={type:'object',properties:{directory:{type:'string',minLength:1,maxLength:512,default:'.',description:'角色工作目录内的相对目录，省略时使用当前目录。'}},additionalProperties:false};
const WORKSPACE_PREVIEW_DESCRIPTION='预览角色工作目录内的静态 HTML/CSS/JS 网页快照，directory 为相对目录，默认当前目录。仅提供临时本机只读 URL，允许浏览器页面内交互，不执行服务端脚本、命令、npm 或开发服务器。需要当前桌面主人及此角色会话的终端权限；权限撤回后链接失效。';
const WORKSPACE_PREVIEW_TTL=10*60*1000;
const required = (value,label,max=200) => { if(typeof value !== 'string'||!value.trim()||value.length>max) throw new Error(`${label}不能为空且不能超过 ${max} 字符`);return value.trim(); };
export class BookError extends Error { constructor(code,message){super(message);this.name='BookError';this.code=code;} }
function fail(code,message){throw new BookError(code,message);}
function redact(value){
  if(Array.isArray(value))return value.map(redact);
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/token|secret|password|authorization|api.?key|credential/i.test(k)?'[已隐藏]':redact(v)]));
  return typeof value==='string'?value.replace(/(Bearer\s+)[\w.\-]+/gi,'$1[已隐藏]').replace(/\bsk-[\w-]{12,}\b/g,'[已隐藏]').replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[已隐藏]@').replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[=:]\s*)[^\s,;]+/gi,'$1[已隐藏]'):value;
}
const BASE_PROMPT = `You are {{character_name}}. Follow the supplied profile and conversation context. Send visible replies through send_message. Do not claim that an action succeeded without a confirming tool result. Respect current permissions and the user’s choices.\n<state s-if="state_updated != ''">{{state_updated}}</state>\n<memory s-if="work_memory_updated != ''">{{work_memory_updated}}</memory>\nConversation context: {{message_context}}`;

export function createBookService({ dataDir, runtime, workerClient, toneClient, channels, media = {}, composerAttachments, toolServices = {}, clock = now, testMode = false, seed, maxConcurrentRuns = 16, cancellationGraceMs = 5000, failureNoticeTimeoutMs = 15000, channelSchedulerTimers = {}, builtinTimers = {} } = {}) {
  if(!dataDir)throw new Error('dataDir is required');
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const databasePath = path.join(dataDir,'book.sqlite');
  const db = new DatabaseSync(databasePath); chmodSync(databasePath,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(conversation_id,sequence));
    CREATE TABLE IF NOT EXISTS incoming(dedupe_key TEXT PRIMARY KEY,message_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,character_id TEXT NOT NULL,trigger_id TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(conversation_id,character_id,trigger_id));
    CREATE TABLE IF NOT EXISTS prompt_revisions(key TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(key,revision));
    CREATE TABLE IF NOT EXISTS logs(sequence INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,level TEXT NOT NULL,event TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_commits(task_id TEXT PRIMARY KEY,name TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,sequence);
    PRAGMA user_version=1;`);
  const listeners = new Set(), queues = new Map(), controllers = new Map(), quarantines = new Map(), ambientEpochs = new Map(), automaticEpochs = new Map(), epochs = new Map(), testSessions = new Map(), testControllers = new Map(), testTasks = new Set(), publicTasks = new Set(), pendingReceipts = new Map(), screenClaims = new Map(), mediaStores = new Map(), channelMediaTasks = new Map(), channelMentionTasks = new Map(), sendTasks = new Map(); let closed = false, closing = false, closeTask, startTask, builtinTimer, builtinTick;
  const previewGrants=new Map(),previewReleases=new Set();
  let occupiedSlots=0; const slotWaiters=[];
  async function acquireSlot(){if(occupiedSlots>=Math.max(1,maxConcurrentRuns))await new Promise(resolve=>slotWaiters.push(resolve));else occupiedSlots++;let released=false;return()=>{if(released)return;released=true;const next=slotWaiters.shift();if(next)next();else occupiedSlots--;};}
  const read = (kind,key) => {const row=db.prepare('SELECT payload,version FROM entities WHERE kind=? AND id=?').get(kind,key);return row?{...JSON.parse(row.payload),version:row.version}:null;};
  const list = kind=>db.prepare('SELECT payload,version FROM entities WHERE kind=? ORDER BY rowid').all(kind).map(r=>({...JSON.parse(r.payload),version:r.version}));
  function put(kind,key,value,expectedVersion){
    const old=read(kind,key); if(expectedVersion!==undefined&&old?.version!==expectedVersion)fail('VERSION_CONFLICT','内容已被更新，请刷新后再保存');
    const version=(old?.version??0)+1;const payload={...value,id:value.id??key,version,updatedAt:clock()};
    db.prepare('INSERT INTO entities(kind,id,version,payload) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,payload=excluded.payload').run(kind,key,version,JSON.stringify(payload)); return payload;
  }
  function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  function emit(type,payload={}){if(closed)return;const event={type,...payload};for(const listener of listeners){try{listener(clone(event));}catch{}}}
  function log(event,payload={},level='info'){
    if(closed)return;
    db.prepare('INSERT INTO logs(time,level,event,payload) VALUES(?,?,?,?)').run(clock(),level,event,JSON.stringify(redact(payload)));
    db.prepare('DELETE FROM logs WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-2000 FROM logs)').run();
    try{recordClientFunction(event,payload);}catch(error){if(event!=='observability.failed')log('observability.failed',{code:error.code??'TELEMETRY_INVALID'},'warn');}
  }
  function requireOpen(){if(closed||closing)fail('CLOSED','沙之书正在关闭或已关闭');}
  function character(key){const result=read('character',key);if(!result)fail('CHARACTER_NOT_FOUND','角色不存在');return result;}
  function conversation(key){const result=read('conversation',key);if(!result)fail('CONVERSATION_NOT_FOUND','对话不存在');return result;}
  const settings=()=>read('settings','app');
  const channelGroupSettings=()=>resolveChannelGroupScheduler(settings().groupScheduler,settings().channelGroupScheduler);
  const channelPolicy=conv=>({...channelGroupSettings(),...conv?.scheduler,...resolveChannelGroupTiming(channelGroupSettings(),conv?.scheduler),enabled:channelGroupSettings().enabled!==false&&conv?.scheduler?.enabled!==false});
  const groupGlobalPolicy=conv=>conv?.kind==='group'&&conv.channel!=='desktop'?channelGroupSettings():settings().groupScheduler;
  function publishedSchedulerPrompt(name){const row=promptHead({scope:'worker',name});return row?{content:row.content,metadata:{enabled:row.metadata?.enabled},revision:row.revision}:null;}
  const groupDecisionPolicy=conv=>conv?.kind==='group'&&conv.channel!=='desktop'?{...channelPolicy(conv),workerPrompt:publishedSchedulerPrompt('group_scheduler')}:null;
  function effectiveBackground(person,preferences=settings()){
    const enabled=preferences.background?.enabled!==false&&person?.background?.enabled!==false;
    const dreamCron=person?.background?.dreamCron??preferences.background?.dreamCron??DEFAULT_DREAM_CRON;
    return {enabled,diaryEnabled:enabled&&preferences.background?.diaryEnabled!==false&&person?.background?.diaryEnabled!==false,dreamCron,dreamEnabled:enabled&&Boolean(dreamCron),timeZone:preferences.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone};
  }
  const validAccentTextMode=value=>['auto','dark','light'].includes(value);
  const settingsView=value=>redact({...value,personalAvatarUrl:value.personalAvatarUrl??'',accentTextMode:validAccentTextMode(value.accentTextMode)?value.accentTextMode:'auto',accentColor:validAccentColor(value.accentColor)?value.accentColor.toLowerCase():DEFAULT_ACCENT_COLOR,background:{...value.background,dreamCron:value.background?.dreamCron??DEFAULT_DREAM_CRON},channelGroupSchedulerEffective:resolveChannelGroupScheduler(value.groupScheduler,value.channelGroupScheduler)});
  const observability=createConversationObservability({db,clock,isDeveloper:()=>settings()?.developerMode===true,emit:event=>emit(event.type,{conversationId:event.conversationId})});
  function recordUsageCall(record,scope={}){
    if(closed||!record||typeof record!=='object')return;
    const value={...record,...scope};
    if(!value.conversationId||!value.id)return;
    try{
      if(!value.estimate)value.estimate=estimateCall({usage:value.usage,pricing:value.pricingSnapshot,providerKind:value.providerKind,modelId:value.configuredModelId??value.modelId,usageFormat:'pi'});
      return observability.recordCall(value);
    }catch(error){log('observability.failed',{code:error.code??'TELEMETRY_INVALID'},'warn');}
  }
  function recordClientFunction(event,payload){
    const events={
      'tool.completed':['function','completed'],'tool.failed':['function','failed'],
      'message.accepted':['send','accepted'],'message.delivered':['send',payload.status??'delivered'],'message.failed':['send','failed'],
      'permission.checked':['check',payload.allowed?'passed':'rejected'],
    };
    if(!events[event])return;
    const row=payload.runId?db.prepare('SELECT payload FROM runs WHERE id=?').get(payload.runId):null;
    const run=row?JSON.parse(row.payload):null;
    const messageRow=payload.messageId?db.prepare('SELECT payload FROM messages WHERE id=?').get(payload.messageId):null;
    const message=messageRow?JSON.parse(messageRow.payload):null;
    const taskId=payload.taskId??message?.taskId;
    const task=taskId?(read('outbox-task',taskId)??read('worker-task',taskId)):null;
    const conversationId=run?.conversationId??task?.conversationId??task?.args?.conversationId??message?.conversationId;
    if(!conversationId)return;
    const [kind,status]=events[event],name=kind==='send'?'send_message':payload.name??'权限检查';
    const key=payload.toolCallId??payload.messageId??payload.taskId??payload.runId;
    if(!key)return;
    const summary=kind==='send'?(message?.text??(status==='accepted'?'消息已受理':payload.error??'消息发送失败')):kind==='check'?(payload.allowed?'工具权限检查通过':'工具权限检查未通过'):(payload.error??`${name} 已完成`);
    observability.recordFunction({id:`function:${event}:${key}`,category:'client-function',kind,name,stage:name,status,time:clock(),conversationId,characterId:run?.characterId??task?.characterId??task?.args?.characterId??message?.sender?.id,runId:run?.id??task?.runId??message?.runId,triggerId:run?.triggerId??task?.triggerId??task?.args?.source?.triggerId,roundId:run?.triggerId??task?.triggerId??task?.args?.source?.triggerId,taskId:task?.id,summary,messageId:message?.id,receiptStatus:kind==='send'?status:undefined,...(kind==='check'?{checks:[{name:`${payload.name??'工具'}权限`,passed:payload.allowed===true}]}:{})});
  }
  function developer(){requireOpen();if(!settings().developerMode)fail('DEVELOPER_MODE_REQUIRED','请先打开开发者模式');}
  function messages(conversationId,limit=100){return db.prepare('SELECT payload FROM messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT ?').all(conversationId,Math.max(1,Math.min(1000,limit))).reverse().map(r=>JSON.parse(r.payload));}
  function appendMessage(input,{onPersisted,withinTransaction=false}={}){
    const message=(withinTransaction?fn=>fn():transaction)(()=>{const next=db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM messages WHERE conversation_id=?').get(input.conversationId).next;
      const value={id:id('msg'),createdAt:clock(),sequence:next,status:'delivered',...input};
      db.prepare('INSERT INTO messages(id,conversation_id,sequence,payload) VALUES(?,?,?,?)').run(value.id,value.conversationId,next,JSON.stringify(value));
      const conv=conversation(value.conversationId);put('conversation',conv.id,{...conv,lastMessage:value.text.slice(0,160),lastMessageAt:value.createdAt});onPersisted?.(value);return value;
    });if(withinTransaction)queueMicrotask(()=>{if(!closed&&db.prepare('SELECT id FROM messages WHERE id=?').get(message.id))emit('message',{message});});else emit('message',{message});return message;
  }
  function patchMessage(message,patch){const result={...message,...patch};db.prepare('UPDATE messages SET payload=? WHERE id=?').run(JSON.stringify(result),message.id);emit('message',{message:result});return result;}

  let credentialStore;const credentialStoreForBusiness=()=>{requireOpen();return credentialStore??=createRoleCredentialStore({root:path.join(dataDir,'credentials'),authorize:request=>hasCharacter(request.characterId)&&toolServices.authorizeCredential?.(request)===true});};
  const roleCredentials=Object.fromEntries(['write','writeAtomically','metadata','readForBusiness','withEnvironment'].map(name=>[name,(...args)=>credentialStoreForBusiness()[name](...args)]));roleCredentials.close=()=>credentialStore?.close();
  const interactions=createConversationInteractions({read,put,list,transaction,append:input=>appendMessage({...input,sender:{...input.sender,name:character(input.sender.id).name}},{withinTransaction:true}),patch:patchMessage,findMessage:(messageId,conversationId)=>{const row=db.prepare('SELECT payload FROM messages WHERE id=? AND conversation_id=?').get(messageId,conversationId);return row?JSON.parse(row.payload):null;},clock,credentials:roleCredentials,changed:conversationId=>emit('interaction.changed',{conversationId}),validateScope:row=>{requireOpen();const person=character(row.characterId),conv=conversation(row.conversationId);requireActiveConversation(conv);if(conv.channel!=='desktop'||!conv.participantIds.includes(person.id))fail('INTERACTION_SCOPE_DENIED','请在角色本地会话使用交互工具');if(promptHead({characterId:person.id,scope:'tool',name:row.kind})?.metadata?.enabled===false||!toolPermission(row.kind,person,conv,{sender:{type:'human',id:'local-owner',source:'desktop'}}).allowed)fail('permission.denied','此角色的交互工具权限已关闭');},respond:({row,content})=>{const conv=conversation(row.conversationId),requestId='interaction:'+row.id,prior=db.prepare('SELECT message_id FROM incoming WHERE dedupe_key=?').get(requestId);if(prior)return {messageId:prior.message_id};const message=appendMessage({conversationId:conv.id,text:content,role:'user',sender:{type:'human',id:'local-owner',name:'你',source:'desktop'},requestId,mentionIds:[row.characterId],roleEligibility:{[row.characterId]:true},dispatchAmbientEligible:false,replyToMessageId:row.messageId,source:{type:'interaction-answer',interactionId:row.id}},{withinTransaction:true});db.prepare('INSERT INTO incoming(dedupe_key,message_id) VALUES(?,?)').run(requestId,message.id);if(isDesktopDirect(conv))directInputs.offer(message,row.characterId);else queueMicrotask(()=>{if(!closed&&!closing&&read('interaction',row.id)?.status!=='pending')void dispatch(message).catch(()=>log('interaction.dispatch.failed',{conversationId:conv.id,interactionId:row.id,code:'DISPATCH_FAILED'},'error'));});return {messageId:message.id};}});
  function getInteraction(input){const result=interactions.get(input);return {...result,...(result.kind==='request_credentials'?{credentialVersion:roleCredentials.metadata(result.characterId).version}:{})};}
  function submitInteraction(input){return interactions.submit(input);}
  function cancelInteraction(input){return interactions.cancel(input);}
  function promptKey({characterId,scope='runtime',name='system'}={}){return `${characterId??'*'}:${scope}:${name}`;}
  function promptHead(input){return promptStore.promptHead(input);}
  function seedPrompt(input,content,label,metadata={}){return promptStore.seedPrompt(input,content,label,metadata);}
  const promptStore=createPromptStore({read,list,put,transaction,db,clock,requireOpen,requireCharacter:character,emit,log});
  const memoryStore=createMemoryStore({db,clock});
  db.exec("CREATE INDEX IF NOT EXISTS local_role_delivery_chain ON entities(json_extract(payload,'$.chainId')) WHERE kind='local-role-delivery';CREATE INDEX IF NOT EXISTS local_role_delivery_status ON entities(json_extract(payload,'$.status')) WHERE kind='local-role-delivery';CREATE INDEX IF NOT EXISTS local_role_session_chain ON entities(json_extract(payload,'$.chainId')) WHERE kind='local-role-peer-session';CREATE INDEX IF NOT EXISTS local_role_open_chain ON entities(id) WHERE kind='local-role-chain' AND json_extract(payload,'$.status')!='ended';");
  const localRoleRecords=createLocalRoleRecords({read,put,clock,findMessage:messageId=>{const row=db.prepare('SELECT payload FROM messages WHERE id=?').get(messageId);return row?JSON.parse(row.payload):null;},
    mainConversation:characterId=>activeDesktopDirect(characterId)??createConversation({kind:'direct',channel:'desktop',participantIds:[characterId]}),
    validateConversation:(characterId,conversationId)=>{const conv=conversation(conversationId);requireActiveConversation(conv);if(!isDesktopDirect(conv)||conv.participantIds[0]!==characterId)fail('TARGET_DENIED','通信记录不属于接收角色的主会话');},
    write:record=>{
      const conv=conversation(record.originConversationId),existing=db.prepare('SELECT payload FROM messages WHERE id=?').get(record.anchorId);let value;
      if(existing){const old=JSON.parse(existing.payload);if(old.hidden===true||old.deletedAt||old.status==='deleted')fail('A2A_ANCHOR_NOT_FOUND','通信标记已隐藏');if(record.expectedSequence!==undefined&&old.sequence!==record.expectedSequence)fail('A2A_ANCHOR_MISMATCH','通信标记位置变化');if(old.conversationId!==conv.id||old.source?.type!=='local-role-communication'||old.source?.chainId!==record.source.chainId)fail('A2A_ANCHOR_MISMATCH','通信标记归属不匹配');value={...old,text:record.text,blocks:[{type:'text',text:record.text}],source:record.source};db.prepare('UPDATE messages SET payload=? WHERE id=?').run(JSON.stringify(value),value.id);}
      else{if(record.allowCreate!==true)fail('A2A_ANCHOR_NOT_FOUND','通信标记已删除');const next=db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM messages WHERE conversation_id=?').get(conv.id).next;value={id:record.anchorId,conversationId:conv.id,sequence:next,createdAt:clock(),status:'delivered',text:record.text,blocks:[{type:'text',text:record.text}],role:'system',sender:{type:'system',id:'local-role-communication',name:'角色通信'},source:record.source,dispatchEligible:false};db.prepare('INSERT INTO messages(id,conversation_id,sequence,payload) VALUES(?,?,?,?)').run(value.id,conv.id,next,JSON.stringify(value));}
      if(messages(conv.id,1).at(-1)?.id===value.id)put('conversation',conv.id,{...conv,lastMessage:'角色通信',lastMessageAt:value.createdAt});emit('message',{message:value});return {id:value.id,sequence:value.sequence};
    }
  });
  const localRolePeers=createLocalRolePeers({read,list,put,transaction,clock,changed:emit,deliveriesFor:key=>db.prepare("SELECT payload FROM entities WHERE kind='local-role-delivery' AND json_extract(payload,'$.chainId')=? ORDER BY rowid").all(key).map(row=>JSON.parse(row.payload)),queuedRows:()=>db.prepare("SELECT payload FROM entities WHERE kind='local-role-delivery' AND json_extract(payload,'$.status')='queued' ORDER BY rowid").all().map(row=>JSON.parse(row.payload)),sessionsFor:key=>db.prepare("SELECT payload FROM entities WHERE kind='local-role-peer-session' AND json_extract(payload,'$.chainId')=?").all(key).map(row=>JSON.parse(row.payload)),openRows:()=>db.prepare("SELECT payload FROM entities WHERE kind='local-role-chain' AND json_extract(payload,'$.status')!='ended'").all().map(row=>JSON.parse(row.payload)),capabilities:key=>localRoles.getCapabilities(key),character,bindRoleTools:input=>localRoles.bind(input),
    assertOrigin:(actorId,conversationId,anchor)=>{requireOpen();const conv=conversation(conversationId);requireActiveConversation(conv);character(actorId);if(!conv.participantIds.includes(actorId))fail('TARGET_DENIED','通信标记不属于当前角色会话');if(anchor){const row=db.prepare('SELECT payload FROM messages WHERE id=? AND conversation_id=?').get(anchor.id,conv.id),marker=row?JSON.parse(row.payload):null;if(!marker||marker.conversationId!==conv.id||marker.source?.type!=='local-role-communication'||marker.sequence!==anchor.sequence||marker.hidden===true||marker.deletedAt||marker.status==='deleted')fail('A2A_ANCHOR_NOT_FOUND','通信标记已不存在');}},
    project:record=>localRoleRecords.project(record),
    buildPrompts:key=>{const person=character(key),publicRole={id:person.id,name:person.name,persona:person.persona,personality:person.personality},variables=snapshotProjection({character:publicRole,state:{},memories:[],history:[],input:'',messageContext:{source:'agent',channel:'a2a'},at:clock()}).variables;const system=promptHead({characterId:key,scope:'runtime',name:'system'}),dev=promptHead({characterId:key,scope:'runtime',name:'dev'}),a2a=promptHead({characterId:key,scope:'runtime',name:'a2a'});variables['memory.user_profile']='';const prompts=assembleClientRuntimePrompts({system:system?.content??BASE_PROMPT,developer:dev?.metadata?.enabled===true?dev.content:'',input:'',variables});return {...prompts,a2aPrefix:a2a?.metadata?.enabled===false?'':renderPrompt(a2a?.content??A2A_DEFAULT_PREFIX,variables).text};},
    workspace:contextId=>{const folder=path.join(dataDir,'a2a-workspaces',contextId);mkdirSync(folder,{recursive:true,mode:0o700});return folder;},
    executeKernel:request=>{if(typeof runtime?.run!=='function')fail('RUNTIME_UNAVAILABLE','A2A 内核未连接');return runtime.run(request);},
    endKernel:request=>{if(typeof runtime?.endA2A!=='function')fail('A2A_RUNTIME_UNAVAILABLE','当前内核插件不支持 A2A 会话收口');return runtime.endA2A(request);},
    onModelCall:(call,scope)=>{if(!closed&&call?.id)recordUsageCall(call,{id:`runtime:${scope.runId}:${call.id}`,category:'runtime-loop',conversationId:scope.originConversationId,characterId:scope.characterId,runId:scope.runId,triggerId:scope.triggerId,roundId:scope.chainId,stage:call.stage??'a2a'});}
  });
  const localRoles=createLocalRoleService({read,list,put,transaction,remove:(kind,key)=>db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind,key),createCharacter,updateCharacter,createConversation,addParticipants,clock,changed:emit,peers:localRolePeers});
  const rawPersonProfiles=createPersonProfileStore({db,clock,requireCharacter:character});
  const personProfiles=createPrimaryProfileView({store:rawPersonProfiles,getAliases:characterId=>channels?.primaryUserAliases?.({characterId})??[]});
  function listPersonProfiles(input){requireOpen();return personProfiles.list(input);}
  function getPersonProfile(input){requireOpen();return personProfiles.detail(input);}
  const characterMemoryView=createCharacterMemoryView({character:key=>{requireOpen();return character(key);},list,memoryStore,relations:characterId=>db.prepare('SELECT memory_id,related_id,description AS desc,time FROM memory_relations WHERE character_id=?').all(characterId)});
  function getCharacterMemories(input){requireOpen();return characterMemoryView.get(input);}
  function getCharacterDreams(input){requireOpen();return characterMemoryView.dreams(input);}
  function validateCharacter(key){requireOpen();const person=character(key);return {id:person.id};}
  // Permission checks need a current existence fact, not the UI's full book
  // projection (which reads histories, prompts and background tasks).
  function hasCharacter(key){requireOpen();return typeof key==='string'&&!!db.prepare("SELECT 1 FROM entities WHERE kind='character' AND id=?").get(key);}
  const fixedConfig=loadDefaultPromptConfig(),seedConfig=toPromptConfig(fixedConfig);
  if(!settings())put('settings','app',{developerMode:false,theme:'system',accentColor:DEFAULT_ACCENT_COLOR,accentTextMode:'auto',appearance:{...DEFAULT_APPEARANCE},petEnabled:false,petType:'frames',ownerBindings:[],groupScheduler:{enabled:true,idleMs:1500},runtime:{mode:'bundled'},background:{diaryEnabled:true},timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,createdAt:clock()});
  const appearanceSettings=settings();
  if(appearanceSettings.appearance===undefined)put('settings','app',{...appearanceSettings,appearance:{...DEFAULT_APPEARANCE}},appearanceSettings.version);
  else if(appearanceSettings.appearance&&typeof appearanceSettings.appearance==='object'&&!Array.isArray(appearanceSettings.appearance)&&(!Object.hasOwn(appearanceSettings.appearance,'transparency')||!Object.hasOwn(appearanceSettings.appearance,'blur')))put('settings','app',{...appearanceSettings,appearance:{...DEFAULT_APPEARANCE,...validateAppearance(appearanceSettings.appearance)}},appearanceSettings.version);
  if(!list('character').length){put('character','default-character',{id:'default-character',name:'助手',persona:DEFAULT_PERSONALITY.immutable.backgrounds,personality:clone(DEFAULT_PERSONALITY),color:'#64748b',avatar:'助',state:{emotion:'',environment:'',pad:{pleasure:0,arousal:0,dominance:0}},memoryVersion:0,createdAt:clock()});}
  const legacy=new Map([['runtime:system',BASE_PROMPT],['runtime:dev',''],['runtime:user_input','<system_time>{{system_time}}</system_time>\n<message_context>{{message_context}}</message_context>\n{{user_input}}']]);
  const legacyLabels=new Map([['runtime:system','System prompt'],['runtime:dev','Developer instructions'],['runtime:user_input','Turn input']]);

  function untouchedLegacyPrompt(old,entry){return old.revision===1&&old.version===1&&old.draft===old.content&&legacy.get(`${entry.scope}:${entry.name}`)===old.content&&old.content!==entry.content&&[entry.name,entry.label,legacyLabels.get(`${entry.scope}:${entry.name}`)].includes(old.label)&&(old.draftLabel??old.label)===old.label&&Object.keys(old.metadata??{}).length===0&&Object.keys(old.draftMetadata??{}).length===0;}

  for(const entry of seedConfig.prompts){const key=promptKey(entry),old=read('prompt',key);if(!old)seedPrompt(entry,entry.content,entry.label,entry.metadata);else if(untouchedLegacyPrompt(old,entry))promptStore.publishPrompt({...entry,expectedRevision:1,expectedVersion:1});}
  for(const [name,definition] of Object.entries(INTERACTION_TOOLS))if(!read('prompt',promptKey({scope:'tool',name})))seedPrompt({scope:'tool',name},definition.description,name==='ask'?'提问':'填写凭证',{enabled:true,terminate:false});
  for(const entry of schedulerWorkerDefaults)if(!read('prompt',promptKey(entry)))seedPrompt(entry,entry.content,entry.label,entry.metadata);
  if(!read('prompt',promptKey({scope:'runtime',name:'a2a'})))seedPrompt({scope:'runtime',name:'a2a'},A2A_DEFAULT_PREFIX,'A2A 提示词',{enabled:true});
  if(!read('prompt',promptKey({scope:'tool',name:TOOL_NAMES.addUserProfile})))seedPrompt({scope:'tool',name:TOOL_NAMES.addUserProfile},ADD_USER_PROFILE_DESCRIPTION,'人物画像',{enabled:true,terminate:false});
  // Upgrade only the untouched product-disabled screenshot default. User edits,
  // per-role overrides and explicitly published disables remain authoritative.
  const oldScreen=read('prompt',promptKey({scope:'tool',name:'screenshot'})),screenSeed=seedConfig.prompts.find(entry=>entry.scope==='tool'&&entry.name==='screenshot');
  const sameMetadata=(a,b)=>JSON.stringify(Object.entries(a??{}).sort())===JSON.stringify(Object.entries(b??{}).sort());
  if(oldScreen&&screenSeed&&oldScreen.revision===1&&oldScreen.version===1&&oldScreen.draft===oldScreen.content&&oldScreen.content===screenSeed.content&&oldScreen.label===screenSeed.label&&oldScreen.draftLabel===oldScreen.label&&sameMetadata(oldScreen.metadata,{...screenSeed.metadata,enabled:false})&&sameMetadata(oldScreen.draftMetadata,oldScreen.metadata)){
    promptStore.publishPrompt({scope:'tool',name:'screenshot',content:oldScreen.content,metadata:screenSeed.metadata,expectedRevision:1,expectedVersion:1});
  }
  // Replace only exact generated Client guidance; archive it before publication.
  for(const old of list('prompt').filter(row=>row.scope==='runtime'&&row.name==='dev'&&row.metadata?.developerSource===undefined&&isGeneratedDeveloperContent(row.content))){
    if((old.draft??old.content)!==old.content||(old.draftLabel??old.label)!==old.label||!sameMetadata(old.draftMetadata??old.metadata,old.metadata))continue;
    promptStore.createPromptCheckpoint({scope:'runtime',name:'dev',...(old.characterId?{characterId:old.characterId}:{}),label:'DSH 原版迁移前的开发提示词'});
    promptStore.publishPrompt({scope:'runtime',name:'dev',...(old.characterId?{characterId:old.characterId}:{}),content:'',label:old.label,metadata:{...old.metadata,developerSource:'dsh-original'},expectedRevision:old.revision,expectedVersion:old.version});
  }
  if(!read('meta','default-prompt-seed')){put('meta','default-prompt-seed',{source:fixedConfig.source,seededAt:clock(),userOverridesPreserved:true});put('meta','prompt-config',{...read('meta','prompt-config'),source:fixedConfig.source});}
  if(!list('conversation').length)put('conversation','welcome',{id:'welcome',title:'New conversation',kind:'direct',participantIds:['default-character'],channel:'desktop',scheduler:{enabled:true},createdAt:clock()});
  if(seed&&!read('meta','test-seed')){
    transaction(()=>{
      db.prepare("DELETE FROM entities WHERE kind IN ('character','conversation','memory','context')").run();db.prepare('DELETE FROM messages').run();
      put('character',seed.character.id,seed.character);put('conversation',seed.conversation.id,{...seed.conversation,channel:'desktop',kind:'direct',participantIds:[seed.character.id],scheduler:{enabled:false}});
      for(const memory of seed.memories??[])put('memory',memory.id,memory);
      for(const message of seed.messages??[])db.prepare('INSERT INTO messages(id,conversation_id,sequence,payload) VALUES(?,?,?,?)').run(message.id,seed.conversation.id,message.sequence,JSON.stringify({...message,conversationId:seed.conversation.id}));
      put('meta','test-seed',{createdAt:clock()});
    });
  }
  // Bind one active desktop private session without merging or deleting history.
  transaction(()=>{
    const migration=read('meta','conversation-lifecycle-v1');
    const defaultPins=new Set(migration?.defaultPinCharacterIds??list('character').slice(0,3).map(person=>person.id));
    const conversations=list('conversation');
    for(const person of list('character')){
      const binding=read('desktop-direct-session',person.id);
      const selected=selectDesktopDirect(conversations,person.id,{preferredId:binding?.conversationId});
      if(selected&&binding?.conversationId!==selected.id)put('desktop-direct-session',person.id,{conversationId:selected.id});
      if(!migration&&selected&&defaultPins.has(person.id)&&typeof selected.pinned!=='boolean')put('conversation',selected.id,{...selected,pinned:true,pinnedAt:clock()});
    }
    if(!migration)put('meta','conversation-lifecycle-v1',{defaultPinCharacterIds:[...defaultPins]});
  });
  function activeDesktopDirect(characterId){const binding=read('desktop-direct-session',characterId),preferred=binding?.conversationId?read('conversation',binding.conversationId):null;if(isDesktopDirect(preferred)&&preferred.participantIds[0]===characterId)return preferred;return selectDesktopDirect(list('conversation'),characterId);}
  function conversationIsActive(conv){return !isDesktopDirect(conv)||activeDesktopDirect(conv.participantIds[0])?.id===conv.id;}
  function requireActiveConversation(conv){if(!conversationIsActive(conv))fail('CONVERSATION_INACTIVE','这是历史私聊，请进入当前活跃私聊发送消息');}
  // A consistent SQLite backup precedes the first projection or a changed import.
  // Raw imported records remain intact, and native corrections win on re-import.
  const legacyProfileRecords=list('sunabot-user-profile').filter(record=>hasCharacter(record.characterId));
  if(legacyProfileRecords.length){
    const digest=createHash('sha256').update(JSON.stringify(legacyProfileRecords)).digest('hex');
    if(read('meta','person-profiles-legacy-v1')?.sourceDigest!==digest){
      const backupDirectory=path.join(dataDir,'backups');mkdirSync(backupDirectory,{recursive:true,mode:0o700});
      const backupPath=path.join(backupDirectory,`before-person-profiles-${randomUUID()}.sqlite`);
      try{
        db.prepare('VACUUM INTO ?').run(backupPath);chmodSync(backupPath,0o600);
        const report=transaction(()=>{const value=rawPersonProfiles.migrateLegacy(legacyProfileRecords);put('meta','person-profiles-legacy-v1',{sourceDigest:digest,backupPath,report:value});return value;});
        log('person_profiles.migrated',{sourceRecords:report.sourceRecords,created:report.created,merged:report.merged,unresolved:report.unresolved});
      }catch(error){db.close();throw error;}
    }
  }
  for(const conv of list('conversation')){
    const prior=!!db.prepare('SELECT 1 FROM messages WHERE conversation_id=? LIMIT 1').get(conv.id)||!!db.prepare('SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1').get(conv.id)||list('worker-task').some(task=>task.args?.conversationId===conv.id);
    observability.setHistoryBoundary({conversationId:conv.id,hadPriorActivity:prior});
  }
  for(const row of db.prepare("SELECT payload FROM runs WHERE status IN ('running','queued')").all()){const run=JSON.parse(row.payload);run.status='interrupted';run.error='上次退出中断了运行，可以重新发送消息';run.finishedAt=clock();db.prepare('UPDATE runs SET status=?,payload=? WHERE id=?').run(run.status,JSON.stringify(run),run.id);}

  const groupDispatch=createGroupDispatchStore({db,clock});
  // An interrupted moderator never repeats paid decisions or role sends on restart.
  for(const round of list('desktop-group-round'))if(['deciding','running','ready'].includes(round.status))put('desktop-group-round',round.id,{...round,status:'interrupted',finishedAt:clock()});
  // Backfill all old batch members, including interrupted runs, once. No replay.
  if(!read('meta','group-dispatch-v1'))transaction(()=>{
    for(const row of db.prepare('SELECT payload FROM runs').all()){
      const run=JSON.parse(row.payload),sources=run.triggerIds??[run.triggerId];
      for(const sourceId of sources)groupDispatch.admit({conversationId:run.conversationId,characterId:run.characterId,sourceId,route:run.route,automatic:run.automatic===true});
      groupDispatch.claim({conversationId:run.conversationId,characterId:run.characterId,sourceIds:sources,runId:run.id,route:run.route});
      groupDispatch.transition(run.id,['completed','silent','failed','cancelled','interrupted','skipped'].includes(run.status)?run.status:'interrupted');
    }
    put('meta','group-dispatch-v1',{createdAt:clock()});
  });
  groupDispatch.recover();
  const directInputs=createDirectInputQueue({list:()=>list('direct-input'),get:key=>read('direct-input',key),save:(key,value)=>{const saved=put('direct-input',key,value);emit('activity.changed',{conversationId:value.conversationId});return saved;},clock,isOpen:()=>!closed&&!closing,
    hasStarted:runId=>controllers.has(runId)||db.prepare('SELECT status FROM runs WHERE id=?').get(runId)?.status!=='queued',
    active:conversationId=>{const active=[...controllers.values()].find(item=>item.conversationId===conversationId&&!item.controller.signal.aborted);return active?{runId:active.runId,ready:active.directInputReady===true,signal:active.controller.signal}:null;},
    busy:conversationId=>!!db.prepare("SELECT id FROM runs WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1").get(conversationId)||[...quarantines.keys()].some(key=>key.endsWith(`:${conversationId}`)),
    start:item=>{const conv=conversation(item.conversationId);requireActiveConversation(conv);const row=db.prepare('SELECT payload FROM messages WHERE id=? AND conversation_id=?').get(item.messageId,conv.id);if(!row)fail('MESSAGE_NOT_FOUND','入队消息已不存在');const task=scheduleRun(item.characterId,JSON.parse(row.payload),'direct');const run=db.prepare('SELECT id FROM runs WHERE conversation_id=? AND trigger_id=?').get(conv.id,item.messageId);if(!run)fail('DIRECT_INPUT_FAILED','消息未能进入运行队列');return {runId:run.id,completion:task};},
    deliver:async(item,running)=>{if(typeof runtime?.deliverUserInput!=='function')throw Object.assign(new Error('主用户插入接口不可用'),{code:'DIRECT_STEER_UNAVAILABLE',definite:true});const conv=conversation(item.conversationId);requireActiveConversation(conv);const row=db.prepare('SELECT payload FROM messages WHERE id=? AND conversation_id=?').get(item.messageId,conv.id);if(!row)throw Object.assign(new Error('消息不存在'),{code:'MESSAGE_NOT_FOUND',definite:true});const message=JSON.parse(row.payload);return runtime.deliverUserInput({contextId:context(item.characterId,conv.id).contextId,coreRunId:running.runId,deliveryId:item.id,content:directSteerContent(item.characterId,conv,message),reviewInstruction:runtimeReviewInstructionFor({character:character(item.characterId),conversation:conv,trigger:message,testMode}),signal:running.signal});},
    onError:error=>{if(!closed)log('direct-input.failed',{code:error.code??'DIRECT_INPUT_FAILED'},'error');}
  });
  directInputs.recover();
  function directSteerContent(characterId,conv,message){return '[主用户] 补充消息\n'+JSON.stringify({message_id:message.id,sender:injectedSender(characterId,message,conv.id),text:message.text,...(message.replyToMessageId?{reply_to:quotedMessageContext(characterId,conv,message)}:{})});}

  const groupDecisions=new Map();
  const channelDirectWaiters=new Map();
  const groupScheduler=createGroupScheduler({
    getPolicy:(_characterId,conversationId)=>{if(closed||closing)return null;const conv=conversation(conversationId);return conv.channel==='desktop'&&replyAllowed(conv,true,'ambient')?resolveGroupScheduler(groupGlobalPolicy(conv),conv.scheduler):null;},
    isBusy:(characterId,conversationId)=>groupDecisions.has(conversationId)||queues.has(`${characterId}:${conversationId}`)||quarantines.has(`${characterId}:${conversationId}`),
    onBatchDue:jobs=>decideAmbientBatch(jobs),
    onChange:payload=>emit('activity.changed',payload),
    onError:error=>log('scheduler.failed',{error:error.message},'error'),
  });
  const channelScheduler=createChannelGroupScheduler({
    ...channelSchedulerTimers,
    getPolicy:(characterId,conversationId)=>{if(closed||closing)return null;const conv=read('conversation',conversationId),person=read('character',characterId);if(!conv||!person||conv.channel==='desktop'||conv.kind!=='group'||!conv.participantIds.includes(characterId)||!characterReplyAllowed(conv,characterId,true))return null;return {...channelPolicy(conv),enabled:replyAllowed(conv,true,'ambient')};},
    isBusy:(characterId,conversationId)=>groupDecisions.has(conversationId)||queues.has(`${characterId}:${conversationId}`)||quarantines.has(`${characterId}:${conversationId}`),
    onDirectDue:async(job,{signal})=>{
      let run,error;
      try{if(!signal.aborted)run=await scheduleRun(job.characterId,{...job.trigger,replyAnchorId:job.replyAnchorId},'direct',job.triggerIds,undefined,job);}
      catch(value){error=value;throw value;}
      finally{
        if(run?.id)channelScheduler.retireDelivery?.({...job,runId:run.id});
        settleChannelWaiters(job,run,error);
      }
    },
    onDecisionDue:(jobs,{signal})=>decideAmbientBatch(jobs.map(job=>({...job,trigger:job.kind==='watch'?{...job.trigger,channelWatch:true}:job.trigger})),signal),
    onChange:state=>{if(closed||closing)return;put('channel-scheduler-state',JSON.stringify([state.characterId,state.conversationId]),{...state,updatedAt:clock()});emit('activity.changed',{conversationId:state.conversationId});},
    onError:error=>log('scheduler.failed',{code:error.code??'CHANNEL_SCHEDULER_FAILED'},'error'),
  });
  const schedulerFor=conv=>conv.channel==='desktop'?groupScheduler:channelScheduler;
  const waiterKey=(characterId,conversationId,sourceId)=>JSON.stringify([characterId,conversationId,sourceId]);
  function settleChannelWaiters(job,run,error){for(const sourceId of job.triggerIds??[]){const key=waiterKey(job.characterId,job.conversationId,sourceId),waiter=channelDirectWaiters.get(key);if(!waiter||waiter.runId&&!run&&!error)continue;channelDirectWaiters.delete(key);error?waiter.reject(error):waiter.resolve(run??null);}}
  function cancelChannelJobs(predicate){const removed=channelScheduler.cancel(predicate);for(const job of removed)settleChannelWaiters(job,null);return removed;}
  function offerChannelRole(trigger,characterId,{direct=false,observe=true,offeredAt=(channelSchedulerTimers.now??Date.now)()}={}){
    const conv=conversation(trigger.conversationId),state=channelScheduler.state({characterId,conversationId:conv.id});
    if(observe)channelScheduler.observe({characterId,conversationId:conv.id,offeredAt});
    const sameSender=value=>value.senderId===trigger.sender.id&&value.senderType===trigger.sender.type;
    const supplement=state?.pendingDirect.some(sameSender),watch=state?.watchers.some(value=>sameSender(value)&&value.remainingBatches>0);
    const scoped={...trigger,...(supplement?{channelDirectSupplement:true}:{}),...(watch?{channelWatch:true}:{})};
    if(!direct&&!supplement&&!watch&&!ambientTriggerAllowed(scoped))return null;
    const route=direct||supplement?'direct':'ambient';
    const key=waiterKey(characterId,conv.id,trigger.id),prior=channelDirectWaiters.get(key);
    if(prior)return prior.promise;
    const admission=admitRole(scoped,characterId,route);
    if(!admission.admitted){if(direct&&admission.entry?.run_id){const row=db.prepare('SELECT payload FROM runs WHERE id=?').get(admission.entry.run_id);return row?Promise.resolve(JSON.parse(row.payload)):null;}return null;}
    let waiter;
    if(direct){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});waiter={characterId,conversationId:conv.id,promise,resolve,reject};channelDirectWaiters.set(key,waiter);}
    if(!channelScheduler.offer({characterId,conversationId:conv.id,trigger:scoped,direct,offeredAt})){groupDispatch.cancel({conversationId:conv.id,characterId,sourceIds:[trigger.id],reason:'scheduler_not_admitted'});if(waiter){channelDirectWaiters.delete(key);waiter.resolve(null);}}
    return waiter?.promise??null;
  }
  function recordChannelSchedulerResult({characterId,conversationId,batchId,status,code,decision,inputUpperSequence,anchorMessageId}){
    if(closed||closing||conversation(conversationId).channel==='desktop')return;
    const key=JSON.stringify([batchId,characterId]),previous=read('channel-scheduler-result',key),summary=projectGroupDecision(decision??previous?.decision);
    put('channel-scheduler-result',key,{characterId,conversationId,batchId,status,...(code?{code}:{}),...(summary?{decision:redact(summary),inputUpperSequence:inputUpperSequence??previous?.inputUpperSequence,anchorMessageId:anchorMessageId??previous?.anchorMessageId}:{}),updatedAt:clock()});
    emit('activity.changed',{conversationId});
  }
  function schedulerThoughts(){
    const labels={'idle':'空闲','debouncing-direct':'等待触发者补充','watching':'监听触发者后续消息','debouncing-watch':'等待后续消息补充','waiting-ambient':'等待群聊消息','waiting-for-run':'等待当前运行结束','queued':'已排队','deciding':'判断是否参与','replying':'处理回复','closed':'已停止'};
    const results={'participating':'参与本轮群聊','not-participating':'本轮不参与','failed':'群聊调度失败','delivered':'回复已发送'};
    const live=new Map(channelScheduler.state().map(value=>[JSON.stringify([value.characterId,value.conversationId]),value]));
    const conversations=list('conversation'),conversationById=new Map(conversations.map(conv=>[conv.id,conv])),characters=new Set(list('character').map(person=>person.id)),targetByRole=new Map();
    for(const conv of [...conversations].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))))if(isDesktopDirect(conv)&&conversationIsActive(conv)&&!targetByRole.has(conv.participantIds[0]))targetByRole.set(conv.participantIds[0],conv);
    const recent=kind=>db.prepare('SELECT payload FROM entities WHERE kind=? ORDER BY rowid DESC LIMIT 100').all(kind).map(row=>JSON.parse(row.payload));
    return [...recent('channel-scheduler-state'),...recent('channel-scheduler-result')].filter(item=>characters.has(item.characterId)&&conversationById.has(item.conversationId)).map(item=>{
      const state=item.phase?live.get(JSON.stringify([item.characterId,item.conversationId])):undefined;
      const target=targetByRole.get(item.characterId);
      return {id:`scheduler:${item.id}`,characterId:item.characterId,targetConversationId:target?.id??null,sourceConversationId:item.conversationId,sourceConversationName:channelConversationName(conversationById.get(item.conversationId)),kind:item.phase?'state':'result',phase:item.phase?(state?.phase??'closed'):undefined,status:item.status,text:item.phase?(labels[state?.phase??'closed']??'调度状态已更新'):(results[item.status]??'调度结束'),...(item.code?{code:item.code}:{}),...(projectGroupDecision(item.decision)?{decision:projectGroupDecision(item.decision)}:{}),updatedAt:item.updatedAt,...(state?{state}:{})};
    }).sort((a,b)=>String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(-100);
  }
  const workerEngine=createWorkerEngine({workerClient,toneClient,clock,onTelemetry:record=>recordUsageCall(record),getConfig:(name,characterId)=>{const entry=promptHead({characterId,scope:'worker',name});if(!entry)return null;return {...JSON.parse(entry.content),metadata:entry.metadata??{},revision:entry.revision};},getSnapshot:workerSnapshot,projectSender:(message,args)=>{const row=typeof message.id==='string'?db.prepare('SELECT payload FROM messages WHERE id=?').get(message.id):null;return injectedSender(args.characterId,row?JSON.parse(row.payload):message,args.conversationId);},recall:request=>memoryStore.recall(request),commit:commitWorker,saveTask:task=>{put('worker-task',task.id,task);emit('background.changed');},listTasks:()=>list('worker-task'),dispatchTTM,logger:(event,payload)=>log(event,payload)});
  const background=createBackgroundScheduler({clock,timeZone:settings().timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone,listTasks:()=>settings().background?.enabled===false?[]:list('cron'),saveTask:task=>{const current=read('cron',task.id);if(!current)return;const patch={};for(const key of ['next_run_at','last_skipped_at','skipped_due_at','last_run_at','last_event_id','last_dispatch_status','error'])if(task[key]!==undefined)patch[key]=task[key];put('cron',task.id,{...current,...patch});emit('background.changed');},dispatchTTM,logger:(event,payload)=>log(event,payload)});
  function workspaceFor(characterId){const directory=path.join(dataDir,'workspaces',characterId);mkdirSync(directory,{recursive:true,mode:0o700});return directory;}
  function mediaFor(characterId){if(!mediaStores.has(characterId))mediaStores.set(characterId,createWorkbenchMedia({workspace:workspaceFor(characterId),mediaDir:path.join(dataDir,'attachments'),...media}));return mediaStores.get(characterId);}
  function localDate(at,zone=settings().timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone){return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));}
  function workerSnapshot({characterId,conversationId,input,source,date,taskId,workerType,claimFacts}={}){
    return transaction(()=>{requireOpen();const person=character(characterId),conv=conversationId?conversation(conversationId):null;
    const history=conv?runMessages(conv.id,source?.triggerSequence?{sequence:source.triggerSequence}:undefined):[];
    let all=list('conversation').filter(c=>c.participantIds.includes(characterId)).flatMap(c=>localRoleRecords.contextMessages(messages(c.id,1000)));
    if(source?.triggerTime)all=all.filter(m=>m.createdAt<=source.triggerTime);
    const factHistory=list('conversation').filter(c=>c.participantIds.includes(characterId)).flatMap(c=>db.prepare("SELECT payload FROM messages WHERE conversation_id=? AND json_extract(payload,'$.source.type')='local-role-communication' ORDER BY sequence").all(c.id).map(row=>JSON.parse(row.payload)));
    const factScope={characterId,through:source?.triggerTime,localDate:at=>localDate(at)},dreamFacts=localRoleRecords.workerFacts(factHistory,{...factScope,consumer:'dream',...(claimFacts&&workerType==='dream_cycle'?{claimTaskId:taskId}:{})});
    const lastDream=read('meta',`last-dream:${characterId}`),targetDate=date??(input&&typeof input==='object'?input.date:undefined)??(workerType==='diary'?localDate(clock()):undefined);
    const diaries=list('diary').filter(item=>item.characterId===characterId&&(!targetDate||item.date<targetDate)).sort((a,b)=>a.date.localeCompare(b.date));
    const previousDiary=diaries.at(-1)?.date;
    const dreamHistory=lastDream?all.filter(m=>lastDream.cutoffs?m.sequence>(lastDream.cutoffs[m.conversationId]??0):m.createdAt>lastDream.at):all;
    const diaryHistory=all.filter(m=>(!targetDate||localDate(m.createdAt)<=targetDate)&&(!previousDiary||localDate(m.createdAt)>previousDiary));
    const projection=snapshotProjection({character:person,conversation:conv,history,projectSender:message=>injectedSender(characterId,message,conversationId),sourceMessages:targetDate?diaryHistory:dreamHistory,dreamHistory,diaryHistory,memories:list('memory').filter(m=>m.characterId===characterId),versions:{state:person.stateVersion??1,memory:person.memoryVersion??0,persona:person.personaVersion??person.version,longMemory:person.longMemoryVersion??0},recentDiaries:diaries.slice(-5).map(item=>({date:item.date,emotion:item.emotion,reasoning:item.reasoning,diary:item.diary})),input,at:clock(),emotionRecovery:person.emotionRecovery});
    projection.variables.recent_messages=withA2aRecentMessages(projection.variables.recent_messages,history,trustedA2aMarker,message=>snapshotProjection({history:[message],conversation:conv,projectSender:item=>injectedSender(characterId,item,conversationId)}).variables.recent_messages[0]);
    if(workerType==='diary')projection.diaryDate=targetDate;
    const diaryFacts=targetDate?localRoleRecords.workerFacts(factHistory,{...factScope,consumer:'diary',date:targetDate,...(claimFacts&&workerType==='diary_cycle'?{claimTaskId:taskId}:{})}):[];
    withA2aWorkerFacts(projection,{sourceFacts:targetDate?diaryFacts:dreamFacts,dreamFacts,diaryFacts});
    return {...projection,sourceBoundary:Object.fromEntries([...new Set(all.map(m=>m.conversationId))].map(id=>[id,Math.max(...all.filter(m=>m.conversationId===id).map(m=>m.sequence))]))};
    });
  }
  function addMemory(characterId,{content,impression_score,sourceMessageIds=[],sourceConversationId,fiction=false,source='agent'}={}){return transaction(()=>{const current=character(characterId),value=put('memory',id('memory'),{characterId,time:clock(),desc:required(content,'记忆',100000),...(impression_score!==undefined?{impression_score}:{}),sourceMessageIds,sourceConversationId,fiction,source,createdAt:clock()});put('character',characterId,{...current,memoryVersion:(current.memoryVersion??0)+1});return value;});}
  function commitWorker({taskId,name,result,base={},source={}}){requireOpen();return transaction(()=>{const existing=db.prepare('SELECT payload FROM worker_commits WHERE task_id=?').get(taskId);if(existing)return {...JSON.parse(existing.payload),duplicate:true};const person=character(source.characterId);let output=result;
    if(['emotion_update','env_update'].includes(name)){if(base.state!==undefined&&(person.stateVersion??1)!==base.state)fail('VERSION_CONFLICT','角色共享状态已变化，后台任务未覆盖新状态');const patch=name==='env_update'?{environment:result.description}:{emotion:{desc:result.description,pad:result.pad,timestamp:clock()}};updateCharacterState(person.id,patch,{expectedVersion:person.version,expectedStateVersion:person.stateVersion??1});}
    else if(name==='persona_dream'&&result!==null){if(base.persona!==undefined&&(person.personaVersion??person.version)!==base.persona)fail('VERSION_CONFLICT','角色人格已变化，旧任务未覆盖新人格');const projected=snapshotProjection({character:person}).persona.persona;const personality={immutable:projected.immutable,mutable:{trait:result.trait,habit:result.habit,dialogue:projected.mutable.dialogue}};put('character',person.id,{...person,personality,personaVersion:(person.personaVersion??person.version)+1});}
    else if(name==='memory_dream'){if(base.longMemory!==undefined&&(person.longMemoryVersion??0)!==base.longMemory)fail('VERSION_CONFLICT','长期记忆已变化，请重新整理');output=memoryStore.apply(person.id,result,{sourceMessages:source.sourceMessages});put('character',person.id,{...person,longMemoryVersion:(person.longMemoryVersion??0)+1});}
    else if(name==='work_memory_convolution'){if((person.workSummary??'')!==(source.frozenConvolution??''))fail('VERSION_CONFLICT','工作记忆摘要已更新，旧卷积未覆盖新摘要');const frozen=new Set(source.frozenEntryIds??[]);const entries=list('memory').filter(m=>m.characterId===person.id&&frozen.has(m.id));const remove=entries.slice(0,Math.max(0,entries.length-10));for(const entry of remove)db.prepare("DELETE FROM entities WHERE kind='memory' AND id=?").run(entry.id);put('character',person.id,{...person,workSummary:String(result),memoryVersion:(person.memoryVersion??0)+1});output={convolution:result,removedIds:remove.map(entry=>entry.id)};}
    else if(name==='dream'){output=put('dream',taskId,{characterId:person.id,content:String(result),fiction:true,createdAt:clock()});}
    else if(name==='dream_work_memory'){const entry={characterId:person.id,time:clock(),desc:`梦境（虚构）\n${result.content}`,fiction:true,source:'dream',sourceConversationId:source.conversationId,createdAt:clock()};output=put('memory',id('memory'),entry);put('character',person.id,{...person,memoryVersion:(person.memoryVersion??0)+1});put('meta',`last-dream:${person.id}`,{at:source.frozenAt??clock(),cutoffs:source.sourceBoundary});localRoleRecords.consumeFacts(person.id,source.a2aFactEvidence,'dream',{taskId,rootTaskId:source.a2aFactTaskId});}
    else if(name==='diary'){const date=source.date??clock().slice(0,10);output=put('diary',`${person.id}:${date}`,{characterId:person.id,date,emotion:result.emotion,reasoning:result.reasoning,diary:result.diary,createdAt:clock()});localRoleRecords.consumeFacts(person.id,source.a2aFactEvidence,'diary',{taskId,rootTaskId:source.a2aFactTaskId,date});}
    db.prepare('INSERT INTO worker_commits(task_id,name,payload) VALUES(?,?,?)').run(taskId,name,JSON.stringify({result:output}));log('write.worker',{taskId,name,characterId:person.id});emit('characters.changed');return {result:output};});}
  function workerArgs(characterId,conversationId,input,source={}){return {characterId,conversationId,input,source,workspace:workspaceFor(characterId),testMode};}
  async function runBackground(input={}){requireOpen();const person=character(input.characterId??'default-character'),conv=conversation(input.conversationId);if(!conv.participantIds.includes(person.id))fail('TARGET_DENIED','该角色不属于目标会话');const args={...workerArgs(person.id,conv.id,input.input??'',{type:'manual',internal:true}),...(input.dates?{dates:input.dates}:{}),...(input.date?{date:input.date}:{}),...(input.taskId?{taskId:input.taskId}:{})};const name=input.name??input.type;if(['group_scheduler','group_moderator'].includes(name))fail('GROUP_DECISION_CONTEXT_REQUIRED','群聊调度提示词仅用于真实群聊调度上下文');if(name==='tone')for(const key of ['provider','model','signal'])if(input[key]!==undefined)args[key]=input[key];return name==='tone'&&input.wait===true?workerEngine.run(name,args):workerEngine.enqueue(name,args);}
  function dreamConversation(person){
    return activeDesktopDirect(person.id)??createConversation({kind:'direct',channel:'desktop',participantIds:[person.id]});
  }
  async function enqueueCharacterDream(person,{taskId,source={type:'manual_dream',internal:true}}={}){
    await workerEngine.start();requireOpen();
    const explicit=taskId?read('worker-task',taskId):null;
    if(explicit&&(explicit.type!=='dream_cycle'||explicit.args?.characterId!==person.id))fail('TASK_ID_CONFLICT','任务标识已属于其他角色或流程');
    const existing=explicit??list('worker-task').find(task=>task.type==='dream_cycle'&&task.args?.characterId===person.id&&['queued','running'].includes(task.status));
    const conv=existing?conversation(existing.args.conversationId):dreamConversation(person);
    if(!conv.participantIds.includes(person.id))fail('TARGET_DENIED','梦境任务不属于当前角色的会话');
    const accepted=await workerEngine.enqueue('dream_cycle',{...workerArgs(person.id,conv.id,'',source),...(taskId?{taskId}:{})});
    const task=read('worker-task',accepted.task_id);
    if(!task||task.type!=='dream_cycle'||task.args?.characterId!==person.id)fail('TASK_ID_CONFLICT','梦境任务与当前角色不匹配');
    return {...accepted,characterId:person.id,conversationId:task.args.conversationId,type:'dream_cycle',taskStatus:task.status};
  }
  async function runCharacterDream(input={}){
    requireOpen();
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['characterId','taskId'].includes(key)))fail('INVALID_ARGUMENT','梦境请求只接受角色与任务标识');
    const person=character(required(input.characterId,'角色标识',200));
    if(input.taskId!==undefined&&(typeof input.taskId!=='string'||!input.taskId||input.taskId.length>200||/[\s\u0000-\u001f\u007f-\u009f]/u.test(input.taskId)))fail('INVALID_ARGUMENT','任务标识必须为1至200字符且不含空白或控制字符');
    return enqueueCharacterDream(person,{taskId:input.taskId});
  }
  function dispatchTTM({characterId,conversationId,content,source={},taskId}){requireOpen();revokePreviews({characterId,conversationId});const person=character(characterId),conv=conversation(conversationId);requireActiveConversation(conv);if(!conv.participantIds.includes(person.id))fail('TARGET_DENIED','任务角色不属于原会话');const key=`ttm_${createHash('sha256').update(String(taskId??id('ttm'))).digest('hex')}`;let trigger=read('trigger',key);if(!trigger){trigger=put('trigger',key,{id:key,kind:'ttm',conversationId:conv.id,text:String(content),automatic:source.automatic===true,sender:{type:'system',id:'internal-task',name:'系统任务'},source:{...source,internal:true},sequence:messages(conv.id,1).at(-1)?.sequence??0,createdAt:clock()});}const task=scheduleRun(person.id,trigger,'ttm');void task.catch(error=>log('ttm.failed',{taskId,error:error.message},'error'));return {status:'accepted',task_id:key};}
  function cronTool(person,conv,args={}){const bad=(code,message,field=null)=>({success:false,code,data:null,error:{message,field}});try{const mode=args.mode;if(!['add','fetch','update','delete'].includes(mode))return bad('INVALID_ARGUMENT','mode 无效','mode');const tasks=list('cron').filter(task=>task.characterId===person.id);if(mode==='fetch')return {success:true,code:'QUERIED',data:{tasks},error:null};const current=args.id?tasks.find(task=>task.id===args.id):null;if(mode!=='add'&&!current)return bad('NOT_FOUND','定时任务不存在','id');if(mode==='delete'){db.prepare("DELETE FROM entities WHERE kind='cron' AND id=?").run(current.id);return {success:true,code:'DELETED',data:{id:current.id},error:null};}if(mode==='update'&&!['content','cron','enable'].some(field=>args[field]!==undefined))return bad('INVALID_ARGUMENT','至少提供一个更新字段');const value={...current,id:current?.id??id('cron'),characterId:person.id,conversationId:current?.conversationId??conv.id,content:args.content!==undefined?required(args.content,'任务内容',20000):current?.content,cron:args.cron!==undefined?required(args.cron,'cron',256):current?.cron,enable:args.enable??current?.enable??true,timezone:current?.timezone??settings().timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone};if(typeof value.enable!=='boolean')return bad('INVALID_ARGUMENT','enable 必须是布尔值','enable');if(!value.content||!value.cron)return bad('INVALID_ARGUMENT','content 和 cron 必填');parseCron(value.cron);value.next_run_at=value.enable?nextRun(value.cron,{after:clock(),timeZone:value.timezone}):null;const saved=put('cron',value.id,value);emit('background.changed');return {success:true,code:mode==='add'?'CREATED':'UPDATED',data:{task:saved},error:null};}catch(error){return bad(error.code==='INVALID_CRON'?'INVALID_CRON':error.code??'INVALID_ARGUMENT',error.message);}}
  function listWorkerActivityTasks(characterId){
    // Sort and return only public summary fields: worker args/snapshots/results
    // can be very large and are still read in full by the execution engine.
    const paths=['$.id','$.type','$.args.characterId','$.args.conversationId','$.status','$.code','$.error','$.createdAt','$.finishedAt'];
    const literals=paths.map(value=>`'${value}'`).join(','),presence=paths.map(value=>`json_type(payload,'${value}') IS NOT NULL`).join(',');
    const rows=db.prepare(`SELECT json_extract(payload,${literals}) AS fields,json_array(${presence}) AS present,json_type(payload,'$.args') AS args_type FROM entities WHERE kind='worker-task' ORDER BY rowid`).all();
    return rows.flatMap(row=>{
      // The prior public projection accesses task.args.characterId even when
      // no filter is supplied. Preserve its malformed missing/null-args error.
      if(row.args_type===null||row.args_type==='null'){const args=row.args_type===null?undefined:null;return args.characterId;}
      const fields=JSON.parse(row.fields),present=JSON.parse(row.present),values=fields.map((value,index)=>present[index]?value:undefined);
      const [id,type,taskCharacterId,conversationId,status,code,error,createdAt,finishedAt]=values;
      if(characterId&&taskCharacterId!==characterId)return [];
      return [{id,type,characterId:taskCharacterId,conversationId,status,code,error:redact(error),createdAt,finishedAt}];
    });
  }
  function listActivities({characterId}={}){requireOpen();return {tasks:listWorkerActivityTasks(characterId),dreams:list('dream').filter(item=>!characterId||item.characterId===characterId),diaries:list('diary').filter(item=>!characterId||item.characterId===characterId),cron:list('cron').filter(item=>!characterId||item.characterId===characterId)};}
  function diaryCatchupDates(characterId,date){const latest=list('diary').filter(item=>item.characterId===characterId&&item.date<date).sort((a,b)=>b.date.localeCompare(a.date))[0]?.date;if(!latest)return [date];const first=Math.max(Date.parse(latest)+86400000,Date.parse(date)-4*86400000),result=[];for(let at=first;at<=Date.parse(date);at+=86400000){const day=new Date(at).toISOString().slice(0,10);if(!read('diary',`${characterId}:${day}`))result.push(day);}return result;}
  function tickBuiltins(){
    if(closing||closed||testMode)return Promise.resolve();
    if(builtinTick)return builtinTick;
    builtinTick=(async()=>{await localRoles.reconcile();
      const instant=new Date(clock()),at=instant.toISOString(),zone=settings().timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone;
      const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(instant).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
      const date=`${parts.year}-${parts.month}-${parts.day}`,minute=Number(parts.hour)*60+Number(parts.minute);
      for(const person of list('character')){
        if(closing||closed)break;
        const policy=effectiveBackground(person),conv=activeDesktopDirect(person.id);
        if(policy.diaryEnabled&&conv&&messages(conv.id,1).length){
          try{
            const key=`diary-schedule:${person.id}:${date}`;let scheduled=read('meta',key);
            if(!scheduled)scheduled=put('meta',key,{minute:21*60+Math.floor(Math.random()*60)});
            if(minute>=scheduled.minute&&!read('diary',`${person.id}:${date}`)&&!scheduled.queued){
              const accepted=await workerEngine.enqueue('diary_cycle',{...workerArgs(person.id,conv.id,''),dates:diaryCatchupDates(person.id,date),taskId:`diary:${person.id}:${date}`});
              put('meta',key,{...scheduled,queued:true,taskId:accepted.task_id});
            }
          }catch(error){if(!closing&&!closed)log('background.diary_failed',{characterId:person.id,code:error.code??'WORKER_ERROR'},'error');}
        }
        if(closing||closed)break;
        const key=`dream-schedule:${person.id}`;let schedule=read('meta',key);
        if(!policy.dreamEnabled){
          if(schedule&&(!schedule.disabled||schedule.next_run_at))put('meta',key,{...schedule,disabled:true,next_run_at:null});
          continue;
        }
        try{
          parseCron(policy.dreamCron);
          if(!schedule||schedule.cron!==policy.dreamCron||schedule.timeZone!==zone||schedule.disabled){
            // A first tick within the scheduled minute must not skip today's run.
            const after=new Date(Math.floor(instant.getTime()/60000)*60000-1).toISOString();
            schedule=put('meta',key,{cron:policy.dreamCron,timeZone:zone,disabled:false,next_run_at:nextRun(policy.dreamCron,{after,timeZone:zone})});
          }
          if(!schedule.next_run_at||Date.parse(schedule.next_run_at)>instant.getTime())continue;
          const due=schedule.next_run_at;
          schedule=put('meta',key,{...schedule,timeZone:zone,next_run_at:nextRun(policy.dreamCron,{after:at,timeZone:zone}),last_due_at:due,last_dispatch_status:'pending',error_code:null});
          const accepted=await enqueueCharacterDream(person,{taskId:`dream:${person.id}:${due}`,source:{type:'dream_schedule',internal:true,automatic:true,dueAt:due,timeZone:zone}});
          put('meta',key,{...schedule,last_task_id:accepted.task_id,last_dispatch_status:accepted.duplicate?'duplicate':'accepted',last_task_status:accepted.taskStatus,error_code:accepted.taskStatus==='failed'?(read('worker-task',accepted.task_id)?.code??'WORKER_ERROR'):null});
        }catch(error){
          if(!closing&&!closed){put('meta',key,{...schedule,cron:policy.dreamCron,timeZone:zone,error_code:error.code??'WORKER_ERROR',last_dispatch_status:'failed'});log('background.dream_failed',{characterId:person.id,code:error.code??'WORKER_ERROR'},'error');}
        }
      }
    })().finally(()=>{builtinTick=undefined;});
    return builtinTick;
  }
  function start(){requireOpen();if(!startTask)startTask=(async()=>{await localRoles.recover();await workerEngine.start();void localRoles.drain().catch(error=>log('local-role.recovery.failed',{code:error.code??'LOCAL_ROLE_FAILED'},'error'));if(closing)return {started:false};for(const task of list('outbox-task')){if(task.status==='accepted')launchSend(task);else if(task.status==='running')put('outbox-task',task.id,{...task,status:'failed',error_code:'INTERRUPTED',error:'上次发送中断，保留已发布消息，不自动重复不确定投递',finishedAt:clock()});}if(!testMode){await background.start();await tickBuiltins();if(closing)return {started:false};builtinTimer=(builtinTimers.setInterval??setInterval)(()=>{void tickBuiltins().catch(error=>log('background.failed',{error:error.message},'error'));},30000);builtinTimer.unref?.();}return {started:true};})();return startTask;}
  async function emojiSegment(characterId, emojiId) {
    if(!toolServices.characterLibrary)fail('LIBRARY_UNAVAILABLE','表情包库尚未连接');
    const resource=await toolServices.characterLibrary.resolveEmoji({characterId,id:emojiId});
    return {type:'image',emojiId,alt:resource.name||'表情包',...await mediaFor(characterId).persistBytes(resource.bytes)};
  }
  async function enqueueSend({person,conv,run,trigger,args,signal,systemError,completionKind}) {
    const content=args.content??args.text;
    if(content!==undefined&&typeof content!=='string')fail('INVALID_MESSAGE','send_message 需要 content 文本');
    if(content===undefined&&args.emojiId===undefined)fail('INVALID_MESSAGE','send_message 需要 content 或 emojiId');
    if(content!==undefined&&!systemError)parseMessageContent(content);
    const key=args.idempotencyKey??args.idempotency_key, fingerprint=createHash('sha256').update(JSON.stringify([content,args.emojiId])).digest('hex');
    return enqueue(`send:${run.id}:${key||id('once')}`,async()=>{
      const prior=key&&read('delivery',`${run.id}:${key}`);
      if(prior){if(prior.fingerprint&&prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','消息标识已用于另一条消息');return {...prior.receipt,duplicate:true};}
      const emoji=args.emojiId===undefined?null:await emojiSegment(person.id,args.emojiId);
      if(signal?.aborted||closing||!runAllowed(run))fail('RUN_CANCELLED','消息任务已取消');
      const replyToMessageId=conv.channel!=='desktop'&&conv.kind==='group'?channelReplyReference({character:character(person.id),conversation:conversation(conv.id),anchorId:run.replyAnchorId??trigger.replyAnchorId??trigger.id,replyLease:run.replyLease,findMessage:key=>{const row=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND id=?').get(conv.id,key);return row?JSON.parse(row.payload):null;}}):conv.channel==='desktop'?args.replyToMessageId??trigger.id:run.replyAnchorId??trigger.replyAnchorId??trigger.id;
      const {task,receipt}=transaction(()=>{const task=put('outbox-task',id('send'),{characterId:person.id,conversationId:conv.id,runId:run.id,groupRootId:run.groupRootId,...(run.channelBatchId?{channelBatchId:run.channelBatchId,channelBatchKind:run.channelBatchKind}:{}),...(run.replyLease!==undefined?{replyLease:run.replyLease}:{}),automatic:run.automatic,automaticEpoch:run.automaticEpoch,route:run.route,epoch:run.epoch,ambientEpoch:run.ambientEpoch,triggerId:trigger.id,triggerSequence:trigger.sequence,triggerTime:trigger.createdAt,content:content??'',...(completionKind?{completionKind}:{}),...(systemError?{systemError,skipTone:true,plainText:true}:{}),...(emoji?{emoji}:{}),replyToMessageId,mentionIds:args.mentionIds??[],status:'accepted',published_message_ids:[],createdAt:clock()});
      const receipt={status:'accepted',task_id:task.id,duplicate:false,version:task.version};
      if(key)put('delivery',`${run.id}:${key}`,{receipt,fingerprint});return {task,receipt};});launchSend(task,signal);log('message.accepted',{runId:run.id,taskId:task.id});return receipt;
    });
  }
  async function sendEmoji(input={}) {
    requireOpen();const conv=conversation(input.conversationId),person=character(input.characterId);requireActiveConversation(conv);
    if(!conv.participantIds.includes(person.id))fail('TARGET_DENIED','角色不属于当前会话');
    const requestId=required(input.requestId,'请求标识',200),emojiId=required(input.emojiId,'表情包标识',200),key=`manual-emoji:${conv.id}:${requestId}`;
    return enqueue(key,async()=>{
      const fingerprint=createHash('sha256').update(JSON.stringify([person.id,emojiId])).digest('hex'),prior=read('delivery',key);
      if(prior){if(prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','消息标识已用于另一条消息');if(prior.historyCleared)return {status:'cancelled',historyCleared:true,duplicate:true};return {...getSendTask(prior.taskId),duplicate:true};}
      const emoji=await emojiSegment(person.id,emojiId);requireOpen();
      const task=transaction(()=>{const task=put('outbox-task',id('send'),{characterId:person.id,conversationId:conv.id,runId:`manual:${requestId}`,manual:true,skipTone:true,triggerId:null,triggerSequence:messages(conv.id,1).at(-1)?.sequence??0,triggerTime:clock(),content:'',emoji,replyToMessageId:null,mentionIds:[],status:'accepted',published_message_ids:[],createdAt:clock()});
      put('delivery',key,{fingerprint,taskId:task.id});return task;});await launchSend(task);
      const receipt=getSendTask(task.id);
      if(conv.channel==='desktop'&&receipt.status==='completed'){
        const message=messages(conv.id,1000).find(m=>m.id===receipt.published_message_ids[0]);
        if(message)void dispatch(message).catch(error=>log('manual.dispatch.failed',{code:error.code??'DISPATCH_FAILED'},'error'));
      }
      return receipt;
    });
  }
  function replyReference(conv,messageId,{maxSequence=messages(conv.id,1).at(-1)?.sequence??0,external=conv.channel!=='desktop'}={}){
    return resolveMessageReply({conversationId:conv.id,messageId,maxSequence,requireExternalId:external,findMessage:key=>{
      const row=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND id=?').get(conv.id,key);return row?JSON.parse(row.payload):null;
    }});
  }
  function resolveReplyMessage({conversationId,messageId}={}){
    requireOpen();const conv=conversation(conversationId),reference=replyReference(conv,messageId);return reference?clone(reference.message):null;
  }
  function composerAttachmentIds(value){
    if(value===undefined)return [];
    if(!Array.isArray(value)||value.length>16||value.some(key=>typeof key!=='string'||!key||key.trim()!==key||/[\x00-\x1f]/.test(key)||key.length>200)||new Set(value).size!==value.length)fail('INVALID_MESSAGE_ATTACHMENTS','附件标识无效');
    return [...value];
  }
  function composerText(input,attachmentIds,{literal=false}={}){
    const value=input.text??'';
    if(typeof value!=='string'||value.length>50000||(!value.trim()&&!attachmentIds.length))fail('INVALID_INPUT','消息不能为空且不能超过50000字');
    return literal?value:value.trim();
  }
  async function resolveComposerAttachments(conv,attachmentIds,signal){
    if(!attachmentIds.length)return {attachments:[],blocks:[]};
    if(typeof composerAttachments?.resolve!=='function')fail('MESSAGE_ATTACHMENTS_UNAVAILABLE','当前服务尚未开放会话附件');
    const result=await composerAttachments.resolve({conversationId:conv.id,attachmentIds,signal});
    requireOpen();requireActiveConversation(conversation(conv.id));signal?.throwIfAborted();
    return result;
  }
  function composerAttachmentPermission({conversationId,characterId}={}){
    requireOpen();const person=character(characterId),conv=conversation(conversationId),state=permissionState(),head=promptHead({characterId,scope:'tool',name:'suna_read_attachment'});
    const enabled=head?.metadata?.enabled!==false&&!!composerAttachments?.controlled;
    const policy=resolveToolPolicy({records:state.records,characterId,tool:'suna_read_attachment',conversation:{...conv,channel:'desktop'}});
    const allowed=conversationIsActive(conv)&&conv.participantIds.includes(person.id)&&enabled&&policy.local==='allow';
    return {allowed,permissionFingerprint:createHash('sha256').update(JSON.stringify([state.version,person.version,conv.version,head?.revision??null,enabled,allowed])).digest('hex')};
  }
  function composerCapturePermission({conversationId,characterId}={}){
    requireOpen();const person=character(characterId),conv=conversation(conversationId),state=permissionState(),head=promptHead({characterId,scope:'tool',name:'screenshot'});
    const enabled=head?.metadata?.enabled!==false&&!!toolServices.screenAccess;
    const role=resolveToolPolicy({records:state.records.filter(record=>record.scope==='role'),characterId,tool:'screenshot',conversation:conv});
    const explicitDeny=state.records.some(record=>record.characterId===characterId&&record.tool==='screenshot'&&record.scope==='conversation'&&record.conversationId===conversationId&&Object.values(record.policy??{}).includes('deny'));
    const legacyDeny=state.legacyScreenDenials.some(pair=>pair.characterId===characterId&&pair.conversationId===conversationId);
    const allowed=conversationIsActive(conv)&&conv.participantIds.includes(person.id)&&enabled&&role.local==='allow'&&!explicitDeny&&!legacyDeny;
    const permissionFingerprint=createHash('sha256').update(JSON.stringify([state.version,person.version,conv.version,head?.revision??null,enabled,allowed])).digest('hex');
    return {allowed,permissionRevision:state.version,permissionFingerprint,...(!allowed?{reason:'当前角色、会话或截图权限不允许采集'}:{})};
  }
  function desktopSendReceipt(conv,requestId,messageId){
    const row=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND id=?').get(conv.id,messageId),message=row?JSON.parse(row.payload):null;
    const directInput=read('direct-input',directInputId(conv.id,requestId)),delivery=read('delivery',`manual-desktop:${conv.id}:${requestId}`),runs=message?db.prepare('SELECT payload FROM runs WHERE conversation_id=? AND trigger_id=?').all(conv.id,message.id).map(row=>JSON.parse(row.payload)):[];
    return {...(directInput?{directInput}:{}),conversationId:conv.id,requestId,acceptance:message?'persisted':'not-persisted',status:message?'completed':'cancelled',messageIds:message?[message.id]:[],messages:message?[message]:[],...(message?{message}:{historyCleared:true}),runs,...(delivery?.dispatchError?{dispatchError:delivery.dispatchError}:{})};
  }
  function channelSendReceipt(conv,requestId,taskId){
    const task=getSendTask(taskId),sent=task.published_message_ids.map(messageId=>{const row=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND id=?').get(conv.id,messageId);return row?JSON.parse(row.payload):null;}).filter(Boolean);
    return {...task,conversationId:conv.id,requestId,acceptance:sent.length?'persisted':'not-persisted',messageIds:sent.map(message=>message.id),messages:sent,...(sent[0]?{message:sent[0]}:{}),runs:[]};
  }
  function getSendReceipt({conversationId,requestId}={}){
    requireOpen();const conv=conversation(conversationId);requestId=required(requestId,'请求标识',200);
    if(conv.channel==='desktop'){
      const prior=db.prepare('SELECT message_id FROM incoming WHERE dedupe_key=?').get(`desktop:${conv.id}:${requestId}`);
      return prior?desktopSendReceipt(conv,requestId,prior.message_id):null;
    }
    const prior=read('delivery',`manual-text:${conv.id}:${requestId}`);
    if(!prior)return null;
    if(prior.historyCleared)return {conversationId:conv.id,requestId,acceptance:'not-persisted',status:'cancelled',historyCleared:true,messageIds:[],messages:[],runs:[]};
    return channelSendReceipt(conv,requestId,prior.taskId);
  }
  async function sendChannelText(input,conv){
    // Composer text is literal user-authored text, never the Agent XML protocol.
    const attachmentIds=composerAttachmentIds(input.attachmentIds),text=composerText(input,attachmentIds,{literal:true});
    const requestId=required(input.requestId??id('request'),'请求标识',200),key=`manual-text:${conv.id}:${requestId}`;
    return enqueue(key,async()=>{
      const prior=read('delivery',key),target=conv.channelTarget;
      const matches=person=>person.accounts?.some(account=>account.channel===conv.channel&&account.platform===target?.platform&&account.accountId===target?.accountId);
      const candidates=conv.participantIds.map(character).filter(matches);
      const characterId=input.characterId??prior?.characterId??(candidates.length===1?candidates[0].id:null);
      if(!characterId)fail(candidates.length>1?'CHARACTER_REQUIRED':'CHANNEL_ROUTE_UNAVAILABLE',candidates.length>1?'请选择发送角色':'当前会话没有绑定的发送角色');
      const person=character(characterId);
      if(!conv.participantIds.includes(person.id))fail('TARGET_DENIED','角色不属于当前会话');
      const replyToMessageId=normalizeReplyMessageId(input.replyToMessageId),mentionIds=(input.mentionIds??[]).filter(key=>conv.participantIds.includes(key));
      const fingerprint=createHash('sha256').update(JSON.stringify([person.id,Object.fromEntries(Object.entries(target??{}).sort(([a],[b])=>a.localeCompare(b))),text,replyToMessageId,attachmentIds,[...new Set(mentionIds)].sort()])).digest('hex');
      const legacyFingerprint=createHash('sha256').update(JSON.stringify([person.id,target,text,replyToMessageId,mentionIds])).digest('hex');
      if(prior){
        if(prior.fingerprint!==fingerprint&&!(prior.inputFingerprintVersion===undefined&&!attachmentIds.length&&prior.fingerprint===legacyFingerprint))fail('IDEMPOTENCY_CONFLICT','消息标识已用于另一条消息');
        if(prior.historyCleared)return {conversationId:conv.id,requestId,acceptance:'not-persisted',status:'cancelled',historyCleared:true,duplicate:true,messageIds:[],messages:[],runs:[]};
        return {...channelSendReceipt(conv,requestId,prior.taskId),duplicate:true};
      }
      if(!target?.accountId||!matches(person))fail('CHANNEL_ROUTE_UNAVAILABLE','这个角色未绑定当前会话的平台账号');
      const reply=replyReference(conv,replyToMessageId);
      const resolved=await resolveComposerAttachments(conv,attachmentIds,input.signal),composerBlocks=[...(text?[{type:'text',text}]:[]),...resolved.blocks];
      if(attachmentIds.length){if(typeof channels?.preflight!=='function')fail('CHANNEL_PREFLIGHT_UNAVAILABLE','渠道尚不支持附件发送预检');await channels.preflight({conversation:conv,character:person,blocks:composerBlocks,replyToMessageId,strictAccount:true,signal:input.signal});}
      requireOpen();requireActiveConversation(conversation(conv.id));replyReference(conv,replyToMessageId);
      if(!conversation(conv.id).participantIds.includes(person.id))fail('TARGET_DENIED','角色已离开当前会话');
      const task=transaction(()=>{
        const task=put('outbox-task',id('send'),{characterId:person.id,conversationId:conv.id,runId:`manual:${requestId}`,requestId,...(attachmentIds.length?{composerBlocks,attachments:resolved.attachments}:{}),manual:true,plainText:true,skipTone:true,triggerId:null,triggerSequence:messages(conv.id,1).at(-1)?.sequence??0,triggerTime:clock(),content:text,replyToMessageId,...(reply?{replyPreview:reply.preview}:{}),mentionIds,status:'accepted',published_message_ids:[],createdAt:clock()});
        put('delivery',key,{fingerprint,inputFingerprintVersion:2,taskId:task.id,characterId:person.id});return task;
      });
      await launchSend(task,input.signal);return channelSendReceipt(conv,requestId,task.id);
    });
  }
  function pluginBinding(input){
    requireOpen();if(testMode)fail('TEST_EXTERNAL_DELIVERY_DENIED','测试会话不能运行外部插件');
    if(!/^suna-[a-z0-9-]{1,58}$/.test(input.pluginId??''))fail('PLUGIN_ID_INVALID','插件标识无效');
    const person=character(input.characterId),conv=conversation(input.conversationId);requireActiveConversation(conv);
    if(!conv.participantIds.includes(person.id))fail('TARGET_DENIED','角色不属于指定会话');
    const content=required(input.content,'插件消息',50000),deliveryId=required(input.deliveryId,'消息标识',200);
    if(input.signal?.aborted)fail('PLUGIN_STOPPED','插件已停止');
    const key=createHash('sha256').update(JSON.stringify([input.pluginId,deliveryId])).digest('hex');
    return {person,conv,content,deliveryId,key};
  }
  function recordPluginTTMEvent(event){
    if(!['ttm-accepted','ttm-admitted','ttm-unconsumed'].includes(event?.type)||typeof event.source?.pluginId!=='string'||typeof event.deliveryId!=='string')return;
    const key=createHash('sha256').update(JSON.stringify([event.source.pluginId,event.deliveryId])).digest('hex'),prior=read('plugin-delivery',key);if(!prior)return;
    const outcome=event.type==='ttm-admitted'?'admitted':event.type==='ttm-unconsumed'?'unconsumed':'accepted';
    if(prior.receipt.outcome==='admitted'&&outcome==='accepted')return;
    put('plugin-delivery',key,{...prior,receipt:{...prior.receipt,status:outcome==='unconsumed'?'cancelled':'accepted',outcome,outcomeAt:clock()}});
  }
  async function sendPluginTTM(input){
    const {person,conv,content,deliveryId,key}=pluginBinding(input);
    if(!['steer','queue'].includes(input.mode))fail('PLUGIN_MODE_INVALID','请选择 steer 或 queue');
    return enqueue(`plugin:${key}`,async()=>{
      const fingerprint=createHash('sha256').update(JSON.stringify(['ttm',person.id,conv.id,content,input.mode])).digest('hex'),prior=read('plugin-delivery',key);
      if(prior){if(prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','消息标识已用于另一条消息');return {...prior.receipt,duplicate:true};}
      if(input.signal?.aborted||closing)fail('PLUGIN_STOPPED','插件已停止');
      const pending={status:'unknown',deliveryId,requestedMode:input.mode,reason:'投递中断时不自动重发'};
      put('plugin-delivery',key,{fingerprint,receipt:pending});
      // Reserve before crossing the runtime boundary: a lost acknowledgement must
      // never cause the same plugin delivery to steer the Agent twice.
      revokePreviews({characterId:person.id,conversationId:conv.id});
      if(input.mode==='steer'&&typeof runtime?.deliverTTM==='function'){
        try{for(const active of controllers.values())if(active.characterId===person.id&&active.conversationId===conv.id)active.restrictAuthority?.();const result=await runtime.deliverTTM({contextId:context(person.id,conv.id).contextId,mode:'steer',content,deliveryId,source:{pluginId:input.pluginId},signal:input.signal});
          if(result?.accepted){const latest=read('plugin-delivery',key)?.receipt,receipt={status:latest?.outcome==='unconsumed'?'cancelled':'accepted',deliveryId,requestedMode:'steer',appliedMode:'steer',runId:result.runId,...(latest?.outcome?{outcome:latest.outcome,outcomeAt:latest.outcomeAt}:{outcome:'accepted'})};put('plugin-delivery',key,{fingerprint,receipt});return receipt;}
        }catch(error){throw error;}
      }
      if(input.signal?.aborted||closing)fail('PLUGIN_STOPPED','插件已停止');
      const queued=dispatchTTM({characterId:person.id,conversationId:conv.id,content,taskId:`plugin:${key}`,source:{pluginId:input.pluginId,deliveryId,mode:'queue'}});
      const receipt={...queued,deliveryId,requestedMode:input.mode,appliedMode:'queue'};put('plugin-delivery',key,{fingerprint,receipt});return receipt;
    });
  }
  function pluginChannelReceipt(taskId,deliveryId){const task=read('outbox-task',taskId);return {...getSendTask(taskId),deliveryId,messages:task.published_message_ids.map(messageId=>{const row=db.prepare('SELECT payload FROM messages WHERE id=?').get(messageId),message=row?JSON.parse(row.payload):null;return {id:messageId,status:message?.status,externalId:message?.externalId};})};}
  async function sendPluginChannel(input){
    const {person,conv,content,deliveryId,key}=pluginBinding(input);
    if(conv.channel==='desktop'||!conv.channelTarget?.accountId)fail('CHANNEL_ROUTE_UNAVAILABLE','请选择已绑定账号的渠道会话');
    // Direct sends preserve content; they do not invoke tone workers or an Agent.
    parseMessageContent(content);
    return enqueue(`plugin:${key}`,async()=>{
      const fingerprint=createHash('sha256').update(JSON.stringify(['channel',person.id,conv.id,conv.channelTarget,content])).digest('hex'),prior=read('plugin-delivery',key);
      if(prior){if(prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','消息标识已用于另一条消息');if(prior.historyCleared)return {status:'cancelled',historyCleared:true,deliveryId,duplicate:true};return {...(prior.receipt.task_id?pluginChannelReceipt(prior.receipt.task_id,deliveryId):prior.receipt),duplicate:true};}
      if(input.signal?.aborted||closing)fail('PLUGIN_STOPPED','插件已停止');
      const task=transaction(()=>{const task=put('outbox-task',id('send'),{characterId:person.id,conversationId:conv.id,runId:`plugin:${key}`,pluginId:input.pluginId,skipTone:true,triggerId:null,triggerSequence:messages(conv.id,1).at(-1)?.sequence??0,triggerTime:clock(),content,replyToMessageId:null,mentionIds:[],status:'accepted',published_message_ids:[],createdAt:clock()});
      put('plugin-delivery',key,{fingerprint,receipt:{status:'accepted',task_id:task.id,deliveryId}});return task;});
      await launchSend(task,input.signal);const receipt=pluginChannelReceipt(task.id,deliveryId);
      put('plugin-delivery',key,{fingerprint,receipt});return receipt;
    });
  }
  function launchSend(task,externalSignal){if(sendTasks.has(task.id))return sendTasks.get(task.id).promise;const controller=new AbortController(),abort=()=>controller.abort(externalSignal?.reason);externalSignal?.addEventListener('abort',abort,{once:true});if(externalSignal?.aborted||closing)controller.abort();const promise=(async()=>{let current=task;const ensure=()=>{requireActiveConversation(conversation(task.conversationId));if(controller.signal.aborted||closing||closed||(task.systemError&&(!conversation(task.conversationId).participantIds.includes(task.characterId)||!runAllowed(task)))||(task.automatic&&!runAllowed(task))||(task.route==='ambient'&&!runAllowed(task)))fail('RUN_CANCELLED','消息任务已取消');};try{ensure();current=put('outbox-task',task.id,{...current,status:'running'});const person=character(task.characterId),conv=conversation(task.conversationId);let parsed=task.plainText?{segments:[{type:'dialog',text:task.content}],hasImages:false}:task.content?parseMessageContent(task.content):{segments:[],hasImages:!!task.emoji};if(task.emoji)parsed.hasImages=true;if(!task.skipTone&&!parsed.hasImages&&settings().toneEnabled!==false&&person.toneEnabled!==false&&promptHead({characterId:person.id,scope:'worker',name:'tone'})?.metadata?.enabled!==false){const xml=parsed.segments.map(segment=>`<dialog>${String(segment.text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</dialog>`).join('');const tone=await workerEngine.run('tone',{...workerArgs(person.id,conv.id,xml,{automatic:task.automatic,runId:task.runId,triggerId:task.triggerId,triggerSequence:task.triggerSequence,triggerTime:task.triggerTime}),taskId:`tone:${task.id}`,signal:controller.signal});ensure();if(tone.status==='completed')parsed=parseMessageContent(tone.result);if(tone.status!=='completed'||tone.fallback)current=put('outbox-task',task.id,{...current,toneWarning:{code:tone.code??tone.warning?.code??'TONE_FAILED',message:redact(tone.error??tone.warning?.message??'已保留原文')}});}
      const segments=task.composerBlocks?[{type:'composer',text:task.content,blocks:task.composerBlocks}]:await mediaFor(person.id).persistSegments(parsed.segments);if(task.emoji)segments.push(task.emoji);ensure();for(const segment of segments){ensure();const blocks=segment.type==='composer'?segment.blocks:segment.type==='dialog'?[{type:'text',text:segment.text}]:[{type:'image',url:segment.url,alt:segment.alt,mime:segment.mime,sha256:segment.sha256,relativePath:segment.relativePath}];const replyToMessageId=conv.channel!=='desktop'&&!task.manual&&!task.pluginId&&task.replyToMessageId&&db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND json_extract(payload,'$.runId')=? AND json_extract(payload,'$.replyToMessageId') IS NOT NULL LIMIT 1").get(conv.id,task.runId)?null:task.replyToMessageId;let message=appendMessage({conversationId:conv.id,text:['dialog','composer'].includes(segment.type)?segment.text:segment.alt||'图片',blocks,...(task.attachments?{attachments:task.attachments}:{}),sender:task.manual&&conv.channel==='desktop'?{type:'human',id:'local-owner',name:'你',source:'desktop'}:{type:'character',id:person.id,name:person.name},role:task.manual&&conv.channel==='desktop'?'user':'assistant',...(task.groupRootId?{groupRootId:task.groupRootId}:{}),...(task.automatic?{automatic:true}:{}),...(task.manual?{source:{type:'manual',actorId:'local-owner'},...(conv.channel!=='desktop'?{dispatchEligible:false}:{})}:{}),...(task.pluginId?{source:{type:'plugin',pluginId:task.pluginId}}:{}),...(task.systemError?{source:{type:'system-error',code:task.systemError.code},dispatchEligible:false}:{}),runId:task.runId,taskId:task.id,...(task.requestId?{requestId:task.requestId}:{}),replyToMessageId,...(task.replyPreview?{replyPreview:task.replyPreview}:{}),mentionIds:task.mentionIds,status:conv.channel==='desktop'?'delivered':'sending'},task.requestId?{onPersisted:value=>{current=put('outbox-task',task.id,{...current,published_message_ids:[...current.published_message_ids,value.id]});}}:{});if(!task.requestId)current=put('outbox-task',task.id,{...current,published_message_ids:[...current.published_message_ids,message.id]});if(conv.channel!=='desktop'){const scope=`${conv.id}:${person.id}`;let settle;const pending=new Promise(resolve=>settle=resolve),receipts=pendingReceipts.get(scope)??new Set();receipts.add(pending);pendingReceipts.set(scope,receipts);let deliveryStarted=false;try{if(testMode)fail('TEST_EXTERNAL_DELIVERY_DENIED','测试会话不能向外部平台发送消息');if(!channels?.send)fail('CHANNEL_UNAVAILABLE','该渠道尚未连接');deliveryStarted=true;const result=await settleAfterAbort(channels.send({conversation:conv,character:person,message,signal:controller.signal,...(task.replyLease!==undefined?{replyLease:task.replyLease}:{}),automatic:task.automatic===true,strictAccount:!!task.pluginId||!!task.manual}),controller.signal);if(!task.manual)ensure();if(result?.deliveryUncertain||result?.status==='unknown')throw Object.assign(new Error(result.error??'渠道投递结果不确定'),{code:'DELIVERY_UNCERTAIN',deliveryUncertain:true});if(!result||result.ok===false||result.status==='failed')fail('DELIVERY_FAILED',result?.error??'渠道未返回成功回执');const accepted=result.status==='accepted';const externalId=result.messageId??result.message_id??result.data?.message_id;message=patchMessage(message,{status:accepted?'accepted':'delivered',receipt:result,...(externalId?{externalId:String(externalId)}:{})});if(externalId)db.prepare('INSERT OR IGNORE INTO incoming(dedupe_key,message_id) VALUES(?,?)').run(`${conv.channel}:${conv.channelTarget?.targetId??conv.id}:${externalId}`,message.id);}catch(error){if(task.manual&&deliveryStarted&&controller.signal.aborted&&error.code!=='DELIVERY_FAILED')error=Object.assign(new Error('渠道请求已发出，投递结果不确定'),{code:'DELIVERY_UNCERTAIN',deliveryUncertain:true});if(!closed)patchMessage(message,{status:error.deliveryUncertain||error.code==='DELIVERY_UNCERTAIN'?'unknown':'failed',...(error.deliveryUncertain||error.code==='DELIVERY_UNCERTAIN'?{deliveryUncertain:true}:{}),error:redact(error.message)});throw error;}finally{receipts.delete(pending);if(!receipts.size)pendingReceipts.delete(scope);settle();}}log('message.delivered',{runId:task.runId,messageId:message.id,channel:conv.channel,status:message.status});if(!task.systemError&&!task.pluginId&&!task.manual&&conv.kind==='group'&&!controller.signal.aborted)scheduleAmbient(message);}current=put('outbox-task',task.id,{...current,status:'completed',finishedAt:clock()});if(task.channelBatchKind==='direct'&&task.channelBatchId&&!task.systemError&&task.completionKind!=='progress'&&current.published_message_ids.length&&current.published_message_ids.every(messageId=>{const row=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND id=?').get(conv.id,messageId);return row&&JSON.parse(row.payload).status==='delivered';})){const delivered=channelScheduler.delivered({characterId:person.id,conversationId:conv.id,batchId:task.channelBatchId,runId:task.runId});if(delivered)recordChannelSchedulerResult({characterId:person.id,conversationId:conv.id,batchId:task.channelBatchId,status:'delivered'});}}
      catch(error){if(closed)return current;current=put('outbox-task',task.id,{...current,status:error.deliveryUncertain||error.code==='DELIVERY_UNCERTAIN'?'unknown':controller.signal.reason?.code==='DELIVERY_UNCERTAIN'?'failed':task.systemError?controller.signal.reason?.cancelReason==='USER_STOP'?'cancelled':'failed':controller.signal.aborted||closing?'cancelled':'failed',...(error.deliveryUncertain||error.code==='DELIVERY_UNCERTAIN'?{deliveryUncertain:true}:{}),error_code:task.systemError&&controller.signal.aborted?runFailureState(controller.signal.reason,controller.signal).code:error.code??'SEND_FAILED',error:redact(error.message),finishedAt:clock()});log('message.failed',{taskId:task.id,error:current.error},'error');}
      finally{externalSignal?.removeEventListener('abort',abort);emit('message.task.changed',{conversationId:task.conversationId});}return current;})();sendTasks.set(task.id,{runId:task.runId,conversationId:task.conversationId,route:task.route,automatic:task.automatic,promise,controller});void promise.finally(()=>sendTasks.delete(task.id)).catch(()=>{});return promise;}
  function getSendTask(taskId){requireOpen();const task=read('outbox-task',taskId);if(!task)fail('TASK_NOT_FOUND','消息任务不存在');return {conversation_id:task.conversationId,character_id:task.characterId,task_id:task.id,run_id:task.runId,version:task.version,status:task.status,published_message_ids:task.published_message_ids,error_code:task.error_code??null,error:task.error??null,toneWarning:task.toneWarning??null,...(task.deliveryUncertain?{deliveryUncertain:true}:{})};}
  function resolveMedia(relative){requireOpen();return mediaFor('default-character').resolveStored(relative);}
  function cleanChannelDetails(value={}){const result={};for(const key of ['peerName','groupName'])if(value[key]!==undefined){if(typeof value[key]!=='string'||value[key].length>256)fail('INVALID_CHANNEL_DETAILS','渠道展示名称必须为不超过256字符的文本');result[key]=value[key];}return result;}
  function setChannelDetails(key,details){requireOpen();const current=conversation(key);if(current.channel==='desktop')fail('INVALID_CHANNEL','应用会话没有平台来源');const next={...cleanChannelDetails(current.channelDetails),...cleanChannelDetails(details)};if(JSON.stringify(next)===JSON.stringify(current.channelDetails??{}))return current;const value=put('conversation',key,{...current,channelDetails:next});emit('conversations.changed');return value;}
  function markConversationRead(key,sequence){requireOpen();conversation(key);if(!Number.isSafeInteger(sequence)||sequence<0)fail('INVALID_SEQUENCE','消息序号无效');const latest=messages(key,1).at(-1)?.sequence??0,prior=read('conversation-read',key)?.sequence??0;const value=Math.max(prior,Math.min(sequence,latest));if(value>prior){put('conversation-read',key,{sequence:value});emit('conversations.changed');}return {sequence:value};}
  function unreadCount(key){return db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND sequence>? AND (json_extract(payload,'$.role')='assistant' OR json_extract(payload,'$.externalId') IS NOT NULL) AND json_extract(payload,'$.status') NOT IN ('failed','pending','sending','cancelled')").get(key,read('conversation-read',key)?.sequence??0).count;}
  function conversationView(value){const activeId=isDesktopDirect(value)?activeDesktopDirect(value.participantIds[0])?.id:undefined,active=!isDesktopDirect(value)||activeId===value.id;const lifecycle={active,showInMainList:channelConversationMainListVisible(value),pinned:active&&value.pinned===true,pinnedAt:active&&value.pinned===true?value.pinnedAt??null:null,...(!active?{inactiveReason:'duplicate-direct',activeConversationId:activeId}:{})};const last=messages(value.id,1).at(-1),target=value.channelTarget??{},details=cleanChannelDetails(value.channelDetails);const channel=value.channel==='desktop'?undefined:Object.fromEntries(Object.entries({platform:target.platform,accountId:target.accountId,accountLabel:target.accountId,...(target.kind==='private'?{peerId:target.externalTargetId,peerName:details.peerName}:{groupId:target.externalTargetId,groupName:details.groupName})}).filter(([,item])=>item!==undefined));return {...value,...lifecycle,...(value.kind==='group'?{schedulerEffective:value.channel!=='desktop'?channelPolicy(value):resolveGroupScheduler(groupGlobalPolicy(value),value.scheduler),...(value.channel!=='desktop'?{replyToTriggerEffective:Object.fromEntries(value.participantIds.map(key=>[key,replyToTriggerEnabled(read('character',key),value)]))}:{desktopGroupSchedulerEffective:resolveDesktopGroupScheduler(value.desktopGroupScheduler)})}:{}),title:channelConversationName({...value,display:{channel}}),unreadCount:unreadCount(value.id),lastSequence:last?.sequence??0,...(value.channelDetails?{channelDetails:details}:{}),display:{participantNames:value.participantIds.map(key=>read('character',key)?.name??key),...(channel?{channel}:{}),preview:String(last?.text??value.lastMessage??'').slice(0,160),lastMessageAt:last?.createdAt??value.lastMessageAt??null}};}

  const runtimePermissions=createRoleRuntimePermissions({read,put,character,assertOpen:requireOpen,getLegacyToolRecords:characterId=>(read('tool-permissions','global')?.records??[]).filter(row=>row.characterId===characterId),getMigrationRequired:characterId=>read('runtime-permission-migration',characterId)?.required===true,getCatalog:()=>runtime?.getRuntimePermissionCatalog?.()??{status:'unsupported',options:[],revision:null,defaultPreset:'auto'},onChanged:characterId=>invalidateRuntimePermission(characterId)});
  const permissionState=()=>read('tool-permissions','global')??{version:0,records:[],legacyScreenDenials:[]};
  // Client preview grants use their role's Client policy revision; Runtime
  // permission changes do not grant or revoke this separate Client capability.
  const previewPermissionRevisions=new Map();
  function previewPermissionRevision(characterId){if(!previewPermissionRevisions.has(characterId))previewPermissionRevisions.set(characterId,permissionState().version);return previewPermissionRevisions.get(characterId);}
  function permissionChannelStatus(accountId,characterId,conv){
    try{return channels?.permissionStatus?.(conv?{conversation:conv,character:character(characterId),characterId}:{accountId,characterId})??{ready:false,reason:'CHANNEL_PERMISSION_UNAVAILABLE'};}catch{return {ready:false,reason:'CHANNEL_PERMISSION_UNAVAILABLE'};}
  }
  function getPermissions(){
    requireOpen();const state=permissionState(),available=new Set(availableTools().map(toolConfigName)),pluginTools=pluginPermissionTools();
    return {version:state.version,defaults:{...TOOL_PERMISSION_DEFAULTS},records:clone(state.records.filter(row=>managedTool(row.tool))),legacyScreenDenials:clone(state.legacyScreenDenials),tools:[...PERMISSION_TOOLS.map(tool=>({...tool,available:available.has(tool.id),...(!available.has(tool.id)?{reason:'工具未启用或执行器不可用'}:{})})),...pluginTools],channelReadiness:channels?.permissionChannels?.()??[],conversationReadiness:list('conversation').filter(conv=>conv.channel!=='desktop').flatMap(conv=>conv.participantIds.map(characterId=>({conversationId:conv.id,characterId,...permissionChannelStatus(undefined,characterId,conv)}))),roleTools:list('character').map(person=>({characterId:person.id,tools:[...PERMISSION_TOOLS.map(tool=>({id:tool.id,available:availableTools(person.id).map(toolConfigName).includes(tool.id)})),...pluginTools.map(tool=>({id:tool.id,available:tool.available&&promptHead({characterId:person.id,scope:'tool',name:tool.functionName})?.metadata?.enabled!==false}))]}))};
  }
  function pluginPermissionTools(){let plugins;try{plugins=toolServices.toolPlugins?.listPlugins?.()??[];}catch{return [];}return plugins.flatMap(plugin=>(plugin.tools??[]).map(tool=>({id:`plugin:${plugin.id}:${tool.name}`,functionName:tool.name,pluginId:plugin.id,label:tool.name==='suna_generate_image'?'生成图片':tool.name==='suna_selfie'?'生成自拍':tool.name,available:plugin.status==='running'&&plugin.enabled===true,...(plugin.status!=='running'?{reason:'插件未启动'}:{})})));}
  function previewServiceAvailable(){return !testMode&&typeof toolServices.workspacePreview?.start==='function'&&typeof toolServices.workspacePreview?.revoke==='function';}
  function previewAuthorityAllowed(person,conv,trigger,restricted=false){
    return previewServiceAvailable()&&!closed&&!closing&&!restricted&&conv.channel==='desktop'&&conv.participantIds.includes(person.id)&&trigger.kind!=='ttm'&&!trigger.source?.internal&&!trigger.source?.pluginId&&trigger.sender?.type==='human'&&trigger.sender.id==='local-owner'&&trigger.sender.source==='desktop'&&ownerFor(trigger.sender,conv)&&promptHead({characterId:person.id,scope:'tool',name:'preview_workspace'})?.metadata?.enabled!==false;
  }
  function previewAllowed(person,conv,trigger,restricted=false){return previewAuthorityAllowed(person,conv,trigger,restricted)&&toolPermission('preview_workspace',person,conv,trigger,restricted).allowed;}

  function revokePreview(grant){
    if(!grant||grant.revoked)return;grant.revoked=true;clearTimeout(grant.timer);grant.detachRun?.();grant.controller.abort();
    if(previewGrants.get(grant.key)===grant)previewGrants.delete(grant.key);
    let result;try{result=toolServices.workspacePreview?.revoke(grant.id);}catch{return;}
    const task=Promise.resolve(result).catch(()=>{});previewReleases.add(task);void task.finally(()=>previewReleases.delete(task));
  }
  function revokePreviews({characterId,conversationId}={}){for(const grant of previewGrants.values())if((!characterId||grant.characterId===characterId)&&(!conversationId||grant.conversationId===conversationId))revokePreview(grant);}
  function finishPreviewRun(run){for(const grant of previewGrants.values())if(grant.runId===run.id){grant.detachRun?.();if(!['completed','silent'].includes(run.status))revokePreview(grant);}}
  function previewCapability(characterId){
    if(!previewServiceAvailable())return false;
    const people=characterId?[character(characterId)]:list('character'),trigger={sender:{type:'human',id:'local-owner',source:'desktop'}};
    return people.some(person=>list('conversation').some(conv=>previewAuthorityAllowed(person,conv,trigger)));
  }
  async function startWorkspacePreview({person,conv,trigger,ctx,run,controller,ensureCurrent,isRestricted},args={}){
    ensureCurrent();
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>key!=='directory')||args.directory!==undefined&&(typeof args.directory!=='string'||!args.directory.length||args.directory.length>512))fail('PREVIEW_INPUT_INVALID','请指定工作目录内的相对目录');
    if(!previewAllowed(character(person.id),conversation(conv.id),trigger,isRestricted()))fail('permission.denied','当前会话没有静态工作区预览权限');
    const key=JSON.stringify([person.id,conv.id]);revokePreview(previewGrants.get(key));
    const grant={id:id('preview_grant'),key,runId:run.id,characterId:person.id,conversationId:conv.id,contextId:ctx.contextId,epoch:run.epoch,permissionRevision:previewPermissionRevision(person.id),sender:clone(trigger.sender),triggerId:trigger.id,expiresAt:Date.now()+WORKSPACE_PREVIEW_TTL,controller:new AbortController(),revoked:false};
    const assertCurrent=()=>{
      const reject=()=>{revokePreview(grant);fail('PREVIEW_AUTHORITY_INVALID','静态预览授权已失效，请重新创建');};
      if(closed||closing||grant.revoked||grant.controller.signal.aborted||Date.now()>=grant.expiresAt||previewGrants.get(key)!==grant)return reject();
      const currentPerson=read('character',person.id),currentConv=read('conversation',conv.id),currentContext=read('context',`${person.id}:${conv.id}`);
      if(!currentPerson||!currentConv||currentContext?.contextId!==grant.contextId||(epochs.get(conv.id)??0)!==grant.epoch||previewPermissionRevision(person.id)!==grant.permissionRevision||!previewAllowed(currentPerson,currentConv,trigger,isRestricted()))return reject();
      const row=db.prepare('SELECT payload FROM messages WHERE id=? AND conversation_id=?').get(grant.triggerId,conv.id),source=row?JSON.parse(row.payload):null;
      if(!source||source.sender?.type!==grant.sender.type||source.sender?.id!==grant.sender.id||source.sender?.source!==grant.sender.source)return reject();
    };
    previewGrants.set(key,grant);grant.timer=setTimeout(()=>revokePreview(grant),WORKSPACE_PREVIEW_TTL);grant.timer.unref?.();
    const canceled=()=>revokePreview(grant);controller.signal.addEventListener('abort',canceled,{once:true});grant.detachRun=()=>controller.signal.removeEventListener('abort',canceled);
    try{
      assertCurrent();const result=await settleAfterAbort(toolServices.workspacePreview.start({workspaceRoot:workspaceFor(person.id),directory:args.directory??'.',authority:{id:grant.id,expiresAt:grant.expiresAt,signal:grant.controller.signal,assertCurrent}}),controller.signal);
      ensureCurrent();assertCurrent();return result;
    }catch(error){revokePreview(grant);throw error;}
  }
  const unsubscribeNativeTools=typeof runtime?.subscribeNativeTools==='function'?runtime.subscribeNativeTools(()=>{if(!closed&&!closing)emit('permissions.changed');}):undefined;
  function invalidateRuntimePermission(characterId){for(const active of controllers.values())if(active.characterId===characterId)active.runtimeNative?.abort();emit('permissions.changed');}
  function invalidateToolPermissions(characterId){
    interactions.revalidate(characterId);
    revokePreviews({characterId});
    for(const active of controllers.values())if(active.characterId===characterId)active.clientPermissions?.abort();
    previewPermissionRevisions.set(characterId,Math.max(permissionState().version,(previewPermissionRevisions.get(characterId)??0)+1));
    for(const conv of list('conversation').filter(conv=>conv.participantIds.includes(characterId))){
      const pair={characterId,conversationId:conv.id};runtime?.restrictImages?.(pair);
      try{const result=toolServices.screenAccess?.revoke?.(pair);if(result?.catch)void result.catch(()=>{});}catch{}
    }
    for(const task of list('worker-task'))if(task.args?.characterId===characterId&&task.args?.source?.triggerId&&['queued','running'].includes(task.status))void workerEngine.cancel(task.id).catch(()=>{});
    emit('permissions.changed');
  }
  function setPermission(input){
    requireOpen();const change=permissionChange(input);character(change.characterId);if(isPluginToolId(change.tool)&&!pluginPermissionTools().some(tool=>tool.id===change.tool))fail('PERMISSION_INVALID','工具插件尚未安装');const state=permissionState();
    if(change.expectedVersion!==state.version)fail('VERSION_CONFLICT','权限已更新，请重新读取');
    if(change.scope==='account'&&!permissionChannelStatus(change.accountId,change.characterId).ready)fail('CHANNEL_PERMISSION_UNAVAILABLE','渠道尚未配置有效的角色管理员');
    if(change.scope==='conversation'){
      const conv=conversation(change.conversationId);if(!conv.participantIds.includes(change.characterId))fail('TARGET_DENIED','角色不属于当前会话');
      const field=conv.channel==='desktop'?'local':conv.kind==='group'?'group':'direct';if(change.field!==field)fail('PERMISSION_INVALID','权限字段与会话类型不符');
      if(conv.channel!=='desktop'&&!permissionChannelStatus(undefined,change.characterId,conv).ready)fail('CHANNEL_PERMISSION_UNAVAILABLE','渠道尚未配置有效的角色管理员');
    }
    const {expectedVersion,field,value,...identity}=change,key=permissionRecordKey(identity),records=clone(state.records),index=records.findIndex(record=>permissionRecordKey(record)===key),record=index<0?{...identity,policy:{},permissionBoundaryVersion:2}:records[index];
    if((value===null&&record.policy[field]===undefined)||record.policy[field]===value)return getPermissions();
    if(value===null)delete record.policy[field];else record.policy[field]=value;
    if(index>=0)records.splice(index,1);if(Object.keys(record.policy).length)records.push(record);
    if(JSON.stringify(records)===JSON.stringify(state.records))return getPermissions();
    transaction(()=>{
      // Removing the last legacy Client record cannot acknowledge Runtime migration.
      // Latch the obligation atomically with the Client edit; reads never write it.
      const migration=read('runtime-permission-migration',change.characterId);
      if(runtimePermissions.selection(change.characterId).confirmationRequired&&migration?.required!==true)put('runtime-permission-migration',change.characterId,{required:true},migration?.version);
      put('tool-permissions','global',{...state,records},state.version||undefined);
    });invalidateToolPermissions(change.characterId);return getPermissions();
  }
  function migrateScreenPermissions(records){
    requireOpen();const state=permissionState();if(state.screenMigrated)return;
    const legacyScreenDenials=(records??[]).filter(record=>record.enabled===false).map(({characterId,conversationId})=>({characterId,conversationId}));
    put('tool-permissions','global',{...state,legacyScreenDenials,screenMigrated:true});
  }
  function adoptScreenPolicy(input={}){
    requireOpen();const fields=['characterId','conversationId','expectedVersion'],validTarget=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!['__proto__','prototype','constructor'].includes(value)&&!/[\x00-\x1f]/.test(value);
    if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!fields.includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(input,key),'value'))||!fields.every(key=>Object.hasOwn(input,key))||!validTarget(input.characterId)||!validTarget(input.conversationId)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)fail('PERMISSION_INVALID','权限参数无效');
    const state=permissionState();if(input.expectedVersion!==state.version)fail('VERSION_CONFLICT','权限已更新，请重新读取');character(input.characterId);const conv=conversation(input.conversationId);
    if(!['direct','group'].includes(conv.kind))fail('PERMISSION_INVALID','会话类型无效');
    if(!Array.isArray(conv.participantIds)||!conv.participantIds.includes(input.characterId))fail('TARGET_DENIED','角色不属于当前会话');
    const legacyScreenDenials=state.legacyScreenDenials.filter(pair=>pair.characterId!==input.characterId||pair.conversationId!==input.conversationId);
    if(legacyScreenDenials.length===state.legacyScreenDenials.length)fail('PERMISSION_INVALID','当前角色会话没有旧截图撤回记录');
    put('tool-permissions','global',{...state,legacyScreenDenials});invalidateToolPermissions(input.characterId);return getPermissions();
  }
  function toolPermission(name,person,conv,trigger,restricted=false){
    name=toolConfigName(name);
    const state=permissionState();let admin=false,effectiveConversation=conv;
    if(conv.channel!=='desktop'){
      const status=permissionChannelStatus(undefined,person.id,conv);if(!status.ready)return {allowed:false,revision:state.version};
      effectiveConversation={...conv,channelTarget:{...conv.channelTarget,accountId:status.accountId??conv.channelTarget?.accountId}};
      try{admin=channels?.isAdministrator?.({conversation:conv,character:person,sender:clone(trigger.sender)})===true;}catch{}
    }
    return {allowed:(name!=='screenshot'||!testMode)&&evaluateToolPermission({...state,characterId:person.id,tool:name,conversation:effectiveConversation,sender:trigger.sender,internal:trigger.kind==='ttm'||trigger.source?.internal===true,restricted,isAdministrator:admin}),revision:state.version};
  }
  function checkScreenCapture(binding={}){
    requireOpen();const claim=screenClaims.get(binding.runId);if(!claim||binding.permissionGranted!==true||claim.signature!==JSON.stringify(binding))return {allowed:false,revision:permissionState().version};
    return claim.check();
  }
  function availableTools(characterId){return [...Object.values(TOOL_NAMES),...(composerAttachments?.controlled?['suna_read_attachment']:[]),...(previewCapability(characterId)?['preview_workspace']:[]),...(toolServices.characterLibrary?['list_emojis']:[]),...(toolServices.screenAccess?['screenshot']:[]),...(typeof toolServices.websearch==='function'?[CLIENT_WEB_NAMES.websearch]:[]),...(typeof toolServices.webfetch==='function'?[CLIENT_WEB_NAMES.webfetch]:[]),...pluginPermissionTools().filter(tool=>tool.available).map(tool=>tool.functionName)].filter(name=>promptHead({characterId,scope:'tool',name:toolConfigName(name)})?.metadata?.enabled!==false);}
  function snapshot(){requireOpen();const prefs=settings();const result={capabilities:{localRoleMcpV1:true,conversationInteractionsV1:true,directChatSteerV1:true,conversationLifecycleV1:true,channelConversationMainListV1:true,messageReferencesV1:true,messageSendReceiptsV1:true,personProfiles:true,characterDreams:true,channelGroupSchedulerV2:true,channelGroupDecisionV2:true,desktopGroupModeratorV1:true,manualGroupImages:true,toolPlugins:!!toolServices.toolPlugins,tools:availableTools(),workers:'production',workerClientAvailable:typeof workerClient?.request==='function',workerRuntimeAvailable:typeof workerClient?.request==='function',disabledTools:fixedConfig.entries.filter(entry=>entry.scope==='tool'&&(Object.hasOwn(CLIENT_WEB_NAMES,entry.name)?!availableTools().includes(exposedToolName(entry.name)):entry.metadata.enabled===false||(entry.name==='screenshot'&&!toolServices.screenAccess))).map(entry=>({name:exposedToolName(entry.name),reason:Object.hasOwn(CLIENT_WEB_NAMES,entry.name)?(promptHead({scope:'tool',name:entry.name})?.metadata?.enabled===false?'工具已停用':'尚未配置真实服务执行器'):entry.metadata.disabledReason??'尚未配置真实服务执行器'}))},characters:list('character').map(person=>({...person,backgroundEffective:effectiveBackground(person,prefs),groupWakeWords:person.groupWakeWords??[],replyToTrigger:person.replyToTrigger!==false,capabilities:{tools:availableTools(person.id)},personality:person.personality??snapshotProjection({character:person}).persona.persona})),conversations:list('conversation').map(conversationView),messages:list('conversation').flatMap(c=>messages(c.id)),settings:settingsView(prefs),prompts:list('prompt').map(p=>({...p,validation:validatePrompt(p.draft,{scope:p.scope})})),activity:[...controllers.values()].map(c=>({runId:c.runId,characterId:c.characterId,conversationId:c.conversationId})),messageTasks:list('outbox-task').map(task=>getSendTask(task.id)),background:listActivities(),channelScheduler:channelScheduler.state(),schedulerThoughts:schedulerThoughts(),pending:[...groupScheduler.pending(),...channelScheduler.pending()].map(p=>({characterId:p.characterId,conversationId:p.conversationId,messageCount:p.messageCount,dueAt:p.dueAt,waitingForRun:p.waitingForRun})),directInputs:[...new Map([...list('direct-input').filter(item=>['queued','sending','accepted'].includes(item.status)),...list('direct-input').slice(-256)].map(item=>[item.id,item])).values()],schemaVersion:1};if(prefs.developerMode)result.runs=db.prepare('SELECT payload FROM runs ORDER BY rowid DESC LIMIT 100').all().map(r=>redact(JSON.parse(r.payload)));return result;}
  function validatePersonality(value){if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_PERSONALITY','人格必须为结构化对象');for(const [section,fields] of [['immutable',['backgrounds','temper']],['mutable',['trait','habit','dialogue']]])for(const field of fields)if(typeof value[section]?.[field]!=='string'||value[section][field].length>100000)fail('INVALID_PERSONALITY',`人格 ${section}.${field} 必须为文本`);return clone(value);}
  function validateBackground(value){if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_SETTINGS','后台任务配置必须为对象');const result=clone(value);for(const key of ['enabled','diaryEnabled'])if(result[key]!==undefined&&typeof result[key]!=='boolean')fail('INVALID_SETTINGS',`${key} 必须为布尔值`);if(result.dreamCron!==undefined){if(typeof result.dreamCron!=='string'||result.dreamCron.length>256)fail('INVALID_CRON','梦境周期必须为 Cron 文本');result.dreamCron=result.dreamCron.trim();if(result.dreamCron)parseCron(result.dreamCron);}return result;}
  function createCharacter(input={}){requireOpen();const value=put('character',id('char'),{name:required(input.name,'角色名称',40),groupWakeWords:input.groupWakeWords===undefined?[]:normalizeGroupWakeWords(input.groupWakeWords),persona:typeof input.persona==='string'?input.persona:'',...(input.personality?{personality:validatePersonality(input.personality)}:{}),color:input.color??'#8d735e',avatar:input.avatar??String(input.name??'').slice(0,1),role:'companion',state:{emotion:'平静',environment:'',pad:{pleasure:0,arousal:0,dominance:0}},memoryVersion:0,createdAt:clock(),...(input.pet?{pet:clone(input.pet)}:{})});emit('characters.changed');return value;}
  function updateCharacter(key,patch={},options={}){requireOpen();const current=character(key);const permitted={};if(Object.hasOwn(patch,'replyToTrigger'))permitted.replyToTrigger=validateReplyToTrigger(patch.replyToTrigger);if(Object.hasOwn(patch,'groupWakeWords'))permitted.groupWakeWords=normalizeGroupWakeWords(patch.groupWakeWords);for(const field of ['name','persona','personality','color','avatar','avatarUrl','pet','model','provider','accounts','emotionRecovery','background','toneEnabled'])if(patch[field]!==undefined)permitted[field]=clone(patch[field]);if(permitted.personality)permitted.personality=validatePersonality(permitted.personality);if(permitted.background!==undefined)permitted.background=validateBackground(permitted.background);if(permitted.name)required(permitted.name,'角色名称',40);const personaChanged=Object.keys(permitted).some(field=>['name','persona','personality'].includes(field));const value=put('character',key,{...current,...permitted,...(personaChanged?{personaVersion:(current.personaVersion??current.version)+1}:{})},options.expectedVersion??patch.expectedVersion);if(permitted.accounts!==undefined||permitted.name!==undefined)for(const [conversationId,active] of groupDecisions)if(active.jobs.some(job=>job.characterId===key))invalidateGroupDecision(conversationId,{requeue:true});if(['model','provider'].some(field=>permitted[field]!==undefined&&JSON.stringify(current[field])!==JSON.stringify(value[field])))for(const [conversationId,active] of groupDecisions)if(active.desktopModerated&&conversation(conversationId).participantIds.includes(key))invalidateGroupDecision(conversationId);emit('characters.changed');return value;}
  function updateCharacterState(key,patch,{expectedVersion,expectedStateVersion}={}){const current=character(key);if(expectedStateVersion!==undefined&&(current.stateVersion??1)!==expectedStateVersion)fail('VERSION_CONFLICT','共享状态已有新版本');const value=put('character',key,{...current,stateVersion:(current.stateVersion??1)+1,state:{...current.state,...clone(patch)}},expectedVersion);emit('characters.changed');return value;}
  function validateReplySettings(channel,input){
    if(Object.hasOwn(input,'replyToTrigger')){if(channel==='desktop')fail('INVALID_REPLY_SETTINGS','引用覆盖仅支持 Channel 会话');validateReplyToTrigger(input.replyToTrigger,{inherit:true});}
    if(input.replyEnabled!==undefined&&(channel==='desktop'||typeof input.replyEnabled!=='boolean'))fail('INVALID_REPLY_SETTINGS','允许回复仅支持渠道会话布尔值');
    if(input.scheduler!==undefined)try{if(channel==='desktop')validateGroupScheduler(input.scheduler);else mergeChannelGroupScheduler({},input.scheduler);}catch(error){fail('INVALID_REPLY_SETTINGS',error.message);}
  }
  function createConversation(input={}){requireOpen();if(Object.hasOwn(input,'pinned'))normalizeConversationPin(input.pinned);validateReplySettings(input.channel??'desktop',input);const ids=[...new Set(input.participantIds??['default-character'])];if(!ids.length)fail('PARTICIPANTS_REQUIRED','请至少选择一位角色');ids.forEach(character);const kind=input.kind??(ids.length>1?'group':'direct');if(!['direct','group'].includes(kind))fail('INVALID_KIND','对话类型无效');if(kind==='direct'&&ids.length>1)fail('DIRECT_PARTICIPANTS','单聊只能有一个角色');if(Object.hasOwn(input,'desktopGroupScheduler')&&(kind!=='group'||(input.channel??'desktop')!=='desktop'))fail('DESKTOP_GROUP_SCOPE','主持调度仅用于内置群聊');if(kind==='direct'&&(input.channel??'desktop')==='desktop'){const existing=activeDesktopDirect(ids[0]);if(existing)return conversationView(existing);}const value=put('conversation',id('conv'),{title:required(input.title??(kind==='group'?'新建群聊':`与 ${character(ids[0]).name} 的对话`),'对话名称',80),kind,participantIds:ids,channel:input.channel??'desktop',...((input.channel??'desktop')!=='desktop'?{channelTitleSource:input.channelTitleSource==='automatic'?'automatic':'custom'}:{}),...(input.channelTarget?{channelTarget:clone(input.channelTarget)}:{}),...(input.replyEnabled!==undefined?{replyEnabled:input.replyEnabled}:{}),...(Object.hasOwn(input,'desktopGroupScheduler')?{desktopGroupScheduler:mergeDesktopGroupScheduler({},input.desktopGroupScheduler)}:{}),...(typeof input.replyToTrigger==='boolean'?{replyToTrigger:input.replyToTrigger}:{}),scheduler:(input.channel??'desktop')==='desktop'?mergeGroupScheduler({enabled:true},input.scheduler??{}):mergeChannelGroupScheduler({enabled:true},input.scheduler??{}),createdAt:clock()});if(isDesktopDirect(value))put('desktop-direct-session',ids[0],{conversationId:value.id});let saved=value;const defaultPin=isDesktopDirect(value)&&(read('meta','conversation-lifecycle-v1')?.defaultPinCharacterIds??[]).includes(ids[0]);if(Object.hasOwn(input,'pinned')||defaultPin)saved=put('conversation',value.id,{...value,pinned:input.pinned??true,pinnedAt:(input.pinned??true)?clock():null});observability.setHistoryBoundary({conversationId:value.id,hadPriorActivity:false});emit('conversations.changed');return conversationView(saved);}
  function updateConversation(key,patch={}){requireOpen();const current=conversation(key);if(Object.hasOwn(patch,'desktopGroupScheduler')&&(current.kind!=='group'||current.channel!=='desktop'))fail('DESKTOP_GROUP_SCOPE','主持调度仅用于内置群聊');if(Object.hasOwn(patch,'showInMainList')){const showInMainList=validateChannelMainListChange(current,patch);const value=put('conversation',key,{...current,showInMainList},patch.expectedVersion);emit('conversations.changed',{conversationId:key});return conversationView(value);}validateReplySettings(current.channel,patch);const next={...current};if(Object.hasOwn(patch,'desktopGroupScheduler')){if(!Number.isSafeInteger(patch.expectedVersion)||patch.expectedVersion<1)fail('EXPECTED_VERSION_REQUIRED','请读取最新群聊版本后再修改调度');next.desktopGroupScheduler=mergeDesktopGroupScheduler(current.desktopGroupScheduler,patch.desktopGroupScheduler);}if(Object.hasOwn(patch,'pinned')){normalizeConversationPin(patch.pinned);if(!Number.isSafeInteger(patch.expectedVersion)||patch.expectedVersion<1)fail('EXPECTED_VERSION_REQUIRED','请读取最新对话版本后再修改置顶');requireActiveConversation(current);next.pinned=patch.pinned;next.pinnedAt=patch.pinned?(current.pinned===true?current.pinnedAt??clock():clock()):null;}if(Object.hasOwn(patch,'replyToTrigger')){if(patch.replyToTrigger===null)delete next.replyToTrigger;else next.replyToTrigger=patch.replyToTrigger;}if(patch.replyEnabled!==undefined)next.replyEnabled=patch.replyEnabled;if(patch.title!==undefined){next.title=required(patch.title,'对话名称',80);if(current.channel!=='desktop')next.channelTitleSource='custom';}if(patch.scheduler)next.scheduler=current.channel==='desktop'?mergeGroupScheduler(current.scheduler,patch.scheduler):mergeChannelGroupScheduler(current.scheduler,patch.scheduler);const moderatorChanged=Object.hasOwn(patch,'desktopGroupScheduler')&&JSON.stringify(resolveDesktopGroupScheduler(current.desktopGroupScheduler))!==JSON.stringify(resolveDesktopGroupScheduler(next.desktopGroupScheduler))&&(isDesktopModeratedGroup(current)||isDesktopModeratedGroup(next));const value=put('conversation',key,next,patch.expectedVersion);if(moderatorChanged)cancelAmbient(key);if(patch.replyEnabled===false)cancelAutomatic(key);else if(patch.scheduler?.enabled===false){if(current.channel==='desktop')cancelConversation(key,{source:'policy'});else cancelAmbient(key);}if(patch.scheduler){invalidateGroupDecision(key,{requeue:true});schedulerFor(current).reconfigure(key);}emit('conversations.changed');return conversationView(value);}
  function addParticipants(key,ids){const conv=conversation(key);if(!Array.isArray(ids))fail('PARTICIPANTS_REQUIRED','请提供角色列表');ids.forEach(character);const next=[...new Set([...conv.participantIds,...ids])];if(next.length===conv.participantIds.length)return conv;if(conv.kind==='direct'){if(conv.channel!=='desktop')fail('CHANNEL_PRIVATE_PARTICIPANTS','Channel 私聊不能在本地转换为平台群聊，请先在平台创建或加入群聊');return createConversation({title:'新建群聊',kind:'group',participantIds:next,channel:'desktop',scheduler:conv.scheduler});}const value=put('conversation',key,{...conv,participantIds:next});invalidateGroupDecision(key,{requeue:true});emit('conversations.changed');return value;}
  function context(characterId,conversationId){const key=`${characterId}:${conversationId}`;return read('context',key)??put('context',key,{id:key,contextId:id('ctx'),characterId,conversationId,stateVersion:0,memoryVersion:-1});}
  function runMessages(conversationId,trigger){
    const conv=conversation(conversationId);
    if(conv.channel!=='desktop'&&conv.kind==='group'){const limit=channelPolicy(conv).historyLimit,upper=trigger?.sequence??messages(conversationId,1).at(-1)?.sequence??0,rows=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND sequence<=? ORDER BY sequence DESC LIMIT ?').all(conversationId,upper,limit).map(row=>JSON.parse(row.payload));if(trigger?.id&&!rows.some(message=>message.id===trigger.id)){const row=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND id=? AND sequence<=?').get(conversationId,trigger.id,upper);if(row)rows.push(JSON.parse(row.payload));}return localRoleRecords.contextMessages(selectChannelGroupHistory(rows,{conversationId,maxSequence:upper,limit,requiredMessageId:trigger?.id}));}
    if(!trigger)return localRoleRecords.contextMessages(messages(conversationId,100));
    const history=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 100').all(conversationId,trigger.sequence).reverse().map(row=>JSON.parse(row.payload));
    const byId=new Map(history.map(message=>[message.id,message]));
    for(const sourceId of trigger.batchSourceIds??[]){const row=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND id=? AND sequence<=?').get(conversationId,sourceId,trigger.sequence);if(row){const message=JSON.parse(row.payload);byId.set(message.id,message);}}
    // Already published replies to frozen history may be included, never future human input.
    if(!trigger.strictInputUpperSequence)for(const message of messages(conversationId,1000))if(message.sender.type==='character'&&byId.has(message.replyToMessageId))byId.set(message.id,message);
    return localRoleRecords.contextMessages([...byId.values()].sort((a,b)=>a.sequence-b.sequence));
  }
  function injectedSender(characterId,message,fallbackConversationId){
    const conversationId=message?.conversationId??message?.conversation_id??fallbackConversationId;
    const conv=conversationId?read('conversation',conversationId):null,person=read('character',characterId);
    return primaryUserSender(message,{conversation:conv,character:person,isAdministrator:request=>channels?.isAdministrator?.(request)});
  }
  function groupInput(trigger,history,characterId){
    if(!trigger?.batchSourceIds||trigger.batchSourceIds.length<2)return trigger?.text??'';
    const sources=(history??runMessages(trigger.conversationId,trigger)).filter(message=>trigger.batchSourceIds.includes(message.id));
    return JSON.stringify({pending_group_messages:sources.map(message=>({id:message.id,sender:injectedSender(characterId,message,trigger.conversationId),text:message.text,blocks:message.blocks??[]})),trigger_message_id:trigger.id,trigger_text:trigger.text});
  }
  const fingerprint=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
  function quotedMessageContext(characterId,conv,trigger){
    if(!conv||!trigger?.replyToMessageId)return undefined;
    try{
      const reply=replyReference(conv,trigger.replyToMessageId,{maxSequence:Number.isSafeInteger(trigger.sequence)?trigger.sequence-1:Infinity,external:false});
      if(!reply)return undefined;
      return {message_id:reply.message.id,sender:injectedSender(characterId,reply.message,conv.id),text:reply.preview.text,kind:reply.preview.kind};
    }catch{return {message_id:trigger.replyToMessageId,unavailable:true};}
  }
  function composerFileSources(conv,trigger,history=[]){
    if(!conv||typeof composerAttachments?.projectForRun!=='function')return [];
    const sources=new Map(history.filter(message=>message.conversationId===conv.id&&['human','character'].includes(message.sender?.type)&&message.status==='delivered'&&!message.internal&&!message.source?.internal).map(message=>[message.id,message]));
    if(trigger?.replyToMessageId){try{const reference=replyReference(conv,trigger.replyToMessageId,{maxSequence:trigger.sequence-1,external:false});if(reference)sources.set(reference.message.id,reference.message);}catch{}}
    const currentIds=new Set([trigger?.id,...(trigger?.batchSourceIds??[])]),priority=message=>currentIds.has(message.id)?0:message.id===trigger?.replyToMessageId?1:2;
    const candidates=[...sources.values()].map(message=>({message,attachments:(message.attachments??[]).filter(item=>item.kind==='file'&&item.conversationId===conv.id)})).filter(source=>source.attachments.length).sort((a,b)=>priority(a.message)-priority(b.message)||b.message.sequence-a.message.sequence||a.message.id.localeCompare(b.message.id));
    let bytes=0;const admitted=new Set();
    return candidates.map(({message,attachments})=>{const retained=[];let omitted=0;for(const item of attachments){
      if(admitted.has(item.id)){retained.push(item);continue;}
      if(!Number.isSafeInteger(item.size)||item.size<0||(item.delivery!=='controlled-url'&&item.size>16*1024*1024)||admitted.size>=16||bytes+(item.delivery==='controlled-url'?0:item.size)>24*1024*1024){omitted++;continue;}
      admitted.add(item.id);bytes+=item.delivery==='controlled-url'?0:item.size;retained.push(item);
    }return {message,attachments:retained,omitted};});
  }
  function composerFileContext(characterId,conv,trigger,history,reader){
    return composerFileSources(conv,trigger,history).map(({message,attachments,omitted})=>({message_id:message.id,sender:injectedSender(characterId,message,conv.id),files:composerAttachments.projectForRun({conversationId:conv.id,attachments}).map(file=>file.delivery==='controlled-url'?{...file,ref:reader?.descriptors.find(a=>a.id===file.attachmentId)?.ref,read_tool:'suna_read_attachment',read_limit_bytes:262144}:file),...(omitted?{omitted_files:omitted,omission_reason:'run_file_budget',file_budget:{max_files:16,max_bytes:24*1024*1024}}:{})}));
  }
  const trustedA2aMarker=message=>localRoleRecords.trusted(message);
  function variablesFor(characterId,conversationId,trigger,history,reader){const person=character(characterId),conv=conversationId?conversation(conversationId):null,ctx=conversationId?context(characterId,conversationId):null,replyTo=quotedMessageContext(characterId,conv,trigger),fileContext=composerFileContext(characterId,conv,trigger,history??(conv?runMessages(conv.id,trigger):[]),reader);const variables=snapshotProjection({character:person,conversation:conv,memories:list('memory').filter(m=>m.characterId===characterId),history:conversationId?(history??runMessages(conversationId,trigger)):[],versions:{state:person.stateVersion??1,memory:person.memoryVersion??0,persona:person.personaVersion??person.version},input:groupInput(trigger,history,characterId),projectSender:message=>injectedSender(characterId,message,conversationId),at:clock(),messageContext:{channel:conv?.channel??'desktop',conversation_id:conversationId??'',message_id:trigger?.id??'',sender:trigger?injectedSender(characterId,trigger,conversationId):null,event_type:trigger?.kind==='ttm'?'ttm':trigger?.sender?.type==='character'?'character_message':'user_message',source:trigger?.source??null,participants:conv?.participantIds.map(k=>({id:k,name:character(k).name}))??[],mention_ids:trigger?.mentionIds??[],reply_to_message_id:trigger?.replyToMessageId??null,...(replyTo?{reply_to:replyTo}:{}),...(fileContext.length?{file_attachments:fileContext}:{})}}).variables;variables.recent_messages=withA2aRecentMessages(variables.recent_messages,history??(conv?runMessages(conv.id,trigger):[]),trustedA2aMarker,message=>snapshotProjection({history:[message],conversation:conv,projectSender:item=>injectedSender(characterId,item,conversationId)}).variables.recent_messages[0]);
    if(ctx&&ctx.baselineContextId===ctx.contextId){
      if(ctx.stateFingerprint===fingerprint(variables.state))variables.state_updated='';
      if(ctx.memoryFingerprint===fingerprint(variables.work_memory))variables.work_memory_updated='';
    }
    variables['memory.user_profile']='';return variables;
  }
  async function readOriginalDeveloperPrompt({characterId}={}){
    developer();if(typeof characterId!=='string'||!characterId)fail('CHARACTER_NOT_FOUND','请选择有效角色');const person=character(characterId);
    if(typeof runtime?.readOriginalDeveloperPrompt!=='function')fail('DSH_ORIGINAL_PROMPT_UNAVAILABLE','当前运行时不支持读取 DSH 原版提示词');
    const selection=runtimePermissions.selection(person.id);
    return runtime.readOriginalDeveloperPrompt({character:clone(person),provider:person.provider,model:person.model,workspace:workspaceFor(person.id),runtimePermissionPreset:selection.preset,runtimePermissionExplicit:selection.explicit,runtimeNative:{confirmed:!selection.confirmationRequired}});
  }
  function previewPrompt(input={}){const characterId=input.characterId??'default-character';const scope=input.scope??'runtime',name=input.name??'system';const head=promptHead({...input,scope,name});const content=input.content??head?.draft??'';const variables={...variablesFor(characterId,input.conversationId,input.trigger),...input.variables};const validation=validatePrompt(content,{scope});if(!validation.valid)return {content,text:'',validation,variables};return {content,...renderPrompt(content,variables),validation,variables};}
  function savePromptDraft(input){return promptStore.savePromptDraft(input);}
  function publishPrompt(input){const result=promptStore.publishPrompt(input);if(input.scope==='tool'&&Object.hasOwn(INTERACTION_TOOLS,input.name))interactions.revalidate(input.characterId);return result;}
  function promptHistory(input){return promptStore.promptHistory(input);}
  function rollbackPrompt(input){return promptStore.rollbackPrompt(input);}
  function exportPromptConfig(){return promptStore.exportPromptConfig();}
  function importPromptConfig(envelope,options){return promptStore.importPromptConfig(envelope,options);}
  function setSettings(patch={}){requireOpen();const current=settings(),clean={};for(const field of ['developerMode','theme','accentColor','accentTextMode','petEnabled','petType','groupScheduler','channelGroupScheduler','runtime','ownerBindings','toneEnabled','background','timeZone','appearance','personalAvatarUrl'])if(patch[field]!==undefined)clean[field]=clone(patch[field]);if(clean.personalAvatarUrl!==undefined&&(typeof clean.personalAvatarUrl!=='string'||clean.personalAvatarUrl!==''&&!/^\/assets-local\/[a-f0-9-]{36}\/image\.png$/.test(clean.personalAvatarUrl)))fail('INVALID_SETTINGS','个人头像必须使用已导入的图片');if(clean.personalAvatarUrl!==undefined&&(!Number.isSafeInteger(patch.expectedVersion)||patch.expectedVersion<1))fail('EXPECTED_VERSION_REQUIRED','请重新读取个人头像后再保存');if(clean.accentTextMode!==undefined&&!validAccentTextMode(clean.accentTextMode))fail('INVALID_SETTINGS','强调色文字模式必须为 auto、dark 或 light');if(clean.accentColor!==undefined){if(!validAccentColor(clean.accentColor))fail('INVALID_SETTINGS','强调色必须为六位十六进制颜色');clean.accentColor=clean.accentColor.toLowerCase();}if(clean.developerMode!==undefined&&typeof clean.developerMode!=='boolean')fail('INVALID_SETTINGS','开发者模式必须为布尔值');if(clean.ownerBindings&&!Array.isArray(clean.ownerBindings))fail('INVALID_SETTINGS','主人绑定格式无效');if(clean.timeZone!==undefined){if(typeof clean.timeZone!=='string'||!clean.timeZone.trim()||clean.timeZone.length>128)fail('INVALID_SETTINGS','时区必须为有效 IANA 标识');clean.timeZone=clean.timeZone.trim();try{new Intl.DateTimeFormat('en',{timeZone:clean.timeZone});}catch{fail('INVALID_SETTINGS','时区无效');}}if(clean.appearance!==undefined)clean.appearance={...DEFAULT_APPEARANCE,...current.appearance,...validateAppearance(clean.appearance)};if(clean.background!==undefined)clean.background=validateBackground(clean.background);if(clean.groupScheduler!==undefined)clean.groupScheduler=mergeGroupScheduler(current.groupScheduler,clean.groupScheduler,{global:true});if(clean.channelGroupScheduler!==undefined)clean.channelGroupScheduler=mergeChannelGroupScheduler(current.channelGroupScheduler,clean.channelGroupScheduler);if(clean.background)clean.background={...current.background,...clean.background};const channelPolicyChanged=clean.channelGroupScheduler!==undefined&&JSON.stringify(resolveChannelGroupScheduler(current.groupScheduler,current.channelGroupScheduler))!==JSON.stringify(resolveChannelGroupScheduler(clean.groupScheduler??current.groupScheduler,clean.channelGroupScheduler));const value=put('settings','app',{...current,...clean},patch.expectedVersion);if(clean.groupScheduler?.enabled===false)for(const c of list('conversation'))if(c.kind==='group'){if(c.channel==='desktop')cancelConversation(c.id,{source:'policy'});else cancelAmbient(c.id);}if(clean.developerMode===false){for(const child of testSessions.values())for(const conv of child.snapshot().conversations)child.cancelConversation(conv.id,{source:'policy'});for(const control of testControllers.values())control.abort();}if(clean.groupScheduler){for(const conversationId of [...groupDecisions.keys()])invalidateGroupDecision(conversationId,{requeue:true});groupScheduler.reconfigure();channelScheduler.reconfigure();}if(channelPolicyChanged)for(const conv of list('conversation'))if(conv.kind==='group'&&conv.channel!=='desktop'){cancelAmbient(conv.id);channelScheduler.reconfigure(conv.id);}log('settings.changed',{keys:Object.keys(clean)});emit('settings.changed');return settingsView(value);}
  function ownerFor(sender,conv){return sender.type==='human'&&(sender.source==='desktop'||(conv.channel==='desktop'?sender.id==='local-owner':settings().ownerBindings.some(binding=>binding.channel===conv.channel&&binding.platform===conv.channelTarget?.platform&&String(binding.userId)===String(sender.id)&&(!binding.accountId||binding.accountId===conv.channelTarget?.accountId))));}
  function enqueue(key,fn){const previous=queues.get(key)??Promise.resolve();const next=previous.catch(()=>{}).then(fn);queues.set(key,next);void next.finally(()=>{if(queues.get(key)===next)queues.delete(key);}).catch(()=>{});return next;}
  async function settleAfterAbort(promise,signal){
    let timer,abort;
    const task=Promise.resolve(promise);void task.catch(()=>{});
    const cancelled=new Promise((_,reject)=>{abort=()=>{timer=setTimeout(()=>reject(signal.reason??new BookError('RUN_CANCELLED','本轮已取消')),Math.max(0,Math.min(30000,Number(cancellationGraceMs)||0)));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
    try{return await Promise.race([task,cancelled]);}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
  }
  function saveRun(run){db.prepare('INSERT INTO runs(id,conversation_id,character_id,trigger_id,status,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(run.id,run.conversationId,run.characterId,run.triggerId,run.status,JSON.stringify(run));emit('activity.changed',{conversationId:run.conversationId});}
  function automaticTrigger(trigger){return trigger.automatic===true||!!trigger.externalId;}
  function replyAllowed(conv,automatic,route){return !(automatic&&conv.channel!=='desktop'&&conv.replyEnabled===false)&&!(route==='ambient'&&(conv.channel==='desktop'?(!groupGlobalPolicy(conv)?.enabled||!conv.scheduler?.enabled):(groupGlobalPolicy(conv)?.enabled===false||conv.scheduler?.enabled===false)));}
  function characterReplyAllowed(conv,characterId,automatic,replyLease){if(!automatic||typeof channels?.canReply!=='function')return true;try{return channels.canReply({conversation:conv,character:character(characterId),automatic:true,...(replyLease!==undefined?{replyLease}:{})})===true;}catch{return false;}}
  function runAllowed(run){return conversationIsActive(conversation(run.conversationId))&&run.epoch===(epochs.get(run.conversationId)??0)&&(!run.automatic||run.automaticEpoch===(automaticEpochs.get(run.conversationId)??0))&&(run.route!=='ambient'||run.ambientEpoch===(ambientEpochs.get(run.conversationId)??0))&&replyAllowed(conversation(run.conversationId),run.automatic,run.route)&&characterReplyAllowed(conversation(run.conversationId),run.characterId,run.automatic,run.replyLease);}
  async function executeRun(run,trigger){
    if(closed)return;const conv=conversation(run.conversationId);if(!runAllowed(run)){
      const persisted=db.prepare('SELECT payload FROM runs WHERE id=?').get(run.id),saved=persisted?JSON.parse(persisted.payload):run;
      const interruption=saved.interruption??{code:'RUN_CANCELLED',cancelSource:characterReplyAllowed(conv,run.characterId,run.automatic,run.replyLease)?'policy':'revocation',message:'本轮回复资格已失效'};
      run.interruption=interruption;Object.assign(run,runFailureState(interruption));run.error=interruption.message;run.finishedAt=clock();
      groupDispatch.transition(run.id,run.status,run.code);groupDispatch.releaseUnstartedAutoTurn(run.id);saveRun(run);return run;
    }
    const controller=new AbortController();controllers.set(run.id,{controller,runId:run.id,characterId:run.characterId,conversationId:conv.id,route:run.route,automatic:run.automatic});run.status='running';run.startedAt=clock();groupDispatch.transition(run.id,'running');saveRun(run);
    const collectRuntimeCall=call=>{
      if(!call||typeof call.id!=='string'||!call.id)return;
      recordUsageCall(call,{id:`runtime:${run.id}:${call.id}`,category:'runtime-loop',conversationId:conv.id,characterId:run.characterId,runId:run.id,triggerId:run.triggerId,roundId:run.triggerId});
    };
    const runKey=`${run.characterId}:${conv.id}`;
    const runBudget=resolveGroupScheduler(groupGlobalPolicy(conv),conv.kind==='group'?conv.scheduler:{}).runTimeoutMs,runDeadline=Date.now()+runBudget;
    const timeout=setTimeout(()=>controller.abort(new BookError('RUN_TIMEOUT','本轮运行超过时间限制')),runBudget);timeout.unref?.();
    async function awaitRuntime(operation){
      let settled=false,cancelTimer,abortHandler;
      const task=Promise.resolve().then(()=>{if(controller.signal.aborted)throw controller.signal.reason??new BookError('RUN_CANCELLED','本轮已取消');groupDispatch.markRuntimeStarted(run.id);return operation();}).finally(()=>{
        settled=true;
        if(quarantines.get(runKey)?.runId===run.id){quarantines.delete(runKey);if(!closing&&!closed){schedulerFor(conv).wake(run.characterId,conv.id);directInputs.wake(conv.id);}}
      });
      // Catch the detached tail even when a broken runtime never honors abort.
      void task.catch(()=>{});
      const cancelled=new Promise((_,reject)=>{
        abortHandler=()=>{if(cancelTimer!==undefined)return;cancelTimer=setTimeout(()=>{
          if(settled)return;
          quarantines.set(runKey,{runId:run.id,contextId:context(run.characterId,conv.id).contextId});
          reject(controller.signal.reason??new BookError('RUN_CANCELLED','本轮已取消，等待运行环境停止'));
        },Math.max(0,Math.min(30000,Number(cancellationGraceMs)||0)));};
        controller.signal.addEventListener('abort',abortHandler,{once:true});if(controller.signal.aborted)abortHandler();
      });
      try{return await Promise.race([task,cancelled]);}finally{clearTimeout(cancelTimer);controller.signal.removeEventListener('abort',abortHandler);}
    }
    trigger=clone(trigger);Object.freeze(trigger.sender);
    let frozenMessages=runMessages(conv.id,trigger);
    const person=character(run.characterId),ctx=context(person.id,conv.id);let variables=variablesFor(person.id,conv.id,trigger,frozenMessages),preparedInput;let hasReply=false,declined=false,authorityRestricted=false;const screenRuns=new Set();
    const presentedSourceIds=trigger.kind==='ttm'?[trigger.id]:frozenMessages.filter(message=>run.triggerIds.includes(message.id)).map(message=>message.id);
    const authority={isOwner:!testMode&&ownerFor(trigger.sender,conv),sender:trigger.sender,computerOperationsAllowed:false};
    let messageImageAccess,manualMessageAccess,groupMediaPort,pluginBindings,roleBindings,attachmentReader,controlledImagesRead=false,profilePort,profileContext='';const runtimeNative=new AbortController();
    const permissionController=new AbortController(),abortPermissions=()=>{permissionController.abort();runtimeNative.abort();};controller.signal.addEventListener('abort',abortPermissions,{once:true});
    const restrictAuthority=()=>{
      if(closed||controller.signal.aborted||controllers.get(run.id)?.controller!==controller)return;
      revokePreviews({characterId:person.id,conversationId:conv.id});
      authorityRestricted=true;authority.isOwner=false;authority.screenPermissionGranted=false;permissionController.abort();runtimeNative.abort();attachmentReader?.dispose();preparedInput?.dispose();groupMediaPort?.dispose();pluginBindings?.dispose();
      for(const task of list('worker-task'))if(task.args?.characterId===person.id&&task.args?.source?.triggerId===trigger.id&&['queued','running'].includes(task.status))void workerEngine.cancel(task.id).catch(()=>{});
      if(screenRuns.size||messageImageAccess||manualMessageAccess){const pair={characterId:person.id,conversationId:conv.id};runtime?.restrictImages?.(pair);try{const result=toolServices.screenAccess?.revoke?.(pair);if(result?.catch)void result.catch(()=>{});}catch{}}
    };
    controllers.get(run.id).restrictAuthority=restrictAuthority;
    const ensureCurrent=()=>{if(controller.signal.aborted||closed||controllers.get(run.id)?.controller!==controller||!runAllowed(run))fail('RUN_CANCELLED','本轮已取消');};
    previewPermissionRevision(person.id);
    controllers.get(run.id).runtimeNative=runtimeNative;controllers.get(run.id).clientPermissions=permissionController;
    try{
      if(quarantines.has(runKey))fail('RUN_CONTEXT_QUARANTINED','上一轮仍在退出，当前角色会话暂不可运行');
      if(!runtime?.run)fail('RUNTIME_UNAVAILABLE','尚未连接 DSH，请在设置中启动或连接运行环境');
      if(runtime.getModelConfig){const configuration=await settleAfterAbort(runtime.getModelConfig(),controller.signal),status=runtime.health?await settleAfterAbort(runtime.health(),controller.signal):{};if(status.mode!=='external'&&!configuration.model&&!person.model)fail('MODEL_NOT_CONFIGURED','尚未配置模型，请先在设置中填写模型名称和服务地址');}
      ensureCurrent();
      if(composerAttachments?.controlled){const attachments=[...new Map(composerFileSources(conv,trigger,frozenMessages).flatMap(source=>source.attachments.map(a=>({...a,sourceMessageId:source.message.id,sequence:source.message.sequence,sourceSender:source.message.sender,blockIndex:Math.max(0,(source.message.blocks??[]).findIndex(b=>b.attachmentId===a.id))}))).map(a=>[a.id,a])).values()];
        attachmentReader=composerAttachments.controlled.createRunReader({conversationId:conv.id,characterId:person.id,runId:run.id,attachments,signal:permissionController.signal,assertCurrent:()=>{ensureCurrent();if(authorityRestricted||closing||!conversation(conv.id).participantIds.includes(person.id)||!toolPermission('suna_read_attachment',character(person.id),conversation(conv.id),trigger,authorityRestricted).allowed||promptHead({characterId:person.id,scope:'tool',name:'suna_read_attachment'})?.metadata?.enabled===false)fail('permission.denied','本轮附件读取权限已失效');}});
        variables=variablesFor(person.id,conv.id,trigger,frozenMessages,attachmentReader);
      }

      profilePort=createRunPersonProfile({store:personProfiles,characterId:person.id,trigger,conversation:conv,runId:run.id,signal:controller.signal,canonicalizeSubject:subject=>personProfiles.resolveSubject({characterId:person.id,subject}),getIdentityStamp:()=>personProfiles.identityStamp({characterId:person.id}),findCharacter:key=>read('character',key),onRecallError:error=>log('person_profiles.recall_failed',{code:error.code??'PROFILE_RECALL_FAILED'},'warn'),assertCurrent:()=>{ensureCurrent();if(closing||authorityRestricted||!conversation(conv.id).participantIds.includes(person.id))fail('RUN_CANCELLED','人物画像执行轮已失效');}});
      profileContext=projectPersonProfile(profilePort);variables['memory.user_profile']=profileContext;
      if(conv.channel!=='desktop'&&conv.kind==='group'&&!testMode&&trigger.kind!=='ttm'&&!trigger.source?.pluginId){
        const assertImages=()=>{ensureCurrent();if(closing||authorityRestricted||!conversation(conv.id).participantIds.includes(person.id))fail('RUN_CANCELLED','本轮会话图片访问已失效');};
        groupMediaPort=createGroupMediaReferences({characterId:person.id,conversationId:conv.id,runId:run.id,messages:frozenMessages,maxSequence:trigger.sequence,maxMessages:channelPolicy(conv).historyLimit,readStored:(relative,options)=>mediaFor(person.id).readStored(relative,options),signal:permissionController.signal,assertCurrent:assertImages});
        frozenMessages=groupMediaPort.project(frozenMessages);variables={...variablesFor(person.id,conv.id,trigger,frozenMessages,attachmentReader),'memory.user_profile':profileContext};
        manualMessageAccess={characterId:person.id,conversationId:conv.id,assertCurrent:ref=>{assertImages();return groupMediaPort.assertCurrent(ref);},read:groupMediaPort.read};
      }
      if(attachmentReader?.descriptors.length&&!testMode&&trigger.kind!=='ttm'&&!trigger.source?.pluginId){const prior=manualMessageAccess;manualMessageAccess={characterId:person.id,conversationId:conv.id,assertCurrent:ref=>{if(typeof ref==='string'&&ref.startsWith('suna-media://')){if(!prior)fail('ATTACHMENT_NOT_FOUND','没有该图片引用');return prior.assertCurrent(ref);}if(ref===undefined){prior?.assertCurrent();ensureCurrent();if(authorityRestricted||closing||!conversation(conv.id).participantIds.includes(person.id))fail('RUN_CANCELLED','本轮会话附件访问已失效');if(controlledImagesRead)attachmentReader.assertCurrent();return true;}return attachmentReader.assertCurrent(ref);},read:(ref,options)=>typeof ref==='string'&&ref.startsWith('suna-media://')?prior.read(ref,options):attachmentReader.readImage(ref,options)};}
      if(!(conv.channel!=='desktop'&&conv.kind==='group')&&!testMode&&trigger.kind!=='ttm'&&!trigger.source?.pluginId)messageImageAccess=createMessageImageAccess({characterId:person.id,conversationId:conv.id,messages:frozenMessages,maxSequence:trigger.sequence,readStored:(relative,options)=>mediaFor(person.id).readStored(relative,options),signal:controller.signal,assertCurrent:()=>{ensureCurrent();if(closing||authorityRestricted||!conversation(conv.id).participantIds.includes(person.id))fail('RUN_CANCELLED','本轮会话图片访问已失效');}});
      const head=promptHead({characterId:person.id,scope:'runtime',name:'system'}),devHead=promptHead({characterId:person.id,scope:'runtime',name:'dev'}),inputHead=promptHead({characterId:person.id,scope:'runtime',name:'user_input'});let {prompt,developerPrompt,inputPrompt}=assembleClientRuntimePrompts({system:head?.content??BASE_PROMPT,developer:devHead?.metadata?.enabled===true&&devHead.metadata.developerSource!=='dsh-original'?devHead.content:'',input:inputHead?.content??'{{user_input}}',variables});
      if(conv.channel!=='desktop'&&conv.kind==='group')inputPrompt=withGroupDecisionContext(withChannelGroupInput(inputPrompt,{messages:frozenMessages,trigger,characterId:person.id,projectSender:message=>injectedSender(person.id,message,conv.id)}),run.groupDecisionContext??[]);
      if(run.desktopModeratorRoundId)inputPrompt=withDesktopModeratorInput(inputPrompt,{messages:frozenMessages,trigger,characterId:person.id,limit:run.desktopModeratorHistoryLimit,projectSender:message=>injectedSender(person.id,message,conv.id)});
      const a2aUsesRecent=[head?.content,devHead?.content,inputHead?.content].some(text=>typeof text==='string'&&/{{\s*recent_messages\s*}}/.test(text));inputPrompt=withA2aHistoryInput(inputPrompt,frozenMessages,trustedA2aMarker,a2aUsesRecent);
      const source={automatic:run.automatic,runId:run.id,triggerId:trigger.id,triggerSequence:trigger.sequence,triggerTime:trigger.createdAt,authority};
      const searchHandler=toolServices.websearch,fetchHandler=toolServices.webfetch,screenAccess=toolServices.screenAccess,pair={characterId:person.id,conversationId:conv.id};
      const screenGrant=()=>{if(controller.signal.aborted||closed||closing||!runAllowed(run)||!availableTools(person.id).includes('screenshot'))return {allowed:false,revision:permissionState().version};return toolPermission('screenshot',character(person.id),conversation(conv.id),trigger,authorityRestricted);};
      let imageAccess;
      if(screenAccess&&screenGrant().allowed){
        const capability=await settleAfterAbort(Promise.resolve(runtime.getModelCapabilities?.({provider:person.provider,model:person.model,signal:controller.signal})).catch(()=>null),controller.signal);
        if(capability?.imageInput&&capability?.ephemeralTransport&&screenGrant().allowed){
          authority.screenPermissionGranted=true;
          imageAccess={...pair,getGrant:screenGrant,capture:async request=>{
            ensureCurrent();const grant=screenGrant();if(!grant.allowed||grant.revision!==request.grantRevision)fail('permission.denied','本轮没有截图权限或权限已改变');
            const binding={permissionGranted:true,runId:request.runId,...pair,triggerId:trigger.id,provider:request.provider,model:request.model,grantRevision:grant.revision};
            const previous=screenClaims.get(binding.runId),signature=JSON.stringify(binding);if(previous&&previous.signature!==signature)fail('permission.denied','截图执行身份已改变');
            screenClaims.set(binding.runId,{signature,check:screenGrant});screenRuns.add(binding.runId);
            const pixels=await screenAccess.capture({...binding,signal:permissionController.signal});ensureCurrent();const after=screenGrant();if(!after.allowed||after.revision!==binding.grantRevision)fail('permission.denied','截图权限已改变');return pixels;
          }};
        }
      }
      let previewEnabled=false;
      if(previewAuthorityAllowed(person,conv,trigger,authorityRestricted))previewEnabled=true;
      const toolHandlers={
        ...(conv.channel==='desktop'?Object.fromEntries(Object.keys(INTERACTION_TOOLS).map(kind=>[kind,args=>{ensureCurrent();const receipt=interactions.create({kind,args,characterId:person.id,conversationId:conv.id,runId:run.id,triggerId:trigger.id,assertCurrent:ensureCurrent});hasReply=true;return receipt;}])):{}),
        ...(manualMessageAccess?{read_message_image:async(args={},execution)=>{ensureCurrent();if(authorityRestricted||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>key!=='ref')||typeof args.ref!=='string'||typeof execution?.readMessageImage!=='function')fail('IMAGE_ACCESS_INVALID','图片读取参数或通道无效');const result=await execution.readMessageImage(args.ref);ensureCurrent();if(!result||result.ok!==true||result.ref!==args.ref)fail('IMAGE_ACCESS_INVALID','图片读取回执无效');return Object.fromEntries(['ok','ref','messageId','sequence','sender','blockIndex','mime','width','height','ephemeral'].filter(key=>result[key]!==undefined).map(key=>[key,result[key]]));}}:{}),
        ...(previewEnabled?{preview_workspace:args=>startWorkspacePreview({person,conv,trigger,ctx,run,controller,ensureCurrent,isRestricted:()=>authorityRestricted},args)}:{}),
        [TOOL_NAMES.sendMessage]:async(args={})=>{ensureCurrent();const perCall=Object.hasOwn(args,'terminate');if(perCall&&typeof args.terminate!=='boolean')fail('INVALID_TERMINATE','terminate 必须为布尔值');if(args.conversationId&&args.conversationId!==conv.id)fail('TARGET_DENIED','不能从当前执行轮向其他对话发送消息');const receipt=await enqueueSend({person,conv,run,trigger,args,signal:controller.signal,completionKind:args.terminate===false?'progress':args.terminate===true?'final':'unspecified'});hasReply=true;return {...receipt,...(perCall?{terminate:args.terminate}:{})};},
        ...(toolServices.characterLibrary?{list_emojis:async(args={})=>{ensureCurrent();return toolServices.characterLibrary.listEmojis({characterId:person.id,query:args.query,offset:args.offset,limit:args.limit});}}:{}),
        [TOOL_NAMES.noReply]:async(args={})=>{ensureCurrent();declined=true;log('run.no_reply',{runId:run.id,reason:String(args.reason??'')});return {status:'completed'};},
        [TOOL_NAMES.addWorkMemory]:async(args={})=>{ensureCurrent();const entry=addMemory(person.id,{content:args.content??args.text,impression_score:args.impression_score??args.score,sourceMessageIds:[trigger.id],sourceConversationId:conv.id});log('write.memory',{runId:run.id,entry});emit('characters.changed');if(list('memory').filter(m=>m.characterId===person.id).length>=50&&!list('worker-task').some(task=>task.type==='work_memory_convolution'&&task.args.characterId===person.id&&['queued','running'].includes(task.status)))void workerEngine.enqueue('work_memory_convolution',{...workerArgs(person.id,conv.id,'',source),signal:permissionController.signal}).catch(error=>log('convolution.failed',{error:error.message},'error'));return {status:'completed',task_id:entry.id,duplicate:false,entry,memoryId:entry.id};},
        ...(profilePort?{[TOOL_NAMES.addUserProfile]:async(args={})=>{const result=await profilePort.execute(args);if(result.recorded)emit('person-profiles.changed',{characterId:person.id});return result;}}:{}),
        [TOOL_NAMES.recallMemory]:async(args={})=>{ensureCurrent();return memoryStore.recall({characterId:person.id,query:args.query,date:args.date});},
        [TOOL_NAMES.updateEmotion]:async(args={})=>{ensureCurrent();const content=required(args.content??args.emotion??args.description,'本次感受',20000);return workerEngine.enqueue('emotion_update',{...workerArgs(person.id,conv.id,content,source),signal:permissionController.signal});},
        [TOOL_NAMES.interactEnv]:async(args={})=>{ensureCurrent();const task=await workerEngine.run('env_update',{...workerArgs(person.id,conv.id,required(args.des,'环境交互',20000),source),signal:permissionController.signal});if(task.status!=='completed')fail(task.code??'WORKER_FAILED',task.error??'环境更新失败');return {status:'completed',...task.result};},
        [TOOL_NAMES.cron]:async(args={})=>{ensureCurrent();return cronTool(person,conv,args);},
        [TOOL_NAMES.getSelfie]:async()=>{ensureCurrent();return {...await mediaFor(person.id).getSelfie(person,{capture:toolServices.captureSelfie,signal:permissionController.signal}),model_image_input:false};},
        ...(screenAccess?{screenshot:async(_args,execution)=>{ensureCurrent();if(!screenGrant().allowed)fail('permission.denied','当前角色与会话不允许截图');if(!imageAccess||typeof execution?.captureImage!=='function')fail('model.images.unsupported','当前模型或运行时不支持临时图片输入');return execution.captureImage();}}:{}),
        ...(typeof searchHandler==='function'?{[CLIENT_WEB_NAMES.websearch]:async args=>{ensureCurrent();try{return await searchHandler(args,{signal:permissionController.signal,characterId:person.id});}catch(error){const receipt=clientWebFailure(error);if(receipt)return receipt;throw error;}}}:{}),
        ...(typeof fetchHandler==='function'?{[CLIENT_WEB_NAMES.webfetch]:async args=>{ensureCurrent();try{return await fetchHandler(args,{signal:permissionController.signal,characterId:person.id});}catch(error){const receipt=clientWebFailure(error);if(receipt)return receipt;throw error;}}}:{}),
      };
      if(attachmentReader?.descriptors.length)toolHandlers.suna_read_attachment=async(args,execution)=>{if(!inputPrepared)fail('ATTACHMENT_NOT_READY','本轮附件上下文尚未准备');if(args?.mode==='image'){if(Object.keys(args).some(k=>!['ref','mode'].includes(k))||typeof execution?.readAttachmentImage!=='function')fail('ATTACHMENT_IMAGE_UNSUPPORTED','当前运行环境不支持附件图片读取');const image=await execution.readAttachmentImage(args.ref);controlledImagesRead=true;return image;}return attachmentReader.read(args);};
      if(!testMode&&trigger.kind!=='ttm'&&!trigger.source?.pluginId&&typeof toolServices.toolPlugins?.createBindings==='function'){
        const rawMediaMessages=new Map(runMessages(conv.id,trigger).map(message=>[message.id,message]));
        const scopedMedia=Object.create(mediaFor(person.id));
        scopedMedia.resolveReference=async(reference,{signal}={})=>{
          ensureCurrent();if(authorityRestricted)fail('permission.denied','本轮不能读取图片引用');
          if(reference.kind==='workbench'){
            let administrator=authority.isOwner===true;try{administrator||=channels?.isAdministrator?.({conversation:conversation(conv.id),character:character(person.id),sender:trigger.sender})===true;}catch{}
            if(!administrator)fail('permission.denied','Workbench 图片引用仅主用户或频道管理员可用');
            const stored=await mediaFor(person.id).persist(reference.path);ensureCurrent();return mediaFor(person.id).readStored(stored.relativePath,{signal,maxBytes:32*1024*1024});
          }
          if(reference.kind!=='media')fail('IMAGE_REFERENCE_INVALID','图片引用格式无效');
          if(groupMediaPort&&reference.id.startsWith('suna-media://')){const image=await groupMediaPort.read(reference.id,{signal});return {data:image.bytes,descriptor:{mime:image.mime,width:image.width,height:image.height,sha256:image.sha256,bytes:image.byteLength}};}
          const split=reference.id.lastIndexOf('#'),messageId=reference.id.slice(0,split),index=Number(reference.id.slice(split+1));
          if(split<1||!Number.isSafeInteger(index)||index<0||!frozenMessages.some(message=>message.id===messageId))fail('IMAGE_REFERENCE_INVALID','图片不属于本轮上下文');
          const block=rawMediaMessages.get(messageId)?.blocks?.[index],match=block?.type==='image'&&/^\/media-local\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))$/.exec(block.url??'');
          if(!match)fail('IMAGE_REFERENCE_INVALID','图片不属于本轮上下文');
          return mediaFor(person.id).readStored(match[1],{signal,maxBytes:32*1024*1024});
        };
        pluginBindings=toolServices.toolPlugins.createBindings({characterId:person.id,characterName:person.name,conversationId:conv.id,triggerId:trigger.id,runId:run.id,replyLease:run.replyLease,signal:permissionController.signal,assertCurrent:()=>{ensureCurrent();if(authorityRestricted||closing)fail('RUN_CANCELLED','本轮工具插件已失效');},allowed:permissionId=>toolPermission(permissionId,character(person.id),conversation(conv.id),trigger,authorityRestricted).allowed,media:scopedMedia,workspace:workspaceFor(person.id),deadline:runDeadline});
        for(const [name,handler] of Object.entries(pluginBindings.handlers)){if(Object.hasOwn(toolHandlers,name))fail('PLUGIN_TOOL_NAME_CONFLICT','工具函数名称冲突');toolHandlers[name]=handler;}
      }
      let peerAvailable=false;if(typeof runtime?.endA2A==='function'){if(typeof runtime.start==='function')await runtime.start();ensureCurrent();const state=typeof runtime.health==='function'?await runtime.health():null;ensureCurrent();peerAvailable=state?.ok===true&&typeof state.a2aRuntimeId==='string'&&state.capabilities?.includes('a2a-sessions-v1')===true&&state.capabilities?.includes('a2a-intrinsic-tools-v1')===true;}
      const rolePort=localRoles.bind({characterId:person.id,conversationId:conv.id,runId:run.id,trigger,peerAvailable,sessionSource:()=>context(person.id,conv.id).sessionId,signal:controller.signal,assertCurrent:()=>{ensureCurrent();if(closing)fail('RUN_CANCELLED','本轮角色能力已失效');},avatarResolver:async({ref,signal})=>{
        ensureCurrent();const match=/^([^#]+)#(0|[1-9][0-9]*)$/.exec(ref);if(!match)fail('LOCAL_ROLE_AVATAR_INVALID','使用本轮图片的 消息ID#内容索引');
        const source=frozenMessages.find(message=>message.id===match[1]),block=source?.blocks?.[Number(match[2])];
        const file=block?.type==='image'&&/^\/media-local\/([a-f0-9]{64}\.(png|jpg|gif|webp))$/.exec(block.url??'');
        if(!file)fail('LOCAL_ROLE_AVATAR_INVALID','头像须来自本轮可见的本地图片');
        await mediaFor(person.id).readStored(file[1],{signal,maxBytes:32*1024*1024});ensureCurrent();return {url:block.url};
      }});
      roleBindings=await createLocalRoleMcpBinding({port:rolePort,signal:controller.signal});ensureCurrent();
      if(roleBindings){for(const [name,handler]of Object.entries(roleBindings.handlers)){if(Object.hasOwn(toolHandlers,name))fail('LOCAL_ROLE_TOOL_CONFLICT','角色工具名称冲突');toolHandlers[name]=handler;}developerPrompt+="\n\n"+roleBindings.skill;}
      // QQ private conversations must produce a visible reply. Keep a hidden
      // rejection path for stale/forged callbacks, but never advertise this tool
      // through Object.keys (the runtime admission list), schemas or termination.
      const qqPrivate=conv.channel!=='desktop'&&conv.channelTarget?.platform==='qq'&&(conv.channelTarget.kind==='private'||(conv.channelTarget.kind===undefined&&conv.kind==='direct'));
      if(qqPrivate)Object.defineProperty(toolHandlers,TOOL_NAMES.noReply,{enumerable:false,writable:false,configurable:false,value:async()=>{ensureCurrent();fail('tool.disabled','QQ 私聊不支持 no_reply，请使用 send_message 回复');}});
      for(const name of Object.keys(toolHandlers))if(!intrinsicRoleTools.has(name)&&promptHead({characterId:person.id,scope:'tool',name:toolConfigName(name)})?.metadata?.enabled===false)delete toolHandlers[name];
      const toolDefinitions=Object.keys(toolHandlers).map(name=>{const entry=promptHead({characterId:person.id,scope:'tool',name:toolConfigName(name)});return {name,...(INTERACTION_TOOLS[name]?INTERACTION_TOOLS[name]:{}),...(CLIENT_WEB_PARAMETERS[name]?{parameters:CLIENT_WEB_PARAMETERS[name]}:{}),...(name==='suna_read_attachment'?{parameters:CONTROLLED_READER_SCHEMA,terminate:false}:{}),...(name==='preview_workspace'?{parameters:WORKSPACE_PREVIEW_PARAMETERS,terminate:false}:{}),...(name==='read_message_image'?{parameters:{type:'object',properties:{ref:{type:'string',pattern:'^suna-media://[a-f0-9]{48}$'}},required:['ref'],additionalProperties:false},terminate:false}:{}),...(toolServices.characterLibrary&&EMOJI_TOOL_PARAMETERS[name]?{parameters:EMOJI_TOOL_PARAMETERS[name]}:{}),description:(entry?.content??(name==='suna_read_attachment'?'按需读取本轮明确提供ref的附件。image读取支持图片的安全衍生像素，成功后仅下一次本轮模型调用可见；text用于UTF-8文字，bytes返回base64片段，单次最多262144字节。不接受路径、URL、角色或其他会话附件；二进制格式不保证可解析。':name==='preview_workspace'?WORKSPACE_PREVIEW_DESCRIPTION:name==='read_message_image'?'手动读取本轮群聊上下文中的图片引用。仅传入 suna-media:// 链接作为 ref，成功后图片像素仅提供给下一次本轮模型调用；不能读取其他会话或任意路径。':name))+(name==='screenshot'?' 一次采集所有已连接显示器的完整画面，按屏幕标识分别提供临时图片；主屏在前，其余屏幕按标识排序。任一屏幕无法完整采集时整次失败，不返回部分屏幕。':'')+(toolServices.characterLibrary?(name==='send_message'?(toolHandlers.list_emojis?' 可使用 list_emojis 获取当前角色表情包，再用 emojiId 发送；也可提供 content 文字。':' 可使用当前角色表情包的 emojiId 发送；也可提供 content 文字。'):name==='list_emojis'?' 搜索当前角色表情包，返回可供 send_message 使用的 emojiId（条目的 id）。':''):''),...(entry?.metadata?.terminate!==undefined?{terminate:entry.metadata.terminate}:{})};});
      for(const definition of pluginBindings?.definitions??[]){const target=toolDefinitions.find(tool=>tool.name===definition.name);if(target)Object.assign(target,definition,{terminate:false});}
      for(const definition of roleBindings?.definitions??[]){const target=toolDefinitions.find(tool=>tool.name===definition.name);if(target)Object.assign(target,definition,{terminate:false});}
      const pluginPermissionIds=new Map((pluginBindings?.definitions??[]).map(tool=>[tool.name,tool.permissionId]));
      for(const definition of toolDefinitions){if(INTERACTION_TOOLS[definition.name]){definition.terminate=false;definition.parameters=INTERACTION_TOOLS[definition.name].parameters;}if(definition.name==='send_message')definition.description=withSemanticBubbleRules(definition.description);if(definition.name===TOOL_NAMES.addUserProfile){definition.parameters=ADD_USER_PROFILE_PARAMETERS;definition.terminate=false;}definition.perCallTermination=definition.name==='send_message';definition.description=toolTerminationDescription(definition);}
      const terminationRules=toolTerminationSystemRules(toolDefinitions);if(terminationRules)prompt+=`\n\n${terminationRules}`;
      prompt=withPersonProfileContext(withPrimaryUserRules(withGroupReplyStyleRules(withSemanticBubbleRules(prompt),conv)),profileContext);
      for(const [name,handler] of Object.entries(toolHandlers))toolHandlers[name]=async(args,execution)=>{ensureCurrent();if(execution?.authorityRestricted)restrictAuthority();if(!intrinsicRoleTools.has(name)&&managedTool(pluginPermissionIds.get(name)??toolConfigName(name))){const grant=toolPermission(pluginPermissionIds.get(name)??name,character(person.id),conversation(conv.id),trigger,authorityRestricted);if(permissionController.signal.aborted)grant.allowed=false;log('permission.checked',{runId:run.id,toolCallId:id('check'),name,allowed:grant.allowed});if(!grant.allowed)fail('permission.denied','当前角色或渠道不允许使用此工具');}if(!intrinsicRoleTools.has(name)&&promptHead({characterId:person.id,scope:'tool',name:toolConfigName(name)})?.metadata?.enabled===false)fail('tool.disabled','工具已停用');const toolCallId=id('tool'),started=Date.now();log('tool.started',{runId:run.id,toolCallId,name,input:name==='suna_read_attachment'?{mode:args?.mode,offset:args?.offset,length:args?.length}:args});try{const result=await handler(args,execution);if(execution?.authorityRestricted)restrictAuthority();ensureCurrent();if(!intrinsicRoleTools.has(name)&&managedTool(pluginPermissionIds.get(name)??toolConfigName(name))&&(permissionController.signal.aborted||!toolPermission(pluginPermissionIds.get(name)??name,character(person.id),conversation(conv.id),trigger,authorityRestricted).allowed))fail('permission.denied','工具执行期间权限已改变');log('tool.completed',{runId:run.id,toolCallId,name,output:name==='suna_read_attachment'?{size:result?.size,offset:result?.offset,length:result?.length,eof:result?.eof,sha256:result?.sha256}:result,durationMs:Date.now()-started});return result;}catch(error){if(!closed&&!controller.signal.aborted&&controllers.get(run.id)?.controller===controller)log('tool.failed',{runId:run.id,toolCallId,name,error:error.message,durationMs:Date.now()-started},'error');throw error;}};
      run.promptRevisions={system:head?.revision,dev:devHead?.revision,user_input:inputHead?.revision};
      let requestLogged=false,preparingInput=false,inputPrepared=false;
      const logRequest=()=>{if(requestLogged||preparingInput)return;requestLogged=true;log('request.started',{runId:run.id,characterId:person.id,conversationId:conv.id,prompt,developerPrompt,inputPrompt,toolDefinitions,promptRevisions:run.promptRevisions,contextId:ctx.contextId});};
      const prepareInput=async({limits,measure,signal})=>{
        if(inputPrepared||preparingInput)fail('RUN_INPUT_ALREADY_PREPARED','本轮输入已准备');
        preparingInput=true;
        const inputSignal=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
        const assertImages=()=>{ensureCurrent();if(closing||authorityRestricted||!conversation(conv.id).participantIds.includes(person.id))fail('RUN_CANCELLED','本轮会话图片访问已失效');};
        preparedInput=await prepareRunInput({messages:frozenMessages,protectedMessageIds:[...new Set([trigger.id,...run.triggerIds,...(trigger.batchSourceIds??[])])].filter(sourceId=>(trigger.kind!=='ttm'||sourceId!==trigger.id)&&(conv.channel==='desktop'||conv.kind!=='group'||frozenMessages.some(message=>message.id===sourceId))),limits,measure,signal:inputSignal,assertCurrent:ensureCurrent,
          ...(conv.channel!=='desktop'&&conv.kind==='group'?{historyMaxMessages:channelPolicy(conv).historyLimit,historyMaxTokens:limits?.text?.maxInputTokens}:{}),
          render:messages=>{const projectedVariables={...variablesFor(person.id,conv.id,trigger,messages,attachmentReader),'memory.user_profile':profileContext},rendered=assembleClientRuntimePrompts({system:head?.content??BASE_PROMPT,developer:devHead?.metadata?.enabled===true&&devHead.metadata.developerSource!=='dsh-original'?devHead.content:'',input:inputHead?.content??'{{user_input}}',variables:projectedVariables});if(roleBindings)rendered.developerPrompt+='\n\n'+roleBindings.skill;if(terminationRules)rendered.prompt+=`\n\n${terminationRules}`;rendered.prompt=withPersonProfileContext(withPrimaryUserRules(withGroupReplyStyleRules(withSemanticBubbleRules(rendered.prompt),conv)),profileContext);if(conv.channel!=='desktop'&&conv.kind==='group')rendered.inputPrompt=withGroupDecisionContext(withChannelGroupInput(rendered.inputPrompt,{messages,trigger,characterId:person.id,projectSender:message=>injectedSender(person.id,message,conv.id)}),run.groupDecisionContext??[]);if(run.desktopModeratorRoundId)rendered.inputPrompt=withDesktopModeratorInput(rendered.inputPrompt,{messages,trigger,characterId:person.id,limit:run.desktopModeratorHistoryLimit,projectSender:message=>injectedSender(person.id,message,conv.id)});rendered.inputPrompt=withA2aHistoryInput(rendered.inputPrompt,messages,trustedA2aMarker,a2aUsesRecent);return rendered;},
          ...(!(conv.channel!=='desktop'&&conv.kind==='group')&&!testMode&&trigger.kind!=='ttm'&&!trigger.source?.pluginId?{images:{characterId:person.id,conversationId:conv.id,maxSequence:trigger.sequence,readStored:(relative,options)=>mediaFor(person.id).readStored(relative,options),assertCurrent:assertImages}}:{})});
        ensureCurrent();inputSignal.throwIfAborted();
        const fileAttachments=[...new Map(composerFileSources(conv,trigger,preparedInput.messages).flatMap(source=>source.attachments).map(item=>[item.id,item])).values()];
        if(attachmentReader?.descriptors.length){const preparedMeasure=Number(await measure({prompt:preparedInput.prompt,developerPrompt:preparedInput.developerPrompt??'',inputPrompt:preparedInput.inputPrompt,messages:preparedInput.messages})),availableReadBytes=Number.isFinite(preparedMeasure)?Math.max(0,(limits?.text?.maxInputTokens??0)-preparedMeasure):0;
        attachmentReader?.setBudget({maxOutputBytes:Math.min(64*1024,Math.max(0,Math.floor((limits?.text?.maxInputTokens??0)/4)),Math.floor(availableReadBytes/2)),maxCalls:16});}
        attachmentReader?.retain(fileAttachments.map(a=>a.id));
        if(fileAttachments.length){if(typeof composerAttachments?.materializeForRun!=='function')fail('MESSAGE_ATTACHMENTS_UNAVAILABLE','当前服务无法准备会话文件');await composerAttachments.materializeForRun({conversationId:conv.id,attachments:fileAttachments,workspace:workspaceFor(person.id),signal:inputSignal});ensureCurrent();inputSignal.throwIfAborted();}
        frozenMessages=preparedInput.messages;groupMediaPort?.retainMessages(frozenMessages.map(message=>message.id));variables={...variablesFor(person.id,conv.id,trigger,frozenMessages,attachmentReader),'memory.user_profile':profileContext};prompt=preparedInput.prompt;developerPrompt=preparedInput.developerPrompt;inputPrompt=preparedInput.inputPrompt;messageImageAccess=preparedInput.messageImageAccess;inputPrepared=true;preparingInput=false;logRequest();
        return {messages:a2aTransportMessages(frozenMessages,trustedA2aMarker),prompt,developerPrompt,inputPrompt,messageImageAccess,retainedMessageIds:preparedInput.retainedMessageIds,protectedMessageIds:preparedInput.protectedMessageIds};
      };
      let inputAdmitted=false;
      const admitInput=event=>{
        if(preparingInput||controller.signal.aborted||closed||controllers.get(run.id)?.controller!==controller||inputAdmitted||event.type!=='input-admitted'||event.contextId!==ctx.contextId||event.inputDigest!==fingerprint(inputPrompt)||!event.messageId||!event.sessionId)return;
        const current=read('context',ctx.id);
        if(!current||current.contextId!==ctx.contextId)return;
        inputAdmitted=true;controllers.get(run.id).directInputReady=true;directInputs.event(event,run);directInputs.wake(conv.id);run.admissionId=event.messageId;run.admittedSourceIds=presentedSourceIds;groupDispatch.markAdmitted(run.id,{admissionId:event.messageId,sourceIds:presentedSourceIds});saveRun(run);
        put('context',ctx.id,{...current,baselineContextId:ctx.contextId,stateFingerprint:fingerprint(variables.state),memoryFingerprint:fingerprint(variables.work_memory),stateVersion:person.stateVersion??1,memoryVersion:person.memoryVersion??0,lastMessageId:trigger.id,admittedMessageId:event.messageId,sessionId:event.sessionId});
      };
      const result=await awaitRuntime(()=>runtime.run({runId:run.id,character:person,developerPromptSource:devHead?.metadata?.enabled===true?devHead.metadata.developerSource:undefined,developerPromptExtras:roleBindings?[roleBindings.skill]:[],...(!testMode?{runtimePermissionPreset:runtimePermissions.selection(person.id).preset,runtimePermissionExplicit:runtimePermissions.selection(person.id).explicit,...(()=>{const instruction=runtimeReviewInstructionFor({character:character(person.id),conversation:conversation(conv.id),trigger,restricted:authorityRestricted,testMode,isAdministrator:input=>permissionChannelStatus(undefined,person.id,input.conversation).ready===true&&channels?.isAdministrator?.(input)===true});return instruction?{runtimeReviewInstruction:instruction}:{};})()}:{}),conversation:conv,messages:a2aTransportMessages(frozenMessages,trustedA2aMarker),prompt,developerPrompt,inputPrompt,prepareInput,...(trigger.source?.pluginId?{inputSource:{kind:'suna-ttuf',pluginId:trigger.source.pluginId,deliveryId:trigger.source.deliveryId}}:frozenMessages.some(trustedA2aMarker)||run.desktopModeratorRoundId?{...(frozenMessages.some(trustedA2aMarker)?{a2aFacts:true}:{}),inputSource:{kind:'suna-context'}}:{}),toolDefinitions,contextId:ctx.contextId,...(imageAccess?{imageAccess}:{}),...(messageImageAccess?{messageImageAccess}:{}),...(manualMessageAccess?{manualMessageAccess}:{}),runtimeNative:{signal:runtimeNative.signal,confirmed:!runtimePermissions.selection(person.id).confirmationRequired},provider:person.provider,model:person.model,signal:controller.signal,authority,route:run.route,testMode,workspace:workspaceFor(person.id),terminalTools:Object.keys(toolHandlers).filter(name=>!INTERACTION_TOOLS[name]&&promptHead({characterId:person.id,scope:'tool',name:toolConfigName(name)})?.metadata?.terminate===true),tools:toolHandlers,onAuthorityRestricted:restrictAuthority,onEvent:event=>{if(event?.type==='input-admitted')logRequest();if(event?.type==='model-call'){collectRuntimeCall(event.call);return;}if(!closed&&!controller.signal.aborted&&controllers.get(run.id)?.controller===controller){admitInput(event);if(event?.contextId===ctx.contextId&&event.type?.startsWith('user-input-'))directInputs.event(event,run);recordPluginTTMEvent(event);log('runtime.event',{runId:run.id,event});}}}));
      logRequest();for(const call of result?.modelCalls??[])collectRuntimeCall(call);
      ensureCurrent();
      if(!hasReply&&!declined)fail('NO_VISIBLE_OUTPUT','运行结束，但角色没有通过 send_message 发送消息');
      run.status=declined&&!hasReply?'silent':'completed';run.sessionId=result?.sessionId;if(result?.sessionId){const current=read('context',ctx.id);if(current?.contextId===ctx.contextId)put('context',ctx.id,{...current,sessionId:result.sessionId});}
      if(result?.text)log('runtime.internal_output',{runId:run.id,text:result.text});
    }catch(error){
      clearTimeout(timeout);
      for(const call of error?.modelCalls??[])collectRuntimeCall(call);
      Object.assign(run,runFailureState(error,controller.signal));
      run.error=redact(controller.signal.reason?.message??error.message);
      log(run.status==='cancelled'?'run.cancelled':'run.failed',{runId:run.id,code:run.code,error:run.error,cancelSource:controller.signal.reason?.cancelSource,cancelReason:controller.signal.reason?.cancelReason},run.status==='cancelled'?'info':'error');
      const current=conversation(conv.id);put('conversation',conv.id,{...current,lastError:run.status==='failed'?run.error:null});
      if(run.status==='failed'&&!['DELIVERY_UNCERTAIN','RUN_SHUTDOWN','RUN_POLICY_CHANGED','RUN_PERMISSION_REVOKED'].includes(run.code)&&!closing&&!closed&&!testMode&&['direct','directed'].includes(run.route)&&trigger.kind!=='ttm'&&trigger.sender?.type==='human'&&runAllowed(run)&&conversation(conv.id).participantIds.includes(person.id)){
        const noticeController=new AbortController(),active=controllers.get(run.id);
        if(active)active.noticeController=noticeController;
        const noticeTimer=setTimeout(()=>noticeController.abort(new BookError('DELIVERY_UNCERTAIN','错误通知投递未确认')),Math.max(10,Math.min(60000,Number(failureNoticeTimeoutMs)||15000)));
        noticeTimer.unref?.();
        try{
          // Finish or observe existing sends first. Never resend an uncertain
          // delivery; only a positively delivered explicit progress message is
          // safe to follow with the final failure notice.
          await settleAfterAbort(Promise.allSettled([...sendTasks.values()].filter(task=>task.runId===run.id).map(task=>task.promise)),noticeController.signal);
          noticeController.signal.throwIfAborted();
          const existing=list('outbox-task').find(task=>task.runId===run.id&&!(task.completionKind==='progress'&&task.status==='completed'&&task.published_message_ids?.length&&task.published_message_ids.every(messageId=>{const row=db.prepare('SELECT payload FROM messages WHERE id=?').get(messageId);return row&&JSON.parse(row.payload).status==='delivered';})));
          if(existing)run.failureNotice={status:'suppressed',reason:'existing_delivery',taskId:existing.id};
          else if(!closing&&!closed&&runAllowed(run)&&conversation(conv.id).participantIds.includes(person.id)){
            const receipt=await enqueueSend({person,conv:conversation(conv.id),run,trigger,args:{content:runFailureNotice(error,run.code),idempotencyKey:'system-error'},signal:noticeController.signal,systemError:{code:run.code}});
            await settleAfterAbort(sendTasks.get(receipt.task_id)?.promise,noticeController.signal);
            const delivery=getSendTask(receipt.task_id);
            run.failureNotice={taskId:delivery.task_id,status:delivery.status,...(delivery.error_code?{code:delivery.error_code}:{})};
          }
        }catch(noticeError){
          const prior=list('outbox-task').find(task=>task.runId===run.id&&task.systemError);
          run.failureNotice={...(prior?{taskId:prior.id}:{}),status:'failed',code:typeof noticeError.code==='string'?noticeError.code:'SEND_FAILED'};
          if(noticeController.signal.reason?.code==='DELIVERY_UNCERTAIN')for(const task of sendTasks.values())if(task.runId===run.id)task.controller.abort(noticeController.signal.reason);
        }finally{clearTimeout(noticeTimer);}
        if(run.failureNotice)log('run.failure_notice',{runId:run.id,...run.failureNotice},run.failureNotice.status==='failed'?'error':'info');
      }
    }
    finally{clearTimeout(timeout);attachmentReader?.dispose();preparedInput?.dispose();groupMediaPort?.dispose();await pluginBindings?.dispose();await roleBindings?.dispose();runtimeNative.abort();controller.signal.removeEventListener('abort',abortPermissions);for(const screenRun of screenRuns){screenClaims.delete(screenRun);toolServices.screenAccess?.releaseRun?.(screenRun);}await Promise.allSettled([...sendTasks.values()].filter(task=>task.runId===run.id).map(task=>task.promise));const failed=list('outbox-task').find(task=>task.runId===run.id&&['failed','cancelled'].includes(task.status));if(controller.signal.aborted){Object.assign(run,runFailureState(controller.signal.reason,controller.signal));run.error=redact(controller.signal.reason?.message??run.error);}else if(failed&&run.status!=='failed'){run.status='failed';run.error=failed.error;run.code=failed.error_code;}finishPreviewRun(run);controllers.delete(run.id);directInputs.finish(run,{definitive:!controller.signal.aborted&&['completed','silent'].includes(run.status)&&quarantines.get(runKey)?.runId!==run.id});run.finishedAt=clock();if(!closed){groupDispatch.transition(run.id,run.status,run.code??null);groupDispatch.releaseUnstartedAutoTurn(run.id);const current=conversation(conv.id),runOutcomes={...current.runOutcomes,[person.id]:{runId:run.id,status:run.status,finishedAt:run.finishedAt,...(run.status==='failed'?{error:run.error}:{} )}},failures=Object.values(runOutcomes).filter(outcome=>outcome.status==='failed');put('conversation',conv.id,{...current,runOutcomes,lastRunStatus:failures.length?'failed':run.status,lastRunAt:run.finishedAt,lastError:failures.map(outcome=>outcome.error).filter(Boolean).join('；')||null});saveRun(run);}}
    return run;
  }
  function roleEligible(trigger,characterId,route,lease=trigger.replyLeases?.[characterId]){
    const conv=conversation(trigger.conversationId),roleMap=trigger.roleEligibility;
    if(roleMap){if(!Object.hasOwn(roleMap,characterId)||roleMap[characterId]!==true)return false;}
    else if(trigger.dispatchEligible===false)return false;
    if(trigger.dispatchCharacterIds&&!trigger.dispatchCharacterIds.includes(characterId)&&trigger.dispatchAmbientEligible!==true&&trigger.channelDirectSupplement!==true)return false;
    if(route==='ambient'&&(trigger.dispatchAmbientEligible===false||!ambientTriggerAllowed(trigger)))return false;
    return conv.participantIds.includes(characterId)&&replyAllowed(conv,automaticTrigger(trigger),route)&&characterReplyAllowed(conv,characterId,automaticTrigger(trigger),lease);
  }
  function rootFor(trigger){
    if(trigger.sender.type==='human')return trigger.id;
    if(trigger.groupRootId)return trigger.groupRootId;
    const row=db.prepare("SELECT id FROM messages WHERE conversation_id=? AND sequence<=? AND json_extract(payload,'$.sender.type')='human' ORDER BY sequence DESC LIMIT 1").get(trigger.conversationId,trigger.sequence);
    return row?.id??`role-only:${trigger.conversationId}`;
  }
  function admitRole(trigger,characterId,route){
    const conv=conversation(trigger.conversationId),lease=trigger.replyLeases?.[characterId]??(automaticTrigger(trigger)&&typeof channels?.replyLease==='function'?channels.replyLease({conversation:conv,character:character(characterId)}):undefined);
    const eligible=roleEligible(trigger,characterId,route,lease);
    return groupDispatch.admit({conversationId:trigger.conversationId,characterId,sourceId:trigger.id,eligible,route,automatic:automaticTrigger(trigger),rootId:rootFor(trigger),reason:eligible?null:'reply_not_eligible',replyLease:lease});
  }
  function ambientTriggerAllowed(trigger){
    const conv=conversation(trigger.conversationId);if(conv.channel==='desktop'||conv.kind!=='group')return true;
    const policy=channelPolicy(conv);if(trigger.channelWatch===true)return policy.enabled!==false;return trigger.sender.type==='human'?policy.humanMessages:trigger.sender.type==='character'?policy.characterMessages:false;
  }
  function scheduleAmbient(trigger,onlyIds){
    const conv=conversation(trigger.conversationId);if(conv.kind!=='group')return;
    // The moderator consumes real role outputs itself; never start a second legacy loop.
    if(isDesktopModeratedGroup(conv)&&trigger.sender.type==='character')return;
    if(conv.channel!=='desktop'){
      const offeredAt=(channelSchedulerTimers.now??Date.now)();
      for(const characterId of onlyIds??conv.participantIds){channelScheduler.observe({characterId,conversationId:conv.id,offeredAt});if(trigger.sender.type==='character'&&trigger.sender.id===characterId)continue;offerChannelRole(trigger,characterId,{observe:false,offeredAt});}
      return;
    }
    const offeredAt=Date.now();
    for(const characterId of onlyIds??conv.participantIds){
      if(trigger.sender.type==='character'&&trigger.sender.id===characterId)continue;
      const admission=admitRole(trigger,characterId,'ambient');
      if(admission.admitted)groupScheduler.offer({characterId,conversationId:conv.id,trigger,offeredAt});
    }
  }
  function pendingDecisionSources(job){
    const conv=conversation(job.conversationId);
    return job.triggerIds.filter(sourceId=>{
      const entry=groupDispatch.get(conv.id,job.characterId,sourceId);
      if(entry?.state!=='pending')return false;
      const lease=entry.reply_lease===null?undefined:JSON.parse(entry.reply_lease);
      if(roleEligible(job.trigger,job.characterId,'ambient',lease))return true;
      groupDispatch.cancel({conversationId:conv.id,characterId:job.characterId,sourceIds:[sourceId],reason:'eligibility_changed'});return false;
    });
  }
  function invalidateGroupDecision(conversationId,{requeue=false}={}){
    const active=groupDecisions.get(conversationId);if(!active)return;
    groupDecisions.delete(conversationId);
    active.controller.abort(Object.assign(new BookError('GROUP_DECISION_STALE','群聊参与判断已失效'),{cancelSource:'policy'}));
    try{active.onInvalidate?.();}catch{log('scheduler.moderator.cleanup.failed',{conversationId},'warn');}
    if(requeue&&!active.desktopModerated&&!closing&&!closed)for(const job of active.jobs){
      const triggerIds=pendingDecisionSources(job);
      if(triggerIds.length){
        if(conversation(job.conversationId).channel==='desktop')groupScheduler.offer({...job,triggerIds});
        else {const trigger=triggerIds.map(key=>{const row=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND id=?').get(job.conversationId,key);return row?JSON.parse(row.payload):null;}).filter(Boolean).sort((a,b)=>b.sequence-a.sequence)[0];if(trigger)channelScheduler.requeue({...job,trigger:job.kind==='watch'?{...trigger,channelWatch:true}:trigger,triggerIds});}
      }
    }
    emit('activity.changed',{conversationId});
  }
  function finishDecisionSources(job,status,code,error,batchId,decision,decisionWindow,requestDiagnostic){
    const sourceIds=pendingDecisionSources(job);if(!sourceIds.length)return;
    const run={id:id('run'),conversationId:job.conversationId,characterId:job.characterId,triggerId:job.trigger.id,triggerIds:sourceIds,route:'ambient',automatic:automaticTrigger(job.trigger),status,code,...(error?{error}:{}),stage:'group_scheduler',groupDecisionId:batchId,...(requestDiagnostic?{decisionRequest:clone(requestDiagnostic)}:{}),createdAt:clock(),finishedAt:clock()};
    transaction(()=>{run.triggerIds=groupDispatch.claim({conversationId:job.conversationId,characterId:job.characterId,sourceIds,runId:run.id,route:'ambient'});if(run.triggerIds.length){groupDispatch.transition(run.id,status,code);saveRun(run);}});
    if(run.triggerIds.length){const current=conversation(job.conversationId),runOutcomes={...current.runOutcomes,[job.characterId]:{runId:run.id,status,...(error?{error}:{}),finishedAt:run.finishedAt}},failures=Object.values(runOutcomes).filter(outcome=>outcome.status==='failed');put('conversation',current.id,{...current,lastRunStatus:failures.length?'failed':status,lastRunAt:run.finishedAt,lastError:failures.map(outcome=>outcome.error).filter(Boolean).join('；')||null,runOutcomes});}
    if(run.triggerIds.length)recordChannelSchedulerResult({characterId:job.characterId,conversationId:job.conversationId,batchId,status:status==='skipped'?'not-participating':'failed',code,decision,inputUpperSequence:decisionWindow?.upperSequence,anchorMessageId:decisionWindow?.anchorMessageId});
  }
  function waitDesktopGroupIdle(conversationId,signal){
    const busy=()=>!!db.prepare("SELECT 1 FROM runs WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1").get(conversationId);
    if(signal.aborted)return Promise.reject(signal.reason);if(!busy())return Promise.resolve();
    return new Promise((resolve,reject)=>{const cleanup=()=>{listeners.delete(changed);signal.removeEventListener('abort',abort);};const abort=()=>{cleanup();reject(signal.reason);};const changed=event=>{if(event.type==='activity.changed'&&event.conversationId===conversationId&&!busy()){cleanup();resolve();}};listeners.add(changed);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else if(!busy()){cleanup();resolve();}});
  }
  async function decideDesktopModeratedBatch(jobs,externalSignal){
    const conversationId=jobs[0].conversationId,conv=conversation(conversationId);
    if(groupDecisions.has(conversationId)){for(const job of jobs)groupScheduler.offer(job);return;}
    const initial=jobs.map(job=>({...job,triggerIds:pendingDecisionSources(job)})).filter(job=>job.triggerIds.length);
    if(!initial.length)return;
    const controller=new AbortController(),batchId=id('desktop-group-round'),modelContext=Object.freeze({}),known=new Map();
    const remember=job=>{known.set(JSON.stringify([job.characterId,job.triggerIds]),job);return job;};initial.forEach(remember);
    const rawPolicy=resolveDesktopGroupScheduler(conv.desktopGroupScheduler),numeric=resolveGroupScheduler(groupGlobalPolicy(conv),conv.scheduler),maxTurns=numeric.maxAutoTurns+1;
    const moderatorPrompt=publishedSchedulerPrompt('group_moderator');
    const policy=JSON.stringify({numeric,moderator:rawPolicy,workerPrompt:moderatorPrompt,enabled:conv.scheduler.enabled}),members=JSON.stringify(conv.participantIds),epoch=epochs.get(conversationId)??0,ambientEpoch=ambientEpochs.get(conversationId)??0;
    const latestHuman=()=>{const row=db.prepare("SELECT id FROM messages WHERE conversation_id=? AND json_extract(payload,'$.sender.type')='human' ORDER BY sequence DESC LIMIT 1").get(conversationId);return row?.id;};
    const rootId=latestHuman();
    const membershipCurrent=()=>{const latest=read('conversation',conversationId);return !!latest&&members===JSON.stringify(latest.participantIds)&&conv.participantIds.every(characterId=>!!read('character',characterId));};
    const permissionStamp=()=>JSON.stringify(conv.participantIds.map(characterId=>[characterId,previewPermissionRevision(characterId),runtimePermissions.selection(characterId).version]));const permissions=permissionStamp();
    const retire=reason=>{if(closed)return;for(const job of known.values()){const sourceIds=job.triggerIds.filter(key=>groupDispatch.get(conversationId,job.characterId,key)?.state==='pending');if(sourceIds.length)groupDispatch.cancel({conversationId,characterId:job.characterId,sourceIds,reason});}};
    const active={jobs:initial,controller,batchId,desktopModerated:true,onInvalidate:()=>retire('moderator_invalidated')};groupDecisions.set(conversationId,active);
    const current=()=>!closed&&!closing&&!controller.signal.aborted&&groupDecisions.get(conversationId)===active&&epoch===(epochs.get(conversationId)??0)&&ambientEpoch===(ambientEpochs.get(conversationId)??0)&&rootId===latestHuman()&&membershipCurrent()&&permissions===permissionStamp()&&policy===JSON.stringify({numeric:resolveGroupScheduler(groupGlobalPolicy(conversation(conversationId)),conversation(conversationId).scheduler),moderator:resolveDesktopGroupScheduler(conversation(conversationId).desktopGroupScheduler),workerPrompt:publishedSchedulerPrompt('group_moderator'),enabled:conversation(conversationId).scheduler.enabled});
    const abort=()=>controller.abort(externalSignal.reason??new BookError('GROUP_DECISION_CANCELLED','群聊主持已停止'));externalSignal?.addEventListener('abort',abort,{once:true});if(externalSignal?.aborted)abort();
    const budget=Math.min(1800000,maxTurns*(numeric.runTimeoutMs+rawPolicy.decisionTimeoutMs));
    const timer=setTimeout(()=>{controller.abort(new BookError('GROUP_DECISION_TIMEOUT','群聊主持已达到本轮时间上限'));if(!closed&&!closing)cancelAmbient(conversationId);},budget);timer.unref?.();
    let requestDiagnostic,roleFailure=false,selectionGuard;
    const checkpoint=record=>{if(!closed)put('desktop-group-round',batchId,{conversationId,rootId,createdAt:read('desktop-group-round',batchId)?.createdAt??clock(),...record,updatedAt:clock()});};
    try{
      checkpoint({id:batchId,status:'ready',turns:[]});if(typeof workerClient.createSelectionGuard==='function')selectionGuard=await workerClient.createSelectionGuard({name:'group_scheduler',signal:controller.signal});if(!current())throw new BookError('GROUP_DECISION_STALE','群聊主持批次已失效');await waitDesktopGroupIdle(conversationId,controller.signal);
      const result=await runDesktopModeratorRound({roundId:batchId,maxTurns,signal:controller.signal,isCurrent:current,onState:checkpoint,
        getCandidates:({lastSpeaker,turns})=>{
          const history=messages(conversationId,200),result=[];
          for(const characterId of conversation(conversationId).participantIds){
            if(characterId===lastSpeaker)continue;
            const pending=[...known.values()].find(job=>job.characterId===characterId&&pendingDecisionSources(job).length===job.triggerIds.length);
            if(pending){result.push(pending);continue;}
            const readThrough=Math.max(0,...turns.filter(turn=>turn.characterId===characterId).map(turn=>turn.inputUpperSequence??0));
            const trigger=history.filter(m=>m.sender?.type==='character'&&m.sender.id!==characterId&&m.groupRootId===rootId&&m.sequence>readThrough&&m.hidden!==true&&!m.deletedAt&&m.status==='delivered').at(-1);
            if(!trigger)continue;
            const admission=admitRole(trigger,characterId,'ambient');if(admission.admitted)result.push(remember({characterId,conversationId,trigger,triggerIds:[trigger.id]}));
          }
          active.jobs=[...known.values()];return result;
        },
        decide:async({step,jobs,turns})=>{
          await selectionGuard?.assertCurrent();if(!current())throw new BookError('GROUP_DECISION_STALE','群聊主持批次已失效');
          const history=messages(conversationId,rawPolicy.historyLimit);const upperSequence=history.at(-1)?.sequence??0;
          for(const job of jobs)job.desktopInputUpperSequence=upperSequence;
          const decision=await decideDesktopModerator({workerPrompt:moderatorPrompt,workerClient,conversationId,roundId:batchId,step,candidates:jobs.map(job=>({characterId:job.characterId,name:character(job.characterId).name})),history,previousTurns:turns,policy:rawPolicy,modelContext,signal:controller.signal,isCurrent:current,onTelemetry:record=>recordUsageCall(record,{conversationId,roundId:batchId,stage:'group_scheduler'}),onDiagnostic:record=>{requestDiagnostic=record;if(!closed)log('scheduler.moderator.request',{conversationId,batchId,...record});}});
          await selectionGuard?.assertCurrent();if(!current())throw new BookError('GROUP_DECISION_STALE','群聊主持批次已失效');return decision;
        },
        dispatch:async job=>{
          await selectionGuard?.assertCurrent();
          if(!current()||pendingDecisionSources(job).length!==job.triggerIds.length)throw new BookError('GROUP_DECISION_STALE','群聊主持批次已失效');
          const run=await scheduleRun(job.characterId,job.trigger,'ambient',job.triggerIds,batchId,{...job,desktopModerated:true});roleFailure=!!run&&!['completed','silent','skipped'].includes(run.status);return run;
        }
      });
      if(current())for(const job of known.values())finishDecisionSources(job,'skipped','GROUP_DECISION_SILENT',undefined,batchId);
      return result;
    }catch(error){
      if(!current()||error?.code==='WORKER_CLIENT_SELECTION_CHANGED'||roleFailure)retire('moderator_stopped');
      else{for(const job of known.values())finishDecisionSources(job,'failed',error.code??'GROUP_DECISION_FAILED',redact(error.message??'群聊主持失败'),batchId,undefined,undefined,requestDiagnostic);log('scheduler.moderator.failed',{conversationId,batchId,code:error.code??'GROUP_DECISION_FAILED'},'error');}
    }finally{clearTimeout(timer);externalSignal?.removeEventListener('abort',abort);if(groupDecisions.get(conversationId)===active)groupDecisions.delete(conversationId);if(!closed){groupScheduler.reconfigure(conversationId);emit('activity.changed',{conversationId});}}
  }

  async function decideAmbientBatch(jobs,externalSignal){
    const conversationId=jobs[0].conversationId;
    if(isDesktopModeratedGroup(conversation(conversationId)))return decideDesktopModeratedBatch(jobs,externalSignal);
    if(groupDecisions.has(conversationId)){for(const job of jobs){if(conversation(conversationId).channel==='desktop')groupScheduler.offer(job);else channelScheduler.requeue(job);}return;}
    let eligible=jobs.map(job=>({...job,triggerIds:pendingDecisionSources(job)})).filter(job=>job.triggerIds.length);
    const conv=conversation(conversationId);
    if(!eligible.length)return;
    if(conv.channel!=='desktop')eligible=eligible.map(job=>({...job,replyAnchorId:job.trigger.id}));
    const controller=new AbortController(),batchId=id('group-decision');
    const decisionPolicy=groupDecisionPolicy(conv);
    const policy=JSON.stringify({numeric:resolveGroupScheduler(groupGlobalPolicy(conv),conv.scheduler),decision:decisionPolicy});
    const membership=JSON.stringify(conv.participantIds),epoch=epochs.get(conversationId)??0,automaticEpoch=automaticEpochs.get(conversationId)??0,ambientEpoch=ambientEpochs.get(conversationId)??0;
    const active={jobs:eligible,controller,batchId};let requestDiagnostic;groupDecisions.set(conversationId,active);
    const cancelDecision=()=>controller.abort(Object.assign(new BookError('GROUP_DECISION_STALE','群聊参与判断已失效'),{cancelSource:'policy'}));externalSignal?.addEventListener('abort',cancelDecision,{once:true});if(externalSignal?.aborted)cancelDecision();
    const upperSequence=conv.channel==='desktop'?Math.max(...eligible.map(job=>job.trigger.sequence)):messages(conversationId,1).at(-1)?.sequence??0;
    const sourceIds=[...new Set(eligible.flatMap(job=>job.triggerIds))];
    const sourceMessages=sourceIds.map(sourceId=>{const row=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND id=?').get(conversationId,sourceId);return row?JSON.parse(row.payload):null;});
    const current=()=>!closed&&!closing&&!controller.signal.aborted&&groupDecisions.get(conversationId)===active&&epoch===(epochs.get(conversationId)??0)&&automaticEpoch===(automaticEpochs.get(conversationId)??0)&&ambientEpoch===(ambientEpochs.get(conversationId)??0)&&membership===JSON.stringify(conversation(conversationId).participantIds)&&policy===JSON.stringify({numeric:resolveGroupScheduler(groupGlobalPolicy(conversation(conversationId)),conversation(conversationId).scheduler),decision:groupDecisionPolicy(conversation(conversationId))})&&eligible.every(job=>pendingDecisionSources(job).length===job.triggerIds.length);
    emit('activity.changed',{conversationId});
    try{
      const decisionHistory=conv.channel==='desktop'?messages(conversationId,100).filter(message=>message.sequence<=upperSequence):db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND sequence<=? ORDER BY sequence ASC').all(conversationId,upperSequence).map(row=>JSON.parse(row.payload));
      const decisionWindow=conv.channel==='desktop'?undefined:selectGroupDecisionWindow(decisionHistory,{conversationId,anchorIds:sourceIds,upperSequence});
      const decision=await decideGroupParticipation({workerClient,conversationId,batchId,...(decisionPolicy?{prompt:decisionPolicy.decisionPrompt,workerPrompt:decisionPolicy.workerPrompt,timeoutMs:decisionPolicy.decisionTimeoutMs,maxRetries:decisionPolicy.decisionRetryCount}:{}),sourceMessages,candidates:eligible.map(job=>({characterId:job.characterId,name:character(job.characterId).name,sourceIds:job.triggerIds})),history:decisionHistory,...(decisionWindow?{decisionWindow}:{}),signal:controller.signal,isCurrent:current,onRetry:record=>{if(!closed)log('scheduler.decision.retry',{conversationId,batchId,...record});},onTelemetry:record=>recordUsageCall(record,{conversationId,roundId:batchId,stage:'group_scheduler'}),onDiagnostic:record=>{requestDiagnostic=record;if(!closed)log('scheduler.decision.request',{conversationId,batchId,...record});}});
      if(!current()){if(groupDecisions.get(conversationId)===active)invalidateGroupDecision(conversationId,{requeue:true});return;}
      const selected=new Set(decision.characterIds),details=new Map((decision.decisions??[]).map(item=>[item.characterId,item]));
      const dispatched=[];
      // No await between validation and synchronous claims; each scheduleRun
      // revalidates its immutable outlet lease and sources before enqueueing.
      for(const job of eligible){
        if(selected.has(job.characterId)){recordChannelSchedulerResult({characterId:job.characterId,conversationId,batchId,status:'participating',decision:details.get(job.characterId),inputUpperSequence:decisionWindow?.upperSequence,anchorMessageId:decisionWindow?.anchorMessageId});dispatched.push(scheduleRun(job.characterId,job.trigger,'ambient',job.triggerIds,batchId,job).catch(error=>log('scheduler.failed',{code:error.code??'GROUP_RUN_FAILED'},'error')));}
        else finishDecisionSources(job,'skipped','GROUP_DECISION_SILENT',undefined,batchId,details.get(job.characterId),decisionWindow);
      }
      // Retain the group batch while its selected roles finish. Otherwise a
      // fast/unselected role could trigger another decision before its peer
      // leaves the role queue, charging separately for the same next batch.
      await Promise.allSettled(dispatched);
    }catch(error){
      if(!current()){if(groupDecisions.get(conversationId)===active)invalidateGroupDecision(conversationId,{requeue:true});return;}
      const code=error.code??'GROUP_DECISION_FAILED',message=redact(error.message??'群聊参与判断失败');
      for(const job of eligible)finishDecisionSources(job,'failed',code,message,batchId,undefined,undefined,requestDiagnostic);
      log('scheduler.decision.failed',{conversationId,batchId,code},'error');
    }finally{
      externalSignal?.removeEventListener('abort',cancelDecision);
      if(groupDecisions.get(conversationId)===active)groupDecisions.delete(conversationId);
      if(!closed){schedulerFor(conv).reconfigure(conversationId);emit('activity.changed',{conversationId});}
    }
  }
  function scheduleRun(characterId,trigger,route,triggerIds=[trigger.id],groupDecisionId,channelJob){
    const conv=conversation(trigger.conversationId);if(!conversationIsActive(conv))return Promise.resolve(null);const existing=groupDispatch.get(conv.id,characterId,trigger.id);
    if(existing&&existing.state!=='pending'){
      const row=existing.run_id&&db.prepare('SELECT payload FROM runs WHERE id=?').get(existing.run_id);
      return Promise.resolve(row?JSON.parse(row.payload):null);
    }
    if(!existing&&!admitRole(trigger,characterId,route).admitted)return Promise.resolve(null);
    const savedAdmission=groupDispatch.get(conv.id,characterId,trigger.id),admittedLease=savedAdmission?.reply_lease===null||savedAdmission?.reply_lease===undefined?undefined:JSON.parse(savedAdmission.reply_lease);
    if(!roleEligible(trigger,characterId,route,admittedLease)){
      groupDispatch.cancel({conversationId:conv.id,characterId,sourceIds:triggerIds,reason:'eligibility_changed'});return Promise.resolve(null);
    }
    const pending=route==='direct'&&conv.channel==='desktop'?groupScheduler.take(characterId,conv.id):null;
    let sourceIds=[...new Set([...(pending?.triggerIds??[]),...triggerIds])].filter(sourceId=>{
      const source=groupDispatch.get(conv.id,characterId,sourceId);
      if(!source||source.state!=='pending')return false;
      const lease=source.reply_lease===null?undefined:JSON.parse(source.reply_lease);
      if(characterReplyAllowed(conv,characterId,source.automatic===1,lease))return true;
      groupDispatch.cancel({conversationId:conv.id,characterId,sourceIds:[sourceId],reason:'account_lease_expired'});return false;
    });
    if(conv.channel!=='desktop'&&conv.kind==='group'&&trigger.kind!=='ttm'){const visible=new Set(runMessages(conv.id,{...trigger,sequence:messages(conv.id,1).at(-1)?.sequence??trigger.sequence,strictInputUpperSequence:true}).map(message=>message.id)),expired=sourceIds.filter(key=>!visible.has(key));if(expired.length)groupDispatch.cancel({conversationId:conv.id,characterId,sourceIds:expired,reason:'history_window_expired'});sourceIds=sourceIds.filter(key=>visible.has(key));}
    const replyLease=admittedLease;
    const run={id:id('run'),conversationId:conv.id,characterId,triggerId:trigger.id,triggerIds:sourceIds,route,...(channelJob?.batchId?{channelBatchId:channelJob.batchId,channelBatchKind:channelJob.kind,replyAnchorId:channelJob.replyAnchorId}:{}),...(groupDecisionId?{groupDecisionId}:{}),...(channelJob?.desktopModerated?{desktopModeratorRoundId:groupDecisionId,desktopModeratorHistoryLimit:resolveDesktopGroupScheduler(conv.desktopGroupScheduler).historyLimit}:{}),automatic:automaticTrigger(trigger),...(replyLease!==undefined?{replyLease}:{}),groupRootId:rootFor(trigger),automaticEpoch:automaticEpochs.get(conv.id)??0,ambientEpoch:ambientEpochs.get(conv.id)??0,epoch:epochs.get(conv.id)??0,status:'queued',createdAt:clock()};
    const claimed=transaction(()=>{
      const claimed=groupDispatch.claim({conversationId:conv.id,characterId,sourceIds,runId:run.id,route});
      if(!claimed.length)return claimed;
      run.triggerIds=claimed;
      const newestHuman=claimed.map(sourceId=>{const row=db.prepare('SELECT payload FROM messages WHERE id=?').get(sourceId);return row?JSON.parse(row.payload):null;}).filter(message=>message?.sender.type==='human').sort((a,b)=>b.sequence-a.sequence)[0];
      if(newestHuman)run.groupRootId=newestHuman.id;
      if(conv.kind==='group'&&trigger.sender.type==='character'&&!newestHuman&&!groupDispatch.reserveAutoTurn({conversationId:conv.id,rootId:run.groupRootId,runId:run.id,limit:resolveGroupScheduler(groupGlobalPolicy(conv),conv.scheduler).maxAutoTurns})){
        run.status='skipped';run.code='GROUP_AUTO_LIMIT';groupDispatch.transition(run.id,'skipped','automatic_turn_limit');
      }
      saveRun(run);return claimed;
    });
    if(!claimed.length||run.status==='skipped')return Promise.resolve(run);
    const upperSequence=conv.channel==='desktop'&&Number.isSafeInteger(channelJob?.desktopInputUpperSequence)?channelJob.desktopInputUpperSequence:conv.channel!=='desktop'&&conv.kind==='group'?(messages(conv.id,1).at(-1)?.sequence??trigger.sequence):groupDecisionId?Math.max(...claimed.map(sourceId=>db.prepare('SELECT sequence FROM messages WHERE conversation_id=? AND id=?').get(conv.id,sourceId).sequence)):Math.max(trigger.sequence,pending?.trigger?.sequence??0);
    const frozen={...clone(trigger),sequence:upperSequence,...(groupDecisionId||conv.channel!=='desktop'&&conv.kind==='group'?{strictInputUpperSequence:true}:{}),...(channelJob?.replyAnchorId?{replyAnchorId:channelJob.replyAnchorId}:{}),batchSourceIds:claimed};
    run.inputUpperSequence=frozen.sequence;
    if(conv.channel!=='desktop'&&conv.kind==='group')run.groupDecisionContext=db.prepare("SELECT payload FROM entities WHERE kind='channel-scheduler-result' AND json_extract(payload,'$.characterId')=? AND json_extract(payload,'$.conversationId')=? AND json_type(payload,'$.inputUpperSequence')='integer' AND json_extract(payload,'$.inputUpperSequence')<=? AND json_extract(payload,'$.status') NOT IN ('failed','cancelled') AND json_type(payload,'$.decision')='object' ORDER BY json_extract(payload,'$.inputUpperSequence') DESC,json_extract(payload,'$.updatedAt') DESC,rowid DESC LIMIT 16").all(characterId,conv.id,frozen.sequence).reverse().map(row=>JSON.parse(row.payload)).filter(item=>projectGroupDecision(item.decision)).map(item=>({batchId:item.batchId,anchorMessageId:item.anchorMessageId,inputUpperSequence:item.inputUpperSequence,decision:projectGroupDecision(item.decision)}));
    saveRun(run);
    if(channelJob?.kind==='direct'&&!channelScheduler.bindRun({...channelJob,runId:run.id})){groupDispatch.transition(run.id,'cancelled','SCHEDULER_BATCH_STALE');run.status='cancelled';run.code='SCHEDULER_BATCH_STALE';saveRun(run);return Promise.resolve(run);}
    if(channelJob?.kind==='direct')for(const sourceId of channelJob.triggerIds){const waiter=channelDirectWaiters.get(waiterKey(characterId,conv.id,sourceId));if(waiter)waiter.runId=run.id;}
    const key=`${characterId}:${conv.id}`;
    return enqueue(key,async()=>{const release=await acquireSlot();try{return await executeRun(run,frozen);}finally{release();}}).finally(()=>{schedulerFor(conv).wake(characterId,conv.id,{activityFinished:true});});
  }
  async function dispatch(trigger,{isReplay=false}={}){
    const conv=conversation(trigger.conversationId);
    if(isDesktopModeratedGroup(conv)&&trigger.sender.type==='human')invalidateGroupDecision(conv.id);
    const replied=trigger.replyToMessageId?db.prepare("SELECT payload FROM messages WHERE conversation_id=? AND (id=? OR json_extract(payload,'$.externalId')=?) AND json_extract(payload,'$.sender.type')='character' LIMIT 1").get(conv.id,trigger.replyToMessageId,trigger.replyToMessageId):null;
    const repliedCharacter=replied?JSON.parse(replied.payload).sender.id:null,direct=[],ambientIds=[];
    if(conv.kind==='group'&&(trigger.mentionIds?.some(key=>conv.participantIds.includes(key))||trigger.wakeCharacterIds?.some(key=>conv.participantIds.includes(key))||repliedCharacter))invalidateGroupDecision(conv.id,{requeue:true});
    if(conv.channel!=='desktop'&&conv.kind==='group'){
      const offeredAt=(channelSchedulerTimers.now??Date.now)();
      for(const characterId of conv.participantIds){
        if(trigger.roleEligibility&&!Object.hasOwn(trigger.roleEligibility,characterId))continue;
        if(!isReplay)channelScheduler.observe({characterId,conversationId:conv.id,offeredAt});
        if(trigger.sender.type==='character'&&trigger.sender.id===characterId)continue;
        const explicit=trigger.mentionIds?.includes(characterId)||trigger.wakeCharacterIds?.includes(characterId);
        const pending=channelScheduler.state({characterId,conversationId:conv.id})?.pendingDirect.some(value=>value.senderId===trigger.sender.id&&value.senderType===trigger.sender.type);
        if(!explicit&&!pending&&repliedCharacter===characterId)direct.push(scheduleRun(characterId,trigger,'direct'));
        else {const task=offerChannelRole(trigger,characterId,{direct:!!explicit,observe:false,offeredAt});if(task)direct.push(task);}
      }
      return (await Promise.all(direct)).filter(Boolean);
    }
    for(const characterId of conv.participantIds){
      if(trigger.roleEligibility&&!Object.hasOwn(trigger.roleEligibility,characterId))continue;
      if(trigger.sender.type==='character'&&trigger.sender.id===characterId)continue;
      if(conv.kind==='direct'||trigger.mentionIds?.includes(characterId)||trigger.wakeCharacterIds?.includes(characterId)||repliedCharacter===characterId)direct.push(scheduleRun(characterId,trigger,'direct'));
      else ambientIds.push(characterId);
    }
    if(ambientIds.length&&!(isDesktopModeratedGroup(conv)&&direct.length))scheduleAmbient(trigger,ambientIds);
    return (await Promise.all(direct)).filter(Boolean);
  }
  async function sendMessage(input={}){
    requireOpen();const conv=conversation(input.conversationId);requireActiveConversation(conv);
    if(input.strategy!==undefined&&input.strategy!=='steer')fail('DIRECT_INPUT_STRATEGY_INVALID','消息策略无效');
    if(input.strategy==='steer'&&!isDesktopDirect(conv))fail('DIRECT_STEER_SCOPE','插入仅支持当前角色主私聊');
    if(conv.channel!=='desktop')return sendChannelText(input,conv);
    const attachmentIds=composerAttachmentIds(input.attachmentIds),text=composerText(input,attachmentIds),requestId=required(input.requestId??id('request'),'请求标识',200),replyToMessageId=normalizeReplyMessageId(input.replyToMessageId),mentionIds=(input.mentionIds??[]).filter(key=>conv.participantIds.includes(key));
    const dedupeKey=`desktop:${conv.id}:${requestId}`,deliveryKey=`manual-desktop:${conv.id}:${requestId}`,fingerprint=createHash('sha256').update(JSON.stringify([text,'local-owner',replyToMessageId,attachmentIds,[...new Set(mentionIds)].sort(),...(input.strategy?[input.strategy]:[])])).digest('hex');
    return enqueue(deliveryKey,async()=>{
      requireOpen();requireActiveConversation(conversation(conv.id));
      const prior=db.prepare('SELECT message_id FROM incoming WHERE dedupe_key=?').get(dedupeKey),delivery=read('delivery',deliveryKey);
      if(prior){
        const row=db.prepare('SELECT payload FROM messages WHERE conversation_id=? AND id=?').get(conv.id,prior.message_id),previous=row?JSON.parse(row.payload):null;
        const legacyFingerprint=previous?createHash('sha256').update(JSON.stringify([previous.text,'local-owner',previous.replyToMessageId??null,previous.attachments?.map(item=>item.id)??[],[...new Set(previous.mentionIds??[])].sort()])).digest('hex'):null;
        if(delivery?delivery.fingerprint!==fingerprint:legacyFingerprint!==null&&legacyFingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','消息标识已用于另一条消息');
        return {...desktopSendReceipt(conv,requestId,prior.message_id),duplicate:true};
      }
      const reply=replyReference(conv,replyToMessageId);
      if(input.strategy==='steer'){
        if(list('direct-input').filter(item=>item.conversationId===conv.id&&['queued','sending','accepted'].includes(item.status)).length>=64)fail('DIRECT_INPUT_QUEUE_FULL','待插入消息过多，请等待处理');
        if(attachmentIds.length&&db.prepare("SELECT id FROM runs WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1").get(conv.id))fail('DIRECT_STEER_ATTACHMENTS_UNSUPPORTED','运行中插入暂不支持附件，请保留内容并等待本轮结束');
        if(db.prepare("SELECT id FROM runs WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1").get(conv.id)&&Buffer.byteLength(directSteerContent(conv.participantIds[0],conv,{id:'pending',text,replyToMessageId}),'utf8')>64000)fail('DIRECT_INPUT_TOO_LARGE','插入内容过长，请缩短后发送');
      }
      const resolved=await resolveComposerAttachments(conv,attachmentIds,input.signal);replyReference(conv,replyToMessageId);
      if(input.strategy==='steer'){requireOpen();const current=conversation(conv.id);requireActiveConversation(current);if(!isDesktopDirect(current)||current.participantIds[0]!==conv.participantIds[0])fail('DIRECT_STEER_SCOPE','当前角色主私聊已变化');}
      const message=appendMessage({conversationId:conv.id,requestId,text,...(attachmentIds.length?{attachments:resolved.attachments,blocks:[...(text?[{type:'text',text}]:[]),...resolved.blocks]}:{}),wakeCharacterIds:matchingWakeCharacterIds({conversation:conv,characters:list('character'),textSegments:[text]}),role:'user',sender:{type:'human',id:'local-owner',name:'你',source:'desktop'},mentionIds,replyToMessageId,...(reply?{replyPreview:reply.preview}:{})},{onPersisted:value=>{
        db.prepare('INSERT INTO incoming(dedupe_key,message_id) VALUES(?,?)').run(dedupeKey,value.id);
        put('delivery',deliveryKey,{fingerprint,inputFingerprintVersion:2,messageId:value.id,conversationId:conv.id,requestId});
        if(input.strategy==='steer'){if(attachmentIds.length&&db.prepare("SELECT id FROM runs WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1").get(conv.id))fail('DIRECT_STEER_ATTACHMENTS_UNSUPPORTED','运行中插入暂不支持附件，请等待本轮结束');if(list('direct-input').filter(item=>item.conversationId===conv.id&&['queued','sending','accepted'].includes(item.status)).length>=64)fail('DIRECT_INPUT_QUEUE_FULL','待插入消息过多，请等待处理');directInputs.offer(value,conv.participantIds[0],{requiresRun:!!value.attachments?.length||Buffer.byteLength(directSteerContent(conv.participantIds[0],conv,value),'utf8')>64000});}
      }});
      if(input.strategy==='steer')return desktopSendReceipt(conv,requestId,message.id);
      try{await dispatch(message);}catch(error){
        const current=read('delivery',deliveryKey);put('delivery',deliveryKey,{...current,dispatchError:{code:error.code??'DISPATCH_FAILED',message:redact(error.message??'角色处理失败')}});
        log('manual.dispatch.failed',{conversationId:conv.id,messageId:message.id,requestId,code:error.code??'DISPATCH_FAILED'},'error');
      }
      return desktopSendReceipt(conv,requestId,message.id);
    });
  }
  async function materializeChannelMedia({conversationId,messageIds}={},converter){
    requireOpen();const conv=conversation(conversationId);
    if(conv.channel==='desktop')fail('INVALID_CHANNEL','仅支持渠道消息媒体');
    if(!Array.isArray(messageIds)||messageIds.length>20||messageIds.some(key=>typeof key!=='string'||!key))fail('INVALID_MESSAGE_IDS','请选择最多20条消息');
    if(typeof converter!=='function')fail('CHANNEL_MEDIA_UNAVAILABLE','渠道媒体服务未连接');
    const ids=[...new Set(messageIds)],rows=ids.map(messageId=>{
      const row=db.prepare('SELECT payload FROM messages WHERE id=? AND conversation_id=?').get(messageId,conv.id);
      if(!row)fail('MESSAGE_NOT_FOUND','消息不属于当前会话');return {messageId,payload:row.payload,message:JSON.parse(row.payload)};
    });
    const result=await Promise.all(rows.map(({messageId,payload,message})=>{
      // New structured messages and literal manual text never need CQ conversion.
      if(message.taskId||message.source?.type==='manual')return message;
      const retryUnavailable=message.blocks?.some(block=>block.type==='unavailable')===true;
      if(!retryUnavailable&&message.blocks?.some(block=>['image','video'].includes(block.type)))return message;
      const hasLegacy=value=>/\[CQ:(?:image|video),/.test(value??'');
      const blockText=(message.blocks??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
      const legacyText=retryUnavailable?message.text:hasLegacy(message.text)?message.text:hasLegacy(blockText)?blockText:null;
      if(legacyText===null)return message;
      if(channelMediaTasks.has(messageId))return channelMediaTasks.get(messageId);
      const pending=(async()=>{
        let converted;try{converted=await converter(clone({...message,text:legacyText}));}catch{requireOpen();return message;}
        requireOpen();const current=db.prepare('SELECT payload FROM messages WHERE id=? AND conversation_id=?').get(messageId,conv.id);
        if(!current)return null;
        if(current.payload!==payload)return JSON.parse(current.payload);
        if(!converted)return message;
        const text=required(converted.text,'消息',50000),blocks=channelMessageBlocks(converted.blocks);
        if(!blocks.length)return message;
        if(retryUnavailable){
          const isMedia=block=>['image','video','unavailable'].includes(block.type),mediaType=block=>block.type==='unavailable'?(block.mediaType??(block.text==='视频无法加载'?'video':'image')):block.type;
          const previous=message.blocks.filter(isMedia),incoming=blocks.filter(isMedia);
          if(previous.length!==incoming.length||previous.some((block,index)=>mediaType(block)!==mediaType(incoming[index])))return message;
          let ordinal=0,recovered=false;
          const merged=message.blocks.map(block=>{if(!isMedia(block))return block;const next=incoming[ordinal++];if(block.type==='unavailable'&&next.type!=='unavailable'){recovered=true;return next;}return block;});
          if(!recovered)return message;
          const summary=merged.map(block=>block.type==='text'||block.type==='unavailable'?block.text:block.type==='mention'?mentionContextText(block):block.alt||(block.type==='video'?'视频':'图片')).join('\n');
          return patchMessage(message,{text:summary,blocks:merged});
        }
        if(blocks.some(block=>block.type==='unavailable'))return {...message,text,blocks};
        return patchMessage(message,{text,blocks});
      })();
      channelMediaTasks.set(messageId,pending);void pending.finally(()=>channelMediaTasks.delete(messageId)).catch(()=>{});return pending;
    }));
    return {conversationId:conv.id,messages:result.filter(Boolean)};
  }
  /** Explicit, server-only history repair. `resolver` is a trusted router callback,
   * never a serialized HTTP result: resolver(message,{conversation,signal}) must
   * verify get_msg against the original account/target/message/sender and return
   * {verified:true,source:{conversationId,channel,platform,accountId,kind,targetId,
   * externalTargetId,messageId:message.externalId,senderId:message.sender.id},blocks}.
   * Only real top-level at segments may produce mention blocks. No numeric-text
   * guessing, network access during snapshot, input admission or message delivery.
   */
  async function materializeChannelMentions({conversationId,messageIds}={},resolver=toolServices.recoverChannelMentions){
    requireOpen();const conv=conversation(conversationId),target=conv.channelTarget;
    if(conv.channel==='desktop'||target?.platform!=='qq'||!['group','private'].includes(target.kind))fail('INVALID_CHANNEL','仅支持 QQ 渠道消息提及恢复');
    if(['accountId','targetId','externalTargetId'].some(key=>typeof target[key]!=='string'||!target[key]))fail('CHANNEL_ROUTE_UNAVAILABLE','渠道会话缺少明确账号或目标');
    if(!Array.isArray(messageIds)||messageIds.length>20||messageIds.some(key=>typeof key!=='string'||!key))fail('INVALID_MESSAGE_IDS','请选择最多20条消息');
    if(typeof resolver!=='function')fail('CHANNEL_MENTIONS_UNAVAILABLE','渠道提及恢复服务未连接');
    const ids=[...new Set(messageIds)],rows=ids.map(messageId=>{
      const row=db.prepare('SELECT payload FROM messages WHERE id=? AND conversation_id=?').get(messageId,conv.id);
      if(!row)fail('MESSAGE_NOT_FOUND','消息不属于当前会话');
      return {messageId,payload:row.payload,message:JSON.parse(row.payload)};
    });
    const route=JSON.stringify([conv.channel,conv.kind,target]),resolved=await Promise.all(rows.map(async row=>{
      const {message,messageId,payload}=row;
      if(message.taskId||message.runId||['manual','plugin'].includes(message.source?.type)||typeof message.externalId!=='string'||!message.externalId||typeof message.sender?.id!=='string'||!message.sender.id)return {...row,converted:null};
      const key=JSON.stringify([conv.id,conv.version,messageId,createHash('sha256').update(payload).digest('hex')]);
      let task=channelMentionTasks.get(key);
      if(!task){
        const controller=new AbortController();task={controller};
        task.promise=Promise.resolve().then(()=>{requireOpen();return resolver(clone(message),{conversation:clone(conv),signal:controller.signal});}).catch(error=>{requireOpen();if(controller.signal.aborted)throw error;return null;});
        channelMentionTasks.set(key,task);void task.promise.finally(()=>{if(channelMentionTasks.get(key)===task)channelMentionTasks.delete(key);}).catch(()=>{});
      }
      return {...row,converted:await task.promise};
    }));
    requireOpen();
    // Validate every supplied proof and block before any write in this batch.
    const prepared=resolved.map(row=>{
      const {message,converted}=row;if(!converted||converted.verified!==true)return {...row,patch:null};
      const source=converted.source,expected={conversationId:conv.id,channel:conv.channel,platform:target.platform,accountId:target.accountId,kind:target.kind,targetId:target.targetId,externalTargetId:target.externalTargetId,messageId:message.externalId,senderId:message.sender.id};
      if(!source||Object.entries(expected).some(([key,value])=>source[key]!==value))fail('CHANNEL_MENTION_SCOPE_MISMATCH','提及恢复结果不属于原消息和渠道目标');
      const blocks=channelMessageBlocks(converted.blocks);
      if(!blocks.some(block=>block.type==='mention'))return {...row,patch:null};
      const isMedia=block=>['image','video','unavailable'].includes(block.type),mediaType=block=>block.type==='unavailable'?(block.mediaType??(block.text==='视频无法加载'?'video':'image')):block.type;
      const previous=(message.blocks??[]).filter(isMedia),incoming=blocks.filter(isMedia);
      if(previous.length&&(previous.length!==incoming.length||previous.some((block,index)=>mediaType(block)!==mediaType(incoming[index]))))return {...row,patch:null};
      let ordinal=0;const merged=previous.length?blocks.map(block=>isMedia(block)?clone(previous[ordinal++]):block):blocks;
      const text=required(merged.map(block=>['text','unavailable'].includes(block.type)?block.text:block.type==='mention'?mentionContextText(block):block.type==='image'?'[图片]':'[视频]').join(''),'消息',50000);
      const changed=message.text!==text||JSON.stringify(message.blocks??[])!==JSON.stringify(merged);
      return {...row,patch:changed?{text,blocks:merged}:null};
    });
    const changed=[];
    const result=transaction(()=>{
      requireOpen();const currentConversation=conversation(conv.id),sameRoute=currentConversation.version===conv.version&&JSON.stringify([currentConversation.channel,currentConversation.kind,currentConversation.channelTarget])===route;
      return prepared.map(({messageId,payload,patch})=>{
        const row=db.prepare('SELECT payload FROM messages WHERE id=? AND conversation_id=?').get(messageId,conv.id);if(!row)return null;
        const current=JSON.parse(row.payload);if(!sameRoute||row.payload!==payload||!patch)return current;
        const next={...current,...patch};const updated=db.prepare('UPDATE messages SET payload=? WHERE id=? AND conversation_id=? AND payload=?').run(JSON.stringify(next),messageId,conv.id,payload);
        if(updated.changes!==1)fail('VERSION_CONFLICT','消息已变化，提及恢复未覆盖新内容');changed.push(next);return next;
      });
    });
    for(const message of changed)emit('message',{message});
    return {conversationId:conv.id,messages:result.filter(Boolean)};
  }
  async function ingestChannelEvent(input={}){
    requireOpen();const blocks=input.blocks===undefined?undefined:channelMessageBlocks(input.blocks);let conv=conversation(input.conversationId);if(conv.channel==='desktop')fail('INVALID_CHANNEL','外部事件不能写入桌面对话');
    const externalId=required(String(input.messageId??''),'平台消息 ID'),key=`${conv.channel}:${conv.channelTarget?.targetId??conv.id}:${externalId}`;
    const sender={id:required(String(input.sender?.id??''),'发送者 ID'),name:String(input.sender?.name??'未知参与者'),type:'human'};
    const bound=list('character').find(c=>c.accounts?.some(a=>a.channel===conv.channel&&a.platform===conv.channelTarget?.platform&&String(a.userId)===sender.id));
    // An echoed platform event can beat the send API response. Wait for its receipt
    // before comparing message IDs, without discarding genuinely new role messages.
    const pending=bound&&pendingReceipts.get(`${conv.id}:${bound.id}`);if(pending?.size){await Promise.all([...pending]);requireOpen();conv=conversation(conv.id);}
    // The router supplies this host-owned account ID after verified ingress. A
    // second account may receive an already-deduplicated group event while its
    // replies are disabled, so record ownership before the duplicate return.
    // This metadata does not grant any new sending or scheduling permission.
    if(conv.kind==='group'&&conv.channelTarget?.kind==='group'&&typeof input.admissionAccountId==='string'&&input.admissionAccountId.trim()&&input.admissionAccountId.length<=200){
      const priorAccounts=Array.isArray(conv.channelAccountIds)?conv.channelAccountIds.filter(value=>typeof value==='string'):[];
      if(!priorAccounts.includes(input.admissionAccountId)){
        conv=put('conversation',conv.id,{...conv,channelAccountIds:[...new Set([...priorAccounts,input.admissionAccountId])]});
        emit('conversations.changed',{conversationId:conv.id});
      }
    }
    const prior=db.prepare('SELECT message_id FROM incoming WHERE dedupe_key=?').get(key);
    if(prior){const row=db.prepare('SELECT payload FROM messages WHERE id=?').get(prior.message_id);if(!row)return {duplicate:true,messageId:prior.message_id,runs:[]};let existing=JSON.parse(row.payload);
      // Shared group accounts can identify a mentioned role only after its account
      // joins. Admit that role once, without granting old members new eligibility.
      if(input.dispatch!==false&&(existing.dispatchEligible===true||input.roleEligibility)&&conv.replyEnabled!==false&&existing.dispatchConversationEligible!==false&&Array.isArray(existing.dispatchParticipantIds)){
        const addedMentions=(input.mentionIds??[]).filter(key=>conv.participantIds.includes(key)&&!existing.dispatchParticipantIds.includes(key));
        const mentionIds=[...new Set([...(existing.mentionIds??[]),...addedMentions])],dispatchCharacterIds=[...new Set([...(existing.dispatchCharacterIds??[]),...addedMentions])];
        if(mentionIds.length!==(existing.mentionIds??[]).length)existing=patchMessage(existing,{mentionIds,dispatchCharacterIds});
      }
      if(input.roleEligibility&&existing.roleEligibility){
        const roleEligibility={...existing.roleEligibility},replyLeases={...existing.replyLeases};let changed=false;
        for(const [characterId,eligible] of Object.entries(input.roleEligibility))if(conv.participantIds.includes(characterId)&&!Object.hasOwn(roleEligibility,characterId)){
          roleEligibility[characterId]=eligible===true&&existing.dispatchConversationEligible!==false;
          if(roleEligibility[characterId]&&input.replyLeases?.[characterId])replyLeases[characterId]=clone(input.replyLeases[characterId]);changed=true;
        }
        if(changed)existing=patchMessage(existing,{roleEligibility,replyLeases});
      }
      return {duplicate:true,messageId:prior.message_id,runs:existing.roleEligibility?await dispatch(existing,{isReplay:true}):input.dispatch===false||existing.dispatchEligible===false?[]:await dispatch(existing,{isReplay:true})};}
    if(bound){sender.id=bound.id;sender.name=bound.name;sender.type='character';}
    if(input.selfEcho===true&&!bound)return {ignored:true,reason:'unbound_self_echo',runs:[]};
    const mentionIds=(input.mentionIds??[]).filter(k=>conv.participantIds.includes(k)),replyToMessageId=input.replyToMessageId??null,replied=replyToMessageId?messages(conv.id,1000).find(message=>(message.id===replyToMessageId||message.externalId===replyToMessageId)&&message.sender?.type==='character'):null;
    const wakeCharacterIds=matchingWakeCharacterIds({conversation:conv,characters:list('character'),textSegments:input.topLevelTextSegments,senderType:sender.type});
    const dispatchCharacterIds=conv.participantIds.filter(characterId=>conv.kind==='direct'||mentionIds.includes(characterId)||wakeCharacterIds.includes(characterId)||replied?.sender.id===characterId||replyAllowed(conv,true,'ambient'));
    const message=appendMessage({conversationId:conv.id,text:required(input.text,'消息',50000),...(blocks?{blocks}:{}),role:sender.type==='character'?'assistant':'user',sender,externalId,...(input.roleEligibility?{roleEligibility:clone(input.roleEligibility),replyLeases:clone(input.replyLeases??{}),admissionAccountId:input.admissionAccountId,dispatchConversationEligible:conv.replyEnabled!==false}:{}),dispatchEligible:input.dispatch!==false&&conv.replyEnabled!==false,dispatchAmbientEligible:replyAllowed(conv,true,'ambient'),dispatchParticipantIds:conv.participantIds,dispatchCharacterIds,wakeCharacterIds,mentionIds,replyToMessageId});
    db.prepare('INSERT INTO incoming(dedupe_key,message_id) VALUES(?,?)').run(key,message.id);return {message,runs:message.roleEligibility?await dispatch(message):input.dispatch===false?[]:await dispatch(message)};
  }
  function markQueuedInterruption(conversationId,reason,{automaticOnly=false,ambientOnly=false}={}){
    for(const row of db.prepare("SELECT payload FROM runs WHERE conversation_id=? AND status='queued'").all(conversationId)){
      const queued=JSON.parse(row.payload);if(queued.interruption||automaticOnly&&!queued.automatic||ambientOnly&&queued.route!=='ambient')continue;
      queued.interruption={code:'RUN_CANCELLED',cancelSource:reason.cancelSource,cancelReason:reason.cancelReason,message:reason.message};saveRun(queued);
    }
  }
  function cancelAutomatic(conversationId){
    invalidateGroupDecision(conversationId);
    automaticEpochs.set(conversationId,(automaticEpochs.get(conversationId)??0)+1);
    markQueuedInterruption(conversationId,{cancelSource:'policy',message:'自动回复已停止'},{automaticOnly:true});
    groupScheduler.cancel(job=>job.conversationId===conversationId&&automaticTrigger(job.trigger));cancelChannelJobs(job=>job.conversationId===conversationId&&automaticTrigger(job.trigger));groupDispatch.cancel({conversationId,automaticOnly:true});
    for(const entry of controllers.values())if(entry.conversationId===conversationId&&entry.automatic)entry.controller.abort(Object.assign(new BookError('RUN_CANCELLED','自动回复已停止'),{cancelSource:'policy'}));
    for(const task of sendTasks.values())if(task.conversationId===conversationId&&task.automatic)task.controller.abort(Object.assign(new BookError('RUN_CANCELLED','自动回复已停止'),{cancelSource:'policy'}));
    for(const task of list('worker-task'))if(task.args.conversationId===conversationId&&task.args.source?.automatic&&['queued','running'].includes(task.status))void workerEngine.cancel(task.id).catch(()=>{});
    emit('activity.changed',{conversationId});
  }
  function cancelAmbient(conversationId){invalidateGroupDecision(conversationId);markQueuedInterruption(conversationId,{cancelSource:'policy',message:'自动接话已停止'},{ambientOnly:true});ambientEpochs.set(conversationId,(ambientEpochs.get(conversationId)??0)+1);groupScheduler.cancel(job=>job.conversationId===conversationId);cancelChannelJobs(job=>job.conversationId===conversationId&&job.kind!=='direct');groupDispatch.cancel({conversationId,ambientOnly:true});for(const entry of controllers.values())if(entry.conversationId===conversationId&&entry.route==='ambient')entry.controller.abort(Object.assign(new BookError('RUN_CANCELLED','自动接话已停止'),{cancelSource:'policy'}));for(const task of sendTasks.values())if(task.conversationId===conversationId&&task.route==='ambient')task.controller.abort();emit('activity.changed',{conversationId});}
  function cancelConversation(conversationId,{source='user'}={}){localRoles.cancelOrigin(conversationId);directInputs.cancel(conversationId);invalidateGroupDecision(conversationId);const cancelSource=['user','shutdown','policy','revocation'].includes(source)?source:'user';const reason=Object.assign(new BookError('RUN_CANCELLED','本轮已取消'),{cancelSource,cancelReason:cancelSource==='user'?'USER_STOP':cancelSource.toUpperCase()});log('conversation.cancelled',{conversationId,source:cancelSource,reason:reason.cancelReason});markQueuedInterruption(conversationId,reason);revokePreviews({conversationId});for(const task of list('worker-task'))if(task.args.conversationId===conversationId&&['queued','running'].includes(task.status))void workerEngine.cancel(task.id).catch(()=>{});for(const task of sendTasks.values()){const persisted=list('outbox-task').find(item=>item.runId===task.runId&&item.conversationId===conversationId);if(persisted)task.controller.abort(reason);}epochs.set(conversationId,(epochs.get(conversationId)??0)+1);groupScheduler.cancel(job=>job.conversationId===conversationId);cancelChannelJobs(job=>job.conversationId===conversationId);groupDispatch.cancel({conversationId});for(const entry of controllers.values())if(entry.conversationId===conversationId){entry.controller.abort(reason);entry.noticeController?.abort(reason);}emit('activity.changed',{conversationId});return {cancelled:true};}
  function getConversationUsage({conversationId,range='all'}={}){developer();conversation(conversationId);return observability.dashboard({conversationId,range,timeZone:settings().timeZone??'Asia/Shanghai'});}
  function getConversationObservability({conversationId,beforeSequence,limit,category,roundId,roundScope}={}){
    developer();conversation(conversationId);
    return {...observability.query({conversationId,beforeSequence,limit,category,roundId,roundScope}),summary:observability.summary({conversationId}),scheduler:channelScheduler.state().filter(item=>item.conversationId===conversationId)};
  }
  function getLogs({limit=100,level}={}){developer();return db.prepare(`SELECT * FROM logs ${level?'WHERE level=?':''} ORDER BY sequence DESC LIMIT ?`).all(...(level?[level]:[]),Math.max(1,Math.min(1000,Number(limit)||100))).map(r=>({...r,payload:JSON.parse(r.payload)}));}
  function exportDiagnostics(){developer();return redact({product:'沙之书',schemaVersion:1,createdAt:clock(),platform:process.platform,node:process.version,counts:{characters:list('character').length,conversations:list('conversation').length,messages:db.prepare('SELECT COUNT(*) AS count FROM messages').get().count},settings:settings(),runs:db.prepare('SELECT payload FROM runs ORDER BY rowid DESC LIMIT 100').all().map(r=>JSON.parse(r.payload)),logs:getLogs({limit:500})});}
  function testRecord(key){const record=read('test-session',key);if(!record)fail('TEST_NOT_FOUND','测试会话不存在');return record;}
  function openTest(key){const record=testRecord(key);if(!testSessions.has(key)){const child=createBookService({dataDir:path.join(dataDir,'tests',key),runtime,workerClient,toneClient,clock,testMode:true});child.setSettings({developerMode:true});child.subscribe(()=>emit('tests.changed',{sessionId:key}));testSessions.set(key,child);}return {record,child:testSessions.get(key)};}
  function createTestSession({characterId='default-character',conversationId,label}={}){
    developer();if(testMode)fail('TEST_NESTING_DENIED','不能在测试会话内再次创建测试会话');const source=character(characterId),sourceConv=conversationId?conversation(conversationId):null;const key=id('test');const convId=id('testconv');const seedData={character:clone(source),conversation:{id:convId,title:label??`${source.name}的测试页`,createdAt:clock()},messages:sourceConv?messages(sourceConv.id,100):[],memories:list('memory').filter(m=>m.characterId===characterId)};
    const child=createBookService({dataDir:path.join(dataDir,'tests',key),runtime,workerClient,toneClient,clock,testMode:true,seed:seedData});child.setSettings({developerMode:true});child.importPromptConfig({...exportPromptConfig(),prompts:exportPromptConfig().prompts.filter(p=>!p.characterId||p.characterId===characterId)});child.subscribe(()=>emit('tests.changed',{sessionId:key}));testSessions.set(key,child);
    const record=put('test-session',key,{id:key,label:label??`${source.name}的测试页`,characterId,conversationId:convId,sourceConversationId:conversationId??null,sourceCharacterVersion:source.version,createdAt:clock()});emit('tests.changed',{sessionId:key});return record;
  }
  function listTestSessions(){developer();return list('test-session');}
  function getTestSession(key){developer();const {record,child}=openTest(key);return {...record,snapshot:child.snapshot(),runs:list('test-run').filter(r=>r.sessionId===key),logs:child.getLogs({limit:300})};}
  function applyTestWorkerResult({characterId,name,result}){
    developer();if(!testMode)fail('TEST_ONLY','测试 Worker 不能写入正式角色');const current=character(characterId);const writes=[];
    if(name==='emotion_update'){const state={emotion:result?.description??result?.emotion??String(result)};if(result?.pad)state.pad=result.pad;updateCharacterState(characterId,state,{expectedVersion:current.version});writes.push({type:'emotion',state});}
    else if(name==='env_update'){const state={environment:typeof result==='string'?result:result?.environment??JSON.stringify(result)};updateCharacterState(characterId,state,{expectedVersion:current.version});writes.push({type:'environment',state});}
    else if(name==='persona_dream'&&result!==null){put('character',characterId,{...current,mutablePersona:typeof result==='string'?result:JSON.stringify(result)},current.version);writes.push({type:'persona',result});}
    else if(['diary','dream'].includes(name)){const entry=put(name,id(name),{characterId,content:result,createdAt:clock()});writes.push({type:name,id:entry.id});}
    else if(name==='memory_dream'){for(const item of result?.memories??[]){const entry=put('memory',id('memory'),{characterId,text:typeof item==='string'?item:JSON.stringify(item),source:'test-worker',createdAt:clock()});writes.push({type:'memory',id:entry.id});}if(writes.length)put('character',characterId,{...current,memoryVersion:current.memoryVersion+1});}
    else if(name==='work_memory_convolution'){put('character',characterId,{...current,workSummary:typeof result==='string'?result:JSON.stringify(result)},current.version);writes.push({type:'work_summary'});}
    for(const write of writes)log('write.worker',{name,...write});return writes;
  }
  async function executeTest({sessionId,input='',worker,provider,model}={}){
    developer();const {record,child}=openTest(sessionId);if(testControllers.has(sessionId))fail('TEST_BUSY','这个测试会话正在运行');const controller=new AbortController();testControllers.set(sessionId,controller);let run=put('test-run',id('testrun'),{sessionId,worker:worker??null,input:String(input),status:'running',startedAt:clock(),promptConfig:child.exportPromptConfig(),steps:[],writes:[]});emit('tests.changed',{sessionId});
    try{
      if(worker==='tone'){
        const task=await child.runBackground({name:'tone',characterId:record.characterId,conversationId:record.conversationId,input:String(input),provider,model,signal:controller.signal,wait:true});
        if(controller.signal.aborted)fail('RUN_CANCELLED','测试已取消');
        run.request=task.request;run.usage=task.usage;run.steps=task.steps;run.output=task.result;run.writes=[];run.status=task.status;run.code=task.code;run.error=task.error;run.fallback=task.fallback;run.warning=task.warning;run.toneContextMode=task.toneContextMode;
      }else if(worker){
        if(['group_scheduler','group_moderator'].includes(worker))fail('GROUP_DECISION_CONTEXT_REQUIRED','群聊调度提示词仅用于真实群聊调度上下文');
        if(typeof workerClient?.request!=='function')fail('WORKER_CLIENT_UNAVAILABLE','未配置 Worker 单次请求客户端');const snapshot=child.snapshot(),head=snapshot.prompts.find(p=>p.scope==='worker'&&p.name===worker&&p.characterId===record.characterId)??snapshot.prompts.find(p=>p.scope==='worker'&&p.name===worker&&!p.characterId);if(!head)fail('WORKER_NOT_FOUND','Worker 配置不存在');if(head.metadata?.enabled===false)fail('WORKER_DISABLED',`Worker ${worker} 未启用`);const config=JSON.parse(head.content);const vars=child.previewPrompt({characterId:record.characterId,conversationId:record.conversationId,content:'{{worker_input}}',variables:{worker_input:String(input)}}).variables;const rendered=config.messages.map(message=>({...message,content:renderPrompt(message.content,vars).text}));run.request={messages:rendered,responseFormat:config.response_format,promptRevision:head.revision};
        const result=await workerClient.request({name:worker,messages:rendered,responseFormat:config.response_format,contextId:`${sessionId}:${worker}:${run.id}`,signal:controller.signal,onEvent:event=>{run.steps.push({time:clock(),...redact(event)});emit('tests.changed',{sessionId});},provider:provider??head.metadata?.provider,model:model??head.metadata?.model,testMode:true,workspace:path.join(dataDir,'tests',sessionId,'workspace')});if(controller.signal.aborted)fail('RUN_CANCELLED','测试已取消');const output=decodeWorkerResponse(result,config.response_format,worker);validateWorkerResult(worker,output,{sourceMessages:snapshot.messages});run.output=output;run.usage=result?.usage;run.writes=child.applyTestWorkerResult({characterId:record.characterId,name:worker,result:output});run.status='completed';
      }else{
        controller.signal.addEventListener('abort',()=>child.cancelConversation(record.conversationId,{source:controller.signal.reason?.cancelSource??'policy'}),{once:true});const before=child.getLogs({limit:1})[0]?.sequence??0;const result=await child.sendMessage({conversationId:record.conversationId,text:required(String(input),'测试输入',50000),requestId:run.id});run.status=result.runs.some(r=>r.status==='failed')?'failed':controller.signal.aborted?'cancelled':'completed';run.output=result;const logs=child.getLogs({limit:1000}).filter(entry=>entry.sequence>before).reverse();run.steps=logs;run.writes=logs.filter(entry=>entry.event.startsWith('write.'));run.error=result.runs.find(r=>r.error)?.error;
      }
    }catch(error){run.status=controller.signal.aborted?'cancelled':'failed';run.error=redact(error.message);run.code=error.code??'TEST_ERROR';}
    finally{testControllers.delete(sessionId);run=put('test-run',run.id,{...run,finishedAt:clock()});emit('tests.changed',{sessionId});}
    return redact(run);
  }
  function runTest(input){const task=executeTest(input);testTasks.add(task);void task.finally(()=>testTasks.delete(task)).catch(()=>{});return task;}
  function cancelTest(key){developer();testRecord(key);testControllers.get(key)?.abort(Object.assign(new BookError('RUN_CANCELLED','测试已停止'),{cancelSource:'user',cancelReason:'USER_STOP'}));const child=testSessions.get(key);if(child)for(const conv of child.snapshot().conversations)child.cancelConversation(conv.id);return {cancelled:true};}
  async function deleteTestSession(key){developer();testRecord(key);if(testControllers.has(key))fail('TEST_BUSY','先停止正在运行的测试');const child=testSessions.get(key);if(child)await child.close();testSessions.delete(key);transaction(()=>{db.prepare("DELETE FROM entities WHERE kind='test-session' AND id=?").run(key);for(const run of list('test-run').filter(r=>r.sessionId===key))db.prepare("DELETE FROM entities WHERE kind='test-run' AND id=?").run(run.id);});rmSync(path.join(dataDir,'tests',key),{recursive:true,force:true});emit('tests.changed',{sessionId:key});return {deleted:true};}
  function close(){if(closeTask)return closeTask;closing=true;revokePreviews();if(typeof unsubscribeNativeTools==='function')unsubscribeNativeTools();(builtinTimers.clearInterval??clearInterval)(builtinTimer);for(const task of channelMentionTasks.values())task.controller.abort();for(const conv of list('conversation'))cancelConversation(conv.id,{source:'shutdown'});for(const controller of testControllers.values())controller.abort(Object.assign(new BookError('RUN_CANCELLED','服务正在关闭'),{cancelSource:'shutdown'}));for(const task of sendTasks.values())task.controller.abort();closeTask=(async()=>{await Promise.allSettled([localRoles.close(),groupScheduler.close(),channelScheduler.close(),background.close(),workerEngine.close(),startTask,builtinTick,...queues.values(),...testTasks,...publicTasks,...previewReleases,...channelMediaTasks.values(),...[...sendTasks.values()].map(task=>task.promise)]);await Promise.allSettled([...testSessions.values()].map(child=>child.close()));closed=true;roleCredentials.close();listeners.clear();db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();})();return closeTask;}
  function revokeScreen(pair){cancelChannelJobs(job=>job.characterId===pair.characterId&&job.conversationId===pair.conversationId);groupDispatch.cancel({characterId:pair.characterId,conversationId:pair.conversationId,reason:'permission_revoked'});invalidateGroupDecision(pair.conversationId,{requeue:true});for(const entry of controllers.values())if(entry.characterId===pair.characterId&&entry.conversationId===pair.conversationId){const reason=Object.assign(new BookError('RUN_CANCELLED','本轮权限已撤回'),{cancelSource:'revocation'});entry.controller.abort(reason);entry.noticeController?.abort(reason);log('run.cancelled',{runId:entry.runId,code:reason.code,cancelSource:reason.cancelSource});}runtime?.revokeImages?.(pair);}
  toolServices.registerCredentialAccess?.(Object.freeze({readForBusiness:roleCredentials.readForBusiness,withEnvironment:roleCredentials.withEnvironment}));
  const publicMethods={readOriginalDeveloperPrompt,composerAttachmentPermission,getLocalRoleCapabilities:characterId=>localRoles.getCapabilities(characterId),getRuntimePermission:characterId=>runtimePermissions.get(characterId),setRuntimePermission:input=>runtimePermissions.set(input),getInteraction,submitInteraction,cancelInteraction,composerCapturePermission,getSendReceipt,resolveReplyMessage,listPersonProfiles,getPersonProfile,getConversationUsage,getConversationObservability,isDeveloperMode:()=>settings().developerMode===true,runtimeWorkspaces:()=>list('character').map(person=>({cwd:workspaceFor(person.id),title:`${person.name}-workbench`})),revokeToolPermissions:({characterId})=>{invalidateToolPermissions(characterId);invalidateRuntimePermission(characterId);for(const conv of list('conversation').filter(conv=>conv.participantIds.includes(characterId)))revokeScreen({characterId,conversationId:conv.id});},getPermissions,setPermission,migrateScreenPermissions,adoptScreenPolicy,checkScreenCapture,getCharacterMemories,getCharacterDreams,validateCharacter,hasCharacter,markConversationRead,start,snapshot,revokeScreen,sendPluginTTM,sendPluginChannel,resumeBackground:taskId=>workerEngine.resume(taskId),cancelBackground:taskId=>workerEngine.cancel(taskId),runBackground,runCharacterDream,listActivities,getSendTask,resolveMedia,setChannelDetails,recallMemory:request=>{requireOpen();character(request.characterId);return memoryStore.recall(request);},createPromptCheckpoint:input=>promptStore.createPromptCheckpoint(input),listPromptCheckpoints:input=>promptStore.listPromptCheckpoints(input),getPromptCheckpoint:taskId=>promptStore.getPromptCheckpoint(taskId),updatePromptCheckpoint:(taskId,patch)=>promptStore.updatePromptCheckpoint(taskId,patch),deletePromptCheckpoint:(taskId,options)=>promptStore.deletePromptCheckpoint(taskId,options),createCharacter,updateCharacter,updateCharacterState,createConversation,updateConversation,addParticipants,sendMessage,sendEmoji,materializeChannelMedia,materializeChannelMentions,ingestChannelEvent,cancelConversation,previewPrompt,savePromptDraft,publishPrompt,promptHistory,rollbackPrompt,exportPromptConfig,importPromptConfig,setSettings,getLogs,exportDiagnostics,createTestSession,listTestSessions,getTestSession,runTest,cancelTest,deleteTestSession,applyTestWorkerResult,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}};
  return {...Object.fromEntries(Object.entries(publicMethods).map(([name,method])=>[name,(...args)=>{requireOpen();const result=method(...args);if(result instanceof Promise){publicTasks.add(result);void result.finally(()=>publicTasks.delete(result)).catch(()=>{});}return result;}])),close};
}
