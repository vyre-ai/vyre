// @ts-check
// The pure half of the failure panel: what a step does when it goes wrong. A step may carry a time limit for one try (`timeout_ms`), a retry policy (`retry`), steps to run if it still fails
// (`on_fail`) and a check of the work (`verify`); the whole Flow may carry steps to run when the run is about to fail (`on_failure`). The engine already runs all of these (kernel/flows/runner.js);
// this file lets the builder read them from a stored Flow and write them back, so a Flow with a failure policy opens as editable cards and saves without loss.
// In a draft the four keys sit on the step under their stored names; the steps inside `on_fail` are draft steps, so the tree helpers treat that path as one more lane.

/** @typedef {{ id: string, kind: string, [k: string]: any }} DraftStep */

/** The errors worth a second try, in words (the engine's RETRY_CODES, kernel/flows/schema.js). @type {[string, string][]} */
export const RETRY_WHY = [
  ["timeout", "It took too long"],
  ["unavailable", "The service was not available"],
  ["rate_limited", "The service asked to slow down"],
  ["upstream_5xx", "The service had an error"],
  ["connection_reset", "The connection dropped"],
  ["busy", "The service was busy"],
];

const BLOCKS = ["decide", "repeat", "parallel"];
const POLICY = ["timeout_ms", "retry", "on_fail", "verify"];

/** The policy keys a stored step of this kind may carry (kernel/flows/schema.js: a block or a subflow takes a failure path and a check, a wait no time limit, a lane nothing). @param {string} kind @returns {string[]} */
export function policyKeys(kind) {
  if (kind === "branch" || kind === "advanced") return [];
  if (BLOCKS.includes(kind) || kind === "subflow") return ["on_fail", "verify"];
  return kind === "wait" ? ["retry", "on_fail", "verify"] : POLICY;
}

/** What the panel offers for a kind: the engine ignores a time limit on a step that waits for a person or an agent, so none is offered there. @param {string} kind */
export function offers(kind) {
  const k = policyKeys(kind);
  return { timeout: k.includes("timeout_ms") && !["ask", "assign", "agent"].includes(kind), retry: k.includes("retry"), verify: k.includes("verify"), fail: k.includes("on_fail"), readback: ["create", "update", "upsert", "stage"].includes(kind) };
}

const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);
const only = (/** @type {any} */ o, /** @type {string[]} */ ks) => Object.keys(o).every((k) => ks.includes(k));

/** Whether a stored policy value is one the panel can show and write back unchanged. @param {string} key @param {any} v */
function showable(key, v) {
  switch (key) {
    case "timeout_ms": return Number.isInteger(v);
    case "retry": return v === false || (isObj(v) && only(v, ["attempts", "backoff_ms", "on"]));
    case "verify": return isObj(v) && only(v, ["check", "essential", "say", "readback"]);
    case "on_fail": return isObj(v) && only(v, ["steps", "then"]) && Array.isArray(v.steps);
    default: return false;
  }
}

/**
 * A stored step split into the part the step's kind reads and the policy it carries. A policy value the panel cannot show stays with the step, which then stays an Advanced step, as before.
 * @param {any} s @returns {{ plain: any, policy: Record<string, any> }}
 */
export function splitPolicy(s) {
  const allowed = policyKeys(s.kind);
  /** @type {Record<string, any>} */ const policy = {};
  /** @type {Record<string, any>} */ const plain = {};
  for (const [k, v] of Object.entries(s)) (allowed.includes(k) && showable(k, v) ? policy : plain)[k] = v;
  return { plain, policy };
}

/** The draft fields for a stored policy: `on_fail.steps` become draft steps. @param {Record<string, any>} policy @param {(s: any) => DraftStep} stepFrom */
export function policyDraft(policy, stepFrom) {
  const out = { ...policy };
  if (out.on_fail) out.on_fail = { ...out.on_fail, steps: out.on_fail.steps.map(stepFrom) };
  return out;
}

/** The policy keys of a draft step as stored. @param {DraftStep} s @param {(x: DraftStep) => any} defOf */
export function policyDefinition(s, defOf) {
  /** @type {Record<string, any>} */ const out = {};
  for (const k of policyKeys(s.kind)) {
    const v = s[k];
    if (v === undefined) continue;
    out[k] = k === "on_fail" ? { ...v, steps: (v.steps || []).map(defOf) } : v;
  }
  return out;
}

/** "30 seconds", "1 minute", "2 hours". @param {number} ms */
export function span(ms) {
  const n = (/** @type {number} */ v, /** @type {string} */ u) => `${v} ${u}${v === 1 ? "" : "s"}`;
  if (ms % 3_600_000 === 0) return n(ms / 3_600_000, "hour");
  if (ms % 60_000 === 0) return n(ms / 60_000, "minute");
  if (ms % 1000 === 0) return n(ms / 1000, "second");
  return n(ms, "millisecond");
}

/** What a step's policy says, as the clause that follows its summary ("", or ", tries up to 3 times, runs 2 steps if it fails"). @param {DraftStep} s */
export function policyWords(s) {
  const bits = [];
  if (s.timeout_ms !== undefined) bits.push(`gives up after ${span(s.timeout_ms)}`);
  if (s.retry === false) bits.push("never tries again");
  else if (isObj(s.retry) && s.retry.attempts !== undefined) bits.push(`tries up to ${s.retry.attempts} time${s.retry.attempts === 1 ? "" : "s"}`);
  if (s.verify) bits.push(s.verify.essential === false ? "checks the work and flags a miss" : "checks the work");
  if (s.on_fail) { const n = (s.on_fail.steps || []).length; bits.push(`${n} step${n === 1 ? "" : "s"} to run if it fails${s.on_fail.then === "continue" ? ", then the Flow goes on" : ""}`); }
  return bits.length ? `, ${bits.join(", ")}` : "";
}

/** What the failure settings of a step still need, in words, or null. @param {DraftStep} s @param {(src: string) => string | null} formulaProblem */
export function policyProblem(s, formulaProblem) {
  if (s.verify) {
    const v = s.verify;
    if (!(v.check || "").trim() && v.readback !== true) return "Say how to check the work, or turn the check off.";
    if ((v.check || "").trim() && formulaProblem(v.check)) return "The check is not a formula the engine can read.";
  }
  if (s.on_fail && !(s.on_fail.steps || []).length) return "Add the steps to run if this fails, or turn them off.";
  return null;
}
