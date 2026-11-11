/** A role's local private conversation is distinct from every Channel and group. */
export function isDesktopDirect(conversation) {
  return conversation?.channel === 'desktop'
    && conversation.kind === 'direct'
    && Array.isArray(conversation.participantIds)
    && conversation.participantIds.length === 1;
}

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const timestamp = value => String(value ?? '');

/** Choose a canonical conversation without changing history or the caller's list. */
export function selectDesktopDirect(conversations, characterId, {preferredId} = {}) {
  const candidates = conversations.filter(conversation =>
    isDesktopDirect(conversation) && conversation.participantIds[0] === characterId);
  const preferred = typeof preferredId === 'string'
    ? candidates.find(conversation => conversation.id === preferredId)
    : undefined;
  if (preferred) return preferred;
  return candidates.sort((left, right) =>
    compareText(timestamp(right.lastMessageAt ?? right.createdAt), timestamp(left.lastMessageAt ?? left.createdAt))
    || compareText(timestamp(right.createdAt), timestamp(left.createdAt))
    || compareText(String(left.id ?? ''), String(right.id ?? '')))[0];
}

/** Pin state must be explicit; strings and numbers are never coerced to booleans. */
export function normalizeConversationPin(value) {
  if (typeof value !== 'boolean') {
    throw Object.assign(new Error('会话置顶状态必须为布尔值'), {code: 'INVALID_CONVERSATION_PIN'});
  }
  return value;
}
