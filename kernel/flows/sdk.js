// @ts-check
// The Flow part of the SDK a definition file imports: `import { defineFlow, step, expr } from '@vyre/sdk'`.
// These return the stored form, so a text file can also be loaded by tools that do run it (the compiler never does: it parses, text.js).
// Records owns @vyre/sdk and re-exports these from there.

import { FLOW_FORMAT, STEP_KINDS, checkFlow } from "./schema.js";
import { normalizeFlow } from "./text.js";

/** A value read from the run's scope: `expr('trigger.client')`. @param {string} source */
export const expr = source => ({ expr: String(source) });

/** @param {string} kind */
const make = kind => (/** @type {string} */ id, /** @type {Record<string, any>} */ props) => ({ id, kind, ...props });

/** One builder per step kind: `step.create('open', { type: 'matter', set: { ... } })`. */
export const step = /** @type {Record<string, (id: string, props: Record<string, any>) => any>} */ (Object.fromEntries(STEP_KINDS.map(k => [k, make(k)])));

/** @param {Record<string, any>} def a Flow without `format`; returns the stored form and throws on a malformed shape */
export function defineFlow(def) {
  const flow = normalizeFlow({ format: FLOW_FORMAT, ...def });
  const problems = checkFlow(flow);
  if (problems.length) throw new Error(`defineFlow: ${problems.map(p => `${p.path || "flow"}: ${p.message}`).join("; ")}`);
  return flow;
}
