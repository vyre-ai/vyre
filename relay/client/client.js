// @ts-check
// client: the device side of the relay for the Expo app (web, iOS, Android) and for Node tests.
// `pair()` scans the QR offer and runs the first handshake; `connect()` keeps a channel to the box
// open and puts fetch, event streams and WebSockets on top of it (ADR 0026, sections 3, 4, 6, 8).
//
// Resilience (ADR 0029): reconnects back off from 1 s to 60 s with jitter and handshake afresh;
// a text "ping" at most every 60 s, answered "pong" by the relay, and two missed pongs are a stall;
// nothing keeps alive while the page or app is hidden, and coming back reconnects at once; event
// streams resume with Last-Event-ID; every non-GET carries an Idempotency-Key, and a request whose
// response was lost to a dropped channel is sent once more on the next channel with the same key.

import { dial, FRAME, MAX_FRAME } from "./channel.js";
import { EMPTY, base64url, fromBase64url, base32, utf8, fromUtf8, toBytes, concat, equal, uuidFrom } from "./bytes.js";
import { Pipe, makeResponse, lowerHeaders } from "./response.js";
import { followEvents } from "./sse.js";
import { webCrypto, indexedDbKeyStore } from "./webcrypto.js";

export const PAIR_BASE = "https://vyre.run/pair";
const PING_MS = 60_000;
const BACKOFF = { min: 1000, max: 60_000 };
const HANDSHAKE_MS = 15_000;
const ROUTE_RE = /^[a-z2-7]{26}$/;

/** The WebSocket API accepts only 1000 and 3000 to 4999 from an application. */
const closeCode = c => c === 1000 || (c >= 3000 && c <= 4999) ? c : 4000;
const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

/**
 * The offer in a scanned URL, or null when it is not one of ours. Same format as core/relay/pairing.js.
 * @param {string} url
 * @returns {{ relay: string, route: string, box: Uint8Array, secret: string, name: string } | null}
 */
export function parsePairUrl(url) {
  const u = String(url);
  const at = u.indexOf("#");
  if (at < 0 || !u.startsWith(PAIR_BASE)) return null;
  let o;
  try { o = JSON.parse(fromUtf8(fromBase64url(u.slice(at + 1)))); } catch { return null; }
  if (!o || o.v !== 1 || typeof o.r !== "string" || !ROUTE_RE.test(o.i) || typeof o.s !== "string" || typeof o.k !== "string") return null;
  let box;
  try { box = fromBase64url(o.k); } catch { return null; }
  if (box.length !== 32 || !/^wss?:\/\/[^\s/]+/.test(o.r)) return null;
  return { relay: o.r, route: o.i, box, secret: o.s, name: typeof o.n === "string" ? o.n.slice(0, 64) : "" };
}

/**
 * The page's or app's visibility. The default reads `document.visibilityState`; React Native
 * passes one built on AppState. `on` returns an unsubscribe.
 * @typedef {{ hidden(): boolean, on(fn: () => void): () => void }} Visibility
 * @returns {Visibility}
 */
export function defaultVisibility() {
  const doc = /** @type {any} */ (globalThis).document;
  if (!doc || typeof doc.addEventListener !== "function") return { hidden: () => false, on: () => () => {} };
  return {
    hidden: () => doc.visibilityState === "hidden",
    on(fn) { doc.addEventListener("visibilitychange", fn); return () => doc.removeEventListener("visibilitychange", fn); },
  };
}

/** What the relay passes on, exactly, when the box says it removed this device (close code 4401). It is the relay's claim, not proof. */
export const REMOVED = "device removed";

/** The device's static key from the store, made and stored on first use. */
export async function deviceKey({ keyStore, crypto }) {
  let k = await keyStore.get();
  if (!k) { k = await crypto.generateKeyPair(); await keyStore.set(k); }
  return k;
}

const defaults = o => ({
  crypto: o.crypto || webCrypto(),
  keyStore: o.keyStore || indexedDbKeyStore(),
  WebSocket: o.WebSocket || globalThis.WebSocket,
});

/**
 * One WebSocket to the relay and one handshake with the box.
 * @returns {Promise<{ channel: import("./channel.js").Channel, reply: any, ws: any }>}
 */
