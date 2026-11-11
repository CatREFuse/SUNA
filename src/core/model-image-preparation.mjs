import {createHash} from 'node:crypto';

export const MODEL_IMAGE_LIMITS=Object.freeze({bytes:8*1024*1024,side:4096,pixels:4096*4096});
export const IMAGE_PROCESSING_LIMITS=Object.freeze({sourceBytes:32*1024*1024,decodePixels:128*1024*1024,timeoutMs:10000});
const formats=new Map([['image/jpeg','jpeg'],['image/png','png'],['image/webp','webp'],['image/gif','gif']]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Object.assign(new Error(({MESSAGE_IMAGE_RESOURCE_LIMIT:'图片解码超出处理资源预算，请压缩原图后重试',MESSAGE_IMAGE_PROCESSING_TIMEOUT:'图片处理超时，请稍后重试',MESSAGE_IMAGE_PROCESSING_FAILED:'图片无法解码，请重新提供有效图片',MESSAGE_IMAGE_PROCESSING_UNAVAILABLE:'图片处理组件不可用，请检查应用运行时',MESSAGE_IMAGES_TOO_LARGE:'本轮图片输入预算不足',MESSAGE_IMAGE_PROCESSING_BUSY:'图片处理繁忙，请稍后重试',RUN_CANCELLED:'本轮图片访问已失效'})[code]??'图片处理失败'),{code});};
let sharpLoader;
const loadSharp=()=>sharpLoader??=import('sharp').then(module=>module.default);

/** Host-only verified bytes in, independently owned bounded pixels out. No paths,
 * network, permissions or publication are delegated to the image decoder. */
