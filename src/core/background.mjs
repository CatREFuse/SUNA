const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_CRON' }); };
const aliases = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };

/** Numeric five-field cron: lists, inclusive ranges, steps and standard @ aliases. */
export function parseCron(expression) {
  if (typeof expression !== 'string' || expression.length > 256) fail('cron 表达式必须为文本');
  const normalized = aliases[expression.trim()] ?? expression.trim();
  const fields = normalized.split(/\s+/); if (fields.length !== 5) fail('cron 需要分钟、小时、日、月、星期五个字段');
  const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const names = ['minute', 'hour', 'day', 'month', 'weekday'];
  const result = { expression: normalized };
  fields.forEach((field, index) => {
    const [minimum, maximum] = limits[index], values = new Set();
    for (const piece of field.split(',')) {
      if (!/^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/.test(piece)) fail(`cron 字段无效：${field}`);
      const [range, stepText] = piece.split('/'), step = stepText ? Number(stepText) : 1;
      if (!Number.isInteger(step) || step < 1 || step > maximum - minimum + 1) fail(`cron 步长无效：${piece}`);
      let from, to;
      if (range === '*') [from, to] = [minimum, maximum];
      else if (range.includes('-')) [from, to] = range.split('-').map(Number);
      else { from = Number(range); to = stepText ? maximum : from; }
      if (from < minimum || to > maximum || from > to) fail(`cron 数值超出范围：${piece}`);
      for (let value = from; value <= to; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    result[names[index]] = [...values].sort((a, b) => a - b);
  });
  result.dayAny = fields[2] === '*'; result.weekdayAny = fields[4] === '*';
  return result;
}

function formatter(timeZone) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { fail('无效时区'); }
}

/** Return ISO timestamp strictly after `after`. DOM/DOW use normal cron OR semantics. */
export function nextRun(expression, { after = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, maxYears = 5 } = {}) {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;
  if (!cron || !Array.isArray(cron.minute)) fail('cron 解析结果无效');
  const start = new Date(after).getTime(); if (!Number.isFinite(start)) fail('cron 基准时间无效');
  const format = formatter(timeZone), weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let instant = Math.floor(start / 60000) * 60000 + 60000;
  const end = start + Math.max(1, Math.min(10, maxYears)) * 366 * 86400000;
  while (instant <= end) {
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const minute = Number(parts.minute), hour = Number(parts.hour), day = Number(parts.day), month = Number(parts.month), weekday = weekdays[parts.weekday];
    const dom = cron.day.includes(day), dow = cron.weekday.includes(weekday);
    const dayMatch = cron.dayAny ? dow : cron.weekdayAny ? dom : dom || dow;
    if (cron.month.includes(month) && dayMatch && cron.hour.includes(hour) && cron.minute.includes(minute)) return new Date(instant).toISOString();
    // Advance to the next local-hour boundary when this whole hour cannot match.
    instant += (!cron.month.includes(month) || !dayMatch || !cron.hour.includes(hour) ? Math.max(1, 60 - minute) : 1) * 60000;
  }
  return null;
}

/**
 * Store ports use root's existing DB, never a parallel persistence layer.
 * listTasks() -> [{id,characterId,conversationId,content,cron,enable,
 *   next_run_at?,timezone?,...}]. saveTask receives a full replacement record.
 * dispatchTTM({characterId,conversationId,content,source,taskId,signal}) must
 * durably enqueue internal work to the original context and deduplicate taskId.
 * Cursors advance before dispatch; unknown sends are not retried automatically.
 * Offline occurrences older than graceMs are explicitly skipped, never replayed
 * as an unbounded backlog. The next future occurrence remains scheduled.
 */
export function createBackgroundScheduler({ listTasks, saveTask, dispatchTTM, clock = () => new Date().toISOString(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, intervalMs = 1000, graceMs = 60000, logger = () => {} } = {}) {
  for (const [name, port] of Object.entries({ listTasks, saveTask, dispatchTTM })) if (typeof port !== 'function') throw new TypeError(`${name} port is required`);
  let timer, ticking, closed = false, closeTask;
  const controller = new AbortController();
  const log = (event, data) => { try { logger(event, data); } catch {} };
  function tick() {
    if (closed) return Promise.resolve({ dispatched: 0, skipped: 0 });
    if (ticking) return ticking;
    ticking = (async () => {
      const now = new Date(clock()), at = now.toISOString(), rows = await listTasks();
      let dispatched = 0, skipped = 0;
      for (const original of rows) {
        if (closed) break;
        const task = structuredClone(original);
        if (task.enable === false) continue;
        try {
          const cron = parseCron(task.cron), zone = task.timezone ?? timeZone;
          if (!task.characterId || !task.conversationId || typeof task.content !== 'string' || !task.content.trim()) throw Object.assign(new Error('定时任务必须保留角色、来源会话和内容'), { code: 'INVALID_ARGUMENT' });
          if (!task.next_run_at) { await saveTask({ ...task, next_run_at: nextRun(cron, { after: now, timeZone: zone }), error: null }); continue; }
          const due = new Date(task.next_run_at).getTime();
          if (!Number.isFinite(due)) throw Object.assign(new Error('next_run_at 无效'), { code: 'INVALID_ARGUMENT' });
          if (due > now.getTime()) continue;
          const next = nextRun(cron, { after: now, timeZone: zone });
          if (now.getTime() - due > Math.max(0, graceMs)) {
            await saveTask({ ...task, next_run_at: next, last_skipped_at: at, skipped_due_at: task.next_run_at, error: null }); skipped++; continue;
          }
          const occurrence = `cron:${task.id}:${new Date(due).toISOString()}`;
          const advanced = { ...task, next_run_at: next, last_run_at: at, last_event_id: occurrence, error: null };
          await saveTask(advanced); if (closed) break;
          try {
            await dispatchTTM({ characterId: task.characterId, conversationId: task.conversationId, content: task.content,
              source: { type: 'cron', internal: true, cronTaskId: task.id, dueAt: task.next_run_at, triggeredAt: at }, taskId: occurrence, signal: controller.signal });
            dispatched++; log('cron.queued', { taskId: task.id, occurrence });
          } catch (cause) {
            await saveTask({ ...advanced, error: { code: cause.code ?? 'DISPATCH_FAILED', message: cause.message }, last_dispatch_status: 'failed' });
            log('cron.failed', { taskId: task.id, code: cause.code ?? 'DISPATCH_FAILED' });
          }
        } catch (cause) {
          await saveTask({ ...task, error: { code: cause.code ?? 'INVALID_CRON', message: cause.message } });
          log('cron.invalid', { taskId: task.id, code: cause.code ?? 'INVALID_CRON' });
        }
      }
      return { dispatched, skipped };
    })();
    void ticking.finally(() => { ticking = undefined; }).catch(() => {});
    return ticking;
  }
  async function start() {
    if (closed) throw Object.assign(new Error('后台调度器已关闭'), { code: 'CLOSED' });
    if (!timer) { timer = setInterval(() => { void tick().catch(cause => log('cron.tick_failed', { code: cause.code ?? 'ERROR' })); }, Math.max(50, intervalMs)); timer.unref?.(); }
    return tick();
  }
  function close() {
    if (closeTask) return closeTask;
    closed = true; clearInterval(timer); controller.abort();
    closeTask = Promise.resolve(ticking).catch(() => {}); return closeTask;
  }
  return { start, tick, close };
}
