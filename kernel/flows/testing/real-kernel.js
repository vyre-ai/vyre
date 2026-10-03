// The real kernel pieces (gateway over the memory store, tasks with approval, event log, chain builder, authorizer) assembled behind the
// surface FakeKernel exposes, so the same Flow and stage tests run on both. Nothing under kernel/ is edited: where the real gateway lacks
// what Flows need, the harness shims it, and every shim sits in a block marked SHIM(<gap>) so it can be deleted when platform lands it.
// The gaps are listed in team/0.2/CHAT.md ("sessions -> platform, 3 Oct").

import crypto from "node:crypto";
import { createGateway } from "../../gateway/index.js";
import { createMemoryStore } from "../../store/memory.js";
import { createEventLog } from "../../core/events.js";
import { createChainBuilder } from "../../core/chain.js";
import { createKernelSeal } from "../../core/seal.js";
import { canonical, hmac } from "../../core/canonical.js";
import { mintUuid } from "../../core/ids.js";
import { createTasks, TASK_ACTIONS } from "../../tasks/tasks.js";
import { parseExpr, evalExpr } from "../../../records/language/expr.js";
import { Presence } from "../../seal/proof.js";
import { payloadHash, proofBytes, chainCtx } from "../../seal/wire.js";

const KEY = Buffer.alloc(32, 7);
const sameActor = (a, b) => Boolean(a && b) && a.kind === b.kind && a.id === b.id;

/** Actions the harness registers on top of the gateway's and the tasks': what Flows call, with the risks the registry would give them. */
const FLOW_ACTIONS = [
  { action: "flows.run", resource_type: "flow", risk: "write", label: "run a Flow", gloss: "Run a Flow." },
  { action: "kits.install", resource_type: "kit", risk: "admin", label: "install a Kit", gloss: "Install a Kit." },
  { action: "kits.remove", resource_type: "kit", risk: "admin", label: "remove a Kit", gloss: "Remove a Kit." },
  { action: "ask.request", resource_type: "task", risk: "write", label: "ask someone", gloss: "Give a person or an assistant a task." },
  { action: "http.request", resource_type: "http", risk: "outward.send", label: "call a web address", gloss: "Call a web address." },
  { action: "fn.run", resource_type: "fn", risk: "write", label: "run a Code step", gloss: "Run a Code step." },
  { action: "model.call", resource_type: "space", risk: "read", label: "ask a model", gloss: "Send text to an AI model." },
];

