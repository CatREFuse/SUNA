import path from 'node:path';
import { constants } from 'node:fs';
import { open, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_PAIRS = 4096;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const fields = new Set(['characterId', 'conversationId', 'enabled', 'expectedVersion']);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const error = (code, reason, message) => Object.assign(new Error(message), { code, reason });
const invalid = reason => error('permission.invalid', reason, '屏幕读取权限配置格式无效');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) && !reserved.has(value);
function pairFor(value) {
  if (!object(value) || !validId(value.characterId) || !validId(value.conversationId)) throw invalid('pair.invalid');
  return Object.freeze({ characterId: value.characterId, conversationId: value.conversationId });
}
const keyFor = pair => JSON.stringify([pair.characterId, pair.conversationId]);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
function parseDocument(value) {
  if (!object(value) || Object.keys(value).some(key => !['schemaVersion', 'version', 'records'].includes(key)) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.version) || value.version < 0 || !Array.isArray(value.records) || value.records.length > MAX_PAIRS) throw invalid('file.invalid');
  const records = new Map(), revisions = new Set();
  for (const record of value.records) {
    const pair = pairFor(record);
    if (Object.keys(record).some(key => !['characterId', 'conversationId', 'enabled', 'revision', 'grantedAt', 'revokedAt'].includes(key)) || typeof record.enabled !== 'boolean' || !Number.isSafeInteger(record.revision) || record.revision < 1 || record.revision > value.version || revisions.has(record.revision) || !timestamp(record.grantedAt) || (record.enabled ? record.revokedAt !== undefined : !timestamp(record.revokedAt)) || records.has(keyFor(pair))) throw invalid('file.invalid');
    records.set(keyFor(pair), { ...pair, enabled: record.enabled, revision: record.revision, grantedAt: record.grantedAt, ...(record.enabled ? {} : { revokedAt: record.revokedAt }) }); revisions.add(record.revision);
  }
  if (records.size === 0 && value.version !== 0) throw invalid('file.invalid');
  return { version: value.version, records };
}
async function readDocument(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw invalid('file.invalid');
    await handle.chmod(0o600);
    const bytes = await handle.readFile(); if (bytes.length > MAX_FILE_BYTES) throw invalid('file.invalid');
    let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw invalid('file.invalid'); }
    return parseDocument(value);
  } catch (failure) {
    if (failure.code === 'ENOENT') return null;
    if (failure.code === 'permission.invalid') throw failure;
    throw error('permission.storage', 'file.unreadable', '屏幕读取权限文件无法安全读取');
  } finally { await handle?.close().catch(() => {}); }
}
async function persist(file, state) {
  const directory = path.dirname(file), temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, version: state.version, records: [...state.records.values()] }, null, 2));
  if (bytes.length > MAX_FILE_BYTES) throw invalid('file.capacity');
  let handle;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, file);
  } catch {
    throw error('permission.storage', 'file.write_failed', '屏幕读取权限保存失败，未更改当前授权');
  } finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
}

/**
 * Single-writer store for role/conversation screen grants. No settings, tool or image integration.
 * await createScreenPermissions({file,validatePair?,onRevoke?,clock?}) ->
 *   snapshot(): {version,grants:[{characterId,conversationId,revision,grantedAt}]}
 *   check({characterId,conversationId}): {allowed,revision}; missing grant revision is 0.
 *   set({characterId,conversationId,enabled,expectedVersion}) -> Promise<snapshot>
 *   grant({...pair,expectedVersion}) / revoke({...pair,expectedVersion}) are set aliases.
 * expectedVersion is mandatory and checked before idempotence. A real grant/revoke increments
 * version; its revision is that new version. Revoked records remain private tombstones so regrant
 * never reuses a revision. Same-state writes are idempotent. validatePair is a synchronous predicate;
 * granting requires true, check denies stale pairs, and revoking an existing orphan remains possible.
 * onRevoke({characterId,conversationId,revision,version}) runs only after durable replacement.
 * A notification failure does not undo revocation; the response then includes revocationNotified:false
 * and notificationError:'permission.notify_failed' without exposing dependency error details.
 */
