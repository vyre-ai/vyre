// @ts-check
// The pure half of the Flow builder: a Flow as a sentence ("When X, do Y"). A draft is what a person edits; `toDefinition` writes it as the stored Flow the box checks (kernel/flows/schema.js),
// so the builder adds no new kind of step: Create a record is `create`, Start a project is `call work.start-project`, Hand to an agent is `agent`, Assign a task is `assign`,
// Send an email is `call comms.send`, Wait for a yes is `ask`, Update a record is `update`.

/** @typedef {{ name: string, label: string }} Named */
/** @typedef {{ name: string, label: string, fields?: Named[] }} TypeOpt  an object (record table) and its fields */
/** @typedef {{ kind: string, type?: string, stage?: string, every?: string, path?: string, raw?: any }} Trigger */
/** @typedef {{ id: string, kind: string, [k: string]: any }} DraftStep */
/** @typedef {{ name: string, id?: string, group?: string, trigger: Trigger, steps: DraftStep[], rest?: Record<string, any> }} Draft  `id` is the stored name (kept when a stored Flow is edited); `rest` is every other key the stored Flow had, kept as is */
/** @typedef {{ id: string, name: string, stages: { name: string, tasks: { title: string, doer: string }[] }[] }} TemplateOpt */
/** @typedef {{ name: string, label: string, staff?: boolean }} AgentOpt  `staff`: made by an owner or an admin, the only agents that may approve */
/** @typedef {{ types: TypeOpt[], agents: AgentOpt[], templates: TemplateOpt[], roles: Named[], people: Named[], flows?: Named[], recordsOf?: (type: string) => Promise<{ urn: string, label: string }[]> }} Options  `recordsOf` lists some records of an object for the tag picker */

import { findStep, flat } from "./tree.js";

export const TRIGGERS = /** @type {const} */ ([
  { id: "created", icon: "records", label: "A record is created", hint: "For example a new refund request" },
  { id: "stage", icon: "board", label: "A record enters a stage", hint: "For example a matter enters Drafting" },
  { id: "signup", icon: "person", label: "A person signs up", hint: "From your sign-up form" },
  { id: "form", icon: "list", label: "A form is submitted", hint: "Any form or link that calls the Flow" },
  { id: "schedule", icon: "clock", label: "On a schedule", hint: "Every day, every Monday, every hour" },
  { id: "manual", icon: "play", label: "Someone runs it", hint: "A person or an agent presses Run" },
]);

/** The step palette, grouped. `soon` ones are shown and cannot be picked yet. Words are what a person searches for. */
export const STEP_GROUPS = /** @type {const} */ ([
  { name: "Logic", items: [
    { kind: "decide", icon: "sort", label: "If / else", hint: "Do one thing when a condition holds, another when it does not", words: "if else branch condition when otherwise" },
    { kind: "repeat", icon: "refresh", label: "For each", hint: "Do the same steps for every record in a list", words: "repeat loop each every list" },
    { kind: "parallel", icon: "list", label: "Side by side", hint: "Do several things at once, then carry on", words: "parallel branch together same time" },
    { kind: "wait", icon: "clock", label: "Wait", hint: "Pause for minutes, hours or days", words: "delay pause sleep timer later" },
    { kind: "ask", icon: "hand", label: "Wait for someone's yes", hint: "The Flow pauses until they answer", words: "ask approve approval question decision" },
  ] },
  { name: "Records", items: [
    { kind: "find", icon: "search", label: "Find records", hint: "Look records up in an object", words: "search lookup query fetch get" },
    { kind: "create", icon: "records", label: "Create a record", hint: "Add a row to one of your objects", words: "add new insert" },
    { kind: "update", icon: "edit", label: "Update a record", hint: "Change a field on a record", words: "change set edit write" },
    { kind: "upsert", icon: "refresh", label: "Create or update", hint: "Update the record that matches, or make it", words: "upsert match merge" },
    { kind: "remove", icon: "trash", label: "Remove a record", hint: "Take a record out", words: "delete" },
    { kind: "stage", icon: "board", label: "Move to a stage", hint: "Put a record in another stage", words: "pipeline status move" },
  ] },
  { name: "Calculate", items: [
    { kind: "formula", icon: "chart", label: "Formula", hint: "Work out a value, with a live preview", words: "math calculate sum total round percent expression" },
  ] },
  { name: "Send", items: [
    { kind: "email", icon: "mail", label: "Send an email", hint: "Through your space's sending service", words: "mail message resend" },
    { kind: "sms", icon: "phone", label: "Send a text", hint: "An SMS through your sending account", words: "sms text twilio message" },
  ] },
  { name: "AI", items: [
    { kind: "agent", icon: "agents", label: "Hand to an agent", hint: "With your instructions and the details", words: "assistant ai robot" },
    { kind: "classify", icon: "filter", label: "Sort into groups", hint: "An AI step reads text and picks one group", words: "classify categorize label" },
    { kind: "extract", icon: "file", label: "Pull out facts", hint: "An AI step reads text and returns fields", words: "extract parse read" },
  ] },
  { name: "Work", items: [
    { kind: "assign", icon: "task", label: "Assign a task", hint: "To a person, a team or role, or an agent", words: "todo give delegate" },
    { kind: "project", icon: "projects", label: "Start a project", hint: "From a template, linked to a record", words: "template" },
    { kind: "subflow", icon: "flows", label: "Run another flow", hint: "Use a flow you already made", words: "subflow call nested" },
  ] },
]);

