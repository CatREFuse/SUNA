import {MAX_IMAGE_BYTES} from './workbench-media.mjs';
import {prepareModelImage,clearModelImageCache} from './model-image-preparation.mjs';
const LOCAL_IMAGE = /^\/media-local\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))$/;
export const MESSAGE_IMAGE_LIMITS = Object.freeze({count:16, bytes:8*1024*1024, totalBytes:24*1024*1024, side:4096});
const fail = code => {throw Object.assign(new Error(code === 'MESSAGE_IMAGES_TOO_LARGE' ? '会话图片超过模型输入限制' : '会话图片无法安全读取'), {code});};
const erase = images => {for (const image of images) if (Buffer.isBuffer(image.bytes)) image.bytes.fill(0);};

/** A trusted, server-only port. No bytes, paths or callbacks cross bridge JSON. */
export function createMessageImageAccess({characterId, conversationId, messages, maxSequence = Infinity, readStored, signal, assertCurrent = () => {}, limits = {}}) {
  const refs = [];
  for (const message of messages) {
    if (message.conversationId !== conversationId || !Number.isSafeInteger(message.sequence) || message.sequence > maxSequence || message.internal || message.source?.internal || message.sender?.type === 'system' || ['failed','pending','sending','cancelled'].includes(message.status)) continue;
    for (const [blockIndex, block] of (message.blocks ?? []).entries()) if (block.type === 'image') {
      refs.push({messageId:message.id, sequence:message.sequence, sender:{...Object.fromEntries(['type','id'].filter(key => typeof message.sender?.[key] === 'string').map(key => [key,message.sender[key]])),name:typeof message.sender?.name === 'string' ? message.sender.name : ''}, blockIndex, url:block.url});
    }
  }
  refs.sort((a,b)=>a.sequence-b.sequence||a.blockIndex-b.blockIndex);
  if (!refs.length) return undefined;
  const check = extraSignal => {signal?.throwIfAborted();extraSignal?.throwIfAborted();const current=assertCurrent();if(current===false||current&&typeof current.then==='function'){void Promise.resolve(current).catch(()=>{});fail('RUN_CANCELLED');}};
  const scope=JSON.stringify([characterId,conversationId]);
  return Object.freeze({characterId, conversationId, assertCurrent:() => check(), async load({signal:extraSignal,limits:requestLimits={}} = {}) {
    const images = []; let totalBytes = 0;
    try {
      check(extraSignal);
      const budget=Object.fromEntries(Object.entries(MESSAGE_IMAGE_LIMITS).map(([key,value])=>[key,Math.min(value,...[limits[key],requestLimits[key]].filter(v=>Number.isSafeInteger(v)&&v>=0))]));
      if (refs.length > budget.count) fail('MESSAGE_IMAGES_TOO_LARGE');
      const combined = signal && extraSignal ? AbortSignal.any([signal,extraSignal]) : signal ?? extraSignal;
      for (const ref of refs) {
        check(extraSignal);
        const match = typeof ref.url === 'string' && LOCAL_IMAGE.exec(ref.url);
        if (!match) fail('MESSAGE_IMAGE_UNAVAILABLE');
        const result = await readStored(match[1], {maxBytes:MAX_IMAGE_BYTES, signal:combined});
        let prepared,data,descriptor;
        try{
          check(extraSignal);
          if(!Buffer.isBuffer(result?.data)||!result?.descriptor)fail('MESSAGE_IMAGE_UNAVAILABLE');
          prepared=await prepareModelImage(result,{scope,signal:combined,assertCurrent:()=>check(extraSignal),limits:{side:budget.side,bytes:Math.min(budget.bytes,Math.floor((budget.totalBytes-totalBytes)/(refs.length-images.length)))}});
          check(extraSignal);descriptor=prepared.descriptor;data=Buffer.from(prepared.data);
        }finally{prepared?.dispose();if(Buffer.isBuffer(result?.data))result.data.fill(0);}
        const image = {...ref, sender:{...ref.sender}, mime:descriptor.mime, bytes:data, width:descriptor.width, height:descriptor.height};
        delete image.url;
        images.push(image); totalBytes += data.length;
        check(extraSignal);
        if (!Buffer.isBuffer(data) || !['image/png','image/jpeg','image/gif','image/webp'].includes(descriptor.mime)) fail('MESSAGE_IMAGE_UNAVAILABLE');
        if (data.length > budget.bytes || totalBytes > budget.totalBytes || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || Math.min(image.width,image.height) < 1 || Math.max(image.width,image.height) > budget.side) fail('MESSAGE_IMAGES_TOO_LARGE');
      }
      check(extraSignal);
      return {images};
    } catch (error) {
      erase(images);
      clearModelImageCache(scope);
      check(extraSignal);
      if (['MESSAGE_IMAGE_UNAVAILABLE','MESSAGE_IMAGES_TOO_LARGE','RUN_CANCELLED','MESSAGE_IMAGE_RESOURCE_LIMIT','MESSAGE_IMAGE_PROCESSING_TIMEOUT','MESSAGE_IMAGE_PROCESSING_FAILED','MESSAGE_IMAGE_PROCESSING_UNAVAILABLE','MESSAGE_IMAGE_PROCESSING_BUSY'].includes(error.code)) throw error;
      fail(error.code === 'MEDIA_FILE_TOO_LARGE' ? 'MESSAGE_IMAGES_TOO_LARGE' : 'MESSAGE_IMAGE_UNAVAILABLE');
    }
  }});
}

