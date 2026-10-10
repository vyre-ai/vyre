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

import { expandConnections } from "./connection-step.js";
import { runCases } from "./cases.js";
import crypto from "node:crypto";
import { parse, evaluate, truthy } from "./expr.js";
import { outputs, resolveValue, recordId, urnOf, plain, coerce, describeSpan, toMs, toFilter } from "./runner-util.js";
export { resolveValue, toFilter };
import { compileFlow, deriveCaps, needs as flowNeeds, urnCovers, STEP_ACTIONS } from "./compile.js";
import { LIMITS as SCHEMA_LIMITS, RETRY_CODES, walkSteps, canonical as canonicalOf } from "./schema.js";
import { runIdFor, newId } from "./store.js";
import { recordTrigger } from "./triggers.js";
import { recordOfTrigger } from "./run-record.js";
import { createJoins, laneOf } from "./joins.js";
import { nextFire, dueTimes, holidaysFrom } from "./schedule.js";
import { taskIdOf } from "./stages.js";
import { chooseDoer } from "./assign.js";
import { requestBind, actBind } from "../seal/uses.js";
import { createPruner, KEEP_DAYS } from "./prune.js";
import { ridesOf, cardTitle } from "./rides.js";
import { redact as redactText } from "../../lib/credential-shapes.js";
import { healthOf, connectorsOf } from "./health.js";
import { timelineOf, stepDetail, stepIndex } from "./timeline.js";
import { opFor, isDeclared, takesKey, readbackRequest, compareReadback, retryAfterMs } from "./safe-write.js";

export const LIMITS = Object.freeze({ ai_tokens_per_step: 2_000, ai_tokens_per_run: 20_000, ai_tokens_per_day: 200_000, depth: 8, rate_per_minute: 60, steps_per_run: 500, children_per_run: 100, concurrency: 8, box_concurrency: 32, stuck_ms: 300_000, stale_ms: 3 * 86_400_000, backlog: 200, retry_cap: 8, scan: 2000, wait_max_ms: 366 * 86_400_000 });
/**
 * What a step does about time and failure when its Flow says nothing (R031 Flows reliability, f1). Per kind: how long one attempt may take, how many attempts there are (the first counts), and the waits between them
 * (the last repeats). Only a fault in RETRY_CODES is ever retried, whatever a Flow says: a refusal, a missing power, outside content and a write that may or may not have gone out (`outcome_unknown`) are not faults of the
 * moment, and a policy cannot name them (the schema refuses). A write is retried only where it carries an idempotency key the other side honours: a record write does; a module tool call and a service write
 * default to one attempt and are retried only when the Flow's author says so. Human waits (ask, assign, agent, wait) have no attempt limit: the watchdog (f5) and their own deadlines cover them.
 * `o.policy` overrides any of it, per kind (the host passes the Space's settings).
 */
export const POLICY = Object.freeze({
  find: { timeout_ms: 30_000, attempts: 3, backoff_ms: [2000, 5000] }, pick: { timeout_ms: 30_000, attempts: 3, backoff_ms: [2000, 5000] }, filter: { timeout_ms: 30_000, attempts: 1, backoff_ms: [0] },
  create: { timeout_ms: 60_000, attempts: 3, backoff_ms: [2000, 5000] }, update: { timeout_ms: 60_000, attempts: 3, backoff_ms: [2000, 5000] }, upsert: { timeout_ms: 60_000, attempts: 3, backoff_ms: [2000, 5000] },
  remove: { timeout_ms: 60_000, attempts: 3, backoff_ms: [2000, 5000] }, stage: { timeout_ms: 60_000, attempts: 3, backoff_ms: [2000, 5000] },
  call: { timeout_ms: 60_000, attempts: 1, backoff_ms: [2000, 5000] }, service: { timeout_ms: 30_000, attempts: 1, backoff_ms: [2000, 5000, 15_000], readAttempts: 3 },
  classify: { timeout_ms: 60_000, attempts: 2, backoff_ms: [3000] }, extract: { timeout_ms: 60_000, attempts: 2, backoff_ms: [3000] }, fn: { timeout_ms: 10_000, attempts: 1, backoff_ms: [0] },
});
/** Steps whose nested steps this run walks itself: they take part in a replay. (A `parallel` step's lanes are runs of their own.) */
const INLINE_KINDS = new Set(["decide", "repeat"]);
/** Denials that mean the approver can no longer do this: the Flow pauses and says why. */
const PAUSE_REASONS = new Set(["revoked", "not_a_member", "expired", "no_grant", "wrong_space"]);
const OUTWARD = new Set(["outward.send", "outward.pay", "outward.publish", "outward.delete", "outward.share"]);

class Suspend extends Error { constructor() { super("suspended"); this.name = "Suspend"; } }
class StepFail extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "StepFail"; this.code = code; }
}
/** A port's own failure (the sandbox's timeout, the door's refusal) keeps its code as the step's. @param {any} e @returns {never} */
function portFail(e) {
  if (e instanceof StepFail || e instanceof Suspend || e instanceof PauseFlow || !e || typeof e.code !== "string") throw e;
  throw new StepFail(e.code, e instanceof Error ? e.message : String(e));
}
/** What went wrong, as a code and words, whatever was thrown. A port's own code is kept; the usual network faults get the names a retry policy knows. @param {any} e @returns {{ code: string, message: string }} */
function failOf(e) {
  if (e instanceof StepFail) return { code: e.code, message: e.message };
  const raw = e && typeof e.code === "string" ? e.code : "error";
  const code = /^(ETIMEDOUT|ESOCKETTIMEDOUT)$/.test(raw) ? "timeout" : /^(ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN)$/.test(raw) ? "connection_reset" : raw;
  return { code, message: e instanceof Error ? e.message : String(e) };
}
/**
 * An input as the timeline may show it: credential-shaped strings and the values of keys that name a secret are hidden, and the whole is cut to 2 KB. A sealed placeholder stays a placeholder.
 * @param {any} v @returns {any}
 */
export function showable(v) {
  if (v === undefined) return undefined;
  const SECRET_KEY = /secret|token|password|passwd|api[_-]?key|authorization|cookie|private/i;
  const walk = (/** @type {any} */ x, /** @type {number} */ depth) => {
    if (depth > 6) return "…";
    if (typeof x === "string") return redactText(x);
    if (Array.isArray(x)) return x.slice(0, 50).map(y => walk(y, depth + 1));
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).slice(0, 50).map(([k, y]) => [k, SECRET_KEY.test(k) && typeof y !== "object" ? "[hidden]" : walk(y, depth + 1)]));
    return x;
  };
  const out = walk(v, 0);
  const text = JSON.stringify(out) ?? "null";
  return text.length > 2048 ? { cut: true, head: text.slice(0, 2000) } : out;
}