export async function createScreenPermissions({ file, validatePair = () => true, onRevoke, clock = () => new Date().toISOString() } = {}) {
  if (typeof file !== 'string' || !file || file.includes('\0') || typeof validatePair !== 'function' || (onRevoke !== undefined && typeof onRevoke !== 'function') || typeof clock !== 'function') throw invalid('options.invalid');
  file = path.resolve(file);
  let state = await readDocument(file); if (!state) { state = { version: 0, records: new Map() }; await persist(file, state); }
  let closing = false, writes = Promise.resolve(), closeTask;
  function exists(pair) {
    let result; try { result = validatePair(pair); } catch { return false; }
    if (result && typeof result.then === 'function') { void Promise.resolve(result).catch(() => {}); throw invalid('validator.async'); }
    return result === true;
  }
  function snapshot() {
    return { version: state.version, grants: [...state.records.values()].filter(record => record.enabled).map(({ characterId, conversationId, revision, grantedAt }) => ({ characterId, conversationId, revision, grantedAt })) };
  }
  function check(value) {
    const pair = pairFor(value), record = state.records.get(keyFor(pair));
    return { allowed: !closing && !!record?.enabled && exists(pair), revision: record?.revision ?? 0 };
  }
  function set(input) {
    if (closing) return Promise.reject(error('permission.unavailable', 'store.closed', '屏幕读取权限库已关闭'));
    // Capture primitives before queueing: later caller edits must not change the authorized write.
    let clean;
    try {
      const pair = pairFor(input);
      if (Object.keys(input).some(key => !fields.has(key)) || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw invalid('update.invalid');
      clean = { ...pair, enabled: input.enabled, expectedVersion: input.expectedVersion };
    } catch (failure) { return Promise.reject(failure); }
    const operation = writes.catch(() => {}).then(async () => {
      if (closing) throw error('permission.unavailable', 'store.closed', '屏幕读取权限库已关闭');
      if (clean.expectedVersion !== state.version) throw error('permission.conflict', 'version.changed', '屏幕读取权限已更新，请重新读取后保存');
      const pair = pairFor(clean), key = keyFor(pair), old = state.records.get(key), present = exists(pair);
      if (!present && (clean.enabled || !old)) throw error('permission.notfound', 'pair.notfound', '角色不属于该会话，或角色与会话已不存在');
      if (!!old?.enabled === clean.enabled) return snapshot();
      if (!Number.isSafeInteger(state.version + 1) || (!old && state.records.size >= MAX_PAIRS)) throw invalid('store.capacity');
      let at; try { at = clock(); } catch { throw invalid('clock.invalid'); } if (!timestamp(at)) throw invalid('clock.invalid');
      const version = state.version + 1, record = { ...pair, enabled: clean.enabled, revision: version, grantedAt: clean.enabled ? at : old.grantedAt, ...(clean.enabled ? {} : { revokedAt: at }) };
      const next = { version, records: new Map(state.records) }; next.records.set(key, record);
      await persist(file, next); state = next;
      let notification;
      if (!clean.enabled && onRevoke) {
        try { await onRevoke(Object.freeze({ ...pair, revision: version, version })); }
        catch { notification = { revocationNotified: false, notificationError: 'permission.notify_failed' }; }
      }
      return { ...snapshot(), ...notification };
    });
    writes = operation; return operation;
  }
  function alias(input, enabled) {
    if (!object(input) || (input.enabled !== undefined && input.enabled !== enabled)) return Promise.reject(invalid('update.invalid'));
    return set({ ...input, enabled });
  }
  function close() { if (closeTask) return closeTask; closing = true; closeTask = writes.catch(() => {}); return closeTask; }
  return { migrationRecords:()=>[...state.records.values()].map(record=>({...record})), snapshot, check, set, grant: input => alias(input, true), revoke: input => alias(input, false), close };
}
