// @ts-check
// used-by (R031-70): everything that uses one credential, in one list, on the credential. Modules and watchers (the grants the person gave), Connections (the accounts that hold it), agents (the logins lent to a
// computer), deployments (Publish's kernel grants), apps (the keys an installed app was made with), Flows and linked records. Names, kinds and times only: no answer here holds a value, and nothing here
// grants or changes anything. Each user says what a new value does to it, so "Rotate" can tell the person what will restart.

import { credentialUrn } from "../../kernel/contracts/index.js";

const MAX = 200;
/** What a new value does to each kind of user, in the words the credential's page shows. */
const RENEWS = Object.freeze({
  module: "reads the new value the next time it uses it",
  connection: "reads the new value the next time it is used",
  agent: "signs in with the new value the next time",
  deployment: "its server restarts with the new value",
  app: "restarts with the new value",
  flow: "reads the new value on its next run",
  record: "nothing to change: it only points at the credential",
});

export class UsedBy {
  /** @param {import("./vault.js").Vault} vault @param {any} ctx */
  constructor(vault, ctx) { this.v = vault; this.ctx = ctx; this.db = vault.db; }

  /** The data of a call to another module, or null: a module that is not here has no users to show. @param {Promise<any>} call */
  async answer(call) {
    try { const r = await call; return r && r.data ? r.data : null; } catch { return null; }
  }

  /** @param {{ item: string }} q @param {any} meta */
  async list({ item }, meta = {}) {
    const name = String(item || "");
    const row = this.v.row(name);
    if (!row) throw Object.assign(new Error(`no item named ${name || "that"}`), { code: "not_found" });
    /** @type {{ kind: keyof typeof RENEWS, id: string, label: string, since: number | null, last_used: number | null, restarts: boolean, renews: string }[]} */
    const users = [];
    const add = (/** @type {keyof typeof RENEWS} */ kind, /** @type {string} */ id, /** @type {string} */ label, /** @type {number | null} */ since = null, /** @type {number | null} */ last = null) => {
      if (users.length < MAX) users.push({ kind, id, label, since, last_used: last, restarts: kind === "deployment" || kind === "app", renews: RENEWS[kind] });
    };

    // the grants the person gave (module, watcher, project), read from the one place the Vault answers a release from
    for (const g of this.v.releases.views().filter((/** @type {any} */ v) => v.item === name)) {
      const extra = g.watcher ? ` for the watcher ${g.watcher}` : g.project ? ` for the project ${g.project}` : "";
      add("module", `${g.module}${g.watcher ? `:${g.watcher}` : ""}`, `Vyre's ${g.module} module${extra}`, Number(g.at) || null);
    }

    for (const c of /** @type {any[]} */ (this.db.prepare("SELECT id, provider, account, label, items, added, last_used FROM vault_connections").all())) {
      let items = []; try { items = JSON.parse(c.items); } catch { items = []; }
      if (Array.isArray(items) && items.includes(name)) add("connection", String(c.id), String(c.label || `${c.provider} ${c.account}`), Number(c.added), c.last_used == null ? null : Number(c.last_used));
    }

    const access = this.v.access;
    if (access) {
      try {
        for (const g of (await access.list({ item: name }, meta)).grants) {
          if (g.status === "active" || g.status === "pending") add("agent", `${g.agent}@${g.origin}`, `the agent ${g.agent} at ${g.origin}${g.status === "pending" ? " (waiting for your yes)" : ""}`, null, g.lastUsed ?? null);
        }
      } catch { /* no kernel here, or agents are not up: no agent rows */ }
      const K = access.K;
      if (K) {
        const at = credentialUrn(K.space, name);
        for (const g of K.vault.grantsOn(at)) {
          if (g.resource.prefix !== at || !String(g.source).startsWith("publish:secret:")) continue;
          const [, , dep, env, , use] = String(g.source).split(":");
          add("deployment", dep, `a site (${dep}) as ${env}${use ? `, for ${use.replace(/\+/g, " and ")}` : ""}`, Number(g.created_at) || null);
          if (use && !use.split("+").includes("runtime")) users[users.length - 1].restarts = false, users[users.length - 1].renews = "used at the site's next build";
        }
      }
    }

    // an app is made with keys named app-<app>-<variable> (appmods); only an app that is installed counts
    const apps = await this.answer(this.ctx.call("appmods.list", {}));
    for (const a of (apps && Array.isArray(apps.apps) ? apps.apps : [])) if (name.startsWith(`app-${a.name}-`)) add("app", String(a.name), `the app ${a.name} (${a.state})`, a.installed == null ? null : Number(a.installed));

    const flows = await this.answer(this.ctx.call("flows.credential-uses", { name }));
    for (const f of (flows && Array.isArray(flows.uses) ? flows.uses : [])) add("flow", String(f.id), `the Flow ${String(f.name || f.id)}`);

    try { for (const l of (await this.v.links.list({ item: name }, meta)).links) add("record", String(l.to), "a record it is linked to"); } catch { /* no kernel: no record links */ }

    const restarts = users.filter(u => u.restarts).length;
    return { item: name, users, count: users.length, restarts, truncated: users.length >= MAX };
  }
}
