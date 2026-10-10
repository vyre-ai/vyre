// @ts-check
// ids: the client for identity names in the hosted directory (names/worker/ids.js, team/0.3/DESIGN-wink.md section 2).
// A name points at an IDENTITY: a permanent id with a signed, chained list of who can speak for it (names/worker/chain.js). What the
// directory keeps is that list (public keys only) and an opaque sealed record (where the person's devices or the space's home can be
// reached). Nothing it returns is trusted: the client re-verifies the whole chain from its genesis, compares it with the head it last saw
// (a shorter answer is stale, a different one is a fork), checks the record's signature against the list as it stood, and only then
// opens the record, which is sealed under a key derived from the name.
//
// The client signs nothing by itself. Every write is built by the caller from a `sign(bytes)` of an entry on the list, and the helpers
// here only name the bytes (a record, an alias proof, an act), so a signer is asked for our own tags and nothing else.

import crypto from "node:crypto";
import * as C from "../../kernel/identity/chain.js";
import { recordMessage, aliasMessage, actMessage } from "../../names/worker/id-messages.js";
import { base32 } from "../bytes.js";
import { httpFetch } from "../http.js";

export const DEFAULT_BASE = "https://names.vyre.run";
export const SEAL_TAG = "vyre-id-seal-v1";
export const SEALED_MAX = 2048;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export { recordMessage, aliasMessage, actMessage };

const b64u = (/** @type {Uint8Array|Buffer} */ b) => Buffer.from(b).toString("base64url");
const sha256hex = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest("hex");

/** An entry id of a raw public key (26 base32 characters). @param {Uint8Array} pub */
export const keyId = pub => {
  const h = crypto.createHash("sha256").update(pub).digest();
  return base32(h).slice(0, 26);
};

/** The key a record is sealed under: derived from the name alone. @param {string} name */
function sealKey(name) { return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(String(name).toLowerCase()), Buffer.from(SEAL_TAG), Buffer.from("record"), 32)); }

/** Seal a JSON payload for a name: AES-256-GCM, the name as associated data. @param {string} name @param {any} payload @param {(n: number) => Buffer} [random] */
export function sealRecord(name, payload, random = crypto.randomBytes) {
  const iv = random(12);
  const c = crypto.createCipheriv("aes-256-gcm", sealKey(name), iv);
  c.setAAD(Buffer.from(name));
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  const out = b64u(Buffer.concat([iv, ct, c.getAuthTag()]));
  if (out.length > SEALED_MAX) throw Object.assign(new Error("the record is too large to seal (keep fewer or shorter entries, then try again)"), { code: "too_large" });
  return out;
}

/** Open a sealed record, or null when it is not for this name. @param {string} name @param {string} sealed */
export function openRecord(name, sealed) {
  try {
    const raw = Buffer.from(String(sealed), "base64url");
    if (raw.length < 12 + 16) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", sealKey(name), raw.subarray(0, 12));
    d.setAAD(Buffer.from(name));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8"));
  } catch { return null; }
}

/**
 * Verify what the directory returned for a name. `pin` is the head this client last saw for the identity (an invite, a pairing or an
 * earlier lookup): `{ id, seq, head }`. Without a pin the chain is trusted on first sight and the new pin is returned.
 * `ownerOps` finds a person's whole chain for a space's owners (the directory is asked for them too, and verified the same way). What is newer than
 * the pin is treated as accepted now: a space op by a device that is off its owner's current list is refused.
 * @param {string} name @param {any} r @param {{ id: string, seq: number, head: string }|null|undefined} pin
 * @param {{ ownerOps?: (id: string) => Promise<any[]|null>, seenAt?: (seq: number) => number|undefined, now?: number }} [o]
 */
