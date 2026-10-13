// @ts-check
// Who added a step. A step carries `added_by`, the id of the person who added or last changed it, and the server is the only one who sets it: a value sent by a client is dropped, a step that is
// the same as in the version before keeps its adder, and a new or changed step is the caller's. The adder must reach what the step touches (checked when it is added, and again each time it runs).
import { walkSteps, canonical } from "./schema.js";

/** A step without its adder, for comparing. @param {any} s */
const bare = s => { const { added_by: _a, ...rest } = s; return canonical(rest); };

/**
 * The Flow with `added_by` set on every step (nested ones too). Only a person adds steps: for any other caller the steps keep what the version before had and a new one gets none.
 * @param {any} prev the stored Flow this one replaces, or null @param {any} flow @param {{ kind: string, id: string }} by @returns {any}
 */
export function stampAdders(prev, flow, by) {
  const old = new Map();
  if (prev) walkSteps(prev.steps || [], s => old.set(s.id, s)), walkSteps(prev.on_failure || [], s => old.set(s.id, s));
  const out = structuredClone(flow);
  const stamp = (/** @type {any} */ s) => {
    const was = old.get(s.id);
    const same = was && bare(was) === bare(s);
    delete s.added_by;
    if (same && was.added_by) s.added_by = was.added_by;
    else if (by && by.kind === "person") s.added_by = by.id;
  };
  walkSteps(out.steps || [], stamp);
  walkSteps(out.on_failure || [], stamp);
  return out;
}
