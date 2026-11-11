import http from 'node:http';
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const FILE_LIMIT = 8 * 1024 * 1024, MEMORY_LIMIT = 32 * 1024 * 1024;
const FILES_LIMIT = 256, PREVIEWS_LIMIT = 8;
const MAX_LIFETIME = 10 * 60 * 1000, MAX_IDLE = 5 * 60 * 1000;
const types = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}));
const sensitive = /^(?:credentials?|secrets?|client[-_]auth|auth(?:entication)?|token|password|config|id_rsa|id_ed25519)(?:[._-]|$)/i;
const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'node_modules']);
const messages = {
  PREVIEW_INVALID: '预览请求格式无效', PREVIEW_CLOSED: '预览服务已关闭',
  PREVIEW_REVOKED: '预览授权已撤回', PREVIEW_EXPIRED: '预览授权已过期',
  PREVIEW_PERMISSION_DENIED: '当前授权不允许预览', PREVIEW_PATH_INVALID: '预览目录或文件不符合安全要求',
  PREVIEW_FILE_CHANGED: '预览文件在读取期间发生变化，请重试',
  PREVIEW_LIMIT: '预览文件数量或大小超过限制', PREVIEW_FORMAT_UNSUPPORTED: '预览包含不支持的文件格式',
  PREVIEW_ENTRY_REQUIRED: '预览目录需要 index.html 或 index.htm', PREVIEW_UNAVAILABLE: '本机预览暂不可用',
};
const fail = code => Object.assign(new Error(messages[code] || messages.PREVIEW_UNAVAILABLE), { code });
const safeError = error => fail(Object.hasOwn(messages, error?.code) ? error.code : 'PREVIEW_UNAVAILABLE');
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id) && !forbidden.has(id);
const inside = (root, target) => target === root || !path.relative(root, target).startsWith('..' + path.sep) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target));
function component(value) {
  if (typeof value !== 'string' || !value || value.length > 255 || value.startsWith('.') || forbidden.has(value) || sensitive.test(value) || /[\\/%\x00-\x1f\x7f]/.test(value)) throw fail('PREVIEW_PATH_INVALID');
  return value;
}
function relativeDirectory(value) {
  if (value === '.') return [];
  if (typeof value !== 'string' || !value || value.length > 2048 || path.isAbsolute(value)) throw fail('PREVIEW_PATH_INVALID');
  return value.split('/').map(component);
}
const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-same-origin";
/** Fixed read-only OS policy, exported so boundary tests exercise the exact
 * production profile. Paths are trusted, canonical inputs from start(). */
export function workspacePreviewSandboxProfile({ root, workspaceRoot = root, nodePath, workerPath }) {
  for (const value of [root, workspaceRoot, nodePath, workerPath]) if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw fail('PREVIEW_INVALID');
  if (root === '/' || inside(root, nodePath) || inside(root, workerPath)) throw fail('PREVIEW_PATH_INVALID');
  const quote = value => JSON.stringify(value);
  const ancestors = new Set(['/']);
  for (const leaf of [root, workspaceRoot, nodePath, workerPath]) {
    let current = path.dirname(leaf); while (current !== '/') { ancestors.add(current); current = path.dirname(current); }
  }
  return ['(version 1)', '(deny default)', '(allow sysctl-read)',
    `(allow process-exec (literal ${quote(nodePath)}))`,
    `(allow file-read-metadata ${[...ancestors].map(item => `(literal ${quote(item)})`).join(' ')})`,
    // Node needs the filesystem root itself during startup; literal "/"
    // grants no child directory or file contents outside the workspace.
    `(allow file-read* ${[nodePath, workerPath, '/', '/dev/null', '/dev/urandom', '/dev/random'].map(item => `(literal ${quote(item)})`).join(' ')} (subpath ${quote(root)}) (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes") (subpath "/usr/lib"))`,
    '(allow file-write* (literal "/dev/null"))', '(deny file-link)', '(deny process-fork)', '(deny network*)'].join('\n');
}

const headers = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'content-security-policy': CSP, 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin', 'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), bluetooth=(), payment=()',
};

