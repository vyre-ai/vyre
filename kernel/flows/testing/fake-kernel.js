// A small in-memory stand-in for the kernel, enough to run the Flow runner end to end in tests: records with versions and idempotency
// keys, an authorize table you can change per test, tasks, an event log and chains. Not the real gateway: it checks nothing the real one
// checks except what the runner depends on.

import crypto from "node:crypto";

const uuid = () => { const b = crypto.randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; return b.toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"); };

export class FakeKernel {
  /** @param {{ space?: string, now?: () => number }} [o] */
  constructor(o = {}) {
    this.space = o.space || "spc_harlow000001";
    this.now = o.now || (() => Date.now());
    /** @type {Map<string, Map<string, any>>} */ this.tables = new Map();
    /** @type {Map<string, any>} */ this.idem = new Map();
    /** @type {any[]} */ this.log = [];
    /** @type {any[]} */ this.tasks = [];
    /** @type {any[]} */ this.calls = [];
    /** @type {Set<Function>} */ this.subs = new Set();
    /** @type {{ match: (i: any) => boolean, effect: string, reason: string }[]} */ this.rules = [];
    this.seq = 0;
    this.denied = new Set();
    /** @type {any[]} */ this.defines = [];
    /** @type {any[]} */ this.grantRows = [];
    this.grants = {
      create: async (/** @type {any} */ _c, /** @type {any} */ g) => { const row = { id: "gr_" + uuid(), status: "active", ...g }; this.grantRows.push(row); return row; },
      revoke: async (/** @type {any} */ _c, /** @type {string} */ id) => { const g = this.grantRows.find(x => x.id === id); if (g) g.status = "revoked"; return g; },
      list: async () => this.grantRows,
    };
    this.modelLabel = "normal";

    this.authorizeCalls = [];
    const self = this;
    this.authorize = async (/** @type {any} */ input) => {
      self.authorizeCalls.push({ action: input.action, resource: input.resource, chain: input.chain });
      const rule = self.rules.find(r => r.match(input));
      const approver = input.chain.hops[input.chain.hops.length - 1].actor;
      if (!rule && self.denied.has(approver.id)) return { effect: "deny", reason: "revoked", grants: [], obligations: [], decision: "dec_" + uuid(), policy_version: 1 };
      const effect = rule ? rule.effect : "allow";
      // a standing rule (kernel-2's shape): obligations (draft_only, ask with waivable false) and the rule that refused, as `authorize` returns them
      return { effect, reason: rule ? rule.reason : "ok", grants: [], obligations: (rule && rule.obligations) || [], ...(rule && rule.rule ? { rule: rule.rule } : {}), decision: "dec_" + uuid(), policy_version: 1 };
    };

    this.records = {
      define: async (/** @type {any} */ _c, /** @type {any} */ diff) => { this.defines.push(diff); for (const t of diff.add_types || []) if (!this.tables.has(t.name)) this.tables.set(t.name, new Map()); for (const n of diff.remove_types || []) this.tables.delete(n); return { applied: true, changes: [] }; },
      get: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {string} */ id) => { this.calls.push(["get", type, id]); return this.#t(type).get(id) || null; },
      query: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {any} */ spec) => {
        this.calls.push(["query", type, spec.filter || null]);
        let rows = [...this.#t(type).values()].filter(r => !r.deleted_at && (!spec.filter || this.#match(r, spec.filter)));
        if (spec.sort && spec.sort[0]) { const { field, dir } = spec.sort[0]; rows.sort((a, b) => (a.data[field] > b.data[field] ? 1 : -1) * (dir === "desc" ? -1 : 1)); }
        const start = spec.page.cursor ? Number(spec.page.cursor) : 0;
        const page = rows.slice(start, start + spec.page.limit);
        return { rows: page, next_cursor: start + spec.page.limit < rows.length ? String(start + spec.page.limit) : undefined };
      },
      aggregate: async () => [],
      search: async () => ({ rows: [] }),
      create: async (/** @type {any} */ chain, /** @type {string} */ type, /** @type {any} */ data, /** @type {any} */ opts) => {
        this.calls.push(["create", type, data, opts && opts.idem]);
        if (opts && opts.idem && this.idem.has(opts.idem)) return this.idem.get(opts.idem);
        const id = uuid(), now = this.now();
        const rec = { type, id, version: 1, data: { ...data }, created_at: now, updated_at: now, urn: `vyre://${this.space}/${type}/${id}`, labels: chain.labels };
        this.#t(type).set(id, rec);
        if (opts && opts.idem) this.idem.set(opts.idem, rec);
        this.emit(`${type}.created`, { id, type, data }, chain, rec.urn);
        if (data.stage) this.emit("record.stage-entered", { type, id, stage: data.stage }, chain, rec.urn);
        return rec;
      },
      update: async (/** @type {any} */ chain, /** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ patch, /** @type {number} */ base, /** @type {any} */ opts) => {
        this.calls.push(["update", type, id, patch, opts && opts.idem]);
        if (opts && opts.idem && this.idem.has(opts.idem)) return this.idem.get(opts.idem);
        const rec = this.#t(type).get(id);
        if (!rec) throw Object.assign(new Error("not found"), { code: "not_found" });
        if (rec.version !== base) throw Object.assign(new Error("version conflict"), { code: "version_conflict" });
        const before = { ...rec.data };
        rec.data = { ...rec.data, ...patch }; rec.version++; rec.updated_at = this.now();
        if (opts && opts.idem) this.idem.set(opts.idem, rec);
        this.emit(`${type}.updated`, { id, type, before, after: rec.data }, chain, rec.urn);
        if ("stage" in patch && patch.stage !== before.stage) this.emit("record.stage-entered", { type, id, stage: patch.stage }, chain, rec.urn);
        return rec;
      },
      remove: async (/** @type {any} */ chain, /** @type {string} */ type, /** @type {string} */ id, /** @type {number} */ base, /** @type {any} */ opts) => {
        this.calls.push(["remove", type, id, opts && opts.idem]);
        const rec = this.#t(type).get(id);
        if (!rec) throw Object.assign(new Error("not found"), { code: "not_found" });
        if (rec.version !== base) throw Object.assign(new Error("version conflict"), { code: "version_conflict" });
        rec.deleted_at = this.now(); rec.version++;
        this.emit(`${type}.removed`, { id, type }, chain, rec.urn);
        return rec;
      },
      restore: async () => { throw new Error("not used"); },
    };

    this.ask = {
      request: async (/** @type {any} */ chain, /** @type {any} */ task, /** @type {any} */ opts) => {
        if (opts && opts.idem) { const had = this.tasks.find(t => t.idem === opts.idem); if (had) return had; }
        const waiting = (task.depends_on || []).some((/** @type {string} */ d) => { const x = this.tasks.find(y => y.id === d); return !x || !["done", "skipped"].includes(x.state); });
        const t = { id: uuid(), state: task.state || (waiting ? "waiting" : "ready"), created_at: this.now(), updated_at: this.now(), assigned_by: chain.hops[chain.hops.length - 1].actor, labels: chain.labels, idem: opts && opts.idem, ...task };
        this.tasks.push(t);
        this.emit("task.created", { id: t.id, title: t.title }, chain, `vyre://${this.space}/task/${t.id}`);
        return t;
      },
      // The real kernel's states (kernel/tasks/tasks.js), so tests see the same shape: a guarded task (a checker, or an outward send, or required) goes to needs_check when its doer completes it, and
      // only a decide moves it on: approved is done with outcome approved, rejected puts it back to ready with outcome rejected. An unguarded task is done when its doer completes it.
      start: async (/** @type {any} */ chain, /** @type {string} */ id) => this.#start(chain, id),
      complete: async (/** @type {any} */ chain, /** @type {string} */ id, /** @type {any} */ evidence) => this.#complete(chain, id, evidence),
      decide: async (/** @type {any} */ chain, /** @type {string} */ id, /** @type {any} */ a) => this.#decide(chain, id, a),
      get: async (/** @type {any} */ _c, /** @type {string} */ id) => this.tasks.find(t => t.id === id) || null,
    };

    this.model = {
      call: async (/** @type {any} */ input) => { this.calls.push(["model", input.purpose]); return { id: uuid(), provider: "fake", model: "fake", content: this.modelLabel }; },
    };

    this.events = {
      read: async (/** @type {any} */ _c, /** @type {any} */ f) => this.log.filter(e => (!f.since || e.seq > f.since) && (!f.type || f.type === "*" || f.type === e.type || (f.type.endsWith(".*") && e.type.startsWith(f.type.slice(0, -1))))).slice(0, f.limit || 1000),
      subscribe: (/** @type {any} */ _c, /** @type {string} */ _n, /** @type {any} */ _f, /** @type {Function} */ cb) => { this.subs.add(cb); return () => this.subs.delete(cb); },
      latestSeq: async () => this.seq,
    };
  }

  /** Subscribe to every event. @param {(e: any) => any} cb */
  onEvent(cb) { this.subs.add(cb); return () => this.subs.delete(cb); }
  async pump() { await new Promise(r => setImmediate(r)); }
  /** The chain a module (stages) works under: [the installing person, service:module]. @param {{ module: string, approver: any, tainted?: boolean }} o */
  moduleChain(o) { return { space: this.space, hops: [{ actor: o.approver, entered_by: "assignment" }, { actor: { kind: "service", id: o.module, space: this.space }, entered_by: "registry" }], labels: { trust: "member", red: "internal", source_spaces: [this.space] }, built_at: this.now() }; }
  /** Fake roles, set by tests. */
  setRole() {}
  addActor(/** @type {any} */ a) { return a; }
  async allTasks() { return this.tasks; }

  /** @param {string} type */
  #t(type) { let t = this.tables.get(type); if (!t) { t = new Map(); this.tables.set(type, t); } return t; }

  /** @param {any} rec @param {any} f @returns {boolean} */
  #match(rec, f) {
    if (f.and) return f.and.every((/** @type {any} */ x) => this.#match(rec, x));
    if (f.or) return f.or.some((/** @type {any} */ x) => this.#match(rec, x));
    if (f.not) return !this.#match(rec, f.not);
    const v = f.field === "id" ? rec.id : rec.data[f.field];
    switch (f.op) {
      case "eq": return JSON.stringify(v ?? null) === JSON.stringify(f.value ?? null);
      case "ne": return JSON.stringify(v ?? null) !== JSON.stringify(f.value ?? null);
      case "lt": return v < f.value; case "lte": return v <= f.value; case "gt": return v > f.value; case "gte": return v >= f.value;
      case "in": return f.value.includes(v);
      case "contains": return typeof v === "string" ? v.includes(f.value) : Array.isArray(v) && v.includes(f.value);
      case "is_null": return v === null || v === undefined;
      default: return false;
    }
  }

  /** Append an event to the log and tell subscribers. Events written under a Flow chain carry corr = the run id. @param {string} type @param {any} data @param {any} chain @param {string} [subject] @param {any} [more] */
  emit(type, data, chain, subject, more = {}) {
    const job = chain && chain.job;
    const e = { v: 1, id: uuid(), seq: ++this.seq, space: this.space, type, sv: 1, time: this.now(), received_at: this.now(), actor: chain ? chain.hops[chain.hops.length - 1].actor.kind + ":" + chain.hops[chain.hops.length - 1].actor.id : "service:test", chain: chain ? chain.hops : [], subject: subject || `vyre://${this.space}/event/${this.seq}`, corr: job && job.run, trust: (chain && chain.labels && chain.labels.trust) || "member", source_spaces: [this.space], vis: "space", red: "internal", data, ...more };
    this.log.push(e);
    for (const s of this.subs) void s(e);
    return e;
  }

  /** An external event, as the Ingress door would label it. @param {string} type @param {any} data @param {'system'|'member'|'external'|'untrusted'} [trust] */
  inbound(type, data, trust = "member") { return this.emit(type, data, { hops: [{ actor: { kind: "service", id: "ingress", space: this.space } }], labels: { trust, red: "internal", source_spaces: [this.space] } }); }

  #start(/** @type {any} */ chain, /** @type {string} */ id) { const t = this.tasks.find(x => x.id === id); if (!t || t.state !== "ready") throw Object.assign(new Error("not ready"), { code: "bad_state" }); return this.#move(id, "working", "task.started", chain); }
  #complete(/** @type {any} */ chain, /** @type {string} */ id, /** @type {any} */ evidence) { const t = this.tasks.find(x => x.id === id); if (!t) throw new Error("no task"); const guarded = Boolean(t.checker) || (t.output && t.output.kind === "sent") || Boolean(t.required); if (t.state !== "working") throw Object.assign(new Error("not started"), { code: "bad_state" }); t.evidence = evidence; return this.#move(id, guarded ? "needs_check" : "done", guarded ? "task.needs-check" : "task.completed", chain); }
  #decide(/** @type {any} */ chain, /** @type {string} */ id, /** @type {any} */ a) { const t = this.tasks.find(x => x.id === id); if (!t || t.state !== "needs_check") throw Object.assign(new Error("not waiting for a check"), { code: "bad_state" }); if (a.outcome === "rejected") { t.outcome = "rejected"; return this.#move(id, "ready", "task.rejected", chain); } t.outcome = "approved"; return this.#move(id, "done", "task.approved", chain); }

  /** One state change, with the event the real kernel writes (the task's new state rides in the data). */
  #move(/** @type {string} */ id, /** @type {string} */ state, /** @type {string} */ type, /** @type {any} */ chain) {
    const t = this.tasks.find(x => x.id === id);
    t.state = state; t.updated_at = this.now();
    this.emit(type, { id, task: id, state, ...(state === "done" && t.outcome ? { outcome: t.outcome } : {}), ...(state === "done" && t.answer !== undefined ? { answer: t.answer } : {}) }, chain && chain.hops ? chain : { hops: [{ actor: { kind: "service", id: "kernel", space: this.space } }], labels: { trust: "system", red: "internal", source_spaces: [this.space] } }, `vyre://${this.space}/task/${id}`);
    if (state === "done") for (const w of this.tasks) if (w.state === "waiting" && w.depends_on.every((/** @type {string} */ d) => ["done", "skipped"].includes(this.tasks.find(y => y.id === d).state))) { w.state = "ready"; this.emit("task.readied", { id: w.id, state: "ready" }, chain, `vyre://${this.space}/task/${w.id}`); }
    return t;
  }

  /** Finish a task as its checker or doer would: through the same states as the real kernel (start, complete, then decide when a checker is waiting). @param {string} id @param {{ outcome?: string, answer?: any, state?: string }} r */
  completeTask(id, r = {}) {
    const t = this.tasks.find(x => x.id === id);
    if (!t) throw new Error("no task");
    if (!r.state) {
      const sys = { hops: [{ actor: { kind: "service", id: "kernel", space: this.space } }], labels: { trust: "system", red: "internal", source_spaces: [this.space] } };
      if (t.state === "ready") this.#start(sys, id);
      if (t.state === "working") { const guarded = Boolean(t.checker) || (t.output && t.output.kind === "sent") || Boolean(t.required); if (!guarded) { t.outcome = r.outcome || "approved"; t.answer = r.answer; } this.#complete(sys, id, { answer: r.answer, outcome: r.outcome }); }
      if (t.state === "needs_check") this.#decide(sys, id, { outcome: r.outcome === "rejected" ? "rejected" : "approved" });
      return t;
    }
    t.state = r.state || "done"; t.outcome = r.outcome || "approved"; t.answer = r.answer; t.updated_at = this.now();
    const sys = { hops: [{ actor: { kind: "service", id: "kernel", space: this.space } }], labels: { trust: "system", red: "internal", source_spaces: [this.space] } };
    const ev = this.emit("task.completed", { id, task: id, state: t.state, outcome: t.outcome, answer: t.answer }, sys, `vyre://${this.space}/task/${id}`);
    for (const w of this.tasks) if (w.state === "waiting" && w.depends_on.every((/** @type {string} */ d) => ["done", "skipped"].includes(this.tasks.find(y => y.id === d).state))) { w.state = "ready"; this.emit("task.readied", { id: w.id, state: "ready" }, sys, `vyre://${this.space}/task/${w.id}`); }
    return ev;
  }

  /** The chain the runner would be given for a Flow run. @param {{ flow: string, approver: any, tainted: boolean, run?: string, space: string, source_spaces?: string[] }} o */
  chainFor(o) {
    return { space: o.space, hops: [{ actor: { kind: "automation", id: o.flow, space: o.space }, entered_by: "job" }, { actor: o.approver, entered_by: "assignment" }], labels: { trust: o.tainted ? "external" : "member", red: "internal", source_spaces: o.source_spaces || [o.space] }, built_at: this.now(), job: { run: o.run } };
  }
}
