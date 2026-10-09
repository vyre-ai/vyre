// @ts-check
// core/vault/release.js: which module may be handed which item, on the one grant model (team/0.3.1/DESIGN-one-grant.md). A release grant is a grant in the kernel's shape: the module's service
// actor, the action `vault.release`, the item's address (under `watcher/<w>/` for one watcher, with a `project` predicate for one project), source `install:<module>:vault`. It is checked by the
// kernel's own pure matcher (`matchGrant`, kernel/core/authorize.js), never by code of the vault's own.
//
// Two homes, one format and one check. On a server the grants are the kernel's (the vault module asks the kernel to lend them, and reads them back from it). On a Mac vyre-core holds the vault in its
// own process and does not trust vyred's kernel (ADR 0040), so it keeps the same grants in its own table (`vault_grants`, a `body` column holding the grant), written only by core. A request an
// assistant made waits in `vault_grant_requests` and carries no authority until a person approves it.

import { matchGrant } from "../../kernel/core/authorize.js";
import { newPrefixedId } from "../../lib/id.js";

/** The grant body goes beside the older columns of vault_grants; the rows are converted in place (`convert`). Appended to the vault's MIGRATIONS. */
export const RELEASE_BODY_MIGRATION = `ALTER TABLE vault_grants ADD COLUMN body TEXT;
   CREATE TABLE vault_grant_requests (
     id TEXT PRIMARY KEY, item TEXT NOT NULL, module TEXT NOT NULL, watcher TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', by TEXT, at INTEGER NOT NULL, UNIQUE (item, module, watcher, project)
   );`;

/** The Space a home with no kernel keeps its grants in, and the vault under it. */
const LOCAL_SPACE = "spc_vyrecore", LOCAL_HOME = `vyre://${LOCAL_SPACE}/vault/core`;
const ACTION = "vault.release";

/** The grant for one release, in the kernel's shape. */
export function releaseGrant({ space = LOCAL_SPACE, home = LOCAL_HOME, id, item, module, watcher = "", project = "", at = Date.now(), by = "vault" }) {
  return {
    id, space, subject: { kind: "actor", actor: { kind: "service", id: module, space } }, actions: [ACTION], action_set_version: 1,
    resource: { prefix: watcher ? `${home}/watcher/${watcher}/item/${item}` : `${home}/item/${item}`, ...(project ? { where: [{ attr: "project", op: "eq", value: project }] } : {}) },
    conditions: {}, issuer: { kind: "service", id: by, space }, source: `install:${module}:vault`, status: "active", created_at: at,
  };
}

/** What a tool shows of a release grant: names only. @param {any} g */
export function viewOf(g) {
  const w = /^(.*)\/watcher\/([^/]+)\/item\/([^/]+)$/.exec(g.resource.prefix), i = /^(.*)\/item\/([^/]+)$/.exec(g.resource.prefix);
  const project = g.resource.where && g.resource.where[0] ? String(g.resource.where[0].value) : "";
  return { id: g.id, home: w ? w[1] : i ? i[1] : "", item: w ? w[3] : i ? i[2] : "", module: String(g.subject.actor.id), watcher: w ? w[2] : "", project, status: g.status, at: g.created_at };
}

/** Is a source one a release grant carries? @param {string} s */
const isRelease = s => /^install:[a-z0-9-]+:vault$/.test(s);

export class Release {
  /** @param {import("./vault.js").Vault} vault */
  constructor(vault) { this.v = vault; this.db = vault.db; }

  /** The kernel's side of the vault when there is one (a server), else null (a Mac's vyre-core, or a build with no kernel). */
  get K() { const k = this.v.access && this.v.access.K; return k || null; }

  /** The live release grants, as grants. Local rows that fail their check are not here. @returns {any[]} */
  grants() {
    const K = this.K;
    if (K) return K.vault.grantsOn(`vyre://${K.space}/vault/`).filter((/** @type {any} */ g) => isRelease(g.source) && g.actions.includes(ACTION));
    // A row that fails its check is ignored and audited; one not yet converted waits for `convert` (the key opening) and counts for nothing until then.
    return /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_grants WHERE status='active'").all())
      .filter(r => this.v.rowOk("vault_grants", r) && r.body).map(r => JSON.parse(r.body)).filter(g => g.status === "active");
  }

  /** The release grants as the older listings showed them: { id, item, module, watcher, project }. */
  views() { return this.grants().map(viewOf); }

