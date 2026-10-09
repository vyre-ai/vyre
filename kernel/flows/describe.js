// @ts-check
// kernel/flows/describe: a Flow or a run in a few lines, for an agent that should not read the whole document (flows.describe). Pure. One line a step with the policy it carries (time limit, tries, failure path,
// check), the trigger in words, and, for a run, where it is and what happens next.
import { timelineOf } from "./timeline.js";

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
