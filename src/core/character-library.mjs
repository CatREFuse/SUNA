import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const CHARACTER_LIBRARY_LIMITS = Object.freeze({ imageBytes: 8 * 1024 * 1024, documentBytes: 2 * 1024 * 1024, documentCharacters: 500_000 });
export class CharacterLibraryError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'CharacterLibraryError'; this.code = code; this.status = status; this.statusCode = status;
  }
}
const fail = (code, message, status) => { throw new CharacterLibraryError(code, message, status); };
const queues = new Map();
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const formats = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
function text(value, label, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0')) fail('LIBRARY_INVALID_INPUT', `${label}格式无效`);
  return value;
}
function pagination({ query = '', offset = 0, limit = 20 }) {
  text(query, '搜索内容', 500, true);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('LIBRARY_INVALID_PAGINATION', '分页参数无效');
  return { query: query.trim().toLocaleLowerCase(), offset, limit };
}
function magic(buffer, mime) {
  if (mime === 'image/png') {
    if (buffer.length < 57 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return false;
    let offset = 8, header = false, pixels = false;
    while (offset + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
      if (size > buffer.length - offset - 12) return false;
      if (!header) {
        if (type !== 'IHDR' || size !== 13 || !buffer.readUInt32BE(offset + 8) || !buffer.readUInt32BE(offset + 12)) return false;
        header = true;
      } else if (type === 'IHDR') return false;
      if (type === 'IDAT' && size > 0) pixels = true;
      offset += size + 12;
      if (type === 'IEND') return size === 0 && pixels && offset === buffer.length;
    }
    return false;
  }
  if (mime === 'image/jpeg') {
    if (buffer.length < 16 || buffer[0] !== 255 || buffer[1] !== 216 || buffer.at(-2) !== 255 || buffer.at(-1) !== 217) return false;
    let offset = 2, frame = false;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset++] !== 255) return false;
      while (buffer[offset] === 255) offset++;
      const marker = buffer[offset++];
      if (offset + 2 > buffer.length) return false;
      const size = buffer.readUInt16BE(offset);
      if (size < 2 || offset + size > buffer.length) return false;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8 || !buffer.readUInt16BE(offset + 3) || !buffer.readUInt16BE(offset + 5)) return false;
        frame = true;
      }
      if (marker === 0xda) return frame && size >= 6 && offset + size < buffer.length - 2;
      offset += size;
    }
    return false;
  }
  if (mime === 'image/gif') {
    if (buffer.length < 14 || !['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6)) || !buffer.readUInt16LE(6) || !buffer.readUInt16LE(8)) return false;
    let offset = 13 + ((buffer[10] & 128) ? 3 * 2 ** ((buffer[10] & 7) + 1) : 0), pixels = false;
    function blocks() {
      while (offset < buffer.length) { const size = buffer[offset++]; if (!size) return true; offset += size; }
      return false;
    }
    while (offset < buffer.length) {
      const marker = buffer[offset++];
      if (marker === 59) return pixels && offset === buffer.length;
      if (marker === 33) { offset++; if (!blocks()) return false; }
      else if (marker === 44) {
        if (offset + 9 > buffer.length || !buffer.readUInt16LE(offset + 4) || !buffer.readUInt16LE(offset + 6)) return false;
        const packed = buffer[offset + 8]; offset += 9 + ((packed & 128) ? 3 * 2 ** ((packed & 7) + 1) : 0);
        if (offset >= buffer.length || buffer[offset] < 2 || buffer[offset] > 8) return false;
        offset++; if (!blocks()) return false; pixels = true;
      } else return false;
    }
    return false;
  }
  if (mime !== 'image/webp' || buffer.length < 26 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP' || buffer.readUInt32LE(4) + 8 !== buffer.length) return false;
  let offset = 12, pixels = false;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (size > buffer.length - start) return false;
    if (type === 'VP8 ') { if (size < 10 || !buffer.subarray(start + 3, start + 6).equals(Buffer.from([157,1,42]))) return false; pixels = true; }
    if (type === 'VP8L') { if (size < 5 || buffer[start] !== 47) return false; pixels = true; }
    // Animated WebP stores the image bitstream inside ANMF chunks.
    if (type === 'ANMF') { if (size < 24) return false; pixels = true; }
    offset = start + size + (size % 2);
  }
  return pixels && offset === buffer.length;
}
function decodeImage(data, mime) {
  if (!Object.hasOwn(formats, mime)) fail('LIBRARY_INVALID_IMAGE', '仅支持 PNG、JPEG、WebP 和 GIF 图片');
  if (typeof data !== 'string') fail('LIBRARY_INVALID_IMAGE', '图片内容必须为 Base64');
  if (data.length > Math.ceil(CHARACTER_LIBRARY_LIMITS.imageBytes / 3) * 4) fail('LIBRARY_TOO_LARGE', '图片超过 8 MiB 限制', 413);
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail('LIBRARY_INVALID_IMAGE', '图片 Base64 格式无效');
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > CHARACTER_LIBRARY_LIMITS.imageBytes) fail('LIBRARY_TOO_LARGE', '图片超过 8 MiB 限制', 413);
  if (buffer.toString('base64') !== data || !magic(buffer, mime)) fail('LIBRARY_INVALID_IMAGE', '图片格式与内容不匹配');
  return buffer;
}

