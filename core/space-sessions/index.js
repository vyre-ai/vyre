// core/space-sessions/index.js: the session engine for a Space. One Space per session; a checkpoint state that carries taint and permissions;
// resume from a checkpoint; Continue in another space; the hours and spend budgets. It owns no files, keys or placement:
//   - the runner (core/runner) owns the sandbox, the encrypted workspace, sync to and from the member's computer, the key lease and where a
//     session runs. We call its `decide` for placement and give it the state to store with each checkpoint (`sessionState`).
//   - the vault owns the key leases (kernel/seal/leases.js), the grants store owns the two-grant check (gateway.grants.offers).
// A factory over ports, so it runs under a fake kernel today and under the real gateway later.
import { createContinue } from "./continue.js";
import { createSessionBudget } from "./budget.js";
import { snapshot, restore } from "./state.js";
import { mintUuid } from "../../kernel/core/ids.js";

export { createContinue, createSessionBudget, snapshot, restore };

/**
 * @param {{ space: string, authorize(i: { chain: any, action: string, resource: string }): Promise<{ effect: string }>,
 *   runner: { decide(o: { pinnedToServer?: boolean }): Promise<{ where: string, reason: string }> | { where: string, reason: string } },
 *   sync?: { getCheckpoint(session: string): Promise<{ turn: number, seq: number, state: any } | null> },
 *   budget?: any, clock?: () => number, sessions?: Map<string, any> }} cfg
 */
export function createSpaceSessions(cfg) {
  const rows = cfg.sessions || new Map();
  const clock = cfg.clock || Date.now;
  const urn = (/** @type {string} */ id) => `vyre://${cfg.space}/session/${id}`;
  const mine = (/** @type {any} */ chain) => chain && chain.space === cfg.space;
  const ok = async (/** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ id) => mine(chain) && (await cfg.authorize({ chain, action, resource: urn(id) })).effect === "allow";
  const notFound = () => Object.assign(new Error("not found (it may not exist, or you may not be allowed to see it: ask the owner or an admin)"), { code: "not_found" });

  return Object.freeze({
    /** @param {{ chain: any, person: any, title?: string, first_context?: string, from?: any, pinnedToServer?: boolean }} q */
    async create(q) {
      if (!mine(q.chain)) throw notFound();
      const id = mintUuid(clock());
      if (!(await ok(q.chain, "sessions.create", id))) throw notFound();
      const place = await cfg.runner.decide({ pinnedToServer: q.pinnedToServer });
      const s = Object.freeze({ id, space: cfg.space, owner: q.person, title: q.title || "Session", where: place.where, why: place.reason, first_context: q.first_context, from: q.from, created_at: clock() });
      // session_hours: reserved now at the longest the session may run; refuses (and tells the person) when it does not fit. ai_spend is the door's.
      if (cfg.budget) await cfg.budget.start({ chain: q.chain, session: id, person: q.person.id });
      rows.set(id, s);
      return s;
    },
    async get(/** @type {any} */ chain, /** @type {string} */ id) { const s = rows.get(id); return s && s.space === cfg.space && (await ok(chain, "sessions.read", id)) ? s : null; },
    async list(/** @type {any} */ chain) { const out = []; for (const s of rows.values()) if (await ok(chain, "sessions.read", s.id)) out.push(s); return out; },
    /** The session is over: settle the hours it ran. @param {any} chain @param {string} id */
    async end(chain, id) { const s = rows.get(id); if (!s || !(await ok(chain, "sessions.read", id))) return false; return cfg.budget ? cfg.budget.end({ chain, session: id }) : true; },

    /**
     * The state the runner stores with each checkpoint (hand this to the runner as `sessionState`). @param {any} chain @param {string} id
     * @param {{ labels: any, permissions: { action: string, resource: string }[], tasks?: string[], meta?: any }} live
     */
    async stateFor(chain, id, live) {
      if (!(await ok(chain, "sessions.read", id))) throw notFound();
      return snapshot({ space: cfg.space, session: id, labels: live.labels, permissions: live.permissions, tasks: live.tasks, meta: live.meta });
    },
    /** Resume a session from the Space's last acknowledged checkpoint: its taint and the permissions this chain still holds. The runner moves the files. */
    async resume(/** @type {any} */ chain, /** @type {string} */ id) {
      if (!(await ok(chain, "sessions.read", id)) || !cfg.sync) throw notFound();
      const cp = await cfg.sync.getCheckpoint(id);
      if (!cp) throw Object.assign(new Error("no checkpoint to resume from"), { code: "not_found" });
      const r = await restore({ chain, space: cfg.space, session: id, state: cp.state, authorize: cfg.authorize });
      return { turn: cp.turn, seq: cp.seq, ...r };
    },
  });
}
