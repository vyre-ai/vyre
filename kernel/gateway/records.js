// kernel/gateway/records.js: the gateway's record calls (contract 3.1; invariants 1, 7, 8, 10). Every call takes the
// kernel-built chain, asks `authorize` first, writes an intent before the store call and one event after, and treats
// the store as untrusted: it never lets the store decide who may see a row, it checks each returned row itself,
// it keeps the id it minted, and it verifies a record's version hash against the event that wrote it.
import { canonical, sha256 } from "../core/canonical.js";
import { mintUuid } from "../core/ids.js";
import { isChain, hasKind } from "../core/chain.js";
import { KernelError } from "../core/errors.js";
import { aggregate as aggregateRows } from "../store/query.js";
import { isSealedShape } from "../store/values.js";

/** The actions the gateway registers with the authorizer (contract 6.1). */
export const RECORD_ACTIONS = Object.freeze([
  { action: "records.read", resource_type: "record", risk: "read", label: "read records", gloss: "Open and search records." },
  { action: "records.create", resource_type: "record", risk: "write", label: "add records", gloss: "Create new records." },
  { action: "records.update", resource_type: "record", risk: "write", label: "edit records", gloss: "Change what a record holds." },
  { action: "records.remove", resource_type: "record", risk: "write", label: "remove records", gloss: "Move records to the bin." },
  { action: "records.restore", resource_type: "record", risk: "write", label: "restore records", gloss: "Bring records back from the bin." },
  { action: "records.define", resource_type: "definition", risk: "admin", label: "change types", gloss: "Add or change the kinds of record and their fields." },
].map(a => Object.freeze(a)));

const TYPE_NAME = /^[a-z][a-z0-9-]*$/;
/** A store answer that definitely means "nothing happened", so the intent can be closed as compensated. */
const REFUSED = new Set(["invalid", "unknown_type", "unknown_field", "version_conflict", "not_found", "sealed_value_refused"]);
const STORE_CODES = new Set(["not_found", "version_conflict", "invalid", "unknown_type", "unknown_field", "unsupported", "unavailable", "id_mismatch", "sealed_value_refused"]);

/** What a version hash covers: the record as the gateway wrote it. */
export const versionHash = (/** @type {any} */ r) => sha256(canonical({ type: r.type, id: r.id, version: r.version, deleted: Boolean(r.deleted_at), data: r.data }));

const redactDiff = (/** @type {any} */ data, /** @type {Set<string>} */ changed) =>
  Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, isSealedShape(v) ? { sealed: true, changed: changed.has(k) } : v]));
const changedFields = (/** @type {any} */ a, /** @type {any} */ b) => {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter(k => canonical((a || {})[k] ?? null) !== canonical((b || {})[k] ?? null)).sort();
};

/**
 * @param {{ space: string, store: any, authorizer: { authorize(i: any): Promise<any> }, log: any, chains: any, clock?: () => number }} cfg
 */
