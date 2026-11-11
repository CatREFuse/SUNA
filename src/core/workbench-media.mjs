import { constants } from 'node:fs';
import { open, mkdir, realpath, lstat, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from '../channels/archive.mjs';
import { validateWorkbenchRelativePath } from './message-content.mjs';
import { MAX_CAPTURE_BYTES, MAX_CAPTURE_SIDE, petIdentity } from '../runtime/pet-capture-contract.mjs';

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const HASH_FILE = /^([a-f0-9]{64})\.(png|jpg|gif|webp)$/;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };

// Bounded container validation and MIME detection; filenames and caller MIME are not trusted.
function imageInfo(data) {
  let mime, extension, width, height;
  if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    let offset = 8, ihdr = false, idat = false, ended = false;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset), end = offset + 12 + length;
      if (end > data.length) break;
      const kind = data.toString('ascii', offset + 4, offset + 8);
      if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) fail('MEDIA_INVALID_IMAGE', 'PNG 校验失败');
      if (offset === 8 && (kind !== 'IHDR' || length !== 13)) break;
      if (kind === 'IHDR') { if (ihdr || length !== 13) break; ihdr = true; width = data.readUInt32BE(offset + 8); height = data.readUInt32BE(offset + 12); }
      if (kind === 'IDAT') idat = true;
      if (kind === 'IEND') { ended = length === 0 && end === data.length; break; }
      offset = end;
    }
    if (!ihdr || !idat || !ended) fail('MEDIA_INVALID_IMAGE', 'PNG 文件不完整');
    mime = 'image/png'; extension = 'png';
  } else if (data.length >= 14 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6)) && data.at(-1) === 0x3b) {
    mime = 'image/gif'; extension = 'gif'; width = data.readUInt16LE(6); height = data.readUInt16LE(8);
  } else if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) + 8 === data.length) {
    let offset = 12, payload = false;
    while (offset + 8 <= data.length) {
      const kind = data.toString('ascii', offset, offset + 4), length = data.readUInt32LE(offset + 4), start = offset + 8, end = start + length;
      if (end > data.length) fail('MEDIA_INVALID_IMAGE', 'WebP 文件不完整');
      if (kind === 'VP8X' && length >= 10) { width = data.readUIntLE(start + 4, 3) + 1; height = data.readUIntLE(start + 7, 3) + 1; }
      if (kind === 'VP8 ' && length >= 10 && data.subarray(start + 3, start + 6).equals(Buffer.from('9d012a', 'hex'))) { width ??= data.readUInt16LE(start + 6) & 0x3fff; height ??= data.readUInt16LE(start + 8) & 0x3fff; payload = true; }
      if (kind === 'VP8L' && length >= 5 && data[start] === 0x2f) { const bits = data.readUInt32LE(start + 1); width ??= (bits & 0x3fff) + 1; height ??= ((bits >>> 14) & 0x3fff) + 1; payload = true; }
      if (kind === 'ANMF' && length >= 16) payload = true;
      offset = end + (length % 2);
    }
    if (!payload || offset !== data.length) fail('MEDIA_INVALID_IMAGE', 'WebP 图像数据缺失');
    mime = 'image/webp'; extension = 'webp';
  } else if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++]; if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset); if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) { height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); }
      offset += length;
    }
    mime = 'image/jpeg'; extension = 'jpg';
  }
  if (!mime || !width || !height) fail('MEDIA_INVALID_IMAGE', '只支持有效的 PNG、JPEG、GIF 或 WebP 图片');
  // Original archives are not model inputs. Pixel/decode budgets apply only
  // while preparing a model derivative, never as an upload dimension gate.
  return { mime, extension, width, height };
}

