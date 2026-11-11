import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readZip, sha256, validateManifest } from './archive.mjs';

const ACTIONS = new Set(['send_msg', 'send_private_msg', 'send_group_msg', 'get_status', 'get_login_info', 'get_friend_list', 'get_group_list', 'get_group_member_list', 'get_image', 'get_file', 'get_msg', 'get_forward_msg', 'delete_msg']);
function secretRedactor(config, schema = {}) {
  return value => {
    let result = String(value ?? '');
    for (const [key, secret] of Object.entries(config)) if ((schema[key]?.type === 'secret' || /secret|token|password|credential|apiKey/i.test(key)) && typeof secret === 'string' && secret) result = result.split(secret).join('[redacted]');
    return result.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
  };
}
function safeError(error, redact) { const result = new Error(redact(error instanceof Error ? error.message : error)); if (typeof error?.code === 'string') result.code = redact(error.code); if (error?.name === 'AbortError') result.name = 'AbortError'; return result; }
const identifier = value => (typeof value === 'string' && value.length > 0 && value.length < 256) || (typeof value === 'number' && Number.isSafeInteger(value));

export function normalizeOneBotEvent(event) {
  if (!event || typeof event !== 'object' || !['message', 'notice', 'request', 'meta_event'].includes(event.post_type) || !identifier(event.self_id)) throw new Error('ONEBOT_EVENT_INVALID');
  if (event.post_type === 'message') {
    if (!['private', 'group'].includes(event.message_type) || !identifier(event.message_id) || !identifier(event.user_id) ||
        (event.message_type === 'group' && !identifier(event.group_id))) throw new Error('ONEBOT_MESSAGE_INVALID');
    if (!Array.isArray(event.message) || event.message.length > 256 || event.message.some(s => !s || typeof s.type !== 'string' || !s.data || typeof s.data !== 'object')) throw new Error('ONEBOT_SEGMENTS_INVALID');
  }
  // Preserve opaque platform IDs and account scope: no coercion to lossy integers.
  return structuredClone(event);
}

