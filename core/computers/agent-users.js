// @ts-check
// agent-users: the agents that live on a space's one computer, each its own Linux user (owner decision, 18 Oct 2026).
//
// One computer per space. Each agent on it has a private home, its own Chrome profile and terminal, and its own virtual screen. The
// screen and Chrome are started on demand and closed after the agent has been idle for a while (5 minutes); the terminal's jobs keep
// running; waking reopens the screen and Chrome where they were. This file is the rules and the table. What actually makes a user, starts
// a screen or wipes a home is the `ctl` port (computerd in the container; a fake in tests), so every rule here is testable with no Docker.
//
// States: "asleep" (user and home exist, no screen), "waking" (screen and Chrome starting), "live" (screen up). An agent that was
// never woken has no row until `add`.

/** Linux users for agents start here, so they never meet the computer's own users (vyre 1001, browser 1002, agent 1000). */
export const UID_BASE = 20000;
/** Displays are :20 and up, one per agent. */
export const DISPLAY_BASE = 20;
/** The most agents one computer holds; each is a user, a screen and a Chrome, so the box decides how many it can run live. */
export const MAX_AGENTS = 64;
/** An agent's screen and Chrome close after this long with nobody using them. */
export const IDLE_SLEEP_MS = 5 * 60_000;

export const MIGRATIONS = [
  `CREATE TABLE computers_agent_users (
     agent_id TEXT PRIMARY KEY,
     agent_name TEXT NOT NULL,
     uid INTEGER NOT NULL UNIQUE,
     display INTEGER NOT NULL UNIQUE,
     state TEXT NOT NULL DEFAULT 'asleep',
     last_active INTEGER NOT NULL,
     woke_at INTEGER,
     created INTEGER NOT NULL
   );`,
];

const AGENT_ID = /^[a-z][a-z0-9._-]{1,80}$/;
/** The Linux user of a uid in the agent range. The image makes all of them at build time (MAX_AGENTS of them), because its root is read-only and cannot add users at run time. */
export const userNameOf = uid => `ag${uid}`;

/**
 * @typedef {{ createUser(u: { agentId: string, user: string, uid: number, display: number }): Promise<void>,
 *   removeUser(u: { agentId: string, user: string, uid: number, display: number }): Promise<void>,
 *   startScreen(u: { agentId: string, user: string, uid: number, display: number }): Promise<void>,
 *   stopScreen(u: { agentId: string, user: string, uid: number, display: number }): Promise<void>,
 *   wipeHome(u: { agentId: string, user: string, uid: number, display: number }): Promise<void>,
 *   screenTicket?(u: { agentId: string, user: string, uid: number, display: number }, ticket: string): Promise<void>,
 *   cdpTicket?(u: { agentId: string, user: string, uid: number, display: number }, ticket: string): Promise<void>,
 *   terminalTicket?(u: { agentId: string, user: string, uid: number, display: number }, ticket: string, session: string): Promise<void>,
 *   terminals?(u: { agentId: string, user: string, uid: number, display: number }): Promise<Array<{ name: string, windows: number }>> }} Ctl
 */

export class AgentUsers {
  /** @param {{ db: import("node:sqlite").DatabaseSync, ctl: Ctl, now?: () => number, emit?: (type: string, payload: any) => void, idleMs?: number, max?: number }} deps */
  constructor(deps) {
    this.db = deps.db;
    this.ctl = deps.ctl;
    this.now = deps.now || (() => Date.now());
    this.emit = deps.emit || (() => {});
    this.idleMs = deps.idleMs ?? IDLE_SLEEP_MS;
    this.max = deps.max ?? MAX_AGENTS;
    /** One action at a time per agent. @type {Map<string, Promise<any>>} */
    this.locks = new Map();
  }

