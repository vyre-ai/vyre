// @ts-check
// store — sealed item files on disk, one per item, in vault/items/.
//
// This file knows paths and permissions, not cryptography: it takes what crypto.sealItem made
// and puts it somewhere only this user can read. Two rules:
//   - Writes go to a temporary file in the same folder and are renamed into place, so a crash
//     leaves either the old item or the new one, never half of one.
//   - An id is checked against a narrow pattern before it becomes part of a path, so no id can
//     reach outside items/.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The path of one item's sealed file. Throws on an id that is not safe as a file name. */
function itemPath(dir, id) {
  if (typeof id !== "string" || !ID.test(id)) throw new Error(`not a valid vault item id: ${JSON.stringify(id)}`);
  return path.join(dir, "items", id + ".json");
}

/** Make the vault folder and its items folder, private to this user, tightening them if needed. */
export function ensureDir(dir) {
  for (const d of [dir, path.join(dir, "items")]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    if ((fs.statSync(d).mode & 0o777) !== 0o700) fs.chmodSync(d, 0o700);
  }
}

/** Write one sealed item, atomically, mode 0600. */
export function writeSealed(dir, id, sealed) {
  const file = itemPath(dir, id);
  ensureDir(dir);
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(sealed)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Read one sealed item, or null if there is none. */
export function readSealed(dir, id) {
  const file = itemPath(dir, id);
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return null; throw e; }
  return JSON.parse(raw);
}

/** Remove one sealed item. Removing one that is not there is not an error. */
export function removeSealed(dir, id) {
  fs.rmSync(itemPath(dir, id), { force: true });
}

/** Staged copies end in this, so a crash between writing a file and its row can be sorted out. */
export const STAGED = "__next";

/** Move a staged sealed file over its item, atomically. */
export function promoteSealed(dir, id) {
  fs.renameSync(itemPath(dir, id + STAGED), itemPath(dir, id));
}

/** Ids with a staged copy waiting. */
export function stagedIds(dir) {
  let names = [];
  try { names = fs.readdirSync(path.join(dir, "items")); } catch { return []; }
  return names.filter(n => n.endsWith(STAGED + ".json")).map(n => n.slice(0, -(STAGED.length + 5))).filter(id => ID.test(id));
}

/** Write a small JSON file in the vault folder atomically, 0600. */
export function writeJsonFile(dir, rel, value) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/** Read one, or null if it is not there. */
export function readJsonFile(dir, rel) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8")); }
  catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return null; throw e; }
}
