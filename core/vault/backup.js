// @ts-check
// backup — one sealed string that holds a whole vault, and the way back from it.
//
// Why this exists: the master key lives in the keychain, a key file or a passphrase, and losing
// that key loses every item (docs/adr/0001-vault-crypto.md, Consequences). A backup is the way
// back. Two rules shape it:
//   - It is useless without its own passphrase. The key comes from scrypt of that passphrase
//     with a salt of its own, never from the vault's master key, so it still opens after the
//     keychain item is gone, and it can be kept in any cloud drive: a copy of it is ciphertext.
//   - Restoring re-seals every item under the master key of the vault it lands in, through the
//     same put() every other item goes through. Nothing sealed under the old key is copied over.
//
// The only thing outside the ciphertext is when the backup was made and how many items it holds,
// so a CLI can say "backup from <date>, 42 items" before it asks for the passphrase.

import crypto from "node:crypto";
import { canonical, sealItem } from "./crypto.js";
import { readSealed, writeSealed } from "./store.js";

const PREFIX = "vyre-backup:v1:";
const AAD = "vyre:backup:v1";
const IDENTITY = "identity";
/** The same cost as the passphrase keystore: N=2^17, r=8, p=1, 128 MB. */
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
const MIN_PASSPHRASE = 12;

const b64 = buf => Buffer.from(buf).toString("base64");
const unb64 = s => Buffer.from(String(s), "base64");
const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };

/** scrypt with room for its memory; a cost outside sane bounds is refused before it runs. */
function derive(passphrase, salt, { N, r, p }) {
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || (N & (N - 1)) !== 0) throw new Error("this backup names a scrypt cost that is not allowed");
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) throw new Error("this backup names a scrypt cost that is not allowed");
  return crypto.scryptSync(String(passphrase).normalize("NFKC"), salt, 32, { N, r, p, maxmem: 256 * N * r + 64 * 1024 * 1024 });
}

function checkPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.normalize("NFKC").length < MIN_PASSPHRASE) {
    throw new Error(`a backup passphrase needs at least ${MIN_PASSPHRASE} characters`);
  }
}

/** The outer JSON of a backup string. Throws if it is not one. */
function outer(blob) {
  const s = String(blob || "").trim();
  if (!s.startsWith(PREFIX)) throw new Error("not a vyre backup");
  let o;
  try { o = JSON.parse(Buffer.from(s.slice(PREFIX.length), "base64url").toString("utf8")); } catch { throw new Error("not a vyre backup"); }
  if (!o || o.v !== 1 || o.kdf !== "scrypt" || !o.salt || !o.iv || !o.tag || !o.ct) throw new Error("not a vyre backup");
  return o;
}

/**
 * Seal the whole vault under a passphrase.
 * @param {import("./vault.js").Vault} vault
 * @param {string} passphrase at least 12 characters
 * @param {{ params?: { N: number, r: number, p: number } }} [opts] params is for tests only, to
 *   make scrypt cheap; leave it out and the cost is N=2^17, r=8, p=1.
 * @returns {Promise<string>} "vyre-backup:v1:" + base64url JSON
 */
export async function backup(vault, passphrase, { params = SCRYPT } = {}) {
  checkPassphrase(passphrase);
  const db = vault.db;
  const items = [];
  for (const r of /** @type {any[]} */ (db.prepare("SELECT * FROM vault_items ORDER BY name").all())) {
    items.push({
      name: r.name, kind: r.kind, description: r.description, fields: await vault.fields(r), order: json(r.fields, []),
      url: r.url ?? null, hosts: json(r.hosts, []), origin: r.origin ?? null, rotate: r.rotate ?? null,
      created: r.created, updated: r.updated,
    });
  }
  const at = Date.now();
  const payload = {
    from: vault.name, at, items,
    grants: db.prepare("SELECT * FROM vault_grants WHERE status = 'active' ORDER BY id").all().map(r => ({ ...r })),
    people: db.prepare("SELECT * FROM vault_people ORDER BY name").all().map(r => ({ ...r })),
    passes: db.prepare("SELECT * FROM vault_passes ORDER BY id").all().map(r => ({ ...r })),
    held: db.prepare("SELECT * FROM vault_held ORDER BY id").all().map(r => ({ ...r })),
    identity: await vault.identity(),
  };
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", derive(passphrase, salt, params), iv);
  c.setAAD(Buffer.from(AAD));
  const ct = Buffer.concat([c.update(Buffer.from(canonical(payload))), c.final()]);
  const o = { v: 1, kdf: "scrypt", N: params.N, r: params.r, p: params.p, salt: b64(salt), iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct), at, items: items.length };
  return PREFIX + Buffer.from(JSON.stringify(o)).toString("base64url");
}

