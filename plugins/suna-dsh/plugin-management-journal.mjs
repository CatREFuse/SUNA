import {randomBytes, randomUUID, createHmac, createHash} from 'node:crypto';
import {mkdir, open, rename, rm, lstat, realpath} from 'node:fs/promises';
import {constants, openSync, fstatSync, readFileSync, closeSync, lstatSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {parseDshPluginManagement} from './plugin-management-contract.mjs';
import {managementFailure, safeDshManagementError} from './plugin-management-errors.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const methods = new Set(['dsh.install', 'dsh.remove', 'dsh.plugin-enabled', 'dsh.bundle-enabled', 'dsh.configure']);
const applications = new Set(['applied', 'restart-required', 'overridden', 'failed', 'cancelled']);
const restartReasons = new Set(['no-hmr', 'package-moved', 'host-module', 'unmanaged-plugin', 'module-comparison']);
async function atomic(filename, content) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, filename);
  } finally { await handle?.close(); await rm(temporary, {force: true}); }
}
function record(value) {
  if (!value || typeof value !== 'object' || !methods.has(value.method) ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId ?? '') ||
      !['targetId', 'generation', 'createdAt', 'updatedAt'].every(key =>
        typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 256) ||
      !['pending', 'completed', 'unknown'].includes(value.state)) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  const result = Object.fromEntries(['requestId', 'method', 'targetId', 'generation', 'state', 'createdAt', 'updatedAt'].map(key => [key, value[key]]));
  if (applications.has(value.application)) result.application = value.application;
  if (restartReasons.has(value.restartReason)) result.restartReason = value.restartReason;
  if (typeof value.changed === 'boolean') result.changed = value.changed;
  if (value.error) result.error = safeDshManagementError(value.error);
  if (result.state === 'completed' && !result.application) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  return result;
}