/** Every step choice, flat. */
export const STEP_CHOICES = STEP_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.name })));

/** The palette for what a person typed: every choice whose name, hint or words contain each word. An empty search is the whole palette. @param {string} q */
export function searchChoices(q) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  return STEP_GROUPS.map((g) => ({ name: g.name, items: g.items.filter((i) => words.every((w) => `${i.label} ${i.hint} ${i.words}`.toLowerCase().includes(w))) })).filter((g) => g.items.length);
}

export const choiceOf = (/** @type {string} */ kind) => (kind === "parallel" ? STEP_CHOICES.find((c) => c.kind === "parallel") : STEP_CHOICES.find((c) => c.kind === kind));
export const triggerOf = (/** @type {string} */ kind) => TRIGGERS.find((t) => t.id === kind);

const named = (/** @type {Named[]} */ list, /** @type {string | undefined} */ id) => (list.find((x) => x.name === id)?.label) || id || "";
const lc = (/** @type {string} */ s) => (s && /^[A-Z]/.test(s) && !/[A-Z]/.test(s[1] ?? "") ? s[0].toLowerCase() + s.slice(1) : s);

/** @param {Options} o */
export const emptyOptions = (o = /** @type {any} */ ({})) => ({ types: o.types || [], agents: o.agents || [], templates: o.templates || [], roles: o.roles || [], people: o.people || [], ...(o.recordsOf ? { recordsOf: o.recordsOf } : {}) });

/** @param {Trigger} t @param {Options} o  "a record is created in RefundRequests" */
export function triggerPhrase(t, o) {
  const type = named(o.types, t.type);
  switch (t.kind) {
    case "created": return type ? `a record is created in the ${type} object` : "a record is created";
    case "stage": return `${type ? `a ${type} record` : "a record"} enters ${t.stage || "a stage"}`;
    case "signup": return "a person signs up";
    case "form": return t.path ? `the form ${t.path} is submitted` : "a form is submitted";
    case "schedule": return t.every ? `it is ${t.every.toLowerCase()}` : "it is time";
    case "advanced": return "it starts in a way the builder cannot show yet";
    default: return "someone runs it";
  }
}

/** Who a task goes to, in words. @param {string | undefined} who "role:attorney", "agent:refunds", "person:ana", "lead", "owner" @param {Options} o */
export function whoWords(who, o) {
  if (!who) return "someone";
  if (who === "lead") return "the project lead";
  if (who === "owner") return "the owner";
  const [kind, id] = who.split(":");
  if (kind === "role") return `the ${named(o.roles, id)} team`;
  if (kind === "agent") return `the ${named(o.agents, id)} agent`;
  if (kind === "person") return named(o.people, id);
  return who;
}

/** The step in one plain sentence (what a collapsed card shows). @param {DraftStep} s @param {Options} o @param {Draft} [d] the Flow it is in, to name a record an earlier step made */
export function stepSummary(s, o, d) {
  switch (s.kind) {
    case "create": return `Create a ${named(o.types, s.type) || "new"} record${s.fields && s.fields.length ? ` with ${s.fields.map((/** @type {any} */ f) => f.field).filter(Boolean).join(", ")}` : ""}`;
    case "project": {
      const t = o.templates.find((x) => x.id === s.template);
      return `Start a project from the ${t ? t.name : "chosen"} template${s.link ? ` and link it to ${linkWords(s.link, d, o)}` : ""}`;
    }
    case "agent": return `Hand it to the ${named(o.agents, s.agent) || "chosen"} agent${s.instructions && s.instructions.trim() ? " with your instructions" : ""}${crew(s, o)}`;
    case "assign": return `Ask ${whoWords(s.to, o)} to ${s.title && s.title.trim() ? lc(s.title.trim()) : "do a task"}${crew(s, o)}`;
    case "email": return `Email ${s.to && s.to.trim() ? (/^\{.*\}$/.test(s.to.trim()) ? "the address from the form" : s.to.trim()) : "someone"}`;
    case "ask": return `Wait for ${whoWords(s.to, o)} to say yes${s.title && s.title.trim() ? `: ${s.title.trim()}` : ""}`;
    case "update": return `Set ${s.field && s.field.trim() ? s.field.trim() : "a field"} to ${s.value && s.value.trim() ? s.value.trim() : "a value"} on ${linkWords(s.record, d, o)}`;
    case "find": return `Find ${named(o.types, s.type) || "records"}${(s.where || "").trim() ? ` where ${s.where.trim()}` : ""}`;
    case "upsert": return `Create or update a ${named(o.types, s.type) || "new"} record, matched by ${(s.matchFields || []).map((/** @type {any} */ f) => f.field).filter(Boolean).join(", ") || "a field"}`;
    case "remove": return `Remove ${linkWords(s.record, d, o)}`;
    case "stage": return `Move ${linkWords(s.record, d, o)} to ${(s.to || "").trim() || "a stage"}`;
    case "wait": return `Wait ${s.amount || 1} ${Number(s.amount || 1) === 1 ? String(s.unit || "hours").replace(/s$/, "") : s.unit || "hours"}`;
    case "formula": return `Work out ${(s.formula || "").trim() || "a value"}`;
    case "sms": return `Text ${s.to && s.to.trim() ? (/^\{.*\}$/.test(s.to.trim()) ? "the number from the form" : s.to.trim()) : "someone"}`;
    case "classify": return `Sort the text into ${String(s.labels || "").split(",").map((x) => x.trim()).filter(Boolean).join(" or ") || "groups"}`;
    case "extract": return `Pull out ${(s.fields || []).map((/** @type {any} */ f) => f.name).filter(Boolean).join(", ") || "facts"} from the text`;
    case "subflow": return `Run the flow ${named(o.flows || [], s.flow) || "chosen"}`;
    case "decide": return `If ${condWords(s.cond, d ? d.trigger : { kind: "manual" })}: ${(s.then || []).length} step${(s.then || []).length === 1 ? "" : "s"}, otherwise ${(s.else || []).length}`;
    case "repeat": return `For each item${s.over ? ` of ${s.over}` : ""}: ${(s.steps || []).length} step${(s.steps || []).length === 1 ? "" : "s"}`;
    case "parallel": return `Do ${(s.lanes || []).length} things side by side, then carry on`;
    case "advanced": return s.summary || `Advanced step (${s.raw?.kind || "other"})`;
    default: return choiceOf(s.kind)?.label || s.kind;
  }
}

