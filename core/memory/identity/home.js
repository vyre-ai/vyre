// @ts-check
// The identity home: the person's identity memory (and the private assistant's state) kept as ciphertext on any space server they belong to, or on a server of their own
// (team/0.3/DESIGN-memory-layers.md). The server holds ciphertext and wrapped copies of the key and nothing it could read; an admin or root there sees only that.
//
//   backend     where the bytes live: a space server's blob folder (FileBackend here; the server's own store in life). It stores and returns bytes by name and knows no key.
//   manifest    identity/<id>/manifest.json: the wrapped keys (one per device, one for the recovery code), the revision, and each object's hash. No secret in it.
//   snapshot    identity/<id>/snap-<rev>.json: a box (crypto.js) of the identity memory, bound to (identity, revision).
//   lease       the key, held in a process's memory for a short time after the person said yes on their phone; it is never written anywhere.
//
// Unlocking is the person's, and it is asked once. On the person's own device their device key unwraps with no prompt (unlockWithDevice). On a shared space server the person gives ONE yes per
// server ("let my assistant use my memory here"): the phone then answers that server's requests by itself, after a restart too, until the person revokes it from the phone. A request is the
// assistant's one-use key pair, signed with the server's own key; the phone checks the signature against the server it granted, unwraps the key with its own and wraps it to the request's
// public key; the assistant opens that. The server only carries the request and the answer. Moving the home to another server is a copy of ciphertext checked by hash, with the old place left
// holding only a marker: the key never changes, so nothing is re-encrypted and nothing is readable on the way.

import { canonical } from "../../../kernel/core/canonical.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newKey, seal, open, newDeviceKey, wrapForDevice, unwrapWithDevice, fingerprint, sha256 } from "../../../lib/keywrap.js";
import { argon2id, STRETCH, STRETCH_SALT } from "../../../kernel/identity/stretch.js";
import { derive, utf8 } from "../../../lib/databox.js";

// The recovery code wrap. It is the IDENTITY's recovery code (the 26 base32 characters of core/spaces/recovery.js, with the optional recovery password), not a second one: the same stretch of the same input
// (kernel/identity/stretch.js: Argon2id, STRETCH parameters, STRETCH_SALT) that makes the identity's recovery key, then HKDF to a key of its own for this wrap, so the identity's signing seed is never used as an
// encryption key. It is the way back into the memory and the backup when every device is lost: a new device that recovered into the identity with the code opens the home with the same code.
import { wrapWithCode, unwrapWithCode, codeLooksRight } from "../../../lib/code-wrap.js";
export { wrapWithCode, unwrapWithCode, codeLooksRight };

/** An unlocked key lives in the assistant's process until it is locked, revoked or the process ends: there is no timer that asks the person again (the no-nagging rule). */
export const LEASE_MS = Infinity;

/** A server's blob folder, by name. It is the whole of what a space server is to the identity home. */
export class FileBackend {
  /** @param {string} dir @param {string} [name] what a manifest calls this place */
  constructor(dir, name = dir) { this.dir = dir; this.name = name; fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  /** @param {string} name */
  path(name) {
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.split("/").some(p => p === ".." || p === "")) throw Object.assign(new Error("bad object name"), { code: "bad_input" });
    return path.join(this.dir, ...name.split("/"));
  }
  /** @param {string} name @param {Buffer|string} bytes */
  put(name, bytes) { const f = this.path(name); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); const tmp = `${f}.tmp`; fs.writeFileSync(tmp, bytes, { mode: 0o600 }); fs.renameSync(tmp, f); }
  /** @param {string} name @returns {Buffer|null} */
  get(name) { const f = this.path(name); try { return fs.readFileSync(f); } catch { return null; } }
  /**
   * A write that lands only if the object is what the writer last saw (its sha256, or null for "not there"): the one compare-and-set a second device needs so two devices never overwrite each other. A server's
   * own storage does this atomically; here it is check-then-write.
   * @param {string} name @param {Buffer|string} bytes @param {string|null} expected @returns {boolean}
   */
  putIf(name, bytes, expected) {
    const cur = this.get(name);
    const have = cur ? crypto.createHash("sha256").update(cur).digest("hex") : null;
    if (have !== expected) return false;
    this.put(name, bytes);
    return true;
  }
  /** @param {string} prefix @returns {string[]} */
  list(prefix) {
    const base = this.path(prefix.replace(/\/$/, ""));
    try { return fs.readdirSync(base).filter(n => !n.endsWith(".tmp")).map(n => `${prefix.replace(/\/$/, "")}/${n}`); } catch { return []; }
  }
  /** @param {string} name */
  delete(name) { const f = this.path(name); try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
}