export function openChannel(o) {
  return new Promise((resolve, reject) => {
    const WS = o.WebSocket;
    if (!WS) { reject(new Error("no WebSocket here: pass one")); return; }
    let ws;
    try { ws = new WS(`${String(o.relay).replace(/\/+$/, "")}/v1/device?route=${encodeURIComponent(o.route)}`); } catch (e) { reject(e); return; }
    try { ws.binaryType = "arraybuffer"; } catch {}
    /** @type {ReturnType<typeof dial> | null} */
    let side = null;
    let done = false;
    const fail = msg => { if (done) return; done = true; globalThis.clearTimeout(timer); reject(new Error(msg)); };
    const timer = globalThis.setTimeout(() => { fail("the box did not answer"); try { ws.close(4000, "timeout"); } catch {} }, o.timeout ?? HANDSHAKE_MS);
    ws.onopen = () => {
      side = dial({
        send: b => { try { ws.send(b); } catch {} },
        close: (c, r) => { try { ws.close(closeCode(c), String(r || "").slice(0, 120)); } catch {} },
      }, { crypto: o.crypto, s: o.keys, box: o.box, route: o.route, hello: o.hello, rekeyEvery: o.rekeyEvery });
      side.ready.then(({ channel, reply }) => {
        if (done) { channel.close(1000, "too late"); return; }
        done = true;
        globalThis.clearTimeout(timer);
        resolve({ channel, reply, ws });
      }, e => fail(e.message));
    };
    ws.onmessage = e => {
      const d = e.data;
      if (typeof d === "string") { if (d === "pong") o.onpong?.(); return; }
      if (side) side.receive(toBytes(d));
    };
    ws.onclose = e => {
      const reason = (e && e.reason) || `closed ${e && e.code}`;
      if (side) side.gone(reason); else fail(reason);
    };
    // On Node 22 a refused WebSocket fires only `error`, never `close`: before the socket opens,
    // that is a failed dial, so the backoff runs now rather than after the handshake timeout.
    ws.onerror = () => { if (!side) { fail("could not reach the relay"); try { ws.close(); } catch {} } };
  });
}

/**
 * What a device says about itself in every hello (ADR 0026 section 10): the hosted web app sends
 * kind "web" and the release and manifest hash it loaded, so the box can show the build.
 * @param {{ kind?: "app"|"web", release?: string, manifest?: string } | undefined} a
 */
const about = a => ({
  ...(a && (a.kind === "web" || a.kind === "app") ? { kind: a.kind } : {}),
  ...(a && typeof a.release === "string" ? { release: a.release } : {}),
  ...(a && typeof a.manifest === "string" ? { manifest: a.manifest } : {}),
});

/**
 * The handshake both `pair()` and `pairOffer()`'s callers run once they have an offer, whichever
 * way they got it: make (or reuse) this device's key, prove the one-time secret and learn this
 * device's id. Returns what `connect()` needs; store it (it holds no secret). Exported (not just
 * internal) so a caller that already confirmed an offer with the person, `resolveTicket()`'s
 * result, after a "pair with this box?" screen, can run the handshake as its own, separate step
 * (reviewer, 28 Sep MEDIUM: pairTicket alone could only show who it paired with after the fact).
 * @param {{ relay: string, route: string, box: Uint8Array, secret: string, name?: string }} offer
 * @param {{ name?: string, enroll?: boolean, presenceKey?: { public_key: string, alg?: number, storage?: "hardware"|"software" }, passkey?: { credential_id: string, public_key: string, alg?: number, rp_id: string }, about?: { kind?: "app"|"web", release?: string, manifest?: string }, keyStore?: import("./webcrypto.js").KeyStore,
 *   crypto?: import("./noise.js").CryptoProvider, WebSocket?: any, timeout?: number, onFingerprint?: (fingerprint: string) => void }} [o]
 */
