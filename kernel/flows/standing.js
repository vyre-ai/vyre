// @ts-check
// kernel/flows/standing: what the person's ONE yes at turn-on covers for sends (the owner's ruling for 0.3.1). A Flow is approved once, as a stored version with its destinations and limits; every run of that
// version then sends without anyone present. A step marked `approve: true`, a human step, a recipient that comes from outside content (unless the Flow's `sends.outside` is "run"), or a bound that is hit
// still stops for a person. Pure: the runner and the compiler read it; the kernel grant that backs it is minted by the Flows host (core/daemon/flows-host.js).

import { walkSteps } from "./schema.js";

export const DEFAULTS = Object.freeze({ max: 100, per_minute: 10, outside: "ask" });

/** @param {any} v a value of a step's input: true when it holds no expression anywhere */
const isConst = v => v === null || typeof v !== "object" ? true : Array.isArray(v) ? v.every(isConst) : Object.hasOwn(v, "expr") ? false : Object.values(v).every(isConst);
const one = (/** @type {any} */ x) => (typeof x === "string" || typeof x === "number" ? [String(x)] : []);
export const strings = (/** @type {any} */ v) => (Array.isArray(v) ? v.flatMap(one) : one(v));

/** The input fields a tool's module declares as its destinations (`recipients` on its flow.steps entry), from the catalog. None declared means standing never covers it. @param {any} step @param {any} cat @returns {string[]} */
export function declaredFields(step, cat) {
  const a = ((cat && cat.actions) || {})[step.action];
  return a && Array.isArray(a.recipients) ? a.recipients.filter((/** @type {any} */ f) => typeof f === "string") : [];
}

/**
 * Who a send step goes to, as written, read from the destination fields its module declares. `literal` is true when the Flow itself names every one (nothing from a trigger or a read); a service step goes to
 * its fixed connector and counts as literal.
 * @param {any} step @param {any} cat @returns {{ values: string[], literal: boolean }}
 */
export function recipientOf(step, cat) {
  if (step.kind === "service") return { values: [String(step.connector || step.connection || "")].filter(Boolean), literal: true };
  const input = step.input && typeof step.input === "object" ? step.input : {};
  /** @type {string[]} */ const values = [];
  let literal = true;
  for (const f of declaredFields(step, cat)) { if (input[f] === undefined) continue; if (isConst(input[f])) values.push(...strings(input[f])); else literal = false; }
  return { values, literal };
}

/**
 * Can the person's one yes cover this step at all? Only a call to a tool whose module declared its destination fields, with no input field the tool did not declare (a field nothing checks could name
 * a second destination). Anything else asks, as before.
 * @param {any} step @param {any} cat
 */
export function covered(step, cat) {
  if (step.kind !== "call" || !isSend(step, cat) || !declaredFields(step, cat).length) return false;
  const known = new Set(Object.keys(((cat && cat.actions) || {})[step.action].inputs || {}));
  return !(step.input && typeof step.input === "object") || Object.keys(step.input).every(k => known.has(k));
}

/** Is this send an outward one a turned-on Flow may run on its own? Calls and non-GET service steps are the sends. @param {any} step @param {any} cat */
export function isSend(step, cat) {
  if (step.kind === "service") return !(step.method === "GET" || step.method === "HEAD");
  if (step.kind !== "call") return false;
  const a = ((cat && cat.actions) || {})[step.action];
  return Boolean(a && /^outward/.test(String(a.risk)));
}

/** The limits of a Flow version, with the defaults filled in: the allow list (the recipients the Flow names itself, unless it says its own), the most sends in all, the most a minute, and the outside rule. @param {any} flow @param {any} cat */
export function boundsOf(flow, cat) {
  const sd = (flow && flow.sends) || {};
  /** @type {Set<string>} */ const named = new Set();
  walkSteps((flow && flow.steps) || [], (/** @type {any} */ s) => { if (covered(s, cat)) for (const v of recipientOf(s, cat).values) named.add(v.toLowerCase()); });
  return { allow: Array.isArray(sd.allow) ? sd.allow.map((/** @type {string} */ x) => x.toLowerCase()) : [...named], max: sd.max ?? DEFAULTS.max, per_minute: sd.per_minute ?? DEFAULTS.per_minute, outside: sd.outside === "run" ? "run" : "ask" };
}

/** @param {string} recipient @param {string[]} allow an address, or @domain for a whole domain */
export function allowed(recipient, allow) {
  const r = String(recipient || "").toLowerCase();
  const at = r.split("@");
  return allow.some(a => a === r || (a.startsWith("@") && at.length === 2 && at[0] !== "" && `@${at[1]}` === a));
}

/**
 * The sends of a Flow version as the approval card lists them: each step, what it does, who it goes to and where that comes from, and whether it always asks.
 * @param {any} flow @param {any} cat @returns {{ step: string, action: string, to: string[], source: "literal" | "outside", approve: boolean, covered: boolean }[]}
 */
export function sendsOf(flow, cat) {
  /** @type {any[]} */ const out = [];
  walkSteps((flow && flow.steps) || [], (/** @type {any} */ s) => {
    if (!isSend(s, cat)) return;
    const r = recipientOf(s, cat);
    out.push({ step: s.id, action: s.kind === "service" ? `${s.method} ${s.connector || s.connection}` : s.action, to: r.values, source: r.literal ? "literal" : "outside", approve: s.approve === true, covered: covered(s, cat) });
  });
  return out;
}
