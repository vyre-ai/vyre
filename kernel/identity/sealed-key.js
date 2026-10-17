// @ts-check
// A key-encryption key for material this box holds at rest.
// On macOS it is a login-keychain item (service vyre-seal). The secret is written on stdin, never on argv, the same rule as the vault keystore.
// Elsewhere, and when the keychain cannot take it, it is a 0600 file. Callers pass a path outside any directory a member copies.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SERVICE = "vyre-seal";
const q = (/** @type {string} */ s) => '"' + String(s).replace(/(["\\])/g, "\\$1") + '"';

/** argv never carries the key. @param {string} account @param {string} hex */
export function keychainWriteCommand(account, hex) {
  const words = ["add-generic-password", "-U", "-s", q(SERVICE), "-a", q(account), "-w", q(hex)];
  return { argv: ["-i"], stdin: words.join(" ") + "\n" };
}

/** @param {string} file */
function accountFor(file) {
  return crypto.createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 16);
}

/** @param {string} account */
function keychainRead(account) {
  const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { encoding: "utf8" });
  if (!r || r.status !== 0) return null;
  const hex = String(r.stdout || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/** @param {string} account @param {Buffer} kek */
function keychainWrite(account, kek) {
  const cmd = keychainWriteCommand(account, kek.toString("hex"));
  const r = spawnSync("security", cmd.argv, { encoding: "utf8", input: cmd.stdin });
  return Boolean(r && r.status === 0 && String(r.stderr || "").trim() === "");
}

/** @param {string} file @param {string} text */
function write0600(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* win32 */ }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* win32 */ }
  fs.renameSync(tmp, file);
}

/** @param {string} file */
function modeOk(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (process.platform !== "win32" && (st.mode & 0o077)) return false;
    return true;
  } catch { return false; }
}

/** @param {string} file @returns {Buffer|null} */
function readFileKek(file) {
  if (!modeOk(file)) return null;
  let text = "";
  try { text = fs.readFileSync(file, "utf8").trim(); } catch { return null; }
  if (!/^[0-9a-fA-F]{64}$/.test(text)) return null;
  return Buffer.from(text, "hex");
}

/** @param {string} file */
function useKeychain() {
  return process.platform === "darwin" && process.env.VYRE_SEAL_FILE !== "1";
}

/**
 * The existing key, or null when this device has none.
 * @param {string} file
 * @returns {Buffer|null}
 */
export function readKek(file) {
  if (useKeychain()) {
    const fromChain = keychainRead(accountFor(file));
    if (fromChain) return fromChain;
  }
  return readFileKek(file);
}

/**
 * The existing key, or a new one stored for this path.
 * @param {string} file
 */
export function ensureKek(file) {
  const existing = readKek(file);
  if (existing) return existing;
  const kek = crypto.randomBytes(32);
  if (useKeychain() && keychainWrite(accountFor(file), kek)) return kek;
  write0600(file, kek.toString("hex") + "\n");
  return kek;
}
