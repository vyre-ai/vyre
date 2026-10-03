// @ts-check
// deck/ui/tasks: the task model as pure functions over the kernel's Task (team/0.3/DESIGN-tasks.md, kernel/contracts/task.d.ts). Nothing here touches a store, a DOM or
// a clock it was not handed, so the mock store, the real gateway adapter and the tests all use the same rules.
//
// A task has one doer and, optionally, one checker. It says what done looks like (its output), and the kernel checks that deterministically: an assistant cannot mark
// Research done while the fields are empty. A stage is a list of task templates; entering it creates its tasks, and when its required tasks are done the record moves on
// by itself. When a task's output leaves the space (kind "sent"), the checker's approval is the Gate approval: one card, never two.
//
// Who may move a task is the kernel's table, not ours: TASK_TRANSITIONS (kernel/contracts/index.js) says from, to and `by`. whyNot() reads it, so the Deck offers a button
// only for a move the table allows that person, and the mock store refuses every other one.
import { TASK_STATES, TASK_TRANSITIONS, TASK_OUTPUT_KINDS, PRESENCE_SIGNERS } from "../../kernel/contracts/index.js";
import { aid } from "./kernel-view.js";

/** @typedef {import("./contracts.js").DeckTask} Task */
/** @typedef {import("./contracts.js").TaskState} TaskState */
/** @typedef {import("./contracts.js").Who} Who */
/** @typedef {import("./contracts.js").Actor} Actor */
/** @typedef {import("./contracts.js").GatewayRecord} GatewayRecord */
/** @typedef {import("./contracts.js").PresenceProof} PresenceProof */
/** @typedef {import("./contracts.js").Evidence} Evidence */
/** @typedef {import("./contracts.js").TaskTemplateDef} TaskTemplateDef */
/** @typedef {import("../../kernel/contracts/task.js").TransitionRule} TransitionRule */

/** The seven states, from the kernel's table. */
export const STATES = TASK_STATES;

/** The words the Deck shows for a state. */
export const STATE_LABEL = /** @type {Record<TaskState, string>} */ ({
  waiting: "Waiting", ready: "Ready", working: "Working", needs_check: "Needs a check", stuck: "Stuck", done: "Done", skipped: "Skipped",
});

/** What each output kind is, and what done means for it (DESIGN-tasks.md, idea 3). The keys are the kernel's TASK_OUTPUT_KINDS. */
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

const blank = (/** @type {any} */ v) => v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length)
  || (typeof v === "object" && !Array.isArray(v) && ("amount" in v ? v.amount === null || v.amount === undefined : "urn" in v ? !v.urn : "sealed" in v ? v.present === false : false));

// ---------------------------------------------------------------------------------------------------------------------------- the table

/** Every rule that moves a task from one state to another (there can be two: a guarded one and an unguarded one). @param {TaskState} from @param {TaskState} to @returns {readonly TransitionRule[]} */
export const rulesFor = (from, to) => TASK_TRANSITIONS.filter(r => r.from === from && r.to === to);

/** Does the table have any rule for this move? @param {TaskState} from @param {TaskState} to */
export const canMove = (from, to) => rulesFor(from, to).length > 0;

/** An output that leaves the space always has a checker (SPEC-core-contract.md 9.4, E-2). @param {Task} task */
const outward = task => task.output?.kind === "sent";
/** The stage's required flag: a task of a stage is required unless its template said otherwise. @param {Task} task */
export const isRequired = task => !!task.stage && task.ext?.required !== false;

/**
 * Does the task fall under the rule's `guarded` flag? For a skip it is a checker, an outward output or the stage's required flag (contract 9.4, "Who may move a task").
 * For the move out of `working` it is a checker or an outward output (a task with no checker goes straight to done after the output check).
 * @param {Task} task @param {TransitionRule} rule
 */
export function guardedFor(task, rule) {
  if (rule.to === "skipped") return !!task.checker || outward(task) || isRequired(task);
  return !!task.checker || outward(task);
}

