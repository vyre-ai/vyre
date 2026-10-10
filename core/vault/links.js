// @ts-check
// links: a credential linked to a record or a project (R031-71). "This client's portal login." The link is a pair of names, an item and a record's address: it grants nothing, it holds no value, and it
// is how the record's timeline can say "the portal login was used by Kit" without the record ever holding the login. Deleting the item takes its links with it.

import { USE_ACTIONS } from "./agents.js";

export const LINKS_MIGRATION = `CREATE TABLE vault_links (
     item TEXT NOT NULL, urn TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (item, urn)
   );
   CREATE INDEX vault_links_urn ON vault_links (urn);`;

/** A record or project address inside one Space: vyre://<space>/<type>/<id>. */
export const LINKED_URN = /^vyre:\/\/[^/]+\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._-]{1,80}$/;
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

  /** @param {{ item: string, to: string }} i @param {string} caller */
  link({ item, to }, caller) {
    const name = String(item || "");
    if (!this.v.row(name)) throw bad(`no item named ${name || "that"}`, "not_found");
    if (!LINKED_URN.test(String(to))) throw bad("name the record or project by its address (vyre://...)");
    this.db.prepare("INSERT OR IGNORE INTO vault_links (item, urn, by, at) VALUES (?,?,?,?)").run(name, String(to), String(caller), Date.now());
    this.v.audit("link", name, caller, true, String(to).split("/").slice(-2).join("/"));
    this.v.emit("vault.linked", { name, to: String(to) });
    return { linked: { item: name, to: String(to) } };
  }

  /** @param {{ item: string, to: string }} i @param {string} caller */
  unlink({ item, to }, caller) {
    const r = this.db.prepare("DELETE FROM vault_links WHERE item = ? AND urn = ?").run(String(item), String(to));
    if (!r.changes) throw bad("that item is not linked there", "not_found");
    this.v.audit("unlink", String(item), caller, true, String(to).split("/").slice(-2).join("/"));
    this.v.emit("vault.unlinked", { name: String(item), to: String(to) });
    return { unlinked: { item: String(item), to: String(to) } };
  }

  /** Names and addresses only. @param {{ item?: string, to?: string }} [q] */
  list({ item, to } = {}) {
    const where = [], args = [];
    if (item) { where.push("item = ?"); args.push(String(item)); }
    if (to) { where.push("urn = ?"); args.push(String(to)); }
    const rows = /** @type {any[]} */ (this.db.prepare(`SELECT item, urn, at FROM vault_links ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY at DESC LIMIT 500`).all(...args));
    return { links: rows.map(r => ({ item: r.item, to: r.urn, since: r.at })) };
  }

  /**
   * The uses of the credentials linked to one record, newest first, as lines a timeline shows: which item, when, and by whom in plain words. A use is a fact from the audit log; no value is read.
   * @param {{ urn: string, limit?: number }} q
   */
  usesFor({ urn, limit = 20 }) {
    if (!LINKED_URN.test(String(urn))) throw bad("name the record by its address");
    const items = /** @type {any[]} */ (this.db.prepare("SELECT item FROM vault_links WHERE urn = ?").all(String(urn))).map(r => String(r.item));
    const out = [];
    for (const item of items) {
      for (const u of this.v.agents.uses({ item, limit: 50 }).uses) {
        if (!u.ok || !USE_ACTIONS.includes(u.action)) continue;
        out.push({ item, at: u.at, by: byWords(u.who), line: `${item} was ${DID[u.action] || "used"} by ${byWords(u.who)}` });
      }
    }
    out.sort((a, b) => b.at - a.at);
    return { uses: out.slice(0, Math.max(1, Math.min(100, Number(limit) || 20))) };
  }

  /** The item is gone: so are its links. @param {string} item */
  drop(item) { this.db.prepare("DELETE FROM vault_links WHERE item = ?").run(String(item)); }
}
