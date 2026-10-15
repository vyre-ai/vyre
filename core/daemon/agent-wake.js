// core/daemon/agent-wake: a task given to an agent wakes it. A Flow's agent step (kernel/flows/runner.js #task) and tasks.request both leave a ready task whose doer is an agent, and nothing started
// the agent's work. This watches the kernel log for such a task and asks the agents module for one job thread (agents.wake, once per task and agent, claimed in its own table so a restart or a repeated
// event starts nothing twice). The job's thread is written on the task as form.thread (a kernel edit, which only the task's doer, a person or whoever assigned it may make: `editChain` gives the assigner's), so the task links to the work. The agent starts and submits the task itself: nothing here marks it done.
//
//   const onEvent = createAgentWake({ space, gw, chain, editChain, callModule, log });
//   k.log.subscribe("agent-wake", {}, onEvent);

/** A task older than this is never woken by a replayed event (a restart reading the log from the start must not wake what was left long ago). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TYPES = /^task\.(created|readied|unblocked)$/;
const AUTH = /oauth|expired|sign.?in|log.?in|authenticat|credential|401|unauthori[sz]ed|api key/i;
const ENDS = /^task\.(completed|approved|rejected|skipped|voided|withdrawn)$/;

/**
 * @param {{ space: string, gw: any, chain: () => any, editChain?: (task: any) => any, lend?: (task: any) => Promise<any>, reclaim?: (taskId: string) => Promise<any>, agentChain?: (task: any) => any, callModule: (tool: string, input: any, space?: string) => Promise<any>, log?: (m: string) => void, clock?: () => number }} o
 * @returns {((e: any) => Promise<void>) & { threadEnded: (thread: string, reason?: string) => Promise<void> }}
 */