/** The key, in memory, until it expires or is locked. */
export class Lease {
  /** @param {Buffer} key @param {string} id @param {number} expires @param {() => number} now */
  constructor(key, id, expires, now) { this.k = key; this.id = id; this.expires = expires; this.now = now; }
  /** @returns {Buffer} @throws when it has expired or been locked */
  key() {
    if (!this.k || this.now() >= this.expires) { this.lock(); throw Object.assign(new Error("the identity memory is locked: ask the person's phone to unlock it"), { code: "locked" }); }
    return this.k;
  }
  get open() { return Boolean(this.k) && this.now() < this.expires; }
  lock() { if (this.k) this.k.fill(0); this.k = /** @type {any} */ (null); }
}

const aadOf = (/** @type {string} */ id, /** @type {string} */ what) => `vyre-identity-home/${id}/${what}`;
const dir = (/** @type {string} */ id) => `identity/${id}`;

/**
 * What the person's phone does with an unlock request, after Face ID (the app's code; here so a test can be the phone): unwrap the key with its own device key and wrap it to the
 * session that asked.
 * @param {{ privateJwk: import("node:crypto").JsonWebKey, publicJwk: import("node:crypto").JsonWebKey }} device
 * @param {{ id: string, home: string, request: string, sessionPub: import("node:crypto").JsonWebKey, wraps: any[] }} ask
 */
export async function approveUnlock(device, ask) {
  const mine = ask.wraps.find(w => w.kind === "device" && w.fp === fingerprint(device.publicJwk));
  if (!mine) throw Object.assign(new Error("this device holds no key for that identity memory"), { code: "unknown_key" });
  const key = await unwrapWithDevice(mine.wrapped, device.privateJwk, aadOf(ask.home, `wrap:${mine.fp}`));
  try { return wrapForDevice(key, ask.sessionPub, aadOf(ask.home, `unlock:${ask.request}`)); } finally { key.fill(0); }
}

/** A server's own key pair: it signs the unlock requests it makes, so a phone that granted this server can tell its requests from anyone else's. It decrypts nothing. @returns {{ publicJwk: import("node:crypto").JsonWebKey, privateJwk: import("node:crypto").JsonWebKey }} */
export const newServerKey = () => newDeviceKey();

