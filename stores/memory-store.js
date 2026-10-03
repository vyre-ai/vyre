// @ts-check
// The reference store: the whole interface in memory, no network. It is the second implementation
// the conformance suite runs against (so the suite is known not to be Twenty-shaped) and the
// starting point for "Vyre's own store, later, maybe".

import { StoreError, SEALED_PLACEHOLDER } from "./contract.js";
import { mintId, isRecordId } from "../records/ids.js";
import { recordHash } from "./hash.js";

/** @param {any} f @param {any} v */
function norm(f, v, typeName) {
  const bad = (m) => { throw new StoreError("invalid", `${typeName}.${f.name}: ${m}`, { field: f.name }); };
  if (v === undefined || v === null) return null;
  switch (f.kind) {
    case "sealed": if (v !== SEALED_PLACEHOLDER) throw new StoreError("sealed_value", `${typeName}.${f.name} is sealed`, { field: f.name }); return v;
    case "text": case "richtext": if (typeof v !== "string") bad("expected text"); return v;
    case "number": if (typeof v !== "number" || !Number.isFinite(v)) bad("expected a number"); if (f.integer && !Number.isInteger(v)) bad("expected a whole number"); if (f.min !== undefined && v < f.min) bad("below the minimum"); if (f.max !== undefined && v > f.max) bad("above the maximum"); return v;
    case "money": if (typeof v !== "object" || typeof v.amount !== "number") bad("expected { amount, currency }"); return { amount: Math.round(v.amount * 1e6) / 1e6, currency: v.currency ?? f.currency ?? "USD" };
    case "boolean": if (typeof v !== "boolean") bad("expected true or false"); return v;
    case "date": if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad("expected YYYY-MM-DD"); return v;
    case "datetime": { const d = new Date(v); if (Number.isNaN(d.getTime())) bad("expected a date and time"); return d.toISOString(); }
    case "choice": if (!f.options.includes(v)) bad("not a choice"); return v;
    case "stage": if (!f.stages.some((/** @type {any} */ s) => s.name === v)) bad("not a stage"); return v;
    default: return v;
  }
}

export class MemoryStore {
  /** @param {{ now?: () => number }} [o] */
  constructor(o = {}) {
    this.now = o.now ?? Date.now;
    /** @type {Map<string, any>} */ this.types = new Map();
    /** @type {Map<string, Map<string, any>>} */ this.rows = new Map();
    /** @type {import("./contract.js").Change[]} */ this.log = [];
    this.tick = 0;
  }
  features() { return { aggregate: "scan", search: "contains", changes: true, import: true, cursorPaging: true, softDelete: true, versionCheck: "counter" }; }
  async health() { return { ok: true }; }
  async version() { return { engine: "memory", version: "1" }; }
  #stamp() { return new Date(this.now()).toISOString().replace("Z", String(++this.tick % 1000).padStart(3, "0") + "Z"); }
  #t(type) { const t = this.types.get(type); if (!t) throw new StoreError("unknown_type", `No type ${type}`); return t; }

