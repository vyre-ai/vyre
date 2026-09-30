// @ts-check
// shield: a take-over the agent may not even look at, for a person signing in (ADR 0005,
// decision 3).
//
// A take-over stops the agent's hands. A shield also stops its eyes: while an agent is
// shielded, computers.may-act refuses every tool, reads included, and computerd answers 423 on
// /tree, /screenshot, /act and /input. The set lives in memory: after a restart nothing is
// shielded, which is true, since the take-over it guarded went with the old vyred too.
//
// The same shield guards a Vault fill (reason "fill", core/computers/fill.js, ADR 0028 decision
// 3): the agent is blind while vyred signs in for it, and computerd accepts only the fill's own
// token on /cdp. A person's shield ends on its own when the take-over does (computer.handed-back),
// so a lapsed lease or a closed tab never leaves an agent blind; a fill's ends with the fill. computerd is told on a best-effort basis; if it
// cannot be reached, vyred's refusal still holds, and a restarted computerd starts unshielded.

/** What the hands hear while a person signs in. */
export const SHIELDED = "a person is signing in on this computer";
/** What the hands hear while the Vault fills a login for the agent. */
export const FILLING = "a sign-in is being filled on this computer";

/** @typedef {"person"|"fill"} Reason */

export class Shield {
  /**
   * @param {{ pool: import("./pool.js").Pool, emit: (type: string, payload: any, where?: any) => any,
   *   on?: (pattern: string, fn: (e: any) => void) => () => void, log?: (m: string) => void,
   *   tell?: (agent: string, on: boolean, o?: { reason?: Reason, fill_token?: string }) => Promise<boolean> }} deps
   */
  constructor(deps) {
    this.pool = deps.pool;
    this.send = deps.emit;
    this.log = deps.log || (() => {});
    this.tell = deps.tell || (async () => false);
    /** Shielded agents, and why. @type {Map<string, Reason>} */
    this.agents = new Map();
    this.off = deps.on ? deps.on("computer.handed-back", e => {
      const agent = e && e.payload && e.payload.agent;
      if (agent && this.agents.get(String(agent)) === "person") this.set(String(agent), false).catch(err => this.log(`unshield ${agent}: ${err.message}`));
    }) : () => {};
  }

  has(agent) { return this.agents.has(agent); }

  /** Why the agent is shielded, or null. */
  reason(agent) { return this.agents.get(agent) || null; }

  /**
   * Raise or lower the shield. vyred's refusal changes first, before computerd is asked, so no
   * read slips through while the request is on the wire. A person's shield and a fill's never
   * replace each other: raising one while the other is up is refused ("busy"), and lowering
   * names the reason it lowers, so a person's hand-back never ends a fill.
   * @param {string} agent @param {boolean} on
   * @param {{ reason?: Reason, fill_token?: string }} [o] fill_token only with reason "fill"
   * @returns {Promise<{ agent: string, shielded: boolean, computerd: boolean }>}
   */
  async set(agent, on, o = {}) {
    const reason = o.reason || "person";
    const now = this.agents.get(agent);
    if (on && now && now !== reason) throw Object.assign(new Error(now === "fill"
      ? `${agent}'s computer is busy: a sign-in is being filled; try again in a few seconds`
      : `${agent}'s computer is busy: a person is signing in on it`), { code: "busy" });
    if (!on && now && now !== reason) return { agent, shielded: true, computerd: false };
    const was = Boolean(now);
    if (on) this.agents.set(agent, reason);
    else this.agents.delete(agent);
    if (was !== on) {
      this.send(on ? "computer.shielded" : "computer.unshielded", { agent, reason });
      this.log(`${agent}'s computer ${on ? "shielded" : "unshielded"} (${reason})`);
    }
    let told = false;
    try { told = await this.tell(agent, on, on && reason === "fill" && o.fill_token ? { reason, fill_token: o.fill_token } : { reason }); }
    catch (e) { this.log(`could not ${on ? "shield" : "unshield"} computerd for ${agent}: ${/** @type {Error} */ (e).message}`); }
    return { agent, shielded: on, computerd: told };
  }

  /**
   * The may-act answer with the shield in front: refused while shielded, whatever the tool. A
   * read (screenshot, tree, apps) is otherwise allowed and touches the checkout, since a
   * take-over holds only the keyboard (ADR 0003); anything else asks `next`, the keyboard.
   * @param {string} agent @param {boolean} read @param {() => any} next
   */
  mayAct(agent, read, next) {
    const r = this.agents.get(agent);
    if (r) return { ok: false, why: r === "fill" ? FILLING : SHIELDED };
    if (read) { this.pool.touch(agent); return { ok: true }; }
    return next();
  }

  stop() { this.off(); }
}
