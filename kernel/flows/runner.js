// @ts-check
// The Flow runner (contract 9). Vyre's own, not Twenty's: every step goes through the gateway as the approver's narrowed chain.
//
//   Authority      a run has the chain [automation:<flow>, approver]. Every effect step is first checked against the Flow's declared caps, then
//                  `authorize` is asked as that chain. `ask` raises a card and waits; `deny` for a lost grant pauses the Flow and says why.
//   At-least-once  a run is the same run however often its trigger is delivered (id = hash of flow and trigger key). Each step is recorded in the
//                  run's ledger before and after it acts, keyed by (run, step, loop index), and every effect carries that key as an idempotency
//                  key. A resumed run replays from the top: finished steps give back their recorded output and do nothing.
//   Deterministic  a condition's branch, a loop's list and a wait's deadline are recorded the first time and reused on replay.
//   Taint          a run triggered by or reading `external` or `untrusted` content is tainted: its outward and grant steps need an Ask naming the source.
//   Loop control   depth of the `corr` chain (default 8), a per-Flow rate limit, a step cap per run. A runaway pauses the Flow and raises a card.
//   Versioned      a run is pinned to the version it started on.

import { parse, evaluate, truthy, roots } from "./expr.js";
import { compileFlow, deriveCaps, needs as flowNeeds, urnCovers, nextCron, STEP_ACTIONS } from "./compile.js";
import { BLOCK_KINDS, LIMITS as SCHEMA_LIMITS } from "./schema.js";
import { runIdFor, newId } from "./store.js";
import { taskIdOf } from "./stages.js";

export const LIMITS = Object.freeze({ depth: 8, rate_per_minute: 60, steps_per_run: 500, scan: 2000, wait_max_ms: 366 * 86_400_000 });
/** Denials that mean the approver can no longer do this: the Flow pauses and says why. */
const PAUSE_REASONS = new Set(["revoked", "not_a_member", "expired", "no_grant", "wrong_space"]);
const OUTWARD = new Set(["outward.send", "outward.pay", "outward.publish", "outward.delete", "outward.share"]);

class Suspend extends Error { constructor() { super("suspended"); this.name = "Suspend"; } }
class StepFail extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "StepFail"; this.code = code; }
}
class PauseFlow extends Error {
  /** @param {string} reason */
  constructor(reason) { super(reason); this.name = "PauseFlow"; this.reason = reason; }
}

/**
 * @typedef {import('./store.js').Run} Run
 * @typedef {{ kind: string, id: string, space?: string }} ActorRef
 * @typedef {{
 *   kernel: any,
 *   store: any,
 *   catalog: () => Promise<import('./compile.js').Catalog> | import('./compile.js').Catalog,
 *   chains: { forFlow: (o: { flow: string, space: string, approver: ActorRef, tainted: boolean, run: string, source_spaces: string[] }) => any },
 *   clock?: () => number,
 *   emit?: (type: string, data: any, o: { chain: any, subject: string, corr: string }) => void,
 *   ports?: {
 *     call?: (chain: any, action: string, resource: string, input: any, o: { idem: string }) => Promise<any>,
 *     service?: (q: { chain: any, connector: string, request: { method: string, path: string, query?: any, headers?: any, body?: any, upload?: { drive: { path: string, version?: string, contentType?: string } }, saveTo?: string }, idem: string, approval?: string }) => Promise<{ status: number, ok?: boolean, headers?: Record<string, string>, body?: string } | { saved: { path: string, version: string|number, size: number, sha256: string } } | { held: boolean, kind?: string, summary?: string }>,
 *     sandbox?: (req: { language: string, source: string, hash: string, inputs: any, outputs: string[], needs: string[] }) => Promise<{ outputs: Record<string, any> }>,
 *     roles?: (space: string, role: string) => Promise<ActorRef[]> | ActorRef[],
 *     model?: { provider: string, model: string },
 *   },
 *   limits?: Partial<typeof LIMITS>,
 * }} RunnerOptions
 */

export class FlowRunner {
  /** @param {RunnerOptions} o */
  constructor(o) {
    this.k = o.kernel; this.store = o.store; this.catalogFn = o.catalog; this.chains = o.chains;
    this.now = o.clock || (() => Date.now());
    this.emitFn = o.emit || (() => {});
    this.ports = o.ports || {};
    this.limits = { ...LIMITS, ...(o.limits || {}) };
    /** @type {Map<string, Promise<any>>} */ this.locks = new Map();
    /** @type {Map<string, number[]>} */ this.rate = new Map();
    /** @type {Map<string, number>} */ this.lastFire = new Map();
    /** @type {{ at: number, flows: any[] } | null} */ this.cache = null;
    /** @type {Set<Promise<any>>} */ this.inflight = new Set();
  }

  // ------------------------------------------------------------------ definitions

  /** Compile and store a new version. Nothing runs until a person approves it. @param {string|null} id @param {any} flow @param {ActorRef} by */
  async define(id, flow, by) {
    const cat = await this.catalogFn();
    const compiled = compileFlow(flow, cat);
    if (!compiled.ok) return { ok: false, errors: compiled.errors, warnings: compiled.warnings, effects: compiled.effects };
    const put = await this.store.putVersion(id, flow, by, this.now(), cat.space);
    return { ok: true, id: put.id, version: put.version, hash: put.hash, same: put.same, warnings: compiled.warnings, effects: compiled.effects, caps: compiled.caps };
  }

  /**
   * Approve a version as `approver`. The card the person saw is built from the stored canonical form (what will run), and `hash` is what they approved:
   * an approval for any other content is refused. Approving makes this version the active one.
   * @param {string} id @param {number} version @param {ActorRef} approver @param {string} hash
   */
  async approve(id, version, approver, hash) {
    const v = await this.store.getVersion(id, version);
    if (!v) throw Object.assign(new Error("no such Flow version"), { code: "not_found" });
    const cat = await this.catalogFn();
    const compiled = compileFlow(v.flow, cat);
    if (!compiled.ok) throw Object.assign(new Error("that version no longer compiles: " + compiled.errors[0].message), { code: "invalid" });
    const row = await this.store.approve(id, version, approver, hash, this.now());
    this.cache = null;
    return row;
  }

