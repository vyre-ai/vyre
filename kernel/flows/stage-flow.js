// @ts-check
// A Playbook stage is a Flow (team/0.6/DESIGN-tasks-v2.md, "Flows and Playbooks as one engine"; team/0.6/PRODUCT-MAP.md, Playbook). One stage, one stored Flow:
//
//   trigger   { on: "stage", type, stage }               a record enters the stage
//   steps     one `assign` step for each of the stage's to-dos, with its three slots (Assigned is `to`, Reviewer, Approver or the old `checker`)
//             and a last `stage` step, id "move": when the to-dos are done the record moves on to the next stage (no move on the last stage)
//   playbook  { key, type, stage, owner?, hold?, enter_if?, groups?, kit?, template?, version?, from }   what makes it a stage, and the hash of the stage it was made from
//
// The parts of a to-do the builder has no field for (depends_on, due_offset_ms, required, checklist, credentials, group, context, needs_yes, ask) ride on its step as `task`, so opening a
// stage in the Flow builder and saving it keeps them. `stageFlow` makes the Flow from a stage; `stageOf` reads the stage back from a Flow; the two are each other's inverse.
// The runner never starts one of these from its own trigger matching: the stages module (kernel/flows/stages.js) runs the Flow's tasks once per entry, and the run is this Flow's run.
// Pure: no store, no kernel.

import { createHash } from "node:crypto";
import { canonical, checkSlots } from "./schema.js";

