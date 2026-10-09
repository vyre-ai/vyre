// @ts-check
// Connections a person made from any app's API: the stateful half of records/connectors/connection.js. A Connection is a row here (the declaration, the Vault item that holds the key, the check,
// its light) and nothing else is the truth: the vault credential `conn-<id>` is derived from the row and written only by `materialize`. The vault lets an api-credential be written only from a
// person's own surface, so a row is made, changed and rebuilt in a person's act; a credential found changed behind the row's back shows as out of step until that act rebuilds it.

import { defineConnector, appHost } from "../../records/connectors/format.js";
import { fromForm, toConfig, credentialName, outcomeOf, operationsOf, cardOf } from "../../records/connectors/connection.js";
import { newPrefixedId } from "../../lib/id.js";
import { siteDeclaration, siteConfig, pollsOf, siteCardOf } from "../../records/connectors/site.js";

const AUTH_OF = { bearer: "bearer", basic: "password", "api-key": "api-key" };

/**
 * @param {{ db: any, call: (tool: string, input: any, opts?: any) => Promise<any>, now?: () => number, emit?: (type: string, payload: any) => void, log?: (m: string, x?: any) => void,
 *   siteCheck?: (id: string) => Promise<{ light: "green" | "red", words: string }>, siteEntries?: (origin: string, names?: string[]) => Promise<{ name: string, kind: string, op: any }[]> }} deps
 */
