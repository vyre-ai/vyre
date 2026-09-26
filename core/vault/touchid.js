// @ts-check
// touchid: Touch ID unlock of the personal vault (ADR 0006, decision 2).
//
// The Secure Enclave helper (mac/enclave.swift) makes a P-256 key that never leaves the enclave
// and needs a fingerprint for every use. Enrolling wraps the account unlock key (AUK) under
// HKDF of an ECDH between that key and an ephemeral P-256 key whose private half is thrown away
// at once; only the enclave can redo that ECDH, and only after Touch ID. Stored in
// vault/touchid.json: the enclave's key handle (useless off this Mac), both public keys and the
// wrapped AUK. Values reach the helper on stdin and come back on stdout, never on argv.

import crypto from "node:crypto";
import { lines } from "./mac/helper.js";
import { wrapVaultKey, unwrapVaultKey, keyObject } from "./crypto.js";

const TIMEOUT_MS = 90_000;

/**
 * One request to the enclave helper, one JSON line back. The reply's error words are fixed by
 * the helper and carry no request data.
 * @param {import("./mac/helper.js").Helper} helper @param {any} req
 * @returns {Promise<any>}
 */
export async function enclaveCall(helper, req) {
  const child = await helper.spawn([]);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (/** @type {any} */ v, /** @type {Error|null} */ e) => {
      if (done) return; done = true; clearTimeout(timer);
      try { child.kill(); } catch {}
      e ? reject(e) : resolve(v);
    };
    const timer = setTimeout(() => finish(null, new Error("the Touch ID helper did not answer")), TIMEOUT_MS);
    lines(child.stdout, msg => finish(msg, null));
    child.on("error", () => finish(null, new Error("the Touch ID helper could not start")));
    child.on("close", () => finish(null, new Error("the Touch ID helper ended without an answer")));
    child.stdin.end(JSON.stringify(req) + "\n");
  });
}

const wrapKey = (shared, ephPub, sePub, acct) => {
  const k = keyObject(Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([ephPub, sePub]), `vyre touchid v2:${acct}`, 32)));
  shared.fill(0);
  return k;
};
const aad = acct => `vyre:touchid:v2:${acct}`;

/**
 * Wrap the AUK to an enclave public key. The ephemeral private key lives only in this call.
 * @param {crypto.KeyObject} auk @param {string} sePubB64 x9.63 uncompressed @param {string} acct
 */
export function wrapAuk(auk, sePubB64, acct) {
  const sePub = Buffer.from(sePubB64, "base64");
  if (sePub.length !== 65 || sePub[0] !== 4) throw new Error("the Secure Enclave returned a key that is not P-256");
  const eph = crypto.createECDH("prime256v1");
  const ephPub = eph.generateKeys();
  const k = wrapKey(eph.computeSecret(sePub), ephPub, sePub, acct);
  return { ephPub: ephPub.toString("base64"), wrapped: wrapVaultKey(k, auk, aad(acct)) };
}

/**
 * The AUK back from the shared secret the enclave computed after Touch ID.
 * @param {Buffer} shared @param {{ ephPub: string, sePub: string, wrapped: any }} rec @param {string} acct
 */
export function unwrapAuk(shared, rec, acct) {
  const k = wrapKey(shared, Buffer.from(rec.ephPub, "base64"), Buffer.from(rec.sePub, "base64"), acct);
  return unwrapVaultKey(k, rec.wrapped, aad(acct));
}