/** Verified pixels live only until transferred to the run relay or disposed. */
export async function prepareMessageImageAccess({messages,protectedMessageIds=[],limits={},...options}) {
  const projected=structuredClone(messages),protectedIds=new Set(protectedMessageIds);
  const bounded=(key,fallback)=>Number.isSafeInteger(limits[key])&&limits[key]>=0?Math.min(limits[key],fallback):fallback;
  const effective=Object.fromEntries(Object.entries(MESSAGE_IMAGE_LIMITS).map(([key,value])=>[key,bounded(key,value)]));
  const historyCount=bounded('historyCount',2),supported=limits.supported!==false;
  const check=()=>{options.signal?.throwIfAborted();options.assertCurrent?.();};
  let loaded=[],disposed=false,transferred=false,totalBytes=0;
  const omit=(message,index)=>{message.blocks[index]={type:'text',text:'[历史图片本轮未提供]'};};
  const refs=[];
  for(const message of projected){
    if(message.conversationId!==options.conversationId||!Number.isSafeInteger(message.sequence)||message.sequence>(options.maxSequence??Infinity)||message.internal||message.source?.internal||message.sender?.type==='system'||['failed','pending','sending','cancelled'].includes(message.status))continue;
    for(const [index,block] of (message.blocks??[]).entries())if(block.type==='image')refs.push({message,index,current:protectedIds.has(message.id)});
  }
  refs.sort((a,b)=>a.message.sequence-b.message.sequence||a.index-b.index);
  const current=refs.filter(ref=>ref.current),history=refs.filter(ref=>!ref.current);
  const dispose=()=>{disposed=true;erase(loaded);loaded=[];clearModelImageCache(JSON.stringify([options.characterId,options.conversationId]));options.signal?.removeEventListener('abort',dispose);};
  options.signal?.addEventListener('abort',dispose,{once:true});
  const accept=async(ref,remaining=1)=>{
    check();
    const single={...ref.message,blocks:ref.message.blocks.map((block,index)=>index===ref.index?block:{type:'text',text:''})};
    const port=createMessageImageAccess({...options,messages:[single],limits:{...effective,bytes:Math.min(effective.bytes,Math.floor((effective.totalBytes-totalBytes)/remaining))}});
    const result=await port.load();
    const image=result.images[0];
    try{
      check();if(disposed)throw Object.assign(new Error('本轮会话图片访问已失效'),{code:'RUN_CANCELLED'});
      if(image.bytes.length>effective.bytes||Math.max(image.width,image.height)>effective.side||totalBytes+image.bytes.length>effective.totalBytes)fail('MESSAGE_IMAGES_TOO_LARGE');
      loaded.push(image);totalBytes+=image.bytes.length;
    }catch(error){erase(result.images);throw error;}
  };
  try {
    check();
    if(current.length&&!supported)throw Object.assign(new Error('当前模型不支持本轮图片输入'),{code:'model.images.unsupported'});
    if(current.length>effective.count)fail('MESSAGE_IMAGES_TOO_LARGE');
    for(const [index,ref]of current.entries())await accept(ref,current.length-index);
    let acceptedHistory=0;
    for(const ref of [...history].reverse()){
      if(!supported||loaded.length>=effective.count||acceptedHistory>=historyCount){omit(ref.message,ref.index);continue;}
      try{await accept(ref);acceptedHistory++;}catch(error){check();if(!['MESSAGE_IMAGE_UNAVAILABLE','MESSAGE_IMAGES_TOO_LARGE','MESSAGE_IMAGE_RESOURCE_LIMIT','MESSAGE_IMAGE_PROCESSING_TIMEOUT','MESSAGE_IMAGE_PROCESSING_FAILED','MESSAGE_IMAGE_PROCESSING_UNAVAILABLE','MESSAGE_IMAGE_PROCESSING_BUSY'].includes(error.code))throw error;omit(ref.message,ref.index);}
    }
    loaded.sort((a,b)=>a.sequence-b.sequence||a.blockIndex-b.blockIndex);
    check();
    const access=loaded.length?Object.freeze(Object.defineProperty({characterId:options.characterId,conversationId:options.conversationId,assertCurrent:()=>{check();if(disposed)throw Object.assign(new Error('本轮会话图片访问已失效'),{code:'RUN_CANCELLED'});},async load({signal}={}){
      try{check();signal?.throwIfAborted();if(disposed||transferred)throw Object.assign(new Error('会话图片已释放'),{code:'MESSAGE_IMAGE_UNAVAILABLE'});
        transferred=true;const images=loaded;loaded=[];options.signal?.removeEventListener('abort',dispose);return {images};
      }catch(error){if(!transferred)dispose();throw error;}
    }},'protectedMessageIds',{value:Object.freeze([...protectedIds]),enumerable:false})):undefined;
    return {messages:projected,get access(){return loaded.length?access:undefined;},dispose,retainMessages(ids){const keep=new Set(ids);for(const image of loaded)if(!keep.has(image.messageId))erase([image]);loaded=loaded.filter(image=>keep.has(image.messageId));}};
  }catch(error){dispose();throw error;}
}
