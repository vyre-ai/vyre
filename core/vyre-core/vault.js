// @ts-check
// vyre-core's vault, phase 2a (ADR 0040 section 6, team/archive/work-journals/vyre-core-plan.md): the vault's own
// store and crypto (core/vault/vault.js, used as it is) in core's db and data dir, with core's own
// key in a file only _vyre can read. Never the login keychain: _vyre can't reach it, and a model
// can.
//
// What each tool asks of its caller, core deciding every one on its own connection:
//   read   vault.list, vault.match       any owner-uid peer (vyred may proxy these)
//   put    vault.put                     a NEW item from anyone, marked unverified; overwriting
//                                        an item, or a verified put, needs a proof
//   out    vault.release                 to vyred for a module, only under a grant core holds
//   safe   vault.revoke                  anyone: revoking only ever takes access away, at once
//   write  vault.delete, vault.grant,    a proof over the exact input
//          vault.verify
//   plain  vault.reveal, vault.totp      only to the Capsule core signed, with a proof or a core
//                                        bound to that Capsule process
//
// An unverified item (one a module or any other process put) is never offered to fill, is shown
// marked, and can't be granted until the person verifies it: otherwise a model plants a
// look-alike "bank" login and waits.

import path from "node:path";
import { migrate } from "../store/index.js";
import { Vault, MIGRATIONS, ensureMacColumns } from "../vault/vault.js";
import { defaultField } from "../../lib/vault-kinds/kinds.js";

const TRUST = [`
  CREATE TABLE vyrecore_item_trust (
    name TEXT PRIMARY KEY,
    verified INTEGER NOT NULL,
    by TEXT NOT NULL,
    at INTEGER NOT NULL
  );
`];

/** How many unverified items one peer, and all of them together, may leave in core's db. */
export const UNVERIFIED_MAX = { perPeer: 50, total: 500 };

/** Kinds that sign inside the vault and never leave it. */
const NEVER_OUT = new Set(["ssh-key", "passkey"]);

/**
 * @param {{ db: import("node:sqlite").DatabaseSync, dataDir: string, log?: (m: string) => void, emit?: (type: string, payload: any) => void, testKdf?: any }} o
 */
export function openVault({ db, dataDir, log = () => {}, emit = () => {}, testKdf = null }) {
  migrate(db, "vault", MIGRATIONS);
  ensureMacColumns(db);
  migrate(db, "vyrecore", TRUST);
  const vault = new Vault({ db, dir: path.join(dataDir, "vault"), config: { name: "vyre-core", vault: { keystore: "file" } }, emit, log, testKdf });

  const trust = {
    /** @param {string} name */
    verified: name => Boolean(/** @type {any} */ (db.prepare("SELECT verified FROM vyrecore_item_trust WHERE name = ?").get(String(name)))?.verified),
    /** @param {string} name @param {boolean} v @param {string} by */
    mark: (name, v, by) => db.prepare("INSERT OR REPLACE INTO vyrecore_item_trust (name, verified, by, at) VALUES (?,?,?,?)").run(String(name), v ? 1 : 0, by, Date.now()),
    /** @param {string} name */
    drop: name => db.prepare("DELETE FROM vyrecore_item_trust WHERE name = ?").run(String(name)),
  };
  const fail = (message, code = "bad_input") => Object.assign(new Error(message), { code });

  return {
    vault,
    trust,
    /** Whether an item of this name exists. @param {string} name */
    exists: name => Boolean(vault.row(String(name || ""))),

    read: {
      "vault.list": async input => {
        const out = vault.list({ filter: input.filter });
        return { ...out, items: out.items.map(i => (trust.verified(i.name) ? i : { ...i, unverified: true })) };
      },
      // Offered to fill: verified logins only.
      "vault.match": async input => ({ logins: vault.match({ url: input.url }).logins.filter(l => trust.verified(l.name)) }),
    },

    /**
     * @param {any} input @param {{ verified: boolean, by: string }} how
     *   verified: the put came with a proof core checked (then it may overwrite).
     */
    put: async (input, how) => {
      const old = Boolean(vault.row(String(input.name || "")));
      if (old && !how.verified) throw fail(`${input.name} exists; changing it needs your proof`, "presence_required");
      // An unverified put costs nothing to send, so a model could fill core's db with them.
      if (!how.verified) {
        const count = (/** @type {string|null} */ by) => Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM vyrecore_item_trust WHERE verified = 0${by ? " AND by = ?" : ""}`).get(...(by ? [by] : []))).n);
        if (count(how.by) >= UNVERIFIED_MAX.perPeer || count(null) >= UNVERIFIED_MAX.total) {
          throw fail("too many items are waiting for you to verify them; verify or delete some first", "too_many_unverified");
        }
      }
      const r = await vault.put(input, how.by);
      trust.mark(input.name, how.verified, how.by);
      return { ...r, ...(how.verified ? {} : { unverified: true }) };
    },

    /** To vyred, for one module, under a grant core holds. The Vault audits every release. */
    release: async input => {
      const mod = String(input.module || "");
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(mod)) throw fail("module must be a module name");
      return vault.release({ name: input.name, field: input.field, watcher: input.watcher || "" }, `module:${mod}`);
    },

    revoke: async (input, by) => vault.revoke({ name: input.name, module: input.module, watcher: input.watcher }, by),

    write: {
      "vault.delete": async (input, by) => { const r = vault.remove({ name: input.name }, by); trust.drop(input.name); return r; },
      "vault.grant": async (input, by) => {
        if (!trust.verified(input.name)) throw fail(`${input.name} was put by something other than you; verify it before granting it`, "unverified");
        return vault.grant({ name: input.name, module: input.module, watcher: input.watcher || "" }, "capsule");
      },
      "vault.verify": async (input, by) => {
        if (!vault.row(String(input.name || ""))) throw fail(`no item named ${input.name}`);
        trust.mark(input.name, true, by);
        vault.audit("verify", input.name, by);
        return { verified: input.name };
      },
    },

    plain: {
      "vault.reveal": async (input, by) => {
        const r = /** @type {any} */ (vault.row(String(input.name || "")));
        if (!r) throw fail(`no item named ${input.name}`);
        if (NEVER_OUT.has(r.kind)) throw fail(`${input.name} is a${r.kind === "ssh-key" ? "n ssh key" : " passkey"}; it signs inside the vault and is never shown`);
        const f = await vault.fields(r);
        const want = input.field || defaultField(r.kind, JSON.parse(r.fields || "[]"));
        if (!want || !(want in f)) throw fail(`${input.name} has no field ${want || "(name one)"}`);
        vault.audit("reveal", input.name, by, true, input.field ? `field ${input.field}` : null);
        return { name: input.name, field: want, value: f[want] };
      },
      "vault.totp": async (input, by) => vault.code({ name: input.name }, by),
    },
  };
}
