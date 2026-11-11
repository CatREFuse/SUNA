/** Associate only persisted identities. Ordering/timestamps never establish a round. */
export function roundMessages(messages = [], rounds = [], records = []) {
  const byId = new Map(messages.map(message => [message.id, message]));
  const roundIds = new Set(rounds.map(round => round.roundId));
  const triggers = new Map(), runs = new Map();
  // Summary identities cover every round even when the log pane selects one.
  for (const round of rounds) for (const runId of round.runIds ?? []) {
    if (!round.conversationId) continue;
    const ids = runs.get(runId) ?? new Map();
    ids.set(round.roundId, round.conversationId); runs.set(runId, ids);
  }
  for (const round of rounds) if (round.triggerId) {
    const ids = triggers.get(round.triggerId) ?? new Set(); ids.add(round.roundId); triggers.set(round.triggerId, ids);
  }
  for (const record of records) if (record.runId && roundIds.has(record.roundId)) {
    const ids = runs.get(record.runId) ?? new Map();
    ids.set(record.roundId, record.conversationId); runs.set(record.runId, ids);
  }
  const last = new Map();
  for (const message of messages) {
    const associated = new Set(triggers.get(message.id) ?? []);
    const explicit = runs.get(message.runId);
    const matching = explicit ? [...explicit].filter(([,id]) => id === message.conversationId) : [];
    if (matching.length === 1) associated.add(matching[0][0]);
    else if (!explicit) {
      let id = message.replyToMessageId;
      const seen = new Set([message.id]);
      while (id && !seen.has(id)) {
        seen.add(id);
        const parent = byId.get(id);
        if (parent && parent.conversationId !== message.conversationId) break;
        const linked = triggers.get(id);
        if (linked) { for (const roundId of linked) associated.add(roundId); break; }
        id = parent?.replyToMessageId;
      }
    }
    for (const roundId of associated) last.set(roundId, message.id);
  }
  const result = new Map();
  for (const round of rounds) {
    const messageId = last.get(round.roundId); if (!messageId) continue;
    const list = result.get(messageId) ?? []; list.push(round); result.set(messageId, list);
  }
  return result;
}