/** The one rule of the table that applies to this task and this move, or undefined. @param {Task} task @param {TaskState} to */
export function ruleOf(task, to) {
  const rules = rulesFor(task.state, to);
  return rules.find(r => r.guarded === undefined) || rules.find(r => r.guarded === guardedFor(task, r));
}

/**
 * @typedef {{ by?: string, actors?: Who[], record?: GatewayRecord|null, kernel?: boolean, detected?: boolean, presence?: boolean, proof?: PresenceProof|null }} MoveCtx
 * `by`: who moves it (an actor id). `kernel`: the kernel makes this move itself (after its output check, or when dependencies are met). `detected`: the kernel's own
 * stuck detection. `presence`: the person has just proved presence (a fresh proof).
 */

/**
 * Why a move is not allowed, or null when it is: the table's `by` column, read against who is moving it.
 * @param {Task} task @param {TaskState} to @param {MoveCtx} [ctx]
 * @returns {string | null}
 */
export function whyNot(task, to, ctx = {}) {
  const rule = ruleOf(task, to);
  if (!rule) return `A task that is ${STATE_LABEL[task.state].toLowerCase()} cannot become ${STATE_LABEL[to].toLowerCase()}.`;
  const by = ctx.by || "", actors = ctx.actors || [];
  const me = actorOf(by, actors), isPerson = me?.family === "person";
  switch (rule.by) {
    case "nobody": return "Nobody moves a task that way.";
    case "dependencies_met": return ctx.kernel ? null : "A task starts by itself when what it waits for is done.";
    case "doer": return by === aid(task.doer) ? null : "Only the doer can start this.";
    case "doer_or_person": return by === aid(task.doer) || isPerson ? null : "Only the doer or a person can skip this.";
    case "checker": return by === aid(task.checker) && isPerson ? null : "Only the checker can send it back.";
    case "checker_approval": return by === aid(task.checker) && (ctx.proof || ctx.presence) ? null : "Only the checker can mark this done, with their approval.";
    case "proposal_for_person_with_presence": return isPerson && ctx.presence ? null : "Skipping this needs a person's approval, with Face ID.";
    case "responsible_person_or_person_with_presence":
      return isPerson && (ownerOf(aid(task.doer), actors) === by || ctx.presence) ? null : "Only the person responsible for the doer can do that.";
    case "assistant_or_detection": return ctx.detected || (by === aid(task.doer) && !!me && !isPerson) ? null : "Only the assistant itself, or Vyre, can mark a task stuck.";
    case "kernel_after_output_check": {
      if (!ctx.kernel) return "Vyre moves this once the output is checked.";
      if (to === "needs_check" && !task.checker) return "This task has no checker.";
      if (to === "needs_check" && !hasOutput(task, ctx.record)) return missingOutput(task, ctx.record) || "The output is not there yet.";
      if (to === "done" && !isComplete(task, ctx.record)) return missingOutput(task, ctx.record) || "The output is not there yet.";
      return null;
    }
    default: return `Nothing in the table lets ${by || "anyone"} do that.`;
  }
}

/** The moves a person could offer on a task: every `to` the table has a rule for from this state that this person may make. @param {Task} task @param {MoveCtx} ctx @returns {TaskState[]} */
export const offers = (task, ctx) => /** @type {TaskState[]} */ (STATES.filter(to => canMove(task.state, to) && whyNot(task, to, ctx) === null));

// ---------------------------------------------------------------------------------------------------------------------------- output

/** The names of the fields a `fields` task asks for. @param {Task} task @returns {string[]} */
export function fieldNames(task) {
  const t = task.output?.target;
  if (task.output?.kind !== "fields" || t === undefined) return [];
  return (Array.isArray(t) ? t : String(t).split(",")).map(s => String(s).trim()).filter(Boolean);
}

