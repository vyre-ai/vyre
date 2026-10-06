// @ts-check
// A device with NO box of its own is added to a person's identity from a device that already holds it ("Add this device from another device"): the joining side, the counterpart of
// serverpair.js. The existing device shows a code (wink.phone.open: `vyre://wink/2?t=<16-byte seed>&r=<relay>&k=phone`); this device redeems it over the relay, shows the person the three
// words, and the person at the existing device says yes only when they match. On that yes the existing device puts this device's identity key on the identity's signed list
// (spaces.identity.enrol), and the person's name then resolves to a list that holds this device. Nothing here needs Buffer or Node: it runs on a phone and in a browser.
//
//   const r = await addThisDevice({ payload, key: { publicKey, label: "Kit's phone" }, name: "Kit's phone", crypto, keyStore, onWords: w => show(w) });
//
// payload   the text of the existing device's QR, or the long code pasted.
// code      INSTEAD of payload: the typed WINK-NNPP-PPPP the existing device shows (with `relay`, the relay's address). This device runs the code's PAKE over the relay, shows `onAck(ack)` (the person types
//           that on the existing device), and then the same pairing follows with the ticket both ends derived from the code's key. The code is the confirmation: the existing device does not ask for the three words.
// presenceKey  optional, THIS device's presence key for its paired session ({ public_key: P-256 SPKI base64url, alg: -7, storage }): the owner's yes confirms it, and the device then signs presence.person.start-paired with it.
// key       THIS device's identity key: its public half (32 raw bytes, base64url) is sent to the existing device inside the pairing, over this device's own encrypted channel, so the yes at the
//           words covers it. The private half never leaves the device.
// onWords   called once with the three words this device derived. Show them: the person at the other device picks the same words from three sets.
// Resolves { paired: true, enrolled, relay, route, box, device, name, identity? }: `name` is the OTHER DEVICE'S name (the box), `identity` is the identity this device joined ({ id, vyre? }: its Vyre name when it has one), to read the identity's list by: `enrolled` says whether the identity list took the key (false with `reason` when the existing device could not sign the
// change, for example an identity it does not hold); persist relay, route, box and the key store when the person wants this device paired to that computer too. Rejects with an Error whose
// `code` is one of: bad_code, taken (the code was used, expired or never existed), busy, unreachable, denied (the person said no or the words did not match), expired, cancelled.
import { pairTicket, connect } from "./client.js";
import { typeWinkCode } from "./join.js";
import { parseCode } from "./code.js";
import { avatarBytesToCode } from "./avatarcode.js";
import { nonceCommit, ticketTag, newNonce, pairWords } from "./pairwords.js";

