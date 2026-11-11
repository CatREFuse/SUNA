import { randomUUID } from 'node:crypto';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
function tokens(text) {
  const clean = String(text).replace(/^\[impression_score:[^\]]+\]\s*/i, '').toLowerCase();
  const result = [...segmenter.segment(clean)].filter(part => part.isWordLike).map(part => part.segment);
  for (const match of clean.matchAll(/[\p{Script=Han}]+/gu)) for (let index = 0; index < match[0].length - 1; index++) result.push(match[0].slice(index, index + 2));
  return result;
}

/** Root owns transactions. apply() must run inside the same transaction as its task commit marker. */
export function createMemoryStore({ db, clock = () => new Date().toISOString() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS long_memories(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,time TEXT NOT NULL,description TEXT NOT NULL,covered TEXT,evidence TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS long_memories_character ON long_memories(character_id);
    CREATE UNIQUE INDEX IF NOT EXISTS long_memories_revision ON long_memories(character_id,covered) WHERE covered IS NOT NULL;
    CREATE TABLE IF NOT EXISTS memory_relations(character_id TEXT NOT NULL,memory_id TEXT NOT NULL,related_id TEXT NOT NULL,description TEXT NOT NULL,time TEXT NOT NULL,PRIMARY KEY(character_id,memory_id,related_id));`);
  const decode = row => row ? { id: row.id, time: row.time, desc: row.description, covered: row.covered, evidence: JSON.parse(row.evidence) } : null;
  const list = characterId => db.prepare('SELECT * FROM long_memories WHERE character_id=? ORDER BY time,rowid').all(characterId).map(decode);
  const owned = (characterId, id) => decode(db.prepare('SELECT * FROM long_memories WHERE character_id=? AND id=?').get(characterId, id));
  function apply(characterId, result, { sourceMessages = [] } = {}) {
    if (!result || !Array.isArray(result.memories) || !Array.isArray(result.relations)) fail('INVALID_MEMORY_RESULT', '长期记忆输出必须包含 memories 与 relations');
    const sources = new Map(sourceMessages.map(message => [String(message.id), String(message.text ?? '')]));
    const identities = new Map(), created = [];
    for (const memory of result.memories) {
      if (typeof memory.id !== 'string' || !memory.id || identities.has(memory.id) || typeof memory.desc !== 'string' || !memory.desc.trim() || !Array.isArray(memory.evidence)) fail('INVALID_MEMORY_RESULT', '长期记忆条目格式无效');
      if (owned(characterId, memory.id)) fail('INVALID_MEMORY_RESULT', '新版本必须使用本批临时 ID，不能覆盖已有记忆正文');
      for (const evidence of memory.evidence) if (!sources.has(String(evidence.source_message)) || typeof evidence.quote !== 'string' || !evidence.quote || !sources.get(String(evidence.source_message)).includes(evidence.quote)) fail('INVALID_MEMORY_EVIDENCE', '证据必须引用本批真实消息与原文');
      identities.set(memory.id, `long_${randomUUID()}`);
    }
    const resolve = id => identities.get(id) ?? (owned(characterId, id) ? id : null);
    for (const memory of result.memories) {
      const id = identities.get(memory.id), covered = memory.covered == null ? null : resolve(memory.covered);
      if (memory.covered != null && !covered) fail('INVALID_MEMORY_REFERENCE', '覆盖引用不属于当前角色或本批记忆');
      if (covered === id) fail('INVALID_MEMORY_REFERENCE', '记忆不能覆盖自身');
      const value = { id, time: clock(), desc: memory.desc, covered, evidence: memory.evidence };
      db.prepare('INSERT INTO long_memories(id,character_id,time,description,covered,evidence) VALUES(?,?,?,?,?,?)').run(id, characterId, value.time, value.desc, covered, JSON.stringify(value.evidence)); created.push(value);
    }
    // Reject coverage cycles even when two new temporary IDs refer to each other.
    for (const memory of created) { const seen = new Set(); let cursor = memory; while (cursor?.covered) { if (seen.has(cursor.id)) fail('INVALID_MEMORY_REFERENCE', '记忆覆盖关系不能形成循环'); seen.add(cursor.id); cursor = owned(characterId, cursor.covered); } }
    const relations = [];
    for (const relation of result.relations) {
      const first = resolve(relation.memory_id), second = resolve(relation.related_id);
      if (!first || !second || first === second || typeof relation.desc !== 'string') fail('INVALID_MEMORY_REFERENCE', '关联端点或关联说明无效');
      const [a, b] = [first, second].sort();
      db.prepare('INSERT INTO memory_relations(character_id,memory_id,related_id,description,time) VALUES(?,?,?,?,?) ON CONFLICT(character_id,memory_id,related_id) DO UPDATE SET description=excluded.description,time=excluded.time').run(characterId, a, b, relation.desc, clock());
      relations.push({ memory_id: a, related_id: b, desc: relation.desc });
    }
    return { memories: created, relations, identities: Object.fromEntries(identities) };
  }
  function recall({ characterId, query, date, limit = 20, maximum = 160 }) {
    if (typeof query !== 'string' || !query.trim()) fail('INVALID_ARGUMENT', '记忆检索 query 不能为空');
    let since = -Infinity, until = Infinity;
    if (date !== undefined) {
      if (!Array.isArray(date) || date.length !== 2 || !date.every(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value.slice(0,10)).toISOString().slice(0,10) === value.slice(0,10))) fail('INVALID_ARGUMENT', '日期必须为 ISO 起止时间');
      [since, until] = date.map(value => Date.parse(value)); if (since > until) fail('INVALID_ARGUMENT', '日期起点不能晚于终点');
    }
    const all = list(characterId), byId = new Map(all.map(memory => [memory.id, memory])), revisions = new Map(all.filter(memory => memory.covered).map(memory => [memory.covered, memory]));
    const queryTokens = [...new Set(tokens(query))]; if (!all.length || !queryTokens.length) return { memories: [], truncated: false };
    const documents = all.map(memory => { const terms = tokens(memory.desc), counts = new Map(); for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1); return { memory, length: terms.length, counts }; });
    const average = Math.max(1, documents.reduce((sum, document) => sum + document.length, 0) / documents.length);
    const frequencies = new Map(queryTokens.map(term => [term, documents.filter(document => document.counts.has(term)).length]));
    const ranked = documents.filter(({ memory }) => Date.parse(memory.time) >= since && Date.parse(memory.time) <= until).map(document => ({ ...document,
      score: queryTokens.reduce((score, term) => { const count = document.counts.get(term) ?? 0, df = frequencies.get(term); return count ? score + Math.log(1 + (all.length - df + 0.5) / (df + 0.5)) * (count * 2.5) / (count + 1.5 * (0.25 + 0.75 * document.length / average)) : score; }, 0),
    })).filter(document => document.score > 0).sort((a, b) => b.score - a.score || b.memory.time.localeCompare(a.memory.time));
    const output = new Map(); let truncated = ranked.length > limit;
    function include(memory, type, level = 0, via) {
      if (!memory) return;
      let value = output.get(memory.id);
      if (!value) { if (output.size >= maximum) { truncated = true; return; } value = { ...memory, types: [], level, ...(via ? { via } : {}) }; output.set(memory.id, value); }
      if (!value.types.includes(type)) value.types.push(type); value.level = Math.min(value.level, level);
    }
    for (const { memory } of ranked.slice(0, Math.max(1, limit))) {
      let cursor = memory, chain = [memory], seen = new Set([memory.id]), hops = 0;
      while (cursor.covered && byId.has(cursor.covered) && hops++ < 128) { cursor = byId.get(cursor.covered); if (seen.has(cursor.id)) { truncated = true; break; } seen.add(cursor.id); chain.unshift(cursor); }
      if (cursor.covered && hops >= 128) truncated = true;
      cursor = memory; let historical = chain.length - 1;
      // The 128-revision body budget must not hide the actual latest version.
      // Follow identity links to the real terminal node even after text truncation.
      while (revisions.has(cursor.id)) { cursor = revisions.get(cursor.id); if (seen.has(cursor.id)) { truncated = true; break; } seen.add(cursor.id); if(historical<128){chain.push(cursor);historical++;}else truncated=true; }
      const latest = !revisions.has(cursor.id) ? cursor : null;
      if(latest&&!chain.some(entry=>entry.id===latest.id))chain.push(latest);
      for (const entry of chain) include(entry, entry.id === memory.id ? 'direct' : chain.indexOf(entry) < chain.indexOf(memory) ? 'older' : 'newer');
      if(latest)include(latest, 'latest');
    }
    const edges = db.prepare('SELECT * FROM memory_relations WHERE character_id=?').all(characterId);
    const seed = [...output.keys()].map(id => ({ id, level: 0 })), seen = new Set(seed.map(value => value.id));
    for (let index = 0; index < seed.length; index++) {
      const { id, level } = seed[index]; if (level >= 3) continue;
      for (const edge of edges.filter(edge => edge.memory_id === id || edge.related_id === id)) {
        const related = edge.memory_id === id ? edge.related_id : edge.memory_id;
        include(byId.get(related), 'related', level + 1, id);
        if (!seen.has(related) && output.has(related)) { seen.add(related); seed.push({ id: related, level: level + 1 }); }
      }
    }
    const memories = [...output.values()].map(value => {
      const related = edges.flatMap(edge => edge.memory_id === value.id && output.has(edge.related_id) ? [{ id: edge.related_id, relation: edge.description }] : edge.related_id === value.id && output.has(edge.memory_id) ? [{ id: edge.memory_id, relation: edge.description }] : []);
      const result = { ...value, type: value.types.includes('direct') ? 'direct' : value.types.includes('latest') ? 'latest' : value.types[0], related };
      if (result.level !== 0) delete result.evidence;
      return result;
    });
    return { memories, truncated };
  }
  return { apply, recall, list };
}