/** ", checked by X, followed by N" for a step that has them. @param {DraftStep} s @param {Options} o */
const crew = (s, o) => `${s.checker ? `, checked by ${whoWords(s.checker, o)}` : ""}${Array.isArray(s.followers) && s.followers.length ? `, followed by ${s.followers.length === 1 ? whoWords(s.followers[0], o) : `${s.followers.length} others`}` : ""}`;

/** @param {string | undefined} ref "trigger" or a step id @param {Draft} [d] @param {Options} [o] */
export function linkWords(ref, d, o) {
  if (!ref) return "no record";
  if (ref === "trigger") return "the record that started the Flow";
  const made = d && findStep(d.steps, ref);
  const type = made && o ? named(o.types, made.type) : "";
  return type ? `the new ${type} record` : "the record made before";
}

/** The whole Flow as one sentence: "When a record is created in RefundRequests, create a RefundRequests record, then hand it to the Refunds agent." @param {Draft} d @param {Options} o */
export function flowSentence(d, o) {
  const parts = d.steps.map((s) => lc(stepSummary(s, o, d)));
  const shown = parts.slice(0, 3);
  const rest = parts.length - shown.length;
  const body = !shown.length ? "do nothing yet" : shown.join(", then ") + (rest > 0 ? `, then ${rest} more step${rest === 1 ? "" : "s"}` : "");
  return `When ${triggerPhrase(d.trigger, o)}, ${body}.`;
}

/** What a step still needs before the Flow can be saved, in words, or null. @param {DraftStep} s @param {Options} o */
export function stepProblem(s, o) {
  void o;
  switch (s.kind) {
    case "create": return s.type ? (s.fields || []).some((/** @type {any} */ f) => f.field && f.field.trim()) ? null : "Add at least one field." : "Choose which object to create a record in.";
    case "project": return s.template ? null : "Choose a project template.";
    case "agent": return !s.agent ? "Choose the agent." : !s.record ? "Choose the record to hand over. Create one in an earlier step first." : !(s.instructions || "").trim() ? "Tell the agent what to do with it." : null;
    case "assign": return !s.to ? "Choose who it goes to." : !(s.title || "").trim() ? "Say what the task is." : null;
    case "email": return !(s.to || "").trim() ? "Say who it goes to." : !(s.body || "").trim() ? "Write the email." : null;
    case "ask": return !s.to ? "Choose who is asked." : !(s.title || "").trim() ? "Say what they are asked." : null;
    case "update": return !s.record ? "Choose which record. Create one in an earlier step first, or start from a record." : !(s.field || "").trim() ? "Name the field." : null;
    case "find": case "remove": return s.type ? (s.kind === "remove" && !s.record ? "Choose which record." : null) : "Choose an object.";
    case "upsert": return !s.type ? "Choose an object." : !(s.matchFields || []).some((/** @type {any} */ f) => (f.field || "").trim()) ? "Say which field finds an existing record." : null;
    case "stage": return !s.type ? "Choose an object." : !s.record ? "Choose which record." : !(s.to || "").trim() ? "Name the stage." : null;
    case "wait": return Number(s.amount) > 0 ? null : "Say how long to wait.";
    case "formula": return (s.formula || "").trim() ? null : "Write the formula.";
    case "sms": return !(s.to || "").trim() ? "Say who it goes to." : !(s.body || "").trim() ? "Write the text." : null;
    case "classify": return !(s.input || "").trim() ? "Say what to read." : String(s.labels || "").split(",").filter((x) => x.trim()).length < 2 ? "Give at least two groups, separated by commas." : null;
    case "extract": return !(s.input || "").trim() ? "Say what to read." : !(s.fields || []).some((/** @type {any} */ f) => (f.name || "").trim()) ? "Name at least one fact to pull out." : null;
    case "subflow": return s.flow ? null : "Choose the flow to run.";
    case "decide": return s.cond && s.cond.mode === "formula" ? ((s.cond.formula || "").trim() ? null : "Write the condition.") : !s.cond || !(s.cond.field || "").trim() || String(s.cond.value ?? "").trim() === "" ? "Say what to check: a field, how, and a value." : null;
    case "repeat": return (s.over || "").trim() ? null : "Choose the list to go through.";
    default: return null;
  }
}

