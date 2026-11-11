import {createHash} from 'node:crypto';
const indexPath='workbench/selfie/references.jsonl',prefix='workbench/selfie/',maxBytes=8*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code})};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const role=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id);
const hex=id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id);
const filename=name=>typeof name==='string'&&name.length<=255&&!/[\\/\x00-\x1f\x7f]/.test(name)&&name!=='.'&&name!=='..'&&/\.(?:png|jpe?g|gif|webp)$/i.test(name);
const validNote=value=>typeof value==='string'&&value.trim().length>0&&[...value.trim()].length<=120&&!/[\p{Cc}]/u.test(value);
function parse(bytes,code){try{return JSON.parse(bytes.toString('utf8'))}catch{fail(code)}}
function buffer(bytes){if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>maxBytes)fail('IMPORT_SELFIE_IMAGE_INVALID');}

/** Pure role-local planner. No source code execution, IO or implicit photo scan. */
export function collectSunabotSelfieReferences({characterId,files,prepareImage}={}){
 if(!role(characterId)||!(files instanceof Map)||prepareImage!==undefined&&typeof prepareImage!=='function')fail('IMPORT_SELFIE_ARGUMENT_INVALID');
 const agentBytes=files.get('agent.json');if(!Buffer.isBuffer(agentBytes)||agentBytes.length>1024*1024)fail('IMPORT_SOURCE_ROLE_MISMATCH');
 const agent=parse(agentBytes,'IMPORT_SOURCE_ROLE_MISMATCH');if(!plain(agent)||agent.id!==characterId)fail('IMPORT_SOURCE_ROLE_MISMATCH');
 const source=files.get(indexPath);
 if(source===undefined){
  if([...files.keys()].some(name=>typeof name==='string'&&name.startsWith(prefix)&&/\.(?:png|jpe?g|gif|webp)$/i.test(name)))fail('IMPORT_SELFIE_INDEX_MISSING');
  return {characterId,present:false,indexSha256:null,items:[],counts:{indexed:0,prepared:0}};
 }
 if(!Buffer.isBuffer(source)||source.length>65536)fail('IMPORT_SELFIE_INDEX_INVALID');
 const lines=source.toString('utf8').split(/\r?\n/).filter(line=>line.trim());if(lines.length>9)fail('IMPORT_SELFIE_REFERENCE_LIMIT');
 const seen=new Set(),active=new Set(),items=[];
 for(const line of lines){
  let row;try{row=JSON.parse(line)}catch{fail('IMPORT_SELFIE_INDEX_INVALID')}
  if(!plain(row)||row.schemaVersion!==1||!hex(row.id)||!filename(row.fileName)||!validNote(row.note))fail('IMPORT_SELFIE_INDEX_INVALID');
  if(['agentId','characterId'].some(key=>Object.hasOwn(row,key)&&row[key]!==characterId))fail('IMPORT_SOURCE_ROLE_MISMATCH');
  if(seen.has(row.id))fail('IMPORT_SELFIE_DUPLICATE');seen.add(row.id);
  const sourcePath=prefix+row.fileName,original=files.get(sourcePath);if(original===undefined)fail('IMPORT_SELFIE_FILE_MISSING');buffer(original);
  const sourceSha256=hash(original);if(row.id!==sourceSha256)fail('IMPORT_SELFIE_HASH_MISMATCH');
  const copy=Buffer.from(original);let prepared;
  try{prepared=prepareImage?prepareImage(copy,{characterId,sourceId:row.id,sourcePath}):copy;buffer(prepared);prepared=Buffer.from(prepared);}catch(error){copy.fill(0);fail('IMPORT_SELFIE_PREPARE_FAILED');}finally{copy.fill(0);}
  const id=hash(prepared);if(active.has(id)){prepared.fill(0);fail('IMPORT_SELFIE_DUPLICATE');}active.add(id);
  items.push({id,sourceId:row.id,sourceSha256,sourcePath,note:row.note.trim(),bytes:prepared});
 }
 return {characterId,present:true,indexSha256:hash(source),items,counts:{indexed:items.length,prepared:items.filter(item=>item.id!==item.sourceId).length}};
}

/** Offline staging merge only. Preserve user entries/notes; CAS conflicts abort. */
export async function mergeSunabotSelfieReferences({characterId,plan,library}={}){
 if(!role(characterId)||!plain(plan)||plan.characterId!==characterId||typeof plan.present!=='boolean'||!Array.isArray(plan.items)||plan.items.length>9||typeof library?.list!=='function'||typeof library?.add!=='function')fail('IMPORT_SELFIE_PLAN_INVALID');
 const incoming=plan.items.map(item=>plain(item)?{...item,bytes:Buffer.isBuffer(item.bytes)?Buffer.from(item.bytes):item.bytes}:item);
 const ids=new Set();for(const item of incoming){if(!plain(item)||!hex(item.id)||!hex(item.sourceId)||item.sourceSha256!==item.sourceId||!validNote(item.note)||item.note!==item.note.trim()||typeof item.sourcePath!=='string'||!filename(item.sourcePath.slice(prefix.length))||!item.sourcePath.startsWith(prefix))fail('IMPORT_SELFIE_PLAN_INVALID');buffer(item.bytes);if(hash(item.bytes)!==item.id||ids.has(item.id))fail('IMPORT_SELFIE_PLAN_INVALID');ids.add(item.id);}
 if(!plan.present&&plan.items.length)fail('IMPORT_SELFIE_PLAN_INVALID');
 const result={characterId,present:plan.present,added:0,existing:0,noteConflicts:0,items:[]};if(!plan.present)return result;
 let catalog=await library.list({characterId});
 const validateCatalog=()=>{if(!catalog||!Number.isSafeInteger(catalog.version)||catalog.version<0||!Array.isArray(catalog.items)||catalog.items.length>9||new Set(catalog.items.map(item=>item.id)).size!==catalog.items.length||catalog.items.some(item=>!hex(item.id)))fail('IMPORT_SELFIE_CATALOG_INVALID');};validateCatalog();
 const missing=incoming.filter(item=>!catalog.items.some(existing=>existing.id===item.id));if(catalog.items.length+missing.length>9)fail('IMPORT_SELFIE_REFERENCE_LIMIT');
 for(const item of incoming){
  const existing=catalog.items.find(existing=>existing.id===item.id);
  if(existing){const noteConflict=existing.note!==item.note;result.existing++;if(noteConflict)result.noteConflicts++;result.items.push({id:item.id,status:'existing',noteConflict});continue;}
  catalog=await library.add({characterId,bytes:Buffer.from(item.bytes),note:item.note,expectedVersion:catalog.version});validateCatalog();if(!catalog.items.some(existing=>existing.id===item.id))fail('IMPORT_SELFIE_CATALOG_INVALID');
  result.added++;result.items.push({id:item.id,status:'added',noteConflict:false});
 }
 return result;
}
