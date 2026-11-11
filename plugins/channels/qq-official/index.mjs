import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { endpoint, header, jsonRequest, textMessage, targetFor, success, boundedMapSet } from '../_shared/runtime.mjs';

export function signingKey(secret) {
  if (typeof secret !== 'string' || !secret) throw new Error('QQ_APP_SECRET_REQUIRED');
  let seed = Buffer.from(secret); while (seed.length < 32) seed = Buffer.concat([seed, seed]);
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
}

export function createAdapter({ config, emit, fetch, reportStatus = () => {} }) {
  if (!config.appId || !config.appSecret) throw new Error('QQ_CREDENTIALS_REQUIRED');
  const base = endpoint(config.apiUrl || 'https://api.sgroup.qq.com'), tokenUrl = endpoint(config.tokenUrl || 'https://bots.qq.com/app/getAppAccessToken');
  const privateKey = signingKey(config.appSecret), publicKey = createPublicKey(privateKey), contexts = new Map(), sequences = new Map();
  let token = '', expires = 0, tokenPromise, started = false, generation = 0;
  async function getToken() {
    if (token && expires > Date.now() + 60000) return token;
    if (!tokenPromise) tokenPromise = (async () => {
      const result = await jsonRequest(fetch, tokenUrl, { body: { appId: config.appId, clientSecret: config.appSecret } });
      if (!result.access_token || !(Number(result.expires_in) > 0)) throw new Error('QQ_TOKEN_FAILED');
      token = result.access_token; expires = Date.now() + Number(result.expires_in) * 1000; return token;
    })().finally(() => { tokenPromise = undefined; });
    return tokenPromise;
  }
  function eventFor(payload) {
    const d = payload.d; if (!d || !['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(payload.t)) return null;
    const group = payload.t === 'GROUP_AT_MESSAGE_CREATE', user = d.author?.user_openid ?? d.author?.id;
    if (!d.id || !user || (group && !d.group_openid)) throw new Error('QQ_EVENT_INVALID');
    const id = group ? d.group_openid : user;
    boundedMapSet(contexts, `${group ? 'group' : 'private'}:${id}`, { id: d.id, at: Date.now() });
    return { time: Math.floor((Date.parse(d.timestamp) || Date.now()) / 1000), self_id: String(config.appId), post_type: 'message', message_type: group ? 'group' : 'private', sub_type: group ? 'normal' : 'friend', message_id: String(d.id), user_id: String(user), ...(group ? { group_id: String(id) } : {}), message: [{ type: 'text', data: { text: String(d.content ?? '').trim() } }], raw_message: String(d.content ?? '').trim(), sender: { user_id: String(user), nickname: d.author?.username || '' } };
  }
  return {
    async start() { const run = ++generation; await getToken(); if (run !== generation) return; started = true; reportStatus('waiting-webhook', '凭据已验证，等待平台回调'); },
    async stop() { generation++; started = false; token = ''; expires = 0; reportStatus('disconnected'); },
    async execute(action, params = {}) {
      if (action === 'get_status') return success({ online: started, good: started });
      if (action === 'get_login_info') return success({ user_id: config.appId, nickname: 'QQ 官方机器人' });
      if (!['send_msg', 'send_private_msg', 'send_group_msg'].includes(action)) throw new Error('QQ_ACTION_UNSUPPORTED');
      if (!started) throw new Error('CHANNEL_NOT_CONNECTED');
      const { type, id } = targetFor(action, params), context = contexts.get(`${type}:${id}`);
      const msgId = params.reply_to ?? params.message?.find?.(s => s.type === 'reply')?.data?.id ?? (context && Date.now() - context.at < 5 * 60 * 1000 ? context.id : undefined);
      if (!msgId) throw new Error('QQ_REPLY_CONTEXT_REQUIRED');
      const sequenceKey = `${type}:${id}:${msgId}`, seq = (sequences.get(sequenceKey) ?? 0) + 1; boundedMapSet(sequences, sequenceKey, seq);
      const result = await jsonRequest(fetch, new URL(`/v2/${type === 'group' ? 'groups' : 'users'}/${encodeURIComponent(id)}/messages`, base), {
        headers: { authorization: `QQBot ${await getToken()}`, 'X-Union-Appid': String(config.appId) },
        body: { content: textMessage(params.message), msg_type: 0, msg_id: String(msgId), msg_seq: seq }
      });
      if (result.code || !result.id) throw new Error(`QQ_SEND_FAILED_${Number(result.code) || 'MISSING_RECEIPT'}`);
      return success({ message_id: String(result.id), accepted: true });
    },
    async handleWebhook({ rawBody, headers, method = 'POST' }) {
      if (!started || method !== 'POST') return { status: 405, body: {} };
      const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? '');
      if (body.length > 1024 * 1024) return { status: 413, body: {} };
      const timestamp = header(headers, 'x-signature-timestamp'), sig = header(headers, 'x-signature-ed25519'), appId = header(headers, 'x-bot-appid');
      if ((appId && appId !== String(config.appId)) || !/^\d+$/.test(timestamp ?? '') || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-fA-F0-9]{128}$/.test(sig ?? '') || !verify(null, Buffer.concat([Buffer.from(timestamp), body]), publicKey, Buffer.from(sig, 'hex'))) return { status: 401, body: {} };
      try {
        const payload = JSON.parse(body.toString('utf8'));
        if (payload.op === 13) {
          if (typeof payload.d?.plain_token !== 'string' || typeof payload.d?.event_ts !== 'string') return { status: 400, body: {} };
          return { status: 200, body: { plain_token: payload.d.plain_token, signature: sign(null, Buffer.from(payload.d.event_ts + payload.d.plain_token), privateKey).toString('hex') } };
        }
        if (payload.op === 0) { const event = eventFor(payload); if (event) emit(event); reportStatus('connected'); return { status: 200, body: { op: 12, d: 0 } }; }
        if (payload.op === 1) return { status: 200, body: { op: 11, d: payload.d } };
        return { status: 200, body: { op: 12, d: 0 } };
      } catch { return { status: 400, body: { op: 12, d: 1 } }; }
    }
  };
}
