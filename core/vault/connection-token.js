// @ts-check
// connection-token: the Vault's side of a person's own app connection (team/0.6/PROPOSAL-vault-connections.md, section 3.3). The hub asks this for an access token at call time; the token
// comes from the connection item in the OWNING person's vault, is refreshed here (a rotated refresh token is saved back to the same item), and only the short-lived access token leaves. The
// refresh token, the client secret and the item itself never do.
//
// Two gates. The hub checks the grant first. This checks again, for the verified chain of the call: the owner's own person, with no assistant in the chain, uses their own connection; anyone else
// (a colleague, an assistant) needs the kernel to allow `vault.read` (a read tool) or `vault.call` (any other) on the connection's address. No kernel answer means no.
//
// What it does not do: reveal, list or change a connection (vault.me.* does, for the person alone), or serve the Space owner, whose connections are ordinary items of the owner's vault.

import { Credentials } from "../../lib/connectors/auth.js";

const denied = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "denied" });
const PERSON = /^per_[A-Za-z0-9_-]{1,64}$/;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The address a grant on a person's connection is made on and checked against. One helper, so the share (V-blocks), the hub's check (C3) and this tool name the same thing. */
export const connectionUrn = (/** @type {string} */ space, /** @type {string} */ owner, /** @type {string} */ name) => `vyre://${space}/vault/${owner}/item/${name}`;

export class ConnectionTokens {
  /** @param {{ people: import("./people.js").PeopleVaults, kernel: any | (() => any), fetch?: any, now?: () => number }} d */
  constructor({ people, kernel, fetch, now = Date.now }) {
    this.people = people; this.kernelOf = typeof kernel === "function" ? kernel : () => kernel; this.fetch = fetch; this.now = now;
    /** @type {Map<string, Credentials>} one per owner, so a minted access token is reused until it nears its end */ this.creds = new Map();
  }

  /** @param {string} owner */
  credentials(owner) {
    let c = this.creds.get(owner);
    if (c) return c;
    const people = this.people;
    c = new Credentials({
      fetchItem: async (item, field) => { const it = await people.get(owner, { name: item }); return it.fields[field || "value"]; },
      save: async (item, fields) => { await people.update(owner, { name: item, fields }); },
      now: this.now, ...(this.fetch ? { fetch: this.fetch } : {}),
    });
    this.creds.set(owner, c);
    return c;
  }

  /** Whether this chain may use the owner's connection. @param {string} owner @param {string} name @param {boolean} write @param {any} meta */
  async allowed(owner, name, write, meta) {
    const K = this.kernelOf();
    if (!K || typeof K.chain !== "function") return false;
    let chain;
    try { chain = await K.chain(meta || {}); } catch { return false; }
    const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
    const persons = new Set(hops.filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id)));
    const assisted = hops.some((/** @type {any} */ h) => h && h.actor && h.actor.kind !== "person");
    if (!assisted && persons.size === 1 && persons.has(owner)) return true;
    if (typeof K.authorize !== "function" || !K.space) return false;
    try {
      const r = await K.authorize({ chain, action: write ? "vault.call" : "vault.read", resource: connectionUrn(K.space, owner, name) });
      return Boolean(r && r.effect === "allow");
    } catch { return false; }
  }

  /**
   * An access token for one connection. @param {{ owner: string, connection: string, write?: boolean }} input @param {any} meta the call, whose chain says who is asking
   * @returns {Promise<{ access_token: string, token_type: "Bearer", expires_at: number | null, resource: string | null }>}
   */
  async token(input, meta) {
    const owner = String(input && input.owner || ""), name = String(input && input.connection || "");
    if (!PERSON.test(owner) || !ITEM.test(name)) throw Object.assign(new Error("name the person and the connection"), { code: "bad_input" });
    const K0 = this.kernelOf();
    if (String(K0 && K0.owner) === owner) throw denied("the Space owner's connections are items of the owner's vault, not a member's");
    if (!(await this.allowed(owner, name, input.write === true, meta))) throw denied("this call may not use that connection");
    // An unlocked vault, or "locked": the person opens it on a device of theirs. No fallback to another vault.
    const it = await this.people.get(owner, { name });
    if (it.kind !== "connection") throw Object.assign(new Error(`${name} is not a connection`), { code: "not_found" });
    const f = it.fields;
    const num = (/** @type {any} */ v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
    if (f.auth_kind === "oauth") {
      const access_token = await this.credentials(owner).token({ type: "oauth", item: name });
      const after = (await this.people.get(owner, { name })).fields;
      return { access_token, token_type: "Bearer", expires_at: num(after.expires_at), resource: after.resource || f.resource || null };
    }
    // A pasted token (PAT, PIT, an agent key) is the value itself; it expires only when its owner replaces it.
    if (f.auth_kind === "bearer" || f.auth_kind === "api_key") {
      const v = f.token || f.value;
      if (!v) throw Object.assign(new Error(`${name} holds no token`), { code: "needs_reconnect" });
      return { access_token: v, token_type: "Bearer", expires_at: null, resource: f.resource || null };
    }
    throw Object.assign(new Error(`${name} has no sign-in kind (auth_kind): connect it again`), { code: "needs_reconnect" });
  }
}
