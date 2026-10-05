// kernel/store/memory.js: the in-memory reference store. It implements the whole Store interface (contracts store.d.ts)
// and passes the conformance suite (kernel/conformance). It is what the gateway tests run against and what a real
// store (Twenty) is measured by. TEST AND DEVELOPMENT ONLY: not durable, and a packaged build never uses it (boot.js gives a packaged
// build with no Twenty a store that refuses every record call). Not trusted either: the gateway treats it like any store.
import { canonical, sha256 } from "../core/canonical.js";
import { isUuid } from "../core/ids.js";
import { checkValue } from "./values.js";
import { page, aggregate as agg, fieldOf } from "./query.js";

/** The conformance suite revision this store last passed. Bump with the suite. */
export const CONFORMANCE_REVISION = 5;

const clone = (/** @type {any} */ v) => structuredClone(v);
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * One type's rows, kept in a Map. `candidates` and `searchCandidates` return every row (a store with an index may return a SUPERSET of what a query or a search needs; the same code then applies the exact rules).
 * @typedef {{ get(id: string): any, has(id: string): boolean, set(id: string, r: any): void, drop(id: string): void, values(): Iterable<any>, searchTop?(words: string[], n: number, after?: { score: number, id: string }): Iterable<any> | null, pageQuery?(spec: any): any, aggregateQuery?(spec: any): any, candidates(spec: any): Iterable<any>, searchCandidates(words: string[]): Iterable<any> }} Table
 */
/** @returns {Table} */
function mapTable() {
  /** @type {Map<string, any>} */ const m = new Map();
  return { get: id => m.get(id), has: id => m.has(id), set: (id, r) => { m.set(id, r); }, drop: id => { m.delete(id); }, values: () => [...m.values()], candidates: () => [...m.values()], searchCandidates: () => [...m.values()] };
}

/**
 * @param {{ clock?: () => number, hook?: (op: string, args: any[]) => void }} [cfg]
 *   hook: tests throw from it to simulate a crash or an outage.
 */
