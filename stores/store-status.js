// @ts-check
// Which record store a server is using, for `vyre status` and /v1/health (launch's update proof asserts it): the store in use (built-in or Twenty), where that choice came from
// (VYRE_STORE set, or the default), and the number of records it sees. When VYRE_STORE asks for Twenty and this server is not on it, or the Twenty it is on does not answer, it says so in
// `note` and never falls back quietly. Reads only.
import fs from "node:fs";
import path from "node:path";

/**
 * @param {{ root: string, store?: any, env?: Record<string, string | undefined> }} o `root` is the vyred home; `store` is the kernel's record store (kernel.store)
 * @returns {Promise<{ store: "builtin" | "twenty", from: "VYRE_STORE" | "default", mode: string, records: number | null, reachable: boolean, note?: string }>}
 */
export async function storeStatus(o) {
  const env = o.env ?? process.env;
  const asked = env.VYRE_STORE;
  const mode = asked || "sqlite";
  const from = asked ? "VYRE_STORE" : "default";
  const store = o.store;
  const inUse = store && (store.kind === "twenty" || (typeof store.constructor === "function" && store.constructor.name === "TwentyStore")) ? "twenty" : "builtin";
  /** @type {string[]} */ const notes = [];
  let reachable = true;
  if (inUse === "twenty" && typeof store.health === "function") {
    try { const h = await store.health(); if (!h.ok) { reachable = false; notes.push(`Twenty is not answering: ${h.detail || "no reply"}`); } } catch (e) { reachable = false; notes.push(`Twenty is not answering: ${/** @type {Error} */ (e).message}`); }
  }
  if (mode === "twenty" && inUse !== "twenty") { reachable = false; notes.push("VYRE_STORE asks for Twenty and this server is not using it"); }
  // a home that was put on Twenty earlier and is now running on the built-in store (the setting is gone): the records shown are the built-in store's
  try {
    const chosen = JSON.parse(fs.readFileSync(path.join(o.root, "kernel", "store.json"), "utf8"));
    if (chosen && chosen.kind === "twenty" && inUse !== "twenty") notes.push("this home was set up on Twenty, and this server is running on the built-in store: the records counted here are the built-in store's");
  } catch { /* no choice recorded: the default */ }
  let records = null;
  if (store && reachable) {
    try {
      records = 0;
      for (const t of await store.types()) { const r = await store.aggregate(t.name, { measures: [{ fn: "count" }] }); records += Number(r && r[0] && r[0].values && r[0].values.count) || 0; }
    } catch (e) { records = null; notes.push(`the records could not be counted: ${/** @type {Error} */ (e).message}`); }
  }
  return { store: inUse, from, mode, records, reachable, ...(notes.length ? { note: notes.join("; ") } : {}) };
}
