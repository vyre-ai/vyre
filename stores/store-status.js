// @ts-check
// Which record store a server is using, for `vyre status` and /v1/health (launch's update proof asserts it): the store in use (built-in or Twenty), where that choice came from
// (VYRE_STORE set, or the default), and the number of records it sees. When VYRE_STORE asks for Twenty and this server is not on it, or the Twenty it is on does not answer, it says so in
// `note` and never falls back quietly. Reads only.
import { storeMode } from "./twenty/space-store.js";
import fs from "node:fs";
import path from "node:path";

/**
 * @param {{ root: string, store?: any, server?: boolean, env?: Record<string, string | undefined> }} o `root` is the vyred home; `store` is the kernel's record store (kernel.store)
 * @returns {Promise<{ store: "builtin" | "twenty", from: "VYRE_STORE" | "default", mode: string, records: number | null, reachable: boolean, unavailable?: { reason: string, since: string, attempts: number, next_try_at?: string }, note?: string }>}
 */
export async function storeStatus(o) {
  const env = o.env ?? process.env;
  const asked = env.VYRE_STORE;
  const mode = storeMode(env, { server: o.server });
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
  // a store that could not be set up and is being tried again: one plain state, with the reason and when the next try is (never a crash, never an empty list)
  /** @type {any} */ let unavailable = null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(o.root, "kernel", "store-state.json"), "utf8"));
    // The file is a record of an attempt that failed, kept so `vyre status` can say why. A store that is attached and answering is the newer fact: a file left by an earlier process (a restart that opened the store at once never cleared it) must not say "not available yet" about a store that is up.
    const live = Boolean(store) && reachable && (typeof store.attached !== "function" || store.attached());
    if (st && st.state === "unavailable" && !live) { unavailable = { reason: st.reason, since: st.since, attempts: st.attempts, ...(st.next_try_at ? { next_try_at: st.next_try_at } : {}) }; reachable = false; notes.push(`the record store is not available yet: ${st.reason}`); }
  } catch { /* none */ }
  let records = null;
  if (store && reachable) {
    try {
      records = 0;
      for (const t of await store.types()) { const r = await store.aggregate(t.name, { measures: [{ fn: "count" }] }); records += Number(r && r[0] && r[0].values && r[0].values.count) || 0; }
    } catch (e) { records = null; notes.push(`the records could not be counted: ${/** @type {Error} */ (e).message}`); }
  }
  return { store: inUse, from, mode, records, reachable, ...(unavailable ? { unavailable } : {}), ...(notes.length ? { note: notes.join("; ") } : {}) };
}

/**
 * storeStatus, but never for longer than `ms`. /v1/health carries this answer, and it asks the record store: while Records sets up its types, every call to the store queues behind the slow
 * ones (4 to 6 s each, minutes in all on a first start), so the health answer itself took longer than the 10 s the CLI waits, and `vyre status`, the installer and the updater read a working
 * vyred as one that was not answering. vyred is alive and serving other things in that time; the health answer says so and says the store is busy, instead of waiting for it.
 * @param {number} ms @param {Parameters<typeof storeStatus>[0]} o
 * @returns {Promise<Awaited<ReturnType<typeof storeStatus>> | { store: string, from: string, mode: string, records: null, reachable: false, busy: true, note: string }>}
 */
export async function storeStatusWithin(ms, o) {
  /** @type {any} */ let timer;
  const late = new Promise(r => { timer = setTimeout(() => r(null), ms); });
  try {
    const got = await Promise.race([storeStatus(o), late]);
    if (got) return got;
  } finally { clearTimeout(timer); }
  const store = o.store;
  return { store: store && store.kind === "twenty" ? "twenty" : "builtin", from: o.env?.VYRE_STORE ? "VYRE_STORE" : "default", mode: "busy", records: null, reachable: false, busy: true, note: "the record store is busy setting up; Vyre is running and this answers when it is done" };
}
