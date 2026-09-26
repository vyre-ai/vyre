// @ts-check
// certs — where certificates and ACME account keys live on disk.
//
// ~/.vyre/certs/<name>.crt and <name>.key, plus one account key per ACME directory. Keys are
// 0600, and every write goes to a temp file and is renamed into place, so a crash mid-renewal
// never leaves the listener a half-written key.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expiry, newKey } from "./acme.js";

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function file(dir, name, ext) {
  if (!NAME.test(String(name)) || String(name).includes("..")) throw new Error(`"${name}" is not a certificate name`);
  return path.join(dir, `${name}.${ext}`);
}

/** Write atomically at 0600: temp file in the same folder, fsync, rename. */
function writeSecret(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, target); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
  fs.chmodSync(target, 0o600);
}

/**
 * The stored certificate and key for a name, or null if either is missing.
 * @returns {{ cert: string, key: string, expires: number } | null}
 */
export function load(dir, name) {
  let cert, key;
  try {
    cert = fs.readFileSync(file(dir, name, "crt"), "utf8");
    key = fs.readFileSync(file(dir, name, "key"), "utf8");
  } catch (err) {
    if (/** @type {any} */ (err).code === "ENOENT") return null;
    throw err;
  }
  return { cert, key, expires: expiry(cert) };
}

/** Store a certificate chain and its key, each replaced in one rename. */
export function save(dir, name, { cert, key }) {
  expiry(cert); // refuse to store something that is not a certificate
  writeSecret(file(dir, name, "key"), key);
  writeSecret(file(dir, name, "crt"), cert);
}

/**
 * The ACME account key for one directory, created on first use.
 * @param {string} dir
 * @param {"production"|"staging"} which
 */
export function accountKey(dir, which) {
  if (which !== "production" && which !== "staging") throw new Error(`unknown ACME directory "${which}"`);
  const p = path.join(dir, `acme-${which}.key`);
  try { return fs.readFileSync(p, "utf8"); } catch (err) { if (/** @type {any} */ (err).code !== "ENOENT") throw err; }
  writeSecret(p, newKey());
  return fs.readFileSync(p, "utf8");
}
