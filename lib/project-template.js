// @ts-check
// Project templates (R031-10, 11, 12): the one place that says what a template is, checks it, writes each task's brief and compiles it into the stage list a running project is pinned to. Pure: no store,
// no kernel. A template is data (a record of the Space, versioned by core/work/templates.js), and its tasks are exactly the stage task templates the Flows stage module already runs (kernel/flows/stages.js),
// so nothing here runs anything: it makes sure what is handed to that module is well formed, and that its briefs are written from the same choices the doer is held to.
//
//   template  { name, description?, tags?: string[], roles?: [{ role, agent?, lead? }], stages: [{ name, owner?, moves_on_when?, tasks?: [task] }] }
//   task      { title, doer, checker?, output: { kind, target? }, how?, template?, depends_on?, due_offset_ms?, required?, brief?, checklist?, credentials?, context?, needs_yes?, ask? }
//   stage     "moves on when" is the stage's tasks done (required ones) AND, when given, an expression over the project that must hold; `owner` is who may move it early.
//
//   problems(template, env)   [{ path, message }] and nothing else; an empty list is a valid template
//   compile(template, env)    the pinned stage list: [{ name, owner?, enter_if?, tasks: [task with its brief written] }]
//   briefOf(task, stage, tpl) the brief a doer gets: goal and done-check, context, what needs a yes, who to ask, the checklist and its standard, the credentials it may use

import { parse } from "../kernel/flows/expr.js";
import { checkTaskExtras } from "../kernel/flows/checklist.js";
import { TASK_OUTPUT_KINDS, TASK_HOW } from "../kernel/contracts/index.js";

export const TEMPLATE_LIMITS = Object.freeze({ stages: 40, tasks: 30, roles: 30, name: 120, text: 2000 });
const WHO = /^(teammate|role|person|assistant|actor):[a-z][a-z0-9_.-]*$/;
const OWNER = /^(role|person):[a-z][a-z0-9_.-]*$/;
const ROLE = /^[a-z][a-z0-9-]{0,30}$/;
/** The fields of a project a brief may name as {record.<field>}. */
export const PROJECT_FIELDS = Object.freeze(["name", "slug", "status", "client", "owner", "due", "repo", "tags"]);

