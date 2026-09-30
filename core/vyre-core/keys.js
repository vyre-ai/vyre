// @ts-check
// vyre-core's relay keys (ADR 0040 phase 5): the box's Noise static key (X25519) and the route key
// (Ed25519) live here, in core's own data directory, and their private halves never leave it. What
// core offers is the four things the relay needs and nothing else: the two public halves, the DH
// step of a Noise handshake, and a signature with the route key.
//
// Stored as keys.json (0600) in the data directory, which only core's account can read. Made on the
// first ensure, atomically: two racing ensures end with the same keys.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { b64, raw, xPrivateKey, ePrivateKey, pubRaw, dhB64, signB64 } from "../../lib/vyre-core-keys.js";

/**
 * The key store in `dataDir`.
 * @param {string} dataDir
 */
export function openKeys(dataDir) {
  const file = path.join(dataDir, "keys.json");
  /** @type {{ box: Buffer, route: Buffer } | null} */
  let cache = null;
  const read = () => {
    if (cache) return cache;
    let j;
    try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
      if (/** @type {any} */ (e).code === "ENOENT") return null;
      throw new Error(`core's keys are unreadable (${file}): ${/** @type {Error} */ (e).message}`);
    }
    cache = { box: raw(j.box, "keys.json box"), route: raw(j.route, "keys.json route") };
    return cache;
  };
  const need = () => {
    const k = read();
    if (!k) throw Object.assign(new Error("core has no relay keys yet: call keys.ensure first"), { code: "no_keys" });
    return k;
  };
  return {
    exists: () => Boolean(read()),
    /** Make both keys if there are none. @returns {{ created: boolean }} */
    ensure() {
      if (read()) return { created: false };
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const box = crypto.generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
      const route = crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, box: b64(Buffer.from(box)), route: b64(Buffer.from(route)) }) + "\n", { mode: 0o600 });
      try { fs.linkSync(tmp, file); } catch (e) { if (/** @type {any} */ (e).code !== "EEXIST") throw e; } finally { fs.rmSync(tmp, { force: true }); }
      cache = null;
      read();
      return { created: true };
    },
    boxPub: () => b64(pubRaw(xPrivateKey(need().box))),
    /** The Noise DH: our static private key with the remote public key. @param {string} remote */
    boxDh: remote => dhB64(need().box, remote),
    routePub: () => b64(pubRaw(ePrivateKey(need().route))),
    /** @param {string} message base64url bytes to sign */
    routeSign: message => signB64(need().route, message),
  };
}