// sorted-key canonical JSON (kernel/core/canonical.js): the order a field arrives in never decides whether a signature stands
const askBytes = (/** @type {any} */ ask) => Buffer.from(canonical({ id: ask.id, home: ask.home, request: ask.request, sessionPub: ask.sessionPub, rev: ask.rev, server: ask.server ? ask.server.fp : null }));
/** Sign an unlock request as this server. @param {any} ask @param {import("node:crypto").JsonWebKey} privateJwk */
export const signAsk = (ask, privateJwk) => crypto.sign("sha256", askBytes(ask), { key: crypto.createPrivateKey({ key: privateJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }).toString("base64url");
/** Was this request signed by the server with that public key? @param {any} ask @param {import("node:crypto").JsonWebKey} publicJwk */
export const askSignedBy = (ask, publicJwk) => { try { return crypto.verify("sha256", askBytes(ask), { key: crypto.createPublicKey({ key: publicJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(String(ask.sig || ""), "base64url")); } catch { return false; } };

/**
 * The person's phone, as far as unlocking goes (the app's code; here so a test can be the phone). It holds the device key and the standing grants: servers the person said yes to once.
 * A request from a granted server, signed by that server's key, is answered at once with no prompt; anything else needs the person's yes first and is refused here.
 */
export class Phone {
  /** @param {{ privateJwk: import("node:crypto").JsonWebKey, publicJwk: import("node:crypto").JsonWebKey }} device */
  constructor(device) { this.device = device; /** @type {Map<string, import("node:crypto").JsonWebKey>} */ this.grants = new Map(); }
  /** The person's yes, given once: let this server's assistant use their memory. @param {import("node:crypto").JsonWebKey} serverPublicJwk */
  grant(serverPublicJwk) { this.grants.set(fingerprint(serverPublicJwk), serverPublicJwk); return fingerprint(serverPublicJwk); }
  /** Revoked from the phone: no request from that server is answered again. @param {string} fp */
  revoke(fp) { return this.grants.delete(fp); }
  /** @param {any} ask */
  async answer(ask) {
    const server = ask.server && this.grants.get(ask.server.fp);
    if (!server) throw Object.assign(new Error("this server has not been given your memory: say yes on the phone first"), { code: "needs_yes" });
    if (!askSignedBy(ask, server)) throw Object.assign(new Error("that request is not signed by the server you granted"), { code: "bad_signature" });
    return approveUnlock(this.device, ask);
  }
}

export class IdentityHome {
  /** @param {{ id: string, backend: FileBackend, now?: () => number }} o */
  constructor({ id, backend, now = Date.now }) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw Object.assign(new Error("bad identity id"), { code: "bad_input" });
    this.id = id; this.backend = backend; this.now = now;
  }

  /** @returns {any|null} the manifest as stored (public: wrapped keys and hashes) */
  manifest() { const b = this.backend.get(`${dir(this.id)}/manifest.json`); try { return b ? JSON.parse(Buffer.from(b).toString("utf8")) : null; } catch { return null; } }
  exists() { const m = this.manifest(); return Boolean(m && !m.moved_to); }
  /** The servers the person has said yes to, as the manifest records them (the phone holds the standing grant itself; this is what a server shows and checks). @returns {{ server: string, fp: string, at: number }[]} */
  grants() { const m = this.manifest(); return m && Array.isArray(m.grants) ? m.grants : []; }
  /** @param {{ server: string, fp: string }} g */
  addGrant(g) {
    const m = this.manifest();
    if (!m) throw Object.assign(new Error("no identity memory is kept here (memory.identity.status shows where it is kept)"), { code: "not_found" });
    const grants = this.grants().filter(x => x.fp !== g.fp).concat([{ server: String(g.server).slice(0, 80), fp: g.fp, at: this.now() }]);
    this.backend.put(`${dir(this.id)}/manifest.json`, JSON.stringify({ ...m, grants }, null, 1));
  }
  /** @param {string} [fp] one server's, or all of them */
  removeGrant(fp) {
    const m = this.manifest();
    if (!m) return;
    this.backend.put(`${dir(this.id)}/manifest.json`, JSON.stringify({ ...m, grants: fp ? this.grants().filter(x => x.fp !== fp) : [] }, null, 1));
  }
  /** Where it went, if it was moved. */
  movedTo() { const b = this.backend.get(`${dir(this.id)}/moved.json`); try { return b ? JSON.parse(Buffer.from(b).toString("utf8")).to : null; } catch { return null; } }

  /**
   * Make the home: a new key, wrapped to each device and to the recovery code, and an empty first snapshot. The caller is the person's own device (it holds the key only here).
   * @param {{ devices: { label?: string, publicJwk: import("node:crypto").JsonWebKey }[], recoveryCode?: string, recoveryPassword?: string, snapshot?: any }} o
   * @returns {Lease}
   */
  create({ devices, recoveryCode, recoveryPassword = "", snapshot = { v: 1, tables: {}, state: {} } }) {
    if (this.manifest()) throw Object.assign(new Error("this identity already has a home here (memory.identity.status shows it)"), { code: "exists" });
    if (!devices || !devices.length) throw Object.assign(new Error("name at least one device that can unlock it"), { code: "bad_input" });
    const key = newKey();
    const wraps = devices.map(d => ({ kind: "device", label: d.label || null, fp: fingerprint(d.publicJwk), jwk: d.publicJwk, wrapped: wrapForDevice(key, d.publicJwk, aadOf(this.id, `wrap:${fingerprint(d.publicJwk)}`)) }));
    if (recoveryCode) wraps.push(/** @type {any} */ ({ kind: "code", wrapped: wrapWithCode(key, recoveryCode, aadOf(this.id, "wrap:code"), recoveryPassword) }));
    this.#write(key, 1, snapshot, wraps);
    return new Lease(key, this.id, this.now() + LEASE_MS, this.now);
  }

  /** @param {Buffer} key @param {number} rev @param {any} snapshot @param {any[]} wraps */
  #write(key, rev, snapshot, wraps) {
    const body = JSON.stringify(seal(JSON.stringify({ ...snapshot, rev }), key, aadOf(this.id, `snap:${rev}`)));
    const name = `${dir(this.id)}/snap-${rev}.json`;
    this.backend.put(name, body);
    const prev = this.manifest();
    this.backend.put(`${dir(this.id)}/manifest.json`, JSON.stringify({ v: 1, id: this.id, rev, wraps, ...(prev && prev.grants ? { grants: prev.grants } : {}), objects: { [`snap-${rev}.json`]: { sha256: sha256(body), bytes: Buffer.byteLength(body) } } }, null, 1));
    if (prev && prev.rev && prev.rev !== rev) this.backend.delete(`${dir(this.id)}/snap-${prev.rev}.json`);
  }

  /**
   * The assistant's session asks to unlock: a one-use key pair, and the request a card on the phone shows and signs over. The private half stays with the session.
   * @param {{ name: string, publicJwk: import("node:crypto").JsonWebKey, privateJwk: import("node:crypto").JsonWebKey }|null} [server] this server's key: the request is signed with it
   * @returns {{ ask: any, secret: import("node:crypto").JsonWebKey }}
   */
  beginUnlock(server = null) {
    const m = this.manifest();
    if (!m || m.moved_to) throw Object.assign(new Error("no identity memory is kept here (memory.identity.status shows where it is kept)"), { code: "not_found" });
    const k = newDeviceKey();
    const request = crypto.randomBytes(12).toString("base64url");
    /** @type {any} */
    const ask = { id: this.id, home: this.id, request, sessionPub: k.publicJwk, wraps: m.wraps.filter((/** @type {any} */ w) => w.kind === "device").map((/** @type {any} */ w) => ({ kind: w.kind, fp: w.fp, wrapped: w.wrapped })), rev: m.rev };
    if (server) { ask.server = { name: server.name, fp: fingerprint(server.publicJwk) }; ask.sig = signAsk(ask, server.privateJwk); }
    return { ask, secret: k.privateJwk };
  }

  /** @param {{ request: string }} ask @param {import("node:crypto").JsonWebKey} secret @param {any} rewrapped what the phone returned @returns {Promise<Lease>} */
  async finishUnlock(ask, secret, rewrapped) {
    const key = await unwrapWithDevice(rewrapped, secret, aadOf(this.id, `unlock:${ask.request}`));
    this.load(new Lease(key, this.id, this.now() + LEASE_MS, this.now));   // the key must open the newest snapshot, or it is not this memory's key
    return new Lease(key, this.id, this.now() + LEASE_MS, this.now);
  }

  /** The person's own device: its key unwraps with no prompt. @param {{ privateJwk: import("node:crypto").JsonWebKey, publicJwk: import("node:crypto").JsonWebKey }} device @returns {Lease} */
  async unlockWithDevice(device) {
    const m = this.manifest();
    const w = m && m.wraps.find((/** @type {any} */ x) => x.kind === "device" && x.fp === fingerprint(device.publicJwk));
    if (!m || !w) throw Object.assign(new Error("this device holds no key for that identity memory"), { code: "unknown_key" });
    const lease = new Lease(await unwrapWithDevice(w.wrapped, device.privateJwk, aadOf(this.id, `wrap:${w.fp}`)), this.id, this.now() + LEASE_MS, this.now);
    this.load(lease);
    return lease;
  }

  /** The recovery path: the code alone, on the person's own device. @param {string} code @returns {Lease} */
  unlockWithCode(code, password = "") {
    const m = this.manifest();
    const w = m && m.wraps.find((/** @type {any} */ x) => x.kind === "code");
    if (!w) throw Object.assign(new Error("no recovery code was set for this memory; unlock it with a device that can (memory.identity.status counts them)"), { code: "not_found" });
    return new Lease(unwrapWithCode(w.wrapped, code, aadOf(this.id, "wrap:code"), password), this.id, this.now() + LEASE_MS, this.now);
  }

  /** @param {Lease} lease @returns {any} the identity memory */
  load(lease) {
    const m = this.manifest();
    if (!m) throw Object.assign(new Error("no identity memory is kept here (memory.identity.status shows where it is kept)"), { code: "not_found" });
    const name = `snap-${m.rev}.json`;
    const raw = this.backend.get(`${dir(this.id)}/${name}`);
    if (!raw || sha256(raw) !== (m.objects[name] || {}).sha256) throw Object.assign(new Error("the stored identity memory does not match its manifest"), { code: "corrupt" });
    return JSON.parse(Buffer.from(open(JSON.parse(Buffer.from(raw).toString("utf8")), lease.key(), aadOf(this.id, `snap:${m.rev}`))).toString("utf8"));
  }

  /** A new revision of the identity memory. @param {Lease} lease @param {any} snapshot @returns {number} the revision */
  save(lease, snapshot) {
    const m = this.manifest();
    if (!m) throw Object.assign(new Error("no identity memory is kept here (memory.identity.status shows where it is kept)"), { code: "not_found" });
    this.load(lease);                                                                      // only the key that opens what is there may replace it
    this.#write(lease.key(), m.rev + 1, snapshot, m.wraps);
    return m.rev + 1;
  }

  /** Let another of the person's devices unlock: wrap the key to it too. @param {Lease} lease @param {{ label?: string, publicJwk: import("node:crypto").JsonWebKey }} device */
  addDevice(lease, device) {
    const m = this.manifest();
    if (!m) throw Object.assign(new Error("no identity memory is kept here (memory.identity.status shows where it is kept)"), { code: "not_found" });
    const fp = fingerprint(device.publicJwk);
    const wraps = m.wraps.filter((/** @type {any} */ w) => !(w.kind === "device" && w.fp === fp)).concat([{ kind: "device", label: device.label || null, fp, jwk: device.publicJwk, wrapped: wrapForDevice(lease.key(), device.publicJwk, aadOf(this.id, `wrap:${fp}`)) }]);
    this.backend.put(`${dir(this.id)}/manifest.json`, JSON.stringify({ ...m, wraps }, null, 1));
  }

  /**
   * Move the home to another server: the ciphertext is copied and each object's hash checked against the manifest, the new place gets the manifest last, and this one keeps only a marker
   * saying where it went. The key does not change and is not needed: nothing is decrypted or re-encrypted on the way.
   * @param {FileBackend} to @returns {{ moved: number, to: string }}
   */
  move(to) {
    const m = this.manifest();
    if (!m || m.moved_to) throw Object.assign(new Error("no identity memory is kept here to move"), { code: "not_found" });
    const there = new IdentityHome({ id: this.id, backend: to, now: this.now });
    if (there.manifest()) throw Object.assign(new Error("that server already holds an identity memory for this person"), { code: "exists" });
    let n = 0;
    for (const [name, o] of Object.entries(m.objects || {})) {
      const bytes = this.backend.get(`${dir(this.id)}/${name}`);
      if (!bytes || sha256(bytes) !== /** @type {any} */ (o).sha256) throw Object.assign(new Error(`${name} does not match its manifest: nothing was moved`), { code: "corrupt" });
      to.put(`${dir(this.id)}/${name}`, bytes);
      if (sha256(/** @type {Buffer} */ (to.get(`${dir(this.id)}/${name}`))) !== /** @type {any} */ (o).sha256) throw Object.assign(new Error(`${name} was not stored intact: nothing was moved`), { code: "corrupt" });
      n++;
    }
    to.put(`${dir(this.id)}/manifest.json`, JSON.stringify(m, null, 1));
    for (const name of Object.keys(m.objects || {})) this.backend.delete(`${dir(this.id)}/${name}`);
    this.backend.delete(`${dir(this.id)}/manifest.json`);
    this.backend.put(`${dir(this.id)}/moved.json`, JSON.stringify({ to: to.name, at: this.now() }));
    return { moved: n, to: to.name };
  }
}
