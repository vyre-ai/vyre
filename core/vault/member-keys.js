// @ts-check
// core/vault/member-keys.js: a member's own AI key on the team's server (G03). A member puts an API key or a setup token here; it belongs to the identity that put it and to nobody else.
//
// What "private" means here, exactly: the key is sealed (sealItemV2) under the server's own vault key for the agents class, in its own row and file, apart from the vault's items. The vault's
// own tools (list, get, run, backup, share, import) never read this table, so the owner and other members cannot see that it exists, read it, name it or share it through any tool.
// Only the member's own calls list or remove it. The turn that uses it asks `release` with the member's id, and gets the value only into the child process of that turn. It is NOT sealed to
// the member's own key: the server has to open it to run the member's turn unattended, so whoever holds root on the host holds it, as the spec says of every host. The owner's recovery code
// does not open it, because the vault backup reads only the vault's items and so this key is not in a backup or a restore: after a restore the member adds it again.
//
// The identity that put it is read from the kernel's chain by the tool, never from the input. A member who leaves the Space can no longer use their keys (release asks membership each time).
import crypto from "node:crypto";
import { sealItemV2, openItemV2 } from "./crypto.js";
import { writeSealed, readSealed, removeSealed } from "./store.js";

export const MEMBER_KEYS_MIGRATION = `CREATE TABLE vault_member_keys (id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL);`;
export const KINDS = Object.freeze(["api-key", "setup-token"]);
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

export class MemberKeys {
  /** @param {any} vault the Vault (its db, dir, key() and at()) */
  constructor(vault) { this.v = vault; this.db = vault.db; }

  /** The item name an account carries for one of these keys. @param {string} id */
  static item(id) { return `member:${id}`; }
  /** The id inside an item name, or null when the name is not a member key's. @param {string} item */
  static idOf(item) { const m = /^member:(mk_[0-9a-f]{16})$/.exec(String(item || "")); return m ? m[1] : null; }

  #at(/** @type {string} */ id) { return this.v.at({ id, name: MemberKeys.item(id), ver: 0, vault: undefined }); }

  /** @param {string} owner the person's id, from the kernel's chain @param {{ label?: string, kind: string, value: string }} q */
  async put(owner, q) {
    if (!owner) throw refuse("a key belongs to a person: sign in as yourself, then add it again", "denied");
    if (!KINDS.includes(q.kind)) throw refuse(`a key is one of ${KINDS.join(", ")}`, "bad_input");
    const value = String(q.value || "").trim();
    if (value.length < 12 || value.length > 400 || /[\s\u0000-\u001f\u007f]/.test(value)) throw refuse("that does not look like a key or token: check what you pasted", "bad_input");
    const id = `mk_${crypto.randomBytes(8).toString("hex")}`;
    const label = String(q.label || "").trim().slice(0, 60) || "My key";
    const vk = await this.v.key();
    writeSealed(this.v.dir, id, sealItemV2(vk, this.#at(id), { meta: { kind: q.kind, owner }, fields: { value } }));
    this.db.prepare("INSERT INTO vault_member_keys (id, owner, label, kind, created) VALUES (?,?,?,?,?)").run(id, owner, label, q.kind, Date.now());
    return { id, item: MemberKeys.item(id), label, kind: q.kind };
  }

  /** Only this person's own keys: id, name, label, kind, never a value. @param {string} owner */
  list(owner) {
    return /** @type {any[]} */ (this.db.prepare("SELECT id, label, kind, created FROM vault_member_keys WHERE owner = ? ORDER BY created").all(String(owner))).map(r => ({ id: r.id, item: MemberKeys.item(r.id), label: r.label, kind: r.kind, created: r.created }));
  }

  /** Does this person own this key? A key that is someone else's and one that is not there answer the same. @param {string} owner @param {string} id */
  owns(owner, id) { return Boolean(owner) && Boolean(this.db.prepare("SELECT 1 FROM vault_member_keys WHERE id = ? AND owner = ?").get(String(id), String(owner))); }

  /** @param {string} owner @param {string} id */
  remove(owner, id) {
    if (!this.owns(owner, id)) throw refuse("that is not one of your keys (vault.member.list shows yours)", "not_found");
    this.db.prepare("DELETE FROM vault_member_keys WHERE id = ? AND owner = ?").run(id, owner);
    removeSealed(this.v.dir, id);
    return { removed: true };
  }

  /** The value, for the turn of the person who owns the key. Anyone else, or a key that is gone, is the same refusal. @param {string} owner @param {string} id */
  async release(owner, id) {
    if (!this.owns(owner, id)) throw refuse("that key is not there for this person: add it again or pick another account", "not_found");
    const sealed = readSealed(this.v.dir, id);
    if (!sealed) throw refuse("that key is gone from the vault: add it again", "not_found");
    let body;
    try { body = openItemV2(await this.v.key(), this.#at(id), sealed); } catch { throw refuse("that key could not be opened: add it again", "not_found"); }
    if (!body || !body.meta || body.meta.owner !== owner || !body.fields || typeof body.fields.value !== "string") throw refuse("that key does not match its owner: add it again", "not_found");
    return body.fields.value;
  }
}
