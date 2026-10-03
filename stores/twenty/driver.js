// @ts-check
// The Twenty store: the business-records store behind the gateway (spec 3.2 to 3.7). It runs one
// Twenty per Space, unmodified, reached only on the Space's internal network, as one service user.
// It implements the store interface, keeps our ids, version-checks updates, never holds a sealed
// value, keeps a snapshot of what it has seen so a change made inside Twenty has a "before",
// and reports what Twenty changes on its own through a signed webhook feed.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { StoreError, SEALED_PLACEHOLDER } from "../contract.js";
import { mintId, isRecordId } from "../../records/ids.js";
import { TwentyClient, twentyGet } from "./client.js";
import { recordHash } from "../hash.js";
import { SnapshotStore } from "./snapshots.js";
import { ChangeFeed } from "./feed.js";
import { planType, pascal, selection, fromRow, toInput, toFilter, toOrderBy, fromTwentyValue, choiceValue } from "./translate.js";

const MAX_PAGE = 200;
const MAX_SCAN = 50_000;

/**
 * @typedef {import("./translate.js").TypePlan} TypePlan
 * @typedef {import("../contract.js").StoredRecord} StoredRecord
 */
export class TwentyStore {
  /**
   * @param {{ client: TwentyClient, space: string, dir: string | null, webhookSecret: string, graceMs?: number, now?: () => number,
   *   mint?: () => string }} o dir: where plans, snapshots and the change log live (null keeps them in memory)
   */
  constructor(o) {
    this.client = o.client;
    this.space = o.space;
    this.dir = o.dir;
    this.mint = o.mint ?? (() => mintId());
    /** @type {Map<string, TypePlan>} */ this.plans = new Map();
    this.snapshots = new SnapshotStore(o.dir ? path.join(o.dir, "snapshots.jsonl") : null);
    this.feed = new ChangeFeed({
      secret: o.webhookSecret, file: o.dir ? path.join(o.dir, "changes.jsonl") : null, graceMs: o.graceMs, now: o.now, snapshots: this.snapshots,
      resolve: (name) => { const p = this.planBySingular(name); return p ? { type: p.vyre, convert: (row) => fromRow(p, row), hashOf: (row) => recordHash(p.vyre, row.id, fromRow(p, row)) } : null; },
    });
    if (o.dir) this.#loadPlans();
  }

