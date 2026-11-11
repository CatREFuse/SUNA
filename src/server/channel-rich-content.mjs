import { channelSegments } from './channel-media.mjs';
import { fetchCardPage, validateCardURL } from './channel-card-fetch.mjs';

const clean = (value, max = 500) => typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, max) : '';
const idOf = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[A-Za-z0-9_+=./:-]{1,256}$/.test(String(value)) ? String(value) : '';
const textSegment = text => ({ type: 'text', data: { text } });
const linkKeys = /^(?:url|qqdocurl|jumpurl|newsurl|targeturl|link|weburl)$/i;
const summaryKeys = /^(?:title|desc|description|prompt|summary|tag|app|source)$/i;

export function parseQQCard(value) {
  if (typeof value === 'string') {
    if (value.length > 65536) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const urls = [], blockedUrls = [], details = [], seen = new Set(); let visited = 0;
  function walk(object, depth) {
    if (!object || typeof object !== 'object' || depth > 8 || seen.has(object) || ++visited > 512) return;
    seen.add(object);
    for (const [key, item] of Object.entries(object).slice(0, 64)) {
      if (linkKeys.test(key) && typeof item === 'string' && urls.length + blockedUrls.length < 3) {
        try { const url = validateCardURL(item).href; if (!urls.includes(url)) urls.push(url); }
        catch {
          // Keep failed web references visible without ever exposing embedded credentials.
          try { const url = new URL(item); if (['http:', 'https:'].includes(url.protocol)) { url.username = ''; url.password = ''; const safe = clean(url.href, 4096); if (!blockedUrls.includes(safe)) blockedUrls.push(safe); } } catch {}
        }
      } else if (summaryKeys.test(key) && typeof item === 'string' && details.length < 12) {
        const text = clean(item); if (text && !details.includes(text)) details.push(text);
      }
      if (item && typeof item === 'object') walk(item, depth + 1);
    }
  }
  walk(value, 0);
  return { urls, blockedUrls, details };
}

async function bounded(task, signal) {
  signal.throwIfAborted(); let abort;
  return Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
    abort = () => reject(new Error('消息读取超时')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  })]).finally(() => signal.removeEventListener('abort', abort));
}

