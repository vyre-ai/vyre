// core/daemon/agent-wake: a task given to an agent wakes it. A Flow's agent step (kernel/flows/runner.js #task) and tasks.request both leave a ready task whose doer is an agent, and nothing started
// the agent's work. This watches the kernel log for such a task and asks the agents module for one job thread (agents.wake, once per task and agent, claimed in its own table so a restart or a repeated
// event starts nothing twice). The job's thread is written on the task as form.thread (a kernel edit, which only the task's doer, a person or whoever assigned it may make: `editChain` gives the assigner's), so the task links to the work. The agent starts and submits the task itself: nothing here marks it done.
//
//   const onEvent = createAgentWake({ space, gw, chain, editChain, callModule, log });
//   k.log.subscribe("agent-wake", {}, onEvent);

/** A task older than this is never woken by a replayed event (a restart reading the log from the start must not wake what was left long ago). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TYPES = /^task\.(created|readied|unblocked)$/;

/**
 * @param {{ space: string, gw: any, chain: () => any, editChain?: (task: any) => any, callModule: (tool: string, input: any, space?: string) => Promise<any>, log?: (m: string) => void, clock?: () => number }} o
 * @returns {(e: any) => Promise<void>}
 */
export function createAgentWake(o) {
  const log = o.log || (() => {});
  const clock = o.clock || Date.now;
  return async function onEvent(e) {
    if (!e || !TYPES.test(String(e.type))) return;
    const id = e.data && e.data.task && typeof e.data.task.id === "string" ? e.data.task.id : null;
    if (!id) return;
    try {
      const t = await o.gw.ask.get(o.chain(), id);
      if (!wakes(t, clock())) return;
      const approver = t.assigned_by && t.assigned_by.kind === "person" ? String(t.assigned_by.id) : undefined;
      const instructions = [t.form && typeof t.form.instructions === "string" ? t.form.instructions : "", t.note || ""].filter(Boolean).join("\n\n");
      const project = typeof t.project === "string" && t.project ? t.project.split("/").pop() : undefined;
      const r = await o.callModule("agents.wake", { task: t.id, agent: t.doer.id, title: t.title, ...(instructions ? { instructions } : {}), ...(t.record ? { record: t.record } : {}), ...(project ? { project } : {}), ...(approver ? { approver } : {}), ...(t.flow ? { flow: t.flow } : {}), ...(t.form && t.form.origin && typeof t.form.origin === "object" ? { origin: t.form.origin } : {}) }, o.space);
      if (r && typeof r.thread === "string" && !(t.form && t.form.thread === r.thread)) {
        try { await o.gw.ask.edit((o.editChain || o.chain)(t), t.id, { form: { ...(t.form || {}), thread: r.thread } }); }
        catch (err) { log(`agent wake ${o.space}: task ${t.id} woke ${t.doer.id} in ${r.thread} but the thread was not written on it (${/** @type {Error} */ (err).message})`); }
      }
    } catch (err) { log(`agent wake ${o.space}: task ${id} did not wake its agent (${/** @type {Error} */ (err).message})`); }
  };
}

/** Whether a task is one an agent is to start on now: ready, an agent's, made by a Flow or by a request (not a person's own to-do), and not a Flow's note that only tells the agent about someone else's task. */
export function wakes(/** @type {any} */ t, /** @type {number} */ now) {
  if (!t || t.kernel || t.state !== "ready" || !t.doer || t.doer.kind !== "agent") return false;
  if (t.source === "manual") return false;
  if (t.form && t.form.fyi === true) return false;   // a follower's or an approver's note (kernel/flows/runner.js #task) tells the agent about a task; it is not the task
  if (typeof t.created_at === "number" && now - t.created_at > MAX_AGE_MS) return false;
  return true;
}
