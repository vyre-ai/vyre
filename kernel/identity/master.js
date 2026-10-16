// @ts-check
// The master password (ADR 0054). One Argon2id stretch, the same function as the recovery code (kernel/identity/stretch.js), unlocks the
// root key. The root key wraps the identity halves, the personal vault master key and the member box key. The recovery key is a bearer for
// that root key: one screen, shown once. GitHub is a login name stored beside the record, never a key.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { argon2id } from "./stretch.js";
import { aesWrap, aesUnwrap, hkdf32, x25519Pair } from "./wrap.js";
import { writePrivate, readJson } from "./files.js";
import { holdIdentity, holdPersonal, forgetIdentity, clearPersonal, identityHeld } from "./holder.js";
import { checkUsername, personUrl } from "./username.js";

/** RFC 9106's second recommendation, one lane: this file's Argon2id is one lane only. */
export const MASTER_KDF = Object.freeze({ memoryKiB: 65536, passes: 3, lanes: 1, tagLength: 32 });
/** Tests only. Production calls use MASTER_KDF. */
export const TEST_KDF = Object.freeze({ memoryKiB: 32, passes: 1, lanes: 1, tagLength: 32, pure: true });
export const PASSWORD_MIN = 12;

const AAD_PW = "vyre:master:password:v1";
const AAD_RE = "vyre:master:recovery:v1";
const AAD_ID = "vyre:master:identity:v1";
const AAD_VAULT = "vyre:master:vault:v1";
const AAD_BOX = "vyre:master:box:v1";

const refuse = (message, code) => Object.assign(new Error(message), { code });

/** @param {string} root */
export const masterPath = root => path.join(root, "identity", "master.json");
/** @param {string} root */
export const identityPath = root => path.join(root, "spaces", "identity.json");

/** What a person types, without spaces or dashes. @param {unknown} code */
export const normalizeRecovery = code => String(code ?? "").toLowerCase().replace(/[\s-]/g, "");

/** @param {unknown} password */
export function checkPassword(password) {
  const pw = String(password ?? "").normalize("NFKC");
  if (pw.length < PASSWORD_MIN) throw refuse("Choose a master password of at least 12 characters. A phrase of four words works well.", "weak_password");
  if (pw.length > 256) throw refuse("That master password is too long. Choose one of 256 characters or fewer.", "weak_password");
  return pw;
}

/** @param {unknown} code */
export function checkRecovery(code) {
  const n = normalizeRecovery(code);
  if (!/^[a-z2-7]{26}$/.test(n)) throw refuse("That recovery key does not look right. Check it and enter it again on this device.", "bad_recovery");
  return n;
}

/** @param {string} root */
export function readMaster(root) {
  return readJson(masterPath(root));
}

/** @param {{ memoryKiB: number, passes: number, lanes?: number, tagLength?: number, pure?: boolean }} kdf @param {Buffer} salt @param {string} password */
function passwordKek(kdf, salt, password) {
  return argon2id(password, salt, { lanes: 1, tagLength: 32, ...kdf });
}

/** @param {string} recovery normalized */
function recoveryKek(recovery) {
  return hkdf32(recovery, "vyre-master-recovery", "vyre:master:recovery-ikm:v1");
}

/**
 * @param {Buffer} rk
 * @param {{ privateKeyB64: string, agreePrivateB64?: string|null, vaultKey?: Buffer|null }} keys
 * @param {{ pub: string, priv: string }} box
 */
function wrapsOf(rk, keys, box) {
  const identityWrap = aesWrap(rk, Buffer.from(JSON.stringify({ privateKey: keys.privateKeyB64, agreePrivate: keys.agreePrivateB64 || null })), AAD_ID);
  const vaultWrap = keys.vaultKey ? aesWrap(rk, keys.vaultKey, AAD_VAULT) : null;
  const boxWrap = aesWrap(rk, Buffer.from(box.priv, "base64url"), AAD_BOX);
  return { identityWrap, vaultWrap, boxWrap };
}

/**
 * @param {{ root: string, username: string, id: string, password: string, recoveryCode: string, privateKeyB64: string, agreePrivateB64?: string|null, vaultKey?: Buffer|null, kdf?: { memoryKiB: number, passes: number, lanes?: number, tagLength?: number, pure?: boolean }, migratedFrom?: string|null, identityFile?: string }} o
 */
