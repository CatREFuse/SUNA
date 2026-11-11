// Read-only record ownership for management navigation, not delivery permission.
// Account/role associations alone do not prove that an account received a group.
export function channelAccountMemberships(snapshot,accounts){
  const entries=new Map();
  for(const conversation of snapshot.conversations){
    if(conversation.channel==='desktop')continue;
    const target=conversation.channelTarget??{};
    const entry={platform:target.platform,primary:target.accountId,shared:conversation.kind==='group'&&target.kind==='group',ids:new Set()};
    const primary=accounts.get(entry.primary);
    if(typeof entry.platform==='string'&&entry.platform&&primary?.platform===entry.platform)entry.ids.add(entry.primary);
    if(entry.shared&&typeof entry.platform==='string'&&entry.platform&&Array.isArray(conversation.channelAccountIds))for(const accountId of conversation.channelAccountIds)if(typeof accountId==='string'&&accounts.get(accountId)?.platform===entry.platform)entry.ids.add(accountId);
    entries.set(conversation.id,entry);
  }
  // One pass over already-loaded messages; never fetch another Book snapshot or
  // repeatedly scan history per conversation. Text/mentions/sender IDs are not evidence.
  for(const message of snapshot.messages){
    const entry=entries.get(message.conversationId);if(!entry?.shared||typeof entry.platform!=='string'||!entry.platform)continue;
    const add=accountId=>{if(typeof accountId==='string'&&accounts.get(accountId)?.platform===entry.platform)entry.ids.add(accountId);};
    add(message.admissionAccountId);
    if(message.replyLeases&&typeof message.replyLeases==='object'&&!Array.isArray(message.replyLeases))for(const lease of Object.values(message.replyLeases))if(lease&&typeof lease==='object'&&!Array.isArray(lease))add(lease.accountId);
  }
  return new Map([...entries].map(([id,entry])=>[id,[...entry.ids].sort((a,b)=>a===b?0:a===entry.primary?-1:b===entry.primary?1:a<b?-1:1)]));
}
