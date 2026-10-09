// @ts-check
// kernel/flows/describe: a Flow or a run in a few lines, for an agent that should not read the whole document (flows.describe). Pure. One line a step with the policy it carries (time limit, tries, failure path,
// check), the trigger in words, and, for a run, where it is and what happens next.
import { timelineOf, stepIndex } from "./timeline.js";
import { whyRan } from "./triggers.js";

/** @param {any} t */
function triggerWords(t) {
  if (!t) return "no trigger";
  if (t.on === "event") return `when ${t.event}${t.where ? ` and ${t.where}` : ""}`;
  if (t.on === "time") return t.cron ? `on schedule ${t.cron}${t.tz ? ` (${t.tz})` : ""}` : t.every_ms ? `every ${Math.round(t.every_ms / 1000)} s` : "once at a set time";
  if (t.on === "web") return `when ${t.path} is called`;
  if (t.on === "manual") return "when started by hand";
  if (t.on === "stage") return `when a ${t.type} reaches ${t.stage}`;
  if (t.on === "watcher") return `when ${t.watcher} finds something`;
  return String(t.on);
}
/** @param {number} ms */
const sec = ms => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/**
 * @param {any} flow @param {{ id?: string, version?: number, status?: string, health?: string }} [o]
 * @returns {string[]}
 */
export function describeFlow(flow, o = {}) {
  /** @type {string[]} */ const lines = [];
  lines.push(`${flow.label || flow.name}${o.id ? ` (${o.id}${o.version ? ` v${o.version}` : ""})` : ""}${o.status ? `, ${o.status}` : ""}. Runs ${triggerWords(flow.trigger)}.`);
  if (o.health) lines.push(o.health);
  const flowBits = [flow.concurrency ? `at most ${flow.concurrency} at once` : "", flow.lock ? `one at a time per ${flow.lock}` : "", flow.stuck_after_ms ? `stuck after ${sec(flow.stuck_after_ms)}` : "", Array.isArray(flow.on_failure) ? `on failure: ${flow.on_failure.length} step${flow.on_failure.length === 1 ? "" : "s"}` : ""].filter(Boolean);
  if (flowBits.length) lines.push(flowBits.join("; ") + ".");
  let n = 0;
  const walk = (/** @type {any[]} */ steps, /** @type {string} */ pad) => {
    for (const s of steps || []) {
      n++;
      const bits = [];
      if (s.timeout_ms) bits.push(`limit ${sec(s.timeout_ms)}`);
      if (s.retry === false) bits.push("no retry"); else if (s.retry && s.retry.attempts) bits.push(`${s.retry.attempts} tries`);
      if (s.on_fail) bits.push(`if it fails: ${s.on_fail.steps.length} step${s.on_fail.steps.length === 1 ? "" : "s"}, then ${s.on_fail.then || "stop"}`);
      if (s.verify) bits.push(`${s.verify.essential === false ? "optional" : "essential"} check${s.verify.readback ? " (read back)" : ""}${s.verify.say ? `: ${s.verify.say}` : ""}`);
      const what = s.type ? ` ${s.type}` : s.action ? ` ${s.action}` : s.connector ? ` ${s.connector}` : s.to ? ` ${s.to}` : s.if ? ` if ${s.if}` : "";
      lines.push(`${pad}${s.id}: ${s.kind}${what}${s.label && s.label !== s.id ? ` "${s.label}"` : ""}${bits.length ? `  [${bits.join("; ")}]` : ""}`);
      for (const b of ["then", "else", "steps"]) if (Array.isArray(s[b]) && s[b].length) { lines.push(`${pad}  ${b}:`); walk(s[b], pad + "    "); }
    }
  };
  walk(flow.steps, "  ");
  if (n === 0) lines.push("  (no steps)");
  return lines;
}

/**
 * @param {any} run @param {any} [flow]
 * @returns {string[]}
 */
export function describeRun(run, flow) {
  const t = timelineOf(run, flow);
  if (run.gate) return describeGate(run, t);
  /** @type {string[]} */ const lines = [`Run ${run.id} of ${flow ? flow.label || flow.name : run.flow} (v${run.version}), started by ${run.trigger ? run.trigger.kind : "a trigger"}${run.tainted ? ", from outside this Space" : ""}.`];
  lines.push(t.lines[0]);
  if (run.error && run.error.code && run.error.code !== "note" && ["failed", "paused"].includes(run.state)) lines.push(`Stopped at ${run.error.step}: ${run.error.code}: ${run.error.message}`);
  if (run.state === "waiting" && run.waiting) lines.push(run.waiting.kind === "task" ? `Waiting for a person (step ${run.waiting.step.replace(/\?ask$/, "")}).` : run.waiting.kind === "time" ? "Waiting for a time." : `Waiting for ${run.waiting.event || "an event"}.`);
  if (run.state === "failed" || run.state === "paused") lines.push("You can retry from that step, skip it (if a later step reads its output, with a value to use), or stop the run.");
  if (run.state === "queued" && run.queued) lines.push(`Held (${run.queued.reason.replace(/_/g, " ")}); it starts, in order, when it can.`);
  const done = t.lines.length - 1;
  lines.push(`${done} step${done === 1 ? "" : "s"} so far; flows.timeline shows them.`);
  return lines;
}

const DID = { create: "made", update: "updated", upsert: "saved", remove: "removed", find: "looked up", pick: "picked", assign: "gave out", agent: "handed to an assistant", call: "ran", service: "called", stage: "moved", classify: "sorted", extract: "read", fn: "ran code for", ask: "asked for a yes on" };

