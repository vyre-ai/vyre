// @ts-check
// core/vault/people.js: a vault for each person (the owner's decisions of 13 Oct), on the Space's server and sealed so the server cannot open it.
//
// Each person has their own Vault instance (their own folder and database under <dir>/people/<id>), which holds the account: a master password and a Secret Key, the scheme of the owner's vault.
// The Secret Key is never kept here: the person's device supplies it with the password for each unlock, and the instance's Secret Key store is a hand-off that remembers nothing (the owner who reads the disk finds
// ciphertext only). Items are not the Vault class's agent items (those sit under a device key kept beside them): each is sealed under the person's own key, in this person's folder, bound to this person.
// An unlock is a lease in memory: it renews on use and ends after an idle time, on lock, and when the process stops. It is held per person, so no other person's call can reach it.
//
// What this file does not do: decide who is calling. tools/me.js reads the person from the kernel's chain and passes the id here.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS, ensureMacColumns } from "./vault.js";
import { ensureDir } from "./store.js";
import { sealItemV2, openItemV2, keyObject } from "./crypto.js";
import { sitesOf } from "./sites.js";
import { sealConnectionKey, openConnectionKey, forgetConnectionKey } from "./people-seal.js";

export const PERSON_ID = /^per_[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[A-Za-z0-9._-]{1,128}$/;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const FIELD = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_VALUE = 64 * 1024, MAX_ITEMS = 500;
const ITEMS = "me-items";
const CONN_ITEMS = "conn-items";
const CK_FILE = "ck.json";
const LEND_ITEMS = "lend-items";
const LK_FILE = "lk.json";
/** The fields of a connection a person may see: what it connects to, never a token, a secret or a key. */
const CONNECTION_PUBLIC = new Set(["auth_kind", "server_url", "catalog_id", "connected_by", "scope", "resource", "expires_at", "issuer"]);
const KV = 1;

/** The age of idleness after which a person's vault locks again. */
export const IDLE_MS = 8 * 60 * 60 * 1000;

const locked = () => Object.assign(new Error("your vault is locked: unlock it with your master password"), { code: "locked" });

export class PeopleVaults {
  /** @param {{ dir: string, sealRoot?: string | null, config?: any, emit?: (t: string, p: object) => void, log?: (m: string) => void, testKdf?: any, clock?: () => number, idleMs?: number }} o */
  constructor({ dir, config, emit = () => {}, log = () => {}, testKdf = null, clock = Date.now, idleMs = IDLE_MS, sealRoot = null }) {
    /** The Space's state folder, where the sealed server copies of members' keys are kept; null keeps none (tests, a build with no server). @type {string | null} */ this.sealRoot = sealRoot;
    this.dir = dir; this.config = config; this.emit = emit; this.log = log; this.testKdf = testKdf; this.clock = clock; this.idleMs = idleMs;
    /** @type {Map<string, { vault: Vault, db: any, last: number, sk: string | null, queue: Promise<any> }>} */ this.open = new Map();
    /** Told when an item of a person's changes or goes (the shares of a login are refreshed or ended from it). Never throws into the change. @type {(id: string, name: string) => Promise<any>} */ this.onItem = async () => {};
  }

  /** Throws unless this is a person id; the id becomes a folder name. @param {string} id */
  static check(id) { if (typeof id !== "string" || !PERSON_ID.test(id)) throw new Error("not a person id"); return id; }

  /** The person's folder: named by a hash of the id (no id forms a path; case-folding disks cannot make two people one folder), and checked to lie under the vaults root. @param {string} id */
  folder(id) {
    const root = path.join(this.dir, "people");
    const f = path.join(root, crypto.createHash("sha256").update("vyre-person-vault\0" + PeopleVaults.check(id)).digest("hex").slice(0, 40));
    ensureDir(root);
    const rootReal = fs.realpathSync(root);
    const real = fs.existsSync(f) ? fs.realpathSync(f) : path.resolve(rootReal, path.basename(f));
    if (path.dirname(real) !== rootReal) throw new Error("not a person folder");
    return f;
  }

  /** @param {string} id */
  slot(id) {
    PeopleVaults.check(id);
    let s = this.open.get(id);
    if (s) return s;
    const dir = this.folder(id);
    ensureDir(dir);
    const db = open(path.join(dir, "vyre.db"));
    migrate(db, "vault", MIGRATIONS);
    ensureMacColumns(db);
    // A file keystore always: the Vault class opens an agent key for its own items; this person's items never use it.
    const vault = new Vault({ db, dir, config: { ...(this.config || {}), vault: { keystore: "file" } }, emit: (t, p) => this.emit(t, { ...p, person: id }), log: this.log, testKdf: this.testKdf, clock: this.clock });
    const slot = { vault, db, last: 0, sk: /** @type {string | null} */ (null), queue: Promise.resolve() };
    // The Secret Key hand-off: read gives what the device sent for this call, put keeps nothing.
    vault.secretKeys = /** @type {any} */ ({ put: async () => {}, read: async () => slot.sk, remove: async () => {}, migrate: async () => ({ moved: false }) });
    this.open.set(id, slot);
    return slot;
  }

  /** One call at a time per person, so the hand-off of the Secret Key is never read by another call. @template T @param {string} id @param {() => Promise<T>} fn @returns {Promise<T>} */
  serial(id, fn) {
    let s;
    try { s = this.slot(id); } catch (e) { return Promise.reject(e); }
    const run = s.queue.then(fn, fn);
    s.queue = run.catch(() => {});
    return run;
  }

  /** @param {string} id @param {{ password: string }} input */
  create(id, { password }) {
    return this.serial(id, async () => {
      const s = this.slot(id);
      const r = await s.vault.createAccount({ password }, "person:" + id);
      s.last = this.clock();
      this.seal(id, s);
      return { acct: r.acct, secretKey: r.secretKey };
    });
  }

  /** @param {string} id @param {{ password: string, secretKey?: string }} input */
  unlock(id, { password, secretKey }) {
    return this.serial(id, async () => {
      const s = this.slot(id);
      s.sk = typeof secretKey === "string" && secretKey ? secretKey : null;
      try {
        if (!s.sk) throw new Error("unlocking needs your Secret Key, which your device holds: unlock from a device that has it");
        const r = await s.vault.unlockAccount({ password, method: "password" }, "person:" + id);
        s.last = this.clock();
        this.seal(id, s);
        return { unlocked: true, acct: r.acct };
      } finally { s.sk = null; }
    });
  }

  /** @param {string} id @param {{ recovery: string, password: string }} input */
  reset(id, input) {
    return this.serial(id, async () => {
      const s = this.slot(id);
      if (typeof (/** @type {any} */ (s.vault)).resetAccount !== "function") throw new Error("resetting a forgotten password is not available in this build");
      try {
        const r = await (/** @type {any} */ (s.vault)).resetAccount(input, "person:" + id);
        s.last = this.clock();
        this.rotateConnectionKey(id, s);
        this.rotateLendKey(id, s);
        return r;
      } finally { s.sk = null; }
    });
  }

  /** @param {string} id */
  lock(id) {
    const s = this.open.get(PeopleVaults.check(id));
    if (!s) return { locked: true };
    s.vault.lockAccount("person:" + id);
    s.last = 0;
    return { locked: true };
  }

  /** A member who is removed: the vault is locked and its folder erased, so a later person with the same name starts empty. @param {string} id */
  destroy(id) {
    const f = this.folder(id);
    const s = this.open.get(id);
    if (s) { try { s.vault.lockAccount("removed"); } catch {} try { s.db.close(); } catch {} this.open.delete(id); }
    fs.rmSync(f, { recursive: true, force: true });
    if (this.sealRoot) { forgetConnectionKey(this.sealRoot, id); forgetConnectionKey(this.sealRoot, id, "lend"); }
    return { removed: true };
  }

  /** @param {string} id */
  status(id) {
    const s = this.slot(id);
    this.expire(s);
    const r = s.vault.accountStatus();
    return { account: r.account, unlocked: r.unlocked, ...(r.acct ? { acct: r.acct } : {}) };
  }

  /** Ends the lease when it has been idle too long. @param {{ vault: Vault, last: number }} s */
  expire(s) {
    if (s.vault.pvk && this.clock() - s.last > this.idleMs) { s.vault.lockAccount("idle"); s.last = 0; }
  }

  /** The person's key, or throws locked; a use renews the lease. @param {string} id */
  key(id) {
    const s = this.slot(id);
    this.expire(s);
    if (!s.vault.pvk) throw locked();
    s.last = this.clock();
    return s.vault.pvk;
  }

  // ---- the connection key ----
  // Items of kind "connection" (a member's app sign-ins) are sealed under a CONNECTION KEY of their own, not under the vault key. The connection key lives inside the vault (wrapped by the vault key,
  // `ck.json`), and it alone is sealed for the server (people-seal.js). So a leak of the state folder yields connection tokens and never a password, a card or a note: the sealed key cannot
  // decrypt any other item, which is a fact of the cryptography and not a check in code. Only the signed-in connect path and the hub's token tool write or read them (`service`).

  /** The connection key, made the first time it is asked for with the vault key in hand. @param {string} id @param {import("node:crypto").KeyObject} pvk */
  connectionKey(id, pvk) {
    const file = path.join(this.folder(id), CK_FILE);
    if (fs.existsSync(file)) {
      const body = openItemV2(pvk, this.at(id, "ck"), JSON.parse(fs.readFileSync(file, "utf8")));
      return keyObject(Buffer.from(body.fields.ck, "base64"));
    }
    const raw = crypto.randomBytes(32);
    this.writeCk(id, pvk, raw);
    return keyObject(raw);
  }

  /** @param {string} id @param {import("node:crypto").KeyObject} pvk @param {Buffer} raw */
  writeCk(id, pvk, raw) {
    const file = path.join(this.folder(id), CK_FILE), tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(sealItemV2(pvk, this.at(id, "ck"), { meta: { name: "ck" }, fields: { ck: Buffer.from(raw).toString("base64") } })), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** Keep the sealed server copy equal to the connection key. A failure is logged and never stops the unlock: the person's own use does not depend on it. @param {string} id @param {{ vault: Vault }} s */
  seal(id, s) {
    if (!this.sealRoot || !s.vault.pvk) return;
    try { sealConnectionKey(this.sealRoot, id, this.connectionKey(id, s.vault.pvk)); } catch (e) { this.log(`vault: could not seal the connection key of ${id}: ${/** @type {Error} */ (e).message}`); }
    try { sealConnectionKey(this.sealRoot, id, this.lendKey(id, s.vault.pvk), "lend"); } catch (e) { this.log(`vault: could not seal the lend key of ${id}: ${/** @type {Error} */ (e).message}`); }
  }

  /** A forgotten password was reset: the connection items get a new key and the server's seal follows. @param {string} id @param {{ vault: Vault }} s */
  rotateConnectionKey(id, s) {
    const pvk = s.vault.pvk;
    if (!pvk) return;
    const old = this.connectionKey(id, pvk);
    const items = this.allConnections(id, old);
    const next = crypto.randomBytes(32);
    const nextKey = keyObject(Buffer.from(next));
    for (const it of items) this.writeConnection(id, it.fileId, { name: it.name, kind: "connection", description: it.description, updated: it.updated }, it.fields, nextKey);
    this.writeCk(id, pvk, next);
    this.seal(id, s);
  }

  /**
   * The person's connection items for a service (the MCP hub's token tool, the connect path), opened with the connection key: the vault's when the person is unlocked, else the sealed server copy.
   * It reads and writes connection items and nothing else, by construction: the key opens nothing more. Throws code "locked" when there is no seal and the person is not unlocked.
   * @param {string} id
   */
  service(id) {
    PeopleVaults.check(id);
    const key = () => {
      const s = this.slot(id);
      this.expire(s);
      if (s.vault.pvk) return this.connectionKey(id, s.vault.pvk);
      const k = this.sealRoot ? openConnectionKey(this.sealRoot, id) : null;
      if (!k) throw locked();
      return k;
    };
    const find = (/** @type {string} */ name) => this.allConnections(id, key()).find(i => i.name === name);
    return {
      has: async (/** @type {string} */ name) => Boolean(find(name)),
      get: async (/** @type {string} */ name) => { const it = find(name); if (!it) throw Object.assign(new Error(`no item named ${name}: check the name in your own vault`), { code: "not_found" }); const { fileId, ...rest } = it; void fileId; return rest; },
      /** Make the connection, or replace its fields (a refresh merges: pass only what changed). */
      put: async (/** @type {string} */ name, /** @type {string} */ description, /** @type {any} */ fields) => {
        if (!NAME.test(String(name || ""))) throw new Error("a name is letters, digits, dot, dash and underscore, up to 128");
        const k = key(), clean = PeopleVaults.clean(fields), it = this.allConnections(id, k).find(i => i.name === name);
        if (it) { this.writeConnection(id, it.fileId, { name, kind: "connection", description: it.description, updated: this.clock() }, { ...it.fields, ...clean }, k); return { name, created: false }; }
        if (this.allConnections(id, k).length >= MAX_ITEMS) throw new Error(`a vault holds up to ${MAX_ITEMS} connections`);
        this.writeConnection(id, crypto.randomBytes(12).toString("hex"), { name, kind: "connection", description: String(description || "").slice(0, 500), updated: this.clock() }, clean, k);
        return { name, created: true };
      },
      update: async (/** @type {string} */ name, /** @type {any} */ fields) => {
        const k = key(), it = this.allConnections(id, k).find(i => i.name === name);
        if (!it) throw Object.assign(new Error(`no item named ${name}: check the name in your own vault`), { code: "not_found" });
        this.writeConnection(id, it.fileId, { name, kind: "connection", description: it.description, updated: this.clock() }, { ...it.fields, ...PeopleVaults.clean(fields) }, k);
      },
    };
  }

  // ---- the lend key ----
  // What a member lends to an agent (a login for the agent's Chrome to fill while she is away) is a copy of that one item, kept in HER vault under a LEND KEY of its own, built exactly like the connection key:
  // the key lives inside her vault (wrapped by the vault key, `lk.json`), and only it is sealed for the server (people-seal.js, purpose "lend"). The Space's vault tools never reach a member's vault, so the
  // owner and the admins can neither list nor reveal a lent copy, and the sealed key opens lent copies and nothing else of hers: not her passwords, not her notes, not her connections.

  /** @param {string} id @param {import("node:crypto").KeyObject} pvk */
  lendKey(id, pvk) {
    const file = path.join(this.folder(id), LK_FILE);
    if (fs.existsSync(file)) {
      const body = openItemV2(pvk, this.at(id, "lk"), JSON.parse(fs.readFileSync(file, "utf8")));
      return keyObject(Buffer.from(body.fields.lk, "base64"));
    }
    const raw = crypto.randomBytes(32);
    this.writeLk(id, pvk, raw);
    return keyObject(raw);
  }

  /** @param {string} id @param {import("node:crypto").KeyObject} pvk @param {Buffer} raw */
  writeLk(id, pvk, raw) {
    const file = path.join(this.folder(id), LK_FILE), tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(sealItemV2(pvk, this.at(id, "lk"), { meta: { name: "lk" }, fields: { lk: Buffer.from(raw).toString("base64") } })), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** A forgotten password was reset: the lent copies get a new key and the server's seal follows. @param {string} id @param {{ vault: Vault }} s */
  rotateLendKey(id, s) {
    const pvk = s.vault.pvk;
    if (!pvk) return;
    const items = this.allLent(id, this.lendKey(id, pvk));
    const next = crypto.randomBytes(32);
    const nextKey = keyObject(Buffer.from(next));
    for (const it of items) this.writeLent(id, it.fileId, { name: it.name, kind: it.kind, description: it.description, updated: it.updated }, it.fields, nextKey);
    this.writeLk(id, pvk, next);
    this.seal(id, s);
  }

  /**
   * The copies a member lent, for the agents' side (agentFill) and for the share tools: opened with the lend key, the vault's when she is unlocked, else the sealed server copy. It reads and writes lent
   * copies and nothing else, by construction. Throws code "locked" when there is no seal and she is not unlocked. A copy is made while she is unlocked (the share tool reads her item first).
   * @param {string} id
   */
  lent(id) {
    PeopleVaults.check(id);
    const key = () => {
      const s = this.slot(id);
      this.expire(s);
      if (s.vault.pvk) return this.lendKey(id, s.vault.pvk);
      const k = this.sealRoot ? openConnectionKey(this.sealRoot, id, "lend") : null;
      if (!k) throw locked();
      return k;
    };
    const find = (/** @type {string} */ name) => this.allLent(id, key()).find(i => i.name === name);
    return {
      has: async (/** @type {string} */ name) => Boolean(find(name)),
      names: async () => this.allLent(id, key()).map(i => i.name),
      get: async (/** @type {string} */ name) => { const it = find(name); if (!it) throw Object.assign(new Error(`no lent item named ${name}: ask the member to share it again`), { code: "not_found" }); const { fileId, ...rest } = it; void fileId; return rest; },
      /** Keep a copy of one item (replacing an earlier copy of the same name). */
      put: async (/** @type {string} */ name, /** @type {{ kind: string, description?: string, fields: any }} */ item) => {
        if (!NAME.test(String(name || ""))) throw new Error("a name is letters, digits, dot, dash and underscore, up to 128");
        if (!KIND.test(String(item && item.kind))) throw new Error("a kind is lowercase letters, digits and dashes");
        const k = key(), clean = PeopleVaults.clean(item.fields), it = this.allLent(id, k).find(i => i.name === name);
        const meta = { name, kind: item.kind, description: String(item.description || "").slice(0, 500), updated: this.clock() };
        if (it) { this.writeLent(id, it.fileId, meta, clean, k); return { name, created: false }; }
        if (this.allLent(id, k).length >= MAX_ITEMS) throw new Error(`a vault lends up to ${MAX_ITEMS} items`);
        this.writeLent(id, crypto.randomBytes(12).toString("hex"), meta, clean, k);
        return { name, created: true };
      },
      /** Delete the copy (unshare, revoke): the file goes, and so does anything it held. */
      remove: async (/** @type {string} */ name) => {
        const it = find(name);
        if (!it) return { removed: false };
        fs.rmSync(path.join(this.lendDir(id), it.fileId + ".json"), { force: true });
        return { removed: true };
      },
    };
  }

  lendDir(/** @type {string} */ id) { const d = path.join(this.folder(id), LEND_ITEMS); ensureDir(d); return d; }
  atLend(/** @type {string} */ person, /** @type {string} */ fileId) { return { vault: "me-lend:" + person, kv: KV, id: fileId, ver: 1, name: fileId }; }

  /** @param {string} id @param {import("node:crypto").KeyObject} lk */
  allLent(id, lk) {
    const dir = this.lendDir(id);
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const fileId = f.slice(0, -5);
      try {
        const body = openItemV2(lk, this.atLend(id, fileId), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
        out.push({ fileId, name: String(body.meta.name), kind: String(body.meta.kind), description: String(body.meta.description || ""), updated: Number(body.meta.updated), fields: body.fields });
      } catch { /* not whole, or sealed under an older key: skipped */ }
    }
    return out;
  }

  writeLent(/** @type {string} */ id, /** @type {string} */ fileId, /** @type {any} */ meta, /** @type {any} */ fields, /** @type {import("node:crypto").KeyObject} */ lk) {
    const file = path.join(this.lendDir(id), fileId + ".json");
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(sealItemV2(lk, this.atLend(id, fileId), { meta, fields })), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  itemDir(/** @type {string} */ id) { const d = path.join(this.folder(id), ITEMS); ensureDir(d); return d; }
  connDir(/** @type {string} */ id) { const d = path.join(this.folder(id), CONN_ITEMS); ensureDir(d); return d; }

  at(/** @type {string} */ person, /** @type {string} */ fileId) { return { vault: "me:" + person, kv: KV, id: fileId, ver: 1, name: fileId }; }
  atConn(/** @type {string} */ person, /** @type {string} */ fileId) { return { vault: "me-conn:" + person, kv: KV, id: fileId, ver: 1, name: fileId }; }

  /** Every ordinary item the person can open: { fileId, name, kind, fields }. A file that does not open (another person's, or damaged) is skipped, and so is anything of kind "connection": those live under their own key. @param {string} id */
  all(id) {
    const k = this.key(id);
    const dir = this.itemDir(id);
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const fileId = f.slice(0, -5);
      try {
        const body = openItemV2(k, this.at(id, fileId), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
        if (String(body.meta.kind) === "connection") continue;
        out.push({ fileId, name: String(body.meta.name), kind: String(body.meta.kind), description: String(body.meta.description || ""), updated: Number(body.meta.updated), fields: body.fields });
      } catch { /* not this person's, or not whole: skipped, never read */ }
    }
    return out;
  }

  /** Every connection item, opened with the connection key. @param {string} id @param {import("node:crypto").KeyObject} ck */
  allConnections(id, ck) {
    const dir = this.connDir(id);
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const fileId = f.slice(0, -5);
      try {
        const body = openItemV2(ck, this.atConn(id, fileId), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
        out.push({ fileId, name: String(body.meta.name), kind: "connection", description: String(body.meta.description || ""), updated: Number(body.meta.updated), fields: body.fields });
      } catch { /* not whole, or sealed under an older key: skipped */ }
    }
    return out;
  }

  write(/** @type {string} */ id, /** @type {string} */ fileId, /** @type {any} */ meta, /** @type {any} */ fields) {
    const k = this.key(id);
    const file = path.join(this.itemDir(id), fileId + ".json");
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(sealItemV2(k, this.at(id, fileId), { meta, fields })), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  writeConnection(/** @type {string} */ id, /** @type {string} */ fileId, /** @type {any} */ meta, /** @type {any} */ fields, /** @type {import("node:crypto").KeyObject} */ ck) {
    const file = path.join(this.connDir(id), fileId + ".json");
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(sealItemV2(ck, this.atConn(id, fileId), { meta, fields })), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** @param {any} fields */
  static clean(fields) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("fields must be an object");
    const out = /** @type {Record<string, string>} */ ({});
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === "") continue;
      if (!FIELD.test(k)) throw new Error(`field name "${k}" is not allowed`);
      if (typeof v !== "string") throw new Error(`field ${k} must be text`);
      if (v.length > MAX_VALUE) throw new Error(`field ${k} is larger than 64 KB`);
      out[k] = v;
    }
    if (!Object.keys(out).length) throw new Error("an item needs at least one field");
    return out;
  }

  /** @param {string} id @param {{ name: string, kind?: string, description?: string, fields: any }} input */
  async put(id, { name, kind = "secret", description = "", fields }) {
    if (!NAME.test(String(name || ""))) throw new Error("a name is letters, digits, dot, dash and underscore, up to 128");
    if (!KIND.test(String(kind))) throw new Error("a kind is lowercase letters, digits and dashes");
    if (kind === "connection") throw Object.assign(new Error("a connection is made by signing in to an app (Connect), not typed in here"), { code: "denied" });
    const clean = PeopleVaults.clean(fields);
    const have = this.all(id);
    if (have.some(i => i.name === name) || this.hasConnection(id, name)) throw new Error(`${name} already exists: update it`);
    if (have.length >= MAX_ITEMS) throw new Error(`a vault holds up to ${MAX_ITEMS} items`);
    this.write(id, crypto.randomBytes(12).toString("hex"), { name, kind, description: String(description).slice(0, 500), updated: this.clock() }, clean);
    return { name, kind, created: true };
  }

  /** Whether a connection of this name exists, for a person who is unlocked. @param {string} id @param {string} name */
  hasConnection(id, name) { return this.allConnections(id, this.connectionKey(id, this.key(id))).some(i => i.name === name); }

  /** @param {string} id @param {{ name: string, fields?: any, description?: string }} input */
  async update(id, { name, fields, description }) {
    if (this.hasConnection(id, name)) throw Object.assign(new Error("a connection is changed by connecting again, not edited here: connect the app again"), { code: "denied" });
    const it = this.all(id).find(i => i.name === name);
    if (!it) throw new Error(`no item named ${name}: check the name in your own vault`);
    const next = fields === undefined ? it.fields : { ...it.fields, ...PeopleVaults.clean(fields) };
    this.write(id, it.fileId, { name, kind: it.kind, description: description === undefined ? it.description : String(description).slice(0, 500), updated: this.clock() }, next);
    await this.onItem(id, name);
    return { name, kind: it.kind, created: false };
  }

  /** One item. A connection shows what it connects to and never a token: its secret fields are not returned to anyone, the person included. @param {string} id @param {{ name: string }} input */
  async get(id, { name }) {
    const it = this.all(id).find(i => i.name === name);
    if (it) { const { fileId, ...rest } = it; void fileId; return rest; }
    const c = this.allConnections(id, this.connectionKey(id, this.key(id))).find(i => i.name === name);
    if (!c) throw new Error(`no item named ${name}: check the name in your own vault`);
    const { fileId, fields, ...rest } = c; void fileId;
    return { ...rest, fields: Object.fromEntries(Object.entries(fields).filter(([k]) => CONNECTION_PUBLIC.has(k))) };
  }

  /** Names and kinds, never a value. @param {string} id @param {{ filter?: string }} [input] */
  async list(id, { filter } = {}) {
    const f = filter ? String(filter).toLowerCase() : "";
    const conns = this.allConnections(id, this.connectionKey(id, this.key(id)));
    const items = [...this.all(id), ...conns].filter(i => !f || i.name.toLowerCase().includes(f)).map(i => ({ name: i.name, kind: i.kind, description: i.description, fields: Object.keys(i.fields), updated: i.updated, ...(i.kind === "login" ? { sites: sitesOf(i.fields) } : {}) }));
    return { items };
  }

  /** @param {string} id @param {{ name: string }} input */
  async remove(id, { name }) {
    const it = this.all(id).find(i => i.name === name);
    if (it) { fs.rmSync(path.join(this.itemDir(id), it.fileId + ".json"), { force: true }); await this.onItem(id, name); return { removed: name }; }
    const c = this.allConnections(id, this.connectionKey(id, this.key(id))).find(i => i.name === name);
    if (!c) throw new Error(`no item named ${name}: check the name in your own vault`);
    fs.rmSync(path.join(this.connDir(id), c.fileId + ".json"), { force: true });
    return { removed: name };
  }

  /**
   * The store other modules code against (member-mcp: MCP and mail connections; space-list-wire: the space list). One person's own items as JSON values under a key, in that person's vault.
   * `person` must come from the kernel's verified chain, never from a tool's input; `space` is accepted for the shape and not used yet (a person has one vault per server). Every call is async and throws
   * code "locked" when the person has not unlocked (a session reads only while their lease is live: no lease, no entries). The caller of this can read one person's items only, the id it was given.
   * @param {string} person @param {string} [space]
   */
  personalStore(person, space) {
    PeopleVaults.check(person); void space;
    const PREFIX = "store.";
    const key = (/** @type {string} */ k) => { if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(String(k))) throw new Error("a store key is letters, digits, dot, dash, underscore and slash"); return PREFIX + String(k).replace(/\//g, "__"); };
    return {
      /** @returns {Promise<any|null>} */
      get: async (/** @type {string} */ k) => { try { return JSON.parse((await this.get(person, { name: key(k) })).fields.json); } catch (e) { if (/no item named/.test(/** @type {Error} */ (e).message)) return null; throw e; } },
      put: async (/** @type {string} */ k, /** @type {any} */ value) => {
        const json = JSON.stringify(value);
        if (json === undefined || json.length > MAX_VALUE) throw new Error("a store value is JSON up to 64 KB");
        const name = key(k);
        if (this.all(person).some(i => i.name === name)) await this.update(person, { name, fields: { json } });
        else await this.put(person, { name, kind: "store", fields: { json } });
      },
      list: async () => this.all(person).filter(i => i.name.startsWith(PREFIX)).map(i => ({ key: i.name.slice(PREFIX.length).replace(/__/g, "/"), value: JSON.parse(i.fields.json) })),
      remove: async (/** @type {string} */ k) => { try { await this.remove(person, { name: key(k) }); return true; } catch (e) { if (/no item named/.test(/** @type {Error} */ (e).message)) return false; throw e; } },
    };
  }

  close() {
    for (const [id, s] of this.open) { try { s.vault.lockAccount("close"); } catch {} try { s.db.close(); } catch {} this.open.delete(id); }
  }
}
