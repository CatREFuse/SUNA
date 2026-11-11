import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import {managementFailure} from './plugin-management-errors.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(value);
const integrity = value => typeof value === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value);

/** Fixed argv only. Package output is retained in memory and never returned as UI diagnostics. */
function command(executable, args, {cwd, env, signal, maxBytes = 1024 * 1024, timeoutMs = 60_000}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(managementFailure('DSH_PLUGIN_DISCONNECTED'));
    const grouped = process.platform !== 'win32';
    const child = spawn(executable, args, {cwd, env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    let size = 0, failure, killing, timer;
    const stdout = [];
    const kill = signal => { try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const stop = () => { kill('SIGTERM'); killing ??= setTimeout(() => kill('SIGKILL'), 2000); };
    const abort = () => { failure = managementFailure('DSH_PLUGIN_DISCONNECTED'); stop(); };
    signal?.addEventListener('abort', abort, {once: true});
    timer = setTimeout(() => { failure = managementFailure('DSH_PLUGIN_PACKAGE_FAILED'); stop(); }, timeoutMs);
    const consume = (chunk, keep) => {
      size += chunk.length;
      if (size > maxBytes) { failure = managementFailure('DSH_PLUGIN_PACKAGE_INVALID'); stop(); }
      else if (keep) stdout.push(chunk);
    };
    child.stdout.on('data', chunk => consume(chunk, true));
    child.stderr.on('data', chunk => consume(chunk, false));
    child.once('error', () => { failure = managementFailure('DSH_PLUGIN_UNSUPPORTED'); });
    child.once('close', async code => {
      if (failure && grouped && child.pid) {
        // The parent can exit before an owned Git transport. Do not delete its job while that range still runs.
        const deadline = Date.now() + 4500;
        for (;;) {
          let live = false;
          try { process.kill(-child.pid, 0); live = true; } catch (error) { if (error.code !== 'ESRCH') live = true; }
          if (!live) break;
          if (Date.now() >= deadline) { failure = managementFailure('DSH_PLUGIN_OPERATION_UNKNOWN'); break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      clearTimeout(timer); clearTimeout(killing); signal?.removeEventListener('abort', abort);
      failure ? reject(failure) : code !== 0 ? reject(managementFailure('DSH_PLUGIN_PACKAGE_FAILED')) : resolve(Buffer.concat(stdout));
    });
  });
}

function gitAddress(spec) {
  let address = spec, ref = 'HEAD';
  const hash = spec.indexOf('#');
  if (hash >= 0) { address = spec.slice(0, hash); ref = spec.slice(hash + 1); }
  if (!ref || ref.length > 240 || ref.startsWith('-') || /[\s~^:?*\[\\\x00-\x1f]/.test(ref) || ref.includes('..') || ref.includes('@{')) throw managementFailure('DSH_PLUGIN_INPUT_INVALID');
  const shorthand = address.match(/^(?:(github|gitlab|bitbucket):)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shorthand) address = `https://${{github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org'}[shorthand[1] ?? 'github']}/${shorthand[2]}/${shorthand[3]}.git`;
  address = address.replace(/^git\+/, '');
  if (/^[A-Za-z0-9_.-]+@[^:]+:/.test(address)) address = 'ssh://' + address.replace(':', '/');
  let url;
  try { url = new URL(address); } catch { throw managementFailure('DSH_PLUGIN_INPUT_INVALID'); }
  if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash ||
      url.protocol === 'https:' && url.username || url.username && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(url.username) ||
      !url.hostname || /[\x00-\x20]/.test(address)) throw managementFailure('DSH_PLUGIN_INPUT_INVALID');
  return {address: url.href, ref};
}

/** All forms become a frozen npm-style archive. Inspection runs no package lifecycle, checkout filter or hook. */
export async function createDshPackageResolver({sdk, profile, packageManager, npmCliPath, directory,
  inspectRegistry, fetchImpl = fetch, gitExecutable = process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'} = {}) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const canonical = await realpath(directory);
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw managementFailure('DSH_PLUGIN_PROFILE_INVALID');
  const controllers = new Set(), tasks = new Set(); let closing = false;
  const queryOptions = signal => ({...packageManager,
    args: [...packageManager.args, '--config.ignore-scripts=true', '--config.ignore-pnpmfile=true'],
    env: {...packageManager.env, npm_config_ignore_scripts: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      npm_config_ignore_pnpmfile: 'true', NPM_CONFIG_IGNORE_PNPMFILE: 'true'}, timeoutMs: 20_000, signal});
  async function selectRegistry(parsed, signal) {
    const registry = await sdk.readProfileRegistry(profile.dir, {...queryOptions(signal), timeoutMs: 2000});
    if (!registry) throw managementFailure('DSH_PLUGIN_PACKAGE_FAILED');
    let selected = sdk.semver.valid(parsed.range ?? '');
    if (!selected) {
      const result = await sdk.viewProfilePackage(profile.dir, parsed.name, {...queryOptions(signal), registry,
        fields: ['versions', 'dist-tags']});
      if (result.exitCode !== 0 || result.timedOut) throw managementFailure('DSH_PLUGIN_PACKAGE_FAILED');
      const metadata = JSON.parse(result.stdout), versions = metadata.versions, tags = metadata['dist-tags'];
      if (!Array.isArray(versions) || versions.length > 20_000 || !tags || typeof tags !== 'object') throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
      selected = tags[parsed.range ?? 'latest'];
      if (!selected && parsed.range && sdk.semver.validRange(parsed.range)) selected = sdk.semver.maxSatisfying(versions, parsed.range);
    }
    if (!version(selected)) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
    return {status: 'accepted', kind: 'registry', name: parsed.name, version: selected, registry};
  }
  async function pack(spec, job, signal, registry) {
    if (!npmCliPath || !packageManager) throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
    const env = {...process.env, ...packageManager.env, npm_config_ignore_scripts: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      npm_config_cache: path.join(job, 'npm-cache'), NPM_CONFIG_CACHE: path.join(job, 'npm-cache'), npm_config_update_notifier: 'false'};
    const args = [npmCliPath, 'pack', '--ignore-scripts', '--json', '--pack-destination', job];
    if (registry) {
      const url = new URL(registry);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw managementFailure('DSH_PLUGIN_INPUT_INVALID');
      args.push('--registry=' + url.href);
    }
    args.push('--', spec);
    const output = JSON.parse((await command(packageManager.command, args, {cwd: profile.dir, env, signal})).toString('utf8'));
    const item = Array.isArray(output) && output.length === 1 ? output[0] : null;
    if (!item || typeof item.filename !== 'string' || path.basename(item.filename) !== item.filename ||
        !item.filename.endsWith('.tgz') || !version(item.version) || !integrity(item.integrity)) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
    const filename = path.join(job, item.filename);
    if (await realpath(filename) !== filename || !(await lstat(filename)).isFile()) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
    return {filename, integrity: item.integrity, expectedName: item.name, expectedVersion: item.version};
  }
  async function download(spec, job, signal) {
    const url = new URL(spec);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw managementFailure('DSH_PLUGIN_INPUT_INVALID');
    const response = await fetchImpl(url, {signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error'});
    if (!response.ok || !response.body) throw managementFailure('DSH_PLUGIN_PACKAGE_FAILED');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
      chunks.push(chunk);
    }
    const filename = path.join(job, 'download.tgz'); await writeFile(filename, Buffer.concat(chunks), {mode: 0o600, flag: 'wx'});
    return {filename};
  }
  async function git(spec, job, signal) {
    const {address, ref} = gitAddress(spec), repo = path.join(job, 'repository.git'), empty = path.join(job, 'empty-config');
    await writeFile(empty, '', {mode: 0o600});
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const env = {...inherited, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_GLOBAL: empty,
      GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_TERMINAL_PROMPT: '0', GIT_SSH_VARIANT: 'ssh',
      GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oUpdateHostKeys=no -F /dev/null'};
    // No checkout, submodule update, dependency installation, prepare script or archive command from global config.
    const fixed = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'credential.interactive=false'];
    await command(gitExecutable, [...fixed, 'init', '--bare', repo], {cwd: job, env, signal});
    const scoped = [...fixed, '--git-dir', repo];
    await command(gitExecutable, [...scoped, 'fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--', address, ref], {cwd: job, env, signal});
    const commit = (await command(gitExecutable, [...scoped, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], {cwd: job, env, signal})).toString('utf8').trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
    const data = await command(gitExecutable, [...scoped, 'archive', '--format=tar', '--prefix=package/', commit], {cwd: job, env, signal, maxBytes: MAX_BYTES});
    const filename = path.join(job, 'git.tgz'); await writeFile(filename, gzipSync(data), {mode: 0o600, flag: 'wx'});
    return {filename, packagedWithoutScripts: true};
  }
  return {
    async resolve(spec) {
      if (closing) throw managementFailure('DSH_PLUGIN_DISCONNECTED');
      let parsed;
      try { parsed = sdk.parseInstallSpec(spec); } catch { throw managementFailure('DSH_PLUGIN_INPUT_INVALID'); }
      const controller = new AbortController(); controllers.add(controller);
      let job;
      const prepare = async () => {
        switch (parsed.kind) {
          case 'path': {
            const source = await realpath(parsed.path);
            if (!(await lstat(source)).isDirectory()) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
            return {...await pack(source, job, controller.signal), packagedWithoutScripts: true};
          }
          case 'tarball': return parsed.path ? {filename: parsed.path} : download(parsed.spec, job, controller.signal);
          case 'git': return git(parsed.spec, job, controller.signal);
          case 'registry': {
            const selected = inspectRegistry ? await inspectRegistry(parsed.spec, controller.signal) : await selectRegistry(parsed, controller.signal);
            if (selected.status !== 'accepted' || selected.kind !== 'registry' || selected.name !== parsed.name || !version(selected.version)) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
            const result = await sdk.viewProfilePackage(profile.dir, `${selected.name}@${selected.version}`, {
              ...queryOptions(controller.signal), execution: 'service', registry: selected.registry,
              fields: ['name', 'version', 'dist.integrity'], signal: controller.signal});
            if (result.exitCode !== 0 || result.timedOut) throw managementFailure('DSH_PLUGIN_PACKAGE_FAILED');
            const metadata = JSON.parse(result.stdout), expected = metadata.dist?.integrity ?? metadata['dist.integrity'];
            if (metadata.name !== selected.name || metadata.version !== selected.version || !integrity(expected)) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
            const packed = await pack(`${selected.name}@${selected.version}`, job, controller.signal, selected.registry);
            if (packed.expectedName !== selected.name || packed.expectedVersion !== selected.version || packed.integrity !== expected) throw managementFailure('DSH_PLUGIN_PACKAGE_INVALID');
            return packed;
          }
          default: throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
        }
      };
      const task = (async () => {
        try {
          job = await mkdtemp(path.join(canonical, 'resolve-'));
          controller.signal.throwIfAborted();
          return {...await prepare(), cleanup: () => rm(job, {recursive: true, force: true})};
        } catch (error) {
          if (job && error.code !== 'DSH_PLUGIN_OPERATION_UNKNOWN') await rm(job, {recursive: true, force: true});
          if (controller.signal.aborted && error.code !== 'DSH_PLUGIN_OPERATION_UNKNOWN') throw managementFailure('DSH_PLUGIN_DISCONNECTED');
          throw error;
        } finally { controllers.delete(controller); }
      })();
      tasks.add(task);
      try { return await task; }
      finally { tasks.delete(task); }
    },
    async close() { closing = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...tasks]); },
  };
}
