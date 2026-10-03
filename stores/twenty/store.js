// @ts-check
// The Twenty store: the business-records store behind the gateway, implementing the kernel's Store
// interface (kernel/contracts/store.d.ts) and passing the kernel's conformance suite. One Twenty per
// Space, unmodified, reached only on the Space's internal network as one service user.
//
//  - Our ids: the id the gateway mints is the id Twenty keeps (v7 layout, version nibble 4).
//  - Versions: a `vyreVersion` number on every row. Every write is a compare-and-set on the version
//    and on Twenty's updatedAt, so an edit made inside Twenty (a sync, an import, a person with the
//    database) is noticed: it changes updatedAt without our version, and the next read or the webhook
//    absorbs it as a new version, in order. A caller holding the old version gets version_conflict.
//  - Sealed fields hold the kernel's reference value, never a value.
//  - changes() reports every change in order: our own writes as they happen, and what Twenty did on its
//    own as the signed webhook arrives (a webhook has no "before"; it comes from our snapshot).
//  - Nothing here decides who may see what: the gateway filters rows and fields itself.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { isUuid } from "../../kernel/core/ids.js";
import { createAggregator } from "../../kernel/store/query.js";
import { SnapshotStore } from "./snapshots.js";
import { twentyGet } from "./client.js";
import { planType, pascal, selection, checkData, toInput, fromRow, toFilter, toOrderBy, PlanError, VERSION_FIELD } from "./plan.js";

/** The conformance suite revision this store last passed (kernel/conformance/suite.js SUITE_REVISION). */
export const CONFORMANCE_REVISION = 5;
const MAX_PAGE = 200;
const MAX_SCAN = 50_000;
const EITHER = { or: [{ deletedAt: { is: "NULL" } }, { deletedAt: { is: "NOT_NULL" } }] };

export class StoreError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "StoreError"; this.code = code; }
}
/** @param {unknown} e */
function asStoreError(e) {
  if (e instanceof StoreError) return e;
  if (e instanceof PlanError) return new StoreError(e.code, e.message);
  const c = /** @type {any} */ (e)?.code;
  const code = c === "not_found" ? "not_found" : c === "unique_violation" ? "unique_violation" : c === "id_exists" || c === "invalid" ? "invalid" : c === "rate_limited" || c === "unavailable" ? "unavailable" : "unavailable";
  return new StoreError(code, String(/** @type {any} */ (e)?.message ?? e));
}

/**
 * @typedef {import("./client.js").TwentyClient} TwentyClient
 * @typedef {{ client: TwentyClient, space: string, dir: string | null, webhookSecret: string, graceMs?: number, now?: () => number }} StoreOptions
 */

export class TwentyStore {
  /** @param {StoreOptions} o */
  constructor(o) {
    this.client = o.client; this.space = o.space; this.dir = o.dir; this.secret = o.webhookSecret;
    this.graceMs = o.graceMs ?? 250; this.now = o.now ?? Date.now;
    /** @type {Map<string, import("./plan.js").TypePlan>} */ this.plans = new Map();
    this.snaps = new SnapshotStore(o.dir ? path.join(o.dir, "snapshots.jsonl") : null);
    /** @type {any[]} */ this.log = [];
    this.logFile = o.dir ? path.join(o.dir, "changes.jsonl") : null;
    /** @type {Set<string>} */ this.self = new Set();
    /** @type {Set<string>} */ this.seen = new Set();
    /** @type {Map<string, number>} */ this.nonces = new Map();
    this.rejected = 0;
    if (this.logFile && fs.existsSync(this.logFile)) for (const l of fs.readFileSync(this.logFile, "utf8").split("\n")) { if (!l) continue; try { this.log.push(JSON.parse(l)); } catch { /* torn line */ } }
    if (o.dir) this.#loadTypes();
  }

