// @ts-check
// vault — items, grants, passes and the audit trail, behind one class the tools call.
//
// The shape of the whole thing is in docs/adr/0001-vault-crypto.md. Three habits run through
// every method here:
//   - A value is opened only at the moment it is handed to the one thing allowed to have it (a
//     granted module, a `vyre vault run` child, a relayed request) and is never returned from
//     anything else. Listings, errors, events and audit rows carry names.
//   - Every release, refusal and relay is an audit row, so "who used what" has an answer after
//     the fact, not only in theory.
//   - Giving access needs a person; taking it away never does. An agent's grants and passes
//     wait as pending until someone approves them.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sealItem, openItem, newIdentity, sealFor, openFrom } from "./crypto.js";
import { keystore, defaultKind } from "./keys.js";
import { ensureDir, writeSealed, readSealed, removeSealed } from "./store.js";
import * as relay from "./relay.js";
import { callerKind } from "../modules/index.js";
import { parse as parseImport, merge as mergeImport } from "./import.js";
import { totp } from "./totp.js";
import { generate } from "./generate.js";

export const MIGRATIONS = [
  `CREATE TABLE vault_items (
     id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
     fields TEXT NOT NULL, url TEXT, hosts TEXT NOT NULL DEFAULT '[]', origin TEXT, rotate TEXT,
     created INTEGER NOT NULL, updated INTEGER NOT NULL
   );
   CREATE TABLE vault_grants (
     id TEXT PRIMARY KEY, item TEXT NOT NULL, module TEXT NOT NULL, watcher TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (item, module, watcher)
   );
   CREATE TABLE vault_audit (
     id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, name TEXT, who TEXT NOT NULL,
     ok INTEGER NOT NULL, why TEXT
   );
   CREATE INDEX vault_audit_name ON vault_audit (name, id);
   CREATE TABLE vault_people (
     name TEXT PRIMARY KEY, sign TEXT NOT NULL, box TEXT NOT NULL, relay TEXT, added INTEGER NOT NULL
   );
   CREATE TABLE vault_passes (
     id TEXT PRIMARY KEY, holder TEXT NOT NULL, holder_sign TEXT NOT NULL, holder_box TEXT NOT NULL,
     items TEXT NOT NULL, mode TEXT NOT NULL, hosts TEXT, expires INTEGER, note TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL, by TEXT NOT NULL, created INTEGER NOT NULL, issued INTEGER, revoked INTEGER
   );
   CREATE TABLE vault_held (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, relay TEXT NOT NULL, owner_sign TEXT NOT NULL,
     items TEXT NOT NULL, mode TEXT NOT NULL, expires INTEGER, accepted INTEGER NOT NULL
   );`,
];

export const KINDS = ["secret", "api-key", "login", "card", "note", "env-set"];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODULE = /^[a-z][a-z0-9-]{1,40}$/;
const PERSON = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/;
/** The field a kind hands over when nobody names one. env-set has none: name the variable. */
const DEFAULT_FIELD = { secret: "value", "api-key": "value", login: "password", card: "number", note: "text", "env-set": null };
const MAX_VALUE = 64 * 1024;
const IDENTITY = "identity";

const now = () => Date.now();
const newId = () => crypto.randomBytes(9).toString("base64url");
const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };

/** A caller's kind, as the registry sees it. */
const kindOf = callerKind;
const moduleOf = c => (String(c).startsWith("module:") ? String(c).slice(7) : null);

/** "30d", "12h", "90m", an ISO date or ms since epoch, to ms since epoch. */
export function parseExpiry(v, from = now()) {
  if (v === undefined || v === null || v === "") return from + 30 * 86400_000;
  if (typeof v === "number") return v;
  const m = /^(\d+)\s*([mhdw])$/.exec(String(v).trim());
  if (m) return from + Number(m[1]) * { m: 60_000, h: 3600_000, d: 86400_000, w: 7 * 86400_000 }[m[2]];
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw new Error(`expires "${v}" is not a duration like 30d or a date`);
  return t;
}

/** An origin ("https://api.example.com") from anything that parses as an http(s) URL. */
export function origin(u) {
  try { const x = new URL(String(u)); return ["http:", "https:"].includes(x.protocol) ? x.origin : null; } catch { return null; }
}

