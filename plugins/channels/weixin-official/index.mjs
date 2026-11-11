import { randomBytes, randomUUID } from 'node:crypto';
import { endpoint, jsonRequest, textMessage, targetFor, success, boundedMapSet, sleep } from '../_shared/runtime.mjs';

export function createAdapter({ config, accountId, emit, fetch, reportStatus = () => {}, saveConfig = async () => {}, log = () => {} }) {
  let base = endpoint(config.apiUrl || 'https://ilinkai.weixin.qq.com');
  const initialBase = base.href, contexts = new Map();
  let token = config.botToken || '', botId = config.botId || accountId, cursor = config.cursor || '', controller, loop, active = false, qr, generation = 0;
  const appHeaders = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x00000100) };
  const baseInfo = { channel_version: '0.1.0', bot_agent: 'SUNA/0.1.0' };
  function trustedBase(value) {
    const url = endpoint(value);
    if (url.origin !== new URL(initialBase).origin && !(url.protocol === 'https:' && (url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')))) throw new Error('WEIXIN_UNTRUSTED_REDIRECT');
    return url;
  }
  async function post(route, body, { authorized = true, timeoutMs = 10000, signal } = {}) {
    const headers = { ...appHeaders, AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'), ...(authorized && token ? { Authorization: `Bearer ${token}` } : {}) };
    const result = await jsonRequest(fetch, new URL(route, base), { body: { ...body, ...(authorized ? { base_info: baseInfo } : {}) }, headers, timeoutMs, signal });
    const errorCode = Number(result.ret || result.errcode || 0);
    if (errorCode) {
      if (errorCode === -14) { active = false; controller?.abort(); reportStatus('login-expired', '微信登录已过期，请重新扫码'); }
      throw new Error(`WEIXIN_API_${errorCode}`);
    }
    return result;
  }
  async function pollOnce(signal) {
    const result = await post('/ilink/bot/getupdates', { get_updates_buf: cursor }, { timeoutMs: 45000, signal });
    if (signal?.aborted) return;
    for (const msg of result.msgs ?? []) {
      if (msg.message_type !== 1 || !msg.from_user_id || !msg.message_id) continue;
      if (msg.group_id) { log('unsupported_group_event'); continue; }
      const text = (msg.item_list ?? []).map(item => item.type === 1 ? item.text_item?.text || '' : item.type === 3 ? item.voice_item?.text || '' : '').join('\n');
      if (!text) { log('unsupported_media_event'); continue; }
      if (msg.context_token) boundedMapSet(contexts, String(msg.from_user_id), { token: msg.context_token, at: Date.now() });
      emit({ time: Math.floor((msg.create_time_ms || Date.now()) / 1000), self_id: String(botId), post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: String(msg.message_id), user_id: String(msg.from_user_id), message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: String(msg.from_user_id) } });
    }
    if (typeof result.get_updates_buf === 'string' && result.get_updates_buf && result.get_updates_buf !== cursor) { cursor = result.get_updates_buf; await saveConfig({ cursor }); }
    if (!signal?.aborted) reportStatus('connected');
  }
  async function run(signal) {
    let failures = 0;
    while (active && !signal.aborted) {
      await sleep(failures ? Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)) : 1000, signal);
      if (!active || signal.aborted) break;
      try { await pollOnce(signal); failures = 0; }
      catch { if (!active || signal.aborted) break; failures++; reportStatus('reconnecting', '收取消息失败，正在重试'); }
    }
  }
  return {
    async start() {
      if (active) return;
      if (!token) { reportStatus('waiting-login', '请扫码绑定微信'); return; }
      const runId = ++generation, localController = new AbortController(); active = true; controller = localController; reportStatus('connecting');
      try { await pollOnce(localController.signal); }
      catch (error) { if (runId !== generation) return; active = false; throw error; }
      if (active && runId === generation) loop = run(localController.signal);
    },
    async stop() { generation++; active = false; controller?.abort(); await loop; reportStatus('disconnected'); },
    async getLoginQr({ refresh = false } = {}) {
      if (active && !refresh) return { status: 'confirmed', qrContent: null, online: true };
      if (active) { generation++; active = false; controller?.abort(); await loop; }
      if (qr && !refresh && Date.now() - qr.at < 180000) return { status: 'wait', qrContent: qr.content };
      const result = await post('/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: token ? [token] : [] }, { authorized: false });
      if (!result.qrcode || !result.qrcode_img_content) throw new Error('WEIXIN_QR_INVALID');
      qr = { code: result.qrcode, content: result.qrcode_img_content, at: Date.now(), pollBase: base };
      reportStatus('waiting-login', '使用微信扫码绑定'); return { status: 'wait', qrContent: qr.content };
    },
    async pollLogin({ verifyCode } = {}) {
      if (!qr) throw new Error('WEIXIN_QR_REQUIRED');
      const url = new URL('/ilink/bot/get_qrcode_status', qr.pollBase); url.searchParams.set('qrcode', qr.code);
      if (verifyCode) { if (!/^\d{4,8}$/.test(verifyCode)) throw new Error('WEIXIN_VERIFY_CODE_INVALID'); url.searchParams.set('verify_code', verifyCode); }
      const result = await jsonRequest(fetch, url, { method: 'GET', headers: appHeaders, timeoutMs: 45000 });
      if (result.status === 'scaned_but_redirect' && result.redirect_host) { qr.pollBase = trustedBase(result.redirect_host.includes('://') ? result.redirect_host : `https://${result.redirect_host}`); return { status: 'scaned' }; }
      if (result.status === 'confirmed') {
        if (!result.bot_token || !result.ilink_bot_id) throw new Error('WEIXIN_LOGIN_INVALID');
        base = trustedBase(result.baseurl || base.href); token = result.bot_token; botId = result.ilink_bot_id; cursor = ''; contexts.clear(); qr = null;
        await saveConfig({ apiUrl: base.href, botToken: token, botId, cursor }); reportStatus('disconnected', '微信已绑定，可以连接');
        return { status: 'confirmed', botId };
      }
      const status = ['wait', 'scaned', 'expired', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'].includes(result.status) ? result.status : 'wait';
      if (status === 'expired' || status === 'verify_code_blocked') qr = null;
      return { status };
    },
    async execute(action, params = {}) {
      if (action === 'get_status') return success({ online: active, good: active });
      if (action === 'get_login_info') return success({ user_id: botId, nickname: '微信 AI Bot' });
      if (!['send_msg', 'send_private_msg'].includes(action)) throw new Error('WEIXIN_ACTION_UNSUPPORTED');
      if (!active) throw new Error('CHANNEL_NOT_CONNECTED');
      const { type, id } = targetFor(action, params); if (type !== 'private') throw new Error('WEIXIN_GROUP_UNSUPPORTED');
      const context = contexts.get(id); if (!context || Date.now() - context.at > 24 * 60 * 60 * 1000) throw new Error('WEIXIN_REPLY_CONTEXT_REQUIRED');
      const clientId = randomUUID();
      const result = await post('/ilink/bot/sendmessage', { msg: { from_user_id: '', to_user_id: id, client_id: clientId, message_type: 2, message_state: 2, context_token: context.token, item_list: [{ type: 1, text_item: { text: textMessage(params.message) } }] } });
      // An API acceptance is not proof that a phone displayed the message.
      return success({ message_id: String(result.message_id ?? clientId), accepted: true, delivered: null });
    }
  };
}
