import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {assertDshBundleBuildReady,readDshBuildStatuses} from './plugin-management-builds.mjs';

const fail = code => { throw Object.assign(new Error(code), {code}); };
const flatten = rows => rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])]);

/** Fixed Profile changes, using public SDK writer locks and composition helpers; never private manager methods. */
export function createDshProfileControls(ctx, {sdk, targetId, generation, revision,
  isProtectedPlugin = () => false, isProtectedBundle = () => false, isBusy = () => false} = {}) {
  const profile = ctx.get('profileContext');
  function check(input) {
    if (input.targetId !== targetId || input.generation !== generation) fail('DSH_PLUGIN_TARGET_CHANGED');
    if (isBusy()) fail('DSH_PLUGIN_BUSY');
    if (revision() !== input.expectedRevision) fail('DSH_PLUGIN_CONFLICT');
  }
  function manager() {
    const manager = ctx.get('pluginManager');
    if (!manager || !profile) fail('DSH_PLUGIN_UNSUPPORTED');
    return manager;
  }
  async function locked(input, action) {
    check(input);
    // SUNA's generated base explicitly disables HMR. Do not silently adopt another Host's reload policy.
    if (ctx.get('hmr')) fail('DSH_PLUGIN_UNSUPPORTED');
    return sdk.withFileLock(path.join(profile.dir, 'package.json'), async () => {
      check(input);
      return action(manager());
    });
  }
  async function writeAndValidate(filename, before, after) {
    if (before === after) return false;
    await sdk.writeFileAtomic(filename, after, {mode: 0o600});
    try {
      // Same public composition validation used for startup-only Profile changes. No live reload is implied.
      sdk.composeEntries([sdk.readProfilePatches('dsh', profile)]);
    } catch {
      try { await sdk.writeFileAtomic(filename, before, {mode: 0o600}); }
      catch { fail('DSH_PLUGIN_OPERATION_UNKNOWN'); }
      fail('DSH_PLUGIN_PROFILE_INVALID');
    }
    return true;
  }
  return {
    pluginEnabled(input) {
      return locked(input, async manager => {
        const row = (await manager.listPlugins()).find(row => row.entryId === input.entryId);
        if (!row) fail('DSH_PLUGIN_TARGET_CHANGED');
        if (row.readOnlyReason || isProtectedPlugin(row)) fail('DSH_PLUGIN_PROTECTED');
        if (input.enabled) {
          const builds = await readDshBuildStatuses(profile.dir);
          if (Object.keys(builds).length) for (const bundle of await manager.listBundles()) {
            if (builds[bundle.name]?.required && ((bundle.rows ?? []).some(item => item.entryId === row.entryId || item.rowId === row.patchId || item.moduleName === row.moduleName) || row.moduleName === bundle.name || row.moduleName.startsWith(bundle.name + '/'))) fail('DSH_PLUGIN_BUILD_APPROVAL_REQUIRED');
          }
        }
        const before = await readFile(profile.patchPath, 'utf8');
        const document = sdk.parseDocument(before, {customTags: [{tag: 'tag:yaml.org,2002:js', resolve: value => value}]});
        if (document.errors.length || !sdk.isSeq(document.contents)) fail('DSH_PLUGIN_PROFILE_INVALID');
        const target = document.contents.items.findLast((node, index) => sdk.isMap(node) &&
          document.getIn([index, 'id']) === row.patchId && !node.has('insert') &&
          (!node.has('name') || document.getIn([index, 'name']) === row.moduleName));
        if (target) target.set('disabled', !input.enabled);
        else document.add({id: row.patchId, name: row.moduleName, disabled: !input.enabled});
        const changed = await writeAndValidate(profile.patchPath, before, String(document));
        const composed = flatten(sdk.composeEntries([sdk.readProfilePatches('dsh', profile)]));
        const desired = composed.find(candidate => candidate.id === row.patchId);
        const overridden = desired && typeof desired.disabled === 'boolean' && desired.disabled !== !input.enabled;
        return {application: overridden ? 'overridden' : 'restart-required',
          ...(!overridden ? {restartReason: 'no-hmr'} : {}), target: input.entryId, changed};
      });
    },
    bundleEnabled(input) {
      return locked(input, async manager => {
        const bundle = (await manager.listBundles()).find(row => row.name === input.name);
        if (!bundle) fail('DSH_PLUGIN_TARGET_CHANGED');
        if (bundle.readOnlyReason || isProtectedBundle(bundle) || input.enabled && bundle.error) fail('DSH_PLUGIN_PROTECTED');
        if (input.enabled) await assertDshBundleBuildReady(profile.dir, input.name);
        const filename = path.join(profile.dir, 'package.json');
        const before = await readFile(filename, 'utf8');
        const manifest = JSON.parse(before);
        const bundles = manifest.dsh?.profile?.bundles;
        if (!Array.isArray(bundles)) fail('DSH_PLUGIN_PROFILE_INVALID');
        const selected = bundles.filter(name => name !== input.name);
        if (input.enabled) selected.push(input.name);
        manifest.dsh.profile.bundles = selected;
        const changed = await writeAndValidate(filename, before, JSON.stringify(manifest, null, 2) + '\n');
        return {application: 'restart-required', restartReason: 'no-hmr', target: input.name, changed};
      });
    },
  };
}
