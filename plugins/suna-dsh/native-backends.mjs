/** Run-scoped implementations of the public DSH FS / SandboxProvider / ShellExecutor seams.
 * No credentials, ambient environment, unrestricted fallback, background jobs or PTY.
 * The plugin composition must delegate through its own Service subclasses and dispose close().
 */
import * as fs from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {readSystemMetrics,systemMetricsShellFunction} from './system-metrics.mjs';

const exec = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
const MAX_FILE = 16 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const BINARIES = ['/bin/bash', '/bin/cat', '/bin/ls', '/bin/mkdir', '/bin/rm', '/bin/cp', '/bin/mv', '/bin/sleep', '/bin/echo', '/usr/bin/touch', '/usr/bin/head', '/usr/bin/tail', '/usr/bin/wc', '/usr/bin/grep', '/usr/bin/sed', '/usr/bin/printf', '/usr/bin/env', '/usr/bin/curl'];
const CREDENTIAL_PART = /^(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.codex|\.dsh|\.git|\.config|\.suna(?:-dev)?|client-auth|credentials?|secrets?|auth\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const mutationQueues = new Map();
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const quote = value => JSON.stringify(value);
const hash = value => createHash('sha256').update(value).digest('hex');
function credentialPath(root, candidate) {
  return path.relative(root, candidate).split(path.sep).some(part => CREDENTIAL_PART.test(part));
}
function checkedPath(root, candidate) {
  if (typeof candidate !== 'string' || candidate.includes('\0')) throw fail('FS_SANDBOX_DENIED');
  const absolute = path.resolve(root, candidate);
  if (!inside(root, absolute) || credentialPath(root, absolute)) throw fail('FS_SANDBOX_DENIED');
  return absolute;
}
async function canonical(root, candidate, allowMissing = false) {
  const absolute = checkedPath(root, candidate);
  try {
    const real = await fs.realpath(absolute);
    checkedPath(root, real);
    const info = await fs.stat(real);
    if (info.isFile() && info.nlink !== 1) throw fail('FS_SANDBOX_DENIED', 'Hard-linked files are not available');
    return real;
  } catch (error) {
    if (error.code !== 'ENOENT' || !allowMissing || absolute === root) throw error;
    const parent = await canonical(root, path.dirname(absolute), false);
    return checkedPath(root, path.join(parent, path.basename(absolute)));
  }
}
async function rejectExistingHardLinks(root) {
  const pending = [root]; let count = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++count > 100000) throw fail('SANDBOX_UNAVAILABLE', 'Workspace exceeds the verification limit');
      const name = path.join(directory, entry.name);
      if (credentialPath(root, name) || entry.isSymbolicLink()) continue;
      const info = await fs.lstat(name);
      if (info.isDirectory()) pending.push(name);
      else if (info.isFile() && info.nlink !== 1) throw fail('FS_SANDBOX_DENIED', 'Workspace contains a hard-linked file');
    }
  }
}
const typeOf = info => info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';
const versionOf = info => hash(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
const projectStat = info => ({ type: typeOf(info), size: Number(info.size), version: versionOf(info) });
function decodeText(data) {
  if (data.includes(0)) throw fail('FS_NOT_TEXT');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\r\n/g, '\n'); }
  catch { throw fail('FS_NOT_TEXT'); }
}

