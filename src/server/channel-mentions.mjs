import { channelMention, qqMentionId, mentionName } from '../core/channel-mentions.mjs';

/** Account/group scoped read-only metadata; never invoked by snapshot or rendering. */
export function createChannelMentionResolver({ host, getAccounts, cleanName = mentionName, ttlMs = 300000, backoffMs = 30000, timeoutMs = 1500, maxGroups = 128, maxMembers = 10000, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map(), queue = [], cancellations = new Set(), epochs = new Map();
  let closed = false, active = 0;
  const live = record => !closed && Array.from(getAccounts()).some(item => item === record) && record.platform === 'qq' && record.pluginId === 'suna-napcat' && host.listConnections().some(item => item.accountId === record.accountId && ['connected', 'waiting-webhook'].includes(item.status));
  function remember(key, entry) { cache.delete(key); cache.set(key, entry); while (cache.size > maxGroups) cache.delete(cache.keys().next().value); }
  function pump() { while (!closed && active < 2 && queue.length) { const job = queue.shift(); active++; void job().finally(() => { active--; pump(); }); } }
  function fetchMembers(record, groupId, stamp) {
    const key = JSON.stringify([record.accountId, groupId]), old = cache.get(key);
    const valid = () => live(record) && record.selfId === stamp.selfId && record.config === stamp.config && (epochs.get(record.accountId) ?? 0) === stamp.epoch;
    if (!valid()) return Promise.resolve(null);
    if (old?.record === record && old.selfId === stamp.selfId && old.config === stamp.config && old.epoch === stamp.epoch && old.expires > now()) return Promise.resolve(old.names);
    if (pending.has(key)) return pending.get(key).record === record && pending.get(key).selfId === stamp.selfId && pending.get(key).config === stamp.config && pending.get(key).epoch === stamp.epoch ? pending.get(key).task : Promise.resolve(null);
    if (pending.size >= maxGroups) return Promise.resolve(null);
    let finish, settled = false;
    const task = new Promise(resolve => { finish = value => { if (settled) return; settled = true; clearTimeout(timer); cancellations.delete(cancel); resolve(value); }; });
    const cancel = () => { if (valid()) remember(key, { record, ...stamp, names: new Map(), expires: now() + backoffMs }); finish(null); }, timer = setTimeout(cancel, timeoutMs);
    cancellations.add(cancel);
    const job = async () => {
      if (settled || !valid()) { finish(null); return; }
      try {
        const result = await Promise.race([Promise.resolve().then(() => host.execute(record.accountId, 'get_group_member_list', { group_id: groupId })), task.then(() => null)]);
        if (settled) return;
        const names = new Map();
        if (!valid() || result?.status !== 'ok' || Number(result.retcode ?? 0) !== 0 || !Array.isArray(result.data)) { if (valid()) remember(key, { record, ...stamp, names, expires: now() + backoffMs }); finish(null); return; }
        for (const member of result.data.slice(0, maxMembers)) {
          const id = qqMentionId(member?.user_id); if (!id || id === 'all' || (member.group_id !== undefined && String(member.group_id) !== groupId)) continue;
          const name = mentionName(cleanName(member.card, record)) || mentionName(cleanName(member.nickname, record)); if (name) names.set(id, name);
        }
        remember(key, { record, ...stamp, names, expires: now() + ttlMs });
        finish(names);
      } catch { if (valid()) remember(key, { record, ...stamp, names: new Map(), expires: now() + backoffMs }); finish(null); }
    };
    const wrapped = task.finally(() => { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); if (pending.get(key)?.task === wrapped) pending.delete(key); });
    pending.set(key, { record, ...stamp, task: wrapped }); queue.push(job); pump(); return wrapped;
  }
  function forEvent(record, event) {
    const groupId = event?.message_type === 'group' ? qqMentionId(event.group_id) : null;
    const stamp = { selfId: record.selfId, config: record.config, epoch: epochs.get(record.accountId) ?? 0 };
    return async (segment, { signal } = {}) => {
      const id = qqMentionId(segment?.data?.qq ?? segment?.data?.id);
      if (!id) return null;
      if (id === 'all') return channelMention(id);
      const hint = mentionName(cleanName(segment.data?.name ?? segment.data?.nickname, record)).replace(/^@/, '');
      const fallback = () => channelMention(id, hint);
      if (!groupId || groupId === 'all' || segment.type === 'suna-mention' || !live(record) || signal?.aborted) return fallback();
      let abort;
      const cancelled = new Promise(resolve => { abort = () => resolve(null); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); });
      try {
        const names = await Promise.race([fetchMembers(record, groupId, stamp), cancelled]);
        if (!live(record) || record.selfId !== stamp.selfId || record.config !== stamp.config || (epochs.get(record.accountId) ?? 0) !== stamp.epoch || signal?.aborted) return fallback();
        return channelMention(id, names?.get(id) || hint);
      } finally { signal?.removeEventListener('abort', abort); }
    };
  }
  return { forEvent, invalidate(accountId) { epochs.set(accountId, (epochs.get(accountId) ?? 0) + 1); for (const [key, entry] of cache) if (entry.record.accountId === accountId) cache.delete(key); }, close() { closed = true; cache.clear(); epochs.clear(); for (const cancel of [...cancellations]) cancel(); queue.length = 0; } };
}
