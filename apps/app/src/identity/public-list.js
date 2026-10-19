// @ts-check
// A person's list as the names directory holds it, read without any key: who can speak for them (their devices, their recovery code, their recovery contacts). A page that has no key of its own (a browser on a
// server's own address, a phone paired to a server) can still SAY the list; it cannot change it, because every change is signed by one of the person's own devices. The chain is checked here, never trusted.
import * as C from "../../../../kernel/identity/chain.js";

/** @typedef {{ eid: string, kind: string, label: string | null, since: number, self: boolean, newcomer: boolean, agree: boolean }} ListEntry */

/**
 * @param {{ directory: string, id: string, fetch?: typeof fetch, now?: number }} o
 * @returns {Promise<ListEntry[]>}
 */
export async function publicEntries(o) {
  const f = o.fetch ?? globalThis.fetch;
  const now = o.now ?? Date.now();
  const res = await f(`${o.directory.replace(/\/+$/, "")}/v1/ids/resolve?id=${encodeURIComponent(o.id)}`, { headers: { accept: "application/json" } });
  /** @type {any} */ let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const d = body && body.data;
  if (!res.ok || !d || !Array.isArray(d.ops)) throw Object.assign(new Error("Your list is not in the names directory."), { code: "not_found" });
  const state = await C.verifyChain(d.ops, { now });
  if (state.id !== o.id) throw Object.assign(new Error("That list does not belong to this name."), { code: "mismatch" });
  return (state.entries || []).map((/** @type {any} */ e) => ({ eid: e.eid, kind: e.kind, label: typeof e.label === "string" ? e.label : null, since: e.since, self: false, newcomer: C.youngAt(e, now), agree: typeof e.agree === "string" }));
}
