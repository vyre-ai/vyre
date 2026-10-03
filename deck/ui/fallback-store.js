// @ts-check
// deck/ui/fallback-store: a tiny in-memory Store (contracts.js) over the sample types and rows, for the field screens until ui/store.js is wired and for any
// place with no daemon. It keeps the one rule the real gateway keeps: seesAs(id, "assistant") never returns a sealed value. Not a mock of the whole product:
// tasks and approvals are empty.
import { types as sampleTypes } from "./types.js";
import { rows as sampleRows, actors as sampleActors, SPACES, events as sampleEvents } from "./sample-rows.js";

/** @typedef {import("./contracts.js").Store} Store */

/** @returns {Store} */
export function fallbackStore() {
  const types = sampleTypes, rows = sampleRows.map(r => ({ ...r, values: { ...r.values } }));
  /** @type {Set<() => void>} */
  const subs = new Set();
  const note = () => subs.forEach(f => f());
  const sealedKeys = (/** @type {string} */ typeId) => (types.find(t => t.id === typeId)?.fields || []).filter(f => f.kind === "sealed" || f.sealed).map(f => f.key);
  return {
    spaces: async () => SPACES,
    actors: async () => sampleActors,
    types: async space => types.filter(t => !space || t.space === space),
    list: async (typeId, q = {}) => rows.filter(r => r.type === typeId && (!q.space || r.space === q.space)),
    get: async id => rows.find(r => r.id === id) || null,
    create: async (typeId, values) => { const r = { id: `${typeId}-${rows.length + 1}`, type: typeId, space: "mine", values, createdAt: Date.now(), updatedAt: Date.now() }; rows.push(r); note(); return r; },
    update: async (id, patch) => { const r = rows.find(x => x.id === id); if (!r) throw new Error("No such record"); Object.assign(r.values, patch); r.updatedAt = Date.now(); note(); return r; },
    tasks: async () => [], task: async () => null,
    updateTask: async () => { throw new Error("Not in this store"); }, approveTask: async () => { throw new Error("Not in this store"); }, reassignTask: async () => { throw new Error("Not in this store"); },
    events: async q => (q.record && sampleEvents[q.record]) || [],
    reveal: async (id, key, proof) => {
      if (!proof?.method) throw new Error("Face ID is needed to reveal a sealed value");
      const r = rows.find(x => x.id === id); return { value: String(r?.values[key] ?? ""), until: Date.now() + 30_000 };
    },
    seesAs: async (id, who) => {
      const r = rows.find(x => x.id === id); if (!r) return {};
      if (who === "person") return { ...r.values };
      const hide = sealedKeys(r.type), out = /** @type {Record<string, any>} */ ({});
      for (const [k, v] of Object.entries(r.values)) out[k] = hide.includes(k) ? (v === undefined || v === "" ? v : { sealed: true }) : v;
      return out;
    },
    subscribe: fn => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}
