// @ts-check
// oversight: the rules behind the panel that shows what an agent is doing in the person's Chrome
// (capsule-pro draws it; this decides). Three promises:
//
//   plan first   an agent posts its plan before it acts, so the person can read what is coming
//   interject    the person can say something mid-run, by prompt or voice, and the agent sees it
//                on its very next call (once), so it can change course
//   stop         Esc stops at once and Vyre waits: the very next op is refused, the extension is
//                told in the same breath so an in-flight batch halts within a step, and nothing
//                continues until the person answers (resume)
//
// Pure: no sockets, no clock of its own beyond the one it is handed, so it is tested with a fake
// bridge. States: idle | planning | running | stopped | waiting_input.

import { performance } from "node:perf_hooks";

/** @param {string} code @param {string} message */
const refuse = (code, message) => Object.assign(new Error(message), { code });

const STEP_STATUS = new Set(["pending", "running", "done", "failed", "skipped"]);
const clip = (/** @type {unknown} */ s, n = 300) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/**
 * @param {{ emit?: (type: string, payload: any) => void, push?: (frame: any) => any, now?: () => number, clean?: (s: string) => string }} [deps]
 *   emit: events for the panel (chrome.plan, chrome.step, ...). push: tell the extension (the bridge's push).
 *   clean: what an agent's own words pass through before they are published.
 */