const isObj = (/** @type {any} */ v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * @param {any} t a template @param {{ fields?: string[], connections?: string[], readOps?: (c: string) => string[] | null }} [env] what the Space has: its project fields and its Connections' short names
 * @returns {{ path: string, message: string }[]}
 */
export function problems(t, env = {}) {
  /** @type {{ path: string, message: string }[]} */ const out = [];
  const bad = (/** @type {string} */ path, /** @type {string} */ message) => out.push({ path, message });
  if (!isObj(t)) return [{ path: "", message: "a template is { name, stages, roles?, tags? }" }];
  for (const k of Object.keys(t)) if (!["name", "description", "tags", "roles", "stages"].includes(k)) bad(k, `${k} is not part of a template (name, description, tags, roles, stages)`);
  if (typeof t.name !== "string" || !t.name.trim() || t.name.length > TEMPLATE_LIMITS.name) bad("name", `name the template in at most ${TEMPLATE_LIMITS.name} characters`);
  if (t.description !== undefined && (typeof t.description !== "string" || t.description.length > TEMPLATE_LIMITS.text)) bad("description", `a description is text of at most ${TEMPLATE_LIMITS.text} characters`);
  if (t.tags !== undefined && (!Array.isArray(t.tags) || t.tags.length > 20 || t.tags.some((/** @type {any} */ x) => typeof x !== "string"))) bad("tags", "tags are a list of up to 20 words");
  const roles = new Set();
  let leads = 0;
  if (t.roles !== undefined) {
    if (!Array.isArray(t.roles) || t.roles.length > TEMPLATE_LIMITS.roles) bad("roles", `roles are a list of at most ${TEMPLATE_LIMITS.roles}`);
    else t.roles.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
      const p = `roles[${i}]`;
      if (!isObj(r) || typeof r.role !== "string" || !ROLE.test(r.role)) return bad(p, "a role is { role: a lower-case word, agent?: a roster agent, lead?: true }");
      for (const k of Object.keys(r)) if (!["role", "agent", "lead"].includes(k)) bad(`${p}.${k}`, `${k} is not part of a role`);
      if (roles.has(r.role)) bad(p, `two roles are named ${r.role}`);
      roles.add(r.role);
      if (r.agent !== undefined && (typeof r.agent !== "string" || !/^[a-z][a-z0-9-]{1,30}$/.test(r.agent))) bad(`${p}.agent`, "agent is the name of an agent on the roster");
      if (r.lead === true) leads++;
    });
    if (leads > 1) bad("roles", "at most one role is the project lead");
  }
  if (!Array.isArray(t.stages) || t.stages.length < 2 || t.stages.length > TEMPLATE_LIMITS.stages) { bad("stages", `a template has 2 to ${TEMPLATE_LIMITS.stages} stages`); return out; }
  const seen = new Set();
  const fields = env.fields || [...PROJECT_FIELDS];
  t.stages.forEach((s, i) => {
    const sp = `stages[${i}]`;
    if (!isObj(s) || typeof s.name !== "string" || !s.name.trim() || s.name.length > 80) return bad(sp, "a stage is { name, owner?, moves_on_when?, tasks? }");
    for (const k of Object.keys(s)) if (!["name", "owner", "moves_on_when", "tasks"].includes(k)) bad(`${sp}.${k}`, `${k} is not part of a stage (name, owner, moves_on_when, tasks)`);
    if (seen.has(s.name)) bad(sp, `two stages are named ${s.name}`);
    seen.add(s.name);
    if (s.owner !== undefined && (typeof s.owner !== "string" || !OWNER.test(s.owner))) bad(`${sp}.owner`, 'who may move a stage early looks like "role:attorney" or "person:alex"');
    if (s.moves_on_when !== undefined) { try { if (typeof s.moves_on_when !== "string") throw new Error("not text"); parse(s.moves_on_when); } catch (e) { bad(`${sp}.moves_on_when`, `moves_on_when is a condition over the project, like paid == true: ${/** @type {Error} */ (e).message}`); } }
    if (s.tasks === undefined) return;
    if (!Array.isArray(s.tasks) || s.tasks.length > TEMPLATE_LIMITS.tasks) return bad(`${sp}.tasks`, `tasks are a list of at most ${TEMPLATE_LIMITS.tasks}`);
    const titles = new Set();
    s.tasks.forEach((/** @type {any} */ k, /** @type {number} */ j) => {
      const p = `${sp}.tasks[${j}]`;
      if (!isObj(k) || typeof k.title !== "string" || !k.title.trim() || k.title.length > 200) return bad(p, "a task is { title, doer, output, ... }");
      for (const key of Object.keys(k)) if (!["title", "doer", "checker", "output", "how", "template", "depends_on", "due_offset_ms", "required", "brief", "checklist", "credentials", "context", "needs_yes", "ask"].includes(key)) bad(`${p}.${key}`, `${key} is not part of a task`);
      if (titles.has(k.title)) bad(p, `two tasks in ${s.name} are titled ${k.title}`);
      titles.add(k.title);
      if (typeof k.doer !== "string" || (!WHO.test(k.doer) && k.doer !== "creator" && k.doer !== "owner")) bad(`${p}.doer`, 'a doer looks like "role:researcher", "teammate:research", "person:alex" or "owner"');
      else { const r = /^role:(.+)$/.exec(k.doer); if (r && roles.size && !roles.has(r[1])) bad(`${p}.doer`, `${k.doer} is not one of the template's roles (${[...roles].join(", ")})`); }
      if (k.checker !== undefined && (typeof k.checker !== "string" || (!WHO.test(k.checker) && k.checker !== "owner"))) bad(`${p}.checker`, 'a checker looks like "role:attorney" or "person:alex"');
      if (k.ask !== undefined && (typeof k.ask !== "string" || !WHO.test(k.ask))) bad(`${p}.ask`, 'who to ask when stuck looks like "role:attorney" or "person:alex"');
      if (!isObj(k.output) || !TASK_OUTPUT_KINDS.includes(k.output.kind)) bad(`${p}.output`, `output is { kind: one of ${TASK_OUTPUT_KINDS.join(", ")} }`);
      if (k.how !== undefined && !TASK_HOW.includes(k.how)) bad(`${p}.how`, `how is one of ${TASK_HOW.join(", ")}`);
      if (k.depends_on !== undefined && (!Array.isArray(k.depends_on) || k.depends_on.some((/** @type {any} */ d) => !titles.has(d) || d === k.title))) bad(`${p}.depends_on`, "a task depends on titles of EARLIER tasks in the same stage");
      if (k.due_offset_ms !== undefined && !(Number.isInteger(k.due_offset_ms) && k.due_offset_ms > 0)) bad(`${p}.due_offset_ms`, "due_offset_ms is a whole number of milliseconds");
      if (k.required !== undefined && typeof k.required !== "boolean") bad(`${p}.required`, "required is true or false");
      for (const key of ["context", "needs_yes"]) if (k[key] !== undefined && (!Array.isArray(k[key]) || k[key].length > 10 || k[key].some((/** @type {any} */ x) => typeof x !== "string" || x.length > 300))) bad(`${p}.${key}`, `${key} is a list of up to 10 short sentences`);
      out.push(...checkTaskExtras(k, `${p}`, { fields, connections: env.connections || (Array.isArray(k.credentials) ? k.credentials : []), ...(env.readOps ? { readOps: env.readOps } : {}) }));
    });
  });
  return out;
}

