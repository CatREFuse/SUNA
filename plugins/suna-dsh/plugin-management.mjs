import {randomUUID,createHash} from 'node:crypto';
import {readFile,mkdir,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createManagementVerifier, MANAGEMENT_PATH} from './plugin-management-auth.mjs';
import {parseDshPluginManagement} from './plugin-management-contract.mjs';
import {createDshManagementRevision} from './plugin-management-state.mjs';
import {createDshConfigurationAccess} from './plugin-management-configuration.mjs';
import {createDshProfileControls} from './plugin-management-controls.mjs';
import {createDshPackageOperations} from './plugin-management-packages.mjs';
import {createDshArchiveInspections} from './plugin-management-archives.mjs';
import {createDshManagementJournal} from './plugin-management-journal.mjs';
import {createDshPackageResolver} from './plugin-management-resolver.mjs';
import {readDshBuildStatuses} from './plugin-management-builds.mjs';
import {createDshRequiredEntries} from './plugin-management-protection.mjs';
import {managementFailure, safeDshManagementError} from './plugin-management-errors.mjs';

export const DSH_MANAGEMENT_CAPABILITY = 'dsh-plugin-management-v1';
const packages = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const literal = value => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, ' ').replace(/(?:file:\/\/)?\/(?:Users|private|var|tmp|home)\/\S+/g, '[路径]').slice(0, 240) : '';
const moduleLabel = value => typeof value === 'string' && packages.test(value) ? value : '本地插件';
const localized = value => typeof value === 'string' ? literal(value) : literal(value?.['zh-CN'] ?? value?.en);