export async function verifyResolved(name, r, pin, o = {}) {
  if (!pin && typeof o.seenAt !== "function") throw Object.assign(new Error("a list is verified against a pin or against the first time this device saw each op, never against the op's own time alone"), { code: "seen_required" });
  if (!r || r.name !== name || !["person", "space"].includes(r.kind) || !Array.isArray(r.ops)) return { ok: false, why: "that is not the name asked for" };
  const now = o.now ?? Date.now();
  let state;
  try { state = await C.verifyChain(r.ops, { now: now + C.SKEW_MS, ownerOps: o.ownerOps, ...(o.seenAt ? { seenAt: o.seenAt } : {}), ...(pin ? { liveFrom: pin.seq + 1 } : {}) }); } catch (e) { return { ok: false, why: `the list does not verify: ${/** @type {any} */ (e).message}` }; }
  if (state.id !== r.id || state.kind !== r.kind) return { ok: false, why: "the list is not for the identity the directory named" };
  const seen = await C.checkAnswer(pin, r.ops);
  if (!seen.ok) return { ok: false, why: seen.why, code: seen.code };
  // The sealed record: signed by an entry that was on the list when it was signed.
  const rec = r.rec;
  let payload = null;
  if (r.sealed && rec) {
    try {
      const at = await C.stateAt(r.ops, rec.ts, { now: now + C.SKEW_MS, ownerOps: o.ownerOps });
      const key = at && await C.signerKey(at, rec.by, rec.via, rec.ts, { ownerOps: o.ownerOps, now: now + C.SKEW_MS }, { seq: rec.vseq, head: rec.vhead });
      const good = key && await C.verifyWith(key.pub, recordMessage({ name, id: state.id, by: rec.by, via: rec.via, ts: rec.ts, sealedHash: sha256hex(r.sealed), vseq: rec.vseq, vhead: rec.vhead }), rec.sig, key.signing);
      if (!good) return { ok: false, why: "the record's signature does not check out" };
    } catch { return { ok: false, why: "the record's signature does not check out" }; }
    payload = openRecord(name, r.sealed);
    if (!payload) return { ok: false, why: "the record could not be opened" };
  }
  return { ok: true, id: state.id, kind: r.kind, state, ops: r.ops, pin: C.pinOf(state), advanced: seen.fresh, payload, ts: rec ? rec.ts : null, aliases: r.aliases || [] };
}

/**
 * @typedef {{ sign(message: Uint8Array): Promise<Uint8Array|Buffer>|Uint8Array|Buffer, by: string, via?: string, pos?: { via_seq: number, via_head: string } }} EntrySigner an entry on the list that signs: `by` is its eid (a space owner's person id, with `via` the device and `pos` the position of that person's list it relied on)
 * @param {{ base?: string, fetch?: typeof globalThis.fetch, now?: () => number, timeoutMs?: number }} o
 */
