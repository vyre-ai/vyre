// kernel/store/memory.js: the in-memory reference store. It implements the whole Store interface (contracts store.d.ts)
// and passes the conformance suite (kernel/conformance). It is what the gateway tests run against and what a real
// store (Twenty, K-later) is measured by. Not durable; not trusted either: the gateway treats it like any store.
import { canonical, sha256 } from "../core/canonical.js";
import { isUuid } from "../core/ids.js";
import { checkValue } from "./values.js";
import { page, aggregate as agg, fieldOf } from "./query.js";

/** The conformance suite revision this store last passed. Bump with the suite. */
export const CONFORMANCE_REVISION = 3;

const clone = (/** @type {any} */ v) => structuredClone(v);
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ clock?: () => number, hook?: (op: string, args: any[]) => void,
 *   initial?: { types: any[], records: any[], changes: any[] },
 *   persist?: { type(name: string, def: any | null): void, record(r: any): void, change(e: any): void } }} [cfg]
 *   hook: tests throw from it to simulate a crash or an outage. initial and persist make the store durable (kernel/store/sqlite.js): the state it starts from, and a
 *   write-through for every change, called after the in-memory change is made.
 */
export function createMemoryStore(cfg = {}) {
  const clock = cfg.clock || Date.now;
  /** @type {Map<string, any>} */ const types = new Map();
  /** @type {Map<string, Map<string, any>>} */ const rows = new Map();
  /** @type {any[]} */ const changes = [];
  if (cfg.initial) {
    for (const t of cfg.initial.types) { types.set(t.name, t); rows.set(t.name, new Map()); }
    for (const r of cfg.initial.records) rows.get(r.type)?.set(r.id, r);
    changes.push(...cfg.initial.changes);
  }
  const touch = (/** @type {string} */ op, /** @type {any[]} */ args) => cfg.hook && cfg.hook(op, args);
  const table = (/** @type {string} */ t) => { if (!types.has(t)) throw fail("unknown_type", `no type ${t}`); return rows.get(t); };
  const note = (/** @type {string} */ kind, /** @type {any} */ r, /** @type {any} */ before) => {
    const entry = { cursor: `c${changes.length + 1}`, type: r.type, id: r.id, kind, version: r.version, at: r.updated_at, ...(before ? { before: clone(before) } : {}), after: clone(r.data) };
    changes.push(entry);
    if (cfg.persist) { cfg.persist.record(clone(r)); cfg.persist.change(clone(entry)); }
  };

  function validate(/** @type {string} */ type, /** @type {any} */ data) {
    const def = types.get(type);
    const known = new Set(def.fields.map((/** @type {any} */ f) => f.name));
    for (const k of Object.keys(data)) if (!known.has(k)) throw fail("unknown_field", `${type} has no field ${k}`);
    for (const f of def.fields) {
      const err = checkValue(f, data[f.name]);
      if (err === "sealed_value_refused") throw fail("sealed_value_refused", `${f.name} is sealed: a value is never stored, only a reference`);
      if (err) throw fail("invalid", err);
    }
  }

  return {
    async define(diff) {
      touch("define", [diff]);
      const changesMade = [];
      for (const t of diff.add_types || []) {
        const had = types.get(t.name);
        if (had && canonical(had) === canonical(t)) continue;
        types.set(t.name, clone(t));
        if (cfg.persist) cfg.persist.type(t.name, clone(t));
        if (!rows.has(t.name)) rows.set(t.name, new Map());
        changesMade.push(had ? `changed type ${t.name}` : `added type ${t.name}`);
      }
      for (const t of diff.change_types || []) {
        if (!types.has(t.name)) throw fail("unknown_type", `no type ${t.name}`);
        if (canonical(types.get(t.name)) === canonical(t)) continue;
        types.set(t.name, clone(t));
        if (cfg.persist) cfg.persist.type(t.name, clone(t));
        changesMade.push(`changed type ${t.name}`);
      }
      for (const name of diff.remove_types || []) {
        if (!types.has(name)) continue;
        if ([...rows.get(name).values()].some(r => !r.deleted_at)) throw fail("invalid", `type ${name} still has records`);
        types.delete(name); rows.delete(name);
        if (cfg.persist) cfg.persist.type(name, null);
        changesMade.push(`removed type ${name}`);
      }
      return { applied: changesMade.length > 0, changes: changesMade };
    },
    /** Every type definition, as defined. */
    async types() { touch("types", []); return [...types.values()].map(t => clone(t)); },
    /** The field names and kinds of a type, or null when there is no such type (the gateway reads sealed fields from here). */
    async describe(type) {
      touch("describe", [type]);
      const t = types.get(type);
      return t ? { name: t.name, fields: t.fields.map((/** @type {any} */ f) => ({ name: f.name, kind: f.kind })) } : null;
    },
    async get(type, id, opts = {}) {
      touch("get", [type, id]);
      const r = table(type).get(id);
      return r && (!r.deleted_at || opts.include_deleted) ? clone(r) : null;
    },
    async query(type, spec) {
      touch("query", [type, spec]);
      const all = [...table(type).values()].filter(r => spec.include_deleted || !r.deleted_at);
      const p = page(all, spec);
      if (p.error) throw fail("invalid", p.error);
      return clone(p);
    },
    async aggregate(type, spec) {
      touch("aggregate", [type, spec]);
      return clone(agg([...table(type).values()].filter(r => !r.deleted_at), spec));
    },
    async create(type, id, data) {
      touch("create", [type, id, data]);
      const t = table(type);
      if (!isUuid(id)) throw fail("invalid", "id must be a time-prefixed uuid");
      if (t.has(id)) throw fail("invalid", `${type} ${id} already exists`);
      validate(type, data);
      const now = clock();
      const r = { type, id, version: 1, data: clone(data), created_at: now, updated_at: now };
      t.set(id, r); note("created", r);
      return clone(r);
    },
    async update(type, id, patch, base) {
      touch("update", [type, id, patch, base]);
      const r = table(type).get(id);
      if (!r || r.deleted_at) throw fail("not_found", `no ${type} ${id}`);
      if (r.version !== base) throw fail("version_conflict", `${type} ${id} is at version ${r.version}, not ${base}`);
      const merged = { ...r.data };
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete merged[k]; else merged[k] = clone(v); }
      validate(type, merged);
      const before = r.data;
      r.data = merged; r.version += 1; r.updated_at = clock();
      note("updated", r, before);
      return clone(r);
    },
    async remove(type, id, base) {
      touch("remove", [type, id, base]);
      const r = table(type).get(id);
      if (!r || r.deleted_at) throw fail("not_found", `no ${type} ${id}`);
      if (r.version !== base) throw fail("version_conflict", `${type} ${id} is at version ${r.version}, not ${base}`);
      r.version += 1; r.deleted_at = r.updated_at = clock();
      note("removed", r);
      return clone(r);
    },
    async restore(type, id) {
      touch("restore", [type, id]);
      const r = table(type).get(id);
      if (!r || !r.deleted_at) throw fail("not_found", `no deleted ${type} ${id}`);
      r.version += 1; delete r.deleted_at; r.updated_at = clock();
      note("restored", r);
      return clone(r);
    },
    async search(spec) {
      touch("search", [spec]);
      const words = spec.text.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = [];
      for (const [type, t] of rows) {
        if (spec.types && !spec.types.includes(type)) continue;
        const def = types.get(type);
        for (const r of t.values()) {
          if (r.deleted_at) continue;
          let score = 0, snippet;
          for (const f of def.fields) {
            if (f.kind === "sealed") continue;
            const v = fieldOf(r, f.name);
            const text = typeof v === "string" ? v : Array.isArray(v) && v.every(x => typeof x === "string") ? v.join(" ") : "";
            const low = text.toLowerCase();
            for (const w of words) if (low.includes(w)) { score += 1; snippet = snippet || text.slice(0, 80); }
          }
          if (score) hits.push({ type, id: r.id, score, ...(snippet ? { snippet } : {}) });
        }
      }
      hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      let start = 0;
      if (spec.page.cursor) { const i = hits.findIndex(h => h.id === spec.page.cursor); start = i === -1 ? hits.length : i + 1; }
      const slice = hits.slice(start, start + spec.page.limit);
      return { rows: slice, ...(start + spec.page.limit < hits.length && slice.length ? { next_cursor: slice[slice.length - 1].id } : {}) };
    },
    async changes(since, limit) {
      touch("changes", [since]);
      const from = since ? Number(since.slice(1)) : 0;
      if (since !== null && !/^c\d+$/.test(since)) throw fail("invalid", "bad changes cursor");
      const entries = changes.slice(from, from + limit);
      return { entries: clone(entries), cursor: `c${from + entries.length}` };
    },
    async health() { touch("health", []); return { ok: true, checked_at: clock() }; },
    async version() { return { store: "memory", version: "1", conformance: CONFORMANCE_REVISION }; },
    async *export(since) {
      let seq = 0;
      const all = [];
      for (const t of rows.values()) for (const r of t.values()) if (!since || r.updated_at >= Number(since)) all.push(clone(r));
      all.sort((a, b) => (a.id < b.id ? -1 : 1));
      for (let i = 0; i < Math.max(1, all.length); i += 100) {
        const records = all.slice(i, i + 100);
        yield { seq: seq++, records, done: i + 100 >= all.length, checksum: sha256(canonical(records)) };
      }
    },
    features() { return { aggregate: true, search: true, changes: true, cursor_paging: /** @type {const} */ (true) }; },
  };
}
