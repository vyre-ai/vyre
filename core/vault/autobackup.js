// @ts-check
// autobackup: the Vault backs itself up every day, sealed so that only its owner can open it, and can prove the backups work (G20).
//
// How it stays unattended AND safe: enrolling takes the owner's recovery code ONCE. A random backup key (BK) is made; BK is kept in the vault as an item (sealed under the vault's own master key, so the
// daily run can use it), and BK is wrapped to the recovery code (lib/code-wrap.js) and written INTO every backup file. So a backup opens with the code alone, even on a computer that has lost the vault's master
// key (that is the case a backup is for), and nobody who only has the file can read it. The backup itself is the vault's passphrase backup (backup.js) with BK's text as its passphrase.
//
// Files: <home>/backups/vault/vault-<UTC stamp>.vyvb (mode 0600), the newest `keep` (default 14) kept. State: <home>/backups/vault/state.json: when the last one was made, and the last restore drill.
// The drill restores the newest backup into a scratch vault (its own folder and key, removed after), then compares every item's name and a hash of its fields with the live vault.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open as openDb, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { backup, restore, inspect } from "./backup.js";
import { canonical } from "./crypto.js";
import { wrapWithCode, unwrapWithCode, codeLooksRight } from "../../lib/code-wrap.js";

export const KEEP_DEFAULT = 14;
export const DAY_MS = 24 * 3_600_000;
const KEY_ITEM = "vyre-backup-key";
const AAD = "vyre:vault-autobackup:v1";
const err = (/** @type {string} */ code, message = code) => Object.assign(new Error(message), { code });
const b64 = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64");
const stamp = (/** @type {number} */ t) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** Where the backups live: beside the vault's folder, in the home. @param {{ dir: string }} vault */
export const dirOf = vault => path.join(path.dirname(vault.dir), "backups", "vault");
const statePath = (/** @type {{ dir: string }} */ vault) => path.join(dirOf(vault), "state.json");

