// @ts-check
// finish: the last step of a pairing whose ticket the box GATED (X-1): the device redeemed it and is a waiting pairing, not yet a device, until it finishes over its own channel. Which
// tool finishes it depends on the gate the box names in its reply (`gate`): a server's ticket ends with wink.server.adopt (the app says who will own the server and proves it, and the
// person at the server says yes), a phone's or a computer's with wink.phone.wait (the person on the showing device says yes). This file is the one place that does either, for the QR and long
// code (serverpair.js, phonepair.js) and for the typed code (join.js) alike; before it the typed code redeemed the ticket and stopped, and the waiting pairing was dropped.
//
// Both resolve what the pairing then holds, or reject with an Error whose `code` is one of the codes serverpair.js and phonepair.js list.
import { connect } from "./client.js";
import { nonceCommit, ticketTag, newNonce, pairWords } from "./pairwords.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * One tool of the waiting pairing, over a channel that reaches only that tool: the data, or the box's own refusal.
 * @param {any} conn @param {string} tool @param {any} input
 */
async function callPending(conn, tool, input) {
  /** @type {any} */ let to;
  const r = await Promise.race([conn.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }), new Promise((_, rej) => { to = setTimeout(() => rej(fail("unreachable", "The other device did not answer.")), 15_000); })]).finally(() => clearTimeout(to));
  const body = /** @type {any} */ (await /** @type {any} */ (r).json().catch(() => null));
  return { status: /** @type {any} */ (r).status, body };
}

/**
 * A server's waiting pairing: wink.server.adopt. The first call carries the claimed owner, its proof and the pairing's commit; the server answers with its nonce; the app reveals its own, both derive
 * the same three words, and the person at the server picks them (a typed code's ack is that pick already, so the owner comes back at once).
 * @param {{ box: string, device: string, route: string, name?: string }} paired what pairTicket answered
 * @param {{ relay: string, ticket: string, typed?: boolean, owner: { id: string, name?: string, vyre?: string, pin?: { id: string, seq: number, head: string }, kind?: "identity" | "space" }, deviceName?: string, proof?: { eid: string, sig: string },
 *   signIdentity?: (message: Uint8Array) => Promise<{ eid: string, sig: string, esig?: string }> | { eid: string, sig: string, esig?: string },
 *   deviceKind?: "phone" | "computer" | "web", keyStorage?: "hardware" | "software", crypto?: any, keyStore?: any, WebSocket?: any,
 *   onWords?: (words: string) => void, signal?: AbortSignal, pollMs?: number, timeoutMs?: number }} o
 *   typed: the ticket came from a typed code. The server names it `typed_tag`, asks no words when the person typed the ack back, and its words are made with no ticket (core/wink/pairing.js).
 * @returns {Promise<{ paired: true, relay: string, route: string, box: string, device: string, name: string, owner: any, session: boolean }>}
 */
export async function adoptServer(paired, o) {
  const deviceName = o.deviceName || "a device";
  const conn = connect({ relay: o.relay, route: paired.route, box: paired.box, name: deviceName, crypto: o.crypto, keyStore: o.keyStore, WebSocket: o.WebSocket });
  const stop = () => { try { conn.close(); } catch { /* closed */ } };
  const adopt = async (/** @type {any} */ input) => callPending(conn, "wink.server.adopt", input);
  const owner = { kind: o.owner.kind || "identity", id: o.owner.id, ...(o.owner.name ? { name: String(o.owner.name).slice(0, 64) } : {}), ...(/** @type {any} */ (o.owner).vyre ? { vyre: String(/** @type {any} */ (o.owner).vyre).slice(0, 253) } : {}), ...(/** @type {any} */ (o.owner).pin ? { pin: /** @type {any} */ (o.owner).pin } : {}) };
  // The proof that the identity's own key stands behind this pairing: its signature over this pairing's box and relay device and ticket tag (so it is good for this pairing only, PI-3); a phone's key adds its Face ID signature `esig`.
  /** @type {{ eid: string, sig: string } | undefined} */ let proof = o.proof;
  if (!proof && o.signIdentity) proof = await o.signIdentity(new TextEncoder().encode(`vyre-wink-pair-to-v1\n${paired.box}\n${paired.device}\n${await ticketTag(o.ticket)}`));
  const base = { owner, identity: owner.kind === "identity" ? owner.id : undefined, ...(proof ? { proof } : {}), ...(o.deviceKind ? { deviceKind: o.deviceKind, deviceName } : {}), ...(o.keyStorage ? { keyStorage: o.keyStorage } : {}) };
  const refuse = (/** @type {any} */ r) => {
    const e = r.body && r.body.error;
    const code = e && e.code;
    throw fail(code === "busy" ? "busy" : code === "expired" ? "expired" : code === "denied" ? "denied" : code === "denied_no_proof" || code === "denied_wrong_proof" || code === "no_pin" ? code : code === "bad_input" ? "bad_owner" : code === "not_hardware" ? "not_hardware" : code === "owned_by_other" ? "owned_by_other" : code === "unavailable" ? "cannot_check" : "unreachable", (e && e.message) || "The server refused.");
  };
  const done = (/** @type {any} */ data) => { stop(); return { paired: /** @type {true} */ (true), relay: o.relay, route: paired.route, box: paired.box, device: paired.device, name: paired.name || "", owner: data.owner, session: data.session !== false }; };
  try {
    const na = newNonce(), commit = await nonceCommit(na), tag = await ticketTag(o.ticket);
    const mark = o.typed ? { typed_tag: tag } : { tag };
    const first = await adopt({ ...base, pairing: { commit, ...mark } });
    if (first.status !== 200 || !first.body || !first.body.data) return refuse(first);
    // a proven (--pair-to) server, or a typed code whose ack was typed back, answers the owner at once; a first adoption answers pending with the server's nonce
    if (first.body.data.owner) return done(first.body.data);
    const nb = String(first.body.data.nb || "");
    if (!nb) throw fail("unreachable", "The server did not start the pairing.");
    const words = await pairWords(String(paired.box), String(paired.device), { ticket: o.typed ? "" : o.ticket, nonceA: na, nonceB: nb });
    if (o.onWords) o.onWords(words);
    const deadline = Date.now() + (o.timeoutMs ?? 5 * 60_000);
    const pollMs = o.pollMs ?? 1000;
    for (;;) {
      if (o.signal && o.signal.aborted) { await adopt({ ...base, pairing: { commit, ...mark, cancel: true } }).catch(() => null); throw fail("cancelled", "Pairing was cancelled."); }
      if (Date.now() > deadline) throw fail("expired", "Nobody answered at the server in time.");
      const r = await adopt({ ...base, pairing: { commit, ...mark, reveal: na } });
      if (r.status === 200 && r.body && r.body.data && r.body.data.owner) return done(r.body.data);
      if (!(r.status === 200 && r.body && r.body.data && r.body.data.pending)) return refuse(r);
      await new Promise(res => setTimeout(res, pollMs));
    }
  } catch (e) { stop(); throw e; }
}

