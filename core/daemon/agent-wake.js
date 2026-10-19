// core/daemon/agent-wake: a task given to an agent wakes it. A Flow's agent step (kernel/flows/runner.js #task) and tasks.request both leave a ready task whose doer is an agent, and nothing started
// the agent's work. This watches the kernel log for such a task and asks the agents module for one job thread (agents.wake, once per task and agent, claimed in its own table so a restart or a repeated
// event starts nothing twice). The job's thread is written on the task as form.thread (a kernel edit, which only the task's doer, a person or whoever assigned it may make: `editChain` gives the assigner's), so the task links to the work. The agent starts and submits the task itself: nothing here marks it done.
//
//   const onEvent = createAgentWake({ space, gw, chain, editChain, callModule, log });
//   k.log.subscribe("agent-wake", {}, onEvent);

/** A task older than this is never woken by a replayed event (a restart reading the log from the start must not wake what was left long ago). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TYPES = /^task\.(created|readied|unblocked)$/;
/** A task handed to a reviewer or an approver (the kernel writes these two events when it enters those steps). */
const SLOT_TYPES = /^task\.(in-review|needs-check)$/;
/** The ends of a review or an approval round: the slot wake is over, though the task is not (the doer may be given changes to make). */
const SLOT_ENDS = /^task\.(changes-requested|review-passed|review-pass-kept|declined)$/;
/** How many rounds an agent reviewer may be woken for one task before a person takes it (agent doer, agent reviewer, changes, doer again must end). The one number. */
export const AGENT_REVIEW_ROUNDS = 5;
/** A reviewer or doer is not woken again for the same task within this time (a burst of events is one wake; a real round takes longer). */
const DEBOUNCE_MS = 3_000;
const AUTH = /oauth|expired|sign.?in|log.?in|authenticat|credential|401|unauthori[sz]ed|api key/i;
const ENDS = /^task\.(completed|approved|rejected|skipped|voided|withdrawn)$/;

/**
 * @param {{ space: string, gw: any, chain: () => any, editChain?: (task: any) => any, lend?: (task: any) => Promise<any>, bind?: (task: any, thread: string) => Promise<any>, reclaim?: (taskId: string) => Promise<any>, agentChain?: (task: any) => any, callModule: (tool: string, input: any, space?: string) => Promise<any>, log?: (m: string) => void, clock?: () => number }} o
 * @returns {((e: any) => Promise<void>) & { threadEnded: (thread: string, reason?: string) => Promise<void> }}
 */
