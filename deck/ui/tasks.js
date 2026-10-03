// @ts-check
// deck/ui/tasks: the task model as pure functions (team/0.3/DESIGN-tasks.md). Nothing here touches a store, a DOM or a clock it was not handed, so the
// mock store, the real gateway adapter and the tests all use the same rules.
//
// A task has one doer and, optionally, one checker. It says what done looks like (its output), and Vyre checks that deterministically: an assistant
// cannot mark Research done while the fields are empty. A stage is a list of task templates; entering it creates its tasks, and when its required
// tasks are done the record moves on by itself. When a task's output leaves the space (kind "sent"), the checker's approval is the Gate approval:
// one card, never two.

/** @typedef {import("./contracts.js").Task} Task */
/** @typedef {import("./contracts.js").TaskState} TaskState */
/** @typedef {import("./contracts.js").Actor} Actor */
/** @typedef {import("./contracts.js").RecordRow} RecordRow */

/** @type {TaskState[]} */
export const STATES = ["waiting", "ready", "working", "needs_check", "stuck", "done", "skipped"];

/** The words the Deck shows for a state. */
export const STATE_LABEL = /** @type {Record<TaskState, string>} */ ({
  waiting: "Waiting", ready: "Ready", working: "Working", needs_check: "Needs a check", stuck: "Stuck", done: "Done", skipped: "Skipped",
});

/** What each output kind is, and what done means for it (DESIGN-tasks.md, idea 3). */
export const OUTPUT_KINDS = /** @type {Record<string, { label: string, doneWhen: string }>} */ ({
  fields: { label: "Fill fields", doneWhen: "the named fields have values" },
  note: { label: "A note", doneWhen: "a note with sources is on the record" },
  draft: { label: "A draft", doneWhen: "a draft exists, ready for the checker" },
  sent: { label: "A sent item", doneWhen: "it has left the space through the checker's approval" },
  decision: { label: "A decision", doneWhen: "there is a yes or no, with a reason" },
  file: { label: "A file", doneWhen: "a file has been uploaded or produced" },
});

/** How the doer works (idea 4), as the task page words it. */
export const HOW_LABEL = /** @type {Record<string, string>} */ ({
  template: "Template", tailor: "Assistant tailors the template", assistant: "Assistant writes it", person: "I'll write it",
});

/** Allowed moves. A finished task (done, skipped) does not move again. */
export const TRANSITIONS = /** @type {Record<TaskState, TaskState[]>} */ ({
  waiting: ["ready", "working", "skipped"],
  ready: ["working", "needs_check", "done", "stuck", "skipped"],
  working: ["needs_check", "done", "stuck", "ready", "skipped"],
  needs_check: ["done", "working", "stuck", "skipped"],
  stuck: ["ready", "working", "skipped"],
  done: [],
  skipped: [],
});

/** @param {TaskState} from @param {TaskState} to */
export const canMove = (from, to) => (TRANSITIONS[from] || []).includes(to);

const blank = (/** @type {any} */ v) => v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

/**
 * @typedef {{ method: "face_id"|"touch_id"|"passkey" }} Proof
 * @typedef {{ draft?: { subject?: string, body: string, sources?: number }, note?: { text: string, sources: string[] }, file?: { name: string },
 *   decision?: { answer: "yes"|"no", reason: string }, sent?: { at: number, by: string, method: string }, approved?: { at: number, by: string, method: string } }} Result
 * A task's `result` holds the evidence of its output that is not a field on the record: the draft, the note and its sources, the file, the decision,
 * and the checker's approval. (It is an optional property of Task; contracts.js lists it.)
 */

/**
 * Is the output there, ignoring the checker? For a sent item this means the draft exists and is ready for the checker's one tap.
 * @param {Task} task @param {RecordRow|null|undefined} record
 */
export function hasOutput(task, record) {
  const out = task.output || { kind: "file" };
  const r = /** @type {Result} */ (/** @type {any} */ (task).result || {});
  switch (out.kind) {
    case "fields": {
      const names = out.fields || [];
      return names.length > 0 && names.every(k => !blank(record?.values?.[k]));
    }
    case "note": return !!r.note && !blank(r.note.text) && Array.isArray(r.note.sources) && r.note.sources.length > 0;
    case "draft":
    case "sent": return !!r.draft && !blank(r.draft.body);
    case "decision": return !!r.decision && (r.decision.answer === "yes" || r.decision.answer === "no") && !blank(r.decision.reason);
    case "file": return !!r.file && !blank(r.file.name);
    default: return false;
  }
}

/**
 * Deterministic completion: is the task's declared output really there? A sent item is complete only once it left through the checker's approval.
 * @param {Task} task @param {RecordRow|null|undefined} record
 */
