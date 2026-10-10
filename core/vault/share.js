// @ts-check
// share: who this Vyre shares with, and how it knows it is still them (ADR 0006, decision 5).
//
// Passes let one person use another's credential. Everything a pass trusts comes down to a key:
// the owner signs the ticket, the holder signs each relayed request. This file keeps those keys
// honest:
//   - People. The first card seen for a name is pinned (trust on first use). A card that later
//     arrives with a different key does not replace the pin quietly: the new card is kept, the
//     person is marked changed, and no new pass reaches them until someone compares fingerprints
//     and runs `vault.people.verify`. v1 cards were unsigned, so they need that from the start.
//   - Fingerprints and safety words. A fingerprint is SHA-256 over the card's two public keys,
//     five groups of four Crockford base32 characters. Safety words are computed over both
//     people's fingerprints, sorted, so both screens show the same four words.
//   - Requests. What an agent asks for (a card to pin, a ticket to accept) waits here until a
//     person approves it with `vault.approve`, the way grants and passes already do.
//   - Relay guards. Replay nonces in vyre.db, the item's relay rules, and a rate limit on audit
//     rows from passes nobody issued.
//
// Later, shared vaults: a membership manifest (a hash chain of signed versions) will name members
// by the same pinned, verified keys, so it adds a table and a check here, not a new trust root.

import crypto from "node:crypto";
import { canonical } from "./crypto.js";
import { CONSONANTS, VOWELS } from "./generate.js";
import * as relay from "./relay.js";
import { isAsker } from "./asker.js";
import { newPrefixedId } from "../../lib/id.js";

export const SHARE_MIGRATIONS = [
  // People are pinned by card; passes may narrow methods and paths; items may allow the body;
  // held passes are keyed by the owner's key as well as the pass id, so a ticket from someone
  // else can never take over a pass. Held rows from unsigned tickets are dropped: nothing proves
  // who made them, and the owner's Vyre refuses their unsigned requests anyway.
  `ALTER TABLE vault_people ADD COLUMN card TEXT;
   ALTER TABLE vault_people ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE vault_people ADD COLUMN fingerprint TEXT;
   ALTER TABLE vault_people ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE vault_people ADD COLUMN first_seen INTEGER;
   ALTER TABLE vault_people ADD COLUMN changed INTEGER;
   UPDATE vault_people SET first_seen = added;
   ALTER TABLE vault_passes ADD COLUMN methods TEXT;
   ALTER TABLE vault_passes ADD COLUMN paths TEXT;
   ALTER TABLE vault_items ADD COLUMN relay TEXT;
   CREATE TABLE vault_held_v2 (
     owner_sign TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, relay TEXT NOT NULL,
     items TEXT NOT NULL, mode TEXT NOT NULL, expires INTEGER, accepted INTEGER NOT NULL,
     PRIMARY KEY (owner_sign, id)
   );
   DROP TABLE vault_held;
   ALTER TABLE vault_held_v2 RENAME TO vault_held;
   CREATE TABLE vault_relay_nonces (nonce TEXT PRIMARY KEY, ts INTEGER NOT NULL);
   CREATE INDEX vault_relay_nonces_ts ON vault_relay_nonces (ts);
   CREATE TABLE vault_share_requests (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, payload TEXT NOT NULL,
     by TEXT NOT NULL, at INTEGER NOT NULL
   );`,
];

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const now = () => Date.now();
const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };

/**
 * A card's fingerprint: SHA-256 of canonical({ sign, box }), the first 100 bits as five groups
 * of four Crockford base32 characters.
 * @param {{ sign: string, box: string }} card
 */
export function fingerprint({ sign, box }) {
  const h = crypto.createHash("sha256").update(canonical({ sign, box })).digest();
  let bits = "";
  for (const b of h.subarray(0, 13)) bits += b.toString(2).padStart(8, "0");
  let s = "";
  for (let i = 0; i < 100; i += 5) s += CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
  return s.match(/.{4}/g)?.join(" ") ?? s;
}

