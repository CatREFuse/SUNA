import {validatePluginUI} from '../plugins/ui-package.mjs';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeName(name) {
  if (!name || name.length > 240 || !/^[a-zA-Z0-9._/-]+$/.test(name) || name.startsWith('/') ||
      name.split('/').some(s => !s || s === '.' || s === '..') || name.includes(':')) throw new Error('PLUGIN_ARCHIVE_UNSAFE_PATH');
  return name;
}

/** Small bounded ZIP reader. No shell extraction; paths, symlinks, sizes and CRC are checked before writes. */
export function readZip(input, { maxBytes = 8 * 1024 * 1024, maxFiles = 64 } = {}) {
  const bytes = Buffer.from(input);
  if (bytes.length > maxBytes || bytes.length < 22) throw new Error('PLUGIN_ARCHIVE_SIZE');
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { eocd = i; break; }
  }
  if (eocd < 0 || bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6)) throw new Error('PLUGIN_ARCHIVE_FORMAT');
  const count = bytes.readUInt16LE(eocd + 10), centralSize = bytes.readUInt32LE(eocd + 12), centralStart = bytes.readUInt32LE(eocd + 16);
  if (!count || count > maxFiles || bytes.readUInt16LE(eocd + 8) !== count || centralStart + centralSize !== eocd) throw new Error('PLUGIN_ARCHIVE_DIRECTORY');
  let pos = centralStart, expanded = 0;
  const files = new Map(), occupied = [], caseNames = new Set();
  for (let i = 0; i < count; i++) {
    if (pos + 46 > eocd || bytes.readUInt32LE(pos) !== 0x02014b50) throw new Error('PLUGIN_ARCHIVE_DIRECTORY');
    const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10), crc = bytes.readUInt32LE(pos + 16);
    const compressed = bytes.readUInt32LE(pos + 20), size = bytes.readUInt32LE(pos + 24);
    const nameLen = bytes.readUInt16LE(pos + 28), extra = bytes.readUInt16LE(pos + 30), comment = bytes.readUInt16LE(pos + 32);
    const attrs = bytes.readUInt32LE(pos + 38), offset = bytes.readUInt32LE(pos + 42);
    if (pos + 46 + nameLen + extra + comment > eocd) throw new Error('PLUGIN_ARCHIVE_DIRECTORY');
    const name = safeName(bytes.subarray(pos + 46, pos + 46 + nameLen).toString('utf8'));
    if (caseNames.has(name.toLowerCase()) || ((attrs >>> 16) & 0xf000) === 0xa000 || (flags & 1) || ![0, 8].includes(method)) throw new Error('PLUGIN_ARCHIVE_UNSUPPORTED_ENTRY');
    caseNames.add(name.toLowerCase());
    expanded += size;
    if (expanded > maxBytes || compressed > maxBytes || offset + 30 > centralStart) throw new Error('PLUGIN_ARCHIVE_SIZE');
    if (bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) throw new Error('PLUGIN_ARCHIVE_LOCAL_HEADER');
    const localNameLen = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtra, end = start + compressed;
    if (end > centralStart || bytes.subarray(offset + 30, offset + 30 + localNameLen).toString('utf8') !== name) throw new Error('PLUGIN_ARCHIVE_LOCAL_HEADER');
    if (occupied.some(([a, b]) => offset < b && end > a)) throw new Error('PLUGIN_ARCHIVE_OVERLAP');
    occupied.push([offset, end]);
    let data;
    try { data = method === 0 ? bytes.subarray(start, end) : inflateRawSync(bytes.subarray(start, end), { maxOutputLength: Math.max(1, size) }); }
    catch { throw new Error('PLUGIN_ARCHIVE_DEFLATE'); }
    if (data.length !== size || crc32(data) !== crc) throw new Error('PLUGIN_ARCHIVE_CHECKSUM');
    files.set(name, Buffer.from(data));
    pos += 46 + nameLen + extra + comment;
  }
  if (pos !== eocd) throw new Error('PLUGIN_ARCHIVE_DIRECTORY');
  return files;
}

/** Deterministic ZIP writer, intentionally STORE-only for small portable plugins. */
export function createZip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, content] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    const filename = Buffer.from(safeName(name)), data = Buffer.from(content), crc = crc32(data);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(filename.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(0x314, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(filename.length, 28);
    dir.writeUInt32LE(0x81a40000, 38); dir.writeUInt32LE(offset, 42);
    local.push(head, filename, data); central.push(dir, filename); offset += head.length + filename.length + data.length;
  }
  const dirs = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(dirs.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirs, end]);
}

export function supportsAdministratorProtocol(manifest){
 const protocol=manifest?.administratorProtocol;
 return !!protocol&&typeof protocol==='object'&&!Array.isArray(protocol)&&Object.keys(protocol).length===4&&protocol.version===1&&protocol.field==='administratorUid'&&protocol.scope==='character-account'&&protocol.managedBy==='host';
}

export function validateManifest(manifest, files) {
  if (!manifest || manifest.apiVersion !== 1 || manifest.protocol !== 'onebot-11' || manifest.kind !== 'channel' ||
      !/^[a-z][a-z0-9-]{2,63}$/.test(manifest.id ?? '') || !/^\d+\.\d+\.\d+$/.test(manifest.version ?? '') ||
      typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 100 || manifest.entry !== 'index.mjs') throw new Error('PLUGIN_MANIFEST_INVALID');
  if (manifest.platform !== undefined && (typeof manifest.platform !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(manifest.platform))) throw new Error('PLUGIN_PLATFORM_INVALID');
  if (manifest.administratorProtocol!==undefined&&!supportsAdministratorProtocol(manifest))throw new Error('PLUGIN_ADMINISTRATOR_PROTOCOL_INVALID');
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.some(x => !['private', 'group', 'login-qr', 'webhook', 'polling', 'websocket'].includes(x))) throw new Error('PLUGIN_CAPABILITIES_INVALID');
  if (!manifest.configSchema || typeof manifest.configSchema !== 'object' || Array.isArray(manifest.configSchema) || Object.keys(manifest.configSchema).length > 32) throw new Error('PLUGIN_CONFIG_SCHEMA_INVALID');
  for (const [key, field] of Object.entries(manifest.configSchema)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__', 'administratorUid', 'administratorUids'].includes(key) || !field || !['string', 'secret', 'select', 'boolean'].includes(field.type) || typeof field.label !== 'string' || field.label.length > 100 || (field.default !== undefined && typeof field.default !== (field.type === 'boolean' ? 'boolean' : 'string'))) throw new Error('PLUGIN_CONFIG_SCHEMA_INVALID');
  }
  for(const field of Object.values(manifest.configSchema))if(field.type==='select'&&(!Array.isArray(field.options)||!field.options.length||field.options.length>100||field.options.some(option=>!option||typeof option.value!=='string'||typeof option.label!=='string')))throw new Error('PLUGIN_CONFIG_SCHEMA_INVALID');
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) || !manifest.files[manifest.entry]) throw new Error('PLUGIN_FILES_INVALID');
  for (const [name, digest] of Object.entries(manifest.files)) {
    safeName(name);
    if (!/\.(mjs|json|md|txt|html)$/.test(name) || !/^[a-f0-9]{64}$/.test(digest) || !files.has(name) || sha256(files.get(name)) !== digest) throw new Error('PLUGIN_FILE_INTEGRITY');
  }
  if (files.size !== Object.keys(manifest.files).length + 1 || !files.has('manifest.json')) throw new Error('PLUGIN_UNDECLARED_FILE');
  validatePluginUI(manifest,files);
  return manifest;
}
