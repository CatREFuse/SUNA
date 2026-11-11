import fs from 'node:fs/promises';
import {safeSelfieFailure} from './selfie-failure.mjs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code})};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const abortable=(promise,signal)=>{signal.throwIfAborted();return new Promise((resolve,reject)=>{const stop=()=>reject(signal.reason??new Error('IMAGE_CANCELLED'));signal.addEventListener('abort',stop,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop)).catch(()=>{});});};
const defaultSleep=(ms,signal)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},ms);const abort=()=>{clearTimeout(timer);reject(signal.reason)};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const diagnosticCodes=new Set(['invalid_api_key','invalid_request_error','model_not_found','unsupported_parameter','unsupported_value','invalid_value','missing_required_parameter','insufficient_quota','rate_limit_exceeded','permission_denied','content_policy_violation','server_error']);
const diagnosticTypes=new Set(['invalid_request_error','authentication_error','permission_error','rate_limit_error','server_error','api_error','insufficient_quota']);
function providerDiagnostic(scope,response,text){
 if(response?.ok!==false||!Number.isInteger(response.status)||response.status<100||response.status>599)return;
 const pick=(value,allowed)=>value===undefined||value===null?null:typeof value==='string'&&allowed.has(value)?value:'unknown';
 let error;
 if(typeof text==='string'&&Buffer.byteLength(text)<=65536)try{const value=JSON.parse(text);if(plain(value)&&Object.hasOwn(value,'error')&&plain(value.error))error=value.error;}catch{}
 const receipt=Object.freeze({status:response.status,error:Object.freeze({code:pick(error&&Object.hasOwn(error,'code')?error.code:undefined,diagnosticCodes),type:pick(error&&Object.hasOwn(error,'type')?error.type:undefined,diagnosticTypes)})});
 // Only trusted server scope receives fixed metadata. Never pass body, message,
 // request arguments, headers or URLs, and never let logging change execution.
 try{if(typeof scope.onDiagnostic==='function'){const value=scope.onDiagnostic(receipt);if(value&&typeof value.then==='function')Promise.resolve(value).catch(()=>{});}}catch{}
}
function parameters(payload){
 if(!plain(payload)||Object.keys(payload).some(k=>!['prompt','size','quality','references'].includes(k))||typeof payload.prompt!=='string'||!payload.prompt.trim()||payload.prompt.length>20000||payload.prompt.includes('\0'))fail('IMAGE_ARGUMENTS_INVALID');
 if(payload.size!==undefined&&!['1024x1024','1024x1536','1536x1024','auto'].includes(payload.size)||payload.quality!==undefined&&!['low','medium','high','auto'].includes(payload.quality))fail('IMAGE_ARGUMENTS_INVALID');
 const refs=payload.references??[];
 if(!Array.isArray(refs)||refs.length>4||refs.some(ref=>!plain(ref)||!['media','workbench'].includes(ref.kind)||Object.keys(ref).some(k=>!['kind','id','path'].includes(k))||ref.kind==='media'&&(typeof ref.id!=='string'||!ref.id||Object.hasOwn(ref,'path'))||ref.kind==='workbench'&&(typeof ref.path!=='string'||!ref.path||Object.hasOwn(ref,'id'))))fail('IMAGE_REFERENCE_INVALID');
 return {...payload,prompt:payload.prompt.trim(),references:refs};
}
async function responseText(response,signal,max){
 if(response.headers?.get('content-length')&&Number(response.headers.get('content-length'))>max)fail('IMAGE_RESPONSE_TOO_LARGE');
 if(!response.body?.getReader){const text=await abortable(response.text(),signal);if(Buffer.byteLength(text)>max)fail('IMAGE_RESPONSE_TOO_LARGE');return text;}
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{while(true){const part=await abortable(reader.read(),signal);if(part.done)break;size+=part.value.length;if(size>max)fail('IMAGE_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(part.value));}return Buffer.concat(chunks).toString('utf8');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function extractCodexImage(text){
 let candidates=[];
 try{const parsed=JSON.parse(text);candidates=Array.isArray(parsed.output)?parsed.output:[];}catch{
  for(const frame of text.split(/\r?\n\r?\n/)){
   const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data||data.trim()==='[DONE]')continue;
   let event;try{event=JSON.parse(data)}catch{fail('IMAGE_RESPONSE_INVALID');}
   if(event.type==='response.completed'&&Array.isArray(event.response?.output))candidates.push(...event.response.output);
   else if(event.type==='response.output_item.done'&&event.item)candidates.push(event.item);
   else if(Array.isArray(event.output))candidates.push(...event.output);
  }
 }
 const item=candidates.find(value=>value?.type==='image_generation_call'&&[value.result,value.image,value.b64_json].some(v=>typeof v==='string'&&v));
 if(!item)fail('IMAGE_OUTPUT_MISSING');
 const encoded=[item.result,item.image,item.b64_json].find(v=>typeof v==='string'&&v).replace(/^data:image\/[a-z0-9.+-]+;base64,/i,'').replace(/\s/g,'');
 if(encoded.length>45*1024*1024||!encoded||encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))fail('IMAGE_OUTPUT_INVALID');
 const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>32*1024*1024||bytes.toString('base64')!==encoded)fail('IMAGE_OUTPUT_INVALID');return bytes;
}
async function workbenchOutput(workspace,descriptor,bytes,check){
 if(typeof workspace!=='string'||!path.isAbsolute(workspace))fail('IMAGE_WORKSPACE_INVALID');
 const stat=await fs.lstat(workspace);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(workspace)!==workspace)fail('IMAGE_WORKSPACE_INVALID');
 const dir=path.join(workspace,'generated');await fs.mkdir(dir,{recursive:true,mode:0o700});if(!(await fs.lstat(dir)).isDirectory()||await fs.realpath(dir)!==dir)fail('IMAGE_WORKSPACE_INVALID');
 if(!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(descriptor.relativePath)||descriptor.sha256!==hash(bytes))fail('IMAGE_OUTPUT_INVALID');
 const temporary=path.join(dir,'.image-'+randomUUID()+'.tmp'),dest=path.join(dir,descriptor.relativePath);let file;
 try{file=await fs.open(temporary,'wx',0o600);await file.writeFile(bytes);await file.sync();await file.close();file=null;check();try{await fs.link(temporary,dest)}catch(error){if(error.code!=='EEXIST')throw error;const s=await fs.lstat(dest);if(!s.isFile()||s.isSymbolicLink()||await fs.realpath(dest)!==dest||hash(await fs.readFile(dest))!==descriptor.sha256)fail('IMAGE_OUTPUT_INVALID');}check();return 'generated/'+descriptor.relativePath;}finally{await file?.close();await fs.rm(temporary,{force:true}).catch(()=>{});}
}
/** Server-only transport. Provider secrets and image bytes never travel to the plugin worker. */
export function createCodexImageService({resolveProvider,fetchImpl=fetch,sleep=defaultSleep,clock=Date.now,rewriteSelfie,selfieLibrary,resolveReference,prepareReference,allowLoopback=false,maxResponseBytes=48*1024*1024,imageTransport}={}){
 if(typeof imageTransport!=='function'&&typeof resolveProvider!=='function')throw new TypeError('Server Provider resolver required');
 async function generate(raw,scope={}){
  const input=parameters(raw),selfie=scope.toolName==='suna_selfie';if(!['suna_generate_image','suna_selfie'].includes(scope.toolName))fail('IMAGE_TOOL_INVALID');
  if(selfie&&input.references.length>1)fail('IMAGE_REFERENCE_LIMIT');
  if(typeof scope.assertCurrent!=='function'||typeof scope.media?.persistBytes!=='function')throw new TypeError('Host media and lifetime guard required');
  const deadline=Math.min(Number.isFinite(scope.deadline)?scope.deadline:Infinity,clock()+600000),timeout=new AbortController(),signal=AbortSignal.any([timeout.signal,...(scope.signal?[scope.signal]:[])]),timer=setTimeout(()=>timeout.abort(Object.assign(new Error('IMAGE_TIMEOUT'),{code:'IMAGE_TIMEOUT'})),Math.max(0,deadline-clock()));
  let providerCurrent;const check=()=>{signal.throwIfAborted();if(clock()>=deadline)fail('IMAGE_TIMEOUT');if(scope.assertCurrent()===false)fail('IMAGE_CANCELLED');if(providerCurrent?.()===false)fail('IMAGE_PROVIDER_CHANGED');};
  const retained=[];let librarySnapshot,libraryVersion,outputBytes,transportCleanup,failureStage='setup';
  try{
   check();let provider,endpoint,headers;if(typeof imageTransport!=='function'){
   check();provider=await abortable(resolveProvider({providerId:scope.config?.providerId,textModelId:scope.config?.textModelId,imageModelId:scope.config?.imageModelId,signal}),signal);providerCurrent=provider?.assertCurrent;check();
   if(!provider||typeof provider.textModelId!=='string'||!provider.textModelId||typeof provider.imageModelId!=='string'||!provider.imageModelId||!plain(provider.headers))fail('IMAGE_PROVIDER_UNAVAILABLE');
   try{endpoint=new URL(provider.endpoint)}catch{fail('IMAGE_PROVIDER_UNAVAILABLE');}
   const declared=Object.hasOwn(provider,'protocol'),direct=declared&&provider.protocol==='openai-responses',codex=declared&&provider.protocol==='openai-codex-responses';
   const loopback=allowLoopback&&endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname);
   const official=endpoint.protocol==='https:'&&!endpoint.port&&(direct&&endpoint.hostname==='api.openai.com'&&endpoint.pathname==='/v1/responses'||codex&&endpoint.hostname==='chatgpt.com'&&endpoint.pathname==='/backend-api/codex/responses');
   if(!(direct||codex)||!loopback&&!official||endpoint.username||endpoint.password||endpoint.hash||endpoint.search)fail('IMAGE_PROVIDER_UNAVAILABLE');
   try{headers=new Headers(provider.headers);}catch{fail('IMAGE_PROVIDER_UNAVAILABLE');}
   const account=headers.get('chatgpt-account-id');
   if(direct&&account!==null||codex&&(typeof account!=='string'||!account.trim()||account.length>300))fail('IMAGE_PROVIDER_UNAVAILABLE');
   }
   const referenceInputs=[],referenceImages=[];
   const addReference=async value=>{
    check();let image=value;const originalBytes=value?.data??value?.bytes,sourceSha256=Buffer.isBuffer(originalBytes)?hash(originalBytes):undefined;try{if(prepareReference)image=await prepareReference(value,{signal,deadline,characterId:scope.characterId,conversationId:scope.conversationId});check();
    const bytes=image?.data??image?.bytes,descriptor=image?.descriptor??image;
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>16*1024*1024||!['image/png','image/jpeg','image/webp','image/gif'].includes(descriptor.mime)||!Number.isInteger(descriptor.width)||!Number.isInteger(descriptor.height)||descriptor.width<1||descriptor.height<1||Math.max(descriptor.width,descriptor.height)>3840||descriptor.width*descriptor.height>8294400)fail('IMAGE_REFERENCE_INVALID');
    const copy=Buffer.from(bytes);retained.push(copy);referenceImages.push({bytes:copy,sourceSha256,descriptor:{mime:descriptor.mime,width:descriptor.width,height:descriptor.height}});referenceInputs.push({type:'input_image',image_url:`data:${descriptor.mime};base64,${copy.toString('base64')}`});}finally{if(image!==value)image?.dispose?.();}
   };
   let prompt=input.prompt;
   if(selfie){
    if(!selfieLibrary||typeof selfieLibrary.list!=='function'||typeof selfieLibrary.readForRun!=='function')fail('SELFIE_REFERENCES_MISSING');
    failureStage='catalog';librarySnapshot=await selfieLibrary.list({characterId:scope.characterId});check();libraryVersion=librarySnapshot.version;
    if(!librarySnapshot.items?.length)fail('SELFIE_REFERENCES_MISSING');
    if(typeof rewriteSelfie!=='function')fail('SELFIE_REWRITE_UNAVAILABLE');
    failureStage='rewrite';const rewritten=await abortable(rewriteSelfie({characterId:scope.characterId,characterName:scope.characterName??scope.characterId,prompt,size:input.size??scope.config?.size??'1024x1024',references:librarySnapshot.items.map(({id,note})=>({id,note})),chatImageCount:input.references.length,signal,deadline}),signal);check();
    if(!rewritten||typeof rewritten.prompt!=='string'||!rewritten.prompt.trim()||rewritten.prompt.length>20000||!Array.isArray(rewritten.selectedSelfieReferenceIds)||rewritten.selectedSelfieReferenceIds.length<1||rewritten.selectedSelfieReferenceIds.length>3||new Set(rewritten.selectedSelfieReferenceIds).size!==rewritten.selectedSelfieReferenceIds.length||rewritten.selectedSelfieReferenceIds.some(id=>!librarySnapshot.items.some(item=>item.id===id)))fail('SELFIE_SELECTION_INVALID');
    prompt=rewritten.prompt;
    for(const id of rewritten.selectedSelfieReferenceIds){failureStage='identity-reference';await addReference(await selfieLibrary.readForRun({characterId:scope.characterId,id,revision:libraryVersion,signal}));check();}
   }
   for(const reference of input.references){failureStage='chat-reference';check();const resolver=resolveReference??scope.media.resolveReference;if(typeof resolver!=='function')fail('IMAGE_REFERENCE_UNAVAILABLE');await addReference(await abortable(resolver(reference,{...scope,signal}),signal));}
   check();const size=input.size??scope.config?.size??'1024x1024',quality=input.quality??scope.config?.quality??'high';
   if(!['1024x1024','1024x1536','1536x1024','auto'].includes(size)||!['low','medium','high','auto'].includes(quality))fail('IMAGE_ARGUMENTS_INVALID');
   failureStage='generation';let bytes;if(typeof imageTransport==='function'){const output=await imageTransport({prompt,size,quality,referenceImages},{...scope,signal,deadline});transportCleanup=typeof output?.cleanup==='function'?output.cleanup:undefined;bytes=output?.bytes;if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>32*1024*1024)fail('IMAGE_OUTPUT_INVALID');outputBytes=bytes;check();}else{
   const body={model:provider.textModelId,input:[{role:'user',content:[{type:'input_text',text:prompt},...referenceInputs]}],instructions:'Generate the requested image with the hosted image_generation tool. Return the generated image only.',tools:[{type:'image_generation',model:provider.imageModelId,size,quality}],store:false,stream:true};
   for(let attempt=1;attempt<=3;attempt++){
    check();let response,text;
    try{response=await abortable(fetchImpl(endpoint.href,{method:'POST',headers:{...Object.fromEntries(headers),'content-type':'application/json'},body:JSON.stringify(body),signal,redirect:'error'}),signal);check();text=await responseText(response,signal,maxResponseBytes);check();}
    catch(error){check();providerDiagnostic(scope,response,text);if(error?.code?.startsWith('IMAGE_'))throw error;if(response)fail('IMAGE_RESULT_UNCERTAIN');if(attempt<3&&!(error?.code?.startsWith('IMAGE_'))){await abortable(sleep(attempt*1000,signal),signal);continue;}throw error;}
    if(!response.ok){providerDiagnostic(scope,response,text);if([408,429].includes(response.status)||response.status>=500){if(attempt<3){await abortable(sleep(attempt*1000,signal),signal);continue;}fail('IMAGE_PROVIDER_RETRY_EXHAUSTED');}fail([401,403].includes(response.status)?'IMAGE_PROVIDER_AUTH_REJECTED':'IMAGE_PROVIDER_FAILED');}
    bytes=extractCodexImage(text);outputBytes=bytes;break;
   }
   }
   check();if(provider?.assertCurrent?.()===false)fail('IMAGE_PROVIDER_CHANGED');if(selfie&&(await selfieLibrary.list({characterId:scope.characterId})).version!==libraryVersion)fail('SELFIE_REFERENCES_CHANGED');check();
   failureStage='archive';const descriptor=await scope.media.persistBytes(bytes);check();const src=await workbenchOutput(scope.workspace,descriptor,bytes,check);check();if(selfie&&(await selfieLibrary.list({characterId:scope.characterId})).version!==libraryVersion)fail('SELFIE_REFERENCES_CHANGED');check();
   return {ok:true,status:'completed',media:{...descriptor,src},terminate:false};
  }catch(error){if(signal.aborted)throw Object.assign(new Error(timeout.signal.aborted?'IMAGE_TIMEOUT':'IMAGE_CANCELLED'),{code:timeout.signal.aborted?'IMAGE_TIMEOUT':'IMAGE_CANCELLED'});if(selfie){const receipt=safeSelfieFailure(error?.code,{stage:failureStage});if(receipt)return receipt;}const safe=/^(IMAGE_|SELFIE_|MEDIA_|permission\.)[A-Za-z0-9_.:-]+$/.test(error?.code??'')?error.code:'IMAGE_GENERATION_FAILED';throw Object.assign(new Error(safe),{code:safe});}
  finally{clearTimeout(timer);for(const bytes of retained)bytes.fill(0);outputBytes?.fill(0);try{await transportCleanup?.();}catch{}}
 }
 return {generate};
}