  async #activeFlows() {
    if (this.cache && this.now() - this.cache.at < 30_000) return this.cache.flows;
    const flows = await this.store.activeFlows();
    this.cache = { at: this.now(), flows };
    return flows;
  }

  /** @param {string} id @param {string} reason */
  async pauseFlow(id, reason) { await this.store.pause(id, reason, this.now()); this.cache = null; }
  /** @param {string} id */
  async resumeFlow(id) { await this.store.resume(id); this.cache = null; }

  // ------------------------------------------------------------------ triggers

  /** An event from the log. Starts runs for matching Flows and resumes runs waiting on it. @param {any} env */
  async onEvent(env) {
    const work = [];
    for (const f of await this.#activeFlows()) {
      if (!triggerScope(f.flow.trigger, env)) continue;
      work.push(this.#start(f, { kind: f.flow.trigger.on, key: String(env.id), event: env }, env));
    }
    work.push(this.#deliver(env));
    return Promise.all(work);
  }

  /** Time: start due time-triggered Flows once each, and wake runs whose wait has ended. Call from one timer set to nextWake(). */
  async tick() {
    const now = this.now();
    const work = [];
    for (const f of await this.#activeFlows()) {
      const t = f.flow.trigger;
      if (t.on !== "time") continue;
      if (!this.lastFire.has(f.id) && t.at === undefined) this.lastFire.set(f.id, now);
      const last = this.lastFire.get(f.id) ?? now;
      let due = null;
      if (t.cron !== undefined) { const n = nextCron(t.cron, last); if (n !== null && n <= now) due = n; }
      else if (t.every_ms !== undefined) { if (last + t.every_ms <= now) due = last + t.every_ms; }
      else if (t.at !== undefined) { if (t.at <= now && !(await this.store.getRun(runIdFor(f.id, `${f.id}@${t.at}`)))) due = t.at; }
      if (due === null) continue;
      this.lastFire.set(f.id, t.cron !== undefined || t.every_ms !== undefined ? now : due);
      work.push(this.#start(f, { kind: "time", key: `${f.id}@${due}`, at: due }, null));
    }
    for (const r of await this.store.listRuns({ state: "waiting", limit: 1000 })) {
      const w = r.waiting;
      if (!w) continue;
      const dl = w.kind === "time" ? w.wake_at : w.deadline;
      if (dl !== undefined && dl <= now) work.push(this.#resume(r.id, { timeout: true }));
    }
    return Promise.all(work);
  }

  /** The earliest time anything needs waking, so the host sets one timer and never polls. @returns {Promise<number|null>} */
  async nextWake() {
    let best = null;
    const take = (/** @type {number|null|undefined} */ n) => { if (n !== null && n !== undefined && (best === null || n < best)) best = n; };
    for (const f of await this.#activeFlows()) {
      const t = f.flow.trigger;
      if (t.on !== "time") continue;
      if (t.cron !== undefined) take(nextCron(t.cron, this.lastFire.get(f.id) ?? this.now()));
      else if (t.every_ms !== undefined) take((this.lastFire.get(f.id) ?? this.now()) + t.every_ms);
      else if (t.at !== undefined && t.at > this.now()) take(t.at);
    }
    for (const r of await this.store.listRuns({ state: "waiting", limit: 1000 })) if (r.waiting) take(r.waiting.kind === "time" ? r.waiting.wake_at : r.waiting.deadline);
    return best;
  }

  /**
   * An inbound web call. The host (the Ingress door) has already authenticated it and labelled its trust; the body is data and the run is tainted
   * unless the host says `member`. `key` makes a retried delivery the same run.
   * @param {string} path @param {{ body?: any, key?: string, trust?: 'member'|'external'|'untrusted' }} [req]
   */
  async handleWeb(path, req = {}) {
    const f = (await this.#activeFlows()).find(x => x.flow.trigger.on === "web" && x.flow.trigger.path === path);
    if (!f) throw Object.assign(new Error("no Flow answers that address"), { code: "not_found" });
    const trust = req.trust || "untrusted";
    return this.#start(f, { kind: "web", key: req.key || newId("web_"), input: req.body ?? {}, path }, { trust, data: req.body ?? {} });
  }

  /**
   * A manual run. `callerChain` is the person's own chain: they need the `flows.run` action on the Flow, and the run itself still has the approver's authority.
   * @param {string} id @param {any} input @param {any} callerChain @param {string} [key]
   */
  async start(id, input, callerChain, key) {
    const f = await this.store.active(id);
    if (!f) throw Object.assign(new Error("that Flow is not running (it is paused, disabled or has no approved version)"), { code: "not_active" });
    const d = await this.k.authorize({ chain: callerChain, action: "flows.run", resource: `vyre://${f.space}/flow/${id}` });
    if (d.effect !== "allow") throw Object.assign(new Error("you may not run that Flow"), { code: d.reason === "no_grant" ? "not_found" : d.reason });
    return this.#start(f, { kind: "manual", key: key || newId("man_"), input: input ?? {} }, { trust: "member", data: input ?? {} });
  }

  /** Wait for every started run to reach a resting state. For tests and for shutdown. */
  async drain() { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  /** Pick up after a restart: re-run what was mid-flight, and apply task results that arrived while we were down. */
  async recover() {
    for (const r of await this.store.listRuns({ state: "running", limit: 1000 })) await this.#exec(r.id);
    const waiting = await this.store.listRuns({ state: "waiting", limit: 1000 });
    if (waiting.some(r => r.waiting && r.waiting.kind === "task")) {
      const chain = this.chains.forFlow({ flow: "system", space: waiting[0].space, approver: waiting[0].approver, tainted: false, run: "recover", source_spaces: [waiting[0].space] });
      const evs = await this.k.events.read(chain, { type: "task.*", limit: 5000 });
      for (const e of evs) await this.#deliver(e);
    }
  }

  // ------------------------------------------------------------------ starting a run

  /** @param {any} f @param {{ kind: string, key: string, event?: any, input?: any, path?: string, at?: number }} trig @param {any} src where the data came from (an event envelope, or { trust, data }) */
  async #start(f, trig, src) {
    const id = runIdFor(f.id, trig.key);
    return this.#locked(id, () => this.#startLocked(id, f, trig, src));
  }

  /** @param {string} id @param {any} f @param {any} trig @param {any} src */
  async #startLocked(id, f, trig, src) {
    if (await this.store.getRun(id)) return { run: id, duplicate: true };
    const now = this.now();
    // depth of the cause chain: an event written under a run carries that run's id as corr
    let depth = 0;
    const corr = src && src.corr;
    if (typeof corr === "string" && corr.startsWith("run_")) { const parent = await this.store.getRun(corr); depth = (parent ? parent.depth : this.limits.depth) + 1; }
    if (depth > this.limits.depth) { await this.#runaway(f, `it was started by its own work ${depth} times in a chain (the limit is ${this.limits.depth})`); return { run: null, refused: "depth" }; }
    const stamps = (this.rate.get(f.id) || []).filter(t => now - t < 60_000);
    if (stamps.length >= this.limits.rate_per_minute) { await this.#runaway(f, `it started more than ${this.limits.rate_per_minute} times in a minute`); return { run: null, refused: "rate" }; }
    stamps.push(now); this.rate.set(f.id, stamps);
    const trust = src && (src.trust || (src.data !== undefined ? "member" : undefined));
    const sourceSpaces = (src && src.source_spaces) || [f.space];
    const tainted = trust === "external" || trust === "untrusted" || sourceSpaces.length > 1;
    /** @type {Run} */
    const run = { id, flow: f.id, version: f.version, hash: f.hash, space: f.space, trigger: { kind: trig.kind, key: trig.key, ...(trig.event ? { event: slim(trig.event) } : {}), ...(trig.input !== undefined ? { input: trig.input } : {}), ...(trig.path ? { path: trig.path } : {}), ...(trig.at !== undefined ? { at: trig.at } : {}) },
      tainted, source_spaces: sourceSpaces, depth, state: "running", started_at: now, updated_at: now, steps: {}, approver: f.approver };
    await this.store.putRun(run);
    this.#emit("flow.started", { run: id, flow: f.id, version: f.version, trigger: trig.kind, tainted }, run, `vyre://${f.space}/flow_run/${id}`);
    await this.#execLocked(id);
    return { run: id };
  }

  /** @param {any} f @param {string} reason */
  async #runaway(f, reason) {
    await this.pauseFlow(f.id, reason);
    const chain = this.chains.forFlow({ flow: f.id, space: f.space, approver: f.approver, tainted: false, run: "runaway", source_spaces: [f.space] });
    await this.k.ask.request(chain, { title: `${f.flow.label || f.flow.name} was paused: ${reason}`, doer: f.approver, output: { kind: "decision" }, source: "flow_step", form: { kind: "flow_paused", flow: f.id } }, { idem: `runaway:${f.id}:${reason}` });
  }

  // ------------------------------------------------------------------ resuming

  /** @param {any} env a task or other event that may release a waiting run */
  async #deliver(env) {
    const work = [];
    for (const r of await this.store.listRuns({ state: "waiting", limit: 1000 })) {
      const w = r.waiting;
      if (!w) continue;
      if (w.kind === "task" && /^task\./.test(env.type) && env.data && taskIdOf(env) === w.task && ["done", "skipped"].includes(env.data.state)) work.push(this.#resume(r.id, { task: env.data }));
      else if (w.kind === "event" && w.event && typeMatches(w.event, env.type)) {
        if (w.where) { try { if (!truthy(evaluate(parse(w.where), { event: env, trigger: r.trigger.event ? r.trigger.event.data : r.trigger.input ?? {}, steps: outputs(r) }))) continue; } catch { continue; } }
        work.push(this.#resume(r.id, { event: slim(env) }));
      }
    }
    return Promise.all(work);
  }

  /** @param {string} runId @param {{ task?: any, event?: any, timeout?: boolean }} result */
  async #resume(runId, result) {
    return this.#locked(runId, async () => {
      const run = await this.store.getRun(runId);
      if (!run || run.state !== "waiting" || !run.waiting) return;
      const led = run.steps[run.waiting.step];
      if (!led || led.status !== "waiting") return;
      led.wait = { ...(led.wait || {}), result };
      run.state = "running"; run.waiting = undefined; run.updated_at = this.now();
      await this.store.putRun(run);
      await this.#execLocked(runId);
    });
  }

  /** Put a paused or failed run back to work after its cause was fixed; finished steps are not repeated. @param {string} runId */
  async retry(runId) {
    return this.#locked(runId, async () => {
      const run = await this.store.getRun(runId);
      if (!run || (run.state !== "paused" && run.state !== "failed")) return;
      run.state = "running"; run.error = undefined; run.finished_at = undefined; run.updated_at = this.now();
      await this.store.putRun(run);
      await this.#execLocked(runId);
    });
  }

  // ------------------------------------------------------------------ executing

  /** @param {string} id @param {() => Promise<any>} fn */
  #locked(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tracked = next.catch(() => {}).finally(() => { if (this.locks.get(id) === tracked) this.locks.delete(id); this.inflight.delete(tracked); });
    this.locks.set(id, tracked);
    this.inflight.add(tracked);
    return next;
  }
  /** @param {string} id */
  #exec(id) { return this.#locked(id, () => this.#execLocked(id)); }

  /** @param {string} runId */
  async #execLocked(runId) {
    const run = await this.store.getRun(runId);
    if (!run || run.state !== "running") return;
    const view = await this.store.getVersion(run.flow, run.version);
    if (!view) { run.state = "failed"; run.error = { step: "", code: "gone", message: "the Flow version this run started on no longer exists" }; await this.#finish(run); return; }
    const cat = await this.catalogFn();
    const caps = Array.isArray(view.flow.caps) ? view.flow.caps : deriveCaps(view.flow, cat);
    const ctx = { run, flow: view.flow, view, cat, caps, dry: false, count: 0, runnerPaused: false };
    try {
      await this.#walk(ctx, view.flow.steps, "", {});
      run.state = "done"; run.error = undefined;
      await this.#finish(run);
    } catch (e) {
      if (e instanceof Suspend) { run.state = "waiting"; run.updated_at = this.now(); await this.store.putRun(run); return; }
      if (e instanceof PauseFlow) {
        run.state = "paused"; run.error = { step: run.error ? run.error.step : "", code: "paused", message: e.reason }; run.updated_at = this.now();
        await this.store.putRun(run);
        await this.pauseFlow(run.flow, e.reason);
        this.#emit("flow.paused", { run: run.id, flow: run.flow, reason: e.reason }, run, `vyre://${run.space}/flow_run/${run.id}`);
        return;
      }
      const code = e instanceof StepFail ? e.code : "error";
      const message = e instanceof Error ? e.message : String(e);
      run.state = "failed"; run.error = { step: run.error && run.error.step || "", code, message };
      await this.#finish(run);
    }
  }

  /** @param {Run} run */
  async #finish(run) {
    run.finished_at = this.now(); run.updated_at = run.finished_at; run.waiting = undefined;
    await this.store.putRun(run);
    this.#emit("flow.finished", { run: run.id, flow: run.flow, state: run.state, ...(run.error ? { error: run.error } : {}) }, run, `vyre://${run.space}/flow_run/${run.id}`);
  }

  /** @param {string} type @param {any} data @param {Run} run @param {string} subject */
  #emit(type, data, run, subject) {
    if (run.dry) return;
    try { this.emitFn(type, data, { chain: this.chains.forFlow({ flow: run.flow, space: run.space, approver: run.approver, tainted: run.tainted, run: run.id, source_spaces: run.source_spaces }), subject, corr: run.id }); } catch { /* an observer must never break a run */ }
  }

  /**
   * Walk a list of steps. `suffix` is the loop index path ("" at top level, "@2" in a loop's third turn) that keeps each turn's ledger entries apart.
   * @param {any} ctx @param {any[]} steps @param {string} suffix @param {Record<string, any>} locals
   */
  async #walk(ctx, steps, suffix, locals) {
    for (const s of steps) {
      if (++ctx.count > this.limits.steps_per_run) throw new StepFail("too_many_steps", `the run took more than ${this.limits.steps_per_run} steps`);
      await this.#step(ctx, s, s.id + suffix, suffix, locals);
    }
  }

  /** @param {any} ctx @param {string} key */
  #led(ctx, key) { return ctx.run.steps[key]; }

  /** @param {any} ctx */
  #scope(ctx, locals) {
    const run = ctx.run, t = run.trigger;
    const trigger = t.event ? (t.event.data ?? {}) : t.input !== undefined ? t.input : t.at !== undefined ? { at: t.at } : {};
    return { trigger, event: t.event || null, steps: outputs(run), run: { id: run.id, depth: run.depth, tainted: run.tainted, flow: run.flow }, now: this.now(), ...locals };
  }

  /** @param {any} ctx @param {string} key @param {Partial<import('./store.js').Run['steps'][string]>} patch */
  async #mark(ctx, key, patch) {
    const run = ctx.run;
    run.steps[key] = { ...(run.steps[key] || {}), at: this.now(), ...patch };
    run.updated_at = this.now();
    if (!ctx.dry) await this.store.putRun(run);
  }

  /** @param {any} ctx @param {any} s @param {string} key @param {string} suffix @param {Record<string, any>} locals */
  async #step(ctx, s, key, suffix, locals) {
    const run = ctx.run;
    const led = this.#led(ctx, key);
    if (led && (led.status === "done" || led.status === "skipped") && !(s.kind in BLOCK_KINDS)) return;
    run.error = { step: s.id, code: "", message: "" }; // names the step in flight; cleared by a clean finish
    const scope = () => this.#scope(ctx, locals);
    const ev = (/** @type {string} */ src) => evaluate(parse(src), scope());
    const val = (/** @type {any} */ v) => resolveValue(v, scope());

    if (s.kind === "decide") {
      let branch = led && led.output && led.output.branch;
      if (!branch) { branch = truthy(ev(s.if)) ? "then" : "else"; await this.#mark(ctx, key, { status: "started", output: { branch } }); }
      await this.#walk(ctx, s[branch] || [], suffix, locals);
      await this.#mark(ctx, key, { status: "done", output: { branch } });
      return;
    }
    if (s.kind === "repeat") {
      let items = led && led.output && led.output.items;
      if (!items) {
        const list = ev(s.over);
        items = Array.isArray(list) ? list.slice(0, Math.min(s.max || SCHEMA_LIMITS.repeatMax, SCHEMA_LIMITS.repeatMax)) : [];
        await this.#mark(ctx, key, { status: "started", output: { items } });
      }
      for (let i = 0; i < items.length; i++) await this.#walk(ctx, s.steps || [], `${suffix}@${i}`, { ...locals, [s.as]: items[i], [`${s.as}_index`]: i });
      await this.#mark(ctx, key, { status: "done", output: { count: items.length } });
      return;
    }

    /** @type {any} */ let out;
    switch (s.kind) {
      case "find": case "pick": case "filter": out = await this.#read(ctx, s, key, scope()); break;
      case "create": case "update": case "upsert": case "remove": case "stage": out = await this.#write(ctx, s, key, scope(), val); break;
      case "wait": out = await this.#wait(ctx, s, key, val); break;
      case "ask": case "assign": case "agent": out = await this.#task(ctx, s, key, scope(), val); break;
      case "call": out = await this.#effect(ctx, s, key, { action: s.action, resource: s.resource }, async idem => {
        if (ctx.dry) return { dry: true };
        if (!this.ports.call) throw new StepFail("unavailable", "this Space has no way to run actions yet");
        return this.ports.call(this.#chain(ctx), s.action, s.resource, val(s.input), { idem });
      }, { input: val(s.input) }); break;
      case "classify": out = await this.#classify(ctx, s, key, val); break;
      case "service": out = await this.#service(ctx, s, key, val); break;
      case "fn": out = await this.#fn(ctx, s, key, val); break;
      default: throw new StepFail("bad_step", `unknown step kind ${s.kind}`);
    }
    await this.#mark(ctx, key, { status: "done", output: out });
    this.#emit("step.done", { run: run.id, step: key, kind: s.kind }, run, `vyre://${run.space}/flow_run/${run.id}`);
  }

  /** @param {any} ctx */
  #chain(ctx) {
    const r = ctx.run;
    return this.chains.forFlow({ flow: r.flow, space: r.space, approver: r.approver, tainted: r.tainted, run: r.id, source_spaces: r.source_spaces });
  }

  // ------------------------------------------------------------------ authority

  /**
   * Check the caps, ask the kernel, and handle ask and deny. Runs `act(idem)` only when the step may go ahead. The ledger records "started" before
   * the act and the caller records "done" after, so a crash in between replays the act with the same idempotency key.
   * @param {any} ctx @param {any} s @param {string} key @param {{ action: string, resource: string }} need
   * @param {(idem: string, approval?: string) => Promise<any>} act @param {{ input?: any, input_class?: string }} [info]
   */
  async #effect(ctx, s, key, need, act, info = {}) {
    const run = ctx.run;
    if (!ctx.caps.some((/** @type {any} */ c) => (c.action === need.action || c.action === "*.*") && urnCovers(c.resource, need.resource))) throw new StepFail("outside_caps", `step ${s.id} is outside the Flow's declared powers (${need.action})`);
    const risk = (ctx.cat.actions[need.action] || {}).risk || (need.action === "service.call" ? "outward.send" : need.action === "service.read" ? "read" : "write");
    const chain = this.#chain(ctx);
    const askKey = key + "?ask";
    const asked = run.steps[askKey];
    if (asked && asked.status === "waiting") {
      const res = asked.wait && asked.wait.result;
      if (!res) throw this.#suspendOn(ctx, askKey, asked.wait);
      if (res.timeout) throw new StepFail("timed_out", "nobody answered the question");
      const approved = res.task && res.task.outcome === "approved";
      await this.#mark(ctx, askKey, { status: approved ? "done" : "failed", output: { outcome: res.task && res.task.outcome } });
      if (!approved) throw new StepFail("refused", `a person said no to step ${s.id}`);
    }
    const approvedTask = run.steps[askKey] && run.steps[askKey].status === "done" ? run.steps[askKey].task : undefined;
    const d = await this.k.authorize({ chain, action: need.action, resource: need.resource, ...(info.input_class ? { input_class: info.input_class } : {}), ...(approvedTask ? { approval: approvedTask } : {}) });
    let effect = d.effect;
    const forced = !approvedTask && effect === "allow" && ((run.tainted && (OUTWARD.has(risk) || risk === "grant")) || (ctx.flow.authorship === "model" && ctx.view && (flowUsesComputedOutward(ctx) && OUTWARD.has(risk))));
    if (forced) effect = "ask";
    if (effect === "deny") {
      this.#note(ctx, s, `denied: ${d.reason}`);
      if (PAUSE_REASONS.has(d.reason)) throw new PauseFlow(`${nameOf(run.approver)} can no longer ${labelOf(ctx.cat, need.action)} (${d.reason.replace(/_/g, " ")}); the Flow is paused until that is fixed`);
      throw new StepFail(d.reason || "denied", `not allowed: ${d.reason}`);
    }
    if (effect === "ask" && !approvedTask) {
      if (ctx.dry) { ctx.dryAsks = (ctx.dryAsks || 0) + 1; }
      else {
        const why = forced ? (run.tainted ? "it started from content outside this Space" : "a model drafted this Flow") : "it needs a person's yes";
        const task = await this.k.ask.request(chain, { title: `${ctx.view.flow.label || ctx.view.flow.name}: ${labelOf(ctx.cat, need.action)}?`, doer: run.approver, output: { kind: "decision" }, source: "flow_step",
          form: { kind: "held_act", flow: run.flow, run: run.id, step: s.id, action: need.action, resource: need.resource, why, trigger_source: run.trigger.kind, input: info.input ?? null } }, { idem: `${run.id}:${askKey}` });
        await this.#mark(ctx, askKey, { status: "waiting", task: task.id, wait: { kind: "task", task: task.id } });
        run.waiting = { step: askKey, kind: "task", task: task.id };
        this.#emit("step.waiting", { run: run.id, step: key, task: task.id, why }, run, `vyre://${run.space}/flow_run/${run.id}`);
        throw new Suspend();
      }
    }
    if (!ctx.dry) await this.#mark(ctx, key, { status: "started" });
    if (ctx.dry) ctx.dryEffects = [...(ctx.dryEffects || []), { step: s.id, action: need.action, resource: need.resource, risk, effect }];
    return act(`${run.id}:${key}`, approvedTask);
  }

  /** @param {any} ctx @param {any} s @param {string} text */
  #note(ctx, s, text) { ctx.run.error = { step: s.id, code: "note", message: text }; }

  // ------------------------------------------------------------------ outside services

  /**
   * Call a service: the Flow names a connector (a vault credential and its route) and a request; the vault at the home makes the call. The credential is never seen here. A read (GET or
   * HEAD) runs at once; anything else is outward and held for the ask-first task by `#effect`, then runs once with that approval. A file goes by Drive reference, never as bytes. The
   * response is data from outside: the run is tainted, headers that carry credentials are dropped, and the stored body is capped.
   * @param {any} ctx @param {any} s @param {string} key @param {(v: any) => any} val
   */
  async #service(ctx, s, key, val) {
    const need = needOf(s, ctx.cat);
    const request = {
      method: s.method, path: s.path,
      ...(s.query === undefined ? {} : { query: val(s.query) }),
      ...(s.headers === undefined ? {} : { headers: val(s.headers) }),
      ...(s.body === undefined ? {} : { body: val(s.body) }),
      ...(s.drive && s.drive.upload ? { upload: { drive: { path: s.drive.upload.path, ...(s.drive.upload.version ? { version: s.drive.upload.version } : {}), ...(s.drive.upload.contentType ? { contentType: s.drive.upload.contentType } : {}) } } } : {}),
      ...(s.drive && s.drive.saveTo ? { saveTo: s.drive.saveTo } : {}),
    };
    const files = [...(request.upload ? [{ way: "send", path: request.upload.drive.path }] : []), ...(request.saveTo ? [{ way: "save", path: request.saveTo }] : [])];
    return this.#effect(ctx, s, key, need, async (idem, approval) => {
      if (ctx.dry) return { dry: true, response: { status: 0 } };
      if (!this.ports.service) throw new StepFail("unavailable", "this Space has no connectors yet");
      const r = /** @type {any} */ (await this.ports.service({ chain: this.#chain(ctx), connector: s.connector, request, idem, ...(approval ? { approval } : {}) }));
      if (r && r.held) throw new StepFail("held", `the vault is holding the call to ${s.connector} for a person's yes${r.summary ? ` (${String(r.summary).slice(0, 120)})` : ""}`);
      ctx.run.tainted = true; // what came back is content from outside
      if (r && r.saved) return { saved: { path: String(r.saved.path), version: r.saved.version, size: r.saved.size, sha256: r.saved.sha256 } };
      const headers = Object.fromEntries(Object.entries((r && r.headers) || {}).filter(([k]) => !/^(set-cookie|authorization|proxy-authenticate|www-authenticate|x-api-key)$/i.test(k)).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const raw = r && typeof r.body === "string" ? Buffer.from(r.body, "base64").toString("utf8") : "";
      const text = raw.length > SERVICE_BODY_CAP ? raw.slice(0, SERVICE_BODY_CAP) : raw;
      let json = null;
      if (/json/i.test(headers["content-type"] || "") && raw.length <= SERVICE_BODY_CAP) { try { json = JSON.parse(raw); } catch { json = null; } }
      return { response: { status: Number(r && r.status) || 0, ok: Boolean(r && (r.ok ?? (r.status >= 200 && r.status < 300))), headers, body: text, json, truncated: raw.length > SERVICE_BODY_CAP }, ...(files.length ? { files } : {}) };
    }, { input: request.body === undefined ? null : request.body });
  }

  // ------------------------------------------------------------------ record steps

  /** @param {any} ctx @param {any} s @param {string} key @param {any} scope */
  async #read(ctx, s, key, scope) {
    if (s.kind === "filter") {
      const list = evaluate(parse(s.from), scope);
      const w = parse(s.where);
      const rows = (Array.isArray(list) ? list : []).filter(r => truthy(evaluate(w, { ...scope, record: r && r.data ? { ...r.data, id: r.id } : r })));
      return { rows, count: rows.length };
    }
    const need = { action: "records.read", resource: `vyre://${ctx.cat.space}/${s.type}/*` };
    return this.#effect(ctx, s, key, need, async () => {
      const where = s.where ? parse(s.where) : null;
      const pushed = where ? toFilter(where, scope) : null;
      const limit = s.kind === "pick" ? 1 : (s.limit || 100);
      const rows = [];
      let cursor;
      let scanned = 0;
      do {
        const page = await this.k.records.query(this.#chain(ctx), s.type, { ...(pushed ? { filter: pushed } : {}), ...(s.sort ? { sort: s.sort } : {}), page: { limit: Math.min(200, this.limits.scan - scanned), ...(cursor ? { cursor } : {}) } });
        for (const r of page.rows) {
          scanned++;
          if (r.labels && (r.labels.trust === "external" || r.labels.trust === "untrusted")) ctx.run.tainted = true;
          if (where && !truthy(evaluate(where, { ...scope, record: { ...r.data, id: r.id } }))) continue;
          rows.push(plain(r));
          if (rows.length >= limit) break;
        }
        cursor = page.next_cursor;
      } while (cursor && rows.length < limit && scanned < this.limits.scan);
      return s.kind === "pick" ? { record: rows[0] || null, found: rows.length > 0 } : { rows, count: rows.length };
    });
  }

  /** @param {any} ctx @param {any} s @param {string} key @param {any} scope @param {(v: any) => any} val */
  async #write(ctx, s, key, scope, val) {
    const typeDef = ctx.cat.types[s.type];
    const stageField = typeDef && (typeDef.fields || []).find((/** @type {any} */ f) => f.kind === "stage");
    const action = STEP_ACTIONS[/** @type {keyof typeof STEP_ACTIONS} */ (s.kind)];
    const need = { action, resource: `vyre://${ctx.cat.space}/${s.type}/*` };
    return this.#effect(ctx, s, key, need, async idem => {
      const chain = this.#chain(ctx);
      const kernelOpts = { idem };
      if (ctx.dry) return { record: { id: "sim_" + key, type: s.type, data: s.set ? val(s.set) : {} }, dry: true };
      if (s.kind === "create") { const r = await this.k.records.create(chain, s.type, val(s.set), kernelOpts); return { record: plain(r) }; }
      if (s.kind === "upsert") {
        const match = val(s.match);
        const found = await this.k.records.query(chain, s.type, { filter: { and: Object.entries(match).map(([field, value]) => ({ field, op: "eq", value })) }, page: { limit: 1 } });
        if (found.rows[0]) { const r = await this.k.records.update(chain, s.type, found.rows[0].id, val(s.set), found.rows[0].version, kernelOpts); return { record: plain(r), created: false }; }
        const r = await this.k.records.create(chain, s.type, { ...match, ...val(s.set) }, kernelOpts);
        return { record: plain(r), created: true };
      }
      const id = recordId(val(s.record));
      if (!id) throw new StepFail("bad_input", `step ${s.id}: no record to act on`);
      const cur = await this.k.records.get(chain, s.type, id);
      if (!cur) throw new StepFail("not_found", `step ${s.id}: that record is gone`);
      if (cur.labels && (cur.labels.trust === "external" || cur.labels.trust === "untrusted")) ctx.run.tainted = true;
      if (s.kind === "remove") { const r = await this.k.records.remove(chain, s.type, id, cur.version, kernelOpts); return { record: plain(r), removed: true }; }
      const patch = s.kind === "stage" ? { [stageField ? stageField.name : "stage"]: s.to } : val(s.set);
      try { const r = await this.k.records.update(chain, s.type, id, patch, cur.version, kernelOpts); return { record: plain(r) }; }
      catch (e) {
        if (!(e && /** @type {any} */ (e).code === "version_conflict")) throw e;
        const again = await this.k.records.get(chain, s.type, id);
        if (!again) throw e;
        const r = await this.k.records.update(chain, s.type, id, patch, again.version, kernelOpts);
        return { record: plain(r), retried: true };
      }
    }, { input: s.set ? val(s.set) : undefined });
  }

  // ------------------------------------------------------------------ waiting, tasks, models, code

  /** @param {any} ctx @param {any} s @param {string} key @param {(v: any) => any} val */
  async #wait(ctx, s, key, val) {
    const led = this.#led(ctx, key);
    const now = this.now();
    if (led && led.status === "waiting") {
      const res = led.wait && led.wait.result;
      if (!res) {
        if (led.wait && led.wait.until !== undefined && led.wait.until <= now) return { waited_ms: now - led.at };
        throw this.#suspendOn(ctx, key, led.wait);
      }
      if (res.timeout && led.wait.kind === "time") return { waited_ms: now - led.at };
      if (res.timeout) { if (s.event !== undefined && s.on_timeout === "fail") throw new StepFail("timed_out", `step ${s.id} timed out waiting for ${s.event}`); return { timed_out: true, waited_ms: now - led.at }; }
      return { event: res.event || null, waited_ms: now - led.at };
    }
    if (ctx.dry) return { dry: true };
    /** @type {any} */ let wait;
    if (s.for_ms !== undefined) wait = { kind: "time", until: now + Math.min(s.for_ms, this.limits.wait_max_ms) };
    else if (s.until !== undefined) { const t = toMs(val(s.until)); if (t === null) throw new StepFail("bad_input", `step ${s.id}: until is not a time`); wait = { kind: "time", until: Math.min(t, now + this.limits.wait_max_ms) }; }
    else wait = { kind: "event", event: s.event, where: s.where, deadline: now + Math.min(s.timeout_ms, this.limits.wait_max_ms) };
    if (wait.kind === "time" && wait.until <= now) return { waited_ms: 0 };
    await this.#mark(ctx, key, { status: "waiting", wait });
    this.#emit("step.waiting", { run: ctx.run.id, step: key, until: wait.until ?? wait.deadline }, ctx.run, `vyre://${ctx.run.space}/flow_run/${ctx.run.id}`);
    throw this.#suspendOn(ctx, key, wait);
  }

  /** @param {any} ctx @param {string} key @param {any} wait */
  #suspendOn(ctx, key, wait) {
    ctx.run.waiting = wait.kind === "time" ? { step: key, kind: "time", wake_at: wait.until } : wait.kind === "task" ? { step: key, kind: "task", task: wait.task, ...(wait.deadline ? { deadline: wait.deadline } : {}) } : { step: key, kind: "event", event: wait.event, where: wait.where, deadline: wait.deadline };
    return new Suspend();
  }

  /** ask, assign and agent all make a task. @param {any} ctx @param {any} s @param {string} key @param {any} scope @param {(v: any) => any} val */
  async #task(ctx, s, key, scope, val) {
    const run = ctx.run;
    const led = this.#led(ctx, key);
    const awaiting = s.kind === "ask" ? true : s.kind === "agent" ? s.await !== false : s.await === true;
    if (led && led.status === "waiting") {
      const res = led.wait && led.wait.result;
      if (!res) throw this.#suspendOn(ctx, key, led.wait);
      if (res.timeout) throw new StepFail("timed_out", `nobody finished step ${s.id}`);
      const t = res.task || {};
      return { task: led.task, state: t.state, outcome: t.outcome ?? null, answer: t.answer ?? null, output: t.output ?? null };
    }
    const who = s.kind === "agent" ? s.assistant : s.to;
    const need = { action: "ask.request", resource: `vyre://${ctx.cat.space}/task/*` };
    return this.#effect(ctx, s, key, need, async idem => {
      if (ctx.dry) { ctx.dryTasks = [...(ctx.dryTasks || []), { step: s.id, to: who, kind: s.kind }]; return { dry: true, task: "sim_" + key }; }
      const { doer, helpers } = await this.#actor(ctx, who);
      const title = String(val(s.title) ?? "");
      const record = s.record !== undefined ? urnOf(ctx, val(s.record), s.type) : undefined;
      const spec = s.kind === "ask"
        ? { title, doer, ...(helpers.length ? { helpers } : {}), output: { kind: "decision" }, source: "flow_step", ...(record ? { record } : {}), ...(s.form ? { form: s.form } : {}) }
        : { title, doer, ...(helpers.length ? { helpers } : {}), output: s.output, how: s.kind === "agent" ? "assistant" : s.how, ...(s.template ? { template: s.template } : {}), ...(s.checker ? { checker: await this.#checker(ctx, s.checker) } : {}), source: "flow_step", ...(record ? { record } : {}), ...(s.kind === "agent" ? { form: { instructions: String(val(s.instructions) ?? "") } } : {}) };
      const task = await this.k.ask.request(this.#chain(ctx), { ...spec, flow: { run: run.id, step: s.id } }, { idem });
      if (!awaiting) return { task: task.id };
      await this.#mark(ctx, key, { status: "waiting", task: task.id, wait: { kind: "task", task: task.id } });
      this.#emit("step.waiting", { run: run.id, step: key, task: task.id }, run, `vyre://${run.space}/flow_run/${run.id}`);
      throw this.#suspendOn(ctx, key, { kind: "task", task: task.id });
    }, { input: s.kind === "agent" ? val(s.instructions) : val(s.title) });
  }

  /** @param {any} ctx @param {string} ref @returns {Promise<{ doer: ActorRef, helpers: ActorRef[] }>} */
  async #actor(ctx, ref) {
    const space = ctx.run.space;
    const [kind, ...rest] = String(ref).split(":");
    const name = rest.join(":");
    if (kind === "person") return { doer: { kind: "person", id: name, space }, helpers: [] };
    if (kind === "teammate") return { doer: { kind: "agent", id: name, space }, helpers: [] };
    const holders = this.ports.roles ? await this.ports.roles(space, name) : [];
    const people = holders.filter(h => h.kind === "person");
    if (!people.length) throw new StepFail("nobody", `nobody holds the role ${name} in this Space, so there is no one to ask`);
    return { doer: people[0], helpers: people.slice(1) };
  }

  /** A checker is a person or a role; a role stays a role for the kernel to expand to humans. @param {any} ctx @param {string} ref */
  async #checker(ctx, ref) {
    const [kind, ...rest] = ref.split(":");
    return kind === "person" ? { kind: "person", id: rest.join(":"), space: ctx.run.space } : { role: rest.join(":") };
  }

  /** @param {any} ctx @param {any} s @param {string} key @param {(v: any) => any} val */
  async #classify(ctx, s, key, val) {
    const need = { action: "model.call", resource: `vyre://${ctx.cat.space}/model/*` };
    return this.#effect(ctx, s, key, need, async () => {
      if (ctx.dry) return { dry: true, label: null };
      const m = this.ports.model || { provider: "default", model: "default" };
      const r = await this.k.model.call({ chain: this.#chain(ctx), purpose: "classify", provider: m.provider, model: m.model,
        messages: [{ role: "system", content: `Answer with exactly one of: ${s.labels.join(", ")}. Nothing else.` }, { role: "user", content: String(val(s.input) ?? "") }] });
      const label = String(r.content || "").trim();
      return { label: s.labels.includes(label) ? label : null, raw_ok: s.labels.includes(label) };
    }, { input_class: "text" });
  }

  /** @param {any} ctx @param {any} s @param {string} key @param {(v: any) => any} val */
  async #fn(ctx, s, key, val) {
    return this.#effect(ctx, s, key, { action: "fn.run", resource: `vyre://${ctx.cat.space}/fn/*` }, async () => {
      if (ctx.dry) return { dry: true };
      if (!this.ports.sandbox) throw new StepFail("unavailable", "this Space has no code sandbox yet");
      const inputs = val(s.inputs);
      const r = await this.ports.sandbox({ language: s.language, source: s.source, hash: s.hash, inputs, outputs: s.outputs, needs: s.needs || [] });
      const out = {};
      for (const name of s.outputs) out[name] = Object.hasOwn(r.outputs || {}, name) ? r.outputs[name] : null;
      for (const k of Object.keys(r.outputs || {})) if (!s.outputs.includes(k)) throw new StepFail("bad_output", `step ${s.id} returned ${k}, which it did not declare`);
      return out;
    });
  }

  // ------------------------------------------------------------------ simulation

  /**
   * Replay a window of past events against a Flow with its actions stubbed, and say what it would have done: how many runs, how many approvals it
   * would have asked for, what it would have written, sent and run. Reads are real (as the approver, read-only), so a `find` sees today's data;
   * writes, tasks, calls, http, code and models are stubbed; waits do not wait. Nothing is stored and nothing is emitted.
   * @param {any} flow a stored Flow (a draft or an active one)
   * @param {{ approver: ActorRef, events?: any[], since?: number, until?: number, limit?: number, samples?: any[] }} o
   */
  async simulate(flow, o) {
    const cat = await this.catalogFn();
    const compiled = compileFlow(flow, cat);
    if (!compiled.ok) return { ok: false, errors: compiled.errors, warnings: compiled.warnings };
    const caps = Array.isArray(flow.caps) ? flow.caps : deriveCaps(flow, cat);
    const limit = o.limit || 1000;
    /** @type {{ trigger: string, key: string, scope: any, env: any, at: number }[]} */
    const hits = [];
    let seen = 0;
    const t = flow.trigger;
    if (t.on === "event" || t.on === "stage") {
      let evs = o.events;
      if (!evs) {
        const chain = this.chains.forFlow({ flow: "simulation", space: cat.space, approver: o.approver, tainted: false, run: "sim", source_spaces: [cat.space] });
        evs = await this.k.events.read(chain, { type: "*", limit: 20_000 });
      }
      for (const env of evs) {
        if (o.since && env.received_at !== undefined && env.received_at < o.since) continue;
        if (o.until && env.received_at !== undefined && env.received_at > o.until) continue;
        seen++;
        const scope = triggerScope(t, env);
        if (scope && hits.length < limit) hits.push({ trigger: t.on, key: String(env.id), scope, env, at: env.received_at ?? env.time });
      }
    } else if (t.on === "time" && t.cron !== undefined && o.since !== undefined && o.until !== undefined) {
      for (let at = nextCron(t.cron, o.since - 1); at !== null && at <= o.until && hits.length < limit; at = nextCron(t.cron, at)) hits.push({ trigger: "time", key: `sim@${at}`, scope: { trigger: { at } }, env: null, at });
    } else if (t.on === "time" && t.every_ms !== undefined && o.since !== undefined && o.until !== undefined) {
      for (let at = o.since + t.every_ms; at <= o.until && hits.length < limit; at += t.every_ms) hits.push({ trigger: "time", key: `sim@${at}`, scope: { trigger: { at } }, env: null, at });
    } else for (const [i, sample] of (o.samples || []).entries()) hits.push({ trigger: t.on, key: `sample${i}`, scope: { trigger: sample }, env: null, at: this.now() });

    const runs = [];
    /** @type {Record<string, number>} */ const writes = {};
    /** @type {Record<string, { action: string, risk: string, count: number }>} */ const outward = {};
    let asks = 0, tasks = 0, completed = 0, paused = 0, failed = 0;
    for (const h of hits) {
      /** @type {Run} */
      const run = { id: "sim_" + h.key, flow: "simulation", version: 0, hash: "", space: cat.space, trigger: { kind: h.trigger, key: h.key, ...(h.env ? { event: slim(h.env) } : { input: h.scope.trigger }) },
        tainted: Boolean(h.env && (h.env.trust === "external" || h.env.trust === "untrusted")), source_spaces: (h.env && h.env.source_spaces) || [cat.space], depth: 0, state: "running", started_at: h.at, updated_at: h.at, steps: {}, approver: o.approver, dry: true };
      const ctx = { run, flow, view: { flow, id: "simulation" }, cat, caps, dry: true, count: 0, dryEffects: /** @type {any[]} */ ([]), dryAsks: 0, dryTasks: /** @type {any[]} */ ([]) };
      /** @type {{ outcome: string, reason?: string }} */ let result = { outcome: "completed" };
      try { await this.#walk(ctx, flow.steps, "", {}); }
      catch (e) {
        if (e instanceof PauseFlow) result = { outcome: "paused", reason: e.reason };
        else if (e instanceof Suspend) result = { outcome: "completed" };
        else result = { outcome: "failed", reason: e instanceof Error ? e.message : String(e) };
      }
      if (result.outcome === "completed") completed++; else if (result.outcome === "paused") paused++; else failed++;
      asks += ctx.dryAsks; tasks += ctx.dryTasks.length;
      for (const eff of ctx.dryEffects) {
        if (/^records\.(create|update|remove)$/.test(eff.action)) { const ty = eff.resource.split("/")[3]; writes[ty] = (writes[ty] || 0) + 1; }
        if (OUTWARD.has(eff.risk)) { const k = eff.action; outward[k] = outward[k] || { action: eff.action, risk: eff.risk, count: 0 }; outward[k].count++; }
      }
      runs.push({ event: h.env ? h.env.id : null, at: h.at, ...result, asks: ctx.dryAsks, tasks: ctx.dryTasks.length, effects: ctx.dryEffects.length, tainted: run.tainted });
    }
    const span = o.since !== undefined && o.until !== undefined ? ` in ${describeSpan(o.until - o.since)}` : " in that window";
    return {
      ok: true, warnings: compiled.warnings, events_seen: seen, matched: hits.length,
      summary: `This Flow would have run ${hits.length} ${hits.length === 1 ? "time" : "times"}${span} and asked for ${asks} ${asks === 1 ? "approval" : "approvals"}.`
        + (paused ? ` ${paused} would have paused.` : "") + (failed ? ` ${failed} would have failed.` : ""),
      totals: { runs: hits.length, completed, paused, failed, asks, tasks, writes, outward: Object.values(outward) },
      runs: runs.slice(0, 200),
      cannot_prove: ["what the actions really do (they are stubbed)", "how long a person takes to answer a question or a task", "what a model or a Code step returns", "events that have not happened yet"],
    };
  }

  // ------------------------------------------------------------------ reading runs

  /** @param {string} id */
  async getRun(id) { return this.store.getRun(id); }
  /** @param {{ flow?: string, state?: string, limit?: number }} [f] */
  async listRuns(f) { return this.store.listRuns(f); }
}