/** @param {Draft} d @param {Options} o @returns {string[]} */
export function draftProblems(d, o) {
  const out = [];
  if (!d.name.trim()) out.push("Give the Flow a name.");
  const t = d.trigger;
  if ((t.kind === "created" || t.kind === "stage") && !t.type) out.push("Choose the object that starts it.");
  if (t.kind === "stage" && !(t.stage || "").trim()) out.push("Name the stage that starts it.");
  if (t.kind === "schedule" && !t.every) out.push("Choose how often it runs.");
  if (!d.steps.length) out.push("Add a first step.");
  flat(d.steps).forEach((s, i) => { const p = stepProblem(s, o); if (p) out.push(`Step ${i + 1}: ${p}`); });
  return out;
}

const EVERY = /** @type {Record<string, { cron: string }>} */ ({ "Every hour": { cron: "0 * * * *" }, "Every day": { cron: "0 9 * * *" }, "Every Monday": { cron: "0 9 * * 1" } });
export const EVERY_CHOICES = Object.keys(EVERY);

/** A text value the person typed: a whole value like {email} reads that field of what started the Flow, anything else is the text itself. @param {string} t */
export const val = (t) => { const m = /^\{([a-z0-9_.]+)\}$/i.exec(String(t ?? "").trim()); return m ? { expr: /^(steps|event|row|item)\./.test(m[1]) ? m[1] : `trigger.${m[1]}` } : t; };
/** The other way: what a stored value says when it is shown for editing. @param {any} v */
const unval = (v) => { const e = exprOf(v); const m = e && /^(?:trigger\.([a-z0-9_.]+)|((?:steps|event|row|item)\.[a-z0-9_.]+))$/i.exec(e); return m ? `{${m[1] || m[2]}}` : typeof v === "string" ? v : null; };

/** Whether what starts the Flow is itself a record (a created or stage trigger), so steps can use "the record that started the Flow". @param {Trigger} t */
export const isRecordTrigger = (t) => t.kind === "created" || t.kind === "stage";

const slug = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "flow";

/** @param {Trigger} t */
export function triggerDefinition(t) {
  switch (t.kind) {
    case "created": return { on: "event", event: `${t.type}.created` };
    case "stage": return { on: "stage", type: String(t.type), stage: String(t.stage) };
    case "signup": return { on: "web", path: "signup" };
    case "form": return { on: "web", path: slug(t.path || "form").replace(/_/g, "-") };
    case "schedule": return { on: "time", cron: (EVERY[t.every || ""] || EVERY["Every day"]).cron };
    default: return { on: "manual" };
  }
}

/** The expression for the record an earlier step made, or what started the Flow. @param {string | undefined} ref */
const rec = (ref) => ({ expr: !ref || ref === "trigger" ? "event.subject" : `steps.${ref}.record.id` });

/** The doer string the kernel takes. @param {string} who */
const doer = (who) => (who.startsWith("agent:") ? `teammate:${who.slice(6)}` : who);

/** @param {DraftStep} s @param {Draft} d */
export function stepDefinition(s, d) {
  const label = s.label || undefined;
  void d;
  switch (s.kind) {
    case "advanced": return s.raw;
    case "find": return { id: s.id, kind: "find", type: s.type, ...((s.where || "").trim() ? { where: s.where.trim() } : {}), limit: Number(s.limit) > 0 ? Number(s.limit) : 20 };
    case "upsert": return { id: s.id, kind: "upsert", type: s.type, match: pairs(s.matchFields), set: pairs(s.fields) };
    case "remove": return { id: s.id, kind: "remove", type: s.type, record: rec(s.record) };
    case "stage": return { id: s.id, kind: "stage", type: s.type, record: rec(s.record), to: (s.to || "").trim() };
    case "wait": return { id: s.id, kind: "wait", for_ms: Math.max(60_000, Number(s.amount || 1) * (UNITS[s.unit || "hours"] || 3_600_000)) };
    case "formula": return { id: s.id, kind: "fn", language: "js", source: FORMULA_SOURCE, hash: FORMULA_HASH, inputs: { value: { expr: (s.formula || "").trim() || "0" } }, outputs: ["value"] };
    case "sms": return { id: s.id, kind: "call", action: "comms.send", resource: "vyre://space/comms", input: { via: "sms", to: val(s.to), body: val(s.body) } };
    case "classify": return { id: s.id, kind: "classify", input: val(s.input), labels: String(s.labels || "").split(",").map((x) => x.trim()).filter(Boolean) };
    case "extract": return { id: s.id, kind: "extract", input: val(s.input), fields: (s.fields || []).filter((/** @type {any} */ f) => f.name && f.name.trim()).map((/** @type {any} */ f) => ({ name: slug(f.name), kind: f.kind || "text" })) };
    case "subflow": return { id: s.id, kind: "subflow", flow: s.flow, input: pairs(s.fields) };
    case "decide": return { id: s.id, kind: "decide", if: condExpr(s.cond, d.trigger) || "false", then: (s.then || []).map((/** @type {DraftStep} */ x) => stepDefinition(x, d)), else: (s.else || []).map((/** @type {DraftStep} */ x) => stepDefinition(x, d)) };
    case "repeat": return { id: s.id, kind: "repeat", over: s.over || "steps.none.rows", as: s.as || "item", max: 50, steps: (s.steps || []).map((/** @type {DraftStep} */ x) => stepDefinition(x, d)) };
    case "parallel": return { id: s.id, kind: "parallel", steps: (s.lanes || []).map((/** @type {any} */ l, /** @type {number} */ i) => ({ id: `${s.id}_lane${i + 1}`, kind: "branch", steps: (l.steps || []).map((/** @type {DraftStep} */ x) => stepDefinition(x, d)) })) };
    case "create": return { id: s.id, kind: "create", type: s.type, set: Object.fromEntries((s.fields || []).filter((/** @type {any} */ f) => f.field && f.field.trim()).map((/** @type {any} */ f) => [slug(f.field), val(f.value)])) };
    case "project": return { id: s.id, kind: "call", action: "work.start-project", resource: "vyre://space/work", input: { template: s.template, name: val((s.name || "").trim()) || { expr: "trigger.name" }, ...(s.link ? { client: rec(s.link) } : {}) } };
    case "agent": return { id: s.id, kind: "agent", assistant: doer(`agent:${s.agent}`), title: (s.title || "").trim() || "Handle this case", instructions: s.instructions, output: { kind: "note" }, record: rec(s.record), await: true, ...(label ? { label } : {}), ...peopleOf(s) };
    case "assign": return { id: s.id, kind: "assign", to: doer(s.to), title: s.title, output: { kind: "note" }, ...(s.brief && s.brief.trim() ? { brief: s.brief } : {}), ...peopleOf(s) };
    case "email": return { id: s.id, kind: "call", action: "comms.send", resource: "vyre://space/comms", input: { via: "email", to: val(s.to), subject: val(s.subject || ""), body: val(s.body) } };
    case "ask": return { id: s.id, kind: "ask", to: doer(s.to), title: s.title };
    case "update": return { id: s.id, kind: "update", type: s.type || "record", record: rec(s.record), set: { [slug(s.field || "field")]: s.value || "" } };
    default: throw new Error(`no step kind ${s.kind}`);
  }
}

