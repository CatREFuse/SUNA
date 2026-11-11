import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createWorkbenchMedia} from '../core/workbench-media.mjs';
import {codexImageFailureCode} from './codex-cli-image-errors.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code})};
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const inside=(root,file)=>file.startsWith(root+path.sep);
const maxBytes=32*1024*1024;
async function readBounded(file,size,limit){
 if(!Number.isSafeInteger(size)||size<1||size>limit)fail('IMAGE_CLI_OUTPUT_INVALID');const bytes=Buffer.alloc(size);let complete=false;
 try{let offset=0;while(offset<size){const part=await file.read(bytes,offset,Math.min(65536,size-offset),offset);if(!Number.isInteger(part.bytesRead)||part.bytesRead<=0)fail('IMAGE_CLI_OUTPUT_CHANGED');offset+=part.bytesRead;}const extra=Buffer.alloc(1);if((await file.read(extra,0,1,size)).bytesRead!==0)fail('IMAGE_CLI_OUTPUT_CHANGED');complete=true;return bytes;}finally{if(!complete)bytes.fill(0);}
}

/** Called only for a native, same-process completed image item. Never parse an
 * assistant's prose, an output manifest or a caller-supplied path as evidence. */
export async function stageCodexInputImages({jobDirectory,referenceImages=[],signal,assertCurrent}){
 const check=()=>{signal.throwIfAborted();if(assertCurrent()===false)fail('IMAGE_CANCELLED')};check();
 if(!Array.isArray(referenceImages)||referenceImages.length>4)fail('IMAGE_REFERENCE_INVALID');
 if(await fs.realpath(jobDirectory)!==jobDirectory)fail('IMAGE_WORKSPACE_INVALID');
 const media=createWorkbenchMedia({workspace:jobDirectory,mediaDir:path.join(jobDirectory,'inputs')}),result=[];
 for(const image of referenceImages){
  check();if(!Buffer.isBuffer(image?.bytes)||!image.bytes.length||image.bytes.length>16*1024*1024)fail('IMAGE_REFERENCE_INVALID');const copy=Buffer.from(image.bytes);
  try{
   const descriptor=await media.persistBytes(copy);check();
   if(Math.max(descriptor.width,descriptor.height)>3840||descriptor.width*descriptor.height>8294400||descriptor.mime!==image.descriptor?.mime||descriptor.width!==image.descriptor?.width||descriptor.height!==image.descriptor?.height)fail('IMAGE_REFERENCE_INVALID');
   const filename=path.join(jobDirectory,'inputs',descriptor.relativePath);if(await fs.realpath(filename)!==filename||(await fs.lstat(filename)).nlink!==1)fail('IMAGE_REFERENCE_INVALID');await fs.chmod(filename,0o400);check();if(!result.some(value=>value.path===filename))result.push(Object.freeze({path:filename,sha256:descriptor.sha256}));
  }finally{copy.fill(0);}
 }
 return Object.freeze(result);
}
export async function stageCodexNativeImage({jobDirectory,nativeRoot,threadId,item,signal,assertCurrent,expectedInputs=[]}){
 const check=()=>{signal.throwIfAborted();if(assertCurrent()===false)fail('IMAGE_CANCELLED')};check();
 if(!safeId(threadId)||!item||item.type!=='imageGeneration'||!safeId(item.id))fail('IMAGE_CLI_OUTPUT_INVALID');
 if(item.failure!==undefined&&item.failure!==null)fail(codexImageFailureCode(item.failure));
 if(item.status!=='completed')fail('IMAGE_CLI_OUTPUT_INVALID');
 if(await fs.realpath(jobDirectory)!==jobDirectory||!(await fs.lstat(jobDirectory)).isDirectory())fail('IMAGE_WORKSPACE_INVALID');
 const observed=item.inputImages??[];
 if(!Array.isArray(observed)||observed.length!==expectedInputs.length||expectedInputs.some(expected=>!observed.some(actual=>actual?.path===expected.path&&actual.sha256===expected.sha256)))fail('IMAGE_CLI_REFERENCE_MISMATCH');
 for(const expected of expectedInputs){check();if(!inside(path.join(jobDirectory,'inputs'),expected.path)||await fs.realpath(expected.path)!==expected.path||!/^[a-f0-9]{64}$/.test(expected.sha256))fail('IMAGE_CLI_REFERENCE_MISMATCH');const input=await fs.open(expected.path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;try{const stat=await input.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>16*1024*1024)fail('IMAGE_CLI_REFERENCE_MISMATCH');bytes=await readBounded(input,stat.size,16*1024*1024);if(createHash('sha256').update(bytes).digest('hex')!==expected.sha256)fail('IMAGE_CLI_REFERENCE_MISMATCH');}finally{bytes?.fill(0);await input.close();}}
 let bytes;const parents=[];let file;
 try{
  if(!Object.hasOwn(item,'fileId')&&typeof item.result==='string'&&item.result){
   const encoded=item.result;if(encoded.length>Math.ceil(maxBytes/3)*4||encoded.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))fail('IMAGE_CLI_OUTPUT_INVALID');
   bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded)fail('IMAGE_CLI_OUTPUT_INVALID');
  }else{
   if(typeof nativeRoot!=='string'||!path.isAbsolute(nativeRoot)||typeof item.savedPath!=='string'||!path.isAbsolute(item.savedPath))fail('IMAGE_CLI_OUTPUT_MISSING');
   const bound=path.join(nativeRoot,threadId),source=item.savedPath;
   if(!inside(bound,source)||await fs.realpath(nativeRoot)!==nativeRoot||await fs.realpath(bound)!==bound||await fs.realpath(source)!==source)fail('IMAGE_CLI_OUTPUT_INVALID');
   const directories=[nativeRoot,bound];let parent=path.dirname(source);while(parent!==bound){if(!inside(bound,parent))fail('IMAGE_CLI_OUTPUT_INVALID');directories.push(parent);parent=path.dirname(parent);}
   for(const directory of [...new Set(directories)]){const handle=await fs.open(directory,constants.O_RDONLY|constants.O_NOFOLLOW);parents.push({directory,handle,identity:await handle.stat()});}
   const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.nlink===b.nlink;
   const validFile=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size>0&&stat.size<=maxBytes;
   const verifyParents=async()=>{for(const {directory,handle,identity} of parents){const named=await fs.lstat(directory),held=await handle.stat();if(!named.isDirectory()||named.isSymbolicLink()||named.dev!==identity.dev||named.ino!==identity.ino||held.dev!==identity.dev||held.ino!==identity.ino||await fs.realpath(directory)!==directory)fail('IMAGE_CLI_OUTPUT_CHANGED');}if(await fs.realpath(source)!==source)fail('IMAGE_CLI_OUTPUT_CHANGED');};
   await verifyParents();const original=await fs.lstat(source);if(!validFile(original))fail('IMAGE_CLI_OUTPUT_INVALID');
   file=await fs.open(source,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await file.stat();await verifyParents();const namedBefore=await fs.lstat(source);
   if(!validFile(before)||!same(original,before)||!same(namedBefore,before))fail('IMAGE_CLI_OUTPUT_CHANGED');
   bytes=await readBounded(file,before.size,maxBytes);check();const after=await file.stat(),named=await fs.lstat(source);await verifyParents();
   if(!same(before,after)||!same(named,before)||!validFile(named)||bytes.length!==before.size)fail('IMAGE_CLI_OUTPUT_CHANGED');
  }
  check();if(!bytes?.length||bytes.length>maxBytes)fail('IMAGE_CLI_OUTPUT_INVALID');
  const media=createWorkbenchMedia({workspace:jobDirectory,mediaDir:path.join(jobDirectory,'validated')});const descriptor=await media.persistBytes(bytes);check();
  if(Math.max(descriptor.width,descriptor.height)>3840||descriptor.width*descriptor.height>8294400)fail('IMAGE_CLI_OUTPUT_INVALID');
  return {bytes:Buffer.from(bytes),descriptor,native:{threadId,itemId:item.id}};
 }finally{bytes?.fill(0);await Promise.allSettled([file?.close(),...parents.reverse().map(({handle})=>handle.close())]);}
}
