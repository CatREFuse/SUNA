import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const events = ['show', 'focus', 'restore', 'resize', 'resized', 'leave-full-screen', 'leave-html-full-screen'];
export function normalizeNativeControlLayout(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['railWidth', 'scale', 'gap', 'centerY'].includes(key))) throw new TypeError('Invalid native control layout');
  const layout = { railWidth: 64, scale: .8, gap: 5, centerY: 22, ...options };
  for (const [key, min, max] of [['railWidth', 44, 128], ['scale', .5, 1], ['gap', 0, 12], ['centerY', 8, 44]]) if (!Number.isFinite(layout[key]) || layout[key] < min || layout[key] > max) throw new TypeError('Invalid native control layout');
  return Object.freeze(layout);
}
/** Main-process only. No renderer IPC or caller-provided native pointers.
 * Reuses AppKit's original standard buttons, target/actions and drawing bounds;
 * native frames shrink to 0.8 and the 43.6pt group centers in the 64pt rail.
 * Only the calling window is changed; system sharing indicators are untouched.
 * Build the Node-API binary before packaging; end users never compile it.
 */
export function createNativeWindowControlsInstaller({ platform = process.platform, arch = process.arch, loadAddon = file => require(file) } = {}) {
  const installed = new WeakMap(); let addon;
  return function install(window, options = {}) {
    const layout = normalizeNativeControlLayout(options);
    const unavailable = reason => Object.freeze({ available: false, reason, apply: () => ({ available: false, reason }), inspect: () => ({ available: false, reason }), dispose() {} });
    if (platform !== 'darwin') return unavailable('UNSUPPORTED_PLATFORM');
    if (!['arm64', 'x64'].includes(arch)) return unavailable('UNSUPPORTED_ARCH');
    if (!window || typeof window.getNativeWindowHandle !== 'function' || typeof window.isDestroyed !== 'function' || typeof window.on !== 'function' || typeof window.removeListener !== 'function') throw new TypeError('Expected BrowserWindow');
    if (window.isDestroyed()) return unavailable('WINDOW_DESTROYED');
    if (Number(process.versions.napi ?? 0) < 8) return unavailable('NODE_API_UNSUPPORTED');
    try { addon ??= loadAddon(fileURLToPath(new URL(`./native-window-controls-darwin-${arch}.node`, import.meta.url))); }
    catch { return unavailable('NATIVE_ADDON_UNAVAILABLE'); }
    installed.get(window)?.dispose();
    let disposed = false, applying = false, immediate, delayed;
    const inspect = () => disposed || window.isDestroyed() ? { available: false, reason: 'WINDOW_DESTROYED' } : { available: true, ...addon.inspect(window.getNativeWindowHandle()) };
    function apply() {
      if (disposed || window.isDestroyed()) return { available: false, reason: 'WINDOW_DESTROYED' };
      if (applying) return { available: true, pending: true };
      applying = true; try { return { available: true, ...addon.apply(window.getNativeWindowHandle(), layout) }; } finally { applying = false; }
    }
    function reapply() {
      clearImmediate(immediate); clearTimeout(delayed);
      // AppKit may position native buttons after Electron emits resize. Retry
      // after that layout without global swizzling or retaining stale pointers.
      immediate = setImmediate(() => { try { apply(); } catch {} });
      delayed = setTimeout(() => { try { apply(); } catch {} }, 32); delayed.unref?.();
    }
    function dispose() {
      if (disposed) return; disposed = true; clearImmediate(immediate); clearTimeout(delayed);
      for (const event of events) window.removeListener(event, reapply); window.removeListener('closed', dispose);
      if (installed.get(window) === controller) installed.delete(window);
      if (!window.isDestroyed()) try { addon.restore(window.getNativeWindowHandle()); } catch {}
    }
    const controller = Object.freeze({ available: true, apply, inspect, dispose });
    try { apply(); } catch { dispose(); return unavailable('NATIVE_CONTROLS_UNAVAILABLE'); }
    for (const event of events) window.on(event, reapply); window.on('closed', dispose); installed.set(window, controller);
    return controller;
  };
}
export const installNativeWindowControls = createNativeWindowControlsInstaller();
