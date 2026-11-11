import { timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';

export function httpError(status,code,message){return Object.assign(new Error(message),{status,code});}
export function equalSecret(actual,expected){if(typeof actual!=='string')return false;const first=Buffer.from(actual),second=Buffer.from(expected);return first.length===second.length&&timingSafeEqual(first,second);}
export function safeError(error){return String(error?.message??error).replace(/(Bearer\s+)\S+/gi,'$1[已隐藏]').replace(/\bsk-[\w-]{12,}\b/g,'[已隐藏]').replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[已隐藏]@').replace(/([?&](?:token|key|secret|access_token|refresh_token|api_key|password)=)[^\s&]+/gi,'$1[已隐藏]').replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[=:]\s*)[^\s,;]+/gi,'$1[已隐藏]');}
export function sanitize(value,secrets=[]){
  if(Array.isArray(value))return value.map(v=>sanitize(v,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,/(?:token|secret|password|credential|authorization|api.?key)/i.test(key)?'[已隐藏]':sanitize(v,secrets)]));
  if(typeof value==='string'){let output=safeError(value);for(const secret of secrets)if(typeof secret==='string'&&secret.length>=4)output=output.split(secret).join('[已隐藏]');return output;}return value;
}
export async function atomicJson(filename,value){await mkdir(path.dirname(filename),{recursive:true,mode:0o700});const temp=`${filename}.part`;await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await chmod(temp,0o600);await rename(temp,filename);}
export async function loadJson(filename,fallback){try{return JSON.parse(await readFile(filename,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
export async function readBody(req,limit=1024*1024){const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>limit)throw httpError(413,'BODY_TOO_LARGE','文件超过允许大小');const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw httpError(413,'BODY_TOO_LARGE','文件超过允许大小');parts.push(chunk);}return Buffer.concat(parts);}
export async function readJson(req,limit){if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))throw httpError(415,'JSON_REQUIRED','请求需要 application/json');const body=await readBody(req,limit);if(!body.length)return {};try{const value=JSON.parse(body.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw httpError(400,'JSON_INVALID','JSON 请求格式无效');}}
export const mimeTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.vrm':'model/gltf-binary','.wasm':'application/wasm','.moc3':'application/octet-stream'};
