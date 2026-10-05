// @ts-check
// key: the box's Ed25519 key, made on first need and kept in its home at 0600. A companion core pins its public half when it pairs (companion.js).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The file in the box's home that holds the key. */
export const KEY_FILE = "link-assert-key.json";

const b64u = (/** @type {Buffer} */ b) => Buffer.from(b).toString("base64url");

/** The stored key, or null when there is none yet. @param {string} file */
function loadKey(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return null; throw e; }
  try {
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(JSON.parse(text).private, "base64url"), format: "der", type: "pkcs8" });
    return { privateKey, publicKey: b64u(crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" })) };
  } catch (e) { throw new Error(`the link's key in ${file} could not be read: ${/** @type {Error} */ (e).message}`); }
}

/**
 * The box's key: loaded from its home, or made and stored there at 0600 on first need.
 * @param {string} root the box's VYRE_HOME
 * @returns {{ privateKey: crypto.KeyObject, publicKey: string }} publicKey: SPKI DER, base64url
 */
export function boxKey(root) {
  const file = path.join(root, KEY_FILE);
  const had = loadKey(file);
  if (had) return had;
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const text = JSON.stringify({ v: 1, alg: "ed25519", private: b64u(privateKey.export({ format: "der", type: "pkcs8" })) }) + "\n";
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // Two makers racing: the first file wins (link never replaces), and both read it back.
  try { fs.linkSync(tmp, file); } catch (e) { if (/** @type {any} */ (e).code !== "EEXIST") { fs.rmSync(tmp, { force: true }); throw e; } }
  fs.rmSync(tmp, { force: true });
  return /** @type {any} */ (loadKey(file));
}