export class Vault {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, dir: string, config: any, emit: (type: string, payload: object) => void, log?: (m: string) => void }} deps
   */
  constructor({ db, dir, config, emit, log = () => {} }) {
    this.db = db; this.dir = dir; this.emit = emit; this.log = log;
    const opts = (config && config.vault) || {};
    this.name = (config && config.name) || "vyre";
    this.kind = opts.keystore || defaultKind();
    this.guarded = this.kind === "keychain" && !opts.keychain && Boolean(process.env.NODE_TEST_CONTEXT);
    this.keys = keystore({ dir, kind: this.kind, keychain: opts.keychain });
    /** @type {Buffer|null} */
    this.mk = null;
    /** Nonces seen on the relay listener, for replay refusal. */
    this.seen = new Map();
    /** Set by index.js once the relay listener is up. */
    this.relayUrl = opts.relay && opts.relay.url ? String(opts.relay.url) : null;
    ensureDir(dir);
  }

  // ---- keys -----------------------------------------------------------------------------

  /** The master key, loaded (or made, the first time) on first use rather than at start. */
  async key() {
    if (this.mk) return this.mk;
    // Under node --test the real login keychain is out of bounds: a test that forgot to pick a
    // keystore must fail loudly, not quietly write a key into someone's keychain.
    if (this.guarded) throw new Error("under tests the keychain keystore needs vault.keychain (a temporary keychain file)");
    if (await this.keys.exists()) {
      const mk = await this.keys.load();
      if (!mk) throw Object.assign(new Error("the vault is locked · vyre vault unlock"), { code: "locked" });
      this.mk = mk;
    } else {
      if (this.kind === "passphrase") throw Object.assign(new Error("the vault has no passphrase yet · vyre vault unlock sets one"), { code: "locked" });
      this.mk = await this.keys.create();
      this.log(`vault key created in the ${this.kind} keystore`);
    }
    return this.mk;
  }

  async unlock(passphrase) {
    if (this.kind !== "passphrase") { await this.key(); return { unlocked: true, keystore: this.kind }; }
    this.mk = (await this.keys.exists()) ? await this.keys.load({ passphrase }) : await this.keys.create({ passphrase });
    return { unlocked: true, keystore: this.kind };
  }

  lock() {
    if (this.mk) this.mk.fill(0);
    this.mk = null;
    return { locked: true, keystore: this.kind, relocks: this.kind !== "passphrase" };
  }

  async locked() {
    if (this.mk) return false;
    return this.kind === "passphrase";
  }

  // ---- audit ----------------------------------------------------------------------------

  audit(action, name, who, ok = true, why = null) {
    this.db.prepare("INSERT INTO vault_audit (at, action, name, who, ok, why) VALUES (?,?,?,?,?,?)").run(now(), action, name ?? null, String(who), ok ? 1 : 0, why);
  }

  auditTrail({ name, limit = 100 } = {}) {
    const rows = name
      ? this.db.prepare("SELECT * FROM vault_audit WHERE name = ? ORDER BY id DESC LIMIT ?").all(name, Math.min(1000, limit))
      : this.db.prepare("SELECT * FROM vault_audit ORDER BY id DESC LIMIT ?").all(Math.min(1000, limit));
    return { entries: rows.map(r => ({ at: r.at, action: r.action, name: r.name, who: r.who, ok: Boolean(r.ok), why: r.why })) };
  }

  // ---- items ----------------------------------------------------------------------------

  row(name) { return /** @type {any} */ (this.db.prepare("SELECT * FROM vault_items WHERE name = ?").get(String(name))); }

  mustRow(name) {
    const r = this.row(name);
    if (!r) throw new Error(`no item named ${name}`);
    return r;
  }

  /** An item's fields, opened. Only the methods that hand a value to its one recipient call this. */
  async fields(r) {
    const sealed = readSealed(this.dir, r.id);
    if (!sealed) throw new Error(`the sealed copy of ${r.name} is missing`);
    return openItem(await this.key(), r.id, r.name, sealed);
  }

  /**
   * Add or replace an item. The fields arrive from the CLI's hidden prompt, an import file or a
   * sealed pass; the tool layer refuses them from Claude.
   */
  async put({ name, kind = "secret", description = "", fields, url, hosts, origin: from }, who) {
    if (!NAME.test(String(name || ""))) throw new Error("a name is letters, digits, dot, dash and underscore, up to 128");
    if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("fields must be an object");
    const clean = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === "") continue;
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) throw new Error(`field name "${k}" is not allowed`);
      if (typeof v !== "string") throw new Error(`field ${k} must be text`);
      if (v.length > MAX_VALUE) throw new Error(`field ${k} is larger than 64 KB`);
      clean[k] = v;
    }
    const need = DEFAULT_FIELD[kind];
    if (need && !(need in clean) && !(kind === "login" && clean.username)) throw new Error(`a ${kind} needs a ${need}`);
    if (!Object.keys(clean).length) throw new Error("an item needs at least one field");
    if (kind === "env-set") for (const k of Object.keys(clean)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`env-set field ${k} is not an environment variable name`);
    const u = url ? String(url) : null;
    let h = Array.isArray(hosts) ? hosts.map(origin) : [];
    if (h.includes(null)) throw new Error("hosts must be origins such as https://api.example.com");
    if (!h.length && u && origin(u)) h = [/** @type {string} */ (origin(u))];

    const mk = await this.key();
    const old = this.row(name);
    const id = old ? old.id : newId();
    writeSealed(this.dir, id, sealItem(mk, id, name, clean));
    const t = now();
    if (old) {
      // Putting an item again is how it is rotated, so the rotate mark goes.
      this.db.prepare("UPDATE vault_items SET kind=?, description=?, fields=?, url=?, hosts=?, origin=COALESCE(?, origin), rotate=NULL, updated=? WHERE id=?")
        .run(kind, String(description || old.description || ""), JSON.stringify(Object.keys(clean)), u, JSON.stringify(h), from || null, t, id);
    } else {
      this.db.prepare("INSERT INTO vault_items (id, name, kind, description, fields, url, hosts, origin, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, name, kind, String(description || ""), JSON.stringify(Object.keys(clean)), u, JSON.stringify(h), from || null, t, t);
    }
    this.audit(old ? "change" : "add", name, who);
    this.emit(old ? "vault.item-changed" : "vault.item-added", { name, kind });
    return { name, kind, created: !old };
  }

  list({ filter } = {}) {
    const f = filter ? String(filter).toLowerCase() : "";
    const grants = this.db.prepare("SELECT item, module, watcher FROM vault_grants WHERE status = 'active'").all();
    const items = this.db.prepare("SELECT * FROM vault_items ORDER BY name").all()
      .filter(r => !f || String(r.name).toLowerCase().includes(f) || String(r.description).toLowerCase().includes(f))
      .map(r => ({
        name: r.name, kind: r.kind, description: r.description, fields: json(r.fields, []),
        ...(r.url ? { url: r.url } : {}), hosts: json(r.hosts, []), rotate: Boolean(r.rotate), ...(r.rotate ? { why: r.rotate } : {}),
        ...(r.origin ? { origin: r.origin } : {}), updated: r.updated,
        grants: grants.filter(g => g.item === r.name).map(g => ({ module: g.module, ...(g.watcher ? { watcher: g.watcher } : {}) })),
      }));
    return { locked: this.kind === "passphrase" && !this.mk, keystore: this.kind, items };
  }

  remove({ name }, who) {
    const r = this.mustRow(name);
    const inPass = this.activePasses().find(p => p.items.includes(name));
    if (inPass) throw new Error(`${name} is in pass ${inPass.id}; revoke the pass first`);
    removeSealed(this.dir, r.id);
    this.db.prepare("DELETE FROM vault_items WHERE id = ?").run(r.id);
    this.db.prepare("DELETE FROM vault_grants WHERE item = ?").run(name);
    this.audit("delete", name, who);
    this.emit("vault.item-deleted", { name });
    return { deleted: name };
  }

  /** Logins for a page, for autofill: names and hosts only. */
  match({ url }) {
    const o = origin(url);
    if (!o) return { logins: [] };
    const host = new URL(o).hostname;
    const logins = this.db.prepare("SELECT name, description, url, hosts FROM vault_items WHERE kind = 'login'").all()
      .filter(r => json(r.hosts, []).includes(o) || (r.url && origin(r.url) && new URL(/** @type {string} */ (origin(r.url))).hostname === host))
      .map(r => ({ name: r.name, description: r.description, url: r.url }));
    return { logins };
  }

  // ---- grants and release ---------------------------------------------------------------

  grant({ name, module, watcher = "" }, caller) {
    const item = this.mustRow(name);
    // A module grants only items it put itself (index.js lets it do so only through vault.put).
    if (kindOf(caller) === "module" && item.origin !== caller) throw new Error(`${moduleOf(caller)} may grant only items it put`);
    if (!MODULE.test(String(module))) throw new Error(`"${module}" is not a module name`);
    const status = kindOf(caller) === "mcp" ? "pending" : "active";
    const old = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_grants WHERE item=? AND module=? AND watcher=?").get(name, module, watcher));
    if (old && old.status === "active") return { grant: this.grantOut(old) };
    const id = old ? old.id : "g_" + newId();
    this.db.prepare("INSERT OR REPLACE INTO vault_grants (id, item, module, watcher, status, by, at) VALUES (?,?,?,?,?,?,?)").run(id, name, module, watcher, status, String(caller), now());
    const g = this.db.prepare("SELECT * FROM vault_grants WHERE id=?").get(id);
    this.audit(status === "active" ? "grant" : "grant-requested", name, caller, true, watcher ? `${module}/${watcher}` : module);
    this.emit(status === "active" ? "vault.granted" : "grant.requested", { name, module, ...(watcher ? { watcher } : {}) });
    return { grant: this.grantOut(g) };
  }

  grantOut(g) { return { id: g.id, name: g.item, module: g.module, ...(g.watcher ? { watcher: g.watcher } : {}), status: g.status }; }

  revoke({ name, module, watcher }, caller) {
    const r = watcher === undefined
      ? this.db.prepare("DELETE FROM vault_grants WHERE item=? AND module=?").run(name, module)
      : this.db.prepare("DELETE FROM vault_grants WHERE item=? AND module=? AND watcher=?").run(name, module, watcher);
    const n = Number(r.changes);
    this.audit("revoke", name, caller, true, watcher ? `${module}/${watcher}` : module);
    if (n) this.emit("vault.revoked", { name, module, ...(watcher ? { watcher } : {}) });
    return { revoked: n };
  }

  /**
   * Hand one value to one module. The grant is the boundary: the loader's needs.vault check is
   * only a courtesy, since a module could reach this tool through ctx.call directly.
   */
  async release({ name, field, watcher = "" }, caller) {
    const mod = moduleOf(caller);
    const who = watcher ? `${caller}/${watcher}` : String(caller);
    if (!mod) { this.audit("release", name, who, false, "not a module"); throw new Error("only modules may ask the vault for a value"); }
    const g = this.db.prepare("SELECT 1 FROM vault_grants WHERE item=? AND module=? AND watcher=? AND status='active'").get(name, mod, watcher);
    if (!g) {
      this.audit("release", name, who, false, "no grant");
      throw new Error(`${name} is not granted to ${watcher ? `${mod}/${watcher}` : mod} · vyre vault grant ${name} ${mod}${watcher ? ` --watcher ${watcher}` : ""}`);
    }
    const r = this.row(name);
    if (!r) { this.audit("release", name, who, false, "no such item"); throw new Error(`no item named ${name}`); }
    const f = await this.fields(r);
    const want = field || DEFAULT_FIELD[r.kind];
    if (!want) { this.audit("release", name, who, false, "no field named"); throw new Error(`${name} is an env-set; name the field you want`); }
    if (!(want in f)) { this.audit("release", name, who, false, `no field ${want}`); throw new Error(`${name} has no field ${want}`); }
    this.audit("release", name, who, true, field ? `field ${field}` : null);
    this.emit("vault.released", { name, module: mod, ...(watcher ? { watcher } : {}) });
    return { value: f[want] };
  }

  /** Values for `vyre vault run`: env var name to value. Only the CLI and local clients get here. */
  async inject({ items }, caller, envName) {
    const env = {};
    for (const it of items) {
      const r = this.row(it.name);
      if (!r) { this.audit("inject", it.name, caller, false, "no such item"); throw new Error(`no item named ${it.name}`); }
      const f = await this.fields(r);
      if (r.kind === "env-set" && !it.field) Object.assign(env, f);
      else {
        const want = it.field || DEFAULT_FIELD[r.kind];
        if (!want || !(want in f)) throw new Error(`${it.name} has no field ${want || "(name one)"}`);
        env[it.env || envName(it.name)] = f[want];
      }
      this.audit("inject", it.name, caller);
      this.emit("vault.released", { name: it.name, module: "run" });
    }
    return { env };
  }

  async code({ name }, caller) {
    const r = this.mustRow(name);
    const mod = moduleOf(caller);
    if (mod && !this.db.prepare("SELECT 1 FROM vault_grants WHERE item=? AND module=? AND status='active'").get(name, mod)) {
      this.audit("totp", name, caller, false, "no grant");
      throw new Error(`${name} is not granted to ${mod}`);
    }
    const f = await this.fields(r);
    if (!f.totp) throw new Error(`${name} has no one-time password`);
    const c = totp(f.totp);
    this.audit("totp", name, caller);
    return { code: c.code, remaining: c.remaining };
  }

  async generate({ length, words, symbols, name, description }, caller) {
    const g = generate({ length, words, symbols });
    if (!name) return { value: g.value, bits: g.bits };
    const r = this.row(name);
    if (r && r.kind === "login") {
      const f = await this.fields(r);
      await this.put({ name, kind: "login", description: r.description, fields: { ...f, password: g.value }, url: r.url, hosts: json(r.hosts, []) }, caller);
    } else if (r) {
      throw new Error(`${name} already exists; generate into a new name or a login`);
    } else {
      await this.put({ name, kind: "secret", description: description || "generated", fields: { value: g.value } }, caller);
    }
    return { bits: g.bits, stored: name };
  }

  /** Read an export file and add what is new. The file is left as it is; the user deletes it. */
  async import({ file, format }, caller) {
    const p = path.resolve(String(file));
    const st = fs.statSync(p);
    if (!st.isFile()) throw new Error(`${p} is not a file`);
    if (st.size > 20 * 1024 * 1024) throw new Error(`${p} is larger than 20 MB`);
    const parsed = parseImport(fs.readFileSync(p, "utf8"), { format, filename: path.basename(p) });
    if (parsed.error) throw new Error(parsed.error);
    const existing = this.db.prepare("SELECT name FROM vault_items").all().map(r => String(r.name));
    const { add, duplicate } = mergeImport(existing, parsed.items);
    const added = [], skipped = [...parsed.skipped];
    for (const it of add) {
      try { await this.put({ ...it, origin: `import:${parsed.format}` }, caller); added.push(it.name); }
      catch (e) { skipped.push(`${it.name}: ${/** @type {Error} */ (e).message}`); }
    }
    this.audit("import", null, caller, true, `${parsed.format}: ${added.length} added from ${path.basename(p)}`);
    return { format: parsed.format, added, duplicate, skipped,
      advice: `Delete ${p} now. It still holds every value in plain text, and nothing needs it again.` };
  }

  // ---- identity -------------------------------------------------------------------------

  async identity() {
    const mk = await this.key();
    let sealed = readSealed(this.dir, IDENTITY);
    if (!sealed) {
      const id = newIdentity();
      writeSealed(this.dir, IDENTITY, sealItem(mk, IDENTITY, IDENTITY, id));
      sealed = readSealed(this.dir, IDENTITY);
    }
    return openItem(mk, IDENTITY, IDENTITY, sealed);
  }

  async card() {
    const id = await this.identity();
    const card = { name: this.name, sign: id.sign.public, box: id.box.public, relay: this.relayUrl || "" };
    return { card: relay.encodeCard(card), name: card.name, relay: card.relay || null };
  }

  // ---- passes: the owner's side ---------------------------------------------------------

  activePasses() {
    const t = now();
    return this.db.prepare("SELECT * FROM vault_passes WHERE status='active' AND revoked IS NULL").all()
      .map(p => this.passOut(p)).filter(p => !p.expires || p.expires > t);
  }

  passOut(p) {
    return { id: p.id, holder: p.holder, items: json(p.items, []), mode: p.mode, ...(p.hosts ? { hosts: json(p.hosts, []) } : {}),
      expires: p.expires, note: p.note, status: p.revoked ? "revoked" : p.status, created: p.created, ...(p.revoked ? { revoked: p.revoked } : {}) };
  }

  async createPass({ holder, card, items, mode = "relayed", hosts, expires, note = "" }, caller) {
    if (!PERSON.test(String(holder || ""))) throw new Error("a holder is a person's name");
    if (!Array.isArray(items) || !items.length) throw new Error("a pass needs at least one item");
    if (!["relayed", "sealed"].includes(mode)) throw new Error("mode is relayed or sealed");
    let person = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_people WHERE name=?").get(holder));
    if (card) {
      const c = relay.decodeCard(card);
      if (person && person.sign !== c.sign && kindOf(caller) === "mcp") throw new Error(`${holder}'s card changed; a person must confirm that with vyre vault pass create`);
      this.db.prepare("INSERT OR REPLACE INTO vault_people (name, sign, box, relay, added) VALUES (?,?,?,?,?)").run(holder, c.sign, c.box, c.relay || null, now());
      person = this.db.prepare("SELECT * FROM vault_people WHERE name=?").get(holder);
    }
    if (!person) throw new Error(`no card for ${holder} yet: ask them to run vyre vault card and pass it with --card`);
    const narrowed = Array.isArray(hosts) && hosts.length ? hosts.map(origin) : null;
    if (narrowed && narrowed.includes(null)) throw new Error("hosts must be origins such as https://api.example.com");
    for (const n of items) {
      const r = this.mustRow(n);
      if (mode === "relayed") {
        const allowed = json(r.hosts, []).filter(h => !narrowed || narrowed.includes(h));
        if (!allowed.length) throw new Error(`${n} has no hosts it may be sent to, so it cannot be relayed · put it again with --host, or pass it sealed`);
      }
    }
    const id = "p_" + newId();
    const status = kindOf(caller) === "mcp" ? "pending" : "active";
    this.db.prepare("INSERT INTO vault_passes (id, holder, holder_sign, holder_box, items, mode, hosts, expires, note, status, by, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, holder, person.sign, person.box, JSON.stringify(items), mode, narrowed ? JSON.stringify(narrowed) : null, parseExpiry(expires), String(note), status, String(caller), now());
    this.audit(status === "active" ? "pass" : "pass-requested", null, caller, true, `${id} to ${holder}: ${items.join(", ")} (${mode})`);
    if (status === "pending") {
      this.emit("pass.requested", { pass: id, holder, items, mode });
      return { pass: this.passOut(this.db.prepare("SELECT * FROM vault_passes WHERE id=?").get(id)) };
    }
    return this.issue(id);
  }

  /** Make the ticket for an active pass. For a sealed pass this is when the items leave. */
  async issue(id) {
    const p = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_passes WHERE id=?").get(id));
    const me = await this.identity();
    const items = json(p.items, []);
    const ticket = { pass: p.id, owner: this.name, relay: this.relayUrl || "", ownerSign: me.sign.public, holder: p.holder, items, mode: p.mode, expires: p.expires };
    if (p.mode === "sealed") {
      ticket.sealed = {};
      for (const n of items) {
        const r = this.mustRow(n);
        ticket.sealed[n] = sealFor(p.holder_box, { kind: r.kind, description: r.description, fields: await this.fields(r), url: r.url, hosts: json(r.hosts, []) }, `vyre:pass:v1:${p.id}:${n}`);
      }
    } else if (!this.relayUrl) {
      throw new Error("this Vyre has no relay address, so a relayed pass cannot reach it · set vault.relay in config.json");
    }
    this.db.prepare("UPDATE vault_passes SET issued=? WHERE id=?").run(now(), id);
    this.emit("pass.created", { pass: p.id, holder: p.holder, items, mode: p.mode });
    return { pass: this.passOut(p), ticket: relay.encodeTicket(ticket) };
  }

  pending() {
    return {
      grants: this.db.prepare("SELECT * FROM vault_grants WHERE status='pending' ORDER BY at").all().map(g => ({ ...this.grantOut(g), by: g.by, at: g.at })),
      passes: this.db.prepare("SELECT * FROM vault_passes WHERE status='pending' AND revoked IS NULL ORDER BY created").all().map(p => ({ ...this.passOut(p), by: p.by })),
    };
  }

  async approve({ id }, caller) {
    const g = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_grants WHERE id=? AND status='pending'").get(id));
    if (g) {
      this.db.prepare("UPDATE vault_grants SET status='active', by=?, at=? WHERE id=?").run(String(caller), now(), id);
      this.audit("grant", g.item, caller, true, `approved ${g.module}${g.watcher ? "/" + g.watcher : ""}`);
      this.emit("vault.granted", { name: g.item, module: g.module, ...(g.watcher ? { watcher: g.watcher } : {}) });
      return { approved: this.grantOut({ ...g, status: "active" }) };
    }
    const p = this.db.prepare("SELECT * FROM vault_passes WHERE id=? AND status='pending' AND revoked IS NULL").get(id);
    if (p) {
      this.db.prepare("UPDATE vault_passes SET status='active', by=? WHERE id=?").run(String(caller), id);
      this.audit("pass", null, caller, true, `approved ${id}`);
      const out = await this.issue(id);
      return { approved: out.pass, ticket: out.ticket };
    }
    throw new Error(`nothing pending with id ${id}`);
  }

  passes() {
    return {
      passes: this.db.prepare("SELECT * FROM vault_passes ORDER BY created DESC").all().map(p => this.passOut(p)),
      held: this.db.prepare("SELECT * FROM vault_held ORDER BY accepted DESC").all().map(h => ({ id: h.id, owner: h.owner, items: json(h.items, []), mode: h.mode, expires: h.expires })),
    };
  }

  /** End a pass. A relayed pass stops working now; a sealed one names what must be rotated. */
  revokePass({ id }, caller) {
    const p = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_passes WHERE id=?").get(id));
    if (!p) throw new Error(`no pass ${id}`);
    if (p.revoked) return { revoked: false, rotate: [] };
    this.db.prepare("UPDATE vault_passes SET revoked=? WHERE id=?").run(now(), id);
    const rotate = p.mode === "sealed" && p.issued ? this.markRotate(p) : [];
    this.audit("pass-revoke", null, caller, true, `${id} from ${p.holder}`);
    this.emit("pass.revoked", { pass: id, holder: p.holder, rotate: rotate.length });
    return { revoked: true, rotate };
  }

  /** Items a sealed pass handed over that have not been put again since. */
  markRotate(p) {
    const out = [];
    for (const n of json(p.items, [])) {
      const r = this.row(n);
      if (!r || r.updated > p.issued) continue;
      this.db.prepare("UPDATE vault_items SET rotate=? WHERE id=?").run(`sealed to ${p.holder} by ${p.id}`, r.id);
      out.push(n);
    }
    return out;
  }

  /** Someone leaves: every pass they hold ends, their card is forgotten, and the list to rotate. */
  offboard({ person }, caller) {
    const all = this.db.prepare("SELECT * FROM vault_passes WHERE holder=?").all(person);
    const known = this.db.prepare("SELECT 1 FROM vault_people WHERE name=?").get(person);
    if (!all.length && !known) throw new Error(`no one called ${person} holds anything`);
    const revoked = [], rotate = new Set();
    for (const p of all) {
      if (!p.revoked) { this.db.prepare("UPDATE vault_passes SET revoked=? WHERE id=?").run(now(), p.id); revoked.push(p.id); }
      if (p.mode === "sealed" && p.issued) for (const n of this.markRotate(p)) rotate.add(n);
    }
    this.db.prepare("DELETE FROM vault_people WHERE name=?").run(person);
    this.audit("offboard", null, caller, true, `${person}: ${revoked.length} passes, ${rotate.size} to rotate`);
    this.emit("person.offboarded", { person, revoked: revoked.length, rotate: rotate.size });
    return { person, revoked, rotate: [...rotate].sort() };
  }

  /**
   * The relay listener's handler: a holder's signed request, checked against its pass, sent on
   * with the value added, and the value scrubbed from whatever comes back.
   */
  async onRelay(env) {
    const deny = (status, message) => ({ status, body: { error: { code: status === 403 ? "denied" : "bad_request", message } } });
    const p = env && typeof env.pass === "string" ? /** @type {any} */ (this.db.prepare("SELECT * FROM vault_passes WHERE id=?").get(env.pass)) : null;
    const who = p ? `pass:${p.id}:${p.holder}` : "pass:unknown";
    const refuse = why => { this.audit("relay", env && env.item, who, false, why); return deny(403, why); };
    if (!p) return refuse("no such pass");
    const why = relay.checkEnvelope(env, { holderKey: p.holder_sign, seen: this.seen });
    if (why) return refuse(why);
    if (p.revoked) return refuse("this pass was revoked");
    if (p.status !== "active") return refuse("this pass is not approved");
    if (p.expires && p.expires < now()) return refuse("this pass has expired");
    if (p.mode !== "relayed") return refuse("this pass is sealed, not relayed");
    if (!json(p.items, []).includes(env.item)) return refuse(`${env.item} is not in this pass`);
    const r = this.row(env.item);
    if (!r) return refuse(`${env.item} no longer exists`);
    const narrowed = p.hosts ? json(p.hosts, []) : null;
    const hosts = json(r.hosts, []).filter(h => !narrowed || narrowed.includes(h));
    if (!relay.allowedOrigin(env.request && env.request.url, hosts)) return refuse(`${env.item} may only be sent to ${hosts.join(", ") || "nowhere"}`);
    const f = await this.fields(r);
    let sub;
    try { sub = relay.substitute(env.request, f, DEFAULT_FIELD[r.kind]); }
    catch (e) { return refuse(/** @type {Error} */ (e).message); }
    let res;
    try { res = await relay.send(sub.request); }
    catch (e) { this.audit("relay", env.item, who, false, "upstream failed"); return { status: 502, body: { error: { code: "upstream", message: relay.scrub(/** @type {Error} */ (e).message, sub.values) } } }; }
    const headers = {};
    for (const [k, v] of Object.entries(res.headers || {})) headers[k] = relay.scrub(String(v), sub.values);
    this.audit("relay", env.item, who, true, `${origin(env.request.url)} ${res.status}`);
    this.emit("vault.released", { name: env.item, pass: p.id, holder: p.holder });
    return { status: 200, body: { data: { status: res.status, headers, body: relay.scrub(res.body, sub.values) } } };
  }

  // ---- passes: the holder's side --------------------------------------------------------

  /** Take a ticket someone sent. A sealed ticket's items become ordinary sealed items here. */
  async accept({ ticket }, caller) {
    const t = relay.decodeTicket(ticket);
    const me = await this.identity();
    const added = [];
    if (t.mode === "sealed") {
      for (const n of t.items) {
        let item;
        try { item = openFrom(me.box.private, t.sealed[n], `vyre:pass:v1:${t.pass}:${n}`); }
        catch { throw new Error("this ticket was not sealed for this Vyre"); }
        const name = this.row(n) && this.row(n).origin !== `pass:${t.owner}:${t.pass}` ? `${t.owner}.${n}`.replace(/[^A-Za-z0-9._-]/g, "-") : n;
        await this.put({ name, kind: item.kind, description: item.description, fields: item.fields, url: item.url, hosts: item.hosts, origin: `pass:${t.owner}:${t.pass}` }, caller);
        added.push(name);
      }
    }
    this.db.prepare("INSERT OR REPLACE INTO vault_held (id, owner, relay, owner_sign, items, mode, expires, accepted) VALUES (?,?,?,?,?,?,?,?)")
      .run(t.pass, t.owner, t.relay || "", t.ownerSign, JSON.stringify(t.items), t.mode, t.expires, now());
    this.audit("pass-accept", null, caller, true, `${t.pass} from ${t.owner}`);
    this.emit("pass.accepted", { pass: t.pass, owner: t.owner, items: t.items, mode: t.mode });
    return { held: { id: t.pass, owner: t.owner, items: t.items, mode: t.mode, ...(added.length ? { added } : {}) } };
  }

  /** Use an item someone relayed to us: the request goes to their box, which adds the value. */
  async relayOut({ item, request, owner }, caller) {
    const t = now();
    const held = this.db.prepare("SELECT * FROM vault_held WHERE mode='relayed' ORDER BY accepted DESC").all()
      .filter(h => json(h.items, []).includes(item) && (!owner || h.owner === owner) && (!h.expires || h.expires > t));
    if (!held.length) throw new Error(`no relayed pass holds ${item}${owner ? ` from ${owner}` : ""}`);
    const h = held[0];
    const me = await this.identity();
    const env = relay.envelope({ pass: String(h.id), item, request, privDer: me.sign.private });
    const r = await relay.callRelay(String(h.relay), env);
    this.audit("relay-out", item, caller, !r.error, r.error ? r.error.message : `via ${h.owner}`);
    if (r.error) throw Object.assign(new Error(`${h.owner}'s Vyre said: ${r.error.message}`), { code: r.error.code });
    return r.data;
  }
}