export function createMaster(o) {
  const file = masterPath(o.root);
  if (fs.existsSync(file)) throw refuse("A master password is already set on this device.", "exists");
  const username = checkUsername(o.username);
  const password = checkPassword(o.password);
  const recovery = checkRecovery(o.recoveryCode);
  const kdf = { lanes: 1, tagLength: 32, ...(o.kdf || MASTER_KDF) };
  if (kdf.lanes !== 1) throw refuse("The master password uses one Argon2id lane.", "bad_input");
  const salt = crypto.randomBytes(16);
  const kek = passwordKek(kdf, salt, password);
  const rk = crypto.randomBytes(32);
  const box = x25519Pair();
  const rec = {
    v: 1,
    username,
    id: o.id,
    discoverable: false,
    kdf: { memoryKiB: kdf.memoryKiB, passes: kdf.passes, lanes: 1, tagLength: 32, salt: salt.toString("base64url") },
    passwordWrap: aesWrap(kek, rk, AAD_PW),
    recoveryWrap: aesWrap(recoveryKek(recovery), rk, AAD_RE),
    ...wrapsOf(rk, o, box),
    box: { pub: box.pub },
    github: null,
    migratedFrom: o.migratedFrom || null,
    createdAt: Date.now(),
  };
  writePrivate(file, JSON.stringify(rec) + "\n");
  kek.fill(0);
  if (o.identityFile) {
    holdIdentity(o.identityFile, { privateKeyB64: o.privateKeyB64, agreePrivateB64: o.agreePrivateB64 || null });
    stripIdentityFile(o.identityFile);
  }
  if (o.vaultKey) holdPersonal(o.vaultKey);
  rk.fill(0);
  return { username, id: o.id, url: personUrl(username) };
}

/** @param {string} file */
function stripIdentityFile(file) {
  const r = readJson(file);
  if (!r) return;
  delete r.privateKey;
  delete r.agreePrivate;
  r.sealed = true;
  writePrivate(file, JSON.stringify(r) + "\n");
}

/** @param {any} rec @param {Buffer} rk @param {string} [identityFile] */
function holdFrom(rec, rk, identityFile) {
  const id = JSON.parse(aesUnwrap(rk, rec.identityWrap, AAD_ID).toString("utf8"));
  if (identityFile) holdIdentity(identityFile, { privateKeyB64: id.privateKey, agreePrivateB64: id.agreePrivate || null });
  if (rec.vaultWrap) holdPersonal(aesUnwrap(rk, rec.vaultWrap, AAD_VAULT));
  else clearPersonal();
  return id;
}

/**
 * @param {{ root: string, password?: string, recoveryCode?: string, identityFile?: string }} o
 */
export function unlockMaster(o) {
  const rec = readMaster(o.root);
  if (!rec) throw refuse("There is no master password on this device yet. Create your username first.", "no_identity");
  const file = o.identityFile || identityPath(o.root);
  let rk;
  if (o.recoveryCode) {
    const recovery = checkRecovery(o.recoveryCode);
    try { rk = aesUnwrap(recoveryKek(recovery), rec.recoveryWrap, AAD_RE); }
    catch { throw refuse("That recovery key does not unlock this identity. Check it and enter it again on this device.", "bad_recovery"); }
  } else {
    const password = checkPassword(o.password);
    const kek = passwordKek(rec.kdf, Buffer.from(rec.kdf.salt, "base64url"), password);
    try { rk = aesUnwrap(kek, rec.passwordWrap, AAD_PW); }
    catch { kek.fill(0); throw refuse("That password does not unlock this identity. Try again, or enter your recovery key on this device.", "bad_password"); }
    kek.fill(0);
  }
  holdFrom(rec, rk, file);
  rk.fill(0);
  return { unlocked: true, username: rec.username, id: rec.id };
}

/** @param {string} [identityFile] @param {string} [root] */
export function lockMaster(identityFile, root) {
  if (identityFile) forgetIdentity(identityFile);
  else if (root) forgetIdentity(identityPath(root));
  clearPersonal();
}

/**
 * @param {string} root
 * @param {string} [identityFile]
 */
export function masterStatus(root, identityFile) {
  const rec = readMaster(root);
  const idFile = identityFile || identityPath(root);
  const legacy = readJson(idFile);
  const needsMigration = Boolean(legacy && legacy.privateKey && !rec);
  if (!rec) {
    return { exists: false, unlocked: false, username: legacy && legacy.name || null, id: legacy && legacy.id || null, url: null, private: true, github: null, needsMigration };
  }
  const unlocked = identityHeld(idFile);
  return {
    exists: true,
    unlocked,
    username: rec.username,
    id: rec.id,
    url: personUrl(rec.username),
    private: rec.discoverable !== true,
    github: rec.github && rec.github.login ? rec.github.login : null,
    needsMigration: false,
  };
}

