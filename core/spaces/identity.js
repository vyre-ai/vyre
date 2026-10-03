// @ts-check
// spaces: this DEVICE's key and the copy of the person's identity chain it holds (team/0.3/DESIGN-wink.md section 2), behind one small
// interface so a secure chip can replace the file later.
//
//   IdentityStore {
//     status():  { exists, pending, name, id, eid, keyId, publicKey, seq, createdAt }   no secret in it. `id` is the permanent identity id,
//                `eid` this device's entry on the list (keyId is the same, kept for older callers)
//     generate({ code?, label? }): make the device key and the genesis (with the recovery code's entry if given); keeps it pending, with no name yet
//     join(ops, pin): this device was added to an existing identity by another entry: keep its key and the chain it was given
//     setName(name): the name was claimed; returns status()
//     sign(message: Buffer): Promise<Buffer>                                      the private half never leaves the store
//     ops() / pin() / setChain(ops, pin): the chain this device holds and the head it last verified
//     held: keys this device holds FOR OTHERS (a recovery contact's approval key), by entry id
//     clear():   forget the key (a failed first claim)
//   }
//
// The file store keeps `<home>/spaces/identity.json`, mode 0600, inside a 0700 folder. The recovery code is NOT part of this store: it goes
// to the caller once and is never written anywhere here (only its public key is on the chain).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { keyId } from "../../lib/identity/directory.js";
import * as C from "../../kernel/identity/chain.js";

const b64u = (/** @type {Uint8Array|Buffer} */ b) => Buffer.from(b).toString("base64url");
export const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** A fresh Ed25519 pair: the raw 32-byte public key and the PKCS8 private key, both base64url. */
export function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: b64u(pub), privateKey: b64u(privateKey.export({ format: "der", type: "pkcs8" })) };
}

/** The key object of a stored private key. @param {string} privateKey */
export const privateKeyOf = privateKey => crypto.createPrivateKey({ key: Buffer.from(privateKey, "base64url"), format: "der", type: "pkcs8" });

/** `per_` plus the key's 26-character id (contract section 4.1). @param {string|Buffer} publicKey raw 32 bytes, base64url when a string */
export const personIdOf = publicKey => `per_${keyId(typeof publicKey === "string" ? Buffer.from(publicKey, "base64url") : publicKey)}`;

/** A directory signer over a sign function and a raw public key. @param {string} publicKey base64url @param {(m: Buffer) => Promise<Buffer>|Buffer} sign */
export function signerOf(publicKey, sign) {
  const pub = Buffer.from(publicKey, "base64url");
  return { identity: async () => ({ route: keyId(pub), pub }), sign: async (/** @type {Buffer} */ m) => Buffer.from(await sign(m)) };
}

/** Write a private file: folder 0700, file 0600, replaced atomically. @param {string} file @param {string} text */
export function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* win32 */ }
  fs.renameSync(tmp, file);
}

/** @param {string} dir the `<home>/spaces` folder */
export function fileIdentityStore(dir) {
  const file = path.join(dir, "identity.json");
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
  const write = (/** @type {any} */ r) => writePrivate(file, JSON.stringify(r) + "\n");
  const view = (/** @type {any} */ r) => r
    ? { exists: true, pending: !r.name, name: r.name || null, id: r.id || personIdOf(r.publicKey), eid: keyId(Buffer.from(r.publicKey, "base64url")), keyId: keyId(Buffer.from(r.publicKey, "base64url")), publicKey: r.publicKey, seq: Array.isArray(r.ops) && r.ops.length ? r.ops[r.ops.length - 1].seq : 0, createdAt: r.createdAt }
    : { exists: false, pending: false, name: null, id: null, eid: null, keyId: null, publicKey: null, seq: 0, createdAt: null };
  return {
    kind: "file",
    status: () => view(read()),
    async generate(/** @type {{ code?: { eid: string, pub: string }, label?: string, ts?: number }} */ o = {}) {
      if (read()) throw Object.assign(new Error("this device already has a Vyre identity"), { code: "exists" });
      const kp = newKeyPair();
      const priv = privateKeyOf(kp.privateKey);
      const eid = keyId(Buffer.from(kp.publicKey, "base64url"));
      const ts = o.ts ?? Date.now();
      const g = await C.makeGenesis({ kind: "person", entry: { eid, kind: "device", pub: kp.publicKey, label: o.label }, ...(o.code ? { code: { eid: o.code.eid, kind: "code", pub: o.code.pub } } : {}),
        nonce: crypto.randomBytes(12).toString("base64url"), ts, sign: m => crypto.sign(null, Buffer.from(m), priv) });
      const state = await C.verifyChain([g], { now: ts + 1 });
      write({ v: 2, name: null, id: state.id, publicKey: kp.publicKey, privateKey: kp.privateKey, ops: [g], pin: C.pinOf(state), createdAt: ts });
      return view(read());
    },
    /** A key for a device that another entry will add to an existing identity. Nothing is on the list until that entry signs. */
    newDeviceKey() { const kp = newKeyPair(); return { publicKey: kp.publicKey, eid: keyId(Buffer.from(kp.publicKey, "base64url")), privateKey: kp.privateKey }; },
    join(/** @type {{ privateKey: string, publicKey: string }} */ key, /** @type {any[]} */ ops, /** @type {string} */ name) {
      if (read()) throw Object.assign(new Error("this device already has a Vyre identity"), { code: "exists" });
      write({ v: 2, name, id: ops[0].id, publicKey: key.publicKey, privateKey: key.privateKey, ops, pin: null, createdAt: Date.now() });
      return view(read());
    },
    setName(/** @type {string} */ name) {
      const r = read();
      if (!r) throw Object.assign(new Error("no identity"), { code: "no_identity" });
      write({ ...r, name });
      return view(read());
    },
    async sign(/** @type {Buffer} */ message) {
      const r = read();
      if (!r) throw Object.assign(new Error("no identity"), { code: "no_identity" });
      return crypto.sign(null, message, privateKeyOf(r.privateKey));
    },
    ops() { const r = read(); return r && Array.isArray(r.ops) ? r.ops : []; },
    pin() { const r = read(); return r ? r.pin || null : null; },
    setChain(/** @type {any[]} */ ops, /** @type {any} */ pin) { const r = read(); if (!r) throw Object.assign(new Error("no identity"), { code: "no_identity" }); write({ ...r, ops, pin }); },
    /** The alerts a device has already shown, as a sequence number. */
    alerted() { const r = read(); return r ? Number(r.alerted || 0) : 0; },
    setAlerted(/** @type {number} */ seq) { const r = read(); if (r) write({ ...r, alerted: seq }); },
    held: {
      get: (/** @type {string} */ eid) => { const r = read(); return r && r.held && r.held[eid] ? r.held[eid] : null; },
      put: (/** @type {string} */ eid, /** @type {any} */ v) => { const r = read(); if (r) write({ ...r, held: { ...(r.held || {}), [eid]: v } }); },
      list: () => { const r = read(); return r && r.held ? Object.entries(r.held).map(([eid, v]) => ({ eid, ...(/** @type {any} */ (v)) })) : []; },
    },
    clear() { try { fs.rmSync(file, { force: true }); } catch { /* already gone */ } },
  };
}
