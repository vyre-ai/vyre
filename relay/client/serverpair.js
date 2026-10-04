// @ts-check
// A device with NO box of its own pairs a fresh server (the iPhone's first run): it holds only its claimed identity. It redeems the server's wink/2 code over the relay, shows the person the
// three words, and the person at the server confirms them; the server then records this identity, with its name, as its owner. Everything runs on this device through the relay client:
// no wink tool of a box of its own is called (src/real/pairing.ts calls those; a box-less device has none).
//
//   const r = await pairServer({ payload, owner: { id: "per_...", name: "Alex" }, name: "Alex's iPhone", crypto, keyStore, onWords: w => show(w) });
//
// payload   the text of the server's QR, or the long code pasted: `vyre://wink/2?t=<16-byte seed, base64url>&r=<relay wss url>`.
// owner     the CLAIMED identity (id and name). The server shows the name to the person at the server and records it as the owner. If the server was installed with --pair-to, the server also
//           needs `proof` (an identity-list key's signature, see core/wink/pairing.js proveIdentity); pass it as `proof: { eid, sig }`.
// onWords   called once with the three words this device derived. Show them: the person at the server picks the same words from three sets, and only then is anything paired.
// Resolves { paired: true, relay, route, box, device, name, owner }: persist relay, route, box and the key store; `connect()` from client.js then reaches the server as a paired device. Rejects with
// an Error whose `code` is one of: not_hardware (a release server takes its owner's proof only from a phone's hardware-held key: "Pair this server from Vyre on your phone"), denied_no_proof (the app sent no identity proof), denied_wrong_proof (its key did not prove the claimed identity), cannot_check (the server could not reach the names directory to check who this is: try again), bad_code, bad_owner (the server refused the identity or its id), taken (the code was already used or expired), busy, denied (the person said no or picked other words), expired (nobody answered in time),
// unreachable (the relay or the server did not answer), cancelled.
import { pairTicket, connect } from "./client.js";
import { nonceCommit, ticketTag, newNonce, pairWords } from "./pairwords.js";

