import {createDshPluginManagement, MANAGEMENT_PATH} from './plugin-management.mjs';
import {loadDshManagementSdk} from './plugin-management-sdk.mjs';
import {managementFailure, safeDshManagementError} from './plugin-management-errors.mjs';

/** Optional Host-only service composition. No agent tool or remote Cordis method is registered. */
export function installDshPluginManagement(ctx, config, {runtimeVersion, bridgeVersion, isBusy = () => false} = {}) {
  let endpoint, closed = false, dispatching = 0;
  const initializations = new Set();
  const busy = () => dispatching > 0 || !!endpoint?.busy();
  if (config) ctx.inject(['loader', 'profileContext', 'pluginManager', 'configEditor'], scope => {
    let disposed = false, owned;
    scope.on('dispose', async () => {
      disposed = true;
      if (endpoint === owned) endpoint = undefined;
      await owned?.close();
    });
    const task = (async () => {
      const sdk = await loadDshManagementSdk(config);
      if (closed || disposed) return;
      owned = await createDshPluginManagement(scope, {...config, sdk, runtimeVersion, bridgeVersion,
        isBusy: () => closed || disposed || isBusy()});
      if (closed || disposed) { await owned?.close(); return; }
      endpoint = owned;
    })();
    initializations.add(task);
    void task.finally(() => initializations.delete(task)).catch(() => {});
    return task;
  });
  return {
    health() {
      return endpoint && !closed ? {pluginManagementGeneration: endpoint.generation,
        pluginManagementTargetId: endpoint.targetId, capabilities: [endpoint.capability]} : {capabilities: []};
    },
    busy,
    async waitForIdle(signal) {
      while (busy()) {
        signal.throwIfAborted();
        if (closed) throw managementFailure('DSH_PLUGIN_DISCONNECTED');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      signal.throwIfAborted();
      if (closed) throw managementFailure('DSH_PLUGIN_DISCONNECTED');
    },
    async handle(req, res, url) {
      if (url.pathname !== MANAGEMENT_PATH) return false;
      try {
        if (req.method !== 'POST') throw managementFailure('DSH_PLUGIN_METHOD_UNSUPPORTED');
        const selected = endpoint;
        if (!selected || closed) throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
        let bytes = 0;
        const chunks = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 256 * 1024) throw managementFailure('DSH_PLUGIN_INPUT_INVALID');
          chunks.push(chunk);
        }
        if (endpoint !== selected || closed) throw managementFailure('DSH_PLUGIN_TARGET_CHANGED');
        dispatching++;
        let value;
        try { value = await selected.handle({method: req.method, pathname: url.pathname,
          headers: req.headers, body: Buffer.concat(chunks).toString('utf8')}); }
        finally { dispatching--; }
        res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
        res.end(JSON.stringify(value));
      } catch (error) {
        const safe = safeDshManagementError(error);
        const status = safe.code === 'DSH_PLUGIN_NATIVE_REQUIRED' ? 403 :
          ['DSH_PLUGIN_BUSY', 'DSH_PLUGIN_CONFLICT', 'DSH_PLUGIN_TARGET_CHANGED'].includes(safe.code) ? 409 : 400;
        if (!res.headersSent) res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
        res.end(JSON.stringify({error: safe.message, code: safe.code}));
      }
      return true;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...initializations]);
      const owned = endpoint; endpoint = undefined;
      await owned?.close();
    },
  };
}
