// @ts-check
// The list of a person's servers and teams that travels with their personal vault: where to connect, nothing more. It is one personal note (ITEM, field FIELD) holding this JSON, so it is readable exactly
// where the vault is open (a new device that got the vault in by any sign-in) and the relay holds only the vault's ciphertext, as it does for every item. It carries no token, device id or key. Each server still
// decides who is a member; the list only says where to connect. Pure: src/real/space-list-vault.js reads and writes the item.

export const ITEM = "vyre-space-list";
export const FIELD = "text";
/** Characters the item may hold (a vault field is small). */
export const LIMIT = 6000;
const VERSION = 1;

/** @typedef {{ kind: "server", id: string, name: string, relay: string, route: string, box: string }} ServerEntry */
/** @typedef {{ kind: "team", id: string, name: string, home: { relay: string, route: string, box: string } }} TeamEntry */
/** @typedef {ServerEntry | TeamEntry} Entry */
/** @typedef {{ v: 1, at: number, entries: Entry[], removed: string[] }} List */

const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
const empty = () => /** @type {List} */ ({ v: VERSION, at: 0, entries: [], removed: [] });

/** What this device holds, as entries: only where to connect. @param {{ pairings: Array<{ relay: string, route: string, box: string, name?: string }>, teams: Array<{ name: string, home: { relay: string, route: string, box: string } }> }} d @returns {Entry[]} */
export function entriesFromDevice(d) {
  /** @type {Entry[]} */ const out = [];
  d.pairings.forEach((p, n) => out.push({ kind: "server", id: p.box, name: (p.name || "").trim() || `Server ${n + 1}`, relay: p.relay, route: p.route, box: p.box }));
  for (const t of d.teams) out.push({ kind: "team", id: `team:${t.name}`, name: t.name, home: { relay: t.home.relay, route: t.home.route, box: t.home.box } });
  return out;
}

/** @param {any} e @returns {Entry | null} */
function entryOf(e) {
  if (!e || typeof e !== "object" || !str(e.id) || !str(e.name)) return null;
  if (e.kind === "server" && str(e.relay) && str(e.route) && str(e.box)) return { kind: "server", id: e.id, name: e.name, relay: e.relay, route: e.route, box: e.box };
  if (e.kind === "team" && e.home && str(e.home.relay) && str(e.home.route) && str(e.home.box)) return { kind: "team", id: e.id, name: e.name, home: { relay: e.home.relay, route: e.home.route, box: e.home.box } };
  return null;
}

/** A stored list, checked. Anything wrong with it, or one bad entry, costs only that. @param {string | null | undefined} text @returns {List} */
export function parseList(text) {
  let j;
  try { j = JSON.parse(String(text ?? "")); } catch { return empty(); }
  if (!j || typeof j !== "object" || j.v !== VERSION) return empty();
  const entries = (Array.isArray(j.entries) ? j.entries : []).map(entryOf).filter((/** @type {Entry | null} */ e) => e !== null);
  return { v: VERSION, at: Number.isFinite(j.at) ? j.at : 0, entries: /** @type {Entry[]} */ (entries), removed: (Array.isArray(j.removed) ? j.removed : []).filter((/** @type {unknown} */ x) => typeof x === "string") };
}

/** @param {List} l @returns {string} */
export function serializeList(l) {
  const text = JSON.stringify({ v: VERSION, at: l.at, entries: l.entries, removed: l.removed });
  if (text.length > LIMIT) throw Object.assign(new Error("The list of your servers and teams is too long to keep in the vault. Remove a server or a team you no longer use, then try again."), { code: "list_too_big" });
  return text;
}

/** Merge two lists: every id once, the newer list naming it; an id either side removed stays out. @param {List} a @param {List} b @returns {List} */
export function mergeLists(a, b) {
  const [older, newer] = a.at <= b.at ? [a, b] : [b, a];
  const removed = [...new Set([...a.removed, ...b.removed])];
  /** @type {Map<string, Entry>} */ const by = new Map();
  for (const e of [...older.entries, ...newer.entries]) by.set(e.id, e);
  return { v: VERSION, at: Math.max(a.at, b.at), entries: [...by.values()].filter((e) => !removed.includes(e.id)), removed };
}

/** The person removed a server or a team: it leaves the list and stays out on every device that merges. @param {List} l @param {string} id @returns {List} */
export function withRemoved(l, id) {
  return { ...l, entries: l.entries.filter((e) => e.id !== id), removed: l.removed.includes(id) ? l.removed : [...l.removed, id] };
}

/** The servers on the list this device is not paired to yet. Teams are joined by invite, not paired. @param {List} l @param {string[]} have box ids @returns {ServerEntry[]} */
export const toPair = (l, have) => /** @type {ServerEntry[]} */ (l.entries.filter((e) => e.kind === "server" && !have.includes(e.box)));
