// core/space-sessions/budget.js: the two meters a session spends (kernel/core/limits.js): `session_hours`, reserved when a session starts at the
// longest it may run and settled with the hours it ran, and `ai_spend`, which the inference door reserves and settles on every model call
// (limits.doorBudget). When either runs out the session stops with `budget_exhausted` and the person gets a task, never a silent stop.
import { KernelError } from "../../kernel/core/errors.js";

const isBudget = (/** @type {any} */ e) => Boolean(e && (e.code === "budget_exhausted" || (e.code === "budget" && e.refusal && e.refusal.meter) || (e.refusal && e.refusal.code === "budget")));

/**
 * @param {{ space: string, limits: { sessionStart(chain: any, s: any): string, sessionEnd(chain: any, id: string, hours: number): any },
 *   ask: { request(chain: any, spec: any): Promise<any> }, limitsOf: (person: string) => { limit_hours: number, max_hours: number },
 *   clock?: () => number, stop?: (session: string, reason: string) => any }} cfg
 *   ask: the kernel's tasks (kernel.tasks); limitsOf: the person's session-hours limit and the longest one session may run (a grant's meter condition).
 */
export function createSessionBudget(cfg) {
  const clock = cfg.clock || Date.now;
  /** @type {Map<string, { id: string, person: string, at: number, stopped?: string }>} */ const open = new Map();

  /** The person is told once per session and meter, in plain words, with the task they can act on. */
  async function tell(/** @type {any} */ chain, /** @type {string} */ session, /** @type {string} */ person, /** @type {string} */ meter) {
    const s = open.get(session);
    if (s && s.stopped === meter) return;
    if (s) s.stopped = meter;
    const what = meter === "ai_spend" ? "its AI spending limit" : "its hours limit";
    await cfg.ask.request(chain, {
      title: "A session stopped: it reached its limit", record: `vyre://${cfg.space}/session/${session}`,
      doer: { kind: "person", id: person, space: cfg.space }, output: { kind: "decision" }, source: "manual",
      note: `The session ran into ${what}. Raise the limit to carry on, or leave it stopped.`,
    });
  }

  return Object.freeze({
    /** Start metering a session. Refuses (and tells the person) when the hours do not fit. @param {{ chain: any, session: string, person: string }} q */
    async start(q) {
      const lim = cfg.limitsOf(q.person);
      let id;
      try { id = cfg.limits.sessionStart(q.chain, { person: q.person, limit_hours: lim.limit_hours, max_hours: lim.max_hours }); }
      catch (e) { if (isBudget(e)) { open.set(q.session, { id: "", person: q.person, at: clock() }); await tell(q.chain, q.session, q.person, "session_hours"); } throw e; }
      open.set(q.session, { id, person: q.person, at: clock() });
    },
    /** Settle the hours the session actually ran. Safe to call twice. @param {{ chain: any, session: string }} q */
    async end(q) {
      const s = open.get(q.session);
      if (!s || !s.id) { open.delete(q.session); return false; }
      open.delete(q.session);
      return cfg.limits.sessionEnd(q.chain, s.id, (clock() - s.at) / 3_600_000);
    },
    /**
     * Run one turn. A budget refusal from the door (ai_spend) or the kernel stops the session, tells the person, and rethrows as `budget_exhausted`.
     * @template T @param {{ chain: any, session: string, person: string }} q @param {() => Promise<T>} turn @returns {Promise<T>}
     */
    async turn(q, turn) {
      try { return await turn(); }
      catch (e) {
        if (!isBudget(e)) throw e;
        const meter = (e.refusal && e.refusal.meter) || "ai_spend";
        await tell(q.chain, q.session, q.person, meter);
        if (cfg.stop) await cfg.stop(q.session, "budget_exhausted");
        await this.end({ chain: q.chain, session: q.session });
        throw new KernelError("budget_exhausted", `the ${meter} budget is used up`);
      }
    },
  });
}
