// @ts-check
// The first key of a Mac SERVER (ADR 0040, the add-a-server path). A Mac with the full install has no Capsule, so there is no key to prove the first enrolment with. What stands in is the
// one thing the app's install line already carries: the setup code is secret16 || the fingerprint of the app's own P-256 key (core/relay/wire.js). The installer reads the fingerprint (not the
// secret) out of that code and hands it to core; core then takes ONE key, and only the key with that fingerprint, within the hour. A same-uid process that read the code from vyre.env
// still cannot enrol a key of its own, because it would need the private half of the app's key. After the first key every enrolment needs a proof from an enrolled key (core's own rule).

import crypto from "node:crypto";
import { inputHash, parse } from "../presence/index.js";

/** The hour the first key may arrive in: the setup code's own life. */
export const FIRST_KEY_TTL = 60 * 60_000;
/** wire.js SETUP_TAG.key: kept as a literal here because vyre-core imports no relay code; a test holds the two equal. */
const TAG = "vyre-setup-key";
const P256_SPKI_HEAD = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

/** The setup fingerprint (16 bytes, hex) of a P-256 SPKI public key given as base64url DER, or null when it is not one. @param {unknown} publicKey */
export function fingerprintOf(publicKey) {
  if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]{100,140}$/.test(publicKey)) return null;
  const spki = Buffer.from(publicKey, "base64url");
  if (spki.length !== 91 || !spki.subarray(0, 26).equals(P256_SPKI_HEAD) || spki[26] !== 4) return null;
  return crypto.createHash("sha256").update(`${TAG}\n`).update(spki).digest().subarray(0, 16).toString("hex");
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function migrateFirstKey(db) {
  db.exec("CREATE TABLE IF NOT EXISTS core_first_key (id INTEGER PRIMARY KEY CHECK (id = 1), fp TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER)");
  // the first key's id, and whether the Capsule key it may name has been taken (enrollCapsule)
  for (const col of ["key_id TEXT", "capsule_done INTEGER"]) { try { db.exec(`ALTER TABLE core_first_key ADD COLUMN ${col}`); } catch { /* already there */ } }
}

/** Arm the first key: the fingerprint, good for an hour, replacing any earlier unused one. @param {any} db @param {string} fp 32 hex @param {number} [now] */
export function armFirstKey(db, fp, now = Date.now()) {
  if (!/^[0-9a-f]{32}$/.test(fp)) throw Object.assign(new Error("the first key's fingerprint is 32 hex characters"), { code: "bad_input" });
  migrateFirstKey(db);
  db.prepare("INSERT INTO core_first_key (id, fp, expires, used) VALUES (1, ?, ?, NULL) ON CONFLICT (id) DO UPDATE SET fp = excluded.fp, expires = excluded.expires, used = NULL").run(fp, now + FIRST_KEY_TTL);
}

/**
 * Enrol the first key. Only a device key (P-256, ES256), only while core has no key, only the key the armed fingerprint names, only once and within the hour. The row is spent in the same
 * transaction as the enrolment, so two racing calls cannot both win and a failed enrolment does not burn it.
 * @param {{ db: any, presence: any, now?: () => number }} d @param {any} input
 */
export function enrollFirst({ db, presence, now = Date.now }, input) {
  const no = (/** @type {string} */ message, code = "presence_required") => Object.assign(new Error(message), { code });
  if (!input || input.kind !== "device" || (input.alg !== undefined && input.alg !== -7)) throw no("the first key of a server is a device key (P-256, alg -7)", "bad_input");
  const fp = fingerprintOf(input.public_key);
  if (!fp) throw no("that is not a P-256 public key (base64url SPKI)", "bad_input");
  if (presence.keys().length) throw no("vyre-core already has a key: enroll with a proof from it");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (presence.keys().length) { db.exec("ROLLBACK"); throw no("vyre-core already has a key: enroll with a proof from it"); }
    const row = db.prepare("SELECT fp, expires, used FROM core_first_key WHERE id = 1").get();
    if (!row || row.used || now() > Number(row.expires)) { db.exec("ROLLBACK"); throw no("no first key is waiting for this server (the install line's hour is over, or it was used)"); }
    if (row.fp !== fp) { db.exec("ROLLBACK"); throw no("that key is not the one the install line named"); }
    const k = presence.enroll({ kind: "device", name: input.name, public_key: input.public_key, alg: -7 });
    db.prepare("UPDATE core_first_key SET used = ?, key_id = ?, capsule_done = NULL WHERE id = 1").run(now(), k.id);
    db.exec("COMMIT");
    return k;
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
}

