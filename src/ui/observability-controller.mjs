const categories = new Set(['all', 'client-function', 'client-worker', 'runtime-loop']);
const normalize = context => ({enabled: context?.enabled === true, conversationId: typeof context?.conversationId === 'string' ? context.conversationId : '', category: categories.has(context?.category) ? context.category : 'runtime-loop', roundSelection: typeof context?.roundSelection === 'string' ? context.roundSelection : null});
const same = (a, b) => a.enabled === b.enabled && a.conversationId === b.conversationId && a.category === b.category && a.roundSelection === b.roundSelection;
const allowed = context => context.enabled && Boolean(context.conversationId);
const denied = error => error?.status === 403 || error?.code === 'DEVELOPER_MODE_REQUIRED';

/** Owns only developer-log requests; never closes the shared application SSE. */
export function createObservabilityController({request, onChange, readContext}) {
  let context = normalize(), state = {page: null, loading: false, error: ''};
  let generation = 0, active = null, closed = false, pendingRefresh = false, blocked = false;
  const publish = patch => { state = {...state, ...patch}; onChange({...state}); };
  function clear() {
    generation++;
    active?.abort.abort();
    active = null; pendingRefresh = false;
    publish({page: null, loading: false, error: ''});
  }
  function live() {
    if (closed) return false;
    // The host may change context between Vue's watch flush and a network reply.
    if (readContext) {
      const latest = normalize(readContext());
      if (!same(context, latest)) { void setContext(latest); return false; }
    }
    return allowed(context) && !blocked;
  }
  function setContext(value = readContext?.()) {
    if (closed) return Promise.resolve();
    const next = normalize(value);
    if (same(context, next)) return active?.promise ?? Promise.resolve();
    context = next; blocked = false; clear();
    return allowed(context) ? load(false) : Promise.resolve();
  }
  function load(append) {
    if (!live()) return Promise.resolve();
    if (active) return active.promise;
    if (append && (!state.page?.hasMore || state.page.nextBeforeSequence == null)) return Promise.resolve();
    const ticket = generation, abort = new AbortController();
    const params = new URLSearchParams({limit: '50'});
    if (context.category !== 'all') params.set('category', context.category);
    if (context.roundSelection) {
      const selected = context.roundSelection;
      const pinnedRound = append && selected === 'latest' ? state.page?.selectedRoundId : null;
      params.set('roundScope', pinnedRound || selected.startsWith('round:') ? 'round' : selected === 'unassigned' ? 'unassigned' : 'latest');
      if (pinnedRound || selected.startsWith('round:')) params.set('roundId', pinnedRound ?? selected.slice(6));
    }
    if (append) params.set('beforeSequence', String(state.page.nextBeforeSequence));
    const path = `/developer/conversations/${encodeURIComponent(context.conversationId)}/observability?${params}`;
    const current = {abort, promise: null};
    active = current;
    publish({loading: true, error: ''});
    current.promise = Promise.resolve().then(() => {
      if (ticket !== generation || closed || abort.signal.aborted) return null;
      return request(path, undefined, 'GET', false, abort.signal);
    }).then(page => {
      if (ticket !== generation || !live() || abort.signal.aborted || !page) return;
      if (context.roundSelection && !Array.isArray(page.rounds)) {
        blocked = true; pendingRefresh = false;
        publish({page: null, error: '当前服务不支持按轮次查看日志'});
        return;
      }
      if (state.page && state.page.selectedRoundId === page.selectedRoundId) {
        const previous = state.page;
        // Refresh updates known rows without discarding pages already opened.
        const updates = new Map(page.items.map(item => [item.id, item]));
        const sequenceUpdates = new Map(page.items.map(item => [item.sequence, item]));
        const ids = new Set(), sequences = new Set();
        const items = [...previous.items.map(item => {
          const update = updates.get(item.id) ?? sequenceUpdates.get(item.sequence);
          return update ? {...update, id: item.id} : item;
        }), ...page.items].filter(item => {
          if (ids.has(item.id) || sequences.has(item.sequence)) return false;
          ids.add(item.id); sequences.add(item.sequence); return true;
        }).sort((a, b) => b.sequence - a.sequence);
        const cursor = !append && previous.items.length ? {nextBeforeSequence: previous.nextBeforeSequence, hasMore: previous.hasMore} : {};
        publish({page: {...page, ...cursor, items}});
      } else publish({page});
    }).catch(error => {
      if (ticket !== generation || !live() || abort.signal.aborted) return;
      if (denied(error)) {
        blocked = true; pendingRefresh = false;
        publish({page: null, error: '开发日志不可用，请确认开发者模式'});
      } else publish({error: '读取日志失败，请重试'});
    }).finally(() => {
      if (ticket !== generation || active !== current || closed) return;
      active = null;
      publish({loading: false});
      if (pendingRefresh) { pendingRefresh = false; void load(false); }
    });
    return current.promise;
  }
  function refresh() { return load(false); }
  function more() { return load(true); }
  function onEvent(event) {
    if (event?.type !== 'conversation-observability.changed' || !live() || event.conversationId !== context.conversationId) return;
    if (active) pendingRefresh = true;
    else void refresh();
  }
  function close() {
    if (closed) return;
    closed = true; blocked = true; clear();
  }
  return {setContext, refresh, more, onEvent, close};
}