export async function pairOffer(offer, o = {}) {
  const d = defaults(o);
  const keys = await deviceKey(d);
  // The box's screen shows this phone's fingerprint beside Confirm (pairing.requested). Hand the same one to the app before the
  // handshake, which waits for that Confirm, so this phone's own screen shows it too and the person compares two.
  if (typeof o.onFingerprint === "function") { try { o.onFingerprint(await keyFingerprint(keys.publicKey, d.crypto)); } catch {} }
  const hello = { v: 1, ...about(o.about), pair: offer.secret, name: o.name || "a device", ...(o.presenceKey ? { presenceKey: o.presenceKey } : {}), ...(o.passkey ? { passkey: o.passkey } : {}), ...(o.enroll ? { enroll: true } : {}) };
  let channel, reply;
  try { ({ channel, reply } = await openChannel({ ...d, relay: offer.relay, route: offer.route, box: offer.box, keys, hello, timeout: o.timeout })); }
  catch (e) { throw /** @type {any} */ (e).code ? e : fail("pair_failed", /** @type {Error} */ (e).message); }
  channel.close(1000, "paired");
  return {
    relay: offer.relay, route: offer.route, box: base64url(offer.box),
    name: promptSafe((reply && reply.box && reply.box.name) || offer.name, "a Vyre box"),
    // A gated ticket (the box's QR for a phone or a server) makes no device until its person confirms: the reply then names the id this device WILL have (`pending`), `pending: true` here,
    // and the wink calls that finish the pairing run over a channel that can reach only the one tool they need. Once confirmed, an ordinary connect is a paired device.
    device: reply && (reply.device || reply.pending), ...(reply && reply.pending ? { pending: true } : {}), presence: (reply && reply.presence) || null,
    // Only when asked (o.enroll) and the box has an address: the one-time grant to enroll this
    // device's own passkey there (core/relay), { grant, expires, rpId }; null otherwise.
    enroll: o.enroll ? enrollOf(reply && reply.enroll) : null,
  };
}

/** The box's enrolment grant when it is well formed (a base64url grant, a time, a bare host), else null. @param {any} e */
function enrollOf(e) {
  if (!e || typeof e.grant !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(e.grant)) return null;
  if (typeof e.rpId !== "string" || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(e.rpId) || e.rpId.length > 253) return null;
  return { grant: e.grant, expires: Number(e.expires) || 0, rpId: e.rpId.toLowerCase() };
}

/**
 * Whether a relay URL named inside a record is exactly the relay that served it: a ws or wss origin with the same scheme and host as
 * the one asked, and nothing else in it.
 * @param {string} named @param {string} asked
 */
export function sameRelay(named, asked) {
  try {
    const a = new URL(String(named)), b = new URL(String(asked).replace(/\/+$/, ""));
    if (a.protocol !== "wss:" && a.protocol !== "ws:") return false;
    if (a.username || a.password || a.search || a.hash || (a.pathname !== "/" && a.pathname !== "")) return false;
    return a.protocol === b.protocol && a.host === b.host;
  } catch { return false; }
}

/**
 * Pair with a box from its QR offer: the fragment carries the whole offer, so it never reaches a
 * server (ADR 0026 section 6).
 * @param {string} offerUrl
 * @param {Parameters<typeof pairOffer>[1]} [o]
 */
export async function pair(offerUrl, o = {}) {
  const offer = parsePairUrl(offerUrl);
  if (!offer) throw fail("bad_input", "not a Vyre pairing code");
  return pairOffer(offer, o);
}

/**
 * The same short fingerprint core/relay/index.js shows in its own Touch ID prompt (base32 of
 * sha256 of a box's public key, 8 characters as two groups of 4), so a phone's own "pairing with
 * X (fingerprint)" screen reads identically to what the box shows. Not a security check by
 * itself, pairTicket() already verifies the record's MAC before this is ever worth computing;
 * just the same human-readable confirmation on both ends of one pairing.
 * @param {Uint8Array} box @param {import("./noise.js").CryptoProvider} crypto
 */
export async function keyFingerprint(box, crypto) {
  const s = base32(await crypto.sha256(box)).slice(0, 8);
  return `${s.slice(0, 4)} ${s.slice(4)}`;
}

// Stable codes on resolveTicket/pairOffer's own errors (reviewer's LOW, 28 Sep), so a caller
// tells expired/used, rate-limited and a failed check apart without matching message text, which
// a later wording change could otherwise silently turn a MAC failure into a generic retry.
const fail = (code, message) => Object.assign(new Error(message), { code });

const TICKET_TAG = { loc: "vyre-pair-loc", sec: "vyre-pair-sec", mac: "vyre-pair-mac", enc: "vyre-pair-enc" };
// core/relay/wire.js's ticketSeal: AES-256-GCM under the ticket's "enc" key, a random 12-byte nonce
// in front of the ciphertext, this AD. The relay only ever holds the sealed bytes.
const TICKET_SEAL_AD = "vyre-pair-record\n1";
/** @param {import("./noise.js").CryptoProvider} crypto @param {"loc"|"sec"|"mac"|"enc"} which @param {Uint8Array} ticket */
const ticketDerive = (crypto, which, ticket) => crypto.sha256(concat(utf8(`${TICKET_TAG[which]}\n`), ticket));