/**
 * What a backup says about itself, without the passphrase. The count is not a secret; it is
 * checked against the sealed contents on restore, so a changed count is caught there.
 * @param {string} blob
 * @returns {{ v: number, at: number, items: number }}
 */
export function inspect(blob) {
  const o = outer(blob);
  return { v: o.v, at: o.at, items: o.items };
}

/**
 * Put a backup's contents into this vault, sealed under this vault's master key.
 * @param {import("./vault.js").Vault} vault
 * @param {string} blob
 * @param {string} passphrase
 * @param {{ mode?: "merge" | "replace", who?: string }} [opts] merge keeps items already here;
 *   replace needs a vault with no items and also takes the backup's device identity.
 */
export async function restore(vault, blob, passphrase, { mode = "merge", who = "cli" } = {}) {
  if (!["merge", "replace"].includes(mode)) throw new Error("mode is merge or replace");
  const o = outer(blob);
  let payload;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", derive(passphrase, unb64(o.salt), o), unb64(o.iv));
    d.setAAD(Buffer.from(AAD));
    d.setAuthTag(unb64(o.tag));
    payload = JSON.parse(Buffer.concat([d.update(unb64(o.ct)), d.final()]).toString("utf8"));
  } catch { throw new Error("that passphrase does not open this backup"); }
  if (!payload || !Array.isArray(payload.items) || payload.items.length !== o.items || payload.at !== o.at) {
    throw new Error("this backup was altered: its label does not match its contents");
  }

  const db = vault.db;
  if (mode === "replace" && db.prepare("SELECT 1 FROM vault_items LIMIT 1").get()) {
    throw new Error("replace needs an empty vault; this one has items · restore with merge instead");
  }
  const mk = await vault.key();

  const added = [], kept = [];
  for (const it of payload.items) {
    if (vault.row(it.name)) { kept.push(it.name); continue; }
    await vault.put({ name: it.name, kind: it.kind, description: it.description, fields: it.fields,
      url: it.url || undefined, hosts: it.hosts, origin: it.origin || undefined }, "restore");
    // Canonical JSON sorts keys, so the listed field order is carried separately and put back.
    const names = json(vault.row(it.name).fields, []);
    const order = Array.isArray(it.order) && it.order.length === names.length && it.order.every(k => names.includes(k)) ? it.order : names;
    db.prepare("UPDATE vault_items SET fields=?, rotate=?, created=?, updated=? WHERE name=?").run(JSON.stringify(order), it.rotate ?? null, it.created, it.updated, it.name);
    added.push(it.name);
  }

  const insert = (table, cols, rows) => {
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})`);
    let n = 0;
    for (const r of rows || []) n += Number(stmt.run(...cols.map(c => r[c] ?? null)).changes);
    return n;
  };
  const grants = insert("vault_grants", ["id", "item", "module", "watcher", "status", "by", "at"],
    (payload.grants || []).map(g => ({ ...g, watcher: g.watcher ?? "" })));
  const people = insert("vault_people", ["name", "sign", "box", "relay", "added"], payload.people);
  const passes = insert("vault_passes", ["id", "holder", "holder_sign", "holder_box", "items", "mode", "hosts", "expires", "note", "status", "by", "created", "issued", "revoked"],
    (payload.passes || []).map(p => ({ ...p, note: p.note ?? "" })));
  const held = insert("vault_held", ["id", "owner", "relay", "owner_sign", "items", "mode", "expires", "accepted"], payload.held);

  // The identity is what the owner's passes were issued against and what holders sign with, so
  // taking it back keeps them valid. It never overwrites one this vault already has, except on
  // replace, where the vault is being made into the one that was backed up.
  let identity = "kept";
  if (payload.identity && (mode === "replace" || !readSealed(vault.dir, IDENTITY))) {
    writeSealed(vault.dir, IDENTITY, sealItem(mk, IDENTITY, IDENTITY, payload.identity));
    identity = "restored";
  }

  const summary = `${mode}: ${added.length} added, ${kept.length} kept, ${grants} grants, ${people} people, ${passes} passes, ${held} held, identity ${identity}`;
  vault.audit("restore", null, who, true, summary);
  vault.emit("vault.restored", { mode, added: added.length, kept: kept.length, grants, passes, identity });
  return { added, kept, grants, passes, identity };
}
