// @ts-check
// kernel/flows/joins: parallel branches and sub-flows (R032-08). Both are one thing: a run starts other runs and waits for all of them. A lane of a `parallel` step is a run of the same Flow version
// that walks only that lane; a sub-flow is a run of another Flow. The parent waits on `{ kind: "children" }`, so a lane can wait for a person or a timer, retry, fail and be retried like any run,
// and the ledger needs nothing new. The runner hands this file the few things it may do (a port); this file keeps no state of its own.

import { runIdFor } from "./store.js";
import { outputs } from "./runner-util.js";

/** A child can no longer move by itself: finished, failed or stopped. A paused child waits for a person, so its parent does too. */
const SETTLED = new Set(["done", "failed", "cancelled"]);

/** The steps of one lane of a `parallel` step, found by the step's id and the lane's id. @param {any} flow @param {{ step: string, id: string }} at @returns {any[] | null} */
export function laneOf(flow, at) {
  /** @type {any[] | null} */ let found = null;
  const look = (/** @type {any[]} */ steps) => {
    for (const s of steps || []) {
      if (found) return;
      if (s.kind === "parallel" && s.id === at.step) { const b = (s.steps || []).find((/** @type {any} */ x) => x.id === at.id); if (b) { found = b.steps || []; return; } }
      for (const k of ["then", "else", "steps"]) if (Array.isArray(s[k])) look(s[k]);
      if (s.on_fail && Array.isArray(s.on_fail.steps)) look(s.on_fail.steps);
    }
  };
  look(flow.steps); look(flow.on_failure);
  return found;
}

/** @param {any} kid a settled child run @returns {string} what happened to it, in words */
const why = kid => (kid && kid.error && kid.error.message ? String(kid.error.message) : kid && kid.state === "cancelled" ? "it was stopped" : "it did not finish");

/**
 * @param {{
 *   store: any, now: () => number,
 *   locked: (id: string, fn: () => Promise<any>) => Promise<any>,
 *   detach: (id: string) => void,
 *   resumeLocked: (id: string, result: any) => Promise<any>,
 *   retry: (id: string) => Promise<any>,
 *   mark: (ctx: any, key: string, patch: any) => Promise<void>,
 *   suspendOn: (ctx: any, key: string, wait: any) => Error,
 *   fail: (code: string, message: string) => Error,
 *   emit: (type: string, data: any, run: any, subject: string) => void,
 *   scope: (ctx: any, locals: Record<string, any>) => any,
 *   walk: (ctx: any, steps: any[], suffix: string, locals: Record<string, any>) => Promise<void>,
 *   depthLimit: number, childLimit: number,
 * }} h
 */
