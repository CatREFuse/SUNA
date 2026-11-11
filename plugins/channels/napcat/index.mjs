import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { endpoint, header, sameSecret, jsonRequest } from '../_shared/runtime.mjs';

const WEBUI_ACTIONS = new Set(['get_status', 'get_login_info', 'get_friend_list', 'get_group_list', 'get_group_member_list', 'get_msg', 'get_forward_msg', 'get_image', 'get_file', 'send_msg', 'send_private_msg', 'send_group_msg']);
const MEDIA_ACTIONS = new Set(['get_image', 'get_file']);
const SEND_ACTIONS = new Set(['send_msg', 'send_private_msg', 'send_group_msg']);
const IDENTITY_READ_ACTIONS = new Set(['get_forward_msg', 'get_group_member_list']);
const validId = value => (typeof value === 'string' && value.length > 0 && value.length < 256) || (typeof value === 'number' && Number.isSafeInteger(value));
const fileError = code => Object.assign(new Error(code), { code });
const uncertainFile = () => Object.assign(fileError('NAPCAT_FILE_DELIVERY_UNCERTAIN'), { deliveryUncertain: true });
function fileParams(action, input) {
  // Snapshot only JSON data. Never evaluate getters or keep caller-owned objects
  // across the asynchronous identity check.
  const copy = (value, depth = 0) => {
    if (depth > 8) throw fileError('NAPCAT_FILE_PARAMS_INVALID');
    if (value === null || ['string','boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) throw fileError('NAPCAT_FILE_PARAMS_INVALID');
    const out = Array.isArray(value) ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || ['__proto__','prototype','constructor'].includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor,'value')) throw fileError('NAPCAT_FILE_PARAMS_INVALID');
      out[key] = copy(descriptor.value, depth + 1);
    }
    return out;
  };
  const params = copy(input), kind = action === 'send_group_msg' ? 'group' : action === 'send_private_msg' ? 'private' : params.message_type;
  if (!['group','private'].includes(kind) || Object.keys(params).some(key => !['message_type','group_id','user_id','message','reply_to'].includes(key)) || params.message_type !== undefined && params.message_type !== kind || !validId(params[kind === 'group' ? 'group_id' : 'user_id']) || !/^\d{1,20}$/.test(String(params[kind === 'group' ? 'group_id' : 'user_id'])) || params[kind === 'group' ? 'user_id' : 'group_id'] !== undefined) throw fileError('NAPCAT_FILE_PARAMS_INVALID');
  if (!Array.isArray(params.message) || !params.message.length || params.message.length > 64) throw fileError('NAPCAT_FILE_PARAMS_INVALID');
  for (const segment of params.message) {
    if (!segment || Array.isArray(segment) || Object.keys(segment).some(key => !['type','data'].includes(key)) || !['reply','text','image','at','file'].includes(segment.type) || !segment.data || Array.isArray(segment.data) || typeof segment.data !== 'object') throw fileError('NAPCAT_FILE_PARAMS_INVALID');
    if (segment.type !== 'file') continue;
    const {file,name} = segment.data;
    if (Object.keys(segment.data).length !== 2 || typeof file !== 'string' || file.length > 8192 || typeof name !== 'string' || !name.trim() || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name)) throw fileError('NAPCAT_FILE_PARAMS_INVALID');
    try {
      const url = new URL(file), path = fileURLToPath(url);
      if (url.host || url.search || url.hash || /[\x00-\x1f\x7f\\]/.test(path) || pathToFileURL(path).href !== file) throw Error();
    } catch { throw fileError('NAPCAT_FILE_PARAMS_INVALID'); }
  }
  return params;
}

