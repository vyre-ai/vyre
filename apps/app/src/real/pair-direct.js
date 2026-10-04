// @ts-check
// Pair a fresh SERVER from a device that has only claimed an identity (no box of its own): the user's install order, identity first, then the server.
// The same steps core/wink/pairing.js startTyping and adopt take on a computer, here in the app, with the relay client and the identity key:
//   1. the long code (vyre://wink/2?t=<16 bytes>&r=<relay>) is the ticket seed: finishJoin(once) redeems it at the relay and pairs this device with the server;
//   2. over the paired channel it calls wink.server.adopt: the owner is THIS identity (id and name), with a proof (a signature by a key on the identity's list over
//      "vyre-wink-pair-to-v1 / box / device", Q-3), and the three words come from a commit-then-reveal of two nonces (pairwords.js): the app sends sha256(its nonce),
//      the server answers with its own nonce, the app reveals, both show the same three words;
//   3. the person at the server says yes; the call then answers not-pending and the server is this identity's.
// Every effect (the redeem, the call over the channel, the clock, the signer) is passed in, so Node tests it with fakes.

import { finishJoin } from "../../../../relay/client/join.js";
import { connect } from "../../../../relay/client/client.js";
import { pairWords, nonceCommit, ticketTag, newNonce } from "../../../../relay/client/pairwords.js";

const b64u = (/** @type {Uint8Array} */ b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const fromB64u = (/** @type {string} */ s) => { const t = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(t, (c) => c.charCodeAt(0)); };
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** What the app signs to prove it is the identity a server was installed for: this pairing's box and device (the same bytes core/wink/pairing.js pairToMessage makes). */
export const pairToMessage = (/** @type {string} */ box, /** @type {string} */ device) => new TextEncoder().encode(`vyre-wink-pair-to-v1\n${box}\n${device}`);

/** The seed (16 bytes) and the relay out of a long code's ticket and relay fields. @param {string} ticket @param {string} relay */
export function seedOf(ticket, relay) {
  let seed = new Uint8Array(0);
  try { seed = fromB64u(ticket); } catch { /* not base64 */ }
  if (seed.length !== 16) throw fail("bad_input", "That is not a Vyre code.");
  if (!/^wss?:\/\/[^\s/]+/.test(relay)) throw fail("bad_input", "That code names no relay.");
  return seed;
}

/** One tool call over the paired channel (the relay client's Noise channel to the server). */
export async function callOverChannel(/** @type {any} */ paired, /** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ pairOptions = {}) {
  const c = connect({ relay: paired.relay, route: paired.route, box: paired.box, name: "Vyre", ...pairOptions });
  try {
    const r = await c.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const j = await r.json().catch(() => null);
    if (r.status >= 300 || !j || j.error) throw Object.assign(fail("unavailable", String((j && j.error && j.error.message) || `the server answered ${r.status}`)), { remote: String((j && j.error && j.error.code) || "") });
    return j.data;
  } finally { try { c.close(); } catch { /* closed */ } }
}

/**
 * @param {{
 *   ticket: string, relay: string, deviceName: string,
 *   identity: { id: string, name: string, eid: string, sign: (m: Uint8Array) => Promise<Uint8Array> },
 *   onWords?: (words: string) => void, pairOptions?: any,
 *   finish?: typeof finishJoin, call?: (paired: any, tool: string, input: any) => Promise<any>,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>, pollMs?: number, random?: (n: number) => Uint8Array,
 * }} o
 * @returns {Promise<{ paired: any }>} the pairing to keep (savePairing) once the person at the server has said yes
 */
export async function pairServerDirect(o) {
  const now = o.now ?? Date.now, sleep = o.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  const finish = o.finish ?? finishJoin;
  const call = o.call ?? ((p, t, i) => callOverChannel(p, t, i, o.pairOptions));
  const seed = seedOf(o.ticket, o.relay);
  const f = await finish({ relay: o.relay, seed, name: o.deviceName, once: true, waitMs: 60_000, pairOptions: o.pairOptions });
  if (!f.ok) throw fail(f.reason === "gone" ? "ticket_gone" : "pair_failed", f.reason === "gone" ? "This code was already used or has run out. Make a new one on the server." : f.reason === "expired" ? "The code ran out. Make a new one on the server." : "Could not reach the server through the relay. Check the code and try again.");
  const paired = f.paired || {};
  if (!paired.box || !paired.device || !paired.route) throw fail("pair_failed", "The server did not finish pairing.");
  const seedText = b64u(seed);
  const na = o.random ? Array.from(o.random(16), (x) => x.toString(16).padStart(2, "0")).join("") : newNonce();
  const commit = await nonceCommit(na), tag = await ticketTag(seedText);
  const sig = await o.identity.sign(pairToMessage(String(paired.box), String(paired.device)));
  const input = { owner: { kind: "identity", id: o.identity.id, name: String(o.identity.name).slice(0, 64) }, identity: o.identity.id,
    peerSecret: b64u(o.random ? o.random(24) : crypto.getRandomValues(new Uint8Array(24))), handover: { device: String(paired.device) },
    proof: { eid: o.identity.eid, sig: b64u(sig) } };
  const body = (/** @type {any} */ more) => ({ ...input, pairing: { commit, tag, ...more } });
  let mine = "";
  const cancel = () => { void call(paired, "wink.server.adopt", { ...input, pairing: { cancel: true, commit, tag } }).catch(() => null); };
  try {
    for (let n = 0; n < 1000; n++) {
      const r = await call(paired, "wink.server.adopt", body(mine ? { reveal: na } : {}));
      if (!r || !r.pending) return { paired };
      if (!mine && r.nb) {
        mine = await pairWords(String(paired.box), String(paired.device), { ticket: seedText, nonceA: na, nonceB: String(r.nb) }).catch(() => "");
        if (mine) continue; // reveal at once
      }
      if (r.words && (!mine || String(r.words) !== mine)) throw fail("mismatch", "The three words do not match. Nothing was paired.");
      if (mine && r.words && o.onWords) o.onWords(mine);
      if (Number(r.until) && now() >= Number(r.until)) throw fail("expired", "Nobody answered at the server in time. Nothing was paired.");
      await sleep(o.pollMs ?? 500);
    }
  } catch (e) {
    if (!/** @type {any} */ (e).remote) cancel();
    throw e;
  }
  throw fail("expired", "Nobody answered at the server in time. Nothing was paired.");
}
