// @ts-check
// The pure half of the Flow builder: a Flow as a sentence ("When X, do Y"). A draft is what a person edits; `toDefinition` writes it as the stored Flow the box checks (kernel/flows/schema.js),
// so the builder adds no new kind of step: Create a record is `create`, Start a project is `call work.start-project`, Hand to an agent is `agent`, Assign a task is `assign`,
// Send an email is `call comms.send`, Wait for a yes is `ask`, Update a record is `update`.

/** @typedef {{ name: string, label: string }} Named */
/** @typedef {{ kind: string, type?: string, stage?: string, every?: string, path?: string, raw?: any }} Trigger */
/** @typedef {{ id: string, kind: string, [k: string]: any }} DraftStep */
/** @typedef {{ name: string, id?: string, group?: string, trigger: Trigger, steps: DraftStep[], rest?: Record<string, any> }} Draft  `id` is the stored name (kept when a stored Flow is edited); `rest` is every other key the stored Flow had, kept as is */
/** @typedef {{ id: string, name: string, stages: { name: string, tasks: { title: string, doer: string }[] }[] }} TemplateOpt */
/** @typedef {{ types: Named[], agents: Named[], templates: TemplateOpt[], roles: Named[], people: Named[] }} Options */

export const TRIGGERS = /** @type {const} */ ([
  { id: "created", icon: "records", label: "A record is created", hint: "For example a new refund request" },
  { id: "stage", icon: "board", label: "A record enters a stage", hint: "For example a matter enters Drafting" },
  { id: "signup", icon: "person", label: "A person signs up", hint: "From your sign-up form" },
  { id: "form", icon: "list", label: "A form is submitted", hint: "Any form or link that calls the Flow" },
  { id: "schedule", icon: "clock", label: "On a schedule", hint: "Every day, every Monday, every hour" },
  { id: "manual", icon: "play", label: "Someone runs it", hint: "A person or an agent presses Run" },
]);

/** The step choices. A `soon` one is shown and cannot be picked yet (none today). */
export const STEP_CHOICES = /** @type {const} */ ([
  { kind: "create", icon: "records", label: "Create a record", hint: "Add a row to one of your record types" },
  { kind: "project", icon: "projects", label: "Start a project", hint: "From a template, linked to a record" },
  { kind: "agent", icon: "agents", label: "Hand to an agent", hint: "With your instructions and the details" },
  { kind: "assign", icon: "task", label: "Assign a task", hint: "To a person, a team or role, or an agent" },
  { kind: "email", icon: "mail", label: "Send an email", hint: "Through your space's sending service" },
  { kind: "ask", icon: "hand", label: "Wait for someone's yes", hint: "The Flow pauses until they answer" },
  { kind: "update", icon: "edit", label: "Update a record", hint: "Change a field on a record" },
]);

export const choiceOf = (/** @type {string} */ kind) => STEP_CHOICES.find((c) => c.kind === kind);
export const triggerOf = (/** @type {string} */ kind) => TRIGGERS.find((t) => t.id === kind);

const named = (/** @type {Named[]} */ list, /** @type {string | undefined} */ id) => (list.find((x) => x.name === id)?.label) || id || "";
const lc = (/** @type {string} */ s) => (s && /^[A-Z]/.test(s) && !/[A-Z]/.test(s[1] ?? "") ? s[0].toLowerCase() + s.slice(1) : s);

/** @param {Options} o */
export const emptyOptions = (o = /** @type {any} */ ({})) => ({ types: o.types || [], agents: o.agents || [], templates: o.templates || [], roles: o.roles || [], people: o.people || [] });

