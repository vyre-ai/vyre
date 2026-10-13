// @ts-check
// The list of a person's servers and teams that travels with their personal vault: where to connect, nothing more. It is one personal note (ITEM, field FIELD) holding this JSON, so it is readable exactly
// where the vault is open (a new device that got the vault in by any sign-in) and the relay holds only the vault's ciphertext, as it does for every item. It carries no token, device id or key. Each server still
// decides who is a member; the list only says where to connect. Pure: src/real/space-list-vault.js reads and writes the item.

export const ITEM = "vyre-space-list";
export const FIELD = "text";
/** The sizes the stored text is padded up to, so the number of servers cannot be read from its length; the largest is the most the item may hold. */
export const STEPS = [2048, 4096, 8192];
export const LIMIT = STEPS[STEPS.length - 1];
/** A box key (the server's own public key, which the connection pins in its handshake) is at least this long; anything shorter is not a pin. */
const PIN_MIN = 32;
const VERSION = 1;

/** @typedef {{ kind: "server", id: string, name: string, relay: string, route: string, box: string }} ServerEntry */
/** @typedef {{ kind: "team", id: string, name: string, home: { relay: string, route: string, box: string } }} TeamEntry */
/** @typedef {ServerEntry | TeamEntry} Entry */
/** @typedef {{ id: string, seq: number }} Tombstone */
/** @typedef {{ v: 1, seq: number, entries: Entry[], removed: Tombstone[] }} List */

const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
const empty = () => /** @type {List} */ ({ v: VERSION, seq: 0, entries: [], removed: [] });

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
  const removed = (Array.isArray(j.removed) ? j.removed : []).filter((/** @type {any} */ x) => x && typeof x.id === "string" && Number.isInteger(x.seq)).map((/** @type {any} */ x) => ({ id: x.id, seq: x.seq }));
  return { v: VERSION, seq: Number.isInteger(j.seq) && j.seq >= 0 ? j.seq : 0, entries: /** @type {Entry[]} */ (entries), removed };
}

/** @param {List} l @returns {string} */
export function serializeList(l) {
  const text = JSON.stringify({ v: VERSION, seq: l.seq, entries: l.entries, removed: l.removed });
  if (text.length > LIMIT) throw Object.assign(new Error("The list of your servers and teams is too long to keep in the vault. Remove a server or a team you no longer use, then try again."), { code: "list_too_big" });
  // padded with spaces (JSON ignores them) to the next step, so the vault item's size does not say how many servers there are
  return text.padEnd(STEPS.find((n) => n >= text.length) ?? LIMIT, " ");
}

/**
 * Merge two lists. Every id once, the higher-seq list naming it. A tombstone (a removed id with the seq it was removed at) beats an entry from a list whose seq is not newer than it, so a stale device cannot bring a
 * removed server back; a later list that adds the id again (a higher seq than the tombstone) can. @param {List} a @param {List} b @returns {List}
 */
export function mergeLists(a, b) {
  const [older, newer] = a.seq <= b.seq ? [a, b] : [b, a];
  /** @type {Map<string, number>} */ const dead = new Map();
  for (const t of [...a.removed, ...b.removed]) dead.set(t.id, Math.max(dead.get(t.id) ?? 0, t.seq));
  /** @type {Map<string, { e: Entry, seq: number }>} */ const by = new Map();
  for (const [l, seq] of [[older, older.seq], [newer, newer.seq]]) for (const e of /** @type {List} */ (l).entries) by.set(e.id, { e, seq: /** @type {number} */ (seq) });
  const entries = [...by.values()].filter(({ e, seq }) => !(dead.has(e.id) && seq <= /** @type {number} */ (dead.get(e.id)))).map(({ e }) => e);
  return { v: VERSION, seq: Math.max(a.seq, b.seq), entries, removed: [...dead].map(([id, seq]) => ({ id, seq })) };
}

/** The person removed a server or a team: it leaves the list and stays out on every device that merges (a tombstone at the new seq). @param {List} l @param {string} id @returns {List} */
export function withRemoved(l, id) {
  const seq = l.seq + 1;
  return { ...l, seq, entries: l.entries.filter((e) => e.id !== id), removed: [...l.removed.filter((t) => t.id !== id), { id, seq }] };
}

/** The person (re-)added a server or a team on purpose: it joins the list at a new seq above any tombstone, so it is back. @param {List} l @param {Entry} e @returns {List} */
export function withAdded(l, e) {
  const seq = l.seq + 1;
  return { ...l, seq, entries: [...l.entries.filter((x) => x.id !== e.id), e], removed: l.removed.filter((t) => t.id !== e.id) };
}

/** Is this server entry pinned? Its box key is what the connection checks in its handshake, so an entry without one could send this device's hello to any server. @param {Entry} e */
export const isPinned = (e) => e.kind === "server" && e.box.length >= PIN_MIN;

/** The servers on the list this device is not paired to yet AND that carry a pin. Teams are joined by invite, not paired. An entry with no pin is never connected to by itself. @param {List} l @param {string[]} have box ids @returns {ServerEntry[]} */
export const toPair = (l, have) => /** @type {ServerEntry[]} */ (l.entries.filter((e) => e.kind === "server" && isPinned(e) && !have.includes(e.box)));

/** The server entries with no pin, which the screen shows by name and asks the person to confirm instead of connecting. @param {List} l @param {string[]} have */
export const unpinned = (l, have) => /** @type {ServerEntry[]} */ (l.entries.filter((e) => e.kind === "server" && !isPinned(e) && !have.includes(e.box)));

/**
 * Rollback: a list whose seq is lower than the highest this device has seen is a fault of whatever served it (an old copy). It is ignored and the local list kept. @param {List} got @param {number} seen
 * @returns {{ ok: boolean }}
 */
export const notOlder = (got, seen) => ({ ok: got.seq >= seen });