export function idDirectory({ base = DEFAULT_BASE, fetch = httpFetch, now = Date.now, timeoutMs = 20_000, seen } = /** @type {any} */ ({})) {
  // Every client keeps when it FIRST SAW each op of each list it verifies (persisted), so a newcomer's age starts when this device learned of it and never from a
  // time its adder wrote. A client with nowhere to keep that is refused here, not given a default.
  if (!seen || typeof seen.get !== "function" || typeof seen.mark !== "function" || typeof seen.has !== "function") throw new Error("idDirectory needs a `seen` store: { has(id), get(id, seq), mark(id, seq, ts) }");
  const root = String(base).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(root)) throw new Error("the directory address must be http(s)");
  async function call(method, target, body) {
    if ((process.env.NODE_TEST_CONTEXT || process.env.VYRE_TEST) && fetch === httpFetch && !LOOPBACK.has(new URL(root).hostname)) {
      throw Object.assign(new Error("tests never call the hosted name directory"), { code: "test_guard" });
    }
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers = /** @type {Record<string, string>} */ ({ accept: "application/json" });
    if (text) headers["content-type"] = "application/json";
    let res;
    try { res = await fetch(root + target, { method, headers, body: text || undefined, signal: AbortSignal.timeout(timeoutMs), allow: LOOPBACK.has(new URL(root).hostname) ? "any" : "public" }); }
    catch (e) {
      // The guarded client names a refusal of the address itself (not_https, not_public, bad_url) in `code`; keep it so a caller can say it was the address, not the network.
      const why = /** @type {any} */ (e).cause?.code || /** @type {any} */ (e).code || /** @type {Error} */ (e).name || "network error";
      throw Object.assign(new Error(`the name directory is not reachable (${why}); wait a minute and call again`), { code: "unreachable", status: 0, why });
    }
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !json || json.error || !json.data) {
      const e = (json && json.error) || {};
      throw Object.assign(new Error(String(e.message || `the name directory answered ${res.status}`)), { code: String(e.code || "directory"), status: res.status });
    }
    return json.data;
  }

  /** A signed record over a payload for an identity's current state. @param {string} name @param {C.State} state @param {EntrySigner} signer @param {any} payload */
  async function recordFor(name, state, signer, payload, ts = now()) {
    const sealed = sealRecord(name, payload);
    const vseq = signer.pos && signer.pos.via_seq, vhead = signer.pos && signer.pos.via_head;
    const sig = b64u(await signer.sign(recordMessage({ name, id: state.id, by: signer.by, via: signer.via, ts, sealedHash: sha256hex(sealed), vseq, vhead })));
    return { sealed, rec: { by: signer.by, ...(signer.via ? { via: signer.via } : {}), ...(vseq !== undefined ? { vseq, vhead } : {}), ts, sig } };
  }
  /** @param {string} action @param {string} name @param {string|undefined} domain @param {EntrySigner} signer */
  async function actFor(action, name, domain, signer, ts = now()) {
    return { by: signer.by, ...(signer.via ? { via: signer.via } : {}), ts, sig: b64u(await signer.sign(actMessage({ action, name, domain, ts }))) };
  }

  /** @param {any[]} ops @param {((id: string) => Promise<any[]|null>)|undefined} local */
  function owners(ops, local) {
    /** @type {Map<string, any[]|null>} */ const seen = new Map();
    return async (/** @type {string} */ id) => {
      if (local) { const mine = await local(id); if (mine) return mine; }
      const e = (Array.isArray(ops) ? ops : []).map(o => o && o.entry).filter(Boolean).find(x => x.subject === id && x.label);
      if (!e) return null;
      if (!seen.has(id)) {
        try { const q = await call("GET", `/v1/ids/resolve?name=${encodeURIComponent(String(e.label))}`); seen.set(id, q.id === id && q.kind === "person" ? q.ops : null); } catch { seen.set(id, null); }
      }
      return seen.get(id) || null;
    };
  }

  return {
    base: root,
    check: name => call("GET", `/v1/names/check?name=${encodeURIComponent(name)}`),
    /** Claim a name for a SPACE: its chain from the genesis (its owners already exist), and a sealed payload signed by one of its entries. A person's first name is `finalize`. */
    claim: async (name, state, ops, signer, payload) => call("POST", "/v1/ids/claim", { name, ops, ...await recordFor(name, state, signer, payload) }),
    /** Hold a name for 24 hours and get the reservation code that finishes it (the web page does this; nothing here needs a key). The code comes back once. */
    reserve: name => call("POST", "/v1/ids/reserve", { name }),
    /** Which name a reservation code is for, without spending it: the app that is pasted a code needs the name before it can build the identity. */
    reservedFor: code => call("POST", "/v1/ids/reserved-for", { code }),
    /** A person's first name: the genesis chain, the sealed payload signed by the device, and the reservation code. The code burns. */
    finalize: async (name, state, ops, signer, payload, code) => call("POST", "/v1/ids/finalize", { name, ops, code, ...await recordFor(name, state, signer, payload) }),
    /** The Space says which server serves its name: a signed act, so only the space's own entries can list a server (or take it off again). */
    server: async (name, route, signer, remove = false) => call("POST", "/v1/ids/server", { name, route, ...(remove ? { remove: true } : {}), act: await actFor(remove ? "server-remove" : "server-add", name, route, signer) }),
    /** Resolve an exact name (or an own-domain alias), verify the chain, and compare it with the pin. */
    async resolve(nameOrAlias, { pin, alias = false, resolve } = /** @type {any} */ ({})) {
      const q = alias ? `alias=${encodeURIComponent(nameOrAlias)}` : `name=${encodeURIComponent(nameOrAlias)}`;
      const r = await call("GET", `/v1/ids/resolve?${q}`);
      // What this device has not seen yet it sees now. On the very first sight with no pin the existing history is taken at its own times (nothing better is known:
      // a link or a pairing carries a pin so that this is not how a space or a device is first met); every op after that is counted from when it arrived here.
      const first = Array.isArray(r.ops) && r.ops.length && !seen.has(r.id);
      /** @type {Map<number, number>} */ const fresh = new Map();
      if (Array.isArray(r.ops) && typeof r.id === "string") {
        for (let q2 = 0; q2 < r.ops.length; q2++) if (seen.get(r.id, q2) === undefined) fresh.set(q2, (first && !pin) || (pin && q2 <= pin.seq) ? Number(r.ops[q2] && r.ops[q2].ts) || 0 : now());
      }
      const v = await verifyResolved(r.name, r, pin, { now: now(), ownerOps: owners(r.ops, resolve), seenAt: seq => seen.get(r.id, seq) ?? fresh.get(seq) });
      if (v.ok) for (const [q2, t2] of fresh) seen.mark(r.id, q2, t2);
      return v;
    },
    /** The lookup a space's chain needs: its owners' own chains, found by the name each owner entry carries; the verifier checks them like any other. `local` answers first (this person's own copy). @param {any[]} ops @param {((id: string) => Promise<any[]|null>)|undefined} [local] */
    ownersResolver: (ops, local) => owners(ops, local),
    /** Send new ops. The directory verifies each against the list before it; a repeat of an op it has is fine. */
    append: (name, ops) => call("POST", "/v1/ids/append", { name, ops }),
    update: async (name, state, signer, payload) => call("POST", "/v1/ids/update", { name, ...await recordFor(name, state, signer, payload) }),
    /** The TXT value to put at _vyre-id.<domain> before addAlias, signed by an entry. */
    async aliasTxt(name, id, domain, signer) {
      const sig = b64u(await signer.sign(aliasMessage({ name, domain, id })));
      return { host: `_vyre-id.${domain}`, value: `vyre-id=2;name=${name};id=${id};by=${signer.by};via=${signer.via || "-"};sig=${sig}` };
    },
    addAlias: (name, domain) => call("POST", "/v1/ids/alias", { name, domain }),
    removeAlias: async (name, domain, signer) => call("DELETE", "/v1/ids/alias", { name, domain, act: await actFor("alias-clear", name, domain, signer) }),
    /** DNS-01 for a Space's name (PT-1): the Space signs, the directory writes the TXT. No other way to get a certificate through the relay. */
    acme: async (name, token, signer) => call("POST", "/v1/ids/acme", { name, token, act: await actFor("acme", name, token, signer) }),
    acmeClear: async (name, signer) => call("DELETE", "/v1/ids/acme", { name, act: await actFor("acme-clear", name, undefined, signer) }),
    /** Pin issuance for the Space's name to one ACME account (CAA with accounturi). */
    caa: async (name, accounturi, signer) => call("POST", "/v1/ids/caa", { name, accounturi, act: await actFor("caa", name, accounturi, signer) }),
    release: async (name, signer) => call("POST", "/v1/ids/release", { name, act: await actFor("release", name, undefined, signer) }),
  };
}

/** A `seen` store in memory, for tests and for a device that keeps nothing between runs (it then meets every list as new). */
export function memorySeen() {
  /** @type {Map<string, Map<number, number>>} */ const m = new Map();
  return { has: (/** @type {string} */ id) => m.has(id), get: (/** @type {string} */ id, /** @type {number} */ seq) => (m.get(id) || new Map()).get(seq),
    mark: (/** @type {string} */ id, /** @type {number} */ seq, /** @type {number} */ ts) => { if (!m.has(id)) m.set(id, new Map()); /** @type {Map<number, number>} */ (m.get(id)).set(seq, ts); } };
}

/** A signer over an Ed25519 key held in memory (tests, and a first device before a secure chip holds it). @param {crypto.KeyObject} privateKey @param {string} [by] */
export function memorySigner(privateKey, by) {
  const pub = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  const publicKey = b64u(pub);
  return { eid: keyId(pub), publicKey, by: by || keyId(pub), sign: async (/** @type {Uint8Array} */ m) => crypto.sign(null, Buffer.from(m), privateKey) };
}
