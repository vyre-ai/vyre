// @ts-check
// The agent records: a DERIVED view of the roster (R031-02, R031-09), so an agent can carry tags, links and relations like any record and appear in a tag filter. The agent store (`agents_agents`) is
// the only truth. This file is the ONE path that writes the mirror: `reconcile` makes the records equal to the store (creates the missing, updates the different, removes the gone), and every change
// to the store schedules it, and so does any change to an agent record from anywhere else (the module hears the kernel's `agent.*` events): a hand-written edit is put back at once, so the view cannot
// drift from the roster. Reconciling writes only a difference, so the events it causes end it.

import { TAGS } from "../../records/core-types.js";

/** The Agent record type, declared in the module's manifest too (needs.kernel.types), which is where the Space gets it. */
export const AGENT = Object.freeze({
  name: "agent", label: "Agent", icon: "IconRobot",
  fields: [
    { name: "name", kind: "text", label: "Name", required: true },
    { name: "uid", kind: "text", label: "Id", unique: true },
    { name: "kind", kind: "choice", label: "Kind", options: ["assistant", "agent"] },
    { name: "owner", kind: "text", label: "Owner" },
    { name: "builtin", kind: "boolean", label: "Built in" },
    { name: "model", kind: "text", label: "Model" },
    TAGS,
  ],
});

/** What a roster row looks like as a record. @param {any} a a shaped agent */
export const recordOf = a => ({ name: a.name, uid: a.uid, kind: a.kind, owner: a.owner || "", builtin: Boolean(a.builtin), model: a.model || "", tags: a.tags || "" });

/**
 * @param {{ kernel: () => any, rows: () => any[], log?: (m: string) => void }} o
 * @returns {{ schedule: () => Promise<any>, reconcile: () => Promise<{ created: number, updated: number, removed: number }> }}
 */
export function createMirror({ kernel, rows, log = () => {} }) {
  /** @type {Promise<any> | null} */ let pending = null, again = false;
  async function reconcile() {
    const k = kernel();
    if (!k || !k.records || typeof k.serviceChain !== "function") return { created: 0, updated: 0, removed: 0 };
    const chain = k.serviceChain("agents");
    const want = new Map(rows().map(a => [String(a.uid), recordOf(a)]));
    const have = (await k.records.query(chain, "agent", { page: { limit: 1000 } })).rows;
    const seen = new Set();
    let created = 0, updated = 0, removed = 0;
    for (const r of have) {
      const w = want.get(String(r.data.uid));
      if (!w || seen.has(String(r.data.uid))) { await k.records.remove(chain, "agent", r.id, r.version); removed++; continue; }
      seen.add(String(r.data.uid));
      const diff = Object.fromEntries(Object.entries(w).filter(([f, v]) => (r.data[f] ?? (typeof v === "boolean" ? false : "")) !== v));
      if (Object.keys(diff).length) { await k.records.update(chain, "agent", r.id, diff, r.version); updated++; }
    }
    for (const [uid, w] of want) if (!seen.has(uid)) { await k.records.create(chain, "agent", w); created++; }
    return { created, updated, removed };
  }
  /** Run a reconcile soon; changes that arrive while one runs get one more after it. Resolves when the mirror is level. */
  function schedule() {
    if (pending) { again = true; return pending; }
    pending = (async () => {
      try { do { again = false; await reconcile(); } while (again); }
      catch (e) { log(`agents: the agent records did not follow the roster (${/** @type {Error} */ (e).message})`); }
      finally { pending = null; }
    })();
    return pending;
  }
  return { schedule, reconcile };
}
