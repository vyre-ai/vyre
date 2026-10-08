// @ts-check
// The owner's side of "add a device to my name": this app holds the identity key, so it signs the list change that puts a new device's key on the name's list and sends it to the names
// directory. A server that holds no identity (the key lives in this app) cannot do it and only records the request (core/wink/pairing.js, wink.phone.pairing `enrol`, wink.phone.enrolled).
// The same steps as core/spaces/identity-ops.js addEntry, with kernel/identity/chain.js itself, every outside thing handed in so Node tests it.

import * as C from "../../../../kernel/identity/chain.js";

const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/**
 * @param {{ name: string, eid: string, pin?: { id: string, seq: number, head: string } | null, base: string, fetch?: typeof fetch, now?: () => number,
 *   sign: (m: Uint8Array) => Promise<Uint8Array> | Uint8Array, esign?: (m: Uint8Array) => Promise<Uint8Array> | Uint8Array,
 *   entry: { publicKey: string, label?: string, agree?: string, enclave?: string } }} o
 * @returns {Promise<{ eid: string, ops: any[], pin: { id: string, seq: number, head: string }, already: boolean }>}
 */
export async function enrolDevice(o) {
  const f = o.fetch ?? globalThis.fetch;
  const now = o.now ?? Date.now;
  const root = String(o.base).replace(/\/+$/, "");
  const get = async (/** @type {string} */ path, /** @type {any} */ body) => {
    let res;
    try { res = await f(root + path, body === undefined ? { headers: { accept: "application/json" } } : { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) }); }
    catch { throw refuse("Cannot reach the names directory right now.", "unreachable"); }
    /** @type {any} */ let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !json || json.error || !json.data) throw refuse(String((json && json.error && json.error.message) || `The names directory answered ${res.status}.`), String((json && json.error && json.error.code) || "directory"));
    return json.data;
  };
  // Build on the list the directory holds now (another device may have changed it), refusing a stale or different one.
  const r = await get(`/v1/ids/resolve?name=${encodeURIComponent(o.name)}`);
  const ops = /** @type {any[]} */ (r.ops);
  const same = await C.checkAnswer(o.pin, ops);
  if (!same.ok) throw refuse(`The directory's answer for your name could not be trusted: ${same.why}`, same.code);
  const state = await C.verifyChain(ops, { now: now() + C.SKEW_MS });
  if (state.id !== r.id && r.id) throw refuse("The directory's answer is for a different identity.", "other_id");
  if (!state.entries.some(e => e.eid === o.eid)) throw refuse("This device is not on your name's list, so it cannot add another.", "not_on_list");
  const eid = await C.eidOf(o.entry.publicKey);
  if (state.entries.some(e => e.eid === eid)) return { eid, ops, pin: C.pinOf(state), already: true };
  // A key a page script can reach, or one nobody proved, cannot change who speaks for the name: the entry is held "web" (the same default as the server's own enrolment).
  const entry = { eid, kind: "device", pub: o.entry.publicKey, ...(typeof o.entry.agree === "string" ? { agree: o.entry.agree } : {}), ...(typeof o.entry.enclave === "string" ? { enclave: o.entry.enclave } : {}), held: "web" };
  const op = await C.makeOp(state, { type: "add", entry }, { by: o.eid, ts: Math.max(now(), state.ts), sign: o.sign, ...(o.esign ? { esign: o.esign } : {}) });
  let next;
  try { next = await C.applyOp(state, op, { now: now(), live: true }); } catch (e) { throw refuse(String(/** @type {Error} */ (e).message || "The list change did not check out."), String(/** @type {any} */ (e).code || "failed")); }
  await get("/v1/ids/append", { name: o.name, ops: [op] });
  return { eid, ops: [...ops, op], pin: C.pinOf(next), already: false };
}
