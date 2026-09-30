// @ts-check
// glance: the morning glance, three lines at most, from reads alone. No model call and nothing
// invented: every line is a row some other module already holds. A source that fails is left out.

const SHOW = 3;

/** Local start of the person's day in ms, from context.now's own day ("YYYY-MM-DD") and tz. Falls back to 24 h ago. */
export function dayStart(now, at = Date.now()) {
  const fallback = at - 24 * 60 * 60_000;
  if (!now || !now.day || !/^\d{4}-\d{2}-\d{2}$/.test(now.day) || !now.localTime) return fallback;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(now.localTime));
  if (!m) return fallback;
  const sinceMidnight = (Number(m[1]) * 60 + Number(m[2])) * 60_000;
  return at - sinceMidnight;
}

/** @param {(tool: string, input?: any) => Promise<any>} call */
export async function glance(call, { at = Date.now() } = {}) {
  const [now, w, t] = await Promise.all([
    call("context.now", {}).catch(() => null),
    call("waiting.list", { limit: 20 }).catch(() => null),
    call("threads.list", { all: false }).catch(() => null),
  ]);
  const n = now && !now.error ? now.data : null;
  const since = dayStart(n, at);
  const wr = w && !w.error && w.data ? w.data : { rows: [], count: 0 };
  const threads = t && !t.error && Array.isArray(t.data) ? t.data : [];
  const named = x => String(x.name || x.agent || "a thread");
  const running = threads.filter(x => ["starting", "working"].includes(x.canonical_status)).map(x => ({
    thread: x.id, who: named(x), project: x.project || null, step: x.canonical_status, since: x.started }));
  const finished = threads.filter(x => x.canonical_status === "finished" && (x.last || 0) >= since).map(x => ({
    thread: x.id, title: named(x), at: x.last }));
  const waiting = (wr.rows || []).map(r => ({ id: r.id, title: r.title, kind: r.kind }));
  const lines = [];
  if (wr.count) lines.push(`${wr.count} waiting on you`);
  if (finished.length) lines.push(finished.length === 1 ? `${finished[0].title} finished` : `${finished.length} threads finished`);
  if (running.length) lines.push(`${running.length} running`);
  return { day: n && n.day || null, waiting, running, finished, next: null, lines: lines.slice(0, SHOW) };
}
