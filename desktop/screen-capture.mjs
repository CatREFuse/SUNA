// Main-process adapter; imports no Electron, file, logging or networking APIs.
// Electron references (checked against the official API documentation):
// https://www.electronjs.org/docs/latest/api/desktop-capturer
// https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source
// https://www.electronjs.org/docs/latest/api/native-image
// https://www.electronjs.org/docs/latest/api/system-preferences#getmediaaccessstatusmediatype-windows-macos
export const MAX_SCREEN_CAPTURE_SIDE = 4096;
export const MAX_SCREEN_CAPTURE_BYTES = 8 * 1024 * 1024;
export const MAX_SCREEN_CAPTURE_TOTAL_BYTES = 24 * 1024 * 1024;
export const MAX_SCREEN_CAPTURE_IMAGES = 16;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const FIELDS = ['runId', 'characterId', 'conversationId', 'triggerId', 'provider', 'model'];
const hostErrors = new WeakSet();
const failure = (code, reason, message) => { const value = Object.assign(new Error(message), { code, reason }); hostErrors.add(value); return value; };
const unavailable = (reason, message = '当前无法读取全部屏幕画面') => failure('capture.unavailable', reason, message);
const cancelled = reason => failure('run.cancelled', reason, '本次屏幕读取已取消或结束');
const text = value => typeof value === 'string' && value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
function bindingFor(input) {
  if (!input || input.permissionGranted !== true) throw failure('permission.denied', 'permission.required', '当前任务尚未通过工具权限校验');
  if (!FIELDS.every(field => text(input[field]))) throw unavailable('context.invalid', '屏幕读取缺少完整的本轮身份或模型描述');
  if (!Number.isSafeInteger(input.grantRevision) || input.grantRevision < 0) throw failure('permission.denied', 'grant.invalid', '本次屏幕读取缺少明确的授权版本');
  return Object.freeze({ permissionGranted: true, ...Object.fromEntries(FIELDS.map(field => [field, input[field]])), grantRevision: input.grantRevision });
}
const pairKey = ({ characterId, conversationId }) => JSON.stringify([characterId, conversationId]);
function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw signal.reason; return operation(); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}
function displayValue(value) {
  const { id, bounds, scaleFactor = 1, rotation = 0 } = value ?? {};
  if ((!Number.isSafeInteger(id) && !text(id)) || String(id) === '-1' || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height, scaleFactor, rotation].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || scaleFactor <= 0) throw unavailable('display.unavailable');
  const width = Math.round(bounds.width * scaleFactor), height = Math.round(bounds.height * scaleFactor);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw unavailable('display.unavailable');
  return { id: String(id), width, height, scaleFactor, identity: JSON.stringify([String(id), bounds.x, bounds.y, bounds.width, bounds.height, scaleFactor, rotation]) };
}
function displaysFor(screen) {
  let primary, values;
  try { primary = displayValue(screen.getPrimaryDisplay()); values = screen.getAllDisplays(); } catch (error) { throw hostErrors.has(error) ? error : unavailable('display.unavailable'); }
  if (!Array.isArray(values) || !values.length) throw unavailable('display.unavailable', '没有可读取的显示器');
  if (values.length > MAX_SCREEN_CAPTURE_IMAGES) throw unavailable('image.too_large', '显示器超过 16 个，未返回部分屏幕画面');
  const displays = values.map(displayValue), ids = new Set(displays.map(display => display.id));
  if (ids.size !== displays.length) throw unavailable('display.unavailable', '显示器标识不唯一，未返回屏幕画面');
  const exact = displays.find(display => display.id === primary.id);
  if (!exact || exact.identity !== primary.identity) throw unavailable('display.changed', '显示器列表与主显示器信息不一致，请重新截图');
  displays.sort((left, right) => left.id === primary.id ? -1 : right.id === primary.id ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return { displays, identity: JSON.stringify([primary.id, ...displays.map(display => display.identity)]) };
}
function imageSize(image) {
  if (!image || typeof image.isEmpty !== 'function' || image.isEmpty() || typeof image.getSize !== 'function') throw unavailable('image.empty');
  const size = image.getSize(1);
  if (!Number.isSafeInteger(size?.width) || !Number.isSafeInteger(size?.height) || size.width < 1 || size.height < 1) throw unavailable('image.invalid');
  return { width: size.width, height: size.height };
}
function sameAspect(size, reference) {
  // Permit only integer rounding (at most two pixels), never a crop/stretch.
  return Math.abs(size.width * reference.height - size.height * reference.width) <= 2 * Math.max(reference.width, reference.height);
}
function encodedSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw unavailable('image.encoding_invalid');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
function resize(image, target) {
  if (typeof image.resize !== 'function') throw unavailable('image.resize_unavailable');
  const current = imageSize(image);
  return image.resize({ [current.width >= current.height ? 'width' : 'height']: target, quality: 'best' });
}
function encode(image, display, check) {
  const original = imageSize(image);
  if (!sameAspect(original, display)) throw unavailable('image.aspect_mismatch', '屏幕画面比例不符，未返回可能裁剪的图片');
  if (Math.max(original.width, original.height) > MAX_SCREEN_CAPTURE_SIDE) image = resize(image, MAX_SCREEN_CAPTURE_SIDE);
  for (let attempt = 0; attempt < 9; attempt++) {
    check(); const size = imageSize(image);
    if (Math.max(size.width, size.height) > MAX_SCREEN_CAPTURE_SIDE || !sameAspect(size, original) || !sameAspect(size, display)) throw unavailable('image.resize_invalid');
    if (typeof image.toPNG !== 'function') throw unavailable('image.encoding_unavailable');
    const bytes = image.toPNG({ scaleFactor: 1 });
    try {
      const encoded = encodedSize(bytes);
      if (encoded.width !== size.width || encoded.height !== size.height) throw unavailable('image.encoding_mismatch');
      if (bytes.length <= MAX_SCREEN_CAPTURE_BYTES) return { bytes, ...size, original };
    } catch (error) { if (Buffer.isBuffer(bytes)) bytes.fill(0); throw error; }
    bytes.fill(0);
    const target = Math.floor(Math.max(size.width, size.height) * 0.75);
    if (target < 64 || attempt === 8) throw unavailable('image.too_large', '完整屏幕图像超过 8 MiB，未返回图片');
    image = resize(image, target);
  }
}

/**
 * createScreenCaptureHost({desktopCapturer,screen,systemPreferences,authorize,timeoutMs?,maxTrackedRuns?})
 * capture({permissionGranted:true,runId,characterId,conversationId,triggerId,provider,model,grantRevision,signal?})
 *   -> {images:[{mime:'image/png',data:base64,width,height,capturedAt,displayId,grantRevision,source}],grantRevision,capturedAt}
 * All displays are captured atomically: primary first, then stable display ID order. A missing,
 * ambiguous, changed or failed display rejects the whole batch. Limits: 16 images, 8 MiB each,
 * 24 MiB total. Calls sharing one Run are serialized; distinct Runs remain independent.
 * authorize({phase:'before'|'after',binding,signal}) -> {allowed:boolean,revision:nonnegative integer}
 *   reads the CURRENT persistent role/conversation grant; it must not display a per-run dialog.
 *   The binding is frozen and contains only the whitelisted trusted fields above.
 * releaseRun(runId) tombstones that run; revoke({characterId,conversationId}) aborts its pair's runs.
 * Neither changes the persistent grant store. Every capture checks the grant before/after capture;
 * a revision change cannot silently expand an existing run. No images or grants are cached on disk.
 * close() rejects pending callers, drops state and returns one shared completion Promise.
 * Electron getSources itself has no AbortSignal: late native results are discarded without encoding.
 */
export function createScreenCaptureHost({ desktopCapturer, screen, systemPreferences, authorize, timeoutMs = 45000, maxTrackedRuns = 16384, clock = () => new Date().toISOString() } = {}) {
  if (typeof desktopCapturer?.getSources !== 'function' || typeof screen?.getPrimaryDisplay !== 'function' || typeof screen?.getAllDisplays !== 'function' || typeof systemPreferences?.getMediaAccessStatus !== 'function' || typeof authorize !== 'function' || typeof clock !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxTrackedRuns) || maxTrackedRuns < 1) throw new TypeError('Screen capture requires trusted host dependencies');
  const runs = new Map(), pending = new Set(); let closed = false, closeTask;
  const check = entry => { if (closed) throw failure('tool.disabled', 'host.closed', '屏幕读取服务已关闭'); if (entry.controller.signal.aborted) throw entry.controller.signal.reason; };
  function stop(entry, reason) { if (!entry.controller.signal.aborted) entry.controller.abort(reason); }
  function systemPermission() {
    let status; try { status = systemPreferences.getMediaAccessStatus('screen'); } catch { throw unavailable('system.permission_unavailable', '系统屏幕读取权限状态不可用'); }
    if (status === 'denied' || status === 'restricted') throw failure('permission.denied', 'system.permission_denied', '系统未允许屏幕读取，请检查屏幕录制权限');
    if (status !== 'granted') throw unavailable('system.permission_required', '尚未取得系统屏幕录制权限');
  }
  async function grant(entry, phase) {
    check(entry);
    const result = await abortable(() => authorize({ phase, binding: entry.binding, signal: entry.controller.signal }), entry.controller.signal);
    check(entry);
    if (!result || result.allowed !== true || !Number.isSafeInteger(result.revision) || result.revision < 0) throw failure('permission.denied', 'grant.missing', '此角色与会话尚未获得屏幕读取授权');
    if (result.revision !== entry.binding.grantRevision) throw failure('permission.denied', 'grant.changed', '屏幕读取授权已更改，请重新开始任务');
    if (entry.revision !== undefined && entry.revision !== result.revision) throw failure('permission.denied', 'grant.changed', '屏幕读取授权已更改，请重新开始任务');
    entry.revision = result.revision;
  }
  function capture(input = {}) {
    if (closed) return Promise.reject(failure('tool.disabled', 'host.closed', '屏幕读取服务已关闭'));
    let binding;
    try { binding = bindingFor(input); } catch (error) {
      if (text(input?.runId)) { let prior = runs.get(input.runId); if (!prior && runs.size < maxTrackedRuns) { prior = { controller: new AbortController() }; runs.set(input.runId, prior); } if (prior) stop(prior, error); }
      return Promise.reject(error);
    }
    const signature = JSON.stringify(binding); let entry = runs.get(binding.runId);
    if (entry?.controller.signal.aborted) return Promise.reject(entry.controller.signal.reason);
    if (entry && entry.signature !== signature) {
      const error = failure('permission.denied', 'context.changed', '本次任务的角色、会话、触发者或模型描述已改变'); stop(entry, error); return Promise.reject(error);
    }
    // Retain tombstones until close; at capacity fail closed instead of evicting old run IDs.
    if (!entry) { if (runs.size >= maxTrackedRuns) return Promise.reject(unavailable('host.capacity')); entry = { binding, signature, pair: pairKey(binding), controller: new AbortController(), revision: undefined }; runs.set(binding.runId, entry); }
    const current = entry, signal = input.signal, abort = () => stop(current, cancelled('caller.cancelled'));
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) { const error = unavailable('context.invalid_signal'); stop(current, error); return Promise.reject(error); }
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(current, cancelled('capture.timeout')), timeoutMs);
    const collect = async () => {
      check(current); await grant(current, 'before'); systemPermission(); check(current);
      const snapshot = displaysFor(screen);
      const sizes = snapshot.displays.map(display => { const factor = Math.min(1, MAX_SCREEN_CAPTURE_SIDE / Math.max(display.width, display.height)); return { width: Math.max(1, Math.round(display.width * factor)), height: Math.max(1, Math.round(display.height * factor)) }; });
      const sources = await abortable(() => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.max(...sizes.map(size => size.width)), height: Math.max(...sizes.map(size => size.height)) }, fetchWindowIcons: false }), current.controller.signal);
      check(current); systemPermission();
      if (displaysFor(screen).identity !== snapshot.identity) throw unavailable('display.changed', '显示器连接、主屏或尺寸已改变，请重新截图');
      // Validate every ID before encoding any screen. Never guess from names or source order.
      const matches = snapshot.displays.map(display => {
        const found = Array.isArray(sources) ? sources.filter(source => typeof source?.id === 'string' && source.id.startsWith('screen:') && source.display_id === display.id) : [];
        if (found.length !== 1) throw unavailable(found.length ? 'source.ambiguous' : 'source.not_found', '无法精确识别全部显示器，未返回部分屏幕画面');
        return found[0];
      });
      const capturedAt = clock(); if (typeof capturedAt !== 'string' || capturedAt.length > 64 || !Number.isFinite(Date.parse(capturedAt))) throw unavailable('image.invalid');
      const encoded = []; let total = 0;
      try {
        for (const [index, display] of snapshot.displays.entries()) {
          const image = encode(matches[index].thumbnail, display, () => check(current)); encoded.push(image); total += image.bytes.length;
          if (total > MAX_SCREEN_CAPTURE_TOTAL_BYTES) throw unavailable('image.too_large', '全部屏幕图像合计超过 24 MiB，未返回部分屏幕画面');
        }
        await grant(current, 'after'); systemPermission(); check(current);
        if (displaysFor(screen).identity !== snapshot.identity) throw unavailable('display.changed', '显示器连接、主屏或尺寸已改变，请重新截图');
        const images = encoded.map((image, index) => { const display = snapshot.displays[index]; return {
          mime: 'image/png', data: image.bytes.toString('base64'), width: image.width, height: image.height, capturedAt,
          displayId: display.id, grantRevision: current.revision, source: { fullDisplay: true, displayWidth: display.width, displayHeight: display.height, scaleFactor: display.scaleFactor,
            thumbnailWidth: image.original.width, thumbnailHeight: image.original.height, downscaled: image.width !== image.original.width || image.height !== image.original.height || image.width < display.width || image.height < display.height }
        }; });
        return { images, grantRevision: current.revision, capturedAt };
      } finally { for (const image of encoded) image.bytes.fill(0); }
    };
    const previous = current.captureTail ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => { check(current); return collect(); });
    current.captureTail = operation.then(() => undefined, () => undefined);
    const task = abortable(() => operation, current.controller.signal).catch(error => {
      const safe = hostErrors.has(error) ? error : unavailable('host.failed', '读取全部屏幕画面失败');
      stop(current, safe); throw safe;
    }).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(task); });
    pending.add(task); return task;
  }
  function releaseRun(runId) {
    if (!text(runId)) throw unavailable('context.invalid');
    if (closed) return;
    let entry = runs.get(runId);
    if (!entry && runs.size < maxTrackedRuns) { entry = { controller: new AbortController() }; runs.set(runId, entry); }
    if (entry) stop(entry, cancelled('run.released'));
    // A full registry already rejects every unknown run; no eviction can reopen this run.
  }
  function revoke(binding) {
    if (!text(binding?.characterId) || !text(binding?.conversationId)) throw unavailable('context.invalid');
    const pair = pairKey(binding);
    for (const entry of runs.values()) if (entry.pair === pair) stop(entry, failure('permission.denied', 'grant.revoked', '此角色与会话的屏幕读取授权已撤回'));
  }
  function close() {
    if (closeTask) return closeTask; closed = true;
    for (const entry of runs.values()) stop(entry, failure('tool.disabled', 'host.closed', '屏幕读取服务已关闭'));
    closeTask = Promise.allSettled([...pending]).then(() => { runs.clear(); }); return closeTask;
  }
  return { capture, releaseRun, revoke, close };
}
