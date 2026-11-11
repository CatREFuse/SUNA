import {constants} from 'node:fs';
import {open, rm, lstat, mkdir, mkdtemp, cp, rename, realpath} from 'node:fs/promises';
import path from 'node:path';
import {managementFailure, safeDshManagementError} from './plugin-management-errors.mjs';
import {dshBundleHasPendingBuilds,writeDshBuildStatus} from './plugin-management-builds.mjs';

const restoredFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'suna-user-plugins.json', '.suna-plugin-manager/build-status.json'];
async function readOptional(filename) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    const content = await handle.readFile('utf8');
    if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    return content;
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  finally { await handle?.close(); }
}

/** Fixed install/remove transactions. Public runProfilePnpm explicitly requires this caller-owned official file lock. */
export function createDshPackageOperations(ctx, {sdk, inspections, targetId, generation, runtimeVersion, revision, packageManager,
  isProtectedBundle = () => false, isBusy = () => false} = {}) {
  const profile = ctx.get('profileContext'), installs = new Map();
  const binding = input => {
    if (input.targetId !== targetId || input.generation !== generation) throw managementFailure('DSH_PLUGIN_TARGET_CHANGED');
  };
  const check = input => {
    binding(input);
    if (isBusy()) throw managementFailure('DSH_PLUGIN_BUSY');
    if (revision() !== input.expectedRevision) throw managementFailure('DSH_PLUGIN_CONFLICT');
  };
  const options = signal => {
    const invocation = packageManager ?? profile.packageManager;
    if (!invocation) throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
    return {command: invocation.command,
      // Generic config flags are global for add/remove/install, including the official repair child.
      args: [...invocation.args, '--config.ignore-scripts=true', '--config.ignore-pnpmfile=true'],
      env: {...invocation.env, npm_config_ignore_scripts: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        npm_config_ignore_pnpmfile: 'true', NPM_CONFIG_IGNORE_PNPMFILE: 'true'},
      execution: 'service', outputBytes: 16_384, activateNewBundles: false, idleTimeoutMs: 30_000,
      ...(signal ? {signal} : {})};
  };
  const context = () => ({profile: profile.name, dir: profile.dir, installAnchor: profile.installAnchor,
    cwd: profile.cwd, home: profile.home});
  async function capture() {
    const files = new Map(await Promise.all(restoredFiles.map(async name => [name, await readOptional(path.join(profile.dir, name))])));
    const managerDirectory = path.join(await realpath(profile.dir), '.suna-plugin-manager');
    await mkdir(managerDirectory, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const managerInfo = await lstat(managerDirectory);
    if (!managerInfo.isDirectory() || managerInfo.isSymbolicLink()) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    const transactions = path.join(managerDirectory, 'transactions');
    await mkdir(transactions, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (await realpath(transactions) !== path.join(await realpath(profile.dir), '.suna-plugin-manager', 'transactions')) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
    const directory = await mkdtemp(path.join(transactions, 'package-'));
    let modules = false;
    try {
      const savedFiles = path.join(directory, 'files');
      await mkdir(savedFiles, {mode: 0o700});
      for (const [name, content] of files) if (content !== undefined) {
        await mkdir(path.dirname(path.join(savedFiles, name)), {recursive: true, mode: 0o700});
        await sdk.writeFileAtomic(path.join(savedFiles, name), content, {mode: 0o600});
      }
      await sdk.writeFileAtomic(path.join(directory, 'snapshot.json'), JSON.stringify({version: 1,
        presentFiles: [...files].filter(([, content]) => content !== undefined).map(([name]) => name)}), {mode: 0o600});
      const source = path.join(profile.dir, 'node_modules');
      const info = await lstat(source).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (info) {
        if (!info.isDirectory() || info.isSymbolicLink()) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
        await cp(source, path.join(directory, 'node_modules'), {recursive: true, dereference: false,
          verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE});
        modules = true;
      }
      return {files, directory, modules};
    } catch (error) {
      await rm(directory, {recursive: true, force: true});
      throw managementFailure(error.code === 'DSH_PLUGIN_PROFILE_INVALID' ? error.code : 'DSH_PLUGIN_PROFILE_WRITE_FAILED');
    }
  }
  async function restore(before) {
    for (const [name, content] of before.files) {
      const filename = path.join(profile.dir, name);
      if (content === undefined) await rm(filename, {force: true});
      else await sdk.writeFileAtomic(filename, content, {mode: 0o600});
    }
    // Preserve generated native files and the exact old dependency tree. A reinstall is not an exact rollback.
    const modules = path.join(profile.dir, 'node_modules');
    const rejected = path.join(before.directory, 'rejected-node_modules');
    try { await rename(modules, rejected); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before.modules) await rename(path.join(before.directory, 'node_modules'), modules);
    for (const [name, content] of before.files) if (await readOptional(path.join(profile.dir, name)) !== content) throw managementFailure('DSH_PLUGIN_OPERATION_UNKNOWN');
    await rm(rejected, {recursive: true, force: true}).catch(() => {});
  }
  async function transaction(input, action, signal) {
    check(input);
    if (!profile || ctx.get('hmr') || !ctx.get('pluginManager')) throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
    return sdk.withFileLock(path.join(profile.dir, 'package.json'), async () => {
      check(input);
      return action();
    }, {signal});
  }
  function failure(result) {
    if (result.incompatible?.length) return 'DSH_PLUGIN_INCOMPATIBLE';
    return sdk.classifyInstallFailure?.({log: result.output ?? '', timedOut: result.timedOut}) === 'build-blocked'
      ? 'DSH_PLUGIN_BUILD_APPROVAL_REQUIRED' : 'DSH_PLUGIN_PACKAGE_FAILED';
  }
  return {
    async install(input, {inspection: borrowedInspection} = {}) {
      if (installs.has(input.requestId)) throw managementFailure('DSH_PLUGIN_BUSY');
      const controller = new AbortController(), control = {controller, phase: 'preparing'};
      let inspectionLease = borrowedInspection, retainInspection = false;
      installs.set(input.requestId, control);
      try {
        // Acquire before waiting for the official writer lock. TTL cannot remove
        // the frozen archive while this admitted installation waits or executes.
        inspectionLease ??= await inspections.acquire(input);
        return await transaction(input, async () => {
          const inspection = await inspectionLease.verify();
          const manifest = JSON.parse(await readOptional(path.join(profile.dir, 'package.json')));
          if (Object.hasOwn(manifest.dependencies ?? {}, inspection.name) || isProtectedBundle({name: inspection.name})) throw managementFailure('DSH_PLUGIN_PROTECTED');
          if (controller.signal.aborted) return {application: 'cancelled', changed: false};
          const before = await capture();
          let result, keepBackup = false;
          try {
            controller.signal.throwIfAborted(); control.phase = 'running';
            result = await sdk.runProfilePnpm(context(), ['add', '--save-exact', inspection.archive], options(controller.signal));
            if (controller.signal.aborted || result.exitCode !== 0 || result.timedOut) throw managementFailure(failure(result));
            control.phase = 'validating';
            const installed = sdk.bundleManifest(inspection.name, profile.dir, profile.installAnchor);
            if (!installed?.dsh?.bundle || installed.name !== inspection.name || installed.version !== inspection.version) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
            if (sdk.evaluatePluginCompatibility(installed, {}, runtimeVersion)) throw managementFailure('DSH_PLUGIN_INCOMPATIBLE');
            const after = JSON.parse(await readOptional(path.join(profile.dir, 'package.json')));
            // Activation is always separate; package-manager defaults cannot select the installed bundle.
            if (after.dsh?.profile?.bundles?.includes(inspection.name)) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
            const buildRequired = inspection.requiresPackaging === true || await dshBundleHasPendingBuilds(profile.dir, inspection.name, sdk);
            await writeDshBuildStatus(profile.dir, inspection.name, inspection.version, buildRequired, sdk);
            controller.signal.throwIfAborted(); control.phase = 'committing';
            if (buildRequired) return {application: 'failed', error: {code: 'DSH_PLUGIN_BUILD_APPROVAL_REQUIRED'}, target: inspection.name, changed: true};
            return {application: 'restart-required', restartReason: 'no-hmr', target: inspection.name, changed: true};
          } catch (error) {
            control.phase = 'restoring';
            try { await restore(before); } catch { keepBackup = true; throw managementFailure('DSH_PLUGIN_OPERATION_UNKNOWN'); }
            if (controller.signal.aborted) return {application: 'cancelled', changed: false};
            throw error;
          } finally { if (!keepBackup) await rm(before.directory, {recursive: true, force: true}).catch(() => {}); }
        }, controller.signal);
      } catch (error) {
        if (safeDshManagementError(error).code === 'DSH_PLUGIN_OPERATION_UNKNOWN') retainInspection = true;
        if (controller.signal.aborted && control.phase === 'preparing') return {application: 'cancelled', changed: false};
        throw error;
      } finally {
        installs.delete(input.requestId);
        if (!borrowedInspection && !retainInspection) await inspectionLease?.release().catch(() => {});
      }
    },
    remove(input) {
      return transaction(input, async () => {
        const bundle = (await ctx.pluginManager.listBundles()).find(bundle => bundle.name === input.name);
        if (!bundle || !bundle.installed || !bundle.removable || bundle.readOnlyReason || isProtectedBundle(bundle)) throw managementFailure('DSH_PLUGIN_PROTECTED');
        const entries = [...ctx.loader.entries()];
        if (profile.startedBundles.includes(input.name) || bundle.rows.some(row => entries.some(entry =>
          entry.fiber && (entry.id === row.entryId || entry.options.id === row.rowId && entry.options.name === row.moduleName)))) throw managementFailure('DSH_PLUGIN_RESTART_REQUIRED');
        const manifest = JSON.parse(await readOptional(path.join(profile.dir, 'package.json')));
        if (!Object.hasOwn(manifest.dependencies ?? {}, input.name)) throw managementFailure('DSH_PLUGIN_PROTECTED');
        const before = await capture();
        let keepBackup = false;
        try {
          const result = await sdk.runProfilePnpm(context(), ['remove', input.name], options(AbortSignal.timeout(45_000)));
          if (result.exitCode !== 0 || result.timedOut) throw managementFailure(failure(result));
          const after = JSON.parse(await readOptional(path.join(profile.dir, 'package.json')));
          if (Object.hasOwn(after.dependencies ?? {}, input.name)) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
          after.dsh.profile.bundles = after.dsh.profile.bundles.filter(name => name !== input.name);
          await sdk.writeFileAtomic(path.join(profile.dir, 'package.json'), JSON.stringify(after, null, 2) + '\n', {mode: 0o600});
          sdk.composeEntries([sdk.readProfilePatches('dsh', profile)]);
          await writeDshBuildStatus(profile.dir, input.name, '', false, sdk);
          return {application: 'restart-required', restartReason: 'no-hmr', target: input.name, changed: true};
        } catch (error) {
          try { await restore(before); } catch { keepBackup = true; throw managementFailure('DSH_PLUGIN_OPERATION_UNKNOWN'); }
          throw error;
        } finally { if (!keepBackup) await rm(before.directory, {recursive: true, force: true}).catch(() => {}); }
      });
    },
    cancel(input) {
      binding(input);
      const control = installs.get(input.requestId);
      if (!control) return {status: 'not-running'};
      if (['committing', 'restoring'].includes(control.phase)) return {status: 'too-late'};
      control.controller.abort();
      // The journal waits for the original operation's real result; this is never confirmation of restoration.
      return {status: 'cancelling'};
    },
    abortOwned() {
      for (const control of installs.values()) if (!['committing', 'restoring'].includes(control.phase)) control.controller.abort();
    },
  };
}
