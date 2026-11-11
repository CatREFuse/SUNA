import { randomUUID } from 'node:crypto';
import { validatePrompt } from './prompts.mjs';

export class PromptStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'PromptStoreError'; this.code = code; }
}
const fail = (code, message) => { throw new PromptStoreError(code, message); };
const clone = value => structuredClone(value);
const owns = (value, key) => Object.hasOwn(value, key);
const fields = new Set(['description', 'trigger', 'input', 'output', 'writeTarget', 'mode', 'terminate', 'provider', 'model', 'enabled', 'developerSource', 'developerSourceSha256', 'developerSourceVersion']);
const stable = value => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);

function text(value, label, max = 250_000, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail('PROMPT_INVALID', `${label}必须为${empty ? '' : '非空'}文本，最多 ${max} 字符`);
  return value;
}
function version(actual, expected, label = '内容') {
  if (expected === undefined) return;
  if (!Number.isSafeInteger(expected) || expected < 0) fail('INVALID_VERSION', '版本必须为非负整数');
  if (actual !== expected) fail('VERSION_CONFLICT', `${label}已被更新，请刷新后再保存`);
}

export function normalizePromptMetadata(value = {}, descriptor = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_METADATA', '提示词配置必须为对象');
  const result = {};
  for (const [key, input] of Object.entries(value)) {
    if (!fields.has(key)) fail('INVALID_METADATA', `不支持的提示词配置字段：${key}`);
    if (input === undefined) continue;
    if(key==='developerSource'){if(descriptor.scope!=='runtime'||descriptor.name!=='dev'||!['dsh-original','custom'].includes(input))fail('INVALID_METADATA','开发提示词来源无效');result[key]=input;
    }else if(key==='developerSourceSha256'){if(descriptor.scope!=='runtime'||descriptor.name!=='dev'||typeof input!=='string'||!/^([a-f0-9]{64})$/.test(input))fail('INVALID_METADATA','原版来源摘要无效');result[key]=input;
    }else if(key==='developerSourceVersion'){if(descriptor.scope!=='runtime'||descriptor.name!=='dev'||typeof input!=='string'||!/^[a-zA-Z0-9.+_-]{1,100}$/.test(input))fail('INVALID_METADATA','原版版本无效');result[key]=input;
    }else if (key === 'mode') {
      if (!['sync', 'async'].includes(input)) fail('INVALID_METADATA', '返回模式必须为 sync 或 async');
      result.mode = input;
    } else if (key === 'terminate') {
      if (typeof input !== 'boolean' && !['dynamic', 'worker'].includes(input)) fail('INVALID_METADATA', 'terminate 必须为布尔值或 dynamic');
      result.terminate = input === 'worker' ? 'dynamic' : input;
    } else if (key === 'enabled') {
      if (typeof input !== 'boolean') fail('INVALID_METADATA', 'enabled 必须为布尔值');
      result.enabled = input;
    } else {
      result[key] = text(input, key, ['provider', 'model'].includes(key) ? 200 : 50_000);
      if (['provider', 'model'].includes(key)) result[key] = result[key].trim();
    }
  }
  if (descriptor.scope === 'runtime' && descriptor.name === 'dev' && result.enabled === undefined) result.enabled = false;
  return result;
}

export function promptKey({ characterId, scope = 'runtime', name = 'system' } = {}) {
  if (!['runtime', 'worker', 'tool'].includes(scope)) fail('INVALID_SCOPE', '提示词类型无效');
  if (typeof name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(name)) fail('PROMPT_INVALID', '模板标识只能包含字母、数字、下划线、点和短横线');
  if (characterId !== undefined && (typeof characterId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(characterId))) fail('CHARACTER_NOT_FOUND', '角色标识无效');
  return `${characterId ?? '*'}:${scope}:${name}`;
}

