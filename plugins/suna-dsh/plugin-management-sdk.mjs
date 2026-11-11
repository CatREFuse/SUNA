import {createRequire} from 'node:module';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {managementFailure} from './plugin-management-errors.mjs';

async function resolver(root, anchor) {
  root = await realpath(root);
  async function owned(filename) {
    const file = await realpath(filename), relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
    return file;
  }
  const require = createRequire(await owned(anchor));
  return {owned, resolve: async name => owned(require.resolve(name)),
    load: async name => import(pathToFileURL(await owned(require.resolve(name))).href)};
}

/** Resolve through the selected distribution, with no fallback to the Client project's dependency graph. */
export async function loadDshProfileLock(root, anchor) {
  const {load} = await resolver(root, anchor);
  const sdk = await load('@deepseek-ai/dsh-atomic-write');
  if (typeof sdk.withFileLock !== 'function') throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
  return sdk.withFileLock;
}

export async function loadDshManagementSdk({root, anchor, archiveParserPath}) {
  const {owned, load, resolve} = await resolver(root, anchor);
  const yamlPath = await owned(createRequire(await resolve('@deepseek-ai/dsh-config-editor')).resolve('yaml'));
  const [boot, atomic, manager, operations, yaml] = await Promise.all([
    load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-atomic-write'),
    load('@deepseek-ai/dsh-plugin-manager'), load('@deepseek-ai/dsh-plugin-manager/operations'), import(pathToFileURL(yamlPath).href),
  ]);
  const tar = await import(pathToFileURL(await owned(archiveParserPath)).href);
  const semver = await import(pathToFileURL(await owned(createRequire(await resolve('@deepseek-ai/dsh-plugin-manager')).resolve('semver'))).href);
  if (typeof tar.Parser !== 'function') throw managementFailure('DSH_PLUGIN_UNSUPPORTED');
  return {...boot, ...atomic, ...operations, classifyInstallFailure: manager.classifyInstallFailure, parseInstallSpec: manager.parseInstallSpec,
    semver: semver.default ?? semver,
    requiredRuntimeModuleNames: ['@deepseek-ai/dsh-agent-loop', pathToFileURL(await resolve('@deepseek-ai/dsh-agent-loop')).href],
    npmCliPath: await owned(path.join(root, 'package-managers/npm/bin/npm-cli.js')),
    parseDocument: yaml.parseDocument, isMap: yaml.isMap, isSeq: yaml.isSeq,
    parseYaml: yaml.parse, createArchiveParser: options => new tar.Parser(options)};
}