/** @param {string} root @param {{ login: string, subject: string }} github @param {string} identityFile */
export function linkGithub(root, github, identityFile) {
  const rec = readMaster(root);
  if (!rec) throw refuse("There is no master password on this device yet. Create your username first.", "no_identity");
  if (!identityHeld(identityFile)) throw refuse("This identity is locked. Enter your master password on this device to unlock it.", "locked");
  const login = String(github.login || "").trim();
  const subject = String(github.subject || "").trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login) || subject.length < 2 || subject.length > 80) throw refuse("Give the GitHub login and the account id from the sign-in.", "bad_input");
  rec.github = { login, subject };
  writePrivate(masterPath(root), JSON.stringify(rec) + "\n");
  return { login, linked: true };
}

/** @param {string} root @param {boolean} on @param {string} identityFile */
export function setDiscoverable(root, on, identityFile) {
  const rec = readMaster(root);
  if (!rec) throw refuse("There is no master password on this device yet. Create your username first.", "no_identity");
  if (!identityHeld(identityFile)) throw refuse("This identity is locked. Enter your master password on this device to unlock it.", "locked");
  rec.discoverable = Boolean(on);
  writePrivate(masterPath(root), JSON.stringify(rec) + "\n");
  return { private: !rec.discoverable, username: rec.username };
}

/**
 * Wrap a 0.5.x identity file under a new master password. The vault key file is copied into the wrap and left in place, so lending keeps its key.
 * @param {{ root: string, identityFile: string, password: string, recoveryCode: string, vaultKey?: Buffer|null, kdf?: any }} o
 */
export function migrateLegacy(o) {
  const legacy = readJson(o.identityFile);
  if (!legacy || !legacy.privateKey) throw refuse("This device has no existing identity to wrap.", "no_identity");
  if (!legacy.name || !legacy.id) throw refuse("This identity has no username yet. Finish claiming the name first.", "no_identity");
  const made = createMaster({
    root: o.root, username: legacy.name, id: legacy.id, password: o.password, recoveryCode: o.recoveryCode,
    privateKeyB64: legacy.privateKey, agreePrivateB64: legacy.agreePrivate || null, vaultKey: o.vaultKey || null,
    kdf: o.kdf, migratedFrom: "0.5.x", identityFile: o.identityFile,
  });
  return { ...made, recoveryCode: checkRecovery(o.recoveryCode) };
}

/** Ciphertext a new device may carry. Never the recovery wrap. @param {string} root */
export function signinCarry(root) {
  const rec = readMaster(root);
  if (!rec) throw refuse("There is no master password on this device yet. Create your username first.", "no_identity");
  return { kdf: rec.kdf, passwordWrap: rec.passwordWrap, identityWrap: rec.identityWrap, vaultWrap: rec.vaultWrap, boxPub: rec.box.pub };
}

/** The stored GitHub link, or null. @param {string} root */
export function githubOf(root) {
  const rec = readMaster(root);
  return rec && rec.github ? rec.github : null;
}

/** @param {string} root @param {string} hexFile a vault/key file of hex text. Returns 32 bytes or null. */
export function readVaultKeyFile(hexFile) {
  let text;
  try { text = fs.readFileSync(hexFile, "utf8").trim(); } catch { return null; }
  if (!/^[0-9a-fA-F]{64}$/.test(text)) return null;
  return Buffer.from(text, "hex");
}

/**
 * The device key the master record wraps. An existing vault/key is that key.
 * A home with no key file and no agent vault yet receives one here, so the master password is the root and the file is its server copy.
 * A home that already has an agent vault and has lost the key file returns null: a new random key would not open it.
 * @param {string} root
 * @returns {Buffer|null}
 */
export function serverVaultKey(root) {
  const file = path.join(root, "vault", "key");
  const existing = readVaultKeyFile(file);
  if (existing) return existing;
  if (fs.existsSync(path.join(root, "vault", "vaults", "agents.json"))) return null;
  const mk = crypto.randomBytes(32);
  writePrivate(file, mk.toString("hex") + "\n");
  return mk;
}
