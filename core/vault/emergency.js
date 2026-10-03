// @ts-check
// emergency: a trusted contact can reach the owner's items after a waiting period the owner can
// stop (ADR 0028, decision 8).
//
// The owner, present, names a verified contact. The vault builds the sealed-pass ticket that
// contact would get from a sealed pass, with every item sealed to the contact's box key, and puts
// it in escrow: the ticket bytes under a fresh random key (AES-256-GCM) in
// <vault>/emergency/<id>.bin, and that key sealed in the agent vault, so the box can release it
// with nobody there. The contact asks through the owner's relay listener; the owner is told
// (event, audit row, planner todo); if nobody denies it before the wait runs out, the next status
// call hands the ticket over and the contact's vault accepts it like any sealed pass.
//
// Rules this file enforces, and why:
// - Only a contact whose card the owner verified by fingerprint can be named. Emergency access is
//   everything, so trust on first use is not enough, and a card whose key changed is refused
//   until it is verified again.
// - Neither side alone opens an item. The box holds the escrow key and the ticket, but the items
//   in it are sealed to the contact's key; the contact holds that key, but not the ticket until
//   the box releases it. A stolen box, or a contact acting early, gets ciphertext.
// - The escrow key is an internal sealed record, not an item: it never appears in a listing, a
//   backup's item list, a grant or a pass, and nothing but release() opens it.
// - Asking needs no approval, but waits. Denying and removing never need presence: taking access
//   away is always allowed (the vault's standing rule).
// - The listener answers only a pinned, verified person with live emergency access, checked by
//   signature, audience, clock and nonce like a relayed pass. Anyone else gets the same refusal
//   as an unknown pass, and at most one audit row a minute.
// - No value, escrow key or ticket goes into an audit row, an event or a planner todo. They carry
//   the contact's name, the wait and dates.
// - A refresh rebuilds the snapshot and nothing else: it never opens, closes or restarts a
//   request. After a release the automatic refresh stops, so items added later do not follow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sealItemV2, openItemV2 } from "./crypto.js";
import { writeSealed, readSealed, removeSealed } from "./store.js";
import * as relay from "./relay.js";

export const EMERGENCY_MIGRATION = `CREATE TABLE vault_emergency (
     id TEXT PRIMARY KEY, person TEXT NOT NULL, wait_ms INTEGER NOT NULL, items TEXT, created INTEGER NOT NULL,
     refreshed INTEGER NOT NULL, requested INTEGER, denied INTEGER, released INTEGER, removed INTEGER, mac TEXT
   );
   CREATE INDEX vault_emergency_person ON vault_emergency (person);`;

/** Every column but the MAC: who, how long, what, and where the request stands. */
export const EMERGENCY_MACED = ["id", "person", "wait_ms", "items", "created", "refreshed", "requested", "denied", "released", "removed"];

export const DAY = 86_400_000;
export const DEFAULT_WAIT = 7 * DAY;
const MIN_WAIT = DAY, MAX_WAIT = 30 * DAY;
/** Kinds that sign inside the vault and are never handed out, so never escrowed by default. */
const NEVER = ["ssh-key", "passkey", "api-credential"];
const AAD = id => `vyre:emergency:v1:${id}`;
const ID = /^e_[A-Za-z0-9_-]{8,40}$/;
const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };
const day = ms => new Date(ms).toISOString().slice(0, 10);
const GENERIC = { status: 403, body: { error: { code: "denied", message: "no such pass" } } };

/**
 * A wait as typed: "7d", from one to thirty days. Left out, seven days.
 * @param {any} v @returns {number} ms
 */
export function parseWait(v) {
  if (v === undefined || v === null || v === "") return DEFAULT_WAIT;
  const m = /^\s*(\d{1,2})\s*d\s*$/i.exec(String(v));
  const ms = m ? Number(m[1]) * DAY : NaN;
  if (!(ms >= MIN_WAIT && ms <= MAX_WAIT)) throw new Error("the wait is a number of days from 1d to 30d, such as 7d");
  return ms;
}

