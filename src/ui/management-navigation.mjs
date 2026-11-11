/** @typedef {import('./types').SettingsTarget} SettingsTarget */
/** @typedef {import('./types').RoleSettingsTarget} RoleSettingsTarget */
/** @typedef {{section:'characters'|'channels'|'plugins'|'settings',characterId?:string,accountId?:string,conversationId?:string,settingsTarget?:SettingsTarget,roleSettingsTarget?:RoleSettingsTarget,requestId?:number}} ManagementTarget */
const sections=new Set(['characters','channels','plugins','settings']);
/** Navigation payloads carry destinations, never configuration values or secrets.
 * @param {unknown} input
 * @returns {ManagementTarget|null}
 */
export function normalizeManagementTarget(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const value=/** @type {Record<string,any>} */(input);
 if(Object.keys(value).some(key=>!['section','characterId','accountId','conversationId','settingsTarget','roleSettingsTarget','requestId'].includes(key)))return null;
 const section=value.section??'characters';if(!sections.has(section))return null;
 const target=/** @type {ManagementTarget} */({section});
 for(const key of ['characterId','accountId','conversationId']){
  if(value[key]===undefined)continue;
  if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>200)return null;
  target[key]=value[key];
 }
 if(value.requestId!==undefined){if(!Number.isSafeInteger(value.requestId)||value.requestId<1)return null;target.requestId=value.requestId;}
 if(value.settingsTarget!==undefined){
  const settings=value.settingsTarget;if(!settings||typeof settings!=='object'||Array.isArray(settings))return null;
  const allowed=['tab','characterId','scope','name','permissionTool','permissionAccountId','permissionConversationId'];
  if(Object.keys(settings).some(key=>!allowed.includes(key)||typeof settings[key]!=='string'||!settings[key].trim()||settings[key].length>200))return null;
  if(settings.tab!==undefined&&!['appearance','model','model-scheduling','search','screen','permissions','runtime','background','group','prompts','developer'].includes(settings.tab))return null;
  if(settings.scope!==undefined&&!['runtime','worker','tool'].includes(settings.scope))return null;
  target.settingsTarget={...settings};
 }
 if(value.roleSettingsTarget!==undefined){
  const role=value.roleSettingsTarget;
  if(!role||typeof role!=='object'||Array.isArray(role)||role.tab!=='permissions'||typeof role.characterId!=='string'||!role.characterId.trim())return null;
  if(Object.keys(role).some(key=>!['tab','characterId','tool','accountId','conversationId','requestId'].includes(key)))return null;
  if(['characterId','tool','accountId','conversationId'].some(key=>role[key]!==undefined&&(typeof role[key]!=='string'||!role[key].trim()||role[key].length>200)))return null;
  if(role.requestId!==undefined&&(!Number.isSafeInteger(role.requestId)||role.requestId<1))return null;
  target.roleSettingsTarget={...role};
 }
 return target;
}
/** @returns {ManagementTarget} */
export function managementTargetFromSearch(search){
 const query=new URLSearchParams(search),legacy=query.get('window')==='settings';
 const section=query.get('section')??(legacy?'settings':'characters');
 const target=/** @type {Record<string,any>} */({section});
 for(const key of ['characterId','accountId','conversationId'])if(query.has(key))target[key]=query.get(key);
 const settings=Object.fromEntries(['tab','scope','name','permissionTool','permissionAccountId','permissionConversationId'].filter(key=>query.has(key)).map(key=>[key,query.get(key)]));
 const settingsCharacterId=query.get('settingsCharacterId')??(section==='settings'?query.get('characterId'):null);
 if(settingsCharacterId)settings.characterId=settingsCharacterId;
 if(Object.keys(settings).length)target.settingsTarget=settings;
 if(legacy&&target.settingsTarget?.characterId)delete target.characterId;
 if(query.get('roleSettings')==='permissions'){
  const characterId=query.get('roleCharacterId')??query.get('characterId');target.section='characters';
  target.roleSettingsTarget={characterId,tab:'permissions'};
  for(const [key,modern,old] of [['tool','roleTool','permissionTool'],['accountId','roleAccountId','permissionAccountId'],['conversationId','roleConversationId','permissionConversationId']]){const value=query.get(modern)??query.get(old);if(value)target.roleSettingsTarget[key]=value;}
  delete target.settingsTarget;
 }
 return normalizeManagementTarget(target)??{section:'characters'};
}
export function managementUrl(base,target){
 const normalized=normalizeManagementTarget(target);if(!normalized)throw new Error('管理页面目标无效');
 const url=new URL(base);url.search='';url.hash='';url.searchParams.set('window','management');url.searchParams.set('section',normalized.section);
 for(const key of ['characterId','accountId','conversationId'])if(normalized[key])url.searchParams.set(key,normalized[key]);
 for(const [key,value] of Object.entries(normalized.settingsTarget??{}))url.searchParams.set(key==='characterId'?'settingsCharacterId':key,value);
 if(normalized.roleSettingsTarget){const role=normalized.roleSettingsTarget;url.searchParams.set('roleSettings','permissions');url.searchParams.set('roleCharacterId',role.characterId);for(const [key,field] of [['tool','roleTool'],['accountId','roleAccountId'],['conversationId','roleConversationId']])if(role[key])url.searchParams.set(field,role[key]);}
 return url.href;
}