/** What the card and the task page print for an output's target; a fields task names its fields by their labels. @param {Task} task @param {(name: string) => string|undefined} [labelOf] */
export function targetText(task, labelOf) {
  if (task.output?.kind === "fields") return fieldNames(task).map(n => labelOf?.(n) ?? n.charAt(0).toUpperCase() + n.slice(1)).join(", ");
  const t = task.output?.target;
  return t === undefined ? "" : Array.isArray(t) ? t.join(", ") : String(t);
}

/** The doer's evidence of an output that is not a field on the record. @param {Task} task */
export const evidenceOf = task => task.ext?.result || {};

/** The yes or no a decision task holds (the kernel's `answer`). @param {Task} task @returns {{ answer: "yes"|"no", reason: string } | null} */
export const decisionOf = task => { const a = /** @type {any} */ (task.answer); return a && (a.answer === "yes" || a.answer === "no") ? a : null; };

/**
 * Is the output there, ignoring the checker? For a sent item this means the draft exists and is ready for the checker's one tap.
 * @param {Task} task @param {GatewayRecord|null|undefined} record
 */
export function hasOutput(task, record) {
  const r = evidenceOf(task);
  switch (task.output?.kind) {
    case "fields": { const names = fieldNames(task); return names.length > 0 && names.every(k => !blank(record?.data?.[k])); }
    case "note": return !!r.note && !blank(r.note.text) && Array.isArray(r.note.sources) && r.note.sources.length > 0;
    case "draft":
    case "sent": return !!r.draft && !blank(r.draft.body);
    case "decision": { const d = decisionOf(task); return !!d && !blank(d.reason); }
    case "file": return !!r.file && !blank(r.file.name);
    default: return false;
  }
}

/** Deterministic completion: is the task's declared output really there? A sent item is complete only once it left through the checker's approval. @param {Task} task @param {GatewayRecord|null|undefined} record */
export function isComplete(task, record) {
  if (!hasOutput(task, record)) return false;
  if (task.output?.kind === "sent") return task.outcome === "approved";
  return true;
}

/** What is still missing, in a plain sentence, or null when nothing is. @param {Task} task @param {GatewayRecord|null|undefined} record */
export function missingOutput(task, record) {
  if (hasOutput(task, record) && isComplete(task, record)) return null;
  const k = task.output?.kind;
  if (k === "fields") {
    const empty = fieldNames(task).filter(f => blank(record?.data?.[f]));
    return empty.length ? `These fields are empty: ${empty.join(", ")}.` : "No fields are named.";
  }
  if (k === "note") return "The note and its sources are not on the record yet.";
  if (k === "draft") return "There is no draft yet.";
  if (k === "sent") return hasOutput(task, record) ? "It has not been sent through the checker's approval yet." : "There is no draft to send yet.";
  if (k === "decision") return "There is no yes or no with a reason yet.";
  if (k === "file") return "No file has been added yet.";
  return "The output is not there yet.";
}

/** Put the doer's evidence on a task: the draft, note and file under ext.result, a decision as the kernel's `answer`. @param {Task} task @param {Evidence} e @returns {Task} */
export function withEvidence(task, e) {
  const { decision, ...rest } = e;
  const result = { ...(task.ext?.result || {}), ...rest };
  /** @type {Task} */
  const next = { ...task, ext: { ...(task.ext || {}), ...(Object.keys(rest).length ? { result } : {}) } };
  return decision ? { ...next, answer: { answer: decision.answer, reason: decision.reason } } : next;
}

/** What a person attests by hand when they mark their own unchecked task done: a decision, a note or a file (a field task needs real values). @param {Task} task @returns {Evidence} */
export function handEvidence(task) {
  const what = targetText(task) || task.title;
  if (task.output.kind === "decision") return { decision: { answer: "yes", reason: "Done by hand." } };
  if (task.output.kind === "note") return { note: { text: "Done by hand.", sources: ["Added by hand"] } };
  if (task.output.kind === "file") return { file: { name: what } };
  return {};
}

// ---------------------------------------------------------------------------------------------------------------------------- people

