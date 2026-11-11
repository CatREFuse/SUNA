// Fixed trusted snapshot code. This module is launched only under the parent's
// deny-default Seatbelt profile. It never imports/evaluates workspace JavaScript.
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';

const FILE_LIMIT = 8 * 1024 * 1024, TOTAL_LIMIT = 32 * 1024 * 1024;
const extensions = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.txt', '.md', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf']);
const sensitive = /^(?:credentials?|secrets?|client[-_]auth|auth(?:entication)?|token|password|config|id_rsa|id_ed25519)(?:[._-]|$)/i;
const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'node_modules']);
const fail = code => Object.assign(new Error(code), { code });
const fields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const same = (a, b) => fields.every(key => String(a[key]) === String(b[key]));
function component(value) {
  if (typeof value !== 'string' || !value || value.length > 255 || value.startsWith('.') || forbidden.has(value) || sensitive.test(value) || /[\\/%\x00-\x1f\x7f]/.test(value)) throw fail('PREVIEW_PATH_INVALID');
  return value;
}
async function write(bytes) { await new Promise((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve())); }
async function frame(header, bytes) {
  const json = Buffer.from(JSON.stringify(header)), length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  await write(length); await write(json); if (bytes?.length) await write(bytes);
}
async function verify(handle, target, before) {
  const current = await lstat(target, { bigint: true }), after = await handle.stat({ bigint: true });
  if (current.isSymbolicLink() || !same(before, after) || !same(after, current) || await realpath(target) !== target) throw fail('PREVIEW_FILE_CHANGED');
}
async function snapshot(config) {
  if (!config || typeof config.root !== 'string' || !path.isAbsolute(config.root) || config.root === '/' || typeof config.original !== 'string' || !Array.isArray(config.parts) || !config.binding) throw fail('PREVIEW_INVALID');
  const handles = []; let files = 0, total = 0, entries = 0;
  try {
    const original = await lstat(config.original, { bigint: true });
    if (original.isSymbolicLink() || !original.isDirectory() || !same(original, config.binding) || await realpath(config.original) !== config.root) throw fail('PREVIEW_FILE_CHANGED');
    let target = config.root, handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    handles.push(handle); const rootInfo = await handle.stat({ bigint: true });
    if (!same(rootInfo, config.binding)) throw fail('PREVIEW_FILE_CHANGED');
    for (const item of config.parts) {
      const name = component(item); target = path.join(target, name);
      // The kernel also confines resolution, including intermediate symlinks.
      const info = await lstat(target, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) throw fail('PREVIEW_PATH_INVALID');
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY); handles.push(handle);
      await verify(handle, target, info);
    }
    async function scan(directoryHandle, directoryPath, prefix = '', depth = 0) {
      if (depth > 16) throw fail('PREVIEW_LIMIT');
      const before = await directoryHandle.stat({ bigint: true }); await verify(directoryHandle, directoryPath, before);
      const directory = await opendir(directoryPath);
      for await (const item of directory) {
        if (++entries > 1024) throw fail('PREVIEW_LIMIT');
        const name = component(item.name), relative = prefix ? prefix + '/' + name : name, filePath = path.join(directoryPath, name);
        if (relative.length > 2048) throw fail('PREVIEW_LIMIT');
        const info = await lstat(filePath, { bigint: true });
        if (info.isSymbolicLink()) throw fail('PREVIEW_PATH_INVALID');
        let child;
        try {
          if (info.isDirectory()) {
            child = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
            if (!same(info, await child.stat({ bigint: true }))) throw fail('PREVIEW_FILE_CHANGED');
            await scan(child, filePath, relative, depth + 1);
          } else {
            if (!info.isFile() || info.nlink !== 1n) throw fail('PREVIEW_PATH_INVALID');
            if (!extensions.has(path.extname(name).toLowerCase())) throw fail('PREVIEW_FORMAT_UNSUPPORTED');
            if (++files > 256 || info.size > BigInt(FILE_LIMIT) || total + Number(info.size) > TOTAL_LIMIT) throw fail('PREVIEW_LIMIT');
            child = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const beforeFile = await child.stat({ bigint: true });
            if (!same(info, beforeFile) || !beforeFile.isFile() || beforeFile.nlink !== 1n) throw fail('PREVIEW_FILE_CHANGED');
            // Stream at most 64KiB at a time; the parent owns the sole full
            // snapshot buffer and publishes nothing until the final done frame.
            const bytes = Buffer.alloc(Math.min(Number(beforeFile.size), 65536));
            try {
              let offset = 0;
              await frame({ type: 'file', path: relative, size: Number(beforeFile.size) });
              while (offset < Number(beforeFile.size)) {
                const read = await child.read(bytes, 0, Math.min(bytes.length, Number(beforeFile.size) - offset), null);
                if (!read.bytesRead) throw fail('PREVIEW_FILE_CHANGED');
                await write(bytes.subarray(0, read.bytesRead)); bytes.fill(0); offset += read.bytesRead;
              }
              const extra = Buffer.alloc(1); const tail = await child.read(extra, 0, 1, null); extra.fill(0);
              if (tail.bytesRead) throw fail('PREVIEW_FILE_CHANGED');
              await verify(child, filePath, beforeFile); total += offset;
            } finally { bytes.fill(0); }
          }
        } finally { await child?.close(); }
      }
      await verify(directoryHandle, directoryPath, before);
    }
    await scan(handle, target); await verify(handles[0], config.root, rootInfo);
    const current = await lstat(config.original, { bigint: true });
    if (current.isSymbolicLink() || !same(rootInfo, current) || await realpath(config.original) !== config.root) throw fail('PREVIEW_FILE_CHANGED');
    await frame({ type: 'done', files });
  } finally { await Promise.allSettled(handles.map(handle => handle.close())); }
}
try {
  if (process.argv[2] !== '--suna-preview-snapshot' || process.versions.electron || process.release.name !== 'node') throw fail('PREVIEW_UNAVAILABLE');
  let input = ''; for await (const chunk of process.stdin) { input += chunk.toString('utf8'); if (input.length > 32768) throw fail('PREVIEW_INVALID'); }
  await snapshot(JSON.parse(input));
} catch (error) {
  const code = ['PREVIEW_INVALID', 'PREVIEW_PATH_INVALID', 'PREVIEW_FILE_CHANGED', 'PREVIEW_LIMIT', 'PREVIEW_FORMAT_UNSUPPORTED'].includes(error?.code) ? error.code : 'PREVIEW_UNAVAILABLE';
  await frame({ type: 'error', code }).catch(() => {}); process.exitCode = 1;
}