export function createJoins(h) {
  /** Make the child run, once: the same (parent, key) is the same run however often the parent replays. @param {any} parent @param {any} spec @returns {Promise<string>} */
  async function spawn(parent, spec) {
    const id = runIdFor(parent.id, spec.key);
    if (await h.store.getRun(id)) return id;
    const now = h.now();
    /** @type {any} */
    const child = {
      id, flow: spec.flow, version: spec.version, hash: spec.hash, space: parent.space, label: spec.label || parent.label,
      trigger: { kind: spec.kind, key: spec.key, source: spec.source, ...(spec.input !== undefined ? { input: spec.input } : {}) },
      tainted: parent.tainted, source_spaces: parent.source_spaces, depth: spec.depth, state: "running", started_at: now, updated_at: now, steps: {}, approver: spec.approver || parent.approver,
      parent: { run: parent.id, step: spec.step, ...(spec.lane ? { lane: spec.lane } : {}) },
      // a lane walks its own steps of the same Flow and sees what the parent saw when it split; lanes take no lock of their own (the author put them side by side on purpose)
      ...(spec.lane ? { branch: { step: spec.stepId, id: spec.lane }, inherit: spec.inherit, lock_key: "" } : {}),
    };
    await h.store.putRun(child);
    h.emit("flow.started", { run: id, flow: child.flow, version: child.version, trigger: spec.kind, source: spec.source, tainted: child.tainted }, child, `vyre://${child.space}/flow-run/${id}`);
    h.detach(id);
    return id;
  }

  /** A run that starts runs has a limit on how many in all (a loop of parallel steps must not make thousands). @param {any} run @param {number} more */
  function room(run, more) {
    const used = Object.values(run.steps || {}).reduce((n, l) => n + ((l && /** @type {any} */ (l).children && /** @type {any} */ (l).children.length) || 0), 0);
    if (used + more > h.childLimit) throw h.fail("too_many_runs", `this run would start more than ${h.childLimit} lanes and sub-flows in all; split the work into Flows of their own`);
  }

  /** The parent waits for these runs. @param {any} ctx @param {string} key @param {string[]} children @returns {Promise<never>} */
  async function waitFor(ctx, key, children) {
    const wait = { kind: "children", children };
    await h.mark(ctx, key, { status: "waiting", children, wait });
    h.emit("step.waiting", { run: ctx.run.id, step: key, children: children.length }, ctx.run, `vyre://${ctx.run.space}/flow-run/${ctx.run.id}`);
    throw h.suspendOn(ctx, key, wait);
  }

  /**
   * What a lane or a sub-flow read from outside is what this run now holds: if any child was tainted (it read content from outside the Space), so is the run, and every step after the join needs an
   * Ask before an outward act or a grant. Otherwise a lane could launder outside content past the check.
   * @param {any} run @param {any[]} kids
   */
  function taint(run, kids) {
    for (const k of kids) {
      if (!k) continue;
      if (k.tainted) run.tainted = true;
      for (const sp of k.source_spaces || []) if (!run.source_spaces.includes(sp)) run.source_spaces = [...run.source_spaces, sp];
    }
  }

  /** @param {any} s @param {any[]} kids @param {string} what */
  function check(s, kids, what) {
    const bad = kids.filter(k => !k || k.state !== "done");
    if (!bad.length) return;
    const first = bad[0];
    const lane = first && first.parent && first.parent.lane;
    throw h.fail(what === "lane" ? "branch_failed" : "subflow_failed", what === "lane"
      ? `${bad.length === 1 ? `the lane ${lane || "(unknown)"}` : `${bad.length} lanes`} of ${s.label || s.id} did not finish: ${why(first)}`
      : `step ${s.id}: the Flow ${s.flow} did not finish: ${why(first)}`);
  }

  /**
   * A `parallel` step: each lane is a child run and all start now; the step is done when every lane is. A lane that did not finish fails the step after the others have settled, naming it and why;
   * retrying the parent sends the lanes that failed round again and keeps the ones that finished. What the lanes made is one output, `branches.<lane>.steps.<id>`, and every lane's step outputs are
   * also readable as `steps.<id>` by the steps after the join (step ids are unique in a Flow).
   * @param {any} ctx @param {any} s @param {string} key @param {string} suffix @param {Record<string, any>} locals
   */
  async function parallel(ctx, s, key, suffix, locals) {
    const run = ctx.run;
    const led = run.steps[key];
    const lanes = (s.steps || []).filter((/** @type {any} */ b) => b.kind === "branch");
    // a practice run walks the lanes one after another in place: the effects are counted, nothing waits
    if (ctx.dry) { for (const b of lanes) await h.walk(ctx, b.steps || [], suffix, locals); return { dry: true }; }
    if (led && led.children) {
      const kids = await Promise.all(led.children.map((/** @type {string} */ id) => h.store.getRun(id)));
      if (led.status === "waiting" && led.wait && led.wait.result) { taint(run, kids); check(s, kids, "lane"); return branchesOf(kids); }
      if (kids.every(k => k && k.state === "done")) { taint(run, kids); return branchesOf(kids); }
      // a retry of a parent whose lane failed: the lanes that did not finish go again. With only stopped lanes left nothing can wake the parent, so it says so now.
      if (!kids.some(k => k && (!SETTLED.has(k.state) || k.state === "failed"))) check(s, kids, "lane");
      for (const k of kids) if (k && (k.state === "failed" || k.state === "paused")) void h.retry(k.id).catch(() => {});
      return waitFor(ctx, key, led.children);
    }
    room(run, lanes.length);
    const sc = h.scope(ctx, locals);
    const inherit = { trigger: sc.trigger, event: sc.event, steps: sc.steps, locals: Object.fromEntries(Object.entries(sc).filter(([k]) => !["trigger", "event", "steps", "run", "now"].includes(k))) };
    /** @type {string[]} */ const children = [];
    for (const b of lanes) children.push(await spawn(run, { key: `${key}/${b.id}`, kind: "branch", source: `branch:${run.id}/${s.id}/${b.id}`, flow: run.flow, version: run.version, hash: run.hash, depth: run.depth, step: key, stepId: s.id, lane: b.id, inherit }));
    return waitFor(ctx, key, children);
  }

  /** @param {any[]} kids @returns {{ branches: Record<string, any> }} */
  function branchesOf(kids) {
    /** @type {Record<string, any>} */ const branches = {};
    for (const k of kids) branches[k.parent.lane] = { run: k.id, state: "done", steps: outputs(k) };
    return { branches };
  }

  /**
   * A sub-flow: the other Flow runs as a child with `input`, and this step is done when it is. It returns what that Flow's `returns` says (null when it says nothing). The caller is the Flow's
   * approver, who needs `flows.run` on the target exactly as for a manual start (the runner checked it, and gives the target here).
   * @param {any} ctx @param {any} s @param {string} key @param {(v: any) => any} val @param {{ id: string, version: number, hash: string, approver: any, flow: any } | null} target
   */
  async function subflow(ctx, s, key, val, target) {
    const run = ctx.run;
    const led = run.steps[key];
    if (ctx.dry) return { dry: true, result: null };
    if (led && led.children) {
      const kid = await h.store.getRun(led.children[0]);
      if (kid && kid.state === "done") { taint(run, [kid]); return { run: kid.id, state: "done", result: kid.result === undefined ? null : kid.result }; }
      if (led.status === "waiting" && led.wait && led.wait.result) check(s, [kid], "subflow");
      if (!kid || kid.state === "cancelled") check(s, [kid], "subflow");
      if (kid.state === "failed" || kid.state === "paused") void h.retry(kid.id).catch(() => {});
      return waitFor(ctx, key, led.children);
    }
    if (!target) throw h.fail("not_found", `step ${s.id}: the Flow ${s.flow} is not running in this Space (it is missing, paused or not approved)`);
    room(run, 1);
    if (run.depth + 1 > h.depthLimit) throw h.fail("too_deep", `step ${s.id}: Flows that run Flows go ${h.depthLimit} deep at most`);
    const id = await spawn(run, { key, kind: "subflow", source: `subflow:${run.id}/${s.id}`, flow: target.id, version: target.version, hash: target.hash, depth: run.depth + 1, step: key, input: s.input === undefined ? {} : val(s.input), approver: target.approver, label: String(target.flow.label || target.flow.name || "") });
    return waitFor(ctx, key, [id]);
  }

  /**
   * A child settled: if its parent waits on children and they have all settled, the parent goes on (a child that did not finish makes the parent's step fail, which its failure path or a retry handles).
   * Asked without waiting from the child's finish, so the child's lock is not held while the parent runs. The parent's lock is held for the check and the resume together: a child that settles before
   * the parent has written that it waits is found by the check once it has.
   * @param {string} parentId @param {string} stepKey
   */
  async function sweep(parentId, stepKey) {
    await h.locked(parentId, async () => {
      const parent = await h.store.getRun(parentId);
      if (!parent || parent.state !== "waiting" || !parent.waiting || parent.waiting.step !== stepKey) return;
      const led = parent.steps[stepKey];
      if (!led || led.status !== "waiting" || !led.wait || led.wait.kind !== "children") return;
      const kids = await Promise.all(led.wait.children.map((/** @type {string} */ id) => h.store.getRun(id)));
      if (kids.some(k => !k || !SETTLED.has(k.state))) return;
      await h.resumeLocked(parentId, { children: kids.map(k => ({ id: k.id, state: k.state })) });
    });
  }

  /** @param {any} child */
  const settled = child => (child && child.parent && SETTLED.has(child.state) ? sweep(child.parent.run, child.parent.step) : Promise.resolve());

  /**
   * A lane or a sub-flow that failed is retried by retrying the run that started it (which sends the failed lane round again and keeps the rest), so the parent finishes and there is one thing to retry.
   * @param {string} runId @returns {Promise<string | null>} the parent's id when it is failed too
   */
  async function retryTarget(runId) {
    const own = await h.store.getRun(runId);
    if (!own || !own.parent || own.state !== "failed") return null;
    const up = await h.store.getRun(own.parent.run);
    return up && up.state === "failed" ? up.id : null;
  }

  return { parallel, subflow, settled, sweep, retryTarget };
}
