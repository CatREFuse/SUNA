const id=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=200&&!/[\x00-\x1f]/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
export function roleSettingsDestination(input){
  const fields=new Set(['characterId','tab','tool','accountId','conversationId']);
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('角色权限目标无效');
  const prototype=Object.getPrototypeOf(input),constructor=prototype&&Object.getOwnPropertyDescriptor(prototype,'constructor')?.value;
  const plain=prototype===null||(Object.getPrototypeOf(prototype)===null&&typeof constructor==='function'&&constructor.prototype===prototype&&Function.prototype.toString.call(constructor)==='function Object() { [native code] }');
  if(!plain||!Object.hasOwn(input,'characterId')||!Object.hasOwn(input,'tab')||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!fields.has(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(input,key),'value'))||!id(input.characterId)||input.tab!=='permissions')throw new Error('角色权限目标无效');
  const target={characterId:input.characterId,tab:'permissions'};
  for(const name of ['tool','accountId','conversationId'])if(input[name]!==undefined){if(!id(input[name]))throw new Error('角色权限目标无效');target[name]=input[name];}
  return target;
}
export function legacyRoleSettingsDestination(input){
  if(!['permissions','screen'].includes(input.tab))return null;
  return roleSettingsDestination({characterId:input.characterId,tab:'permissions',
    ...(input.tab==='screen'?{tool:'screenshot'}:input.permissionTool!==undefined?{tool:input.permissionTool}:{}),
    ...(input.permissionAccountId!==undefined?{accountId:input.permissionAccountId}:{}),
    ...(input.permissionConversationId!==undefined?{conversationId:input.permissionConversationId}:{})});
}
export function roleSettingsUrl(base,target){
  const url=new URL(base);url.search='';url.hash='';url.searchParams.set('roleSettings','permissions');url.searchParams.set('characterId',target.characterId);
  for(const [name,query] of [['tool','permissionTool'],['accountId','permissionAccountId'],['conversationId','permissionConversationId']])if(target[name]!==undefined)url.searchParams.set(query,target[name]);
  if(target.requestId!==undefined)url.searchParams.set('roleSettingsRequestId',String(target.requestId));
  return url.href;
}
export function requireRolePermissionFrame(event,mainWindow,rendererUrl){
  const contents=mainWindow?.webContents;
  if(!contents||event.sender!==contents||event.senderFrame!==contents.mainFrame)throw new Error('权限只能在角色资料所在的主窗口修改');
  let origin;try{origin=new URL(event.senderFrame.url).origin;}catch{throw new Error('Unexpected renderer origin');}
  if(origin!==new URL(rendererUrl).origin)throw new Error('Unexpected renderer origin');
}
