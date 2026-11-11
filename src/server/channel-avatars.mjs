// QQ avatars are public resources. Only numeric IDs from a known channel
// account/conversation may reach this service; no caller-supplied URL is used.
export function createChannelAvatars({fetch:fetchImpl=globalThis.fetch}={}){
 const cache=new Map();
 async function get(id,kind='private'){
  if(!/^\d{5,20}$/.test(String(id))||!['private','group'].includes(kind))throw new Error('CHANNEL_AVATAR_UNAVAILABLE');
  const key=`${kind}:${id}`,previous=cache.get(key);if(previous&&previous.until>Date.now())return previous.promise;
  const promise=(async()=>{
   const url=kind==='group'?`https://p.qlogo.cn/gh/${id}/${id}/100`:`https://q.qlogo.cn/headimg_dl?dst_uin=${id}&spec=100&img_type=jpg`;
   const response=await fetchImpl(url,{signal:AbortSignal.timeout(8000),redirect:'error',headers:{accept:'image/png,image/jpeg,image/webp'}});
   if(!response.ok||!response.body)throw new Error('CHANNEL_AVATAR_UNAVAILABLE');
   const chunks=[];let length=0;const reader=response.body.getReader();try{while(true){const{done,value}=await reader.read();if(done)break;length+=value.length;if(length>512*1024)throw new Error('CHANNEL_AVATAR_TOO_LARGE');chunks.push(value)}}finally{await reader.cancel().catch(()=>{})}
   const bytes=Buffer.concat(chunks);let mime;
   if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';
   else if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
   else if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')mime='image/webp';
   else throw new Error('CHANNEL_AVATAR_FORMAT');
   return {bytes,mime,dataUrl:`data:${mime};base64,${bytes.toString('base64')}`};
  })();cache.set(key,{promise,until:Date.now()+3600000});if(cache.size>256)cache.delete(cache.keys().next().value);try{return await promise}catch(error){cache.set(key,{promise,until:Date.now()+30000});throw error}
 }
 return {get};
}


const qqId=value=>typeof value==='string'&&/^\d{5,20}$/.test(value);
/** Resolve only identities already attached to a stored QQ group message. */
export function channelMessageAvatarResolver(snapshot){
 const conversations=new Map(snapshot.conversations.map(item=>[item.id,item])),messages=new Map(snapshot.messages.map(item=>[item.id,item])),characters=new Map(snapshot.characters.map(item=>[item.id,item]));
 return (conversationId,messageId)=>{
 const conversation=conversations.get(conversationId);
 if(!conversation||conversation.channel!=='onebot'||conversation.kind!=='group'||conversation.channelTarget?.platform!=='qq')return null;
 const message=messages.get(messageId);
 if(message?.conversationId!==conversationId||!message?.sender)return null;
 if(message.sender.type==='human')return qqId(message.sender.id)?message.sender.id:null;
 if(message.sender.type!=='character')return null;
 const character=characters.get(message.sender.id);
 if(!character||!conversation.participantIds?.includes(character.id))return null;
 const accounts=(character.accounts??[]).filter(item=>item.channel==='onebot'&&item.platform==='qq'&&qqId(item.userId));
 const current=accounts.find(item=>item.accountId===conversation.channelTarget.accountId);
 if(current)return current.userId;
 const ids=[...new Set(accounts.map(item=>item.userId))];return ids.length===1?ids[0]:null;
 };
}
export function channelMessageAvatarId(snapshot,conversationId,messageId){return channelMessageAvatarResolver(snapshot)(conversationId,messageId);}
export function channelMessageAvatarUrl(conversationId,messageId){
 return `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/avatar`;
}