/** The run stops at the next step boundary because the Space's switch says pause: it is held (state queued) and goes on, in order, when the switch is released. */
class Hold extends Error {
  /** @param {string} reason */
  constructor(reason) { super(reason); this.name = "Hold"; this.reason = reason; }
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
 *     call?: (chain: any, action: string, resource: string, input: any, o: { idem: string, approval?: string, bind?: string }) => Promise<any>,
 *     service?: (q: { chain: any, connector: string, request: { method: string, path: string, query?: any, headers?: any, body?: any, upload?: { drive: { path: string, version?: string, contentType?: string } }, saveTo?: string }, idem: string, approval?: string }) => Promise<{ status: number, ok?: boolean, headers?: Record<string, string>, body?: string } | { saved: { path: string, version: string|number, size: number, sha256: string } } | { held: boolean, kind?: string, summary?: string }>,
 *     sandbox?: (req: { language: string, source: string, hash: string, inputs: any, outputs: string[], needs: string[] }) => Promise<{ outputs: Record<string, any> }>,
 *     roles?: (space: string, role: string) => Promise<ActorRef[]> | ActorRef[],
 *     model?: { provider: string, model: string },
 *   },
 *   settings?: (key: string) => Promise<any>,
 *   policy?: Record<string, { timeout_ms?: number, attempts?: number, backoff_ms?: number[], readAttempts?: number }>,
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
    /** @type {Record<string, { timeout_ms?: number, attempts?: number, backoff_ms?: number[], readAttempts?: number }>} */
    this.policy = Object.fromEntries(Object.entries(POLICY).map(([k, v]) => [k, { ...v, .../** @type {any} */ ((o.policy || {})[k] || {}) }]));
    /** @type {Map<string, Promise<any>>} */ this.locks = new Map();
    /** @type {Map<string, number[]>} */ this.rate = new Map();
    /** @type {Map<string, number>} */ this.lastFire = new Map();
    /** @type {{ at: number, flows: any[] } | null} */ this.cache = null;
    /** @type {Set<Promise<any>>} */ this.inflight = new Set();
    /** Who is executing a slice now: the box, each Flow, each lock key. A run holds a place only while it executes, never while it waits for a person or a timer. */
    this.slots = { box: /** @type {Set<string>} */ (new Set()), byFlow: /** @type {Map<string, Set<string>>} */ (new Map()), locks: /** @type {Map<string, string>} */ (new Map()) };
    /** The Space's switch (running, paused, draining), cached a few seconds. @type {{ mode: string, reason?: string, since?: number, by?: string|null, dropped?: Record<string, number> }} */ this.ctl = { mode: "running" };
    this.ctlAt = -Infinity;
    /** @type {Map<string, number>} runs the watchdog already ran once more, and when */ this.reexec = new Map();
    /** Arrival order for held runs that were held in the same millisecond. */ this.seq = 0;
    /** The run objects being executed now, so the watchdog can flag one that is silent without waiting behind it. @type {Map<string, Run>} */ this.live = new Map();
    /** @type {Promise<void> | null} */ this.queueRun = null; this.queueAgain = false;
    /** Reads the Space's settings (flows.concurrency, ...); the host gives it. @type {((key: string) => Promise<any>) | null} */ this.settingsFn = o.settings || null;
    this.settingsAt = -Infinity;
    /** @type {number} the most tries any step gets from the kind's default (a setting; an author's own `retry` is not capped) */ this.retryCap = LIMITS.retry_cap;
    /** @type {Map<string, { key: string, at: number, bad?: string }>} the last replay of a Flow's saved test cases, for the health line */ this.testMemo = new Map();
    /** The Space's holidays (setting flows.holidays), for schedules that keep business hours. @type {string[]} */ this.holidays = [];
    /** Old finished runs shrink to one line (setting flows.runs_keep_days; kernel/flows/prune.js). */
    this.keepMs = KEEP_DAYS * 86_400_000; this.pruneAt = -Infinity; this.pruner = createPruner({ store: this.store, now: () => this.now(), locked: (id, fn) => this.#locked(id, fn) });
    /** Parallel lanes and sub-flows: runs that start runs and wait for them (kernel/flows/joins.js). */
    this.joins = createJoins({
      store: this.store, now: () => this.now(), locked: (id, fn) => this.#locked(id, fn), detach: id => this.#detach(id), resumeLocked: (id, r) => this.#resumeLocked(id, r), retry: id => this.retry(id),
      mark: (ctx, key, patch) => this.#mark(ctx, key, patch), suspendOn: (ctx, key, wait) => this.#suspendOn(ctx, key, wait), fail: (code, message) => new StepFail(code, message),
      childLimit: this.limits.children_per_run, emit: (type, data, run, subject) => this.#emit(type, data, run, subject), scope: (ctx, locals) => this.#scope(ctx, locals), walk: (ctx, steps, suffix, locals) => this.#walk(ctx, steps, suffix, locals), depthLimit: this.limits.depth,
    });
  }

  // ------------------------------------------------------------------ definitions

  /** Compile and store a new version. Nothing runs until a person approves it. @param {string|null} id @param {any} flow @param {ActorRef} by */
  async define(id, flow, by) {
    const cat = await this.catalogFn();
    const compiled = compileFlow(flow, cat);
    if (!compiled.ok) return { ok: false, errors: compiled.errors, warnings: compiled.warnings, effects: compiled.effects };
    const put = await this.store.putVersion(id, compiled.flow || flow, by, this.now(), cat.space);
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
    // a saved test case that fails holds the approval back (t2)
    const cases = this.store.getTests ? await this.store.getTests(id) : [];
    if (cases.length) {
      const r = await runCases(this, v.flow, cases, approver);
      if (!r.ok) throw Object.assign(new Error(`a saved test case fails, so this version is not approved: ${r.results.filter(x => !x.ok).map(x => x.line).slice(0, 3).join("; ")}`), { code: "invalid", cases: r });
    }
    const row = await this.store.approve(id, version, approver, hash, this.now());
    this.cache = null;
    return row;
  }

  // ------------------------------------------------------------------ stage gates (s1)
  // A stage with tasks is a gate the record passes through. The stages module makes the tasks and decides when the record moves on; the gate is a run on THIS runner, so it is written down (a restart
  // loses nothing), it shows on the timeline and in `flows.describe`, a task that is stuck raises attention, and a move made early is on its ledger with who and why. It is synthesized at stage
  // entry from the stage as the Space defines it: no Flow is stored for it, and its steps are `tasks`, one `task:<title>` for each task, `condition` (the next stage's entry condition) and `move`.

  /** Open (or find) the gate for one stage entry. @param {{ key: string, urn: string, type: string, id: string, stage: string, next: string | null, owner?: string, tasks: { id: string, title: string, required: boolean }[], approver?: any }} g */
  async gateOpen(g) {
    const cat = /** @type {any} */ (await this.catalogFn());
    const id = runIdFor(`gate:${g.key}`, "gate");
    const had = await this.store.getRun(id);
    if (had) return had.id;
    const now = this.now();
    /** @type {Run} */
    const run = { id, flow: `gate:${g.type}:${g.stage}`, version: 0, hash: "", space: cat.space, trigger: { kind: "gate", key: g.key, source: `stage:${g.type}.${g.stage}`, input: { record: g.urn, stage: g.stage } }, tainted: false, source_spaces: [cat.space], depth: 0,
      state: "waiting", started_at: now, updated_at: now, steps: {}, waiting: { step: "tasks", kind: "gate" }, approver: g.approver || { kind: "service", id: "stages", space: cat.space },
      gate: { key: g.key, urn: g.urn, type: g.type, record: g.id, stage: g.stage, next: g.next, owner: g.owner || null, tasks: g.tasks } };
    run.steps.tasks = { status: "waiting", at: now, output: { count: g.tasks.length, required: g.tasks.filter(t => t.required).length } };
    for (const t of g.tasks) run.steps[`task:${t.title}`] = { status: "waiting", at: now, task: t.id, output: { required: t.required } };
    await this.store.putRun(run);
    this.#emit("stage.gate-opened", { run: id, record: g.urn, stage: g.stage }, run, `vyre://${run.space}/flow-run/${id}`);
    return id;
  }

  /**
   * One read through a Connection, for a stage gate's checklist: the declared operation must be a read (GET or HEAD), and the gateway authorizes it as a read for the chain it is given. A check
   * never writes, so there is no yes to ask for; anything outward is refused here and would be held by the gateway anyway.
   * @param {{ connection: string, operation: string, input?: any }} spec @param {any} chain a kernel-built chain
   */
  async readConnection(spec, chain) {
    const cat = /** @type {any} */ (await this.catalogFn());
    const probe = expandConnections({ steps: [{ id: "check", kind: "service", connection: spec.connection, operation: spec.operation, ...(spec.input !== undefined ? { input: spec.input } : {}) }] }, cat);
    if (probe.errors.length) throw Object.assign(new Error(probe.errors[0].message), { code: "bad_input" });
    const s = probe.flow.steps[0];
    const method = String(s.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw Object.assign(new Error(`a check only reads, and ${spec.operation} is ${method}`), { code: "not_allowed" });
    if (!this.ports.service) throw Object.assign(new Error("this Space has no connectors yet"), { code: "unavailable" });
    const val = (/** @type {any} */ v) => v;
    return this.ports.service({ chain, connector: s.connector, request: { method, path: s.path, ...(s.query !== undefined ? { query: val(s.query) } : {}), ...(s.headers !== undefined ? { headers: val(s.headers) } : {}) } });
  }

  /** What the stages module writes its gates through. */
  gatePort() { return { open: (/** @type {any} */ g) => this.gateOpen(g), mark: (/** @type {string} */ id, /** @type {string} */ k, /** @type {any} */ p, /** @type {any} */ x) => this.gateMark(id, k, p, x), close: (/** @type {string} */ id, /** @type {any} */ x) => this.gateClose(id, x), list: () => this.gates(), read: (/** @type {any} */ spec, /** @type {any} */ chain) => this.readConnection(spec, chain) }; }

  /** The open gates. @returns {Promise<any[]>} */
  async gates() { return (await this.store.listRuns({ state: "waiting", limit: 5000 })).filter((/** @type {any} */ r) => r.gate); }

  /** Write one step of a gate. A step that is already in that status with that output is left alone, so a repeated look writes nothing. @param {string} id @param {string} key @param {Record<string, any>} patch @param {{ attention?: any }} [o] */
  async gateMark(id, key, patch, o = {}) {
    return this.#locked(id, async () => {
      const run = await this.store.getRun(id);
      if (!run || !run.gate) return null;
      const cur = run.steps[key];
      const same = cur && cur.status === patch.status && JSON.stringify(cur.output ?? null) === JSON.stringify(patch.output ?? cur.output ?? null);
      if (same && !o.attention && !run.attention) return run;
      run.steps[key] = { ...(cur || {}), at: this.now(), ...patch };
      run.updated_at = this.now();
      if (o.attention) run.attention = { since: this.now(), ...o.attention }; else if (patch.status !== "failed") run.attention = undefined;
      await this.store.putRun(run);
      return run;
    });
  }

  /** The gate is over: the record moved on (or was moved, or the stage is no longer the record's). @param {string} id @param {{ state?: 'done'|'cancelled', note?: string }} o */
  async gateClose(id, o = {}) {
    return this.#locked(id, async () => {
      const run = await this.store.getRun(id);
      if (!run || !run.gate || run.finished_at) return;
      run.state = o.state || "done"; run.finished_at = this.now(); run.updated_at = run.finished_at; run.waiting = undefined; run.attention = undefined;
      if (o.note) run.error = { step: "move", code: "note", message: o.note };
      await this.store.putRun(run);
      this.#emit("stage.gate-closed", { run: id, state: run.state }, run, `vyre://${run.space}/flow-run/${id}`);
    });
  }

  /**
   * The runs that need a person (f3): every run with an `attention` that is not over, newest first. One row each, in plain words, with no step data and no secret (the message is redacted).
   * A stage gate is here too (stuck task, a held entry condition); `loud` is false for the quiet ones (a person who has simply not answered yet).
   * @returns {Promise<{ run: string, flow: string, label: string, kind: string, step: string, step_label: string, message: string, since: number, loud: boolean, gate?: boolean }[]>}
   */
  async attention() {
    const rows = [];
    const versions = new Map();
    for (const r of await this.store.listRuns({ limit: 1000 })) {
      if (!r.attention || r.state === "done" || r.state === "cancelled") continue;
      // a lane or sub-flow whose parent already reports the failure is one row, the parent's: Retry on it sends the failed lanes round again
      if (r.parent) { const p = await this.store.getRun(r.parent.run); if (p && p.state === "failed" && p.error && /^(branch|subflow)_failed$/.test(p.error.code)) continue; }
      let label = r.gate ? `Stage gate: ${r.gate.type} ${r.gate.stage}` : r.flow;
      let stepLabel = r.attention.step || "";
      if (!r.gate) {
        const key = `${r.flow}@${r.version}`;
        if (!versions.has(key)) versions.set(key, await this.store.getVersion(r.flow, r.version).catch(() => null));
        const v = versions.get(key);
        if (v && v.flow) { label = v.flow.label || v.flow.name || label; stepLabel = (stepIndex(v.flow).get(String(stepLabel).replace(/\?.*$/, "")) || { label: stepLabel }).label; }
      }
      rows.push({ run: r.id, flow: r.flow, label: String(label).slice(0, 120), kind: r.attention.kind, step: String(r.attention.step || ""), step_label: String(stepLabel).slice(0, 80), message: redactText(String(r.attention.message || "")).slice(0, 200),
        since: r.attention.since || r.updated_at, loud: r.attention.kind !== "stale", ...(r.gate ? { gate: true } : {}) });
    }
    return rows.sort((a, b) => b.since - a.since);
  }

  /** The saved test cases of a Flow. @param {string} id */
  async tests(id) { return this.store.getTests ? this.store.getTests(id) : []; }
  /** @param {string} id @param {any[]} cases */
  async saveTests(id, cases) { if (!this.store.putTests) throw Object.assign(new Error("this store keeps no test cases"), { code: "unavailable" }); await this.store.putTests(id, cases); }

  async #activeFlows() {
    if (this.cache && this.now() - this.cache.at < 30_000) return this.cache.flows;
    const flows = await this.store.activeFlows();
    this.cache = { at: this.now(), flows };
    return flows;
  }

  /** The Flows a trigger may reach: the active ones, and the paused ones (flagged `paused`), so what arrives for a paused Flow is held, in order, and not lost. */
  async #triggerFlows() {
    const active = await this.#activeFlows();
    if (!this.store.pausedFlows) return active;
    const paused = await this.store.pausedFlows().catch(() => []);
    return paused.length ? [...active, ...paused] : active;
  }

  /** @param {string} id @param {string} reason */
  async pauseFlow(id, reason) { await this.store.pause(id, reason, this.now()); this.cache = null; }
  /**
   * Resume a paused Flow. What arrived while it was paused and was held runs now, in order (`backlog: "run"`, the default), or is dropped and counted (`"drop"`).
   * @param {string} id @param {{ backlog?: 'run'|'drop', by?: string|null }} [o]
   */
  async resumeFlow(id, o = {}) {
    await this.store.resume(id); this.cache = null;
    const dropped = o.backlog === "drop" ? await this.#dropHeld((r) => r.flow === id && r.queued !== undefined && r.queued.reason === "flow_paused", o.by || null) : 0;
    await this.#drainQueue();
    return { ok: true, dropped_now: dropped };
  }

  // ------------------------------------------------------------------ health and the timeline (f8, f12)

  /**
   * How each Flow is, in one line and a few numbers: last run, this week's successes, the next run, what needs a person, what is held, and red when a Connection it uses is red. One Flow with `id`, else all of
   * them. Read from the runs the runner already keeps; nothing new is stored.
   * @param {string} [id]
   */
  async health(id) {
    const now = this.now(), cat = /** @type {any} */ (await this.catalogFn()), ctl = await this.#control();
    const out = [];
    for (const r of (await this.store.list()).filter((/** @type {any} */ x) => !id || x.id === id)) {
      const ver = r.active !== null && r.active !== undefined ? await this.store.getVersion(r.id, r.active) : null;
      const flow = ver ? ver.flow : null;
      const runs = await this.store.listRuns({ flow: r.id, limit: 200 });
      /** @type {number | null} */ let nextAt = null;
      const t = flow && flow.trigger;
      if (t && t.on === "time" && r.status === "active") {
        const last = await this.#lastFire(r.id, now);
        const nf = t.cron !== undefined || t.every_ms !== undefined ? nextFire(t, t.cron !== undefined ? Math.max(last, now) : last, this.#zone(t, cat), this.holidays) : null;
        nextAt = nf !== null ? (t.every_ms !== undefined ? Math.max(nf, now) : nf) : t.at !== undefined && t.at > now ? t.at : null;
      }
      out.push(healthOf({ id: r.id, label: (flow && (flow.label || flow.name)) || r.name || r.id, status: r.status, paused: r.paused || null, runs, now, nextAt, tz: cat.tz || "UTC",
        lights: cat.lights || {}, connectors: connectorsOf(flow), control: ctl, testFailing: ver && r.status === "active" ? await this.#testFailing(r.id, ver) : undefined, held: runs.filter((/** @type {any} */ x) => x.state === "queued").length }));
    }
    return id ? out[0] || null : out;
  }

  /** The first failing saved test case of the active version, or undefined (a minute's cache: health is read often and a replay is not free). @param {string} id @param {any} ver */
  async #testFailing(id, ver) {
    const cases = await this.tests(id);
    if (!cases.length) return undefined;
    const key = `${ver.hash}:${JSON.stringify(cases).length}`;
    const hit = this.testMemo.get(id);
    if (hit && hit.key === key && this.now() - hit.at < 60_000) return hit.bad;
    const approver = ver.approver || { kind: "service", id: "flows", space: ver.space };
    const r = await runCases(this, ver.flow, cases, approver).catch(() => null);
    const bad = r && !r.ok ? r.results.find(x => !x.ok)?.name : undefined;
    this.testMemo.set(id, { key, at: this.now(), bad });
    return bad;
  }

  /** A run read back as lines (f12), or one step in detail. @param {string} runId @param {{ step?: string }} [o] */
  async timeline(runId, o = {}) {
    const run = await this.store.getRun(runId);
    if (!run) throw Object.assign(new Error("no such run"), { code: "not_found" });
    const ver = await this.store.getVersion(run.flow, run.version);
    if (o.step) { const d = stepDetail(run, o.step); if (!d) throw Object.assign(new Error(`that run has no step ${o.step}`), { code: "not_found" }); return { run: run.id, step: d }; }
    const t = timelineOf(run, ver ? ver.flow : null);
    return { run: run.id, flow: run.flow, version: run.version, lines: t.lines };
  }

  // ------------------------------------------------------------------ the switch, the queue, concurrency and locks (f5, f6, f7)

  /** The limits the Space's settings give, read at most every 30 seconds. A setting that is missing or not a number leaves the default. */
  async #refreshSettings() {
    if (!this.settingsFn || this.now() - this.settingsAt < 30_000) return;
    this.settingsAt = this.now();
    const pick = async (/** @type {string} */ key, /** @type {number} */ scale, /** @type {number} */ lo, /** @type {number} */ hi) => { try { const v = Number(await /** @type {any} */ (this.settingsFn)(key)); return Number.isFinite(v) && v >= lo && v <= hi ? v * scale : undefined; } catch { return undefined; } };
    const set = (/** @type {string} */ k, /** @type {number|undefined} */ v) => { if (v !== undefined) /** @type {any} */ (this.limits)[k] = v; };
    set("concurrency", await pick("flows.concurrency", 1, 1, 32));
    set("box_concurrency", await pick("flows.concurrency_box", 1, 1, 256));
    set("stuck_ms", await pick("flows.stuck_minutes", 60_000, 1, 1440));
    set("stale_ms", await pick("flows.stale_days", 86_400_000, 1, 365));
    set("backlog", await pick("flows.backlog_cap", 1, 1, 5000));
    { const keep = await pick("flows.runs_keep_days", 86_400_000, 1, 3650); if (keep !== undefined) this.keepMs = keep; }
    const cap = await pick("flows.retry_attempts", 1, 1, 8);
    if (cap !== undefined) this.retryCap = cap;
    try { this.holidays = holidaysFrom(await /** @type {any} */ (this.settingsFn)("flows.holidays")); } catch { /* keep the list it had */ }
  }

  /** The Space's switch. @returns {Promise<{ mode: string, reason?: string, since?: number, by?: string|null, dropped?: Record<string, number> }>} */
  async #control() {
    if (this.now() - this.ctlAt < 5000) return this.ctl;
    this.ctlAt = this.now();
    try { const c = this.store.getControl ? await this.store.getControl() : null; this.ctl = c && c.mode ? c : { mode: "running" }; } catch { /* the last known switch stands */ }
    return this.ctl;
  }

  /** @param {{ mode: string, reason?: string, since?: number, by?: string|null, dropped?: Record<string, number> }} c */
  async #putControl(c) { this.ctl = c; this.ctlAt = this.now(); if (this.store.putControl) await this.store.putControl(c); }

  /**
   * Pause every Flow at once, or drain. Paused: nothing new starts (a trigger that arrives is held, in order, and runs when the switch is released) and a run in flight stops at its next step boundary.
   * Draining: nothing new starts, and the runs already going finish. A person's own.
   * @param {{ reason?: string, by?: string|null, drain?: boolean }} [o]
   */
  async pauseAll(o = {}) {
    const prev = await this.#control();
    await this.#putControl({ mode: o.drain ? "draining" : "paused", reason: String(o.reason || "").slice(0, 200), since: this.now(), by: o.by || null, dropped: prev.dropped || {} });
    return this.controlState();
  }

  /**
   * Release the switch. What was held while it was on runs now, in the order it came (`backlog: "run"`, the default), or is dropped and counted (`"drop"`).
   * @param {{ backlog?: 'run'|'drop', by?: string|null }} [o]
   */
  async resumeAll(o = {}) {
    const prev = await this.#control();
    await this.#putControl({ mode: "running", since: this.now(), by: o.by || null, dropped: prev.dropped || {} });
    const dropped = o.backlog === "drop" ? await this.#dropHeld((r) => r.queued.reason === "paused" || r.queued.reason === "draining", o.by || null) : 0;
    await this.#drainQueue();
    return { ...(await this.controlState()), dropped_now: dropped };
  }

  /** The switch, and what waits behind it, for a line a person reads first: how many runs are held and why, and how many events were dropped past the cap. */
  async controlState() {
    const c = await this.#control();
    const held = await this.store.listRuns({ state: "queued", limit: 5000 });
    const byReason = /** @type {Record<string, number>} */ ({});
    for (const r of held) if (r.queued) byReason[r.queued.reason] = (byReason[r.queued.reason] || 0) + 1;
    return { mode: c.mode, ...(c.reason ? { reason: c.reason } : {}), ...(c.since ? { since: c.since } : {}), ...(c.by ? { by: c.by } : {}), held: held.length, held_by: byReason, dropped: Object.values(c.dropped || {}).reduce((a, b) => a + b, 0) };
  }

  /** Mark queued runs cancelled (a person chose not to run what was held) and count them. @param {(r: Run) => boolean} pick @param {string|null} by */
  async #dropHeld(pick, by) {
    let n = 0;
    for (const r of await this.store.listRuns({ state: "queued", limit: 5000 })) {
      if (!r.queued || !pick(r)) continue;
      await this.#locked(r.id, async () => {
        const cur = await this.store.getRun(r.id);
        if (!cur || cur.state !== "queued") return;
        cur.state = "cancelled"; cur.finished_at = this.now(); cur.updated_at = cur.finished_at; cur.queued = undefined; cur.cancelled = { by, at: cur.finished_at, reason: "dropped when the backlog was released" };
        await this.store.putRun(cur);
        n++;
      });
    }
    return n;
  }

  /** @param {Run} run @param {string} why */
  async #queue(run, why) {
    const was = run.state;
    run.state = "queued"; run.queued = { reason: /** @type {any} */ (why), since: run.queued ? run.queued.since : this.now(), seq: run.queued ? run.queued.seq : ++this.seq }; run.updated_at = this.now();
    await this.store.putRun(run);
    if (was !== "queued") this.#emit("flow.queued", { run: run.id, flow: run.flow, reason: why }, run, `vyre://${run.space}/flow-run/${run.id}`);
  }

  /** The most runs of this Flow at once. @param {any} flow */
  #flowLimit(flow) { return Math.min(flow && flow.concurrency ? flow.concurrency : this.limits.concurrency, this.limits.box_concurrency); }

  /** A lock key from the Flow's expression, once per run. @param {Run} run @param {any} flow @returns {string|null} */
  #lockKey(run, flow) {
    if (run.lock_key !== undefined) return run.lock_key || null;
    // No lock of its own: a run that a record's event started works on that record, and two such runs for one record take turns (they never interleave their writes). Events that are not about a record have no key.
    if (!flow || typeof flow.lock !== "string") {
      const subject = run.trigger && run.trigger.event && typeof run.trigger.event.subject === "string" ? run.trigger.event.subject : "";
      const m = /^vyre:\/\/[^/]+\/([a-z][a-z0-9-]*)\/[^/]+$/.exec(subject);
      run.lock_key = m && !["event", "flow", "flow-run", "task", "def-flow", "flow-state"].includes(m[1]) ? subject : "";
      return run.lock_key || null;
    }
    let key = "";
    try { const v = evaluate(parse(flow.lock), this.#scope({ run }, {})); key = v === null || v === undefined || v === "" ? "" : String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 200); } catch { key = ""; }
    run.lock_key = key;
    return key || null;
  }

  /**
   * Take a place to execute: one of the Flow's, one of the box's, and the lock key if the Flow has one. Returns null when taken, else why not (the run is then queued).
   * @param {Run} run @param {any} flow @returns {string | null}
   */
  #acquire(run, flow) {
    if (this.slots.box.has(run.id)) return null;
    if (this.slots.box.size >= this.limits.box_concurrency) return "box_limit";
    const set = this.slots.byFlow.get(run.flow) || new Set();
    if (set.size >= this.#flowLimit(flow)) return "concurrency";
    const key = this.#lockKey(run, flow);
    if (key) { const holder = this.slots.locks.get(key); if (holder && holder !== run.id) return "lock"; }
    this.slots.box.add(run.id); set.add(run.id); this.slots.byFlow.set(run.flow, set);
    if (key) this.slots.locks.set(key, run.id);
    return null;
  }

  /** @param {Run} run */
  #release(run) {
    this.slots.box.delete(run.id);
    const set = this.slots.byFlow.get(run.flow);
    if (set) { set.delete(run.id); if (!set.size) this.slots.byFlow.delete(run.flow); }
    if (run.lock_key && this.slots.locks.get(run.lock_key) === run.id) this.slots.locks.delete(run.lock_key);
  }

  /** Start what was held and can go now, oldest first. One pass at a time; a request that comes in during a pass makes another pass, and none is lost. */
  #drainQueue() {
    this.queueAgain = true;
    if (this.queueRun) return this.queueRun;
    /** @type {Promise<void>} */ const p = (async () => {
      try { while (this.queueAgain) { this.queueAgain = false; await this.#drainOnce(); } }
      catch { /* the next request tries again */ }
      finally { this.queueRun = null; this.inflight.delete(p); }
    })();
    this.queueRun = p; this.inflight.add(p);
    return p;
  }

  async #drainOnce() {
    const c = await this.#control();
    if (c.mode !== "running") return;
    const held = (await this.store.listRuns({ state: "queued", limit: 5000 })).filter(r => r.queued).sort((a, b) => /** @type {any} */ (a.queued).since - /** @type {any} */ (b.queued).since || (/** @type {any} */ (a.queued).seq || 0) - (/** @type {any} */ (b.queued).seq || 0) || (a.id < b.id ? -1 : 1));
    /** @type {Map<string, number>} */ const launched = new Map();
    let box = this.slots.box.size;
    for (const r of held) {
      const f = await this.store.active(r.flow);
      if (!f) continue;                                           // the Flow is paused or off: its runs wait with it
      const view = await this.store.getVersion(r.flow, r.version);
      const flow = view ? view.flow : f.flow;
      const mine = (this.slots.byFlow.get(r.flow) ? this.slots.byFlow.get(r.flow)?.size || 0 : 0) + (launched.get(r.flow) || 0);
      if (box >= this.limits.box_concurrency || mine >= this.#flowLimit(flow)) continue;
      const key = this.#lockKey(r, flow);
      if (key && this.slots.locks.has(key) && this.slots.locks.get(key) !== r.id) continue;
      launched.set(r.flow, (launched.get(r.flow) || 0) + 1); box++;
      await this.#locked(r.id, async () => {
        const cur = await this.store.getRun(r.id);
        if (!cur || cur.state !== "queued") return;
        cur.state = "running"; cur.queued = undefined; cur.updated_at = this.now();
        await this.store.putRun(cur);
      });
      this.#detach(r.id);
    }
  }

  /**
   * A run that stopped moving is never silent (f5). A run that says it is running but has not written to its ledger for `stuck_after_ms` is run once more (the ledger makes that safe, it is
   * what a restart does) and, if it still does not move, flagged `stuck`. A run waiting for a person past `stale_after` is flagged `stale`, and left waiting: a person may simply be slow.
   * Only the scheduler's own tick calls this, so there is no timer of its own.
   */
  async #watchdog() {
    const now = this.now();
    const stuckOf = async (/** @type {Run} */ r) => { const v = await this.store.getVersion(r.flow, r.version); return v && v.flow && v.flow.stuck_after_ms ? v.flow.stuck_after_ms : this.limits.stuck_ms; };
    for (const r of await this.store.listRuns({ state: "running", limit: 1000 })) {
      if (now - r.updated_at < await stuckOf(r)) continue;
      if (r.attention && r.attention.kind === "stuck") continue;
      const going = this.locks.has(r.id);
      const again = this.reexec.get(r.id);
      if (!going && (again === undefined || again < r.updated_at)) { this.reexec.set(r.id, now); this.#detach(r.id); continue; }
      // A run that is executing but silent cannot be written behind its own lock (that lock is held by the step that hangs): the flag goes on the live run, and the run's next write keeps it.
      const live = this.live.get(r.id);
      if (!live && !going) {                                  // run once more already and still not moving, with nothing executing it
        await this.#locked(r.id, async () => {
          const cur = await this.store.getRun(r.id);
          if (!cur || cur.state !== "running" || cur.attention) return;
          this.#attend(cur, { kind: "stuck", step: cur.error ? cur.error.step : "", message: "this run has not moved for a while" });
          await this.store.putRun(cur);
          this.#emit("flow.stuck", { run: cur.id, flow: cur.flow, step: cur.error ? cur.error.step : "" }, cur, `vyre://${cur.space}/flow-run/${cur.id}`);
        });
        continue;
      }
      if (!live || live.state !== "running") continue;
      this.#attend(live, { kind: "stuck", step: live.error ? live.error.step : "", message: "this run has not moved for a while" });
      await this.store.putRun(live);
      this.#emit("flow.stuck", { run: live.id, flow: live.flow, step: live.error ? live.error.step : "" }, live, `vyre://${live.space}/flow-run/${live.id}`);
    }
    for (const r of await this.store.listRuns({ state: "waiting", limit: 1000 })) {
      if (!r.waiting || r.waiting.kind !== "task" || r.attention || now - r.updated_at < this.limits.stale_ms) continue;
      await this.#locked(r.id, async () => {
        const cur = await this.store.getRun(r.id);
        if (!cur || cur.state !== "waiting" || cur.attention) return;
        this.#attend(cur, { kind: "stale", step: cur.waiting ? cur.waiting.step : "", message: "a person has not answered yet" });
        await this.store.putRun(cur);
        this.#emit("flow.stale", { run: cur.id, flow: cur.flow }, cur, `vyre://${cur.space}/flow-run/${cur.id}`);
      });
    }
  }

  // ------------------------------------------------------------------ triggers

  /** An event from the log. Starts runs for matching Flows and resumes runs waiting on it. @param {any} env */
  async onEvent(env) {
    const work = [];
    for (const f of await this.#triggerFlows()) {
      if (!triggerScope(f.flow.trigger, env)) continue;
      work.push(this.#start(f, { kind: f.flow.trigger.on, key: String(env.id), event: env }, env));
    }
    work.push(this.#deliver(env));
    return Promise.all(work);
  }

  /**
   * The Space's time zone for schedules: the catalog's `tz`, or UTC. A trigger may name its own (a branch office). @param {any} t @param {any} cat
   * @returns {string}
   */
  #zone(t, cat) { return (t && t.tz) || (cat && cat.tz) || "UTC"; }

  /**
   * When a schedule last ran, from memory or from the store (so a restart remembers). A schedule never seen before starts counting from now: nothing runs retroactively for a Flow
   * that did not exist yet. @param {string} id @param {number} now @returns {Promise<number>}
   */
  async #lastFire(id, now) {
    if (this.lastFire.has(id)) return /** @type {number} */ (this.lastFire.get(id));
    const saved = this.store.getSchedule ? await this.store.getSchedule(id) : null;
    const last = saved ?? now;
    this.lastFire.set(id, last);
    if (saved === null && this.store.putSchedule) await this.store.putSchedule(id, last);
    return last;
  }

  /**
   * Time: start due scheduled Flows, and wake runs whose wait has ended. Call from one timer set to nextWake() (nothing needs it faster than a minute). A schedule that fell due while
   * the server was off runs ONCE when it comes back, with `caught_up` and how many times it skipped; never once per missed tick.
   */
  async tick() {
    await this.#refreshSettings();
    if (this.now() - this.pruneAt >= 3_600_000) { this.pruneAt = this.now(); await this.prune().catch(() => 0); }
    const now = this.now();
    const cat = await this.catalogFn();
    const work = [];
    for (const f of await this.#activeFlows()) {
      const t = f.flow.trigger;
      if (t.on !== "time") continue;
      const tz = this.#zone(t, cat);
      const last = await this.#lastFire(f.id, now);
      if (t.at !== undefined) {
        if (t.at <= now && !(await this.store.getRun(runIdFor(f.id, `${f.id}@${t.at}`)))) work.push(this.#start(f, { kind: "time", key: `${f.id}@${t.at}`, at: t.at }, null));
        continue;
      }
      // A schedule (cron line or interval, in its zone, inside its hours, off holidays) that fell due: once for everything missed (default), once for each time missed, or not for what was missed.
      const { times, more } = dueTimes(t, last, now, tz, this.holidays);
      if (!times.length) continue;
      const rule = t.catch_up || "once";
      const fire = rule === "all" ? times : rule === "skip" ? times.filter(x => now - x < 120_000) : [times[0]];
      const missed = rule === "once" ? times.length - 1 + more : 0;
      const kept = rule === "all" && more > 0 ? times[times.length - 1] : now;   // past the cap, the rest are looked at on the next tick
      this.lastFire.set(f.id, kept); if (this.store.putSchedule) await this.store.putSchedule(f.id, kept);
      for (const due of fire) {
        const late = now - due >= 120_000 || missed > 0;
        work.push(this.#start(f, { kind: "time", key: `${f.id}@${due}`, at: due, ...(t.cron !== undefined || t.hours !== undefined ? { tz } : {}), ...(late ? { caught_up: true, missed } : {}) }, null));
      }
    }
    for (const r of await this.store.listRuns({ state: "waiting", limit: 1000 })) {
      const w = r.waiting;
      if (!w) continue;
      const dl = w.kind === "time" ? w.wake_at : w.deadline;
      if (dl !== undefined && dl <= now) work.push(this.#resume(r.id, { timeout: true }));
    }
    const out = await Promise.all(work);
    await this.#drainQueue();
    await this.#watchdog();
    return out;
  }

  /** The earliest time anything needs waking, so the host sets one timer and never polls. @returns {Promise<number|null>} */
  async nextWake() {
    let best = null;
    const now = this.now();
    const cat = await this.catalogFn();
    const take = (/** @type {number|null|undefined} */ n) => { if (n !== null && n !== undefined && (best === null || n < best)) best = n; };
    for (const f of await this.#activeFlows()) {
      const t = f.flow.trigger;
      if (t.on !== "time") continue;
      const last = await this.#lastFire(f.id, now);
      if (t.cron !== undefined || t.every_ms !== undefined) take(nextFire(t, last, this.#zone(t, cat), this.holidays));
      else if (t.at !== undefined && t.at > now) take(t.at);
    }
    for (const r of await this.store.listRuns({ state: "waiting", limit: 1000 })) if (r.waiting) { take(r.waiting.kind === "time" ? r.waiting.wake_at : r.waiting.deadline); if (r.waiting.kind === "task" && !r.attention) take(r.updated_at + this.limits.stale_ms); }
    for (const r of await this.store.listRuns({ state: "running", limit: 1000 })) if (!r.attention) take(r.updated_at + this.limits.stuck_ms);
    return best;
  }

  /**
   * A watcher found something new. The host that runs watchers (the daemon's watchers module, through kernel/flows/watcher-bridge.js) calls this with each item; every active Flow
   * armed on that watcher starts once per item. The item is data from outside: the run is tainted (`external`), so its outward steps need an Ask naming the source, and it runs under
   * the chain of the person who owns the Flow, narrowed, like any other run. The same item delivered twice is the same run.
   * @param {{ watcher: string, item: any, trust?: 'member'|'external'|'untrusted', key?: string }} w
   * @returns {Promise<{ flow: string, run: string|null, duplicate?: boolean }[]>}
   */
  async watcherItem(w) {
    if (!w || typeof w.watcher !== "string" || w.item === null || typeof w.item !== "object") throw Object.assign(new Error("a watcher item needs the watcher's name and the item"), { code: "bad_input" });
    const trust = w.trust || "external";
    const itemKey = w.key || (w.item.id !== undefined ? `${w.watcher}/${String(w.item.id)}` : `${w.watcher}/${crypto.createHash("sha256").update(canonicalOf(w.item)).digest("hex").slice(0, 24)}`);
    const out = [];
    for (const f of await this.#triggerFlows()) {
      const t = f.flow.trigger;
      if (t.on !== "watcher" || t.watcher !== w.watcher) continue;
      const scope = { trigger: { watcher: w.watcher, item: w.item, at: this.now() } };
      if (t.where) { try { if (!truthy(evaluate(parse(t.where), scope))) continue; } catch { continue; } }
      const r = await this.#start(f, { kind: "watcher", key: itemKey, input: w.item, at: this.now() }, { trust, data: scope.trigger });
      out.push({ flow: f.id, run: r.run, ...(r.duplicate ? { duplicate: true } : {}) });
    }
    return out;
  }

  /**
   * An inbound web call. The host (the Ingress door) has already authenticated it and labelled its trust; the body is data and the run is tainted
   * unless the host says `member`. `key` makes a retried delivery the same run.
   * @param {string} path @param {{ body?: any, key?: string, trust?: 'member'|'external'|'untrusted' }} [req]
   */
  async handleWeb(path, req = {}) {
    const f = (await this.#triggerFlows()).find(x => x.flow.trigger.on === "web" && x.flow.trigger.path === path);
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
    // A model-started run (the chain has an assistant in it) carries model-supplied input: it runs tainted (external), so it can never drive a grant or an admin act, and its record says so.
    const byModel = (callerChain.hops || []).some((/** @type {any} */ h) => h.actor.kind === "agent");
    return this.#start(f, { kind: "manual", key: key || newId("man_"), input: input ?? {} }, { trust: byModel ? "external" : "member", data: input ?? {} });
  }

  /** Wait for every started run to reach a resting state. For tests and for shutdown. */
  async drain() { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  /** Pick up after a restart: re-run what was mid-flight, and apply task results that arrived while we were down. */
  async recover() {
    for (const r of await this.store.listRuns({ state: "running", limit: 1000 })) await this.#exec(r.id);
    await this.#drainQueue();                                  // what was held when the server stopped goes on, if the switch is off
    const waiting = await this.store.listRuns({ state: "waiting", limit: 1000 });
    for (const r of waiting) if (r.waiting && r.waiting.kind === "children") await this.joins.sweep(r.id, r.waiting.step);   // a lane that settled while the server was down
    if (waiting.some(r => r.waiting && r.waiting.kind === "task")) {
      const chain = this.chains.forFlow({ flow: "system", space: waiting[0].space, approver: waiting[0].approver, tainted: false, run: "recover", source_spaces: [waiting[0].space] });
      const evs = await this.k.events.read(chain, { type: "task.*", limit: 5000 });
      for (const e of evs) await this.#deliver(e);
    }
  }

  // ------------------------------------------------------------------ starting a run

  /** @param {any} f @param {{ kind: string, key: string, event?: any, input?: any, path?: string, at?: number, caught_up?: boolean, missed?: number, tz?: string }} trig @param {any} src where the data came from (an event envelope, or { trust, data }) */
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
    // A paused Flow, a paused or draining Space: the trigger is held as a queued run (so a restart keeps it) and runs when the switch is released. Held runs are bounded per Flow; past the cap an event is
    // dropped, counted, and the owner sees the count first (controlState).
    const ctl = await this.#control();
    const hold = f.paused ? "flow_paused" : ctl.mode !== "running" ? ctl.mode : null;
    if (hold) {
      const queued = await this.store.listRuns({ flow: f.id, state: "queued", limit: this.limits.backlog + 1 });
      if (queued.length >= this.limits.backlog) {
        const dropped = { ...(ctl.dropped || {}) }; dropped[f.id] = (dropped[f.id] || 0) + 1;
        await this.#putControl({ ...ctl, dropped });
        this.emitFn("flow.dropped", { flow: f.id, reason: hold, dropped: dropped[f.id] }, { chain: null, subject: `vyre://${f.space}/flow/${f.id}`, corr: "" });
        return { run: null, refused: "backlog" };
      }
    }
    const trust = src && (src.trust || (src.data !== undefined ? "member" : undefined));
    const sourceSpaces = (src && src.source_spaces) || [f.space];
    const tainted = trust === "external" || trust === "untrusted" || sourceSpaces.length > 1;
    /** @type {Run} */
    const run = { id, flow: f.id, version: f.version, hash: f.hash, space: f.space, trigger: recordTrigger(f.flow.trigger, trig, slim),
      tainted, source_spaces: sourceSpaces, depth, state: "running", started_at: now, updated_at: now, steps: {}, approver: f.approver, label: String(f.flow.label || f.flow.name || "").slice(0, 120) };
    const about = recordOfTrigger(trig);
    if (about) run.record = about;
    if (hold) {
      run.state = "queued"; run.queued = { reason: /** @type {any} */ (hold), since: now, seq: ++this.seq };
      await this.store.putRun(run);
      this.#emit("flow.queued", { run: id, flow: f.id, reason: hold }, run, `vyre://${f.space}/flow-run/${id}`);
      return { run: id, queued: true };
    }
    await this.store.putRun(run);
    this.#emit("flow.started", { run: id, flow: f.id, version: f.version, trigger: trig.kind, source: run.trigger.source, tainted }, run, `vyre://${f.space}/flow-run/${id}`);
    // The run executes on its own: a trigger's delivery is not held up by a slow step (one slow Flow must not stop the others' events), and the concurrency gate is what bounds how many go at once.
    this.#detach(id);
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
      if (w.kind === "task" && /^task\./.test(env.type) && env.data && taskIdOf(env) === w.task && TASK_ENDS.has(env.type) && (env.type !== "task.completed" && env.type !== "task.skipped" ? true : ["done", "skipped"].includes(env.data.state))) work.push(this.#taskEnded(r, env));
      else if (w.kind === "event" && w.event && typeMatches(w.event, env.type)) {
        if (w.where) { try { if (!truthy(evaluate(parse(w.where), { event: env, trigger: r.trigger.event ? r.trigger.event.data : r.trigger.input ?? {}, steps: outputs(r) }))) continue; } catch { continue; } }
        work.push(this.#resume(r.id, { event: slim(env) }));
      }
    }
    return Promise.all(work);
  }

  /**
   * A task a run waits on has ended: approved or rejected by its checker, completed by its doer (no checker), or skipped. What the run reads is the task as the kernel holds it now (outcome,
   * and the answer where the kernel or the harness carries one), never only the event, so a rejection (which puts the task back to ready) and an approval read the same way.
   * @param {any} r the waiting run @param {any} env
   */
  async #taskEnded(r, env) {
    let row = null;
    try { row = await this.k.ask.get(this.chains.forFlow({ flow: r.flow, space: r.space, approver: r.approver, tainted: false, run: r.id, source_spaces: r.source_spaces }), taskIdOf(env)); } catch { row = null; }
    const byType = env.type === "task.approved" ? "approved" : env.type === "task.rejected" ? "rejected" : undefined;
    const t = { ...env.data, ...(row ? { state: row.state, outcome: row.outcome, answer: row.answer, output: row.output } : {}) };
    if (t.outcome === undefined || t.outcome === null) t.outcome = byType ?? (t.answer === "yes" ? "approved" : t.answer === "no" ? "rejected" : t.outcome);
    return this.#resume(r.id, { task: t });
  }

  /** @param {string} runId @param {{ task?: any, event?: any, timeout?: boolean }} result */
  async #resume(runId, result) { return this.#locked(runId, () => this.#resumeLocked(runId, result)); }

  /** The resume itself, for a caller that already holds the run's lock. @param {string} runId @param {{ task?: any, event?: any, timeout?: boolean, children?: any[] }} result */
  async #resumeLocked(runId, result) {
    const run = await this.store.getRun(runId);
    if (!run || run.state !== "waiting" || !run.waiting) return;
    const led = run.steps[run.waiting.step];
    if (!led || led.status !== "waiting") return;
    led.wait = { ...(led.wait || {}), result };
    run.state = "running"; run.waiting = undefined; run.updated_at = this.now();
    if (run.attention && run.attention.kind === "device") run.attention = undefined;
    await this.store.putRun(run);
    await this.#execLocked(runId);
  }

  /**
   * Put a paused or failed run back to work after its cause was fixed; finished steps are not repeated (their recorded outputs are used), so the run resumes at the step that failed.
   *   skip     do not run the failed step: it is recorded as skipped. If a later step reads its output (`steps.<id>`), a `value` to use instead is required: typed by the person or accepted from an
   *            agent's proposal, and recorded on the step with who supplied it (`by`). With no value the skip is refused, naming the step.
   *   version  "latest" re-pins the run to the Flow's active version, only if every step already done is still there with the same id and kind; otherwise it is refused, naming the first that is not.
   * @param {string} runId @param {{ skip?: boolean, value?: any, by?: string, version?: 'pinned'|'latest' }} [opts]
   */
  async retry(runId, opts = {}) {
    { const up = await this.joins.retryTarget(runId); if (up) return this.retry(up, opts); }
    // Retry on a run that waits for a Chrome means: try now, do not wait for the Mac to say it is back.
    { const w = await this.store.getRun(runId); if (w && w.state === "waiting" && w.attention && w.attention.kind === "device") return this.#resume(runId, { event: null }); }
    return this.#locked(runId, async () => {
      const run = await this.store.getRun(runId);
      if (run && run.gate) throw Object.assign(new Error("a stage gate is not retried; it moves on by itself when its tasks are done"), { code: "bad_state" });
      if (!run || (run.state !== "paused" && run.state !== "failed")) return;
      const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
      if (opts.version === "latest") {
        const now = await this.store.active(run.flow);
        if (!now) throw fail("not_active", "that Flow has no active version to move to");
        if (now.version !== run.version) {
          /** @type {Map<string, string>} */ const kinds = new Map();
          const note = (/** @type {any} */ st) => kinds.set(st.id, st.kind);
          walkSteps(now.flow.steps || [], note); walkSteps(now.flow.on_failure || [], note);
          for (const [k, l] of Object.entries(run.steps)) {
            if (!l || !["done", "skipped", "failed_handled"].includes(l.status) || k.includes("?")) continue;
            const id = k.replace(/[@!].*$/, "");
            const was = (await this.store.getVersion(run.flow, run.version));
            /** @type {Map<string, string>} */ const old = new Map();
            if (was) { const oldNote = (/** @type {any} */ st) => old.set(st.id, st.kind); walkSteps(was.flow.steps || [], oldNote); walkSteps(was.flow.on_failure || [], oldNote); }
            if (kinds.get(id) !== old.get(id)) throw fail("version_mismatch", `step ${id} was already done, and version ${now.version} ${kinds.has(id) ? `makes it a ${kinds.get(id)} step` : "no longer has it"}: retry on the version the run started on, or start a new run`);
          }
          run.version = now.version; run.hash = now.hash;
        }
      }
      if (opts.skip) {
        const at = run.error && run.error.step;
        const entry = Object.entries(run.steps).find(([k, l]) => l && l.status === "failed" && k.replace(/[@!].*$/, "") === at);
        if (!at || !entry) throw fail("nothing_to_skip", "this run did not stop at a step that can be skipped");
        const def = await this.store.getVersion(run.flow, run.version);
        const readers = def && new RegExp(`steps\\.${at}\\b|steps\\[['"]${at}['"]\\]`).test(JSON.stringify(def.flow));
        if (readers && opts.value === undefined) throw fail("skip_needs_value", `a later step reads what ${at} produces, so skipping it needs a value to use instead (give one, or retry)`);
        run.steps[entry[0]] = { ...entry[1], status: "skipped", output: opts.value === undefined ? null : opts.value, skipped_by: opts.by || null, skipped_at: this.now(), ...(opts.value !== undefined ? { substitute: true } : {}), error: undefined, handling: undefined };
      }
      run.state = "running"; run.error = undefined; run.finished_at = undefined; run.updated_at = this.now(); run.attention = undefined; run.failing = undefined; run.failing_done = undefined; run.failing_error = undefined;
      // A person retrying a run whose write may or may not have gone out has looked and said go: the record that it might have been sent is cleared, so the call is made again.
      // The tries start again, and a failure path that ran for the last failure may run again for the next.
      for (const [k, l] of Object.entries(run.steps)) {
        if (!l) continue;
        if ((l.status === "started" || l.status === "failed") && l.sent_at) l.sent_at = null;
        if (l.status === "failed") { l.tries = 0; l.handling = undefined; }
        if (k.includes("!")) delete run.steps[k];
      }
      await this.store.putRun(run);
      this.#emit("flow.retried", { run: run.id, flow: run.flow, ...(opts.skip ? { skipped: true } : {}), ...(opts.version === "latest" ? { version: run.version } : {}) }, run, `vyre://${run.space}/flow-run/${run.id}`);
      await this.#execLocked(runId);
    });
  }

  /**
   * Stop a run that is not running: paused, failed, waiting or held. It is kept (its ledger and error stay), marked cancelled, and any card it waits on is withdrawn where the kernel can. A run that already finished is left as it is.
   * @param {string} runId @param {{ by?: string, reason?: string }} [o]
   */
  async cancel(runId, o = {}) {
    return this.#locked(runId, async () => {
      const run = await this.store.getRun(runId);
      if (run && run.gate) throw Object.assign(new Error("a stage gate is not cancelled; move the record, or move it on early with flows.advance"), { code: "bad_state" });
      if (!run || !["paused", "failed", "waiting", "queued"].includes(run.state)) return { ok: false, state: run ? run.state : null };
      const w = run.waiting;
      run.state = "cancelled"; run.waiting = undefined; run.queued = undefined; run.finished_at = this.now(); run.updated_at = run.finished_at; run.attention = undefined;
      run.cancelled = { by: o.by || null, at: run.finished_at, ...(o.reason ? { reason: String(o.reason).slice(0, 200) } : {}) };
      await this.store.putRun(run);
      if (w && w.task && this.k.ask && typeof this.k.ask.cancel === "function") { try { await this.k.ask.cancel(this.#chain({ run, cat: null, flow: null }), w.task); } catch { /* the card stays; the run is stopped anyway */ } }
      // what it was waiting on goes with it: its lanes and sub-flows that can be stopped are, and a parent waiting on this one is told
      if (w && w.kind === "children") { const led = run.steps[w.step]; for (const id of (led && led.children) || []) void this.cancel(id, { by: o.by, reason: "its run was stopped" }).catch(() => {}); }
      this.#emit("flow.cancelled", { run: run.id, flow: run.flow, by: o.by || null }, run, `vyre://${run.space}/flow-run/${run.id}`);
      if (run.parent) this.#settled(run);
      return { ok: true, state: "cancelled" };
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
  /**
   * Run a run on its own. Whatever it throws (a store that failed while a run was being written, a bug) ends here: a detached run must never become an unhandled rejection, which would take the whole server down.
   * The run is marked failed if it can be, and the fault is said in an event.
   * @param {string} id
   */
  #detach(id) {
    void this.#exec(id).catch(async (e) => {
      try {
        const r = await this.store.getRun(id);
        if (r && (r.state === "running" || r.state === "queued")) {
          const f = failOf(e);
          r.state = "failed"; r.error = { step: r.error ? r.error.step : "", code: f.code, message: f.message }; r.finished_at = this.now(); r.updated_at = r.finished_at; this.#attend(r, { kind: "failed", step: r.error.step, code: f.code, message: f.message });
          await this.store.putRun(r);
          if (r.parent) this.#settled(r);
        }
      } catch { /* the store is the fault; the next recover() finds the run */ }
      try { this.emitFn("flow.error", { run: id, message: String(e && /** @type {any} */ (e).message || e).slice(0, 200) }, { chain: null, subject: "", corr: id }); } catch { /* said if it can be */ }
    });
  }

  /** @param {string} runId */
  async #execLocked(runId) {
    const run = await this.store.getRun(runId);
    if (!run || run.state !== "running") return;
    const view = await this.store.getVersion(run.flow, run.version);
    if (!view) { run.state = "failed"; run.error = { step: "", code: "gone", message: "the Flow version this run started on no longer exists" }; await this.#finish(run); return; }
    const cat = await this.catalogFn();
    const caps = Array.isArray(view.flow.caps) ? view.flow.caps : deriveCaps(view.flow, cat);
    const ctx = { run, flow: view.flow, view, cat, caps, dry: false, count: 0, runnerPaused: false };
    // A place to execute: the Flow's, the box's and the lock's. Without one the run is held, in order, and starts when a place frees.
    const why = this.#acquire(run, view.flow);
    if (why) { await this.#queue(run, why); return; }
    this.live.set(run.id, run);
    try {
      // A Flow-level failure path was started before a restart: carry on with it, not with the steps that failed.
      if (run.failing) throw new StepFail(run.failing.code, run.failing.message);
      const lane = run.branch ? laneOf(view.flow, run.branch) : null;
      if (run.branch && !lane) throw new StepFail("gone", "the lane this run was started for is no longer in the Flow version it started on");
      await this.#walk(ctx, lane || view.flow.steps, "", {});
      if (!run.branch && view.flow.returns !== undefined) run.result = resolveValue(view.flow.returns, this.#scope(ctx, {}));
      run.state = "done"; run.error = undefined;
      if (run.attention && run.attention.kind !== "verify") run.attention = undefined;
      await this.#finish(run);
    } catch (e) {
      if (e instanceof Hold) { await this.#queue(run, e.reason); return; }
      if (e instanceof Suspend) { run.state = "waiting"; run.updated_at = this.now(); await this.store.putRun(run); return; }
      if (e instanceof PauseFlow) {
        run.state = "paused"; run.error = { step: run.error ? run.error.step : "", code: "paused", message: e.reason }; run.updated_at = this.now();
        this.#attend(run, { kind: "paused", step: run.error.step, code: "paused", message: e.reason });
        await this.store.putRun(run);
        await this.pauseFlow(run.flow, e.reason);
        this.#emit("flow.paused", { run: run.id, flow: run.flow, reason: e.reason }, run, `vyre://${run.space}/flow-run/${run.id}`);
        return;
      }
      const f = failOf(e);
      run.error = { step: run.failing ? run.failing.step : (run.error && run.error.step || ""), code: f.code, message: f.message };
      // The Flow's own failure path runs once, before the run is called failed. A person's answer in it resumes it here, not at the step that failed.
      const failedAt = run.error.step;
      if (Array.isArray(view.flow.on_failure) && view.flow.on_failure.length && !run.failing_done && !run.branch) {
        run.failing = { step: run.error.step, code: f.code, message: f.message };
        await this.store.putRun(run);
        try { await this.#walk(ctx, view.flow.on_failure, "!onfail", { error: { code: f.code, message: f.message, step: run.error.step } }); }
        catch (e2) {
          if (e2 instanceof Suspend) { run.state = "waiting"; run.updated_at = this.now(); await this.store.putRun(run); return; }
          // a failure path that itself fails does not hide the first failure
          run.failing_error = failOf(e2);
        }
        run.failing = undefined; run.failing_done = true;
        run.error = { step: failedAt, code: f.code, message: f.message };   // the failure path's own steps wrote their names here
      }
      run.state = "failed";
      this.#attend(run, { kind: "failed", step: run.error.step, code: f.code, message: f.message });
      await this.#finish(run);
    } finally {
      this.live.delete(run.id);
      this.#release(run);
      void this.#drainQueue();
    }
  }

  /** @param {Run} run */
  async #finish(run) {
    run.finished_at = this.now(); run.updated_at = run.finished_at; run.waiting = undefined;
    await this.store.putRun(run);
    this.#emit("flow.finished", { run: run.id, flow: run.flow, state: run.state, ...(run.error ? { error: run.error } : {}) }, run, `vyre://${run.space}/flow-run/${run.id}`);
    if (run.parent) this.#settled(run);
  }

  /** A lane or a sub-flow settled: its parent may go on. Not waited for here, so this run's lock is not held while the parent runs. @param {Run} run */
  #settled(run) { void this.joins.settled(run).catch(() => { /* the next recover() finds the parent */ }); }

  /** A Flow called by name from a step: the active one, run only with the Flow's own `flows.run` check as for a manual start. @param {any} ctx @param {any} s @param {string} key @param {(v: any) => any} val */
  async #subflow(ctx, s, key, val) {
    const led = this.#led(ctx, key);
    if (ctx.dry || (led && led.children)) return this.joins.subflow(ctx, s, key, val, null);
    const target = (await this.#activeFlows()).find((/** @type {any} */ x) => x.flow.name === s.flow) || null;
    if (!target) return this.joins.subflow(ctx, s, key, val, null);
    return this.#effect(ctx, s, key, { action: "flows.run", resource: `vyre://${ctx.cat.space}/flow/${target.id}` }, () => this.joins.subflow(ctx, s, key, val, target), { input: s.input === undefined ? undefined : val(s.input) });
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
      if (!ctx.dry && this.ctl.mode === "paused") throw new Hold("paused");
      if (++ctx.count > this.limits.steps_per_run) throw new StepFail("too_many_steps", `the run took more than ${this.limits.steps_per_run} steps`);
      await this.#step(ctx, s, s.id + suffix, suffix, locals);
    }
  }

  /** @param {any} ctx @param {string} key */
  #led(ctx, key) { return ctx.run.steps[key]; }

  /** @param {any} ctx */
  #scope(ctx, locals) {
    const run = ctx.run, t = run.trigger;
    const inh = run.inherit;                                 // a lane of a parallel step reads what its parent had read when it split
    const trigger = inh ? inh.trigger : t.kind === "watcher" ? { watcher: String(t.source || "").replace(/^watcher:/, ""), item: t.input ?? {}, at: t.at } : t.event ? (t.event.data ?? {}) : t.input !== undefined ? t.input : t.at !== undefined ? { at: t.at } : {};
    return { trigger, event: inh ? inh.event : t.event || null, steps: { ...(inh ? inh.steps : {}), ...outputs(run) }, run: { id: run.id, depth: run.depth, tainted: run.tainted, flow: run.flow }, now: this.now(), ...(inh ? inh.locals : {}), ...locals };
  }

  /** @param {any} ctx @param {string} key @param {Partial<import('./store.js').Run['steps'][string]>} patch */
  async #mark(ctx, key, patch) {
    const run = ctx.run;
    run.steps[key] = { ...(run.steps[key] || {}), at: this.now(), ...patch };
    run.updated_at = this.now();
    if (run.attention && (run.attention.kind === "stuck" || run.attention.kind === "stale")) run.attention = undefined;   // it moved
    if (!ctx.dry) await this.store.putRun(run);
  }

  /** @param {any} ctx @param {any} s @param {string} key @param {string} suffix @param {Record<string, any>} locals */
  async #step(ctx, s, key, suffix, locals) {
    const run = ctx.run;
    const led = this.#led(ctx, key);
    if (led && (led.status === "done" || led.status === "skipped") && !INLINE_KINDS.has(s.kind)) return;
    if (led && led.status === "failed_handled" && INLINE_KINDS.has(s.kind)) return;
    run.error = { step: s.id, code: "", message: "" }; // names the step in flight; cleared by a clean finish
    const scope = () => this.#scope(ctx, locals);
    const ev = (/** @type {string} */ src) => evaluate(parse(src), scope());
    const val = (/** @type {any} */ v) => resolveValue(v, scope());

    if (s.kind === "decide") {
      await this.#block(ctx, s, key, suffix, locals, scope, async () => {
        let branch = led && led.output && led.output.branch;
        if (!branch) { branch = truthy(ev(s.if)) ? "then" : "else"; await this.#mark(ctx, key, { status: "started", output: { branch } }); }
        await this.#walk(ctx, s[branch] || [], suffix, locals);
        return { branch };
      });
      return;
    }
    if (s.kind === "repeat") {
      await this.#block(ctx, s, key, suffix, locals, scope, async () => {
        let items = led && led.output && led.output.items;
        if (!items) {
          const list = ev(s.over);
          items = Array.isArray(list) ? list.slice(0, Math.min(s.max || SCHEMA_LIMITS.repeatMax, SCHEMA_LIMITS.repeatMax)) : [];
          await this.#mark(ctx, key, { status: "started", output: { items } });
        }
        for (let i = 0; i < items.length; i++) await this.#walk(ctx, s.steps || [], `${suffix}@${i}`, { ...locals, [s.as]: items[i], [`${s.as}_index`]: i });
        return { count: items.length };
      });
      return;
    }

    if (led && led.status === "failed_handled") return;
    const dispatch = async () => {
      /** @type {any} */ let out;
      switch (s.kind) {
        case "find": case "pick": case "filter": out = await this.#read(ctx, s, key, scope()); break;
        case "create": case "update": case "upsert": case "remove": case "stage": out = await this.#write(ctx, s, key, scope(), val); break;
        case "wait": out = await this.#wait(ctx, s, key, val); break;
        case "ask": case "assign": case "agent": out = await this.#task(ctx, s, key, scope(), val); break;
        case "call": { const rides = ridesOf(ctx.flow, s.id, ctx.cat), ride = s.with ? ctx.dry ? "dry" : this.#rideOf(ctx, s) : undefined; out = await this.#effect(ctx, s, key, { action: s.action, resource: s.resource }, async (idem, approval, rules) => {
          if (ctx.dry) return { dry: true };
          if (!this.ports.call) throw new StepFail("unavailable", "this Space has no way to run actions yet");
          // Draft only: the catalog says which action prepares a draft instead of sending (`draft_as`); without one the send does not happen at all.
          const draftAs = rules && rules.draftOnly ? (ctx.cat.actions[s.action] || {}).draft_as : null;
          if (rules && rules.draftOnly && !draftAs) throw new StepFail("draft_only", `a rule of this space allows drafts only${rules.draftOnly.label ? ` (${rules.draftOnly.label})` : ""}, and ${labelOf(ctx.cat, s.action)} has no way to prepare a draft, so nothing was sent`);
          // The approval the person gave for exactly this act is presented WITH it (and the bind of what was approved), so the act's own gate spends the one use; a draft is not the approved send and carries none.
          const input = val(s.input);
          const r = await this.ports.call(this.#chain(ctx), draftAs || s.action, s.resource, input, { idem: draftAs ? `${idem}:draft` : idem, ...(approval && !draftAs ? { approval, bind: actBind({ action: s.action, resource: s.resource, input }), ...(ride ? { ride: { run: ctx.run.id, step: s.id, with: s.with } } : {}) } : {}) });
          return draftAs ? { draft: true, via: draftAs, result: r } : r;
        }, { input: val(s.input), bind: actBind({ action: s.action, resource: s.resource, input: val(s.input) }), rides, ride }); break; }
        case "classify": out = await this.#classify(ctx, s, key, val); break;
        case "extract": out = await this.#extract(ctx, s, key, val); break;
        case "service": out = await this.#service(ctx, s, key, val); break;
        case "fn": out = await this.#fn(ctx, s, key, val); break;
        case "parallel": out = await this.joins.parallel(ctx, s, key, suffix, locals); break;
        case "subflow": out = await this.#subflow(ctx, s, key, val); break;
        default: throw new StepFail("bad_step", `unknown step kind ${s.kind}`);
      }
      return out;
    };
    const t0 = this.now();
    /** @type {any} */ let out;
    if (ctx.dry) out = await dispatch();
    else {
      const r = await this.#guarded(ctx, s, key, suffix, locals, dispatch, scope);
      if (r.handled) return;
      out = r.out;
    }
    await this.#mark(ctx, key, { status: "done", output: out, started_at: (this.#led(ctx, key) || {}).started_at ?? t0, finished_at: this.now(), error: undefined, handling: undefined });
    this.#emit("step.done", { run: run.id, step: key, kind: s.kind }, run, `vyre://${run.space}/flow-run/${run.id}`);
  }

  /**
   * A decide or a repeat under its failure path and its check (f1, f2 on blocks). A step inside that fails for good, or a check that fails, sends the block to its on_fail steps, which read
   * `error`; `then: continue` lets the run go on after them, the default fails the run. Replay-safe like a step: the block's ledger entry records that the failure path was started.
   * @param {any} ctx @param {any} s @param {string} key @param {string} suffix @param {Record<string, any>} locals @param {() => any} scope @param {() => Promise<any>} body
   */
  async #block(ctx, s, key, suffix, locals, scope, body) {
    const run = ctx.run;
    const led0 = this.#led(ctx, key);
    /** @type {{ code: string, message: string } | null} */ let failure = null;
    if (led0 && led0.status === "failed" && led0.handling && s.on_fail) failure = led0.error || { code: "error", message: "failed" };
    if (!failure) {
      try {
        const out = await body();
        const bad = ctx.dry ? null : await this.#verify(ctx, s, key, out, scope);
        if (bad) throw new StepFail("verify_failed", bad);
        await this.#mark(ctx, key, { status: "done", output: { ...((this.#led(ctx, key) || {}).output || {}), ...out } });
        return;
      } catch (e) {
        if (e instanceof Suspend || e instanceof PauseFlow || e instanceof Hold || !s.on_fail) throw e;
        failure = failOf(e);
        await this.#mark(ctx, key, { status: "failed", error: failure, handling: true, finished_at: this.now() });
      }
    }
    await this.#walk(ctx, s.on_fail.steps, `${suffix}!${s.id}`, { ...locals, error: { code: failure.code, message: failure.message, step: s.id } });
    run.error = { step: s.id, code: failure.code, message: failure.message };
    if (s.on_fail.then === "continue") {
      await this.#mark(ctx, key, { status: "failed_handled", output: { failed: true, error: failure }, handling: undefined, finished_at: this.now() });
      this.#emit("step.failed-handled", { run: run.id, step: key, code: failure.code }, run, `vyre://${run.space}/flow-run/${run.id}`);
      return;
    }
    throw new StepFail(failure.code, failure.message);
  }

  /**
   * One step under its policy (f1, f2): a time limit on each attempt, retries of a fault that is worth retrying (with a durable wait between, so a restart loses nothing and repeats nothing), then the
   * step's VERIFY, then, if it still failed, its failure path. Replay-safe: the number of tries and the fact that a failure path was started are in the step's ledger entry.
   * @param {any} ctx @param {any} s @param {string} key @param {string} suffix @param {Record<string, any>} locals @param {() => Promise<any>} dispatch @param {() => any} scope
   * @returns {Promise<{ out?: any, handled?: boolean }>}
   */
  async #guarded(ctx, s, key, suffix, locals, dispatch, scope) {
    const run = ctx.run;
    const pol = this.#policyOf(ctx, s);
    let led = this.#led(ctx, key);
    /** @type {{ code: string, message: string } | null} */ let failure = null;
    if (led && led.status === "failed" && led.handling && s.on_fail) failure = led.error || { code: "error", message: "failed" };
    while (!failure) {
      try {
        const out = await this.#withTimeout(pol.timeout_ms, dispatch, s);
        const bad = await this.#verify(ctx, s, key, out, scope);
        if (bad) throw new StepFail("verify_failed", bad);
        return { out };
      } catch (e) {
        if (e instanceof Suspend || e instanceof PauseFlow || e instanceof Hold) throw e;
        const f = failOf(e);
        led = this.#led(ctx, key);
        const tries = ((led && led.tries) || 0) + 1;
        const log = [...((led && led.attempts_log) || []), { at: this.now(), code: f.code }].slice(-8);
        if (f.code !== "verify_failed" && pol.retryOn.has(f.code) && tries < pol.attempts) {
          await this.#mark(ctx, key, { status: "started", tries, last_error: f, attempts_log: log });
          const wait = pol.backoff_ms.length ? pol.backoff_ms[Math.min(tries - 1, pol.backoff_ms.length - 1)] : 0;
          await this.#sleepOnce(ctx, `${key}?retry${tries}`, wait);   // suspends the run until the wake; the replay then tries again
          continue;
        }
        failure = f;
        await this.#mark(ctx, key, { status: "failed", error: f, tries, attempts_log: log, handling: Boolean(s.on_fail), started_at: (led && led.started_at) ?? this.now(), finished_at: this.now() });
      }
    }
    // it failed for good
    if (!s.on_fail) throw new StepFail(failure.code, failure.message);
    await this.#walk(ctx, s.on_fail.steps, `${suffix}!${s.id}`, { ...locals, error: { code: failure.code, message: failure.message, step: s.id } });
    run.error = { step: s.id, code: failure.code, message: failure.message };   // the handler's steps wrote their own names here
    if (s.on_fail.then === "continue") {
      await this.#mark(ctx, key, { status: "failed_handled", output: { failed: true, error: failure }, handling: undefined, finished_at: this.now() });
      this.#emit("step.failed-handled", { run: run.id, step: key, code: failure.code }, run, `vyre://${run.space}/flow-run/${run.id}`);
      return { handled: true };
    }
    throw new StepFail(failure.code, failure.message);
  }

  /** The time limit, retry and the codes worth retrying for one step: the step's own words over the kind's defaults. @param {any} ctx @param {any} s */
  #policyOf(ctx, s) {
    const base = this.policy[s.kind] || {};
    const read = s.kind === "service" && ["GET", "HEAD"].includes(String(s.method || "GET").toUpperCase());
    let attempts = Math.min(read && base.readAttempts ? base.readAttempts : base.attempts ?? 1, this.retryCap);
    let backoff = base.backoff_ms || [];
    let on = new Set(RETRY_CODES);
    if (s.retry === false) attempts = 1;
    else if (s.retry && typeof s.retry === "object") {
      if (s.retry.attempts !== undefined) attempts = s.retry.attempts;
      if (s.retry.backoff_ms !== undefined) backoff = Array.isArray(s.retry.backoff_ms) ? s.retry.backoff_ms : [s.retry.backoff_ms];
      if (Array.isArray(s.retry.on)) on = new Set(s.retry.on);
    }
    const timeout = s.kind === "wait" || ["ask", "assign", "agent"].includes(s.kind) ? 0 : (s.timeout_ms ?? base.timeout_ms ?? 0);
    return { timeout_ms: timeout, attempts: Math.max(1, attempts), backoff_ms: backoff, retryOn: on };
  }

  /** @template T @param {number} ms @param {() => Promise<T>} fn @param {any} s @returns {Promise<T>} */
  #withTimeout(ms, fn, s) {
    if (!ms) return fn();
    /** @type {any} */ let timer;
    return Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new StepFail("timeout", `step ${s.id} took longer than ${describeSpan(ms)}`)), ms); if (timer.unref) timer.unref(); })]).finally(() => clearTimeout(timer));
  }

  /**
   * A step's VERIFY, evaluated right after it acted: an expression over its output (and everything a step can read), or a read-back of the record it wrote. Returns the words of what is wrong, or null.
   * An essential check that fails fails the step; an optional one is only written on the ledger and raises the Flow's attention.
   * @param {any} ctx @param {any} s @param {string} key @param {any} out @param {() => any} scope
   */
  async #verify(ctx, s, key, out, scope) {
    const v = s.verify;
    if (!v) return null;
    let problem = null;
    if (v.check !== undefined) {
      let ok = false;
      try { ok = truthy(evaluate(parse(v.check), { ...scope(), output: out })); } catch { ok = false; }
      if (!ok) problem = v.say || `the check ${v.check} did not hold`;
    }
    if (!problem && v.readback === true && out && out.record && out.record.id && s.type) {
      const want = s.kind === "stage" ? null : this.#valuesOf(s, scope);
      const cur = await this.k.records.get(this.#chain(ctx), s.type, out.record.id).catch(() => null);
      if (!cur) problem = v.say || `the ${s.type} record could not be read back`;
      else if (want) {
        const data = cur.data || {};
        const off = Object.keys(want).filter(k => JSON.stringify(data[k] ?? null) !== JSON.stringify(want[k] ?? null));
        if (off.length) problem = v.say || `the saved ${s.type} differs from what was written in: ${off.join(", ")}`;
      }
    }
    if (!problem) { await this.#mark(ctx, key, { verify: { ok: true } }); return null; }
    if (v.essential === false) {
      await this.#mark(ctx, key, { verify: { ok: false, say: problem } });
      this.#attend(ctx.run, { kind: "verify", step: s.id, code: "verify_failed", message: problem });
      this.#emit("step.verify-failed", { run: ctx.run.id, step: key, essential: false }, ctx.run, `vyre://${ctx.run.space}/flow-run/${ctx.run.id}`);
      return null;
    }
    await this.#mark(ctx, key, { verify: { ok: false, say: problem } });
    return problem;
  }

  /** The fields a write step set, resolved, for a read-back. @param {any} s @param {() => any} scope */
  #valuesOf(s, scope) { try { return s.set ? resolveValue(s.set, scope()) : s.match ? { ...resolveValue(s.match, scope()), ...(s.set ? resolveValue(s.set, scope()) : {}) } : null; } catch { return null; } }

  /**
   * Something needs a person's eye: a failed run, a stuck one, a check that failed. One field on the run (`attention`), set where the fault is found and cleared on progress, so the inbox,
   * the health line and the timeline all read the same thing.
   * @param {Run} run @param {{ kind: 'failed'|'stuck'|'stale'|'verify'|'paused', step?: string, code?: string, message: string }} a
   */
  #attend(run, a) { run.attention = { ...a, since: run.attention && run.attention.kind === a.kind && run.attention.step === a.step ? run.attention.since : this.now() }; }

  /** @param {any} ctx */
  #chain(ctx) {
    if (ctx.actAs) return ctx.actAs;
    const r = ctx.run;
    return this.chains.forFlow({ flow: r.flow, space: r.space, approver: r.approver, tainted: r.tainted, run: r.id, source_spaces: r.source_spaces });
  }

  // ------------------------------------------------------------------ authority

  /** The approved task of the earlier send a step rides (`with`), or nothing when that step asked nobody: then this step asks for itself. @param {any} ctx @param {any} s @returns {string | undefined} */
  #rideOf(ctx, s) {
    // A run that has read content from outside, or a Flow a model drafted, is asked about every send: what the later send says or goes to may come from that content, which the earlier yes never saw.
    if (ctx.run.tainted || ctx.flow.authorship === "model") return undefined;
    const e = ctx.run.steps[`${s.with}?ask`]; return e && e.status === "done" && typeof e.task === "string" ? e.task : undefined;
  }

  /**
   * Check the caps, ask the kernel, and handle ask and deny. Runs `act(idem)` only when the step may go ahead. The ledger records "started" before
   * the act and the caller records "done" after, so a crash in between replays the act with the same idempotency key.
   * @param {any} ctx @param {any} s @param {string} key @param {{ action: string, resource: string }} need
   * @param {(idem: string, approval?: string, rules?: { draftOnly?: { rule?: string, label?: string } }) => Promise<any>} act @param {{ input?: any, input_class?: string, bind?: string, rides?: { step: string, action: string, resource: string, line: string }[], ride?: string }} [info]
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
      await this.#mark(ctx, askKey, { status: approved ? "done" : "failed", output: { outcome: res.task && res.task.outcome }, answered: { by: res.task ? (res.task.checked_by ?? res.task.by ?? (res.task.checker && res.task.checker.id) ?? (res.task.doer && res.task.doer.id) ?? null) : null, at: this.now() } });
      if (!approved) throw new StepFail("refused", `a person said no to step ${s.id}`);
    }
    const approvedTask = (info.ride && info.ride !== "dry" ? info.ride : undefined) || (run.steps[askKey] && run.steps[askKey].status === "done" ? run.steps[askKey].task : undefined);
    // An approved act is the task's DOER's to carry out (the approval is a single-use authority for exactly that act, given to the doer: the Flows service under the approver): the run presents the approval
    // as the doer, and this check only looks at it (peek): the act's own gate below it spends the one use.
    const doerChain = approvedTask && this.chains.forDoer ? this.chains.forDoer({ flow: run.flow, space: run.space, approver: run.approver, run: run.id }) : null;
    // A registered tool a Flow may run (a module flow.steps entry, in the catalog with `tool: true`) is not a kernel action: a read runs, an outward one is held for the person's yes and then runs
    // with that approval, which the host spends once at the call (the task store's `useApproval`). Anything else asks the kernel.
    const isTool = Boolean((ctx.cat.actions[need.action] || {}).tool);
    const d = isTool ? { effect: risk === "read" ? "allow" : approvedTask ? "allow" : "ask", obligations: [], decision: null, reason: "ok" } : await this.k.authorize({ chain: doerChain || chain, action: need.action, resource: need.resource, ...(info.input_class ? { input_class: info.input_class } : {}), ...(approvedTask ? { approval: approvedTask, peek: true, ...(info.bind ? { bind: info.bind } : {}) } : {}) });
    let effect = d.effect;
    // Standing rules for the space (DESIGN-flows-joints 5a, enforced in the kernel's authorize): a rule only tightens, and its refusal names itself.
    const obl = Array.isArray(d.obligations) ? d.obligations : [];
    const draftOnly = obl.find((/** @type {any} */ o) => o && o.type === "draft_only");
    const alwaysAsk = obl.find((/** @type {any} */ o) => o && o.type === "ask" && o.waivable === false);
    const forced = !approvedTask && effect === "allow" && ((run.tainted && (OUTWARD.has(risk) || risk === "grant")) || (ctx.flow.authorship === "model" && ctx.view && (flowUsesComputedOutward(ctx) && OUTWARD.has(risk))));
    if (forced) effect = "ask";
    if (effect === "deny") {
      this.#note(ctx, s, `denied: ${d.rule && d.rule.label ? d.rule.label : d.reason}`);
      if (d.rule && d.reason === "rule_never") throw new StepFail("rule_never", `a rule of this space does not allow this: ${d.rule.label || "never"}`);
      if (PAUSE_REASONS.has(d.reason)) throw new PauseFlow(`${nameOf(run.approver)} can no longer ${labelOf(ctx.cat, need.action)} (${d.reason.replace(/_/g, " ")}); the Flow is paused until that is fixed`);
      throw new StepFail(d.reason || "denied", `not allowed: ${d.reason}`);
    }
    if (effect === "ask" && !approvedTask) {
      if (ctx.dry) { if (!info.ride) ctx.dryAsks = (ctx.dryAsks || 0) + 1; }
      else {
        const why = forced ? (run.tainted ? "it started from content outside this Space" : "a model drafted this Flow") : "it needs a person's yes";
        // A held act is a task the Flow's own service does (it asks) and a person CHECKS: the person's approve or reject is the answer, with their presence, as for any approval. An always-ask
        // rule is answered BY the person or role it names, every time, with no "don't ask again": the task says so and carries the rule.
        const namedChecker = alwaysAsk && alwaysAsk.approver ? (alwaysAsk.approver.person ? { kind: "person", id: alwaysAsk.approver.person, space: run.space } : alwaysAsk.approver.role ? { role: alwaysAsk.approver.role } : null) : null;
        const doerChain = this.chains.forDoer ? this.chains.forDoer({ flow: run.flow, space: run.space, approver: run.approver, run: run.id }) : null;
        const reason = alwaysAsk ? (d.rule && d.rule.label) || "a rule of this space asks every time" : why;
        const task = await this.k.ask.request(chain, { title: cardTitle(ctx.view.flow.label || ctx.view.flow.name, labelOf(ctx.cat, need.action), info.rides || []),
          ...(doerChain ? { doer: { kind: "service", id: "flows", space: run.space }, checker: namedChecker || run.approver } : { doer: namedChecker && namedChecker.kind ? namedChecker : run.approver }),
          output: { kind: "decision" }, source: "flow_step",
          form: { kind: "held_act", flow: run.flow, run: run.id, step: s.id, action: need.action, resource: need.resource, why: reason, trigger_source: run.trigger.kind, input: info.input ?? null,
            ...(info.bind ? { bind: info.bind } : {}),
            ...(info.rides && info.rides.length ? { rides: info.rides } : {}),
            ...(alwaysAsk ? { rule: alwaysAsk.rule, waivable: false, ...(alwaysAsk.approver && alwaysAsk.approver.role ? { approver_role: alwaysAsk.approver.role } : {}) } : {}) } }, { idem: `${run.id}:${askKey}` });
        if (doerChain) {
          // the Flow's service asks: it does the task (a yes with its reason), which puts it in front of the checker; a replay finds it already started
          for (const [step, arg] of [["start"], ["complete", { answer: "yes", reason: String(reason).slice(0, 300) || "needs a person's yes" }]]) {
            try { await (step === "start" ? this.k.ask.start(doerChain, task.id) : this.k.ask.complete(doerChain, task.id, arg)); } catch (e) { if (!e || !["bad_state", "not_allowed"].includes(/** @type {any} */ (e).code)) throw e; }
          }
        }
        await this.#mark(ctx, askKey, { status: "waiting", task: task.id, wait: { kind: "task", task: task.id } });
        run.waiting = { step: askKey, kind: "task", task: task.id };
        this.#emit("step.waiting", { run: run.id, step: key, task: task.id, why }, run, `vyre://${run.space}/flow-run/${run.id}`);
        throw new Suspend();
      }
    }
    if (!ctx.dry) await this.#mark(ctx, key, { status: "started", ...(info.input !== undefined ? { input: showable(info.input) } : {}) });
    if (ctx.dry) ctx.dryEffects = [...(ctx.dryEffects || []), { step: s.id, action: need.action, resource: need.resource, risk, effect }];
    // Draft only: the action is prepared as a draft in the outside system and NEVER sent, even with an approval in hand.
    ctx.actAs = doerChain;
    try { return await act(`${run.id}:${key}`, approvedTask, draftOnly ? { draftOnly: { rule: draftOnly.rule, label: d.rule && d.rule.label } } : undefined); } finally { ctx.actAs = null; }
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
    return this.#effect(ctx, s, key, need, async (idem, approval, rules) => {
      if (ctx.dry) return { dry: true, response: { status: 0 } };
      if (!this.ports.service) throw new StepFail("unavailable", "this Space has no connectors yet");
      // Draft only: the connector's own draft operation (`draft: { method, path }` on the connector in the catalog) replaces the send, with the same body; no draft operation, no call.
      let req = request, asDraft = false;
      if (rules && rules.draftOnly) {
        const dr = ctx.cat.connectors && ctx.cat.connectors[s.connector] && /** @type {any} */ (ctx.cat.connectors[s.connector]).draft;
        if (!dr || typeof dr.path !== "string") throw new StepFail("draft_only", `a rule of this space allows drafts only${rules.draftOnly.label ? ` (${rules.draftOnly.label})` : ""}, and ${s.connector} has no way to prepare a draft, so nothing was sent`);
        req = { ...request, method: dr.method || "POST", path: dr.path, ...(typeof dr.wrap === "string" && request.body !== undefined ? { body: { [dr.wrap]: request.body } } : {}) }; asDraft = true;
      }
      // Safe outside writes (the connector's declaration, kernel/flows/safe-write.js). A connector that declares nothing keeps the old behaviour: the route rules decide and the vault dedupes by key.
      const conn = /** @type {any} */ (ctx.cat.connectors && ctx.cat.connectors[s.connector]);
      const declared = !asDraft && isDeclared(conn);
      const method = String(req.method || "GET").toUpperCase();
      const op = declared ? opFor(conn, method, req.path) : null;
      const write = op ? !op.read : method !== "GET" && method !== "HEAD";
      const run = ctx.run;
      const led = this.#led(ctx, key) || {};
      /** @type {any} */ let r;
      if (declared && write && led.written) {
        // The write was done before the server stopped: it is NOT sent again; only what is missing after it (the read-back) is finished.
        r = { status: led.written.status, ok: led.written.ok, headers: led.written.headers || {}, body: led.written.body ?? "" };
      } else {
        // A 429 or 503 the provider asked us to wait out: the run sleeps until then (it survives a restart), then the same step sends again with the same key.
        if (declared && led.backoff) await this.#sleepOnce(ctx, led.backoff, 0);
        // A write whose outcome the ledger cannot tell (sent, never recorded) is repeated only where the provider takes an idempotency key. Otherwise it is not sent again: a duplicate matter or payment
        // is worse than a Flow that stopped and told the owner.
        if (declared && write && led.sent_at && !takesKey(conn, op)) {
          await this.#alert(ctx, `${ctx.view.flow.label || ctx.view.flow.name}: check ${s.connector} before this goes again`, { kind: "outcome_unknown", flow: run.flow, run: run.id, step: s.id, connector: s.connector, method, path: req.path }, `${run.id}:${key}:unknown`);
          throw new StepFail("outcome_unknown", `the call ${method} ${req.path} to ${s.connector} may or may not have gone through before the server stopped, and ${s.connector} takes no idempotency key, so it was not sent again; check it, then retry the run`);
        }
        // The provider's own idempotency header is added by the vault from this key (connector.idempotency); the runner keeps passing `idem` and records it.
        const sendReq = req, sendIdem = idem;
        // The key and the attempt are in the ledger BEFORE the call, so a crash after the send leaves a record that it may have gone out.
        if (declared && write) await this.#mark(ctx, key, { idem: sendIdem, attempts: (led.attempts || 0) + 1, sent_at: this.now() });
        try {
          r = /** @type {any} */ (await this.ports.service({ chain: this.#chain(ctx), connector: s.connector, request: sendReq, idem: asDraft ? `${sendIdem}:draft` : sendIdem, ...(asDraft ? { draft: true } : {}), ...(approval && !asDraft ? { approval } : {}) }));
        } catch (e) {
          // The vault waited out the provider's Retry-After as far as it would and gave up (`rate_limited`, `retryAfter` seconds): nothing was done, so the run sleeps that long and sends again.
          const x = /** @type {any} */ (e);
          if (!(declared && x && x.code === "rate_limited" && (led.attempts || 0) + 1 < 6)) throw e;
          const rkey = `${key}?retry${(led.attempts || 0) + 1}`;
          await this.#mark(ctx, key, { sent_at: null, backoff: rkey });
          await this.#sleepOnce(ctx, rkey, Math.max(1, Number(x.retryAfter) || 5) * 1000);
          throw e;
        }
        // A website Connection run on the person's own Chrome through a Mac that is off: the run WAITS (the durable wait, the same one a person or a timer uses) and wakes when the Mac comes online.
        if (r && deviceOffline(r)) await this.#awaitDevice(ctx, key, deviceOffline(r));
        if (r && r.held) throw new StepFail("held", `the vault is holding the call to ${s.connector} for a person's yes${r.summary ? ` (${String(r.summary).slice(0, 120)})` : ""}`);
        // A 503 can come AFTER the provider did the work, so a write that cannot be repeated safely (no idempotency key) is never sent again on one: it stops and tells the owner, as after a crash.
        // A 429 is a refusal before anything happened, and a read has nothing to duplicate, so those wait and go again.
        if (declared && write && r && r.status === 503 && !takesKey(conn, op)) {
          await this.#alert(ctx, `${ctx.view.flow.label || ctx.view.flow.name}: check ${s.connector} before this goes again`, { kind: "outcome_unknown", flow: run.flow, run: run.id, step: s.id, connector: s.connector, method, path: req.path }, `${run.id}:${key}:unknown`);
          throw new StepFail("outcome_unknown", `${s.connector} answered 503 to ${method} ${req.path}, which may have been done already, and ${s.connector} takes no idempotency key, so it was not sent again; check it, then retry the run`);
        }
        if (declared && r && (r.status === 429 || r.status === 503) && (led.attempts || 0) + 1 < 6) {
          const lower = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
          const wait = retryAfterMs(lower, this.now()) ?? (r.status === 429 ? 5000 * ((led.attempts || 0) + 1) : null);
          if (wait !== null) {
            // refused, so nothing was done: it is safe to send again after the wait
            const rkey = `${key}?retry${(led.attempts || 0) + 1}`;
            await this.#mark(ctx, key, { sent_at: null, backoff: rkey });
            await this.#sleepOnce(ctx, rkey, wait);
          }
        }
        if (declared && write && r && r.status >= 200 && r.status < 300 && !r.saved) {
          const body = typeof r.body === "string" && r.body.length <= SERVICE_BODY_CAP ? r.body : undefined;
          await this.#mark(ctx, key, { sent_at: null, written: { status: Number(r.status), ok: true, headers: r.headers || {}, ...(body !== undefined ? { body } : {}) } });
        }
      }
      ctx.run.tainted = true; // what came back is content from outside
      if (r && r.saved) return { saved: { path: String(r.saved.path), version: r.saved.version, size: r.saved.size, sha256: r.saved.sha256 } };
      const headers = Object.fromEntries(Object.entries((r && r.headers) || {}).filter(([k]) => !/^(set-cookie|authorization|proxy-authenticate|www-authenticate|x-api-key)$/i.test(k)).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const raw = r && typeof r.body === "string" ? Buffer.from(r.body, "base64").toString("utf8") : "";
      const text = raw.length > SERVICE_BODY_CAP ? raw.slice(0, SERVICE_BODY_CAP) : raw;
      let json = null;
      if (/json/i.test(headers["content-type"] || "") && raw.length <= SERVICE_BODY_CAP) { try { json = JSON.parse(raw); } catch { json = null; } }
      // Read-back: the connector pairs this write with a read; the record is read again and the fields it names compared with what was sent. A difference stops the Flow and tells the owner.
      /** @type {any} */ let readback;
      if (op && write && op.readback && r && r.status >= 200 && r.status < 300) {
        const pair = readbackRequest(op, req, json);
        const mismatch = async (/** @type {string} */ why) => {
          const reason = `${s.connector} did not keep what step ${s.id} wrote (${why})`;
          await this.#alert(ctx, `${ctx.view.flow.label || ctx.view.flow.name} was stopped: ${s.connector} does not match what was sent`, { kind: "readback_mismatch", flow: run.flow, run: run.id, step: s.id, connector: s.connector, why }, `${run.id}:${key}:readback`);
          await this.pauseFlow(run.flow, reason);
          throw new StepFail("readback_mismatch", `${reason}; the Flow is paused`);
        };
        if (pair === null) await mismatch("the answer to the write did not carry what the read-back needs, so it could not be read back");
        const rr = /** @type {any} */ (await this.ports.service({ chain: this.#chain(ctx), connector: s.connector, request: { method: pair.method, path: pair.path }, idem: `${idem}:readback` }));
        const rraw = rr && typeof rr.body === "string" ? Buffer.from(rr.body, "base64").toString("utf8") : "";
        let rjson = null; try { rjson = JSON.parse(rraw); } catch { rjson = null; }
        if (!rr || !(rr.status >= 200 && rr.status < 300)) await mismatch(`reading it back answered ${rr ? rr.status : "nothing"}`);
        const cmp = compareReadback(op, req, rjson, json);
        if (!cmp.ok) await mismatch(`these fields differ: ${cmp.mismatches.map(m => m.field).join(", ")}`);
        readback = { ok: true, path: pair.path, checked: Object.keys((op.readback && op.readback.compare) || {}).length };
      }
      return { ...(asDraft ? { draft: true } : {}), response: { status: Number(r && r.status) || 0, ok: Boolean(r && (r.ok ?? (r.status >= 200 && r.status < 300))), headers, body: text, json, truncated: raw.length > SERVICE_BODY_CAP }, ...(readback ? { readback } : {}), ...(files.length ? { files } : {}) };
    }, { input: request.body === undefined ? null : request.body, bind: requestBind({ connector: s.connector, method: String(s.method || "GET"), path: request.path, query: request.query, body: request.body, headers: request.headers, upload: request.upload, saveTo: request.saveTo }) });
  }

  /**
   * Sleep inside a step: the run is suspended until `ms` from now and the same step runs again when it wakes (the timer wakes it, a restart keeps it). The sleep has its own ledger entry,
   * so a second pass finds it done and goes on.
   * @param {any} ctx @param {string} rkey @param {number} ms
   */
  async #sleepOnce(ctx, rkey, ms) {
    const now = this.now();
    const l = this.#led(ctx, rkey);
    if (l && l.status === "done") return;
    if (l && l.status === "waiting") {
      if (l.wait && (l.wait.result || l.wait.until <= now)) { await this.#mark(ctx, rkey, { status: "done" }); return; }
      throw this.#suspendOn(ctx, rkey, l.wait);
    }
    if (ms <= 0) return;
    const wait = { kind: "time", until: now + Math.min(ms, this.limits.wait_max_ms) };
    await this.#mark(ctx, rkey, { status: "waiting", wait });
    this.#emit("step.waiting", { run: ctx.run.id, step: rkey, until: wait.until }, ctx.run, `vyre://${ctx.run.space}/flow-run/${ctx.run.id}`);
    throw this.#suspendOn(ctx, rkey, wait);
  }

  /** Put a card in front of the Flow's approver, once per key: the way a stopped Flow tells its owner. @param {any} ctx @param {string} title @param {any} form @param {string} idem */
  async #alert(ctx, title, form, idem) {
    const run = ctx.run;
    const chain = this.chains.forFlow({ flow: run.flow, space: run.space, approver: run.approver, tainted: false, run: run.id, source_spaces: [run.space] });
    await this.k.ask.request(chain, { title, doer: run.approver, output: { kind: "decision" }, source: "flow_step", form }, { idem });
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
        // (a Kit being tried out reads types the Space does not have yet: those read as empty)
        const page = await this.k.records.query(this.#chain(ctx), s.type, { ...(pushed ? { filter: pushed } : {}), ...(s.sort ? { sort: s.sort } : {}), page: { limit: Math.min(200, this.limits.scan - scanned), ...(cursor ? { cursor } : {}) } }).catch((/** @type {any} */ e) => { if (ctx.softReads) return { rows: [], next_cursor: null }; throw e; });
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
    this.#emit("step.waiting", { run: ctx.run.id, step: key, until: wait.until ?? wait.deadline }, ctx.run, `vyre://${ctx.run.space}/flow-run/${ctx.run.id}`);
    throw this.#suspendOn(ctx, key, wait);
  }

  /**
   * The Chrome this step needs is on a Mac that is off. The run waits on the event "link.mac-online" with a deadline (the longest wait a Flow may have), shows as one card that needs the person
   * ("Needs your Chrome", with Retry to try now and Stop to end it), and tries the same step again when it wakes. If the deadline passes it fails plainly.
   * @param {any} ctx @param {string} key @param {string} message
   */
  async #awaitDevice(ctx, key, message) {
    const dk = `${key}?device`;
    const l = this.#led(ctx, dk);
    if (l && l.status === "waiting" && l.wait && l.wait.result && l.wait.result.timeout) throw new StepFail("device_offline", "the Chrome this step needs did not come online in time");
    const wait = { kind: "event", event: "link.mac-online", deadline: this.now() + this.limits.wait_max_ms };
    await this.#mark(ctx, dk, { status: "waiting", wait });
    this.#attend(ctx.run, { kind: "device", step: key, message: `Needs your Chrome: ${message}` });
    this.#emit("step.waiting", { run: ctx.run.id, step: dk, until: wait.deadline }, ctx.run, `vyre://${ctx.run.space}/flow-run/${ctx.run.id}`);
    throw this.#suspendOn(ctx, dk, wait);
  }

  /** @param {any} ctx @param {string} key @param {any} wait */
  #suspendOn(ctx, key, wait) {
    ctx.run.waiting = wait.kind === "time" ? { step: key, kind: "time", wake_at: wait.until } : wait.kind === "task" ? { step: key, kind: "task", task: wait.task, ...(wait.deadline ? { deadline: wait.deadline } : {}) } : wait.kind === "children" ? { step: key, kind: "children" } : { step: key, kind: "event", event: wait.event, where: wait.where, deadline: wait.deadline };
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
      return { task: led.task, state: t.state, outcome: t.outcome ?? null, answer: t.answer ?? null, output: t.output ?? null, ...(led.chosen ? { chosen: led.chosen } : {}) };
    }
    const who = s.kind === "agent" ? s.assistant : s.to;
    const need = { action: "ask.request", resource: `vyre://${ctx.cat.space}/task/*` };
    return this.#effect(ctx, s, key, need, async idem => {
      if (ctx.dry) { ctx.dryTasks = [...(ctx.dryTasks || []), { step: s.id, to: who, kind: s.kind }]; return { dry: true, task: "sim_" + key }; }
      const title = String(val(s.title) ?? "");
      const record = s.record !== undefined ? urnOf(ctx, val(s.record), s.type) : undefined;
      const { doer, helpers, why } = await this.#actor(ctx, who, { skills: s.skills, record });
      const spec = s.kind === "ask"
        ? { title, doer, ...(helpers.length ? { helpers } : {}), output: { kind: "decision" }, source: "flow_step", ...(record ? { record } : {}), ...(s.form ? { form: s.form } : {}) }
        : { title, doer, ...(helpers.length ? { helpers } : {}), output: s.output, how: s.kind === "agent" ? "assistant" : s.how, ...(s.template ? { template: s.template } : {}), ...(s.checker ? { checker: await this.#checker(ctx, s.checker) } : {}), source: "flow_step", ...(record ? { record } : {}), ...(s.kind === "agent" ? { form: { instructions: String(val(s.instructions) ?? "") } } : {}) };
      // A task given to a role or a pool says who was chosen and why, on the task itself (what its doer sees) and on the run
      const withWhy = why ? { ...spec, form: { ...(spec.form || {}), chosen: why } } : spec;
      // (the task keeps `flow` as text: the Flow that gave it; an object here was stored as "[object Object]")
      const task = await this.k.ask.request(this.#chain(ctx), { ...withWhy, flow: run.flow }, { idem });
      if (why) this.#emit("step.assigned", { run: run.id, step: key, doer: doer.id, why }, run, `vyre://${run.space}/flow-run/${run.id}`);
      if (!awaiting) return { task: task.id, ...(why ? { chosen: { doer: doer.id, why } } : {}) };
      await this.#mark(ctx, key, { status: "waiting", task: task.id, ...(why ? { chosen: { doer: doer.id, why } } : {}), wait: { kind: "task", task: task.id } });
      this.#emit("step.waiting", { run: run.id, step: key, task: task.id }, run, `vyre://${run.space}/flow-run/${run.id}`);
      throw this.#suspendOn(ctx, key, { kind: "task", task: task.id });
    }, { input: s.kind === "agent" ? val(s.instructions) : val(s.title) });
  }

  /**
   * Who does a task. A person or a teammate is named; a role or a pool is CHOSEN: of its candidates, the ones with the skills the step asks for, then the one who has worked most on this record,
   * then the lightest open workload (kernel/flows/assign.js), and the choice comes back with its reason. With no skills and no signals the first holder is chosen, and a role's other
   * holders help, as before.
   * @param {any} ctx @param {string} ref @param {{ skills?: string[], record?: string }} [o] @returns {Promise<{ doer: ActorRef, helpers: ActorRef[], why?: string }>}
   */
  async #actor(ctx, ref, o = {}) {
    const space = ctx.run.space;
    const [kind, ...rest] = String(ref).split(":");
    const name = rest.join(":");
    if (kind === "person") return { doer: { kind: "person", id: name, space }, helpers: [] };
    if (kind === "teammate") return { doer: { kind: "agent", id: name, space }, helpers: [] };
    /** @type {{ actor: ActorRef, name?: string, skills?: string[] }[]} */ let candidates;
    if (kind === "pool") {
      candidates = this.ports.pool ? await this.ports.pool(space, name) : [];
      if (!candidates.length) throw new StepFail("nobody", `nobody is in the pool ${name}, so there is no one to give this to`);
    } else {
      const holders = this.ports.roles ? await this.ports.roles(space, name) : [];
      candidates = holders.filter((/** @type {any} */ h) => h.kind === "person").map((/** @type {any} */ h) => ({ actor: h }));
      if (!candidates.length) throw new StepFail("nobody", `nobody holds the role ${name} in this Space, so there is no one to ask`);
    }
    const sig = this.ports.signals ? await this.ports.signals(space, o.record).catch(() => null) : null;
    const skills = Array.isArray(o.skills) ? o.skills : [];
    const c = chooseDoer({ candidates, skills, involvement: (sig && sig.involvement) || {}, load: (sig && sig.load) || {} });
    if (!c.pick) throw new StepFail("nobody", `no one fits: ${c.why}`);
    // a role keeps its other holders as helpers; a pool is a choice of one
    const helpers = kind === "role" ? candidates.filter(x => x.actor.id !== c.pick.actor.id).map(x => x.actor) : [];
    return { doer: c.pick.actor, helpers, ...(kind === "pool" || skills.length || sig ? { why: c.why } : {}) };
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
      // AI is metered: a step may spend little, a run a bit more, a Space a day's worth (an admin sets it; kernel/flows `flows.budget`). Refused plainly before anything is sent.
      await this.#aiGuard(ctx);
      const text = String(val(s.input) ?? "").slice(0, 16_000);
      // The door's refusal (a budget, a residency rule, a value it would not let through) is the step's failure with its own code, so the owner reads the rule and not "error".
      const r = await this.k.model.call({ chain: this.#chain(ctx), purpose: "classify", provider: m.provider, model: m.model, max_tokens: 64,
        messages: [{ role: "system", content: `Answer with exactly one of: ${s.labels.join(", ")}. Nothing else.` }, { role: "user", content: text }] }).catch(portFail);
      const u = r && r.usage || {};
      const spent = Number(u.total_tokens) || (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) || Math.ceil((text.length + String(r.content || "").length) / 4);
      await this.#aiSpend(ctx, Math.min(spent, this.limits.ai_tokens_per_step * 50));
      const label = String(r.content || "").trim();
      return { label: s.labels.includes(label) ? label : null, raw_ok: s.labels.includes(label) };
    }, { input_class: "text" });
  }

  /**
   * Extract: named fields read out of a message or document, through the same model door as classify (sealed values placeholders, no tools, the same AI budget). The model is asked for a JSON object of
   * exactly the declared fields, null where the text does not say; each value is coerced to its declared kind and anything else is dropped, so the step's output is the declared shape and nothing more.
   * @param {any} ctx @param {any} s @param {string} key @param {(v: any) => any} val
   */
  async #extract(ctx, s, key, val) {
    const need = { action: "model.call", resource: `vyre://${ctx.cat.space}/model/*` };
    return this.#effect(ctx, s, key, need, async () => {
      const names = s.fields.map((/** @type {any} */ f) => f.name);
      if (ctx.dry) return { dry: true, fields: Object.fromEntries(names.map((/** @type {string} */ n) => [n, null])) };
      const m = this.ports.model || { provider: "default", model: "default" };
      await this.#aiGuard(ctx);
      const text = String(val(s.input) ?? "").slice(0, 16_000);
      const spec = s.fields.map((/** @type {any} */ f) => `${f.name} (${f.kind || "text"})${f.description ? `: ${f.description}` : ""}`).join("\n");
      const r = await this.k.model.call({ chain: this.#chain(ctx), purpose: "extract", provider: m.provider, model: m.model, max_tokens: 400,
        messages: [{ role: "system", content: `Read the user's text and answer with ONE JSON object and nothing else. Its keys are exactly these fields; a value is null when the text does not say. Dates are YYYY-MM-DD.\n${spec}` }, { role: "user", content: text }] }).catch(portFail);
      const u = r && r.usage || {};
      const spent = Number(u.total_tokens) || (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) || Math.ceil((text.length + String(r.content || "").length) / 4);
      await this.#aiSpend(ctx, Math.min(spent, this.limits.ai_tokens_per_step * 50));
      /** @type {any} */ let parsed = null;
      try { const raw = String(r.content || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, ""); parsed = JSON.parse(raw); } catch { parsed = null; }
      const ok = parsed && typeof parsed === "object" && !Array.isArray(parsed);
      /** @type {Record<string, any>} */ const fields = {};
      for (const f of s.fields) fields[f.name] = ok ? coerce(parsed[f.name], f.kind || "text") : null;
      return { fields, found: names.filter((/** @type {string} */ n) => fields[n] !== null), raw_ok: Boolean(ok) };
    }, { input_class: "text" });
  }

  /** @param {number} now */
  #day(now) { return new Date(now).toISOString().slice(0, 10); }
  /** The Space's daily AI allowance in tokens: what an admin set, else the default. */
  async aiBudget() {
    const day = this.#day(this.now());
    const set = this.store.getSchedule ? await this.store.getSchedule("ai:budget") : null;
    const used = this.store.getSchedule ? (await this.store.getSchedule(`ai:use:${day}`)) || 0 : 0;
    const ctxSet = this.store.getSchedule ? await this.store.getSchedule("set:context_tokens") : null;
    return { tokens_per_day: set ?? this.limits.ai_tokens_per_day, used_today: used, day, context_tokens: ctxSet ?? 1200 };
  }
  /** An admin sets the daily allowance (a number of tokens; 0 turns AI steps off). @param {number} tokens */
  async setAiBudget(tokens) {
    if (!Number.isInteger(tokens) || tokens < 0 || tokens > 1_000_000_000) throw Object.assign(new Error("the budget is a whole number of tokens, 0 or more"), { code: "bad_input" });
    if (this.store.putSchedule) await this.store.putSchedule("ai:budget", tokens);
    return this.aiBudget();
  }
  /** How much of a record's world an agent is shown in this Space (tokens, 200 to 8000; default 1200). @param {number} tokens */
  async setContextTokens(tokens) {
    if (!Number.isInteger(tokens) || tokens < 200 || tokens > 8000) throw Object.assign(new Error("the context budget is a whole number of tokens from 200 to 8000"), { code: "bad_input" });
    if (this.store.putSchedule) await this.store.putSchedule("set:context_tokens", tokens);
    return this.aiBudget();
  }
  /** @param {any} ctx */
  async #aiGuard(ctx) {
    const b = await this.aiBudget();
    if (b.used_today >= b.tokens_per_day) throw new StepFail("ai_budget", "This space's AI budget for today is used up");
    if ((ctx.run.ai_tokens || 0) >= this.limits.ai_tokens_per_run) throw new StepFail("ai_budget", "This run has used its AI allowance, so it did not ask the model again");
  }
  /** @param {any} ctx @param {number} tokens */
  async #aiSpend(ctx, tokens) {
    ctx.run.ai_tokens = (ctx.run.ai_tokens || 0) + tokens;
    if (this.store.putSchedule) { const k = `ai:use:${this.#day(this.now())}`; await this.store.putSchedule(k, ((await this.store.getSchedule(k)) || 0) + tokens); }
  }

  /** @param {any} ctx @param {any} s @param {string} key @param {(v: any) => any} val */
  async #fn(ctx, s, key, val) {
    return this.#effect(ctx, s, key, { action: "fn.run", resource: `vyre://${ctx.cat.space}/fn/*` }, async () => {
      if (ctx.dry) return { dry: true };
      if (!this.ports.sandbox) throw new StepFail("unavailable", "this Space has no code sandbox yet");
      const inputs = val(s.inputs);
      const r = await this.ports.sandbox({ language: s.language, source: s.source, hash: s.hash, inputs, outputs: s.outputs, needs: s.needs || [] }).catch(portFail);
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
   * @param {{ approver: ActorRef, events?: any[], since?: number, until?: number, limit?: number, samples?: any[], cat?: any, softReads?: boolean }} o
   */
  async simulate(flow, o) {
    const cat = o.cat || await this.catalogFn();
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
    } else if (t.on === "time" && (t.cron !== undefined || t.every_ms !== undefined) && o.since !== undefined && o.until !== undefined) {
      // the schedule's real times: in its zone, inside its hours, off holidays (an interval counts from the window that opens, as it does live)
      const first = t.cron !== undefined ? o.since - 1 : o.since;
      for (const at of dueTimes(t, first, o.until, this.#zone(t, cat), this.holidays, Math.min(limit, 1000)).times) hits.push({ trigger: "time", key: `sim@${at}`, scope: { trigger: { at } }, env: null, at });
    } else for (const [i, sample] of (o.samples || []).entries()) hits.push({ trigger: t.on, key: `sample${i}`, scope: { trigger: sample }, env: null, at: this.now() });

    const runs = [];
    /** @type {Record<string, number>} */ const writes = {};
    /** @type {Record<string, { action: string, risk: string, count: number }>} */ const outward = {};
    let asks = 0, tasks = 0, completed = 0, paused = 0, failed = 0;
    for (const h of hits) {
      /** @type {Run} */
      const run = { id: "sim_" + h.key, flow: "simulation", version: 0, hash: "", space: cat.space, trigger: { kind: h.trigger, key: h.key, ...(h.env ? { event: slim(h.env) } : { input: h.scope.trigger }) },
        tainted: Boolean(h.env && (h.env.trust === "external" || h.env.trust === "untrusted")), source_spaces: (h.env && h.env.source_spaces) || [cat.space], depth: 0, state: "running", started_at: h.at, updated_at: h.at, steps: {}, approver: o.approver, dry: true };
      const ctx = { run, flow, view: { flow, id: "simulation" }, cat, caps, dry: true, count: 0, dryEffects: /** @type {any[]} */ ([]), dryAsks: 0, dryTasks: /** @type {any[]} */ ([]), softReads: Boolean(o.softReads) };
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
      const ran = [...new Set(Object.entries(run.steps).filter(([k, v]) => !k.includes("?") && !k.includes("!") && (/** @type {any} */ (v)).status === "done").map(([k]) => k.replace(/@.*$/, "")))];
      runs.push({ event: h.env ? h.env.id : null, at: h.at, ...result, ran, asks: ctx.dryAsks, tasks: ctx.dryTasks.length, effects: ctx.dryEffects.length, tainted: run.tainted });
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
  /** Shrink the finished runs older than the Space's keep days to one line each; how many shrank. @returns {Promise<number>} */
  async prune() { return this.pruner.sweep(this.keepMs); }
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

/** A trimmed event kept in the run (the body is not copied wholesale). @param {any} e */
const slim = e => ({ id: e.id, seq: e.seq, type: e.type, subject: e.subject, actor: e.actor, time: e.time, trust: e.trust, corr: e.corr, data: e.data });

/** How much of a service's response a run keeps (a Flow reads data, it does not store documents; a big file goes by Drive reference). */
/** Does a service answer say the Chrome it needs is on a Mac that is off? Returns the plain reason, or null. @param {any} r */
function deviceOffline(r) {
  if (!r || r.status !== 503 || typeof r.body !== "string") return null;
  try { const j = JSON.parse(Buffer.from(r.body, "base64").toString("utf8")); return j && j.error && j.error.class === "no_browser" && j.error.mac === true ? String(j.error.reason || "the Mac is offline").slice(0, 160) : null; } catch { return null; }
}

const SERVICE_BODY_CAP = 64 * 1024;
/** @param {any} step @param {import('./compile.js').Catalog} cat */
/** The task events that end a wait: the checker's answer either way, the doer's completion, a skip. */
const TASK_ENDS = new Set(["task.approved", "task.rejected", "task.completed", "task.skipped"]);

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

