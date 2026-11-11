import {readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {readPluginUI} from './ui-package.mjs';
import {parseDshPluginManagement} from '../../plugins/suna-dsh/plugin-management-contract.mjs';
import {managementFailure, safeDshManagementError} from '../../plugins/suna-dsh/plugin-management-errors.mjs';

export const DSH_CLIENT_PLUGIN_ID = 'suna-dsh-plugins';

/** A bundled Client plugin has no Node worker, role tools, credential config or executable import. */
export async function createDshClientPlugin({projectRoot, runtime}) {
  const plugins = new Map();
  let directory;
  try { directory = await realpath(path.join(projectRoot, 'plugins/dsh-plugins')); }
  catch (error) { if (error.code === 'ENOENT') return {plugins, listPlugins: () => []}; throw error; }
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.id !== DSH_CLIENT_PLUGIN_ID || manifest.kind !== 'client' || manifest.apiVersion !== 1 ||
      manifest.name !== 'DSH 插件' || !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
      JSON.stringify(manifest.capabilities) !== JSON.stringify(['dsh.plugins.manage']) ||
      JSON.stringify(manifest.configSchema) !== '{}' || JSON.stringify(manifest.ui) !== '{"entry":"ui.html"}' ||
      Object.keys(manifest.files ?? {}).join() !== 'ui.html' ||
      Object.keys(manifest).some(key => !['id', 'name', 'kind', 'apiVersion', 'version', 'description', 'capabilities', 'configSchema', 'ui', 'files'].includes(key))) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
  const record = {directory, manifest};
  await readPluginUI(record);
  plugins.set(manifest.id, record);
  return {
    plugins,
    listPlugins: () => [{...manifest, status: 'installed', config: {}, hasSecrets: []}],
    async rpc(id, raw) {
      if (id !== DSH_CLIENT_PLUGIN_ID || !plugins.has(id)) throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
      const input = parseDshPluginManagement(raw);
      if (typeof runtime.manageDshPlugins !== 'function') {
        if (input.method === 'context' || input.method === 'dsh.snapshot') return {protocolVersion: 1,
          status: 'unsupported', reason: 'DSH_PLUGIN_UNSUPPORTED', targetId: 'unsupported', generation: null,
          revision: '', canManage: false, plugins: [], bundles: [], operations: []};
        throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
      }
      try { return await runtime.manageDshPlugins(input); }
      catch (error) { throw managementFailure(safeDshManagementError(error).code); }
    },
  };
}
