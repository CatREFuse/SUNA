import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, rm, realpath} from 'node:fs/promises';
import path from 'node:path';
import {managementFailure} from './plugin-management-errors.mjs';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const packageName = value => typeof value === 'string' && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(value);
async function bytes(filename) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_ARCHIVE_BYTES) throw new Error('archive');
    const data = await handle.readFile();
    if (data.length > MAX_ARCHIVE_BYTES) throw new Error('archive');
    return data;
  } catch { throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID'); }
  finally { await handle?.close(); }
}
const hash = data => createHash('sha512').update(data).digest('hex');

/** Inspection reads tar metadata only. It extracts no files and imports/executes no package code. */
export async function createDshArchiveInspections({directory, targetId, generation, runtimeVersion,
  createArchiveParser, evaluatePluginCompatibility, clock = Date.now, removeFile = filename => rm(filename, {force: true})} = {}) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
  const expectedDirectory = await realpath(directory), inspected = new Map(), ownedFiles = new Map();
  let queue = Promise.resolve();
  const serialized = action => { const task = queue.then(action); queue = task.catch(() => {}); return task; };
  async function assertDirectory() {
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== expectedDirectory) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
  }
  async function removeOwned(filename) {
    const owned = ownedFiles.get(filename);
    if (!owned) return;
    await assertDirectory();
    const info = await lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.dev !== owned.dev || info.ino !== owned.ino ||
        path.dirname(filename) !== directory || !/^[0-9a-f]{128}\.tgz$/.test(path.basename(filename)))) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
    if (info) {
      try { await removeFile(filename); }
      catch { throw managementFailure('DSH_PLUGIN_PROFILE_WRITE_FAILED'); }
    }
    ownedFiles.delete(filename);
  }
  async function collect() {
    await assertDirectory();
    for (const [id, item] of inspected) if (!item.leases && clock() >= Date.parse(item.publicResult.expiresAt)) inspected.delete(id);
    const retained = new Set([...inspected.values()].map(item => item.archive));
    for (const filename of ownedFiles.keys()) if (!retained.has(filename)) await removeOwned(filename);
  }
  async function resolve(input, {leased} = {}) {
    const inspection = inspected.get(input.inspectionId);
    if (!inspection || !leased && clock() >= Date.parse(inspection.publicResult.expiresAt)) throw managementFailure('DSH_PLUGIN_INSPECTION_EXPIRED');
    const record = inspection.publicResult;
    if (record.targetId !== input.targetId || record.generation !== input.generation) throw managementFailure('DSH_PLUGIN_TARGET_CHANGED');
    if (record.revision !== input.expectedRevision) throw managementFailure('DSH_PLUGIN_CONFLICT');
    if (!record.canInstall) throw managementFailure(record.reason);
    await assertDirectory();
    if (hash(await bytes(inspection.archive)) !== inspection.digest) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
    return {archive: inspection.archive, name: record.name, version: record.version, requiresPackaging: inspection.requiresPackaging};
  }
  return {
    inspect(filename, {revision, integrity, packagedWithoutScripts = false} = {}) { return serialized(async () => {
      await collect();
      if (inspected.size >= 256) throw managementFailure('DSH_PLUGIN_BUSY');
      const data = await bytes(filename), digest = hash(data);
      if (integrity && integrity !== 'sha512-' + Buffer.from(digest, 'hex').toString('base64')) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
      // A content-addressed, private, retained copy is what an installation consumes, never the input path.
      const archive = path.join(directory, digest + '.tgz');
      let handle, created = false;
      try {
        handle = await open(archive, 'wx', 0o400); created = true;
        const identity = await handle.stat(); ownedFiles.set(archive, {dev: identity.dev, ino: identity.ino});
        await handle.writeFile(data); await handle.sync();
      } catch (error) {
        if (created) { await handle?.close(); handle = undefined; await removeOwned(archive); }
        if (error.code !== 'EEXIST' || hash(await bytes(archive)) !== digest) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
      } finally { await handle?.close(); }
      let count = 0, total = 0, invalid = false, packageCount = 0;
      const chunks = [], entries = new Map();
      try {
        await new Promise((resolve, reject) => {
          const parser = createArchiveParser({strict: true, maxDecompressionRatio: 1000});
          parser.on('error', reject); parser.on('end', resolve);
          parser.on('entry', entry => {
          const segments = entry.path.split('/');
          if (++count > 10_000 || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
              (total += entry.size) > 128 * 1024 * 1024 || entry.path.includes('\\') ||
              entry.path.startsWith('/') || segments[0] !== 'package' || segments.includes('..') ||
              !['File', 'Directory'].includes(entry.type)) invalid = true;
          if (entry.type === 'File') { if (entries.has(entry.path)) invalid = true; entries.set(entry.path, entry.size); }
          if (invalid) { parser.abort(new Error('Archive limits exceeded')); return; }
          if (entry.path !== 'package/package.json') { entry.resume(); return; }
          if (++packageCount !== 1 || entry.type !== 'File' || entry.size > 1024 * 1024) { invalid = true; parser.abort(new Error('Invalid package metadata')); return; }
          let size = 0;
          entry.on('data', chunk => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(chunk); else { invalid = true; parser.abort(new Error('Metadata limits exceeded')); } });
          entry.resume();
          });
          parser.end(data);
        });
        if (invalid || packageCount !== 1) throw new Error('metadata');
        const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!manifest || !packageName(manifest.name) || typeof manifest.version !== 'string' ||
            !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(manifest.version)) throw new Error('metadata');
        const patch = manifest.dsh?.bundle?.patch;
        const paths = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : [];
        const bundle = paths.length > 0 && paths.every(value => {
          if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').includes('..')) return false;
          const name = 'package/' + value.replace(/^(?:\.\/)+/, '');
          return entries.has(name) && entries.get(name) <= 512 * 1024;
        });
        const compatible = !evaluatePluginCompatibility(manifest, {}, runtimeVersion);
        const inspectionId = randomUUID(), expiresAt = new Date(clock() + 5 * 60_000).toISOString();
        const publicResult = {inspectionId, targetId, generation, revision, name: manifest.name, version: manifest.version,
          compatible, bundle: !!bundle, canInstall: compatible && !!bundle, expiresAt,
          ...(!compatible ? {reason: 'DSH_PLUGIN_INCOMPATIBLE'} : !bundle ? {reason: 'DSH_PLUGIN_PACKAGE_INVALID'} : {})};
        const requiresPackaging = packagedWithoutScripts && ['prepare', 'prepack', 'postpack'].some(key => typeof manifest.scripts?.[key] === 'string' && manifest.scripts[key].trim());
        inspected.set(inspectionId, {publicResult, archive, digest, requiresPackaging, leases: 0});
        return {...publicResult};
      } catch (error) {
        if (created) await removeOwned(archive);
        if (error.code?.startsWith('DSH_PLUGIN_')) throw error;
        throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
      }
    }); },
    resolve: input => serialized(() => resolve(input)),
    acquire(input) { return serialized(async () => {
      await collect();
      const value = await resolve(input), inspection = inspected.get(input.inspectionId);
      inspection.leases++;
      let released = false;
      return {...value,
        verify: () => serialized(() => {
          if (released) throw managementFailure('DSH_PLUGIN_INSPECTION_EXPIRED');
          return resolve(input, {leased: true});
        }),
        release: () => serialized(async () => {
          if (released) return;
          released = true; inspection.leases--;
          await collect();
        })};
    }); },
    hasLease: id => (inspected.get(id)?.leases ?? 0) > 0,
    collect: () => serialized(collect),
    close: () => serialized(collect),
  };
}