export function isComplete(task, record) {
  if (!hasOutput(task, record)) return false;
  if (task.output?.kind === "sent") {
    const r = /** @type {Result} */ (/** @type {any} */ (task).result || {});
    return !!r.sent;
  }
  return true;
}

/** What is still missing, in a plain sentence, or null when nothing is.
 * @param {Task} task @param {RecordRow|null|undefined} record */
export function missingOutput(task, record) {
  if (hasOutput(task, record) && isComplete(task, record)) return null;
  const k = task.output?.kind;
  if (k === "fields") {
    const empty = (task.output.fields || []).filter(f => blank(record?.values?.[f]));
    return empty.length ? `These fields are empty: ${empty.join(", ")}.` : "No fields are named.";
  }
  if (k === "note") return "The note and its sources are not on the record yet.";
  if (k === "draft") return "There is no draft yet.";
  if (k === "sent") return hasOutput(task, record) ? "It has not been sent through the checker's approval yet." : "There is no draft to send yet.";
  if (k === "decision") return "There is no yes or no with a reason yet.";
  if (k === "file") return "No file has been added yet.";
  return "The output is not there yet.";
}

/**
 * @param {string|undefined} id @param {Record<string, Actor>|Actor[]|undefined} actors
 * @returns {Actor|undefined}
 */
export function actorOf(id, actors) {
  if (!id || !actors) return undefined;
  return Array.isArray(actors) ? actors.find(a => a.id === id) : actors[id];
}

/** The person accountable for an actor: a person is their own, an assistant or teammate belongs to its owner (`owner`, else the first person).
 * @param {string} id @param {Record<string, Actor>|Actor[]} actors */
export function ownerOf(id, actors) {
  const a = actorOf(id, actors);
  if (!a) return id;
  if (a.kind === "person") return a.id;
  return /** @type {any} */ (a).owner || id;
}

/**
 * Why a task needs `me`, or null (DESIGN-tasks.md, Now): I am the checker and it waits for my check; I am the doer and it is ready; it is stuck and I
 * am responsible (I am the doer, or the doer is my assistant).
 * @param {Task} task @param {string} me an actor id @param {Record<string, Actor>|Actor[]} [actors]
 * @returns {"check"|"do"|"stuck"|null}
 */
export function needsReason(task, me, actors = {}) {
  if (task.checker === me && task.state === "needs_check") return "check";
  if (task.doer === me && task.state === "ready") return "do";
  if (task.state === "stuck" && (task.doer === me || ownerOf(task.doer, actors) === me)) return "stuck";
  return null;
}

/** @param {Task} task @param {string} me @param {Record<string, Actor>|Actor[]} [actors] */
export const needsYou = (task, me, actors = {}) => needsReason(task, me, actors) !== null;

/** The state a waiting task enters once its dependencies are done: a person's task is ready, an assistant's starts working.
 * @param {Task} task @param {Record<string, Actor>|Actor[]} actors @returns {TaskState} */
export function startState(task, actors) {
  const a = actorOf(task.doer, actors);
  return !a || a.kind === "person" ? "ready" : "working";
}

/**
 * A checker's approval is needed, and it is the Gate when the output leaves the space.
 * @param {Task} task */
export const isGate = task => task.output?.kind === "sent" && !!task.checker;

/**
 * Why a move is not allowed, or null when it is. `by` is who moves it.
 * @param {Task} task @param {TaskState} to
 * @param {{ by?: string, record?: RecordRow|null, actors?: Record<string, Actor>|Actor[] }} [ctx]
 */
export function whyNot(task, to, ctx = {}) {
  if (!canMove(task.state, to)) return `A task that is ${STATE_LABEL[task.state].toLowerCase()} cannot become ${STATE_LABEL[to].toLowerCase()}.`;
  if (to === "needs_check") {
    if (!task.checker) return "This task has no checker.";
    if (!hasOutput(task, ctx.record)) return missingOutput(task, ctx.record) || "The output is not there yet.";
  }
  if (to === "done") {
    if (task.checker && ctx.by !== task.checker && task.state === "needs_check") return "Only the checker can mark this done.";
    if (task.checker && task.state !== "needs_check") return "The checker has to check it first.";
    if (isGate(task)) return "A sent item is done through the checker's approval.";
    // A person doing their own unchecked task attests a decision, a note or a file by hand; an assistant needs the output to be there, and fields must always have values.
    const byHand = actorOf(ctx.by, ctx.actors)?.kind === "person" && ctx.by === task.doer && !task.checker && ["decision", "file", "note"].includes(task.output?.kind);
    if (!byHand && !isComplete(task, ctx.record)) return missingOutput(task, ctx.record) || "The output is not there yet.";
  }
  if (to === "stuck" && !task.stuck) return "A stuck task needs a reason.";
  return null;
}

