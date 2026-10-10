// @ts-check
// links: a credential linked to a record or a project (R031-71). "This client's portal login." The link is the record's own: a `credentials` field of links on the record, holding the credential's address
// (kernel/contracts `credentialUrn`), the same mechanism every other link between records uses. It grants nothing, it holds no value, and it is how the record's timeline can say "the portal login was
// used by Kit" without the record ever holding the login. A type with no `credentials` field has no place for one: it says so, and the Kit or the Engineer adds the field where it is wanted.

import { USE_ACTIONS } from "./agents.js";
import { asPerson } from "../../lib/project-reach.js";
import { credentialUrn } from "../../kernel/contracts/index.js";

/** A record or project address inside one Space: vyre://<space>/<type>/<id>. */
export const LINKED_URN = /^vyre:\/\/[^/]+\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._-]{1,80}$/;
/** The record types a reverse lookup (which records use this credential) asks. A type that does not exist here, or has no `credentials` field, answers nothing. */
const LOOKED_AT = ["project", "client", "matter", "contact", "organization"];
const bad = (/** @type {string} */ m, /** @type {string} */ code = "bad_input") => Object.assign(new Error(m), { code });

/** Who used it, in the words a person reads on a record: never an id of a device. @param {string} who */
export function byWords(who) {
  const w = String(who || "");
  const agent = /(?:^|\s)agent:([a-z][a-z0-9-]{0,30})/.exec(w);
  if (agent) return `the agent ${agent[1]}`;
  if (/^module:/.test(w)) return `Vyre's ${w.slice(7).split("/")[0]} module`;
  if (/^(device:|mcp|harness|ext:)/.test(w)) return /^device:/.test(w) ? "one of your devices" : "an assistant";
  return "you";
}
/** What happened to the item, in a few plain words. */
const DID = /** @type {Record<string, string>} */ ({ fill: "used to sign in", "agent-fill": "used to sign in", "fill-native": "used to sign in", release: "used", relay: "used", inject: "used", totp: "used for its code", copy: "copied", reveal: "looked at" });

export class Links {
  /** @param {import("./vault.js").Vault} vault */
  constructor(vault) { this.v = vault; this.db = vault.db; }

  /** The kernel's side, or the plain reason there is none. */
  need() {
    const K = this.v.access && this.v.access.K;
    if (!K) throw bad("linking a login to a record needs this server's kernel, which this build runs without", "unavailable");
    return K;
  }

  /** The record a link is on, read as the person: [type, id] and the record. @param {any} K @param {any} meta @param {string} to */
  async recordAt(K, meta, to) {
    if (!LINKED_URN.test(String(to))) throw bad("name the record or project by its address (vyre://...)");
    const [, , space, type, id] = String(to).split("/");
    if (space !== K.space) throw bad("that record is in another Space");
    const { chain } = await asPerson(K, meta);
    let record;
    try { record = await K.records.get(chain, type, id); } catch (e) { throw bad("that record is not there, or is not yours to change", "not_found"); }
    return { chain, type, id, record };
  }

  /** @param {{ item: string, to: string }} i @param {any} meta the call, with its caller */
  async link({ item, to }, meta) {
    const name = String(item || "");
    if (!this.v.row(name)) throw bad(`no item named ${name || "that"}`, "not_found");
    const K = this.need();
    const { chain, type, id, record } = await this.recordAt(K, meta, to);
    try { await K.records.update(chain, type, id, { credentials: { add: [{ urn: credentialUrn(K.space, name) }] } }, record.version); }
    catch (/** @type {any} */ e) { throw bad(e && e.code === "unknown_field" ? `a ${type} has no place for logins yet; add a "credentials" field of links to its type first` : String(e && e.message || "the record would not take the link"), e && e.code || "failed"); }
    this.v.audit("link", name, String(meta.caller), true, `${type}/${id}`);
    this.v.emit("vault.linked", { name, to: String(to) });
    return { linked: { item: name, to: String(to) } };
  }

  /** @param {{ item: string, to: string }} i @param {any} meta */
  async unlink({ item, to }, meta) {
    const name = String(item || "");
    const K = this.need();
    const { chain, type, id, record } = await this.recordAt(K, meta, to);
    const urn = credentialUrn(K.space, name);
    const have = record.data && Array.isArray(record.data.credentials) ? record.data.credentials : [];
    if (!have.some((/** @type {any} */ x) => x && x.urn === urn)) throw bad("that item is not linked there", "not_found");
    await K.records.update(chain, type, id, { credentials: { remove: [{ urn }] } }, record.version);
    this.v.audit("unlink", name, String(meta.caller), true, `${type}/${id}`);
    this.v.emit("vault.unlinked", { name, to: String(to) });
    return { unlinked: { item: name, to: String(to) } };
  }

  /** The items a record holds links to that still exist, by name. @param {any} K @param {any} record */
  itemsOf(K, record) {
    const prefix = credentialUrn(K.space, "");
    const have = record && record.data && Array.isArray(record.data.credentials) ? record.data.credentials : [];
    return have.map((/** @type {any} */ x) => String(x && x.urn || "")).filter((/** @type {string} */ u) => u.startsWith(prefix)).map((/** @type {string} */ u) => u.slice(prefix.length)).filter((/** @type {string} */ n) => this.v.row(n));
  }

  /** Names and addresses only: the items one record links to, or the records that link to one item (as the person asking can read them). @param {{ item?: string, to?: string }} q @param {any} meta */
  async list({ item, to } = {}, meta = {}) {
    const K = this.need();
    if (to) {
      const { record } = await this.recordAt(K, meta, to);
      return { links: this.itemsOf(K, record).filter((/** @type {string} */ n) => !item || n === item).map((/** @type {string} */ n) => ({ item: n, to: String(to) })) };
    }
    if (!item) throw bad("name an item or a record");
    const { chain } = await asPerson(K, meta);
    const urn = credentialUrn(K.space, String(item));
    /** @type {{ item: string, to: string }[]} */ const links = [];
    for (const type of LOOKED_AT) {
      try {
        const r = await K.records.query(chain, type, { filter: { field: "credentials", op: "contains", value: { urn } }, page: { limit: 100 } });
        for (const row of r.rows || []) links.push({ item: String(item), to: row.urn });
      } catch { /* this Space has no such type, or it has no credentials field */ }
    }
    return { links };
  }

  /**
   * The recent uses of the credentials one record links to, newest first, as lines a timeline shows: which item, when, and by whom in plain words. A use is a fact from the audit log; no value is read.
   * Asked as the person (a record they cannot read answers nothing). @param {{ urn: string, limit?: number }} q @param {any} meta
   */
  async usesFor({ urn, limit = 20 }, meta = {}) {
    const K = this.need();
    const { record } = await this.recordAt(K, meta, urn);
    const out = [];
    for (const item of this.itemsOf(K, record)) {
      for (const u of this.v.agents.uses({ item, limit: 50 }).uses) {
        if (!u.ok || !USE_ACTIONS.includes(u.action)) continue;
        out.push({ item, at: u.at, by: byWords(u.who), line: `${item} was ${DID[u.action] || "used"} by ${byWords(u.who)}` });
      }
    }
    out.sort((a, b) => b.at - a.at);
    return { uses: out.slice(0, Math.max(1, Math.min(100, Number(limit) || 20))) };
  }
}