  /** @param {string} id @param {() => Promise<any>} fn */
  serial(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(id, next);
    next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => {});
    return next;
  }

  /** @param {string} id */
  row(id) { return /** @type {any} */ (this.db.prepare("SELECT * FROM computers_agent_users WHERE agent_id = ?").get(id)) || null; }
  list() { return /** @type {any[]} */ (this.db.prepare("SELECT * FROM computers_agent_users ORDER BY uid").all()); }

  /** The agent's user on the computer, made once: the same uid and display for ever, so its home and profile always belong to it. @param {string} id @param {string} name */
  async add(id, name) {
    if (!AGENT_ID.test(String(id || ""))) throw new Error(`"${id}" is not an agent id`);
    return this.serial(id, async () => {
      const have = this.row(id);
      if (have) return have;
      const rows = this.list();
      if (rows.length >= this.max) throw new Error(`this computer already holds ${this.max} agents`);
      const used = new Set(rows.map(r => r.uid));
      let uid = UID_BASE;
      while (used.has(uid)) uid++;
      const display = DISPLAY_BASE + (uid - UID_BASE);
      const at = this.now();
      await this.ctl.createUser({ agentId: id, user: userNameOf(uid), uid, display });
      this.db.prepare("INSERT INTO computers_agent_users (agent_id, agent_name, uid, display, state, last_active, created) VALUES (?, ?, ?, ?, 'asleep', ?, ?)").run(id, String(name || id), uid, display, at, at);
      this.emit("computer.agent-added", { agent: id });
      return this.row(id);
    });
  }

  /** Wake the agent: start its screen and Chrome if they are not up, and count this as use. Idempotent for a live agent. @param {string} id */
  async wake(id) {
    return this.serial(id, async () => {
      const r = this.row(id);
      if (!r) throw new Error(`${id} has no place on this computer yet`);
      if (r.state === "live") { this.touchNow(id); return this.row(id); }
      this.set(id, { state: "waking", last_active: this.now() });
      this.emit("computer.agent-waking", { agent: id });
      try { await this.ctl.startScreen({ agentId: id, user: userNameOf(r.uid), uid: r.uid, display: r.display }); }
      catch (e) { this.set(id, { state: "asleep" }); throw e; }
      this.set(id, { state: "live", woke_at: this.now(), last_active: this.now() });
      this.emit("computer.agent-live", { agent: id });
      return this.row(id);
    });
  }

  /** Register a viewer's one-use ticket for this agent's live screen with agentd's relay; counts as use. Refused for a screen that is not up. @param {string} id @param {string} ticket */
  async screenTicket(id, ticket) {
    const r = this.row(id);
    if (!r || r.state !== "live") throw new Error(`${id}'s screen is not on`);
    if (typeof this.ctl.screenTicket !== "function") throw new Error("this computer cannot open a screen to an agent");
    await this.ctl.screenTicket({ agentId: id, user: userNameOf(r.uid), uid: r.uid, display: r.display }, ticket);
    this.touchNow(id);
  }

  /** Register a one-use ticket for this agent's Chrome (its debugging pipe); the agent's screen and Chrome must be up. @param {string} id @param {string} ticket */
  async cdpTicket(id, ticket) {
    const r = this.row(id);
    if (!r || r.state !== "live") throw new Error(`${id}'s Chrome is not up`);
    if (typeof this.ctl.cdpTicket !== "function") throw new Error("this computer cannot reach an agent's Chrome");
    await this.ctl.cdpTicket({ agentId: id, user: userNameOf(r.uid), uid: r.uid, display: r.display }, ticket);
    this.touchNow(id);
  }

  /** The agent's terminals (tmux sessions; they outlive the screen). @param {string} id */
  async terminals(id) {
    const r = this.row(id);
    if (!r) return [];
    if (typeof this.ctl.terminals !== "function") throw new Error("this computer cannot list terminals");
    return this.ctl.terminals({ agentId: id, user: userNameOf(r.uid), uid: r.uid, display: r.display });
  }

  /** Register a one-use ticket for one terminal of this agent. @param {string} id @param {string} ticket @param {string} session */
  async terminalTicket(id, ticket, session) {
    const r = this.row(id);
    if (!r) throw new Error(`${id} has no place on this computer yet`);
    if (typeof this.ctl.terminalTicket !== "function") throw new Error("this computer cannot open a terminal");
    await this.ctl.terminalTicket({ agentId: id, user: userNameOf(r.uid), uid: r.uid, display: r.display }, ticket, session);
    this.touchNow(id);
  }

  /** Something used the agent's screen or Chrome (a tool call, a viewer, a take-over input). @param {string} id */
  touch(id) { this.touchNow(id); }
  /** @param {string} id */
  touchNow(id) { this.db.prepare("UPDATE computers_agent_users SET last_active = ? WHERE agent_id = ?").run(this.now(), id); }

  /** Close the agent's screen and Chrome now. Its terminal jobs and home are untouched. @param {string} id @param {string} [why] */
  async sleep(id, why = "asked") {
    return this.serial(id, async () => {
      const r = this.row(id);
      if (!r || r.state === "asleep") return r;
      await this.ctl.stopScreen({ agentId: id, user: userNameOf(r.uid), uid: r.uid, display: r.display });
      this.set(id, { state: "asleep" });
      this.emit("computer.agent-asleep", { agent: id, why });
      return this.row(id);
    });
  }

  /** Put to sleep every live agent that has been idle long enough. `held(id)` is true while a person watches or has taken over. @param {(id: string) => boolean} [held] @returns {Promise<string[]>} */
  async sweep(held = () => false) {
    const t = this.now();
    const slept = [];
    for (const r of this.list()) {
      if (r.state !== "live" || held(r.agent_id)) continue;
      if (t - r.last_active >= this.idleMs) { await this.sleep(r.agent_id, "idle"); slept.push(r.agent_id); }
    }
    return slept;
  }

  /** Reset one agent's home: its screen closes, the home (Chrome profile, files, terminal state) is emptied, and the user stays. Nobody else's home is touched. @param {string} id */
  async reset(id) {
    const r = this.row(id);
    if (!r) throw new Error(`${id} has no place on this computer`);
    await this.sleep(id, "reset");
    return this.serial(id, async () => {
      await this.ctl.wipeHome({ agentId: id, user: userNameOf(r.uid), uid: r.uid, display: r.display });
      this.emit("computer.agent-reset", { agent: id });
      return this.row(id);
    });
  }

  /** Remove the agent from the computer: its user and home go. Its uid and display are free for the next agent only after this. @param {string} id */
  async remove(id) {
    await this.sleep(id, "removed");
    return this.serial(id, async () => {
      if (!this.row(id)) return false;
      const r = this.row(id); await this.ctl.removeUser({ agentId: id, user: userNameOf(r.uid), uid: r.uid, display: r.display });
      this.db.prepare("DELETE FROM computers_agent_users WHERE agent_id = ?").run(id);
      this.emit("computer.agent-removed", { agent: id });
      return true;
    });
  }

  /** What the screens say: asleep, waking or live. @param {string} id */
  status(id) {
    const r = this.row(id);
    return r ? { agent: id, state: r.state, display: r.display, lastActive: r.last_active } : { agent: id, state: "none" };
  }

  /** @param {string} id @param {Record<string, any>} f */
  set(id, f) {
    const k = Object.keys(f);
    this.db.prepare(`UPDATE computers_agent_users SET ${k.map(x => `${x} = ?`).join(", ")} WHERE agent_id = ?`).run(...k.map(x => f[x]), id);
  }
}
