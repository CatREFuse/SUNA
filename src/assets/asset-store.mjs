import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from '../channels/archive.mjs';

const MAX_BYTES = 160 * 1024 * 1024, MAX_FILES = 2048;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function safePath(name) {
  if (typeof name !== 'string' || !name || name.length > 500 || /[\\\x00-\x1f<>:"|?*%#]/u.test(name) || name.startsWith('/') || name.split('/').some(s => !s || s === '.' || s === '..' || s.endsWith('.') || s.endsWith(' '))) throw new Error('素材路径不安全');
  return name.normalize('NFC');
}
function readAssetZip(bytes) {
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break; }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('不支持的 ZIP 文件');
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), centralSize = bytes.readUInt32LE(end + 12);
  if (!count || count > MAX_FILES || bytes.readUInt16LE(end + 8) !== count || start + centralSize !== end) throw new Error('ZIP 目录无效或文件过多');
  const files = new Map(), names = new Set(), ranges = []; let cursor = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), checksum = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extra + comment > end) throw new Error('ZIP 目录损坏');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'), directory = rawName.endsWith('/');
    const name = safePath(directory ? rawName.slice(0, -1) : rawName), fold = name.toLocaleLowerCase('en-US');
    if (names.has(fold) || ((bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000 || flags & 1 || ![0, 8].includes(method)) throw new Error('ZIP 包含重复路径、链接或不支持的压缩项');
    names.add(fold); total += size;
    if (total > MAX_BYTES || compressed > MAX_BYTES || offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('ZIP 解压大小超限或文件头损坏');
    const localNameLength = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28), bodyStart = offset + 30 + localNameLength + localExtra, bodyEnd = bodyStart + compressed;
    if (bodyEnd > start || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method || bytes.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') !== rawName || ranges.some(([a, b]) => offset < b && bodyEnd > a)) throw new Error('ZIP 文件区块不一致');
    ranges.push([offset, bodyEnd]);
    let data; try { data = method === 0 ? bytes.subarray(bodyStart, bodyEnd) : inflateRawSync(bytes.subarray(bodyStart, bodyEnd), { maxOutputLength: Math.max(1, size) }); } catch { throw new Error('ZIP 解压失败'); }
    if (data.length !== size || crc32(data) !== checksum) throw new Error('ZIP 文件校验失败');
    if (!directory && !name.startsWith('__MACOSX/') && !path.posix.basename(name).startsWith('._')) files.set(name, Buffer.from(data));
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end) throw new Error('ZIP 目录不一致');
  return files;
}
function imageSize(bytes, extension) {
  let width, height;
  if (extension === '.png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  else if (extension === '.gif' && bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) { width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); }
  else if (extension === '.webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const format = bytes.toString('ascii', 12, 16);
    if (format === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (format === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else if (format === 'VP8L' && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) throw new Error('图片格式无效或尺寸超限（最多 6400 万像素）');
  return { width, height };
}
function inspectVrm(bytes) {
  if (bytes.length < 24 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error('VRM 必须是完整的 GLB 2.0 文件');
  const length = bytes.readUInt32LE(12); if (length > 8 * 1024 * 1024 || 20 + length > bytes.length) throw new Error('VRM 元数据无效');
  let model; try { model = JSON.parse(bytes.toString('utf8', 20, 20 + length).trim()); } catch { throw new Error('VRM 元数据无效'); }
  if (!model.extensions?.VRM && !model.extensions?.VRMC_vrm) throw new Error('文件缺少 VRM 角色扩展');
  for (const resource of [...(model.buffers ?? []), ...(model.images ?? [])]) if (resource.uri && !/^data:(?:image\/(?:png|jpeg|webp)|application\/octet-stream);base64,[A-Za-z0-9+/=]+$/.test(resource.uri)) throw new Error('VRM 需内嵌模型与纹理，不能引用外部地址');
  return model.extensions?.VRMC_vrm ? '1' : '0';
}
function inspectLive2d(files) {
  const models = [...files.keys()].filter(name => name.endsWith('.model3.json'));
  if (models.length !== 1) throw new Error('Live2D ZIP 需要且只能包含一个 .model3.json 模型');
  const entry = models[0]; let model;
  try { model = JSON.parse(files.get(entry).toString('utf8')); } catch { throw new Error('Live2D 模型配置无法读取'); }
  const refs = model.FileReferences;
  if (model.Version !== 3 || !refs || typeof refs.Moc !== 'string' || !Array.isArray(refs.Textures) || !refs.Textures.length) throw new Error('Live2D 模型缺少 Moc 或纹理');
  const needed = new Set([entry]);
  const add = reference => {
    if (typeof reference !== 'string' || /^[a-z]+:/i.test(reference) || reference.startsWith('/') || /[\\%?#\x00-\x1f]/.test(reference)) throw new Error('Live2D 资源引用不安全');
    const resolved = safePath(path.posix.normalize(path.posix.join(path.posix.dirname(entry), reference)));
    if (!files.has(resolved)) throw new Error(`Live2D 缺少资源：${reference}`);
    if (!/\.(?:moc3|json|png|webp|jpg|jpeg|mp3|wav|ogg)$/i.test(resolved)) throw new Error('Live2D 包含不支持的资源类型');
    needed.add(resolved); return resolved;
  };
  const moc = add(refs.Moc); if (!moc.endsWith('.moc3') || files.get(moc).toString('ascii', 0, 4) !== 'MOC3') throw new Error('Live2D Moc 文件无效');
  for (const texture of refs.Textures) add(texture);
  for (const key of ['Physics', 'Pose', 'UserData', 'DisplayInfo']) if (refs[key]) add(refs[key]);
  for (const expression of refs.Expressions ?? []) add(expression.File);
  for (const motions of Object.values(refs.Motions ?? {})) { if (!Array.isArray(motions)) throw new Error('Live2D 动作配置无效'); for (const motion of motions) { add(motion.File); if (motion.Sound) add(motion.Sound); } }
  return { entry, files: new Map([...needed].map(name => [name, files.get(name)])) };
}

export function createAssetStore({ dataDir }) {
  if (!dataDir) throw new Error('ASSET_DATA_DIR_REQUIRED');
  const root = path.resolve(dataDir, 'assets');
  return {
    async importAsset({ name, data, columns = 1, rows = 1, fps = 8 }) {
      if (typeof name !== 'string' || !name.trim() || name.length > 250 || typeof data !== 'string' || data.length > Math.ceil(MAX_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) throw new Error('素材文件名或 Base64 内容无效');
      const bytes = Buffer.from(data, 'base64'); if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== data) throw new Error('素材大小超限或内容无效（最多 160 MB）');
      const extension = path.extname(name).toLowerCase(), id = randomUUID();
      let type, entry, files, extra = {};
      if (['.png', '.webp', '.gif'].includes(extension)) {
        const { width, height } = imageSize(bytes, extension);
        if (![columns, rows, fps].every(Number.isInteger) || columns < 1 || rows < 1 || columns > 64 || rows > 64 || fps < 1 || fps > 60 || width % columns || height % rows) throw new Error('帧动画行列必须均分图片，帧率范围为 1–60');
        type = 'frames'; entry = `image${extension}`; files = new Map([[entry, bytes]]); extra = { columns, rows, fps };
      } else if (extension === '.vrm') { inspectVrm(bytes); type = 'vrm'; entry = 'model.vrm'; files = new Map([[entry, bytes]]); }
      else if (extension === '.zip') { const result = inspectLive2d(readAssetZip(bytes)); type = 'live2d'; entry = result.entry; files = result.files; }
      else throw new Error('支持 PNG、WebP、GIF、VRM 或 Live2D ZIP');
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const temp = await fs.mkdtemp(path.join(root, '.import-')), destination = path.join(root, id);
      try {
        for (const [filename, content] of files) { const target = path.join(temp, filename); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 }); }
        const asset = { type, url: `/assets-local/${id}/${entry.split('/').map(encodeURIComponent).join('/')}`, name: path.basename(name), ...extra };
        await fs.writeFile(path.join(temp, '.asset.json'), JSON.stringify({ ...asset, importedAt: new Date().toISOString(), sha256: digest(bytes) }), { mode: 0o600 });
        await fs.rename(temp, destination); return asset;
      } catch (error) { await fs.rm(temp, { recursive: true, force: true }); throw error; }
    },
    async resolveUrlPath(relative) {
      if (typeof relative !== 'string') throw new Error('素材路径无效');
      let decoded; try { decoded = decodeURIComponent(relative.replace(/^\/assets-local\//, '')); } catch { throw new Error('素材路径无效'); }
      const safe = safePath(decoded), parts = safe.split('/');
      if (!/^[a-f0-9-]{36}$/.test(parts[0]) || parts.length < 2 || parts.some(part => part.startsWith('.'))) throw new Error('素材路径无效');
      const canonicalRoot = await fs.realpath(root), target = path.join(canonicalRoot, safe), canonicalTarget = await fs.realpath(target);
      if (canonicalTarget !== target || !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`) || !(await fs.lstat(target)).isFile()) throw new Error('素材路径越界或不是文件');
      return target;
    }
  };
}
