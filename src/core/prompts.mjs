/** Prompt rendering intentionally does not use eval, Function or HTML parsing. */
export const VARIABLE_NAMES = ['character_name','persona_immutable','persona_mutable','backgrounds','temper','trait','habit','dialogue','emotion','environment','work_conv','work_entries','state','state_updated','work_memory','work_memory_updated','recalled_memories','recent_messages','user_input','system_time','language','expressions','persona','recent_diaries','system_language','elapsed_minutes','associate_memory','dream_sampled_messages','worker_input','diary_sampled_messages','source_messages','tone_recent_dialogs','message_context','memory.user_profile','utils.roll'];

export function condition(expression, variables = {}) {
  if (expression.length > 512) throw new Error('条件表达式不能超过 512 字符');
  const tokens = expression.match(/\s+|===|!==|==|!=|&&|\|\||<=|>=|[!<>()]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|[A-Za-z_][\w.]*/g) ?? [];
  if (tokens.join('') !== expression || tokens.length > 128) throw new Error('条件表达式无效');
  const ts = tokens.filter(t => t.trim()); let cursor = 0; let depth = 0;
  function atom() {
    if (++depth > 32) throw new Error('条件表达式嵌套过深');
    const token = ts[cursor++]; let value;
    if (token === '!') value = !atom();
    else if (token === '(') { value = or(); if (ts[cursor++] !== ')') throw new Error('条件括号不匹配'); }
    else if (token === 'true' || token === 'false') value = token === 'true';
    else if (token === 'null') value = null;
    else if (/^-?\d/.test(token ?? '')) value = Number(token);
    else if (/^["']/.test(token ?? '')) value = token[0] === '"' ? JSON.parse(token) : token.slice(1,-1).replace(/\\'/g,"'");
    else if (/^[A-Za-z_]\w*(?:\.\w+)*$/.test(token ?? '')) { if (!Object.hasOwn(variables, token)) throw new Error(`未知条件变量：${token}`); value = variables[token]; }
    else throw new Error('条件表达式缺少值');
    depth--; return value;
  }
  function compare() { let a = atom(); const op = ts[cursor]; if (['==','===','!=','!==','<','>','<=','>='].includes(op)) { cursor++; const b = atom(); a = op === '==' || op === '===' ? a === b : op === '!=' || op === '!==' ? a !== b : op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b; } return a; }
  function and() { let a = compare(); while (ts[cursor] === '&&') { cursor++; const b = compare(); a = Boolean(a && b); } return a; }
  function or() { let a = and(); while (ts[cursor] === '||') { cursor++; const b = and(); a = Boolean(a || b); } return a; }
  const value = or(); if (cursor !== ts.length) throw new Error('条件表达式包含不支持的运算'); return Boolean(value);
}

function renderConditions(text, variables) {
  const pattern = /<([A-Za-z][\w:.-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  let match;
  while ((match = pattern.exec(text))) {
    const [opening, tag] = match;
    const conditional=opening.match(/\s+s-if\s*=\s*(["'])(.*?)\1/);
    if(!conditional)continue;
    const expression=conditional[2];
    const decoded = expression.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"');
    const enabled = condition(decoded, variables);
    const clean = opening.replace(/\s+s-if\s*=\s*(["']).*?\1/, '');
    let end = match.index + opening.length; let inner = ''; let closing = '';
    if (!/\/\s*>$/.test(opening)) {
      const nested = new RegExp(`<(/?)${tag}(?=[\\s/>])[^>]*>`, 'g'); nested.lastIndex = end;
      let depth = 1; let next;
      while ((next = nested.exec(text))) {
        if (next[1]) depth--; else if (!/\/\s*>$/.test(next[0])) depth++;
        if (!depth) { inner = text.slice(end, next.index); closing = next[0]; end = nested.lastIndex; break; }
      }
      if (depth) throw new Error(`条件块 <${tag}> 缺少闭合标签`);
    }
    const replacement = enabled ? clean + renderConditions(inner, variables) + closing : '';
    text = text.slice(0,match.index) + replacement + text.slice(end); pattern.lastIndex = match.index + replacement.length;
  }
  if (/\bs-if\s*=/.test(text)) throw new Error('条件标签格式无效');
  return text;
}

const rollPattern = /{{\s*utils\.roll\s*}}|@\{utils\.roll\}/g;
const personaVariables = new Set(['persona', 'persona_immutable', 'persona_mutable', 'backgrounds', 'temper', 'trait', 'habit', 'dialogue']);
const stableRuntimeVariables = new Set(['character_name', ...personaVariables, 'expressions', 'language', 'system_language']);

function deferConditions(content, fragments) {
  const opening = /<([A-Za-z][\w:.-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  let match;
  while ((match = opening.exec(content))) {
    if (!/\bs-if\s*=/.test(match[0])) continue;
    let end = opening.lastIndex;
    if (!/\/\s*>$/.test(match[0])) {
      const nested = new RegExp(`<(/?)${match[1]}(?=[\\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>`, 'g');
      nested.lastIndex = end;
      let depth = 1, next;
      while ((next = nested.exec(content))) {
        if (next[1]) depth--; else if (!/\/\s*>$/.test(next[0])) depth++;
        if (!depth) { end = nested.lastIndex; break; }
      }
      if (depth) throw new Error(`条件块 <${match[1]}> 缺少闭合标签`);
    }
    fragments.push(content.slice(match.index, end));
    content = content.slice(0, match.index) + content.slice(end);
    opening.lastIndex = match.index;
  }
  return content;
}

/** Keep changing values out of DSH's append-only system-message history. */
export function assembleRuntimePrompts({ system, developer = '', input, variables }, options = {}) {
  const rollBindings = [], dynamicValues = {}, fragments = [];
  function stable(content) {
    // Conditional blocks belong to the dynamic input: evaluating them in system
    // would change that entire message when an update becomes empty/nonempty.
    const withoutConditions = deferConditions(content, fragments);
    const bound = withoutConditions.replace(/{{\s*([\w.]+)\s*}}/g, (match, name) => {
      if (name === 'utils.roll' || stableRuntimeVariables.has(name) || !Object.hasOwn(variables, name)) return match;
      dynamicValues[name] = variables[name];
      return `本轮动态变量 ${name}`;
    });
    return renderPrompt(bound, variables, { ...options, rollBindings }).text;
  }
  const systemPrompt = stable(system), developerPrompt = developer ? stable(developer) : '';
  const prompt = systemPrompt + (!options.separateDeveloper && developerPrompt ? '\n\n' + developerPrompt : '');
  let inputPrompt = renderPrompt(input, variables, options).text;
  for (const fragment of fragments) {
    const text = renderPrompt(fragment, variables, options).text;
    if (text) inputPrompt += '\n' + text;
  }
  for (const binding of rollBindings) dynamicValues[binding.name] = binding.value;
  if (Object.keys(dynamicValues).length) inputPrompt += `\n<runtime_variables>${JSON.stringify(dynamicValues)}</runtime_variables>`;
  return options.separateDeveloper ? { prompt, developerPrompt, inputPrompt } : { prompt, inputPrompt };
}

function rollInteger() {
  // This module is shared with the browser prompt editor. Rejection sampling
  // avoids modulo bias without importing a Node-only module into its bundle.
  const word = new Uint32Array(1), limit = 2 ** 32 - (2 ** 32 % 100);
  do { globalThis.crypto.getRandomValues(word); } while (word[0] >= limit);
  return word[0] % 100 + 1;
}

export function renderPrompt(content, variables = {}, { strict = true, roll = rollInteger, rollBindings } = {}) {
  // Stable system text may refer to values carried in this turn's user input.
  // Sampling still happens independently for every evaluated occurrence.
  function expandRolls(text) {
    return text.replace(rollPattern, () => {
      const value = roll();
      if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('utils.roll 必须返回 1 至 100 的整数');
      if (!rollBindings) return String(value);
      const name = `utils.roll.${rollBindings.length + 1}`;
      rollBindings.push({ name, value });
      return `本轮动态变量 ${name}`;
    });
  }
  const refs = [...content.matchAll(/{{\s*([\w.]+)\s*}}/g)].map(m=>m[1]);
  const missing = [...new Set(refs.filter(name=>name !== 'utils.roll' && !Object.hasOwn(variables,name)))];
  if (strict && missing.length) throw new Error(`未知提示词变量：${missing.join('、')}`);
  const conditional = renderConditions(content, variables);
  // Expand only authored templates and persona fields. User messages, recalled
  // documents and tool output containing this literal are never evaluated.
  const text = conditional.replace(/{{\s*([\w.]+)\s*}}|@\{utils\.roll\}/g, (match,name)=> {
    if (name === 'utils.roll' || match === '@{utils.roll}') return expandRolls(match);
    const value = variables[name];
    const serialized = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    return personaVariables.has(name) ? expandRolls(serialized) : serialized;
  });
  return { text, missing, variables: [...new Set([...refs, ...(content.includes('@{utils.roll}') ? ['utils.roll'] : [])])] };
}

export function validatePrompt(content, { scope = 'runtime', variables = VARIABLE_NAMES } = {}) {
  const errors = []; const registry = Object.fromEntries(variables.map(k=>[k,'']));
  if (typeof content !== 'string' || content.length > 250_000) return {valid:false,errors:['提示词必须为不超过 250000 字符的文本'],variables:[]};
  let refs = [];
  try { const rendered = renderPrompt(content, registry, { roll: () => 1 }); refs = rendered.variables; } catch (error) { errors.push(error.message); }
  if (scope === 'worker') {
    try { const parsed = JSON.parse(content); if (!Array.isArray(parsed.messages) || !parsed.messages.every(m=>['system','developer','user','assistant'].includes(m.role) && typeof m.content === 'string')) errors.push('Worker messages 必须包含合法 role 和 content'); const format=parsed.response_format;if(format&&!['text','json_object','json_schema'].includes(format.type))errors.push('Worker response_format 类型无效');if(format?.type==='json_schema'&&(!format.json_schema?.schema||typeof format.json_schema.schema!=='object'))errors.push('Worker json_schema 缺少 schema'); } catch { errors.push('Worker JSON 格式无效'); }
  }
  return { valid:errors.length===0, errors, variables:refs };
}