  async define(def) {
    const applied = []; let unchanged = 0;
    for (const t of def.types) {
      const prev = this.types.get(t.name);
      if (!prev) { this.types.set(t.name, t); this.rows.set(t.name, new Map()); applied.push(`type ${t.name}`); continue; }
      for (const f of prev.fields) if (!t.fields.some((/** @type {any} */ g) => g.name === f.name)) throw new StoreError("unsupported", `Field ${f.name} removed`);
      let changed = false;
      for (const f of t.fields) { const o = prev.fields.find((/** @type {any} */ g) => g.name === f.name); if (!o) { applied.push(`field ${t.name}.${f.name}`); changed = true; } else if (o.kind !== f.kind) throw new StoreError("unsupported", `Field ${f.name} changed kind`); }
      this.types.set(t.name, t);
      if (!changed) unchanged++;
    }
    return { applied, unchanged };
  }
  #rec(type, r) { const fields = { ...r.fields }; return { id: r.id, type, fields, version: r.version, hash: recordHash(type, r.id, fields), createdAt: r.createdAt, updatedAt: r.updatedAt, deletedAt: r.deletedAt }; }
  async get(type, id, o = {}) { this.#t(type); const r = this.rows.get(type)?.get(id); if (!r || (r.deletedAt && !o.includeDeleted)) return null; return this.#rec(type, r); }

  #match(t, rec, filter) {
    if (!filter) return true;
    for (const [k, c] of Object.entries(filter)) {
      if (k === "and") { if (!c.every((/** @type {any} */ x) => this.#match(t, rec, x))) return false; continue; }
      if (k === "or") { if (!c.some((/** @type {any} */ x) => this.#match(t, rec, x))) return false; continue; }
      if (k === "not") { if (this.#match(t, rec, c)) return false; continue; }
      const f = k === "id" || k === "createdAt" || k === "updatedAt" ? null : t.fields.find((/** @type {any} */ x) => x.name === k);
      if (!f && !(k === "id" || k === "createdAt" || k === "updatedAt")) throw new StoreError("unknown_field", `No field ${k}`);
      if (f?.kind === "sealed") throw new StoreError("invalid", "sealed fields cannot be filtered");
      const v = k === "id" ? rec.id : k === "createdAt" || k === "updatedAt" ? rec[k] : rec.fields[k];
      const cond = c !== null && typeof c === "object" && !Array.isArray(c) && !("amount" in c) ? c : { eq: c };
      const val = (x) => (x && typeof x === "object" && "amount" in x ? x.amount : x);
      for (const [op, rhs] of Object.entries(cond)) {
        const a = val(v), b = Array.isArray(rhs) ? rhs.map(val) : val(rhs);
        const ok = op === "eq" ? a === b || (f?.kind === "money" && a === b) : op === "ne" ? a !== b : op === "in" ? b.includes(a) : op === "isNull" ? (a === null || a === undefined) === !!rhs : op === "contains" ? typeof a === "string" && a.toLowerCase().includes(String(b).toLowerCase()) : a == null || b == null ? false : op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : op === "lte" ? a <= b : (() => { throw new StoreError("invalid", `operator ${op}`); })();
        if (!ok) return false;
      }
    }
    return true;
  }
  #all(type, q = {}) {
    const t = this.#t(type);
    let rows = [...(this.rows.get(type) ?? new Map()).values()].filter((r) => q.onlyDeleted ? !!r.deletedAt : q.includeDeleted ? true : !r.deletedAt).map((r) => this.#rec(type, r)).filter((r) => this.#match(t, r, q.filter));
    const sort = q.sort?.length ? q.sort : [{ field: "id" }];
    for (const s of sort) if (t.fields.find((/** @type {any} */ f) => f.name === s.field)?.kind === "sealed") throw new StoreError("invalid", "sealed fields cannot be sorted");
    const key = (r, f) => { if (f === "id" || f === "createdAt" || f === "updatedAt") return r[f]; const v = r.fields[f]; return v && typeof v === "object" ? v.amount : v; };
    rows.sort((a, b) => { for (const s of sort) { const x = key(a, s.field), y = key(b, s.field); if (x === y) continue; if (x == null) return 1; if (y == null) return -1; const c = x < y ? -1 : 1; return s.dir === "desc" ? -c : c; } return a.id < b.id ? -1 : 1; });
    return rows;
  }
  async query(type, q = {}) {
    const all = this.#all(type, q);
    const limit = Math.min(Math.max(q.page?.limit ?? 50, 1), 200);
    const start = q.page?.after ? Number(Buffer.from(q.page.after, "base64").toString()) : 0;
    const rows = all.slice(start, start + limit);
    return { rows, next: start + limit < all.length ? Buffer.from(String(start + limit)).toString("base64") : null, total: all.length };
  }
  async aggregate(type, a = {}) {
    const t = this.#t(type); const groupBy = a.groupBy ?? []; const measures = a.measures?.length ? a.measures : [{ op: "count" }];
    for (const g of groupBy) if (t.fields.find((/** @type {any} */ f) => f.name === g)?.kind === "sealed") throw new StoreError("invalid", "sealed");
    for (const m of measures) if (m.field && t.fields.find((/** @type {any} */ f) => f.name === m.field)?.kind === "sealed") throw new StoreError("invalid", "sealed");
    const buckets = new Map();
    for (const rec of this.#all(type, { filter: a.filter })) {
      const gv = groupBy.map((g) => rec.fields[g]); const k = JSON.stringify(gv);
      let b = buckets.get(k); if (!b) { b = { group: Object.fromEntries(groupBy.map((g, i) => [g, gv[i]])), count: 0, acc: measures.map(() => []) }; buckets.set(k, b); }
      b.count++; measures.forEach((m, i) => { if (m.op === "count") return; const v = rec.fields[m.field]; const n = v && typeof v === "object" ? v.amount : v; if (n != null) b.acc[i].push(n); });
    }
    return [...buckets.values()].map((b) => { const out = { group: b.group, count: b.count }; measures.forEach((m, i) => { if (m.op === "count") return; const a2 = b.acc[i]; out[`${m.op}_${m.field}`] = !a2.length ? null : typeof a2[0] === "string" ? (m.op === "min" ? [...a2].sort()[0] : m.op === "max" ? [...a2].sort().at(-1) : null) : m.op === "sum" ? a2.reduce((x, y) => x + y, 0) : m.op === "avg" ? a2.reduce((x, y) => x + y, 0) / a2.length : m.op === "min" ? Math.min(...a2) : Math.max(...a2); }); return out; });
  }
  async search(text, o = {}) {
    const needle = String(text).trim().toLowerCase(); if (!needle) return [];
    const hits = [];
    for (const [type, t] of this.types) {
      if (o.types?.length && !o.types.includes(type)) continue;
      const title = t.title ?? t.fields.find((/** @type {any} */ f) => f.kind === "text")?.name;
      for (const rec of this.#all(type)) {
        let score = 0;
        for (const f of t.fields) { if (!["text", "richtext"].includes(f.kind)) continue; const v = String(rec.fields[f.name] ?? "").toLowerCase(); if (!v.includes(needle)) continue; const w = f.name === title ? 3 : 1; score = Math.max(score, v === needle ? 4 * w : v.startsWith(needle) ? 2 * w : w); }
        if (score) hits.push({ type, record: rec, score });
      }
    }
    return hits.sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : 1)).slice(0, o.limit ?? 20);
  }
  async create(type, record) {
    const t = this.#t(type); const id = record.id ?? mintId();
    if (!isRecordId(id)) throw new StoreError("invalid", "bad id");
    const rows = /** @type {Map<string, any>} */ (this.rows.get(type));
    if (rows.has(id)) throw new StoreError("id_exists", "exists");
    const fields = {};
    for (const f of t.fields) {
      let v = record.fields?.[f.name];
      if (v === undefined && f.default !== undefined) v = f.default;
      if (v === undefined && f.kind === "stage") v = f.stages[0].name;
      fields[f.name] = norm(f, v, type);
      if (f.required && fields[f.name] === null) throw new StoreError("invalid", `${type}.${f.name} is required`);
    }
    for (const k of Object.keys(record.fields ?? {})) if (!t.fields.some((/** @type {any} */ f) => f.name === k)) throw new StoreError("unknown_field", `No field ${k}`);
    const at = this.#stamp();
    const row = { id, fields, version: at, createdAt: at, updatedAt: at, deletedAt: null };
    rows.set(id, row);
    return this.#rec(type, row);
  }
  async update(type, id, patch, baseVersion) {
    const t = this.#t(type);
    if (!baseVersion) throw new StoreError("invalid", "base version required");
    if (!patch || !Object.keys(patch).length) throw new StoreError("invalid", "empty patch");
    const row = this.rows.get(type)?.get(id);
    if (!row) throw new StoreError("not_found", "missing");
    if (row.version !== baseVersion) throw new StoreError("conflict", "changed", { current: row.version });
    const next = { ...row.fields };
    for (const [k, v] of Object.entries(patch)) { const f = t.fields.find((/** @type {any} */ x) => x.name === k); if (!f) throw new StoreError("unknown_field", `No field ${k}`); next[k] = norm(f, v, type); if (f.required && next[k] === null) throw new StoreError("invalid", "required"); }
    const at = this.#stamp(); row.fields = next; row.version = at; row.updatedAt = at;
    return this.#rec(type, row);
  }
  async remove(type, id) { const row = this.rows.get(type)?.get(id); if (!row) throw new StoreError("not_found", "missing"); const at = this.#stamp(); row.deletedAt = at; row.version = at; row.updatedAt = at; return this.#rec(type, row); }
  async restore(type, id) { const row = this.rows.get(type)?.get(id); if (!row) throw new StoreError("not_found", "missing"); const at = this.#stamp(); row.deletedAt = null; row.version = at; row.updatedAt = at; return this.#rec(type, row); }
  changes(since = 0) { const rows = this.log.filter((c) => c.seq > since); return { changes: rows, cursor: rows.length ? rows.at(-1).seq : since }; }
  async verify(type, id, expected) { const r = await this.get(type, id, { includeDeleted: true }); if (!r) return { ok: false, reason: "missing", actual: null }; return r.hash === expected ? { ok: true, actual: r.hash } : { ok: false, reason: "modified_outside", actual: r.hash }; }
  async *export(o = {}) { for (const type of this.types.keys()) for (const record of this.#all(type, { includeDeleted: true })) if (!o.since || record.updatedAt > o.since) yield { type, record }; }
  async import(rows) { let n = 0; for await (const { type, record } of /** @type {any} */ (rows)) { const fields = { ...record.fields }; for (const [k, v] of Object.entries(fields)) if (v === null) delete fields[k]; await this.create(type, { id: record.id, fields }); if (record.deletedAt) await this.remove(type, record.id); n++; } return { imported: n }; }

  /** Test hook: something changes a record inside the store, behind the gateway, like a sync or an import. */
  async _behind(type, id, patch) {
    const row = /** @type {any} */ (this.rows.get(type)?.get(id)); const before = { ...row.fields }; const at = this.#stamp();
    row.fields = { ...row.fields, ...patch }; row.version = at; row.updatedAt = at;
    this.log.push({ seq: this.log.length + 1, at: new Date().toISOString(), source: "memory", kind: "updated", type, id, before, after: { ...row.fields }, changed: Object.keys(patch), version: at, by: "sync" });
  }
  /** Test hook: change something the language does not declare (position, search vector, a sync stamp). */
  async _touch(type, id) { const row = /** @type {any} */ (this.rows.get(type)?.get(id)); row.undeclared = (row.undeclared ?? 0) + 1; }
}