// The box's own name, reported by the relay (never signed by anything the relay holds) or later
// by the box itself in the handshake reply: same stripping as core/relay/index.js's promptSafe,
// so a name shown in a confirm line can't carry a control character, a bidi override or the like.
const PROMPT_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g;
const promptSafe = (s, fallback, max = 64) => { const t = String(s || "").replace(PROMPT_UNSAFE, " ").replace(/ {2,}/g, " ").trim().slice(0, max); return t || fallback; };

/**
 * Look up a compact pairing ticket (ADR 0045, "Wink") against the relay, verify it, and hand back
 * an offer ready for `pairOffer()`, without pairing yet. Split from the handshake itself
 * (reviewer, 28 Sep MEDIUM) so a caller can show "Pair with alex's box (a1b2 c3d4)?" and let the
 * person confirm BEFORE anything is paired: the MAC here proves the record came from whoever
 * minted the ticket, not that it is the person's own box, someone else's code, scanned by
 * mistake, still passes the MAC. Recognising the name and fingerprint is the only thing that
 * catches that, so it has to happen before the handshake, not after.
 *
 * The ticket itself never leaves this device; every value the relay sees is a one-way derivation
 * of it under its own tag, matching core/relay/wire.js byte for byte, so the relay can neither
 * redeem this pairing (it never learns the secret), nor substitute its own record (it never learns
 * the MAC key that authenticates it), nor read the record (sealed under the "enc" key, opened here).
 * @param {Uint8Array} ticket 8 random bytes, scanned from the Vyre code
 * @param {{ relay: string, fetch?: typeof fetch, crypto?: import("./noise.js").CryptoProvider }} o
 * @returns {Promise<{ offer: { relay: string, route: string, box: Uint8Array, secret: string }, name: string, fingerprint: string, handle: string|null, identity: string|null, invite: object|null }>}
 */