/**
 * The brief a doer gets, written from the task's own choices: what to do and how it is known to be done, what it may use, what waits for a person's yes, who to ask, and the standard it is held to.
 * `{record.name}` is filled when the task is made (kernel/flows/checklist.js renderBrief). A brief the author wrote by hand is used as it is. @param {any} task @param {any} stage @param {any} tpl
 */
export function briefOf(task, stage, tpl) {
  if (typeof task.brief === "string" && task.brief.trim()) return task.brief;
  const out = [];
  const done = Array.isArray(task.checklist) && task.checklist.length ? task.checklist.map((/** @type {any} */ c) => c.say).join("; ") : `you mark it done when ${outputWords(task.output)}`;
  out.push(`Goal: ${task.title} for {record.name}. Done when: ${done}.`);
  const ctx = [`the project is {record.name}`, ...((task.context || []).map(String))];
  out.push(`Context: ${ctx.join("; ")}.`);
  const yes = [...(task.needs_yes || []).map(String), ...(task.output && task.output.kind === "sent" ? ["sending it out"] : [])];
  out.push(yes.length ? `Needs a yes before it happens: ${yes.join("; ")}.` : "Needs a yes: nothing; everything you do here stays inside the project.");
  const who = task.ask || (stage && stage.owner) || (task.checker ? String(task.checker) : "");
  if (who) out.push(`If you are stuck, ask ${who}.`);
  if (tpl && tpl.name) out.push(`This task is part of the ${tpl.name} template, stage ${stage ? stage.name : ""}.`.replace(/, stage \.$/, "."));
  return out.join("\n");
}

const outputWords = (/** @type {any} */ o) => (o && o.kind === "decision" ? "a decision is recorded" : o && o.kind === "sent" ? "it has been sent" : o && o.kind === "file" ? "the file is saved to the project" : o && o.kind === "fields" ? "the fields are filled in" : "your note is on the project");

/**
 * The stage list a project is pinned to: each task with its brief written, "moves on when" turned into the next stage's entry condition (the same `enter_if` Kits use), and nothing else added.
 * @param {any} t a valid template @returns {{ name: string, owner?: string, enter_if?: string, tasks?: any[] }[]}
 */
export function compile(t) {
  return t.stages.map((/** @type {any} */ s, /** @type {number} */ i) => {
    const prev = i > 0 ? t.stages[i - 1] : null;
    const tasks = (s.tasks || []).map((/** @type {any} */ k) => {
      const { context: _c, needs_yes: _n, ask: _a, ...rest } = k;
      return { ...rest, brief: briefOf(k, s, t) };
    });
    return { name: s.name, ...(s.owner ? { owner: s.owner } : {}), ...(prev && prev.moves_on_when ? { enter_if: prev.moves_on_when } : {}), ...(tasks.length ? { tasks } : {}) };
  });
}

/** The text a project stores to be pinned to this version of a template. @param {any} t a valid template @param {{ id: string, version: number }} at */
export const snapshotOf = (t, at) => JSON.stringify({ template: at.id, version: at.version, name: t.name, stages: compile(t) });
