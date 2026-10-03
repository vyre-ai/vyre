// @ts-check
// ids: the client for identity names in the hosted directory (names/worker/ids.js, team/0.3/DESIGN-spaces-first.md sections 1 and 1b).
// A person or a space claims `<label>.vyre.run` with its KEY. What the directory keeps is the signed claim and an opaque sealed record
// (where the person's devices or the space's home can be reached). The record is sealed under a key derived from the name, so the
// directory cannot read it and a visitor who does not know the name learns nothing; it is signed by the identity key, so a client
// that pinned the key (from an invite or a pairing) knows it is not a substitute. There is no DNS record for the name.
//
// The `signer` holds the identity key (a device's secure chip for a person, the owners' root key for a space). It is asked to sign
// only messages that start with this file's tags or the directory's request tag, never arbitrary bytes.

import crypto from "node:crypto";

export const AUTH_TAG = "vyre-names-v1";
export const RECORD_TAG = "vyre-id-record-v1";
export const ALIAS_TAG = "vyre-id-alias-v1";
export const ROTATE_TAG = "vyre-id-rotate-v1";
export const SEAL_TAG = "vyre-id-seal-v1";
export const DEFAULT_BASE = "https://names.vyre.run";
export const SEALED_MAX = 2048;
const TAGS = [AUTH_TAG, RECORD_TAG, ALIAS_TAG, ROTATE_TAG];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const b64u = b => Buffer.from(b).toString("base64url");
const sha256hex = s => crypto.createHash("sha256").update(s).digest("hex");

/** The ids of a key: the route id (26 base32 characters of its hash) a person's id is built from. @param {Uint8Array} pub */
export function keyId(pub) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const h = crypto.createHash("sha256").update(pub).digest();
  let out = "", bits = 0, value = 0;
  for (const byte of h) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.slice(0, 26);
}

export const recordMessage = m => Buffer.from(`${RECORD_TAG}\n${m.name}\n${m.kind}\n${m.pub}\n${m.ts}\n${m.sealedHash}`);
export const aliasMessage = m => Buffer.from(`${ALIAS_TAG}\n${m.name}\n${m.domain}\n${m.keyId}`);
export const rotateMessage = m => Buffer.from(`${ROTATE_TAG}\n${m.name}\n${m.from}\n${m.to}`);

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

/** Verify what the directory returned for a name against the key the client pinned (an invite's, a pairing's); without a pin the key is trusted on first sight and returned as `pin`. */
export function verifyResolved(name, r, pinned) {
  if (!r || r.name !== name || !["person", "space"].includes(r.kind)) return { ok: false, why: "that is not the name asked for" };
  const pub = Buffer.from(String(r.pub), "base64url");
  if (pub.length !== 32 || keyId(pub) !== r.keyId) return { ok: false, why: "the key does not match its id" };
  if (pinned && String(pinned) !== r.pub) return { ok: false, why: "this name is held by a different key than the one you trusted" };
  let good = false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" });
    good = crypto.verify(null, recordMessage({ name, kind: r.kind, pub: r.pub, ts: r.ts, sealedHash: sha256hex(r.sealed) }), key, Buffer.from(String(r.recordSig), "base64url"));
  } catch { good = false; }
  if (!good) return { ok: false, why: "the record's signature does not check out" };
  const payload = openRecord(name, r.sealed);
  if (!payload) return { ok: false, why: "the record could not be opened" };
  return { ok: true, pin: r.pub, keyId: r.keyId, kind: r.kind, payload, ts: r.ts, aliases: r.aliases || [] };
}

/**
 * @typedef {{ identity(): Promise<{ route: string, pub: Buffer }>, sign(message: Buffer): Promise<Buffer> }} IdSigner
 * @param {{ base?: string, signer: IdSigner, fetch?: typeof globalThis.fetch, now?: () => number, timeoutMs?: number }} o
 */