export function createAgentWake(o) {
  const log = o.log || (() => {});
  const clock = o.clock || Date.now;
  /** @type {Set<string>} tasks whose job already ended unstarted once: the second time the task is stuck, in words */
  const retried = new Set();
  /**
   * A task the agent could not start or did not finish is never left open in silence: it is marked stuck, as the agent itself (the assigner on the chain, the one shape the kernel takes for the doer's own
   * flag), with what happened in plain words and what to do. It surfaces in Needs you for the assigner and approver, and the run shows it. The wake is marked failed so one retry may start it again.
   * @param {any} t @param {string} why
   */
  async function stick(t, why) {
    const reason = sayWhy(t.doer.id, why);
    try {
      await o.callModule("agents.wake-failed", { task: t.id, agent: t.doer.id }, o.space).catch(() => null);
      if (typeof o.agentChain !== "function") return;
      await o.gw.ask.stuck(o.agentChain(t), t.id, reason);
    } catch (err) { log(`agent wake ${o.space}: task ${t.id} could not be marked stuck (${/** @type {Error} */ (err).message})`); }
  }

  /** End what was lent for a task (best effort: the task's own end reclaims it again). @param {string} id */
  const drop = async id => { if (typeof o.reclaim !== "function") return; try { await o.reclaim(id); } catch (err) { log(`agent wake ${o.space}: the lent use of task ${id} was not ended (${/** @type {Error} */ (err).message})`); } };

  /** A wake job's thread ended (finished or stopped): a task still open that the agent has not handed in, flagged or moved is stuck. @param {string} thread @param {string} [reason] */
  async function threadEnded(thread, reason) {
    try {
      const w = await o.callModule("agents.woken", { thread }, o.space);
      if (!w || !w.task) return;
      // a review or an approval round's job ended: its hold on the task ends with it (the task stays where it is for a person, or the next round)
      if (String(w.task).includes("#")) { const real = String(w.task).split("#")[0]; await o.callModule("agents.wake-done", { task: real, slots: true }, o.space).catch(() => null); if (typeof o.reclaimSlots === "function") await o.reclaimSlots(real).catch(() => null); return; }
      const t = await o.gw.ask.get(o.chain(), w.task);
      if (!t || !["ready", "working"].includes(t.state)) return;
      await drop(t.id);   // the job is gone: what was lent for it (the task grant and the connections) ends with it; a retry lends again
      // A job that ended before the agent ever started its task (the moment the lend is held to the job's thread, a refusal there, a crash at launch) is woken once more, quietly: the task is not stuck yet.
      if (t.state === "ready" && !retried.has(t.id)) {
        retried.add(t.id);
        await o.callModule("agents.wake-failed", { task: t.id, agent: t.doer.id }, o.space).catch(() => null);
        await onEvent({ type: "task.readied", data: { task: { id: t.id } } });
        return;
      }
      // the stop reason is often bare; what the thread itself said last (an expired sign-in says so there) is the better words
      let said = reason || "";
      if (!AUTH.test(said)) { try { const g = await o.callModule("threads.get", { thread, limit: 1 }, o.space); const th = g && (g.thread || g.data && g.data.thread); const line = th && (th.last_line || th.stopped_reason); if (line) said = `${said} ${String(line)}`.trim(); } catch { /* the thread could not be read: the reason given stands */ } }
      await stick(t, said);
    } catch (err) { log(`agent wake ${o.space}: thread ${thread} ended and its task was not checked (${/** @type {Error} */ (err).message})`); }
  }

  /** End the job thread an agent was woken in for a task. The thread is the one the wake itself recorded (agents.woken by task), never the task's form: the form is the doer's to edit, and a doer must not be able to aim the stop at another thread. @param {string} taskId */
  async function stopThread(taskId) {
    try {
      const w = await o.callModule("agents.woken", { task: taskId }, o.space);
      const thread = w && w.task === taskId && typeof w.thread === "string" && w.thread ? w.thread : null;
      if (thread) {
        await o.callModule("threads.stop", { thread }, o.space);
        // what the session held for a yes meanwhile is cancelled, with the reason in plain words in the approvals queue
        await o.callModule("gate.withdraw-thread", { thread, why: "The task's due time passed, so this was cancelled and nothing was sent." }, o.space);
        await o.callModule("approvals.withdraw-thread", { thread, why: "The task's due time passed, so this was cancelled and nothing was sent." }, o.space);
      }
    } catch (err) { log(`agent wake ${o.space}: the session for withdrawn task ${taskId} was not ended (${/** @type {Error} */ (err).message})`); }
  }

  /** @type {Map<string, number>} when a task last woke an agent, for the debounce */
  const lastWake = new Map();
  const debounced = (/** @type {string} */ key) => { const now = clock(), at = lastWake.get(key); if (at !== undefined && now - at < DEBOUNCE_MS) return true; lastWake.set(key, now); return false; };
  /**
   * The loop agent doer, agent reviewer, changes, doer again ends: after AGENT_REVIEW_ROUNDS reviews by an agent the task goes to a person (a note task for the one who gave it) and no agent is woken for it again.
   * @param {any} t @returns {Promise<boolean>} true when the cap is reached and a person has it
   */
  async function capped(t) {
    let rounds = 0;
    try { const r = await o.callModule("agents.wake-rounds", { task: t.id }, o.space); rounds = r && Number.isInteger(r.rounds) ? r.rounds : 0; } catch { return false; }
    if (rounds < AGENT_REVIEW_ROUNDS) return false;
    const who = t.assigned_by && t.assigned_by.kind === "person" ? t.assigned_by : null;
    if (who && typeof o.gw.ask.request === "function") {
      try { await o.gw.ask.request(o.chain(), { title: `A person is needed on "${String(t.title).slice(0, 120)}"`, doer: who, output: { kind: "note" }, source: "flow_step", ...(t.record ? { record: t.record } : {}), note: `The agents went ${AGENT_REVIEW_ROUNDS} rounds of review without settling it. It is waiting for a person: open the task and decide.`, form: { fyi: true } }, { idem: `review-cap:${t.id}` }); }
      catch (err) { log(`agent wake ${o.space}: task ${t.id} reached ${AGENT_REVIEW_ROUNDS} review rounds but no person was told (${/** @type {Error} */ (err).message})`); }
    }
    return true;
  }
  /**
   * Changes were requested on a task whose doer is an agent: the doer is woken again, in a job of its own, with the reviewer's answer as information, so the loop does not stall after the first "changes".
   * @param {string} id
   */
  async function wakeForChanges(id) {
    try {
      const t = await o.gw.ask.get(o.chain(), id);
      if (!t || t.kernel || t.state !== "changes_requested" || !t.doer || t.doer.kind !== "agent" || typeof o.lend !== "function") return;
      if (await capped(t) || debounced(`${t.id}:doer`)) return;
      await o.lend(t);
      const rv = t.review && typeof t.review === "object" ? t.review : {};
      const info = { review: { by: rv.by ? { kind: rv.by.kind, id: rv.by.id } : undefined, type: rv.type, result: rv.result, checklist: Array.isArray(rv.checklist) ? rv.checklist : [], ...(typeof t.review_note === "string" && t.review_note ? { note: t.review_note } : {}) } };
      const approver = t.assigned_by && t.assigned_by.kind === "person" ? String(t.assigned_by.id) : typeof t.requested_for === "string" && t.requested_for ? t.requested_for : undefined;
      const project = typeof t.project === "string" && t.project ? t.project.split("/").pop() : undefined;
      const r = await o.callModule("agents.wake", { task: `${t.id}#changes:${rv.at || clock()}`, task_id: t.id, slot: "changes", agent: t.doer.id, title: t.title, info, ...(t.record ? { record: t.record } : {}), ...(project ? { project } : {}), ...(approver ? { approver } : {}) }, o.space);
      if (r && typeof r.thread === "string" && typeof o.bind === "function") await o.bind(t, r.thread).catch((/** @type {Error} */ err) => log(`agent wake ${o.space}: the lend of task ${t.id} was not held to its thread (${err.message})`));
    } catch (err) { log(`agent wake ${o.space}: task ${id} did not wake its doer for the changes (${/** @type {Error} */ (err).message})`); }
  }
  /**
   * An agent holding the reviewer slot (task in_review) or the approver slot (task needs_check, internal work) is woken once per hand-in with what it may do: review against the checklist, or decide. It holds the task for
   * that one job (a grant on this task only, ending with the round), never the doer's. A person in the slot is not woken; an agent that is the doer is not woken for its own work.
   * @param {string} id
   */
  async function wakeSlot(id) {
    /** @type {{ t: any, agent: string, slot: string, key: string } | null} the round being woken, so a failure can be told */
    let round = null;
    try {
      const t = await o.gw.ask.get(o.chain(), id);
      if (!t || t.kernel) return;
      const slot = t.state === "in_review" && t.reviewer && t.reviewer.kind === "agent" ? "reviewer" : t.state === "needs_check" && t.checker && t.checker.kind === "agent" && !t.stage && !(t.output && t.output.kind === "sent") ? "approver" : null;
      const agent = slot === "reviewer" ? t.reviewer : slot === "approver" ? t.checker : null;
      if (!slot || !agent || typeof o.lendSlot !== "function" || (t.doer && t.doer.kind === "agent" && t.doer.id === agent.id)) return;
      if (typeof t.created_at === "number" && clock() - t.created_at > MAX_AGE_MS) return;
      if (slot === "reviewer" && await capped(t)) return;
      if (debounced(`${t.id}:${slot}`)) return;
      const hand = t.payload && typeof t.payload.payload_hash === "string" ? t.payload.payload_hash.slice(0, 12) : String(t.updated_at || 0);
      const key = `${t.id}#${slot}:${hand}`;
      round = { t, agent: agent.id, slot, key };
      await o.lendSlot(t, agent.id, slot);
      const approver = t.assigned_by && t.assigned_by.kind === "person" ? String(t.assigned_by.id) : typeof t.requested_for === "string" && t.requested_for ? t.requested_for : undefined;
      const g = t.guides && typeof t.guides === "object" ? t.guides : null;
      const skills = g && g.skills && Array.isArray(g.skills[slot]) ? g.skills[slot] : [];
      const info = { ...(g && g.instructions && g.instructions[slot] ? { instructions: g.instructions[slot] } : {}), ...(skills.length ? { skills: skills.map((/** @type {any} */ k) => ({ name: k.name || k.id, checklist: k.checklist })) } : {}), ...(t.details !== undefined ? { details: t.details } : {}), ...(Array.isArray(t.outputs) && t.outputs.length ? { outputs: t.outputs } : {}) };
      const project = typeof t.project === "string" && t.project ? t.project.split("/").pop() : undefined;
      const r = await o.callModule("agents.wake", { task: key, task_id: t.id, slot, agent: agent.id, title: t.title, ...(Object.keys(info).length ? { info } : {}), ...(t.record ? { record: t.record } : {}), ...(project ? { project } : {}), ...(approver ? { approver } : {}) }, o.space);
      if (r && typeof r.thread === "string" && typeof o.bindSlot === "function") await o.bindSlot(t, agent.id, slot, r.thread).catch((/** @type {Error} */ err) => log(`agent wake ${o.space}: the lend of ${slot} on task ${t.id} was not held to its thread (${err.message})`));
    } catch (err) {
      log(`agent wake ${o.space}: task ${id} did not wake its reviewer or approver (${/** @type {Error} */ (err).message})`);
      if (typeof o.reclaimSlots === "function") await o.reclaimSlots(id).catch(() => null);
      if (round) await slotFailed(round, /** @type {Error} */ (err).message);
    }
  }
  /**
   * A reviewer or approver round that could not start is never left in silence. A task in review or waiting on a check cannot be marked stuck (the kernel takes stuck only from ready or working), so the
   * person who gave the task is handed a note with what happened and the next step, once per hand-in, the way the review cap hands a task to a person.
   * @param {{ t: any, agent: string, slot: string, key: string }} r @param {string} why
   */
  async function slotFailed(r, why) {
    const who = r.t.assigned_by && r.t.assigned_by.kind === "person" ? r.t.assigned_by : null;
    if (!who || typeof o.gw.ask.request !== "function") return;
    const said = sayWhy(r.agent, why);
    try { await o.gw.ask.request(o.chain(), { title: `${r.agent} could not ${r.slot === "reviewer" ? "review" : "check"} "${String(r.t.title).slice(0, 120)}"`, doer: who, output: { kind: "note" }, source: "flow_step", ...(r.t.record ? { record: r.t.record } : {}), note: `${said.reason} ${said.suggested_fix}`.slice(0, 400), form: { fyi: true } }, { idem: `slot-failed:${r.key}` }); }
    catch (err) { log(`agent wake ${o.space}: task ${r.t.id} could not wake its ${r.slot} and no person was told (${/** @type {Error} */ (err).message})`); }
  }

  async function onEvent(e) {
    if (e && ENDS.test(String(e.type)) && e.data && e.data.task && typeof e.data.task.id === "string") {
      const id = e.data.task.id;
      // the task is over: the use of it lent to the agent ends with it
      await o.callModule("agents.wake-done", { task: id, slots: true }, o.space).catch(() => null);
      if (typeof o.reclaim === "function") { try { await o.reclaim(id); } catch (err) { log(`agent wake ${o.space}: the lent use of task ${id} was not ended (${/** @type {Error} */ (err).message})`); } }
      // withdrawn at its due time: the agent's session for it ends too (a thread already stopped is the same answer). Every step is safe to repeat, so a replay of this event after a restart finishes what a crash left.
      if (e.type === "task.withdrawn") await stopThread(id);
      return;
    }
    if (e && SLOT_ENDS.test(String(e.type)) && e.data && e.data.task && typeof e.data.task.id === "string") {
      await o.callModule("agents.wake-done", { task: e.data.task.id, slots: true }, o.space).catch(() => null);
      if (typeof o.reclaimSlots === "function") await o.reclaimSlots(e.data.task.id).catch(() => null);
      if (e.type === "task.changes-requested") await wakeForChanges(e.data.task.id);
      return;
    }
    if (e && SLOT_TYPES.test(String(e.type)) && e.data && e.data.task && typeof e.data.task.id === "string") return wakeSlot(e.data.task.id);
    if (!e || !TYPES.test(String(e.type))) return;
    const id = e.data && e.data.task && typeof e.data.task.id === "string" ? e.data.task.id : null;
    if (!id) return;
    try {
      const t = await o.gw.ask.get(o.chain(), id);
      if (!wakes(t, clock())) return;
      // A named agent holds no standing right on a task, so it may start and hand in this one task and nothing else, for as long as the task lives
      if (typeof o.lend === "function") await o.lend(t);
      // a task an agent handed on has the person it began with (the kernel records it from the verified chain), so the woken agent works within that person's limits
      const approver = t.assigned_by && t.assigned_by.kind === "person" ? String(t.assigned_by.id) : typeof t.requested_for === "string" && t.requested_for ? t.requested_for : undefined;
      const instructions = [t.form && typeof t.form.instructions === "string" ? t.form.instructions : "", t.note || ""].filter(Boolean).join("\n\n");
      // What the person who asked added to the task (slot instructions, the doer's skills, details and outputs) goes to the agent as information, in its own section, never mixed into the instructions.
      const g = t.guides && typeof t.guides === "object" ? t.guides : null;
      const info = { ...(g && g.instructions && g.instructions.doer ? { instructions: g.instructions.doer } : {}), ...(g && g.skills && Array.isArray(g.skills.doer) && g.skills.doer.length ? { skills: g.skills.doer.map((/** @type {any} */ k) => ({ name: k.name || k.id, checklist: k.checklist })) } : {}), ...(t.details !== undefined ? { details: t.details } : {}), ...(Array.isArray(t.outputs) && t.outputs.length ? { outputs: t.outputs } : {}) };
      const project = typeof t.project === "string" && t.project ? t.project.split("/").pop() : undefined;
      const r = await o.callModule("agents.wake", { task: t.id, agent: t.doer.id, title: t.title, ...(instructions ? { instructions } : {}), ...(Object.keys(info).length ? { info } : {}), ...(t.record ? { record: t.record } : {}), ...(project ? { project } : {}), ...(approver ? { approver } : {}), ...(t.flow ? { flow: t.flow } : {}), ...(t.form && t.form.origin && typeof t.form.origin === "object" ? { origin: t.form.origin } : {}) }, o.space);
      // the lend of the task was made before the job existed; now that it has a thread, the lend is held to that thread (the old one ends in the same step the bound one begins)
      if (r && typeof r.thread === "string" && typeof o.bind === "function") { try { await o.bind(t, r.thread); } catch (err) { log(`agent wake ${o.space}: the lend of task ${t.id} was not held to its thread (${/** @type {Error} */ (err).message})`); } }
      if (r && typeof r.thread === "string" && !(t.form && t.form.thread === r.thread)) {
        try { await o.gw.ask.edit((o.editChain || o.chain)(t), t.id, { form: { ...(t.form || {}), thread: r.thread } }); }
        catch (err) { log(`agent wake ${o.space}: task ${t.id} woke ${t.doer.id} in ${r.thread} but the thread was not written on it (${/** @type {Error} */ (err).message})`); }
      }
    } catch (err) {
      log(`agent wake ${o.space}: task ${id} did not wake its agent (${/** @type {Error} */ (err).message})`);
      await drop(id);   // no job runs: nothing stays lent
      try { const t = await o.gw.ask.get(o.chain(), id); if (wakes(t, clock())) await stick(t, /** @type {Error} */ (err).message); } catch { /* the task could not be read: the log line above is all there is */ }
    }
  }
  return Object.assign(onEvent, { threadEnded });
}

