// @ts-check
// A stand-in for the platform's gateway, for the records team's own tests and the testbox runs. It
// does what the spec says the gateway does around a store, minus grants: write an intent, call the
// store, write the event with before, after and the version hash, keep an idempotency key. The real
// gateway replaces it; the store and the connector only ever see this shape.

import { mintId } from "../ids.js";

export class GatewayLite {
  /** @param {{ store: any, actor?: string, space?: string, now?: () => number }} o */
  constructor(o) {
    this.store = o.store; this.actor = o.actor ?? "system:records"; this.space = o.space ?? "harlow";
    this.now = o.now ?? Date.now;
    /** @type {any[]} */ this.events = [];
    /** @type {Map<string, any>} */ this.keys = new Map();
  }
  #event(e) { const row = { id: mintId(), at: new Date(this.now()).toISOString(), space: this.space, actor: this.actor, ...e }; this.events.push(row); return row; }
  /** Write an event once per idempotency key. @param {string} kind @param {any} payload @param {{ source?: string, key?: string }} [o] */
  emit(kind, payload, o = {}) {
    if (o.key && this.keys.has(o.key)) return { event: this.keys.get(o.key), duplicate: true };
    const event = this.#event({ kind, source: o.source ?? "gateway", payload });
    if (o.key) this.keys.set(o.key, event);
    return { event, duplicate: false };
  }
  async query(type, q) { return this.store.query(type, q); }
  async get(type, id) { return this.store.get(type, id); }
  async create(type, r) {
    const rec = await this.store.create(type, r);
    this.#event({ kind: "record.created", ref: `vyre://${this.space}/${type}/${rec.id}`, before: null, after: rec.fields, hash: rec.hash, version: rec.version });
    return rec;
  }
  async update(type, id, patch, base) {
    const before = await this.store.get(type, id);
    const rec = await this.store.update(type, id, patch, base ?? before?.version);
    this.#event({ kind: "record.updated", ref: `vyre://${this.space}/${type}/${id}`, before: before?.fields ?? null, after: rec.fields, hash: rec.hash, version: rec.version });
    return rec;
  }
}
