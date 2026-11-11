import {httpError,readJson} from './security.mjs';
import {createHash} from 'node:crypto';

const MAX_BYTES=8*1024*1024,MAX_BASE64=4*Math.ceil(MAX_BYTES/3),BODY_LIMIT=MAX_BASE64+4096;
const imageTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);
const idPattern=/^[a-f0-9]{64}$/;
const storage=()=>httpError(500,'SELFIE_STORAGE_ERROR','自拍参考图库暂不可用');
const invalid=()=>httpError(400,'SELFIE_ARGUMENT_INVALID','自拍参考图请求参数无效');
const closing=()=>httpError(503,'SERVICE_CLOSING','沙之书正在关闭');
function decode(value){try{return decodeURIComponent(value);}catch{throw invalid();}}
function roleId(value){const id=decode(value);if(!id||id.length>200||id!==id.trim()||/[\s\x00-\x1f\x7f/\\%?#]/.test(id)||['.','..'].includes(id))throw invalid();return id;}
function referenceId(value){const id=decode(value);if(!idPattern.test(id))throw invalid();return id;}
function query(url){try{decodeURIComponent(url.search.slice(1).replaceAll('+',' '));}catch{throw invalid();}if(url.hash||url.searchParams.size)throw invalid();}
function note(value){if(typeof value!=='string'||!value.trim()||[...value.trim()].length>120||/[\x00-\x1f\x7f]/.test(value))throw httpError(400,'SELFIE_NOTE_INVALID','图片说明需为 1～120 字的单行文字');return value.trim();}
function version(value){if(!Number.isSafeInteger(value)||value<0)throw httpError(400,'SELFIE_VERSION_INVALID','自拍参考图库版本无效');return value;}
function bodyFields(body,fields){if(Reflect.ownKeys(body).some(key=>typeof key!=='string'||!fields.includes(key))||fields.some(key=>!Object.hasOwn(body,key)))throw invalid();}
function imageBytes(value){
  if(typeof value!=='string'||!value||value.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw httpError(400,'SELFIE_IMAGE_INVALID','图片需为规范的 Base64 数据');
  if(value.length>MAX_BASE64)throw httpError(413,'SELFIE_IMAGE_TOO_LARGE','图片不能超过 8 MiB');
  const bytes=Buffer.from(value,'base64');
  if(bytes.length>MAX_BYTES){bytes.fill(0);throw httpError(413,'SELFIE_IMAGE_TOO_LARGE','图片不能超过 8 MiB');}
  if(!bytes.length||bytes.toString('base64')!==value){bytes.fill(0);throw httpError(400,'SELFIE_IMAGE_INVALID','图片需为规范的 Base64 数据');}
  return bytes;
}
function catalog(value){
  try{
    if(!value||!Number.isSafeInteger(value.version)||value.version<0||!Array.isArray(value.items)||value.items.length>9||value.version===0&&value.items.length)throw storage();
    const ids=new Set(),items=value.items.map(item=>{
      if(!item||!idPattern.test(item.id)||ids.has(item.id)||note(item.note)!==item.note||!imageTypes.has(item.mime)||!Number.isSafeInteger(item.width)||!Number.isSafeInteger(item.height)||Math.min(item.width,item.height)<1||Math.max(item.width,item.height)>16384||item.width*item.height>64*1024*1024||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>MAX_BYTES)throw storage();
      ids.add(item.id);return {id:item.id,note:item.note,mime:item.mime,width:item.width,height:item.height,bytes:item.bytes};
    });
    return {version:value.version,items};
  }catch{throw storage();}
}
function fixedError(cause){
  const code=cause?.code;
  const messages={
    CHARACTER_NOT_FOUND:[404,'角色不存在'],SELFIE_REFERENCE_NOT_FOUND:[404,'自拍参考图不存在'],
    VERSION_CONFLICT:[409,'自拍参考图库已更新，请重新加载'],SELFIE_REFERENCES_CHANGED:[409,'自拍参考图库已更新，请重新加载'],
    SELFIE_REFERENCE_DUPLICATE:[409,'这张参考图已存在'],SELFIE_REFERENCE_LIMIT:[409,'最多保存 9 张自拍参考图'],
    SELFIE_ARGUMENT_INVALID:[400,'自拍参考图请求参数无效'],SELFIE_CHARACTER_INVALID:[400,'角色标识无效'],
    SELFIE_NOTE_INVALID:[400,'图片说明需为 1～120 字的单行文字'],SELFIE_VERSION_INVALID:[400,'自拍参考图库版本无效'],
    SELFIE_IMAGE_INVALID:[400,'图片需为有效的 PNG、JPEG、GIF 或 WebP'],MEDIA_INVALID_IMAGE:[400,'图片需为有效的 PNG、JPEG、GIF 或 WebP'],
    MEDIA_IMAGE_TOO_LARGE:[400,'图片尺寸超过允许范围'],SELFIE_IMAGE_TOO_LARGE:[413,'图片不能超过 8 MiB'],MEDIA_FILE_TOO_LARGE:[413,'图片不能超过 8 MiB'],
    BODY_TOO_LARGE:[413,'请求内容超过允许大小'],JSON_REQUIRED:[415,'请求需要 application/json'],JSON_INVALID:[400,'JSON 请求格式无效'],
    SERVICE_CLOSING:[503,'沙之书正在关闭'],METHOD_NOT_ALLOWED:[405,'此自拍参考图接口不支持该请求方式'],SELFIE_ROUTE_NOT_FOUND:[404,'自拍参考图接口不存在'],
  };
  const entry=messages[code];return entry?httpError(entry[0],code,entry[1]):storage();
}
function sendImage(res,data,mime){
  return new Promise((resolve,reject)=>{
    let finished=false;
    const clear=()=>{res.removeListener?.('error',onError);res.removeListener?.('close',onClose);res.removeListener?.('finish',onFinish);};
    const settle=cause=>{if(finished)return;finished=true;clear();if(cause)reject(cause);else resolve();};
    const onError=()=>settle(storage()),onClose=()=>settle(storage()),onFinish=()=>settle();
    res.once?.('error',onError);res.once?.('close',onClose);res.once?.('finish',onFinish);
    try{res.writeHead(200,{'content-type':mime,'content-length':data.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(data,cause=>settle(cause?storage():undefined));}catch{settle(storage());}
  });
}

/** Mount after Origin/CSRF checks and before the host's general body reader. */
export function createSelfieLibraryRoutes({library,validateCharacter,writeJson,isClosing=()=>false}={}){
  if(['list','add','update','remove','readForRun'].some(name=>typeof library?.[name]!=='function')||typeof validateCharacter!=='function'||typeof writeJson!=='function'||typeof isClosing!=='function')throw new TypeError('Selfie routes require a scoped library, role validator and JSON writer');
  const active=()=>{if(isClosing())throw closing();};
  async function validate(id){active();const result=await validateCharacter(id);if(result===false||result===null)throw httpError(404,'CHARACTER_NOT_FOUND','角色不存在');active();}
  return async function handle(req,res,url,pathname){
    const prefix=/^\/characters\/([^/]+)\/selfie-references(?=\/|$)/.exec(pathname);if(!prefix)return false;
    let bytes,image;
    try{
      active();query(url);
      const match=/^\/characters\/([^/]+)\/selfie-references(?:\/([^/]+)(\/image)?)?$/.exec(pathname);
      if(!match)throw httpError(404,'SELFIE_ROUTE_NOT_FOUND','自拍参考图接口不存在');
      const characterId=roleId(match[1]),id=match[2]===undefined?undefined:referenceId(match[2]),isImage=!!match[3];
      const allowed=isImage?['GET']:id?['PATCH','DELETE']:['GET','POST'];
      if(!allowed.includes(req.method)){res.setHeader('allow',allowed.join(', '));throw httpError(405,'METHOD_NOT_ALLOWED','此自拍参考图接口不支持该请求方式');}
      await validate(characterId);
      if(req.method==='GET'){
        const current=catalog(await library.list({characterId}));await validate(characterId);
        if(!isImage){await writeJson(res,200,current);return true;}
        if(!current.items.some(item=>item.id===id))throw httpError(404,'SELFIE_REFERENCE_NOT_FOUND','自拍参考图不存在');
        const controller=new AbortController(),abort=()=>controller.abort();req.once?.('aborted',abort);res.once?.('close',abort);
        try{
          image=await library.readForRun({characterId,id,revision:current.version,signal:controller.signal});
          await validate(characterId);if(controller.signal.aborted||req.aborted||res.destroyed)throw storage();
          const item=current.items.find(item=>item.id===id),descriptor=image?.descriptor;
          if(!Buffer.isBuffer(image?.data)||image.data.length<1||image.data.length>MAX_BYTES||!descriptor||descriptor.sha256!==id||descriptor.mime!==item.mime||descriptor.bytes!==image.data.length||descriptor.width!==item.width||descriptor.height!==item.height||createHash('sha256').update(image.data).digest('hex')!==id)throw storage();
          await sendImage(res,image.data,descriptor.mime);return true;
        }finally{req.removeListener?.('aborted',abort);res.removeListener?.('close',abort);image?.data?.fill?.(0);}
      }
      const body=await readJson(req,BODY_LIMIT);await validate(characterId);
      const expectedVersion=version(body.expectedVersion);
      let result;
      if(req.method==='POST'){
        bodyFields(body,['data','note','expectedVersion']);const description=note(body.note);bytes=imageBytes(body.data);body.data='';
        result=await library.add({characterId,bytes,note:description,expectedVersion});
      }else if(req.method==='PATCH'){
        bodyFields(body,['note','expectedVersion']);result=await library.update({characterId,id,note:note(body.note),expectedVersion});
      }else{
        bodyFields(body,['expectedVersion']);result=await library.remove({characterId,id,expectedVersion});
      }
      await validate(characterId);await writeJson(res,200,catalog(result));return true;
    }catch(cause){throw fixedError(cause);}
    finally{bytes?.fill(0);image?.data?.fill?.(0);}
  };
}
