import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const readPackage = async root => JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

// Resolve package roots without assuming that package.json or "." is exported.
async function resolvePackage(name, fromRoot) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) fail('IMAGE_DEPENDENCY_INVALID');
  const require = createRequire(path.join(fromRoot, 'package.json'));
  for (const base of require.resolve.paths(name) ?? []) {
    const root = path.join(base, name);
    try {
      const resolved = await realpath(root);
      const pkg = await readPackage(resolved);
      if (pkg.name !== name || typeof pkg.version !== 'string') fail('IMAGE_DEPENDENCY_INVALID');
      return { root: resolved, pkg };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  fail('IMAGE_DEPENDENCY_MISSING');
}

const supportsHost = pkg => {
  const allows = (list, value) => !list || (!list.includes('!' + value) && (!list.some(item => !item.startsWith('!')) || list.includes(value)));
  return allows(pkg.os, process.platform) && allows(pkg.cpu, process.arch);
};
async function verifyPortable(root, dir = root) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (!inside(root, await realpath(file))) fail('IMAGE_DEPENDENCY_EXTERNAL_SYMLINK');
    } else if (entry.isDirectory()) await verifyPortable(root, file);
  }
}

export async function stageImageDependencies({ projectRoot, backendStage }) {
  const project = await readPackage(projectRoot);
  const pin = project.dependencies?.sharp;
  if (typeof pin !== 'string' || !/^\d+\.\d+\.\d+$/.test(pin)) fail('IMAGE_DEPENDENCY_NOT_PINNED');
  const sharp = await resolvePackage('sharp', projectRoot);
  if (sharp.pkg.version !== pin) fail('IMAGE_DEPENDENCY_VERSION_MISMATCH');
  const libc = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? 'linuxmusl' : process.platform;
  const nativeName = `@img/sharp-${libc}-${process.arch}`;
  const vipsName = `@img/sharp-libvips-${libc}-${process.arch}`;
  if (!sharp.pkg.optionalDependencies?.[nativeName]) fail('IMAGE_DEPENDENCY_PLATFORM_UNSUPPORTED');
  const packages = new Map();
  async function visit(name, parent, required = true, requestedVersion) {
    let item;
    try { item = await resolvePackage(name, parent); }
    catch (error) { if (!required && error.code === 'IMAGE_DEPENDENCY_MISSING') return; throw error; }
    if (typeof requestedVersion === 'string' && /^\d+\.\d+\.\d+$/.test(requestedVersion) && item.pkg.version !== requestedVersion) fail('IMAGE_DEPENDENCY_VERSION_MISMATCH');
    if (!supportsHost(item.pkg)) { if (required) fail('IMAGE_DEPENDENCY_PLATFORM_MISMATCH'); return; }
    const existing = packages.get(name);
    if (existing) {
      if (existing.root !== item.root || existing.pkg.version !== item.pkg.version) fail('IMAGE_DEPENDENCY_CONFLICT');
      return;
    }
    packages.set(name, item);
    for (const [dependency, version] of Object.entries(item.pkg.dependencies ?? {})) await visit(dependency, item.root, true, version);
    for (const dependency of Object.keys(item.pkg.optionalDependencies ?? {})) {
      // Native packages for other architectures are intentionally not part of this artifact.
      if (dependency.startsWith('@img/sharp-') && dependency !== nativeName && dependency !== vipsName) continue;
      await visit(dependency, item.root, dependency === nativeName || dependency === vipsName, item.pkg.optionalDependencies[dependency]);
    }
  }
  await visit('sharp', projectRoot);
  if (!packages.has(nativeName)) fail('IMAGE_DEPENDENCY_MISSING');
  const modules = path.join(backendStage, 'node_modules');
  await mkdir(modules, { recursive: true });
  // Review the complete closure before writing any package.
  for (const [name, item] of packages) {
    await verifyPortable(item.root);
    try { await lstat(path.join(modules, name)); fail('IMAGE_DEPENDENCY_DESTINATION_CONFLICT'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const [name, item] of packages) {
    const destination = path.join(modules, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(item.root, destination, { recursive: true, dereference: true, errorOnExist: true, force: false,
      filter: source => !path.relative(item.root, source).split(path.sep).includes('node_modules') });
  }
  const report = { platform: process.platform, arch: process.arch, packages: Object.fromEntries([...packages].map(([name, item]) => [name, item.pkg.version])) };
  await writeFile(path.join(backendStage, 'image-dependencies.json'), JSON.stringify(report, null, 2));
  return report;
}
