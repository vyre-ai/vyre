// @vyre/ui tasks model: what a task is to a person, as data (pure, no React, no store). Over the kernel's Task shape (deck/ui/tasks.js, kernel/contracts/task.d.ts):
// doer, checker and assigned_by are Actors, a record is a urn, the Deck's extras (now, say, note, result) sit under task.ext. The React components in this folder
// only draw what these functions return, so the words and the buttons are tested in node (model.test.js).
import { hourOf, longDateOf, sameDay, timeOf, weekdayDayOf } from "../../src/time/show.js";
import { actorOf, cardTitle, howSentence, needsReason, ownerOf, OUTPUT_KINDS, HOW_LABEL, STATE_LABEL, fieldNames, targetText, stageProgress } from "../../src/store-core/tasks.js";
import { aid, eventLine } from "../../src/store-core/kernel-view.js";
import { viewDefOf } from "../../src/store-core/view-defs.js";

const STATE_WORDS = /** @type {Record<string, string>} */ (STATE_LABEL);
export { STATE_WORDS as STATE_LABEL, HOW_LABEL, OUTPUT_KINDS };

/**
 * The world a screen draws from: everything one read of the store gives, as plain data.
 * @typedef {{ me: string, actors: any[], spaces: any[], types: Map<string, any>, tasks: any[], events: any[], calendar: any[], records: Map<string, any>, now: number }} World
 */

