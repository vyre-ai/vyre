// @ts-check
// kernel/flows/rides: a later send that rides an earlier step's yes (`with`, contracts/flow-runs.md item 7). Pure.
//
// A call step may say `with: "<id of an earlier call step>"`. The person's yes to that earlier step also covers this one, so the run asks nothing when it gets here, even days later (a signing Flow's
// signed copy rides the yes to the signing request). The rule is written in the Flow, never found out while it runs: saving refuses a `with` that names a step that is not an earlier send on the same
// path, and one the earlier send's tool does not name in its manifest `covers`. The earlier step's card says in plain words which steps ride it, and that reading is the consent.

import { walkSteps } from "./schema.js";

/** The send tools a Flow may name, as the catalog has them: a registered tool, outward. @param {any} cat @param {string} action */
const isSend = (cat, action) => { const a = (cat.actions || {})[action]; return Boolean(a && a.tool && /^outward/.test(String(a.risk))); };

/**
 * Check every `with` in a Flow. The earlier step must be a send step before this one on the same path: not in another branch, not outside a repeat or a lane this step sits in, and not itself.
 * @param {any[]} steps @param {any} cat @param {{ path: string, message: string, bad?: string, choices?: string[] }[]} errors
 */
export function checkRides(steps, cat, errors) {
  /** @param {any[]} list @param {string} base @param {Map<string, any>} before the send steps that ran before this list on this path */
  const visit = (list, base, before) => {
    const here = new Map(before);
    list.forEach((s, i) => {
      const p = `${base}[${i}]`;
      if (s.with !== undefined) {
        const early = here.get(s.with);
        if (s.kind !== "call") errors.push({ path: `${p}.with`, message: "only a call step rides an earlier yes" });
        else if (s.with === s.id) errors.push({ path: `${p}.with`, message: "a step cannot ride its own yes" });
        else if (!early) errors.push({ path: `${p}.with`, message: `${s.with} is not an earlier send step on this path (a step rides only the yes of a send before it, in the same branch, repeat or lane)`, bad: String(s.with), choices: [...here.keys()] });
        else if (!isSend(cat, s.action)) errors.push({ path: `${p}.with`, message: `${s.action} is not a send, so it needs no yes to ride` });
        else if (!(((cat.actions || {})[early.action] || {}).covers || []).includes(s.action)) errors.push({ path: `${p}.with`, message: `${early.action} does not name ${s.action} among the sends it covers, so its yes cannot cover it` });
      }
      if (s.kind === "call" && isSend(cat, s.action)) here.set(s.id, s);
      if (s.kind === "decide") { visit(s.then || [], `${p}.then`, here); if (s.else) visit(s.else, `${p}.else`, here); }
      else if (s.kind === "repeat") visit(s.steps || [], `${p}.steps`, new Map());
      else if (s.kind === "parallel") for (const [j, lane] of (s.steps || []).entries()) visit(lane.steps || [], `${p}.steps[${j}].steps`, new Map());
    });
  };
  visit(steps, "steps", new Map());
}

/**
 * The steps that ride a step's yes, in words the card shows. @param {any} flow @param {string} stepId @param {any} cat
 * @returns {{ step: string, action: string, resource: string, line: string }[]}
 */
export function ridesOf(flow, stepId, cat) {
  /** @type {{ step: string, action: string, resource: string, line: string }[]} */ const out = [];
  walkSteps(flow.steps || [], (/** @type {any} */ s) => {
    if (s.kind === "call" && s.with === stepId) out.push({ step: s.id, action: s.action, resource: s.resource, line: String(s.label || ((cat.actions || {})[s.action] || {}).label || s.action).slice(0, 120) });
  });
  return out;
}

/** The title of the earlier step's card, naming what rides it. @param {string} flowLabel @param {string} actionLabel @param {{ line: string }[]} rides */
export function cardTitle(flowLabel, actionLabel, rides) {
  return `${flowLabel}: ${actionLabel}${rides.length ? `, and then ${rides.map(r => r.line).join(" and ")} with this same yes` : ""}?`;
}
