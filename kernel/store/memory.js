// kernel/store/memory.js: the in-memory reference store. It implements the whole Store interface (contracts store.d.ts)
// and passes the conformance suite (kernel/conformance). It is what the gateway tests run against and what a real
// store (Twenty, K-later) is measured by. Not durable; not trusted either: the gateway treats it like any store.
import { canonical, sha256 } from "../core/canonical.js";
import { isUuid } from "../core/ids.js";
import { checkValue } from "./values.js";
import { page, aggregate as agg, fieldOf } from "./query.js";

/** The conformance suite revision this store last passed. Bump with the suite. */
export const CONFORMANCE_REVISION = 5;

const clone = (/** @type {any} */ v) => structuredClone(v);
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * One type's rows. The reference store keeps them in a Map; a durable store (kernel/store/sqlite.js) pages them from its database behind a small LRU, so the rows it holds in
 * memory are the hot ones, not all of them. `candidates` and `searchCandidates` may return a SUPERSET of what a query or a search needs (the database narrows by an equality
 * filter or a word); the same code then applies the exact rules, so an answer is the same either way.
 * @typedef {{ get(id: string): any, has(id: string): boolean, set(id: string, r: any): void, values(): Iterable<any>, candidates(spec: any): Iterable<any>, searchCandidates(words: string[]): Iterable<any> }} Table
 */
/** @returns {Table} */
function mapTable() {
  /** @type {Map<string, any>} */ const m = new Map();
  return { get: id => m.get(id), has: id => m.has(id), set: (id, r) => { m.set(id, r); }, values: () => [...m.values()], candidates: () => [...m.values()], searchCandidates: () => [...m.values()] };
}

/**
 * @param {{ clock?: () => number, hook?: (op: string, args: any[]) => void,
 *   initial?: { types: any[], records: any[], changes: any[] },
 *   backing?: { table(type: string): Table, changes: { readonly length: number, push(e: any): void, slice(from: number, to: number): any[] } },
 *   persist?: { type(name: string, def: any | null): void, record(r: any): void, change(e: any): void } }} [cfg]
 *   hook: tests throw from it to simulate a crash or an outage. initial and persist make the store durable (kernel/store/sqlite.js): the state it starts from, and a
 *   write-through for every change, called after the in-memory change is made.
 */
