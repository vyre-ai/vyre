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
import * as C from "../../names/worker/chain.js";
import { recordMessage, aliasMessage, actMessage } from "../../names/worker/ids.js";

export const DEFAULT_BASE = "https://names.vyre.run";
export const SEAL_TAG = "vyre-id-seal-v1";
export const SEALED_MAX = 2048;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export { recordMessage, aliasMessage, actMessage };

const b64u = (/** @type {Uint8Array|Buffer} */ b) => Buffer.from(b).toString("base64url");
const sha256hex = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest("hex");

/** An entry id of a raw public key (26 base32 characters). @param {Uint8Array} pub */
export const keyId = pub => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const h = crypto.createHash("sha256").update(pub).digest();
  let out = "", bits = 0, value = 0;
  for (const byte of h) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.slice(0, 26);
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
  if (out.length > SEALED_MAX) throw Object.assign(new Error("the record is too large to seal"), { code: "too_large" });
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
 * `resolve` finds a person's chain state for a space's owners (the directory is asked for them too, and verified the same way).
 * @param {string} name @param {any} r @param {{ id: string, seq: number, head: string }|null|undefined} pin
 * @param {{ resolve?: (id: string, ts: number) => Promise<C.State|null>, now?: number }} [o]
 */
export async function verifyResolved(name, r, pin, o = {}) {
  if (!r || r.name !== name || !["person", "space"].includes(r.kind) || !Array.isArray(r.ops)) return { ok: false, why: "that is not the name asked for" };
  const now = o.now ?? Date.now();
  let state;
  try { state = await C.verifyChain(r.ops, { now: now + C.SKEW_MS, resolve: o.resolve }); } catch (e) { return { ok: false, why: `the list does not verify: ${/** @type {any} */ (e).message}` }; }
  if (state.id !== r.id || state.kind !== r.kind) return { ok: false, why: "the list is not for the identity the directory named" };
  const seen = await C.checkAnswer(pin, r.ops);
  if (!seen.ok) return { ok: false, why: seen.why, code: seen.code };
  // The sealed record: signed by an entry that was on the list when it was signed.
  const rec = r.rec;
  let payload = null;
  if (r.sealed && rec) {
    try {
      const at = await C.stateAt(r.ops, rec.ts, { now: now + C.SKEW_MS, resolve: o.resolve });
      const key = at && await C.signerKey(at, rec.by, rec.via, rec.ts, { resolve: o.resolve });
      const good = key && await C.verifyWith(key.pub, recordMessage({ name, id: state.id, by: rec.by, via: rec.via, ts: rec.ts, sealedHash: sha256hex(r.sealed) }), rec.sig);
      if (!good) return { ok: false, why: "the record's signature does not check out" };
    } catch { return { ok: false, why: "the record's signature does not check out" }; }
    payload = openRecord(name, r.sealed);
    if (!payload) return { ok: false, why: "the record could not be opened" };
  }
  return { ok: true, id: state.id, kind: r.kind, state, ops: r.ops, pin: C.pinOf(state), advanced: seen.fresh, payload, ts: rec ? rec.ts : null, aliases: r.aliases || [] };
}

/**
 * @typedef {{ sign(message: Uint8Array): Promise<Uint8Array|Buffer>|Uint8Array|Buffer, by: string, via?: string }} EntrySigner an entry on the list that signs: `by` is its eid (a space owner's person id, with `via` the device)
 * @param {{ base?: string, fetch?: typeof globalThis.fetch, now?: () => number, timeoutMs?: number }} o
 */
export function idDirectory({ base = DEFAULT_BASE, fetch = globalThis.fetch, now = Date.now, timeoutMs = 20_000 } = {}) {
  const root = String(base).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(root)) throw new Error("the directory address must be http(s)");
  async function call(method, target, body) {
    if ((process.env.NODE_TEST_CONTEXT || process.env.VYRE_TEST) && fetch === globalThis.fetch && !LOOPBACK.has(new URL(root).hostname)) {
      throw Object.assign(new Error("tests never call the hosted name directory"), { code: "test_guard" });
    }
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers = /** @type {Record<string, string>} */ ({ accept: "application/json" });
    if (text) headers["content-type"] = "application/json";
    let res;
    try { res = await fetch(root + target, { method, headers, body: text || undefined, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw Object.assign(new Error(`the name directory is not reachable (${/** @type {any} */ (e).cause?.code || /** @type {Error} */ (e).name || "network error"})`), { code: "unreachable", status: 0 }); }
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
    const sig = b64u(await signer.sign(recordMessage({ name, id: state.id, by: signer.by, via: signer.via, ts, sealedHash: sha256hex(sealed) })));
    return { sealed, rec: { by: signer.by, ...(signer.via ? { via: signer.via } : {}), ts, sig } };
  }
  /** @param {string} action @param {string} name @param {string|undefined} domain @param {EntrySigner} signer */
  async function actFor(action, name, domain, signer, ts = now()) {
    return { by: signer.by, ...(signer.via ? { via: signer.via } : {}), ts, sig: b64u(await signer.sign(actMessage({ action, name, domain, ts }))) };
  }

  return {
    base: root,
    check: name => call("GET", `/v1/names/check?name=${encodeURIComponent(name)}`),
    /** Claim a name for an identity: its chain from the genesis, and a sealed payload signed by one of its entries. */
    claim: async (name, state, ops, signer, payload) => call("POST", "/v1/ids/claim", { name, ops, ...await recordFor(name, state, signer, payload) }),
    /** Resolve an exact name (or an own-domain alias), verify the chain, and compare it with the pin. */
    async resolve(nameOrAlias, { pin, alias = false, resolve } = /** @type {any} */ ({})) {
      const q = alias ? `alias=${encodeURIComponent(nameOrAlias)}` : `name=${encodeURIComponent(nameOrAlias)}`;
      const r = await call("GET", `/v1/ids/resolve?${q}`);
      return verifyResolved(r.name, r, pin, { now: now(), resolve });
    },
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
    release: async (name, signer) => call("POST", "/v1/ids/release", { name, act: await actFor("release", name, undefined, signer) }),
  };
}

/** A signer over an Ed25519 key held in memory (tests, and a first device before a secure chip holds it). @param {crypto.KeyObject} privateKey @param {string} [by] */
export function memorySigner(privateKey, by) {
  const pub = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  const publicKey = b64u(pub);
  return { eid: keyId(pub), publicKey, by: by || keyId(pub), sign: async (/** @type {Uint8Array} */ m) => crypto.sign(null, Buffer.from(m), privateKey) };
}