/** A fingerprint as typed: spaces and dashes dropped, case folded, O as 0 and I or L as 1. */
export function normalizeFingerprint(s) {
  const t = String(s || "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return t.length === 20 && [...t].every(c => CROCKFORD.includes(c)) ? t.match(/.{4}/g)?.join(" ") ?? t : null;
}

/**
 * Four words both people see, computed from both fingerprints in sorted order. Each word is
 * three consonant-vowel syllables, the same shape generate.js uses for passphrases.
 * @param {string} a @param {string} b
 */
export function safetyWords(a, b) {
  const [x, y] = [normalizeFingerprint(a), normalizeFingerprint(b)].map(v => String(v)).sort();
  const h = crypto.createHash("sha256").update(`vyre-safety-v1:${x}:${y}`).digest();
  const n = CONSONANTS.length * VOWELS.length;
  const words = [];
  for (let w = 0; w < 4; w++) {
    let word = "";
    for (let s = 0; s < 3; s++) {
      const i = h.readUInt16BE((w * 3 + s) * 2) % n;
      word += CONSONANTS[Math.floor(i / VOWELS.length)] + VOWELS[i % VOWELS.length];
    }
    words.push(word);
  }
  return words;
}

/**
 * The sharing side of one vault. Holds no key of its own; it asks the Vault for its identity.
 */
export class Share {
  /** @param {import("./vault.js").Vault} vault */
  constructor(vault) {
    this.vault = vault;
    this.db = vault.db;
    /** @type {ReturnType<typeof relay.dbNonces> | null} */
    this._nonces = null;
    /** pass id -> the minute its last unknown-pass audit row was written. */
    this.unknownSeen = new Map();
  }

  /** The relay's replay store, made on first use (the tables exist only after migration). */
  get nonces() { return (this._nonces ??= relay.dbNonces(this.db)); }

  // ---- this Vyre's own card ------------------------------------------------------------------

  /** The account id, once the key hierarchy (vault-core) provides one. */
  async accountId() {
    const v = /** @type {any} */ (this.vault);
    const a = typeof v.accountId === "function" ? await v.accountId() : null;
    return a ? String(a) : undefined;
  }

  /** This Vyre's signed v2 card, its fingerprint, and the address a relayed pass reaches. */
  async myCard() {
    const id = await this.vault.identity();
    const card = relay.encodeCard({ acct: await this.accountId(), name: this.vault.name, sign: id.sign.public, box: id.box.public,
      relay: this.vault.relayUrl || "", ...(this.vault.login ? { login: this.vault.login } : {}), devices: [] }, id.sign.private);
    return { card, name: this.vault.name, relay: this.vault.relayUrl || null, fingerprint: fingerprint({ sign: id.sign.public, box: id.box.public }) };
  }

  async myFingerprint() {
    const id = await this.vault.identity();
    return fingerprint({ sign: id.sign.public, box: id.box.public });
  }

  // ---- people --------------------------------------------------------------------------------

  /** @param {string} name */
  row(name) { return /** @type {any} */ (this.db.prepare("SELECT * FROM vault_people WHERE name = ?").get(String(name))); }

  /** A row's fingerprint; rows pinned before v2 have none stored, so it is computed. */
  fp(r) { return r.fingerprint || fingerprint({ sign: r.sign, box: r.box }); }

  /** Why no new pass may go to this person, or null. */
  blockedWhy(r) {
    if (r.verified) return null;
    if (r.changed) return `${r.name}'s card changed on ${new Date(r.changed).toISOString().slice(0, 10)}, so nothing proves it is still them · compare fingerprints with them (vyre vault fingerprint ${r.name}), then vyre vault people verify ${r.name} <fingerprint>`;
    if (Number(r.version) < 2) return `${r.name}'s card is an old unsigned one · ask them for a new card, or compare fingerprints and run vyre vault people verify ${r.name} <fingerprint>`;
    return null;
  }

  personOut(r) {
    return { name: r.name, fingerprint: this.fp(r), version: Number(r.version) || 1, verified: Boolean(r.verified),
      ...(r.relay ? { relay: r.relay } : {}), ...(r.login ? { login: r.login } : {}),
      firstSeen: r.first_seen ?? r.added, ...(r.changed ? { changed: r.changed } : {}), blocked: Boolean(this.blockedWhy(r)) };
  }

  people() {
    return { people: this.db.prepare("SELECT * FROM vault_people ORDER BY name").all().map(r => this.personOut(r)) };
  }

  /**
   * Pin a person's card. A new name is pinned as given. The same keys again refresh the address
   * and login (a v2 card is signed by that same key). Different keys mark the person changed and
   * block new passes until they are verified. From an agent, anything that would change the
   * table waits for a person.
   * @param {{ card: string, name?: string }} input @param {string} caller
   */
  async addPerson({ card, name }, caller) {
    const c = relay.decodeCard(card);
    const who = String(name || c.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/.test(who)) throw new Error("a person's name is letters, digits, space, dot, dash, underscore and @, up to 64");
    const fp = fingerprint(c);
    const old = this.row(who);
    if (old && this.fp(old) === fp) {
      if (c.v === 2) this.db.prepare("UPDATE vault_people SET card=?, version=2, relay=?, login=?, fingerprint=? WHERE name=?").run(String(card).trim(), c.relay || null, c.login || null, fp, who);
      return { person: this.personOut(this.row(who)), pinned: false };
    }
    if (isAsker(caller)) return this.request("person", who, String(card).trim(), caller, { fingerprint: fp });
    const t = now();
    if (old) {
      this.db.prepare("UPDATE vault_people SET sign=?, box=?, relay=?, login=?, card=?, version=?, fingerprint=?, verified=0, changed=? WHERE name=?")
        .run(c.sign, c.box, c.relay || null, c.login || null, String(card).trim(), c.v, fp, t, who);
      this.vault.audit("person-changed", null, caller, true, `${who}: was ${this.fp(old)}, now ${fp}`);
      this.vault.emit("vault.card-changed", { name: who, fingerprint: fp, was: this.fp(old) });
      return { person: this.personOut(this.row(who)), changed: true };
    }
    this.db.prepare("INSERT INTO vault_people (name, sign, box, relay, login, card, version, fingerprint, verified, first_seen, added) VALUES (?,?,?,?,?,?,?,?,0,?,?)")
      .run(who, c.sign, c.box, c.relay || null, c.login || null, String(card).trim(), c.v, fp, t, t);
    this.vault.audit("person-add", null, caller, true, `${who}: ${fp}`);
    return { person: this.personOut(this.row(who)), pinned: true };
  }

  /**
   * A person compared fingerprints out of band and says they match. The fingerprint is checked,
   * not taken on trust: a mismatch is an error, and the person stays blocked.
   * @param {{ name: string, fingerprint: string }} input @param {string} caller
   */
  verifyPerson({ name, fingerprint: typed }, caller) {
    const r = this.row(name);
    if (!r) throw new Error(`no card for ${name} yet · vyre vault people add <card>`);
    const want = normalizeFingerprint(typed);
    if (!want) throw new Error("a fingerprint is 20 characters, five groups of four");
    if (want !== this.fp(r)) {
      this.vault.audit("person-verify", null, caller, false, `${name}: fingerprint did not match`);
      throw new Error(`that fingerprint does not match the card on file for ${name}; do not share with them until it does`);
    }
    this.db.prepare("UPDATE vault_people SET verified=1, changed=NULL, fingerprint=? WHERE name=?").run(want, r.name);
    this.vault.audit("person-verify", null, caller, true, `${r.name}: ${want}`);
    this.vault.emit("vault.person-verified", { name: r.name, fingerprint: want });
    return { person: this.personOut(this.row(r.name)) };
  }

  /** The person a new pass may go to, or a readable reason it may not. */
  trusted(name) {
    const r = this.row(name);
    if (!r) throw new Error(`no card for ${name} yet: ask them to run vyre vault card and pass it with --card`);
    const why = this.blockedWhy(r);
    if (why) throw new Error(why);
    return r;
  }

  /** Our fingerprint, and with a person, theirs and the safety words both of you should see. */
  async fingerprintWith({ with: other } = {}) {
    const mine = await this.myFingerprint();
    if (!other) return { fingerprint: mine };
    const r = this.row(other);
    if (!r) throw new Error(`no card for ${other} yet · vyre vault people add <card>`);
    const theirs = this.fp(r);
    return { fingerprint: mine, person: { name: r.name, fingerprint: theirs, verified: Boolean(r.verified) }, words: safetyWords(mine, theirs) };
  }

  /**
   * On accepting a ticket: the owner's card must match the pin for that key or that name. A key
   * never seen and a name never seen is pinned now, since a person is the one accepting.
   * @param {import("./relay.js").Card} card @param {string} cardStr @param {string} caller
   * @returns {Promise<string>} the local name of the owner
   */
  async pinOwner(card, cardStr, caller) {
    const fp = fingerprint(card);
    const byKey = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_people WHERE sign = ? AND box = ?").get(card.sign, card.box));
    if (byKey) {
      const why = this.blockedWhy(byKey);
      if (why) throw new Error(why);
      return byKey.name;
    }
    // A ticket never re-pins someone: a forged one would otherwise block the real person. A real
    // key change goes through `people add` and `people verify`, where a person sees both prints.
    const byName = this.row(card.name);
    if (byName) throw new Error(`this ticket is signed by a key that is not the one pinned for ${card.name} (${this.fp(byName)}; the ticket's is ${fp}) · if they have a new key, add their new card and verify it before accepting`);
    await this.addPerson({ card: cardStr }, caller);
    return card.name;
  }

  // ---- requests an agent made, waiting for a person ------------------------------------------

  /** @param {"person"|"accept"} kind @param {string} subject @param {string} payload @param {string} caller */
  request(kind, subject, payload, caller, extra = {}) {
    const id = newPrefixedId("s");
    this.db.prepare("INSERT INTO vault_share_requests (id, kind, subject, payload, by, at) VALUES (?,?,?,?,?,?)").run(id, kind, subject, payload, String(caller), now());
    this.vault.audit(kind === "person" ? "person-requested" : "pass-accept-requested", null, caller, true, `${id}: ${subject}`);
    this.vault.emit(kind === "person" ? "person.requested" : "pass.accept-requested", { id, [kind === "person" ? "name" : "owner"]: subject, ...extra });
    return { pending: { id, kind, [kind === "person" ? "name" : "owner"]: subject, ...extra, status: "pending" } };
  }

  requests() {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_share_requests ORDER BY at").all());
    const people = [], accepts = [];
    for (const r of rows) {
      if (r.kind === "person") {
        let fp = null;
        try { fp = fingerprint(relay.decodeCard(r.payload)); } catch {}
        people.push({ id: r.id, name: r.subject, fingerprint: fp, by: r.by, at: r.at });
      } else {
        let t = null;
        try { t = relay.decodeTicket(r.payload); } catch {}
        accepts.push({ id: r.id, owner: r.subject, ...(t ? { items: t.items, mode: t.mode, expires: t.expires } : {}), by: r.by, at: r.at });
      }
    }
    return { people, accepts };
  }

  /** Approve a request by id, as the person approving it. Null when the id is not one of ours. */
  async approve(id, caller) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_share_requests WHERE id = ?").get(String(id)));
    if (!r) return null;
    this.db.prepare("DELETE FROM vault_share_requests WHERE id = ?").run(r.id);
    if (r.kind === "person") {
      const out = await this.addPerson({ card: r.payload, name: r.subject }, caller);
      return { approved: out.person, ...(out.changed ? { changed: true } : {}) };
    }
    const out = await this.vault.accept({ ticket: r.payload }, caller);
    return { approved: out.held };
  }

  // ---- relay guards --------------------------------------------------------------------------

  /** An item's relay rules. Only `body` today: may a placeholder go in the request body. */
  relayRules(itemRow) {
    const r = json(itemRow && itemRow.relay, {});
    return { body: r && r.body === true };
  }

  /**
   * Check relay rules and give the column value: '{"body":true}' or null. The rules are sealed
   * in the item's meta (ADR 0006), so they cannot change without a new sealed version.
   * @param {any} rules
   */
  checkRelayRules(rules) {
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error("relay must be an object such as { body: true }");
    for (const k of Object.keys(rules)) if (k !== "body") throw new Error(`relay.${k} is not a relay rule; the one rule is relay.body`);
    if (rules.body !== undefined && typeof rules.body !== "boolean") throw new Error("relay.body is true or false");
    return rules.body ? JSON.stringify({ body: true }) : null;
  }

  /** Set an item's relay rules: a new sealed version with them in its meta. @param {string} name @param {any} rules */
  async setRelayRules(name, rules) {
    const relay = this.checkRelayRules(rules);
    await this.vault.setMeta(name, { relay }, "relay rules");
    return this.relayRules(this.vault.row(name));
  }

  /**
   * An audit row for a request naming a pass nobody issued, at most one per pass id per minute,
   * so a stranger cannot fill the disk by posting to the relay in a loop.
   * @param {any} passId @param {any} item @param {string} why
   */
  auditUnknown(passId, item, why) {
    const key = typeof passId === "string" ? passId.slice(0, 64) : "?";
    const minute = Math.floor(now() / 60_000);
    if (this.unknownSeen.get(key) === minute) return;
    if (this.unknownSeen.size >= 1000) this.unknownSeen.clear();
    this.unknownSeen.set(key, minute);
    this.vault.audit("relay", typeof item === "string" ? item.slice(0, 128) : null, `pass:unknown:${key}`, false, why);
  }
}
