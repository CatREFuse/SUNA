const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
const text = value => typeof value === 'string' ? value : '';
const copy = value => structuredClone(value);
const statuses = new Set(['queued', 'running', 'ready', 'completed', 'failed', 'cancelled', 'interrupted']);
const safeStatus = value => statuses.has(value) ? value : 'unknown';

function parameters(input) {
  if (!input || typeof input.characterId !== 'string' || !input.characterId.trim()) fail('必须指定角色');
  for (const key of ['offset', 'limit']) if (input[key] !== undefined && typeof input[key] !== 'number' && !(typeof input[key] === 'string' && /^\d+$/.test(input[key]))) fail('分页参数无效');
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  const limit = input.limit === undefined ? 30 : Number(input.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('分页参数无效');
  if (input.query !== undefined && (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 1000)) fail('搜索内容不能为空且不能超过 1000 字符');
  return { characterId: input.characterId, offset, limit, query: input.query?.trim().toLocaleLowerCase() };
}

const recent = items => items.sort((a, b) => text(b.createdAt ?? b.time).localeCompare(text(a.createdAt ?? a.time)) || text(a.id).localeCompare(text(b.id)));
const page = (items, { offset, limit }) => ({ items: items.slice(offset, offset + limit), total: items.length, offset, limit });
const matches = (query, values) => query === undefined || values.some(value => text(value).toLocaleLowerCase().includes(query));

/** Read-only projections. character() must validate an open book and role ownership;
 * list() and memoryStore must belong to that same book. No filesystem access.
 * Omitted query browses all; a supplied empty query is rejected, never broadened.
 * Optional relations(characterId) supplies {memory_id,related_id,desc} edges.
 */
export function createCharacterMemoryView({ character, list, memoryStore, relations }) {
  if (typeof character !== 'function' || typeof list !== 'function' || typeof memoryStore?.list !== 'function') throw new TypeError('角色记忆浏览缺少数据源');

  function get(input = {}) {
    const options = parameters(input), { characterId, query } = options;
    const person = character(characterId);
    const source = input.source ?? 'working';
    if (!['working', 'long'].includes(source)) fail('未知记忆来源');
    let items;
    if (source === 'working') {
      items = list('memory').filter(item => item.characterId === characterId).map(item => ({
        id: item.id, characterId, time: text(item.time ?? item.createdAt), createdAt: text(item.createdAt ?? item.time),
        desc: text(item.desc ?? item.text ?? item.content), source: text(item.source), fiction: item.fiction === true,
        ...(Number.isFinite(item.impression_score) ? { impression_score: item.impression_score } : {}),
        sourceConversationId: text(item.sourceConversationId),
        sourceMessageIds: Array.isArray(item.sourceMessageIds) ? item.sourceMessageIds.filter(id => typeof id === 'string') : [],
      }));
    } else {
      const all = memoryStore.list(characterId), ids = new Set(all.map(item => item.id));
      const edges = typeof relations === 'function' ? relations(characterId).filter(edge => ids.has(edge.memory_id) && ids.has(edge.related_id)) : [];
      items = all.map(item => ({
        id: item.id, characterId, time: text(item.time), desc: text(item.desc),
        covered: ids.has(item.covered) ? item.covered : null,
        coveredBy: all.filter(next => next.covered === item.id).map(next => next.id),
        evidence: Array.isArray(item.evidence) ? item.evidence.map(entry => ({ source_message: text(entry.source_message), quote: text(entry.quote) })) : [],
        ...(typeof relations === 'function' ? { related: edges.flatMap(edge => edge.memory_id === item.id ? [{ id: edge.related_id, relation: text(edge.desc) }] : edge.related_id === item.id ? [{ id: edge.memory_id, relation: text(edge.desc) }] : []) } : {}),
      }));
    }
    const filtered = recent(items.filter(item => matches(query, [item.desc, item.source, ...(item.evidence ?? []).map(entry => entry.quote)])));
    return copy({ characterId, source, workSummary: source === 'working' ? text(person.workSummary) : '', relationsAvailable: source === 'long' && typeof relations === 'function', ...page(filtered, options) });
  }

  function dreams(input = {}) {
    const options = parameters(input), { characterId, query } = options;
    character(characterId);
    const rawTasks = list('worker-task').filter(task => task.args?.characterId === characterId && ['dream', 'dream_cycle'].includes(task.type));
    const tasks = recent(rawTasks.map(task => ({
      id: task.id, type: task.type, characterId, status: safeStatus(task.status),
      createdAt: text(task.createdAt), startedAt: text(task.startedAt), finishedAt: text(task.finishedAt),
      // Never expose provider errors, frozen snapshots, arguments, logs or intermediate results.
      error: task.status === 'failed' ? '梦境任务执行失败' : '',
      steps: Array.isArray(task.steps) ? task.steps.map(step => ({ name: text(step.name), status: safeStatus(step.status), startedAt: text(step.startedAt), finishedAt: text(step.finishedAt) })) : [],
    })));
    const items = recent(list('dream').filter(item => item.characterId === characterId).map(item => {
      const task = rawTasks.find(task => item.id === `${task.id}:dream:content` || item.id === `${task.id}:dream` || item.id === task.id);
      return { id: item.id, characterId, content: text(item.content), fiction: item.fiction === true, createdAt: text(item.createdAt), taskId: task?.id ?? null, status: task ? safeStatus(task.status) : null };
    }).filter(item => matches(query, [item.content])));
    // Task history has its own total, using the same bounded pagination. Content
    // search only returns tasks associated with matching persisted dreams.
    const filteredTasks = query === undefined ? tasks : tasks.filter(task => items.some(item => item.taskId === task.id));
    return copy({ characterId, ...page(items, options), tasks: filteredTasks.slice(options.offset, options.offset + options.limit), taskTotal: filteredTasks.length });
  }
  return { get, dreams };
}
