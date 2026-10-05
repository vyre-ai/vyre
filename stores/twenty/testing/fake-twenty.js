// @ts-check
// A fake Twenty for offline tests: an HTTP server that answers the exact operations the driver sends
// (metadata and core GraphQL, /healthz, /client-config) over an in-memory workspace, and sends signed
// webhooks like the worker does. It reproduces the facts the spike found: UUIDs of version 6 to 8 are
// refused, an update with a filter is a compare-and-set, soft-deleted rows are hidden unless the
// filter mentions deletedAt, and webhooks carry the full record and updatedFields but no "before".
// It is not Twenty: the live conformance run (testbox) is the real check.

import http from "node:http";
import crypto from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class GqlError extends Error { constructor(message, code = "BAD_USER_INPUT", subCode) { super(message); this.code = code; this.subCode = subCode; } }

export class FakeTwenty {
  constructor() {
    /** @type {Map<string, any>} */ this.objects = new Map();
    /** @type {Map<string, any>} views made through the metadata API, by id */ this.views = new Map();
    /** @type {Map<string, Map<string, any>>} */ this.rows = new Map();
    /** @type {any[]} */ this.hooks = [];
    /** @type {{ op: string, variables: any }[]} */ this.requests = [];
    this.key = "fake-key-" + crypto.randomBytes(6).toString("hex");
    this.workspaceId = crypto.randomUUID();
    this.version = "v2.44.0";
    this.limit = Infinity; this.served = 0;
    /** @type {((payload: any, headers: Record<string, string>, raw: string) => Promise<void>) | null} */ this.deliver = null;
    this.lastMs = 0;
    /** @type {http.Server | null} */ this.server = null;
    this.url = "";
  }
  async start() {
    this.server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise((r) => /** @type {http.Server} */ (this.server).listen(0, "127.0.0.1", () => r(null)));
    this.url = `http://127.0.0.1:${/** @type {any} */ (this.server.address()).port}`;
    return this;
  }
  async stop() { await new Promise((r) => this.server?.close(() => r(null))); this.server?.closeAllConnections?.(); }
  #now() { let ms = Date.now(); if (ms <= this.lastMs) ms = this.lastMs + 1; this.lastMs = ms; return new Date(ms).toISOString(); }

