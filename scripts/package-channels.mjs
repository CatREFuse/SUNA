import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createZip, readZip, sha256, validateManifest } from '../src/channels/archive.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function packageChannels(outputDirectory = path.join(root, 'dist', 'plugins')) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const shared = await fs.readFile(path.join(root, 'plugins/channels/_shared/runtime.mjs'));
  const results = [], archives = [];
  for (const id of ['napcat', 'qq-official', 'weixin-official']) {
    const source = path.join(root, 'plugins/channels', id);
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
    const entry = (await fs.readFile(path.join(source, 'index.mjs'), 'utf8')).replace("'../_shared/runtime.mjs'", "'./runtime.mjs'");
    const files = new Map([['index.mjs', Buffer.from(entry)], ['runtime.mjs', shared]]);
    if(manifest.ui)files.set(manifest.ui.entry,await fs.readFile(path.join(source,manifest.ui.entry)));
    manifest.files = Object.fromEntries([...files].map(([name, data]) => [name, sha256(data)]));
    files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    validateManifest(manifest, files);
    const zip = createZip(files); validateManifest(manifest, readZip(zip));
    const filename = `${manifest.id}-${manifest.version}.zip`, destination = path.join(outputDirectory, filename);
    archives.push({ destination, zip });
    results.push({ id: manifest.id, version: manifest.version, path: destination, bytes: zip.length, sha256: sha256(zip) });
  }
  // A published version identifies immutable bytes. Check the whole batch before
  // writing, and use exclusive creation to cover concurrent packaging attempts.
  const checkExisting = async ({ destination, zip }) => {
    try {
      if (!(await fs.readFile(destination)).equals(zip)) throw new Error(`PACKAGE_VERSION_CONFLICT: ${path.basename(destination)} already exists with different bytes; bump the plugin version`);
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  for (const archive of archives) await checkExisting(archive);
  for (const archive of archives) {
    try { await fs.writeFile(archive.destination, archive.zip, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await checkExisting(archive); }
  }
  const portableManifest = results.map(result => ({ ...result, path: path.basename(result.path) }));
  await fs.writeFile(path.join(outputDirectory, 'channels-manifest.json'), `${JSON.stringify(portableManifest, null, 2)}\n`);
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await packageChannels(process.argv[2] ? path.resolve(process.argv[2]) : undefined), null, 2));
