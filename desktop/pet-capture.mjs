import { BrowserWindow, nativeImage } from 'electron';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
/** Captures only PetRenderer-owned canvases. Never uses desktopCapturer/capturePage. */
export function createPetCaptureHost({ rendererUrl, readCharacter, existingPet, secure, contract }) {
  const { petIdentity, MAX_CAPTURE_BYTES, MAX_CAPTURE_SIDE } = contract;
  const tasks = new Map(), hiddenWindows = new Set(); let closed = false, tail = Promise.resolve();
  const check = signal => { if (closed || signal?.aborted) fail('RUN_CANCELLED', '角色截图已取消'); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function capture({ characterId, pet }, signal) {
    check(signal);
    if (typeof characterId !== 'string' || !characterId || characterId.length > 200 || !['frames', 'live2d', 'vrm'].includes(pet?.type) || typeof pet.url !== 'string' || !pet.url.startsWith('/assets-local/')) fail('SELFIE_UNAVAILABLE', '当前角色没有可用的本地形象');
    const identity = petIdentity(pet);
    const verify = async () => { check(signal); const current = await readCharacter(characterId); if (!current?.pet || petIdentity(current.pet) !== identity) fail('SELFIE_ASSET_CHANGED', '角色当前形象已改变，请重新获取'); };
    await verify();
    const existing = existingPet(characterId); let window = existing?.isDestroyed() ? undefined : existing, owned = false;
    const abort = () => { if (owned && window && !window.isDestroyed()) window.destroy(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      check(signal);
      if (!window) {
        window = new BrowserWindow({ title: '沙之书角色渲染', width: 512, height: 640, show: false, frame: false, transparent: true, skipTaskbar: true, backgroundColor: '#00000000', webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
        owned = true; hiddenWindows.add(window); secure(window, new URL(rendererUrl()).origin);
        const url = new URL(rendererUrl()); url.search = ''; url.hash = ''; url.searchParams.set('pet', ''); url.searchParams.set('character', characterId); url.searchParams.set('capture', '1');
        await window.loadURL(url.href);
      }
      const deadline = Date.now() + 35000;
      while (Date.now() < deadline) {
        check(signal); if (window.isDestroyed()) fail('SELFIE_CAPTURE_FAILED', '角色渲染窗口已关闭');
        const status = await window.webContents.executeJavaScript('({state:document.querySelector(".pet-renderer")?.dataset.renderState,error:document.querySelector(".pet-render-message[role=alert]")?.textContent,capture:typeof window.__sandbookCapturePet})');
        if (status.state === 'error') fail('SELFIE_CAPTURE_FAILED', status.error || '角色形象渲染失败');
        if (status.state === 'ready' && status.capture === 'function') break;
        await pause(50);
      }
      check(signal);
      const result = await window.webContents.executeJavaScript('window.__sandbookCapturePet()');
      if (result?.source?.characterId !== characterId || result.source.assetIdentity !== identity || result.source.assetUrl !== pet.url || result.source.assetType !== pet.type) fail('SELFIE_SOURCE_MISMATCH', '角色截图来源与当前形象不一致');
      if (result.mime !== 'image/png' || typeof result.data !== 'string' || result.data.length > Math.ceil(MAX_CAPTURE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.data)) fail('SELFIE_CAPTURE_INVALID', '角色截图数据无效');
      const bytes = Buffer.from(result.data, 'base64'), image = nativeImage.createFromBuffer(bytes), size = image.getSize();
      if (!bytes.length || bytes.length > MAX_CAPTURE_BYTES || bytes.toString('base64') !== result.data || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || image.isEmpty() || size.width !== result.width || size.height !== result.height || Math.max(size.width, size.height) > MAX_CAPTURE_SIDE) fail('SELFIE_CAPTURE_INVALID', '角色截图尺寸或格式无效');
      const bitmap = image.toBitmap(); let visible = false; for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i]) { visible = true; break; }
      if (!visible) fail('SELFIE_CAPTURE_EMPTY', '角色画布没有可见像素');
      await verify(); check(signal); return result;
    } catch (error) { check(signal); throw error; }
    finally { signal?.removeEventListener('abort', abort); if (owned && window) { hiddenWindows.delete(window); if (!window.isDestroyed()) window.destroy(); } }
  }
  function handle(message, reply) {
    if (message?.type === 'pet-capture-cancel') { tasks.get(message.id)?.abort(); return; }
    if (message?.type !== 'pet-capture' || typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id) || tasks.has(message.id)) return;
    if (closed || tasks.size >= 4) { reply({ type: 'pet-capture-result', id: message.id, ok: false, error: { code: 'SELFIE_BUSY', message: '角色截图服务暂不可用' } }); return; }
    const controller = new AbortController(); tasks.set(message.id, controller);
    const task = tail.catch(() => {}).then(() => capture(message, controller.signal)); tail = task.catch(() => {});
    void task.then(result => reply({ type: 'pet-capture-result', id: message.id, ok: true, result }), error => reply({ type: 'pet-capture-result', id: message.id, ok: false, error: { code: error.code || 'SELFIE_CAPTURE_FAILED', message: String(error.message || '角色画布捕获失败').slice(0, 500) } })).finally(() => tasks.delete(message.id)).catch(() => {});
  }
  async function close() { closed = true; for (const controller of tasks.values()) controller.abort(); for (const window of hiddenWindows) if (!window.isDestroyed()) window.destroy(); await tail; }
  return { handle, capture, close };
}