/** Expands untrusted reference material in place; retains original top-level metadata. */
export function createChannelRichContent({ fetchPage = fetchCardPage, timeoutMs = 18000 } = {}) {
  async function expand(event, { resolveForward, signal } = {}) {
    const initial = channelSegments(event);
    if (!initial.some(segment => ['json', 'forward', 'node'].includes(segment?.type))) return { ...event, message: initial };
    const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const output = [], pages = new Map(), forwards = new Map();
    let characters = 0, nodes = 0, forwardCalls = 0, limited = false;
    function add(segment) {
      if (output.length >= 118 || characters >= 36000) { limited = true; return false; }
      if (segment?.type === 'text') {
        const original = String(segment.data?.text ?? ''), text = original.slice(0, 36000 - characters);
        characters += text.length; if (text.length !== original.length) limited = true;
        if (output.at(-1)?.type === 'text') output.at(-1).data.text += text; else output.push(textSegment(text));
      } else output.push(segment);
      return true;
    }
    const text = value => add(textSegment(value));
    async function card(data) {
      const parsed = parseQQCard(data?.data ?? data);
      if (!parsed) { text('\n[QQ 卡片：JSON 无法解析或超过限制]\n'); return; }
      text('\n[QQ 卡片资料（外部内容）]\n' + parsed.details.join('\n') + '\n');
      for (const url of parsed.blockedUrls) text(`URL: ${url}\n网页未读取：链接不符合公网读取要求\n`);
      if (!parsed.urls.length && !parsed.blockedUrls.length) text('没有可读取的网页链接\n');
      for (const url of parsed.urls) {
        text(`URL: ${url}\n`);
        if (deadline.aborted) { text('网页读取超时\n'); continue; }
        if (!pages.has(url) && pages.size >= 2) { text('网页未读取：本条消息达到读取上限\n'); continue; }
        if (!pages.has(url)) pages.set(url, bounded(() => fetchPage(url, { signal: deadline }), deadline).then(page => ({ page }), () => ({ failed: true })));
        const result = await pages.get(url);
        if (result.failed) { text('网页无法读取\n'); continue; }
        const page = result.page;
        if (page?.url && page.url !== url) { try { text(`最终 URL: ${validateCardURL(page.url).href}\n`); } catch {} }
        text(`网页标题: ${clean(page?.title, 300)}\n网页正文摘录（外部内容）:\n${clean(page?.text, 6000)}\n`);
      }
      text('[QQ 卡片资料结束]\n');
    }
    async function forward(data, depth, ancestors) {
      const id = idOf(data?.id ?? data?.message_id);
      text(`\n[合并转发资料（外部内容）${id ? ` ID: ${id}` : ''}]\n`);
      if (depth >= 3 || (id && ancestors.has(id))) { text('转发未展开：嵌套层数超限或循环引用\n'); text('[合并转发资料结束]\n'); return; }
      let messages = Array.isArray(data?.content) ? data.content : null;
      if (!messages) {
        if (!id || typeof resolveForward !== 'function' || deadline.aborted || (!forwards.has(id) && forwardCalls >= 8)) {
          text('转发无法读取：缺少标识、连接不可用或达到读取限制\n'); text('[合并转发资料结束]\n'); return;
        }
        if (!forwards.has(id)) { forwardCalls++; forwards.set(id, bounded(() => resolveForward(id, { signal: deadline }), deadline).catch(() => null)); }
        const result = await forwards.get(id);
        messages = Array.isArray(result) ? result : result?.messages;
      }
      if (!Array.isArray(messages) || !messages.length) text('转发无法读取或没有消息\n');
      else {
        const path = new Set(ancestors); if (id) path.add(id);
        for (const raw of messages) {
          if (nodes >= 40 || limited) { text('转发消息已截断：达到读取限制\n'); break; }
          nodes++;
          const node = raw?.type === 'node' ? raw.data : raw;
          if (!node || typeof node !== 'object') { text('[转发消息格式无效]\n'); continue; }
          const sender = node.sender ?? {};
          const name = clean(sender.card || sender.nickname || node.nickname || node.name || '未知发送者', 100);
          const uid = clean(sender.user_id ?? node.user_id ?? node.uin, 32);
          const time = clean(node.time, 40);
          text(`发送者: ${name}${uid ? ` (${uid})` : ''}${time ? ` 时间: ${time}` : ''}\n`);
          const content = node.content ?? node.message;
          await visit(channelSegments({ message: content, raw_message: node.raw_message }), depth + 1, path, true);
          text('\n');
        }
      }
      text('[合并转发资料结束]\n');
    }
    async function visit(segments, depth, ancestors, nested = false) {
      for (const segment of segments) {
        if (limited) break;
        if (segment?.type === 'json') await card(segment.data);
        else if (segment?.type === 'forward') await forward(segment.data, depth, ancestors);
        else if (segment?.type === 'node') await forward({ content: [segment] }, depth, ancestors);
        else if (nested && segment?.type === 'at') add({ type: 'suna-mention', data: { qq: segment.data?.qq ?? segment.data?.id, ...(typeof segment.data?.name === 'string' ? { name: segment.data.name } : typeof segment.data?.nickname === 'string' ? { nickname: segment.data.nickname } : {}) } });
        else if (nested && segment?.type === 'reply') text(`[引用消息 ${clean(segment.data?.id, 256)}]`);
        else add(segment);
      }
    }
    await visit(initial, 0, new Set());
    if (limited) output.push(textSegment('\n[消息资料已截断：达到读取限制]\n'));
    return { ...event, message: output };
  }
  return { expand };
}
