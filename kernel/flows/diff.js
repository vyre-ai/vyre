// @ts-check
// kernel/flows/diff: what changed between two versions of a Flow, by step id (f11). Pure over two stored Flows. A few lines, not two documents: steps added, removed, moved and changed (which keys), the trigger,
// the Flow-level keys, and a plain-words summary the rollback card shows.

/** @param {any} v */
const canon = v => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
/** @param {any} v @param {number} [n] */
const short = (v, n = 60) => { const t = typeof v === "string" ? v : canon(v) ?? "null"; return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const BLOCKS = ["then", "else", "steps"];

/** Every step with where it sits: { step (without its children), parent, position }. @param {any} flow @returns {Map<string, { step: any, where: string, index: number }>} */
function index(flow) {
  /** @type {Map<string, { step: any, where: string, index: number }>} */ const m = new Map();
  const walk = (/** @type {any[]} */ steps, /** @type {string} */ where) => (steps || []).forEach((s, i) => {
    const { then: _t, else: _e, steps: _s, on_fail, ...rest } = s;
    m.set(s.id, { step: { ...rest, ...(on_fail ? { on_fail: { ...on_fail, steps: (on_fail.steps || []).map((/** @type {any} */ x) => x.id) } } : {}) }, where, index: i });
    for (const b of BLOCKS) if (Array.isArray(s[b])) walk(s[b], `${s.id}.${b}`);
    if (on_fail && Array.isArray(on_fail.steps)) walk(on_fail.steps, `${s.id}.on_fail`);
  });
  walk(flow.steps, "");
  walk(flow.on_failure, "on_failure");
  return m;
}

/**
 * @param {any} a the older Flow @param {any} b the newer Flow
 * @returns {{ same: boolean, added: { id: string, kind: string, label?: string }[], removed: { id: string, kind: string, label?: string }[], moved: { id: string, from: string, to: string }[],
 *   changed: { id: string, keys: { key: string, from: string, to: string }[] }[], flow: { key: string, from: string, to: string }[], summary: string[] }}
 */
export function diffFlows(a, b) {
  const A = index(a), B = index(b);
  const added = [...B].filter(([id]) => !A.has(id)).map(([id, x]) => ({ id, kind: x.step.kind, ...(x.step.label ? { label: x.step.label } : {}) }));
  const removed = [...A].filter(([id]) => !B.has(id)).map(([id, x]) => ({ id, kind: x.step.kind, ...(x.step.label ? { label: x.step.label } : {}) }));
  /** @type {{ id: string, from: string, to: string }[]} */ const moved = [];
  /** @type {{ id: string, keys: { key: string, from: string, to: string }[] }[]} */ const changed = [];
  for (const [id, x] of B) {
    const y = A.get(id);
    if (!y) continue;
    if (y.where !== x.where || y.index !== x.index) moved.push({ id, from: `${y.where || "main"}#${y.index + 1}`, to: `${x.where || "main"}#${x.index + 1}` });
    const keys = [];
    for (const k of new Set([...Object.keys(y.step), ...Object.keys(x.step)])) if (canon(y.step[k]) !== canon(x.step[k])) keys.push({ key: k, from: short(y.step[k]), to: short(x.step[k]) });
    if (keys.length) changed.push({ id, keys });
  }
  const flow = [];
  const skip = new Set(["steps", "on_failure", "format"]);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!skip.has(k) && canon(a[k]) !== canon(b[k])) flow.push({ key: k, from: short(a[k]), to: short(b[k]) });
  const summary = [
    ...added.map(x => `adds ${x.kind} step ${x.id}${x.label ? ` (${x.label})` : ""}`),
    ...removed.map(x => `removes ${x.kind} step ${x.id}${x.label ? ` (${x.label})` : ""}`),
    ...changed.map(x => `changes ${x.id}: ${x.keys.map(k => k.key).join(", ")}`),
    ...moved.map(x => `moves ${x.id}`),
    ...flow.map(x => `changes the ${x.key}`),
  ];
  return { same: !summary.length, added, removed, moved, changed, flow, summary };
}
