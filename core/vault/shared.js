// @ts-check
// shared: vaults a team shares (ADR 0006, decision 5).
//
// A shared vault is a vault class of its own, `shared:<id>`, with a random vault key (VK). Each
// member gets the VK sealed to their card's box key. Who is a member, with which role, is a
// membership manifest: a hash chain of versions, the first signed by the owner and each later one
// by someone who was an admin in the version before. Every load verifies the whole chain.
//
// The owner's vyred is the vault's home. It keeps the canonical log of item records and answers
// POST /v1/sync on the relay listener: pull what changed since a revision, push a new record
// naming its parent revision (409 when the parent is stale), and admin changes (a new manifest,
// the VK wraps that go with it, re-wrapped records after a rotation). Requests are signed sync
// envelopes: audience, timestamp, nonce, from a key in the current manifest.
//
// Records carry the item exactly as a local item is sealed (sealItemV2 under the vault's VK),
// plus the metadata a listing needs. The author signs each record; the home signs a receipt with
// its revision and the manifest version in force when it took it. A peer ignores a record whose
// receipt is not the owner's, or whose author could not write in that manifest version.
//
// Each member keeps a replica and materialises the current records as ordinary rows in
// vault_items, named `<vault>/<item>`, with the vault class `shared:<id>`. That is what makes run,
// inject, grants and the Deck work on shared items without knowing about sharing: vault.open asks
// this file for the key.
//
// Removing a member mints a new VK at kv + 1, wraps it for everyone left, re-wraps each item's
// key (not the body) and flags every item for rotation: the person who left could read them all.
//
// Not here yet: deleting a shared item, and multi-device join (ADR 0006: next wave).

import { launcherItem } from "./vault.js";
import crypto from "node:crypto";
import { canonical, sign, verify, sealFor, openFrom, keyObject, newVaultKey, sealItemV2, openItemV2, rewrapItemKey } from "./crypto.js";
import { writeSealed, removeSealed } from "./store.js";
import { fingerprint } from "./share.js";
import * as relay from "./relay.js";
import { newId as newUuid } from "../../lib/id.js";

export const SHARED_MIGRATIONS = [
  `CREATE TABLE vault_shared (
     id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, home TEXT NOT NULL, owner_sign TEXT NOT NULL,
     kv INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, since INTEGER NOT NULL DEFAULT 0,
     role TEXT NOT NULL DEFAULT '', joined INTEGER NOT NULL
   );
   CREATE TABLE vault_shared_manifests (vault TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (vault, seq));
   CREATE TABLE vault_shared_wraps (vault TEXT NOT NULL, kv INTEGER NOT NULL, fp TEXT NOT NULL, wrap TEXT NOT NULL, PRIMARY KEY (vault, kv, fp));
   CREATE TABLE vault_shared_records (
     vault TEXT NOT NULL, rev INTEGER NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, receipt TEXT NOT NULL,
     PRIMARY KEY (vault, rev)
   );
   CREATE INDEX vault_shared_records_id ON vault_shared_records (vault, id, rev);
   CREATE TABLE vault_shared_conflicts (
     id INTEGER PRIMARY KEY, vault TEXT NOT NULL, item TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL
   );`,
];

/**
 * The words a signed manifest carries for a member. Peers on other computers verify them, so they cannot change; each is one access level of the one grant model (kernel/seal/uses.js ACCESS_LEVELS),
 * written once here. A person who is a member of a shared vault holds its key and so can read what is in it whatever the level says: "use without seeing" holds for this Space's agents, teams'
 * assistants and projects (kernel grants) and for outsiders through passes, not for people in a shared vault (team/0.3/DESIGN-vaults-named.md).
 */
export const ROLE_LEVEL = Object.freeze({ owner: "manage", admin: "manage", member: "reveal", "read-only": "use" });
export const VAULT_MEMBER_ROLES = Object.keys(ROLE_LEVEL);
/** The role a level is written as in a manifest (the owner is the one `owner`). @param {string} level @param {boolean} [owner] */
export const roleOfLevel = (level, owner = false) => (owner ? "owner" : /** @type {any} */ ({ manage: "admin", reveal: "member", use: "read-only" })[level]);
const WRITE = new Set(VAULT_MEMBER_ROLES.filter(r => /** @type {any} */ (ROLE_LEVEL)[r] !== "use"));
const ADMIN = new Set(VAULT_MEMBER_ROLES.filter(r => /** @type {any} */ (ROLE_LEVEL)[r] === "manage"));
const MANIFEST_TAG = "vyre-manifest-v1", RECORD_TAG = "vyre-record-v1", RECEIPT_TAG = "vyre-receipt-v1", INVITE_TAG = "vyre-invite-v1";
const INVITE_PREFIX = "vyre-invite:v1:";
const VAULT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ITEM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const now = () => Date.now();
const newId = () => newUuid();
const hash = v => crypto.createHash("sha256").update(canonical(v)).digest("base64url");
const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };
export const classOf = id => `shared:${id}`;
const idOf = cls => String(cls).slice("shared:".length);
const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };
const fpOf = m => fingerprint({ sign: m.sign, box: m.box });
const vkAad = (cls, kv, fp) => `vyre:vk:v2:${cls}:${kv}:${fp}`;
const err = (message, code) => Object.assign(new Error(message), code ? { code } : {});

// ---- the manifest ------------------------------------------------------------------------------

/** Sign a manifest version. @param {any} body @param {string} privDer */
export const signManifest = (body, privDer) => ({ ...body, sig: sign(privDer, { tag: MANIFEST_TAG, ...body }) });

function checkMembers(m) {
  if (!Array.isArray(m.members) || !m.members.length) throw new Error("a manifest needs members");
  const signs = new Set();
  for (const x of m.members) {
    if (!x || typeof x.name !== "string" || typeof x.sign !== "string" || typeof x.box !== "string" || !VAULT_MEMBER_ROLES.includes(x.role)) throw new Error("a manifest member is malformed");
    if (signs.has(x.sign)) throw new Error("a manifest lists one key twice");
    signs.add(x.sign);
  }
  const owners = m.members.filter(x => x.role === "owner");
  if (owners.length !== 1) throw new Error("a manifest has exactly one owner");
  return owners[0];
}

