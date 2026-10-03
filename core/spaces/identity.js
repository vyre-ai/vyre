// @ts-check
// spaces: this device's PERSON key, behind one small interface so a secure chip can replace the file later.
//
//   IdentityStore {
//     status():  { exists, pending, name, id, keyId, publicKey, createdAt }     no secret in it
//     generate():  make the key and keep it (pending, with no name yet); returns status()
//     setName(name): the name was claimed; returns status()
//     sign(message: Buffer): Promise<Buffer>                                      the private half never leaves the store
//     clear():   forget the key (a failed first claim)
//   }
//
// The file store keeps `<home>/spaces/identity.json`, mode 0600, inside a 0700 folder. The recovery code the directory returns at claim
// time is NOT part of this store: it goes to the caller once and is never written anywhere here.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { keyId } from "../names/ids.js";

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
  const view = (/** @type {any} */ r) => r
    ? { exists: true, pending: !r.name, name: r.name || null, id: personIdOf(r.publicKey), keyId: keyId(Buffer.from(r.publicKey, "base64url")), publicKey: r.publicKey, createdAt: r.createdAt }
    : { exists: false, pending: false, name: null, id: null, keyId: null, publicKey: null, createdAt: null };
  return {
    kind: "file",
    status: () => view(read()),
    generate() {
      if (read()) throw Object.assign(new Error("this device already has a Vyre identity"), { code: "exists" });
      const kp = newKeyPair();
      writePrivate(file, JSON.stringify({ v: 1, name: null, publicKey: kp.publicKey, privateKey: kp.privateKey, createdAt: Date.now() }) + "\n");
      return view(read());
    },
    setName(/** @type {string} */ name) {
      const r = read();
      if (!r) throw Object.assign(new Error("no identity"), { code: "no_identity" });
      writePrivate(file, JSON.stringify({ ...r, name }) + "\n");
      return view(read());
    },
    async sign(/** @type {Buffer} */ message) {
      const r = read();
      if (!r) throw Object.assign(new Error("no identity"), { code: "no_identity" });
      return crypto.sign(null, message, privateKeyOf(r.privateKey));
    },
    clear() { try { fs.rmSync(file, { force: true }); } catch { /* already gone */ } },
  };
}
