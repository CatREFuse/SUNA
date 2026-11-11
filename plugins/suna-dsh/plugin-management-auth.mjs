import {createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify} from 'node:crypto';

export const MANAGEMENT_PATH = '/plugin-management';
const WINDOW_MS = 30_000;
const MAX_BODY_BYTES = 256 * 1024;
const reject = () => { throw Object.assign(new Error('DSH 插件管理请求未获授权'), {code: 'DSH_PLUGIN_NATIVE_REQUIRED'}); };

function envelope(body, timestamp, nonce) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY_BYTES) reject();
  return Buffer.from(['suna-dsh-management-v1', 'POST', MANAGEMENT_PATH, timestamp, nonce,
    createHash('sha256').update(body).digest('hex')].join('\n'));
}

/** A new Client-owned signing key is created per Runtime generation, never sent to a renderer or DSH. */
export function createManagementSigner({clock = Date.now} = {}) {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({type: 'spki', format: 'pem'});
  return {
    publicKey,
    headers(body) {
      const timestamp = String(clock());
      const nonce = randomBytes(24).toString('hex');
      const signature = sign(null, envelope(body, timestamp, nonce), keys.privateKey).toString('base64url');
      return {'x-suna-management-time': timestamp, 'x-suna-management-nonce': nonce,
        'x-suna-management-signature': signature};
    },
  };
}

/** Bearer discovery tokens do not authorize administration. Only the Client's signed fixed-route request does. */
export function createManagementVerifier(publicKey, {clock = Date.now, maximumNonces = 4096} = {}) {
  if (typeof publicKey !== 'string' || publicKey.length > 4096 || !Number.isInteger(maximumNonces) || maximumNonces < 1) reject();
  let key;
  try { key = createPublicKey(publicKey); } catch { reject(); }
  if (key.asymmetricKeyType !== 'ed25519') reject();
  const nonces = new Map();
  return {
    verify({method, pathname, headers, body}) {
      if (method !== 'POST' || pathname !== MANAGEMENT_PATH) reject();
      const timestamp = headers?.['x-suna-management-time'];
      const nonce = headers?.['x-suna-management-nonce'];
      const signature = headers?.['x-suna-management-signature'];
      if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) ||
          typeof nonce !== 'string' || !/^[a-f0-9]{48}$/.test(nonce) ||
          typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) reject();
      const now = clock();
      if (Math.abs(now - Number(timestamp)) > WINDOW_MS) reject();
      let valid = false;
      try { valid = verify(null, envelope(body, timestamp, nonce), key, Buffer.from(signature, 'base64url')); } catch {}
      if (!valid) reject();
      for (const [id, expiry] of nonces) if (expiry < now) nonces.delete(id);
      // Do not evict an unexpired nonce: that would make an old signed request replayable.
      if (nonces.has(nonce) || nonces.size >= maximumNonces) reject();
      nonces.set(nonce, Number(timestamp) + WINDOW_MS);
      return true;
    },
  };
}
