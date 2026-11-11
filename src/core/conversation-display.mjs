// Main-list visibility is a display preference, never a delivery or scheduling policy.
export function channelConversationMainListVisible(conversation){
  return conversation.channel!=='desktop'&&conversation.showInMainList===true;
}

export function validateChannelMainListChange(conversation,patch){
  const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
  if(conversation.channel==='desktop')fail('INVALID_CONVERSATION_DISPLAY','主列表展示设置仅支持频道会话');
  if(typeof patch.showInMainList!=='boolean')fail('INVALID_CONVERSATION_DISPLAY','主列表展示设置必须为布尔值');
  if(!Number.isSafeInteger(patch.expectedVersion)||patch.expectedVersion<1)fail('EXPECTED_VERSION_REQUIRED','请读取最新对话版本后再修改主列表展示');
  if(Object.keys(patch).some(key=>!['showInMainList','expectedVersion'].includes(key)))fail('INVALID_CONVERSATION_DISPLAY','主列表展示设置不能与其他修改一起提交');
  return patch.showInMainList;
}
