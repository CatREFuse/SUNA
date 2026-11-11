export const TOOL_PERMISSION_DEFAULTS=Object.freeze({local:'allow',group:'admins',direct:'admins'});
export const PERMISSION_TOOLS=Object.freeze([
 ['suna_read_attachment','附件读取'],['ask','提问'],['request_credentials','填写凭证'],['screenshot','截图'],['preview_workspace','静态预览'],['websearch','网络搜索'],['webfetch','网页读取'],['get_selfie','形象截图'],['image_gen','生成图片'],['cron','定时任务'],['interact_env','环境交互'],['recall_memory','记忆查询'],['add_work_memory','写入记忆'],['update_emotion','更新心境'],['list_emojis','表情包查询'],
].map(([id,label])=>Object.freeze({id,label})));
const known=new Set(PERMISSION_TOOLS.map(tool=>tool.id));
const values={local:new Set(['allow','deny']),group:new Set(['everyone','admins','deny']),direct:new Set(['everyone','admins'])};
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!['__proto__','prototype','constructor'].includes(value)&&!/[\x00-\x1f]/.test(value);
export const isPluginToolId=name=>typeof name==='string'&&/^plugin:suna-[a-z0-9-]{1,58}:suna_[a-z][a-z0-9_]{0,57}$/.test(name);
export const managedTool=name=>known.has(name)||isPluginToolId(name);
export function permissionRecordKey(record){return JSON.stringify([record.characterId,record.tool,record.scope,record.accountId??null,record.conversationId??null]);}
export function permissionChange(input){
 const fields=new Set(['expectedVersion','characterId','tool','scope','accountId','conversationId','field','value']);
 if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!fields.has(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(input,key),'value'))||!['expectedVersion','characterId','tool','scope','field','value'].every(key=>Object.hasOwn(input,key))||!validId(input.characterId)||!managedTool(input.tool)||!['role','account','conversation'].includes(input.scope)||!Object.hasOwn(values,input.field)||input.value!==null&&!values[input.field].has(input.value)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)fail('PERMISSION_INVALID','工具权限配置无效');
 if(input.scope==='role'&&(input.accountId!==undefined||input.conversationId!==undefined)||input.scope==='account'&&(!validId(input.accountId)||input.conversationId!==undefined||input.field==='local')||input.scope==='conversation'&&(!validId(input.conversationId)||input.accountId!==undefined))fail('PERMISSION_INVALID','权限覆盖范围无效');
 return {...input};
}
export function resolveToolPolicy({records=[],characterId,tool,conversation}){
 const policy={...TOOL_PERMISSION_DEFAULTS},accountId=conversation.channelTarget?.accountId;
 for(const scope of ['role','account','conversation'])for(const record of records){
  if(record.characterId!==characterId||record.tool!==tool||record.scope!==scope)continue;
  if(scope==='account'&&(conversation.channel==='desktop'||record.accountId!==accountId)||scope==='conversation'&&record.conversationId!==conversation.id)continue;
  Object.assign(policy,record.policy);
 }
 return policy;
}
export function evaluateToolPermission({records=[],legacyScreenDenials=[],characterId,tool,conversation,sender,internal=false,restricted=false,isAdministrator=false}){
 if(!managedTool(tool))return typeof tool==='string'&&!tool.startsWith('native:')&&!tool.startsWith('plugin:')&&!['bash','image_gen'].includes(tool);
 if(restricted||!sender||sender.type!=='human'||internal)return false;
 if(tool==='screenshot'&&legacyScreenDenials.some(pair=>pair.characterId===characterId&&pair.conversationId===conversation.id))return false;
 const allowed=name=>{
  const policy=resolveToolPolicy({records,characterId,tool:name,conversation});
  if(conversation.channel==='desktop')return sender.id==='local-owner'&&sender.source==='desktop'&&policy.local==='allow';
  const value=conversation.kind==='group'?policy.group:policy.direct;
  return value==='everyone'||value==='admins'&&isAdministrator===true;
 };
 const legacy=isPluginToolId(tool)&&/:(suna_generate_image|suna_selfie)$/.test(tool)?'image_gen':null;
 return allowed(tool)&&(!legacy||allowed(legacy));
}

