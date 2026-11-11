const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
export function createRoleRuntimePermissions({read,put,character,getCatalog,getLegacyToolRecords=()=>[],getMigrationRequired=()=>false,assertOpen=()=>{},onChanged=()=>{}}){
 const selection=characterId=>{assertOpen();character(characterId);const saved=read('runtime-permission',characterId);const legacy=getLegacyToolRecords(characterId).filter(row=>row.characterId===characterId&&(typeof row.tool==='string'&&row.tool.startsWith('native:')||['bash','websearch','webfetch','cron'].includes(row.tool)&&row.permissionBoundaryVersion!==2));return {characterId,version:saved?.version??0,preset:saved?.preset??'auto',explicit:!!saved,authority:'runtime',confirmationRequired:(legacy.length>0||getMigrationRequired(characterId)===true)&&saved?.permissionBoundaryVersion!==2};};
 const get=async characterId=>{selection(characterId);const catalog=await getCatalog();assertOpen();character(characterId);return {...selection(characterId),catalog};};
 return {selection,get,async set(input){
  assertOpen();if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!['characterId','expectedVersion','preset','catalogRevision'].includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(input,key),'value'))||!validId(input.characterId)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||typeof input.preset!=='string'||!input.preset||input.preset.length>100||typeof input.catalogRevision!=='string')fail('RUNTIME_PERMISSION_INVALID','运行权限配置无效');
  input={...input};
  const before=selection(input.characterId);if(input.expectedVersion!==before.version)fail('VERSION_CONFLICT','运行权限已更新，请重新读取');
  const catalog=await getCatalog();assertOpen();const current=selection(input.characterId);if(input.expectedVersion!==current.version)fail('VERSION_CONFLICT','运行权限已更新，请重新读取');
  if(catalog.status!=='connected'||catalog.revision!==input.catalogRevision||!catalog.options.some(option=>option.value===input.preset))fail('RUNTIME_PERMISSION_UNAVAILABLE','运行权限选项已更新，请重新读取');
  if(!current.explicit||current.preset!==input.preset||current.confirmationRequired){put('runtime-permission',input.characterId,{preset:input.preset,permissionBoundaryVersion:2},current.explicit?current.version:undefined);onChanged(input.characterId);}
  return {...selection(input.characterId),catalog};
 }};
}