export function idDirectory({ base = DEFAULT_BASE, signer, fetch = globalThis.fetch, now = Date.now, timeoutMs = 20_000 }) {
  const root = String(base).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(root)) throw new Error("the directory address must be http(s)");
  /** The signer is asked only for our own tags. @param {Buffer} m */
  async function sign(m) {
    if (!TAGS.some(t => m.subarray(0, t.length).toString() === t && m[t.length] === 10)) throw new Error("this key signs only name-directory messages");
    return signer.sign(m);
  }
  async function call(method, target, body, signed = true) {
    if ((process.env.NODE_TEST_CONTEXT || process.env.VYRE_TEST) && fetch === globalThis.fetch && !LOOPBACK.has(new URL(root).hostname)) {
      throw Object.assign(new Error("tests never call the hosted name directory"), { code: "test_guard" });
    }
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers = /** @type {Record<string, string>} */ ({ accept: "application/json" });
    if (text) headers["content-type"] = "application/json";
    if (signed) {
      const { route, pub } = await signer.identity();
      const ts = now(), nonce = crypto.randomBytes(16).toString("base64url");
      const m = Buffer.from(`${AUTH_TAG}\n${route}\n${ts}\n${nonce}\n${method}\n${target}\n${sha256hex(text)}`);
      Object.assign(headers, { "x-vyre-route": route, "x-vyre-pub": b64u(pub), "x-vyre-ts": String(ts), "x-vyre-nonce": nonce, "x-vyre-sig": b64u(await sign(m)) });
    }
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

  /** A signed record for a name from a payload. @param {string} name @param {"person"|"space"} kind @param {any} payload */
  async function recordFor(name, kind, payload, ts = now()) {
    const { pub } = await signer.identity();
    const sealed = sealRecord(name, payload);
    const pubText = b64u(pub);
    const sig = await sign(recordMessage({ name, kind, pub: pubText, ts, sealedHash: sha256hex(sealed) }));
    return { record: { name, kind, pub: pubText, sealed, ts }, recordSig: b64u(sig) };
  }

  return {
    base: root,
    check: name => call("GET", `/v1/names/check?name=${encodeURIComponent(name)}`, undefined, false),
    /** Claim a name for this key. Returns the one-time recovery code (show it once; the directory keeps only its hash). */
    claim: async (name, kind, payload) => call("POST", "/v1/ids/claim", { name, kind, ...await recordFor(name, kind, payload) }),
    /** Resolve a name (or an own-domain alias) and verify it against the pinned key, if there is one. */
    async resolve(nameOrAlias, { pinned, alias = false } = {}) {
      const q = alias ? `alias=${encodeURIComponent(nameOrAlias)}` : `name=${encodeURIComponent(nameOrAlias)}`;
      const r = await call("GET", `/v1/ids/resolve?${q}`, undefined, false);
      return verifyResolved(r.name, r, pinned);
    },
    mine: () => call("GET", "/v1/ids/mine"),
    update: async (name, kind, payload) => call("POST", "/v1/ids/update", { name, ...await recordFor(name, kind, payload) }),
    /** The TXT value to put at _vyre-id.<domain> before addAlias, signed by this key. */
    async aliasTxt(name, domain) {
      const { route } = await signer.identity();
      const sig = await sign(aliasMessage({ name, domain, keyId: route }));
      return { host: `_vyre-id.${domain}`, value: `vyre-id=1;name=${name};key=${route};sig=${b64u(sig)}` };
    },
    addAlias: (name, domain) => call("POST", "/v1/ids/alias", { name, domain }),
    removeAlias: (name, domain) => call("DELETE", "/v1/ids/alias", { name, domain }),
    release: name => call("POST", "/v1/ids/release", { name }),
    cancelRecovery: name => call("POST", "/v1/ids/recover/cancel", { name }),
    /** This (new) key asks to take over `name` with the recovery code; `next` is the hash of the code the new holder chose. */
    recover: async (name, kind, code, next, payload) => call("POST", "/v1/ids/recover", { name, code, next, ...await recordFor(name, kind, payload) }),
    /** Move a name to a new key: this client holds the OLD key; `nextSigner` is the new one, which signs the record and the move. */
    async rotate(name, kind, payload, nextSigner) {
      const next = await nextSigner.identity();
      const old = await signer.identity();
      const ts = now();
      const sealed = sealRecord(name, payload);
      const pubText = b64u(next.pub);
      const recordSig = await nextSigner.sign(recordMessage({ name, kind, pub: pubText, ts, sealedHash: sha256hex(sealed) }));
      const rotateSig = await nextSigner.sign(rotateMessage({ name, from: old.route, to: next.route }));
      return call("POST", "/v1/ids/rotate", { name, record: { name, kind, pub: pubText, sealed, ts }, recordSig: b64u(recordSig), rotateSig: b64u(rotateSig) });
    },
  };
}

/** A signer over an Ed25519 key held in memory (tests, and the first device before a secure chip holds it). @param {crypto.KeyObject} privateKey */
export function memorySigner(privateKey) {
  const pub = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { identity: async () => ({ route: keyId(pub), pub: Buffer.from(pub) }), sign: async (/** @type {Buffer} */ m) => crypto.sign(null, m, privateKey) };
}