/** Field rows as a stored object: the field's slug and a typed value. @param {any[] | undefined} rows */
const pairs = (rows) => Object.fromEntries((rows || []).filter((/** @type {any} */ f) => f.field && f.field.trim()).map((/** @type {any} */ f) => [slug(f.field), val(f.value)]));
const UNITS = /** @type {Record<string, number>} */ ({ minutes: 60_000, hours: 3_600_000, days: 86_400_000 });
export const UNIT_CHOICES = /** @type {[string, string][]} */ ([["minutes", "minutes"], ["hours", "hours"], ["days", "days"]]);
/** A formula is a Code step that returns one value: the engine evaluates the expression (its own language, kernel/flows/expr.js) before the code runs. `FORMULA_HASH` is the hash of this source, checked by a test. */
export const FORMULA_SOURCE = "return { value: inputs.value };";
export const FORMULA_HASH = "7qwxhVRKeL6pL4KISfzabcHuuGGlWbVtqWloRYyYn_c";

/** The approver, the followers and what they are told, as the stored step has them. @param {DraftStep} s */
export function peopleOf(s) {
  const notes = { ...(s.approverNote && s.approverNote.trim() ? { approver: s.approverNote } : {}), ...(s.followerNote && s.followerNote.trim() ? { followers: s.followerNote } : {}) };
  return { ...(s.checker ? { checker: doer(s.checker) } : {}), ...(Array.isArray(s.followers) && s.followers.length ? { followers: s.followers.map(doer) } : {}), ...(Object.keys(notes).length ? { notes } : {}) };
}

/** The stored Flow for a draft. @param {Draft} d */
export function toDefinition(d) {
  return { format: 1, name: d.id || slug(d.name), label: d.name.trim(), authorship: /** @type {const} */ ("builder"), ...(d.group ? { group: d.group } : {}), trigger: d.trigger.kind === "advanced" ? d.trigger.raw : triggerDefinition(d.trigger), steps: d.steps.map((s) => stepDefinition(s, d)), ...(d.rest || {}) };
}

/** A fresh step with sensible choices from the others. @param {string} kind @param {Draft} d @param {Options} o @returns {DraftStep} */
export function newStep(kind, d, o) {
  const all = flat(d.steps);
  let n = all.length + 1;
  while (all.some((s) => s.id === `${kind}${n}`)) n++;
  const id = `${kind}${n}`;
  const lastMade = [...all].reverse().find((s) => s.kind === "create");
  const link = lastMade ? lastMade.id : isRecordTrigger(d.trigger) ? "trigger" : "";
  switch (kind) {
    case "create": return { id, kind, type: d.trigger.kind === "created" ? "" : d.trigger.type || "", fields: [{ field: "", value: "" }] };
    case "project": return { id, kind, template: o.templates[0]?.id || "", name: "", link };
    case "agent": return { id, kind, agent: o.agents[0]?.name || "", title: "", instructions: "", record: link };
    case "assign": return { id, kind, to: "role:" + (o.roles[0]?.name || "owner"), title: "" };
    case "email": return { id, kind, to: "", subject: "", body: "" };
    case "ask": return { id, kind, to: "role:" + (o.roles[0]?.name || "owner"), title: "" };
    case "find": return { id, kind, type: "", where: "", limit: 20 };
    case "upsert": return { id, kind, type: "", matchFields: [{ field: "", value: "" }], fields: [{ field: "", value: "" }] };
    case "remove": return { id, kind, type: lastMade?.type || "", record: link };
    case "stage": return { id, kind, type: lastMade?.type || d.trigger.type || "", record: link, to: "" };
    case "wait": return { id, kind, amount: 1, unit: "days" };
    case "formula": return { id, kind, formula: "" };
    case "sms": return { id, kind, to: "", body: "" };
    case "classify": return { id, kind, input: "", labels: "" };
    case "extract": return { id, kind, input: "", fields: [{ name: "", kind: "text" }] };
    case "subflow": return { id, kind, flow: o.flows?.[0]?.name || "", fields: [{ field: "", value: "" }] };
    case "decide": return { id, kind, cond: { mode: "build", source: "trigger", field: "", op: ">", value: "" }, then: [], else: [] };
    case "repeat": return { id, kind, over: "", as: "item", steps: [] };
    case "parallel": return { id, kind, lanes: [{ steps: [] }, { steps: [] }] };
    default: return { id, kind, record: link, type: lastMade?.type || d.trigger.type || "", field: "", value: "" };
  }
}

