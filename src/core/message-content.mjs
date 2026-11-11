export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_MESSAGE_SEGMENTS = 32;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function validCharacters(value) {
  for (const char of value) {
    const point = char.codePointAt(0);
    if (!(point === 9 || point === 10 || point === 13 || point >= 32 && point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff)) fail('INVALID_MESSAGE_XML', '消息含无效字符');
  }
}
function decode(value) {
  if (/[<>]/.test(value)) fail('INVALID_MESSAGE_XML', 'XML 正文和属性中的尖括号必须转义，不支持嵌套');
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&([^&;]*);|&/g, (whole, name) => {
    if (Object.hasOwn(entities, name)) return entities[name];
    if (/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(name || '')) {
      const point = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (Number.isInteger(point) && point >= 0 && point <= 0x10ffff) { const char = String.fromCodePoint(point); validCharacters(char); return char; }
    }
    fail('INVALID_MESSAGE_XML', 'XML 实体无效或未转义 &');
  });
}

/** Canonical, portable relative path. No decoding is performed at the filesystem boundary. */
export function validateWorkbenchRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\:%?#\x00-\x1f\x7f]/.test(value) || value.startsWith('/')) fail('MEDIA_PATH_INVALID', '图片必须使用当前角色目录下的相对路径');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('MEDIA_PATH_INVALID', '图片相对路径无效');
  return value;
}
function validateDialog(text) {
  if (!text.trim()) fail('INVALID_MESSAGE_XML', '文字片段不能为空');
  if (/^\s*(?:`{3,}|~{3,})/m.test(text) || /^\s*\|?\s*:?-{3,}:?\s*\|(?:\s*:?-{3,}:?\s*\|?)+\s*$/m.test(text)) fail('MESSAGE_FORMAT_UNSUPPORTED', '当前文字片段不支持代码块或表格');
}

/** Restricted sibling XML, or legacy plain text. This parser never expands external entities. */
export function parseMessageContent(content) {
  if (typeof content !== 'string') fail('INVALID_MESSAGE_CONTENT', '消息内容必须是字符串');
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_MESSAGE_BYTES) fail('MESSAGE_TOO_LARGE', '消息不能超过 64 KiB');
  validCharacters(content);
  if (!content.trim()) fail('INVALID_MESSAGE_CONTENT', '消息内容不能为空');
  if (!/<(?:\/?[A-Za-z]|[!?])/.test(content)) return { segments: [{ type: 'dialog', text: content }], hasImages: false, plainText: content, byteLength, format: 'plain' };
  const segments = []; let cursor = 0;
  while (cursor < content.length) {
    const gap = /^\s*/.exec(content.slice(cursor))[0]; cursor += gap.length;
    if (cursor === content.length) break;
    if (segments.length >= MAX_MESSAGE_SEGMENTS) fail('MESSAGE_SEGMENT_LIMIT', '消息不能超过 32 个片段');
    const dialogStart = /^<dialog\s*>/.exec(content.slice(cursor));
    if (dialogStart) {
      const bodyStart = cursor + dialogStart[0].length, closing = /<\/dialog\s*>/.exec(content.slice(bodyStart));
      if (!closing) fail('INVALID_MESSAGE_XML', 'dialog 缺少结束标签');
      const text = decode(content.slice(bodyStart, bodyStart + closing.index)); validateDialog(text);
      segments.push({ type: 'dialog', text }); cursor = bodyStart + closing.index + closing[0].length;
    } else if (/^<img\s/.test(content.slice(cursor))) {
      cursor += 4; const attrs = Object.create(null);
      for (;;) {
        const space = /^\s+/.exec(content.slice(cursor));
        if (space) cursor += space[0].length;
        if (content.startsWith('/>', cursor)) { cursor += 2; break; }
        if (!space) fail('INVALID_MESSAGE_XML', 'img 属性必须由空白分隔');
        const attribute = /^(src|alt)\s*=\s*(["'])(.*?)\2/s.exec(content.slice(cursor));
        if (!attribute || Object.hasOwn(attrs, attribute[1])) fail('INVALID_MESSAGE_XML', 'img 只支持各一个 src 和 alt 属性');
        attrs[attribute[1]] = decode(attribute[3]); cursor += attribute[0].length;
      }
      if (!Object.hasOwn(attrs, 'src') || !Object.hasOwn(attrs, 'alt')) fail('INVALID_MESSAGE_XML', 'img 必须包含 src 和 alt');
      segments.push({ type: 'image', src: validateWorkbenchRelativePath(attrs.src), alt: attrs.alt });
    } else fail('INVALID_MESSAGE_XML', '仅支持并列的无属性 dialog 和 img 标签');
  }
  return { segments, hasImages: segments.some(s => s.type === 'image'), plainText: segments.map(s => s.type === 'dialog' ? s.text : s.alt || '[图片]').join('\n'), byteLength, format: 'xml' };
}
