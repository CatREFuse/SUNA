import { channelMention } from '../core/channel-mentions.mjs';
const LOCAL_VIDEO = /^\/media-local\/[a-f0-9]{64}\.(?:mp4|webm|mov)$/;
const LOCAL_IMAGE = /^\/media-local\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/;
export function fileAttachmentUrl(message,block){
  if(typeof message?.conversationId!=='string'||!message.conversationId||typeof block?.attachmentId!=='string'||!block.attachmentId)return '';
  if(/^url_[a-f0-9]{48}$/.test(block.attachmentId)){const controlled=`/api/conversations/${encodeURIComponent(message.conversationId)}/controlled-attachments/${block.attachmentId}/download`;return block.url===controlled?controlled:'';}
  const expected=`/api/conversations/${encodeURIComponent(message.conversationId)}/attachments/${encodeURIComponent(block.attachmentId)}/download`;
  return block.url===expected?expected:'';
}

/** Only persisted attachments can cause an image request in a conversation. */
export function messageBlocks(message) {
  if (!Array.isArray(message.blocks) || !message.blocks.length) {
    return [{ type: 'text', text: String(message.text ?? '') }];
  }
  const blocks = message.blocks.map(block => {
    if (block?.type === 'text') return { type: 'text', text: String(block.text ?? '') };
    if (block?.type === 'mention') {
      const mention = block.platform === 'qq' && channelMention(block.userId, block.name);
      // Names are literal metadata, even when they contain Markdown punctuation.
      const name = mention?.name.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
      return { type: 'text', text: mention ? `@${name}` : '[无效提及]' };
    }
    if (block?.type === 'image') {
      const alt = typeof block.alt === 'string' ? block.alt : '';
      return typeof block.url === 'string' && LOCAL_IMAGE.test(block.url)
        ? { type: 'image', url: block.url, alt }
        : { type: 'unavailable', text: '图片无法加载', alt };
    }
    if(block?.type==='file'){
      const url=fileAttachmentUrl(message,block);
      return url&&typeof block.name==='string'&&Number.isSafeInteger(block.size)&&block.size>=0
        ?{type:'file',url,...(/^url_[a-f0-9]{48}$/.test(block.attachmentId)?{attachmentId:block.attachmentId}:{}),name:block.name,size:block.size,mime:String(block.mime??'application/octet-stream')}
        :{type:'unavailable',text:'文件无法加载'};
    }
    if (block?.type === 'video') {
      const alt = typeof block.alt === 'string' ? block.alt : '';
      return typeof block.url === 'string' && LOCAL_VIDEO.test(block.url)
        ? { type: 'video', url: block.url, alt, ...(typeof block.poster === 'string' && LOCAL_IMAGE.test(block.poster) ? {poster:block.poster} : {}) }
        : { type: 'unavailable', text: '视频无法加载', alt };
    }
    if (block?.type === 'unavailable') return { type: 'unavailable', text: ['图片无法加载','视频无法加载'].includes(block.text) ? block.text : '媒体无法加载', ...(['image','video'].includes(block.mediaType) ? {mediaType:block.mediaType} : {}) };
    return { type: 'unavailable', text: '不支持的消息类型' };
  });
  if (!message.blocks.some(block => block?.type === 'mention')) return blocks;
  return blocks.reduce((merged, block) => {
    if (block.type === 'text' && merged.at(-1)?.type === 'text') merged.at(-1).text += block.text;
    else merged.push(block);
    return merged;
  }, []);
}