/**
 * Verify a whole chain, oldest first. Returns the latest version. Throws on the first break:
 * a bad signature, a missing link, a signer who was not an admin in the version before, a
 * changed owner, a member removed without a new key, or a key version that went backwards.
 * @param {any[]} chain
 */
export function verifyChain(chain) {
  if (!Array.isArray(chain) || !chain.length) throw new Error("no manifest");
  let prev = null, owner = null;
  for (const m of chain) {
    if (!m || m.v !== 1 || typeof m.vault !== "string" || !Number.isInteger(m.seq) || !Number.isInteger(m.kv) || m.kv < 1 || typeof m.by !== "string") throw new Error("a manifest version is malformed");
    const o = checkMembers(m);
    if (!verify(m.by, { tag: MANIFEST_TAG, ...without(m, "sig") }, m.sig)) throw new Error(`manifest version ${m.seq} is not signed by the key it names`);
    if (!prev) {
      if (m.seq !== 1 || m.prev !== "" || m.by !== o.sign) throw new Error("the first manifest version is not the owner's");
      owner = o.sign;
    } else {
      if (m.vault !== prev.vault || m.seq !== prev.seq + 1 || m.prev !== hash(prev)) throw new Error(`manifest version ${m.seq} does not follow the one before`);
      if (!prev.members.some(x => x.sign === m.by && ADMIN.has(x.role))) throw new Error(`manifest version ${m.seq} was signed by someone who was not an admin`);
      if (o.sign !== owner) throw new Error("a manifest version changed the owner");
      const removed = prev.members.some(x => !m.members.some(y => y.sign === x.sign));
      if (m.kv < prev.kv || (removed && m.kv !== prev.kv + 1)) throw new Error(`manifest version ${m.seq} removed a member without a new key`);
    }
    prev = m;
  }
  return /** @type {any} */ (prev);
}

// ---- records and receipts -----------------------------------------------------------------------

export const signRecord = (body, privDer) => ({ ...body, sig: sign(privDer, { tag: RECORD_TAG, ...body }) });
const recordOk = r => r && typeof r.author === "string" && verify(r.author, { tag: RECORD_TAG, ...without(r, "sig") }, r.sig);
export const signReceipt = (body, privDer) => ({ ...body, sig: sign(privDer, { tag: RECEIPT_TAG, ...body }) });
const receiptOk = (rc, ownerSign) => rc && verify(ownerSign, { tag: RECEIPT_TAG, ...without(rc, "sig") }, rc.sig);

// ---- invites ----------------------------------------------------------------------------------

function encodeInvite(body, privDer) {
  return INVITE_PREFIX + Buffer.from(canonical({ ...body, sig: sign(privDer, { tag: INVITE_TAG, ...body }) })).toString("base64url");
}

/** Read an invite; its signature must match the inviter card it carries. */
export function decodeInvite(str) {
  const s = String(str || "").trim();
  if (!s.startsWith(INVITE_PREFIX)) throw new Error(`not a vault invite: it should start with "${INVITE_PREFIX}"`);
  let o;
  try { o = JSON.parse(Buffer.from(s.slice(INVITE_PREFIX.length), "base64url").toString("utf8")); } catch { throw new Error("this invite is damaged"); }
  for (const k of ["vault", "name", "home", "owner", "inviterCard", "sig"]) if (typeof o?.[k] !== "string") throw new Error(`this invite is missing "${k}"`);
  if (!o.member || typeof o.member.sign !== "string") throw new Error("this invite does not name who it is for");
  const card = relay.decodeCard(o.inviterCard);
  if (card.v !== 2 || !verify(card.sign, { tag: INVITE_TAG, ...without(o, "sig") }, o.sig)) throw new Error("this invite's signature does not match its inviter, so it was altered or forged");
  return { ...o, card };
}

export class Shared {
  /** @param {import("./vault.js").Vault} vault */
  constructor(vault) {
    this.vault = vault;
    this.db = vault.db;
    /** @type {Map<string, import("node:crypto").KeyObject>} */
    this.keys = new Map();
    /** How a member reaches a home. Tests swap it for a direct call. */
    this.post = (url, env) => relay.callRelay(url, env, { route: "/v1/sync" });
  }

  // ---- reading local state ---------------------------------------------------------------------

  /** A shared vault by name or id. */
  row(ref) {
    return /** @type {any} */ (this.db.prepare("SELECT * FROM vault_shared WHERE name = ? OR id = ?").get(String(ref), String(ref)));
  }

  mustRow(ref) {
    const v = this.row(ref);
    if (!v) throw new Error(`no shared vault named ${ref}`);
    if (v.role === "removed") throw new Error(`you are no longer a member of ${v.name}`);
    return v;
  }

  chain(id) {
    return /** @type {any[]} */ (this.db.prepare("SELECT body FROM vault_shared_manifests WHERE vault = ? ORDER BY seq").all(id)).map(r => JSON.parse(r.body));
  }

  /** The latest manifest, the chain verified from the start every time. */
  manifest(id) { return verifyChain(this.chain(id)); }

  manifestAt(id, seq) {
    const r = /** @type {any} */ (this.db.prepare("SELECT body FROM vault_shared_manifests WHERE vault = ? AND seq = ?").get(id, seq));
    return r ? JSON.parse(r.body) : null;
  }

  /** The key version rows of a shared class are sealed at. */
  kvOf(cls) {
    const v = /** @type {any} */ (this.db.prepare("SELECT kv FROM vault_shared WHERE id = ?").get(idOf(cls)));
    return v ? Number(v.kv) : 0;
  }

  async me() {
    const id = await this.vault.identity();
    return { id, sign: id.sign.public, box: id.box.public, fp: fingerprint({ sign: id.sign.public, box: id.box.public }) };
  }

  /** The VK of a vault at a key version, unwrapped with this device's box key. */
  async vk(id, kv) {
    const k = `${id}:${kv}`;
    const hit = this.keys.get(k);
    if (hit) return hit;
    const me = await this.me();
    const w = /** @type {any} */ (this.db.prepare("SELECT wrap FROM vault_shared_wraps WHERE vault = ? AND kv = ? AND fp = ?").get(id, kv, me.fp));
    if (!w) throw err(`this Vyre holds no key for version ${kv} of that shared vault`, "locked");
    const raw = Buffer.from(openFrom(me.id.box.private, JSON.parse(w.wrap), vkAad(classOf(id), kv, me.fp), "vk").vk, "base64");
    const key = keyObject(raw);
    this.keys.set(k, key);
    return key;
  }

