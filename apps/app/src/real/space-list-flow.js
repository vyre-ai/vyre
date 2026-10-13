// @ts-check
// The list of a person's servers and teams (space-list.js) in the app. It is read twice and never in the background: once when the master password has just opened the personal vault (`opened`), and once when
// Settings, Servers opens (`sync`). It is written with the yes the person already gave for the act itself: a server paired (`added`), a team joined (`added`), a server or team left (`left`). A vault that is
// locked, or a list that could not be read, changes nothing; a leave made then is kept on this device and written at the next open. Each device keeps two small counters, never the list: the highest seq it has
// seen (a lower one is a rollback) and the removals not yet written. Connecting a listed server uses its pinned box key through `pairByChain` (the server's admission of a chain device, lane 2) and no typed code.
// Pure: every outside thing (the vault's tools, the pairing, the counters) comes in as a port.
import { FIELD, ITEM, entriesFromDevice, mergeLists, notOlder, pruneTombstones, toPair, unpinned, withAdded, withRemoved, isPinned } from "./space-list.js";
import { readList, writeList } from "./space-list-vault.js";

/** @typedef {import("./space-list.js").Entry} Entry */
/** @typedef {import("./space-list.js").ServerEntry} ServerEntry */
/** @typedef {{ relay: string, route: string, box: string, name?: string }} Pairing */
/** @typedef {{ found: ServerEntry[], confirm: ServerEntry[], unavailable?: string }} Found */

/** The only vault door the list gets: tools of the vault family on the list note by name. Vault calls go to a named server outside any Space (the routing's one exception), so nothing else may ride them. @param {(name: string, input?: Record<string, unknown>) => Promise<any>} tool */
export const onlyTheList = (tool) => (/** @type {string} */ name, /** @type {Record<string, unknown> | undefined} */ input) => {
  if (!/^vault\./.test(name) || !input || input.name !== ITEM) return Promise.reject(Object.assign(new Error("That is not the list of your servers."), { code: "not_the_list" }));
  return tool(name, input);
};

/** The same four vault calls the list port makes, answered by a member's personal store (vault.me.store.*, key vyre-space-list, the JSON as the value). The owner keeps the vault note; a member has no vault note, only this store. A locked store refuses with code locked, as the vault does. @param {(name: string, input?: Record<string, unknown>) => Promise<any>} tool */
export const memberTool = (tool) => async (/** @type {string} */ name, /** @type {Record<string, any> | undefined} */ input) => {
  if (!input || input.name !== ITEM) throw Object.assign(new Error("That is not the list of your servers."), { code: "not_the_list" });
  const KEY = ITEM;
  if (name === "vault.item" || name === "vault.reveal") {
    const v = await tool("vault.me.store.get", { key: KEY });
    if (v === null || v === undefined) throw Object.assign(new Error("No list yet."), { code: "not_found" });
    return name === "vault.item" ? { name: ITEM, kind: "note" } : { value: String(v) };
  }
  if (name === "vault.put" || name === "vault.update") return tool("vault.me.store.put", { key: KEY, value: input.fields?.[FIELD] });
  throw Object.assign(new Error("That is not the list of your servers."), { code: "not_the_list" });
};

/**
 * @param {{
 *   tool: (name: string, input?: Record<string, unknown>) => Promise<any>,
 *   device: () => Promise<{ pairings: Pairing[], teams: Array<{ name: string, home: { relay: string, route: string, box: string } }> }>,
 *   state: { seen: () => Promise<number>, setSeen: (n: number) => Promise<void>, pending: () => Promise<string[]>, setPending: (ids: string[]) => Promise<void> },
 *   pairByChain: (e: ServerEntry) => Promise<Pairing>,
 *   onPaired: (p: Pairing) => Promise<void>,
 *   now?: () => number,
 * }} io
 */
