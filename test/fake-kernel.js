// @ts-check
// A small in-memory stand-in for the Kernel of kernel/contracts (gateway.d.ts), for the modules that sit on it: teammates, memory and
// @Engineer. It keeps the rules those modules lean on and nothing else: authority is the intersection of every hop's grants (invariant 2), a
// model-facing read never carries a sealed reference (5), every write makes one event with the chain (7), a task moves only along the contract's
// table and only a chain of exactly one person with a proof over the payload approves (4), and the inference door refuses a prompt holding a
// value the test sealed (6). The real kernel replaces it; a module that passes against this one passes against the contract.
//
// Tests only. Not imported by any runtime file.

import { TASK_TRANSITIONS, OUTWARD_RISKS, RISKS } from "../kernel/contracts/index.js";
import { joinLabels, memberLabels } from "../lib/labels.js";
import { isSealedValue, placeholderOf } from "../lib/sealed.js";

const CHAIN = Symbol.for("vyre.fake.chain");
let counter = 0;
/** A time-prefixed id, enough for ordering in a test. @param {string} [p] */
export const uid = (p = "") => `${p}${Date.now().toString(16).padStart(12, "0")}-${(++counter).toString(16).padStart(8, "0")}-4000-8000-000000000000`;

/** The actions the fake knows and their risk (the real registry is the kernel's). Unknown reads as outward.share (invariant 1). */
export const ACTIONS = Object.freeze({
  "record.read": "read", "record.write": "write", "record.define": "admin", "grant.create": "grant", "task.request": "write", "task.decide": "grant",
  "email.send": "outward.send", "model.use": "read", "event.read": "read", "memory.read": "read", "team.add": "admin", "engineer.talk": "admin",
});

/** @param {string} kind @param {string} id @param {string} space */
export const actor = (kind, id, space) => ({ kind: /** @type {any} */ (kind), id, space });

/**
 * A fake kernel for one Space.
 * @param {{ space?: string, now?: () => number }} [o]
 */