export function createMemoryStore(cfg = {}) {
  const clock = cfg.clock || Date.now;
  /** @type {Map<string, any>} */ const types = new Map();
  /** @type {Map<string, Table>} */ const rows = new Map();
  const makeTable = (/** @type {string} */ _name) => mapTable();
  /** @type {{ readonly length: number, push(e: any): void, pop?(): void, slice(from: number, to: number): any[] }} */
  const changes = (() => { /** @type {any[]} */ const a = []; return { get length() { return a.length; }, push: (/** @type {any} */ e) => { a.push(e); }, pop: () => { a.pop(); }, slice: (/** @type {number} */ f, /** @type {number} */ t) => a.slice(f, t) }; })();
  // (the unique indexes for a loaded store are rebuilt below, once the helpers exist)
  const touch = (/** @type {string} */ op, /** @type {any[]} */ args) => cfg.hook && cfg.hook(op, args);
  const table = (/** @type {string} */ t) => { if (!types.has(t)) throw fail("unknown_type", `no type ${t}`); return rows.get(t); };
  const note = (/** @type {string} */ kind, /** @type {any} */ r, /** @type {any} */ before) => {
    const entry = { cursor: `c${changes.length + 1}`, type: r.type, id: r.id, kind, version: r.version, at: r.updated_at, ...(before ? { before: clone(before) } : {}), after: clone(r.data) };
    changes.push(entry);
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
        changesMade.push(`changed type ${t.name}`);
      }
      for (const name of diff.remove_types || []) {
        if (!types.has(name)) continue;
        if ([.../** @type {Table} */ (rows.get(name)).values()].some((/** @type {any} */ r) => !r.deleted_at)) throw fail("invalid", `type ${name} still has records`);
        types.delete(name); rows.delete(name);
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
      const fast = table(type).pageQuery ? table(type).pageQuery(spec) : null;
      if (fast && fast.error) throw fail("invalid", fast.error);
      if (fast) return clone(fast);
      const all = (function* (/** @type {Iterable<any>} */ it) { for (const r of it) if (spec.include_deleted || !r.deleted_at) yield r; })(table(type).candidates(spec));
      const p = page(all, spec);
      if (p.error) throw fail("invalid", p.error);
      return clone(p);
    },
    async aggregate(type, spec) {
      touch("aggregate", [type, spec]);
      // A sealed field is never grouped or measured: there is no value to group by.
      const sealedField = (/** @type {any} */ f) => typeof f === "string" && types.get(type).fields.some((/** @type {any} */ d) => d.name === f && d.kind === "sealed");
      for (const g of spec.group_by || []) if (sealedField(g)) throw fail("invalid", `${g} is sealed: it cannot be grouped by`);
      for (const m of spec.measures || []) if (m && sealedField(m.field)) throw fail("invalid", `${m.field} is sealed: it cannot be measured`);
      const fast = table(type).aggregateQuery ? table(type).aggregateQuery(spec) : null;
      if (fast) return clone(fast);
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
    /**
     * Take back the last write to a record that was made inside a unit of work whose database transaction was rolled back (the gateway's event for it was refused): memory goes back to what
     * the database holds. `previous` is the row before the write (a clone), null for a create. The write must be the newest change.
     * @param {string} type @param {string} id @param {any} previous
     */
    async undo(type, id, previous) {
      const t = table(type), cur = t.get(id);
      if (cur && !cur.deleted_at) indexSet(type, cur, false);
      if (previous) { const r = clone(previous); t.set(id, r); if (!r.deleted_at) indexSet(type, r, true); } else t.drop(id);
      if (changes.pop) changes.pop();
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
      const hitOf = (/** @type {string} */ type, /** @type {any} */ def, /** @type {any} */ r) => {
        let score = 0, snippet;
        for (const f of def.fields) {
          if (f.kind === "sealed") continue;
          const v = fieldOf(r, f.name);
          const text = typeof v === "string" ? v : Array.isArray(v) && v.every(x => typeof x === "string") ? v.join(" ") : "";
          const low = text.toLowerCase();
          for (const w of words) if (low.includes(w)) { score += 1; snippet = snippet || text.slice(0, 80); }
        }
        return score ? { type, id: r.id, score, ...(snippet ? { snippet } : {}) } : null;
      };
      const scope = [...rows].filter(([type]) => !spec.types || spec.types.includes(type));
      // A later page of a ranked search, when the store can rank by itself: the hits strictly after the cursor's hit in (score, id) order, `limit + 1` of them, ranked by the store. The
      // cursor's own hit is found and scored here; if it is gone (changed, removed) the whole list is used, as before.
      if (!top && scope.length && scope.every(([, t]) => t.searchTop)) {
        let cur = null;
        for (const [type, t] of scope) { const r = t.get(spec.page.cursor); if (r && !r.deleted_at) { cur = hitOf(type, types.get(type), r); if (cur) break; } }
        if (cur) {
          /** @type {any[]} */ const got = [];
          let ok = true;
          for (const [type, t] of scope) {
            const list = t.searchTop(words, spec.page.limit + 1, { score: cur.score, id: cur.id });
            if (!list) { ok = false; break; }
            for (const r of list) { if (r.deleted_at) continue; const h = hitOf(type, types.get(type), r); if (h) got.push(h); }
          }
          if (ok) {
            got.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
            const slice = got.slice(0, spec.page.limit);
            return { rows: slice, ...(got.length > spec.page.limit && slice.length ? { next_cursor: slice[slice.length - 1].id } : {}) };
          }
        }
      }
      for (const [type, t] of scope) {
        const def = types.get(type);
        for (const r of (top && t.searchTop && t.searchTop(words, spec.page.limit + 1)) || t.searchCandidates(words)) {
          if (r.deleted_at) continue;
          const h = hitOf(type, def, r);
          if (h) add(h);
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
    /**
     * Destroy one record for good (the gateway's `forget`): its row, its index entries and what the change log holds of it. The log keeps an entry's envelope (type, id, kind, version, time)
     * and loses its data, so the cursors still line up.
     */
    async destroy(type, id) {
      touch("destroy", [type, id]);
      const t = table(type), r = t.get(id);
      if (!r) throw fail("not_found", `no ${type} ${id}`);
      if (!r.deleted_at) indexSet(type, r, false);
      for (let i = 0; i < changes.length; i += 500) for (const e of changes.slice(i, i + 500)) if (e.type === type && e.id === id) { delete e.before; delete e.after; e.erased = true; }
      if (typeof t.drop === "function") t.drop(id);
      else { r.data = {}; r.deleted_at = r.deleted_at || clock(); r.version += 1; r.updated_at = clock(); t.set(id, r); }
    },
    /** Forget the values these fields held in the change log (a field was sealed: its old plain values must not survive here). */
    async scrub(type, fields) {
      touch("scrub", [type, fields]);
      for (let i = 0; i < changes.length; i += 500) for (const e of changes.slice(i, i + 500)) if (e.type === type) for (const f of fields) { if (e.before) delete e.before[f]; if (e.after) delete e.after[f]; }
    },
    features() { return { aggregate: true, search: true, changes: true, cursor_paging: /** @type {const} */ (true) }; },
  };
}
