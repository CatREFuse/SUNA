/** Standard Chat editing helpers. Unknown fields survive a structured edit. */
export function parseWorkerContent(text) {
  try {
    const config = JSON.parse(text);
    if (!config || Array.isArray(config) || !Array.isArray(config.messages) || !config.messages.every(message => message && ['system', 'developer', 'user', 'assistant'].includes(message.role) && typeof message.content === 'string')) throw new Error('messages 必须包含标准 role 和 content');
    if (config.response_format && !['text', 'json_object', 'json_schema'].includes(config.response_format.type)) throw new Error('response_format 类型无效');
    return { config, error: '' };
  } catch (error) { return { config: null, error: error.message }; }
}

export function serializeWorkerContent(config, schemaText) {
  if (config.response_format?.type !== 'json_schema' || schemaText === undefined) return JSON.stringify(config, null, 2);
  let marker = '__SUNA_SCHEMA_EDITOR_CONTENT__';
  const original = JSON.stringify(config);
  while (original.includes(marker)) marker += '_';
  const copy = { ...config, response_format: { ...config.response_format, json_schema: { ...config.response_format.json_schema, schema: marker } } };
  // Keep a partially typed JSON schema in the draft instead of reverting the user's input.
  return JSON.stringify(copy, null, 2).replace(JSON.stringify(marker), schemaText);
}

export function withDeveloperMessages(messages, enabled, cached = []) {
  const existing = messages.filter(message => message.role === 'developer');
  if (!enabled) return { messages: messages.filter(message => message.role !== 'developer'), cached: existing.length ? existing : cached };
  if (existing.length) return { messages: [...messages], cached: existing };
  const next = [...messages];
  let index = 0;
  while (next[index]?.role === 'system') index++;
  next.splice(index, 0, ...(cached.length ? cached : [{ role: 'developer', content: '' }]));
  return { messages: next, cached };
}

export function insertPromptVariable(text, start, end, name, xml = false) {
  if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error('变量名无效');
  const slot = `{{${name}}}`, value = xml ? `<${name}>${slot}</${name}>` : slot;
  return { text: text.slice(0, start) + value + text.slice(end), cursor: start + value.length };
}