async function rootDirectory(root, create = false) {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('MEDIA_PATH_INVALID', '媒体目录无效');
  return realpath(root);
}
async function targetPath(root, relative) {
  validateWorkbenchRelativePath(relative);
  const target = path.join(root, relative), resolved = await realpath(target);
  // Reject internal links too, so a later retarget cannot silently change authority.
  if (!within(root, resolved) || resolved !== target) fail('MEDIA_PATH_INVALID', '图片路径包含符号链接或超出允许目录');
  return target;
}
async function readImage(root, relative, maxBytes, { signal, rejectHardlinks = false } = {}) {
  let file, buffer;
  try {
    signal?.throwIfAborted();
    const target = await targetPath(root, relative);
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || rejectHardlinks && before.nlink !== 1n) fail('MEDIA_PATH_INVALID', '图片路径不是独立普通文件');
    if (before.size <= 0n || before.size > BigInt(maxBytes)) fail('MEDIA_FILE_TOO_LARGE', '图片文件为空或超过大小限制');
    buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < buffer.length) { signal?.throwIfAborted(); const next = await file.read(buffer, length, buffer.length - length, null); if (!next.bytesRead) break; length += next.bytesRead; }
    const after = await file.stat({ bigint: true }), currentPath = await targetPath(root, relative), current = await lstat(currentPath, { bigint: true });
    signal?.throwIfAborted();
    if (length !== Number(before.size) || ['size', 'dev', 'ino', 'mtimeNs', 'ctimeNs', ...(rejectHardlinks ? ['nlink'] : [])].some(key => before[key] !== after[key]) || current.dev !== after.dev || current.ino !== after.ino || rejectHardlinks && current.nlink !== 1n) fail('MEDIA_FILE_CHANGED', '图片在读取期间发生变化，请重试');
    const bytes = buffer.subarray(0, length), info = imageInfo(bytes);
    return { data: bytes, descriptor: { sha256: hash(bytes), bytes: length, ...info } };
  } catch (error) {
    buffer?.fill(0);
    if (signal?.aborted) signal.throwIfAborted();
    if (error.code?.startsWith('MEDIA_')) throw error;
    if (error.code === 'ENOENT') fail('MEDIA_NOT_FOUND', '图片文件不存在');
    fail('MEDIA_PATH_INVALID', '图片无法安全读取');
  } finally { await file?.close(); }
}
async function saveImage(root, image, maxBytes) {
  const { descriptor, data } = image, relativePath = `${descriptor.sha256}.${descriptor.extension}`;
  const temporary = path.join(root, `.media-${randomUUID()}.tmp`), destination = path.join(root, relativePath);
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(data); await file.sync(); await file.close(); file = undefined;
    try { await link(temporary, destination); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readImage(root, relativePath, maxBytes);
      if (existing.descriptor.sha256 !== descriptor.sha256) fail('MEDIA_STORE_CORRUPT', '已归档图片的校验失败');
    }
  } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  const { extension: _extension, ...publicDescriptor } = descriptor;
  return { ...publicDescriptor, relativePath };
}

