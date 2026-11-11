import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {managementFailure} from './plugin-management-errors.mjs';

const receiptFile = directory => path.join(directory, '.suna-plugin-manager/build-status.json');
const packageName = name => typeof name === 'string' && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name);
async function read(filename, maximum = 4 * 1024 * 1024) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    const bytes = await handle.readFile('utf8');
    if (Buffer.byteLength(bytes) > maximum) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    return bytes;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

/** A private receipt records no script bodies, source URLs, dependency locators, output or credentials. */
export async function readDshBuildStatuses(directory) {
  const text = await read(receiptFile(directory), 256 * 1024);
  if (text === null) return {};
  let record;
  try { record = JSON.parse(text); } catch { throw managementFailure('DSH_PLUGIN_PROFILE_INVALID'); }
  if (record?.version !== 1 || !record.bundles || Array.isArray(record.bundles) ||
      Object.keys(record.bundles).length > 256) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  for (const [name, value] of Object.entries(record.bundles)) if (!packageName(name) || !value ||
      typeof value.version !== 'string' || value.version.length > 100 || value.required !== true ||
      Object.keys(value).some(key => !['version', 'required'].includes(key))) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  return record.bundles;
}

export async function writeDshBuildStatus(directory, name, version, required, sdk) {
  const bundles = await readDshBuildStatuses(directory);
  if (required) Object.defineProperty(bundles, name, {value: {version, required: true}, enumerable: true, configurable: true, writable: true}); else delete bundles[name];
  await sdk.writeFileAtomic(receiptFile(directory), JSON.stringify({version: 1, bundles}) + '\n', {mode: 0o600});
}

/** Follow the actual pnpm snapshot graph so an unrelated pending build cannot block this Bundle. */
export async function dshBundleHasPendingBuilds(directory, name, sdk) {
  const moduleText = await read(path.join(directory, 'node_modules/.modules.yaml'));
  if (moduleText === null) return false;
  if (typeof sdk.parseYaml !== 'function') throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
  const modules = sdk.parseYaml(moduleText), pending = modules?.pendingBuilds ?? [];
  if (!Array.isArray(pending) || pending.length > 8192 || pending.some(item => typeof item !== 'string' || item.length > 4096)) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  if (!pending.length) return false;
  const lockText = await read(path.join(directory, 'pnpm-lock.yaml'));
  if (lockText === null) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  const lock = sdk.parseYaml(lockText), snapshots = lock?.snapshots, importer = lock?.importers?.['.'];
  if (!snapshots || typeof snapshots !== 'object' || Object.keys(snapshots).length > 8192 || !importer) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  const keyOf = (name, input) => {
    const version = typeof input === 'string' ? input : input?.version;
    if (typeof version !== 'string') return null;
    return [`${name}@${version}`, version].find(key => Object.hasOwn(snapshots, key)) ?? null;
  };
  const first = keyOf(name, importer.dependencies?.[name] ?? importer.optionalDependencies?.[name]);
  if (!first) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  const needed = new Set(), queue = [first];
  while (queue.length) {
    const key = queue.pop(); if (needed.has(key)) continue;
    needed.add(key);
    if (needed.size > 8192) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    const snapshot = snapshots[key];
    for (const [dependency, version] of Object.entries({...snapshot.dependencies, ...snapshot.optionalDependencies})) {
      const next = keyOf(dependency, version);
      if (next) queue.push(next);
      else if (typeof version !== 'string' || !version.startsWith('link:')) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    }
  }
  // A format that this exact installer has not produced must not be treated as a successful build.
  if (pending.some(key => !Object.hasOwn(snapshots, key))) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  return pending.some(key => needed.has(key));
}

export async function assertDshBundleBuildReady(directory, name) {
  if ((await readDshBuildStatuses(directory))[name]?.required) throw managementFailure('DSH_PLUGIN_BUILD_APPROVAL_REQUIRED');
}