/** Client-only administration endpoint. It registers no tools, remote Cordis service, Agent or Session. */
export async function createDshPluginManagement(ctx, {sdk, publicKey, targetId, runtimeVersion, bridgeVersion,
  protectedEntryIds = [], protectedBundles = [], packageManager, resolveSpec,
  isBusy = () => false, clock = Date.now} = {}) {
  const profile = ctx.get('profileContext');
  if (!profile || ctx.get('hmr') || !ctx.get('pluginManager') || !ctx.get('configEditor') ||
      !['0.2.1-rc.5', '0.2.2-rc.1'].includes(runtimeVersion) || !publicKey || !targetId || !(packageManager ?? profile.packageManager)) return null;
  const manifest = JSON.parse(await readFile(path.join(profile.dir, 'package.json'), 'utf8'));
  if (manifest.sunaManagedProfile !== 1) return null;
  const verify = createManagementVerifier(publicKey), generation = randomUUID();
  const revision = createDshManagementRevision(ctx, profile.dir);
  const binding = {targetId, generation};
  const protectedIds = new Set(['suna-bridge', 'plugin-manager', 'config-editor', ...protectedEntryIds]);
  const protectedNames = new Set(['@suna/dsh-bridge', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...protectedBundles]);
  const requiredEntries = createDshRequiredEntries(ctx, {moduleNames: sdk.requiredRuntimeModuleNames});
  const protectedEntry = entry => protectedIds.has(entry.options.id) ||
    requiredEntries().has(entry.id);
  const protectedPlugin = row => !!row.readOnlyReason || protectedIds.has(row.patchId) || requiredEntries().has(row.entryId);
  const protectedBundle = row => !!row.readOnlyReason || protectedNames.has(row.name) ||
    (row.overrides ?? []).some(id => protectedIds.has(id)) || (row.rows ?? []).some(row => protectedIds.has(row.rowId) || requiredEntries().has(row.entryId));
  const configuration = createDshConfigurationAccess(ctx, {...binding, revision, isBusy, isNativeConfigSchema: sdk.isNativeConfigSchema, isProtected: protectedEntry});
  const controls = createDshProfileControls(ctx, {sdk, ...binding, revision,
    isBusy, isProtectedPlugin: protectedPlugin, isProtectedBundle: protectedBundle});
  const directory = path.join(profile.dir, '.suna-plugin-manager');
  await mkdir(directory, {recursive: true, mode: 0o700});
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== path.join(await realpath(profile.dir), '.suna-plugin-manager')) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  const inspections = await createDshArchiveInspections({directory: path.join(directory, 'archives'), ...binding,
    runtimeVersion, createArchiveParser: sdk.createArchiveParser, evaluatePluginCompatibility: sdk.evaluatePluginCompatibility, clock});
  const journal = await createDshManagementJournal({directory: path.join(directory, 'journal'), ...binding});
  const packageOperations = createDshPackageOperations(ctx, {sdk, inspections, ...binding, runtimeVersion, revision,
    isBusy, packageManager, isProtectedBundle: protectedBundle});
  const resolver = !resolveSpec && typeof sdk.parseInstallSpec === 'function' ? await createDshPackageResolver({sdk,
    profile, packageManager: packageManager ?? profile.packageManager, npmCliPath: sdk.npmCliPath,
    directory: path.join(directory, 'resolutions')}) : null;
  let closing = false; const requests = new Set(), inspectionRequests = new Map(), leaseTasks = new Set();
  const assertBinding = params => {
    if (params.targetId !== targetId || params.generation !== generation) throw managementFailure('DSH_PLUGIN_TARGET_CHANGED');
  };
  function canRemove(bundle) {
    if (!bundle.installed || !bundle.removable || protectedBundle(bundle) || profile.startedBundles.includes(bundle.name)) return false;
    return !(bundle.rows ?? []).some(row => [...ctx.loader.entries()].some(entry => entry.fiber &&
      (entry.id === row.entryId || entry.options.id === row.rowId && entry.options.name === row.moduleName)));
  }
  async function snapshot() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = revision();
      const [plugins, bundles] = await Promise.all([ctx.pluginManager.listPlugins(), ctx.pluginManager.listBundles()]);
      const buildStatuses = await readDshBuildStatuses(profile.dir);
      const buildBlocked = row => bundles.some(bundle => buildStatuses[bundle.name]?.required && ((bundle.rows ?? []).some(item => item.entryId === row.entryId || item.rowId === row.patchId || item.moduleName === row.moduleName) || row.moduleName === bundle.name || row.moduleName.startsWith(bundle.name + '/')));
      const after = revision();
      if (before !== after) continue;
      const busy = closing || isBusy(), canManage = !busy;
      return {protocolVersion: 1, status: busy ? 'unavailable' : 'connected', ...(busy ? {reason: 'DSH_PLUGIN_BUSY'} : {}),
        ...binding, revision: after, canManage, runtimeVersion, bridgeVersion,
        plugins: plugins.map(row => ({entryId: row.entryId, moduleName: moduleLabel(row.moduleName),
          name: localized(row.meta?.name) || moduleLabel(row.moduleName),
          ...(localized(row.meta?.description) ? {description: localized(row.meta.description)} : {}),
          enabled: row.enabled, phase: row.fiberPhase, protected: protectedPlugin(row),
          canEnable: canManage && !protectedPlugin(row) && (row.enabled || !buildBlocked(row)), canConfigure: canManage && configuration.canConfigure(row.entryId),
          ...(protectedPlugin(row) ? {reason: 'DSH_PLUGIN_PROTECTED'} : buildBlocked(row) ? {reason: 'DSH_PLUGIN_BUILD_APPROVAL_REQUIRED'} : {})})),
        bundles: bundles.map(row => ({name: row.name, label: localized(row.meta?.name) || literal(row.name),
          ...(row.version ? {version: literal(row.version)} : {}),
          ...(localized(row.meta?.description) || literal(row.description) ? {description: localized(row.meta?.description) || literal(row.description)} : {}),
          installed: row.installed, enabled: row.enabled, official: row.official, availability: row.availability,
          protected: protectedBundle(row), canEnable: canManage && !protectedBundle(row) && !row.error && (row.enabled || !buildStatuses[row.name]?.required),
          canRemove: canManage && canRemove(row),
          ...(protectedBundle(row) ? {reason: 'DSH_PLUGIN_PROTECTED'} : buildStatuses[row.name]?.required ? {reason: 'DSH_PLUGIN_BUILD_APPROVAL_REQUIRED'} : row.removable && !canRemove(row) ? {reason: 'DSH_PLUGIN_RESTART_REQUIRED'} : row.error ? {reason: 'DSH_PLUGIN_PACKAGE_INVALID'} : {}),
          rows: row.rows.map(item => ({...(item.entryId ? {entryId: item.entryId} : {}),
            moduleName: moduleLabel(item.moduleName), name: localized(item.meta?.name) || moduleLabel(item.moduleName)}))})),
        operations: journal.list()};
    }
    throw managementFailure('DSH_PLUGIN_BUSY');
  }
  async function dispatch(input) {
    if (closing) throw managementFailure('DSH_PLUGIN_DISCONNECTED');
    const {method, params} = input;
    if (method === 'context' || method === 'dsh.snapshot') return snapshot();
    assertBinding(params);
    if (method === 'dsh.configuration') return configuration.read(params);
    if (method === 'dsh.operation') return journal.read(params);
    if (method === 'dsh.cancel') return journal.cancel(params, requestId => packageOperations.cancel({...binding, requestId}));
    if (method === 'dsh.inspect') {
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      for (const [id, previous] of inspectionRequests) if (previous.settled && !previous.unknown && clock() >= previous.expires &&
          !inspections.hasLease(previous.inspectionId)) inspectionRequests.delete(id);
      await inspections.collect();
      const prior = inspectionRequests.get(params.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw managementFailure('DSH_PLUGIN_CONFLICT');
        return {...await prior.task};
      }
      if (isBusy()) throw managementFailure('DSH_PLUGIN_BUSY');
      if (revision() !== params.expectedRevision) throw managementFailure('DSH_PLUGIN_CONFLICT');
      if (inspectionRequests.size >= 256) throw managementFailure('DSH_PLUGIN_BUSY');
      const receipt = {fingerprint, task: null, settled: false, unknown: false, expires: clock() + 5 * 60_000};
      const task = (async () => {
        const prepared = resolveSpec ? await resolveSpec(params.spec) : resolver ? await resolver.resolve(params.spec) :
          path.isAbsolute(params.spec) && /\.(tgz|tar\.gz)$/i.test(params.spec) ? {filename: params.spec} : null;
        if (!prepared) throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
        try {
          const result = await inspections.inspect(prepared.filename, {revision: params.expectedRevision, integrity: prepared.integrity, packagedWithoutScripts: prepared.packagedWithoutScripts});
          if (prepared.expectedName && result.name !== prepared.expectedName || prepared.expectedVersion && result.version !== prepared.expectedVersion) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
          if (revision() !== params.expectedRevision) throw managementFailure('DSH_PLUGIN_CONFLICT');
          receipt.expires = Date.parse(result.expiresAt); receipt.inspectionId = result.inspectionId;
          return result;
        } finally { await prepared.cleanup?.(); }
      })();
      receipt.task = task; inspectionRequests.set(params.requestId, receipt);
      void task.then(() => {receipt.settled = true;}, error => {receipt.settled = true; receipt.unknown = safeDshManagementError(error).code === 'DSH_PLUGIN_OPERATION_UNKNOWN';});
      return {...await task};
    }
    let inspectionLease, inspectionError, admitted = false;
    if (method === 'dsh.install' && journal.read(params).method === 'dsh.operation') {
      try { inspectionLease = await inspections.acquire(params); }
      catch (error) { inspectionError = error; }
    }
    try {
    const result = await journal.start(input, async input => {
      // Keep preflight failures on the existing durable operation path: callers
      // can query a definitive expired/invalid receipt instead of an orphaned UI write.
      if (inspectionError) throw inspectionError;
      if (closing) throw managementFailure('DSH_PLUGIN_DISCONNECTED');
      if (isBusy()) throw managementFailure('DSH_PLUGIN_BUSY');
      switch (input.method) {
        case 'dsh.configure': return configuration.configure(input.params);
        case 'dsh.plugin-enabled': return controls.pluginEnabled(input.params);
        case 'dsh.bundle-enabled': return controls.bundleEnabled(input.params);
        case 'dsh.install': return packageOperations.install(input.params, {inspection: inspectionLease});
        case 'dsh.remove': return packageOperations.remove(input.params);
        default: throw managementFailure('DSH_PLUGIN_METHOD_UNSUPPORTED');
      }
    }, {beforeAdmit() {
      if (closing) throw managementFailure('DSH_PLUGIN_DISCONNECTED');
      if (isBusy()) throw managementFailure('DSH_PLUGIN_BUSY');
      if (revision() !== params.expectedRevision) throw managementFailure('DSH_PLUGIN_CONFLICT');
      admitted = true;
    }});
    if (inspectionLease) {
      if (!admitted) await inspectionLease.release().catch(() => {});
      else {
        // Also releases a queued cancellation whose execute callback never ran.
        // Unknown outcomes retain their frozen artifact for later inspection.
        const lease = inspectionLease;
        const task = journal.settled().then(async () => {
          if (journal.read(params).state === 'completed') await lease.release();
        });
        leaseTasks.add(task); void task.finally(() => leaseTasks.delete(task)).catch(() => {});
      }
    }
    return result;
    } catch (error) { await inspectionLease?.release().catch(() => {}); throw error; }
  }
  return {
    ...binding, capability: DSH_MANAGEMENT_CAPABILITY,
    busy: () => journal.list().some(item => item.generation === generation && item.state === 'pending'),
    async handle(request) {
      // Verify raw bytes before JSON parsing. Both reads and writes require the Client-owned signing key here.
      verify.verify(request);
      const task = (async () => {
        let input; try { input = JSON.parse(request.body); } catch { throw managementFailure('DSH_PLUGIN_INPUT_INVALID'); }
        return dispatch(parseDshPluginManagement(input));
      })(); requests.add(task);
      try { return await task; }
      catch (error) { throw Object.assign(new Error(safeDshManagementError(error).message), safeDshManagementError(error)); }
      finally { requests.delete(task); }
    },
    async close() { closing = true; packageOperations.abortOwned(); await resolver?.close(); await Promise.allSettled([...requests]); await journal.close(); await Promise.allSettled([...leaseTasks]); await inspections.close(); },
  };
}

export {MANAGEMENT_PATH};