/** Local-only media: exact bytes are copied before a task can reference the persistent URL. */
export function createWorkbenchMedia({ workspace, mediaDir, assetRoot, resolveAsset, urlPrefix = '/media-local/', maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (!path.isAbsolute(workspace || '') || !path.isAbsolute(mediaDir || '')) throw new TypeError('workspace and mediaDir must be absolute');
  if (!/^\/[a-z0-9/-]+\/$/i.test(urlPrefix) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_IMAGE_BYTES) throw new TypeError('Invalid media storage options');
  const sourceImage = async src => readImage(await rootDirectory(workspace, true), validateWorkbenchRelativePath(src), maxBytes);
  const inspect = async src => { const { descriptor } = await sourceImage(src); const { extension: _extension, ...result } = descriptor; return result; };
  const persist = async src => { const result = await saveImage(await rootDirectory(mediaDir, true), await sourceImage(src), maxBytes); return { ...result, url: urlPrefix + result.relativePath }; };
  async function persistBytes(data) {
    if (!Buffer.isBuffer(data) || !data.length || data.length > maxBytes) fail('MEDIA_FILE_TOO_LARGE', '图片文件为空或超过大小限制');
    const copy = Buffer.from(data), descriptor = { ...imageInfo(copy), sha256: hash(copy), bytes: copy.length };
    const result = await saveImage(await rootDirectory(mediaDir, true), { data: copy, descriptor }, maxBytes);
    return { ...result, url: urlPrefix + result.relativePath };
  }
  async function persistSegments(segments) {
    if (!Array.isArray(segments) || segments.length > 32) fail('INVALID_MESSAGE_CONTENT', '消息片段无效');
    const results = [];
    for (const segment of segments) {
      if (segment.type === 'image') results.push({ type: 'image', src: segment.src, alt: String(segment.alt || ''), ...await persist(segment.src) });
      else if (segment.type === 'dialog' && typeof segment.text === 'string') results.push({ type: 'dialog', text: segment.text });
      else fail('INVALID_MESSAGE_CONTENT', '消息片段无效');
    }
    return results;
  }
  async function resolveStored(relative) {
    const match = typeof relative === 'string' && HASH_FILE.exec(relative);
    if (!match) fail('MEDIA_PATH_INVALID', '附件路径无效');
    const root = await rootDirectory(mediaDir), { descriptor } = await readImage(root, relative, maxBytes);
    if (descriptor.sha256 !== match[1] || descriptor.extension !== match[2]) fail('MEDIA_STORE_CORRUPT', '附件校验失败');
    return targetPath(root, relative);
  }
  // Return verified bytes from the same file descriptor; callers must erase
  // the returned buffer after its run. Never reopen a path returned by resolveStored.
  async function readStored(relative, { maxBytes: limit = maxBytes, signal } = {}) {
    const match = typeof relative === 'string' && HASH_FILE.exec(relative);
    if (!match || !Number.isSafeInteger(limit) || limit < 1 || limit > maxBytes) fail('MEDIA_PATH_INVALID', '附件读取参数无效');
    signal?.throwIfAborted();
    const root = await rootDirectory(mediaDir);
    const image = await readImage(root, relative, limit, {signal, rejectHardlinks:true});
    try {
      signal?.throwIfAborted();
      if (image.descriptor.sha256 !== match[1] || image.descriptor.extension !== match[2]) fail('MEDIA_STORE_CORRUPT', '附件校验失败');
      return image;
    } catch (error) { image.data.fill(0); throw error; }
  }
  async function getSelfie(characterOrPet, { capture, signal } = {}) {
    const pet = characterOrPet?.pet ?? characterOrPet;
    if (!pet?.url) fail('SELFIE_UNAVAILABLE', '当前角色没有可用形象资源');
    if (typeof capture === 'function') {
      const check = () => { if (signal?.aborted) fail('RUN_CANCELLED', '角色截图已取消'); }; check();
      if (!characterOrPet?.id || !assetRoot || typeof resolveAsset !== 'function' || typeof pet.url !== 'string' || !pet.url.startsWith('/assets-local/')) fail('SELFIE_UNAVAILABLE', '当前角色资源不可读取');
      const assetDirectory = await rootDirectory(assetRoot), assetFile = await resolveAsset(pet.url);
      if (typeof assetFile !== 'string' || !within(assetDirectory, assetFile)) fail('MEDIA_PATH_INVALID', '角色形象资源超出允许目录');
      await targetPath(assetDirectory, path.relative(assetDirectory, assetFile)); check();
      const result = await capture({ characterId: characterOrPet.id, pet: structuredClone(pet), signal }); check();
      if (!result || result.mime !== 'image/png' || result.source?.characterId !== characterOrPet.id || result.source?.assetIdentity !== petIdentity(pet) || result.source?.assetUrl !== pet.url || result.source?.assetType !== pet.type) fail('SELFIE_SOURCE_MISMATCH', '角色截图来源与当前形象不一致');
      if (typeof result.data !== 'string' || result.data.length > Math.ceil(MAX_CAPTURE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.data)) fail('SELFIE_CAPTURE_INVALID', '角色截图数据无效');
      const data = Buffer.from(result.data, 'base64');
      if (data.length > Math.min(maxBytes, MAX_CAPTURE_BYTES) || data.toString('base64') !== result.data) fail('SELFIE_CAPTURE_INVALID', '角色截图数据过大或编码无效');
      const info = imageInfo(data);
      if (info.mime !== 'image/png' || info.width !== result.width || info.height !== result.height || Math.max(info.width, info.height) > MAX_CAPTURE_SIDE) fail('SELFIE_CAPTURE_INVALID', '角色截图尺寸或格式无效');
      const descriptor = { ...info, bytes: data.length, sha256: hash(data) }, work = await rootDirectory(workspace, true);
      const saved = await saveImage(await rootDirectory(path.join(work, 'selfie'), true), { data, descriptor }, maxBytes); check();
      return { ...saved, src: 'selfie/' + saved.relativePath, alt: `${characterOrPet.name || '角色'}的当前形象`, capturedAt: new Date().toISOString(), source: { characterId: characterOrPet.id, assetUrl: pet.url, assetType: pet.type, ...(Number.isInteger(result.source.frame) ? { frame: result.source.frame } : {}) } };
    }
    if (pet.type !== 'frames' || (pet.columns ?? 1) !== 1 || (pet.rows ?? 1) !== 1) fail('SELFIE_RENDER_REQUIRED', '当前形象需要真实渲染截图，尚未接入截图能力');
    if (!assetRoot || typeof resolveAsset !== 'function' || !pet.url.startsWith('/assets-local/')) fail('SELFIE_UNAVAILABLE', '当前角色资源不可读取');
    const root = await rootDirectory(assetRoot), resolved = await resolveAsset(pet.url);
    if (typeof resolved !== 'string' || !within(root, resolved)) fail('MEDIA_PATH_INVALID', '角色形象资源超出允许目录');
    const image = await readImage(root, path.relative(root, resolved), maxBytes);
    const work = await rootDirectory(workspace, true), selfieDir = path.join(work, 'selfie');
    const saved = await saveImage(await rootDirectory(selfieDir, true), image, maxBytes);
    return { ...saved, src: 'selfie/' + saved.relativePath, alt: `${characterOrPet?.name || '角色'}的当前形象` };
  }
  return { inspect, persist, persistBytes, persistSegments, resolveStored, readStored, getSelfie };
}