/** Owns dataDir/character-library only. Validation callback must throw or return false/null for a missing character. */
export async function createCharacterLibrary({ dataDir, validateCharacter } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || typeof validateCharacter !== 'function') throw new TypeError('Character library requires dataDir and validateCharacter');
  async function boundary(fn) {
    try { return await fn(); } catch (error) {
      if (error instanceof CharacterLibraryError) throw error;
      if (error?.code === 'ELOOP') fail('LIBRARY_UNSAFE_PATH', '资料存储路径不安全', 409);
      fail('LIBRARY_STORAGE_ERROR', '资料存储不可用', 500);
    }
  }
  async function directory(filename) {
    if (await realpath(path.dirname(filename)) !== path.dirname(filename)) fail('LIBRARY_UNSAFE_PATH', '资料存储路径不安全', 409);
    try { await mkdir(filename, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(filename);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(filename) !== path.resolve(filename)) fail('LIBRARY_UNSAFE_PATH', '资料存储路径不安全', 409);
  }
  const root = await boundary(async () => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if ((await lstat(dataDir)).isSymbolicLink()) fail('LIBRARY_UNSAFE_PATH', '资料存储路径不安全', 409);
    const base = await realpath(dataDir);
    const result = path.join(base, 'character-library');
    await directory(result);
    return result;
  });
  async function scope(characterId) {
    if (typeof characterId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(characterId)) fail('CHARACTER_NOT_FOUND', '角色不存在', 404);
    try { const valid = await validateCharacter(characterId); if (valid === false || valid === null) fail('CHARACTER_NOT_FOUND', '角色不存在', 404); }
    catch { fail('CHARACTER_NOT_FOUND', '角色不存在', 404); }
    await directory(root);
    const folder = path.join(root, createHash('sha256').update(characterId).digest('hex'));
    await directory(folder);
    return folder;
  }
  async function fileRead(filename, maxBytes) {
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) fail('LIBRARY_UNSAFE_PATH', '资料文件不安全', 409);
      if (info.size > maxBytes) fail('LIBRARY_STORAGE_ERROR', '资料文件无效', 500);
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  async function indexRead(folder, characterId) {
    let data;
    try { data = JSON.parse((await fileRead(path.join(folder, 'index.json'), 20 * 1024 * 1024)).toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, characterId, emojis: [], documents: [] }; throw error; }
    if (data?.version !== 1 || data.characterId !== characterId || !Array.isArray(data.emojis) || !Array.isArray(data.documents)) fail('LIBRARY_STORAGE_ERROR', '资料目录无效', 500);
    for (const [kind, rows] of [['emojis', data.emojis], ['documents', data.documents]]) for (const row of rows) {
      if (!row || !idPattern.test(row.id) || row.characterId !== characterId || typeof row.createdAt !== 'string' || !Number.isSafeInteger(row.size) || row.size < 0 || (kind === 'emojis' ? !Object.hasOwn(formats, row.mime) || typeof row.name !== 'string' || typeof row.description !== 'string' : typeof row.title !== 'string' || typeof row.excerpt !== 'string')) fail('LIBRARY_STORAGE_ERROR', '资料目录无效', 500);
    }
    return data;
  }
  async function writeExclusive(filename, data) {
    const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  }
  async function indexWrite(folder, index) {
    const filename = path.join(folder, 'index.json');
    try { const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('LIBRARY_UNSAFE_PATH', '资料文件不安全', 409); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = path.join(folder, `${randomUUID()}.tmp`);
    try { await writeExclusive(temp, JSON.stringify(index)); await rename(temp, filename); }
    finally { await unlink(temp).catch(() => {}); }
  }
  function run(characterId, operation) {
    return boundary(async () => {
      const folder = await scope(characterId);
      // The shared queue also coordinates separate service instances in this process.
      const previous = queues.get(folder) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        await directory(root); await directory(folder);
        return operation(folder, await indexRead(folder, characterId));
      });
      queues.set(folder, pending);
      try { return await pending; } finally { if (queues.get(folder) === pending) queues.delete(folder); }
    });
  }
  function validateId(id) { if (typeof id !== 'string' || !idPattern.test(id)) fail('LIBRARY_NOT_FOUND', '资料不存在', 404); }
  function documentFile(folder, id) { return path.join(folder, `${id}.txt`); }
  function emojiFile(folder, row) { return path.join(folder, `${row.id}.${formats[row.mime]}`); }
  async function documentContent(folder, row) {
    const buffer = await fileRead(documentFile(folder, row.id), CHARACTER_LIBRARY_LIMITS.documentBytes);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (content.length > CHARACTER_LIBRARY_LIMITS.documentCharacters || buffer.length !== row.size || content.includes('\0')) fail('LIBRARY_STORAGE_ERROR', '文档内容无效', 500);
    return content;
  }
  const page = (items, { offset, limit }) => ({ items: items.slice(offset, offset + limit), total: items.length, offset, limit });
  return {
    async listEmojis(input = {}) {
      const options = pagination(input);
      return run(input.characterId, async (_folder, index) => page(index.emojis.filter(row => `${row.name}\n${row.description}`.toLocaleLowerCase().includes(options.query)), options));
    },
    async addEmoji({ characterId, name, description = '', data, mime } = {}) {
      name = text(name, '表情包名称', 200).trim(); description = text(description, '表情包描述', 2000, true);
      const buffer = decodeImage(data, mime);
      return run(characterId, async (folder, index) => {
        const row = { id: randomUUID(), characterId, name, description, mime, size: buffer.length, createdAt: new Date().toISOString() };
        const filename = emojiFile(folder, row);
        await writeExclusive(filename, buffer);
        try { index.emojis.unshift(row); await indexWrite(folder, index); } catch (error) { await unlink(filename).catch(() => {}); throw error; }
        return row;
      });
    },
    async listDocuments(input = {}) {
      const options = pagination(input);
      return run(input.characterId, async (folder, index) => {
        const rows = [];
        for (const row of index.documents) {
          if (!options.query || `${row.title}\n${await documentContent(folder, row)}`.toLocaleLowerCase().includes(options.query)) rows.push(row);
        }
        return page(rows, options);
      });
    },
    async addDocument({ characterId, title, content } = {}) {
      title = text(title, '文档标题', 200).trim();
      if (typeof content !== 'string') fail('LIBRARY_INVALID_INPUT', '文档正文必须为文本');
      if (content.length > CHARACTER_LIBRARY_LIMITS.documentCharacters || Buffer.byteLength(content, 'utf8') > CHARACTER_LIBRARY_LIMITS.documentBytes) fail('LIBRARY_TOO_LARGE', '文档超过 500000 字符或 2 MiB 限制', 413);
      text(content, '文档正文', CHARACTER_LIBRARY_LIMITS.documentCharacters);
      // Reject binary control characters. Markdown is stored verbatim and is never executed.
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(content)) fail('LIBRARY_INVALID_INPUT', '文档正文必须为文本');
      return run(characterId, async (folder, index) => {
        const row = { id: randomUUID(), characterId, title, excerpt: content.replace(/\s+/g, ' ').slice(0, 240), size: Buffer.byteLength(content), createdAt: new Date().toISOString() };
        const filename = documentFile(folder, row.id);
        await writeExclusive(filename, content);
        try { index.documents.unshift(row); await indexWrite(folder, index); } catch (error) { await unlink(filename).catch(() => {}); throw error; }
        return row;
      });
    },
    async getDocument({ characterId, id } = {}) {
      validateId(id);
      return run(characterId, async (folder, index) => {
        const row = index.documents.find(item => item.id === id);
        if (!row) fail('LIBRARY_NOT_FOUND', '文档不存在', 404);
        return { ...row, content: await documentContent(folder, row) };
      });
    },
    async resolveEmoji({ characterId, id } = {}) {
      validateId(id);
      return run(characterId, async (folder, index) => {
        const row = index.emojis.find(item => item.id === id);
        if (!row) fail('LIBRARY_NOT_FOUND', '表情包不存在', 404);
        const filename = emojiFile(folder, row), buffer = await fileRead(filename, CHARACTER_LIBRARY_LIMITS.imageBytes);
        if (buffer.length !== row.size || !magic(buffer, row.mime)) fail('LIBRARY_STORAGE_ERROR', '图片内容无效', 500);
        return { filename, mime: row.mime, bytes: buffer, name: row.name, description: row.description };
      });
    },
  };
}
