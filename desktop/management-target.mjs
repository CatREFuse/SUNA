import {roleSettingsDestination,legacyRoleSettingsDestination} from './role-settings-target.mjs';

const sections=['characters','channels','plugins','settings'];
const validId=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
function record(input,fields,label){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error(label);
 const proto=Object.getPrototypeOf(input),ctor=proto&&Object.getOwnPropertyDescriptor(proto,'constructor')?.value;
 const plain=proto===null||(Object.getPrototypeOf(proto)===null&&typeof ctor==='function'&&ctor.prototype===proto&&Function.prototype.toString.call(ctor)==='function Object() { [native code] }');
 if(!plain||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!fields.includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(input,key),'value')))throw new Error(label);
 return input;
}
export function settingsDestination(input={}){
 record(input,['tab','characterId','scope','name','permissionTool','permissionAccountId','permissionConversationId'],'设置目标无效');
 const target={};
 if(input.tab!==undefined){if(!['appearance','model','model-scheduling','search','screen','permissions','runtime','background','group','prompts','developer'].includes(input.tab))throw new Error('设置页面无效');target.tab=input.tab;}
 if(input.characterId!==undefined){if(!validId(input.characterId))throw new Error('角色标识无效');target.characterId=input.characterId;target.tab??='prompts';}
 if(input.scope!==undefined){if(!['runtime','worker','tool'].includes(input.scope))throw new Error('提示词类型无效');target.scope=input.scope;}
 if(input.name!==undefined){if(!validId(input.name))throw new Error('提示词名称无效');target.name=input.name;}
 for(const field of ['permissionTool','permissionAccountId','permissionConversationId'])if(input[field]!==undefined){if(!validId(input[field]))throw new Error('权限目标无效');target[field]=input[field];if(target.tab!=='screen')target.tab='permissions';}
 return target;
}
export function managementDestination(input={section:'characters'}){
 record(input,['section','characterId','accountId','conversationId','settingsTarget','roleSettingsTarget'],'管理目标无效');
 if(!sections.includes(input.section))throw new Error('管理页面无效');
 const result={section:input.section};
 for(const field of ['characterId','accountId','conversationId'])if(input[field]!==undefined){if(!validId(input[field]))throw new Error('管理目标标识无效');result[field]=input[field];}
 if(input.settingsTarget!==undefined){
  if(input.section!=='settings')throw new Error('设置目标不属于当前管理页');
  const settings=settingsDestination(input.settingsTarget),role=legacyRoleSettingsDestination(settings);
  if(role){for(const [key,expected] of [['characterId',role.characterId],['accountId',role.accountId],['conversationId',role.conversationId]])if(result[key]!==undefined&&result[key]!==expected)throw new Error('权限目标不一致');return managementDestination({section:'characters',characterId:role.characterId,roleSettingsTarget:role});}
  if(result.characterId&&settings.characterId&&result.characterId!==settings.characterId)throw new Error('角色目标不一致');
  result.settingsTarget=settings;
 }
 if(input.roleSettingsTarget!==undefined){
  if(input.section!=='characters')throw new Error('角色权限目标不属于当前管理页');
  const role=roleSettingsDestination(input.roleSettingsTarget);
  if(result.characterId&&result.characterId!==role.characterId)throw new Error('角色目标不一致');
  result.characterId=role.characterId;result.roleSettingsTarget=role;
 }
 if(result.section==='channels'&&result.conversationId&&!result.accountId)throw new Error('频道会话需要明确账号');
 return result;
}
export function managementUrl(base){const url=new URL(base);url.search='';url.hash='';url.searchParams.set('window','management');return url.href;}
export function conversationDestination(value){if(!validId(value))throw new Error('会话标识无效');return value;}
export function validateManagementOwnership(target,snapshot={characters:[],conversations:[]},connections=[]){
 const role=target.roleSettingsTarget;
 const characterIds=[target.characterId,target.settingsTarget?.characterId,role?.characterId].filter(Boolean);
 for(const id of characterIds)if(!snapshot.characters?.some(character=>character.id===id))throw new Error('角色不存在');
 const accountIds=[target.accountId,role?.accountId].filter(Boolean);
 for(const id of accountIds){const account=connections.find(account=>account.accountId===id);if(!account)throw new Error('频道账号不存在');if(characterIds.some(characterId=>account.characterId!==characterId))throw new Error('频道账号不属于当前角色');}
 for(const id of [target.conversationId,role?.conversationId].filter(Boolean)){
  const conversation=snapshot.conversations?.find(conversation=>conversation.id===id);if(!conversation)throw new Error('会话不存在');
  if(target.section==='channels'&&conversation.channel==='desktop')throw new Error('应用会话不属于频道记录');
  if(characterIds.some(characterId=>!conversation.participantIds?.includes(characterId)))throw new Error('会话不属于当前角色');
  if(conversation.channel==='desktop'){if(accountIds.length)throw new Error('应用会话不属于频道账号');continue;}
  const primary=conversation.channelTarget?.accountId,platform=conversation.channelTarget?.platform;
  let memberships=[primary];
  if(conversation.channelAccountIds!==undefined){
   const values=conversation.channelAccountIds;
   if(!Array.isArray(values)||values.length>1000||values.some(value=>!validId(value))||new Set(values).size!==values.length)throw new Error('频道会话账号归属无效');
   memberships=conversation.kind==='group'&&conversation.channelTarget?.kind!=='private'?values:values.filter(value=>value===primary);
  }
  if(accountIds.some(accountId=>!memberships.includes(accountId)))throw new Error('频道会话不属于当前账号');
  const bound=connections.filter(account=>memberships.includes(account.accountId)&&account.platform===platform);
  if(!bound.length||accountIds.some(accountId=>!bound.some(account=>account.accountId===accountId)))throw new Error('频道会话账号不可用');
  if(role&&!bound.some(account=>account.characterId===role.characterId&&(!role.accountId||account.accountId===role.accountId)))throw new Error('频道账号不属于当前角色');
 }
 return target;
}
export function requireApplicationFrame(event,windows,rendererUrl){
 const allowed=windows.filter(window=>window&&!window.isDestroyed());
 const window=allowed.find(window=>event.sender===window.webContents);
 if(!window||event.senderFrame!==window.webContents.mainFrame)throw new Error('操作只能从本机主窗口或管理窗口发起');
 let url;try{url=new URL(event.senderFrame.url);}catch{throw new Error('Unexpected renderer origin');}
 const expected=new URL(rendererUrl);if(!['http:','https:'].includes(expected.protocol)||url.origin!==expected.origin||url.pathname!==expected.pathname||url.username||url.password)throw new Error('Unexpected renderer origin');
 return window;
}