export function createAdapter({ config, emit, fetch, WebSocket, reportStatus = () => {}, log = () => {}, connectionTimeoutMs = 10000, reconnectDelayMs = 1000 }) {
  const transport = config.transport || 'http';
  if (!['http', 'webui-action'].includes(transport)) throw new Error('NAPCAT_TRANSPORT_INVALID');
  const base = transport === 'http' ? endpoint(config.httpUrl || 'http://127.0.0.1:3000') : null;
  if (transport === 'webui-action') {
    if (!config.webuiUrl || !config.webuiToken) throw new Error('NAPCAT_WEBUI_CONFIG_REQUIRED');
    endpoint(config.webuiUrl);
  }
  let socket, stopped = true, retry, attempts = 0, credential = '', generation = 0, authenticatedIdentity = '', cancelPending, connectionAbort;
  const request = async (action, params = {}) => {
    const requestGeneration = generation;
    if (SEND_ACTIONS.has(action) && Array.isArray(params?.message) && params.message.some(segment => segment?.type === 'file')) {
      params = fileParams(action, params);
      const url = transport === 'http' ? base : endpoint(config.webuiUrl);
      if (!['127.0.0.1','[::1]','localhost'].includes(url.hostname)) throw fileError('NAPCAT_FILE_TRANSPORT_UNSUPPORTED');
      if (stopped) throw fileError('NAPCAT_NOT_CONNECTED');
      if (Buffer.byteLength(JSON.stringify({action,params}), 'utf8') > 100 * 1024) throw fileError('NAPCAT_FILE_PAYLOAD_TOO_LARGE');
      if (transport === 'webui-action') await webuiIdentity();
      else {
        const status = await request('get_status');
        if (status.data?.online !== true || status.data?.good === false) throw fileError('NAPCAT_NOT_LOGGED_IN');
        const identity = await request('get_login_info'), expected = String(config.expectedSelfId || authenticatedIdentity || '');
        if (!validId(identity.data?.user_id)) throw fileError('NAPCAT_NOT_LOGGED_IN');
        if (expected && String(identity.data.user_id) !== expected) throw fileError('NAPCAT_ACCOUNT_MISMATCH');
        authenticatedIdentity = String(identity.data.user_id);
      }
      if (stopped || requestGeneration !== generation) throw fileError('NAPCAT_NOT_CONNECTED');
      let result;
      try {
        result = transport === 'webui-action' ? await webui('/Debug/call', {action,params}) : await jsonRequest(fetch, new URL(action, `${base.href.replace(/\/$/, '')}/`), {body:params,headers:config.accessToken ? {authorization:`Bearer ${config.accessToken}`} : {}});
      } catch { throw uncertainFile(); }
      if (stopped || requestGeneration !== generation) throw uncertainFile();
      if (result?.status !== 'ok' || Number(result?.retcode) !== 0) {
        if (result?.status !== 'failed' || !Number.isFinite(Number(result?.retcode)) || Number(result.retcode) === 0) throw uncertainFile();
        throw fileError(`NAPCAT_ACTION_FAILED_${Number(result.retcode)}`);
      }
      if (!validId(result.data?.message_id) || /[\x00-\x20\x7f]/.test(String(result.data.message_id))) throw uncertainFile();
      return {...result,retcode:0};
    }
    if (action === 'get_forward_msg') {
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length !== 1 || !Object.hasOwn(params, 'message_id') || !validId(params.message_id) || /[\x00-\x20\x7f]/.test(String(params.message_id))) throw new Error('NAPCAT_FORWARD_PARAMS_INVALID');
      params = { message_id: String(params.message_id) };
      if (stopped) throw new Error('NAPCAT_NOT_CONNECTED');
    }
    if (action === 'get_group_member_list') {
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['group_id','no_cache'].includes(key)) || !Object.hasOwn(params,'group_id') || !validId(params.group_id) || !/^\d{1,20}$/.test(String(params.group_id)) || params.no_cache !== undefined && typeof params.no_cache !== 'boolean') throw new Error('NAPCAT_MEMBER_PARAMS_INVALID');
      params = { group_id: String(params.group_id), ...(params.no_cache !== undefined ? { no_cache: params.no_cache } : {}) };
      if (stopped) throw new Error('NAPCAT_NOT_CONNECTED');
    }
    if (IDENTITY_READ_ACTIONS.has(action) && transport === 'http') {
        const identity = await request('get_login_info');
        const expected = String(config.expectedSelfId || authenticatedIdentity || '');
        if (!validId(identity.data?.user_id)) throw new Error('NAPCAT_NOT_LOGGED_IN');
        if (expected && String(identity.data.user_id) !== expected) throw new Error('NAPCAT_ACCOUNT_MISMATCH');
        if (stopped || requestGeneration !== generation) throw new Error('NAPCAT_NOT_CONNECTED');
        authenticatedIdentity = String(identity.data.user_id);
    }
    if (MEDIA_ACTIONS.has(action)) {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('NAPCAT_MEDIA_PARAMS_INVALID');
      const fields = Object.entries(params);
      if (!fields.length || fields.some(([key,value]) => !['file','file_id'].includes(key) || typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value))) throw new Error('NAPCAT_MEDIA_PARAMS_INVALID');
      params = Object.fromEntries(fields);
      if (stopped) throw new Error('NAPCAT_NOT_CONNECTED');
    }
    if (transport === 'webui-action') {
      if (!WEBUI_ACTIONS.has(action)) throw new Error('NAPCAT_WEBUI_ACTION_UNSUPPORTED');
      if (Buffer.byteLength(JSON.stringify({action,params}), 'utf8') > 100 * 1024) throw Object.assign(new Error('NapCat WebUI 请求超过 100 KiB；远程图片请改用 OneBot HTTP 连接'), {code:'NAPCAT_WEBUI_PAYLOAD_TOO_LARGE'});
      const run = generation;
      if (SEND_ACTIONS.has(action) || MEDIA_ACTIONS.has(action) || IDENTITY_READ_ACTIONS.has(action)) {
        if (stopped) throw new Error('NAPCAT_NOT_CONNECTED');
        await webuiIdentity();
        if (stopped || run !== generation) throw new Error('NAPCAT_NOT_CONNECTED');
      }
      const result = await webui('/Debug/call', { action, params });
      if (IDENTITY_READ_ACTIONS.has(action) && (stopped || run !== generation)) throw new Error('NAPCAT_NOT_CONNECTED');
      if (result?.status !== 'ok' || Number(result?.retcode) !== 0) throw new Error(`NAPCAT_ACTION_FAILED_${Number.isFinite(Number(result?.retcode)) ? Number(result.retcode) : 'UNKNOWN'}`);
      if (SEND_ACTIONS.has(action) && !validId(result.data?.message_id)) throw new Error('NAPCAT_SEND_RECEIPT_MISSING');
      return { ...result, retcode: 0 };
    }
    const result = await jsonRequest(fetch, new URL(action, `${base.href.replace(/\/$/, '')}/`), { body: params, headers: config.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {} });
    if (IDENTITY_READ_ACTIONS.has(action) && (stopped || requestGeneration !== generation)) throw new Error('NAPCAT_NOT_CONNECTED');
    if (result.status !== 'ok' || Number(result.retcode) !== 0) throw new Error(`NAPCAT_ACTION_FAILED_${Number(result.retcode) || 'UNKNOWN'}`);
    return result;
  };
  const accept = event => { if (!event?.post_type) return; if (transport === 'webui-action' && (!authenticatedIdentity || String(event.self_id) !== authenticatedIdentity)) return; emit(event); };
  function openSocket(run) {
    if (stopped || run !== generation) return;
    const url = endpoint(config.eventUrl, { websocket: true }); if (config.accessToken) url.searchParams.set('access_token', config.accessToken);
    socket = new WebSocket(url.href);
    socket.addEventListener('open', () => { if (stopped || run !== generation) return; attempts = 0; reportStatus('connected'); });
    socket.addEventListener('message', ({ data }) => { if (stopped || run !== generation) return; try { if (String(data).length > 1024 * 1024) return; accept(JSON.parse(String(data))); } catch { log('invalid_event'); } });
    socket.addEventListener('error', () => { if (!stopped && run === generation) reportStatus('reconnecting', '消息连接异常，正在重连'); });
    socket.addEventListener('close', () => { if (!stopped && run === generation) { reportStatus('reconnecting'); retry = setTimeout(() => openSocket(run), Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5))); retry.unref?.(); } });
  }
  function scheduleWebuiReconnect(run) {
    if (stopped || run !== generation) return;
    reportStatus('reconnecting', '消息连接断开，正在重连');
    clearTimeout(retry);
    retry = setTimeout(() => {
      retry = undefined;
      void connectWebuiEvents(run).catch(() => { if (!stopped && run === generation) scheduleWebuiReconnect(run); });
    }, Math.min(30000, reconnectDelayMs * 2 ** Math.min(attempts++, 5)));
    retry.unref?.();
  }
  async function connectWebuiEvents(run) {
    if (!WebSocket) throw new Error('WEBSOCKET_UNAVAILABLE');
    const active = () => !stopped && run === generation;
    if (!active()) throw new Error('NAPCAT_NOT_CONNECTED');
    await webuiIdentity(connectionAbort?.signal);
    if (!active()) throw new Error('NAPCAT_NOT_CONNECTED');
    const session = await webui('/Debug/create', {}, connectionAbort?.signal);
    if (!active()) throw new Error('NAPCAT_NOT_CONNECTED');
    if (typeof session?.adapterName !== 'string' || !session.adapterName || session.adapterName.length > 256 || typeof session.token !== 'string' || !session.token || session.token.length > 4096) throw new Error('NAPCAT_EVENT_SESSION_INVALID');
    const url = new URL('/api/Debug/ws', endpoint(config.webuiUrl));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('adapterName', session.adapterName);url.searchParams.set('token', session.token);
    return new Promise((resolve, reject) => {
      let opened = false, settled = false, timer, ws;
      const finish = error => {
        if (settled) return;settled = true;clearTimeout(timer);
        if (cancelPending === cancel) cancelPending = undefined;
        if (error) { reject(new Error(error)); try { ws?.close(); } catch {} } else resolve();
      };
      const cancel = () => finish('NAPCAT_NOT_CONNECTED');cancelPending = cancel;
      try { ws = new WebSocket(url.href);socket = ws; } catch { finish('NAPCAT_EVENT_CONNECT_FAILED');return; }
      timer = setTimeout(() => finish('NAPCAT_EVENT_CONNECT_TIMEOUT'), connectionTimeoutMs);
      ws.addEventListener('open', () => {
        if (!active() || socket !== ws) { finish('NAPCAT_NOT_CONNECTED');return; }
        opened = true;attempts = 0;reportStatus('connected');finish();
      });
      ws.addEventListener('message', ({data}) => {
        if (!opened || !active() || socket !== ws) return;
        try {
          const text = String(data);if (text.length > 1024 * 1024) return;
          accept(JSON.parse(text.replace(/("(?:message_id|seq|msg_seq)"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"')));
        } catch { log('invalid_event'); }
      });
      ws.addEventListener('error', () => {
        if (!active() || socket !== ws) return;
        if (!opened) finish('NAPCAT_EVENT_CONNECT_FAILED');else { reportStatus('reconnecting', '消息连接异常，正在重连');try { ws.close(); } catch {} }
      });
      ws.addEventListener('close', () => {
        if (socket === ws) socket = undefined;
        if (!opened) finish('NAPCAT_EVENT_CONNECT_FAILED');
        else if (active()) scheduleWebuiReconnect(run);
      });
    });
  }
  async function webui(route, body = {}, signal) {
    if (!config.webuiUrl || !config.webuiToken) throw new Error('NAPCAT_WEBUI_CONFIG_REQUIRED');
    const url = endpoint(config.webuiUrl);
    if (!credential) {
      const auth = await jsonRequest(fetch, new URL('/api/auth/login', url), { body: { hash: createHash('sha256').update(`${config.webuiToken}.napcat`).digest('hex') }, signal });
      if (auth.code !== 0 || !auth.data?.Credential) throw new Error('NAPCAT_WEBUI_AUTH_FAILED'); credential = auth.data.Credential;
    }
    const result = await jsonRequest(fetch, new URL(`/api${route}`, url), { body, headers: { authorization: `Bearer ${credential}` }, signal });
    if (result.code !== 0) { credential = ''; throw new Error('NAPCAT_WEBUI_REQUEST_FAILED'); }
    return result.data;
  }
  async function webuiIdentity(signal) {
    const info = await webui('/QQLogin/GetQQLoginInfo', {}, signal);
    if (info?.online !== true || !validId(info.uin)) throw new Error('NAPCAT_NOT_LOGGED_IN');
    const expected = String(config.expectedSelfId || authenticatedIdentity || '');
    if (expected && String(info.uin) !== expected) throw new Error('NAPCAT_ACCOUNT_MISMATCH');
    return String(info.uin);
  }
  return {
    async start() {
      if (!stopped) return;
      const run = ++generation;connectionAbort?.abort();connectionAbort = new AbortController();
      if (transport === 'webui-action') {
        const status = await webui('/QQLogin/CheckLoginStatus', {}, connectionAbort.signal);
        if (status?.isLogin !== true || status.isOffline === true || status.loginError) throw new Error('NAPCAT_NOT_LOGGED_IN');
        const identity = await webuiIdentity(connectionAbort.signal);
        if (run !== generation) return;
        authenticatedIdentity = identity;
        stopped = false;
        if (config.receiveEvents === true) {
          try { await connectWebuiEvents(run); } catch (error) { if (run === generation) { stopped = true;socket?.close();socket = undefined; } throw error; }
        } else reportStatus('connected');
        return;
      }
      const status = await request('get_status'); if (status.data?.online === false || status.data?.good === false) throw new Error('NAPCAT_NOT_LOGGED_IN');
      if (run !== generation) return;
      stopped = false;
      if (config.eventUrl) { if (!WebSocket) { stopped = true; throw new Error('WEBSOCKET_UNAVAILABLE'); } openSocket(run); }
      else if (config.webhookToken) reportStatus('waiting-webhook', '等待 OneBot 事件上报');
      else { stopped = true; throw new Error('NAPCAT_EVENT_TRANSPORT_REQUIRED'); }
    },
    async stop() { stopped = true; generation++; connectionAbort?.abort();clearTimeout(retry);cancelPending?.();socket?.close(); socket = undefined; reportStatus('disconnected'); },
    execute: request,
    async getLoginQr({ refresh = false } = {}) {
      let status = await webui('/QQLogin/CheckLoginStatus');
      // Refresh is a login operation, never an implicit logout of a live account.
      if (refresh && status.isLogin !== true) {
        await webui('/QQLogin/RefreshQRcode');
        status = await webui('/QQLogin/CheckLoginStatus');
      }
      if (status.isLogin === true) {
        const info = await webui('/QQLogin/GetQQLoginInfo');
        const online = info?.online === true && status.isOffline !== true && !status.loginError;
        const mismatch = config.expectedSelfId && String(info?.uin) !== String(config.expectedSelfId);
        return {status:online&&!mismatch?'confirmed':'offline',online:online&&!mismatch,qrContent:null,selfId:validId(info?.uin)?String(info.uin):undefined,nickname:typeof info?.nick==='string'?info.nick.slice(0,100):undefined,error:mismatch?'登录 QQ 与预期账号不一致':status.loginError?'NapCat 登录异常，请在手机上检查':null};
      }
      return {status:status.isOffline?'offline':'wait',online:false,qrContent:!status.loginError&&typeof status.qrcodeurl==='string'&&status.qrcodeurl.length<=8192?status.qrcodeurl:null,error:status.loginError?'NapCat 登录异常，请在手机上检查':null};
    },
    async handleWebhook({ rawBody, headers, method = 'POST' }) {
      if (stopped || method !== 'POST') return { status: 405, body: {} };
      if (!config.webhookToken) return { status: 403, body: {} };
      const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? '');
      if (body.length > 1024 * 1024) return { status: 413, body: {} };
      const bearer = header(headers, 'authorization'), signature = header(headers, 'x-signature');
      const valid = sameSecret(bearer, `Bearer ${config.webhookToken}`) || sameSecret(signature, `sha1=${createHmac('sha1', config.webhookToken).update(body).digest('hex')}`);
      if (!valid) return { status: 401, body: {} };
      try { accept(JSON.parse(body.toString('utf8'))); reportStatus('connected'); return { status: 200, body: {} }; }
      catch { return { status: 400, body: {} }; }
    }
  };
}
