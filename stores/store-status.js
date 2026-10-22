// @ts-check
// Which record store a server is using, for `vyre status` and /v1/health. Records live in the kernel's own SQLite store. Reads only.
import fs from "node:fs";
import path from "node:path";

/**
 * @param {{ root: string, store?: any, server?: boolean, env?: Record<string, string | undefined> }} o `root` is the vyred home; `store` is the kernel's record store
 * @returns {Promise<{ store: "vyre", records: number | null, reachable: boolean, unavailable?: { reason: string, since: string, attempts: number, next_try_at?: string }, note?: string }>}
 */
export async function storeStatus(o) {
  const store = o.store;
  /** @type {string[]} */ const notes = [];
  let reachable = true;
  /** @type {any} */ let unavailable = null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(o.root, "kernel", "store-state.json"), "utf8"));
    const live = Boolean(store) && (typeof store.attached !== "function" || store.attached());
    if (st && st.state === "unavailable" && !live) { unavailable = { reason: st.reason, since: st.since, attempts: st.attempts, ...(st.next_try_at ? { next_try_at: st.next_try_at } : {}) }; reachable = false; notes.push(`the record store is not available yet: ${st.reason}`); }
  } catch { /* none */ }
  let records = null;
  if (store && reachable) {
    try {
      records = 0;
      for (const t of await store.types()) { const r = await store.aggregate(t.name, { measures: [{ fn: "count" }] }); records += Number(r && r[0] && r[0].values && r[0].values.count) || 0; }
    } catch (e) { records = null; reachable = false; notes.push(`the records could not be counted: ${/** @type {Error} */ (e).message}`); }
  }
  return { store: "vyre", records, reachable, ...(unavailable ? { unavailable } : {}), ...(notes.length ? { note: notes.join("; ") } : {}) };
}

/**
 * storeStatus, but never for longer than `ms`. /v1/health carries this answer. A store that does not answer in time is reported as busy; vyred itself is up.
 * @param {number} ms @param {Parameters<typeof storeStatus>[0]} o
 * @returns {Promise<Awaited<ReturnType<typeof storeStatus>> | { store: "vyre", records: null, reachable: false, busy: true, note: string }>}
 */
export async function storeStatusWithin(ms, o) {
  /** @type {any} */ let timer;
  const late = new Promise(r => { timer = setTimeout(() => r(null), ms); });
  try {
    const got = await Promise.race([storeStatus(o), late]);
    if (got) return got;
  } finally { clearTimeout(timer); }
  return { store: "vyre", records: null, reachable: false, busy: true, note: "the record store is busy setting up; Vyre is running and this answers when it is done" };
}
