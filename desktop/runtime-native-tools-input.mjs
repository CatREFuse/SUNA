const invalid=()=>{throw new Error('原生工具配置格式无效');};
function plain(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  const names=Reflect.ownKeys(value);if(names.length!==keys.length||names.some(key=>typeof key!=='string'||!keys.includes(key)))invalid();
  for(const key of names){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))invalid();}
}
const opaque=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
export function runtimeNativeToolsInput(value){
  plain(value,['expectedVersion','targetId','generation','catalogRevision','changes']);
  if(!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<0||!opaque(value.targetId)||!(value.generation===null||opaque(value.generation))||!(value.catalogRevision===null||opaque(value.catalogRevision))||!Array.isArray(value.changes)||value.changes.length<1||value.changes.length>512)invalid();
  // IPC sends structured-clone data. Still reject sparse/extra array properties
  // and accessors before inspecting values, including in direct host tests.
  const keys=Reflect.ownKeys(value.changes);if(Object.getPrototypeOf(value.changes)!==Array.prototype||keys.length!==value.changes.length+1||keys.some(key=>key!=='length'&&(typeof key!=='string'||! /^(0|[1-9]\d*)$/.test(key)||Number(key)>=value.changes.length)))invalid();
  const seen=new Set(),changes=[];
  for(let index=0;index<value.changes.length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(value.changes,String(index));if(!descriptor||!Object.hasOwn(descriptor,'value'))invalid();
    const change=descriptor.value;plain(change,['id','enabled']);
    if(typeof change.id!=='string'||! /^native:[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,199}$/.test(change.id)||typeof change.enabled!=='boolean'||seen.has(change.id))invalid();
    seen.add(change.id);changes.push({id:change.id,enabled:change.enabled});
  }
  const result={expectedVersion:value.expectedVersion,targetId:value.targetId,generation:value.generation,catalogRevision:value.catalogRevision,changes};
  if(Buffer.byteLength(JSON.stringify(result))>64*1024)invalid();
  return result;
}