export function createMemoryStore(cfg = {}) {
  const clock = cfg.clock || Date.now;
  /** @type {Map<string, any>} */ const types = new Map();
  /** @type {Map<string, Table>} */ const rows = new Map();
  const makeTable = (/** @type {string} */ name) => (cfg.backing ? cfg.backing.table(name) : mapTable());
  /** @type {{ readonly length: number, push(e: any): void, slice(from: number, to: number): any[] }} */
  const changes = cfg.backing ? cfg.backing.changes : (() => { /** @type {any[]} */ const a = []; return { get length() { return a.length; }, push: (/** @type {any} */ e) => { a.push(e); }, slice: (/** @type {number} */ f, /** @type {number} */ t) => a.slice(f, t) }; })();
  if (cfg.initial) {
    for (const t of cfg.initial.types) { types.set(t.name, t); rows.set(t.name, makeTable(t.name)); }
    for (const r of cfg.initial.records) rows.get(r.type)?.set(r.id, r);
    if (!cfg.backing) for (const e of cfg.initial.changes) changes.push(e);
  }
  // (the unique indexes for a loaded store are rebuilt below, once the helpers exist)
  const touch = (/** @type {string} */ op, /** @type {any[]} */ args) => cfg.hook && cfg.hook(op, args);
  const table = (/** @type {string} */ t) => { if (!types.has(t)) throw fail("unknown_type", `no type ${t}`); return rows.get(t); };
  const note = (/** @type {string} */ kind, /** @type {any} */ r, /** @type {any} */ before) => {
    const entry = { cursor: `c${changes.length + 1}`, type: r.type, id: r.id, kind, version: r.version, at: r.updated_at, ...(before ? { before: clone(before) } : {}), after: clone(r.data) };
    changes.push(entry);
    if (cfg.persist) { cfg.persist.record(clone(r)); cfg.persist.change(clone(entry)); }
  };

  // Unique fields (contract: FieldDefinition.unique): among a type's LIVE records, a non-null value held by one record is refused for another. An index per (type, field)
  // keeps the check constant-time; it is rebuilt when a type is defined and kept by every write. The store is single-threaded, so check and write are one step.
  /** @type {Map<string, Map<string, string>>} */ const uidx = new Map();
  const ukey = (/** @type {any} */ v) => canonical(v);
  const uniqueOf = (/** @type {string} */ type) => (types.get(type)?.fields || []).filter((/** @type {any} */ f) => f.unique === true);
  function rebuildUnique(/** @type {string} */ type) {
    for (const k of [...uidx.keys()]) if (k.startsWith(`${type}\u0000`)) uidx.delete(k);
    const fields = uniqueOf(type);
    for (const f of fields) {
      const m = new Map();
      for (const r of rows.get(type)?.values() || []) {
        if (r.deleted_at || r.data[f.name] === undefined || r.data[f.name] === null) continue;
        const k = ukey(r.data[f.name]);
        if (m.has(k)) throw fail("unique_violation", `${f.name} of ${type} already has duplicate values, so it cannot be made unique`);
        m.set(k, r.id);
      }
      uidx.set(`${type}\u0000${f.name}`, m);
    }
  }
  /** Throw if `data` would put a value another live record holds. @param {string} type @param {any} data @param {string | null} selfId */
  function checkUnique(type, data, selfId) {
    for (const f of uniqueOf(type)) {
      const v = data[f.name];
      if (v === undefined || v === null) continue;
      const holder = uidx.get(`${type}\u0000${f.name}`)?.get(ukey(v));
      if (holder && holder !== selfId) throw Object.assign(fail("unique_violation", `${f.name} must be unique: another ${type} already has that value`), { field: f.name, value: v });
    }
  }
  function indexSet(/** @type {string} */ type, /** @type {any} */ r, /** @type {boolean} */ on) {
    for (const f of uniqueOf(type)) {
      const v = r.data[f.name]; if (v === undefined || v === null) continue;
      const m = uidx.get(`${type}\u0000${f.name}`); if (!m) continue;
      if (on) m.set(ukey(v), r.id); else if (m.get(ukey(v)) === r.id) m.delete(ukey(v));
    }
  }

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

  for (const name of types.keys()) rebuildUnique(name);

  return {
    async define(diff) {
      touch("define", [diff]);
      const changesMade = [];
      for (const t of diff.add_types || []) {
        const had = types.get(t.name);
        if (had && canonical(had) === canonical(t)) continue;
        types.set(t.name, clone(t));
        if (cfg.persist) cfg.persist.type(t.name, clone(t));
        if (!rows.has(t.name)) rows.set(t.name, makeTable(t.name));
        rebuildUnique(t.name);
        changesMade.push(had ? `changed type ${t.name}` : `added type ${t.name}`);
      }
      for (const t of diff.change_types || []) {
        if (!types.has(t.name)) throw fail("unknown_type", `no type ${t.name}`);
        if (canonical(types.get(t.name)) === canonical(t)) continue;
        const before = types.get(t.name);
        types.set(t.name, clone(t));
        try { rebuildUnique(t.name); } catch (e) { types.set(t.name, before); rebuildUnique(t.name); throw e; }
        if (cfg.persist) cfg.persist.type(t.name, clone(t));
        changesMade.push(`changed type ${t.name}`);
      }
      for (const name of diff.remove_types || []) {
        if (!types.has(name)) continue;
        if ([.../** @type {Table} */ (rows.get(name)).values()].some((/** @type {any} */ r) => !r.deleted_at)) throw fail("invalid", `type ${name} still has records`);
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
      const all = (function* (/** @type {Iterable<any>} */ it) { for (const r of it) if (spec.include_deleted || !r.deleted_at) yield r; })(table(type).candidates(spec));
      const p = page(all, spec);
      if (p.error) throw fail("invalid", p.error);
      return clone(p);
    },
    async aggregate(type, spec) {
      touch("aggregate", [type, spec]);
      return clone(agg((function* (/** @type {Iterable<any>} */ it) { for (const r of it) if (!r.deleted_at) yield r; })(table(type).candidates(spec)), spec));
    },
    async create(type, id, data) {
      touch("create", [type, id, data]);
      const t = table(type);
      if (!isUuid(id)) throw fail("invalid", "id must be a time-prefixed uuid");
      if (t.has(id)) throw fail("invalid", `${type} ${id} already exists`);
      validate(type, data);
      checkUnique(type, data, null);
      const now = clock();
      const r = { type, id, version: 1, data: clone(data), created_at: now, updated_at: now };
      t.set(id, r); indexSet(type, r, true); note("created", r);
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
      checkUnique(type, merged, id);
      const before = r.data;
      indexSet(type, r, false);
      r.data = merged; indexSet(type, r, true); r.version += 1; r.updated_at = clock();
      note("updated", r, before);
      return clone(r);
    },
    async remove(type, id, base) {
      touch("remove", [type, id, base]);
      const r = table(type).get(id);
      if (!r || r.deleted_at) throw fail("not_found", `no ${type} ${id}`);
      if (r.version !== base) throw fail("version_conflict", `${type} ${id} is at version ${r.version}, not ${base}`);
      indexSet(type, r, false);
      r.version += 1; r.deleted_at = r.updated_at = clock();
      note("removed", r);
      return clone(r);
    },
    async restore(type, id) {
      touch("restore", [type, id]);
      const r = table(type).get(id);
      if (!r || !r.deleted_at) throw fail("not_found", `no deleted ${type} ${id}`);
      checkUnique(type, r.data, id);
      r.version += 1; delete r.deleted_at; r.updated_at = clock(); indexSet(type, r, true);
      note("restored", r);
      return clone(r);
    },
    async search(spec) {
      touch("search", [spec]);
      const words = spec.text.toLowerCase().split(/\s+/).filter(Boolean);
      // The first page keeps only the best `limit` hits as it goes (a small sorted list); a later page (a cursor is a position in the whole ranking) needs the whole list.
      const top = !spec.page.cursor;
      const better = (/** @type {any} */ a, /** @type {any} */ b) => a.score - b.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      /** @type {any[]} */ const hits = [];
      let counted = 0;
      const add = (/** @type {any} */ h) => {
        if (!top) { hits.push(h); return; }
        counted++;
        if (hits.length === spec.page.limit && better(h, hits[hits.length - 1]) >= 0) return;
        let lo = 0, hi = hits.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (better(hits[mid], h) <= 0) lo = mid + 1; else hi = mid; }
        hits.splice(lo, 0, h);
        if (hits.length > spec.page.limit) hits.pop();
      };
      for (const [type, t] of rows) {
        if (spec.types && !spec.types.includes(type)) continue;
        const def = types.get(type);
        for (const r of t.searchCandidates(words)) {
          if (r.deleted_at) continue;
          let score = 0, snippet;
          for (const f of def.fields) {
            if (f.kind === "sealed") continue;
            const v = fieldOf(r, f.name);
            const text = typeof v === "string" ? v : Array.isArray(v) && v.every(x => typeof x === "string") ? v.join(" ") : "";
            const low = text.toLowerCase();
            for (const w of words) if (low.includes(w)) { score += 1; snippet = snippet || text.slice(0, 80); }
          }
          if (score) add({ type, id: r.id, score, ...(snippet ? { snippet } : {}) });
        }
      }
      if (top) return { rows: hits, ...(counted > spec.page.limit && hits.length ? { next_cursor: hits[hits.length - 1].id } : {}) };
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
    /** Forget the values these fields held in the change log (a field was sealed: its old plain values must not survive here). Stores with a durable log do the same through `cfg.persist.scrub`. */
    async scrub(type, fields) {
      touch("scrub", [type, fields]);
      for (const e of changes) if (e.type === type) for (const f of fields) { if (e.before) delete e.before[f]; if (e.after) delete e.after[f]; }
      if (cfg.persist && typeof cfg.persist.scrub === "function") cfg.persist.scrub(type, fields);
    },
    features() { return { aggregate: true, search: true, changes: true, cursor_paging: /** @type {const} */ (true) }; },
  };
}