/** The parts of a to-do kept on its step as `task`. */
export const TASK_EXTRAS = Object.freeze(["depends_on", "due_offset_ms", "required", "checklist", "credentials", "group", "context", "needs_yes", "ask"]);
/** The parts of a to-do that are the step's own keys. */
const STEP_PARTS = Object.freeze(["to", "title", "output", "how", "template", "checker", "reviewer", "approver", "followers", "notes", "brief"]);
/** The stage-level parts kept on `playbook`. */
const STAGE_PARTS = Object.freeze(["owner", "hold", "enter_if", "groups"]);
const WHO = /^(?:(?:teammate|role|person|assistant|actor|group|pool):[A-Za-z0-9._:-]{1,80}|lead|owner|creator)$/;
const STEP_ID = /^task_[0-9]{1,3}$/;
const OUTPUTS = new Set(["fields", "note", "draft", "sent", "decision", "file"]);
const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);
const short = (/** @type {string} */ s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/**
 * The key a stage's Flow is found by. A type's stage: `type:<type>:<set>:<stage>` (set is the stage set's index, "" for the type's own list). A Playbook template's stage:
 * `template:<template>:<version>:<stage>` (a running project keeps the version it began with, so each version's stage is its own Flow).
 * @param {{ type: string, stage: string, set?: number | null, template?: string, version?: number | string }} p
 */
export function stageKey(p) {
  return p.template ? `template:${p.template}:${p.version ?? ""}:${p.stage}` : `type:${p.type}:${p.set ?? ""}:${p.stage}`;
}

/** The hash of a stage as it is defined (its to-dos and stage-level parts), so a Kit update that changes the stage is seen. @param {any} stage */
export const stageHash = stage => short(canonical({ tasks: (stage && stage.tasks) || [], ...Object.fromEntries(STAGE_PARTS.filter(k => stage && stage[k] !== undefined).map(k => [k, stage[k]])) }));

/**
 * The Flow a stage is. @param {{ type: string, typeLabel?: string, stage: any, next?: string | null, set?: number | null, kit?: string, template?: string, version?: number | string, authorship?: string }} p
 * @returns {any}
 */
export function stageFlow(p) {
  const st = p.stage || {};
  const key = stageKey({ type: p.type, stage: st.name, set: p.set, template: p.template, version: p.version });
  const steps = (st.tasks || []).map((/** @type {any} */ t, /** @type {number} */ i) => {
    const step = /** @type {Record<string, any>} */ ({ id: `task_${i + 1}`, kind: "assign", label: String(t.title).slice(0, 120) });
    for (const k of STEP_PARTS) {
      const v = k === "to" ? t.doer : t[k];
      if (v !== undefined && v !== null) step[k] = v;
    }
    const extra = Object.fromEntries(TASK_EXTRAS.filter(k => t[k] !== undefined).map(k => [k, t[k]]));
    if (Object.keys(extra).length) step.task = extra;
    if (t.required !== false) step.await = true;   // the stage waits for it
    return step;
  });
  // a stage with no to-dos never moves on by itself (a person moves it), so it has no move
  if (p.next && steps.length) steps.push({ id: "move", kind: "stage", label: `Move on to ${p.next}`, type: p.type, record: { expr: "trigger.id" }, to: p.next });
  const playbook = { key, type: p.type, stage: String(st.name), from: stageHash(st), ...Object.fromEntries(STAGE_PARTS.filter(k => st[k] !== undefined).map(k => [k, st[k]])),
    ...(p.set !== undefined && p.set !== null ? { set: p.set } : {}), ...(p.kit ? { kit: p.kit } : {}), ...(p.template ? { template: p.template, version: p.version } : {}) };
  return { format: 1, name: `stage-${short(key)}`, label: `${p.typeLabel || p.type}: ${st.name}`.slice(0, 120), authorship: p.authorship || (p.kit ? "kit" : "human"), playbook, trigger: { on: "stage", type: p.type, stage: String(st.name) }, steps };
}

/** Is this stored Flow a Playbook stage? @param {any} flow */
export const isStageFlow = flow => Boolean(flow && isObj(flow.playbook) && typeof flow.playbook.key === "string");

/**
 * The stage a Flow is: { name, tasks, owner?, hold?, enter_if?, groups? }, the shape the stages module runs and the template body holds. @param {any} flow
 */
export function stageOf(flow) {
  const pb = flow.playbook || {};
  const tasks = (flow.steps || []).filter((/** @type {any} */ s) => s.kind === "assign").map((/** @type {any} */ s) => {
    const t = /** @type {Record<string, any>} */ ({});
    for (const k of STEP_PARTS) { const v = s[k]; if (v === undefined) continue; t[k === "to" ? "doer" : k] = v; }
    if (s.title === undefined && s.label) t.title = s.label;
    for (const [k, v] of Object.entries(isObj(s.task) ? s.task : {})) if (TASK_EXTRAS.includes(k)) t[k] = v;
    // a step that no longer waits is an optional to-do (the builder's "wait for it" switch)
    if (s.await !== true && t.required === undefined) t.required = false;
    return t;
  });
  return { name: String(pb.stage), ...Object.fromEntries(STAGE_PARTS.filter(k => pb[k] !== undefined).map(k => [k, pb[k]])), tasks };
}

/** The next stage a stage Flow moves the record to, or null on the last stage. @param {any} flow */
export const nextOf = flow => { const m = (flow.steps || []).find((/** @type {any} */ s) => s.kind === "stage" && s.id === "move"); return m ? String(m.to) : null; };

/**
 * What is wrong with a stage Flow's shape, or []. It stays a stage: its trigger is its stage's, its steps are to-dos and the one last move, and a to-do names who does it.
 * @param {any} flow @returns {{ path: string, message: string }[]}
 */
export function stageFlowProblems(flow) {
  /** @type {{ path: string, message: string }[]} */ const out = [];
  const bad = (/** @type {string} */ path, /** @type {string} */ message) => out.push({ path, message });
  if (!isObj(flow)) return [{ path: "", message: "a Flow is an object" }];
  for (const k of Object.keys(flow)) if (!["format", "name", "label", "description", "authorship", "playbook", "trigger", "steps", "group", "project", "runs_on"].includes(k)) bad(k, `${k} is not part of a Playbook stage`);
  if (flow.format !== 1) bad("format", "format is 1");
  if (typeof flow.name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(flow.name)) bad("name", "a Flow name is lowercase letters, digits and dashes");
  if (flow.label !== undefined && (typeof flow.label !== "string" || flow.label.length > 120)) bad("label", "a label is a short text");
  if (!["builder", "human", "model", "kit"].includes(flow.authorship)) bad("authorship", "authorship is builder, human, model or kit");
  const pb = flow.playbook;
  if (!isObj(pb) || typeof pb.key !== "string" || typeof pb.type !== "string" || typeof pb.stage !== "string" || !pb.stage) { bad("playbook", "a Playbook stage names its type and its stage"); return out; }
  const t = flow.trigger;
  if (!isObj(t) || t.on !== "stage" || t.type !== pb.type || t.stage !== pb.stage || Object.keys(t).length !== 3) bad("trigger", `a Playbook stage starts when a ${pb.type} enters ${pb.stage}, and only then`);
  if (!Array.isArray(flow.steps)) { bad("steps", "steps are a list"); return out; }
  if (flow.steps.length > 31) bad("steps", "a stage has at most 30 to-dos");
  const ids = new Set();
  flow.steps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    const p = `steps[${i}]`;
    if (!isObj(s)) { bad(p, "a step is an object"); return; }
    if (ids.has(s.id)) bad(`${p}.id`, `two steps are called ${s.id}`);
    ids.add(s.id);
    if (s.kind === "stage") {
      if (s.id !== "move" || i !== flow.steps.length - 1) bad(p, "moving the record on is the stage's last step, called move");
      if (s.type !== pb.type || typeof s.to !== "string" || !s.to) bad(`${p}.to`, "the last step moves the record to the next stage");
      for (const k of Object.keys(s)) if (!["id", "kind", "label", "added_by", "type", "record", "to"].includes(k)) bad(`${p}.${k}`, `${k} is not part of moving the record on`);
      return;
    }
    if (s.kind !== "assign") { bad(`${p}.kind`, "a stage is made of to-dos (Assign a task) and the move to the next stage"); return; }
    if (typeof s.id !== "string" || !STEP_ID.test(s.id)) bad(`${p}.id`, "a to-do's step is called task_<n>");
    // added_by: the runner stamps who added a step (kernel/flows/adders.js)
    for (const k of Object.keys(s)) if (!["id", "kind", "label", "added_by", "await", "task", ...STEP_PARTS].includes(k)) bad(`${p}.${k}`, `${k} is not part of a stage's to-do`);
    if (typeof s.title !== "string" || !s.title.trim() || s.title.length > 200) bad(`${p}.title`, "say what the to-do is");
    if (typeof s.to !== "string" || !WHO.test(s.to)) bad(`${p}.to`, "a to-do goes to person:<id>, teammate:<agent>, role:<name>, group:<role>, lead, owner or creator");
    if (!isObj(s.output) || !OUTPUTS.has(s.output.kind)) bad(`${p}.output`, `an output is one of ${[...OUTPUTS].join(", ")}`);
    if (s.how !== undefined && !["template", "tailor", "assistant", "person"].includes(s.how)) bad(`${p}.how`, "how is template, tailor, assistant or person");
    if (s.checker !== undefined && (typeof s.checker !== "string" || !WHO.test(s.checker))) bad(`${p}.checker`, "an approver is person:<id>, role:<name> or teammate:<agent>");
    if (s.await !== undefined && typeof s.await !== "boolean") bad(`${p}.await`, "await is yes or no");
    if (s.task !== undefined && (!isObj(s.task) || Object.keys(s.task).some(k => !TASK_EXTRAS.includes(k)) || JSON.stringify(s.task).length > 16_384)) bad(`${p}.task`, `task holds only ${TASK_EXTRAS.join(", ")}`);
    if (s.followers !== undefined && !(Array.isArray(s.followers) && s.followers.length <= 10 && s.followers.every((/** @type {any} */ x) => typeof x === "string" && WHO.test(x)))) bad(`${p}.followers`, "followers are up to 10 people, agents or roles");
    if (s.brief !== undefined && (typeof s.brief !== "string" || s.brief.length > 16_000)) bad(`${p}.brief`, "a brief is a text of at most 16000 characters");
    checkSlots(s, p, out);
  });
  return out;
}