export class RealKernel {
  /** @param {{ space?: string, now?: () => number, owner?: string, actions?: Record<string, { risk: string, label?: string }> }} [o] */
  constructor(o = {}) {
    this.space = o.space || "spc_harlow000001";
    this.now = o.now || (() => Date.now());
    this.owner = o.owner || "per_alex";
    this.clock = () => this.now();
    this.key = KEY;
    /** @type {any[]} */ this.calls = [];
    /** @type {any[]} */ this.defines = [];
    /** @type {any[]} */ this.grantRows = [];
    /** @type {any[]} */ this.authorizeCalls = [];
    /** @type {any[]} */ this.released = [];
    /** @type {{ match: (i: any) => boolean, effect: string, reason: string }[]} */ this.rules = [];
    this.denied = new Set();
    this.modelLabel = "normal";
    /** @type {Map<string, any>} */ this.idem = new Map();
    /** @type {Map<string, any>} */ this.gatewayGrants = new Map();
    /** @type {Set<string>} */ this.members = new Set();
    /** @type {Map<string, string>} person -> private key holder */ this.signers = new Map();
    // The one verifier is the sealing process's Presence class; wrapped the way the process's presence.check does (as kernel/tasks/tasks.test.js does).
    const pr = new Presence(this.clock, { allowUnattested: true });
    this.presenceKeys = pr;
    this.presence = { check: async (/** @type {any} */ { chain, op, fields, proof }) => (chain && proof ? pr.refuse(proof, { op, space: this.space, fields, ctx: chainCtx(chain) }) : "no_proof") };
    this.#stageTypes = new Map();
    /** @type {any} */ this.hooks = null;

    // SHIM(corr): events written under an automation chain carry corr = the chain's job. Wrapping the log is the only way in without editing core.
    const rawLog = createEventLog({ space: this.space, clock: this.clock });
    this.rawLog = rawLog;
    const self = this;
    this.logw = { ...rawLog, append(chain, ev, opts) { return rawLog.append(chain, ev.corr || !chain.job ? ev : { ...ev, corr: String(chain.job) }, opts); } };

    this.chains = createChainBuilder({ space: this.space, owner: this.owner, owner_uid: 501, key: KEY, clock: this.clock, is_person: p => self.members.has(`person:${p}`) });
    this.actions = [...TASK_ACTIONS, ...FLOW_ACTIONS, ...Object.entries({ "email.send": { risk: "outward.send", label: "Send an email" }, ...(o.actions || {}) }).map(([action, d]) => ({ action, resource_type: "external", risk: d.risk, label: d.label || action, gloss: d.label || action }))];
    this.grantActions = ["records.*", "records.define", "events.read", "tasks.request", "tasks.read", "tasks.work", "tasks.decide", "flows.run", "kits.install", "kits.remove", "model.call", "ask.request", "http.request", "fn.run", ...this.actions.filter(a => /^outward\./.test(a.risk)).map(a => a.action)];

    this.store = createMemoryStore({ clock: this.clock });
    this.gw = createGateway({
      space: this.space, owner: this.owner, store: this.store, log: this.logw, chains: this.chains, clock: this.clock, actions: this.actions,
      grants: { forSubject: a => [...this.gatewayGrants.values()].filter(g => sameActor(g.subject.actor, a)), get: id => this.gatewayGrants.get(id) },
      members: { has: a => this.members.has(`${a.kind}:${a.id}`) },
      hasPresenceSession: () => true, verifyPresence: () => true,
      // stage gates: the rule evaluator is records' expression language; the stage hooks are set by whoever runs the stages module
      expr: { parseExpr, evalExpr },
      onStageEnter: e => (this.hooks && this.hooks.onStageEnter ? this.hooks.onStageEnter(e) : undefined),
      stageTasks: (u, s) => (this.hooks && this.hooks.stageTasks ? this.hooks.stageTasks(u, s) : []),
    });
    this.tasksApi = createTasks({
      space: this.space, authorizer: { authorize: this.gw.authorize, actions: new Map(this.actions.map(a => [a.action, a])) }, log: this.logw, presence: this.presence, chains: this.chains, clock: this.clock,
      members: { has: a => this.members.has(`${a.kind}:${a.id}`) },
      roleHolders: role => this.roleHolders(role),
      approver: () => ({ kind: "person", id: this.owner, space: this.space }),
      responsible: () => true,
      facts: { record: async urn => this.#recordByUrn(urn), exists: async urn => typeof urn === "string" && urn.startsWith("vyre://") },
      release: async (task, body, by) => { this.released.push({ id: task.id, body, by }); },
    });
    this.addActor({ kind: "person", id: this.owner, space: this.space });
    /** @type {Record<string, any[]>} */ this.roles = {};

    this.authorize = async input => {
      this.authorizeCalls.push({ action: input.action, resource: input.resource, chain: input.chain });
      const rule = this.rules.find(r => r.match(input));
      if (rule) return { effect: rule.effect, reason: rule.reason, grants: [], obligations: [], decision: "dec_" + mintUuid(), policy_version: 1 };
      const approver = input.chain.hops[input.chain.hops.length - 1].actor;
      if (this.denied.has(approver.id)) return { effect: "deny", reason: "revoked", grants: [], obligations: [], decision: "dec_" + mintUuid(), policy_version: 1 };
      return this.gw.authorize(input);
    };

    const idemWrap = (/** @type {Function} */ fn) => async (/** @type {any[]} */ ...args) => {
      const opts = args[args.length - 1];
      const k = opts && typeof opts === "object" && !Array.isArray(opts) && "idem" in opts ? opts.idem : undefined;
      if (k && this.idem.has(k)) return this.idem.get(k);
      const r = await fn(...(k !== undefined ? args.slice(0, -1) : args));
      if (k) this.idem.set(k, r);
      return r;
    };
    const rec = this.gw.records;
    this.records = {
      define: async (chain, diff) => {
        this.defines.push(diff);
        // Defining types is an admin act: the kernel now wants exactly one person (the owner here), never a flow or module chain.
        const r = await rec.define(this.as(this.ownerActor()), diff);
        for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) if ((t.fields || []).some((/** @type {any} */ f) => f.kind === "stage")) this.#stageTypes.set(t.name, true);
        return r;
      },
      get: (c, t, id) => rec.get(c, t, id),
      query: (c, t, spec) => { this.calls.push(["query", t, spec.filter || null]); return rec.query(c, t, spec); },
      aggregate: (c, t, s) => rec.aggregate(c, t, s),
      search: (c, s) => rec.search(c, s),
      // SHIM(idem): the gateway has no idempotency key on records yet; dedupe here. SHIM(stage-entered): the gateway emits no record.stage-entered.
      create: idemWrap(async (c, t, d) => { const r = await rec.create(c, t, d); this.#stageEvent(c, r, undefined); return r; }),
      update: idemWrap(async (c, t, id, p, base) => { const before = await rec.get(c, t, id); const r = await rec.update(c, t, id, p, base); this.#stageEvent(c, r, before); return r; }),
      remove: idemWrap((c, t, id, base) => rec.remove(c, t, id, base)),
      restore: (c, t, id) => rec.restore(c, t, id),
    };
    this.ask = {
      // SHIM(ask-idem, ask-flow-form): ask.request takes no idem key and refuses the `flow` and `form` keys the runner sends; the harness drops them.
      request: idemWrap(async (chain, spec) => { const { flow: _f, form: _o, ...rest } = spec; return this.tasksApi.request(chain, rest); }),
      decide: (c, id, a) => this.tasksApi.decide(c, id, a),
      get: (c, id) => this.tasksApi.get(c, id),
      start: (c, id) => this.tasksApi.start(c, id),
      complete: (c, id, e) => this.tasksApi.complete(c, id, e),
      stuck: (c, id, i) => this.tasksApi.stuck(c, id, i),
      unblock: (c, id, o) => this.tasksApi.unblock(c, id, o),
      skip: (c, id, r) => this.tasksApi.skip(c, id, r),
      revise: (c, id, r) => this.tasksApi.revise(c, id, r),
      needsYou: c => this.tasksApi.needsYou(c),
    };
    this.grants = {
      create: async (_c, g) => { const row = { id: "gr_" + mintUuid(), status: "active", ...g }; this.grantRows.push(row); return row; },
      revoke: async (_c, id) => { const g = this.grantRows.find(x => x.id === id); if (g) g.status = "revoked"; return g; },
      list: async () => this.grantRows,
    };
    this.model = { call: async input => { this.calls.push(["model", input.purpose]); return { id: mintUuid(), provider: "fake", model: "fake", content: this.modelLabel }; } };
    const sysChain = () => this.chainFor({ flow: "events", approver: this.ownerActor(), tainted: false, space: this.space });
    this.events = {
      read: (c, f) => this.gw.events.read(c, f),
      subscribe: (c, name, f, cb) => this.gw.events.subscribe(c, name, f, cb),
      latestSeq: async () => rawLog.latestSeq(),
    };
    this.sysChain = sysChain;
  }

  /** @type {Map<string, boolean>} */ #stageTypes;

  ownerActor() { return { kind: "person", id: this.owner, space: this.space }; }

  /** Register an actor as a member of the space with a grant broad enough for the tests (outward actions named, wildcards for read and write). @param {{ kind: string, id: string, space?: string }} a */
  addActor(a) {
    const actor = { kind: a.kind, id: a.id, space: this.space };
    this.members.add(`${a.kind}:${a.id}`);
    const gid = `gr_${a.kind}_${a.id}`;
    if (!this.gatewayGrants.has(gid)) {
      this.gatewayGrants.set(gid, { id: gid, space: this.space, subject: { kind: "actor", actor }, actions: this.grantActions, action_set_version: 9, resource: { prefix: `vyre://${this.space}/*/*` }, conditions: {}, issuer: this.ownerActor(), source: "test", status: "active", created_at: 0 });
    }
    if (a.kind === "person" && !this.signers.has(a.id)) {
      const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      this.signers.set(a.id, kp.privateKey);
      this.presenceKeys.keys.set(`key-${a.id}`, { person: a.id, signer: "secure_enclave", attested: true, key: kp.publicKey });
    }
    return actor;
  }

  /** Who holds a role, for checker resolution. @param {string} role */
  roleHolders(role) { return this.roles[role] || []; }
  setRole(/** @type {string} */ role, /** @type {any[]} */ actors) { this.roles[role] = actors.map(a => this.addActor(a)); }

  /** The chain the runner is given for a Flow run: [automation, approver]. SHIM(chain-automation): the chain builder has no automation hop, so the harness seals one with the kernel key (the stored-job path). */
  chainFor(o) {
    const auto = this.addActor({ kind: "automation", id: o.flow });
    const ap = this.addActor(o.approver);
    return this.#sealed([{ actor: auto, entered_by: "job" }, { actor: ap, entered_by: "assignment" }], { trust: o.tainted ? "external" : "member", red: "internal", source_spaces: o.source_spaces || [this.space] }, o.run || "job");
  }

  /** A module's chain: [the person who installed it, service:module], so the tasks it assigns carry that person as the assigner. @param {{ module: string, approver: any, tainted?: boolean }} o */
  moduleChain(o) {
    const ap = this.addActor(o.approver), svc = this.addActor({ kind: "service", id: o.module });
    return this.#sealed([{ actor: ap, entered_by: "assignment" }, { actor: svc, entered_by: "registry" }], { trust: o.tainted ? "external" : "member", red: "internal", source_spaces: [this.space] }, `mod_${o.module}`);
  }

  #sealed(/** @type {any[]} */ hops, /** @type {any} */ labels, /** @type {string} */ job) {
    const body = canonical({ space: this.space, hops, labels, built_at: this.now(), job });
    // The stored form is sealed the way the chain builder seals it (kernel/core/seal.js), not with a bare HMAC of its own.
    return this.chains.restore({ job, body, mac: createKernelSeal({ key: KEY }).mac("chain-seal-v1", body) });
  }

  /** The chain an actor works under: a person on their device, an assistant under the owner. @param {any} actor */
  as(actor) {
    this.addActor(actor);
    if (actor.kind === "person") return this.chains.fromFacts({ kind: "device", device_key_id: `d-${actor.id}`, person: actor.id, path: "direct" });
    if (actor.kind === "agent") return this.chains.fromFacts({ kind: "agent_session", agent: actor.id, session: "s", thread: "t", vouched: true });
    return this.chains.appendService(undefined, actor.id, true);
  }

  /** An external event, as the Ingress door would label it. @param {string} type @param {any} data @param {'system'|'member'|'external'|'untrusted'} [trust] */
  inbound(type, data, trust = "member") {
    this.addActor({ kind: "service", id: "ingress" });
    const base = this.chains.appendService(undefined, "ingress", true);
    const chain = trust === "member" ? base : this.chains.weaken(base, { trust, red: "internal", source_spaces: [this.space] });
    return this.logw.append(chain, { type, sv: 1, subject: `vyre://${this.space}/event/${mintUuid(this.now())}`, data, red: "internal" });
  }

  /** Let the log deliver to its consumers. */
  async pump() { for (let i = 0; i < 4; i++) { await new Promise(r => setImmediate(r)); await this.rawLog.pump(); } }

  /** Subscribe a consumer to every event, in order. */
  onEvent(/** @type {(e: any) => any} */ cb, name = "test") { return this.rawLog.subscribe(name, {}, cb); }

  /** SHIM(stage-entered): after a create or an update, write record.stage-entered when the stage field is set or changed. */
  #stageEvent(/** @type {any} */ chain, /** @type {any} */ r, /** @type {any} */ before) {
    if (!this.#stageTypes.has(r.type)) return;
    const now = r.data && r.data.stage;
    if (!now || (before && before.data && before.data.stage === now)) return;
    this.logw.append(chain, { type: "record.stage-entered", sv: 1, subject: r.urn, data: { type: r.type, id: r.id, stage: now } });
  }

  async #recordByUrn(/** @type {string} */ urn) {
    const m = /^vyre:\/\/[^/]+\/([^/]+)\/([^/]+)$/.exec(urn || "");
    return m ? this.records.get(this.sysChain(), m[1], m[2]) : null;
  }

  /** Move a task along as its doer and (when it needs one) its checker would, with evidence made to fit the output kind. Real transitions, real presence proof. @param {string} id @param {{ outcome?: string, answer?: any, state?: string, evidence?: any }} [r] */
  async completeTask(id, r = {}) {
    let t = await this.tasksApi.get(this.sysChain(), id);
    if (!t) throw new Error("no task");
    const doer = this.as(t.doer);
    if (t.state === "ready") t = await this.tasksApi.start(doer, id);
    if (t.state === "working") {
      const e = r.evidence || this.#evidence(t, r);
      t = await this.tasksApi.complete(doer, id, e);
    }
    if (t.state === "needs_check") t = await this.approve(id, { outcome: r.outcome === "rejected" ? "rejected" : "approved" });
    await this.pump();
    return t;
  }

  #evidence(/** @type {any} */ t, /** @type {any} */ r) {
    const u = `vyre://${this.space}/file/${mintUuid()}`;
    switch (t.output.kind) {
      case "note": return { note: "done", sources: ["https://example.test/a"] };
      case "draft": return { draft: u };
      case "sent": return { payload: { what: t.title, recipients: [{ address: "jane@example.test", verified: false }] }, action: "email.send", resource: `vyre://${this.space}/message/${mintUuid()}` };
      case "decision": return { answer: r.answer === "no" ? "no" : "yes", reason: "because" };
      case "file": return { file: u };
      default: return {};
    }
  }

  /** A checker's approval with a real presence proof. @param {string} id @param {{ person?: any, outcome?: 'approved'|'rejected', reason?: string }} [o] */
  async approve(id, o = {}) {
    const t = await this.tasksApi.get(this.sysChain(), id);
    const holders = t.checker && t.checker.role ? this.roleHolders(t.checker.role) : [t.checker];
    const person = o.person || holders.find(a => a && a.kind === "person" && !sameActor(a, t.doer));
    const chain = this.as(person);
    const out = o.outcome || "approved";
    if (out === "rejected") return this.tasksApi.decide(chain, id, { outcome: "rejected", reason: o.reason || "not yet" });
    const now = this.now();
    const base = { signer: "secure_enclave", key_id: `key-${person.id}`, payload_hash: payloadHash("task.decide", this.space, { task: id, payload_hash: t.payload.payload_hash, decision: t.payload.decision }), decision: "task.decide", chain_hash: chainCtx(chain).chain_hash, issued_at: now, expires_at: now + 60_000, nonce: crypto.randomUUID() };
    const proof = { ...base, signature: crypto.sign("sha256", proofBytes(base), { key: this.signers.get(person.id), dsaEncoding: "ieee-p1363" }).toString("base64url") };
    return this.tasksApi.decide(chain, id, { outcome: "approved", proof });
  }

  /** Every task made so far, as the kernel holds them (what the Fake exposes as .tasks). */
  async allTasks() { const out = []; for (const e of this.rawLog.read({ type: "task.created" })) out.push(await this.tasksApi.get(this.sysChain(), e.subject.split("/").pop())); return out; }
}