const b64u = (/** @type {string} */ s) => { try { const t = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(t, c => c.charCodeAt(0)); } catch { return null; } };
const toB64u = (/** @type {Uint8Array} */ b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** Reads a phone's QR or long code (`k=phone`): { seed, relay } or null. A server's code is not a phone's. @param {string} s @returns {{ seed: Uint8Array, relay: string } | null} */
export function parsePhonePayload(s) {
  const m = /^vyre:\/\/wink\/2\?(.*)$/.exec(String(s).trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  if (q.get("k") !== "phone") return null;
  const seed = b64u(q.get("t") || "");
  return seed && seed.length === 16 ? { seed, relay: q.get("r") || "" } : null;
}

/**
 * @param {{ payload: string, key: { publicKey: string, label?: string, agree?: string, held?: "web" | boolean, enclave?: string, attest?: string }, name?: string, crypto?: any, keyStore?: any, WebSocket?: any, relay?: string, about?: any,
 *   avatar?: ArrayLike<number>, presenceKey?: { public_key: string, alg?: number, storage?: "hardware"|"software" }, code?: string, onAck?: (ack: string, expires?: number) => void, fetch?: typeof fetch,
 *   onWords?: (words: string) => void, signal?: AbortSignal, pollMs?: number, timeoutMs?: number }} o
 */
export async function addThisDevice(o) {
  /** @type {{ seed: Uint8Array, relay: string } | null} */ let scan;
  /** the typed code's end in epoch ms, when the relay said it: the wait for the ack runs to it */ let typedEnd = 0;
  // The camera reader's picture of the typed code (the avatar's 8 bytes) is the code itself.
  if (o.code === undefined && o.avatar !== undefined && o.payload === undefined) { const c = avatarBytesToCode(o.avatar); if (!c) throw fail("bad_code", "That is not a Vyre code. Scan the avatar the other device shows."); o = { ...o, code: c }; }
  if (o.code !== undefined && o.payload === undefined) {
    if (!parseCode(String(o.code))) throw fail("bad_code", "That is not a code. Type the code the other device shows, like WINK-K7QM-4P2X.");
    if (!o.relay) throw fail("bad_code", "addThisDevice needs the relay's address to use a typed code");
    const t = await typeWinkCode({ relay: o.relay, input: String(o.code), ...(o.fetch ? { fetch: o.fetch } : {}) });
    if (!t.ok) throw fail(t.reason === "offline" ? "unreachable" : t.reason === "busy" ? "busy" : "taken", t.reason === "offline" ? "The relay could not be reached." : t.reason === "busy" ? "Too many tries; wait a minute." : "That code did not work. Check it on the other device, or ask for a new one.");
    if (o.onAck) o.onAck(t.ack, t.expires);
    scan = { seed: t.seed, relay: o.relay };
    typedEnd = t.expires || 0;
  } else scan = parsePhonePayload(String(o.payload));
  if (!scan) throw fail("bad_code", "That is not a code for adding a device. On the device that is already signed in, choose Add a device and scan or paste the code it shows.");
  const raw = o.key && typeof o.key.publicKey === "string" ? b64u(o.key.publicKey) : null;
  if (!raw || raw.length !== 32) throw fail("bad_code", "addThisDevice needs this device's identity key (32 bytes, base64url)");
  const relay = o.relay || scan.relay;
  const ticket = toB64u(scan.seed);
  const deviceName = o.name || "a device";
  /** @type {any} */ let paired;
  try {
    // A typed code's ticket appears at the relay only once the person has typed the ack back on the other device: ask until it does (or the wait runs out).
    const until = typedEnd && o.timeoutMs === undefined ? typedEnd : Date.now() + (o.timeoutMs ?? 5 * 60_000);
    for (;;) {
      try {
        paired = await pairTicket(scan.seed, { relay, name: deviceName, ...(o.presenceKey ? { presenceKey: o.presenceKey } : {}), crypto: o.crypto, keyStore: o.keyStore, WebSocket: o.WebSocket, ...(o.about ? { about: o.about } : {}) });
        break;
      } catch (e) {
        if (o.code === undefined || /** @type {any} */ (e).code !== "ticket_gone" || Date.now() > until || (o.signal && o.signal.aborted)) throw e;
        await new Promise(res => setTimeout(res, o.pollMs ?? 1000));
      }
    }
  } catch (e) {
    const code = /** @type {any} */ (e).code;
    const said = String(/** @type {Error} */ (e).message || "");
    throw fail(code === "ticket_used" || code === "expired" || code === "not_found" || /expired|already used/i.test(said) ? "taken" : code === "rate_limited" || /too many/i.test(said) ? "busy" : "unreachable", said);
  }
  if (!paired.pending) throw fail("unreachable", "The other device did not ask who is joining. Make a new code there and try again.");
  const conn = connect({ relay, route: paired.route, box: paired.box, name: deviceName, crypto: o.crypto, keyStore: o.keyStore, WebSocket: o.WebSocket });
  const stop = () => { try { conn.close(); } catch { /* closed */ } };
  /** One call of the pairing's own tool, answered with its data or thrown with the remote's code. @param {any} input */
  const wait = async input => {
    /** @type {any} */ let to;
    const r = await Promise.race([conn.fetch("/v1/tools/wink.phone.wait", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }), new Promise((_, rej) => { to = setTimeout(() => rej(fail("unreachable", "The other device did not answer.")), 15_000); })]).finally(() => clearTimeout(to));
    const body = /** @type {any} */ (await /** @type {any} */ (r).json().catch(() => null));
    if (/** @type {any} */ (r).status === 200 && body && body.data) return body.data;
    const code = body && body.error && body.error.code;
    throw fail(code === "denied" ? "denied" : code === "expired" ? "expired" : "unreachable", String((body && body.error && body.error.message) || "The other device refused."));
  };
  try {
    const na = newNonce(), commit = await nonceCommit(na), tag = await ticketTag(ticket);
    const entry = { publicKey: o.key.publicKey, ...(o.key.label ? { label: String(o.key.label).slice(0, 60) } : {}), ...(typeof o.key.agree === "string" ? { agree: o.key.agree } : {}),
      // what the chain may be told about this key: a key a page script can reach says so (`held: "web"`: it cannot change who speaks for the identity), a chip key says which (`enclave`), and a platform proof of it (`attest`);
      // the existing device copies these into the entry (core/wink/pairing.js entryExtras) and the identity chain decides what each is worth
      ...(o.key.held === "web" || o.key.held === true ? { held: "web" } : {}), ...(typeof o.key.enclave === "string" ? { enclave: o.key.enclave } : {}), ...(typeof o.key.attest === "string" ? { attest: o.key.attest } : {}) };
    const base = { commit, tag, name: deviceName.slice(0, 64), entry };
    const first = await wait(base);
    const nb = String(first && first.nb || "");
    if (!nb) throw fail("unreachable", "The other device did not start the pairing.");
    const words = await pairWords(String(paired.box), String(paired.device), { ticket, nonceA: na, nonceB: nb });
    if (o.onWords) o.onWords(words);
    const deadline = Date.now() + (o.timeoutMs ?? 5 * 60_000);
    const pollMs = o.pollMs ?? 1000;
    for (;;) {
      if (o.signal && o.signal.aborted) throw fail("cancelled", "Adding this device was cancelled.");
      if (Date.now() > deadline) throw fail("expired", "Nobody answered at the other device in time.");
      const r = await wait({ ...base, reveal: na });
      // the other device derives the same three words only after the reveal: a different set means someone sits between the two
      if (r.words && String(r.words) !== words) throw fail("denied", "The words did not match, so nothing was added. Start again from the other device.");
      if (r.state === "yes") { stop(); return { paired: true, enrolled: r.enrolled !== false, ...(r.enrolled === false && r.reason ? { reason: String(r.reason) } : {}), relay, route: paired.route, box: paired.box, device: paired.device, name: paired.name, ...(r.identity && typeof r.identity.id === "string" ? { identity: { id: String(r.identity.id), ...(typeof r.identity.vyre === "string" ? { vyre: r.identity.vyre } : {}) } } : {}) }; }
      if (r.state === "no") throw fail("denied", "The other device said no, so nothing was added.");
      if (r.state === "expired") throw fail("expired", "Nobody answered at the other device in time.");
      await new Promise(res => setTimeout(res, pollMs));
    }
  } catch (e) { stop(); throw e; }
}