/**
 * An in-memory, static-only publisher; it never executes workspace code or uses
 * the Client API origin. start({workspaceRoot,directory='.',authority}) accepts a
 * trusted caller-selected workspace and authority {id,expiresAt:epochMs,signal,
 * assertCurrent():void|true}. false, thrown errors and asynchronous validators
 * deny access. Callers bind that closure to the real role/conversation/owner;
 * neither a model-supplied path nor an enabled tool is itself an authority.
 *
 * start() -> Promise<{previewId,url,expiresAt}>. The random URL is a short-lived
 * read capability, not a credential or filesystem path. Every preview has its
 * own 127.0.0.1 port and immutable snapshot. A fixed trusted Node snapshot worker
 * runs read-only under macOS Seatbelt (no network, fork, generated code or
 * outside-workspace reads); unavailable isolation fails closed. The whole service holds <=32MiB;
 * each file <=8MiB, each snapshot <=256 files. Hidden/sensitive names, links,
 * special files and unsupported MIME extensions reject the entire snapshot.
 * Prefer a clean artifact subdirectory instead of publishing a mixed workbench.
 *
 * revoke(authorityId | previewId) and close() are idempotent Promise<void>s.
 * Close/expiry/abort destroy connections, wait for pending snapshots, and clear
 * their buffers. Idle is 5min and absolute lifetime <=10min (options may only
 * reduce those durations). Already delivered browser bytes cannot be recalled.
 *
 * CSP blocks external subresources/connections; it cannot reliably constrain
 * top-level JavaScript navigation in every browser. A desktop consumer MUST
 * additionally restrict navigation, redirects and requests to this preview's
 * origin/path, using a separate sandboxed view without Node/preload/app IPC.
 */