/** @param {string|undefined} id @param {Record<string, Who>|Who[]|undefined} actors @returns {Who|undefined} */
export function actorOf(id, actors) {
  if (!id || !actors) return undefined;
  return Array.isArray(actors) ? actors.find(a => a.id === id) : actors[id];
}

/** The person accountable for an actor: a person is their own, an assistant or teammate belongs to its owner (`owner`, else itself). @param {string} id @param {Who[]|Record<string, Who>} actors */
export function ownerOf(id, actors) {
  const a = actorOf(id, actors);
  if (!a) return id;
  if (a.family === "person") return a.id;
  return a.owner || id;
}

/**
 * Why a task needs `me`, or null (DESIGN-tasks.md, Now): I am the checker and it waits for my check; I am the doer and it is ready; it is stuck and I
 * am responsible (I am the doer, or the doer is my assistant).
 * @param {Task} task @param {string} me an actor id @param {Who[]|Record<string, Who>} [actors]
 * @returns {"check"|"do"|"stuck"|null}
 */
export function needsReason(task, me, actors = {}) {
  if (aid(task.checker) === me && task.state === "needs_check") return "check";
  if (aid(task.doer) === me && task.state === "ready") return "do";
  if (task.state === "stuck" && (aid(task.doer) === me || ownerOf(aid(task.doer), actors) === me)) return "stuck";
  return null;
}

/** @param {Task} task @param {string} me @param {Who[]|Record<string, Who>} [actors] */
export const needsYou = (task, me, actors = {}) => needsReason(task, me, actors) !== null;

/** Can this doer start a ready task on its own (an assistant's session picks it up)? @param {Task} task @param {Who[]|Record<string, Who>} actors */
export const startsItself = (task, actors) => task.state === "ready" && (() => { const a = actorOf(aid(task.doer), actors); return !!a && a.family !== "person"; })();

/** A checker's approval is needed, and it is the Gate when the output leaves the space. @param {Task} task */
export const isGate = task => task.output?.kind === "sent" && !!task.checker;

// ---------------------------------------------------------------------------------------------------------------------------- moves

/** @param {Task} task @param {TaskState} to @param {MoveCtx} [ctx] @returns {Task} */
export function move(task, to, ctx = {}) {
  const why = whyNot(task, to, ctx);
  if (why) throw new Error(why);
  const { stuck, ...rest } = task;
  return /** @type {Task} */ ({ ...rest, state: to, ...(to === "stuck" && stuck ? { stuck } : {}) });
}

/**
 * The checker's approval (ask.decide, outcome approved). For a sent item this is the Gate approval: the task is done and the outcome says it left the space (the mock
 * sends nothing). The proof is a presence proof (a biometric-gated key's signature over the payload); the Deck simulates one in the preview.
 * @param {Task} task @param {PresenceProof} proof @param {{ by: string, now: number, record?: GatewayRecord|null, actors?: Who[] }} ctx @returns {Task}
 */
export function approve(task, proof, ctx) {
  if (task.state !== "needs_check") throw new Error("Nothing is waiting for a check on this task.");
  if (!task.checker) throw new Error("This task has no checker.");
  if (ctx.by !== aid(task.checker)) throw new Error("Only the checker can approve this.");
  if (!isProof(proof)) throw new Error("Approval needs Face ID, Touch ID or a passkey: a presence proof from your device.");
  if (!hasOutput(task, ctx.record)) throw new Error(missingOutput(task, ctx.record) || "The output is not there yet.");
  const why = whyNot(task, "done", { by: ctx.by, actors: ctx.actors || [], proof });
  if (why) throw new Error(why);
  const { stuck, ...rest } = task;
  void stuck;
  return /** @type {Task} */ ({ ...rest, state: "done", outcome: "approved", payload: { payload_hash: proof.payload_hash, decision: proof.decision }, updated_at: ctx.now });
}

