import {applyPluginConfigurationChanges, projectPluginConfiguration} from './plugin-management-schema.mjs';

const fail = code => { throw Object.assign(new Error(code), {code}); };

/** Configuration access uses already loaded official schemas; reading a form never imports an inspected package. */
export function createDshConfigurationAccess(ctx, {targetId, generation, revision,
  isNativeConfigSchema, isProtected = () => false, isBusy = () => false} = {}) {
  const binding = input => {
    if (input.targetId !== targetId || input.generation !== generation) fail('DSH_PLUGIN_TARGET_CHANGED');
  };
  function find(entryId) {
    const editor = ctx.get('configEditor');
    if (!editor) fail('DSH_PLUGIN_UNSUPPORTED');
    const entry = editor.entries().find(entry => entry.id === entryId);
    if (!entry || entry.fiber?.state !== 2) fail('DSH_PLUGIN_SCHEMA_UNSUPPORTED');
    return {editor, entry};
  }
  function projection(entry) {
    return projectPluginConfiguration(entry.fiber.runtime.Config, entry.options.config ?? {}, {isNativeConfigSchema});
  }
  return {
    read(input) {
      binding(input);
      const {entry} = find(input.entryId);
      const current = revision();
      const form = isProtected(entry) ? {fields: [], values: {}, hasSecrets: [], readOnly: true,
        reason: 'DSH_PLUGIN_PROTECTED'} : projection(entry);
      return {targetId, generation, revision: current, entryId: input.entryId, ...form};
    },
    canConfigure(entryId) {
      try {
        const {entry} = find(entryId);
        return !isProtected(entry) && !projection(entry).readOnly;
      } catch { return false; }
    },
    async configure(input) {
      binding(input);
      if (isBusy()) fail('DSH_PLUGIN_BUSY');
      if (revision() !== input.expectedRevision) fail('DSH_PLUGIN_CONFLICT');
      const {editor, entry} = find(input.entryId);
      if (isProtected(entry)) fail('DSH_PLUGIN_PROTECTED');
      await editor.edit(entry, current => {
        // Official ConfigEditor calls this after acquiring the cross-process writer lock and reconciling disk.
        binding(input);
        if (isBusy()) fail('DSH_PLUGIN_BUSY');
        if (revision() !== input.expectedRevision) fail('DSH_PLUGIN_CONFLICT');
        if (isProtected(entry)) fail('DSH_PLUGIN_PROTECTED');
        return applyPluginConfigurationChanges(entry.fiber.runtime.Config, current, input.changes, {isNativeConfigSchema});
      });
      return {application: 'applied', target: input.entryId};
    },
  };
}
