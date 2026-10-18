// @ts-check
// agent-frame: the small picture of an agent's screen for the Computer tab (computers.agent.frame). It is a view, not a stream: one JPEG at most every 5 seconds per agent, the latest one kept in memory only.
//
// - A live screen is captured through agentd (agentd.js planShot, run as the screen's owner). Asking does not count as use, so an open tab does not keep an agent awake.
// - While a person is typing into the agent's screen (a take-over) or a fill or a person's sign-in has the screen shielded, NO picture is given, only who holds the screen: a picture must never carry what is being typed.
// - An asleep agent shows the latest picture it had, marked asleep. Nothing is written to disk, to an event or to a log. A reset, a removal or the computer stopping drops it.

export const FRAME_EVERY_MS = 5000;

/**
 * @typedef {{ at: number, mime: string, width: number, height: number, jpeg: string }} Shot
 * @param {{ users: import("./agent-users.js").AgentUsers, now?: () => number,
 *   typing: (agent: string) => boolean, shielded: (agent: string) => boolean, watching: (agent: string) => boolean }} d
 */
export class AgentFrames {
  constructor(d) {
    this.users = d.users; this.now = d.now || (() => Date.now());
    this.typing = d.typing; this.shielded = d.shielded; this.watching = d.watching;
    /** @type {Map<string, Shot>} */ this.cache = new Map();
    /** @type {Map<string, Promise<Shot | null>>} one capture at a time per agent */ this.inflight = new Map();
  }

  /** Forget one agent's picture (its home was reset, it was removed). @param {string} agent */
  drop(agent) { this.cache.delete(agent); }
  /** Forget every picture (the computer stopped). */
  dropAll() { this.cache.clear(); }

  /** @param {string} agent @returns {Promise<Shot | null>} */
  async capture(agent) {
    const have = this.cache.get(agent);
    if (have && this.now() - have.at < FRAME_EVERY_MS) return have;
    let p = this.inflight.get(agent);
    if (!p) {
      p = this.users.shot(agent).then(s => {
        /** @type {Shot} */ const shot = { at: this.now(), mime: String(s.mime), width: Number(s.width), height: Number(s.height), jpeg: String(s.jpeg) };
        this.cache.set(agent, shot);
        return shot;
      }).catch(() => this.cache.get(agent) || null).finally(() => { this.inflight.delete(agent); });
      this.inflight.set(agent, p);
    }
    return p;
  }

  /**
   * What the tab shows for one agent.
   * @param {string} agent
   * @returns {Promise<{ agent: string, state: string, lastActive: number, thumbnail?: string, width?: number, height?: number, at?: number, held_by?: "taken-over" | "watching", withheld?: "typing" | "shielded" }>}
   */
  async view(agent) {
    const row = this.users.row(agent);
    const state = row ? String(row.state) : "none";
    /** @type {any} */ const out = { agent, state, lastActive: row ? Number(row.last_active) : 0 };
    if (state === "live") {
      const typing = this.typing(agent), shielded = this.shielded(agent);
      if (typing) out.held_by = "taken-over"; else if (this.watching(agent)) out.held_by = "watching";
      if (typing || shielded) { out.withheld = typing ? "typing" : "shielded"; return out; }
    }
    const shot = state === "live" ? await this.capture(agent) : this.cache.get(agent) || null;
    if (shot) Object.assign(out, { thumbnail: `data:${shot.mime};base64,${shot.jpeg}`, width: shot.width, height: shot.height, at: shot.at });
    return out;
  }
}
