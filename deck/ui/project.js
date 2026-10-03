// @ts-check
// deck/ui/project: what the project page (views/ui-project.js) is made of, apart from the record page it reuses (views.js recordPage). A record of a type that
// holds work has stages, and every stage is a list of tasks (team/0.3/DESIGN-tasks.md, "Stages are made of tasks"). The pure functions here are tested without a
// DOM (project.test.js); projectTasks() draws them.
//
//   stageGroups(tasks, stages, current)   the tasks of each stage, in stage order, with "n of m done"; tasks with no stage form one group, "Tasks"
//   teamOf(o) / teamLine(id, o)           who is on the team and the one line under each face: what they are doing right now
//   liveLine(tasks, actors)               the line under the stage strip: the first assistant that is working
//   createdLine(events, actors)           "Created by Vyre from the Kit Estate planning matter, 9:00. Flow On payment: Jane Doe paid $1,500."
//   projectTasks({ me, open })            the Tasks card: the current stage open, the others collapsed; .update(data) redraws it from fresh data
import { h, put } from "../js/dom.js";
import { when } from "../js/fmt.js";
import { card, chip } from "./components/index.js";
import { icon } from "../js/icons.js";
import { actorAvatar } from "./task-card.js";
import { actorOf, STATE_LABEL, stageProgress } from "./tasks.js";

/** @typedef {import("./contracts.js").Task} Task */
/** @typedef {import("./contracts.js").Actor} Actor */
/** @typedef {import("./contracts.js").VyreEvent} VyreEvent */

