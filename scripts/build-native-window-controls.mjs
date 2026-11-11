import { access, readdir, realpath, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  child.once('error', reject); child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(output || 'Native build failed')));
});
export async function buildNativeWindowControls({ arch = process.env.SAND_TARGET_ARCH || process.arch, headers = process.env.SAND_NODE_API_HEADERS } = {}) {
  if (process.platform !== 'darwin') return { skipped: true, reason: 'macOS only' };
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported native control architecture');
  if (!headers) {
    const pnpm = path.join(root, 'runtime/dsh/node_modules/.pnpm');
    for (const entry of (await readdir(pnpm)).filter(name => /^koffi@/.test(name)).sort()) {
      const candidate = path.join(pnpm, entry, 'node_modules/koffi/vendor/node-api-headers/include');
      try { await access(path.join(candidate, 'node_api.h')); headers = candidate; break; } catch {}
    }
  }
  if (!headers) throw new Error('Node-API headers unavailable; set SAND_NODE_API_HEADERS during the build');
  headers = await realpath(headers);
  for (const name of ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']) await access(path.join(headers, name));
  const source = path.join(root, 'desktop/native-window-controls.mm'), output = path.join(root, `desktop/native-window-controls-darwin-${arch}.node`), temporary = output + '.' + randomUUID();
  const sdk = await run('/usr/bin/xcrun', ['--show-sdk-path']);
  try {
    await run('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup', '-DNAPI_VERSION=8', '-mmacosx-version-min=12.0', '-arch', arch === 'x64' ? 'x86_64' : arch, '-isysroot', sdk, '-I', headers, source, '-framework', 'Cocoa', '-o', temporary]);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'app.sandbook.native-window-controls.' + arch, temporary]); await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
  const report = { createdAt: new Date().toISOString(), platform: 'darwin', arch, nodeApi: 8, output: path.relative(root, output), sha256: createHash('sha256').update(await readFile(output)).digest('hex'), dependencies: (await run('/usr/bin/otool', ['-L', output])).replace(output, path.basename(output)), signing: 'ad-hoc; production app signing follows packaging' };
  await writeFile(path.join(root, `desktop/native-window-controls-build-${arch}.json`), JSON.stringify(report, null, 2)); return report;
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildNativeWindowControls({ arch: process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : undefined }), null, 2));