// ---------------------------------------------------------------------- helpers

/** Does an event pattern (`noun.past-verb`, `noun.*`) match a type? @param {string} pattern @param {string} type */
export const typeMatches = (pattern, type) => pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));

/**
 * Does this event trigger this Flow? Returns the scope the Flow reads (`trigger` and `event`), or null. An error in the condition is "no".
 * @param {any} t the Flow's trigger @param {any} env an event envelope
 */
export function triggerScope(t, env) {
  let scope = null;
  if (t.on === "event" && typeMatches(t.event, env.type)) scope = { trigger: env.data ?? {}, event: env };
  else if (t.on === "stage" && env.type === "record.stage-entered" && env.data && env.data.type === t.type && env.data.stage === t.stage) scope = { trigger: env.data, event: env };
  if (!scope) return null;
  if (t.on === "event" && t.where) { try { if (!truthy(evaluate(parse(t.where), scope))) return null; } catch { return null; } }
  return scope;
}

/** The outputs of finished steps, by step id (the latest turn of a loop wins). @param {Run} run */
function outputs(run) {
  /** @type {Record<string, any>} */ const o = {};
  for (const [k, v] of Object.entries(run.steps)) {
    if (k.includes("?")) continue;
    if (v.status !== "done" && v.status !== "started") continue;
    const id = k.replace(/@.*$/, "");
    if (v.output !== undefined) o[id] = v.output;
  }
  return o;
}

