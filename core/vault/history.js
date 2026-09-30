// @ts-check
// history: the last sealed versions of each item, and what changed between them.
//
// A put seals a new version; the one it replaces moves to vault/history/<id>/<ver>.json, still
// wrapped under its own item key and vault key, so reading an old version needs the same key
// the item needed then. vault_history keeps one row per version: when, who, and which field
// names changed. "Changed" compares per-field HMACs under the metadata key, never plain hashes,
// so a copy of vyre.db cannot confirm a guessed value. Rows are MACed like every other row.
// Only the last KEEP older versions are kept; older files and rows are pruned.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const KEEP = 10;

export const HISTORY_MIGRATION = `CREATE TABLE vault_history (
     id TEXT PRIMARY KEY, item TEXT NOT NULL, ver INTEGER NOT NULL, name TEXT NOT NULL, vault TEXT NOT NULL,
     at INTEGER NOT NULL, by TEXT NOT NULL, changed TEXT NOT NULL DEFAULT '[]', fh TEXT NOT NULL DEFAULT '{}', mac TEXT
   );
   CREATE INDEX vault_history_item ON vault_history (item, ver);`;

const VER = /^[0-9]{1,9}$/;

/** Per-field HMACs of one version's values, under the metadata key. */
export function fieldHashes(mkey, id, fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = crypto.createHmac("sha256", mkey).update(`vyre field v1:${id}:${k}:`).update(String(v)).digest("base64");
  return out;
}

/** Field names that differ between two versions' hashes (added, removed or changed). */
export function changedFields(prev, next) {
  if (!prev) return Object.keys(next).sort();
  const names = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...names].filter(k => prev[k] !== next[k]).sort();
}

/** Where an old version's sealed file lives. */
export function historyPath(dir, id, ver) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id)) || !VER.test(String(ver))) throw new Error("not a valid history entry");
  return path.join(dir, "history", String(id), `${ver}.json`);
}

/** Keep an old sealed version, atomically, 0600 in 0700 folders. */
export function keepVersion(dir, id, ver, sealed) {
  const file = historyPath(dir, id, ver);
  for (const d of [path.join(dir, "history"), path.dirname(file)]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700); }
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(sealed)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/** An old version's sealed file, or null. */
export function readVersion(dir, id, ver) {
  try { return JSON.parse(fs.readFileSync(historyPath(dir, id, ver), "utf8")); }
  catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return null; throw e; }
}

/** Remove an item's whole history folder. */
export function dropHistory(dir, id) {
  fs.rmSync(path.join(dir, "history", String(id)), { recursive: true, force: true });
}

/** Remove one old version's file. */
export function dropVersion(dir, id, ver) {
  fs.rmSync(historyPath(dir, id, ver), { force: true });
}