/** @param {Trigger} t @param {Options} o  "a record is created in RefundRequests" */
export function triggerPhrase(t, o) {
  const type = named(o.types, t.type);
  switch (t.kind) {
    case "created": return type ? `a record is created in ${type}` : "a record is created";
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
    case "agent": return `Hand it to the ${named(o.agents, s.agent) || "chosen"} agent${s.instructions && s.instructions.trim() ? " with your instructions" : ""}`;
    case "assign": return `Ask ${whoWords(s.to, o)} to ${s.title && s.title.trim() ? lc(s.title.trim()) : "do a task"}`;
    case "email": return `Email ${s.to && s.to.trim() ? (/^\{.*\}$/.test(s.to.trim()) ? "the address from the form" : s.to.trim()) : "someone"}`;
    case "ask": return `Wait for ${whoWords(s.to, o)} to say yes${s.title && s.title.trim() ? `: ${s.title.trim()}` : ""}`;
    case "update": return `Set ${s.field && s.field.trim() ? s.field.trim() : "a field"} to ${s.value && s.value.trim() ? s.value.trim() : "a value"} on ${linkWords(s.record, d, o)}`;
    case "advanced": return s.summary || `Advanced step (${s.raw?.kind || "other"})`;
    default: return choiceOf(s.kind)?.label || s.kind;
  }
}

/** @param {string | undefined} ref "trigger" or a step id @param {Draft} [d] @param {Options} [o] */
export function linkWords(ref, d, o) {
  if (!ref) return "no record";
  if (ref === "trigger") return "the record that started the Flow";
  const made = d && d.steps.find((x) => x.id === ref);
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
    case "create": return s.type ? (s.fields || []).some((/** @type {any} */ f) => f.field && f.field.trim()) ? null : "Add at least one field." : "Choose which kind of record to create.";
    case "project": return s.template ? null : "Choose a project template.";
    case "agent": return !s.agent ? "Choose the agent." : !s.record ? "Choose the record to hand over. Create one in an earlier step first." : !(s.instructions || "").trim() ? "Tell the agent what to do with it." : null;
    case "assign": return !s.to ? "Choose who it goes to." : !(s.title || "").trim() ? "Say what the task is." : null;
    case "email": return !(s.to || "").trim() ? "Say who it goes to." : !(s.body || "").trim() ? "Write the email." : null;
    case "ask": return !s.to ? "Choose who is asked." : !(s.title || "").trim() ? "Say what they are asked." : null;
    case "update": return !s.record ? "Choose which record. Create one in an earlier step first, or start from a record." : !(s.field || "").trim() ? "Name the field." : null;
    default: return null;
  }
}

/** @param {Draft} d @param {Options} o @returns {string[]} */
export function draftProblems(d, o) {
  const out = [];
  if (!d.name.trim()) out.push("Give the Flow a name.");
  const t = d.trigger;
  if ((t.kind === "created" || t.kind === "stage") && !t.type) out.push("Choose the kind of record that starts it.");
  if (t.kind === "stage" && !(t.stage || "").trim()) out.push("Name the stage that starts it.");
  if (t.kind === "schedule" && !t.every) out.push("Choose how often it runs.");
  if (!d.steps.length) out.push("Add a first step.");
  d.steps.forEach((s, i) => { const p = stepProblem(s, o); if (p) out.push(`Step ${i + 1}: ${p}`); });
  return out;
}

const EVERY = /** @type {Record<string, { cron: string }>} */ ({ "Every hour": { cron: "0 * * * *" }, "Every day": { cron: "0 9 * * *" }, "Every Monday": { cron: "0 9 * * 1" } });
export const EVERY_CHOICES = Object.keys(EVERY);

/** A text value the person typed: a whole value like {email} reads that field of what started the Flow, anything else is the text itself. @param {string} t */
export const val = (t) => { const m = /^\{([a-z0-9_.]+)\}$/i.exec(String(t ?? "").trim()); return m ? { expr: `trigger.${m[1]}` } : t; };
/** The other way: what a stored value says when it is shown for editing. @param {any} v */
const unval = (v) => { const e = exprOf(v); const m = e && /^trigger\.([a-z0-9_.]+)$/i.exec(e); return m ? `{${m[1]}}` : typeof v === "string" ? v : null; };

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
    case "create": return { id: s.id, kind: "create", type: s.type, set: Object.fromEntries((s.fields || []).filter((/** @type {any} */ f) => f.field && f.field.trim()).map((/** @type {any} */ f) => [slug(f.field), val(f.value)])) };
    case "project": return { id: s.id, kind: "call", action: "work.start-project", resource: "vyre://space/work", input: { template: s.template, name: val((s.name || "").trim()) || { expr: "trigger.name" }, ...(s.link ? { client: rec(s.link) } : {}) } };
    case "agent": return { id: s.id, kind: "agent", assistant: doer(`agent:${s.agent}`), title: (s.title || "").trim() || "Handle this case", instructions: s.instructions, output: { kind: "note" }, record: rec(s.record), await: true, ...(label ? { label } : {}) };
    case "assign": return { id: s.id, kind: "assign", to: doer(s.to), title: s.title, output: { kind: "note" } };
    case "email": return { id: s.id, kind: "call", action: "comms.send", resource: "vyre://space/comms", input: { via: "email", to: val(s.to), subject: val(s.subject || ""), body: val(s.body) } };
    case "ask": return { id: s.id, kind: "ask", to: doer(s.to), title: s.title };
    case "update": return { id: s.id, kind: "update", type: s.type || "record", record: rec(s.record), set: { [slug(s.field || "field")]: s.value || "" } };
    default: throw new Error(`no step kind ${s.kind}`);
  }
}