/** The checker sends a drafted item back with a reason (ask.decide, outcome rejected): needs_check to ready. @param {Task} task @param {string} reason @param {PresenceProof} proof @param {{ by: string, now: number, actors?: Who[] }} ctx @returns {Task} */
export function reject(task, reason, proof, ctx) {
  if (task.state !== "needs_check") throw new Error("Nothing is waiting for a check on this task.");
  if (!isProof(proof)) throw new Error("Sending it back needs a presence proof from your device.");
  const why = whyNot(task, "ready", { by: ctx.by, actors: ctx.actors || [] });
  if (why) throw new Error(why);
  return /** @type {Task} */ ({ ...task, state: "ready", outcome: "rejected", answer: { reason: String(reason || "") }, updated_at: ctx.now });
}

/** @param {any} p @returns {p is PresenceProof} */
export const isProof = p => !!p && PRESENCE_SIGNERS.includes(p.signer) && typeof p.payload_hash === "string" && typeof p.decision === "string" && typeof p.signature === "string";

/**
 * An assistant that cannot continue sets stuck with a reason and a suggested fix (DESIGN-tasks.md). It lands in its owner's Now. The fix is quoted text in the doer's block
 * (a model's own words give no one-tap grant).
 * @param {Task} task @param {string} reason @param {string} suggestedFix @param {number} now @param {MoveCtx} [ctx]
 * @returns {Task}
 */
export function makeStuck(task, reason, suggestedFix, now, ctx = { detected: true }) {
  if (!String(reason || "").trim()) throw new Error("A stuck task needs a reason.");
  const why = whyNot({ ...task, stuck: undefined }, "stuck", ctx);
  if (why) throw new Error(why);
  return /** @type {Task} */ ({ ...task, state: "stuck", stuck: { reason: String(reason), since: now, ...(suggestedFix ? { suggested_fix: { text: String(suggestedFix) } } : {}) } });
}

/** Hand a stuck task to a new doer, or back to the same one once it is fixed: stuck to ready, by the person responsible (never the doer). @param {Task} task @param {Actor} doer @param {MoveCtx} ctx @returns {Task} */
export function reassign(task, doer, ctx) {
  if (task.state === "done" || task.state === "skipped") throw new Error("A finished task cannot be reassigned.");
  const why = whyNot(task, "ready", ctx);
  if (why) throw new Error(why);
  const { stuck, ...rest } = task;
  void stuck;
  return /** @type {Task} */ ({ ...rest, state: "ready", doer, helpers: (task.helpers || []).filter(x => x.id !== doer.id) });
}

/**
 * Dependency unblocking, by the kernel: every waiting task whose dependencies are all done (or skipped) becomes ready. Returns a new array, and the ids that changed.
 * An assistant's ready task then starts by itself (the store does that as a second, separate move: ready to working, by the doer).
 * @param {Task[]} tasks @returns {{ tasks: Task[], started: string[] }}
 */
export function unblock(tasks) {
  const finished = new Set(tasks.filter(t => t.state === "done" || t.state === "skipped").map(t => t.id));
  /** @type {string[]} */
  const started = [];
  const next = tasks.map(t => {
    if (t.state !== "waiting") return t;
    if (!(t.depends_on || []).every(d => finished.has(d))) return t;
    started.push(t.id);
    return /** @type {Task} */ ({ ...t, state: "ready" });
  });
  return { tasks: next, started };
}

/**
 * A stage is done when its required tasks are done (a task is required unless its template said so; skipped counts). A stage with no required task is not done.
 * @param {Task[]} tasks all the tasks of one record @param {string} stage
 */
export function stageDone(tasks, stage) {
  const req = tasks.filter(t => t.stage === stage && t.ext?.required !== false);
  return req.length > 0 && req.every(t => t.state === "done" || t.state === "skipped");
}