/**
 * A phone's or computer's waiting pairing: wink.phone.wait. The first call carries the pairing's commit and this device's name (and, for a device joining a person's identity, its key entry); the other device
 * answers with its nonce; this device reveals its own, both derive the same three words, and the person at the other device says yes (a typed code's ack is that yes already).
 * @param {{ box: string, device: string, route: string, name?: string }} paired
 * @param {{ relay: string, ticket: string, deviceName?: string, entry?: any, crypto?: any, keyStore?: any, WebSocket?: any, onWords?: (words: string) => void, signal?: AbortSignal, pollMs?: number, timeoutMs?: number }} o
 * @returns {Promise<{ paired: true, enrolled: boolean, reason?: string, relay: string, route: string, box: string, device: string, name: string, identity?: { id: string, vyre?: string } }>}
 */
export async function waitPhone(paired, o) {
  const deviceName = o.deviceName || "a device";
  const conn = connect({ relay: o.relay, route: paired.route, box: paired.box, name: deviceName, crypto: o.crypto, keyStore: o.keyStore, WebSocket: o.WebSocket });
  const stop = () => { try { conn.close(); } catch { /* closed */ } };
  /** @param {any} input */
  const wait = async input => {
    const r = await callPending(conn, "wink.phone.wait", input);
    if (r.status === 200 && r.body && r.body.data) return r.body.data;
    const code = r.body && r.body.error && r.body.error.code;
    throw fail(code === "denied" ? "denied" : code === "expired" ? "expired" : "unreachable", String((r.body && r.body.error && r.body.error.message) || "The other device refused."));
  };
  try {
    const na = newNonce(), commit = await nonceCommit(na), tag = await ticketTag(o.ticket);
    const base = { commit, tag, name: deviceName.slice(0, 64), ...(o.entry ? { entry: o.entry } : {}) };
    const first = await wait(base);
    const nb = String(first && first.nb || "");
    if (!nb) throw fail("unreachable", "The other device did not start the pairing.");
    const words = await pairWords(String(paired.box), String(paired.device), { ticket: o.ticket, nonceA: na, nonceB: nb });
    if (o.onWords) o.onWords(words);
    const deadline = Date.now() + (o.timeoutMs ?? 5 * 60_000);
    const pollMs = o.pollMs ?? 1000;
    for (;;) {
      if (o.signal && o.signal.aborted) throw fail("cancelled", "Adding this device was cancelled.");
      if (Date.now() > deadline) throw fail("expired", "Nobody answered at the other device in time.");
      const r = await wait({ ...base, reveal: na });
      // the other device derives the same three words only after the reveal: a different set means someone sits between the two
      if (r.words && String(r.words) !== words) throw fail("denied", "The words did not match, so nothing was added. Start again from the other device.");
      if (r.state === "yes") { stop(); return { paired: true, enrolled: r.enrolled !== false, ...(r.enrolled === false && r.reason ? { reason: String(r.reason) } : {}), relay: o.relay, route: paired.route, box: paired.box, device: paired.device, name: paired.name || "", ...(r.identity && typeof r.identity.id === "string" ? { identity: { id: String(r.identity.id), ...(typeof r.identity.vyre === "string" ? { vyre: r.identity.vyre } : {}) } } : {}) }; }
      if (r.state === "no") throw fail("denied", "The other device said no, so nothing was added.");
      if (r.state === "expired") throw fail("expired", "Nobody answered at the other device in time.");
      await new Promise(res => setTimeout(res, pollMs));
    }
  } catch (e) { stop(); throw e; }
}