/** Who a task can go to, as [value, label] for a Select. @param {Options} o @returns {[string, string][]} */
export function whoChoices(o) {
  return [...[{ name: "owner", label: "Owner" }, ...o.roles.filter((r) => r.name !== "owner")].map(/** @returns {[string, string]} */ (r) => [`role:${r.name}`, `A team or role: ${r.label}`]), ...o.agents.map(/** @returns {[string, string]} */ (a) => [`agent:${a.name}`, `Agent: ${a.label}`]), ...o.people.map(/** @returns {[string, string]} */ (p) => [`person:${p.name}`, p.label])];
}

/** Move a step up or down (dir -1 or 1). @template T @param {T[]} list @param {number} i @param {number} dir */
export function moveStep(list, i, dir) {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const n = [...list];
  [n[i], n[j]] = [n[j], n[i]];
  return n;
}

/** After a step is removed, a step that pointed at it points at what started the Flow. @param {DraftStep[]} steps @param {string} id */
export function removeStep(steps, id) {
  return steps.filter((s) => s.id !== id).map((s) => {
    const n = { ...s };
    for (const k of ["link", "record"]) if (n[k] === id) n[k] = "trigger";
    return n;
  });
}

/** The first stage's tasks of a template, to show what a started project will hand out. @param {TemplateOpt | undefined} t @param {Options} o */
export function firstStageTasks(t, o) {
  const st = t && t.stages[0];
  if (!st) return null;
  return { stage: st.name, tasks: st.tasks.map((k) => ({ title: k.title, who: whoWords(k.doer.startsWith("teammate:") ? `agent:${k.doer.slice(9)}` : k.doer, o) })) };
}

const exprOf = (/** @type {any} */ v) => (v && typeof v === "object" && typeof v.expr === "string" ? v.expr : null);
/** "trigger.record" is what started the Flow, "steps.<id>.record.id" a record an earlier step made. @param {any} v @returns {string | null} */
const refOf = (v) => { const e = exprOf(v); if (e === "event.subject") return "trigger"; const m = e && /^steps\.([a-z0-9_]+)\.record\.id$/i.exec(e); return m ? m[1] : null; };
const keys = (/** @type {any} */ o, /** @type {string[]} */ allowed) => Object.keys(o).every((k) => allowed.includes(k));

/** @param {any} t @returns {Trigger} */
function triggerFrom(t) {
  const raw = { kind: "advanced", raw: t };
  if (!t || typeof t !== "object") return raw;
  if (t.on === "manual" && keys(t, ["on"])) return { kind: "manual" };
  if (t.on === "stage" && keys(t, ["on", "type", "stage"])) return { kind: "stage", type: t.type, stage: t.stage };
  if (t.on === "event" && keys(t, ["on", "event"])) {
    const m = /^([a-z][a-z0-9_]*)\.created$/.exec(t.event || "");
    return m ? { kind: "created", type: m[1] } : raw;
  }
  if (t.on === "web" && keys(t, ["on", "path"])) return t.path === "signup" ? { kind: "signup" } : { kind: "form", path: t.path };
  if (t.on === "time" && keys(t, ["on", "cron"])) {
    const hit = Object.entries(EVERY).find(([, v]) => v.cron === t.cron);
    return hit ? { kind: "schedule", every: hit[0] } : raw;
  }
  return raw;
}

/** Stored field values back to editable rows, or null when one is something the rows cannot say. @param {Record<string, any>} o */
const rowsOf = (o) => { const rows = Object.entries(o || {}).map(([field, v]) => ({ field, value: unval(v) })); return rows.every((r) => r.value !== null) ? (rows.length ? rows : [{ field: "", value: "" }]) : null; };

/** @param {any} s */
const peopleFrom = (s) => ({ ...(s.checker ? { checker: s.checker.startsWith("teammate:") ? `agent:${s.checker.slice(9)}` : s.checker } : {}), ...(Array.isArray(s.followers) ? { followers: s.followers.map((/** @type {string} */ f) => (f.startsWith("teammate:") ? `agent:${f.slice(9)}` : f)) } : {}), ...(s.notes && s.notes.approver ? { approverNote: s.notes.approver } : {}), ...(s.notes && s.notes.followers ? { followerNote: s.notes.followers } : {}) });

/** A stored condition back to the builder's field / operator / value when it is that simple, else the formula as it is. @param {string} e */
function condFrom(e) {
  const m = /^(trigger\.after\.|trigger\.|steps\.([a-z0-9_]+)\.)([A-Za-z0-9_.]+) (==|!=|>=|<=|>|<) (-?\d+(?:\.\d+)?|"[^"]*")$/.exec(e || "");
  if (!m) return { mode: "formula", formula: e || "" };
  return { mode: "build", source: m[2] || "trigger", field: m[3], op: m[4], value: m[5].startsWith('"') ? m[5].slice(1, -1) : m[5] };
}