  /** For vault.open: the key of a `shared:<id>` class at its current version. */
  async keyFor(cls) { return this.vk(idOf(cls), this.kvOf(cls)); }

  /** The latest accepted record per item id. */
  current(id) {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_shared_records WHERE vault = ? ORDER BY rev").all(id));
    const by = new Map();
    for (const r of rows) by.set(r.id, { rev: r.rev, rec: JSON.parse(r.body) });
    return by;
  }

  latestFor(id, itemId) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_shared_records WHERE vault = ? AND id = ? ORDER BY rev DESC LIMIT 1").get(id, itemId));
    return r ? { rev: r.rev, rec: JSON.parse(r.body) } : null;
  }

  /** Current records without tombstones: the items that exist. */
  live(id) {
    const out = new Map();
    for (const [k, x] of this.current(id)) if (!x.rec.deleted) out.set(k, x);
    return out;
  }

  byName(id, name) {
    for (const [, x] of this.live(id)) if (x.rec.name === name) return x;
    return null;
  }

  isHome(v, me) { return v.owner_sign === me.sign; }

  // ---- the home's side -------------------------------------------------------------------------

  /**
   * Take one record into the canonical log. Checks the author may write in the current
   * manifest, the key and manifest versions are current, and the parent is the latest revision
   * of that item. Returns `{ rev }` or throws with code "conflict" and the latest revision.
   */
  async acceptRecord(id, rec, me) {
    const m = this.manifest(id);
    if (!recordOk(rec) || rec.vault !== id) throw err("that record is not signed by its author", "bad_request");
    const author = m.members.find(x => x.sign === rec.author);
    if (!author || !WRITE.has(author.role)) throw err("the author may not write in this vault", "denied");
    if (rec.kv !== m.kv || rec.mseq !== m.seq) throw err("the record was made for an older version of this vault; sync and try again", "conflict");
    if (!ITEM_NAME.test(String(rec.name)) || typeof rec.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(rec.id)) throw err("that record's name or id is not allowed", "bad_request");
    const latest = this.latestFor(id, rec.id);
    if ((latest ? latest.rev : 0) !== rec.parent) throw Object.assign(err("that item changed since you last synced", "conflict"), { latest: latest ? latest.rev : 0 });
    if (rec.deleted ? rec.sealed !== null : !rec.sealed || typeof rec.sealed !== "object") throw err("that record's sealed body is malformed", "bad_request");
    const clash = rec.deleted ? null : this.byName(id, rec.name);
    if (clash && clash.rec.id !== rec.id) throw Object.assign(err(`another item is already called ${rec.name} here`, "conflict"), { latest: clash.rev });
    const top = /** @type {any} */ (this.db.prepare("SELECT MAX(rev) AS r FROM vault_shared_records WHERE vault = ?").get(id));
    const rev = Number(top && top.r || 0) + 1;
    const receipt = signReceipt({ vault: id, rev, hash: hash(rec), mseq: m.seq }, me.id.sign.private);
    this.db.prepare("INSERT INTO vault_shared_records (vault, rev, id, body, receipt) VALUES (?,?,?,?,?)").run(id, rev, rec.id, JSON.stringify(rec), JSON.stringify(receipt));
    return { rev };
  }

  /** Apply an admin change at the home: the next manifest, its wraps, and any re-wrapped records. */
  async applyAdmin(id, { manifest, wraps = [], records = [] }, me) {
    const chain = this.chain(id);
    verifyChain([...chain, manifest]);
    this.vault.tx(() => {
      this.db.prepare("INSERT INTO vault_shared_manifests (vault, seq, body) VALUES (?,?,?)").run(id, manifest.seq, JSON.stringify(manifest));
      for (const w of wraps) this.db.prepare("INSERT OR REPLACE INTO vault_shared_wraps (vault, kv, fp, wrap) VALUES (?,?,?,?)").run(id, w.kv, w.fp, JSON.stringify(w.wrap));
    });
    for (const r of records) await this.acceptRecord(id, r, me);
    this.db.prepare("UPDATE vault_shared SET kv = ?, seq = ? WHERE id = ?").run(manifest.kv, manifest.seq, id);
  }

  /**
   * POST /v1/sync. Only the home answers, only to a key in the current manifest, and errors say
   * what went wrong in words chosen here, never an exception's message.
   */
  async onSync(env) {
    const deny = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });
    let me;
    try { await this.vault.key(); me = await this.me(); } catch { return deny(503, "locked", "this vault is locked"); }
    const v = env && typeof env.vault === "string" ? /** @type {any} */ (this.db.prepare("SELECT * FROM vault_shared WHERE id = ?").get(env.vault)) : null;
    // A poke from a vault's home: something changed there, so pull soon.
    if (v && env.op === "poke" && !this.isHome(v, me) && v.role !== "removed") {
      if (env.from !== v.owner_sign) return deny(403, "denied", "only the vault's home pokes");
      const why = relay.checkSync(env, { audience: this.vault.relayUrl || "", seen: this.vault.share.nonces });
      if (why) return deny(403, "denied", why);
      this.soon(v.id);
      return { status: 200, body: { data: { ok: true } } };
    }
    if (!v || !this.isHome(v, me)) { this.vault.share.auditUnknown(env && env.vault, null, "no such shared vault"); return deny(404, "not_found", "no such shared vault here"); }
    let m;
    try { m = this.manifest(v.id); } catch { return deny(500, "internal", "this vault's manifest does not verify"); }
    const member = m.members.find(x => env && x.sign === env.from);
    if (!member) { this.vault.share.auditUnknown(`sync:${v.id}`, null, "not a member"); return deny(403, "denied", "you are not a member of this vault"); }
    const why = relay.checkSync(env, { audience: this.vault.relayUrl || "", seen: this.vault.share.nonces });
    if (why) { this.vault.audit("sync", null, `member:${member.name}`, false, why); return deny(403, "denied", why); }
    const body = env.body && typeof env.body === "object" ? env.body : {};
    try {
      if (env.op === "pull") {
        const since = Number(body.since) || 0;
        const fp = fpOf(member);
        return { status: 200, body: { data: {
          manifests: this.chain(v.id),
          wraps: /** @type {any[]} */ (this.db.prepare("SELECT kv, wrap FROM vault_shared_wraps WHERE vault = ? AND fp = ?").all(v.id, fp)).map(w => ({ kv: w.kv, wrap: JSON.parse(w.wrap) })),
          records: /** @type {any[]} */ (this.db.prepare("SELECT rev, body, receipt FROM vault_shared_records WHERE vault = ? AND rev > ? ORDER BY rev").all(v.id, since))
            .map(r => ({ rev: r.rev, record: JSON.parse(r.body), receipt: JSON.parse(r.receipt) })),
        } } };
      }
      if (env.op === "push") {
        const out = await this.acceptRecord(v.id, body.record, me);
        this.materialize(v.id);
        this.poke(v, me, member.sign);
        this.vault.audit("sync", null, `member:${member.name}`, true, `push ${body.record && body.record.name} rev ${out.rev}`);
        return { status: 200, body: { data: out } };
      }
      if (env.op === "admin") {
        if (!ADMIN.has(member.role)) return deny(403, "denied", "only an admin may change who is in this vault");
        await this.applyAdmin(v.id, body, me);
        this.materialize(v.id);
        this.poke(v, me, member.sign);
        this.vault.audit("sync", null, `member:${member.name}`, true, `manifest ${body.manifest && body.manifest.seq}`);
        return { status: 200, body: { data: { seq: body.manifest.seq } } };
      }
      return deny(400, "bad_request", "unknown sync operation");
    } catch (e) {
      const x = /** @type {any} */ (e);
      if (x.code === "conflict") return deny(409, "conflict", "that item changed since you last synced", { latest: x.latest ?? null });
      if (x.code === "denied") return deny(403, "denied", "you may not write in this vault");
      this.vault.audit("sync", null, `member:${member.name}`, false, "refused a malformed change");
      return deny(400, "bad_request", "that change was refused");
    }
  }

  // ---- a member's side -------------------------------------------------------------------------

  /** Send a sync request to a vault's home. */
  async call(v, op, body) {
    const me = await this.me();
    const env = relay.syncEnvelope({ vault: v.id, op, body, from: me.sign, privDer: me.id.sign.private, aud: v.home });
    return this.post(v.home, env);
  }

  /**
   * Pull from the home and take what verifies: the manifest chain (whole, from the genesis the
   * invite named), this device's key wraps, and records whose receipt is the owner's and whose
   * author could write when the home took them.
   * @param {{ vault?: string }} [input]
   */
  async sync({ vault: ref } = {}, caller = "cli") {
    const rows = ref ? [this.mustRow(ref)] : /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_shared WHERE role != 'removed'").all());
    // No shared vaults: nothing to pull, and asking for this device's identity would make a key.
    if (!rows.length) return { synced: [] };
    const me = await this.me();
    const out = [];
    for (const v of rows) {
      if (this.isHome(v, me)) { this.materialize(v.id); out.push({ vault: v.name, home: true }); continue; }
      const r = await this.call(v, "pull", { since: v.since });
      if (r.error) {
        if (r.error.code === "denied" && /not a member/.test(r.error.message)) { this.forget(v, "removed by the vault's admins"); out.push({ vault: v.name, removed: true }); continue; }
        throw err(`${v.name}'s home said: ${r.error.message}`, r.error.code);
      }
      out.push({ vault: v.name, ...this.take(v, r.data, me, caller) });
    }
    return { synced: out };
  }

  take(v, data, me, caller) {
    const chain = Array.isArray(data.manifests) ? data.manifests : [];
    const m = verifyChain(chain);
    if (chain[0].by !== v.owner_sign || m.vault !== v.id) throw new Error(`${v.name}'s manifest does not start with its owner`);
    const mine = m.members.find(x => x.sign === me.sign);
    if (!mine) { this.forget(v, "not in the latest manifest"); return { removed: true }; }
    let taken = 0, ignored = 0, since = v.since;
    this.vault.tx(() => {
      this.db.prepare("DELETE FROM vault_shared_manifests WHERE vault = ?").run(v.id);
      for (const x of chain) this.db.prepare("INSERT INTO vault_shared_manifests (vault, seq, body) VALUES (?,?,?)").run(v.id, x.seq, JSON.stringify(x));
      for (const w of data.wraps || []) this.db.prepare("INSERT OR REPLACE INTO vault_shared_wraps (vault, kv, fp, wrap) VALUES (?,?,?,?)").run(v.id, w.kv, me.fp, JSON.stringify(w.wrap));
      for (const r of data.records || []) {
        since = Math.max(since, Number(r.rev) || 0);
        const at = chain.find(x => x.seq === r.receipt?.mseq);
        const author = at && at.members.find(x => x.sign === r.record?.author);
        const good = receiptOk(r.receipt, v.owner_sign) && r.receipt.rev === r.rev && r.receipt.vault === v.id && r.receipt.hash === hash(r.record)
          && recordOk(r.record) && author && WRITE.has(author.role) && r.record.kv === at.kv && r.record.mseq === at.seq;
        if (!good) { ignored++; continue; }
        this.db.prepare("INSERT OR IGNORE INTO vault_shared_records (vault, rev, id, body, receipt) VALUES (?,?,?,?,?)").run(v.id, r.rev, r.record.id, JSON.stringify(r.record), JSON.stringify(r.receipt));
        taken++;
      }
      this.db.prepare("UPDATE vault_shared SET kv = ?, seq = ?, since = ?, role = ? WHERE id = ?").run(m.kv, m.seq, since, mine.role, v.id);
    });
    if (ignored) this.vault.audit("sync", null, String(caller), false, `${v.name}: ${ignored} records ignored (signer could not write, or the receipt is not the owner's)`);
    this.materialize(v.id);
    return { taken, ignored, kv: m.kv };
  }

  /** Someone removed us: drop the replica, its keys and its items here. */
  forget(v, why) {
    for (const r of /** @type {any[]} */ (this.db.prepare("SELECT id FROM vault_items WHERE vault = ?").all(classOf(v.id)))) removeSealed(this.vault.dir, r.id);
    this.vault.tx(() => {
      this.db.prepare("DELETE FROM vault_items WHERE vault = ?").run(classOf(v.id));
      for (const t of ["vault_shared_wraps", "vault_shared_records", "vault_shared_manifests"]) this.db.prepare(`DELETE FROM ${t} WHERE vault = ?`).run(v.id);
      this.db.prepare("UPDATE vault_shared SET role = 'removed' WHERE id = ?").run(v.id);
    });
    for (const k of [...this.keys.keys()]) if (k.startsWith(v.id + ":")) this.keys.delete(k);
    this.vault.audit("shared-removed", null, "vault", true, `${v.name}: ${why}`);
  }

  /** Current records become rows in vault_items (`<vault>/<item>`), each sealed file beside them. */
  materialize(id) {
    const v = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_shared WHERE id = ?").get(id));
    if (!v) return;
    const cls = classOf(id);
    const cur = this.live(id);
    const keep = new Set();
    const t = now();
    for (const [itemId, { rec }] of cur) {
      keep.add(itemId);
      writeSealed(this.vault.dir, itemId, rec.sealed);
      const name = `${v.name}/${rec.name}`;
      const m = rec.meta || {};
      this.vault.tx(() => {
        this.db.prepare(`INSERT INTO vault_items (id, name, kind, description, fields, url, hosts, origin, rotate, created, updated, ver, vault, apps, reprompt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET name=excluded.name, kind=excluded.kind, description=excluded.description,
          fields=excluded.fields, url=excluded.url, hosts=excluded.hosts, origin=excluded.origin, rotate=excluded.rotate, updated=excluded.updated,
          ver=excluded.ver, vault=excluded.vault, apps=excluded.apps, reprompt=excluded.reprompt`)
          .run(itemId, name, String(m.kind || "secret"), String(rec.description || ""), JSON.stringify(rec.fields || []), m.url ?? null, JSON.stringify(m.hosts || []),
            `shared:${v.name}`, rec.rotate || null, t, t, rec.ver, cls, JSON.stringify(m.apps || []), m.reprompt ? 1 : 0);
        this.vault.sign("vault_items", itemId);
      });
    }
    for (const r of /** @type {any[]} */ (this.db.prepare("SELECT id FROM vault_items WHERE vault = ?").all(cls))) {
      if (keep.has(r.id)) continue;
      removeSealed(this.vault.dir, r.id);
      this.db.prepare("DELETE FROM vault_items WHERE id = ?").run(r.id);
    }
  }

  /**
   * Tell members something changed, so they pull. A member is reached at the relay address on
   * the card pinned for their key; members without one pull on start or every ten minutes.
   */
  poke(v, me, except = null) {
    let m;
    try { m = this.manifest(v.id); } catch { return; }
    for (const x of m.members) {
      if (x.sign === me.sign || x.sign === except) continue;
      const p = /** @type {any} */ (this.db.prepare("SELECT relay FROM vault_people WHERE sign = ? AND relay IS NOT NULL AND relay != ''").get(x.sign));
      if (!p || !relay.secureTarget(p.relay)) continue;
      const env = relay.syncEnvelope({ vault: v.id, op: "poke", body: {}, from: me.sign, privDer: me.id.sign.private, aud: p.relay });
      Promise.resolve(this.post(p.relay, env)).catch(() => {});
    }
  }

  /** Pull one vault (or all) in a moment. */
  soon(id = null) {
    this.vault.later(() => this.sync(id ? { vault: id } : {}, "vault").catch(e => this.vault.log(`vault shared sync: ${/** @type {Error} */ (e).message}`)), 200);
  }

  /** An admin change: applied here at the home, or sent to it. */
  async submitAdmin(v, bundle, me) {
    if (this.isHome(v, me)) { await this.applyAdmin(v.id, bundle, me); this.materialize(v.id); this.poke(v, me); return; }
    const r = await this.call(v, "admin", bundle);
    if (r.error) throw err(`${v.name}'s home refused the change: ${r.error.message}`, r.error.code);
    await this.sync({ vault: v.id });
  }

  /** The next manifest version, signed by this device, from the current one and a change. */
  next(m, me, change) {
    return signManifest({ v: 1, vault: m.vault, name: m.name, seq: m.seq + 1, prev: hash(m), kv: m.kv, members: m.members, by: me.sign, at: now(), ...change }, me.id.sign.private);
  }

  /** Wrap a VK for one member at a key version. */
  wrapFor(id, kv, vk, member) {
    const fp = fpOf(member);
    const raw = vk.export();
    try { return { kv, fp, wrap: sealFor(member.box, { vk: raw.toString("base64") }, vkAad(classOf(id), kv, fp), "vk") }; }
    finally { raw.fill(0); }
  }

  mustAdmin(m, me, what) {
    const self = m.members.find(x => x.sign === me.sign);
    if (!self || !ADMIN.has(self.role)) throw err(`only an owner or admin may ${what}`, "denied");
    return self;
  }

  // ---- tools -------------------------------------------------------------------------------------

  /** Make a shared vault with this Vyre as owner and home. @param {{ name: string }} input */
  async create({ name }, caller) {
    if (!VAULT_NAME.test(String(name || ""))) throw new Error("a vault name is letters, digits, dot, dash and underscore, up to 64");
    if (this.row(name)) throw new Error(`there is already a shared vault named ${name}`);
    const me = await this.me();
    const id = newId();
    const m = signManifest({ v: 1, vault: id, name, seq: 1, prev: "", kv: 1, members: [{ name: this.vault.name, sign: me.sign, box: me.box, role: "owner" }], by: me.sign, at: now() }, me.id.sign.private);
    const vk = newVaultKey();
    const w = this.wrapFor(id, 1, vk, m.members[0]);
    this.vault.tx(() => {
      this.db.prepare("INSERT INTO vault_shared (id, name, home, owner_sign, kv, seq, since, role, joined) VALUES (?,?,?,?,?,?,?,?,?)").run(id, name, this.vault.relayUrl || "", me.sign, 1, 1, 0, "owner", now());
      this.db.prepare("INSERT INTO vault_shared_manifests (vault, seq, body) VALUES (?,?,?)").run(id, 1, JSON.stringify(m));
      this.db.prepare("INSERT INTO vault_shared_wraps (vault, kv, fp, wrap) VALUES (?,?,?,?)").run(id, 1, w.fp, JSON.stringify(w.wrap));
    });
    this.keys.set(`${id}:1`, vk);
    this.vault.audit("vault-create", null, caller, true, name);
    return { vault: this.out(this.row(id)) };
  }

  out(v) {
    let m = null;
    try { m = this.manifest(v.id); } catch {}
    const items = /** @type {any[]} */ (this.db.prepare("SELECT name, rotate FROM vault_items WHERE vault = ? ORDER BY name").all(classOf(v.id)));
    const conflicts = Number(/** @type {any} */ (this.db.prepare("SELECT COUNT(*) AS n FROM vault_shared_conflicts WHERE vault = ?").get(v.id)).n);
    return {
      id: v.id, name: v.name, role: v.role, kv: v.kv, seq: v.seq, home: v.home || null,
      members: m ? m.members.map(x => ({ name: x.name, role: x.role, fingerprint: fpOf(x) })) : [],
      items: items.map(i => ({ name: i.name, ...(i.rotate ? { rotate: true } : {}) })), ...(conflicts ? { conflicts } : {}),
    };
  }

  list() {
    return { vaults: /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_shared ORDER BY name").all()).map(v => this.out(v)) };
  }

  /**
   * Invite a pinned, verified person. Returns an invite for them to accept; it carries no key
   * (their VK wrap waits at the home, sealed to their card's box key).
   * @param {{ vault: string, person: string, role?: string }} input
   */
  async invite({ vault: ref, person, role = "member" }, caller) {
    if (!["admin", "member", "read-only"].includes(role)) throw new Error("role is admin, member or read-only");
    const v = this.mustRow(ref);
    if (!v.home) throw new Error(`${v.name} has no home address, so nobody else can reach it · set vault.relay in config.json on its owner's Vyre`);
    const me = await this.me();
    if (!this.isHome(v, me)) await this.sync({ vault: v.id });
    const m = this.manifest(v.id);
    this.mustAdmin(m, me, "invite");
    const p = this.vault.share.trusted(person);
    if (!p.verified) throw new Error(`${person}'s card is pinned but not verified · compare fingerprints (vyre vault fingerprint ${person}) and run vyre vault people verify first`);
    if (m.members.some(x => x.sign === p.sign)) throw new Error(`${person} is already in ${v.name}`);
    const member = { name: String(person), sign: p.sign, box: p.box, role };
    const next = this.next(m, me, { members: [...m.members, member] });
    // Everything that can fail is made before the member is added, so no one is added without an invite.
    const wrap = this.wrapFor(v.id, m.kv, await this.vk(v.id, m.kv), member);
    const invite = encodeInvite({ v: 1, vault: v.id, name: v.name, home: v.home, owner: v.owner_sign, inviterCard: (await this.vault.share.myCard()).card,
      member: { name: String(person), sign: p.sign }, seq: next.seq }, me.id.sign.private);
    await this.submitAdmin(v, { manifest: next, wraps: [wrap] }, me);
    this.vault.audit("member-add", null, caller, true, `${v.name}: ${person} as ${role}`);
    this.vault.emit("vault.member-added", { vault: v.name, member: String(person), role });
    return { invite, vault: v.name, member: String(person), role };
  }

  /** Join a vault from an invite: the inviter must match their pinned card, the invite must be for us. */
  async accept({ invite }, caller) {
    const inv = decodeInvite(invite);
    const me = await this.me();
    if (inv.member.sign !== me.sign) throw new Error("this invite was made for another Vyre");
    await this.vault.share.pinOwner(inv.card, inv.inviterCard, caller);
    if (!relay.secureTarget(inv.home)) throw new Error("this vault's home is not reachable over https (or loopback)");
    const known = this.row(inv.vault);
    if (known && known.role !== "removed") throw new Error(`you are already in ${known.name}`);
    if (this.row(inv.name) && this.row(inv.name).id !== inv.vault) throw new Error(`you already have a vault named ${inv.name}`);
    this.db.prepare("INSERT OR REPLACE INTO vault_shared (id, name, home, owner_sign, kv, seq, since, role, joined) VALUES (?,?,?,?,0,0,0,'',?)").run(inv.vault, inv.name, inv.home, inv.owner, now());
    try { await this.sync({ vault: inv.vault }, caller); }
    catch (e) { this.db.prepare("DELETE FROM vault_shared WHERE id = ?").run(inv.vault); throw e; }
    const v = this.row(inv.vault);
    if (v.role === "removed" || !v.role) { this.db.prepare("DELETE FROM vault_shared WHERE id = ?").run(inv.vault); throw new Error("the vault's home does not list you as a member"); }
    this.vault.audit("vault-join", null, caller, true, v.name);
    return { vault: this.out(v) };
  }

  async role({ vault: ref, person, role }, caller) {
    if (!["admin", "member", "read-only"].includes(role)) throw new Error("role is admin, member or read-only");
    const v = this.mustRow(ref);
    const me = await this.me();
    if (!this.isHome(v, me)) await this.sync({ vault: v.id });
    const m = this.manifest(v.id);
    this.mustAdmin(m, me, "change roles");
    const who = this.member(m, person);
    if (who.role === "owner") throw new Error("the owner's role does not change");
    await this.submitAdmin(v, { manifest: this.next(m, me, { members: m.members.map(x => x.sign === who.sign ? { ...x, role } : x) }) }, me);
    this.vault.audit("member-role", null, caller, true, `${v.name}: ${who.name} is ${role}`);
    return { vault: v.name, member: who.name, role };
  }

  /** A manifest member by manifest name, or by the key pinned for a local name. */
  member(m, person) {
    const pinned = this.vault.share.row(person);
    const who = m.members.find(x => (pinned && x.sign === pinned.sign) || x.name === person);
    if (!who) throw new Error(`${person} is not in this vault`);
    return who;
  }

  /**
   * A new key version: a fresh VK wrapped for `members`, and every current item's key re-wrapped
   * under it as a new record, flagged for rotation when `flag` says why.
   */
  async rekey(v, m, me, members, flag) {
    const kv = m.kv + 1;
    const next = this.next(m, me, { members, kv });
    const oldVk = await this.vk(v.id, m.kv), newVk = newVaultKey();
    const wraps = members.map(x => this.wrapFor(v.id, kv, newVk, x));
    const records = [];
    for (const [itemId, { rev, rec }] of this.live(v.id)) {
      const at = { vault: classOf(v.id), id: itemId, ver: rec.ver, name: `${v.name}/${rec.name}` };
      const sealed = rewrapItemKey(oldVk, newVk, { ...at, kv: m.kv }, { ...at, kv }, rec.sealed);
      records.push(signRecord({ ...without(rec, "sig"), parent: rev, kv, mseq: next.seq, sealed, author: me.sign, at: now(), ...(flag ? { rotate: flag } : {}) }, me.id.sign.private));
    }
    await this.submitAdmin(v, { manifest: next, wraps, records }, me);
    this.keys.set(`${v.id}:${kv}`, newVk);
    this.vault.emit("vault.key-rotated", { vault: v.name, kv });
    return { kv, items: records.map(r => `${v.name}/${r.name}`) };
  }

  /** Remove a member: a new key they never see, and every item they could read flagged for rotation. */
  async remove({ vault: ref, person }, caller) {
    const v = this.mustRow(ref);
    const me = await this.me();
    if (!this.isHome(v, me)) await this.sync({ vault: v.id });
    const m = this.manifest(v.id);
    this.mustAdmin(m, me, "remove members");
    const who = this.member(m, person);
    if (who.role === "owner") throw new Error("the owner cannot be removed from their own vault");
    const flag = `readable by ${who.name} until ${new Date().toISOString().slice(0, 10)}`;
    const r = await this.rekey(v, m, me, m.members.filter(x => x.sign !== who.sign), flag);
    this.vault.audit("member-remove", null, caller, true, `${v.name}: ${who.name}, ${r.items.length} to rotate`);
    this.vault.emit("vault.member-removed", { vault: v.name, member: who.name, rotate: r.items.length });
    return { vault: v.name, removed: who.name, kv: r.kv, rotate: r.items };
  }

  /** A new key with the same members (after a lost device, say). Items keep their values. */
  async rotate({ vault: ref }, caller) {
    const v = this.mustRow(ref);
    const me = await this.me();
    if (!this.isHome(v, me)) await this.sync({ vault: v.id });
    const m = this.manifest(v.id);
    this.mustAdmin(m, me, "rotate the key");
    const r = await this.rekey(v, m, me, m.members, null);
    this.vault.audit("vault-rotate", null, caller, true, `${v.name}: key version ${r.kv}`);
    return { vault: v.name, kv: r.kv };
  }

  /**
   * Write an item into a shared vault. The record names the revision it was based on; if the
   * home has moved on, the two versions are merged when they changed different fields, and
   * otherwise this version is kept as a conflict revision and vault.sync-conflicted says so.
   * @param {{ vault: string, name: string, kind?: string, description?: string, fields: Record<string,string>, url?: string|null, hosts?: string[], apps?: string[], reprompt?: boolean }} input
   */
  async put(input, caller) {
    const v = this.mustRow(input.vault);
    if (!ITEM_NAME.test(String(input.name || ""))) throw new Error("a name is letters, digits, dot, dash and underscore, up to 128");
    if (!input.fields || typeof input.fields !== "object" || !Object.keys(input.fields).length || Object.values(input.fields).some(x => typeof x !== "string")) throw new Error("fields must be an object of text");
    const me = await this.me();
    let m = this.manifest(v.id);
    const self = m.members.find(x => x.sign === me.sign);
    if (!self || !WRITE.has(self.role)) throw err(`you may read ${v.name} but not write to it`, "denied");
    const base = this.byName(v.id, input.name);
    const meta = { kind: input.kind || (base && base.rec.meta.kind) || "secret", url: input.url ?? (base ? base.rec.meta.url : null) ?? null,
      hosts: input.hosts ?? (base ? base.rec.meta.hosts : []) ?? [], apps: input.apps ?? (base ? base.rec.meta.apps : []) ?? [], reprompt: Boolean(input.reprompt ?? (base && base.rec.meta.reprompt)) };
    let fields = { ...input.fields };
    let parent = base ? base.rev : 0, prev = base;
    for (let attempt = 0; attempt < 3; attempt++) {
      const rec = await this.record(v, m, me, { id: prev ? prev.rec.id : newId(), name: input.name, ver: prev ? prev.rec.ver + 1 : 1, parent, meta,
        description: String(input.description ?? (prev ? prev.rec.description : "") ?? ""), fields });
      const r = this.isHome(v, me) ? await this.acceptLocal(v, rec, me) : await this.call(v, "push", { record: rec });
      if (!r.error) {
        if (!this.isHome(v, me)) await this.sync({ vault: v.id }, caller);
        this.vault.audit(base ? "change" : "add", `${v.name}/${input.name}`, caller, true, `shared rev ${r.data.rev}`);
        this.vault.emit(base ? "vault.item-changed" : "vault.item-added", { name: `${v.name}/${input.name}`, kind: meta.kind });
        return { name: `${v.name}/${input.name}`, vault: v.name, rev: r.data.rev, ...(attempt ? { merged: true } : {}) };
      }
      if (r.error.code !== "conflict") throw err(`${v.name}'s home refused it: ${r.error.message}`, r.error.code);
      // Someone else wrote first. Take their version and see whether the edits overlap.
      if (!this.isHome(v, me)) await this.sync({ vault: v.id }, caller);
      m = this.manifest(v.id);
      const theirs = this.byName(v.id, input.name);
      if (!theirs) throw err(`${v.name} changed under you; try again`, "conflict");
      const baseFields = base ? (await this.openRecord(v, base.rec)).fields : {};
      const theirFields = (await this.openRecord(v, theirs.rec)).fields;
      const changed = f => new Set(Object.keys({ ...baseFields, ...f }).filter(k => baseFields[k] !== f[k]));
      const mine = changed(input.fields), other = changed(theirFields);
      if ([...mine].some(k => other.has(k)) || (base && theirs.rec.id !== base.rec.id)) {
        this.db.prepare("INSERT INTO vault_shared_conflicts (vault, item, name, body, at) VALUES (?,?,?,?,?)").run(v.id, theirs.rec.id, input.name, JSON.stringify(rec), now());
        this.vault.audit("sync-conflict", `${v.name}/${input.name}`, caller, false, `kept as a conflict revision beside rev ${theirs.rev}`);
        this.vault.emit("vault.sync-conflicted", { vault: v.name, name: `${v.name}/${input.name}` });
        return { name: `${v.name}/${input.name}`, vault: v.name, conflict: true, current: theirs.rev };
      }
      fields = { ...theirFields };
      for (const k of mine) { if (input.fields[k] === undefined) delete fields[k]; else fields[k] = input.fields[k]; }
      parent = theirs.rev; prev = theirs;
    }
    throw err(`${v.name} kept changing while this was written; try again`, "conflict");
  }

  async acceptLocal(v, rec, me) {
    try { const out = await this.acceptRecord(v.id, rec, me); this.materialize(v.id); this.poke(v, me); return { data: out }; }
    catch (e) { const x = /** @type {any} */ (e); return { error: { code: x.code || "bad_request", message: x.message, latest: x.latest } }; }
  }

  /** Seal and sign one record for the current key and manifest version. */
  async record(v, m, me, { id, name, ver, parent, meta, description, fields }) {
    const at = { vault: classOf(v.id), kv: m.kv, id, ver, name: `${v.name}/${name}` };
    const sealed = sealItemV2(await this.vk(v.id, m.kv), at, { meta, fields });
    return signRecord({ v: 1, vault: v.id, id, name, ver, parent, kv: m.kv, mseq: m.seq, meta, description, fields: Object.keys(fields), sealed, author: me.sign, at: now() }, me.id.sign.private);
  }

  async openRecord(v, rec) {
    return openItemV2(await this.vk(v.id, rec.kv), { vault: classOf(v.id), kv: rec.kv, id: rec.id, ver: rec.ver, name: `${v.name}/${rec.name}` }, rec.sealed);
  }

  /**
   * Delete an item from a shared vault: a tombstone record, signed like any write and naming the
   * revision it deletes. If someone changed the item since, nothing is deleted and the person is
   * told, rather than their edit disappearing.
   * @param {{ vault: string, name: string }} input
   */
  async deleteItem({ vault: ref, name }, caller) {
    const v = this.mustRow(ref);
    const me = await this.me();
    const base = this.byName(v.id, name);
    if (!base) throw new Error(`no item named ${v.name}/${name}`);
    let r;
    for (let attempt = 0; attempt < 2; attempt++) {
      const m = this.manifest(v.id);
      const self = m.members.find(x => x.sign === me.sign);
      if (!self || !WRITE.has(self.role)) throw err(`you may read ${v.name} but not delete from it`, "denied");
      const rec = signRecord({ v: 1, vault: v.id, id: base.rec.id, name, ver: base.rec.ver + 1, parent: base.rev, kv: m.kv, mseq: m.seq, meta: null, description: "",
        fields: [], sealed: null, deleted: true, author: me.sign, at: now() }, me.id.sign.private);
      r = this.isHome(v, me) ? await this.acceptLocal(v, rec, me) : await this.call(v, "push", { record: rec });
      if (!r.error || r.error.code !== "conflict" || this.isHome(v, me)) break;
      // Stale: if only the manifest moved on (the item did not), take it and try once more.
      await this.sync({ vault: v.id }, caller);
      const now2 = this.byName(v.id, name);
      if (!now2 || now2.rev !== base.rev) break;
    }
    if (r.error) {
      if (!this.isHome(v, me)) await this.sync({ vault: v.id }, caller).catch(() => {});
      throw err(r.error.code === "conflict" ? `${v.name}/${name} changed since you last synced; look at it again before deleting` : `${v.name}'s home refused it: ${r.error.message}`, r.error.code);
    }
    if (!this.isHome(v, me)) await this.sync({ vault: v.id }, caller);
    this.vault.audit("delete", `${v.name}/${name}`, caller, true, `shared rev ${r.data.rev}`);
    this.vault.emit("vault.item-deleted", { name: `${v.name}/${name}` });
    return { deleted: `${v.name}/${name}`, rev: r.data.rev };
  }

  /** Move a local item into a shared vault. The local copy goes once the shared one is written. */
  async move({ name, to }, caller) {
    // A provider sign-in token is the person's own and goes only to the session launcher: never into a shared vault, where a team could use it.
    if (launcherItem(String(name))) { const why = `${name} is a provider sign-in token; it is never moved into a shared vault`; this.vault.refuse("move", name, caller, why); throw new Error(why); }
    const r = this.vault.mustRow(name);
    if (String(r.vault).startsWith("shared:")) throw new Error(`${name} is already in a shared vault`);
    // The local copy is removed after the shared one is written, and remove refuses an item in a live pass: check that first, so a refusal leaves nothing half moved.
    const inPass = this.vault.activePasses().find(p => p.items.includes(name));
    if (inPass) { const why = `${name} is in pass ${inPass.id}; revoke the pass first`; this.vault.refuse("move", name, caller, why); throw new Error(why); }
    const { meta, fields } = await this.vault.open(r);
    const out = await this.put({ vault: to, name, kind: meta.kind, description: r.description, fields, url: meta.url, hosts: meta.hosts, apps: meta.apps, reprompt: meta.reprompt }, caller);
    if (out.conflict) return out;
    this.vault.remove({ name }, caller);
    return { moved: name, to: out.name, rev: out.rev };
  }

  /**
   * For offboarding: remove a person from every shared vault this Vyre can administer, by the
   * key pinned for them. Returns the items to rotate, as local names.
   * @param {string|null} sign the person's pinned sign key @param {string} person
   */
  async removeEverywhere(sign, person, caller) {
    const rotate = [], left = [];
    const me = await this.me();
    for (const v of /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_shared WHERE role IN ('owner', 'admin')").all())) {
      let m;
      try { m = this.manifest(v.id); } catch { continue; }
      const who = m.members.find(x => (sign && x.sign === sign) || x.name === person);
      if (!who || who.role === "owner" || !ADMIN.has(m.members.find(x => x.sign === me.sign)?.role)) continue;
      const r = await this.remove({ vault: v.id, person: who.name }, caller);
      rotate.push(...r.rotate);
      left.push(v.name);
    }
    return { vaults: left, rotate };
  }
}
