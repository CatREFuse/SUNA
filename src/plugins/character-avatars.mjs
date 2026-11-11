import {open,realpath} from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES=2*1024*1024;
function mime(bytes){
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>=10&&/^GIF8[79]a$/.test(bytes.toString('ascii',0,6)))return 'image/gif';
  if(bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return null;
}

// The caller checks the plugin's role binding. URLs come exclusively from the
// stored character, never an iframe-supplied URL, path or remote fetch.
export function createCharacterAvatars({uiDir,resolveAsset,resolveMedia}={}){
  return {async get(character){
    const url=character?.avatarUrl;
    if(typeof url!=='string'||url.length>500||/[?#%\\\0]/.test(url))return {dataUrl:null};
    let filename;
    try{
      if(/^\/characters\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/.test(url)&&uiDir){
        const root=await realpath(path.join(uiDir,'characters'));
        filename=await realpath(path.join(uiDir,url.slice(1)));
        if(!filename.startsWith(root+path.sep))return {dataUrl:null};
      }else if(/^\/media-local\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(url)&&resolveMedia){filename=await resolveMedia(url.slice('/media-local/'.length));}
      else if(/^\/assets-local\/[A-Za-z0-9_./-]+\.(png|jpe?g|gif|webp)$/.test(url)&&!url.split('/').includes('..')&&resolveAsset){filename=await resolveAsset(url);}
      else return {dataUrl:null};
      const file=await open(filename,'r');
      try{
        const info=await file.stat();if(!info.isFile()||info.size>MAX_BYTES)return {dataUrl:null};
        // Bound reads even if a concurrently replaced/growing file disagrees
        // with the earlier stat; no SVG/HTML or arbitrary binary is projected.
        const bytes=Buffer.alloc(MAX_BYTES+1);const {bytesRead}=await file.read(bytes,0,bytes.length,0);
        if(bytesRead>MAX_BYTES)return {dataUrl:null};
        const data=bytes.subarray(0,bytesRead),type=mime(data);
        return {dataUrl:type?`data:${type};base64,${data.toString('base64')}`:null};
      }finally{await file.close();}
    }catch(error){if(['ENOENT','ENOTDIR','EACCES'].includes(error.code))return {dataUrl:null};throw error;}
  }};
}