  async #handle(req, res) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const send = (code, v, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(typeof v === "string" ? v : JSON.stringify(v)); };
    if (req.url === "/healthz") return send(200, { status: "ok" });
    if (req.url === "/client-config") return send(200, { appVersion: this.version });
    const { query, variables } = JSON.parse(body || "{}");
    const op = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "";
    if (!op.startsWith("Boot_") && !op.startsWith("Rot_") && req.headers.authorization !== `Bearer ${this.key}` && !(this.validKeys ?? new Set()).has(String(req.headers.authorization).slice(7))) return send(401, { errors: [{ message: "Unauthorized" }] });
    if (!op.startsWith("Boot_") && !op.startsWith("Rot_") && ++this.served > this.limit) { this.served = 0; return send(429, { errors: [{ message: "Too many requests" }] }); }
    this.requests.push({ op, variables });
    try {
      const data = req.url === "/metadata" ? this.#metadata(op, variables, query) : req.url === "/graphql" ? await this.#core(op, variables, query) : (() => { throw new GqlError("not found"); })();
      send(200, { data });
    } catch (e) {
      if (e instanceof GqlError) return send(200, { errors: [{ message: e.message, extensions: { code: e.code, ...(e.subCode ? { subCode: e.subCode } : {}) } }], data: null });
      send(500, { errors: [{ message: String(/** @type {Error} */ (e).stack) }] });
    }
  }

  #metadata(op, v, query = "") {
    if (op.startsWith("Boot_") || op.startsWith("Rot_")) return this.#boot(op, query);
    switch (op) {
      case "Cols": return { objects: { edges: [...this.objects.values()].map((o) => ({ node: { id: o.id, nameSingular: o.nameSingular, fields: { edges: [...o.fields.values()].map((f) => ({ node: { name: f.name } })) } } })) } };
      case "AuditProbe": return { __type: { inputFields: [{ name: "nameSingular" }, { name: "isAuditLogged" }] } };
      case "Health": return { objects: { totalCount: this.objects.size } };
      case "Objs": return { objects: { edges: [...this.objects.values()].map((o) => ({ node: { id: o.id, nameSingular: o.nameSingular, namePlural: o.namePlural, labelSingular: o.labelSingular, icon: o.icon, isAuditLogged: o.isAuditLogged, fields: { edges: [...o.fields.values()].map((f) => ({ node: f })) } } })) } };
      case "CreateObj": {
        const o = v.i.object;
        if (this.objects.has(o.nameSingular)) throw new GqlError("An object with that name already exists");
        const obj = { id: crypto.randomUUID(), nameSingular: o.nameSingular, namePlural: o.namePlural, labelSingular: o.labelSingular, icon: o.icon, isAuditLogged: o.isAuditLogged !== false, fields: new Map([["name", { id: crypto.randomUUID(), name: "name", type: "TEXT", options: null, isActive: true }]]) };
        this.objects.set(o.nameSingular, obj); this.rows.set(o.nameSingular, new Map());
        return { createOneObject: { id: obj.id, nameSingular: obj.nameSingular } };
      }
      case "UpdObj": { const o = [...this.objects.values()].find((x) => x.id === v.i.id); if (!o) throw new GqlError("Object not found", "NOT_FOUND"); Object.assign(o, v.i.update); return { updateOneObject: { id: o.id } }; }
      case "CreateField": {
        const f = v.i.field; const obj = [...this.objects.values()].find((o) => o.id === f.objectMetadataId);
        if (!obj) throw new GqlError("Object not found", "NOT_FOUND");
        if (obj.fields.has(f.name)) throw new GqlError("Field already exists");
        const field = { id: crypto.randomUUID(), name: f.name, type: f.type, options: f.options ?? null, isActive: true, defaultValue: f.defaultValue, isUnique: f.isUnique === true };
        obj.fields.set(f.name, field); return { createOneField: { id: field.id, name: field.name } };
      }
      case "UpdField": {
        for (const o of this.objects.values()) for (const f of o.fields.values()) if (f.id === v.i.id) {
          if (v.i.update.options !== undefined) f.options = v.i.update.options;
          if (v.i.update.isUnique !== undefined) {
            if (v.i.update.isUnique) { const seen = new Set(); for (const r of this.rows.get(o.nameSingular).values()) { if (r[f.name] == null) continue; const k = JSON.stringify(r[f.name]); if (seen.has(k)) throw new GqlError(`could not create unique index "IDX_UNIQUE_${f.name}": duplicate key value violates unique constraint`); seen.add(k); } }
            f.isUnique = v.i.update.isUnique;
          }
          return { updateOneField: { id: f.id } };
        }
        throw new GqlError("Field not found", "NOT_FOUND");
      }
      // views (stores/twenty/views.js): kept as one row each with the parts that were made for it
      case "V": return { getViews: [...this.views.values()].filter((w) => w.objectMetadataId === v.o).map((w) => ({ id: w.id })) };
      case "Gone": case "Re": { this.views.delete(v.id); return { destroyView: true }; }
      case "MkView": { this.views.set(v.i.id, { ...v.i, viewFields: [], viewSorts: [], viewFilterGroups: [], viewFilters: [] }); return { createView: { id: v.i.id } }; }
      case "MkVF": { this.views.get(v.i.viewId).viewFields.push(v.i); return { createViewField: { id: "vf" } }; }
      case "MkVS": { this.views.get(v.i.viewId).viewSorts.push(v.i); return { createViewSort: { id: "vs" } }; }
      case "MkVFG": { const g = { ...v.i, id: crypto.randomUUID() }; this.views.get(v.i.viewId).viewFilterGroups.push(g); return { createViewFilterGroup: { id: g.id } }; }
      case "MkVFl": { this.views.get(v.i.viewId).viewFilters.push(v.i); return { createViewFilter: { id: "vfl" } }; }
      case "Hooks": return { webhooks: this.hooks.map((h) => ({ id: h.id, targetUrl: h.targetUrl, description: h.description })) };
      case "NewHook": { const h = { id: crypto.randomUUID(), ...v.i }; this.hooks.push(h); return { createWebhook: { id: h.id } }; }
      case "DelHook": { this.hooks = this.hooks.filter((h) => h.id !== v.id); return { deleteWebhook: { id: v.id } }; }
      default: throw new GqlError(`Unknown metadata operation ${op}`);
    }
  }

  /** The headless bootstrap the provisioner runs, in the order it runs it. */
  #boot(op, query) {
    this.boot = this.boot ?? { calls: [], origin: null };
    this.boot.calls.push(op);
    switch (op) {
      case "Boot_signUp": return { signUp: { tokens: { accessOrWorkspaceAgnosticToken: { token: "agnostic" } } } };
      case "Boot_signIn": return { signIn: { tokens: { accessOrWorkspaceAgnosticToken: { token: "agnostic" } } } };
      case "Boot_workspace": return { signUpInNewWorkspace: { loginToken: { token: "login" }, workspace: { id: this.workspaceId } } };
      case "Boot_login": return { getAuthTokensFromLoginToken: { tokens: { accessOrWorkspaceAgnosticToken: { token: "access" } } } };
      case "Boot_activate": return { activateWorkspace: { id: this.workspaceId } };
      case "Boot_roles": return { getRoles: [{ id: "role-member", label: "Member" }, { id: "role-admin", label: "Admin" }] };
      case "Boot_key": return { createApiKey: { id: "key-1" } };
      case "Boot_token": return { generateApiKeyToken: { token: this.key } };
      case "Rot_loginToken": return { getLoginTokenFromCredentials: { loginToken: { token: "login" } } };
      case "Rot_login": return { getAuthTokensFromLoginToken: { tokens: { accessOrWorkspaceAgnosticToken: { token: "access" } } } };
      case "Rot_roles": return { getRoles: [{ id: "role-member", label: "Member" }, { id: "role-admin", label: "Admin" }] };
      case "Rot_key": return { createApiKey: { id: `key-${this.boot.calls.length}` } };
      case "Rot_token": { this.rotated = (this.rotated ?? 0) + 1; const t = this.nextKey ?? `rotated-${this.rotated}`; (this.validKeys ??= new Set()).add(t); return { generateApiKeyToken: { token: t } }; }
      case "Rot_check": return { objects: { edges: [] } };
      case "Rot_revoke": this.revoked = (this.revoked ?? 0) + 1; return { revokeApiKey: { id: "x" } };
      case "Boot_close": this.boot.closed = true; return { updateWorkspace: { id: this.workspaceId } };
      default: throw new GqlError(`Unknown bootstrap operation ${op}`);
    }
  }

  /** @param {string} name @returns {{ obj: any, rows: Map<string, any> }} */
  #objBySingular(name) { const obj = this.objects.get(name); if (!obj) throw new GqlError(`Cannot query field "${name}" on type "Query".`); return { obj, rows: /** @type {Map<string, any>} */ (this.rows.get(name)) }; }
  #objByPlural(name) { for (const o of this.objects.values()) if (o.namePlural === name) return { obj: o, rows: /** @type {Map<string, any>} */ (this.rows.get(o.nameSingular)) }; throw new GqlError(`Cannot query field "${name}" on type "Query".`); }

  #checkInput(obj, d) {
    for (const [k, val] of Object.entries(d)) {
      if (k === "id") { if (!UUID.test(String(val))) throw new GqlError(`Value "${val}" is not a valid UUID`); continue; }
      const f = obj.fields.get(k); if (!f) throw new GqlError(`Field "${k}" is not defined by type`);
      if (val === null) continue;
      if (f.type === "SELECT" && !(f.options ?? []).some((/** @type {any} */ o) => o.value === val)) throw new GqlError(`Value "${val}" does not exist in the select`);
      if (f.type === "UUID" && !UUID.test(String(val))) throw new GqlError(`Value "${val}" is not a valid UUID`);
      if (f.type === "NUMBER" && typeof val !== "number") throw new GqlError("Float cannot represent non numeric value");
      if (f.type === "TEXT" && typeof val !== "string") throw new GqlError("String cannot represent a non string value");
      if (f.type === "BOOLEAN" && typeof val !== "boolean") throw new GqlError("Boolean cannot represent a non boolean value");
      if (f.type === "MULTI_SELECT" && (!Array.isArray(val) || val.some((x) => !(f.options ?? []).some((/** @type {any} */ o) => o.value === x)))) throw new GqlError("Value does not exist in the multi select");
      if (f.type === "RATING" && !/^RATING_[1-5]$/.test(String(val))) throw new GqlError("Not a rating");
      if (f.type === "CURRENCY" && (typeof val !== "object" || typeof val.amountMicros !== "number")) throw new GqlError("Not a currency");
    }
  }

  async #core(op, v, query = "") {
    if (op === "PurgeTimeline") { this.timelinePurges = (this.timelinePurges ?? 0) + 1; return { destroyTimelineActivities: [] }; }
    const [kind, ...rest] = op.split("_"); const name = rest.join("_");
    if (kind === "Get") { const { rows } = this.#objBySingular(name); const rowsList = [...rows.values()].filter((r) => this.#match(r, v.f)); this.#visible(v.f, rowsList); return { [name]: rowsList.filter((r) => this.#vis(v.f, r))[0] ?? null }; }
    if (kind === "Q") {
      const { obj, rows } = this.#objByPlural(name);
      let list = [...rows.values()].filter((r) => this.#vis(v.f, r) && this.#match(r, v.f));
      list = this.#sort(obj, list, v.o);
      // a keyset cursor: the id of the last row served; the next page is what sorts after it
      let start = 0;
      if (v.after) { const lastId = Buffer.from(v.after, "base64").toString(); const i = list.findIndex((r) => r.id === lastId); if (i < 0) throw new GqlError("Invalid cursor"); start = i + 1; }
      const first = v.first ?? 60;
      const page = list.slice(start, start + first);
      return { [name]: { edges: page.map((r) => ({ node: r })), pageInfo: { hasNextPage: start + first < list.length, endCursor: page.length ? Buffer.from(page[page.length - 1].id).toString("base64") : null }, totalCount: list.length } };
    }
    if (kind === "Destroy") {
      const { obj, rows } = this.#objByPlural(name);
      const gone = [...rows.values()].filter((r) => this.#match(r, v.f));
      for (const r of gone) rows.delete(r.id);
      return { [`destroy${obj.namePlural[0].toUpperCase()}${obj.namePlural.slice(1)}`]: gone.map((r) => ({ id: r.id })) };
    }
    if (kind === "Cnt") { const { rows } = this.#objByPlural(name); return { [name]: { totalCount: rows.size, edges: [] } }; }
    if (kind === "Agg") {
      const { rows } = this.#objByPlural(name);
      const dims = v.g.map((x) => Object.keys(x)[0]);
      const list = [...rows.values()].filter((r) => this.#vis(v.f, r) && this.#match(r, v.f));
      // the aggregate fields the query asks for: sumX, avgX, minX, maxX, countNotEmptyX (a money field's are sumXAmountMicros ...)
      const asked = [...new Set([...query.matchAll(/\b(sum|avg|min|max|countNotEmpty)([A-Z]\w*?)(AmountMicros)?\b/g)].map((m) => m[0]))].map((tok) => { const m = /^(sum|avg|min|max|countNotEmpty)([A-Z]\w*?)(AmountMicros)?$/.exec(tok); return { tok, fn: m[1], col: m[2][0].toLowerCase() + m[2].slice(1), micros: Boolean(m[3]) }; });
      const val = (r, a) => { const x = r[a.col]; return a.micros ? (x == null ? null : x.amountMicros) : x; };
      const b = new Map();
      for (const r of list) { const k = JSON.stringify(dims.map((d) => r[d] ?? null)); const e = b.get(k) ?? { groupByDimensionValues: dims.map((d) => r[d] ?? null), totalCount: 0, rows: [] }; e.totalCount++; e.rows.push(r); b.set(k, e); }
      return { [`${name}GroupBy`]: [...b.values()].map(({ rows: rs, ...e }) => { const out = { ...e }; for (const a of asked) { const xs = rs.map((r) => val(r, a)).filter((x) => x !== null && x !== undefined && x !== ""); out[a.tok] = a.fn === "countNotEmpty" ? xs.length : !xs.length ? null : a.fn === "sum" ? xs.reduce((p, c) => p + Number(c), 0) : a.fn === "avg" ? xs.reduce((p, c) => p + Number(c), 0) / xs.length : a.fn === "min" ? Math.min(...xs.map(Number)) : Math.max(...xs.map(Number)); } return out; }) };
    }
    if (kind === "Create") {
      const { obj, rows } = this.#objBySingular(name); const d = v.d;
      this.#checkInput(obj, d);
      if (rows.has(d.id)) throw new GqlError("duplicate key value violates unique constraint \"PK_pkey\"", "INTERNAL_SERVER_ERROR");
      this.#unique(obj, rows, d, null);
      const at = this.#now();
      const row = { name: null, position: 0, createdBy: { source: "API", name: "vyre-gateway" }, updatedBy: { source: "API", name: "vyre-gateway" }, searchVector: "", ...d, createdAt: at, updatedAt: at, deletedAt: null };
      rows.set(row.id, row); this.#emit(name, "created", row, Object.keys(d));
      return { [`create${cap(name)}`]: row };
    }
    if (kind === "Update") {
      const { obj, rows } = this.#objByPlural(name); this.#checkInput(obj, v.d);
      const hit = [...rows.values()].filter((r) => this.#vis(v.f, r) && this.#match(r, v.f));
      const out = [];
      for (const r of hit) this.#unique(obj, rows, { ...r, ...v.d }, r.id);
      for (const r of hit) { Object.assign(r, v.d, { updatedAt: this.#now(), updatedBy: { source: "API", name: "vyre-gateway" } }); this.#emit(obj.nameSingular, "updated", r, Object.keys(v.d)); out.push(r); }
      return { [`update${cap(name)}`]: out };
    }
    if (kind === "Delete" || kind === "Restore") {
      const { obj, rows } = this.#objBySingular(name); if (!UUID.test(v.id)) throw new GqlError(`Value "${v.id}" is not a valid UUID`);
      const r = rows.get(v.id); if (!r) throw new GqlError("Record not found", "NOT_FOUND", "RECORD_NOT_FOUND");
      if (kind === "Restore") this.#unique(obj, rows, r, r.id);
      r.deletedAt = kind === "Delete" ? this.#now() : null; r.updatedAt = this.#now();
      this.#emit(name, kind === "Delete" ? "deleted" : "restored", r, ["deletedAt"]);
      return { [`${kind.toLowerCase()}${cap(name)}`]: r };
    }
    throw new GqlError(`Unknown operation ${op}`);
  }
  /** the unique fields of an object, enforced among ALL rows, soft-deleted ones included, as the real unique index is (the store moves a removed record's values out: HELD_FIELD) @param {any} obj @param {Map<string, any>} rows @param {any} cand @param {string | null} selfId */
  #unique(obj, rows, cand, selfId) {
    for (const f of obj.fields.values()) {
      if (!f.isUnique || cand[f.name] == null) continue;
      for (const r of rows.values()) if (r.id !== selfId && JSON.stringify(r[f.name]) === JSON.stringify(cand[f.name])) throw new GqlError(`duplicate key value violates unique constraint "IDX_UNIQUE_${obj.nameSingular}_${f.name}"`, "INTERNAL_SERVER_ERROR");
    }
  }
  #vis(filter, row) { return JSON.stringify(filter ?? {}).includes("deletedAt") ? true : !row.deletedAt; }
  #visible() {}

  #cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  #match(row, f) {
    if (!f) return true;
    for (const [k, c] of Object.entries(f)) {
      if (k === "and") { if (!c.every((x) => this.#match(row, x))) return false; continue; }
      if (k === "or") { if (!c.some((x) => this.#match(row, x))) return false; continue; }
      if (k === "not") { if (this.#match(row, c)) return false; continue; }
      let val = row[k];
      for (const [op, rhs0] of Object.entries(c)) {
        let rhs = rhs0, lhs = val;
        if (op === "amountMicros") { lhs = val?.amountMicros ?? null; for (const [o2, r2] of Object.entries(rhs0)) if (!this.#op(o2, lhs, r2)) return false; continue; }
        if (!this.#op(op, lhs, rhs)) return false;
      }
    }
    return true;
  }
  #op(op, a, b) {
    switch (op) {
      case "eq": return a === b || (a && b && typeof a === "string" && typeof b === "string" && a.slice(0, 23) === b.slice(0, 23) && /T/.test(a)) ;
      case "neq": return a !== b;
      case "in": return b.includes(a);
      case "is": return b === "NULL" ? a == null || (Array.isArray(a) && a.length === 0) : a != null && !(Array.isArray(a) && a.length === 0);
      case "containsAny": return Array.isArray(a) && b.some((/** @type {any} */ x) => a.includes(x));
      case "ilike": { if (a == null) return false; const re = new RegExp("^" + String(b).replace(/[.*+?^${}()|[\]]/g, "\\$&").replace(/\\\\([%_])/g, "\u0001$1").replace(/%/g, ".*").replace(/_/g, ".").replace(/\u0001(.)/g, "$1") + "$", "i"); return re.test(String(a)); }
      case "gt": return a != null && this.#cmp(a, b) > 0;
      case "gte": return a != null && this.#cmp(a, b) >= 0;
      case "lt": return a != null && this.#cmp(a, b) < 0;
      case "lte": return a != null && this.#cmp(a, b) <= 0;
      default: throw new GqlError(`Unknown filter operator ${op}`);
    }
  }
  #sort(obj, list, order) {
    const specs = (order ?? []).flatMap((o) => Object.entries(o));
    return [...list].sort((x, y) => {
      for (const [field, dirRaw] of specs) {
        const dir = typeof dirRaw === "object" ? Object.values(dirRaw)[0] : dirRaw; const sub = typeof dirRaw === "object" ? Object.keys(dirRaw)[0] : null;
        const a = sub ? x[field]?.[sub] : x[field], b = sub ? y[field]?.[sub] : y[field];
        if (a === b) continue;
        const desc = String(dir).startsWith("Desc");
        if (a == null) return desc ? 1 : -1; if (b == null) return desc ? -1 : 1;
        const c = this.#cmp(a, b); return desc ? -c : c;
      }
      return this.#cmp(x.id, y.id);
    });
  }

  /** Send the signed webhook for a record event, like the worker does, a moment later. */
  #emit(singular, kind, row, updatedFields) {
    for (const h of this.hooks) {
      if (!h.operations.some((/** @type {string} */ o) => o === "*.*" || o === `${singular}.${kind}`)) continue;
      const payload = { targetUrl: h.targetUrl, eventName: `${singular}.${kind}`, objectMetadata: { id: this.objects.get(singular).id, nameSingular: singular }, workspaceId: this.workspaceId, webhookId: h.id, eventDate: new Date().toISOString(), record: { ...row }, updatedFields };
      const ts = String(Date.now()); const raw = JSON.stringify(payload);
      const headers = { "content-type": "application/json", "x-twenty-webhook-timestamp": ts, "x-twenty-webhook-nonce": crypto.randomBytes(8).toString("hex"), "x-twenty-webhook-signature": crypto.createHmac("sha256", h.secret).update(`${ts}:${JSON.stringify(payload)}`).digest("hex") };
      setTimeout(() => { (this.deliver ? this.deliver(payload, headers, raw) : fetch(h.targetUrl, { method: "POST", headers, body: raw })).catch(() => {}); }, 15);
    }
  }

  // ---- test hooks
  /** Forget every object, row and webhook: a fresh Twenty, same server and key. */
  reset() { this.objects.clear(); this.rows.clear(); this.hooks = []; this.requests = []; this.limit = Infinity; this.served = 0; }
  /** Change a row inside Twenty, bypassing the driver. Fields use Twenty's names. */
  behind(singular, id, patch) { const r = this.rows.get(singular)?.get(id); if (!r) throw new Error("no row"); Object.assign(r, patch, { updatedAt: this.#now(), updatedBy: { source: "EMAIL", name: "sync" } }); this.#emit(singular, "updated", r, Object.keys(patch)); }
  /** Change a field the language does not declare. */
  touch(singular, id) { const r = this.rows.get(singular)?.get(id); if (!r) throw new Error("no row"); r.position = (r.position ?? 0) + 1; r.searchVector = `v${r.position}`; r.updatedAt = this.#now(); }
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