/** @param {any} s @returns {DraftStep} */
function stepFrom(s) {
  const adv = /** @type {DraftStep} */ ({ id: s.id, kind: "advanced", raw: s, summary: s.label || undefined });
  const who = (/** @type {string} */ v) => (typeof v === "string" && v.startsWith("teammate:") ? `agent:${v.slice(9)}` : v);
  switch (s.kind) {
    case "find": return keys(s, ["id", "kind", "type", "where", "limit", "label"]) ? { id: s.id, kind: "find", type: s.type, where: s.where || "", limit: s.limit ?? 20 } : adv;
    case "upsert": return keys(s, ["id", "kind", "type", "match", "set", "label"]) && rowsOf(s.match) && rowsOf(s.set) ? { id: s.id, kind: "upsert", type: s.type, matchFields: rowsOf(s.match), fields: rowsOf(s.set) } : adv;
    case "remove": return refOf(s.record) && keys(s, ["id", "kind", "type", "record", "label"]) ? { id: s.id, kind: "remove", type: s.type, record: refOf(s.record) } : adv;
    case "stage": return refOf(s.record) && typeof s.to === "string" && keys(s, ["id", "kind", "type", "record", "to", "label"]) ? { id: s.id, kind: "stage", type: s.type, record: refOf(s.record), to: s.to } : adv;
    case "wait": {
      const u = Object.entries(UNITS).reverse().find(([, ms]) => s.for_ms % ms === 0);
      return typeof s.for_ms === "number" && u && keys(s, ["id", "kind", "for_ms", "label"]) ? { id: s.id, kind: "wait", amount: s.for_ms / u[1], unit: u[0] } : adv;
    }
    case "classify": return keys(s, ["id", "kind", "input", "labels", "label"]) && unval(s.input) !== null ? { id: s.id, kind: "classify", input: unval(s.input), labels: (s.labels || []).join(", ") } : adv;
    case "extract": return keys(s, ["id", "kind", "input", "fields", "label"]) && unval(s.input) !== null ? { id: s.id, kind: "extract", input: unval(s.input), fields: (s.fields || []).map((/** @type {any} */ f) => ({ name: f.name, kind: f.kind || "text" })) } : adv;
    case "subflow": return typeof s.flow === "string" && keys(s, ["id", "kind", "flow", "input", "label"]) && rowsOf(s.input || {}) ? { id: s.id, kind: "subflow", flow: s.flow, fields: rowsOf(s.input || {}) } : adv;
    case "fn": return s.source === FORMULA_SOURCE && exprOf(s.inputs && s.inputs.value) !== null && keys(s, ["id", "kind", "language", "source", "hash", "inputs", "outputs", "label"]) ? { id: s.id, kind: "formula", formula: exprOf(s.inputs.value) } : adv;
    case "decide": {
      const cond = condFrom(s.if);
      return typeof s.if === "string" && keys(s, ["id", "kind", "if", "then", "else", "label"]) ? { id: s.id, kind: "decide", cond, then: (s.then || []).map(stepFrom), else: (s.else || []).map(stepFrom) } : adv;
    }
    case "repeat": return typeof s.over === "string" && typeof s.as === "string" && (s.max === undefined || s.max === 50) && keys(s, ["id", "kind", "over", "as", "max", "steps", "label"]) ? { id: s.id, kind: "repeat", over: s.over, as: s.as, steps: (s.steps || []).map(stepFrom) } : adv;
    case "parallel": return (s.steps || []).every((/** @type {any} */ b) => b.kind === "branch" && keys(b, ["id", "kind", "steps"])) && keys(s, ["id", "kind", "steps", "label"]) ? { id: s.id, kind: "parallel", lanes: (s.steps || []).map((/** @type {any} */ b) => ({ steps: (b.steps || []).map(stepFrom) })) } : adv;
    case "create": {
      const set = s.set || {};
      const fields = Object.entries(set).map(([field, v]) => ({ field, value: unval(v) }));
      return fields.every((f) => f.value !== null) && keys(s, ["id", "kind", "type", "set"]) ? { id: s.id, kind: "create", type: s.type, fields: /** @type {any} */ (fields.length ? fields : [{ field: "", value: "" }]) } : adv;
    }
    case "call": {
      const i = s.input || {};
      if (s.action === "work.start-project" && s.resource === "vyre://space/work" && typeof i.template === "string" && keys(i, ["template", "name", "client"])) {
        const link = i.client === undefined ? "" : refOf(i.client);
        const name = exprOf(i.name) === "trigger.name" ? "" : unval(i.name);
        return link === null || name === null ? adv : { id: s.id, kind: "project", template: i.template, name, link: link || undefined };
      }
      if (s.action === "comms.send" && i.via === "sms" && keys(i, ["via", "to", "body"]) && unval(i.to) !== null && unval(i.body) !== null) return { id: s.id, kind: "sms", to: unval(i.to), body: unval(i.body) };
      if (s.action === "comms.send" && i.via === "email" && keys(i, ["via", "to", "subject", "body"]) && unval(i.to) !== null && unval(i.subject || "") !== null && unval(i.body) !== null) return { id: s.id, kind: "email", to: unval(i.to), subject: unval(i.subject || ""), body: unval(i.body) };
      return adv;
    }
    case "agent": {
      const rec = refOf(s.record);
      const ppl = peopleFrom(s);
      return typeof s.assistant === "string" && s.assistant.startsWith("teammate:") && rec && typeof s.instructions === "string" && typeof s.title === "string" && s.output && s.output.kind === "note" && keys(s, ["id", "kind", "assistant", "title", "instructions", "output", "record", "await", "label", "checker", "followers", "notes"])
        ? { id: s.id, kind: "agent", agent: s.assistant.slice(9), title: s.title, instructions: s.instructions, record: rec, ...ppl } : adv;
    }
    case "assign": return typeof s.title === "string" && typeof s.to === "string" && s.output && s.output.kind === "note" && keys(s, ["id", "kind", "to", "title", "output", "brief", "checker", "followers", "notes"]) ? { id: s.id, kind: "assign", to: who(s.to), title: s.title, ...(s.brief ? { brief: s.brief } : {}), ...peopleFrom(s) } : adv;
    case "ask": return typeof s.title === "string" && typeof s.to === "string" && keys(s, ["id", "kind", "to", "title"]) ? { id: s.id, kind: "ask", to: who(s.to), title: s.title } : adv;
    case "update": {
      const rec = refOf(s.record), f = Object.keys(s.set || {});
      return rec && f.length === 1 && typeof s.set[f[0]] === "string" && keys(s, ["id", "kind", "type", "record", "set"]) ? { id: s.id, kind: "update", type: s.type, record: rec, field: f[0], value: s.set[f[0]] } : adv;
    }
    default: return adv;
  }
}