/** @param {{ dir: string }} vault @returns {{ v: 1, wrapped: any, keep: number, last: null | { at: number, file: string, items: number }, drill: null | { at: number, ok: boolean, file: string, items: number, matched: number, newer: string[], missing: string[], changed: string[], note: string } } | null} */
function readState(vault) { try { return JSON.parse(fs.readFileSync(statePath(vault), "utf8")); } catch { return null; } }
function writeState(vault, state) {
  fs.mkdirSync(dirOf(vault), { recursive: true, mode: 0o700 });
  const tmp = `${statePath(vault)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, statePath(vault));
}

/** The backup passphrase for a key. @param {Uint8Array} bk */
const passphraseOf = bk => `vyre-autobackup-${b64(bk)}`;

/**
 * Turn automatic backups on: the owner's recovery code is asked once.
 * @param {Vault} vault @param {{ code: string, password?: string, keep?: number }} o
 */
export async function enrol(vault, { code, password = "", keep = KEEP_DEFAULT }) {
  if (!codeLooksRight(code)) throw err("bad_code", "that is not a recovery code");
  const bk = crypto.randomBytes(32);
  const wrapped = wrapWithCode(bk, code, AAD, password);
  await vault.put({ name: KEY_ITEM, kind: "secret", description: "Opens the automatic vault backups (also wrapped to your recovery code inside every backup file).", fields: { value: b64(bk) } }, "autobackup");
  writeState(vault, { v: 1, wrapped, keep: Math.max(2, Math.min(60, Math.floor(keep))), last: null, drill: null });
  return { enrolled: true, keep };
}

/** What the Settings line and `vyre vault autobackup status` say. @param {{ dir: string }} vault */
export function status(vault) {
  const s = readState(vault);
  if (!s) return { enrolled: false, last: null, drill: null, keep: KEEP_DEFAULT, files: [] };
  let files = [];
  try { files = fs.readdirSync(dirOf(vault)).filter(f => /^vault-.*\.vyvb$/.test(f)).sort(); } catch { /* none yet */ }
  return { enrolled: true, last: s.last, drill: s.drill, keep: s.keep, files };
}

/** Is a backup due (none yet, or the last is a day old)? @param {{ dir: string }} vault @param {number} [now] */
export const due = (vault, now = Date.now()) => { const s = readState(vault); return Boolean(s) && (!s?.last || now - s.last.at >= DAY_MS); };

/**
 * Make a backup now (and keep only the newest `keep`).
 * @param {Vault} vault @param {{ now?: number, params?: { N: number, r: number, p: number } }} [o]
 */
export async function run(vault, { now = Date.now(), params } = {}) {
  const s = readState(vault);
  if (!s) throw err("not_enrolled", "automatic backups are not turned on");
  const row = vault.row(KEY_ITEM);
  if (!row) throw err("no_key", "the backup key item is missing: turn automatic backups on again");
  const bk = Buffer.from(String((await vault.fields(row)).value), "base64");
  const blob = await backup(vault, passphraseOf(bk), params ? { params } : undefined);
  const info = inspect(blob);
  const file = `vault-${stamp(now)}.vyvb`;
  fs.mkdirSync(dirOf(vault), { recursive: true, mode: 0o700 });
  const target = path.join(dirOf(vault), file);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify({ v: 1, kind: "vault-autobackup", at: info.at, items: info.items, wrapped: s.wrapped, blob }) + "\n", { mode: 0o600 });
  fs.renameSync(`${target}.tmp`, target);
  const all = fs.readdirSync(dirOf(vault)).filter(f => /^vault-.*\.vyvb$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - s.keep))) fs.rmSync(path.join(dirOf(vault), old), { force: true });
  writeState(vault, { ...s, last: { at: now, file, items: info.items } });
  vault.audit("backup", null, "autobackup", true, `${info.items} items to ${file}`);
  return { file, items: info.items, at: now };
}

/** The daily tick: a backup when one is due. @param {Vault} vault @param {{ now?: number }} [o] */
export async function tick(vault, o = {}) { return due(vault, o.now) ? run(vault, o) : null; }

/** Open a backup file with the owner's recovery code: the blob and its passphrase. @param {string} text @param {string} code @param {string} [password] */
export function unseal(text, code, password = "") {
  let f;
  try { f = JSON.parse(text); } catch { throw err("not_a_backup", "that is not a Vyre automatic backup"); }
  if (!f || f.kind !== "vault-autobackup" || !f.wrapped || typeof f.blob !== "string") throw err("not_a_backup", "that is not a Vyre automatic backup");
  let bk;
  try { bk = unwrapWithCode(f.wrapped, code, AAD, password); } catch { throw err("bad_code", "that recovery code does not open this backup"); }
  return { blob: f.blob, passphrase: passphraseOf(bk), at: f.at, items: f.items };
}

/** A hash of what an item holds, for comparing two vaults without reading either aloud. @param {Vault} v @param {any} row */
async function hashOf(v, row) { return crypto.createHash("sha256").update(canonical({ kind: row.kind, fields: await v.fields(row, { sealed: true }) })).digest("hex"); }

/**
 * The restore drill: restore the newest backup (or `file`) into a scratch vault with a key of its own and compare it with the live vault. Items made or changed after the backup are "newer", not
 * failures; an item in the backup that is gone from the live vault or whose hash differs without a newer change is a failure. The result is kept for the Settings line.
 * @param {Vault} vault @param {{ code: string, password?: string, file?: string, params?: { N: number, r: number, p: number } }} o
 */
export async function drill(vault, { code, password = "", file, params }) {
  const s = readState(vault);
  if (!s) throw err("not_enrolled", "automatic backups are not turned on");
  const name = file || (s.last && s.last.file);
  if (!name) throw err("no_backup", "there is no backup to try yet: make one first");
  const full = path.isAbsolute(name) ? name : path.join(dirOf(vault), name);
  const opened = unseal(fs.readFileSync(full, "utf8"), code, password);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-drill-"));
  const db = openDb(path.join(home, "vyre.db"));
  try {
    migrate(db, "vault", MIGRATIONS);
    const scratch = new Vault({ db, dir: path.join(home, "vault"), config: { name: "drill", vault: { keystore: "file" } }, emit: () => {} });
    await restore(scratch, opened.blob, opened.passphrase, { mode: "replace", who: "drill" });
    /** @type {string[]} */ const missing = [], changed = [], newer = [];
    let matched = 0;
    const theirs = new Map(/** @type {any[]} */ (scratch.db.prepare("SELECT * FROM vault_items").all()).map(r => [r.name, r]));
    for (const [n, r] of theirs) {
      const live = vault.row(n);
      if (!live) { missing.push(n); continue; }
      if (Number(live.updated) > opened.at) { newer.push(n); continue; }
      if ((await hashOf(vault, live)) === (await hashOf(scratch, r))) matched++; else changed.push(n);
    }
    for (const live of /** @type {any[]} */ (vault.db.prepare("SELECT * FROM vault_items").all())) if (!theirs.has(live.name) && Number(live.created) <= opened.at) missing.push(`${live.name} (not in the backup)`);
    const ok = missing.length === 0 && changed.length === 0 && theirs.size === opened.items;
    const result = { at: Date.now(), ok, file: path.basename(full), items: theirs.size, matched, newer, missing, changed, note: ok ? `${matched} of ${theirs.size} items match the live vault${newer.length ? `, ${newer.length} changed since` : ""}` : `${missing.length} missing, ${changed.length} different` };
    writeState(vault, { ...s, drill: result });
    vault.audit("restore", null, "drill", ok, result.note);
    return result;
  } finally { try { db.close(); } catch { /* closed */ } fs.rmSync(home, { recursive: true, force: true }); }
}