const lc = (/** @type {string} */ s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** "Welcome email for Jane Doe" -> "Welcome email". @param {string} title */
const short = title => title.replace(/ (for|with) .+$/, "");
const nameOf = (/** @type {string|undefined|null} */ id, /** @type {Actor[]} */ actors) => (id ? actorOf(id, actors)?.name || id : "");

/**
 * @typedef {{ stage: string|null, label: string, tasks: Task[], done: number, total: number, current: boolean, complete: boolean }} Group
 */

/**
 * The tasks of each stage. A stage with no task is left out unless it is the current one; tasks without a stage (or with one the type does not have) form
 * one group at the end. `done` and `total` count the required tasks, or every task when none is required.
 * @param {Task[]} tasks @param {string[]} stages @param {string|undefined} current
 * @returns {Group[]}
 */
export function stageGroups(tasks, stages, current) {
  /** @param {string|null} stage @param {string} label @param {Task[]} list @param {boolean} isCurrent @returns {Group} */
  const make = (stage, label, list, isCurrent) => {
    const req = stage ? stageProgress(tasks, stage) : { done: list.filter(t => t.state === "done" || t.state === "skipped").length, total: list.length };
    const noneRequired = req.total === 0 && list.length > 0;
    const total = noneRequired ? list.length : req.total, done = noneRequired ? list.filter(t => t.state === "done" || t.state === "skipped").length : req.done;
    return { stage, label, tasks: list, done, total, current: isCurrent, complete: total > 0 && done === total };
  };
  const known = new Set(stages);
  /** @type {Group[]} */
  const out = [];
  for (const s of stages) {
    const list = tasks.filter(t => t.stage === s);
    if (list.length || s === current) out.push(make(s, s, list, s === current));
  }
  const loose = tasks.filter(t => !t.stage || !known.has(t.stage));
  if (loose.length) out.push(make(null, "Tasks", loose, !stages.length || out.every(g => !g.current)));
  return out;
}

/** What a finished task did, in a few words. @param {Task} t @param {Actor[]} actors */
function didWhat(t, actors) {
  const r = t.result || {};
  switch (t.output?.kind) {
    case "fields": {
      const n = (t.output.fields || []).length - (r.note ? 1 : 0);
      return `wrote ${Math.max(n, 0)} field${n === 1 ? "" : "s"}${r.note ? ` and a note with ${r.note.sources.length} source${r.note.sources.length === 1 ? "" : "s"}` : ""}`;
    }
    case "note": return `wrote a note${r.note ? ` with ${r.note.sources.length} source${r.note.sources.length === 1 ? "" : "s"}` : ""}`;
    case "sent": return `sent the ${short(t.title)}`;
    case "draft": return `drafted the ${lc(short(t.title))}`;
    case "file": return `added ${r.file?.name ? r.file.name : `the ${lc(short(t.title))}`}`;
    case "decision": return `recorded the decision${r.decision ? `: ${r.decision.answer}` : ""}`;
    default: void actors; return `finished ${lc(short(t.title))}`;
  }
}

/**
 * The one line under a teammate's face: what it is doing right now. A working task says so in its own words (`now`), else the actor's `doing` field, else the
 * last thing it finished or is waiting on, else its role.
 * @param {string} id @param {{ tasks: Task[], actors: Actor[], owner?: string }} o
 * @returns {string}
 */
export function teamLine(id, o) {
  const a = actorOf(id, o.actors), name = a?.name || id;
  const mine = o.tasks.filter(t => t.doer === id);
  const working = mine.filter(t => t.state === "working");
  const w = working.find(t => t.now) || working[0];
  if (w) return w.now ? `${name} ${w.now}` : `${name} is working on ${lc(short(w.title))}`;
  if (a?.doing) return a.doing;
  const stuck = mine.find(t => t.state === "stuck");
  if (stuck) return `${name} is stuck. ${stuck.stuck?.reason || ""}`.trim();
  const check = mine.find(t => t.state === "needs_check");
  if (check) return `${name} drafted the ${lc(short(check.title))}. It waits for ${nameOf(check.checker, o.actors)}.`;
  const done = mine.filter(t => t.state === "done").pop();
  if (done) return `${name} ${didWhat(done, o.actors)}`;
  if (id === o.owner) return "Owner";
  const ready = mine.find(t => t.state === "ready");
  if (ready) return `${name} has ${lc(short(ready.title))} to do`;
  const waits = mine.find(t => t.state === "waiting");
  if (waits) return `${name} waits to ${lc(short(waits.title))}`;
  return a?.role || "";
}

/**
 * The team of a record: its owner first, then everyone who does, checks or helps on its tasks.
 * @param {{ tasks: Task[], actors: Actor[], owner?: string }} o
 * @returns {{ id: string, role?: string, doing: string }[]}
 */
export function teamOf(o) {
  const ids = [o.owner, ...o.tasks.flatMap(t => [t.doer, t.checker, ...(t.helpers || [])])].filter(/** @returns {x is string} */ x => !!x);
  return [...new Set(ids)].filter(i => actorOf(i, o.actors)).map(id => {
    const line = id === o.owner && !o.tasks.some(t => t.doer === id && t.state === "working") && !actorOf(id, o.actors)?.doing ? "Owner" : teamLine(id, o);
    return { id, role: actorOf(id, o.actors)?.role, doing: line };
  });
}

/** The line under the stage strip: the first assistant (else anyone) working, in its own words. @param {Task[]} tasks @param {Actor[]} actors */
export function liveLine(tasks, actors) {
  const working = tasks.filter(t => t.state === "working");
  const t = working.find(x => actorOf(x.doer, actors)?.kind !== "person" && x.now) || working.find(x => x.now);
  return t ? `${nameOf(t.doer, actors)} ${t.now}` : null;
}

/**
 * The "created from the Kit" line, from the record's first event.
 * @param {VyreEvent[]} events @param {Actor[]} actors
 * @returns {string|null}
 */
export function createdLine(events, actors) {
  const mine = events.filter(e => /^created /.test(e.what));
  const pool = mine.length ? mine : events;
  if (!pool.length) return null;
  const first = pool.reduce((a, b) => (b.at < a.at ? b : a));
  const kit = /from the Kit (.+)$/.exec(first.what)?.[1];
  const who = nameOf(first.actor, actors) || "Someone";
  return `Created by ${who}${kit ? ` from the Kit ${kit}` : ""}, ${when(first.at)}.${first.why ? ` ${first.why}` : ""}`;
}

/** The state chip's words for `me`. @param {Task} t @param {string} me */
export function stateWord(t, me) {
  if (t.state === "needs_check") return t.checker === me ? "Needs your check" : "Needs a check";
  return STATE_LABEL[t.state];
}
const TONE = /** @type {Record<string, string>} */ ({ done: "ok", stuck: "sealed", needs_check: "accent", ready: "accent", working: "accent" });

/**
 * The Tasks card of a project page. `update(data)` redraws it from fresh data: { tasks, stages, current, actors, me }. The current stage is open and the others are
 * collapsed (a finished one says "n of m done"); a person's own toggles stay until the record moves to another stage, which opens the new current one by itself.
 * @param {{ me: string, open: (task: Task) => void }} o
 * @returns {HTMLElement & { update: (data: { tasks: Task[], stages: string[], current?: string, actors: Actor[], me?: string }) => void }}
 */
export function projectTasks(o) {
  const body = h("div", { class: "up-stages" });
  const sub = h("span", { class: "up-hint" });
  const el = /** @type {any} */ (card({ title: "Tasks", actions: sub }, body));
  el.classList.add("up-tasks");
  /** @type {Map<string, boolean>} */
  const toggled = new Map();
  let lastCurrent = /** @type {string|undefined} */ (undefined), seen = false;
  /** @type {any} */
  let data = null;

  function row(/** @type {Task} */ t) {
    const a = actorOf(t.doer, data.actors), chk = t.checker ? nameOf(t.checker, data.actors) : "";
    const deps = (t.dependsOn || []).map((/** @type {string} */ d) => data.tasks.find((/** @type {Task} */ x) => x.id === d)).filter((/** @type {Task|undefined} */ x) => x && x.state !== "done" && x.state !== "skipped");
    const meta = [t.state === "waiting" && deps.length ? `Waits for ${deps.map((/** @type {Task} */ d) => lc(d.title)).join(", ")}` : null, chk ? `Checked by ${chk}` : null, t.required === false ? "Optional" : null].filter(Boolean).join(" · ");
    const extra = t.state === "stuck" && t.stuck ? h("span", { class: "up-why" }, icon("alert", 14), t.stuck.reason)
      : t.state === "working" && t.now ? h("span", { class: "up-now" }, h("span", { class: "up-live", "aria-hidden": "true" }), `${a?.name || t.doer} ${t.now}`) : null;
    return h("button", { type: "button", class: `up-task is-${t.state}`, "data-task": t.id, "data-state": t.state, onclick: () => o.open(t) },
      h("span", { class: `up-dot is-${t.state}`, "aria-hidden": "true" }),
      h("span", { class: "up-task-t" }, h("b", null, t.title), meta ? h("span", { class: "up-hint" }, meta) : null, extra),
      h("span", { class: "up-task-who" }, actorAvatar(a, 28), h("span", { class: "up-who-n" }, a?.name || t.doer)),
      chip(stateWord(t, data.me || o.me), { tone: /** @type {any} */ (TONE[t.state] || "plain") }));
  }

  function draw() {
    const groups = stageGroups(data.tasks, data.stages, data.current);
    const all = data.tasks.filter((/** @type {Task} */ t) => t.required !== false);
    const done = all.filter((/** @type {Task} */ t) => t.state === "done" || t.state === "skipped").length;
    put(sub, data.tasks.length ? `${done} of ${all.length} done` : "");
    if (!groups.length) { put(body, h("div", { class: "up-hint up-pad" }, "No tasks yet. Entering a stage makes its tasks.")); return; }
    put(body, groups.map(g => {
      const key = g.label;
      const open = toggled.has(key) ? /** @type {boolean} */ (toggled.get(key)) : g.current;
      const section = h("section", { class: `up-stage${g.current ? " is-current" : ""}${g.complete ? " is-complete" : ""}${open ? " is-open" : ""}`, "data-stage": key },
        h("button", { type: "button", class: "up-stage-h", "aria-expanded": String(open), onclick: () => { toggled.set(key, !open); draw(); } },
          h("span", { class: "up-chev", "aria-hidden": "true" }, icon("chevron", 14)),
          h("b", null, g.label), g.current && g.stage ? chip("Now", { tone: "accent" }) : null,
          h("span", { class: "up-stage-n" }, g.tasks.length ? `${g.done} of ${g.total} done` : "No tasks yet")),
        open ? h("div", { class: "up-stage-b" }, g.tasks.length ? g.tasks.map(row) : h("div", { class: "up-hint up-pad" }, "No tasks yet.")) : null);
      return section;
    }));
  }

  el.update = (/** @type {any} */ d) => {
    if (seen && d.current !== lastCurrent) toggled.clear();
    seen = true; lastCurrent = d.current; data = d;
    draw();
  };
  return el;
}