export function createWorkspacePreviewService({ now = Date.now, idleMs = MAX_IDLE, maxLifetimeMs = MAX_LIFETIME } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > MAX_IDLE || !Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > MAX_LIFETIME) throw fail('PREVIEW_INVALID');
  const records = new Map(); let closing = false, closeTask, reservedBytes = 0;
  const time = () => { const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw fail('PREVIEW_INVALID'); return at; };
  function check(entry) {
    if (closing) throw fail('PREVIEW_CLOSED');
    if (entry.stopping || entry.controller.signal.aborted || entry.authority.signal.aborted) throw fail('PREVIEW_REVOKED');
    const at = time();
    if (at >= entry.expiresAt || entry.ready && at >= entry.lastAccess + idleMs) throw fail('PREVIEW_EXPIRED');
    let result;
    try { result = entry.authority.assertCurrent(); } catch { throw fail('PREVIEW_PERMISSION_DENIED'); }
    if (result && typeof result.then === 'function') { void Promise.resolve(result).catch(() => {}); throw fail('PREVIEW_PERMISSION_DENIED'); }
    if (result !== undefined && result !== true) throw fail('PREVIEW_PERMISSION_DENIED');
    // A validator may synchronously revoke/close the service itself.
    if (closing || entry.stopping || entry.controller.signal.aborted || entry.authority.signal.aborted) throw fail('PREVIEW_REVOKED');
    if (time() >= entry.expiresAt) throw fail('PREVIEW_EXPIRED');
  }
  async function stopServer(server) {
    if (!server) return;
    server.closeAllConnections();
    await new Promise(resolve => { try { server.close(() => resolve()); } catch { resolve(); } });
  }
  function stop(entry) {
    if (entry.stopTask) return entry.stopTask;
    entry.stopping = true; entry.controller.abort(); entry.worker?.kill('SIGKILL'); clearTimeout(entry.timer); clearTimeout(entry.absoluteTimer);
    entry.authority.signal.removeEventListener('abort', entry.onAbort);
    entry.server?.closeAllConnections();
    entry.stopTask = (async () => {
      await entry.operation?.catch(() => {});
      await stopServer(entry.server);
      for (const bytes of entry.buffers) bytes.fill(0);
      entry.buffers.clear(); entry.files.clear(); reservedBytes -= entry.reserved; entry.reserved = 0;
      records.delete(entry.previewId);
    })();
    return entry.stopTask;
  }
  function schedule(entry) {
    clearTimeout(entry.timer);
    const remaining = Math.max(1, Math.min(entry.expiresAt, entry.lastAccess + idleMs) - time());
    // Timers keep their elapsed-time deadline even if the wall clock moves back.
    entry.timer = setTimeout(() => { void stop(entry); }, remaining); entry.timer.unref();
  }
  async function snapshot(entry, workspaceRoot, parts) {
    let rootHandle, child, exited, remaining = Buffer.alloc(0), reader, workerTimer;
    try {
      check(entry);
      const original = await lstat(workspaceRoot, { bigint: true }); check(entry);
      if (!original.isDirectory() || original.isSymbolicLink()) throw fail('PREVIEW_PATH_INVALID');
      const root = await realpath(workspaceRoot);
      if (root === path.parse(root).root || process.platform !== 'darwin' || process.versions.electron || process.release.name !== 'node') throw fail('PREVIEW_UNAVAILABLE');
      rootHandle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      const rootInfo = await rootHandle.stat({ bigint: true });
      if (!same(original, rootInfo)) throw fail('PREVIEW_FILE_CHANGED');
      const nodePath = await realpath(process.execPath), workerPath = await realpath(fileURLToPath(new URL('./workspace-preview-worker.mjs', import.meta.url)));
      if (inside(root, nodePath) || inside(root, workerPath)) throw fail('PREVIEW_PATH_INVALID');
      const profile = workspacePreviewSandboxProfile({ root, workspaceRoot, nodePath, workerPath });
      check(entry);
      child = entry.worker = spawn('/usr/bin/sandbox-exec', ['-p', profile, nodePath, '--no-addons', '--disable-proto=throw', workerPath, '--suna-preview-snapshot'], {
        cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', HOME: '/var/empty', TMPDIR: '/var/empty' }, stdio: ['pipe', 'pipe', 'ignore'],
      });
      let spawnFailed = false;
      exited = new Promise(resolve => { child.once('error', () => { spawnFailed = true; }); child.once('close', code => resolve(code)); });
      child.stdin.on('error', () => {});
      const binding = Object.fromEntries(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(rootInfo[key])]));
      child.stdin.end(JSON.stringify({ root, original: workspaceRoot, parts, binding }));
      workerTimer = setTimeout(() => child.kill('SIGKILL'), Math.min(30000, Math.max(1, entry.expiresAt - time()))); workerTimer.unref();
      reader = child.stdout[Symbol.asyncIterator]();
      async function exact(size, destination, eofAllowed = false) {
        const bytes = destination ?? Buffer.alloc(size); let offset = 0;
        while (offset < size) {
          check(entry);
          if (!remaining.length) {
            const part = await reader.next(); check(entry);
            if (part.done) { if (eofAllowed && !offset) return null; throw fail('PREVIEW_UNAVAILABLE'); }
            remaining = part.value;
          }
          const amount = Math.min(size - offset, remaining.length);
          remaining.copy(bytes, offset, 0, amount); remaining.fill(0, 0, amount); remaining = remaining.subarray(amount); offset += amount;
        }
        return bytes;
      }
      let done = false;
      while (!done) {
        const length = (await exact(4)).readUInt32BE();
        if (length < 1 || length > 4096) throw fail('PREVIEW_UNAVAILABLE');
        let frame; try { frame = JSON.parse((await exact(length)).toString('utf8')); } catch { throw fail('PREVIEW_UNAVAILABLE'); }
        if (frame.type === 'error') throw safeError(frame);
        if (frame.type === 'done') { if (frame.files !== entry.files.size) throw fail('PREVIEW_UNAVAILABLE'); done = true; break; }
        if (frame.type !== 'file' || typeof frame.path !== 'string' || frame.path.length > 2048 || !Number.isSafeInteger(frame.size) || frame.size < 0) throw fail('PREVIEW_UNAVAILABLE');
        const relative = frame.path.split('/').map(component).join('/'), mime = types.get(path.extname(relative).toLowerCase());
        if (!mime || entry.files.has(relative)) throw fail('PREVIEW_PATH_INVALID');
        if (frame.size > FILE_LIMIT || entry.files.size >= FILES_LIMIT || reservedBytes + frame.size > MEMORY_LIMIT) throw fail('PREVIEW_LIMIT');
        entry.reserved += frame.size; reservedBytes += frame.size;
        const bytes = Buffer.alloc(frame.size); entry.buffers.add(bytes);
        await exact(frame.size, bytes); entry.files.set(relative, { mime, bytes });
      }
      if (await exact(1, undefined, true) !== null || await exited !== 0 || spawnFailed) throw fail('PREVIEW_UNAVAILABLE');
      const current = await lstat(workspaceRoot, { bigint: true }), after = await rootHandle.stat({ bigint: true });
      const currentRoot = await realpath(workspaceRoot); check(entry);
      if (current.isSymbolicLink() || !same(rootInfo, current) || !same(rootInfo, after) || currentRoot !== root) throw fail('PREVIEW_FILE_CHANGED');
      entry.index = entry.files.has('index.html') ? 'index.html' : entry.files.has('index.htm') ? 'index.htm' : null;
      if (!entry.index) throw fail('PREVIEW_ENTRY_REQUIRED');
    } finally {
      clearTimeout(workerTimer); remaining.fill(0);
      // A rejected header/budget can leave unread pipe data. Destroy the
      // private streams before joining, otherwise ChildProcess.close may wait
      // forever for a paused stdout iterator even after the worker is killed.
      child?.stdin.destroy(); child?.stdout.destroy();
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited; entry.worker = undefined; await rootHandle?.close();
    }
  }
  function serve(entry, req, res) {
    const error = (status, text) => { res.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) }); res.end(req.method === 'HEAD' ? undefined : text); };
    try { check(entry); } catch { error(410, 'Preview unavailable'); void stop(entry); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { error(405, 'Method not allowed'); return; }
    if (req.headers.host !== entry.host || req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1 || req.socket.remoteAddress !== '127.0.0.1') { error(403, 'Forbidden'); return; }
    if (req.headers.origin !== undefined && req.headers.origin !== entry.origin) { error(403, 'Forbidden'); return; }
    const site = req.headers['sec-fetch-site'];
    if (['cross-site', 'same-site'].includes(site) && !(req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document')) { error(403, 'Forbidden'); return; }
    let relative;
    try {
      if (typeof req.url !== 'string' || req.url.length > 4096 || !req.url.startsWith(entry.prefix) || /[\\#\x00-\x20\x7f]/.test(req.url) || /%2f|%5c/i.test(req.url)) throw 0;
      const raw = req.url.slice(entry.prefix.length).split('?')[0];
      relative = decodeURIComponent(raw);
      if (!relative) relative = entry.index;
      else {
        const trailing = relative.endsWith('/');
        const pieces = (trailing ? relative.slice(0, -1) : relative).split('/').map(component);
        relative = pieces.join('/') + (trailing ? '/index.html' : '');
      }
    } catch { error(404, 'Not found'); return; }
    const file = entry.files.get(relative);
    if (!file) { error(404, 'Not found'); return; }
    try { check(entry); } catch { error(410, 'Preview unavailable'); void stop(entry); return; }
    // No await between the final authority check and writing the fixed bytes.
    entry.lastAccess = time(); schedule(entry);
    res.writeHead(200, { ...headers, 'content-type': file.mime, 'content-length': file.bytes.length });
    res.end(req.method === 'HEAD' ? undefined : file.bytes);
  }
  function start({ workspaceRoot, directory = '.', authority } = {}) {
    let entry, parts;
    try {
      if (closing) throw fail('PREVIEW_CLOSED');
      if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) || workspaceRoot.length > 4096 || /[\x00-\x1f\x7f]/.test(workspaceRoot) || !authority || !validId(authority.id) || !Number.isSafeInteger(authority.expiresAt) || authority.expiresAt <= time() || !(authority.signal instanceof AbortSignal) || typeof authority.assertCurrent !== 'function') throw fail('PREVIEW_INVALID');
      if (records.size >= PREVIEWS_LIMIT) throw fail('PREVIEW_LIMIT');
      parts = relativeDirectory(directory);
      entry = { previewId: randomUUID(), authority: Object.freeze({ id: authority.id, expiresAt: authority.expiresAt, signal: authority.signal, assertCurrent: authority.assertCurrent }), expiresAt: Math.min(authority.expiresAt, time() + maxLifetimeMs), controller: new AbortController(), files: new Map(), buffers: new Set(), reserved: 0, entries: 0 };
      entry.prefix = '/' + randomBytes(32).toString('hex') + '/'; records.set(entry.previewId, entry);
      entry.operation = Promise.resolve().then(async () => {
        await snapshot(entry, workspaceRoot, parts); check(entry);
        const server = entry.server = http.createServer((req, res) => {
          try { serve(entry, req, res); } catch { res.destroy(); void stop(entry); }
        });
        server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 64; server.maxConnections = 16;
        server.on('clientError', (_error, socket) => socket.destroy());
        server.on('upgrade', (_req, socket) => socket.destroy());
        await new Promise((resolve, reject) => {
          const abort = () => finish(fail('PREVIEW_REVOKED'));
          const listening = () => finish(); const failed = () => finish(fail('PREVIEW_UNAVAILABLE'));
          const finish = error => { server.removeListener('error', failed); server.removeListener('listening', listening); entry.controller.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
          server.once('error', failed); server.once('listening', listening); entry.controller.signal.addEventListener('abort', abort, { once: true });
          if (entry.controller.signal.aborted) { abort(); return; }
          server.listen({ host: '127.0.0.1', port: 0, signal: entry.controller.signal });
        });
        server.on('error', () => { void stop(entry); });
        check(entry); entry.host = '127.0.0.1:' + server.address().port; entry.origin = 'http://' + entry.host;
        entry.ready = true; entry.lastAccess = time(); schedule(entry);
        return { previewId: entry.previewId, url: entry.origin + entry.prefix, expiresAt: entry.expiresAt };
      });
      entry.onAbort = () => { void stop(entry); };
      entry.absoluteTimer = setTimeout(() => { void stop(entry); }, Math.max(1, entry.expiresAt - time())); entry.absoluteTimer.unref();
      authority.signal.addEventListener('abort', entry.onAbort, { once: true }); if (authority.signal.aborted) entry.onAbort();
      return entry.operation.catch(async error => { await stop(entry); throw safeError(error); });
    } catch (error) { return Promise.reject(safeError(error)); }
  }
  function revoke(id) { return Promise.all([...records.values()].filter(entry => entry.previewId === id || entry.authority.id === id).map(stop)).then(() => {}); }
  function close() { if (closeTask) return closeTask; closing = true; closeTask = Promise.all([...records.values()].map(stop)).then(() => {}); return closeTask; }
  return { start, revoke, close };
}