export function createFakeKernel({ space = "spc_test", now = () => Date.now() } = {}) {
  /** @type {Map<string, Map<string, any>>} */ const records = new Map();
  /** @type {Map<string, any>} */ const types = new Map();
  /** @type {any[]} */ const grants = [];
  /** @type {any[]} */ const events = [];
  /** @type {Map<string, any>} */ const tasks = new Map();
  /** @type {Set<string>} */ const sealedValues = new Set();
  /** @type {Set<string>} */ const admins = new Set();
  /** @type {{ consumer: string, filter: any, fn: (e: any) => any }[]} */ const subs = [];
  /** @type {any[]} */ const modelCalls = [];
  /** @type {(call: any) => any} */ let modelScript = () => ({ content: "" });
  const labelsOf = new Map();

  const person = (/** @type {string} */ id) => actor("person", id, space);
  const agent = (/** @type {string} */ id) => actor("agent", id, space);
  const service = (/** @type {string} */ id) => actor("service", id, space);

  /** A chain, built the way only the kernel does: tools never pass one in. @param {any[]} actors @param {any} [labels] */
  function chain(actors, labels = memberLabels(space)) {
    return Object.freeze({ [CHAIN]: true, space, hops: Object.freeze(actors.map(a => Object.freeze({ actor: a, entered_by: "surface" }))), labels, built_at: now() });
  }
  const key = (/** @type {any} */ a) => `${a.kind}:${a.id}`;
  const isChain = (/** @type {any} */ c) => Boolean(c && c[CHAIN]);

  function event(/** @type {any} */ c, type, subject, data, extra = {}) {
    const e = { v: 1, id: uid("e"), seq: events.length + 1, space, type, sv: 1, time: now(), received_at: now(), actor: key(c.hops.at(-1).actor), chain: c.hops, subject, trust: c.labels.trust, source_spaces: c.labels.source_spaces, vis: "space", red: c.labels.red, data, ...extra };
    events.push(e);
    for (const s of subs) if (match(s.filter, e)) Promise.resolve(s.fn(e)).catch(() => {});
    return e;
  }
  const match = (/** @type {any} */ f, /** @type {any} */ e) => (!f.type || f.type === "*" || f.type === e.type || (f.type.endsWith(".*") && e.type.startsWith(f.type.slice(0, -1)))) && (!f.subject_prefix || e.subject.startsWith(f.subject_prefix)) && (!f.since || e.seq > f.since);

  // ---- grants and authorize: the intersection of every hop (invariant 2) ----
  /** Give an actor a grant. @param {any} subject @param {string[]} actions @param {string} prefix @param {any} [conditions] */
  function grant(subject, actions, prefix = "vyre://", conditions = {}) {
    const g = { id: "gr_" + uid(), space, subject: { kind: "actor", actor: subject }, actions, action_set_version: 1, resource: { prefix }, conditions, issuer: person("root"), source: "test", status: "active", created_at: now() };
    grants.push(g);
    return g;
  }
  const covers = (/** @type {any} */ g, /** @type {string} */ action, /** @type {string} */ resource) =>
    g.status === "active" && g.actions.some((/** @type {string} */ a) => a === action || a === "*") && resource.startsWith(g.resource.prefix) && (!g.conditions?.when?.expires || g.conditions.when.expires > now());
  const holds = (/** @type {any} */ a, /** @type {string} */ action, /** @type {string} */ resource) => grants.find(g => g.subject.kind === "actor" && key(g.subject.actor) === key(a) && covers(g, action, resource));

  /** @param {{ chain: any, action: string, resource: string }} i */
  async function authorize({ chain: c, action, resource }) {
    const risk = /** @type {any} */ (ACTIONS)[action] || "outward.share";
    const used = [];
    for (const h of c.hops) {
      const g = holds(h.actor, action, resource);
      if (!g) return { effect: "deny", reason: "no_grant", grants: [], obligations: [], decision: "dec_" + uid(), policy_version: 1 };
      used.push(g.id);
    }
    const obligations = [];
    for (const g of used.map(id => grants.find(x => x.id === id))) {
      if (g.conditions?.how?.presence && g.conditions.how.presence !== "none") obligations.push({ type: "presence", method: g.conditions.how.presence });
      if (g.conditions?.how?.approval) obligations.push({ type: "ask", kind: risk, approver: g.conditions.how.approval.by, checker_must_be_person: true });
    }
    if (OUTWARD_RISKS.includes(risk) && !obligations.some(o => o.type === "ask")) obligations.push({ type: "ask", kind: risk, approver: "owner", checker_must_be_person: true });
    return { effect: obligations.some(o => o.type === "ask") ? "ask" : "allow", reason: "ok", grants: used, obligations, decision: "dec_" + uid(), policy_version: 1 };
  }
  async function need(/** @type {any} */ c, /** @type {string} */ action, /** @type {string} */ resource) {
    if (!isChain(c)) throw Object.assign(new Error("a chain is built by the kernel"), { code: "bad_input" });
    const r = await authorize({ chain: c, action, resource });
    if (r.effect === "deny") throw Object.assign(new Error("not found"), { code: "not_found", hidden_reason: r.reason });
    return r;
  }

  // ---- records ----
  const urn = (/** @type {string} */ type, /** @type {string} */ id) => `vyre://${space}/${type}/${id}`;
  const table = (/** @type {string} */ type) => { if (!records.has(type)) records.set(type, new Map()); return /** @type {Map<string, any>} */ (records.get(type)); };
  const agentChain = (/** @type {any} */ c) => c.hops.some((/** @type {any} */ h) => h.actor.kind === "agent" || h.actor.kind === "service");
  /** A record as the caller may see it: an agent or service hop in the chain gets placeholders, never the reference. */
  function shape(/** @type {any} */ c, /** @type {any} */ rec) {
    const data = {};
    for (const [k, v] of Object.entries(rec.data)) data[k] = isSealedValue(v) && agentChain(c) ? placeholderOf(v) : v;
    return { ...rec, data, urn: urn(rec.type, rec.id), labels: labelsOf.get(rec.id) || memberLabels(space) };
  }
  const records_api = {
    async define(/** @type {any} */ c, /** @type {any} */ diff) {
      await need(c, "record.define", `vyre://${space}/def`);
      for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) types.set(t.name, t);
      for (const n of diff.remove_types || []) types.delete(n);
      event(c, "definition.changed", `vyre://${space}/def`, { diff });
      return { applied: true, changes: [...(diff.add_types || []).map((/** @type {any} */ t) => `added ${t.name}`), ...(diff.change_types || []).map((/** @type {any} */ t) => `changed ${t.name}`)] };
    },
    async get(/** @type {any} */ c, /** @type {string} */ type, /** @type {string} */ id) {
      await need(c, "record.read", urn(type, id));
      const r = table(type).get(id);
      return r && !r.deleted_at ? shape(c, r) : null;
    },
    async query(/** @type {any} */ c, /** @type {string} */ type, /** @type {any} */ spec) {
      const rows = [];
      for (const r of table(type).values()) {
        if (r.deleted_at && !spec.include_deleted) continue;
        if ((await authorize({ chain: c, action: "record.read", resource: urn(type, r.id) })).effect === "deny") continue;
        if (spec.filter && !filterOk(spec.filter, r.data)) continue;
        rows.push(shape(c, r));
      }
      return { rows: rows.slice(0, spec.page?.limit || 100), total_visible: rows.length };
    },
    async aggregate() { return []; },
    async search(/** @type {any} */ c, /** @type {any} */ spec) {
      const hits = [];
      const q = String(spec.text || "").toLowerCase();
      for (const [type, tab] of records) for (const r of tab.values()) {
        if (r.deleted_at || (spec.types && !spec.types.includes(type))) continue;
        if ((await authorize({ chain: c, action: "record.read", resource: urn(type, r.id) })).effect === "deny") continue;
        const text = Object.values(r.data).filter(v => typeof v === "string").join(" ").toLowerCase();
        if (q && text.includes(q)) hits.push({ type, id: r.id, score: 1, snippet: text.slice(0, 80) });
      }
      return { rows: hits };
    },
    async create(/** @type {any} */ c, /** @type {string} */ type, /** @type {any} */ data) {
      const id = uid("r");
      await need(c, "record.write", urn(type, id));
      const rec = { type, id, version: 1, data: { ...data }, created_at: now(), updated_at: now() };
      table(type).set(id, rec);
      labelsOf.set(id, c.labels);
      event(c, "record.created", urn(type, id), { after: data, changed: Object.keys(data) });
      return shape(c, rec);
    },
    async update(/** @type {any} */ c, /** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ patch, /** @type {number} */ base) {
      await need(c, "record.write", urn(type, id));
      const rec = table(type).get(id);
      if (!rec) throw Object.assign(new Error("not found"), { code: "not_found" });
      if (rec.version !== base) throw Object.assign(new Error("version conflict"), { code: "version_conflict" });
      const before = { ...rec.data };
      Object.assign(rec.data, patch);
      rec.version++; rec.updated_at = now();
      labelsOf.set(id, joinLabels([labelsOf.get(id), c.labels]));
      event(c, "record.updated", urn(type, id), { before, after: patch, changed: Object.keys(patch) });
      return shape(c, rec);
    },
    async remove(/** @type {any} */ c, /** @type {string} */ type, /** @type {string} */ id) {
      await need(c, "record.write", urn(type, id));
      const rec = table(type).get(id); rec.deleted_at = now(); rec.version++;
      event(c, "record.removed", urn(type, id), { changed: [] });
      return shape(c, rec);
    },
    async restore(/** @type {any} */ c, /** @type {string} */ type, /** @type {string} */ id) {
      await need(c, "record.write", urn(type, id));
      const rec = table(type).get(id); delete rec.deleted_at; rec.version++;
      return shape(c, rec);
    },
  };
  function filterOk(/** @type {any} */ f, /** @type {any} */ data) {
    if (f.and) return f.and.every((/** @type {any} */ x) => filterOk(x, data));
    if (f.or) return f.or.some((/** @type {any} */ x) => filterOk(x, data));
    if (f.not) return !filterOk(f.not, data);
    const v = data[f.field];
    if (f.op === "eq") return JSON.stringify(v) === JSON.stringify(f.value);
    if (f.op === "ne") return JSON.stringify(v) !== JSON.stringify(f.value);
    if (f.op === "is_null") return v == null;
    if (f.op === "contains") return typeof v === "string" && v.includes(String(f.value));
    if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
    return false;
  }

  // ---- grants api: a delegate is contained in its parent; the parent's presence and approval conditions become the delegate's ----
  const grants_api = {
    async create(/** @type {any} */ c, /** @type {any} */ input) {
      await need(c, "grant.create", `vyre://${space}/grant`);
      const issuer = c.hops.at(-1).actor;
      if (input.parent) {
        const p = grants.find(g => g.id === input.parent);
        if (!p || p.status !== "active") throw Object.assign(new Error("parent grant"), { code: "not_contained" });
        const ok = input.actions.every((/** @type {string} */ a) => p.actions.includes(a) || p.actions.includes("*")) && input.resource.prefix.startsWith(p.resource.prefix) &&
          (!p.conditions?.when?.expires || (input.conditions?.when?.expires && input.conditions.when.expires <= p.conditions.when.expires));
        if (!ok) throw Object.assign(new Error("a delegated grant must be contained in its parent"), { code: "not_contained" });
        input = { ...input, conditions: { ...input.conditions, how: { ...(p.conditions?.how || {}), ...(input.conditions?.how || {}) } } };
      }
      const g = { id: "gr_" + uid(), space, ...input, action_set_version: 1, issuer, status: "active", created_at: now() };
      grants.push(g);
      event(c, "grant.created", `vyre://${space}/grant/${g.id}`, { grant: g.id });
      return g;
    },
    async revoke(/** @type {any} */ c, /** @type {string} */ id, /** @type {string} */ reason) {
      const g = grants.find(x => x.id === id); g.status = "revoked"; g.reason = reason; g.revoked_at = now();
      for (const child of grants.filter(x => x.parent === id)) { child.status = "revoked"; child.revoked_at = now(); }
      event(c, "grant.revoked", `vyre://${space}/grant/${id}`, { reason });
      return g;
    },
    async list(/** @type {any} */ c, /** @type {any} */ filter = {}) {
      return grants.filter(g => (!filter.status || g.status === filter.status) && (!filter.subject || (g.subject.kind === "actor" && key(g.subject.actor) === key(filter.subject.actor))));
    },
  };

  // ---- tasks: the contract's table; only the kernel moves the guarded states ----
  const guardedTask = (/** @type {any} */ t) => Boolean(t.checker) || ["sent"].includes(t.output?.kind) || t.required === true;
  const ask = {
    async request(/** @type {any} */ c, /** @type {any} */ t) {
      await need(c, "task.request", `vyre://${space}/task`);
      const output = t.output || { kind: "decision" };
      if (output.kind === "sent" && !t.checker) t = { ...t, checker: person("owner") };
      const task = { id: uid("t"), space, ...t, output, state: t.state || (t.depends_on?.length ? "waiting" : "ready"), assigned_by: c.hops[0].actor, labels: c.labels, created_at: now(), updated_at: now() };
      tasks.set(task.id, task);
      event(c, "task.created", `vyre://${space}/task/${task.id}`, { title: task.title, doer: key(task.doer), source: task.source });
      return task;
    },
    async decide(/** @type {any} */ c, /** @type {string} */ id, /** @type {any} */ approval) {
      const t = tasks.get(id);
      if (!t || t.state !== "needs_check") throw Object.assign(new Error("not waiting for a check"), { code: "bad_input" });
      if (c.hops.length !== 1 || c.hops[0].actor.kind !== "person") throw Object.assign(new Error("approval is a person's, alone"), { code: "chain_not_person" });
      if (!approval.proof || approval.proof.payload_hash !== taskPayloadHash(t)) throw Object.assign(new Error("the proof does not sign this payload"), { code: "needs_presence" });
      if (key(t.doer) === key(c.hops[0].actor)) throw Object.assign(new Error("the doer cannot check their own task"), { code: "chain_not_person" });
      t.state = approval.outcome === "approved" ? "done" : "ready";
      t.outcome = approval.outcome; t.updated_at = now();
      event(c, "task.decided", `vyre://${space}/task/${id}`, { outcome: approval.outcome });
      return t;
    },
  };
  /** What the fake's approval binds: the title, output and draft. The real one binds the canonical outbound payload (R6-3). @param {any} t */
  const taskPayloadHash = t => JSON.stringify([t.id, t.title, t.output, t.draft_hash || null]);
  /** The kernel's moves of a task (contract 9.4 transitions): the module asks, the kernel checks the table. Fake-only names, proposed to platform. */
  const task_moves = {
    async move(/** @type {any} */ c, /** @type {string} */ id, /** @type {string} */ to, /** @type {any} */ info = {}) {
      const t = tasks.get(id);
      const rule = TASK_TRANSITIONS.find(r => r.from === t.state && r.to === to && (r.guarded === undefined || r.guarded === guardedTask(t)));
      if (!rule) throw Object.assign(new Error(`${t.state} to ${to} is not a move`), { code: "bad_input" });
      if (rule.by === "assistant_or_detection" && !c.hops.some((/** @type {any} */ h) => h.actor.kind === "agent" || h.actor.kind === "service")) throw Object.assign(new Error("only an assistant or detection"), { code: "bad_input" });
      if (rule.by === "proposal_for_person_with_presence" && !(info.presence_by && c.hops.length === 1 && c.hops[0].actor.kind === "person")) throw Object.assign(new Error("a guarded skip is a proposal for a person with presence"), { code: "bad_input" });
      if (rule.by === "kernel_after_output_check" && !info.output_checked) throw Object.assign(new Error("the output check has not passed"), { code: "bad_input" });
      t.state = to; t.updated_at = now();
      if (to === "stuck") t.stuck = info.stuck;
      if (to !== "stuck") delete t.stuck;
      event(c, `task.${to === "stuck" ? "stuck" : "moved"}`, `vyre://${space}/task/${id}`, { to, stuck: info.stuck });
      return t;
    },
  };

  // ---- events ----
  const events_api = {
    async read(/** @type {any} */ c, /** @type {any} */ filter) { return events.filter(e => match(filter, e)).slice(0, filter.limit || 1000); },
    subscribe(/** @type {any} */ c, /** @type {string} */ consumer, /** @type {any} */ filter, /** @type {any} */ fn) { const s = { consumer, filter, fn }; subs.push(s); return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); }; },
    async latestSeq() { return events.length; },
  };

  // ---- the inference door: placeholders in, and a prompt holding a sealed value is refused (invariant 6) ----
  const model = {
    async call(/** @type {any} */ input) {
      const text = input.messages.map((/** @type {any} */ m) => m.content).join("\n");
      for (const v of sealedValues) if (text.includes(v)) throw Object.assign(new Error("ledger hit"), { code: "ledger_hit", class: "free" });
      modelCalls.push(input);
      const r = await modelScript(input);
      return { id: uid("m"), provider: input.provider || "fake", model: input.model || "fake", content: "", ...r };
    },
  };

  const kernel = {
    authorize, records: records_api, grants: grants_api, ask, model, events: events_api,
    seal: { async put() { throw new Error("not in the fake"); }, async use() { throw new Error("not in the fake"); }, async reveal() { throw new Error("not in the fake"); } },
    audit: { async verify() { return { ok: true, events: events.length, open_intents: 0 }; } },
    async health() { return { ok: true, versions: { fake: "1" } }; },
    /** Extensions the contract does not have yet; the modules treat them as a port (see docs/work/assistant.md, Needs). */
    tasks: task_moves,
    /** Is this chain's person an admin of the Space (role.admin or owner)? The real kernel answers from memberships. */
    members: { isAdmin: (/** @type {any} */ c) => c.hops.length >= 1 && c.hops[0].actor.kind === "person" && admins.has(c.hops[0].actor.id) },
  };

  return {
    kernel, space, chain, person, agent, service, grant, events, tasks, records, types, grants, modelCalls, taskPayloadHash,
    /** A value the sealing process holds: the inference door refuses any prompt that contains it. */
    sealValue: (/** @type {string} */ v) => sealedValues.add(v),
    makeAdmin: (/** @type {string} */ personId) => admins.add(personId),
    /** What the model answers: a function of the call (a test's script). @param {(call: any) => any} fn */
    script: fn => { modelScript = fn; },
    /** Put a record straight into the store, bypassing authorize (test setup). */
    seed(/** @type {string} */ type, /** @type {any} */ data, labels = memberLabels(space)) {
      const id = uid("r");
      table(type).set(id, { type, id, version: 1, data: { ...data }, created_at: now(), updated_at: now() });
      labelsOf.set(id, labels);
      return { id, urn: urn(type, id) };
    },
    urn,
    RISKS,
  };
}