const lc = (/** @type {string} */ s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** "Welcome email for Jane Doe" -> "Welcome email". @param {string} title */
const short = (title) => title.replace(/ (for|with) .+$/, "");

/** The title of a record, by its type's title field. @param {World} w @param {any} rec */
export function recordTitle(w, rec) {
  if (!rec) return "";
  const def = w.types.get(rec.type);
  const key = def ? viewDefOf(def).titleField : "title";
  return String(rec.data?.[key] ?? rec.id);
}

/** @param {World} w @param {string|undefined} id */
export const who = (w, id) => actorOf(id, w.actors);
/** @param {World} w @param {string|undefined} id */
export const nameOf = (w, id) => who(w, id)?.name || id || "";
/** @param {World} w @param {string|undefined} spaceId */
export const spaceName = (w, spaceId) => w.spaces.find((s) => s.id === spaceId)?.name || "";

/**
 * What a task is, to a person, as a card: the line it says, the sentence under it, the tags and the buttons.
 * @param {{ task: any, record?: any, recordTitle?: string, actors: any[], me: string, spaceName?: string, showSpace?: boolean, templateName?: string, fieldLabel?: (name: string) => string|undefined }} i
 * @returns {{ reason: "check"|"do"|"stuck"|null, title: string, why: string, lead: string, tags: { text: string, tone?: string, kind?: "record"|"space" }[],
 *   actions: { id: string, label: string, kind: "primary"|"secondary", icon?: string }[], inline?: { name: string, label: string, kind: "text"|"date" } }}
 */
export function cardModel(i) {
  const { task, actors } = i;
  const reason = needsReason(task, i.me, actors);
  const title = cardTitle(task, reason, actors);
  const rec = i.recordTitle || "";
  const note = typeof task.ext?.note === "string" ? task.ext.note : "";
  const madeBy = actorOf(aid(task.assigned_by), actors);
  const draft = task.ext?.result?.draft;
  const flow = /^Flow:/.test(note);
  const target = targetText(task, i.fieldLabel);
  const pay = /payment/i.test(target);
  /** @type {ReturnType<typeof cardModel>["actions"]} */
  let actions = [];
  let why = "";
  /** @type {ReturnType<typeof cardModel>["inline"]} */
  let inline;
  let lead = aid(task.doer);

  if (reason === "check") {
    if (task.output.kind === "sent") {
      why = draft ? howSentence(task, { actors, templateName: i.templateName, usedNotesOf: task.how === "tailor" && i.record?.data?.research ? "Research" : undefined }) : "Needs your approval to send.";
      actions = [{ id: "send", label: pay ? "Pay with Face ID" : "Send with Face ID", kind: "primary", icon: "faceid" }, draft ? { id: "edit", label: "Edit", kind: "secondary" } : { id: "open", label: "Open", kind: "secondary" }];
    } else {
      why = "Needs your check.";
      actions = [{ id: "approve", label: "Approve with Face ID", kind: "primary", icon: "faceid" }, { id: "open", label: "Open", kind: "secondary" }];
    }
  } else if (reason === "stuck") {
    const s = task.stuck;
    why = [s?.reason, s?.suggested_fix?.text].filter(Boolean).join(" ");
    actions = [{ id: "fix", label: "Fix", kind: "primary" }, { id: "reassign", label: "Reassign", kind: "secondary" }];
  } else if (reason === "do") {
    lead = madeBy && madeBy.id !== i.me ? madeBy.id : aid(task.doer);
    const names = fieldNames(task);
    const one = task.output.kind === "fields" && names.length === 1 ? names[0] : null;
    if (one) {
      why = `It is needed on ${rec}.`;
      const label = i.fieldLabel?.(one) || one;
      inline = { name: one, label, kind: /date/i.test(one) || /date/i.test(label) ? "date" : "text" };
      actions = [{ id: "save", label: "Save", kind: "primary" }];
    } else if (task.output.kind === "decision" && flow) {
      why = `From the ${note.replace(/^Flow:\s*/, "Flow ")}. It needs your approval to send.`;
      actions = [{ id: "yes", label: "Approve with Face ID", kind: "primary", icon: "faceid" }, { id: "no", label: "Decline", kind: "secondary" }];
    } else if (task.output.kind === "file") {
      why = `Needed to continue ${rec}.`;
      actions = [{ id: "file", label: "Add the file", kind: "primary" }];
    } else {
      // a to-do that belongs to no stage or record has nothing to be "due with": it just waits for you
      const where = task.stage || rec;
      why = `${madeBy && madeBy.id !== i.me && madeBy.family === "person" ? `${madeBy.name} assigned this to you. ` : ""}${where ? `Due with ${where}.` : task.source === "flow_step" ? "A Flow is waiting for you." : "It is waiting for you."}`;
      actions = [{ id: "done", label: "Mark done", kind: "primary" }, { id: "open", label: "Open", kind: "secondary" }];
    }
  } else {
    why = STATE_LABEL[task.state] + ".";
    actions = [{ id: "open", label: "Open", kind: "secondary" }];
  }
  /** @type {ReturnType<typeof cardModel>["tags"]} */
  const tags = [{ text: note && !/^is /.test(note) ? note : "Stage task" }];
  if (rec) tags.push({ text: rec, kind: "record" });
  if (i.showSpace && i.spaceName) tags.push({ text: i.spaceName, kind: "space" });
  if (reason === "stuck") tags.push({ text: "Stuck", tone: "warn" });
  return { reason, title, why, lead, tags, actions, inline };
}

/** The card model of a task for the person in the world. @param {World} w @param {any} task @param {{ showSpace?: boolean }} [o] */
export function cardFor(w, task, o = {}) {
  const rec = w.records.get(task.record);
  const tpl = task.template ? w.records.get(task.template) : null;
  const def = rec ? w.types.get(rec.type) : null;
  return cardModel({
    task, record: rec, recordTitle: recordTitle(w, rec), actors: w.actors, me: w.me, spaceName: spaceName(w, task.space), showSpace: o.showSpace,
    templateName: tpl ? recordTitle(w, tpl) : undefined, fieldLabel: (n) => def?.fields.find((/** @type {any} */ f) => f.name === n)?.label,
  });
}

/**
 * The facts of a task: Doer, Checker, Output with Done-when, How, Inputs.
 * @param {World} w @param {any} task @param {{ titles?: Map<string, string> }} [o]
 * @returns {{ doer: { id: string, meta: string }, checker: { id: string, meta?: string } | null, output: { label: string, target: string, doneWhen: string }, how: string, inputs: string[] }}
 */
export function taskFacts(w, task, o = {}) {
  const rec = w.records.get(task.record);
  const def = rec ? w.types.get(rec.type) : null;
  const kind = OUTPUT_KINDS[task.output?.kind] || OUTPUT_KINDS.file;
  const tpl = task.template ? w.records.get(task.template) : null;
  /** @type {string[]} */
  const inputs = [];
  if (rec?.data?.research && task.how === "tailor") inputs.push(`Research notes on ${recordTitle(w, rec)}`);
  if (tpl) inputs.push(`Template: ${recordTitle(w, tpl)}`);
  for (const d of task.depends_on || []) inputs.push(`Output of ${o.titles?.get(d) || d}`);
  return {
    doer: { id: aid(task.doer), meta: task.state === "working" && task.ext?.now ? task.ext.now : "One doer, accountable" },
    checker: task.checker ? { id: aid(task.checker), meta: task.output?.kind === "sent" ? "Their approval sends it" : undefined } : null,
    output: { label: kind.label, target: targetText(task, (n) => def?.fields.find((/** @type {any} */ f) => f.name === n)?.label), doneWhen: kind.doneWhen },
    how: (task.how && HOW_LABEL[task.how]) || "Done by hand",
    inputs,
  };
}

/**
 * What the doer is asked to do, in the task's own words: the brief a template or a person wrote (Goal, context, what counts as done), or "". A line that is only a tag ("Flow: ...", "is working on ...") is not a brief.
 * @param {any} task @returns {string}
 */
export function briefOf(task) {
  for (const x of [task && task.note, task && task.ext && task.ext.note]) if (typeof x === "string" && x.trim() && !/^(Flow:|is )/.test(x.trim())) return x.trim();
  return "";
}

/** The draft of a task and the one sentence under it, or null. @param {World} w @param {any} task */
export function draftOf(w, task) {
  const d = task.ext?.result?.draft;
  if (!d) return null;
  const rec = w.records.get(task.record);
  const tpl = task.template ? w.records.get(task.template) : null;
  const how = howSentence(task, { actors: w.actors, templateName: tpl ? recordTitle(w, tpl) : undefined, usedNotesOf: task.how === "tailor" && rec?.data?.research ? "Research" : undefined });
  return { subject: d.subject, body: d.body, line: `${how}${d.sources ? ` ${d.sources} sources.` : ""}` };
}

// ---------------------------------------------------------------------------------------------------------------------------- Now

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
/** "12:06 pm" the same day (the viewer's zone, lib/time), else "Mon 28 Sep". @param {number} at @param {number} now */
export function whenLabel(at, now) {
  if (sameDay(at, now)) return timeOf(at);
  return weekdayDayOf(at);
}
/** "Thursday, 1 October". @param {number} at */
export const dateLine = (at) => longDateOf(at);
/** @param {number} at */
/** The first word of a name for a greeting; an id that has no name behind it (per_...) is empty, so the greeting has no name at all. @param {string | undefined} n */
export const firstName = (n) => (!n || /^[a-z]{2,4}_[a-z0-9]{8,}$/.test(n) ? "" : n.split(" ")[0]);
export const greeting = (at) => { const h = hourOf(at); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
/** @param {number} at */
const startOfDay = (at) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "1 thing needs you". @param {number} n */
export const needsLine = (n) => (n === 0 ? "nothing needs you" : n === 1 ? "1 thing needs you" : `${n} things need you`);

/**
 * What Now shows for a scope ("all" or a space id): the tasks that need the person, what is being worked on, what finished today, today's calendar and recent events.
 * @param {World} w @param {string} [scope]
 */
export function nowModel(w, scope = "all") {
  const inScope = (/** @type {string|undefined} */ space) => scope === "all" || space === scope;
  const tasks = w.tasks.filter((t) => inScope(t.space));
  const needs = tasks.filter((t) => needsReason(t, w.me, w.actors) !== null).sort((a, b) => b.updated_at - a.updated_at);
  const needIds = new Set(needs.map((t) => t.id));
  const working = tasks.filter((t) => t.state === "working");
  const day = startOfDay(w.now);
  const doneToday = tasks.filter((t) => (t.state === "done" || t.state === "skipped") && t.updated_at >= day && t.updated_at < day + 86_400_000).sort((a, b) => b.updated_at - a.updated_at);
  const recent = w.events.map(eventLine).map((l) => plainLine(w, l)).filter((l) => l).filter((e) => e.record ? inScope(spaceOfUrnLoose(e.record)) : scope !== "mine").slice(0, 5);
  const calendar = w.calendar.filter((c) => !c.record || inScope(spaceOfUrnLoose(c.record)));
  const me = who(w, w.me);
  return {
    greeting: firstName(me?.name) ? `${greeting(w.now)}, ${firstName(me?.name)}` : greeting(w.now),
    meta: `${dateLine(w.now)} · ${needsLine(needs.length)}`,
    needs, needIds, working, doneToday, recent, calendar,
    stuck: tasks.filter((t) => t.state === "stuck"),
    faces: [...new Set(w.tasks.filter((t) => t.state === "working").map((t) => aid(t.doer)))].slice(0, 3),
  };
}
/** An id the box uses for an actor (per_, agt_, spc_ ...): never shown to a person as a name. */
export const isRawId = (/** @type {unknown} */ n) => typeof n === "string" && /^[a-z]{2,4}_[a-z0-9]{10,}$/.test(n);

/** Kernel events a person reads as sentences. Anything else with only a raw event type is housekeeping and stays out of Recent. */
const PLAIN = {
  "owner.changed": (/** @type {any} */ w, /** @type {any} */ l) => ({ actor: "You", what: `became the owner of ${(l.record && spaceName(w, spaceOfUrnLoose(l.record))) || "this space"}` }),
};
/** Recent's line: a plain sentence with the real actor, or null for housekeeping (a raw event type with no sentence of its own). @param {World} w @param {any} l */
export function plainLine(w, l) {
  const raw = typeof l.what === "string" && /^[a-z_-]+(\.[a-z_-]+)+$/.test(l.what);
  if (!raw) return l;
  const f = /** @type {any} */ (PLAIN)[l.what];
  return f ? { ...l, ...f(w, l) } : null;
}

/** How many tasks wait on the person across every space: the one badge the shell shows on Now. @param {World} w */
export const nowCount = (w) => nowModel(w, "all").needs.length;

/** The event to show as "Next": the first one still to come today, else the first of the day. @param {any[]} calendar @param {number} now */
export function nextEvent(calendar, now) {
  const list = [...calendar].sort((a, b) => a.at - b.at);
  return list.find((e) => e.at >= now) || list[0] || null;
}

/** The space id inside a urn. @param {string} urn */
const spaceOfUrnLoose = (urn) => /^vyre:\/\/([^/]+)\//.exec(urn)?.[1] || "";

/** The line a working task shows. @param {World} w @param {any} t */
export const workingLine = (w, t) => `${nameOf(w, aid(t.doer))} ${t.ext?.now || `is working on ${lc(t.title)}`}`;

// ---------------------------------------------------------------------------------------------------------------------------- the project page

const isDone = (/** @type {any} */ t) => t.state === "done" || t.state === "skipped";

/** What a finished task did, in a few words. @param {any} t */
function didWhat(t) {
  const r = t.ext?.result || {};
  switch (t.output?.kind) {
    case "fields": {
      const n = fieldNames(t).length - (r.note ? 1 : 0);
      return `wrote ${Math.max(n, 0)} field${n === 1 ? "" : "s"}${r.note ? ` and a note with ${r.note.sources.length} source${r.note.sources.length === 1 ? "" : "s"}` : ""}`;
    }
    case "note": return `wrote a note${r.note ? ` with ${r.note.sources.length} source${r.note.sources.length === 1 ? "" : "s"}` : ""}`;
    case "sent": return `sent the ${short(t.title)}`;
    case "draft": return `drafted the ${lc(short(t.title))}`;
    case "file": return `added ${r.file?.name ? r.file.name : `the ${lc(short(t.title))}`}`;
    case "decision": return `recorded the decision${t.answer ? `: ${t.answer.answer}` : ""}`;
    default: return `finished ${lc(short(t.title))}`;
  }
}

/**
 * The tasks of each stage, in stage order, with "n of m done". A stage with no task is left out unless it is the current one; tasks without a stage (or with one the type
 * does not have) form one group at the end. `done` and `total` count the required tasks, or every task when none is required.
 * @param {any[]} tasks @param {string[]} stages @param {string|undefined} current
 * @returns {{ stage: string|null, label: string, tasks: any[], done: number, total: number, current: boolean, complete: boolean }[]}
 */
export function stageGroups(tasks, stages, current) {
  const make = (/** @type {string|null} */ stage, /** @type {string} */ label, /** @type {any[]} */ list, /** @type {boolean} */ isCurrent) => {
    const req = stage ? stageProgress(tasks, stage) : { done: list.filter(isDone).length, total: list.length };
    const none = req.total === 0 && list.length > 0;
    const total = none ? list.length : req.total, done = none ? list.filter(isDone).length : req.done;
    return { stage, label, tasks: list, done, total, current: isCurrent, complete: total > 0 && done === total };
  };
  const known = new Set(stages);
  const out = [];
  for (const s of stages) {
    const list = tasks.filter((t) => t.stage === s);
    if (list.length || s === current) out.push(make(s, s, list, s === current));
  }
  const loose = tasks.filter((t) => !t.stage || !known.has(t.stage));
  if (loose.length) out.push(make(null, "Tasks", loose, !stages.length || out.every((g) => !g.current)));
  return out;
}

/**
 * The one line under a teammate's face: what it is doing right now. A working task says so in its own words (ext.now), else the actor's `doing` field, else the last thing
 * it finished or is waiting on, else its role.
 * @param {string} id @param {{ tasks: any[], actors: any[], owner?: string }} o
 */
export function teamLine(id, o) {
  const a = actorOf(id, o.actors), name = a?.name || id;
  const mine = o.tasks.filter((t) => aid(t.doer) === id);
  const working = mine.filter((t) => t.state === "working");
  const w = working.find((t) => t.ext?.now) || working[0];
  if (w) return w.ext?.now ? `${name} ${w.ext.now}` : `${name} is working on ${lc(short(w.title))}`;
  if (a?.doing) return a.doing;
  const stuck = mine.find((t) => t.state === "stuck");
  if (stuck) return `${name} is stuck. ${stuck.stuck?.reason || ""}`.trim();
  const check = mine.find((t) => t.state === "needs_check");
  if (check) return `${name} drafted the ${lc(short(check.title))}. It waits for ${actorOf(aid(check.checker), o.actors)?.name || aid(check.checker)}.`;
  const done = mine.filter((t) => t.state === "done").pop();
  if (done) return `${name} ${didWhat(done)}`;
  if (id === o.owner) return "Owner";
  const ready = mine.find((t) => t.state === "ready");
  if (ready) return `${name} has ${lc(short(ready.title))} to do`;
  const waits = mine.find((t) => t.state === "waiting");
  if (waits) return `${name} waits to ${lc(short(waits.title))}`;
  return a?.role || "";
}

/** The team of a record: its owner first, then everyone who does, checks or helps on its tasks. @param {{ tasks: any[], actors: any[], owner?: string }} o @returns {{ id: string, role?: string, doing: string }[]} */
export function teamOf(o) {
  const ids = [o.owner, ...o.tasks.flatMap((t) => [aid(t.doer), aid(t.checker), ...(t.helpers || []).map(aid)])].filter((x) => !!x);
  return [...new Set(ids)].filter((i) => actorOf(i, o.actors)).map((id) => {
    const quiet = id === o.owner && !o.tasks.some((t) => aid(t.doer) === id && t.state === "working") && !actorOf(id, o.actors)?.doing;
    return { id, role: actorOf(id, o.actors)?.role, doing: quiet ? "Owner" : teamLine(id, o) };
  });
}

/** The line under the stage strip: the first assistant (else anyone) working, in its own words. @param {any[]} tasks @param {any[]} actors */
export function liveLine(tasks, actors) {
  const working = tasks.filter((t) => t.state === "working");
  const t = working.find((x) => actorOf(aid(x.doer), actors)?.family !== "person" && x.ext?.now) || working.find((x) => x.ext?.now);
  return t ? `${actorOf(aid(t.doer), actors)?.name || aid(t.doer)} ${t.ext.now}` : null;
}

/** "Created by Vyre from the Kit Estate planning matter, 9:00. Flow On payment: Jane Doe paid $1,500." @param {any[]} events EventEnvelopes @param {any[]} actors @param {number} now */
export function createdLine(events, actors, now) {
  const lines = events.map(eventLine);
  const mine = lines.filter((e) => /^created /.test(e.what));
  const pool = mine.length ? mine : lines;
  if (!pool.length) return null;
  const first = pool.reduce((a, b) => (b.at < a.at ? b : a));
  const kit = /from the Kit (.+)$/.exec(first.what)?.[1];
  const name = actorOf(first.actor, actors)?.name || first.actor || "Someone";
  return `Created by ${name}${kit ? ` from the Kit ${kit}` : ""}, ${whenLabel(first.at, now)}.${first.why ? ` ${first.why}` : ""}`;
}

/** The state chip's words for `me`. @param {any} t @param {string} me */
export const stateWord = (t, me) => (t.state === "needs_check" ? (aid(t.checker) === me ? "Needs your check" : "Needs a check") : STATE_LABEL[t.state]);
/** The chip tone of a state. @param {string} state */
export const stateTone = (state) => ({ done: "ok", stuck: "sealed", needs_check: "accent", ready: "accent", working: "accent" }[/** @type {string} */ (state)] || "plain");

/** "2 of 4 tasks" / "No tasks", over every task of a record. @param {any[]} tasks */
export const progressText = (tasks) => (tasks.length ? `${tasks.filter(isDone).length} of ${tasks.length} task${tasks.length === 1 ? "" : "s"}` : "No tasks");

/** How many of a record's tasks are done, and how many there are. @param {any[]} tasks */
export const taskFraction = (tasks) => ({ done: tasks.filter(isDone).length, total: tasks.length });

/** Which of a task's dependencies are still open, as lower-case titles. @param {any} t @param {any[]} all */
export const waitsFor = (t, all) => (t.depends_on || []).map((/** @type {string} */ d) => all.find((x) => x.id === d)).filter((/** @type {any} */ x) => x && !isDone(x)).map((/** @type {any} */ x) => lc(x.title));

/** Is a task required for its stage? @param {any} t */
export const required = (t) => t.ext?.required !== false;
export { ownerOf };
