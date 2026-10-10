// @ts-check
// A module that needs the Space's records and finds the record store still starting (a first start makes the Space's database; after an update on a box it takes minutes) must not FAIL the
// start. It is "waiting": it reports running with a note, its tools answer in the store's own words, and it starts for real the moment the store joins (startStoreWaiting, called by the
// daemon from the store's whenReady). The updater of an earlier version reads `vyre modules` and rolls an update back when a listed module says anything but running or off, so a slow store
// must never show as a failed module.

import { toolEntries } from "../../packages/module-sdk/manifest.js";

/** What a module that threw at start becomes: waiting when only the store was away, failed otherwise. @param {any} e @returns {{ state: string, error: string, waitsForStore: boolean }} */
export function failure(e) {
  const waits = Boolean(e) && e.code === "unavailable";
  return { state: waits ? "waiting" : "failed", error: String((e && e.message) || e), waitsForStore: waits };
}

/** A module that requires one that is waiting waits too (it starts when that one does); otherwise it failed. @param {any} reg @param {string} dep @returns {{ state: string, error: string, waitsForStore: boolean }} */
export function requiresFailure(reg, dep) {
  const r = reg.modules.get(dep);
  return { state: r && r.state === "waiting" ? "waiting" : "failed", error: `requires "${dep}", which is not running`, waitsForStore: Boolean(r && r.state === "waiting") };
}

/** The state `vyre modules` shows: a waiting module is running (with its note), so a slow store is not a failed start. @param {any} r */
export const reported = r => (r.state === "waiting" ? "running" : r.state);

/** The module's tools while it waits: each answers, in the store's words, that records are not up yet. @param {any} reg @param {any} m the manifest @param {string} words */
export function stubTools(reg, m, words) {
  const ctx = reg.context(m);
  for (const e of toolEntries(m)) ctx.tool(e.name, { description: e.description || "", run: async () => { throw Object.assign(new Error(`${m.name} is waiting for the records: ${words}`), { code: "unavailable" }); } });
}

/** The record store has joined: start every waiting module again, in turn, until none of them moves (a module that requires another starts after it). @param {any} reg */
export async function startWaiting(reg) {
  for (let moved = true; moved;) {
    moved = false;
    for (const r of [...reg.modules.values()]) {
      if (r.state !== "waiting" || !r.waitsForStore) continue;
      for (const [t, def] of [...reg.tools]) if (def.module === r.manifest.name) reg.tools.delete(t);
      await reg.startOne({ manifest: r.manifest, dir: r.dir });
      if (r.state !== "waiting") moved = true;
    }
  }
}