export function makeListFlow(io) {
  const now = io.now ?? Date.now;
  const tool = onlyTheList(io.tool);

  /** Read, bring this device and the vault together, write when something changed. @param {{ added?: Entry[] }} [o] @returns {Promise<Found>} */
  async function run(o = {}) {
    const there = await readList(tool);
    if (there.unavailable) return { found: [], confirm: [], unavailable: there.unavailable };
    const seen = await io.state.seen();
    if (!notOlder(there, seen).ok) return { found: [], confirm: [], unavailable: "rolled_back" };
    const device = await io.device();
    const have = device.pairings.map((p) => p.box);
    const held = new Set([...have, ...device.teams.map((t) => `team:${t.name}`)]);
    // removals made while the vault could not be written; one this device holds again is no removal
    const pending = (await io.state.pending()).filter((id) => !held.has(id));
    let base = there;
    for (const id of pending) base = withRemoved(base, id, now());
    for (const e of o.added ?? []) base = withAdded(base, e);
    const mine = { v: /** @type {const} */ (1), seq: base.seq, entries: entriesFromDevice(device), removed: [] };
    const merged = mergeLists(base, mine);
    const changed = base !== there || JSON.stringify(merged.entries) !== JSON.stringify(there.entries);
    const list = pruneTombstones(changed && merged.seq === there.seq ? { ...merged, seq: there.seq + 1 } : merged, now());
    if (changed) { await writeList(tool, list); await io.state.setPending([]); }
    else if (pending.length !== (await io.state.pending()).length) await io.state.setPending(pending);
    await io.state.setSeen(Math.max(seen, list.seq));
    return { found: toPair(list, have), confirm: unpinned(list, have) };
  }

  /** A write that cannot happen (locked vault, unreadable list) is not an error the person can act on: the device keeps what it needs and the next open writes it. @param {{ added?: Entry[] }} [o] */
  const quiet = async (o) => { try { return await run(o); } catch (e) { return { found: [], confirm: [], unavailable: String(/** @type {any} */ (e)?.code || "unavailable") }; } };

  /** @param {ServerEntry} e @returns {Promise<void>} */
  async function connect(e) {
    if (!isPinned(e)) throw Object.assign(new Error(`${e.name} has no key to check. Pair it with a code from that server.`), { code: "unpinned" });
    await io.onPaired(await io.pairByChain(e));
  }

  /** Each server in turn; one that refuses does not stop the next. @param {ServerEntry[]} entries */
  async function connectAll(entries) {
    /** @type {ServerEntry[]} */ const done = [];
    /** @type {Array<{ entry: ServerEntry, code: string, message: string }>} */ const failed = [];
    for (const entry of entries) {
      try { await connect(entry); done.push(entry); } catch (e) { failed.push({ entry, code: String(/** @type {any} */ (e)?.code || "failed"), message: e instanceof Error ? e.message : "Could not connect." }); }
    }
    return { done, failed };
  }

  return {
    /** Settings, Servers opens. */
    sync: () => quiet(),
    /** The master password just opened the vault: read, then connect every pinned server this device lacks. */
    async opened() {
      const r = await quiet();
      const out = await connectAll(r.found);
      return { ...r, found: out.failed.map((f) => f.entry), connected: out.done, failed: out.failed };
    },
    /** A server was paired or a team joined here. @param {Pairing | { name: string, home: { relay: string, route: string, box: string } }} what */
    added(what) {
      const e = "home" in what ? entriesFromDevice({ pairings: [], teams: [what] })[0] : entriesFromDevice({ pairings: [/** @type {Pairing} */ (what)], teams: [] })[0];
      return quiet({ added: [e] });
    },
    /** The person left a server or a team here (id: the box key, or `team:<name>`). @param {string} id */
    async left(id) {
      const p = await io.state.pending();
      if (!p.includes(id)) await io.state.setPending([...p, id]);
      return quiet();
    },
    connect,
    connectAll,
  };
}