/**
 * A stored Flow as a draft: every step the palette covers becomes an editable step, anything else (and a step with settings the palette cannot say) stays as it was, shown as an Advanced
 * step. Saving writes the same steps back, so opening and saving a Flow never loses what the builder could not show. Keys the builder does not know ride in `rest`.
 * @param {any} flow @returns {Draft}
 */
export function fromDefinition(flow) {
  const { format: _f, name, label, authorship: _a, group, trigger, steps, ...rest } = flow;
  return { id: name, name: label || name, ...(group ? { group } : {}), trigger: triggerFrom(trigger), steps: (steps || []).map(stepFrom), ...(Object.keys(rest).length ? { rest } : {}) };
}

/** Who can approve: a person, a team or role, or an agent made by an owner or an admin (an agent checks internal work only: a send or a stage hold still waits for a person; the kernel checks the maker again each time). @param {Options} o @returns {[string, string][]} */
export const approverChoices = (o) => [["", "Nobody"], ...whoChoices(o).filter(([v]) => !v.startsWith("agent:") || o.agents.some((a) => `agent:${a.name}` === v && a.staff === true))];


/** The operators of a condition, as [symbol, words]. */
export const OPERATORS = /** @type {[string, string][]} */ ([["==", "is"], ["!=", "is not"], [">", "is more than"], ["<", "is less than"], [">=", "is at least"], ["<=", "is at most"]]);

/** What a condition field reads: where it comes from and its name. `source` is "trigger" or an earlier step's id. @param {{ source?: string, field?: string }} c @param {Trigger} t */
export function fieldExpr(c, t) {
  const f = String(c.field || "").trim().replace(/[^A-Za-z0-9_.]/g, "_");
  if (!f) return "";
  if (!c.source || c.source === "trigger") return t.kind === "created" || t.kind === "stage" ? `trigger.after.${f}` : `trigger.${f}`;
  return `steps.${c.source}.${f}`;
}

/** A condition as the expression the engine reads: built from a field, an operator and a value, or the formula as typed. @param {any} c @param {Trigger} t */
export function condExpr(c, t) {
  if (!c) return "";
  if (c.mode === "formula") return String(c.formula || "").trim();
  const left = fieldExpr(c, t);
  if (!left || c.value === undefined || String(c.value).trim() === "") return "";
  const v = String(c.value).trim();
  return `${left} ${c.op || "=="} ${/^-?\d+(\.\d+)?$/.test(v) ? v : JSON.stringify(v)}`;
}

/** A condition in words for a collapsed card. @param {any} c @param {Trigger} t */
export function condWords(c, t) {
  if (!c) return "a condition holds";
  if (c.mode === "formula") return String(c.formula || "").trim() || "a condition holds";
  const op = OPERATORS.find(([x]) => x === c.op)?.[1] || "is";
  return c.field && String(c.value ?? "").trim() !== "" ? `${c.field} ${op} ${c.value}` : "a condition holds";
}
void fieldExpr;


/** The values a box can insert from before this step: what started the Flow and what earlier steps made, as [token, words]. @param {Draft} d @param {string} stepId @param {Options} o @returns {[string, string][]} */
export function valueSources(d, stepId, o) {
  /** @type {[string, string][]} */ const out = [];
  const t = d.trigger;
  if (t.kind === "created" || t.kind === "stage") for (const f of o.types.find((x) => x.name === t.type)?.fields || []) out.push([`{after.${f.name}}`, `${f.label} of the record that started it`]);
  else if (t.kind === "form" || t.kind === "signup") for (const f of ["name", "email", "phone", "message"]) out.push([`{${f}}`, `${f[0].toUpperCase()}${f.slice(1)} from the form`]);
  for (const s of flat(d.steps)) {
    if (s.id === stepId) break;
    if (s.kind === "create" || s.kind === "upsert") out.push([`{steps.${s.id}.record.id}`, `The record made by ${s.id}`]);
    if (s.kind === "find") out.push([`{steps.${s.id}.rows}`, `The records found by ${s.id}`]);
    if (s.kind === "formula") out.push([`{steps.${s.id}.value}`, `The value worked out by ${s.id}`]);
  }
  return out;
}
