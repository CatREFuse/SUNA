/** Records in the channel manager must belong to the selected transport account. */
const validAccountId = value => typeof value === 'string' && value.length > 0 && !/[\s\u0000-\u001f\u007f]/.test(value);

export function accountConversations(conversations, accountId) {
  if (!validAccountId(accountId)) return [];
  return conversations.filter(conversation => {
    if (typeof conversation.channel !== 'string' || !conversation.channel || conversation.channel === 'desktop') return false;
    // The server aggregates verified membership for shared groups. An explicit
    // empty projection is authoritative; never recover membership from labels,
    // participants or a stale primary account when the field is present.
    if (Object.hasOwn(conversation, 'channelAccountIds')) {
      const memberships = conversation.channelAccountIds;
      if (!Array.isArray(memberships) || !Array.from(memberships).every(validAccountId)) return false;
      const privateConversation = conversation.kind === 'direct' || conversation.channelTarget?.kind === 'private';
      // A malformed projection must not turn any private transport into a shared
      // record, even when its public kind incorrectly says group.
      if (privateConversation && conversation.channelTarget?.accountId !== accountId) return false;
      return memberships.includes(accountId);
    }
    // Compatibility with older services is limited to the transport primary.
    return conversation.channelTarget?.accountId === accountId;
  });
}

export function accountRecordConversation(conversations, accountId, conversationId) {
  return accountConversations(conversations, accountId).find(item => item.id === conversationId);
}

/** Do not consume a native target while independent account/snapshot reads race. */
export function resolveAccountRecordTarget(conversations, accounts, target, {fresh = false} = {}) {
  if (!target || typeof target !== 'object') return {status:'waiting',pending:true,reason:'target'};
  const accountId = target.accountId;
  const conversationId = target.conversationId;
  if (conversationId && !validAccountId(accountId)) return {status:'error',pending:false,reason:'account-required'};
  if (!validAccountId(accountId)) return {status:'waiting',pending:true,reason:'target'};
  if (conversationId) {
    const conversation = conversations.find(item => item.id === conversationId);
    if (!conversation) return {status:fresh?'error':'waiting',pending:true,reason:'conversation-missing'};
    if (!accountRecordConversation(conversations, accountId, conversationId)) {
      return {status:'error',pending:false,reason:'account-mismatch'};
    }
  }
  if (!accounts.some(account => account.accountId === accountId)) {
    return {status:fresh?'error':'waiting',pending:true,reason:'account-missing'};
  }
  return {status:'ready',pending:false,accountId,conversationId:conversationId || ''};
}
