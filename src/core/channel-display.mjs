/** Pure display projection: transport identifiers remain available on the record. */
const text = value => typeof value === 'string' ? value.trim() : '';
const uuid = value => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
const platformNames = new Map(Object.entries({qq:'QQ',wechat:'微信',weixin:'微信',onebot:'OneBot',telegram:'Telegram',discord:'Discord',slack:'Slack'}));

export function channelPlatformName(platform) {
  const key = text(platform).toLowerCase();
  return platformNames.get(key) ?? '渠道';
}

export function channelAccountName(account = {}) {
  for (const value of [account.accountLabel, account.label, account.selfName]) {
    const name = text(value);
    if (name && !uuid(name) && ![account.accountId, account.id, account.selfId].filter(Boolean).map(String).includes(name)) return name;
  }
  return `${channelPlatformName(account.platform)}账号`;
}

export function channelConversationName(conversation = {}) {
  if (conversation.channel === 'desktop') return conversation.title ?? '';
  const title = text(conversation.title);
  if (conversation.channelTitleSource === 'custom' && title) return title;
  const target = conversation.channelTarget ?? {};
  const details = {...conversation.channelDetails, ...conversation.display?.channel};
  const group = conversation.kind === 'group' || target.kind === 'group';
  const ids = [target.externalTargetId, target.targetId, group ? details.groupId : details.peerId].filter(value => value != null).map(String);
  // Old automatic titles included the canonical target or a category followed by its ID.
  const automatic = !title || ids.includes(title) || (!ids.length && /^\d+$/.test(title)) || uuid(title) || /^[a-z][a-z\d_-]*:(?:group|private):/i.test(title)
    || ids.some(id => ['群聊','群','联系人','单聊','私聊','QQ 群聊','QQ 联系人'].some(label => new RegExp(`^${label}\\s*[:：#-]?\\s*`).test(title) && title.replace(new RegExp(`^${label}\\s*[:：#-]?\\s*`), '') === id));
  if (title && conversation.channelTitleSource !== 'automatic' && !automatic) return title;
  const name = text(group ? details.groupName : details.peerName);
  if (name && !ids.includes(name) && !uuid(name)) return name;
  // An automatic title can still contain a previously resolved real name.
  if (title && !automatic) return title;
  return `${channelPlatformName(details.platform ?? target.platform ?? conversation.channel)} ${group ? '群聊' : '联系人'}（名称未获取）`;
}