export class ChannelHost extends EventEmitter {
  constructor({ pluginRoot, fetch: fetchImpl = globalThis.fetch, WebSocket: WebSocketImpl = globalThis.WebSocket, log = () => {}, onConfigUpdate = async () => {} } = {}) {
    super(); if (!pluginRoot) throw new Error('PLUGIN_ROOT_REQUIRED');
    this.pluginRoot = path.resolve(pluginRoot); this.fetch = fetchImpl; this.WebSocket = WebSocketImpl; this.log = log; this.onConfigUpdate = onConfigUpdate;
    this.connections = new Map(); this.seen = new Map(); this.plugins = new Map();
    this.closing = false; this.closePromise = null; this.pending = new Set(); this.creating = new Set(); this.lifetime = new AbortController();
  }
  assertOpen() { if (this.closing) throw new Error('CHANNEL_HOST_CLOSED'); }
  track(promise) { this.pending.add(promise); promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise)); return promise; }
  async invoke(record, method, ...args) { this.assertOpen(); try { const result = await this.track(Promise.resolve().then(() => { this.assertOpen(); return record.adapter[method](...args); })); this.assertOpen(); return result; } catch (error) { throw safeError(error, record.redact); } }
  async init() {
    this.assertOpen();
    await fs.mkdir(this.pluginRoot, { recursive: true, mode: 0o700 });
    this.pluginRoot = await fs.realpath(this.pluginRoot);
    const entries = await fs.readdir(this.pluginRoot, { withFileTypes: true });
    for (const entry of entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))) {
      try {
        const directory = path.join(this.pluginRoot, entry.name);
        const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
        const files = new Map([['manifest.json', Buffer.from(JSON.stringify(manifest))]]);
        for (const name of Object.keys(manifest.files ?? {})) {
          // Validate before path access, then reject links in every ancestor.
          if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.split('/').some(s => !s || s === '.' || s === '..') || name.startsWith('/')) throw new Error('PLUGIN_PATH_INVALID');
          const target = path.join(directory, name);
          if (await fs.realpath(target) !== target || !(await fs.lstat(target)).isFile()) throw new Error('PLUGIN_LINK_REJECTED');
          files.set(name, await fs.readFile(target));
        }
        validateManifest(manifest, files);
        const stat = await fs.stat(path.join(directory, 'manifest.json'));
        const previous = this.plugins.get(manifest.id);
        if (!previous || stat.mtimeMs > previous.installedAt) this.plugins.set(manifest.id, { manifest, directory, installedAt: stat.mtimeMs });
      } catch { this.log('channel.plugin.invalid', { directory: entry.name }); }
    }
    return this.listPlugins();
  }
  listPlugins() { return [...this.plugins.values()].map(({ manifest }) => structuredClone(manifest)); }
  async importPlugin(archivePath) {
    this.assertOpen();
    return this.track(this.installPlugin(archivePath));
  }
  async installPlugin(archivePath) {
    const stat = await fs.stat(archivePath);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('PLUGIN_ARCHIVE_SIZE');
    const bytes = await fs.readFile(archivePath), files = readZip(bytes);
    let manifest; try { manifest = JSON.parse(files.get('manifest.json')?.toString('utf8')); } catch { throw new Error('PLUGIN_MANIFEST_INVALID'); }
    validateManifest(manifest, files);
    if ([...this.connections.values()].some(c => c.pluginId === manifest.id && !['disconnected', 'error'].includes(c.status))) throw new Error('PLUGIN_IN_USE');
    await fs.mkdir(this.pluginRoot, { recursive: true, mode: 0o700 });
    const temp = await fs.mkdtemp(path.join(this.pluginRoot, '.install-'));
    const directory = path.join(this.pluginRoot, `${manifest.id}-${manifest.version}-${sha256(bytes).slice(0, 16)}`);
    try {
      for (const [name, data] of files) {
        const target = path.join(temp, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data, { mode: 0o600, flag: 'wx' });
      }
      try { await fs.rename(temp, directory); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; await fs.rm(temp, { recursive: true, force: true }); }
      this.assertOpen();
      this.plugins.set(manifest.id, { manifest, directory, installedAt: Date.now() });
      this.log('channel.plugin.installed', { pluginId: manifest.id, version: manifest.version });
      return structuredClone(manifest);
    } catch (error) { await fs.rm(temp, { recursive: true, force: true }); throw error; }
  }
  listConnections() { return [...this.connections.values()].map(c => ({ accountId: c.accountId, pluginId: c.pluginId, pluginVersion: c.pluginVersion, status: c.status, detail: c.detail })); }
  async createConnection({ pluginId, accountId = randomUUID(), config = {} }) {
    this.assertOpen();
    if (this.creating.has(accountId)) throw new Error('CHANNEL_ACCOUNT_EXISTS');
    this.creating.add(accountId);
    const redact = secretRedactor(config, this.plugins.get(pluginId)?.manifest.configSchema);
    try { return await this.track(this.makeConnection({ pluginId, accountId, config, redact })); }
    catch (error) { throw safeError(error, redact); }
    finally { this.creating.delete(accountId); }
  }
  async makeConnection({ pluginId, accountId, config, redact }) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(accountId)) throw new Error('CHANNEL_ACCOUNT_ID_INVALID');
    if (this.connections.has(accountId)) throw new Error('CHANNEL_ACCOUNT_EXISTS');
    const plugin = this.plugins.get(pluginId); if (!plugin) throw new Error('PLUGIN_NOT_INSTALLED');
    const installedManifest = await fs.readFile(path.join(plugin.directory, 'manifest.json'));
    if (installedManifest.length > 64 * 1024) throw new Error('PLUGIN_MANIFEST_INVALID');
    const files = new Map([['manifest.json', installedManifest]]);
    for (const name of Object.keys(plugin.manifest.files)) {
      const filename = path.join(plugin.directory, name), stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || await fs.realpath(filename) !== filename) throw new Error('PLUGIN_FILE_INTEGRITY');
      files.set(name, await fs.readFile(filename));
    }
    validateManifest(plugin.manifest, files);
    // Importing a package is data-only. This explicit creation is the execution boundary.
    const { createAdapter } = await import(pathToFileURL(path.join(plugin.directory, plugin.manifest.entry)).href);
    if (typeof createAdapter !== 'function') throw new Error('PLUGIN_FACTORY_MISSING');
    this.assertOpen();
    const record = { accountId, pluginId, pluginVersion: plugin.manifest.version, status: 'disconnected', detail: '', adapter: null, generation: 0, enabled: true, disposed: false, redact };
    const active = () => !this.closing && !record.disposed && record.enabled;
    const reportStatus = (status, detail = '') => { if (!active()) return; record.status = redact(status); record.detail = redact(detail); this.emit('status', { accountId, pluginId, status: record.status, detail: record.detail }); };
    record.adapter = await createAdapter({
      config: structuredClone(config), accountId, signal: this.lifetime.signal,
      fetch: (input, options = {}) => { this.assertOpen(); return this.fetch(input, { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal }); }, WebSocket: this.WebSocket, reportStatus,
      log: (event, detail = {}) => { if (!this.closing && !record.disposed) this.log(`channel.${redact(event)}`, { accountId, pluginId, detail: redact(JSON.stringify(detail)) }); },
      saveConfig: async patch => { if (!active()) return; Object.assign(config, patch); await this.track(Promise.resolve().then(() => { if (active()) return this.onConfigUpdate(accountId, patch); })); },
      emit: event => {
        if (!active()) return false;
        const normalized = normalizeOneBotEvent(event);
        if (normalized.post_type === 'message') {
          const key = JSON.stringify([accountId, normalized.self_id, normalized.message_type, normalized.group_id ?? normalized.user_id, normalized.message_id]);
          if (this.seen.has(key)) return false;
          this.seen.set(key, Date.now()); if (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value);
        }
        this.emit('event', { accountId, pluginId, event: normalized }); return true;
      }
    });
    if (this.closing) { record.disposed = true; try { await record.adapter?.stop?.(); } catch {} throw new Error('CHANNEL_HOST_CLOSED'); }
    if (!record.adapter || typeof record.adapter.start !== 'function' || typeof record.adapter.stop !== 'function' || typeof record.adapter.execute !== 'function') throw new Error('PLUGIN_INTERFACE_INVALID');
    this.connections.set(accountId, record); return { accountId, pluginId, status: record.status };
  }
  connection(accountId) { const c = this.connections.get(accountId); if (!c) throw new Error('CHANNEL_ACCOUNT_NOT_FOUND'); return c; }
  async connect(accountId) {
    this.assertOpen();
    const c = this.connection(accountId); if (['connected', 'connecting', 'waiting-webhook', 'reconnecting'].includes(c.status)) return this.listConnections().find(x => x.accountId === accountId);
    c.enabled = true; c.status = 'connecting'; const generation = ++c.generation;
    try { await this.invoke(c, 'start'); }
    catch (error) { if (generation !== c.generation) return this.listConnections().find(x => x.accountId === accountId); c.status = 'error'; c.detail = '连接失败，请检查渠道配置'; this.emit('status', { accountId, pluginId: c.pluginId, status: 'error', detail: c.detail }); throw safeError(error, c.redact); }
    return this.listConnections().find(x => x.accountId === accountId);
  }
  async disconnect(accountId) { this.assertOpen(); const c = this.connection(accountId); c.generation++; c.enabled = false; try { await this.invoke(c, 'stop'); } finally { c.status = 'disconnected'; c.detail = ''; if (!this.closing) this.emit('status', { accountId, pluginId: c.pluginId, status: c.status, detail: '' }); } }
  async removeConnection(accountId) { await this.disconnect(accountId); this.connection(accountId).disposed = true; this.connections.delete(accountId); }
  async execute(accountId, action, params = {}) {
    this.assertOpen();
    if (!ACTIONS.has(action)) throw new Error('ONEBOT_ACTION_UNSUPPORTED');
    const c = this.connection(accountId); if (!['connected', 'waiting-webhook'].includes(c.status) && !['get_status', 'get_login_info'].includes(action)) throw new Error('CHANNEL_NOT_CONNECTED');
    return this.invoke(c, 'execute', action, structuredClone(params));
  }
  async getLoginQr(accountId, options = {}) {
    this.assertOpen(); const c = this.connection(accountId); if (!c.adapter.getLoginQr) throw new Error('CHANNEL_QR_UNSUPPORTED');
    // Reading login state must not re-admit callbacks rejected by disconnect.
    // Only an explicit login refresh (or connect) starts accepting them again.
    if (options.refresh === true) c.enabled = true;
    return this.invoke(c, 'getLoginQr', options);
  }
  async pollLogin(accountId, options = {}) { this.assertOpen(); const c = this.connection(accountId); if (!c.adapter.pollLogin) throw new Error('CHANNEL_QR_UNSUPPORTED'); return this.invoke(c, 'pollLogin', options); }
  async handleWebhook(accountId, request) { this.assertOpen(); const c = this.connection(accountId); if (!c.adapter.handleWebhook) throw new Error('CHANNEL_WEBHOOK_UNSUPPORTED'); if (!['connected', 'waiting-webhook'].includes(c.status)) throw new Error('CHANNEL_NOT_CONNECTED'); return this.invoke(c, 'handleWebhook', request); }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true; this.lifetime.abort();
    for (const c of this.connections.values()) { c.enabled = false; c.disposed = true; c.generation++; }
    this.closePromise = (async () => {
      await Promise.allSettled([...this.connections.values()].map(async c => { try { await c.adapter.stop(); } finally { c.status = 'disconnected'; c.detail = ''; } }));
      // Wait for accepted work, including a factory which may finish after shutdown began.
      // Third-party JS remains trusted: an arbitrary plugin can ignore cancellation.
      while (this.pending.size) await Promise.allSettled([...this.pending]);
    })();
    return this.closePromise;
  }
}