export function createModelImagePreparer({maxCacheBytes=32*1024*1024,maxCacheEntries=16,cacheTtlMs=60000,clock=Date.now,sharpFactory=loadSharp}={}){
 if(![maxCacheBytes,maxCacheEntries,cacheTtlMs].every(v=>Number.isSafeInteger(v)&&v>=0)||typeof clock!=='function'||typeof sharpFactory!=='function')throw new TypeError('Invalid image preparation policy');
 const cache=new Map(),signalKeys=new WeakMap();let cachedBytes=0,tail=Promise.resolve(),pending=0,decodes=0,hits=0;
 function remove(key){const row=cache.get(key);if(row){clearTimeout(row.timer);row.bytes.fill(0);cachedBytes-=row.bytes.length;cache.delete(key);if(row.signal){const owner=signalKeys.get(row.signal);owner?.keys.delete(key);if(owner&&!owner.keys.size){row.signal.removeEventListener('abort',owner.abort);signalKeys.delete(row.signal);}}}}
 function clearScope(scope){for(const [key,row]of cache)if(row.scope===scope)remove(key);}
 function clear(){for(const key of cache.keys())remove(key);}
 function store(key,value,scope,signal){if(value.data.length>maxCacheBytes||maxCacheEntries<1||!cacheTtlMs)return;for(const [id,row]of cache)if(clock()-row.at>=cacheTtlMs)remove(id);while(cache.size>=maxCacheEntries||cachedBytes+value.data.length>maxCacheBytes)remove(cache.keys().next().value);const bytes=Buffer.from(value.data),timer=setTimeout(()=>remove(key),cacheTtlMs);timer.unref?.();cache.set(key,{bytes,descriptor:{...value.descriptor},scope,at:clock(),timer,signal});cachedBytes+=bytes.length;if(signal){let owner=signalKeys.get(signal);if(!owner){owner={keys:new Set(),abort:()=>{for(const id of [...owner.keys])remove(id);}};signalKeys.set(signal,owner);signal.addEventListener('abort',owner.abort,{once:true});}owner.keys.add(key);}}
 async function prepare(value,{limits={},scope='',signal,assertCurrent=()=>{},deadline,cache:useCache=true}={}){
  const expires=Math.min(deadline??Infinity,clock()+IMAGE_PROCESSING_LIMITS.timeoutMs),monotonicExpires=performance.now()+IMAGE_PROCESSING_LIMITS.timeoutMs;
  const check=()=>{signal?.throwIfAborted();const current=assertCurrent();if(current===false||current&&typeof current.then==='function'){void Promise.resolve(current).catch(()=>{});fail('RUN_CANCELLED');}if(!Number.isFinite(expires)||clock()>=expires||performance.now()>=monotonicExpires)fail('MESSAGE_IMAGE_PROCESSING_TIMEOUT');};
  try{check();}catch(error){clearScope(scope);throw error;}if(pending>=16)fail('MESSAGE_IMAGE_PROCESSING_BUSY');pending++;
  const previous=tail;let release;tail=new Promise(resolve=>release=resolve);let source,derived;
  try{
   await previous;check();
   const max={};for(const [name,fallback]of Object.entries(MODEL_IMAGE_LIMITS)){const supplied=limits[name];max[name]=supplied===undefined?fallback:Math.min(fallback,Number.isSafeInteger(supplied)&&supplied>=0?supplied:0);if(max[name]<1)fail('MESSAGE_IMAGES_TOO_LARGE');}
   // Optional native image-generation callers can use the same processing engine
   // with a smaller edge/pixel limit; ordinary model input never exceeds defaults.
   const data=value?.data??value?.bytes,descriptor=value?.descriptor;
   if(!Buffer.isBuffer(data)||!data.length||data.length>IMAGE_PROCESSING_LIMITS.sourceBytes||!descriptor||!formats.has(descriptor.mime)||!Number.isSafeInteger(descriptor.width)||!Number.isSafeInteger(descriptor.height)||Math.min(descriptor.width,descriptor.height)<1)fail('MESSAGE_IMAGE_PROCESSING_FAILED');
   if(descriptor.width*descriptor.height>IMAGE_PROCESSING_LIMITS.decodePixels)fail('MESSAGE_IMAGE_RESOURCE_LIMIT');
   source=Buffer.from(data);const sourceSha256=hash(source);if(descriptor.sha256!==undefined&&descriptor.sha256!==sourceSha256)fail('MESSAGE_IMAGE_PROCESSING_FAILED');
   const key=JSON.stringify([scope,sourceSha256,descriptor.mime,descriptor.width,descriptor.height,max,'model-image-v1']);const cached=useCache?cache.get(key):undefined;
   const owned=(bytes,meta)=>{const copy=Buffer.from(bytes);return {data:copy,descriptor:{...meta},sourceSha256,dispose:()=>copy.fill(0)};};
   if(cached&&clock()-cached.at<cacheTtlMs){check();hits++;cache.delete(key);cache.set(key,cached);return owned(cached.bytes,cached.descriptor);}if(cached)remove(key);
   let sharp;try{sharp=await sharpFactory();}catch{fail('MESSAGE_IMAGE_PROCESSING_UNAVAILABLE');}check();const seconds=()=>{check();const remaining=Math.floor(Math.min(expires-clock(),monotonicExpires-performance.now())/1000);if(remaining<1)fail('MESSAGE_IMAGE_PROCESSING_TIMEOUT');return remaining;};
   const input=()=>sharp(source,{limitInputPixels:IMAGE_PROCESSING_LIMITS.decodePixels,failOn:'warning',sequentialRead:true});
   const meta=await input().timeout({seconds:seconds()}).metadata();check();decodes++;
   if(meta.width!==descriptor.width||meta.height!==descriptor.height||meta.format!==formats.get(descriptor.mime))fail('MESSAGE_IMAGE_PROCESSING_FAILED');
   let result;
   if(source.length<=max.bytes&&Math.max(meta.width,meta.height)<=max.side&&meta.width*meta.height<=max.pixels&&(!meta.orientation||meta.orientation===1)&&!(meta.pages>1)){
    let decoded;try{decoded=await input().raw().timeout({seconds:seconds()}).toBuffer();check();}finally{decoded?.fill(0);}
    result={data:source,descriptor:{...descriptor,sha256:sourceSha256,bytes:source.length}};
   }else{
    const rotate=meta.orientation>=5&&meta.orientation<=8,width=rotate?meta.height:meta.width,height=rotate?meta.width:meta.height;
    let scale=Math.min(1,max.side/Math.max(width,height),Math.sqrt(max.pixels/(width*height)));
    for(let attempt=0;attempt<6;attempt++){
     let pipeline=input().rotate().resize({width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale)),fit:'inside',withoutEnlargement:true});
     pipeline=meta.hasAlpha?pipeline.webp({quality:Math.max(50,85-attempt*7),alphaQuality:100,effort:3}):pipeline.jpeg({quality:Math.max(50,85-attempt*7),mozjpeg:false});
     const output=await pipeline.timeout({seconds:seconds()}).toBuffer({resolveWithObject:true});derived=output.data;check();
     if(derived.length<=max.bytes&&Math.max(output.info.width,output.info.height)<=max.side&&output.info.width*output.info.height<=max.pixels){result={data:derived,descriptor:{mime:meta.hasAlpha?'image/webp':'image/jpeg',width:output.info.width,height:output.info.height,sha256:hash(derived),bytes:derived.length}};break;}
     derived.fill(0);derived=undefined;scale*=0.72;
    }
    if(!result)fail('MESSAGE_IMAGES_TOO_LARGE');
   }
   check();if(useCache)store(key,result,scope,signal);return owned(result.data,result.descriptor);
  }catch(error){if(signal?.aborted)signal.throwIfAborted();if(['RUN_CANCELLED','MESSAGE_IMAGE_RESOURCE_LIMIT','MESSAGE_IMAGE_PROCESSING_TIMEOUT','MESSAGE_IMAGE_PROCESSING_UNAVAILABLE','MESSAGE_IMAGES_TOO_LARGE','MESSAGE_IMAGE_PROCESSING_BUSY'].includes(error?.code))throw error;if(/timeout|timed out/i.test(error?.message??''))fail('MESSAGE_IMAGE_PROCESSING_TIMEOUT');fail('MESSAGE_IMAGE_PROCESSING_FAILED');}
  finally{source?.fill(0);derived?.fill(0);pending--;release();}
 }
 return {prepare,clearScope,clear,stats:()=>({cacheEntries:cache.size,cacheBytes:cachedBytes,pending,decodes,cacheHits:hits})};
}
const shared=createModelImagePreparer();
export const prepareModelImage=(value,options)=>shared.prepare(value,options);
export const clearModelImageCache=scope=>shared.clearScope(scope);