/** Inject the existing synchronous SQLite entity repository; this module owns no service lifecycle. */
export function createPromptStore({ read, list, put, transaction, db, clock = () => new Date().toISOString(), requireOpen = () => {}, requireCharacter, emit = () => {}, log = () => {}, validate = validatePrompt } = {}) {
  if (![read, list, put, transaction].every(value => typeof value === 'function') || !db?.prepare || !db?.exec) throw new TypeError('Prompt store requires read/list/put/transaction/db');
  db.exec(`CREATE TABLE IF NOT EXISTS prompt_revisions(key TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(key,revision));
    CREATE TABLE IF NOT EXISTS prompt_checkpoints(id TEXT PRIMARY KEY,key TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS prompt_checkpoints_key ON prompt_checkpoints(key);`);
  const ensureCharacter = requireCharacter ?? (key => { if (!read('character', key)) fail('CHARACTER_NOT_FOUND', '角色不存在'); });
  function identity(input = {}) {
    requireOpen();
    const result = { scope: input.scope ?? 'runtime', name: input.name ?? 'system', ...(input.characterId !== undefined ? { characterId: input.characterId } : {}) };
    if(result.scope==='worker'&&['group_scheduler','group_moderator'].includes(result.name)&&result.characterId)fail('PROMPT_GLOBAL_ONLY','群聊调度 Worker 提示词仅支持全局配置');
    const key = promptKey(result);
    if (result.characterId) ensureCharacter(result.characterId);
    return { ...result, key };
  }
  function promptHead(input = {}) {
    const descriptor = identity(input), own = read('prompt', descriptor.key);
    if (own && own.revision > 0) return own;
    if (!descriptor.characterId) return null;
    const global = read('prompt', promptKey({ ...descriptor, characterId: undefined }));
    return global?.revision > 0 ? global : null;
  }
  function touchConfig(patch = {}) {
    return put('meta', 'prompt-config', { ...read('meta', 'prompt-config'), ...patch });
  }
  function normalizeEntry(input, descriptor, fallback, { draft = false, incomplete = false } = {}) {
    if(descriptor.scope==='worker'&&['group_scheduler','group_moderator'].includes(descriptor.name)&&descriptor.characterId)fail('PROMPT_GLOBAL_ONLY','群聊调度 Worker 提示词仅支持全局配置');
    const content = text(owns(input, 'content') ? input.content : (draft ? fallback?.draft ?? fallback?.content : fallback?.content) ?? '', '提示词');
    const label = text(owns(input, 'label') ? input.label : (draft ? fallback?.draftLabel : fallback?.label) ?? fallback?.label ?? descriptor.name, '名称', 120, { empty: incomplete }).trim();
    const metadata = normalizePromptMetadata(owns(input, 'metadata') ? input.metadata : (draft ? fallback?.draftMetadata : fallback?.metadata) ?? fallback?.metadata ?? {}, descriptor);
    return { content, label, metadata };
  }
  function validatePublished(content, scope) {
    const result = validate(content, { scope });
    if (!result.valid) fail('PROMPT_INVALID', result.errors.join('；'));
  }
  function writePublication(descriptor, current, entry) {
    const value = { ...current, id: descriptor.key, ...descriptor, ...entry, draft: entry.content, draftLabel: entry.label, draftMetadata: clone(entry.metadata), revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? clock(), publishedAt: clock() };
    const saved = put('prompt', descriptor.key, value);
    db.prepare('INSERT INTO prompt_revisions(key,revision,payload) VALUES(?,?,?)').run(descriptor.key, saved.revision, JSON.stringify(saved));
    return saved;
  }
  function seedPrompt(input, content, label, metadata = input?.metadata ?? {}) {
    const descriptor = identity(input);
    if (read('prompt', descriptor.key)) return read('prompt', descriptor.key);
    const entry = normalizeEntry({ content, label: label ?? input.label ?? descriptor.name, metadata }, descriptor);
    validatePublished(entry.content, descriptor.scope);
    return transaction(() => {
      const existing = read('prompt', descriptor.key); if (existing) return existing;
      const saved = writePublication(descriptor, null, entry); touchConfig(); return saved;
    });
  }
  function savePromptDraft(input = {}) {
    const descriptor = identity(input);
    const saved = transaction(() => {
      const old = read('prompt', descriptor.key), inherited = promptHead(descriptor);
      version(old?.version ?? 0, input.expectedVersion);
      const fallback = old ?? (inherited ? { ...inherited, draft: inherited.content, draftLabel: inherited.label, draftMetadata: inherited.metadata } : null);
      const entry = normalizeEntry(input, descriptor, fallback, { draft: true, incomplete: true });
      const base = old ?? { id: descriptor.key, ...descriptor, revision: 0, content: inherited?.content ?? '', label: inherited?.label ?? descriptor.name, metadata: normalizePromptMetadata(inherited?.metadata ?? {}, descriptor), createdAt: clock() };
      const value = put('prompt', descriptor.key, { ...base, draft: entry.content, draftLabel: entry.label, draftMetadata: entry.metadata });
      touchConfig(); return value;
    });
    emit('prompts.changed');
    return { ...saved, validation: validate(saved.draft, { scope: descriptor.scope }) };
  }
  function publishPrompt(input = {}) {
    const descriptor = identity(input);
    const saved = transaction(() => {
      const current = read('prompt', descriptor.key);
      version(current?.revision ?? 0, input.expectedRevision, '提示词');
      version(current?.version ?? 0, input.expectedVersion);
      const inherited = current ? null : promptHead(descriptor);
      const fallback = current ?? (inherited ? { ...inherited, draft: inherited.content, draftLabel: inherited.label, draftMetadata: inherited.metadata } : null);
      const entry = normalizeEntry(input, descriptor, fallback, { draft: true });
      validatePublished(entry.content, descriptor.scope);
      const value = writePublication(descriptor, current, entry);
      touchConfig({ publishedAt: clock() }); return value;
    });
    emit('prompts.changed'); return saved;
  }
  function promptHistory(input = {}) {
    const descriptor = identity(input);
    return db.prepare('SELECT payload FROM prompt_revisions WHERE key=? ORDER BY revision DESC').all(descriptor.key).map(row => JSON.parse(row.payload));
  }
  function rollbackPrompt(input = {}) {
    const entry = promptHistory(input).find(item => item.revision === Number(input.revision));
    if (!entry) fail('REVISION_NOT_FOUND', '该版本不存在');
    return publishPrompt({ ...input, content: entry.content, label: entry.label, metadata: entry.metadata ?? {} });
  }
  function exportPromptConfig() {
    requireOpen();
    const meta = read('meta', 'prompt-config');
    return { schema: 'book.prompt-config', version: 1, exportedAt: clock(), revision: meta?.version ?? 0, source: meta?.source ?? null,
      prompts: list('prompt').filter(entry => entry.revision > 0).map(({ scope, name, characterId, content, label, metadata, revision }) => ({ scope, name, ...(characterId ? { characterId } : {}), content, label, metadata: normalizePromptMetadata(metadata ?? {}, { scope, name }), revision })) };
  }
  function importPromptConfig(envelope, { preview = false, expectedVersion } = {}) {
    requireOpen();
    if (envelope?.schema !== 'book.prompt-config' || envelope.version !== 1 || !Array.isArray(envelope.prompts) || envelope.prompts.length > 1000) fail('CONFIG_INVALID', '配置包格式无效');
    let source;
    try { const encoded = JSON.stringify(envelope.source ?? null); if (encoded.length > 32_000) throw new Error(); source = JSON.parse(encoded); } catch { fail('CONFIG_INVALID', '来源元数据格式无效或过长'); }
    const result = transaction(() => {
      const currentVersion = read('meta', 'prompt-config')?.version ?? 0;
      version(currentVersion, expectedVersion, '配置包');
      const seen = new Set();
      const changes = envelope.prompts.map(input => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('CONFIG_INVALID', '模板配置必须为对象');
        const descriptor = identity(input);
        if (seen.has(descriptor.key)) fail('CONFIG_INVALID', '配置包包含重复模板'); seen.add(descriptor.key);
        const existing = read('prompt', descriptor.key);
        const entry = normalizeEntry(input, descriptor, existing);
        validatePublished(entry.content, descriptor.scope);
        const same = existing?.revision > 0 && existing.content === entry.content && existing.label === entry.label && stable(normalizePromptMetadata(existing.metadata ?? {}, descriptor)) === stable(entry.metadata);
        const overwritesDraft = Boolean(existing && ((existing.draft ?? existing.content) !== existing.content || (existing.draftLabel ?? existing.label) !== existing.label || stable(existing.draftMetadata ?? existing.metadata ?? {}) !== stable(existing.metadata ?? {})));
        return { ...descriptor, ...entry, change: same ? 'unchanged' : existing?.revision > 0 ? 'replace' : 'add', overwritesDraft };
      });
      const summary = changes.map(({ content, ...change }) => change);
      if (preview) return { revision: currentVersion, source, changes: summary };
      for (const { change, overwritesDraft, ...entry } of changes) {
        if (change === 'unchanged') continue;
        const descriptor = identity(entry);
        writePublication(descriptor, read('prompt', descriptor.key), { content: entry.content, label: entry.label, metadata: entry.metadata });
      }
      const meta = touchConfig({ source, importedAt: clock() });
      return { revision: meta.version, source, changes: summary };
    });
    if (!preview) { log('prompts.imported', { count: result.changes.length, source }); emit('prompts.changed'); }
    return result;
  }
  function listPromptCheckpoints(input = {}) {
    const descriptor = identity(input);
    return db.prepare('SELECT payload FROM prompt_checkpoints WHERE key=? ORDER BY rowid DESC').all(descriptor.key).map(row => JSON.parse(row.payload));
  }
  function getPromptCheckpoint(id) {
    requireOpen(); text(id, 'Checkpoint ID', 200, { empty: false });
    const row = db.prepare('SELECT payload FROM prompt_checkpoints WHERE id=?').get(id);
    if (!row) fail('CHECKPOINT_NOT_FOUND', 'Checkpoint 不存在');
    return JSON.parse(row.payload);
  }
  function createPromptCheckpoint(input = {}) {
    const descriptor = identity(input);
    const saved = transaction(() => {
      const current = read('prompt', descriptor.key) ?? promptHead(descriptor);
      version(current?.version ?? 0, input.expectedVersion);
      const entry = normalizeEntry({ ...(owns(input, 'content') ? { content: input.content } : {}), ...(owns(input, 'entryLabel') ? { label: input.entryLabel } : {}), ...(owns(input, 'metadata') ? { metadata: input.metadata } : {}) }, descriptor, current, { draft: true, incomplete: true });
      const count = db.prepare('SELECT COUNT(*) AS total FROM prompt_checkpoints WHERE key=?').get(descriptor.key).total;
      const label = text(input.label === undefined ? '' : input.label, 'Checkpoint 名称', 120).trim() || `#${count + 1}`;
      const value = { id: `checkpoint_${randomUUID()}`, ...descriptor, label, entryLabel: entry.label, content: entry.content, metadata: entry.metadata, createdAt: clock(), version: 1 };
      db.prepare('INSERT INTO prompt_checkpoints(id,key,payload) VALUES(?,?,?)').run(value.id, descriptor.key, JSON.stringify(value)); return value;
    });
    emit('prompts.checkpoints.changed', { key: descriptor.key }); return saved;
  }
  function updatePromptCheckpoint(id, patch = {}) {
    const saved = transaction(() => {
      const current = getPromptCheckpoint(id); version(current.version ?? 1, patch.expectedVersion, 'Checkpoint');
      const value = { ...current, label: text(patch.label, 'Checkpoint 名称', 120, { empty: false }).trim(), version: (current.version ?? 1) + 1, updatedAt: clock() };
      db.prepare('UPDATE prompt_checkpoints SET payload=? WHERE id=?').run(JSON.stringify(value), id); return value;
    });
    emit('prompts.checkpoints.changed', { key: saved.key }); return saved;
  }
  function deletePromptCheckpoint(id, options = {}) {
    const current = transaction(() => { const entry = getPromptCheckpoint(id); version(entry.version ?? 1, options.expectedVersion, 'Checkpoint'); db.prepare('DELETE FROM prompt_checkpoints WHERE id=?').run(id); return entry; });
    emit('prompts.checkpoints.changed', { key: current.key }); return { id, deleted: true };
  }
  return { promptKey, promptHead, seedPrompt, savePromptDraft, publishPrompt, promptHistory, rollbackPrompt, exportPromptConfig, importPromptConfig, createPromptCheckpoint, listPromptCheckpoints, getPromptCheckpoint, updatePromptCheckpoint, deletePromptCheckpoint };
}