/** The words a person reads when an agent's job failed: what happened, cut short and free of anything that looks like a secret, and the next step. @param {string} agent @param {string} why */
export function sayWhy(agent, why) {
  const clean = String(why || "").replace(/[A-Za-z0-9_\-./+=]{24,}/g, "[removed]").replace(/\s+/g, " ").trim().slice(0, 160);
  const auth = AUTH.test(clean);
  if (auth) return { reason: `${agent}'s AI sign-in has expired.${clean ? ` (${clean})` : ""}`.slice(0, 400), suggested_fix: `Reconnect the AI account for ${agent} in Settings, then retry.` };
  return { reason: `${agent} stopped before it finished this task.${clean ? ` (${clean})` : ""}`.slice(0, 400), suggested_fix: `Open ${agent}'s thread to see what happened, then retry.` };
}

/** Whether a task is one an agent is to start on now: ready and an agent's, whether a Flow, a request or a person's to-do gave it (a person's own to-do has a person as its doer and never wakes anything), and not a Flow's note that only tells the agent about someone else's task. */
export function wakes(/** @type {any} */ t, /** @type {number} */ now) {
  if (!t || t.kernel || t.state !== "ready" || !t.doer || t.doer.kind !== "agent") return false;
  if (t.form && t.form.fyi === true) return false;   // a follower's or an approver's note (kernel/flows/runner.js #task) tells the agent about a task; it is not the task
  if (typeof t.created_at === "number" && now - t.created_at > MAX_AGE_MS) return false;
  return true;
}