/** @param {any} v @param {any} scope @returns {any} */
export function resolveValue(v, scope) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(x => resolveValue(x, scope));
  if (Object.hasOwn(v, "expr")) return evaluate(parse(v.expr), scope);
  /** @type {Record<string, any>} */ const o = {};
  for (const k of Object.keys(v)) o[k] = resolveValue(v[k], scope);
  return o;
}

/** @param {any} v */
function recordId(v) {
  if (!v) return null;
  if (typeof v === "string") return v.includes("/") ? v.split("/").pop() || null : v;
  if (typeof v === "object" && typeof v.id === "string") return v.id;
  if (typeof v === "object" && typeof v.urn === "string") return v.urn.split("/").pop() || null;
  return null;
}

/** @param {any} ctx @param {any} v @param {string} [type] */
function urnOf(ctx, v, type) {
  if (typeof v === "string" && v.startsWith("vyre://")) return v;
  if (v && typeof v === "object" && typeof v.urn === "string") return v.urn;
  const id = recordId(v);
  const t = (v && typeof v === "object" && v.type) || type;
  return id && t ? `vyre://${ctx.cat.space}/${t}/${id}` : undefined;
}

/** Keep a record's useful fields only. @param {any} r */
const plain = r => (r ? { id: r.id, type: r.type, version: r.version, data: r.data, urn: r.urn } : r);