/**
 * A run in plain words, at most four sentences: why it ran, what it did in the order done, and what happens next. No step data and no secrets: only step labels and one-word outcomes.
 * @param {any} run @param {any} [flow]
 * @returns {string}
 */
export function explainRun(run, flow) {
  if (run.gate) return explainGate(run);
  const idx = stepIndex(flow);
  const why = whyRan(run.trigger);
  /** @type {string[]} */ const did = [];
  /** @type {string[]} */ const sent = [];
  for (const [key, e] of Object.entries(run.steps || {})) {
    const entry = /** @type {any} */ (e);
    if (!entry || key.includes("?") || key.includes("!") || entry.status !== "done") continue;
    const id = key.replace(/@.*$/, "");
    const meta = idx.get(id);
    if (!meta || meta.kind === "decide" || meta.kind === "repeat" || meta.kind === "wait") continue;
    const verb = /** @type {Record<string, string>} */ (DID)[meta.kind] || "did";
    did.push(`${verb} ${meta.label}`);
    if (entry.output && entry.output.dry) sent.push(meta.label);
  }
  const done = [...new Set(did)];
  const parts = [why];
  if (done.length) parts.push(`It ${done.slice(0, 4).join(", ")}${done.length > 4 ? `, and ${done.length - 4} more` : ""}.`);
  else parts.push("It has not done anything yet.");
  const w = run.waiting;
  const err = run.error && run.error.code && run.error.code !== "note" ? run.error : null;
  const label = (/** @type {string} */ id) => (idx.get(String(id).replace(/\?.*$/, "")) || { label: id }).label;
  if (run.state === "done") parts.push("It finished.");
  else if (run.state === "cancelled") parts.push("It was stopped.");
  else if (run.state === "failed") parts.push(`It stopped at ${label(err ? err.step : "?")} (${err ? err.code : "an error"}); retry it, skip that step, or stop the run.`);
  else if (run.state === "paused") parts.push(`It is paused${err ? ` at ${label(err.step)}` : ""}.`);
  else if (run.state === "queued") parts.push(`It is held (${String(run.queued && run.queued.reason || "waiting its turn").replace(/_/g, " ")}) and starts, in order, when it can.`);
  else if (run.state === "waiting" && w) parts.push(w.kind === "task" ? `It is waiting for ${(idx.get(String(w.step || "").replace(/\?.*$/, "")) || {}).kind === "ask" || String(w.step || "").endsWith("?ask") ? "a person's yes" : "a person"} on ${label(w.step)}.` : w.kind === "time" ? "It is waiting for a time." : `It is waiting for ${w.event || "an event"}.`);
  else if (run.state === "waiting") parts.push("It is waiting.");
  else parts.push("It is running.");
  if (run.attention && run.attention.kind) parts.push(`Needs attention: ${run.attention.kind}.`);
  return parts.slice(0, 5).join(" ");
}

/** @param {any} run */
function gateCounts(run) {
  const g = run.gate;
  const tasks = Object.entries(run.steps || {}).filter(([k]) => k.startsWith("task:")).map(([k, v]) => ({ title: k.slice(5), status: /** @type {any} */ (v).status, required: Boolean(/** @type {any} */ (v).output && /** @type {any} */ (v).output.required) }));
  const req = tasks.filter(t => t.required);
  const pool = req.length ? req : tasks;
  return { g, tasks, done: pool.filter(t => t.status === "done" || t.status === "skipped").length, of: pool.length, stuck: tasks.filter(t => t.status === "failed") };
}

/** A stage gate as lines: where the record is, how many tasks are done, what holds it, and who may move it on. @param {any} run @param {{ lines: string[] }} t */
function describeGate(run, t) {
  const { g, done, of, stuck } = gateCounts(run);
  /** @type {string[]} */ const lines = [`Stage gate for ${g.type} ${g.record} in ${g.stage}${g.next ? `, then ${g.next}` : ", the last stage"}.`];
  lines.push(...t.lines.slice(0, 1));
  if (run.state === "waiting") {
    lines.push(`${done} of ${of} ${of === 1 ? "task" : "tasks"} done${stuck.length ? `; stuck: ${stuck.map(x => x.title).join(", ")}` : ""}.`);
    const cond = run.steps.condition;
    if (cond && cond.status === "waiting") lines.push(`Held by the next stage: ${cond.output && cond.output.say}.`);
    if (g.owner) lines.push(`${g.owner} (or an admin) can move it on early with flows.advance.`);
  } else lines.push(run.error && run.error.code === "note" ? `Over: ${run.error.message}.` : "Over: the record moved on.");
  return lines;
}

/** @param {any} run */
function explainGate(run) {
  const { g, done, of } = gateCounts(run);
  const move = run.steps.move;
  if (run.state !== "waiting") return `${g.type} ${g.record} entered ${g.stage}. ${move && move.output && move.output.early ? `${move.output.by} moved it on early to ${move.output.to}: ${move.output.reason}.` : move ? `Its tasks were done, so it moved on to ${g.next}.` : run.error && run.error.message ? `It is over: ${run.error.message}.` : "It is over."}`;
  const cond = run.steps.condition;
  return `${g.type} ${g.record} entered ${g.stage}, which has ${of} ${of === 1 ? "task" : "tasks"}; ${done} done. ${cond && cond.status === "waiting" ? `${g.next} cannot be entered yet: ${cond.output && cond.output.say}.` : g.next ? `When they are done it moves on to ${g.next}.` : "This is the last stage."}${g.owner ? ` ${g.owner} or an admin can move it on early.` : ""}`;
}
