// @ts-check
// The main search's line: scopes and the from:, in: and type: filters, the best match, and the actions. Pure, so Node tests it. The older p, t and u prefixes (find-prefix.js) still work.

/** The scopes, in the order the bar shows them. */
export const SCOPE_LIST = /** @type {const} */ ([["all", "Everything"], ["chats", "Chats"], ["people", "People"], ["records", "Records"], ["projects", "Projects"], ["files", "Files"], ["settings", "Settings"]]);
const SCOPE_WORDS = new Map([["everything", "all"], ["all", "all"], ["chats", "chats"], ["chat", "chats"], ["threads", "chats"], ["people", "people"], ["person", "people"], ["records", "records"], ["record", "records"], ["projects", "projects"], ["project", "projects"], ["files", "files"], ["file", "files"], ["settings", "settings"], ["setting", "settings"]]);
/** The kinds a row can be, and the words a person may type for each after type:. */
const TYPE_WORDS = new Map([["chat", "chat"], ["thread", "chat"], ["message", "message"], ["messages", "message"], ["person", "person"], ["people", "person"], ["agent", "agent"], ["project", "project"], ["record", "record"], ["file", "file"], ["setting", "setting"], ["memory", "memory"], ["action", "action"], ["place", "place"]]);

/**
 * Split a line into the words to search and the filters it carries. A filter is `from:x`, `in:x` or `type:x`; a value with spaces is quoted ("in:'Park Lane'" or in:"Park Lane"). An unknown type or a
 * from with nothing after it stays in the text as typed, so a colon in an ordinary search ("note: call back") is never swallowed.
 * @param {string} raw @returns {{ text: string, scope: string | null, type: string | null, from: string | null, within: string | null }}
 */
export function parseQuery(raw) {
  let scope = null, type = null, from = null, within = null;
  const text = String(raw || "").replace(/(^|\s)(from|in|type):(?:"([^"]+)"|'([^']+)'|(\S+))/gi, (whole, lead, key, a, b, c) => {
    const value = String(a ?? b ?? c ?? "").trim();
    const k = String(key).toLowerCase();
    if (!value) return whole;
    if (k === "type") { const t = TYPE_WORDS.get(value.toLowerCase()); if (!t) return whole; type = t; return lead; }
    if (k === "from") { from = value; return lead; }
    const s = SCOPE_WORDS.get(value.toLowerCase());
    if (s) scope = s; else within = value;
    return lead;
  }).replace(/\s+/g, " ").trim();
  return { text, scope, type, from, within };
}

/** How well a row's title matches the words: exact 100, starts with 80, a word starts with 60, contains 40, otherwise 20. @param {string} title @param {string[]} ws */
export function score(title, ws) {
  const t = String(title || "").toLowerCase(), joined = ws.join(" ");
  if (!joined) return 0;
  if (t === joined) return 100;
  if (t.startsWith(joined)) return 80;
  if (ws.every(w => t.split(/[^\p{L}\p{N}]+/u).some(p => p.startsWith(w)))) return 60;
  if (ws.every(w => t.includes(w))) return 40;
  return 20;
}

/**
 * The single best row across the sections, and the sections without it. Ties go to the earlier section. Only a row that matches by its title qualifies (score above 20), so a body match is never
 * called the best match. @template {{ key: string, rows: { key: string, title: string }[] }} S @param {S[]} secs @param {string} text
 */
export function bestMatch(secs, text) {
  const ws = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
  let best = null, bestScore = 20;
  for (const s of secs) for (const r of s.rows) { const sc = score(r.title, ws); if (sc > bestScore) { best = r; bestScore = sc; } }
  if (!best) return { best: null, rest: secs };
  const rest = secs.map(s => ({ ...s, rows: s.rows.filter(r => r !== best) })).filter(s => s.rows.length > 0 || (/** @type {any} */ (s).notes || []).length > 0);
  return { best, rest };
}

/** What a person can do from the search, with the words that find it. */
export const ACTIONS = Object.freeze([
  { key: "new-chat", title: "New chat", href: "/u/chats/new", words: "new chat message start talk" },
  { key: "new-agent", title: "New agent", href: "/u/engineer", words: "new agent make create assistant" },
  { key: "new-flow", title: "New Flow", href: "/u/flows/new", words: "new flow automation make create" },
  { key: "new-record", title: "New record", href: "/u/record/new", words: "new record add contact task note" },
  { key: "make-app", title: "Make an app", href: "/u/engineer", words: "make app build create" },
  { key: "settings", title: "Open Settings", href: "/u/settings", words: "settings preferences options" },
]);

/** The actions whose title or words match every typed word. @param {string} text @param {number} [max] */
export function actionHits(text, max = 3) {
  const ws = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!ws.length) return [];
  return ACTIONS.filter(a => ws.every(w => `${a.title} ${a.words}`.toLowerCase().split(/\s+/).some(p => p.startsWith(w)))).slice(0, max);
}

/**
 * Keep the rows a filter lets through. `type` is a row kind; `from` matches the row's author or agent (or its sub line); `within` matches the chat, project or place it sits in.
 * @template {{ kind: string, sub?: string, from?: string, where?: string, title: string }} R @param {R[]} rows @param {{ type: string | null, from: string | null, within: string | null }} f
 */
export function filterRows(rows, f) {
  const has = (/** @type {string | undefined} */ hay, /** @type {string} */ needle) => String(hay || "").toLowerCase().includes(needle.toLowerCase());
  return rows.filter(r => (!f.type || r.kind === f.type) && (!f.from || has(r.from, f.from) || has(r.sub, f.from)) && (!f.within || has(r.where, f.within) || has(r.sub, f.within) || has(r.title, f.within)));
}
