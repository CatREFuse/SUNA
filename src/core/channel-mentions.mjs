export const qqMentionId = value => typeof value === 'string' && /^(?:all|\d{1,20})$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
export const mentionName = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 128) : '';

export function channelMention(userId, name) {
  const id = qqMentionId(userId);
  if (!id) return null;
  return { type: 'mention', platform: 'qq', userId: id, name: id === 'all' ? '全体成员' : mentionName(name) || id };
}

export function mentionContextText(block) {
  const mention = channelMention(block?.userId, block?.name);
  if (!mention) return '[无效提及]';
  if (mention.userId === 'all') return '@全体成员';
  return mention.name === mention.userId ? `@${mention.userId}` : `@${mention.name}（QQ：${mention.userId}）`;
}