export function createRecords(cfg) {
  const { space, store, authorizer, log, chains } = cfg;
  const clock = cfg.clock || Date.now;
  const urn = (/** @type {string} */ type, /** @type {string} */ id) => `vyre://${space}/${type}/${id}`;
  /** @type {Map<string, any>} */ const intents = new Map();
  /** @type {Map<string, { version: number, hash: string }>} the latest version hash the gateway wrote, per record */ const index = new Map();

  function mapError(/** @type {any} */ e) {
    if (e instanceof KernelError) return e;
    if (e && STORE_CODES.has(e.code)) return new KernelError(e.code, e.message);
    return new KernelError("unavailable", "the store could not answer", String(e && e.message));
  }

  /** Ask `authorize`. Allow returns the decision; ask and deny throw, and a deny looks like absence (invariant 8). */
  async function gate(/** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource, /** @type {{ quiet?: boolean }} */ opts = {}) {
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    const d = await authorizer.authorize({ chain, action, resource });
    if (d.effect === "allow") return d;
    if (d.effect === "ask") throw Object.assign(new KernelError(d.reason, `${action} needs ${d.reason === "needs_presence" ? "presence" : "approval"}`), { decision: d.decision, obligations: d.obligations });
    if (!opts.quiet && d.obligations.some((/** @type {any} */ o) => o.type === "audit")) {
      try { log.append(chain, { type: "access.denied", sv: 1, subject: resource, data: { action, reason: d.reason }, prov: { decision: d.decision } }); } catch { /* the refusal stands even if the note cannot be written */ }
    }
    throw Object.assign(new KernelError("not_found", "no such record", d.reason), { decision: d.decision });
  }
  const allowed = async (/** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource) => {
    try { await gate(chain, action, resource, { quiet: true }); return true; } catch { return false; }
  };

  /** Shape a stored row for the caller: checked, labelled, and with sealed values as placeholders when a model is in the chain. */
  function shape(/** @type {any} */ chain, /** @type {any} */ r) {
    const u = urn(r.type, r.id);
    const known = index.get(u);
    const hash = versionHash(r);
    const modified = !known || known.version !== r.version || known.hash !== hash;
    const model = hasKind(chain, "agent");
    const data = model ? Object.fromEntries(Object.entries(r.data).map(([k, v]) => [k, isSealedShape(v) ? { sealed: /** @type {any} */ (v).sealed, present: Boolean(/** @type {any} */ (v).present), valid_format: Boolean(/** @type {any} */ (v).valid_format) } : v])) : r.data;
    return Object.freeze({ ...r, data, urn: u, labels: { trust: modified ? "external" : "member", red: "internal", source_spaces: [space] }, ...(modified ? { modified_outside: true } : {}) });
  }

  async function write(/** @type {any} */ chain, /** @type {"create"|"update"|"remove"|"restore"} */ op, /** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ input, /** @type {number | null} */ base, /** @type {() => Promise<any>} */ run, /** @type {(() => Promise<any>) | null} */ getBefore) {
    if (!TYPE_NAME.test(type)) throw new KernelError("bad_input", "bad type name");
    const u = urn(type, id);
    const d = await gate(chain, `records.${op}`, u);
    let before = null;
    if (getBefore) { try { before = await getBefore(); } catch (e) { throw mapError(e); } }
    const intent = { id: mintUuid(clock()), decision: d.decision, chain: chain.hops, record: u, base_version: base, operation: op, input_hash: sha256(canonical(input)), state: "open", started_at: clock(), stored: chains.serialize(chain) };
    intents.set(intent.id, intent);
    let rec;
    try { rec = await run(); }
    catch (e) {
      const err = mapError(e);
      // A definite refusal means nothing happened. A lost answer (unavailable) may mean it did: the intent stays open for recovery.
      if (REFUSED.has(err.code)) intent.state = "compensated";
      throw err;
    }
    if (rec.id !== id || rec.type !== type) {
      intent.state = "compensated";
      try { if (op === "create") await store.remove(type, id, rec.version); } catch { /* best effort */ }
      throw new KernelError("id_mismatch", "the store did not keep the id it was given");
    }
    emit(chain, intent, rec, before, d.decision, false);
    return shape(chain, rec);
  }

  function emit(/** @type {any} */ chain, /** @type {any} */ intent, /** @type {any} */ rec, /** @type {any} */ before, /** @type {string} */ decision, /** @type {boolean} */ recovered) {
    const changed = changedFields(before ? before.data : {}, rec.data);
    const set = new Set(changed);
    const hash = versionHash(rec);
    const verb = { create: "created", update: "updated", remove: "removed", restore: "restored" }[/** @type {"create"} */ (intent.operation)];
    const sealed = Object.values(rec.data).some(isSealedShape);
    log.append(chain, {
      type: `${rec.type}.${verb}`, sv: 1, subject: intent.record,
      data: { changed, version: rec.version, version_hash: hash, ...(before ? { before: redactDiff(before.data, set) } : {}), after: redactDiff(rec.data, set), ...(recovered ? { recovered: true } : {}) },
      red: sealed ? "pii" : "internal",
    }, { decision });
    index.set(intent.record, { version: rec.version, hash });
    intent.state = "completed";
  }

  return {
    async define(chain, diff) {
      const d = await gate(chain, "records.define", `vyre://${space}/definition/types`);
      for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) if (!TYPE_NAME.test(t.name)) throw new KernelError("bad_input", `bad type name ${t.name}`);
      let res;
      try { res = await store.define(diff); } catch (e) { throw mapError(e); }
      if (res.applied) log.append(chain, { type: "types.defined", sv: 1, subject: `vyre://${space}/definition/types`, data: { changes: res.changes } }, { decision: d.decision });
      return res;
    },

    async get(chain, type, id) {
      const u = urn(type, id);
      try { await gate(chain, "records.read", u); } catch (e) { if (e instanceof KernelError && e.code === "not_found") return null; throw e; }
      let r;
      try { r = await store.get(type, id); } catch (e) { throw mapError(e); }
      return r && r.id === id && r.type === type ? shape(chain, r) : null;
    },

    async query(chain, type, spec) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      let cursor = spec.page.cursor, out = [], next;
      for (let pages = 0; pages < 10; pages++) {
        let p;
        try { p = await store.query(type, { ...spec, page: { limit: spec.page.limit, ...(cursor ? { cursor } : {}) } }); } catch (e) { throw mapError(e); }
        for (const r of p.rows) if (r.type === type && await allowed(chain, "records.read", urn(r.type, r.id))) out.push(shape(chain, r));
        next = p.next_cursor;
        if (out.length || !next) break;
        cursor = next;
      }
      return { rows: out, ...(next ? { next_cursor: next } : {}) };
    },

    async aggregate(chain, type, spec) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      // A store cannot hide rows from a total, so the gateway aggregates only the rows it has itself allowed.
      const rows = [];
      let cursor;
      for (let pages = 0; pages < 40; pages++) {
        let p;
        try { p = await store.query(type, { filter: spec.filter, page: { limit: 500, ...(cursor ? { cursor } : {}) } }); } catch (e) { throw mapError(e); }
        for (const r of p.rows) if (r.type === type && await allowed(chain, "records.read", urn(r.type, r.id))) rows.push(r);
        if (!p.next_cursor) return aggregateRows(rows, spec);
        cursor = p.next_cursor;
      }
      throw new KernelError("unsupported", "too many rows to total here");
    },

    async search(chain, spec) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      let p;
      try { p = await store.search(spec); } catch (e) { throw mapError(e); }
      const rows = [];
      for (const h of p.rows) if (await allowed(chain, "records.read", urn(h.type, h.id))) rows.push(h);
      return { rows, ...(p.next_cursor ? { next_cursor: p.next_cursor } : {}) };
    },

    async create(chain, type, data) {
      const id = mintUuid(clock());
      return write(chain, "create", type, id, data, null, () => store.create(type, id, data), null);
    },

    async update(chain, type, id, patch, base) {
      return write(chain, "update", type, id, patch, base, () => store.update(type, id, patch, base), () => store.get(type, id));
    },

    async remove(chain, type, id, base) {
      return write(chain, "remove", type, id, {}, base, () => store.remove(type, id, base), () => store.get(type, id));
    },

    async restore(chain, type, id) {
      return write(chain, "restore", type, id, {}, null, () => store.restore(type, id), () => store.get(type, id, { include_deleted: true }));
    },

    /**
     * Close intents a crash left open: if the store shows the change was made, write the event that was missing
     * (marked recovered); if it shows nothing happened, close the intent as compensated. Never guesses.
     */
    async recover() {
      const result = { completed: 0, compensated: 0, still_open: 0 };
      for (const intent of intents.values()) {
        if (intent.state !== "open") continue;
        const [, type, id] = intent.record.slice(7).split("/");
        let rec;
        try { rec = id ? await store.get(type, id, { include_deleted: true }) : null; } catch { result.still_open++; continue; }
        const op = intent.operation;
        const applied = Boolean(rec) && (op === "create" ? true : op === "update" ? rec.version > intent.base_version : op === "remove" ? Boolean(rec.deleted_at) && rec.version > intent.base_version : !rec.deleted_at);
        if (!applied) { intent.state = "compensated"; result.compensated++; continue; }
        emit(chains.restore(intent.stored), intent, rec, null, intent.decision, true);
        result.completed++;
      }
      return result;
    },

    openIntents: () => [...intents.values()].filter(i => i.state === "open").length,
    intents: () => [...intents.values()].map(({ stored: _s, ...rest }) => rest),
    /** Rebuild the version-hash index from the log (after a restart). */
    rebuild() {
      index.clear();
      for (const e of log.read()) {
        const d = e.data;
        if (d && typeof d === "object" && typeof d.version_hash === "string" && typeof d.version === "number") index.set(e.subject, { version: d.version, hash: d.version_hash });
      }
    },
    versionHash,
  };
}
