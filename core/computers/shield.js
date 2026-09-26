// @ts-check
// shield: a take-over the agent may not even look at, for a person signing in (ADR 0005,
// decision 3).
//
// A take-over stops the agent's hands. A shield also stops its eyes: while an agent is
// shielded, computers.may-act refuses every tool, reads included, and computerd answers 423 on
// /tree, /screenshot, /act and /input. The set lives in memory: after a restart nothing is
// shielded, which is true, since the take-over it guarded went with the old vyred too.
//
// The shield ends on its own when the take-over does (computer.handed-back), so a lapsed lease
// or a closed tab never leaves an agent blind. computerd is told on a best-effort basis; if it
// cannot be reached, vyred's refusal still holds, and a restarted computerd starts unshielded.

/** What the hands hear while a person signs in. */
export const SHIELDED = "a person is signing in on this computer";

export class Shield {
  /**
   * @param {{ pool: import("./pool.js").Pool, emit: (type: string, payload: any, where?: any) => any,
   *   on?: (pattern: string, fn: (e: any) => void) => () => void, log?: (m: string) => void,
   *   tell?: (agent: string, on: boolean) => Promise<boolean> }} deps
   */
  constructor(deps) {
    this.pool = deps.pool;
    this.send = deps.emit;
    this.log = deps.log || (() => {});
    this.tell = deps.tell || (async () => false);
    /** @type {Set<string>} */
    this.agents = new Set();
    this.off = deps.on ? deps.on("computer.handed-back", e => {
      const agent = e && e.payload && e.payload.agent;
      if (agent && this.agents.has(String(agent))) this.set(String(agent), false).catch(err => this.log(`unshield ${agent}: ${err.message}`));
    }) : () => {};
  }

  has(agent) { return this.agents.has(agent); }

  /**
   * Raise or lower the shield. vyred's refusal changes first, before computerd is asked, so no
   * read slips through while the request is on the wire.
   * @returns {Promise<{ agent: string, shielded: boolean, computerd: boolean }>}
   */
  async set(agent, on) {
    const was = this.agents.has(agent);
    if (on) this.agents.add(agent);
    else this.agents.delete(agent);
    if (was !== on) {
      this.send(on ? "computer.shielded" : "computer.unshielded", { agent });
      this.log(`${agent}'s computer ${on ? "shielded" : "unshielded"}`);
    }
    let told = false;
    try { told = await this.tell(agent, on); }
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
    if (this.agents.has(agent)) return { ok: false, why: SHIELDED };
    if (read) { this.pool.touch(agent); return { ok: true }; }
    return next();
  }

  stop() { this.off(); }
}
