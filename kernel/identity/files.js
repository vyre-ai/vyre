// @ts-check
// A private file write for the master record and the space vault. This is not a vault keystore: the vault's key file stays where ADR 0001 put it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Folder 0700, file 0600, replaced by rename. @param {string} file @param {string|Buffer} data */
export function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* win32 */ }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* win32 */ }
  fs.renameSync(tmp, file);
}

/** @param {string} file @returns {any} */
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** @param {string} dir */
export function rmQuiet(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}
