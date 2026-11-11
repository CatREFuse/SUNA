import { channelMention } from './channel-mentions.mjs';
const imageUrl=/^\/media-local\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/;
const videoUrl=/^\/media-local\/[a-f0-9]{64}\.(?:mp4|webm|mov)$/;
const invalid=()=>{throw Object.assign(new Error('渠道消息媒体格式无效'),{code:'INVALID_CHANNEL_BLOCKS'});};
/** Only local, content-addressed display data crosses the persisted message boundary. */
export function channelMessageBlocks(value){
 if(!Array.isArray(value)||value.length>128)invalid();
 return value.map(block=>{
  if(!block||typeof block!=='object')invalid();
  if(block.type==='text'){
   if(typeof block.text!=='string'||block.text.length>50000)invalid();
   return {type:'text',text:block.text};
  }
  if(block.type==='mention'){
   const mention=channelMention(block.userId,block.name);
   if(block.platform!=='qq'||typeof block.userId!=='string'||typeof block.name!=='string'||!mention||mention.name!==block.name)invalid();
   return mention;
  }
  if(block.type==='unavailable'){
   if(!['图片无法加载','视频无法加载'].includes(block.text)||block.mediaType!==undefined&&!['image','video'].includes(block.mediaType))invalid();
   return {type:'unavailable',text:block.text,...(block.mediaType?{mediaType:block.mediaType}:{})};
  }
  if(!['image','video'].includes(block.type)||typeof block.url!=='string'||!(block.type==='image'?imageUrl:videoUrl).test(block.url))invalid();
  if(block.alt!==undefined&&(typeof block.alt!=='string'||block.alt.length>2000))invalid();
  if(block.poster!==undefined&&(block.type!=='video'||typeof block.poster!=='string'||!imageUrl.test(block.poster)))invalid();
  return {type:block.type,url:block.url,...(block.alt!==undefined?{alt:block.alt}:{}),...(block.poster?{poster:block.poster}:{})};
 });
}