/** The stored Flow for a draft. @param {Draft} d */
export function toDefinition(d) {
  return { format: 1, name: d.id || slug(d.name), label: d.name.trim(), authorship: /** @type {const} */ ("builder"), ...(d.group ? { group: d.group } : {}), trigger: d.trigger.kind === "advanced" ? d.trigger.raw : triggerDefinition(d.trigger), steps: d.steps.map((s) => stepDefinition(s, d)), ...(d.rest || {}) };
}

/** A fresh step with sensible choices from the others. @param {string} kind @param {Draft} d @param {Options} o @returns {DraftStep} */
export function newStep(kind, d, o) {
  let n = d.steps.length + 1;
  while (d.steps.some((s) => s.id === `${kind}${n}`)) n++;
  const id = `${kind}${n}`;
  const lastMade = [...d.steps].reverse().find((s) => s.kind === "create");
  const link = lastMade ? lastMade.id : isRecordTrigger(d.trigger) ? "trigger" : "";
  switch (kind) {
    case "create": return { id, kind, type: d.trigger.kind === "created" ? "" : d.trigger.type || "", fields: [{ field: "", value: "" }] };
    case "project": return { id, kind, template: o.templates[0]?.id || "", name: "", link };
    case "agent": return { id, kind, agent: o.agents[0]?.name || "", title: "", instructions: "", record: link };
    case "assign": return { id, kind, to: "role:" + (o.roles[0]?.name || "owner"), title: "" };
    case "email": return { id, kind, to: "", subject: "", body: "" };
    case "ask": return { id, kind, to: "role:" + (o.roles[0]?.name || "owner"), title: "" };
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

/** @param {any} s @returns {DraftStep} */
function stepFrom(s) {
  const adv = /** @type {DraftStep} */ ({ id: s.id, kind: "advanced", raw: s, summary: s.label || undefined });
  const who = (/** @type {string} */ v) => (typeof v === "string" && v.startsWith("teammate:") ? `agent:${v.slice(9)}` : v);
  switch (s.kind) {
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
      if (s.action === "comms.send" && i.via === "email" && keys(i, ["via", "to", "subject", "body"]) && unval(i.to) !== null && unval(i.subject || "") !== null && unval(i.body) !== null) return { id: s.id, kind: "email", to: unval(i.to), subject: unval(i.subject || ""), body: unval(i.body) };
      return adv;
    }
    case "agent": {
      const rec = refOf(s.record);
      return typeof s.assistant === "string" && s.assistant.startsWith("teammate:") && rec && typeof s.instructions === "string" && typeof s.title === "string" && s.output && s.output.kind === "note" && keys(s, ["id", "kind", "assistant", "title", "instructions", "output", "record", "await", "label"])
        ? { id: s.id, kind: "agent", agent: s.assistant.slice(9), title: s.title, instructions: s.instructions, record: rec } : adv;
    }
    case "assign": return typeof s.title === "string" && typeof s.to === "string" && s.output && s.output.kind === "note" && keys(s, ["id", "kind", "to", "title", "output"]) ? { id: s.id, kind: "assign", to: who(s.to), title: s.title } : adv;
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
