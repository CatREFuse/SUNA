import { timingSafeEqual } from 'node:crypto';

export function endpoint(value, { websocket = false } = {}) {
  const url = new URL(value);
  const secure = websocket ? 'wss:' : 'https:', local = websocket ? 'ws:' : 'http:';
  if (url.username || url.password || url.hash || (url.protocol !== secure && !(url.protocol === local && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('CHANNEL_ENDPOINT_REQUIRES_HTTPS_OR_LOOPBACK');
  return url;
}
export function sameSecret(a, b) { const aa = Buffer.from(a ?? ''), bb = Buffer.from(b ?? ''); return aa.length > 0 && aa.length === bb.length && timingSafeEqual(aa, bb); }
export function header(headers, name) { return typeof headers?.get === 'function' ? headers.get(name) : Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]; }
export async function jsonRequest(fetchImpl, url, { body, headers = {}, method = 'POST', timeoutMs = 10000, signal } = {}) {
  const response = await fetchImpl(endpoint(url), { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`CHANNEL_HTTP_${response.status}`);
  const text = await response.text(); if (text.length > 4 * 1024 * 1024) throw new Error('CHANNEL_RESPONSE_TOO_LARGE');
  // Platform IDs are uint64 and must not lose precision before event normalization.
  return JSON.parse(text.replace(/("(?:message_id|seq|msg_seq)"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"'));
}
export function textMessage(message) {
  if (typeof message === 'string' && message.trim()) return message;
  if (!Array.isArray(message) || message.some(s => s.type !== 'text' && s.type !== 'reply')) throw new Error('CHANNEL_TEXT_MESSAGES_ONLY');
  const result = message.filter(s => s.type === 'text').map(s => String(s.data?.text ?? '')).join('');
  if (!result.trim()) throw new Error('CHANNEL_MESSAGE_EMPTY');
  return result;
}
export function targetFor(action, params) {
  const type = action === 'send_group_msg' ? 'group' : action === 'send_private_msg' ? 'private' : params.message_type ?? (params.group_id != null ? 'group' : 'private');
  if (!['group', 'private'].includes(type)) throw new Error('CHANNEL_TARGET_INVALID');
  const id = params[type === 'group' ? 'group_id' : 'user_id'];
  if (id == null || String(id).length < 1 || String(id).length > 256) throw new Error('CHANNEL_TARGET_REQUIRED');
  return { type, id: String(id) };
}
export const success = data => ({ status: 'ok', retcode: 0, data });
export function boundedMapSet(map, key, value, max = 5000) { map.set(key, value); if (map.size > max) map.delete(map.keys().next().value); }
export function sleep(ms, signal) { return new Promise(resolve => { if (signal?.aborted) return resolve(); const timer = setTimeout(done, ms); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); }); }