/**
 * Move a task. Returns a new task; throws an Error with the plain reason when the move is not allowed.
 * @param {Task} task @param {TaskState} to
 * @param {{ by?: string, record?: RecordRow|null, actors?: Record<string, Actor>|Actor[] }} [ctx]
 * @returns {Task}
 */
export function move(task, to, ctx = {}) {
  const why = whyNot(task, to, ctx);
  if (why) throw new Error(why);
  return { ...task, state: to, stuck: to === "stuck" ? task.stuck ?? null : null };
}

/**
 * The checker's approval. For a sent item this is the Gate approval: the task is done and one event records that it left the space (the mock sends nothing).
 * @param {Task} task @param {Proof} proof @param {{ by: string, now: number, record?: RecordRow|null }} ctx
 * @returns {Task}
 */
export function approve(task, proof, ctx) {
  if (task.state !== "needs_check") throw new Error("Nothing is waiting for a check on this task.");
  if (!task.checker) throw new Error("This task has no checker.");
  if (ctx.by !== task.checker) throw new Error("Only the checker can approve this.");
  if (!proof || !["face_id", "touch_id", "passkey"].includes(proof.method)) throw new Error("Approval needs Face ID, Touch ID or a passkey.");
  if (!hasOutput(task, ctx.record)) throw new Error(missingOutput(task, ctx.record) || "The output is not there yet.");
  const result = { ...(/** @type {any} */ (task).result || {}) };
  const stamp = { at: ctx.now, by: ctx.by, method: proof.method };
  result.approved = stamp;
  if (task.output.kind === "sent") result.sent = stamp;
  return /** @type {Task} */ ({ ...task, state: "done", stuck: null, result });
}

/**
 * An assistant that cannot continue sets stuck with a reason and a suggested fix (DESIGN-tasks.md). It lands in its owner's Now.
 * @param {Task} task @param {string} reason @param {string} suggestedFix @param {number} now
 * @returns {Task}
 */
export function makeStuck(task, reason, suggestedFix, now) {
  if (!String(reason || "").trim()) throw new Error("A stuck task needs a reason.");
  if (!canMove(task.state, "stuck")) throw new Error(`A task that is ${STATE_LABEL[task.state].toLowerCase()} cannot become stuck.`);
  return { ...task, state: "stuck", stuck: { reason: String(reason), since: now, suggestedFix: String(suggestedFix || "") } };
}

/** Clear stuck (the fix was made). The task goes back to ready for a person and to working for an assistant.
 * @param {Task} task @param {Record<string, Actor>|Actor[]} actors @returns {Task} */
export function unstick(task, actors) {
  if (task.state !== "stuck") return task;
  return { ...task, state: startState(task, actors), stuck: null };
}

/** Hand a task to a new doer. It keeps its state, except a stuck one, which starts again for the new doer.
 * @param {Task} task @param {string} doer @param {Record<string, Actor>|Actor[]} actors @returns {Task} */
export function reassign(task, doer, actors) {
  if (task.state === "done" || task.state === "skipped") throw new Error("A finished task cannot be reassigned.");
  const next = { ...task, doer, helpers: (task.helpers || []).filter(h => h !== doer) };
  return task.state === "stuck" ? unstick(next, actors) : next;
}

/**
 * Dependency unblocking: every waiting task whose dependencies are all done (or skipped) starts. Returns a new array, and the ids that changed.
 * @param {Task[]} tasks @param {Record<string, Actor>|Actor[]} actors
 * @returns {{ tasks: Task[], started: string[] }}
 */
export function unblock(tasks, actors) {
  const finished = new Set(tasks.filter(t => t.state === "done" || t.state === "skipped").map(t => t.id));
  /** @type {string[]} */
  const started = [];
  const next = tasks.map(t => {
    if (t.state !== "waiting") return t;
    if (!(t.dependsOn || []).every(d => finished.has(d))) return t;
    started.push(t.id);
    return { ...t, state: startState(t, actors) };
  });
  return { tasks: next, started };
}

/**
 * A stage is done when its required tasks are done (a task is required unless `required` is false; skipped counts). A stage with no required task is not done.
 * @param {Task[]} tasks all the tasks of one record @param {string} stage
 */
export function stageDone(tasks, stage) {
  const req = tasks.filter(t => t.stage === stage && /** @type {any} */ (t).required !== false);
  return req.length > 0 && req.every(t => t.state === "done" || t.state === "skipped");
}

/** Progress over a stage's required tasks.
 * @param {Task[]} tasks @param {string} stage @returns {{ done: number, total: number }} */
export function stageProgress(tasks, stage) {
  const req = tasks.filter(t => t.stage === stage && /** @type {any} */ (t).required !== false);
  return { done: req.filter(t => t.state === "done" || t.state === "skipped").length, total: req.length };
}

