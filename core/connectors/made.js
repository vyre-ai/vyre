// @ts-check
// Connections a person made from any app's API: the stateful half of records/connectors/connection.js. A Connection is a row here (the declaration, the Vault item that holds the key, the check,
// its light) and nothing else is the truth: the vault credential `conn-<id>` is derived from the row and written only by `materialize`. The vault lets an api-credential be written only from a
// person's own surface, so a row is made, changed and rebuilt in a person's act; a credential found changed behind the row's back shows as out of step until that act rebuilds it.

import { defineConnector } from "../../records/connectors/format.js";
import { fromForm, toConfig, credentialName, outcomeOf, operationsOf } from "../../records/connectors/connection.js";

const AUTH_OF = { bearer: "bearer", basic: "password", "api-key": "api-key" };

/**
 * @param {{ db: any, call: (tool: string, input: any, opts?: any) => Promise<any>, now?: () => number, emit?: (type: string, payload: any) => void, log?: (m: string, x?: any) => void }} deps
 */
export function madeConnections({ db, call, now = Date.now, emit = () => {}, log = () => {} }) {
  const fail = (/** @type {string} */ msg, /** @type {string} */ code) => Object.assign(new Error(msg), { code });
  const data = (/** @type {any} */ r) => { if (r.error) throw fail(r.error.message, r.error.code || "failed"); return r.data; };
  const row = (/** @type {string} */ id) => /** @type {any} */ (db.prepare("SELECT * FROM connectors_made WHERE id = ?").get(id));
  const shape = (/** @type {any} */ r, /** @type {boolean} */ stale) => {
    const d = JSON.parse(r.declaration);
    const a = d.auth;
    const auth = a.type === "api-key" ? (a.in === "query" ? { kind: "query", name: a.param } : { kind: "header", name: a.header || "x-api-key" }) : { kind: a.type };
    const f = r.form ? JSON.parse(r.form) : {};
    return { id: r.id, label: r.label, host: new URL(d.base_url).hostname, auth, credential: { item: r.credential_item, ...(r.credential_field ? { field: r.credential_field } : {}) }, headers: f.headers || {}, vars: f.vars || {},
      check: { method: "GET", path: r.check_path }, origin: r.origin,
      light: stale ? "out_of_step" : r.light, reason: stale ? "the Vault credential was changed outside this connection; save the connection again to rebuild it" : r.reason, checked_at: r.checked_at, created: r.created,
      operations: operationsOf(d) };
  };

  /** The vault item names and when each was last written, for spotting drift. */
  async function items() {
    const l = data(await call("vault.list", {}));
    return new Map((l.items || []).map((/** @type {any} */ x) => [String(x.name), x]));
  }

  /** Write the derived credential from the row, as the person. @param {any} r @param {string} as */
  async function materialize(r, as) {
    const decl = defineConnector(JSON.parse(r.declaration));
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
    const reg = await call("vault.connections.register", { ref: `made:${r.id}`, provider: "custom", account: new URL(decl.base_url).hostname, auth: AUTH_OF[/** @type {keyof typeof AUTH_OF} */ (decl.auth.type)] || "api-key", label: decl.label });
    if (reg.error) log("connections: could not register the row", { id: r.id, error: reg.error.message });
    return name;
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
    if (stale) out = { light: "red", words: "the Vault credential was changed outside this connection; save the connection again to rebuild it" };
    else {
      const res = await call("vault.request", { credential: credentialName(id), method: "GET", url: d.base_url + r.check_path });
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
    save, check, row,
    list: async () => { return { connections: await Promise.all(/** @type {any[]} */ (db.prepare("SELECT * FROM connectors_made ORDER BY label").all()).map(async r => shape(r, await isStale(r)))) }; },
    get: async (/** @type {string} */ id) => {
      const r = row(id); if (!r) throw fail(`no connection ${id}`, "not_found");
      return { ...shape(r, await isStale(r)), declaration: JSON.parse(r.declaration) };
    },
    /** A Connection as a template: what is the app's (host, how a key is sent, operations, polls, the names of fixed headers) and nothing that is the person's (the key's item, the values typed, the dates). */
    exportTemplate: async (/** @type {string} */ id) => {
      const r = row(id); if (!r) throw fail(`no connection ${id}`, "not_found");
      const rec = shape(r, false), f = r.form ? JSON.parse(r.form) : {};
      const holes = (/** @type {Record<string, string>} */ vars) => Object.fromEntries(Object.keys(vars).map(k => [k, `{{${k}}}`]));
      const vars = f.vars || {};
      const sub = (/** @type {string} */ text) => Object.entries(vars).reduce((t, [k, v]) => (v ? t.split(encodeURIComponent(String(v))).join(`{${k}}`).split(String(v)).join(`{${k}}`) : t), text);
      return { template: 1, label: rec.label, base_url: `https://${rec.host}`, send: f.send || rec.auth, headers: Object.fromEntries(Object.entries(f.headers || {}).map(([k, v]) => [k, sub(String(v))])), vars: holes(vars),
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