  #loadPlans() {
    const f = path.join(/** @type {string} */ (this.dir), "types.json");
    if (!fs.existsSync(f)) return;
    for (const t of JSON.parse(fs.readFileSync(f, "utf8"))) { const p = planType(t); this.plans.set(p.vyre, p); }
  }
  #savePlans() {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, "types.json"), JSON.stringify([...this.plans.values()].map((p) => p.def)), { mode: 0o600 });
  }
  /** @param {string} singular */ planBySingular(singular) { for (const p of this.plans.values()) if (p.singular === singular) return p; return null; }
  /** @param {string} type @returns {TypePlan} */
  plan(type) { const p = this.plans.get(type); if (!p) throw new StoreError("unknown_type", `The store has no type "${type}"; define it first`, { type }); return p; }

  features() { return { aggregate: "native-groupby-count-else-scan", search: "ilike", changes: true, import: true, cursorPaging: true, softDelete: true, versionCheck: "updatedAt" }; }

  async health() {
    const h = await twentyGet(this.client, "/healthz");
    if (h.status !== 200) return { ok: false, reason: `Twenty is not answering (${h.status || "no reply"})` };
    try { await this.client.gql("metadata", "query Health { objects(paging: { first: 1 }) { edges { node { id } } } }"); } catch (e) { return { ok: false, reason: /** @type {Error} */ (e).message }; }
    return { ok: true };
  }
  async version() {
    const r = await twentyGet(this.client, "/client-config");
    let appVersion = null; try { appVersion = JSON.parse(r.body).appVersion ?? null; } catch { /* leave null */ }
    return { engine: "twenty", version: appVersion };
  }

  // ---- definitions ---------------------------------------------------------------------------

  /**
   * Make Twenty match the given types. Idempotent. Adds types, fields and choices; refuses a change
   * of kind and any removal (that is a migration, not a define).
   * @param {{ types: any[] }} def stored types from a kit
   * @returns {Promise<{ applied: string[], unchanged: number }>}
   */
  async define(def) {
    const applied = []; let unchanged = 0;
    const plans = def.types.map((t) => planType(t));
    const cur = await this.client.gql("metadata", "query Objs { objects(paging: { first: 200 }) { edges { node { id nameSingular namePlural fields(paging: { first: 200 }) { edges { node { id name type options isActive } } } } } } }");
    /** @type {Map<string, any>} */ const objs = new Map(cur.objects.edges.map((/** @type {any} */ e) => [e.node.nameSingular, e.node]));
    for (const p of plans) {
      let obj = objs.get(p.singular);
      const prev = this.plans.get(p.vyre);
      if (prev) for (const old of prev.fields) if (!p.byVyre.has(old.vyre)) throw new StoreError("unsupported", `Field "${old.vyre}" of ${p.vyre} was removed: removing a field is a migration, not a define`, { type: p.vyre, field: old.vyre });
      if (!obj) {
        const r = await this.client.gql("metadata", "mutation CreateObj($i: CreateOneObjectInput!) { createOneObject(input: $i) { id nameSingular } }", { i: { object: { nameSingular: p.singular, namePlural: p.plural, labelSingular: p.label, labelPlural: p.plural_label, icon: p.icon } } });
        obj = { id: r.createOneObject.id, nameSingular: p.singular, fields: { edges: [] } }; applied.push(`type ${p.vyre}`);
      } else unchanged++;
      /** @type {Map<string, any>} */ const have = new Map(obj.fields.edges.map((/** @type {any} */ e) => [e.node.name, e.node]));
      for (const f of p.fields) {
        if (f.isTitle) continue;
        const ex = have.get(f.twenty);
        if (!ex) {
          const field = { objectMetadataId: obj.id, type: f.type, name: f.twenty, label: f.def.label ?? f.vyre, isNullable: true, ...(f.options ? { options: f.options } : {}), ...(f.settings ? { settings: f.settings } : {}), ...(f.def.unique ? { isUnique: true } : {}), ...(f.kind === "stage" ? { defaultValue: `'${f.options?.[0].value}'` } : {}) };
          await this.client.gql("metadata", "mutation CreateField($i: CreateOneFieldMetadataInput!) { createOneField(input: $i) { id name } }", { i: { field } });
          applied.push(`field ${p.vyre}.${f.vyre}`);
          continue;
        }
        if (ex.type !== f.type) throw new StoreError("unsupported", `Field "${f.vyre}" of ${p.vyre} changed kind: that is a migration, not a define`, { type: p.vyre, field: f.vyre });
        if (f.options) {
          const exVals = new Set((ex.options ?? []).map((/** @type {any} */ o) => o.value));
          const want = new Set(f.options.map((o) => o.value));
          for (const v of exVals) if (!want.has(v)) throw new StoreError("unsupported", `A choice of ${p.vyre}.${f.vyre} was removed: that is a migration, not a define`, { type: p.vyre, field: f.vyre });
          const added = f.options.filter((o) => !exVals.has(o.value));
          if (added.length) {
            await this.client.gql("metadata", "mutation UpdField($i: UpdateOneFieldMetadataInput!) { updateOneField(input: $i) { id } }", { i: { id: ex.id, update: { options: f.options } } });
            applied.push(`choices ${p.vyre}.${f.vyre} +${added.map((o) => o.label).join(",")}`);
          } else unchanged++;
        } else unchanged++;
      }
    }
    for (const p of plans) this.plans.set(p.vyre, p);
    this.#savePlans();
    return { applied, unchanged };
  }

  // ---- reads ---------------------------------------------------------------------------------

  /** @param {TypePlan} p @param {any} row @param {boolean} [snapshotIfNew] @returns {StoredRecord} */
  #record(p, row, snapshotIfNew = false) {
    const fields = fromRow(p, row);
    const rec = { id: row.id, type: p.vyre, fields, version: row.updatedAt, hash: recordHash(p.vyre, row.id, fields), createdAt: row.createdAt, updatedAt: row.updatedAt, deletedAt: row.deletedAt ?? null };
    if (snapshotIfNew && !this.snapshots.get(p.vyre, row.id)) this.snapshots.set(p.vyre, row.id, { version: rec.version, hash: rec.hash, fields });
    return rec;
  }

  /**
   * @param {string} type @param {string} id @param {{ includeDeleted?: boolean }} [opts]
   * @returns {Promise<StoredRecord | null>}
   */
  async get(type, id, opts = {}) {
    const p = this.plan(type);
    if (!isIdShape(id)) throw new StoreError("invalid", "The id is not a valid id");
    const filter = opts.includeDeleted ? { and: [{ id: { eq: id } }, { or: [{ deletedAt: { is: "NULL" } }, { deletedAt: { is: "NOT_NULL" } }] }] } : { id: { eq: id } };
    let d;
    try { d = await this.client.gql("graphql", `query Get_${p.singular}($f: ${pascal(p.singular)}FilterInput) { ${p.singular}(filter: $f) { ${selection(p)} } }`, { f: filter }); }
    catch (e) { if (e instanceof StoreError && e.code === "not_found") return null; throw e; }
    const row = d[p.singular];
    return row ? this.#record(p, row, true) : null;
  }

  /**
   * @param {string} type
   * @param {{ filter?: import("../contract.js").Filter, sort?: import("../contract.js").Sort[], page?: import("../contract.js").Page, includeDeleted?: boolean, onlyDeleted?: boolean }} [q]
   * @returns {Promise<import("../contract.js").QueryResult>}
   */
  async query(type, q = {}) {
    const p = this.plan(type);
    const limit = Math.min(Math.max(q.page?.limit ?? 50, 1), MAX_PAGE);
    /** @type {any[]} */ const parts = [];
    const f = toFilter(p, q.filter); if (f) parts.push(f);
    if (q.onlyDeleted) parts.push({ deletedAt: { is: "NOT_NULL" } });
    else if (q.includeDeleted) parts.push({ or: [{ deletedAt: { is: "NULL" } }, { deletedAt: { is: "NOT_NULL" } }] });
    const filter = parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { and: parts };
    const P = pascal(p.singular);
    const d = await this.client.gql("graphql", `query Q_${p.plural}($f: ${P}FilterInput, $o: [${P}OrderByInput!], $first: Int, $after: String) { ${p.plural}(filter: $f, orderBy: $o, first: $first, after: $after) { edges { node { ${selection(p)} } } pageInfo { hasNextPage endCursor } totalCount } }`, { f: filter, o: toOrderBy(p, q.sort), first: limit, after: q.page?.after ?? undefined });
    const c = d[p.plural];
    return { rows: c.edges.map((/** @type {any} */ e) => this.#record(p, e.node, true)), next: c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null, total: c.totalCount };
  }

  /**
   * Counts and measures. Count by select, text or boolean fields uses Twenty's own group-by; every
   * other shape scans up to 50,000 rows here. Sealed fields are refused. Hidden-row filtering is the
   * gateway's job: it passes a filter that already selects only visible rows.
   * @param {string} type
   * @param {{ filter?: import("../contract.js").Filter, groupBy?: string[], measures?: { op: "count" | "sum" | "avg" | "min" | "max", field?: string }[] }} [a]
   */
  async aggregate(type, a = {}) {
    const p = this.plan(type);
    const groupBy = a.groupBy ?? [];
    const measures = a.measures?.length ? a.measures : [{ op: "count" }];
    for (const g of groupBy) { const f = p.byVyre.get(g); if (!f) throw new StoreError("unknown_field", `${type} has no field "${g}"`); if (f.sealed) throw new StoreError("invalid", `${type}.${g} is sealed and cannot be grouped`); }
    for (const m of measures) { if (m.op !== "count") { const f = m.field ? p.byVyre.get(m.field) : null; if (!f) throw new StoreError("unknown_field", `${type} has no field "${m.field}"`); if (f.sealed) throw new StoreError("invalid", `${type}.${m.field} is sealed`); if (!["number", "money", "date", "datetime"].includes(f.kind)) throw new StoreError("invalid", `${m.op} needs a number, money or date field`); } }
    const simple = groupBy.length > 0 && groupBy.every((g) => ["SELECT", "TEXT", "BOOLEAN"].includes(/** @type {any} */ (p.byVyre.get(g)).type)) && measures.every((m) => m.op === "count");
    if (simple) {
      const P = pascal(p.singular);
      const dims = groupBy.map((g) => ({ [/** @type {any} */ (p.byVyre.get(g)).twenty]: true }));
      const d = await this.client.gql("graphql", `query Agg_${p.plural}($g: [${P}GroupByInput!]!, $f: ${P}FilterInput) { ${p.plural}GroupBy(groupBy: $g, filter: $f) { groupByDimensionValues totalCount } }`, { g: dims, f: toFilter(p, a.filter) });
      return d[`${p.plural}GroupBy`].map((/** @type {any} */ r) => ({ group: Object.fromEntries(groupBy.map((g, i) => [g, fromTwentyValue(/** @type {any} */ (p.byVyre.get(g)), r.groupByDimensionValues[i])])), count: r.totalCount }));
    }
    /** @type {Map<string, any>} */ const buckets = new Map();
    let scanned = 0, after = null;
    do {
      const r = await this.query(type, { filter: a.filter, page: { limit: MAX_PAGE, after }, sort: [{ field: "id" }] });
      for (const rec of r.rows) {
        scanned++;
        const gv = groupBy.map((g) => rec.fields[g]);
        const k = JSON.stringify(gv);
        let b = buckets.get(k); if (!b) { b = { group: Object.fromEntries(groupBy.map((g, i) => [g, gv[i]])), count: 0, acc: measures.map(() => []) }; buckets.set(k, b); }
        b.count++;
        measures.forEach((m, i) => { if (m.op === "count") return; const v = rec.fields[/** @type {string} */ (m.field)]; const n = v && typeof v === "object" ? v.amount : v; if (n != null) b.acc[i].push(typeof n === "string" ? n : Number(n)); });
      }
      after = r.next;
      if (scanned > MAX_SCAN) throw new StoreError("unsupported", `Aggregate scans at most ${MAX_SCAN} rows; narrow the filter`);
    } while (after);
    return [...buckets.values()].map((b) => { const out = { group: b.group, count: b.count }; measures.forEach((m, i) => { if (m.op === "count") return; const a2 = b.acc[i]; const key = `${m.op}_${m.field}`; if (!a2.length) out[key] = null; else if (typeof a2[0] === "string") out[key] = m.op === "min" ? [...a2].sort()[0] : m.op === "max" ? [...a2].sort().at(-1) : null; else out[key] = m.op === "sum" ? a2.reduce((x, y) => x + y, 0) : m.op === "avg" ? a2.reduce((x, y) => x + y, 0) / a2.length : m.op === "min" ? Math.min(...a2) : Math.max(...a2); }); return out; });
  }

  /**
   * Text search over the non-sealed text fields, ranked: exact title, then prefix, then contains.
   * @param {string} text @param {{ types?: string[], limit?: number }} [o]
   */
  async search(text, o = {}) {
    const needle = String(text ?? "").trim();
    if (!needle) return [];
    const types = o.types?.length ? o.types : [...this.plans.keys()];
    const limit = Math.min(o.limit ?? 20, 100);
    const lower = needle.toLowerCase();
    /** @type {{ type: string, record: StoredRecord, score: number }[]} */ const hits = [];
    for (const t of types) {
      const p = this.plan(t);
      const textFields = p.fields.filter((f) => (f.type === "TEXT") && !f.sealed && f.kind !== "actor");
      if (!textFields.length) continue;
      const r = await this.query(t, { filter: { or: textFields.map((f) => ({ [f.vyre]: { contains: needle } })) }, page: { limit: Math.min(limit * 3, MAX_PAGE) } });
      for (const rec of r.rows) {
        let score = 0;
        for (const f of textFields) { const v = String(rec.fields[f.vyre] ?? "").toLowerCase(); if (!v.includes(lower)) continue; const w = f.isTitle ? 3 : 1; score = Math.max(score, v === lower ? 4 * w : v.startsWith(lower) ? 2 * w : w); }
        hits.push({ type: t, record: rec, score });
      }
    }
    return hits.sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : 1)).slice(0, limit);
  }

  // ---- writes --------------------------------------------------------------------------------

  /**
   * Create a record. The id is ours: pass one, or the store mints one. Twenty keeps it.
   * @param {string} type @param {{ id?: string, fields: Record<string, any> }} record
   * @returns {Promise<StoredRecord>}
   */
  async create(type, record) {
    const p = this.plan(type);
    const id = record.id ?? this.mint();
    if (!isRecordId(id)) throw new StoreError("invalid", "A record id is a time-prefixed id minted by Vyre", { id });
    const input = toInput(p, record.fields ?? {}, true);
    for (const f of p.fields) if (f.required && (input[f.twenty] === null || input[f.twenty] === undefined)) throw new StoreError("invalid", `${type}.${f.vyre} is required`, { field: f.vyre });
    const P = pascal(p.singular);
    const d = await this.client.gql("graphql", `mutation Create_${p.singular}($d: ${P}CreateInput!) { create${P}(data: $d) { ${selection(p)} } }`, { d: { id, ...input } });
    const row = d[`create${P}`];
    if (row.id !== id) throw new StoreError("tampered", `Twenty replaced our id: sent ${id}, got ${row.id}`);
    this.feed.noteSelfWrite(id, row.updatedAt);
    const rec = this.#record(p, row);
    this.snapshots.set(type, id, { version: rec.version, hash: rec.hash, fields: rec.fields });
    return rec;
  }

  /**
   * Change fields of a record the caller has read. baseVersion is the version it read: if the record
   * has moved on, nothing is written and the error is "conflict".
   * @param {string} type @param {string} id @param {Record<string, any>} patch @param {string} baseVersion
   * @returns {Promise<StoredRecord>}
   */
  async update(type, id, patch, baseVersion) {
    const p = this.plan(type);
    if (typeof baseVersion !== "string" || !baseVersion) throw new StoreError("invalid", "update needs the version the caller read");
    if (!patch || !Object.keys(patch).length) throw new StoreError("invalid", "update needs at least one field");
    const data = toInput(p, patch);
    for (const f of p.fields) if (f.required && f.twenty in data && data[f.twenty] === null) throw new StoreError("invalid", `${type}.${f.vyre} is required`, { field: f.vyre });
    const P = pascal(p.singular);
    const d = await this.client.gql("graphql", `mutation Update_${p.plural}($f: ${P}FilterInput, $d: ${P}UpdateInput!) { update${pascal(p.plural)}(filter: $f, data: $d) { ${selection(p)} } }`, { f: { and: [{ id: { eq: id } }, { updatedAt: { eq: baseVersion } }] }, d: data });
    const rows = d[`update${pascal(p.plural)}`];
    if (!rows.length) {
      const now = await this.get(type, id, { includeDeleted: true });
      if (!now) throw new StoreError("not_found", `No ${type} with that id`, { id });
      throw new StoreError("conflict", `The ${type} changed since it was read`, { id, current: now.version, base: baseVersion });
    }
    const rec = this.#record(p, rows[0]);
    this.feed.noteSelfWrite(id, rec.version);
    this.snapshots.set(type, id, { version: rec.version, hash: rec.hash, fields: rec.fields });
    return rec;
  }

  /** Soft delete. @param {string} type @param {string} id */
  async remove(type, id) {
    const p = this.plan(type); const P = pascal(p.singular);
    const d = await this.client.gql("graphql", `mutation Delete_${p.singular}($id: UUID!) { delete${P}(id: $id) { ${selection(p)} } }`, { id });
    const rec = this.#record(p, d[`delete${P}`]); this.feed.noteSelfWrite(id, rec.version); return rec;
  }
  /** Undo a soft delete. @param {string} type @param {string} id */
  async restore(type, id) {
    const p = this.plan(type); const P = pascal(p.singular);
    const d = await this.client.gql("graphql", `mutation Restore_${p.singular}($id: UUID!) { restore${P}(id: $id) { ${selection(p)} } }`, { id });
    const rec = this.#record(p, d[`restore${P}`]); this.feed.noteSelfWrite(id, rec.version);
    this.snapshots.set(type, id, { version: rec.version, hash: rec.hash, fields: rec.fields });
    return rec;
  }

  // ---- what happened inside Twenty, and trust ---------------------------------------------------

  /** @param {number} [since] */ changes(since = 0) { return this.feed.changes(since); }
  /** @param {Record<string, string | string[] | undefined>} headers @param {string} raw */ handleWebhook(headers, raw) { return this.feed.handle(headers, raw); }

  /**
   * Has the record been edited behind the gateway? Compare the hash the gateway wrote into its event
   * with the hash of what the store holds now (declared fields only).
   * @param {string} type @param {string} id @param {string} expectedHash
   */
  async verify(type, id, expectedHash) {
    const rec = await this.get(type, id, { includeDeleted: true });
    if (!rec) return { ok: false, reason: "missing", actual: null };
    return rec.hash === expectedHash ? { ok: true, actual: rec.hash } : { ok: false, reason: "modified_outside", actual: rec.hash, version: rec.version };
  }

  /**
   * Register the signed webhook Twenty calls. Idempotent: the description carries a short hash of the
   * secret, so a webhook made with another secret is replaced, never reused (it would fail every signature).
   * @param {string} targetUrl
   */
  async registerWebhook(targetUrl) {
    const tag = `vyre:${this.space}:${crypto.createHash("sha256").update(this.feed.secret).digest("hex").slice(0, 12)}`;
    const cur = await this.client.gql("metadata", "query Hooks { webhooks { id targetUrl description } }");
    const mine = cur.webhooks.filter((/** @type {any} */ w) => String(w.description ?? "").startsWith(`vyre:${this.space}:`));
    const same = mine.find((/** @type {any} */ w) => w.description === tag && w.targetUrl === targetUrl);
    for (const w of mine) if (w !== same) await this.client.gql("metadata", "mutation DelHook($id: UUID!) { deleteWebhook(id: $id) { id } }", { id: w.id });
    if (same) return { id: same.id, created: false };
    const r = await this.client.gql("metadata", "mutation NewHook($i: CreateWebhookInput!) { createWebhook(input: $i) { id } }", { i: { targetUrl, operations: ["*.*"], description: tag, secret: this.feed.secret } });
    return { id: r.createWebhook.id, created: true };
  }

  // ---- leaving and conformance -------------------------------------------------------------

  /**
   * Every record of every type, including soft-deleted ones, oldest first.
   * @param {{ since?: string }} [o] only records updated after this version
   * @returns {AsyncGenerator<{ type: string, record: StoredRecord }>}
   */
  async *export(o = {}) {
    for (const type of this.plans.keys()) {
      let after = null;
      do {
        const r = await this.query(type, { filter: o.since ? { updatedAt: { gt: o.since } } : undefined, page: { limit: MAX_PAGE, after }, includeDeleted: true, sort: [{ field: "id" }] });
        for (const record of r.rows) yield { type, record };
        after = r.next;
      } while (after);
    }
  }
  /** Load an export into an empty store, keeping ids. @param {AsyncIterable<{ type: string, record: StoredRecord }> | Iterable<{ type: string, record: StoredRecord }>} rows */
  async import(rows) {
    let n = 0;
    for await (const { type, record } of /** @type {any} */ (rows)) {
      const fields = { ...record.fields };
      for (const [k, v] of Object.entries(fields)) if (v === null) delete fields[k];
      await this.create(type, { id: record.id, fields });
      if (record.deletedAt) await this.remove(type, record.id);
      n++;
    }
    return { imported: n };
  }
}

const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** @param {unknown} s */ const isIdShape = (s) => typeof s === "string" && UUID_ANY.test(s);
export { SEALED_PLACEHOLDER, choiceValue };
