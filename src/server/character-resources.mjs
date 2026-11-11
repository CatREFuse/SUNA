import { httpError, readJson } from './security.mjs';

const BODY_LIMIT = 12 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const invalid = message => { throw httpError(400, 'INVALID_ARGUMENT', message); };
function decode(value) {
  try { return decodeURIComponent(value); } catch { invalid('资源标识编码无效'); }
}
function singleton(params, key) {
  const values = params.getAll(key);
  if (values.length > 1) invalid('查询参数不能重复');
  return values[0];
}
function listOptions(url, characterId, kind) {
  const options = { characterId };
  for (const key of ['offset', 'limit']) {
    const raw = singleton(url.searchParams, key);
    if (raw === undefined) continue;
    if (!/^(0|[1-9]\d*)$/.test(raw)) invalid('分页参数必须为非负整数');
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || (key === 'offset' ? value > 1_000_000 : value < 1 || value > 100)) invalid('分页参数超出范围');
    options[key] = value;
  }
  const query = singleton(url.searchParams, 'query');
  if (query !== undefined) {
    if (!query.trim() || query.length > 500 || query.includes('\0')) invalid('搜索内容不能为空且不能超过 500 字符');
    options.query = query;
  }
  if (kind === 'memories') {
    const source = singleton(url.searchParams, 'source');
    if (source !== undefined) {
      if (!['working', 'long'].includes(source)) invalid('记忆来源无效');
      options.source = source;
    }
  }
  return options;
}

/** Host calls this only after its origin/CSRF check, before its generic body parser. */
export function createCharacterResourceRoutes({ book, library, writeJson, isClosing = () => false } = {}) {
  if (!book || !library || typeof writeJson !== 'function') throw new TypeError('Character resource routes require book, library, and writeJson');
  return async function handle(req, res, url, pathname) {
    const match = /^\/characters\/([^/]+)\/(memories|dreams|knowledge|emojis)(\/.*)?$/.exec(pathname);
    if (!match) return false;
    if (isClosing()) throw httpError(503, 'SERVICE_CLOSING', '沙之书正在关闭');
    const characterId = decode(match[1]), kind = match[2], tail = match[3] ?? '';
    const method = req.method;
    const item = /^\/([^/]+)$/.exec(tail);
    const image = /^\/([^/]+)\/image$/.exec(tail);
    const isList = !tail, isDocument = kind === 'knowledge' && item, isImage = kind === 'emojis' && image;
    if (!isList && !isDocument && !isImage) throw httpError(404, 'RESOURCE_NOT_FOUND', '资料接口不存在');
    const allowed = isList && ['knowledge', 'emojis'].includes(kind) ? ['GET', 'POST'] : ['GET'];
    if (!allowed.includes(method)) {
      res.setHeader('allow', allowed.join(', '));
      throw httpError(405, 'METHOD_NOT_ALLOWED', '此资料接口不支持该请求方式');
    }
    if (isImage) {
      const { bytes, mime } = await library.resolveEmoji({ characterId, id: decode(image[1]) });
      if (!Buffer.isBuffer(bytes) || !imageTypes.has(mime)) throw httpError(500, 'LIBRARY_STORAGE_ERROR', '图片内容无效');
      res.writeHead(200, { 'content-type': mime, 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(bytes);
      return true;
    }
    if (isDocument) {
      writeJson(res, 200, await library.getDocument({ characterId, id: decode(item[1]) }));
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req, BODY_LIMIT);
      if (isClosing()) throw httpError(503, 'SERVICE_CLOSING', '沙之书正在关闭');
      const result = kind === 'knowledge'
        ? await library.addDocument({ characterId, title: body.title, content: body.content })
        : await library.addEmoji({ characterId, name: body.name, description: body.description, data: body.data, mime: body.mime });
      writeJson(res, 200, result);
      return true;
    }
    const options = listOptions(url, characterId, kind);
    const result = kind === 'memories' ? await book.getCharacterMemories(options)
      : kind === 'dreams' ? await book.getCharacterDreams(options)
      : kind === 'knowledge' ? await library.listDocuments(options)
      : await library.listEmojis(options);
    writeJson(res, 200, result);
    return true;
  };
}
