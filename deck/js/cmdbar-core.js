// @ts-check
// The command bar's choices, without a DOM (design-system.md section 4, the prototype's palette): what exists to go to, how a typed word narrows it,
// and what shows before anything is typed. Groups in a fixed order; `p `, `t ` and `u ` at the start restrict to projects, threads and people and
// agents; Enter acts on the highlighted entry. Pure, so the order and the prefixes are tested.

export const GROUP_ORDER = Object.freeze(["Recent", "Actions", "Projects", "People and agents", "Threads"]);
const PREFIX = { p: "Projects", t: "Threads", u: "People and agents" };

/**
 * @typedef {{ id: string, group: "Actions"|"Projects"|"People and agents"|"Threads", title: string, meta?: string, href: string, kind?: "project"|"agent"|"thread"|"action", ref?: string }} Entry
 * @typedef {Entry & { group: string }} Shown
 */

/** `p kit` is projects named like kit; a bare word is everything. @param {string} raw @returns {{ prefix: string|null, q: string }} */
export function parseQuery(raw) {
  const m = /^([ptu])\s+(.*)$/i.exec(String(raw || "").trimStart());
  return m ? { prefix: PREFIX[/** @type {"p"} */ (m[1].toLowerCase())], q: m[2].trim().toLowerCase() } : { prefix: null, q: String(raw || "").trim().toLowerCase() };
}

/** How well the words match an entry: 3 starts with it, 2 a word starts with it, 1 it is inside, 0 no. @param {Entry} e @param {string} q */
export function score(e, q) {
  if (!q) return 1;
  const t = e.title.toLowerCase();
  if (t.startsWith(q)) return 3;
  if (t.split(/[\s\-_/.]+/).some(w => w.startsWith(q))) return 2;
  if (t.includes(q) || String(e.meta || "").toLowerCase().includes(q)) return 1;
  return 0;
}

/**
 * The entries to show for what was typed, in group order.
 * @param {Entry[]} entries everything known
 * @param {string} raw the box's words
 * @param {string[]} [recents] ids of the last entries chosen, newest first
 * @returns {Shown[]}
 */
export function choices(entries, raw, recents = []) {
  const { prefix, q } = parseQuery(raw);
  if (!q && !prefix) {
    const byId = new Map(entries.map(e => [e.id, e]));
    const recent = recents.map(id => byId.get(id)).filter(Boolean).slice(0, 6).map(e => ({ .../** @type {Entry} */ (e), group: "Recent" }));
    const seen = new Set(recent.map(e => e.id));
    const rest = entries.filter(e => !seen.has(e.id));
    const take = (/** @type {string} */ g, /** @type {number} */ n) => rest.filter(e => e.group === g).slice(0, n);
    return [...recent, ...take("Actions", 6), ...take("Projects", 4), ...take("People and agents", 4), ...take("Threads", 4)];
  }
  const pool = prefix ? entries.filter(e => e.group === prefix) : entries;
  const scored = pool.map((e, i) => ({ e, s: score(e, q), i })).filter(x => x.s > 0);
  /** @type {Shown[]} */ const out = [];
  for (const g of GROUP_ORDER) {
    const inGroup = scored.filter(x => x.e.group === g).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, prefix ? 30 : 6);
    for (const x of inGroup) out.push({ ...x.e, group: g });
  }
  return out;
}

/** The action entries, from what the box has. @param {{ assistant?: string|null }} [o] @returns {Entry[]} */
export function actionEntries(o = {}) {
  /** @type {Entry[]} */ const a = [{ id: "act:new-chat", group: "Actions", title: "New chat", href: "/chat?new", kind: "action" }];
  if (o.assistant) a.push({ id: "act:ask", group: "Actions", title: `Ask ${o.assistant}`, href: `/agents/${encodeURIComponent(o.assistant)}`, kind: "action" });
  a.push({ id: "act:planner", group: "Actions", title: "Planner", meta: "Alarms, todos and notes", href: "/planner", kind: "action" },
    { id: "act:devices", group: "Actions", title: "Devices", meta: "Your phones, computers and Macs", href: "/settings#devices", kind: "action" },
    { id: "act:settings", group: "Actions", title: "Settings", href: "/settings", kind: "action" });
  return a;
}