/** A trimmed event kept in the run (the body is not copied wholesale). @param {any} e */
const slim = e => ({ id: e.id, seq: e.seq, type: e.type, subject: e.subject, actor: e.actor, time: e.time, trust: e.trust, corr: e.corr, data: e.data });

/** How much of a service's response a run keeps (a Flow reads data, it does not store documents; a big file goes by Drive reference). */
const SERVICE_BODY_CAP = 64 * 1024;

/** @param {any} step @param {import('./compile.js').Catalog} cat */
function needOf(step, cat) { return flowNeeds({ steps: [step] }, cat)[0]; }

/** @param {ActorRef} a */
const nameOf = a => (a && a.id ? `${a.id}` : "the approver");
/** @param {import('./compile.js').Catalog} cat @param {string} action */
const labelOf = (cat, action) => (cat.actions[action] && cat.actions[action].label ? cat.actions[action].label.toLowerCase() : action.replace(".", " ").replace(/-/g, " "));

/** @param {any} ctx */
function flowUsesComputedOutward(ctx) {
  const c = compileFlow(ctx.view.flow, ctx.cat);
  return c.effects.needs_run_ask;
}

/** @param {number} ms */
function describeSpan(ms) {
  const d = Math.round(ms / 86_400_000);
  if (d >= 56) return `${Math.round(d / 30)} months`;
  if (d >= 14) return `${Math.round(d / 7)} weeks`;
  if (d >= 2) return `${d} days`;
  const h = Math.round(ms / 3_600_000);
  return h >= 2 ? `${h} hours` : "an hour";
}

