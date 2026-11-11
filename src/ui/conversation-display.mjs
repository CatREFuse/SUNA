/** A display preference is acknowledged only by a strictly newer authoritative DTO. */
export async function saveChannelMainList({id,shown,getSnapshot,request}){
 const state=getSnapshot(),conversation=state.conversations.find(item=>item.id===id);
 const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
 if(state.capabilities?.channelConversationMainListV1!==true)fail('CHANNEL_DISPLAY_UNSUPPORTED','当前服务不支持调整主列表展示');
 if(!conversation||conversation.channel==='desktop'||conversation.active===false)fail('CHANNEL_DISPLAY_TARGET','该频道会话不可调整');
 if(typeof shown!=='boolean'||!Number.isSafeInteger(conversation.version)||conversation.version<1)fail('CHANNEL_DISPLAY_INVALID','无法确认会话版本，请刷新后重试');
 const expectedVersion=conversation.version;
 const result=await request(`/conversations/${encodeURIComponent(id)}`,{showInMainList:shown,expectedVersion});
 if(!result||result.id!==id||result.channel!==conversation.channel||conversation.channelTarget?.accountId&&result.channelTarget?.accountId!==conversation.channelTarget.accountId||result.showInMainList!==shown||!Number.isSafeInteger(result.version)||result.version<=expectedVersion)fail('CHANNEL_DISPLAY_UNCONFIRMED','保存结果未确认，请重新读取后核对');
 // SSE may already have delivered a newer edit. Never roll it back with this response.
 const latest=getSnapshot().conversations.find(item=>item.id===id);
 if(latest&&latest.version<=result.version)Object.assign(latest,{showInMainList:result.showInMainList,version:result.version});
 return result;
}
