import {createHmac, randomBytes} from 'node:crypto';
import {constants, openSync, closeSync, fstatSync, readFileSync} from 'node:fs';
import path from 'node:path';

const fail = code => { throw Object.assign(new Error(code), {code}); };
const FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'compatibility.json', 'suna-base.patch.json', '.suna-plugin-manager/build-status.json'];

// Only the digest leaves the Runtime. Neither raw configuration nor secret-dependent plain hashes are public.
function stable(value, seen = new Set(), depth = 0) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return typeof value;
  if (depth > 20 || seen.has(value)) fail('DSH_PLUGIN_SCHEMA_UNSUPPORTED');
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length > 4096) fail('DSH_PLUGIN_SCHEMA_UNSUPPORTED');
    return (Array.isArray(value) ? '[' : '{') + Object.keys(descriptors).sort().map(key => {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value')) fail('DSH_PLUGIN_SCHEMA_UNSUPPORTED');
      return JSON.stringify(key) + ':' + stable(descriptor.value, seen, depth + 1);
    }).join(',') + (Array.isArray(value) ? ']' : '}');
  } finally { seen.delete(value); }
}

function fileContent(filename) {
  let descriptor;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) fail('DSH_PLUGIN_PROFILE_INVALID');
    return readFileSync(descriptor);
  } catch (error) {
    if (error.code === 'ENOENT') return Buffer.from('absent');
    if (error.code?.startsWith('DSH_PLUGIN_')) throw error;
    fail('DSH_PLUGIN_PROFILE_INVALID');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Synchronous so ConfigEditor.edit can check it inside its actual official package.json writer lock. */
export function createDshManagementRevision(ctx, directory, {key = randomBytes(32)} = {}) {
  return () => {
    const hmac = createHmac('sha256', key);
    for (const filename of FILES) {
      const content = fileContent(path.join(directory, filename));
      hmac.update(filename + '\0' + content.length + '\0').update(content);
    }
    const entries = [...ctx.loader.entries()].map(entry => ({
      id: entry.id, moduleName: entry.options.name, disabled: entry.options.disabled,
      phase: entry.fiber?.state ?? null, config: entry.options.config,
    }));
    hmac.update(stable(entries));
    return hmac.digest('hex');
  };
}