/** @param {any} v @returns {number|null} */
function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

/**
 * Turn a condition into the store's Filter where it is simple enough: comparisons of `record.<field>` with a value computed from the rest of the scope,
 * joined by and, or and not. Anything else returns null and the rows are checked in memory (the in-memory check always runs, so this is only an optimisation).
 * @param {import('./expr.js').Node} n @param {any} scope @returns {any|null}
 */
export function toFilter(n, scope) {
  /** @param {import('./expr.js').Node} x */
  const field = x => (x.k === "member" && x.obj.k === "id" && x.obj.name === "record" ? x.name : null);
  const pureRight = (/** @type {import('./expr.js').Node} */ x) => !roots(x).has("record");
  if (n.k === "bin" && (n.op === "and" || n.op === "or")) {
    const a = toFilter(n.a, scope), b = toFilter(n.b, scope);
    return a && b ? { [n.op]: [a, b] } : null;
  }
  if (n.k === "un" && n.op === "not") { const a = toFilter(n.a, scope); return a ? { not: a } : null; }
  if (n.k === "bin" && ["==", "!=", "<", "<=", ">", ">="].includes(n.op)) {
    const f = field(n.a);
    if (f && pureRight(n.b)) return { field: f, op: { "==": "eq", "!=": "ne", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" }[/** @type {'=='} */ (n.op)], value: evaluate(n.b, scope) };
  }
  return null;
}
