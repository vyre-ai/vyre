// @ts-check
// The first key of a Mac SERVER (ADR 0040, the add-a-server path). A Mac with the full install has no Capsule, so there is no key to prove the first enrolment with. What stands in is the
// one thing the app's install line already carries: the setup code is secret16 || the fingerprint of the app's own P-256 key (core/relay/wire.js). The installer reads the fingerprint (not the
// secret) out of that code and hands it to core; core then takes ONE key, and only the key with that fingerprint, within the hour. A same-uid process that read the code from vyre.env
// still cannot enrol a key of its own, because it would need the private half of the app's key. After the first key every enrolment needs a proof from an enrolled key (core's own rule).

import crypto from "node:crypto";

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
    db.prepare("UPDATE core_first_key SET used = ? WHERE id = 1").run(now());
    const k = presence.enroll({ kind: "device", name: input.name, public_key: input.public_key, alg: -7 });
    db.exec("COMMIT");
    return k;
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
}