/** AES-256-GCM over the ticket: a 12-byte IV, the 16-byte tag, then the ciphertext. */
export function sealEscrow(key, bytes, id) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(AAD(id)));
  const ct = Buffer.concat([c.update(bytes), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/** Open what sealEscrow made. Throws on a wrong key, a wrong id or a changed byte. */
export function openEscrow(key, blob, id) {
  if (!Buffer.isBuffer(blob) || blob.length < 29) throw new Error("not an escrow file");
  const d = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAAD(Buffer.from(AAD(id)));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

/**
 * Emergency access for one vault, both sides: the owner's grants and listener, and the contact's
 * request and status calls. Holds no key of its own; the Vault supplies the agent key and identity.
 */
export class Emergency {
  /** @param {import("./vault.js").Vault} vault */
  constructor(vault) {
    this.vault = vault;
    this.db = vault.db;
    /** The clock. Tests move it past the wait; both sides of an exchange must share one. */
    this.now = () => Date.now();
    /** Set by index.js when the daemon has ctx.call: planner.add for the owner's todo. */
    /** @type {((tool: string, input: any) => Promise<any>) | null} */ this.call = null;
  }

  dir() { return path.join(this.vault.dir, "emergency"); }

  /** @param {string} id */
  file(id) {
    if (!ID.test(id)) throw new Error("not an emergency id");
    return path.join(this.dir(), `${id}.bin`);
  }

  /** Where the escrow key sits in the agent vault. Its version is the MACed refresh time, so an older key file put back does not open. */
  keyAt(r) { const id = `emk_${r.id}`; return { vault: "agents", kv: 1, id, ver: Number(r.refreshed), name: id }; }

  // ---- rows ----------------------------------------------------------------------------------

  /** The live grant for a person, or undefined. A row that fails its MAC counts as none. */
  live(person) {
    return /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_emergency WHERE person = ? AND removed IS NULL ORDER BY created DESC").all(String(person)))
      .find(r => this.vault.rowOk("vault_emergency", r));
  }

  allLive() {
    return /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_emergency WHERE removed IS NULL ORDER BY person").all())
      .filter(r => this.vault.rowOk("vault_emergency", r));
  }

  /** @param {any} r @param {Record<string, any>} changes */
  update(r, changes) {
    const cols = Object.keys(changes);
    this.db.prepare(`UPDATE vault_emergency SET ${cols.map(c => `${c}=?`).join(", ")} WHERE id=?`).run(...cols.map(c => changes[c]), r.id);
    this.vault.sign("vault_emergency", r.id);
    return /** @type {any} */ (this.db.prepare("SELECT * FROM vault_emergency WHERE id=?").get(r.id));
  }

  /**
   * Where a grant stands. "open" is internal: the wait is over and the next status releases.
   * @returns {"standby"|"waiting"|"open"|"denied"|"released"}
   */
  state(r, t = this.now()) {
    if (r.released) return "released";
    if (r.requested) return t >= Number(r.requested) + Number(r.wait_ms) ? "open" : "waiting";
    if (r.denied) return "denied";
    return "standby";
  }

  /** The row as the owner sees it: names, the wait and dates. */
  out(r) {
    const st = this.state(r);
    const explicit = json(r.items, null);
    return { person: r.person, wait: `${Math.round(Number(r.wait_ms) / DAY)}d`, wait_ms: Number(r.wait_ms), state: st === "open" ? "waiting" : st,
      ...(r.requested ? { requested: Number(r.requested), opens: Number(r.requested) + Number(r.wait_ms) } : {}),
      ...(r.denied ? { denied: Number(r.denied) } : {}), ...(r.released ? { released: Number(r.released) } : {}),
      items: explicit || "every item except ssh keys and passkeys", created: Number(r.created), refreshed: Number(r.refreshed) };
  }

  // ---- the owner, present --------------------------------------------------------------------

  /** A pinned person whose card was verified by fingerprint and has not changed since. */
  verified(name) {
    const p = this.vault.share.trusted(name);
    if (!p.verified) throw new Error(`${p.name}'s card is pinned but not verified · compare fingerprints with them (vyre vault fingerprint ${p.name}), then vyre vault people verify ${p.name} <fingerprint>; emergency access needs a verified card`);
    return p;
  }

  /** The item names this grant covers now: its own list, or every agent and personal item except ssh keys and passkeys. */
  names(r) {
    const explicit = json(r.items, null);
    if (explicit) return explicit.filter(n => this.vault.row(n));
    return /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_items WHERE vault IN ('agents', 'personal') ORDER BY name").all())
      .filter(x => !NEVER.includes(x.kind) && this.vault.rowOk("vault_items", x)).map(x => String(x.name));
  }

  /**
   * Build the ticket, escrow it, and store the escrow key. The key record and the file are both
   * replaced; the row's refreshed time, which the key record is bound to, changes last.
   * @returns {Promise<{ row: any, items: string[] }>}
   */
  async build(r) {
    const vk = await this.vault.key();
    const person = this.verified(r.person);
    const items = this.names(r);
    if (!items.length) throw new Error("there is nothing in the vault to keep for emergency access yet");
    const ticket = await this.vault.ticketFor({ pass: r.id, holder: person.name, holderSign: person.sign, holderBox: person.box, items, mode: "sealed", expires: null });
    const key = crypto.randomBytes(32);
    const t = Math.max(this.now(), Number(r.refreshed) + 1);
    try {
      fs.mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
      const f = this.file(r.id), tmp = `${f}.tmp-${crypto.randomBytes(6).toString("hex")}`;
      try {
        const fd = fs.openSync(tmp, "wx", 0o600);
        try { fs.writeFileSync(fd, sealEscrow(key, Buffer.from(ticket, "utf8"), r.id)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, f);
      } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
      writeSealed(this.vault.dir, `emk_${r.id}`, sealItemV2(vk, this.keyAt({ ...r, refreshed: t }), { meta: { kind: "emergency-key" }, fields: { key: key.toString("base64") } }));
    } finally { key.fill(0); }
    return { row: this.update(r, { refreshed: t }), items };
  }

  /** The escrowed ticket, opened. Only the listener's release path calls this. */
  async release(r) {
    const vk = await this.vault.key();
    const rec = readSealed(this.vault.dir, `emk_${r.id}`);
    if (!rec) throw new Error("the escrow key is missing");
    const key = Buffer.from(String(openItemV2(vk, this.keyAt(r), rec).fields.key), "base64");
    try { return openEscrow(key, fs.readFileSync(this.file(r.id)), r.id).toString("utf8"); }
    finally { key.fill(0); }
  }

  /**
   * vault.emergency.add: keep emergency access for a verified contact.
   * @param {{ person: string, wait?: string, items?: string[] }} input @param {string} caller
   */
  async add({ person, wait, items }, caller) {
    await this.vault.key();
    const p = this.verified(String(person || ""));
    const wait_ms = parseWait(wait);
    if (this.live(p.name)) throw new Error(`${p.name} already has emergency access · vyre vault emergency refresh, or remove it first to change it`);
    let list = null;
    if (items !== undefined) {
      if (!Array.isArray(items) || !items.length || !items.every(n => typeof n === "string" && n)) throw new Error("items is a list of item names");
      for (const n of items) {
        const r = this.vault.mustRow(n);
        if (NEVER.includes(r.kind)) throw new Error(`${n} is ${r.kind === "passkey" ? "a passkey" : r.kind === "api-credential" ? "an api-credential" : "an ssh key"}; it ${r.kind === "api-credential" ? "is used only by vault.request" : "signs inside the vault"} and is never handed out`);
        if (String(r.vault).startsWith("shared:")) throw new Error(`${n} is in a shared vault; its members already reach it`);
      }
      list = JSON.stringify([...new Set(items)]);
    }
    const t = this.now();
    const id = "e_" + crypto.randomBytes(12).toString("base64url");
    this.db.prepare("INSERT INTO vault_emergency (id, person, wait_ms, items, created, refreshed) VALUES (?,?,?,?,?,?)").run(id, p.name, wait_ms, list, t, t);
    this.vault.sign("vault_emergency", id);
    let built;
    try { built = await this.build(this.db.prepare("SELECT * FROM vault_emergency WHERE id=?").get(id)); }
    catch (e) { this.drop(id); this.db.prepare("DELETE FROM vault_emergency WHERE id=?").run(id); throw e; }
    this.vault.audit("emergency-add", null, caller, true, `${p.name}: ${built.items.length} items, opens ${Math.round(wait_ms / DAY)}d after a request`);
    this.vault.emit("vault.emergency-added", { person: p.name, items: built.items.length, wait_ms });
    return { emergency: this.out(built.row), escrowed: built.items };
  }

  /**
   * vault.emergency.refresh: rebuild the snapshot for one contact, or for all of them.
   * @param {{ person?: string }} input @param {string} caller
   */
  async refresh({ person } = {}, caller) {
    await this.vault.key();
    const rows = person ? [this.live(person)] : this.allLive();
    if (person && !rows[0]) throw new Error(`${person} has no emergency access`);
    const refreshed = [];
    for (const r of rows) {
      const b = await this.build(r);
      this.vault.audit("emergency-refresh", null, caller, true, `${r.person}: ${b.items.length} items`);
      refreshed.push({ person: r.person, items: b.items.length });
    }
    return { refreshed };
  }

  /**
   * On an account unlock: rebuild every grant not refreshed in the last day and not yet released.
   * One failure (a contact's card changed, say) is audited and the rest go on.
   */
  async autoRefresh(who) {
    const t = this.now();
    for (const r of this.allLive()) {
      if (r.released || t - Number(r.refreshed) < DAY) continue;
      try {
        const b = await this.build(r);
        this.vault.audit("emergency-refresh", null, who, true, `${r.person}: ${b.items.length} items, on unlock`);
      } catch (e) {
        this.vault.audit("emergency-refresh", null, who, false, `${r.person}: ${/** @type {Error} */ (e).message}`.slice(0, 300));
      }
    }
  }

  // ---- the owner, taking it away (no presence) -----------------------------------------------

  /**
   * vault.emergency.deny: close an open request (or a release: they keep what they already
   * took, and are told to rotate). They may ask again, and wait again.
   * @param {{ person: string }} input @param {string} caller
   */
  deny({ person }, caller) {
    const r = this.live(String(person || ""));
    if (!r) throw new Error(`${person} has no emergency access`);
    const wasReleased = Boolean(r.released);
    const next = this.update(r, { requested: null, released: null, denied: this.now() });
    this.vault.audit("emergency-deny", null, caller, true, `${r.person}${wasReleased ? ": after release" : ""}`);
    this.vault.emit("vault.emergency-denied", { person: r.person });
    return { emergency: this.out(next), ...(wasReleased ? { warning: `${r.person} already took the items; rotate them, or remove their access` } : {}) };
  }

  /** Delete one grant's escrow file and key record. */
  drop(id) {
    fs.rmSync(this.file(id), { force: true });
    removeSealed(this.vault.dir, `emk_${id}`);
  }

  /**
   * End every grant for a person: escrow deleted, row marked removed. A row that fails its check
   * is removed too; taking access away is always safe. Returns how many ended.
   */
  removeAll(person, caller) {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_emergency WHERE person = ? AND removed IS NULL").all(String(person)));
    for (const r of rows) {
      this.drop(r.id);
      const good = this.vault.rowOk("vault_emergency", r);
      this.db.prepare("UPDATE vault_emergency SET removed=? WHERE id=?").run(this.now(), r.id);
      if (good) this.vault.sign("vault_emergency", r.id);
    }
    if (rows.length) {
      this.vault.audit("emergency-remove", null, caller, true, String(person));
      this.vault.emit("vault.emergency-removed", { person: String(person) });
    }
    return rows.length;
  }

  /** vault.emergency.remove. @param {{ person: string }} input @param {string} caller */
  remove({ person }, caller) {
    if (!this.removeAll(String(person || ""), caller)) throw new Error(`${person} has no emergency access`);
    return { removed: String(person) };
  }

  /** vault.emergency.list: contacts, wait, state and when it opens. Names only. */
  list() { return { contacts: this.allLive().map(r => this.out(r)) }; }

  // ---- the owner's relay listener ------------------------------------------------------------

  /**
   * POST /v1/emergency. The sender is found by the key that signed the envelope; anyone who is
   * not a verified person with live emergency access gets the unknown-pass refusal.
   * @param {any} env
   * @returns {Promise<{ status: number, body: any }>}
   */
  async onRequest(env) {
    try { await this.vault.key(); } catch { return { status: 503, body: { error: { code: "locked", message: "this vault is locked" } } }; }
    const generic = why => { this.vault.share.auditUnknown("emergency", null, why); return GENERIC; };
    if (!env || typeof env !== "object" || typeof env.from !== "string") return generic("malformed emergency request");
    const person = /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_people WHERE sign = ?").all(env.from))
      .find(p => p.verified && !this.vault.share.blockedWhy(p));
    const r = person ? this.live(person.name) : undefined;
    if (!r) return generic("no emergency access for this key");
    const t = this.now();
    const why = relay.checkEmergency(env, { audience: this.vault.relayUrl || "", now: t, seen: this.vault.share.nonces });
    if (why === "bad signature" || (why && why.startsWith("malformed"))) return generic(why);
    const who = `emergency:${r.person}`;
    if (why) { this.vault.audit("emergency", null, who, false, why); return { status: 403, body: { error: { code: "denied", message: why } } }; }
    if (env.op === "request") return this.onAsk(r, who, t);
    if (env.op === "status") return this.onStatus(r, who, t, env.from);
    return { status: 400, body: { error: { code: "bad_request", message: "op is request or status" } } };
  }

  async onAsk(r, who, t) {
    if (r.requested || r.released) return { status: 200, body: { data: this.contactView(r, t) } };
    const next = this.update(r, { requested: t });
    const opens = t + Number(r.wait_ms);
    this.vault.audit("emergency-request", null, who, true, `opens ${day(opens)} unless denied`);
    this.vault.emit("vault.emergency-requested", { person: r.person, opens });
    if (this.call) {
      await this.call("planner.add", { kind: "todo", list: "Vault", priority: 1, tags: ["vault", "emergency"],
        title: `${r.person} asked for emergency access: it opens on ${day(opens)} unless you deny it` }).catch(() => null);
    }
    return { status: 200, body: { data: this.contactView(next, t) } };
  }

  async onStatus(r, who, t, from) {
    const st = this.state(r, t);
    if (st !== "open" && st !== "released") return { status: 200, body: { data: this.contactView(r, t) } };
    let ticket;
    try {
      ticket = await this.release(r);
      // The escrow was sealed to the key pinned when it was built; a contact whose key changed and
      // was verified again needs a refresh before it can open.
      if (relay.decodeTicket(ticket).holderSign !== from) throw new Error("built for an older key");
    } catch (e) {
      this.vault.audit("emergency-release", null, who, false, `the escrow did not open: ${/** @type {Error} */ (e).message}`.slice(0, 200));
      return { status: 409, body: { error: { code: "escrow", message: "the owner's emergency escrow did not open; they must refresh it" } } };
    }
    if (st === "open") {
      const next = this.update(r, { released: t });
      this.vault.audit("emergency-release", null, who, true, `after ${Math.round(Number(r.wait_ms) / DAY)}d`);
      this.vault.emit("vault.emergency-released", { person: r.person });
      return { status: 200, body: { data: { ...this.contactView(next, t), ticket } } };
    }
    return { status: 200, body: { data: { ...this.contactView(r, t), ticket } } };
  }

  /** What the contact is told: the state, and when a waiting request opens. */
  contactView(r, t) {
    const st = this.state(r, t);
    return st === "waiting" || st === "open" ? { state: "waiting", opens: Number(r.requested) + Number(r.wait_ms) } : { state: st };
  }

  // ---- the contact's side --------------------------------------------------------------------

  /** Send one signed op to an owner's relay listener. */
  async callOwner(owner, op, caller) {
    const o = this.vault.share.trusted(String(owner || ""));
    if (!o.relay) throw new Error(`${o.name}'s card has no relay address, so their Vyre cannot be reached for emergency access · ask them for a new card`);
    const me = await this.vault.identity();
    const env = relay.emergencyEnvelope({ op, from: me.sign.public, privDer: me.sign.private, aud: String(o.relay), now: this.now() });
    const res = await relay.callRelay(String(o.relay), env, { route: "/v1/emergency" });
    this.vault.audit("emergency-out", null, caller, !res.error, res.error ? `${op} to ${o.name}: ${res.error.message}`.slice(0, 200) : `${op} to ${o.name}`);
    if (res.error) throw Object.assign(new Error(`${o.name}'s Vyre said: ${res.error.message}`), { code: res.error.code });
    return { o, data: res.data || {} };
  }

  /** vault.emergency.request. @param {{ owner: string }} input @param {string} caller */
  async request({ owner }, caller) {
    const { o, data } = await this.callOwner(owner, "request", caller);
    return { owner: o.name, state: data.state, ...(data.opens ? { opens: data.opens } : {}) };
  }

  /**
   * vault.emergency.status. Once released, the ticket goes through accept(), so the items land
   * here the way a sealed pass's do. The ticket itself is never returned.
   * @param {{ owner: string }} input @param {string} caller
   */
  async status({ owner }, caller) {
    const { o, data } = await this.callOwner(owner, "status", caller);
    const base = { owner: o.name, state: data.state, ...(data.opens ? { opens: data.opens } : {}) };
    if (data.state !== "released" || typeof data.ticket !== "string") return base;
    const t = relay.decodeTicket(data.ticket);
    if (t.ownerSign !== o.sign) throw new Error(`the ticket that came back is not signed by the key pinned for ${o.name}`);
    const held = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_held WHERE owner_sign = ? AND id = ?").get(t.ownerSign, t.pass));
    if (held && JSON.stringify(json(held.items, [])) === JSON.stringify(t.items)) return { ...base, items: t.items, already: true };
    const out = await this.vault.accept({ ticket: data.ticket }, caller);
    return { ...base, items: t.items, ...(out.held && out.held.added ? { added: out.held.added } : {}) };
  }
}
