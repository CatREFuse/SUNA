import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createWorkbenchMedia} from '../core/workbench-media.mjs';
const queues=new Map(),hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code})};
const id=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\x00-\x1f]/.test(value);
const note=value=>{if(typeof value!=='string'||!value.trim()||[...value.trim()].length>120||/[\x00-\x1f]/.test(value))fail('SELFIE_NOTE_INVALID');return value.trim();};
export function createSelfieLibrary({root,mediaFactory=createWorkbenchMedia}={}){
 if(typeof root!=='string'||!path.isAbsolute(root)||typeof mediaFactory!=='function')throw new TypeError('absolute library root and media factory required');
 async function directory(characterId,create=false){
  if(!id(characterId))fail('SELFIE_CHARACTER_INVALID');
  if(create)await fs.mkdir(root,{recursive:true,mode:0o700});
  const rootStat=await fs.lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||await fs.realpath(root)!==root)fail('SELFIE_PATH_INVALID');
  const dir=path.join(root,hash(characterId));if(create)await fs.mkdir(dir,{recursive:true,mode:0o700});const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(dir)!==dir)fail('SELFIE_PATH_INVALID');return dir;
 }
 async function read(characterId){
  try{const dir=await directory(characterId),file=path.join(dir,'catalog.json'),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||await fs.realpath(file)!==file)fail('SELFIE_CATALOG_INVALID');const catalog=JSON.parse(await fs.readFile(file,'utf8'));if(catalog.version<1||!Number.isSafeInteger(catalog.version)||!Array.isArray(catalog.items)||catalog.items.length>9||new Set(catalog.items.map(i=>i.id)).size!==catalog.items.length||catalog.items.some(i=>!(/^[a-f0-9]{64}$/.test(i.id))||!(/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(i.relativePath))||!i.relativePath.startsWith(i.id+'.')||note(i.note)!==i.note))fail('SELFIE_CATALOG_INVALID');return catalog;}catch(error){if(error.code==='ENOENT')return {version:0,items:[]};throw error;}
 }
 const publicCatalog=catalog=>({version:catalog.version,items:catalog.items.map(({id,note,mime,width,height,bytes})=>({id,note,mime,width,height,bytes}))});
 const media=dir=>mediaFactory({workspace:dir,mediaDir:path.join(dir,'images'),maxBytes:8*1024*1024});
 function mutate(characterId,expectedVersion,operation){if(!id(characterId)||!Number.isSafeInteger(expectedVersion)||expectedVersion<0)fail('SELFIE_VERSION_INVALID');const key=path.join(root,hash(characterId));const task=(queues.get(key)??Promise.resolve()).catch(()=>{}).then(async()=>{const catalog=await read(characterId);if(catalog.version!==expectedVersion)fail('VERSION_CONFLICT');const dir=await directory(characterId,true),items=await operation(structuredClone(catalog.items),dir);const next={version:catalog.version+1,items},file=path.join(dir,'catalog.json'),temporary=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,JSON.stringify(next),{mode:0o600,flag:'wx'});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}return publicCatalog(next);});queues.set(key,task);void task.finally(()=>{if(queues.get(key)===task)queues.delete(key)}).catch(()=>{});return task;}
 return {
  list:async({characterId})=>publicCatalog(await read(characterId)),
  add:({characterId,bytes,note:text,expectedVersion})=>{const value=note(text);if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>8*1024*1024)fail('SELFIE_IMAGE_INVALID');const copy=Buffer.from(bytes);return mutate(characterId,expectedVersion,async(items,dir)=>{try{if(items.length>=9)fail('SELFIE_REFERENCE_LIMIT');const descriptor=await media(dir).persistBytes(copy);if(items.some(i=>i.id===descriptor.sha256))fail('SELFIE_REFERENCE_DUPLICATE');items.push({id:descriptor.sha256,note:value,relativePath:descriptor.relativePath,mime:descriptor.mime,width:descriptor.width,height:descriptor.height,bytes:descriptor.bytes});return items;}finally{copy.fill(0)}}).finally(()=>copy.fill(0));},
  update:({characterId,id:referenceId,note:text,expectedVersion})=>{const value=note(text);return mutate(characterId,expectedVersion,items=>{const found=items.find(i=>i.id===referenceId);if(!found)fail('SELFIE_REFERENCE_NOT_FOUND');found.note=value;return items;});},
  remove:({characterId,id:referenceId,expectedVersion})=>mutate(characterId,expectedVersion,items=>{if(!items.some(i=>i.id===referenceId))fail('SELFIE_REFERENCE_NOT_FOUND');return items.filter(i=>i.id!==referenceId);}),
  readForRun:async({characterId,id:referenceId,revision,signal})=>{signal?.throwIfAborted();const before=await read(characterId);if(before.version!==revision)fail('SELFIE_REFERENCES_CHANGED');const found=before.items.find(i=>i.id===referenceId);if(!found)fail('SELFIE_REFERENCE_NOT_FOUND');const image=await media(await directory(characterId)).readStored(found.relativePath,{maxBytes:8*1024*1024,signal});let delivered=false;try{signal?.throwIfAborted();const after=await read(characterId);signal?.throwIfAborted();if(after.version!==revision)fail('SELFIE_REFERENCES_CHANGED');delivered=true;return image;}finally{if(!delivered)image.data.fill(0);}},
 };
}