export async function resolveTicket(ticket, o) {
  if (!o || !/^wss?:\/\/[^\s/]+/.test(String(o.relay))) throw fail("bad_input", "resolveTicket needs the relay this ticket's box registered with");
  const cryptoP = (o.crypto) || webCrypto();
  const fetchFn = o.fetch || globalThis.fetch;
  if (!fetchFn) throw fail("bad_input", "no fetch here: pass one");
  const loc = await ticketDerive(cryptoP, "loc", ticket);
  const secret = await ticketDerive(cryptoP, "sec", ticket);
  const macKey = await ticketDerive(cryptoP, "mac", ticket);
  const encKey = await ticketDerive(cryptoP, "enc", ticket);
  const base = String(o.relay).replace(/\/+$/, "").replace(/^ws/, "http");
  const res = await fetchFn(`${base}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: base64url(loc) }) });
  if (res.status === 404) throw fail("ticket_gone", "this pairing code has expired or was already used");
  if (res.status === 429) throw fail("rate_limited", "too many pairing attempts; wait a minute");
  // Two boxes registered this locator (first writer wins on the relay): the setup page's "Two servers used this code".
  if (res.status === 409) throw fail("contested", "two servers used this code; start again");
  if (!res.ok) throw fail("pair_failed", `the relay would not resolve this pairing code (${res.status})`);
  const body = await res.json();
  const recordText = String((body && body.record) || "");
  const mac = fromBase64url(String((body && body.mac) || ""));
  const wantMac = await cryptoP.hmacSha256(macKey, utf8(recordText));
  if (!equal(mac, wantMac)) throw fail("bad_record", "the relay's answer for this pairing code does not check out; refusing to pair");
  // The MAC passed, so these are the box's own bytes; opening them is what the relay can't do.
  let record;
  try {
    const key = cryptoP.aesKey ? await cryptoP.aesKey(encKey) : encKey;
    const sealed = fromBase64url(recordText);
    if (sealed.length < 28) throw new Error("too short");
    record = JSON.parse(fromUtf8(await cryptoP.aesGcmDecrypt(key, sealed.subarray(0, 12), utf8(TICKET_SEAL_AD), sealed.subarray(12))));
  } catch { throw fail("bad_record", "the relay's answer for this pairing code is not valid"); }
  if (record.v !== 1 || typeof record.relay !== "string" || !ROUTE_RE.test(record.route) || typeof record.box !== "string") throw fail("bad_record", "the relay's answer for this pairing code is not shaped like an offer");
  // The record names the relay the phone will connect to after it is confirmed. It comes from the box, so it is held to the relay that
  // actually answered: the same host and scheme, no path, credentials, query or fragment. A box cannot send a phone to another server.
  if (!sameRelay(record.relay, o.relay)) throw fail("bad_record", "this pairing code names a different relay than the one that holds it; refusing to pair");
  // The MAC only proves the relay's answer is unmodified from whatever the box minted; an expiry
  // in the past is still a legitimate, unmodified record for a ticket that should have been gone.
  if (typeof record.exp !== "number" || record.exp < Date.now()) throw fail("ticket_gone", "this pairing code has expired or was already used");
  const box = fromBase64url(record.box);
  if (box.length !== 32) throw fail("bad_record", "the relay's answer for this pairing code is not shaped like an offer");
  // Cleaned the same way the box itself validates a claimed name (core/names/service.js), not
  // just stripped like a free-text name: a handle only means something as a real subdomain, so
  // a bad shape becomes null (no redirect offered) rather than a sanitised-but-wrong string.
  const handle = typeof record.handle === "string" && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/i.test(record.handle) ? record.handle.slice(0, 32) : null;
  // The avatar's own seed (the lead's ruling, 28 Sep): 8 bytes, base64url, or null on a box that
  // hasn't got an owner.id yet (anywhere's core/onboard, not landed everywhere), never guessed.
  // The box's own https origin, from the MAC-covered record: the only source an app may pin (null when none).
  let address = null;
  try { if (typeof record.address === "string") { const u = new URL(record.address); if (u.protocol === "https:" && u.origin === record.address) address = u.origin; } } catch {}
  let identity = null;
  try { const b = fromBase64url(String(record.identity || "")); if (b.length === 8) identity = base64url(b); } catch {}
  // An invitation rides inside the sealed record (core/wink): plain JSON of at most 2 KB, never executed, shown on a card after a person looks at it.
  let invite = null;
  try { if (record.offer && typeof record.offer === "object" && JSON.stringify(record.offer).length <= 2048) invite = JSON.parse(JSON.stringify(record.offer)); } catch {}
  return {
    offer: { relay: record.relay, route: record.route, box, secret: base64url(secret) },
    name: promptSafe(record.name, "a Vyre box"),
    fingerprint: await keyFingerprint(box, cryptoP),
    handle,
    address,
    identity,
    invite,
  };
}

/**
 * The one-call convenience for a caller that does not confirm before pairing: `resolveTicket()`
 * then `pairOffer()` right away. Prefer calling them separately when a person can see and approve
 * who they are pairing with first (pwa's "Pair with this box?" screen). `o.name` here is this
 * DEVICE's own name (as pairOffer's `o.name` always is), not the box's, which comes back on the
 * result regardless of which of the two ways it was reached.
 * @param {Uint8Array} ticket
 * @param {Parameters<typeof resolveTicket>[1] & Parameters<typeof pairOffer>[1]} o
 */
export async function pairTicket(ticket, o) {
  const { offer, address } = await resolveTicket(ticket, o);
  const paired = await pairOffer(offer, o);
  // The box's own https origin, from the sealed record the ticket held (null when the box gave none): a client that opens the box's web page (the Windows app) pins it.
  return address ? { ...paired, address } : paired;
}

/**
 * Stay connected to a paired box.
 * @param {{ relay: string, route: string, box: string|Uint8Array, name?: string, about?: { kind?: "app"|"web", release?: string, manifest?: string },
 *   keyStore?: import("./webcrypto.js").KeyStore, crypto?: import("./noise.js").CryptoProvider, WebSocket?: any,
 *   visibility?: Visibility, pingMs?: number, backoff?: { min?: number, max?: number }, timeout?: number,
 *   rekeyEvery?: number, random?: () => number, invitee?: boolean, homeMove?: boolean }} o
 * `invitee: true` says in every hello that this channel is a person's who is not paired here (the box makes no device row for it and admits only the invitee peer stream).
 */
export function connect(o) {
  return new Connection(o);
}

/** A kept-open channel to one box, with fetch, events and socket on top. */
export class Connection {
  /** @param {Parameters<typeof connect>[0]} o */
  constructor(o) {
    if (!o || !ROUTE_RE.test(String(o.route)) || !/^wss?:\/\/[^\s/]+/.test(String(o.relay))) throw new Error("connect needs the relay, route and box from pair()");
    const box = typeof o.box === "string" ? fromBase64url(o.box) : toBytes(o.box);
    if (box.length !== 32) throw new Error("the box key is 32 bytes");
    this.o = { ...o, ...defaults(o), box };
    this.pingMs = o.pingMs || PING_MS;
    this.min = o.backoff?.min ?? BACKOFF.min;
    this.max = o.backoff?.max ?? BACKOFF.max;
    this.random = o.random || Math.random;
    this.visibility = o.visibility || defaultVisibility();
    /** @type {"connecting"|"open"|"offline"|"relay_removed"} */
    this.state = "connecting";
    /** @type {(state: "connecting"|"open"|"offline"|"relay_removed") => void} */
    this.onstate = () => {};
    this.closed = false;
    /** @type {import("./channel.js").Channel | null} */
    this.channel = null;
    this.ws = null;
    /** @type {any} the box's handshake reply: { v, box: { name }, device } */
    this.reply = null;
    /** @type {Error|null} */
    this.lastError = null;
    this.dialing = false;
    this.backoff = this.min;
    /** @type {any} */ this.retryTimer = null;
    /** @type {any} */ this.pinger = null;
    this.outstanding = false;
    this.missed = 0;
    /** @type {Array<{ resolve: (c: any) => void, reject: (e: any) => void }>} */
    this.waiters = [];
    /** @type {Set<{ close(): void }>} */
    this.follows = new Set();
    this.offVisible = this.visibility.on(() => this.visibleChanged());
    const g = /** @type {any} */ (globalThis);
    const online = () => this.wake();
    if (typeof g.addEventListener === "function") { g.addEventListener("online", online); this.offOnline = () => g.removeEventListener("online", online); }
    else this.offOnline = () => {};
    Promise.resolve().then(() => this.dial());
  }

  get open() { return this.state === "open"; }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    try { this.onstate(s); } catch {}
  }

  async dial() {
    if (this.closed || this.dialing || this.channel) return;
    if (this.visibility.hidden()) { this.setState("offline"); return; }
    this.dialing = true;
    this.setState("connecting");
    try {
      const keys = await deviceKey(this.o);
      const hello = { v: 1, ...about(this.o.about), ...(this.o.name ? { name: this.o.name } : {}), ...(this.o.invitee === true ? { invitee: true } : {}), ...(this.o.homeMove === true ? { homeMove: true } : {}) };
      const { channel, reply, ws } = await openChannel({ ...this.o, keys, hello, onpong: () => { this.outstanding = false; this.missed = 0; } });
      this.dialing = false;
      if (this.closed) { channel.close(1000, "closed"); return; }
      this.channel = channel;
      this.ws = ws;
      this.reply = reply;
      this.backoff = this.min;
      this.lastError = null;
      channel.onclose = reason => this.lost(channel, reason);
      this.setState("open");
      this.keepalive();
      for (const w of this.waiters.splice(0)) w.resolve(channel);
    } catch (e) {
      this.dialing = false;
      this.lastError = /** @type {Error} */ (e);
      if (/** @type {Error} */ (e).message === REMOVED) { this.removed(); return; }
      this.retry();
    }
  }

  /** @param {import("./channel.js").Channel} ch @param {string} [reason] */
  lost(ch, reason) {
    if (this.channel !== ch) return;
    this.channel = null;
    this.ws = null;
    globalThis.clearInterval(this.pinger);
    this.pinger = null;
    if (reason === REMOVED) { this.removed(); return; }
    this.retry();
  }

  /**
   * The relay passed on 4401 "device removed". That is the RELAY's word, never the box's own answer: a
   * compromised relay can say it, so nothing here may wipe anything on it. The state is final for this
   * relay path (no retry can work if it is true), and the app must ask the box directly over a path the
   * relay does not control (the direct address, or a fresh pairing check) before it acts on it.
   */
  removed() {
    if (this.closed) return;
    this.closed = true;
    globalThis.clearTimeout(this.retryTimer);
    globalThis.clearInterval(this.pinger);
    this.offVisible();
    this.offOnline();
    for (const f of [...this.follows]) f.close();
    for (const w of this.waiters.splice(0)) w.reject(Object.assign(new Error(REMOVED), { code: "relay_removed" }));
    this.channel = null;
    this.setState("relay_removed");
  }

  retry() {
    if (this.closed) return;
    this.setState("offline");
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.visibility.hidden()) return;               // coming back to the front dials
    const delay = this.backoff * (0.8 + 0.4 * this.random());
    this.backoff = Math.min(this.backoff * 2, this.max);
    this.retryTimer = globalThis.setTimeout(() => { this.retryTimer = null; this.dial(); }, delay);
    // a pause between tries never keeps a Node process alive by itself (an open socket does); a browser timer has no unref
    if (this.retryTimer && typeof this.retryTimer.unref === "function") this.retryTimer.unref();
  }

  /** Reconnect now if we are not connected (a wake, the network came back, the app came to the front). */
  wake() {
    if (this.closed) return;
    if (this.channel) {
      // After a sleep the socket may be dead without knowing it: ask now.
      this.missed = 0;
      this.ping();
      return;
    }
    if (this.dialing) return;
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.backoff = this.min;
    this.dial();
  }

  visibleChanged() { if (!this.visibility.hidden()) this.wake(); }

  keepalive() {
    globalThis.clearInterval(this.pinger);
    this.outstanding = false;
    this.missed = 0;
    this.pinger = globalThis.setInterval(() => this.tick(), this.pingMs);
  }

  tick() {
    if (!this.channel || this.visibility.hidden()) return;
    if (this.outstanding && ++this.missed >= 2) {
      this.channel.close(4000, "no answer to two pings");
      return;
    }
    this.ping();
  }

  ping() {
    if (!this.ws) return;
    this.outstanding = true;
    try { this.ws.send("ping"); } catch {}
  }

  /** The open channel, now or when the next one opens. */
  ready(signal) {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    if (this.channel) return Promise.resolve(this.channel);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const w = { resolve, reject };
      this.waiters.push(w);
      signal?.addEventListener?.("abort", () => { this.waiters = this.waiters.filter(x => x !== w); reject(abortError()); }, { once: true });
    });
  }

  /**
   * A request through the box's router. Resolves on the response head; read the body with
   * text(), json() or `for await (const chunk of res.body)`.
   * @param {string} path
   * @param {{ method?: string, headers?: any, body?: string|Uint8Array|ArrayBuffer|null, signal?: AbortSignal }} [init]
   */
  async fetch(path, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    const headers = lowerHeaders(init.headers);
    if (method !== "GET" && method !== "HEAD" && !headers["idempotency-key"]) headers["idempotency-key"] = await newKey(this.o.crypto);
    const body = init.body == null ? EMPTY : toBytes(init.body);
    const head = { method, path, headers };
    for (let attempt = 0; ; attempt++) {
      const ch = await this.ready(init.signal);
      try { return await request(ch, head, body, init.signal); }
      catch (e) { if (/** @type {any} */ (e)?.lost && attempt === 0 && !this.closed) continue; throw e; }
    }
  }

  /**
   * Follow a server-sent event stream, across reconnects, resuming with Last-Event-ID.
   * @param {string} path
   * @param {Omit<Parameters<typeof followEvents>[2], "onEvent"> & { onEvent: Parameters<typeof followEvents>[2]["onEvent"] }} o
   */
  events(path, o) {
    const f = followEvents((p, init) => this.fetch(p, init), path, { random: this.random, ...o });
    const handle = { get lastEventId() { return f.lastEventId; }, reopen: () => f.reopen(), close: () => { f.close(); this.follows.delete(handle); } };
    this.follows.add(handle);
    return handle;
  }

  /**
   * A WebSocket to one of the box's /v1/streams/ paths, through the channel. It does not survive
   * a reconnect: on close, open a new one (the stream's own resume, like a terminal offset, is
   * the caller's).
   * @param {string} path @param {{ headers?: Record<string, string> }} [o]
   */
  socket(path, o = {}) {
    const sock = new RelaySocket();
    this.ready().then(ch => { if (sock.readyState === 0) sock.attach(ch, path, lowerHeaders(o.headers)); },
      e => sock.finish(1006, String(e.message)));
    return sock;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    globalThis.clearTimeout(this.retryTimer);
    globalThis.clearInterval(this.pinger);
    this.offVisible();
    this.offOnline();
    for (const f of [...this.follows]) f.close();
    for (const w of this.waiters.splice(0)) w.reject(new Error("connection closed"));
    const ch = this.channel;
    this.channel = null;
    ch?.close(1000, "closed");
    this.setState("offline");
  }
}

async function newKey(crypto) {
  const g = /** @type {any} */ (globalThis).crypto;
  if (g && typeof g.randomUUID === "function") return g.randomUUID();
  return uuidFrom(await crypto.randomBytes(16));
}

/**
 * One request on one channel. Rejects with `lost: true` when the channel dropped before the
 * response head arrived, so the caller can send it once more on the next channel.
 * @param {import("./channel.js").Channel} ch
 */
export function request(ch, head, body, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    let s;
    try { s = ch.open(head); } catch (e) { reject(e); return; }
    const pipe = new Pipe();
    let answered = false;
    const onAbort = () => { s.reset("cancelled"); const e = abortError(); if (answered) pipe.fail(e); else reject(e); };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
    pipe.oncancel = () => { cleanup(); s.reset("cancelled"); };
    s.onhead = h => {
      if (answered) return;
      answered = true;
      resolve(makeResponse(Number(h && h.status) || 0, (h && h.headers) || {}, pipe, { path: head.path }));
    };
    s.ondata = c => pipe.push(c);
    s.onend = () => { cleanup(); if (!answered) reject(new Error("the box ended the stream without a response")); pipe.end(); };
    s.onreset = reason => {
      cleanup();
      const lost = ch.closed;
      const e = Object.assign(new Error(lost ? `connection lost: ${reason}` : `request reset: ${reason}`), { lost });
      if (answered) pipe.fail(e); else reject(e);
    };
    if (body.length) s.write(body);
    s.end();
  });
}

/** A WebSocket-shaped stream: data frames are [1 text | 2 binary][message], as in core/relay/channel.js. */
export class RelaySocket {
  constructor() {
    this.readyState = 0;
    this.binaryType = "arraybuffer";
    /** @type {any} */ this.stream = null;
    /** @type {((e: any) => void) | null} */ this.onopen = null;
    /** @type {((e: { data: string|ArrayBuffer }) => void) | null} */ this.onmessage = null;
    /** @type {((e: { code: number, reason: string, wasClean: boolean }) => void) | null} */ this.onclose = null;
    /** @type {((e: any) => void) | null} */ this.onerror = null;
  }
  /** @param {import("./channel.js").Channel} ch @param {string} path @param {Record<string, string>} headers */
  attach(ch, path, headers) {
    let s;
    try { s = ch.open({ ws: path, headers }); } catch (e) { this.finish(1006, "connection lost"); return; }
    this.stream = s;
    s.onhead = h => {
      if (h && h.status === 101) { this.readyState = 1; this.onopen?.({}); return; }
      this.onerror?.({ status: h && h.status });
      s.reset("refused");
      this.finish(1006, `refused: ${h && h.status}`);
    };
    s.ondata = c => {
      if (this.readyState !== 1 || !c.length) return;
      const m = c.subarray(1);
      this.onmessage?.({ data: c[0] === 1 ? fromUtf8(m) : m.slice().buffer });
    };
    s.onend = () => this.finish(1000, "");
    s.onreset = r => this.finish(1006, r);
  }
  /** One message, one frame: a WebSocket message is never split. @param {string|Uint8Array|ArrayBuffer} data */
  send(data) {
    if (this.readyState !== 1) throw Object.assign(new Error("the socket is not open"), { name: "InvalidStateError" });
    const payload = concat(new Uint8Array([typeof data === "string" ? 1 : 2]), toBytes(data));
    if (payload.length + 5 + 16 > MAX_FRAME) throw new Error("message too big for one relay frame (1 MiB)");
    this.stream.ch.frame(FRAME.data, this.stream.id, payload);
  }
  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    if (this.stream) this.stream.end();
    this.finish(code, reason);
  }
  /** @param {number} code @param {string} reason */
  finish(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}
RelaySocket.CONNECTING = 0;
RelaySocket.OPEN = 1;
RelaySocket.CLOSING = 2;
RelaySocket.CLOSED = 3;