export function createOversight({ emit: rawEmit = () => {}, push = () => false, now = () => performance.now(), clean = s => s } = {}) {
  /** @type {"idle"|"planning"|"running"|"stopped"|"waiting_input"} */
  let state = "idle";
  // Every event carries `run`: the thread the panel's pills already use, or the agent when there is none.
  const emit = (/** @type {string} */ type, /** @type {any} */ payload) => rawEmit(type, { ...payload, run: payload && (payload.thread || payload.agent) ? String(payload.thread || payload.agent) : (active ? String((plans.get(active) && /** @type {any} */ (plans.get(active)).thread) || active) : "") });
  /** The panel's step vocabulary. */
  const STATE_OF = /** @type {Record<string, string>} */ ({ pending: "todo", running: "current", done: "done", failed: "failed", skipped: "skipped" });
  /** @type {Map<string, { thread?: string, title?: string, steps: { id: string, text: string, risk?: string, status: string }[] }>} */
  const plans = new Map();
  /** @type {string|null} the agent the panel is showing */
  let active = null;
  /** @type {{ from: string, text: string }[]} */
  let queue = [];
  /** @type {string|null} */
  let stoppedBy = null;
  /** @type {string|null} */
  let question = null;
  /** @type {number[]} */
  const latencies = [];

  const stepsOf = () => (active && plans.get(active) ? /** @type {any} */ (plans.get(active)).steps : []);
  const find = (/** @type {string} */ id) => stepsOf().find((/** @type {any} */ s) => s.id === id);

  /** @param {"running"|"done"|"failed"} status @param {string} id @param {string} [why] */
  function step(status, id, why) {
    const s = find(String(id));
    if (!s) throw refuse("bad_request", `no step "${id}" in the plan`);
    s.status = status;
    if (status === "running" && state !== "stopped" && state !== "waiting_input") state = "running";
    const p = active ? plans.get(active) : null;
    emit("chrome.step", { agent: active, ...(p && p.thread ? { thread: p.thread } : {}), id: s.id, status, state: STATE_OF[status] || status, ...(why ? { why: clean(clip(why)) } : {}) });
    return { id: s.id, status };
  }

  /** The agent whose plan has this run id (its thread, or its own name). @param {string|undefined} run */
  const agentOfRun = run => {
    if (!run) return active;
    for (const [agent, p] of plans) if (p.thread === String(run) || agent === String(run)) return agent;
    return null;
  };
  /** The whole plan as the panel draws it. @param {string} agent */
  const planFrame = agent => {
    const p = /** @type {any} */ (plans.get(agent));
    return { agent, ...(p.thread ? { thread: p.thread } : {}), title: p.title, steps: p.steps.map((/** @type {any} */ { status, ...s }) => ({ ...s, state: STATE_OF[status] || status })) };
  };

  const self = {
    get state() { return state; },
    get stopLatencyMs() { return latencies.length ? latencies[latencies.length - 1] : null; },
    /** Every measured stop latency, oldest first, for a report. */
    stopLatencies: () => [...latencies],

    /** What the panel draws. */
    snapshot() {
      const p = active ? plans.get(active) : null;
      return { state, agent: active, thread: p ? p.thread || null : null, title: p ? p.title || null : null, steps: p ? p.steps.map(s => ({ ...s, state: STATE_OF[s.status] || s.status })) : [], queued: queue.length, stoppedBy, question, stopLatencyMs: self.stopLatencyMs };
    },

    /**
     * An agent's plan for its run. Replaces its last plan.
     * @param {string} agent @param {{ id: string, text: string, risk?: string }[]} steps @param {{ thread?: string, title?: string }} [meta]
     */
    plan(agent, steps, meta = {}) {
      if (!agent) throw refuse("bad_request", "a plan needs an agent");
      if (!Array.isArray(steps) || !steps.length) throw refuse("bad_request", "a plan needs at least one step");
      const seen = new Set();
      const list = steps.map((s, i) => {
        const id = String((s && s.id) ?? i + 1);
        if (seen.has(id)) throw refuse("bad_request", `step id "${id}" is used twice`);
        seen.add(id);
        if (!s || !String(s.text || "").trim()) throw refuse("bad_request", `step "${id}" has no text`);
        return { id, text: clean(clip(s.text)), ...(s.risk ? { risk: clip(s.risk, 40) } : {}), status: "pending" };
      });
      const title = meta.title ? clean(clip(meta.title, 120)) : clean(clip(list[0].text, 80));
      plans.set(agent, { ...(meta.thread ? { thread: String(meta.thread) } : {}), title, steps: list });
      active = agent;
      if (state === "idle" || state === "planning" || state === "running") state = "planning";
      emit("chrome.plan", planFrame(agent));
      return { ok: true, steps: list.length };
    },

    /**
     * The person retexts a step that has not started (a running or finished step cannot be edited, only steered). Resends the plan.
     * @param {{ run?: string, step: string, text: string }} o
     */
    editStep({ run, step: id, text }) {
      const agent = agentOfRun(run);
      const pl = agent ? plans.get(agent) : null;
      if (!agent || !pl) throw refuse("not_found", "there is no plan for that run");
      const s = pl.steps.find(x => x.id === String(id));
      if (!s) throw refuse("bad_request", `no step "${id}" in the plan`);
      if (s.status !== "pending") throw refuse("bad_request", `step "${id}" has already started; steer the agent instead`);
      const t = clean(clip(text));
      if (!t) throw refuse("bad_request", "say what the step should say");
      s.text = t;
      emit("chrome.plan", planFrame(agent));
      return { ok: true, step: s.id };
    },

    /**
     * The person pauses the run (the panel's Pause): the same hold as a stop, resumed with resume().
     * @param {{ run?: string }} [o]
     */
    pause({ run } = {}) {
      if (run && !agentOfRun(run)) throw refuse("not_found", "there is no run with that id");
      if (state === "stopped") return Promise.resolve({ ok: true, paused: true, already: true });
      const t0 = now();
      state = "stopped";
      stoppedBy = "user";
      emit("chrome.paused", { agent: active });
      return Promise.resolve(push({ event: "stop", by: "user" })).catch(() => false).then(() => ({ ok: true, paused: true, already: false, latencyMs: Math.max(0, now() - t0) }));
    },

    /**
     * What the person says aloud, live, for the panel to show. A final phrase reaches the agent as an interjection.
     * @param {{ run?: string, text: string, final?: boolean }} o
     */
    voice({ run, text, final = false }) {
      const t = clean(clip(text, 1000));
      emit("chrome.voice", { agent: active, ...(run ? { run: String(run) } : {}), text: t, final: Boolean(final) });
      if (final && t) self.interject({ from: "voice", text: t });
      return { ok: true };
    },
    /** @param {string} id */ stepStarted: id => step("running", id),
    /** @param {string} id */ stepDone: id => step("done", id),
    /** @param {string} id @param {string} [why] */ stepFailed: (id, why) => step("failed", id, why),

    /** The run is over: forget the plan so the next run must post its own. @param {string} agent */
    finish(agent) {
      plans.delete(agent);
      if (active === agent) { active = null; if (state === "planning" || state === "running") state = "idle"; }
      return { ok: true };
    },

    /**
     * The person says something to the agent mid-run. Kept until the agent's next call takes it.
     * @param {{ from?: "prompt"|"voice", text: string }} o
     */
    interject({ from = "prompt", text }) {
      const t = clean(clip(text, 1000));
      if (!t) throw refuse("bad_request", "say what to tell the agent");
      const f = from === "voice" ? "voice" : "prompt";
      queue.push({ from: f, text: t });
      emit("chrome.interjected", { agent: active, from: f, text: t });
      return { ok: true, queued: queue.length };
    },

    /**
     * Stop now. Idempotent: a second Esc is the same stop. The flag is set before anything is
     * awaited, so the next op is already refused when this returns its promise.
     * @param {{ by?: "esc"|"user"|"agent-error" }} [o]
     */
    stop({ by = "user" } = {}) {
      if (state === "stopped") return Promise.resolve({ ok: true, stopped: true, already: true, by: stoppedBy });
      const t0 = now();
      state = "stopped";
      stoppedBy = by;
      emit("chrome.stopped", { agent: active, by });
      return Promise.resolve(push({ event: "stop", by })).catch(() => false).then(() => {
        const ms = Math.max(0, now() - t0);
        latencies.push(ms);
        return { ok: true, stopped: true, already: false, by, latencyMs: ms };
      });
    },

    /** The person answered; carry on. Only from stopped or waiting_input. @param {{ answer?: string }} [o] */
    resume({ answer } = {}) {
      if (state !== "stopped" && state !== "waiting_input") throw refuse("not_stopped", `nothing to resume: the state is ${state}`);
      const a = clean(clip(answer, 1000));
      state = active && plans.get(active) ? "running" : "idle";
      stoppedBy = null; question = null;
      if (a) queue.push({ from: "answer", text: a });
      emit("chrome.resumed", { agent: active, ...(a ? { answer: a } : {}) });
      return Promise.resolve(push({ event: "resume" })).catch(() => false).then(() => ({ ok: true, state }));
    },

    /** The agent needs the person before it can go on. @param {string} text */
    waitInput(text) {
      if (state === "stopped") return { ok: true, state };
      state = "waiting_input";
      question = clean(clip(text, 500));
      emit("chrome.waiting", { agent: active, question });
      return { ok: true, state };
    },

    /**
     * Called before every op. Throws when the person has stopped Vyre or Vyre is waiting for them,
     * and when an agent (not a person's own direct call) acts with no plan posted. Returns the
     * interjection waiting for the caller, once, if there is one.
     * @param {string|null|undefined} agent the named agent, or null for a person's own call
     * @param {string} [caller] @returns {{ interjection?: string }}
     */
    /** Whether this agent has posted a plan (chrome.plan) and the person has not stopped Vyre: what other modules ask before they show an agent the person's screen. @param {string} agent */
    planned(agent) { return state !== "stopped" && plans.has(agent); },
    guard(agent, caller) {
      if (state === "stopped") throw refuse("stopped", "the person stopped Vyre in Chrome. Ask them, then wait for chrome.resume before acting again.");
      if (state === "waiting_input") throw refuse("waiting_input", `waiting for the person: ${question || "they were asked a question"}`);
      const isAgent = Boolean(agent) && /^mcp:agent:/.test(String(caller || `mcp:agent:${agent}`));
      if (isAgent && !plans.has(/** @type {string} */ (agent))) throw refuse("plan_first", "post your plan first with chrome.plan (a short list of steps), then act.");
      if (state === "idle" || state === "planning") state = "running";
      if (!queue.length) return {};
      const text = queue.map(q => q.text).join("\n");
      queue = [];
      return { interjection: text };
    },
  };
  return self;
}
