import https from 'node:https';
import { channelMention, mentionContextText } from '../core/channel-mentions.mjs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createWorkbenchMedia } from '../core/workbench-media.mjs';
import { normalizeGroupImageAlt } from '../core/group-media-reference.mjs';

const HOSTS = new Set(['gchat.qpic.cn', 'c2cpicdw.qpic.cn', 'multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'video.gtimg.com']);
const VIDEO_FILE = /^([a-f0-9]{64})\.(mp4|mov|webm)$/;
export const CHANNEL_MEDIA_LIMIT = 64 * 1024 * 1024;
const fail = () => { throw Object.assign(new Error('媒体不可用'), { code: 'CHANNEL_MEDIA_UNAVAILABLE' }); };
const digest = data => createHash('sha256').update(data).digest('hex');
export function validateQQMediaURL(value) {
  let url; try { url = new URL(value); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !HOSTS.has(url.hostname) || url.hash) fail();
  return url;
}
export function publicIPv4(address) {
  if (typeof address !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address)) return false;
  const a = address.split('.').map(Number); if (a.some(n => n > 255)) return false;
  return !(a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 || (a[0] === 100 && a[1] >= 64 && a[1] <= 127) || (a[0] === 169 && a[1] === 254) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && [0, 168].includes(a[1])) || (a[0] === 198 && [18, 19, 51].includes(a[1])) || (a[0] === 203 && a[1] === 0 && a[2] === 113));
}
const fakeIPv4 = address => /^198\.(18|19)\.\d{1,3}\.\d{1,3}$/.test(address) && address.split('.').every(part => Number(part) <= 255);
const publicDNSCache = new Map();
// A local proxy may synthesize RFC 2544 addresses even for a public resolver's UDP
// replies. Only this exact case uses a fixed TLS-authenticated DoH bootstrap.
// The resolver receives a whitelisted hostname, never a media path or signature.
export async function resolveQQMediaDNS(hostname, { signal, request = https.request } = {}) {
  if (!HOSTS.has(hostname)) fail();
  const cached = request === https.request && publicDNSCache.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.records;
  const deadline = AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]);
  deadline.throwIfAborted();
  const data = await new Promise((resolve, reject) => {
    const req = request(new URL(`https://dns.alidns.com/resolve?name=${hostname}&type=A`), {
      method: 'GET', agent: false, signal: deadline,
      headers: { accept: 'application/dns-json', 'accept-encoding': 'identity' },
      lookup: (_host, options, callback) => callback(null, options.all ? [{ address: '223.5.5.5', family: 4 }] : '223.5.5.5', 4),
    }, res => {
      if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length'] || 0) > 8192) { res.destroy(); reject(new Error('媒体域名解析失败')); return; }
      let count = 0; const chunks = [];
      res.on('data', chunk => { count += chunk.length; if (count > 8192) { res.destroy(); reject(new Error('媒体域名解析失败')); } else chunks.push(chunk); });
      res.on('error', reject); res.on('aborted', () => reject(new Error('媒体域名解析中断')));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('媒体域名解析失败')); } });
    }); req.on('error', reject); req.end();
  });
  if (data?.Status !== 0 || !Array.isArray(data.Answer) || data.Answer.length > 64) fail();
  const normalized = name => typeof name === 'string' ? name.toLowerCase().replace(/\.$/, '') : '';
  const names = new Set([hostname]);
  for (let i = 0; i < 16; i++) for (const answer of data.Answer) if (answer.type === 5 && names.has(normalized(answer.name))) names.add(normalized(answer.data));
  const answers = data.Answer.filter(answer => answer.type === 1 && names.has(normalized(answer.name)));
  if (!answers.length || answers.some(answer => !publicIPv4(answer.data))) fail();
  const records = [...new Set(answers.map(answer => answer.data))].map(address => ({ address, family: 4 }));
  if (request === https.request) publicDNSCache.set(hostname, { records, expires: Date.now() + 30000 });
  return records;
}
// DNS is checked once per hop, and the validated address is pinned in the TLS request.
// TLS still validates the original hostname. Neither cookies nor caller headers are forwarded.
export async function fetchQQMedia(value, { signal, lookup = dnsLookup, request = https.request, resolvePublic = resolveQQMediaDNS, maxBytes = CHANNEL_MEDIA_LIMIT } = {}) {
  const deadline = AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])]);
  for (let hop = 0; hop < 4; hop++) {
    deadline.throwIfAborted(); const url = validateQQMediaURL(value);
    let abortLookup;
    const records = await Promise.race([(async () => {
      const initial = await lookup(url.hostname, { all: true, family: 4 });
      return initial.length && initial.every(item => item.family === 4 && fakeIPv4(item.address)) ? resolvePublic(url.hostname, { signal: deadline }) : initial;
    })(), new Promise((_, reject) => { abortLookup = () => reject(new Error('媒体请求超时')); if (deadline.aborted) abortLookup(); else deadline.addEventListener('abort', abortLookup, { once: true }); })]).finally(() => deadline.removeEventListener('abort', abortLookup));
    if (!records.length || records.some(item => item.family !== 4 || !publicIPv4(item.address))) fail();
    const result = await new Promise((resolve, reject) => {
      const req = request(url, { method: 'GET', agent: false, signal: deadline, headers: { accept: 'image/*,video/*', 'accept-encoding': 'identity' }, lookup: (_host, options, callback) => { const item = records[0]; callback(null, options.all ? [item] : item.address, item.family); } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) { res.destroy(); resolve({ redirect: res.headers.location }); return; }
        if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length'] || 0) > maxBytes) { res.destroy(); reject(new Error('媒体不可用')); return; }
        let count = 0; const chunks = [];
        res.on('data', chunk => { count += chunk.length; if (count > maxBytes) { res.destroy(); reject(new Error('媒体大小超限')); } else chunks.push(chunk); });
        res.on('error', reject); res.on('aborted', () => reject(new Error('媒体下载中断')));
        res.on('end', () => resolve({ data: Buffer.concat(chunks), mime: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() }));
      }); req.on('error', reject); req.end();
    });
    if (result.redirect) { value = new URL(result.redirect, url).href; continue; }
    if (!result.data?.length) fail(); return result;
  }
  fail();
}
const decode = value => String(value).replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
export function channelSegments(event) {
  if (Array.isArray(event.message) && event.message.length) return event.message;
  const raw = typeof event.message === 'string' ? event.message : String(event.raw_message ?? '');
  const output = []; let last = 0;
  for (const match of raw.matchAll(/\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > last) output.push({ type: 'text', data: { text: decode(raw.slice(last, match.index)) } });
    const data = Object.create(null);
    for (const pair of match[2].slice(1).split(',')) { const equal = pair.indexOf('='); if (equal > 0) data[pair.slice(0, equal)] = decode(pair.slice(equal + 1)); }
    output.push({ type: match[1], data }); last = match.index + match[0].length;
  }
  if (last < raw.length) output.push({ type: 'text', data: { text: decode(raw.slice(last)) } });
  return output;
}
export function videoInfo(data) {
  if (!Buffer.isBuffer(data) || data.length < 16 || data.length > CHANNEL_MEDIA_LIMIT) fail();
  if (data.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) {
    // Require the EBML doctype and Segment element, not merely the magic bytes.
    if (!data.subarray(0, 4096).includes(Buffer.from('webm')) || data.indexOf(Buffer.from('18538067', 'hex'), 4) < 0) fail();
    return { extension: 'webm', mime: 'video/webm' };
  }
  let offset = 0, brand, movie = false, payload = false;
  while (offset + 8 <= data.length) {
    let length = data.readUInt32BE(offset); const kind = data.toString('ascii', offset + 4, offset + 8); let header = 8;
    if (length === 1) { if (offset + 16 > data.length) fail(); const large = data.readBigUInt64BE(offset + 8); if (large > BigInt(CHANNEL_MEDIA_LIMIT)) fail(); length = Number(large); header = 16; }
    if (length === 0) length = data.length - offset;
    if (length < header || offset + length > data.length) fail();
    if (offset === 0) { if (kind !== 'ftyp' || length < header + 8) fail(); brand = data.toString('ascii', offset + header, offset + header + 4); }
    if (kind === 'moov' && length > header) movie = true;
    if (kind === 'mdat' && length > header) payload = true;
    offset += length;
  }
  if (!brand || offset !== data.length || !movie || !payload || !/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|qt  )$/.test(brand)) fail();
  return brand === 'qt  ' ? { extension: 'mov', mime: 'video/quicktime' } : { extension: 'mp4', mime: 'video/mp4' };
}
export function createChannelMedia({ dataDir, download = fetchQQMedia } = {}) {
  const directory = path.join(dataDir, 'book', 'attachments');
  const images = createWorkbenchMedia({ workspace: path.join(dataDir, 'book', 'channel-workspace'), mediaDir: directory });
  async function root() { await mkdir(directory, { recursive: true, mode: 0o700 }); if ((await lstat(directory)).isSymbolicLink()) fail(); return realpath(directory); }
  async function resolveVideo(relative) {
    const match = VIDEO_FILE.exec(relative); if (!match) fail();
    const base = await root(), filename = path.join(base, relative); let file;
    try {
      file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const stat = await file.stat();
      if (!stat.isFile() || stat.size < 16 || stat.size > CHANNEL_MEDIA_LIMIT) fail();
      const data = await file.readFile(); if (data.length !== stat.size || digest(data) !== match[1] || videoInfo(data).extension !== match[2]) fail(); return filename;
    } finally { await file?.close(); }
  }
  async function persistVideo(data, mime) {
    const info = videoInfo(data); if (mime !== info.mime && mime !== 'application/octet-stream') fail();
    const relativePath = `${digest(data)}.${info.extension}`, base = await root(), temporary = path.join(base, `.media-${randomUUID()}.tmp`); let file;
    try { file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await file.writeFile(data); await file.close(); file = undefined; try { await link(temporary, path.join(base, relativePath)); } catch (error) { if (error.code !== 'EEXIST') throw error; await resolveVideo(relativePath); } }
    finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { url: '/media-local/' + relativePath, relativePath };
  }
  let activeDownloads = 0;
  async function boundedDownload(source, signal) {
    if (activeDownloads >= 4) fail();
    activeDownloads++; try { return await download(source, {signal}); } finally { activeDownloads--; }
  }
  async function convert(event, { resolveMedia, resolveMention, signal: parentSignal } = {}) {
    const segments = channelSegments(event), blocks = [], signal = AbortSignal.any([AbortSignal.timeout(20000), ...(parentSignal ? [parentSignal] : [])]);
    const text = value => { if (!value) return; const previous = blocks.at(-1); if (previous?.type === 'text') previous.text += value; else blocks.push({ type: 'text', text: value }); };
    let mediaCount = 0;
    for (const segment of segments.slice(0, 128)) {
      if (!segment || typeof segment !== 'object') { text('[消息]'); continue; }
      const data = segment.data ?? {};
      if (segment.type === 'text') { text(String(data.text ?? '')); continue; }
      if (['image', 'video'].includes(segment.type)) {
        const label = segment.type === 'image' ? '图片' : '视频';
        const alt = segment.type === 'image' ? [data.summary, data.alt].map(normalizeGroupImageAlt).find(value => value !== '图片，尚未识别') ?? '图片，尚未识别' : label;
        try {
          if (++mediaCount > 16) fail();
          const source = [data.url, data.file].find(value => typeof value === 'string' && value.startsWith('https://'));
          const load = async url => {
            signal.throwIfAborted(); validateQQMediaURL(url); const media = await boundedDownload(url, signal);
            signal.throwIfAborted();
            if (segment.type === 'image') { if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream'].includes(media.mime)) fail(); const saved = await images.persistBytes(media.data); if (media.mime !== 'application/octet-stream' && media.mime !== saved.mime) fail(); return { type: 'image', url: saved.url, relativePath: saved.relativePath, alt }; }
            const saved = await persistVideo(media.data, media.mime); return { type: 'video', ...saved, alt: label };
          };
          let block;
          try { block = await load(source); }
          catch (error) {
            if (typeof resolveMedia !== 'function' || signal.aborted) throw error;
            // The channel plugin can refresh an expired/missing URL. It cannot
            // supply local paths or bypass the downloader's authority checks.
            let onAbort;
            const refreshed = await Promise.race([Promise.resolve().then(() => resolveMedia(segment, { signal })), new Promise((_, reject) => { onAbort = () => reject(new Error('媒体请求超时')); signal.addEventListener('abort', onAbort, { once: true }); })]).finally(() => signal.removeEventListener('abort', onAbort));
            if (typeof refreshed !== 'string' || refreshed === source) throw error;
            block = await load(refreshed);
          }
          blocks.push(block);
        } catch { blocks.push({type:'unavailable',text:`${label}无法加载`,mediaType:segment.type}); }
      } else if (segment.type === 'at' || segment.type === 'suna-mention') {
        let mention = channelMention(data.qq ?? data.id, data.name ?? data.nickname);
        if (mention && mention.userId !== 'all' && typeof resolveMention === 'function' && !signal.aborted) {
          let abort;
          try {
            const resolved = await Promise.race([Promise.resolve().then(() => resolveMention(segment, { signal })), new Promise(resolve => { abort = () => resolve(null); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]);
            if (!signal.aborted && resolved?.userId === mention.userId) mention = channelMention(mention.userId, resolved.name);
          } catch {} finally { signal.removeEventListener('abort', abort); }
        }
        if (mention) blocks.push(mention); else text('[无效提及]');
      }
      else if (segment.type !== 'reply') text(({ face: '[表情]', record: '[语音]', file: '[文件]', forward: '[合并转发]' })[segment.type] ?? '[消息]');
    }
    return { blocks, text: blocks.map(block => ['text','unavailable'].includes(block.type) ? block.text : block.type === 'mention' ? mentionContextText(block) : block.type === 'image' ? '[图片]' : '[视频]').join('') };
  }
  return { convert, resolveVideo };
}

export function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header); if (!match || (!match[1] && !match[2])) return false;
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return false; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (![start, end].every(Number.isSafeInteger) || start >= size || start < 0 || end < start) return false;
  return { start, end: Math.min(end, size - 1) };
}
