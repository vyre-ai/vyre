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
import { sealItemV2, openItemV2 } from "./crypto.js";

export const PERSON_ID = /^per_[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[A-Za-z0-9._-]{1,128}$/;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const FIELD = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_VALUE = 64 * 1024, MAX_ITEMS = 500;
const ITEMS = "me-items";
const KV = 1;

/** The age of idleness after which a person's vault locks again. */
export const IDLE_MS = 8 * 60 * 60 * 1000;

const locked = () => Object.assign(new Error("your vault is locked: unlock it with your master password"), { code: "locked" });

export class PeopleVaults {
  /** @param {{ dir: string, config?: any, emit?: (t: string, p: object) => void, log?: (m: string) => void, testKdf?: any, clock?: () => number, idleMs?: number }} o */
  constructor({ dir, config, emit = () => {}, log = () => {}, testKdf = null, clock = Date.now, idleMs = IDLE_MS }) {
    this.dir = dir; this.config = config; this.emit = emit; this.log = log; this.testKdf = testKdf; this.clock = clock; this.idleMs = idleMs;
    /** @type {Map<string, { vault: Vault, db: any, last: number, sk: string | null, queue: Promise<any> }>} */ this.open = new Map();
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

  itemDir(/** @type {string} */ id) { const d = path.join(this.folder(id), ITEMS); ensureDir(d); return d; }

  at(/** @type {string} */ person, /** @type {string} */ fileId) { return { vault: "me:" + person, kv: KV, id: fileId, ver: 1, name: fileId }; }

  /** Every item the person can open: { fileId, name, kind, fields }. A file that does not open (another person's, or damaged) is skipped. @param {string} id */
  all(id) {
    const k = this.key(id);
    const dir = this.itemDir(id);
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const fileId = f.slice(0, -5);
      try {
        const body = openItemV2(k, this.at(id, fileId), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
        out.push({ fileId, name: String(body.meta.name), kind: String(body.meta.kind), description: String(body.meta.description || ""), updated: Number(body.meta.updated), fields: body.fields });
      } catch { /* not this person's, or not whole: skipped, never read */ }
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
    const clean = PeopleVaults.clean(fields);
    const have = this.all(id);
    if (have.some(i => i.name === name)) throw new Error(`${name} already exists: update it`);
    if (have.length >= MAX_ITEMS) throw new Error(`a vault holds up to ${MAX_ITEMS} items`);
    this.write(id, crypto.randomBytes(12).toString("hex"), { name, kind, description: String(description).slice(0, 500), updated: this.clock() }, clean);
    return { name, kind, created: true };
  }

  /** @param {string} id @param {{ name: string, fields?: any, description?: string }} input */
  async update(id, { name, fields, description }) {
    const it = this.all(id).find(i => i.name === name);
    if (!it) throw new Error(`no item named ${name}`);
    const next = fields === undefined ? it.fields : { ...it.fields, ...PeopleVaults.clean(fields) };
    this.write(id, it.fileId, { name, kind: it.kind, description: description === undefined ? it.description : String(description).slice(0, 500), updated: this.clock() }, next);
    return { name, kind: it.kind, created: false };
  }

  /** @param {string} id @param {{ name: string }} input */
  async get(id, { name }) {
    const it = this.all(id).find(i => i.name === name);
    if (!it) throw new Error(`no item named ${name}`);
    const { fileId, ...rest } = it; void fileId;
    return rest;
  }

  /** Names and kinds, never a value. @param {string} id @param {{ filter?: string }} [input] */
  async list(id, { filter } = {}) {
    const f = filter ? String(filter).toLowerCase() : "";
    const items = this.all(id).filter(i => !f || i.name.toLowerCase().includes(f)).map(i => ({ name: i.name, kind: i.kind, description: i.description, fields: Object.keys(i.fields), updated: i.updated }));
    return { items };
  }

  /** @param {string} id @param {{ name: string }} input */
  async remove(id, { name }) {
    const it = this.all(id).find(i => i.name === name);
    if (!it) throw new Error(`no item named ${name}`);
    fs.rmSync(path.join(this.itemDir(id), it.fileId + ".json"), { force: true });
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
