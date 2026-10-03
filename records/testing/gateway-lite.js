// @ts-check
// A stand-in for the platform's gateway, for the records team's own tests and the testbox runs. It
// does what the spec says the gateway does around a store, minus grants: mint the id, call the store,
// write the event with before and after, keep an idempotency key. The real gateway replaces it; the
// connector and the flow runner only ever see this small shape (find, create, emit, urn).

import { mintUuid } from "../../kernel/core/ids.js";

export class GatewayLite {
  /** @param {{ store: any, types: any[], actor?: string, space?: string, now?: () => number }} o */
  constructor(o) {
    this.store = o.store; this.actor = o.actor ?? "system:records"; this.space = o.space ?? "harlow";
    this.types = new Map(o.types.map((t) => [t.name, t]));
    this.now = o.now ?? Date.now;
    /** @type {any[]} */ this.events = [];
    /** @type {Map<string, any>} */ this.keys = new Map();
  }
  /** @param {string} type @param {string} id */ urn(type, id) { return `vyre://${this.space}/${type}/${id}`; }
  #event(/** @type {any} */ e) { const row = { id: mintUuid(this.now()), at: this.now(), space: this.space, actor: this.actor, ...e }; this.events.push(row); return row; }
  /** Write an event once per idempotency key. @param {string} kind @param {any} payload @param {{ source?: string, key?: string }} [o] */
  emit(kind, payload, o = {}) {
    if (o.key && this.keys.has(o.key)) return { event: this.keys.get(o.key), duplicate: true };
    const event = this.#event({ kind, source: o.source ?? "gateway", payload });
    if (o.key) this.keys.set(o.key, event);
    return { event, duplicate: false };
  }
  /** One record whose fields equal `by`, or null. @param {string} type @param {Record<string, any>} by */
  async find(type, by) {
    const parts = Object.entries(by).map(([field, value]) => ({ field, op: "eq", value: this.#coerce(type, field, value) }));
    const r = await this.store.query(type, { filter: parts.length === 1 ? parts[0] : { and: parts }, page: { limit: 1 } });
    return r.rows[0] ?? null;
  }
  /** Templates give a ref as its urn text; the store wants { urn }. @param {string} type @param {string} field @param {any} v */
  #coerce(type, field, v) {
    const f = this.types.get(type)?.fields.find((/** @type {any} */ x) => x.name === field);
    if (f?.kind === "ref" && typeof v === "string") return { urn: v };
    return v;
  }
  /** @param {string} type @param {Record<string, any>} fields */
  async create(type, fields) {
    const data = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, this.#coerce(type, k, v)]));
    const rec = await this.store.create(type, mintUuid(this.now()), data);
    this.#event({ kind: "record.created", ref: this.urn(type, rec.id), before: null, after: rec.data, version: rec.version, hash: this.store.recordHash ? this.store.recordHash(rec) : undefined });
    return rec;
  }
  /** @param {string} type @param {string} id @param {Record<string, any>} patch */
  async update(type, id, patch) {
    const before = await this.store.get(type, id);
    const rec = await this.store.update(type, id, patch, /** @type {any} */ (before).version);
    this.#event({ kind: "record.updated", ref: this.urn(type, id), before: before?.data ?? null, after: rec.data, version: rec.version, hash: this.store.recordHash ? this.store.recordHash(rec) : undefined });
    return rec;
  }
}
