// @ts-check
// Task escalation (SPEC-0.3.0 part 3). A task may say `escalate_after` (milliseconds) and `escalate_to` (an actor of the Space) when it is made; the kernel stores both and reads neither. The planner's
// one scheduler reads them: this file is a wake hook on it (scheduler.hook), so there is no second timer. When an unfinished task has waited `escalate_after` since it was made, the planner puts a
// to-do in front of `escalate_to` ("<title> is late"), once, and says so with `planner.escalated`. The late task stays where it is and stays its doer's.

/** The states of a task someone is still on: waiting on other tasks is not late, and done or skipped is over. */
const OPEN = ["ready", "working", "stuck", "needs_check"];
const KEY = "task-escalations";

/**
 * @param {{ K: any, st: any, scheduler: any, now: () => number, emit: (type: string, payload: any) => void, log: (m: string) => void }} d
 */
export function taskEscalation({ K, st, scheduler, now, emit, log }) {
  /** @type {Map<string, number>} task id to the moment it falls due, for tasks not yet escalated */
  let pending = new Map();
  /** @type {Promise<void> | null} */ let reading = null;
  let again = false;
  const done = () => /** @type {Record<string, number>} */ (st.state.get(KEY) || {});

  /** Read the open tasks again: which have an escalation set, which are already escalated. Forgets the escalated ones that are over. */
  const refresh = () => (reading ? (again = true, reading) : (reading = (async () => {
    try {
      const tasks = /** @type {any[]} */ (await K.tasks.list(K.serviceChain(), { state: OPEN }));
      const have = done(), next = new Map(), still = {};
      for (const t of tasks) {
        if (!(t.escalate_after > 0) || !t.escalate_to) continue;
        if (have[t.id]) { still[t.id] = have[t.id]; continue; }
        next.set(t.id, Number(t.created_at) + Number(t.escalate_after));
      }
      pending = next;
      if (Object.keys(still).length !== Object.keys(have).length) st.state.set(KEY, still);
    } catch (e) { log(`planner: tasks were not read for escalation (${/** @type {Error} */ (e).message})`); }
  })()).finally(() => { reading = null; if (again) { again = false; void refresh().then(() => scheduler.arm()); } }));

  /** Put the late task in front of the person it escalates to, once. @param {string} id */
  async function escalate(id) {
    const t = await K.tasks.get(K.serviceChain(), id).catch(() => null);
    if (!t || !OPEN.includes(t.state) || !t.escalate_to) return;
    st.state.set(KEY, { ...done(), [id]: now() });
    if (t.escalate_to.id === t.doer.id) return;
    const late = Math.max(1, Math.round((now() - Number(t.created_at)) / 60_000));
    try {
      await K.tasks.request(K.serviceChain(), { title: `Late: ${t.title}`.slice(0, 200), doer: t.escalate_to, parent: t.id, source: "manual", output: { kind: "note" },
        note: `${t.doer.id} has had this ${late} minute${late === 1 ? "" : "s"} and it is not done.` }, { idem: `escalate:${id}` });
      emit("planner.escalated", { task: id, title: t.title, doer: t.doer.id, to: t.escalate_to.id, after_ms: t.escalate_after });
    } catch (e) { log(`planner: task ${id} was late but could not be escalated (${/** @type {Error} */ (e).message})`); }
  }

  scheduler.hook({
    next: (/** @type {number} */ _now) => { let at = null; for (const v of pending.values()) if (at == null || v < at) at = v; return at; },
    run: (/** @type {number} */ t) => {
      const due = [...pending].filter(([, at]) => at <= t).map(([id]) => id);
      for (const id of due) pending.delete(id);
      void Promise.all(due.map(escalate)).then(refresh).then(() => scheduler.arm());
    },
  });
  return { refresh: () => refresh().then(() => scheduler.arm()) };
}
