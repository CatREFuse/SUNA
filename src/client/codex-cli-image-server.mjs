import http from 'node:http';
import {prepareModelImage} from '../core/model-image-preparation.mjs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
const failure=code=>Object.assign(new Error(code),{code});
export function finishCodexImageResponse(res,bytes){
 return new Promise((resolve,reject)=>{
  let settled=false;const finish=(error)=>{if(settled)return;settled=true;res.off('finish',done);res.off('error',broken);res.off('close',closed);error?reject(error):resolve();};
  const done=()=>finish(),broken=()=>finish(failure('IMAGE_CANCELLED')),closed=()=>finish(failure('IMAGE_CANCELLED'));
  res.once('finish',done);res.once('error',broken);res.once('close',closed);
  if(res.destroyed){closed();return;}try{res.end(bytes)}catch{broken();}
 });
}
/** Private loopback image-only server; the bearer never leaves Client memory.
 * runner is host-owned and exposes generate/close, never command execution. */
export async function createCodexCliImageServer({runner,maxRequestBytes=Math.ceil(64*1024*1024/3)*4+65536}={}){
 if(typeof runner?.generate!=='function')throw TypeError('Host image runner required');
 const secret=randomBytes(32).toString('hex'),expected=Buffer.from('Bearer '+secret);let closing=false,active=false,closeTask;const controllers=new Set(),handlers=new Set();
 const app=http.createServer(async(req,res)=>{
  const deny=(status,code)=>{if(res.headersSent||res.destroyed){if(!res.destroyed)res.destroy();return;}if(!res.writableEnded){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:{code}}));}};
  const auth=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
  if(req.headers.origin!==undefined||req.headers.host!==`127.0.0.1:${app.address().port}`||auth.length!==expected.length||!timingSafeEqual(auth,expected)){deny(403,'IMAGE_SERVER_FORBIDDEN');return;}
  if(closing){deny(503,'IMAGE_SERVER_CLOSED');return;}
  if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({available:true,busy:active}));return;}
  if(req.method!=='POST'||req.url!=='/generate'){deny(404,'IMAGE_SERVER_ROUTE_INVALID');return;}
  if(active){deny(409,'IMAGE_BUSY');return;}
  if(req.headers['content-type']!=='application/json'){deny(415,'IMAGE_ARGUMENTS_INVALID');return;}
  const controller=new AbortController();controllers.add(controller);active=true;let finished;const owned=new Promise(resolve=>finished=resolve);handlers.add(owned);let output;const references=[];
  const disconnected=()=>{if(!res.writableEnded)controller.abort(failure('IMAGE_CANCELLED'));};res.on('close',disconnected);
  try{
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxRequestBytes)throw failure('IMAGE_ARGUMENTS_INVALID');chunks.push(chunk);}
   const raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['prompt','size','quality','references'].includes(k))||typeof raw.prompt!=='string'||!raw.prompt.trim()||raw.prompt.length>20000)throw failure('IMAGE_ARGUMENTS_INVALID');
   if(raw.size!==undefined&&!['1024x1024','1024x1536','1536x1024','auto'].includes(raw.size)||raw.quality!==undefined&&!['low','medium','high','auto'].includes(raw.quality)||raw.references!==undefined&&!Array.isArray(raw.references)||raw.references?.length>4)throw failure('IMAGE_ARGUMENTS_INVALID');
   for(const ref of raw.references??[]){if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).some(key=>!['data','mime','width','height'].includes(key))||typeof ref.data!=='string'||ref.data.length>Math.ceil(32*1024*1024/3)*4||ref.data.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(ref.data)||!['image/png','image/jpeg','image/webp','image/gif'].includes(ref.mime)||!Number.isInteger(ref.width)||!Number.isInteger(ref.height)||Math.min(ref.width,ref.height)<1)throw failure('IMAGE_REFERENCE_INVALID');const bytes=Buffer.from(ref.data,'base64');if(!bytes.length||bytes.length>32*1024*1024||bytes.toString('base64')!==ref.data){bytes.fill(0);throw failure('IMAGE_REFERENCE_INVALID');}ref.data='';let prepared;try{prepared=await prepareModelImage({data:bytes,descriptor:{mime:ref.mime,width:ref.width,height:ref.height}},{signal:controller.signal,cache:false,limits:{side:3840,pixels:8294400}});references.push({bytes:Buffer.from(prepared.data),descriptor:prepared.descriptor,sourceSha256:prepared.sourceSha256});}catch{throw failure('IMAGE_REFERENCE_INVALID');}finally{bytes.fill(0);prepared?.dispose();}}
   // No cwd, command, model, executable, env, output path or auth is accepted.
   output=await runner.generate({prompt:raw.prompt,size:raw.size,quality:raw.quality,referenceImages:references},{signal:controller.signal});controller.signal.throwIfAborted();
   if(closing)throw failure('IMAGE_CANCELLED');if(!Buffer.isBuffer(output?.bytes)||!output.bytes.length||output.bytes.length>32*1024*1024)throw failure('IMAGE_CLI_OUTPUT_INVALID');
   res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store'});await finishCodexImageResponse(res,output.bytes);
  }catch(error){const code=/^IMAGE_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'IMAGE_GENERATION_FAILED';deny(400,code);}
  finally{res.off('close',disconnected);output?.bytes?.fill(0);for(const ref of references)ref.bytes.fill(0);try{await output?.cleanup?.();}catch{}finally{controllers.delete(controller);active=false;handlers.delete(owned);finished();}}
 });
 app.requestTimeout=650000;app.headersTimeout=10000;
 await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve)});
 return {url:`http://127.0.0.1:${app.address().port}`,authorization:'Bearer '+secret,close(){if(closeTask)return closeTask;closing=true;for(const controller of controllers)controller.abort(failure('IMAGE_CANCELLED'));closeTask=(async()=>{let cleanupError;try{await runner.close?.();}catch(error){cleanupError=error;}finally{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));await Promise.allSettled([...handlers]);}if(cleanupError)throw cleanupError;})();return closeTask;}};
}
