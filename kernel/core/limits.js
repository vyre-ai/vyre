// kernel/core/limits.js: the counters behind a grant's `once`, `rate` and `budget` conditions (contract 6.2; K1 item 8c). `authorize` is pure: it only
// says what a grant carries, as obligations. This is what counts them, in the gateway, atomically (one synchronous step, no await between the check
// and the mark), and writes one event per use. `once` is consumed on the act that carries it; `rate` is a sliding window per grant and actor; a
// `meter` is reserved before the act and settled after, so a call that fails frees its reservation and a call that spends more than it reserved is
// charged what it spent. The two meters the kernel keeps are `ai_spend` (the model door) and `session_hours`; any grant may name another.
// Durable parts (once, settled meters and the acts inside a rate window) are replayed from the log by `rebuild`, so a restart resets none of them.
import { KernelError } from "./errors.js";
import { mintUuid } from "./ids.js";

const urn = (/** @type {string} */ space, /** @type {string} */ type, /** @type {string} */ id) => `vyre://${space}/${type}/${id}`;

/** @param {{ space: string, log: any, clock?: () => number }} cfg */
export function createLimits(cfg) {
  const clock = cfg.clock || Date.now;
  /** @type {Set<string>} */ const onceUsed = new Set();
  /** @type {Map<string, number[]>} */ const windows = new Map();
  /** @type {Map<string, { settled: number, reserved: number }>} */ const meters = new Map();
  /** @type {Map<string, { key: string, amount: number, meter: string, grant: string | null, open: boolean }>} */ const reservations = new Map();
  const slot = (/** @type {string} */ key) => { if (!meters.has(key)) meters.set(key, { settled: 0, reserved: 0 }); return /** @type {{ settled: number, reserved: number }} */ (meters.get(key)); };
  const actorOf = (/** @type {any} */ chain) => { const a = chain.hops[chain.hops.length - 1].actor; return `${a.kind}:${a.id}`; };
  const note = (/** @type {any} */ chain, /** @type {string} */ type, /** @type {string} */ subject, /** @type {any} */ data) => {
    try { cfg.log.append(chain, { type, sv: 1, subject, data, vis: "actor", red: "internal" }); } catch { /* a counter never fails an act for want of a note */ }
  };

  const api = {
    /** `once`: the grant may carry one act. Taken before the act runs, so two concurrent calls cannot both pass. */
    useOnce(/** @type {any} */ chain, /** @type {string} */ grant) {
      if (onceUsed.has(grant)) throw new KernelError("used_up", "that access was for one use and has been used");
      onceUsed.add(grant);
      note(chain, "grant.used", urn(cfg.space, "grant", grant), { grant });
    },

    /** `rate`: at most `n` acts per `per_seconds` for this actor on this grant. */
    rate(/** @type {any} */ chain, /** @type {string} */ grant, /** @type {{ n: number, per_seconds: number }} */ r) {
      const k = `${grant}|${actorOf(chain)}`, now = clock(), from = now - r.per_seconds * 1000;
      const w = (windows.get(k) || []).filter(t => t > from);
      if (w.length >= r.n) { windows.set(k, w); throw new KernelError("rate_limited", "too many times in a short while; try again shortly"); }
      w.push(now); windows.set(k, w);
      // One event per counted act on a rate-limited grant, so a restart cannot reset the window.
      note(chain, "rate.used", urn(cfg.space, "grant", grant), { grant, actor: actorOf(chain), at: now, per_seconds: r.per_seconds });
    },

    /**
     * Reserve `amount` of `meter` against `limit` for `key` (a grant id, or a person for a Space-wide meter). Returns a reservation id.
     * @param {any} chain @param {{ key: string, meter: string, amount: number, limit: number, grant?: string }} r
     */
    reserve(chain, r) {
      if (!(r.amount >= 0) || !(r.limit >= 0)) throw new KernelError("bad_input", "a meter needs an amount and a limit");
      const m = slot(`${r.key}|${r.meter}`);
      if (m.settled + m.reserved + r.amount > r.limit) throw new KernelError("budget_exhausted", `the ${r.meter} budget is used up`);
      m.reserved += r.amount;
      const id = `rsv_${mintUuid(clock())}`;
      reservations.set(id, { key: `${r.key}|${r.meter}`, amount: r.amount, meter: r.meter, grant: r.grant ?? null, open: true });
      note(chain, "meter.reserved", urn(cfg.space, "meter", r.meter), { id, meter: r.meter, amount: r.amount, key: r.key, ...(r.grant ? { grant: r.grant } : {}) });
      return id;
    },

    /** Settle a reservation for what was actually spent (it may be less, or more: the overrun is charged). Idempotent. */
    settle(/** @type {any} */ chain, /** @type {string} */ id, /** @type {number} */ actual) {
      const r = reservations.get(id);
      if (!r || !r.open) return false;
      r.open = false;
      const m = slot(r.key);
      m.reserved -= r.amount; m.settled += Math.max(0, actual);
      note(chain, "meter.settled", urn(cfg.space, "meter", r.meter), { id, meter: r.meter, reserved: r.amount, actual: Math.max(0, actual), key: r.key.split("|")[0], ...(r.grant ? { grant: r.grant } : {}) });
      return true;
    },
    /** Give a reservation back (the act failed before it spent anything). */
    release(/** @type {any} */ chain, /** @type {string} */ id) { return api.settle(chain, id, 0); },
    used: (/** @type {string} */ key, /** @type {string} */ meter) => { const m = meters.get(`${key}|${meter}`); return m ? { settled: m.settled, reserved: m.reserved } : { settled: 0, reserved: 0 }; },

    /**
     * What the gateway calls on an allowed act: count every `once`, `rate` and `meter` obligation the decision carries. A meter on a grant is one
     * unit per act, reserved and settled together (an act has no cost beyond being done); the model door and sessions reserve and settle themselves.
     * @param {any} chain @param {{ obligations: readonly any[] }} d
     */
    enforce(chain, d) {
      for (const o of d.obligations || []) {
        if (o.type === "once") api.useOnce(chain, o.grant);
        else if (o.type === "rate" && o.grant) api.rate(chain, o.grant, o);
        else if (o.type === "meter" && o.grant) { const id = api.reserve(chain, { key: o.grant, meter: o.meter, amount: o.amount ?? 1, limit: o.limit, grant: o.grant }); api.settle(chain, id, o.amount ?? 1); }
      }
    },

    /**
     * The model door's budget (`createDoor({ budget })`): `ai_spend`, in micro-dollars, per person per Space. `limitOf(chain)` says the limit
     * (undefined means none is set, and nothing is counted); `estimate(input)` the cost to hold, `cost(input, usage)` the cost actually spent.
     * @param {{ limitOf: (chain: any) => number | undefined, estimate?: (input: any) => number, cost?: (input: any, usage: any) => number }} o
     */
    doorBudget(o) {
      const open = new Map();
      const keyOf = (/** @type {any} */ chain) => { const p = chain.hops.find((/** @type {any} */ h) => h.actor.kind === "person"); return p ? p.actor.id : actorOf(chain); };
      return {
        reserve(/** @type {any} */ input) {
          const limit = o.limitOf(input.chain);
          if (limit === undefined) return null;
          try { const amount = o.estimate ? o.estimate(input) : 0; open.set(input, { id: api.reserve(input.chain, { key: keyOf(input.chain), meter: "ai_spend", amount, limit }), amount }); } catch (e) { return /** @type {any} */ (e).code === "budget_exhausted" ? "ai_spend" : "ai_spend"; }
          return null;
        },
        /** The call failed or was refused after the reservation: give it back, spend nothing. */
        release(/** @type {any} */ input) { const r = open.get(input); if (!r) return; open.delete(input); api.release(input.chain, r.id); },
        settle(/** @type {any} */ input, /** @type {any} */ usage) {
          const r = open.get(input); if (!r) return;
          open.delete(input);
          // A provider that reports no usage at all is charged what was reserved: unmetered spend is never free (D-1).
          const reported = usage === undefined || usage === null ? null : o.cost ? o.cost(input, usage) : Number(usage.cost_micro);
          api.settle(input.chain, r.id, Number.isFinite(reported) && reported !== null ? reported : r.amount);
        },
      };
    },

    /** Session hours: reserve the longest a session may run when it starts, settle with the hours it did run when it ends. */
    sessionStart(/** @type {any} */ chain, /** @type {{ person: string, limit_hours: number, max_hours: number }} */ s) { return api.reserve(chain, { key: s.person, meter: "session_hours", amount: s.max_hours, limit: s.limit_hours }); },
    sessionEnd(/** @type {any} */ chain, /** @type {string} */ id, /** @type {number} */ hours) { return api.settle(chain, id, hours); },

    /** Replay the durable counters after a restart: `once` marks and settled meter totals. */
    rebuild() {
      onceUsed.clear(); meters.clear(); reservations.clear(); windows.clear();
      for (const e of cfg.log.read({})) {
        if (e.type === "grant.used" && e.data && e.data.grant) onceUsed.add(e.data.grant);
        else if (e.type === "meter.settled" && e.data) slot(`${e.data.key}|${e.data.meter}`).settled += e.data.actual;
        else if (e.type === "rate.used" && e.data && e.data.at > clock() - e.data.per_seconds * 1000) { const k = `${e.data.grant}|${e.data.actor}`; windows.set(k, [...(windows.get(k) || []), e.data.at]); }
      }
    },
  };
  return Object.freeze(api);
}