  /**
   * May this module be handed this item (for exactly this watcher when one is named)? Asked of the same matcher the kernel uses, with the caller's project when it has one: a grant scoped to another
   * project does not match, and a caller with no project is not narrowed (docs/design/session-credentials.md).
   * @param {{ name: string, module: string, watcher?: string, project?: string }} q
   */
  allowed({ name, module, watcher = "", project }) {
    const now = this.v.clock();
    return this.grants().some(g => {
      const v = viewOf(g);
      return v.item === name && v.module === module && v.watcher === watcher
        && matchGrant(g, ACTION, watcher ? `${v.home}/watcher/${watcher}/item/${name}` : `${v.home}/item/${name}`, { now, probe: !project, attrs: { project: project || "" }, since: 0, risk: "write" }).ok;
    });
  }

  /** Is this item granted to this module in any way (a watcher's included)? */
  holds(/** @type {string} */ name, /** @type {string} */ module) { return this.views().some(v => v.item === name && v.module === module); }

  /** The names of the items any module holds. */
  items() { return new Set(this.views().map(v => v.item)); }

  /** Give an item to a module (a watcher, a project), once: the same release asked for again is the one already made. @param {{ name: string, module: string, watcher?: string, project?: string }} s @param {string} by */
  async put({ name, module, watcher = "", project = "" }, by) {
    const have = this.views().find(v => v.item === name && v.module === module && v.watcher === watcher && v.project === project);
    if (have) return have;
    const id = newPrefixedId("g");
    if (this.K) {
      await this.K.vault.carryOver([{ id, kind: "release", who: module, item: name, watcher, project }]);
      return this.views().find(v => v.item === name && v.module === module && v.watcher === watcher && v.project === project) || { id, item: name, module, watcher, project, status: "active" };
    }
    const g = releaseGrant({ id, item: name, module, watcher, project, at: Date.now(), by: String(by) });
    this.db.prepare("INSERT INTO vault_grants (id, item, module, watcher, status, by, at, project, body) VALUES (?,?,?,?,'active',?,?,?,?)").run(id, name, module, watcher, String(by), g.created_at, project, JSON.stringify(g));
    this.v.sign("vault_grants", id);
    return viewOf(g);
  }

  /** Take release grants away: of an item, a module, and when named a watcher and a project. Returns how many went. @param {{ name: string, module?: string, watcher?: string, project?: string }} f */
  async remove({ name, module, watcher, project }) {
    const hit = this.views().filter(v => v.item === name && (module === undefined || v.module === module) && (watcher === undefined || v.watcher === watcher) && (project === undefined || v.project === project));
    for (const v of hit) {
      if (this.K) await this.K.vault.takeBack({ id: v.id, reason: "taken back" });
      else this.db.prepare("DELETE FROM vault_grants WHERE id = ?").run(v.id);
    }
    return hit.length;
  }

  /** The item is gone: so is every release of it (a login made again under the name inherits nothing). Local rows go before this returns. @param {string} name */
  async dropItem(name) {
    this.db.prepare("DELETE FROM vault_grant_requests WHERE item = ?").run(name);
    if (!this.K) { this.db.prepare("DELETE FROM vault_grants WHERE item = ?").run(name); return 0; }
    return this.remove({ name });
  }

  /**
   * The rows vault_grants held before the one grant model become the grants they always were, in place: each row that passes its (older) check gets its grant in `body` and is signed again; one that
   * fails is dropped; a request that was waiting moves to vault_grant_requests. A server's rows go to the kernel (a home with a kernel keeps no grant here). Run once the key is open.
   */
  async convert() {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_grants WHERE body IS NULL").all());
    for (const r of rows) {
      const ok = this.v.rowOkLegacy("vault_grants", r);
      if (ok && r.status === "pending") this.db.prepare("INSERT OR IGNORE INTO vault_grant_requests (id, item, module, watcher, project, by, at) VALUES (?,?,?,?,?,?,?)").run(r.id, r.item, r.module, r.watcher ?? "", r.project ?? "", r.by, r.at);
      if (ok && r.status === "active") {
        if (this.K) await this.K.vault.carryOver([{ id: r.id, kind: "release", who: r.module, item: r.item, watcher: r.watcher || "", project: r.project || "" }]);
        else { const g = releaseGrant({ id: r.id, item: r.item, module: r.module, watcher: r.watcher || "", project: r.project || "", at: r.at, by: String(r.by || "vault") }); this.db.prepare("UPDATE vault_grants SET body = ? WHERE id = ?").run(JSON.stringify(g), r.id); this.v.sign("vault_grants", r.id); continue; }
      }
      this.db.prepare("DELETE FROM vault_grants WHERE id = ?").run(r.id);
    }
    return rows.length;
  }
}
