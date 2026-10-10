// @ts-check
// kernel/flows/standing: what the person's ONE yes at turn-on covers for sends (the owner's ruling for 0.3.1). A Flow is approved once, as a stored version with its destinations and limits; every run of that
// version then sends without anyone present. A step marked `approve: true`, a human step, a recipient that comes from outside content (unless the Flow's `sends.outside` is "run"), or a bound that is hit
// still stops for a person. Pure: the runner and the compiler read it; the kernel grant that backs it is minted by the Flows host (core/daemon/flows-host.js).

import { walkSteps } from "./schema.js";

/** Input fields that name who a send goes to, in the order they are looked for. */
export const RECIPIENT_FIELDS = Object.freeze(["to", "recipient", "recipients", "email", "address"]);
export const DEFAULTS = Object.freeze({ max: 100, per_minute: 10, outside: "ask" });

/** @param {any} v a value of a step's input: true when it holds no expression anywhere */
const isConst = v => v === null || typeof v !== "object" ? true : Array.isArray(v) ? v.every(isConst) : Object.hasOwn(v, "expr") ? false : Object.values(v).every(isConst);
const strings = (/** @type {any} */ v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter(x => typeof x === "string") : []);

/**
 * Who a send step goes to, as written. `literal` is true when the Flow itself names the recipient (nothing from a trigger or a read); a send with no recipient field of its own goes to a fixed
 * destination (its connector) and counts as literal.
 * @param {any} step @returns {{ values: string[], literal: boolean }}
 */
export function recipientOf(step) {
  if (step.kind === "service") return { values: [String(step.connector || step.connection || "")].filter(Boolean), literal: true };
  const input = step.input && typeof step.input === "object" ? step.input : {};
  for (const f of RECIPIENT_FIELDS) if (input[f] !== undefined) return { values: isConst(input[f]) ? strings(input[f]) : [], literal: isConst(input[f]) };
  return { values: [], literal: true };
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
  walkSteps((flow && flow.steps) || [], (/** @type {any} */ s) => { if (isSend(s, cat)) for (const v of recipientOf(s).values) named.add(v.toLowerCase()); });
  return { allow: Array.isArray(sd.allow) ? sd.allow.map((/** @type {string} */ x) => x.toLowerCase()) : [...named], max: sd.max ?? DEFAULTS.max, per_minute: sd.per_minute ?? DEFAULTS.per_minute, outside: sd.outside === "run" ? "run" : "ask" };
}

/** @param {string} recipient @param {string[]} allow an address, or @domain for a whole domain */
export function allowed(recipient, allow) {
  const r = String(recipient || "").toLowerCase();
  return allow.some(a => a === r || (a.startsWith("@") && r.endsWith(a)));
}

/**
 * The sends of a Flow version as the approval card lists them: each step, what it does, who it goes to and where that comes from, and whether it always asks.
 * @param {any} flow @param {any} cat @returns {{ step: string, action: string, to: string[], source: "literal" | "outside", approve: boolean }[]}
 */
export function sendsOf(flow, cat) {
  /** @type {any[]} */ const out = [];
  walkSteps((flow && flow.steps) || [], (/** @type {any} */ s) => {
    if (!isSend(s, cat)) return;
    const r = recipientOf(s);
    out.push({ step: s.id, action: s.kind === "service" ? `${s.method} ${s.connector || s.connection}` : s.action, to: r.values, source: r.literal ? "literal" : "outside", approve: s.approve === true });
  });
  return out;
}