export function createAgentWake(o) {
  const log = o.log || (() => {});
  const clock = o.clock || Date.now;
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

  /** A wake job's thread ended (finished or stopped): a task still open that the agent has not handed in, flagged or moved is stuck. @param {string} thread @param {string} [reason] */
  async function threadEnded(thread, reason) {
    try {
      const w = await o.callModule("agents.woken", { thread }, o.space);
      if (!w || !w.task) return;
      const t = await o.gw.ask.get(o.chain(), w.task);
      if (!t || !["ready", "working"].includes(t.state)) return;
      // the stop reason is often bare; what the thread itself said last (an expired sign-in says so there) is the better words
      let said = reason || "";
      if (!AUTH.test(said)) { try { const g = await o.callModule("threads.get", { thread, limit: 1 }, o.space); const th = g && (g.thread || g.data && g.data.thread); const line = th && (th.last_line || th.stopped_reason); if (line) said = `${said} ${String(line)}`.trim(); } catch { /* the thread could not be read: the reason given stands */ } }
      await stick(t, said);
    } catch (err) { log(`agent wake ${o.space}: thread ${thread} ended and its task was not checked (${/** @type {Error} */ (err).message})`); }
  }

  /** End the job thread an agent was woken in for a task (the thread is written on the task as form.thread). @param {string} taskId */
  async function stopThread(taskId) {
    try {
      const t = await o.gw.ask.get(o.chain(), taskId);
      const thread = t && t.form && typeof t.form.thread === "string" ? t.form.thread : null;
      if (thread) {
        await o.callModule("threads.stop", { thread }, o.space);
        // what the session held for a yes meanwhile is cancelled, with the reason in plain words in the approvals queue
        await o.callModule("gate.withdraw-thread", { thread, why: "The task's due time passed, so this was cancelled and nothing was sent." }, o.space);
        await o.callModule("approvals.withdraw-thread", { thread, why: "The task's due time passed, so this was cancelled and nothing was sent." }, o.space);
      }
    } catch (err) { log(`agent wake ${o.space}: the session for withdrawn task ${taskId} was not ended (${/** @type {Error} */ (err).message})`); }
  }

  async function onEvent(e) {
    if (e && ENDS.test(String(e.type)) && e.data && e.data.task && typeof e.data.task.id === "string") {
      const id = e.data.task.id;
      // the task is over: the use of it lent to the agent ends with it
      if (typeof o.reclaim === "function") { try { await o.reclaim(id); } catch (err) { log(`agent wake ${o.space}: the lent use of task ${id} was not ended (${/** @type {Error} */ (err).message})`); } }
      // withdrawn at its due time: the agent's session for it ends too (a thread already stopped is the same answer). Every step is safe to repeat, so a replay of this event after a restart finishes what a crash left.
      if (e.type === "task.withdrawn") await stopThread(id);
      return;
    }
    if (!e || !TYPES.test(String(e.type))) return;
    const id = e.data && e.data.task && typeof e.data.task.id === "string" ? e.data.task.id : null;
    if (!id) return;
    try {
      const t = await o.gw.ask.get(o.chain(), id);
      if (!wakes(t, clock())) return;
      // A named agent holds no standing right on a task, so it may start and hand in this one task and nothing else, for as long as the task lives
      if (typeof o.lend === "function") await o.lend(t);
      const approver = t.assigned_by && t.assigned_by.kind === "person" ? String(t.assigned_by.id) : undefined;
      const instructions = [t.form && typeof t.form.instructions === "string" ? t.form.instructions : "", t.note || ""].filter(Boolean).join("\n\n");
      const project = typeof t.project === "string" && t.project ? t.project.split("/").pop() : undefined;
      const r = await o.callModule("agents.wake", { task: t.id, agent: t.doer.id, title: t.title, ...(instructions ? { instructions } : {}), ...(t.record ? { record: t.record } : {}), ...(project ? { project } : {}), ...(approver ? { approver } : {}), ...(t.flow ? { flow: t.flow } : {}), ...(t.form && t.form.origin && typeof t.form.origin === "object" ? { origin: t.form.origin } : {}) }, o.space);
      if (r && typeof r.thread === "string" && !(t.form && t.form.thread === r.thread)) {
        try { await o.gw.ask.edit((o.editChain || o.chain)(t), t.id, { form: { ...(t.form || {}), thread: r.thread } }); }
        catch (err) { log(`agent wake ${o.space}: task ${t.id} woke ${t.doer.id} in ${r.thread} but the thread was not written on it (${/** @type {Error} */ (err).message})`); }
      }
    } catch (err) {
      log(`agent wake ${o.space}: task ${id} did not wake its agent (${/** @type {Error} */ (err).message})`);
      try { const t = await o.gw.ask.get(o.chain(), id); if (wakes(t, clock())) await stick(t, /** @type {Error} */ (err).message); } catch { /* the task could not be read: the log line above is all there is */ }
    }
  }
  return Object.assign(onEvent, { threadEnded });
}

/** The words a person reads when an agent's job failed: what happened, cut short and free of anything that looks like a secret, and the next step. @param {string} agent @param {string} why */
export function sayWhy(agent, why) {
  const clean = String(why || "").replace(/[A-Za-z0-9_\-.]{24,}/g, "[removed]").replace(/\s+/g, " ").trim().slice(0, 160);
  const auth = AUTH.test(clean);
  if (auth) return { reason: `${agent}'s AI sign-in has expired.${clean ? ` (${clean})` : ""}`.slice(0, 400), suggested_fix: `Reconnect the AI account for ${agent} in Settings, then retry.` };
  return { reason: `${agent} stopped before it finished this task.${clean ? ` (${clean})` : ""}`.slice(0, 400), suggested_fix: `Open ${agent}'s thread to see what happened, then retry.` };
}

/** Whether a task is one an agent is to start on now: ready, an agent's, made by a Flow or by a request (not a person's own to-do), and not a Flow's note that only tells the agent about someone else's task. */
export function wakes(/** @type {any} */ t, /** @type {number} */ now) {
  if (!t || t.kernel || t.state !== "ready" || !t.doer || t.doer.kind !== "agent") return false;
  if (t.source === "manual") return false;
  if (t.form && t.form.fyi === true) return false;   // a follower's or an approver's note (kernel/flows/runner.js #task) tells the agent about a task; it is not the task
  if (typeof t.created_at === "number" && now - t.created_at > MAX_AGE_MS) return false;
  return true;
}