/** Progress over a stage's required tasks. @param {Task[]} tasks @param {string} stage @returns {{ done: number, total: number }} */
export function stageProgress(tasks, stage) {
  const req = tasks.filter(t => t.stage === stage && t.ext?.required !== false);
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
 * Entering a stage creates its tasks, from the stage's TaskTemplateDefs (kernel/contracts/fields.d.ts). Text may hold {client}, which `vars` fills in. A doer or checker is a
 * reference ("teammate:research", "person:alex") the caller resolves to an Actor; `template` is a Template record's name, resolved to its urn. Returns tasks that are waiting
 * or ready (the store starts an assistant's).
 * @param {readonly TaskTemplateDef[]} templates
 * @param {{ record: string, space: string, stage: string, vars?: Record<string, string>, now: number, assignedBy: Actor, newId: () => string, actor: (ref: string) => Actor,
 *   templateUrn?: (name: string) => string|undefined, existing?: Task[] }} ctx
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
    const id = ctx.newId();
    byTitle.set(title, id);
    const target = t.output.kind === "fields" ? (t.output.target || "").split(",").map(s => s.trim()).filter(Boolean) : fill(t.output.target);
    const tpl = t.template ? ctx.templateUrn?.(t.template) : undefined;
    made.push(/** @type {Task} */ ({
      id, space: ctx.space, title, record: ctx.record, stage: ctx.stage, doer: ctx.actor(t.doer), ...(t.checker ? { checker: ctx.actor(t.checker) } : {}),
      output: { kind: t.output.kind, ...(target !== undefined ? { target } : {}) }, ...(t.how ? { how: t.how } : {}), ...(tpl ? { template: tpl } : {}),
      depends_on: [], ...(t.due_offset_ms ? { due: ctx.now + t.due_offset_ms } : {}), state: "waiting", assigned_by: ctx.assignedBy,
      labels: { trust: "member", red: "internal", source_spaces: [ctx.space] }, created_at: ctx.now, updated_at: ctx.now,
      ...(t.required === false ? { ext: { required: false } } : {}),
    }));
  }
  // Resolve dependencies by title, now that every id exists.
  for (const t of templates) {
    const task = made.find(m => m.title === fill(t.title));
    if (!task) continue;
    /** @type {any} */ (task).depends_on = (t.depends_on || []).map(d => byTitle.get(/** @type {string} */ (fill(d)))).filter(/** @returns {x is string} */ x => !!x);
  }
  return unblock(made).tasks;
}

// ---------------------------------------------------------------------------------------------------------------------------- words

/**
 * The one sentence under a drafted task: who made it, from what, with what. "Intake drafted it from Welcome, using Research's notes."
 * @param {Task} task @param {{ actors: Who[]|Record<string, Who>, templateName?: string, usedNotesOf?: string }} ctx
 */
export function howSentence(task, ctx) {
  const doer = actorOf(aid(task.doer), ctx.actors)?.name || aid(task.doer);
  const from = ctx.templateName ? ` from ${ctx.templateName}` : "";
  const using = ctx.usedNotesOf ? `, using ${ctx.usedNotesOf}'s notes` : "";
  switch (task.how) {
    case "tailor": return `${doer} drafted it${from}${using}.`;
    case "template": return `${doer} filled ${ctx.templateName || "the template"}.`;
    case "assistant": return `${doer} wrote it.`;
    default: return `${doer} wrote it.`;
  }
}

/**
 * The line a card shows as its title. A task can carry its own (`ext.say`); otherwise the title, with "is ready" when a draft waits for its checker.
 * @param {Task} task @param {"check"|"do"|"stuck"|null} reason @param {Who[]|Record<string, Who>} [actors]
 */
export function cardTitle(task, reason, actors = {}) {
  const say = task.ext?.say;
  if (reason === "stuck") {
    if (say) return say;
    const a = actorOf(aid(task.doer), actors)?.name || aid(task.doer);
    return `${a} could not continue: ${task.title}`;
  }
  if (say) return say;
  if (reason === "check") return /\bis ready$/.test(task.title) ? task.title : `${task.title} is ready`;
  return task.title;
}

void TASK_OUTPUT_KINDS;
