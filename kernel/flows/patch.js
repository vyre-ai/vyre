// @ts-check
// Edit by patch (e2): small, named edits to a Flow instead of rewriting it. Each op acts on a copy of the stored form; the result is checked and stored as a new draft by the caller. Pure.
//
//   { op: "set", step, key, value }                 one key of a step; key may be a path (set.client); value omitted removes it
//   { op: "replace", step, line | with }            a step replaced whole (its lines text, or its stored form)
//   { op: "insert", after | first | into+block, line | step }   a new step after another, first, or at the end of a block (then, else, steps)
//   { op: "remove", step }
//   { op: "move", step, by }                        within its list, by an offset
//   { op: "trigger", trigger }
//   { op: "meta", key, value }                      name, label, description, concurrency, lock, stuck_after_ms
//
// A step is named by its id. An unknown id says which ids there are and which is close.

import { ops, locate } from "./canvas.js";
import { parseLines } from "./lines.js";
import { nearest } from "./places.js";
import { walkSteps } from "./schema.js";

export const META_KEYS = ["name", "label", "description", "concurrency", "lock", "stuck_after_ms"];
const BAD = new Set(["__proto__", "constructor", "prototype"]);

export class PatchError extends Error {
  /** @param {number} at @param {string} message */
  constructor(at, message) { super(`op ${at + 1}: ${message}`); this.name = "PatchError"; this.at = at; this.detail = message; }
}

/** @param {any} flow @param {string} id @param {number} at */
function known(flow, id, at) {
  if (typeof id !== "string" || !id) throw new PatchError(at, "name the step by its id");
  if (!locate(flow.steps, id) && !(flow.on_failure && locate(flow.on_failure, id))) {
    /** @type {string[]} */ const ids = [];
    walkSteps(flow.steps, s => ids.push(s.id));
    const close = nearest(id, ids);
    throw new PatchError(at, `there is no step ${id}; ${close ? `did you mean ${close}?` : `the steps are ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? " and more" : ""}`}`);
  }
}

/** One step from its lines text. @param {string} line @param {number} at */
function stepFromLine(line, at) {
  let f;
  try { f = parseLines("steps:\n" + String(line).split("\n").map(l => "  " + l).join("\n") + "\n"); } catch (e) { throw new PatchError(at, /** @type {any} */ (e).detail || /** @type {Error} */ (e).message); }
  if (f.steps.length !== 1) throw new PatchError(at, "give exactly one step");
  return f.steps[0];
}

/**
 * @param {any} flow the stored Flow @param {any[]} patch
 * @returns {any} the new stored Flow
 */
export function applyPatch(flow, patch) {
  if (!Array.isArray(patch) || !patch.length) throw new PatchError(0, "give ops: a list of { op, ... }");
  if (patch.length > 50) throw new PatchError(50, "at most 50 ops in one patch");
  let f = structuredClone(flow);
  patch.forEach((p, at) => {
    if (!p || typeof p !== "object") throw new PatchError(at, "an op is { op, ... }");
    switch (p.op) {
      case "set": {
        known(f, p.step, at);
        const path = String(p.key || "").split(".");
        if (!path[0] || path.some(k => !k || BAD.has(k))) throw new PatchError(at, "key is a name, or a path like set.client");
        if (path[0] === "id" || path[0] === "kind") throw new PatchError(at, "a step keeps its id and kind (replace it to change them)");
        const top = path[0];
        const cur = locate(f.steps, p.step) || /** @type {any} */ (locate(f.on_failure, p.step));
        const s = cur.list[cur.index];
        if (path.length === 1) { f = ops.updateStep(f, p.step, { [top]: p.value }); break; }
        const copy = structuredClone(s[top] ?? {});
        let o = copy;
        for (const k of path.slice(1, -1)) { if (!o[k] || typeof o[k] !== "object") o[k] = {}; o = o[k]; }
        const last = path[path.length - 1];
        if (p.value === undefined) delete o[last]; else o[last] = p.value;
        f = ops.updateStep(f, p.step, { [top]: copy });
        break;
      }
      case "replace": {
        known(f, p.step, at);
        const next = p.line !== undefined ? stepFromLine(p.line, at) : p.with;
        if (!next || typeof next !== "object" || typeof next.id !== "string") throw new PatchError(at, "give the new step as line (lines text) or with (its stored form)");
        const c = structuredClone(f);
        const l = locate(c.steps, p.step) || /** @type {any} */ (locate(c.on_failure, p.step));
        l.list.splice(l.index, 1, next);
        f = c;
        break;
      }
      case "insert": {
        const step = p.line !== undefined ? stepFromLine(p.line, at) : p.step;
        if (!step || typeof step !== "object" || typeof step.id !== "string") throw new PatchError(at, "give the new step as line (lines text) or step (its stored form)");
        if (p.into !== undefined) { known(f, p.into, at); f = ops.addStep(f, step, null, { into: p.into, block: p.block }); }
        else if (p.after !== undefined) { known(f, p.after, at); f = ops.addStep(f, step, p.after); }
        else if (p.first === true) f = ops.addStep(f, step, null);
        else throw new PatchError(at, "say where: after (a step id), first: true, or into (a block step) with block");
        break;
      }
      case "remove": known(f, p.step, at); f = ops.removeStep(f, p.step); break;
      case "move": known(f, p.step, at); if (!Number.isInteger(p.by)) throw new PatchError(at, "by is a whole number of places (negative moves up)"); f = ops.moveStep(f, p.step, p.by); break;
      case "trigger": if (!p.trigger || typeof p.trigger !== "object") throw new PatchError(at, "trigger is the new trigger"); f = ops.setTrigger(f, p.trigger); break;
      case "meta": {
        if (!META_KEYS.includes(p.key)) throw new PatchError(at, `key is one of ${META_KEYS.join(", ")}`);
        f = { ...f }; if (p.value === undefined) delete f[p.key]; else f[p.key] = p.value;
        break;
      }
      default: throw new PatchError(at, `op is one of set, replace, insert, remove, move, trigger, meta${p.op ? `; ${p.op} is not one` : ""}`);
    }
  });
  return f;
}