/** Stores only operation summaries. Request bodies, specs, config values and secret-derived hashes are never persisted. */
export async function createDshManagementJournal({directory, targetId, generation, clock = () => new Date().toISOString(),
  write = atomic, maximumOperations = 256, maximumArchiveBucketOperations = 4096, maximumArchiveBucketBytes = 4 * 1024 * 1024} = {}) {
  if (!Number.isSafeInteger(maximumOperations) || maximumOperations < 1 || maximumOperations > 256 ||
      !Number.isSafeInteger(maximumArchiveBucketOperations) || maximumArchiveBucketOperations < 1 || maximumArchiveBucketOperations > 4096 ||
      !Number.isSafeInteger(maximumArchiveBucketBytes) || maximumArchiveBucketBytes < 1 || maximumArchiveBucketBytes > 4 * 1024 * 1024) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const filename = path.join(directory, 'operations.json');
  const archiveDirectory = path.join(directory, 'completed');
  await mkdir(archiveDirectory, {recursive: true, mode: 0o700});
  const archiveRealpath = path.join(await realpath(directory), 'completed');
  if ((await lstat(archiveDirectory)).isSymbolicLink() || await realpath(archiveDirectory) !== archiveRealpath) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  const catalogFile = path.join(archiveDirectory, 'index.json');
  const digest = items => createHash('sha256').update(JSON.stringify(items)).digest('hex');
  function readJson(filename, maximumBytes) {
    let descriptor;
    try {
      descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1 || info.size > maximumBytes) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
      return JSON.parse(readFileSync(descriptor, 'utf8'));
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  let catalog;
  try {
    const stored = readJson(catalogFile, 16 * 1024);
    if (stored.version !== 1 || !stored.buckets || typeof stored.buckets !== 'object' || Array.isArray(stored.buckets) ||
        Object.entries(stored.buckets).some(([id, value]) => !/^[0-9a-f]$/.test(id) || !value ||
          !Number.isSafeInteger(value.count) || value.count < 0 || value.count > maximumArchiveBucketOperations || !/^[0-9a-f]{64}$/.test(value.digest))) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    catalog = stored.buckets;
  } catch (error) {
    if (error.code !== 'ENOENT') throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    // A lost index must not make archived IDs look unused after a restart.
    for (const id of '0123456789abcdef') {
      try { await lstat(path.join(archiveDirectory, id + '.json')); throw managementFailure('DSH_PLUGIN_PROFILE_INVALID'); }
      catch (error) { if (error.code !== 'ENOENT') throw managementFailure('DSH_PLUGIN_PROFILE_INVALID'); }
    }
    catalog = {};
  }
  async function checkpointArchive(id, items) {
    const next = {...catalog, [id]: {count: items.length, digest: digest(items)}};
    try { await write(catalogFile, JSON.stringify({version: 1, buckets: next}) + '\n'); }
    catch { throw managementFailure('DSH_PLUGIN_PROFILE_WRITE_FAILED'); }
    catalog = next;
  }
  // Sixteen fixed shards bound disk and lookup memory without loading historical
  // receipts at startup. IDs are retained permanently; there is no unsafe eviction.
  const bucket = requestId => createHash('sha256').update(requestId).digest('hex')[0];
  function readArchive(requestId) {
    const selected = bucket(requestId), archive = path.join(archiveDirectory, selected + '.json');
    try {
      if (lstatSync(archiveDirectory).isSymbolicLink() || realpathSync(archiveDirectory) !== archiveRealpath) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
      const stored = readJson(archive, maximumArchiveBucketBytes);
      if (stored.version !== 1 || !Array.isArray(stored.operations) || stored.operations.length > maximumArchiveBucketOperations) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
      const expected = catalog[selected];
      if (!expected || stored.operations.length < expected.count || digest(stored.operations.slice(0, expected.count)) !== expected.digest) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
      const items = new Map();
      for (const value of stored.operations) {
        const item = record(value);
        if (item.state !== 'completed' || bucket(item.requestId) !== selected || items.has(item.requestId)) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
        items.set(item.requestId, item);
      }
      return {id: selected, filename: archive, items};
    } catch (error) {
      if (error.code === 'ENOENT' && !(catalog[selected]?.count > 0)) return {id: selected, filename: archive, items: new Map()};
      throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    }
  }
  async function archiveCompleted(item) {
    if ((await lstat(archiveDirectory)).isSymbolicLink() || await realpath(archiveDirectory) !== archiveRealpath) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    const archive = readArchive(item.requestId), previous = archive.items.get(item.requestId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(record(item))) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
      await checkpointArchive(archive.id, [...archive.items.values()]);
      return;
    }
    if (archive.items.size >= maximumArchiveBucketOperations) throw managementFailure('DSH_PLUGIN_RECEIPT_CAPACITY');
    archive.items.set(item.requestId, record(item));
    const content = JSON.stringify({version: 1, operations: [...archive.items.values()]}) + '\n';
    if (Buffer.byteLength(content) > maximumArchiveBucketBytes) throw managementFailure('DSH_PLUGIN_RECEIPT_CAPACITY');
    if (!catalog[archive.id]) await checkpointArchive(archive.id, []);
    try { await write(archive.filename, content); }
    catch { throw managementFailure('DSH_PLUGIN_PROFILE_WRITE_FAILED'); }
    // Only then can the hot copy be removed. A crash before this checkpoint
    // leaves an append-only suffix plus the original hot receipt, never a gap.
    await checkpointArchive(archive.id, [...archive.items.values()]);
  }
  const records = new Map(), fingerprints = new Map(), owned = new Map();
  const key = randomBytes(32);
  let queue = Promise.resolve(), dispatchTail = Promise.resolve(), closing = false;
  const tasks = new Set();
  const serialized = action => { const task = queue.then(action); queue = task.catch(() => {}); return task; };
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    const stored = JSON.parse(await handle.readFile('utf8'));
    if (stored.version !== 1 || !Array.isArray(stored.operations) || stored.operations.length > maximumOperations) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    for (const value of stored.operations) {
      const item = record(value);
      if (records.has(item.requestId)) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
      if (item.state === 'pending') {
        Object.assign(item, {state: 'unknown', error: safeDshManagementError(null), updatedAt: clock()});
        delete item.application; delete item.restartReason;
      }
      records.set(item.requestId, item);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  } finally { await handle?.close(); }
  const persist = () => write(filename, JSON.stringify({version: 1, operations: [...records.values()]}) + '\n');
  if (records.size) await persist();
  const assertBinding = input => {
    if (input.targetId !== targetId || input.generation !== generation) throw managementFailure('DSH_PLUGIN_TARGET_CHANGED');
  };
  const unknown = requestId => ({requestId, method: 'dsh.operation', targetId, generation,
    state: 'unknown', error: safeDshManagementError(null), createdAt: clock(), updatedAt: clock()});
  return {
    list: () => [...records.values()].map(clone),
    read(input) { assertBinding(input); return clone(records.get(input.requestId) ?? readArchive(input.requestId).items.get(input.requestId) ?? unknown(input.requestId)); },
    async start(raw, execute, {beforeAdmit} = {}) {
      const input = parseDshPluginManagement(raw);
      if (!methods.has(input.method)) throw managementFailure('DSH_PLUGIN_METHOD_UNSUPPORTED');
      assertBinding(input.params);
      const fingerprint = createHmac('sha256', key).update(JSON.stringify(input)).digest('hex');
      return serialized(async () => {
        if (closing) throw managementFailure('DSH_PLUGIN_DISCONNECTED');
        const requestId = input.params.requestId;
        const prior = records.get(requestId) ?? readArchive(requestId).items.get(requestId);
        if (prior) {
          if (prior.targetId !== targetId) throw managementFailure('DSH_PLUGIN_TARGET_CHANGED');
          // A restart loses the process-only HMAC. Do not pretend an unprovable
          // duplicate is the same request; only operation reads return its receipt.
          if (prior.generation !== generation || !fingerprints.has(requestId)) throw managementFailure('DSH_PLUGIN_RECEIPT_READ_ONLY');
          if (fingerprints.get(requestId) !== fingerprint) throw managementFailure('DSH_PLUGIN_CONFLICT');
          return clone(prior);
        }
        // Existing IDs are resolved first: their original receipt is stable even after configuration revision changes.
        beforeAdmit?.();
        if (records.size >= maximumOperations) {
          const completed = [...records.values()].find(item => item.state === 'completed');
          if (!completed) throw managementFailure('DSH_PLUGIN_BUSY');
          // Archive first, then remove from the hot journal. If either write fails,
          // the old ID remains durably reserved and no new operation is dispatched.
          await archiveCompleted(completed);
          records.delete(completed.requestId);
          try { await persist(); }
          catch { records.set(completed.requestId, completed); throw managementFailure('DSH_PLUGIN_PROFILE_WRITE_FAILED'); }
        }
        const timestamp = clock();
        const item = {requestId, method: input.method, targetId, generation, state: 'pending', createdAt: timestamp, updatedAt: timestamp};
        records.set(requestId, item);
        fingerprints.set(requestId, fingerprint);
        try { await persist(); }
        catch {
          records.delete(requestId); fingerprints.delete(requestId);
          // A failed summary write may have committed, but no business operation has been dispatched.
          throw managementFailure('DSH_PLUGIN_PROFILE_WRITE_FAILED');
        }
        const initial = clone(item);
        const control = {started: false, cancelled: false};
        const task = dispatchTail.then(async () => {
          let result;
          try { control.started = true; result = control.cancelled ? {application: 'cancelled', changed: false} : await execute(input); }
          catch (error) {
            const safe = safeDshManagementError(error);
            result = safe.code === 'DSH_PLUGIN_OPERATION_UNKNOWN' ? {state: 'unknown', error: safe} : {application: 'failed', error: safe};
          }
          await serialized(async () => {
            const update = {updatedAt: clock()};
            if (result?.state === 'unknown' || !applications.has(result?.application)) Object.assign(update, {state: 'unknown', error: safeDshManagementError(null)});
            else {
              Object.assign(update, {state: 'completed', application: result.application});
              if (restartReasons.has(result.restartReason)) update.restartReason = result.restartReason;
              if (typeof result.changed === 'boolean') update.changed = result.changed;
              if (result.error) update.error = safeDshManagementError(result.error);
            }
            Object.assign(item, update);
            try { await persist(); }
            catch {
              Object.assign(item, {state: 'unknown', error: safeDshManagementError(null), updatedAt: clock()});
              delete item.application; delete item.restartReason;
            }
          });
        });
        owned.set(requestId, control);
        tasks.add(task); dispatchTail = task.catch(() => {});
        void task.finally(() => { owned.delete(requestId); tasks.delete(task); }).catch(() => {});
        return initial;
      });
    },
    async cancel(input, cancelActive) {
      assertBinding(input);
      const selected = await serialized(() => {
        const control = owned.get(input.requestId);
        if (!control) return false;
        if (!control.started) { control.cancelled = true; return false; }
        return true;
      });
      // Do not hold the journal queue while an active cancellation waits for its original operation to settle.
      if (selected) await cancelActive(input.requestId);
      return this.read(input);
    },
    async settled() { await Promise.allSettled([...tasks]); await queue; },
    async close() { closing = true; await Promise.allSettled([...tasks]); await queue; },
  };
}