/**
 * Compile a stage Flow: its shape, its type, and what it does, for the approval card. It has no caps of its own: every task it makes is the stage module's act under the chain the
 * stages module uses, which the kernel judges at each request.
 * @param {any} flow @param {{ types: Record<string, any> }} cat
 */
export function compileStageFlow(flow, cat) {
  const errors = stageFlowProblems(flow);
  if (!errors.length && !flow.playbook.template && !(cat.types && cat.types[flow.playbook.type])) errors.push({ path: "playbook.type", message: `there is no record type ${flow.playbook.type}` });
  const steps = Array.isArray(flow && flow.steps) ? flow.steps : [];
  const effects = { reads: [], writes: flow && flow.playbook ? [flow.playbook.type] : [], outward: [], services: [], code: [], asks: 0, sealed_uses: [], destinations: [], model_steps: [], needs_run_ask: false,
    assigns: steps.filter((/** @type {any} */ s) => s && s.kind === "assign").map((/** @type {any} */ s) => ({ step: s.id, to: String(s.to), checker: s.checker || (s.approver && s.approver.who) || null, output: s.output && s.output.kind })) };
  const warnings = flow && flow.authorship === "kit" ? [{ path: "", message: "from a Kit: its text counts as external until a person has reviewed it" }] : [];
  return { ok: errors.length === 0, errors, warnings, effects, caps: [], flow };
}