/** The ES256 skew a first-key proof is allowed, either way. */
const PROOF_SKEW = 2 * 60_000;

/**
 * The Capsule key of a Mac server (ADR 0040): the app's Secure Enclave key, P-256, enrolled as a `capsule` key, whose Touch ID proofs are `hardware` strength. A software setup key cannot prove an
 * enrolment for a presence act (strength.js), and a Secure Enclave key cannot do the WebCrypto the setup channel uses, so the hand-over is this one act: the setup key, which the install line named and
 * which is core's ONLY key, signs the Capsule key's enrolment (a vyre-presence-v1 proof over this exact input), core checks that signature itself, and in the same transaction the Capsule key is
 * enrolled and the setup key is removed. Once, within the hour of the first key. After it core holds one key and it is a hardware one.
 * @param {{ db: any, presence: any, now?: () => number }} d @param {any} input { kind: "capsule", name, public_key, alg: -7, proof }
 */
export function enrollCapsule({ db, presence, now = Date.now }, input) {
  const no = (/** @type {string} */ message, code = "presence_required") => Object.assign(new Error(message), { code });
  if (!input || input.kind !== "capsule" || (input.alg !== undefined && input.alg !== -7)) throw no("a server's Capsule key is a Secure Enclave key (P-256, alg -7)", "bad_input");
  if (!fingerprintOf(input.public_key)) throw no("that is not a P-256 public key (base64url SPKI)", "bad_input");
  const proof = parse(String(input.proof || ""));
  if (!proof || proof.method !== "device" || !proof.key || !proof.sig) throw no("the Capsule key's enrolment is signed by the setup key: a device proof is needed");
  const body = { kind: "capsule", name: input.name, public_key: input.public_key, alg: -7 };
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT used, key_id, capsule_done FROM core_first_key WHERE id = 1").get();
    const keys = presence.keys();
    if (!row || !row.used || !row.key_id) throw no("no first key has been taken, so there is nothing to hand over from");
    if (row.capsule_done) throw no("the Capsule key was already taken for this server");
    if (now() - Number(row.used) > FIRST_KEY_TTL) throw no("the hour of the first key is over");
    if (keys.length !== 1 || keys[0].id !== row.key_id) throw no("the setup key is no longer vyre-core's only key: enroll with a proof from a key it has");
    if (String(proof.key) !== row.key_id) throw no("that proof is not from the setup key");
    const ts = Number(proof.ts);
    if (!/^\d{1,16}$/.test(String(proof.ts)) || Math.abs(now() - ts) > PROOF_SKEW) throw no("the proof is too old or from the future");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(proof.nonce))) throw no("the proof's nonce is missing or malformed");
    const stored = db.prepare("SELECT public_key FROM presence_keys WHERE id = ?").get(row.key_id);
    let good = false;
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(stored.public_key, "base64url"), format: "der", type: "spki" });
      good = crypto.verify("sha256", Buffer.from(`vyre-presence-v1\npresence.enroll\n${inputHash(body)}\n${proof.ts}\n${proof.nonce}`), { key: pub, dsaEncoding: "der" }, Buffer.from(String(proof.sig), "base64url"));
    } catch { good = false; }
    if (!good) throw no("the setup key's signature does not check out");
    const k = presence.enroll({ kind: "capsule", name: input.name, public_key: input.public_key, alg: -7 });
    presence.remove(row.key_id);
    db.prepare("UPDATE core_first_key SET capsule_done = ? WHERE id = 1").run(now());
    db.exec("COMMIT");
    return k;
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
}