export function madeConnections({ db, call, now = Date.now, emit = () => {}, log = () => {}, siteCheck, siteEntries }) {
  const fail = (/** @type {string} */ msg, /** @type {string} */ code) => Object.assign(new Error(msg), { code });
  const data = (/** @type {any} */ r) => { if (r.error) throw fail(r.error.message, r.error.code || "failed"); return r.data; };
  const row = (/** @type {string} */ id) => /** @type {any} */ (db.prepare("SELECT * FROM connectors_made WHERE id = ?").get(id));
  const shape = (/** @type {any} */ r, /** @type {boolean} */ stale) => {
    const d = JSON.parse(r.declaration);
    const a = d.auth;
    const auth = a.type === "api-key" ? (a.in === "query" ? { kind: "query", name: a.param } : { kind: "header", name: a.header || "x-api-key" }) : { kind: a.type };
    const f = r.form ? JSON.parse(r.form) : {};
    return { id: r.id, label: r.label, host: d.app ? appHost(d.app) : new URL(d.base_url).hostname, ...(d.app ? { app: d.app } : {}), auth, credential: { item: r.credential_item, ...(r.credential_field ? { field: r.credential_field } : {}) }, headers: f.headers || {}, vars: f.vars || {},
      check: { method: "GET", path: r.check_path }, origin: r.origin, ...(d.transport === "site" ? { transport: "site", site: d.base_url } : {}),
      light: stale ? "out_of_step" : r.light, reason: stale ? "the Vault credential was changed outside this connection; save the connection again to rebuild it" : r.reason, checked_at: r.checked_at, created: r.created,
      operations: operationsOf(d),
      // How an assistant calls this API: vault.request with this credential, a method and a full address on the host; the key is attached outside it and never seen. (The Connection's own key item is not what to pass.)
      use: { tool: "vault.request", credential: `conn-${r.id}`, url: `https://${d.app ? appHost(d.app) : new URL(d.base_url).hostname}/...` } };
  };

  /** The vault item names and when each was last written, for spotting drift. */
  async function items() {
    const l = data(await call("vault.list", {}));
    return new Map((l.items || []).map((/** @type {any} */ x) => [String(x.name), x]));
  }

  /** Write the derived credential from the row, as the person. @param {any} r @param {string} as */
  async function materialize(r, as) {
    const decl = defineConnector(JSON.parse(r.declaration));
    // A website signed in through a browser has no key in the Vault: the credential holds the host and the route rules, and nothing else.
    if (decl.transport === "site") return materializeSite(r, decl, as);
    const config = toConfig({ declaration: decl, credential: { item: r.credential_item, ...(r.credential_field ? { field: r.credential_field } : {}) }, check: { path: r.check_path } });
    const name = credentialName(r.id);
    const old = (await items()).get(name);
    if (old && old.kind !== "api-credential") throw fail(`the vault already has an item named ${name} that is not an api credential; rename or delete it first`, "exists");
    const src = (await items()).get(r.credential_item);
    if (!src) throw fail(`the Vault has no item named ${r.credential_item}; save the key there first`, "not_found");
    if (src.kind === "api-credential") throw fail(`${r.credential_item} is itself an api credential, which never hands out a key; name the item that holds the key`, "bad_input");
    const put = await call("vault.put", { name, kind: "api-credential", description: `${decl.label} connection (derived from the connection record; change the connection, not this)`, fields: { config: JSON.stringify(config) } }, { as });
    if (put.error) throw fail(`could not save the credential in the vault: ${put.error.message}`, put.error.code || "vault");
    const after = (await items()).get(name);
    db.prepare("UPDATE connectors_made SET item_updated = ? WHERE id = ?").run(after ? Number(after.updated) || now() : now(), r.id);
    const reg = await call("vault.connections.register", { ref: `made:${r.id}`, provider: "custom", account: decl.app ? `${decl.app} (on this machine)` : new URL(decl.base_url).hostname, auth: AUTH_OF[/** @type {keyof typeof AUTH_OF} */ (decl.auth.type)] || "api-key", label: decl.label });
    if (reg.error) log("connections: could not register the row", { id: r.id, error: reg.error.message });
    return name;
  }

  /** The derived credential of a site Connection. @param {any} r @param {import("../../records/connectors/format.js").Declaration} decl @param {string} as */
  async function materializeSite(r, decl, as) {
    const name = credentialName(r.id);
    const old = (await items()).get(name);
    if (old && old.kind !== "api-credential") throw fail(`the vault already has an item named ${name} that is not an api credential; rename or delete it first`, "exists");
    const put = await call("vault.put", { name, kind: "api-credential", description: `${decl.label} (a website, signed in through a browser; derived from the connection record, change the connection, not this)`, fields: { config: JSON.stringify(siteConfig(decl)) } }, { as });
    if (put.error) throw fail(`could not save the credential in the vault: ${put.error.message}`, put.error.code || "vault");
    const after = (await items()).get(name);
    db.prepare("UPDATE connectors_made SET item_updated = ? WHERE id = ?").run(after ? Number(after.updated) || now() : now(), r.id);
    const reg = await call("vault.connections.register", { ref: `made:${r.id}`, provider: "custom", account: new URL(/** @type {string} */ (decl.base_url)).hostname, auth: "none", label: decl.label });
    if (reg.error) log("connections: could not register the row", { id: r.id, error: reg.error.message });
    return name;
  }

  /**
   * Make (or, with `replace`, rewrite) the Connection of a website from the operations its site record holds. A person's act: it widens what the Connection can reach, and the vault asks them to
   * confirm the credential it writes.
   * @param {{ id?: string, label: string, origin: string, entries: { name: string, kind: string, op: any }[], polls?: any[], agent?: string }} site @param {{ as: string, replace?: boolean }} o
   */
  async function saveSite(site, o) {
    const id = site.id ? String(site.id) : String(site.label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
    const had = row(id);
    // a sync keeps the polls the Connection already had unless new ones are given
    const polls = Array.isArray(site.polls) ? site.polls : had && JSON.parse(had.declaration).transport === "site" ? pollsOf(JSON.parse(had.declaration)) : undefined;
    const declaration = siteDeclaration({ id, label: site.label, origin: site.origin, entries: site.entries, ...(polls ? { polls } : {}) });
    if (had && !o.replace) throw fail(`there is already a connection ${id}; sync it to change it`, "exists");
    if (!had && o.replace) throw fail(`no connection ${id}`, "not_found");
    if (had && JSON.parse(had.declaration).transport !== "site") throw fail(`${id} is not a website connection`, "bad_input");
    const t = now();
    // the agent whose computer holds the login (a box's rung) is kept across a sync unless a new one is given
    const agent = site.agent !== undefined ? site.agent : had && had.form ? (() => { try { return JSON.parse(had.form).agent; } catch { return undefined; } })() : undefined;
    const formJson = JSON.stringify({ site: site.origin, ...(agent ? { agent } : {}) });
    if (had) db.prepare("UPDATE connectors_made SET label=?, declaration=?, light='unknown', reason=NULL, updated=?, form=? WHERE id=?").run(declaration.label, JSON.stringify(declaration), t, formJson, id);
    else db.prepare("INSERT INTO connectors_made (id, label, declaration, credential_item, credential_field, check_path, origin, made_by, form, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, declaration.label, JSON.stringify(declaration), "", null, "/", "site", o.as, formJson, t, t);
    try { await materialize(row(id), o.as); }
    catch (e) { if (!had) db.prepare("DELETE FROM connectors_made WHERE id = ?").run(id); throw e; }
    emit(had ? "connectors.connection-updated" : "connectors.connection-created", { id });
    return { id, credential: credentialName(id), operations: Object.keys(declaration.ops).length };
  }

  /** The light of a Connection, set from what a call or a check found. @param {string} id @param {"green" | "red"} light @param {string} words */
  function touch(id, light, words) {
    db.prepare("UPDATE connectors_made SET light = ?, reason = ?, checked_at = ? WHERE id = ?").run(light, words, now(), id);
  }

  /** @param {any} form @param {{ as: string, origin?: string, replace?: boolean }} o */
  async function save(form, o) {
    const made = fromForm(form);
    const had = row(made.id);
    if (had && !o.replace) throw fail(`there is already a connection ${made.id}; update it to change it`, "exists");
    if (!had && o.replace) throw fail(`no connection ${made.id}`, "not_found");
    const t = now();
    const formJson = JSON.stringify({ send: form.send, headers: form.headers || {}, vars: form.vars || {}, check: form.check });
    const values = [made.id, made.declaration.label, JSON.stringify(made.declaration), made.credential.item, made.credential.field || null, made.check.path, o.origin || "form", o.as, formJson, t, t];
    if (had) db.prepare("UPDATE connectors_made SET label=?, declaration=?, credential_item=?, credential_field=?, check_path=?, origin=?, made_by=?, form=?, light='unknown', reason=NULL, updated=? WHERE id=?").run(...values.slice(1, 9), t, made.id);
    else db.prepare("INSERT INTO connectors_made (id, label, declaration, credential_item, credential_field, check_path, origin, made_by, form, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(...values);
    try { await materialize(row(made.id), o.as); }
    catch (e) { if (!had) db.prepare("DELETE FROM connectors_made WHERE id = ?").run(made.id); throw e; }
    emit(had ? "connectors.connection-updated" : "connectors.connection-created", { id: made.id });
    return { id: made.id, credential: credentialName(made.id) };
  }

  /** Run the check as this module (a read, the check path only) and keep the light. @param {string} id */
  async function check(id) {
    const r = row(id);
    if (!r) throw fail(`no connection ${id}`, "not_found");
    const d = JSON.parse(r.declaration);
    const stale = await isStale(r);
    /** @type {{ light: "green" | "red", words: string }} */ let out;
    if (d.transport === "site") out = stale ? { light: "red", words: "the Vault credential was changed outside this connection; sync the connection again to rebuild it" } : siteCheck ? await siteCheck(id) : { light: "red", words: "no browser is connected" };
    else if (stale) out = { light: "red", words: "the Vault credential was changed outside this connection; save the connection again to rebuild it" };
    else {
      const res = await call("vault.request", { credential: credentialName(id), method: "GET", url: (d.app ? `https://${appHost(d.app)}` : d.base_url) + r.check_path });
      out = res.error ? outcomeOf({ error: res.error }) : outcomeOf({ reply: res.data });
    }
    db.prepare("UPDATE connectors_made SET light = ?, reason = ?, checked_at = ? WHERE id = ?").run(out.light, out.words, now(), id);
    emit("connectors.connection-checked", { id, light: out.light });
    return { id, light: out.light, words: out.words };
  }

  /** Whether the derived credential is missing or was written by anything but `materialize`. @param {any} r */
  async function isStale(r) {
    const have = (await items()).get(credentialName(r.id));
    return !have || (r.item_updated != null && Number(have.updated) !== Number(r.item_updated));
  }

  return {
    save, saveSite, touch, check, row,
    list: async () => { return { connections: await Promise.all(/** @type {any[]} */ (db.prepare("SELECT * FROM connectors_made ORDER BY label").all()).map(async r => shape(r, await isStale(r)))) }; },
    get: async (/** @type {string} */ id) => {
      const r = row(id); if (!r) throw fail(`no connection ${id}`, "not_found");
      return { ...shape(r, await isStale(r)), declaration: JSON.parse(r.declaration) };
    },
    /**
     * An assistant's proposal for a Connection. It is checked like any form, but what only the person may say is taken out first: a relabeled operation, and any kind but the method's. Nothing is made
     * and nothing is called; the proposal waits for the person, who approves it from their own screen (approve), which is the person-only create.
     */
    propose: async (/** @type {any} */ form, /** @type {string} */ by, /** @type {string} */ why) => {
      const clean = { ...form, operations: Array.isArray(form && form.operations) ? form.operations.map((/** @type {any} */ o) => { const { relabeled: _r, kind: _k, ...rest } = o || {}; return rest; }) : undefined };
      if (clean.operations === undefined) delete clean.operations;
      const made = fromForm(clean);
      if (row(made.id)) throw fail(`there is already a connection ${made.id}; the person changes it from their own screen`, "exists");
      const item = (await items()).get(clean.credential.item);
      if (!item) throw fail(`the Vault has no item named ${String(clean.credential.item).slice(0, 60)}: ask the person to save the key there first, then propose the connection`, "not_found");
      if (item.kind === "api-credential") throw fail(`${clean.credential.item} is itself an api credential, which never hands out a key`, "bad_input");
      const id = newPrefixedId("prop");
      db.prepare("DELETE FROM connectors_proposals WHERE json_extract(form, '$.label') = ? AND proposed_by = ?").run(String(clean.label), by);
      db.prepare("INSERT INTO connectors_proposals (id, form, proposed_by, why, created) VALUES (?,?,?,?,?)").run(id, JSON.stringify(clean), by, why ? String(why).slice(0, 300) : null, now());
      emit("connectors.connection-proposed", { proposal: id, label: made.declaration.label });
      return { proposal: id, card: cardOf(made, clean.credential.item) };
    },
    /** An assistant's proposal for a website Connection from what is learned on the site. Nothing is made; the person approves it from their own screen, which is the person-only create. */
    proposeSite: async (/** @type {any} */ form, /** @type {string} */ by, /** @type {string} */ why) => {
      if (!siteEntries) throw fail("no site record is wired here", "unavailable");
      const origin = String(form && form.site || "");
      const entries = await siteEntries(origin, Array.isArray(form.operations) ? form.operations : undefined);
      const label = String(form.label || "").trim();
      if (!label) throw fail("label: a short name", "bad_input");
      siteDeclaration({ id: form.id ? String(form.id) : label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40), label, origin, entries, ...(Array.isArray(form.polls) ? { polls: form.polls } : {}) });
      const card = siteCardOf({ label, origin, entries });
      // the card is kept with the proposal, so the person's list is read without asking the site record again
      const clean = { site: origin, label, card, ...(form.id ? { id: String(form.id) } : {}), ...(Array.isArray(form.operations) ? { operations: form.operations.map(String) } : {}), ...(Array.isArray(form.polls) ? { polls: form.polls } : {}) };
      const id = newPrefixedId("prop");
      db.prepare("DELETE FROM connectors_proposals WHERE json_extract(form, '$.label') = ? AND proposed_by = ?").run(label, by);
      db.prepare("INSERT INTO connectors_proposals (id, form, proposed_by, why, created) VALUES (?,?,?,?,?)").run(id, JSON.stringify(clean), by, why ? String(why).slice(0, 300) : null, now());
      emit("connectors.connection-proposed", { proposal: id, label });
      return { proposal: id, card };
    },
    proposals: () => /** @type {any[]} */ (db.prepare("SELECT * FROM connectors_proposals ORDER BY created DESC").all()).map(r => {
      const form = JSON.parse(r.form);
      if (form.site) { const { card, ...rest } = form; return { proposal: r.id, by: r.proposed_by, why: r.why, created: r.created, form: rest, card }; }
      return { proposal: r.id, by: r.proposed_by, why: r.why, created: r.created, form, card: cardOf(fromForm(form), form.credential.item) };
    }),
    /** The person's yes: the same create as the form's, as that person. */
    approve: async (/** @type {string} */ proposal, /** @type {string} */ as) => {
      const r = /** @type {any} */ (db.prepare("SELECT * FROM connectors_proposals WHERE id = ?").get(proposal));
      if (!r) throw fail(`no proposal ${String(proposal).slice(0, 40)}`, "not_found");
      const form = JSON.parse(r.form);
      const out = form.site
        ? await saveSite({ ...(form.id ? { id: form.id } : {}), label: form.label, origin: form.site, entries: await /** @type {any} */ (siteEntries)(form.site, form.operations), ...(form.polls ? { polls: form.polls } : {}) }, { as })
        : await save(form, { as, origin: "assistant" });
      db.prepare("DELETE FROM connectors_proposals WHERE id = ?").run(proposal);
      return out;
    },
    decline: (/** @type {string} */ proposal) => { const n = Number(db.prepare("DELETE FROM connectors_proposals WHERE id = ?").run(proposal).changes); if (!n) throw fail(`no proposal ${String(proposal).slice(0, 40)}`, "not_found"); return { declined: proposal }; },
    /** A Connection as a template: what is the app's (host, how a key is sent, operations, polls, the names of fixed headers) and nothing that is the person's (the key's item, the values typed, the dates). */
    exportTemplate: async (/** @type {string} */ id) => {
      const r = row(id); if (!r) throw fail(`no connection ${id}`, "not_found");
      const rec = shape(r, false), f = r.form ? JSON.parse(r.form) : {};
      const holes = (/** @type {Record<string, string>} */ vars) => Object.fromEntries(Object.keys(vars).map(k => [k, `{{${k}}}`]));
      const vars = f.vars || {};
      const sub = (/** @type {string} */ text) => Object.entries(vars).reduce((t, [k, v]) => (v ? t.split(encodeURIComponent(String(v))).join(`{${k}}`).split(String(v)).join(`{${k}}`) : t), text);
      return { template: 1, label: rec.label, ...(rec.app ? { app: rec.app } : { base_url: `https://${rec.host}` }), send: f.send || rec.auth, headers: Object.fromEntries(Object.entries(f.headers || {}).map(([k, v]) => [k, sub(String(v))])), vars: holes(vars),
        check: { path: sub(r.check_path) }, operations: rec.operations, credential: { item: "" } };
    },
    rebuild: async (/** @type {string} */ id, /** @type {string} */ as) => { const r = row(id); if (!r) throw fail(`no connection ${id}`, "not_found"); return { id, credential: await materialize(r, as) }; },
    remove: async (/** @type {string} */ id, /** @type {string} */ as) => {
      if (!row(id)) throw fail(`no connection ${id}`, "not_found");
      const had = (await items()).get(credentialName(id));
      if (had) { const r = await call("vault.delete", { name: credentialName(id) }, { as }); if (r.error) throw fail(`could not remove the credential: ${r.error.message}`, r.error.code || "vault"); }
      db.prepare("DELETE FROM connectors_made WHERE id = ?").run(id);
      await call("vault.connections.unregister", { ref: `made:${id}` });
      emit("connectors.connection-deleted", { id });
      return { id, removed: true };
    },
  };
}
