// core/daemon/stage-deadlines: a Kit stage task an agent was given is withdrawn when its due offset passes (ADR 0054), the same path as an agent step's due time. The planner escalates a late
// task to the stage owner (core/planner/escalate.js) and never ends it; ending it is the Flows service's act, so this runs in the Flows host, on the host's own timer: `next()` is folded into the
// timer's next wake and `tick()` runs after each Flows tick. It reads the open tasks of stages from the kernel (nothing is held here that a restart would lose) and withdraws the ones whose agent doer
// is past `due`. A required stage task that is withdrawn stays required, so the stage's gate stays closed until a person decides (kernel/flows/stages.js reads only `done` for required tasks).
//
//   const sd = createStageDeadlines({ gw, chain, withdrawChain, now, log });

const OPEN = ["ready", "working", "stuck", "needs_check"];

/**
 * @param {{ gw: any, chain: () => any, withdrawChain: (task: any) => any, now: () => number, log: (m: string) => void }} o
 */
export function createStageDeadlines(o) {
  /** @type {number | null} */ let soonest = null;
  /** The open stage tasks an agent holds that have a due time: [task, due]. @returns {Promise<any[]>} */
  async function dueTasks() {
    const rows = /** @type {any[]} */ (await o.gw.ask.list(o.chain(), { state: OPEN }));
    return rows.filter(t => t && !t.kernel && t.stage && t.record && typeof t.due === "number" && t.doer && t.doer.kind === "agent" && !(t.form && t.form.fyi === true));
  }
  /** Withdraw what is past due; remember when the next one falls due. Safe to repeat: a task already ended refuses and is left alone. */
  async function tick() {
    try {
      const now = o.now();
      soonest = null;
      for (const t of await dueTasks()) {
        if (t.due > now) { if (soonest === null || t.due < soonest) soonest = t.due; continue; }
        try { await o.gw.ask.withdraw(o.withdrawChain(t), t.id, { reason: "the due time of this stage task passed" }); }
        catch (e) { if (!e || /** @type {any} */ (e).code !== "bad_state") o.log(`stage deadlines: task ${t.id} is past due and was not withdrawn (${e && /** @type {Error} */ (e).message})`); }
      }
    } catch (e) { o.log(`stage deadlines: the open tasks were not read (${e && /** @type {Error} */ (e).message})`); }
  }
  return { tick, next: () => soonest };
}