// All actual filesystem access runs here *inside* Seatbelt. Parent-directory swaps
// cannot turn a successful host realpath check into a read/write outside the root.
async function fsOperation(root, op, input) {
  const p = await canonical(root, input.path, ['resolve', 'stat', 'writeText'].includes(op));
  if (op === 'verify') { await rejectExistingHardLinks(root); return true; }
  if (op === 'resolve') return { targetKey: p, displayPath: p };
  if (op === 'stat' || op === 'lstat') {
    try { return projectStat(await fs[op === 'lstat' ? 'lstat' : 'stat'](op === 'lstat' ? checkedPath(root, input.path) : p, { bigint: true })); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  if (op === 'listDir') {
    const entries = await fs.readdir(p, { withFileTypes: true });
    if (entries.length > 10000) throw fail('FS_TOO_LARGE');
    const result = [];
    for (const entry of entries) {
      const child = path.join(p, entry.name);
      if (credentialPath(root, child)) continue;
      try {
        const real = await canonical(root, child);
        const info = projectStat(await fs.stat(real, { bigint: true }));
        result.push({ name: entry.name, ...info, target: { targetKey: real, displayPath: real } });
      } catch (error) { if (!['FS_SANDBOX_DENIED', 'EPERM', 'EACCES', 'ENOENT'].includes(error.code)) throw error; }
    }
    return result;
  }
  const read = async (limit = MAX_FILE, range) => {
    const handle = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile()) throw fail('FS_NOT_REGULAR_FILE');
      if (info.nlink !== 1n) throw fail('FS_SANDBOX_DENIED');
      if (!range && info.size > BigInt(limit)) throw fail('FS_TOO_LARGE');
      const size = range ? Math.min(range.length, Math.max(0, Number(info.size) - range.offset)) : Number(info.size);
      const data = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(data, offset, size - offset, (range?.offset ?? 0) + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return { data: data.subarray(0, offset), info };
    } finally { await handle.close(); }
  };
  if (['readText', 'readBytes', 'readByteRange'].includes(op)) {
    const { data } = await read(input.maxBytes ?? MAX_FILE, input.range);
    return op === 'readText' ? decodeText(data) : data.toString('base64');
  }
  if (!['writeText', 'editText'].includes(op)) throw fail('FS_IO_ERROR', 'Unknown filesystem operation');
  if (input.expected !== undefined) {
    const expected = input.expected;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw fail('FS_IO_ERROR');
    if (op === 'editText') {
      if (Object.keys(expected).some(k => k !== 'version') || typeof expected.version !== 'string' || !expected.version) throw fail('FS_IO_ERROR');
    } else if (expected.kind === 'createIfAbsent') {
      if (Object.keys(expected).some(k => k !== 'kind')) throw fail('FS_IO_ERROR');
    } else if (expected.kind !== 'replaceIfVersion' || Object.keys(expected).some(k => !['kind', 'version'].includes(k)) || typeof expected.version !== 'string' || !expected.version) throw fail('FS_IO_ERROR');
  }
  let before = null, observed;
  try { const old = await read(); before = decodeText(old.data); observed = versionOf(old.info); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (input.expected?.kind === 'createIfAbsent' && before !== null) throw fail('FS_STALE_VERSION');
  if (input.expected?.version && input.expected.version !== observed) throw fail('FS_STALE_VERSION');
  let after = input.content;
  if (op === 'editText') {
    if (before === null) throw fail('FS_NOT_FOUND');
    const { oldString, newString, replaceAll } = input.edit ?? {};
    if (typeof oldString !== 'string' || !oldString || typeof newString !== 'string' || typeof replaceAll !== 'boolean') throw fail('FS_IO_ERROR');
    const count = before.split(oldString).length - 1;
    if (!count) throw fail('FS_EDIT_NOT_FOUND');
    if (!replaceAll && count > 1) throw fail('FS_AMBIGUOUS_EDIT');
    after = replaceAll ? before.replaceAll(oldString, newString) : before.replace(oldString, newString);
  }
  if (typeof after !== 'string' || Buffer.byteLength(after) > MAX_FILE || after.includes('\0')) throw fail('FS_TOO_LARGE');
  after = after.replace(/\r\n/g, '\n');
  if (before === null) {
    const handle = await fs.open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(after); } finally { await handle.close(); }
  } else {
    const temp = path.join(path.dirname(p), `.suna-write-${randomUUID()}`);
    try {
      await fs.writeFile(temp, after, { flag: 'wx', mode: 0o600 });
      if (versionOf(await fs.stat(p, { bigint: true })) !== observed) throw fail('FS_STALE_VERSION');
      await canonical(root, p);
      await fs.rename(temp, p);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }
  const outcome = { version: versionOf(await fs.stat(p, { bigint: true })), before, after };
  // Official edit forwards every field except version into a strict tool-output
  // schema. FsEditOutcome deliberately has no write-only `operation` property.
  return op === 'editText' ? outcome : { operation: before === null ? 'create' : 'update', ...outcome };
}

function profile(root, mode, { worker = false, nodePath, modulePath, metricsPath }) {
  const executables = worker ? [nodePath] : BINARIES;
  // Path expressions are quoted, never interpolated as SBPL source.
  const reads = ['/', '/dev/null', '/dev/urandom', '/dev/random', ...executables, ...(worker ? [modulePath,metricsPath] : [])].map(p => `(literal ${quote(p)})`);
  const ancestors = new Set();
  for (const leaf of [root, nodePath, modulePath]) { let current = path.dirname(leaf); while (current !== '/') { ancestors.add(current); current = path.dirname(current); } }
  const libraries = ['/System/Library', '/System/Volumes/Preboot/Cryptexes', '/usr/lib'].map(p => `(subpath ${quote(p)})`);
  // The runtime can itself live below .suna-dev; protect credential names *inside*
  // the role workspace, without accidentally denying all descendants of its host.
  const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const deniedNames = String.raw`(\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.codex|\.dsh|\.git|\.config|\.suna(-dev)?|client-auth|credentials?|secrets?|auth\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx))`;
  const caseInsensitiveNames = deniedNames.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`);
  const credentialPattern = `^${escapedRoot}/(.*/)?${caseInsensitiveNames}(/|$)`;
  // SBPL #"" regex literals preserve backslashes; JSON string escaping would
  // double them and accidentally turn a credential-name dot into a backslash.
  const credential = `(regex #"${credentialPattern.replaceAll('"', '\\"')}")`;
  return ['(version 1)', '(deny default)', '(allow process-fork)', '(allow sysctl-read)', '(allow signal (target same-sandbox))',
    `(allow file-read-metadata ${[...ancestors].map(p => `(literal ${quote(p)})`).join(' ')})`,
    `(allow process-exec ${executables.map(p => `(literal ${quote(p)})`).join(' ')})`,
    `(allow file-read* ${reads.join(' ')} ${libraries.join(' ')} (subpath ${quote(root)}))`,
    `(allow file-write* (literal "/dev/null")${mode === 'workspace-write' ? ` (subpath ${quote(root)})` : ''})`,
    `(deny file-read* file-write* ${credential})`,
    `(deny file-map-executable (subpath ${quote(root)}))`,
    '(deny file-link)', '(deny network*)'].join('\n');
}
function safeEnvironment(privateDir) {
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', HOME: path.join(privateDir, 'home'), TMPDIR: path.join(privateDir, 'tmp'), TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat' };
}
function collector(limit) {
  let data = Buffer.alloc(0), total = 0;
  return {
    add(chunk) { total += chunk.length; data = Buffer.concat([data, chunk]); if (data.length > limit) data = data.subarray(data.length - limit); },
    readFrom(offset) { const start = total - data.length; return { text: data.subarray(Math.max(0, offset - start)).toString('utf8'), nextOffset: total, lossy: offset < start }; },
  };
}
async function processTable() {
  // macOS ps's sess pointer is intentionally hidden (zero). Query the public
  // getsid syscall through the OS Ruby runtime instead of treating it as a SID.
  // Ruby is never executable from the untrusted command's Seatbelt profile.
  const script = `IO.popen(["/bin/ps", "-axo", "pid=,ppid=,pgid="]) { |io| io.each_line { |l| p = l.split.map(&:to_i); begin; puts (p + [Process.getsid(p[0])]).join(" "); rescue Errno::ESRCH, Errno::EPERM; end } }`;
  const { stdout } = await exec('/usr/bin/ruby', ['--disable-gems', '-e', script], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim().split('\n').map(line => { const [pid, ppid, pgid, session] = line.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), session }; });
}

/** Dependency-free public shape, installed only in an Agent/run's scoped composition.
 * authorize() must throw or return false after policy revocation. signal must be the
 * run/tool authority AbortSignal, not merely a UI lifetime. close() kills and joins.
 */
export async function createNativeBackends({ workspaceRoot, signal, authorize = () => true, nodePath = process.execPath } = {}) {
  if (process.platform !== 'darwin') throw fail('SANDBOX_UNAVAILABLE', 'Restricted native tools require macOS Seatbelt');
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) throw fail('SANDBOX_UNAVAILABLE', 'A fixed workspace is required');
  const root = await fs.realpath(workspaceRoot);
  if (root === '/' || !((await fs.stat(root)).isDirectory())) throw fail('SANDBOX_UNAVAILABLE');
  nodePath = await fs.realpath(nodePath);
  const modulePath = await fs.realpath(SELF);
  const metricsPath = await fs.realpath(new URL('./system-metrics.mjs',import.meta.url));
  if (inside(root, nodePath) || inside(root, modulePath) || inside(root,metricsPath)) throw fail('SANDBOX_UNAVAILABLE', 'Runtime must be outside the writable workspace');
  const privateDir = path.join(root, `.suna-native-${randomUUID()}`);
  await fs.mkdir(path.join(privateDir, 'home'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(privateDir, 'tmp'), { mode: 0o700 });
  const environment = safeEnvironment(privateDir);
  let closed = false;
  const active = new Set();
  async function guard(callSignal) {
    if (closed || signal?.aborted || callSignal?.aborted) throw fail('FS_ABORTED');
    if (await authorize() === false) throw fail('NATIVE_TOOL_PERMISSION_DENIED');
    if (closed || signal?.aborted || callSignal?.aborted) throw fail('FS_ABORTED');
    if (await fs.realpath(workspaceRoot) !== root) throw fail('FS_SANDBOX_DENIED');
  }
  function policyMode(policy) {
    if (!policy) return 'workspace-write';
    if (!['read-only', 'workspace-write'].includes(policy.mode) || path.resolve(policy.workspaceRoot ?? '') !== root) throw fail('SANDBOX_UNAVAILABLE', 'Sandbox policy cannot widen this run workspace');
    return policy.mode;
  }
  const configuration = { nodePath, modulePath, metricsPath };
  async function confine(argv, policy, callSignal, worker = false) {
    await guard(callSignal);
    const mode = policyMode(policy);
    if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !(worker ? [nodePath] : BINARIES).includes(argv[0])) throw fail('SANDBOX_UNAVAILABLE', 'Executable is not part of the restricted backend');
    return { argv: ['/usr/bin/sandbox-exec', '-p', profile(root, mode, { ...configuration, worker }), ...argv], enforcement: 'full', denialSignatures: ['operation not permitted', 'permission denied'], runnerFailureRules: [{ fatalSignatures: ['sandbox_init:', 'sandbox-exec:'] }] };
  }
  // A functional probe must succeed under the final deny-default profile. No fallback.
  try {
    const p = await confine(['/bin/bash', '--noprofile', '--norc', '-c', 'printf suna-sandbox-ready'], { mode: 'read-only', workspaceRoot: root });
    const result = await exec(p.argv[0], p.argv.slice(1), { cwd: root, env: environment, timeout: 5000, maxBuffer: 4096 });
    if (result.stdout !== 'suna-sandbox-ready') throw new Error('probe failed');
    await processTable();
  } catch (error) {
    await fs.rm(privateDir, { recursive: true, force: true });
    throw fail('SANDBOX_UNAVAILABLE', `Restricted native backend could not be verified (${error.code ?? 'probe'})`);
  }
  async function worker(op, input, callSignal, policy) {
    await guard(callSignal);
    const p = await confine([nodePath, '--no-addons', '--disable-proto=throw', modulePath, '--suna-fs-worker', root], { mode: policyMode(policy), workspaceRoot: root }, callSignal, true);
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(callSignal ? [callSignal] : [])]);
    const running = exec(p.argv[0], p.argv.slice(1), { cwd: root, env: environment, signal: combined, timeout: 15000, maxBuffer: MAX_FILE * 2 + 65536, encoding: 'utf8' });
    running.child.stdin.end(JSON.stringify({ op, input }));
    const joined = new Promise(resolve => running.child.once('close', resolve));
    const record = { kill: () => controller.abort(), done: joined };
    active.add(record);
    try {
      const { stdout } = await running;
      await guard(callSignal);
      const result = JSON.parse(stdout);
      if (result.error) throw fail(result.error.code, result.error.message);
      return result.value;
    } catch (error) {
      if (combined.aborted) throw fail('FS_ABORTED');
      if (typeof error.code === 'string' && /^(FS_|NATIVE_)/.test(error.code)) throw error;
      throw fail('FS_IO_ERROR', 'Restricted filesystem operation failed');
    } finally { await joined; active.delete(record); }
  }
  const targetPath = target => {
    const absolute = checkedPath(root, target?.targetKey);
    try { return checkedPath(root, realpathSync(absolute)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return checkedPath(root, path.join(checkedPath(root, realpathSync(path.dirname(absolute))), path.basename(absolute)));
    }
  };
  const serialize = async (target, action) => {
    const key = targetPath(target), old = mutationQueues.get(key) ?? Promise.resolve();
    const next = old.catch(() => {}).then(action); mutationQueues.set(key, next);
    try { return await next; } finally { if (mutationQueues.get(key) === next) mutationQueues.delete(key); }
  };
  const filesystem = {
    sandboxMode: 'workspace-write',
    resolve: async (value, opts = {}) => worker('resolve', { path: checkedPath(root, path.resolve(checkedPath(root, opts.cwd ?? root), value)) }, opts.signal),
    processPath: targetPath,
    processPathFromHostPath(value) { try { return targetPath({ targetKey: value }); } catch { return undefined; } },
    fileUrl: target => pathToFileURL(targetPath(target)).href,
    contains: (parent, child) => inside(targetPath(parent), targetPath(child)),
    stat: async (target, s) => (await worker('stat', { path: targetPath(target) }, s)) ?? undefined,
    lstat: async (value, opts = {}, s) => (await worker('lstat', { path: checkedPath(root, path.resolve(checkedPath(root, opts.cwd ?? root), value)) }, s)) ?? undefined,
    readText: async (target, s) => worker('readText', { path: targetPath(target) }, s),
    async streamText(target, s) { const value = await this.readText(target, s); return (async function* () { yield value; })(); },
    async readBytes(target, s, maxBytes = MAX_FILE) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_FILE) throw fail('FS_TOO_LARGE');
      return Buffer.from(await worker('readBytes', { path: targetPath(target), maxBytes }, s), 'base64');
    },
    async readByteRange(target, range, s) {
      if (!range || !Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length < 0 || range.length > MAX_FILE) throw fail('FS_TOO_LARGE');
      return Buffer.from(await worker('readByteRange', { path: targetPath(target), range }, s), 'base64');
    },
    listDir: async (target, s) => worker('listDir', { path: targetPath(target) }, s),
    writeText(target, content, expected, s, policy) { return serialize(target, () => worker('writeText', { path: targetPath(target), content, expected }, s, policy)); },
    editText(target, edit, expected, s, policy) { return serialize(target, () => worker('editText', { path: targetPath(target), edit, expected }, s, policy)); },
  };
  async function execute(request) {
    const spec = shell.resolve(request);
    await guard(spec.signal);
    await worker('verify', { path: root }, spec.signal, { mode: 'read-only', workspaceRoot: root });
    const workdir = await canonical(root, spec.workdir);
    let metrics;
    try { metrics = await readSystemMetrics(root,{signal:AbortSignal.any([...(signal?[signal]:[]),...(spec.signal?[spec.signal]:[])])}); }
    catch { await guard(spec.signal); } // Unavailable metrics must not break ordinary Bash.
    await guard(spec.signal);
    const wrapper = 'printf R >&3; IFS= read -r token <&4; [ "$token" = go ] || exit 125; exec 3>&- 4<&-; exec /bin/bash --noprofile --norc -c "$1"';
    const confined = await confine(['/bin/bash', '--noprofile', '--norc', '-c', wrapper, 'suna', systemMetricsShellFunction(metrics)+spec.command], spec.sandboxPolicy, spec.signal);
    const child = spawn(confined.argv[0], confined.argv.slice(1), { cwd: workdir, env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    const out = collector(spec.stdoutMaxBytes), err = collector(spec.stdoutMaxBytes);
    child.stdout.on('data', chunk => out.add(chunk)); child.stderr.on('data', chunk => err.add(chunk));
    let spawnError, session, cause, terminated = false, cleanupPromise, timer;
    const exited = new Promise(resolve => { child.once('error', e => { spawnError = e; }); child.once('close', (code, sig) => { handle.exitCode = code; handle.signal = sig; resolve(); }); });
    const combined = AbortSignal.any([...(signal ? [signal] : []), ...(spec.signal ? [spec.signal] : [])]);
    const stop = () => {
      if (terminated) return false;
      terminated = true;
      if (!session) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      return true;
    };
    async function drain() {
      if (!session) return;
      for (let attempt = 0; attempt < 100; attempt++) {
        const members = (await processTable()).filter(p => p.session === session);
        if (!members.length) return;
        // Stop every member before killing, so job-control process groups cannot
        // keep forking across the observation/termination pass.
        for (const member of members) { try { process.kill(member.pid, 'SIGSTOP'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
        for (const member of members) { try { process.kill(member.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw fail('NATIVE_PROCESS_RANGE_UNSETTLED', 'Restricted command process range did not terminate');
    }
    function requestStop(reason) { cause ??= reason; stop(); cleanupPromise ??= drain(); cleanupPromise.catch(() => {}); }
    // The shell's exit precedes stdio close when a background child inherited the
    // pipes. Foreground-only means terminate that remaining session immediately,
    // rather than waiting for the child (or the command deadline) to close them.
    child.once('exit', () => { cleanupPromise ??= drain(); cleanupPromise.catch(() => {}); });
    const onAbort = () => requestStop('aborted');
    let stdoutOffset = 0, stderrOffset = 0, resultPromise, settleError;
    const handle = {
      status: 'running', exitCode: null, signal: null,
      sandbox: { mode: policyMode(spec.sandboxPolicy), enforcement: 'full', denied: false },
      observed: { stdout: out, stderr: err },
      done: null,
      kill() { if (this.status !== 'running' || terminated) return false; requestStop('aborted'); return true; },
      readOutput() { const o = out.readFrom(stdoutOffset), e = err.readFrom(stderrOffset); stdoutOffset = o.nextOffset; stderrOffset = e.nextOffset; return { delta: o.text + (e.text ? `\n[stderr]\n${e.text}` : ''), lossy: o.lossy || e.lossy }; },
      result() { return resultPromise ??= this.done.then(() => { if (spawnError || settleError) throw spawnError ?? settleError; const o = out.readFrom(0), e = err.readFrom(0); return { exitCode: this.exitCode, signal: this.signal, timedOut: cause === 'timeout', aborted: cause === 'aborted', timeoutMs: spec.timeoutMs, stdout: { text: o.text, truncated: o.lossy }, stderr: { text: e.text, truncated: e.lossy }, sandbox: this.sandbox }; }); },
    };
    handle.done = exited.then(async () => {
      clearTimeout(timer); combined.removeEventListener('abort', onAbort);
      try { await (cleanupPromise ?? drain()); } catch (error) { settleError = error; }
      try { await guard(spec.signal); } catch (error) { if (!cause) settleError ??= error; }
      handle.status = cause || handle.signal || spawnError ? 'killed' : 'completed';
      handle.sandbox.denied = /operation not permitted|permission denied/i.test(err.readFrom(0).text);
      active.delete(handle);
    });
    active.add(handle);
    combined.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => requestStop('timeout'), spec.timeoutMs);
    try {
      await Promise.race([new Promise((resolve, reject) => { child.stdio[3].once('data', resolve); child.once('error', reject); child.once('exit', () => reject(fail('SANDBOX_UNAVAILABLE', 'Restricted shell could not start'))); }), new Promise((_, reject) => { const t = setTimeout(() => reject(fail('SANDBOX_UNAVAILABLE', 'Restricted shell handshake timed out')), 5000); t.unref(); })]);
      const identity = (await processTable()).find(p => p.pid === child.pid && p.pgid === child.pid);
      if (!identity || !identity.session || identity.session === '0') throw fail('SANDBOX_UNAVAILABLE', 'Cannot identify restricted command session');
      session = identity.session;
      await guard(spec.signal);
      if (terminated || combined.aborted) throw fail('FS_ABORTED');
      child.stdio[4].end('go\n');
      child.stdin.end(spec.stdin ?? '');
      return handle;
    } catch (error) { requestStop('aborted'); await handle.done; throw error; }
  }
  const shell = {
    sandboxMode: 'workspace-write',
    resolve(request) {
      if (!request || typeof request.command !== 'string' || request.command.includes('\0') || Buffer.byteLength(request.command) > 65536) throw fail('NATIVE_SHELL_INVALID');
      if (request.onExpiry && request.onExpiry !== 'kill') throw fail('NATIVE_SHELL_UNAVAILABLE', 'Only foreground commands are available');
      if ((request.env && Object.keys(request.env).length) || (request.dshEnv && Object.keys(request.dshEnv).length)) throw fail('NATIVE_ENV_DENIED', 'Explicit environment overrides are not available');
      const timeoutMs = request.timeoutMs ?? 30000, stdoutMaxBytes = request.stdoutMaxBytes ?? 65536;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isSafeInteger(stdoutMaxBytes) || stdoutMaxBytes < 1 || stdoutMaxBytes > MAX_OUTPUT) throw fail('NATIVE_SHELL_INVALID');
      policyMode(request.sandboxPolicy);
      return { command: request.command, workdir: checkedPath(root, request.workdir ?? root), timeoutMs, stdoutMaxBytes, onExpiry: 'kill', signal: request.signal, stdin: request.stdin, sandboxPolicy: request.sandboxPolicy };
    }, execute,
  };
  try { await worker('stat', { path: root }); }
  catch { closed = true; await fs.rm(privateDir, { recursive: true, force: true }); throw fail('SANDBOX_UNAVAILABLE', 'Restricted filesystem worker could not be verified'); }
  return {
    fs: filesystem, sandbox: { confine }, shell,
    capabilities: Object.freeze({ fs: true, bash: true, pwsh: false, jobs: false, pty: false, network: false }),
    async close() { closed = true; for (const item of active) item.kill(); await Promise.all([...active].map(item => item.done)); await fs.rm(privateDir, { recursive: true, force: true }); },
  };
}

if (process.argv[2] === '--suna-fs-worker') {
  let raw = '';
  try {
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > MAX_FILE * 2 + 65536) throw fail('FS_TOO_LARGE'); }
    const { op, input } = JSON.parse(raw);
    const value = await fsOperation(await fs.realpath(process.argv[3]), op, input);
    process.stdout.write(JSON.stringify({ value }));
  } catch (error) {
    const mappings = { ENOENT: 'FS_NOT_FOUND', ENOTDIR: 'FS_NOT_DIRECTORY', EACCES: 'FS_SANDBOX_DENIED', EPERM: 'FS_SANDBOX_DENIED', ELOOP: 'FS_SANDBOX_DENIED', EEXIST: 'FS_STALE_VERSION' };
    const code = mappings[error.code] ?? (String(error.code).startsWith('FS_') ? error.code : 'FS_IO_ERROR');
    process.stdout.write(JSON.stringify({ error: { code, message: code } }));
  }
}