  // ---- plumbing --------------------------------------------------------------------------------
  #loadTypes() {
    const f = path.join(/** @type {string} */ (this.dir), "types.json");
    if (!fs.existsSync(f)) return;
    for (const t of JSON.parse(fs.readFileSync(f, "utf8"))) { const p = planType(t.def, { plural: t.plural }); this.plans.set(p.vyre, p); }
  }
  #saveTypes() {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, "types.json"), JSON.stringify([...this.plans.values()].map((p) => ({ def: p.def, plural: p.plural }))), { mode: 0o600 });
  }
  /** @param {string} type */
  #plan(type) { const p = this.plans.get(type); if (!p) throw new StoreError("unknown_type", `no type ${type}`); return p; }
  /** @param {string} singular */ planBySingular(singular) { for (const p of this.plans.values()) if (p.singular === singular) return p; return null; }

  /** Run a Twenty call and turn its errors into store errors. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  async #t(fn) { try { return await fn(); } catch (e) { throw asStoreError(e); } }

  /** @param {import("./plan.js").TypePlan} p @param {any} row @returns {any} */
  #rec(p, row) { return fromRow(p, row); }
  /** @param {import("./plan.js").TypePlan} p @param {any} row */
  #snap(p, row) { const r = this.#rec(p, row); this.snaps.set(p.vyre, row.id, { version: r.version, updatedAt: row.updatedAt, data: r.data }); return r; }
  /** @param {any} entry */
  #note(entry) {
    const e = { cursor: `c${this.log.length + 1}`, ...entry };
    this.log.push(e);
    if (this.logFile) { fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 }); fs.appendFileSync(this.logFile, JSON.stringify(e) + "\n", { mode: 0o600 }); }
  }
  /** @param {string} id @param {string} updatedAt */
  #mine(id, updatedAt) { this.self.add(`${id}@${updatedAt}`); this.seen.add(`${id}@${updatedAt}`); if (this.self.size > 50_000) this.self.delete(/** @type {string} */ (this.self.values().next().value)); }

  /** @param {import("./plan.js").TypePlan} p @param {string} id @param {"live" | "any" | "deleted"} [scope] */
  async #row(p, id, scope = "live") {
    const f = scope === "any" ? { and: [{ id: { eq: id } }, EITHER] } : scope === "deleted" ? { and: [{ id: { eq: id } }, { deletedAt: { is: "NOT_NULL" } }] } : { id: { eq: id } };
    try {
      const d = await this.client.gql("graphql", `query Get_${p.singular}($f: ${pascal(p.singular)}FilterInput) { ${p.singular}(filter: $f) { ${selection(p)} } }`, { f: f });
      return d[p.singular] ?? null;
    } catch (e) { if (/** @type {any} */ (e)?.code === "not_found") return null; throw e; }
  }

  /** compare-and-set write of some fields on a row; returns the new row or null when the guard no longer holds */
  async #cas(/** @type {import("./plan.js").TypePlan} */ p, /** @type {string} */ id, /** @type {any} */ guard, /** @type {Record<string, any>} */ data) {
    const P = pascal(p.singular);
    const f = { and: [{ id: { eq: id } }, ...guard, EITHER] };
    const d = await this.client.gql("graphql", `mutation Update_${p.plural}($f: ${P}FilterInput, $d: ${P}UpdateInput!) { update${pascal(p.plural)}(filter: $f, data: $d) { ${selection(p)} } }`, { f, d: data });
    const rows = d[`update${pascal(p.plural)}`];
    if (rows.length) this.#mine(id, rows[0].updatedAt);
    return rows[0] ?? null;
  }

  /**
   * A row whose updatedAt does not match what we recorded for its version was changed inside Twenty (or
   * was created there). Give it the next version, in order, and report it. Returns the row to use.
   * @param {import("./plan.js").TypePlan} p @param {any} row @param {{ kind?: string }} [o]
   */
  async #settle(p, row, o = {}) {
    const snap = this.snaps.get(p.vyre, row.id);
    const v = row[VERSION_FIELD] == null ? null : Number(row[VERSION_FIELD]);
    const key = `${row.id}@${row.updatedAt}`;
    const external = v === null || (snap && snap.updatedAt !== row.updatedAt && snap.version === v);
    if (!external || this.self.has(key)) { if (!snap) this.#snap(p, row); return row; }
    const next = (v ?? 0) + 1;
    const bumped = await this.#cas(p, row.id, [{ updatedAt: { eq: row.updatedAt } }, ...(v === null ? [] : [{ [VERSION_FIELD]: { eq: v } }])], { [VERSION_FIELD]: next });
    const use = bumped ?? row;
    const before = snap?.data ?? null;
    const rec = this.#snap(p, use);
    this.seen.add(key);
    this.#note({ type: p.vyre, id: row.id, kind: o.kind ?? (snap ? (row.deletedAt ? "removed" : "updated") : "created"), version: rec.version, at: this.now(), ...(before ? { before } : {}), after: rec.data, source: "twenty" });
    return use;
  }

  // ---- features and health ---------------------------------------------------------------------
  features() { return { aggregate: true, search: true, changes: true, cursor_paging: /** @type {const} */ (true) }; }
  async health() {
    const h = await twentyGet(this.client, "/healthz");
    if (h.status !== 200) return { ok: false, detail: `Twenty is not answering (${h.status || "no reply"})`, checked_at: this.now() };
    try { await this.client.gql("metadata", "query Health { objects(paging: { first: 1 }) { edges { node { id } } } }"); } catch (e) { return { ok: false, detail: /** @type {Error} */ (e).message, checked_at: this.now() }; }
    return { ok: true, checked_at: this.now() };
  }
  async version() {
    const r = await twentyGet(this.client, "/client-config");
    let v = "unknown"; try { v = JSON.parse(r.body).appVersion ?? v; } catch { /* keep */ }
    return { store: "twenty", version: String(v), conformance: CONFORMANCE_REVISION };
  }

  // ---- definitions -----------------------------------------------------------------------------
  /** @param {{ add_types?: any[], change_types?: any[], remove_types?: string[] }} diff */
  async define(diff) {
    const changes = [];
    const cur = await this.#t(() => this.client.gql("metadata", "query Objs { objects(paging: { first: 200 }) { edges { node { id nameSingular namePlural labelSingular icon fields(paging: { first: 200 }) { edges { node { id name type options isUnique } } } } } } }"));
    /** @type {Map<string, any>} */ const objs = new Map(cur.objects.edges.map((/** @type {any} */ e) => [e.node.nameSingular, e.node]));
    /** @param {any} def @param {boolean} mustExist */
    const apply = async (def, mustExist) => {
      const known = this.plans.get(def.name);
      if (mustExist && !known && !objs.has(planType(def).singular)) throw new StoreError("unknown_type", `no type ${def.name}`);
      const p = planType(def, known ? { plural: known.plural } : {});
      let obj = objs.get(p.singular);
      if (known && canonical(known.def) === canonical(def) && obj) return;
      if (!obj) {
        const r = await this.client.gql("metadata", "mutation CreateObj($i: CreateOneObjectInput!) { createOneObject(input: $i) { id nameSingular } }", { i: { object: { nameSingular: p.singular, namePlural: p.plural, labelSingular: p.label, labelPlural: p.label + "s", icon: p.icon } } });
        obj = { id: r.createOneObject.id, nameSingular: p.singular, labelSingular: p.label, icon: p.icon, fields: { edges: [] } }; objs.set(p.singular, obj);
        changes.push(`added type ${def.name}`);
      } else {
        if (known) for (const old of known.fields) if (!p.byVyre.has(old.vyre)) throw new StoreError("unsupported", `Field ${old.vyre} of ${def.name} was removed: removing a field is a migration, not a define`);
        if (obj.labelSingular !== p.label || (obj.icon ?? p.icon) !== p.icon) { await this.client.gql("metadata", "mutation UpdObj($i: UpdateOneObjectInput!) { updateOneObject(input: $i) { id } }", { i: { id: obj.id, update: { labelSingular: p.label, labelPlural: p.label + "s", icon: p.icon } } }); obj.labelSingular = p.label; obj.icon = p.icon; changes.push(`changed type ${def.name}`); }
      }
      /** @type {Map<string, any>} */ const have = new Map(obj.fields.edges.map((/** @type {any} */ e) => [e.node.name, e.node]));
      const wanted = [...p.fields.filter((f) => !f.isTitle), { twenty: VERSION_FIELD, type: "NUMBER", vyre: VERSION_FIELD, def: { label: "Vyre version" }, settings: { dataType: "int", decimals: 0, type: "number" }, options: undefined, kind: "system" }];
      for (const f of wanted) {
        const ex = have.get(f.twenty);
        if (!ex) {
          const field = { objectMetadataId: obj.id, type: f.type, name: f.twenty, label: f.def.label ?? f.vyre, isNullable: true, ...(f.def.unique === true ? { isUnique: true } : {}), ...(f.options ? { options: f.options } : {}), ...(f.settings ? { settings: f.settings } : {}) };
          await this.client.gql("metadata", "mutation CreateField($i: CreateOneFieldMetadataInput!) { createOneField(input: $i) { id name } }", { i: { field } });
          if (f.twenty !== VERSION_FIELD) changes.push(`added field ${def.name}.${f.vyre}`);
          continue;
        }
        if (ex.type !== f.type) throw new StoreError("unsupported", `Field ${f.vyre} of ${def.name} changed kind: that is a migration, not a define`);
        // `unique` on or off: Twenty builds or drops the index; over existing duplicates it refuses, which the client reports as unique_violation
        if (f.vyre !== VERSION_FIELD && Boolean(ex.isUnique) !== (f.def.unique === true)) { await this.client.gql("metadata", "mutation UpdUnique($i: UpdateOneFieldMetadataInput!) { updateOneField(input: $i) { id } }", { i: { id: ex.id, update: { isUnique: f.def.unique === true } } }); changes.push(`changed field ${def.name}.${f.vyre}`); }
        if (f.options) {
          const exVals = new Set((ex.options ?? []).map((/** @type {any} */ o) => o.value));
          for (const v of exVals) if (!f.options.some((o) => o.value === v)) throw new StoreError("unsupported", `An option of ${def.name}.${f.vyre} was removed: that is a migration, not a define`);
          if (f.options.some((o) => !exVals.has(o.value))) { await this.client.gql("metadata", "mutation UpdField($i: UpdateOneFieldMetadataInput!) { updateOneField(input: $i) { id } }", { i: { id: ex.id, update: { options: f.options } } }); changes.push(`changed field ${def.name}.${f.vyre}`); }
        }
      }
      this.plans.set(def.name, p);
    };
    try {
      for (const t of diff.add_types ?? []) await apply(t, false);
      for (const t of diff.change_types ?? []) await apply(t, true);
      for (const name of diff.remove_types ?? []) {
        const p = this.plans.get(name); if (!p) continue;
        const live = await this.query(name, { page: { limit: 1 }, include_deleted: false });
        if (live.rows.length) throw new StoreError("invalid", `type ${name} still has records`);
        const o = objs.get(p.singular);
        if (o) { await this.client.gql("metadata", "mutation Off($i: UpdateOneObjectInput!) { updateOneObject(input: $i) { id } }", { i: { id: o.id, update: { isActive: false } } }); await this.client.gql("metadata", "mutation Del($i: DeleteOneObjectInput!) { deleteOneObject(input: $i) { id } }", { i: { id: o.id } }); }
        this.plans.delete(name); changes.push(`removed type ${name}`);
      }
    } catch (e) { throw asStoreError(e); }
    this.#saveTypes();
    return { applied: changes.length > 0, changes };
  }

  /** Every definition the store holds, as it was defined. */
  async types() { return [...this.plans.values()].map((p) => structuredClone(p.def)); }

  /** @param {string} type */
  async describe(type) {
    const p = this.plans.get(type);
    return p ? { name: type, fields: p.def.fields.map((/** @type {any} */ f) => ({ name: f.name, kind: f.kind })) } : null;
  }

  // ---- reads -----------------------------------------------------------------------------------
  /** @param {string} type @param {string} id @param {{ include_deleted?: boolean }} [opts] */
  async get(type, id, opts = {}) {
    const p = this.#plan(type);
    if (!isUuid(id)) return null;
    return this.#t(async () => {
      let row = await this.#row(p, id, opts.include_deleted ? "any" : "live");
      if (!row) return null;
      row = await this.#settle(p, row);
      return this.#snap(p, row);
    });
  }

  /** @param {string} type @param {any} spec */
  async query(type, spec) {
    const p = this.#plan(type);
    const limit = Math.min(Math.max(Number(spec.page?.limit) || 50, 1), MAX_PAGE);
    /** @type {any} */ let after;
    if (spec.page?.cursor !== undefined) {
      const m = /^t1\.(.+)$/.exec(String(spec.page.cursor));
      if (!m) throw new StoreError("invalid", "invalid cursor");
      try { after = Buffer.from(m[1], "base64url").toString(); if (!after) throw 0; } catch { throw new StoreError("invalid", "invalid cursor"); }
    }
    /** @type {any[]} */ const parts = [];
    try { const f = toFilter(p, spec.filter); if (f) parts.push(f); } catch (e) { throw asStoreError(e); }
    if (spec.include_deleted) parts.push(EITHER);
    const filter = parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { and: parts };
    const P = pascal(p.singular);
    let order; try { order = toOrderBy(p, spec.sort); } catch (e) { throw asStoreError(e); }
    return this.#t(async () => {
      const d = await this.client.gql("graphql", `query Q_${p.plural}($f: ${P}FilterInput, $o: [${P}OrderByInput!], $first: Int, $after: String) { ${p.plural}(filter: $f, orderBy: $o, first: $first, after: $after) { edges { node { ${selection(p)} } } pageInfo { hasNextPage endCursor } totalCount } }`, { f: filter, o: order, first: limit, after });
      const c = d[p.plural];
      const rows = c.edges.map((/** @type {any} */ e) => this.#snapIfNew(p, e.node));
      return { rows, ...(c.pageInfo.hasNextPage && rows.length ? { next_cursor: "t1." + Buffer.from(c.pageInfo.endCursor).toString("base64url") } : {}), total_visible: c.totalCount };
    });
  }
  /** a row read in a list: record it if we have never seen it, but leave an existing snapshot alone so an outside edit is still noticed */
  #snapIfNew(/** @type {import("./plan.js").TypePlan} */ p, /** @type {any} */ row) { const r = this.#rec(p, row); if (!this.snaps.get(p.vyre, row.id)) this.snaps.set(p.vyre, row.id, { version: r.version, updatedAt: row.updatedAt, data: r.data }); return r; }

  /** Pull rows through query() until done, up to a ceiling. @param {string} type @param {any} spec */
  async #scan(type, spec) {
    /** @type {any[]} */ const all = []; let cursor;
    do {
      const r = await this.query(type, { ...spec, page: { limit: MAX_PAGE, ...(cursor ? { cursor } : {}) } });
      all.push(...r.rows); cursor = r.next_cursor;
      if (all.length > MAX_SCAN) throw new StoreError("unsupported", `a search scans at most ${MAX_SCAN} rows; narrow the filter`);
    } while (cursor);
    return all;
  }

  /** Groups and measures over the rows that match, computed by the kernel's own aggregate. @param {string} type @param {any} spec */
  async aggregate(type, spec) {
    const p = this.#plan(type);
    for (const g of spec.group_by ?? []) { const f = p.byVyre.get(g); if (g !== "id" && !f) throw new StoreError("unknown_field", `${type} has no field ${g}`); if (f?.sealed) throw new StoreError("invalid", `${type}.${g} is sealed`); }
    for (const m of spec.measures ?? []) { const f = m.field ? p.byVyre.get(m.field) : null; if (m.field && !f) throw new StoreError("unknown_field", `${type} has no field ${m.field}`); if (f?.sealed) throw new StoreError("invalid", `${type}.${m.field} is sealed`); }
    // Folded page by page: no row cap, and the rows are never all in memory.
    const agg = createAggregator(spec);
    let cursor;
    do {
      const r = await this.query(type, { filter: spec.filter, page: { limit: MAX_PAGE, ...(cursor ? { cursor } : {}) } });
      for (const row of r.rows) agg.add(row);
      cursor = r.next_cursor;
    } while (cursor);
    return agg.result();
  }

  /** @param {{ text: string, types?: string[], page: { limit: number, cursor?: string } }} spec */
  async search(spec) {
    const words = String(spec.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { rows: [] };
    /** @type {any[]} */ const hits = [];
    for (const [type, p] of this.plans) {
      if (spec.types && !spec.types.includes(type)) continue;
      const fields = p.fields.filter((f) => f.type === "TEXT" && !f.sealed);
      if (!fields.length) continue;
      const r = await this.#scan(type, { filter: { or: words.flatMap((w) => fields.map((f) => ({ field: f.vyre, op: "contains", value: w }))) } });
      for (const rec of r) {
        let score = 0, snippet;
        for (const f of fields) { const text = rec.data[f.vyre]; if (typeof text !== "string") continue; const low = text.toLowerCase(); for (const w of words) if (low.includes(w)) { score += 1; snippet = snippet ?? text.slice(0, 80); } }
        if (score) hits.push({ type, id: rec.id, score, ...(snippet ? { snippet } : {}) });
      }
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    let start = 0;
    if (spec.page.cursor) { const i = hits.findIndex((h) => h.id === spec.page.cursor); start = i === -1 ? hits.length : i + 1; }
    const slice = hits.slice(start, start + spec.page.limit);
    return { rows: slice, ...(start + spec.page.limit < hits.length && slice.length ? { next_cursor: slice[slice.length - 1].id } : {}) };
  }

  // ---- writes ----------------------------------------------------------------------------------
  /** @param {string} type @param {string} id @param {Record<string, any>} data */
  async create(type, id, data) {
    const p = this.#plan(type);
    if (!isUuid(id)) throw new StoreError("invalid", "id must be a time-prefixed uuid");
    const bad = checkData(p, data); if (bad) throw new StoreError(bad.code, bad.message);
    const P = pascal(p.singular);
    return this.#t(async () => {
      if (await this.#row(p, id, "any")) throw new StoreError("invalid", `${type} ${id} already exists`);
      const d = await this.client.gql("graphql", `mutation Create_${p.singular}($d: ${P}CreateInput!) { create${P}(data: $d) { ${selection(p)} } }`, { d: { id, ...toInput(p, data), [VERSION_FIELD]: 1 } });
      const row = d[`create${P}`];
      if (row.id !== id) throw new StoreError("invalid", `Twenty replaced our id: sent ${id}, got ${row.id}`);
      this.#mine(id, row.updatedAt);
      const rec = this.#snap(p, row);
      this.#note({ type, id, kind: "created", version: 1, at: rec.updated_at, after: rec.data, source: "gateway" });
      return rec;
    });
  }

  /** @param {string} type @param {string} id @param {Record<string, any>} patch @param {number} base */
  async update(type, id, patch, base) {
    const p = this.#plan(type);
    if (!isUuid(id)) throw new StoreError("not_found", `no ${type} ${id}`);
    return this.#t(async () => {
      let row = await this.#row(p, id, "live");
      if (!row) throw new StoreError("not_found", `no ${type} ${id}`);
      row = await this.#settle(p, row);
      const cur = this.#rec(p, row);
      if (cur.version !== base) throw new StoreError("version_conflict", `${type} ${id} is at version ${cur.version}, not ${base}`);
      const merged = { ...cur.data };
      for (const [k, v] of Object.entries(patch)) { if (!p.byVyre.has(k)) throw new StoreError("unknown_field", `${type} has no field ${k}`); if (v === null) delete merged[k]; else merged[k] = v; }
      const bad = checkData(p, merged); if (bad) throw new StoreError(bad.code, bad.message);
      const next = await this.#cas(p, id, [{ updatedAt: { eq: row.updatedAt } }, { [VERSION_FIELD]: { eq: base } }], { ...toInput(p, patch), [VERSION_FIELD]: base + 1 });
      if (!next) { const now = await this.#row(p, id, "live"); throw now ? new StoreError("version_conflict", `${type} ${id} changed while it was being updated`) : new StoreError("not_found", `no ${type} ${id}`); }
      const rec = this.#snap(p, next);
      this.#note({ type, id, kind: "updated", version: rec.version, at: rec.updated_at, before: cur.data, after: rec.data, source: "gateway" });
      return rec;
    });
  }

  /** Soft delete. @param {string} type @param {string} id @param {number} base */
  async remove(type, id, base) {
    const p = this.#plan(type);
    if (!isUuid(id)) throw new StoreError("not_found", `no ${type} ${id}`);
    const P = pascal(p.singular);
    return this.#t(async () => {
      let row = await this.#row(p, id, "live");
      if (!row) throw new StoreError("not_found", `no ${type} ${id}`);
      row = await this.#settle(p, row);
      const cur = this.#rec(p, row);
      if (cur.version !== base) throw new StoreError("version_conflict", `${type} ${id} is at version ${cur.version}, not ${base}`);
      const bumped = await this.#cas(p, id, [{ updatedAt: { eq: row.updatedAt } }, { [VERSION_FIELD]: { eq: base } }], { [VERSION_FIELD]: base + 1 });
      if (!bumped) throw new StoreError("version_conflict", `${type} ${id} changed while it was being removed`);
      const d = await this.client.gql("graphql", `mutation Delete_${p.singular}($id: UUID!) { delete${P}(id: $id) { ${selection(p)} } }`, { id });
      const gone = d[`delete${P}`]; this.#mine(id, gone.updatedAt);
      const rec = this.#snap(p, gone);
      this.#note({ type, id, kind: "removed", version: rec.version, at: rec.deleted_at ?? rec.updated_at, before: cur.data, source: "gateway" });
      return rec;
    });
  }

  /** @param {string} type @param {string} id */
  async restore(type, id) {
    const p = this.#plan(type);
    if (!isUuid(id)) throw new StoreError("not_found", `no deleted ${type} ${id}`);
    const P = pascal(p.singular);
    return this.#t(async () => {
      const row = await this.#row(p, id, "deleted");
      if (!row) throw new StoreError("not_found", `no deleted ${type} ${id}`);
      const v = row[VERSION_FIELD] == null ? 1 : Number(row[VERSION_FIELD]);
      const d = await this.client.gql("graphql", `mutation Restore_${p.singular}($id: UUID!) { restore${P}(id: $id) { ${selection(p)} } }`, { id });
      const back = d[`restore${P}`]; this.#mine(id, back.updatedAt);
      const next = await this.#cas(p, id, [{ updatedAt: { eq: back.updatedAt } }], { [VERSION_FIELD]: v + 1 });
      const rec = this.#snap(p, next ?? back);
      this.#note({ type, id, kind: "restored", version: rec.version, at: rec.updated_at, after: rec.data, source: "gateway" });
      return rec;
    });
  }

  // ---- what happened, and trust ----------------------------------------------------------------
  /** @param {string | null} since @param {number} limit */
  async changes(since, limit) {
    if (since !== null && !/^c\d+$/.test(since)) throw new StoreError("invalid", "bad changes cursor");
    const from = since ? Number(since.slice(1)) : 0;
    const entries = this.log.slice(from, from + Math.max(1, limit));
    return { entries: structuredClone(entries), cursor: `c${from + entries.length}` };
  }

  /** The hash of what the language declares for a record: type, id and data. Twenty's own columns and the version are not in it. @param {{ type: string, id: string, data: any }} rec */
  recordHash(rec) { return "sha256:" + sha256(canonical({ type: rec.type, id: rec.id, data: rec.data })); }

  /**
   * Has this record been edited behind the gateway? Compares the hash the gateway wrote into its event with
   * the hash of what Twenty holds now. @param {string} type @param {string} id @param {string} expectedHash
   */
  async verify(type, id, expectedHash) {
    const p = this.#plan(type);
    const row = await this.#t(() => this.#row(p, id, "any"));
    if (!row) return { ok: false, reason: "missing", actual: null };
    const actual = this.recordHash(this.#rec(p, row));
    return actual === expectedHash ? { ok: true, actual } : { ok: false, reason: "modified_outside", actual };
  }

  /** A signed webhook from Twenty. Anything not signed by this Space's secret is refused and counted. @param {Record<string, string | string[] | undefined>} headers @param {string} raw */
  async handleWebhook(headers, raw) {
    const h = (/** @type {string} */ k) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
    /** @type {any} */ let body; try { body = JSON.parse(raw); } catch { return { status: 400, recorded: 0 }; }
    const ts = h("x-twenty-webhook-timestamp"), sig = h("x-twenty-webhook-signature"), nonce = h("x-twenty-webhook-nonce");
    const { secret: _s, ...rest } = body;
    const want = crypto.createHmac("sha256", this.secret).update(`${ts}:${JSON.stringify(rest)}`).digest("hex");
    const a = Buffer.from(String(sig ?? "")), b = Buffer.from(want);
    const tsMs = Number(ts) || Date.parse(String(ts));
    if (!(a.length === b.length && crypto.timingSafeEqual(a, b)) || !Number.isFinite(tsMs) || Math.abs(this.now() - tsMs) > 300_000) { this.rejected++; return { status: 401, recorded: 0 }; }
    if (nonce) { if (this.nonces.has(nonce)) return { status: 200, recorded: 0 }; this.nonces.set(nonce, this.now()); for (const [n, t] of this.nonces) if (this.now() - t > 300_000) this.nonces.delete(n); }
    const objectName = body.objectMetadata?.nameSingular ?? String(body.eventName ?? "").split(".")[0];
    const kind = String(body.eventName ?? "").split(".").pop();
    const p = this.planBySingular(objectName);
    const rec = body.record;
    if (!p || !rec?.id) return { status: 200, recorded: 0 };
    const key = `${rec.id}@${rec.updatedAt}`;
    if (this.self.has(key) || this.seen.has(key)) return { status: 200, recorded: 0 };
    if (this.graceMs > 0) { await new Promise((r) => setTimeout(r, this.graceMs)); if (this.self.has(key) || this.seen.has(key)) return { status: 200, recorded: 0 }; }
    if (kind === "destroyed") { this.snaps.set(p.vyre, rec.id, null); return { status: 200, recorded: 0 }; }
    const before = this.log.length;
    try {
      const row = await this.#row(p, rec.id, "any");
      if (row) await this.#settle(p, row, { kind: kind === "deleted" ? "removed" : kind === "restored" ? "restored" : kind === "created" ? "created" : undefined });
    } catch { return { status: 500, recorded: 0 }; }
    return { status: 200, recorded: this.log.length - before };
  }

  /** Register the signed webhook Twenty calls. Idempotent: the description carries a short hash of the secret, so a webhook made with another secret is replaced. @param {string} targetUrl */
  async registerWebhook(targetUrl) {
    const tag = `vyre:${this.space}:${crypto.createHash("sha256").update(this.secret).digest("hex").slice(0, 12)}`;
    const cur = await this.#t(() => this.client.gql("metadata", "query Hooks { webhooks { id targetUrl description } }"));
    const mine = cur.webhooks.filter((/** @type {any} */ w) => String(w.description ?? "") === `vyre:${this.space}` || String(w.description ?? "").startsWith(`vyre:${this.space}:`));
    const same = mine.find((/** @type {any} */ w) => w.description === tag && w.targetUrl === targetUrl);
    for (const w of mine) if (w !== same) await this.client.gql("metadata", "mutation DelHook($id: UUID!) { deleteWebhook(id: $id) { id } }", { id: w.id });
    if (same) return { id: same.id, created: false };
    const r = await this.#t(() => this.client.gql("metadata", "mutation NewHook($i: CreateWebhookInput!) { createWebhook(input: $i) { id } }", { i: { targetUrl, operations: ["*.*"], description: tag, secret: this.secret } }));
    return { id: r.createWebhook.id, created: true };
  }

  // ---- leaving ---------------------------------------------------------------------------------
  /** Every record of every type, soft-deleted included, in chunks whose checksum covers them. @param {string} [since] */
  async *export(since) {
    let seq = 0;
    /** @type {any[]} */ let pending = [];
    /** @param {boolean} done */
    const chunk = (done) => { const records = pending; pending = []; return { seq: seq++, records, done, checksum: sha256(canonical(records)) }; };
    for (const type of this.plans.keys()) {
      let cursor;
      do {
        const r = await this.query(type, { filter: since ? { field: "updated_at", op: "gte", value: Number(since) } : undefined, sort: [{ field: "id", dir: "asc" }], page: { limit: 100, ...(cursor ? { cursor } : {}) }, include_deleted: true });
        for (const rec of r.rows) { pending.push(rec); if (pending.length >= 100) yield chunk(false); }
        cursor = r.next_cursor;
      } while (cursor);
    }
    yield chunk(true);
  }
}

/** @param {StoreOptions} o */
export function createTwentyStore(o) { return new TwentyStore(o); }