/**
 * The stage progression rule: when the current stage is done and there is a next one, the record moves on by itself.
 * @param {string[]} stages @param {string|undefined} current @param {Task[]} tasks
 * @returns {{ moved: boolean, stage: string|undefined, from?: string }}
 */
export function advanceStage(stages, current, tasks) {
  const i = current ? stages.indexOf(current) : -1;
  if (i < 0 || i >= stages.length - 1) return { moved: false, stage: current };
  if (!stageDone(tasks, /** @type {string} */ (current))) return { moved: false, stage: current };
  return { moved: true, stage: stages[i + 1], from: current };
}

/**
 * A template of a Kit stage (DESIGN-tasks.md, idea 5): title, doer, checker, output, how, what it depends on (titles), an optional due offset in days.
 * Text may hold {client}, {record}, which spawn fills in.
 * @typedef {{ title: string, doer: string, checker?: string|null, output: { kind: import("./contracts.js").TaskOutputKind, target?: string, fields?: string[] },
 *   how?: import("./contracts.js").TaskHow, template?: string, dependsOn?: string[], dueInDays?: number, required?: boolean, say?: string }} TaskTemplate
 */

/**
 * Entering a stage creates its tasks. Returns tasks that are waiting, ready or working already.
 * @param {TaskTemplate[]} templates @param {{ record: string, stage: string, vars?: Record<string, string>, now: number, madeBy?: string,
 *   newId: () => string, actors: Record<string, Actor>|Actor[], existing?: Task[] }} ctx
 * @returns {Task[]}
 */
export function spawnStage(templates, ctx) {
  const fill = (/** @type {string|undefined} */ s) => (s === undefined ? s : s.replace(/\{(\w+)\}/g, (m, k) => ctx.vars?.[k] ?? m));
  const have = new Set((ctx.existing || []).filter(t => t.stage === ctx.stage).map(t => t.title));
  /** @type {Task[]} */
  const made = [];
  /** @type {Map<string, string>} title -> id, for this stage and the existing tasks */
  const byTitle = new Map((ctx.existing || []).map(t => [t.title, t.id]));
  for (const t of templates) {
    const title = /** @type {string} */ (fill(t.title));
    if (have.has(title)) continue;
    byTitle.set(title, ctx.newId());
    made.push(/** @type {Task} */ ({
      id: /** @type {string} */ (byTitle.get(title)), title, record: ctx.record, stage: ctx.stage, doer: t.doer, checker: t.checker || null, helpers: [],
      output: { ...t.output, target: fill(t.output.target) }, how: t.how, template: t.template, inputs: [], dependsOn: [],
      due: t.dueInDays ? ctx.now + t.dueInDays * 86_400_000 : null, state: "waiting", stuck: null, session: null, madeBy: ctx.madeBy,
      required: t.required === false ? false : true, say: fill(t.say),
    }));
  }
  // Resolve dependencies by title, now that every id exists.
  const all = new Map(byTitle);
  for (const [i, t] of templates.entries()) {
    const title = /** @type {string} */ (fill(t.title));
    const task = made.find(m => m.title === title);
    if (!task) continue;
    task.dependsOn = (t.dependsOn || []).map(d => all.get(/** @type {string} */ (fill(d)))).filter(/** @returns {x is string} */ x => !!x);
    void i;
  }
  return unblock(made, ctx.actors).tasks;
}

/**
 * The one sentence under a drafted task: who made it, from what, with what. "Intake drafted it from Welcome, using Research's notes."
 * @param {Task} task @param {{ actors: Record<string, Actor>|Actor[], templateName?: string, usedNotesOf?: string }} ctx
 */
export function howSentence(task, ctx) {
  const doer = actorOf(task.doer, ctx.actors)?.name || task.doer;
  const from = ctx.templateName ? ` from ${ctx.templateName}` : "";
  const using = ctx.usedNotesOf ? `, using ${ctx.usedNotesOf}'s notes` : "";
  switch (task.how) {
    case "tailor": return `${doer} drafted it${from}${using}.`;
    case "template": return `${doer} filled ${ctx.templateName || "the template"}.`;
    case "assistant": return `${doer} wrote it.`;
    default: return `${doer} wrote it.`;
  }
}

/** The line a card shows as its title. A task can carry its own (`say`); otherwise the title, with "is ready" when a draft waits for its checker.
 * @param {Task} task @param {"check"|"do"|"stuck"|null} reason @param {Record<string, Actor>|Actor[]} [actors] */
export function cardTitle(task, reason, actors = {}) {
  const say = /** @type {any} */ (task).say;
  if (reason === "stuck") {
    if (say) return say;
    const a = actorOf(task.doer, actors)?.name || task.doer;
    return `${a} could not continue: ${task.title}`;
  }
  if (say) return say;
  if (reason === "check") return /\bis ready$/.test(task.title) ? task.title : `${task.title} is ready`;
  return task.title;
}