const b64u = (/** @type {string} */ s) => { try { const t = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(t, c => c.charCodeAt(0)); } catch { return null; } };
const toB64u = (/** @type {Uint8Array} */ b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** Reads a server's QR or long code: { seed, relay } or null. A phone's code (`k=phone`) is not a server's. @param {string} s @returns {{ seed: Uint8Array, relay: string } | null} */
export function parseServerPayload(s) {
  const m = /^vyre:\/\/wink\/2\?(.*)$/.exec(String(s).trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  if (q.get("k") === "phone") return null;
  const seed = b64u(q.get("t") || "");
  return seed && seed.length === 16 ? { seed, relay: q.get("r") || "" } : null;
}

/**
 * @param {{ payload: string, owner: { id: string, name?: string, vyre?: string, pin?: { id: string, seq: number, head: string }, kind?: "identity" | "space" }, name?: string, proof?: { eid: string, sig: string },
 *   deviceKind?: "phone" | "computer" | "web", keyStorage?: "hardware" | "software", signIdentity?: (message: Uint8Array) => Promise<{ eid: string, sig: string, esig?: string }> | { eid: string, sig: string, esig?: string }, crypto?: any, keyStore?: any, WebSocket?: any, relay?: string, about?: { kind?: "app" | "web", release?: string, manifest?: string }, presenceKey?: any, passkey?: any,
 *   onWords?: (words: string) => void, signal?: AbortSignal, pollMs?: number, timeoutMs?: number }} o
 */
export async function pairServer(o) {
  const scan = parseServerPayload(o.payload);
  if (!scan) throw fail("bad_code", "That is not a Vyre server code. Scan the code on the server's screen, or paste the long code it printed.");
  if (!o.owner || typeof o.owner.id !== "string" || !o.owner.id) throw fail("bad_code", "pairServer needs the identity that will own the server");
  const relay = o.relay || scan.relay;
  const ticket = toB64u(scan.seed);
  const deviceName = o.name || "a device";
  /** @type {any} */ let paired;
  try {
    paired = await pairTicket(scan.seed, { relay, name: deviceName, crypto: o.crypto, keyStore: o.keyStore, WebSocket: o.WebSocket, ...(o.about ? { about: o.about } : {}), ...(o.presenceKey ? { presenceKey: o.presenceKey } : {}), ...(o.passkey ? { passkey: o.passkey } : {}) });
  } catch (e) {
    const code = /** @type {any} */ (e).code;
    throw fail(code === "ticket_used" || code === "expired" || code === "not_found" ? "taken" : code === "rate_limited" ? "busy" : "unreachable", /** @type {Error} */ (e).message);
  }
  if (!paired.pending) throw fail("unreachable", "The server did not ask who is pairing. Make a new code on the server and try again.");
  const conn = connect({ relay, route: paired.route, box: paired.box, name: deviceName, crypto: o.crypto, keyStore: o.keyStore, WebSocket: o.WebSocket });
  const stop = () => { try { conn.close(); } catch { /* closed */ } };
  /** @param {any} input */
  const adopt = async input => {
    const r = await Promise.race([conn.fetch("/v1/tools/wink.server.adopt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }), new Promise((_, rej) => setTimeout(() => rej(fail("unreachable", "The server did not answer.")), 15_000))]);
    const body = /** @type {any} */ (await /** @type {any} */ (r).json().catch(() => null));
    return { status: /** @type {any} */ (r).status, body };
  };
  const owner = { kind: o.owner.kind || "identity", id: o.owner.id, ...(o.owner.name ? { name: String(o.owner.name).slice(0, 64) } : {}), ...(/** @type {any} */ (o.owner).vyre ? { vyre: String(/** @type {any} */ (o.owner).vyre).slice(0, 253) } : {}), ...(/** @type {any} */ (o.owner).pin ? { pin: /** @type {any} */ (o.owner).pin } : {}) };
  // The proof that the identity's own key stands behind this pairing: its signature over this pairing's box and relay device (the same message a --pair-to server checks). Given ready-made
  // (`proof`) or made here from the device's identity key (`signIdentity`); a device with neither is checked by the three words alone.
  /** @type {{ eid: string, sig: string } | undefined} */ let proof = o.proof;
  // the message names this pairing's own ticket tag, so the proof is good for this pairing only (PI-3); a phone's key adds its Face ID signature `esig` over the same message (PI-1)
  if (!proof && o.signIdentity) proof = await o.signIdentity(new TextEncoder().encode(`vyre-wink-pair-to-v1\n${paired.box}\n${paired.device}\n${await ticketTag(ticket)}`));
  const base = { owner, identity: owner.kind === "identity" ? owner.id : undefined, ...(proof ? { proof } : {}), ...(o.deviceKind ? { deviceKind: o.deviceKind, deviceName: deviceName } : {}), ...(o.keyStorage ? { keyStorage: o.keyStorage } : {}) };
  const refuse = (/** @type {any} */ r) => {
    const e = r.body && r.body.error;
    const code = e && e.code;
    throw fail(code === "busy" ? "busy" : code === "expired" ? "expired" : code === "denied" ? "denied" : code === "denied_no_proof" || code === "denied_wrong_proof" ? code : code === "bad_input" ? "bad_owner" : code === "not_hardware" ? "not_hardware" : code === "unavailable" ? "cannot_check" : "unreachable", (e && e.message) || "The server refused.");
  };
  try {
    const na = newNonce(), commit = await nonceCommit(na), tag = await ticketTag(ticket);
    const first = await adopt({ ...base, pairing: { commit, tag } });
    if (first.status !== 200 || !first.body || !first.body.data) return refuse(first);
    // a proven (--pair-to) server answers the owner at once; a first adoption answers pending with the server's nonce
    if (first.body.data.owner) { stop(); return { paired: true, relay, route: paired.route, box: paired.box, device: paired.device, name: paired.name, owner: first.body.data.owner, session: first.body.data.session !== false }; }
    const nb = String(first.body.data.nb || "");
    if (!nb) throw fail("unreachable", "The server did not start the pairing.");
    const words = await pairWords(String(paired.box), String(paired.device), { ticket, nonceA: na, nonceB: nb });
    if (o.onWords) o.onWords(words);
    const deadline = Date.now() + (o.timeoutMs ?? 5 * 60_000);
    const pollMs = o.pollMs ?? 1000;
    for (;;) {
      if (o.signal && o.signal.aborted) { await adopt({ ...base, pairing: { commit, tag, cancel: true } }).catch(() => null); throw fail("cancelled", "Pairing was cancelled."); }
      if (Date.now() > deadline) throw fail("expired", "Nobody answered at the server in time.");
      const r = await adopt({ ...base, pairing: { commit, tag, reveal: na } });
      if (r.status === 200 && r.body && r.body.data && r.body.data.owner) { stop(); return { paired: true, relay, route: paired.route, box: paired.box, device: paired.device, name: paired.name, owner: r.body.data.owner, session: r.body.data.session !== false }; }
      if (!(r.status === 200 && r.body && r.body.data && r.body.data.pending)) return refuse(r);
      await new Promise(res => setTimeout(res, pollMs));
    }
  } catch (e) { stop(); throw e; }
}
