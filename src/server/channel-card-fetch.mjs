import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { publicIPv4 } from './channel-media.mjs';

const fail = () => { throw Object.assign(new Error('卡片网页无法读取'), { code: 'CHANNEL_CARD_FETCH_UNAVAILABLE' }); };
export function validateCardURL(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) fail();
  let url; try { url = new URL(value); } catch { fail(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !url.hostname.includes('.') || url.hostname.endsWith('.') || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) fail();
  // Literal addresses are validated before DNS too. IPv6 is deliberately not supported.
  if (url.hostname.includes(':') || (/^[\d.]+$/.test(url.hostname) && !publicIPv4(url.hostname))) fail();
  url.hash = '';
  return url;
}

const decode = text => text.replace(/&#(x[\da-f]+|\d+);/gi, (match, value) => {
  const n = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
}).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key]);
const clean = text => decode(text.replace(/<[^>]*>/g, ' ')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
export function extractCardPage(source, mime = 'text/html') {
  if (mime === 'text/plain') return { title: '', text: clean(source).slice(0, 6000) };
  const title = clean(source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '').slice(0, 300);
  const safe = source.replace(/<!--[^]*?-->/g, ' ').replace(/<(script|style|noscript|svg|nav|header|footer|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const body = safe.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)\s*>/i)?.[1] ?? safe.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? safe;
  return { title, text: clean(body).slice(0, 6000) };
}

async function bounded(task, signal) {
  signal.throwIfAborted(); let abort;
  return Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
    abort = () => reject(new Error('卡片读取超时'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  })]).finally(() => signal.removeEventListener('abort', abort));
}

/** Only the hostname goes to the fixed resolver, never a card path or query. */
export async function resolveCardDNS(hostname, { signal, request = https.request } = {}) {
  if (validateCardURL(`https://${hostname}/`).hostname !== hostname) fail();
  const deadline = AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]);
  const data = await bounded(() => new Promise((resolve, reject) => {
    const req = request(new URL(`https://dns.alidns.com/resolve?name=${encodeURIComponent(hostname)}&type=A`), {
      method: 'GET', agent: false, signal: deadline,
      headers: { accept: 'application/dns-json', 'accept-encoding': 'identity' },
      lookup: (_host, options, callback) => callback(null, options.all ? [{ address: '223.5.5.5', family: 4 }] : '223.5.5.5', 4),
    }, res => {
      if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length'] ?? 0) > 16384) { res.destroy(); reject(new Error('卡片域名解析失败')); return; }
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 16384) { res.destroy(); reject(new Error('卡片域名解析失败')); } else chunks.push(chunk); });
      res.on('error', reject); res.on('aborted', () => reject(new Error('卡片域名解析中断')));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('卡片域名解析失败')); } });
    }); req.on('error', reject); req.end();
  }), deadline);
  if (data?.Status !== 0 || !Array.isArray(data.Answer) || data.Answer.length > 64) fail();
  const normalized = value => typeof value === 'string' ? value.toLowerCase().replace(/\.$/, '') : '';
  const names = new Set([hostname]);
  for (let i = 0; i < 16; i++) for (const answer of data.Answer) if (answer.type === 5 && names.has(normalized(answer.name))) names.add(normalized(answer.data));
  const answers = data.Answer.filter(answer => answer.type === 1 && names.has(normalized(answer.name)));
  if (!answers.length || answers.some(answer => !publicIPv4(answer.data))) fail();
  return [...new Set(answers.map(answer => answer.data))].map(address => ({ address, family: 4 }));
}

/** Public pages only; never forwards QQ credentials, cookies or caller headers. */
export async function fetchCardPage(value, { signal, lookup = dnsLookup, request, resolvePublic = resolveCardDNS, maxBytes = 512 * 1024, timeoutMs = 6000 } = {}) {
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  for (let hop = 0; hop < 4; hop++) {
    deadline.throwIfAborted();
    const url = validateCardURL(value);
    let addresses = await bounded(() => lookup(url.hostname, { all: true, family: 4 }), deadline);
    if (Array.isArray(addresses) && addresses.length && addresses.every(item => item.family === 4 && /^198\.(18|19)\.\d{1,3}\.\d{1,3}$/.test(item.address) && item.address.split('.').every(part => Number(part) <= 255))) {
      addresses = await bounded(() => resolvePublic(url.hostname, { signal: deadline }), deadline);
    }
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => item.family !== 4 || !publicIPv4(item.address))) fail();
    const result = await bounded(() => new Promise((resolve, reject) => {
      const req = (request ?? (url.protocol === 'https:' ? https.request : http.request))(url, {
        method: 'GET', agent: false, signal: deadline,
        headers: { accept: 'text/html,text/plain', 'accept-encoding': 'identity', 'user-agent': 'Sandbook-CardReader/1.0' },
        lookup: (_hostname, options, callback) => callback(null, options.all ? [addresses[0]] : addresses[0].address, addresses[0].family),
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) { const location = res.headers.location; res.destroy(); if (typeof location !== 'string' || !location) { reject(new Error('卡片跳转无效')); return; } resolve({ location }); return; }
        const mime = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (res.statusCode !== 200 || !['text/html', 'application/xhtml+xml', 'text/plain'].includes(mime) || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length'] ?? 0) > maxBytes) { res.destroy(); reject(new Error('卡片网页不可用')); return; }
        let size = 0; const chunks = [];
        res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { res.destroy(); reject(new Error('卡片网页大小超限')); } else chunks.push(chunk); });
        res.on('error', reject); res.on('aborted', () => reject(new Error('卡片读取中断')));
        res.on('end', () => resolve({ data: Buffer.concat(chunks).toString('utf8'), mime }));
      });
      req.on('error', reject); req.end();
    }), deadline);
    if (result.location) {
      const next = validateCardURL(new URL(result.location, url).href);
      if (url.protocol === 'https:' && next.protocol !== 'https:') fail();
      value = next.href; continue;
    }
    const page = extractCardPage(result.data, result.mime);
    if (!page.text) fail();
    return { url: url.href, ...page };
  }
  fail();
}
