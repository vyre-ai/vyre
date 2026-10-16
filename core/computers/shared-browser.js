// @ts-check
// shared-browser: agent-browsers.md level 2 — one headless Chrome, one context per agent (via cdpmux).
//
// Agents with computer: true reach the shared browser computer through membership (agents.uid as
// agent_id), not a per-agent desktop checkout. computers.endpoint, helper, watch, takeover and
// hands-chrome all go through here when browse mode is "browser" (the default on a box).

import crypto from "node:crypto";

const AGENT = /^[a-z][a-z0-9-]{0,40}$/;
/** The synthetic row id for the install's shared browser computer (never a real agent name). */
export const SHARED_COMPUTER_ID = "browser-shared";

/** @param {any} cfg computers section of config */
export function browseMode(cfg) {
  const m = cfg && cfg.browse;
  if (m === "desktop" || m === "desktops" || m === "pool") return "desktop";
  if (m === "browser") return "browser";
  if (cfg && (cfg.defaultBrowser === true || cfg.default_browser === true)) return "browser";
  if (cfg && cfg.browser === false) return "desktop";
  // Real boxes default to the shared headless browser; the fake driver keeps desktop unless asked.
  if (cfg && cfg.driver === "fake") return "desktop";
  return "browser";
}

/** @param {any} cfg */
export function sharedBrowserOn(cfg) {
  return browseMode(cfg) === "browser";
}

/**
 * @typedef {{ viewers: number, touched: number, thread: string|null, since: number }} Hold
 */

export class SharedBrowser {
  /**
   * @param {{ pool: import("./pool.js").Pool, call: (tool: string, input: any) => Promise<any>,
   *   cfg: () => any, log?: (m: string) => void }} deps
   */
  constructor(deps) {
    this.pool = deps.pool;
    this.call = deps.call;
    this.cfg = deps.cfg;
    this.log = deps.log || (() => {});
    /** @type {Map<string, Hold>} agent name -> hold (replaces desktop checkout for browsing) */
    this.holds = new Map();
    /** computer id resolved once */
    this.computerId = null;
  }

  enabled() {
    return sharedBrowserOn(this.cfg()) && Boolean(this.pool.driver);
  }

  computer() {
    const c = this.cfg();
    const fromCfg = c && c.sharedBrowser && AGENT.test(String(c.sharedBrowser)) ? String(c.sharedBrowser) : SHARED_COMPUTER_ID;
    if (this.computerId) return this.computerId;
    const row = this.pool.row(fromCfg);
    if (row && row.kind === "browser") { this.computerId = fromCfg; return fromCfg; }
    const any = this.pool.rows().find(r => r.kind === "browser");
    if (any) { this.computerId = String(any.agent); return this.computerId; }
    return fromCfg;
  }

  /** @param {string} agent */
  async agentRecord(agent) {
    const r = await this.call("agents.list", {});
    if (r.error) throw new Error(`could not read agents: ${r.error.message}`);
    const a = (r.data || []).find(x => x && x.name === agent);
    if (!a) throw new Error(`no agent ${agent}`);
    if (a.computer !== true) throw new Error(`${agent} has no computer; set computer: true on the agent to give it one`);
    if (!a.uid) throw new Error(`${agent} has no stable id yet`);
    return a;
  }

  /** @param {string} agent */
  async ensureMember(agent) {
    const a = await this.agentRecord(agent);
    const computerId = this.computer();
    const members = this.pool.members(computerId);
    const uid = String(a.uid);
    if (!members.some(m => m.agent_id === uid)) {
      await this.pool.addAgent(computerId, uid, String(a.name));
      this.log(`shared browser: ${agent} (${uid}) joined ${computerId}`);
    }
    await this.pool.serial(computerId, async () => {
      await this.pool.allowed(agent);
      await this.pool.ensure(computerId);
    });
    return { computerId, agentId: uid, name: String(a.name) };
  }

  /** @param {string} agent */
  async endpoint(agent) {
    const { computerId, agentId } = await this.ensureMember(agent);
    const h = this.pool.endpoint(computerId).helper;
    const token = await this.pool.memberCdpToken(computerId, agentId);
    return { helper: { url: h.url, token } };
  }

  /** Thaw the shared computer without taking a desktop screen. @param {string} agent */
  async touch(agent) {
    await this.ensureMember(agent);
    const co = this.computer();
    const hold = this.holds.get(agent);
    if (hold) hold.touched = this.pool.now();
    else if (!this.pool.touch(co)) this.pool.idle.set(co, this.pool.now());
  }

  /**
   * Hold the shared browser for hands, watch or take-over (no VNC screen).
   * @param {string} agent @param {{ thread?: string|null, why?: string }} [o]
   */
  async hold(agent, o = {}) {
    await this.ensureMember(agent);
    let h = this.holds.get(agent);
    if (!h) {
      h = { viewers: 0, touched: this.pool.now(), thread: o.thread || null, since: this.pool.now() };
      this.holds.set(agent, h);
    } else {
      if (o.thread) h.thread = o.thread;
      h.touched = this.pool.now();
    }
    return h;
  }

  /** @param {string} agent @param {number} delta */
  viewer(agent, delta) {
    const h = this.holds.get(agent);
    if (!h) return 0;
    if (delta > 0) h.viewers += 1;
    else h.viewers = Math.max(0, h.viewers - 1);
    h.touched = this.pool.now();
    return h.viewers;
  }

  /** @param {string} agent */
  release(agent) {
    return this.holds.delete(agent);
  }

  /** @param {string} agent */
  holder(agent) {
    return this.holds.get(agent) || null;
  }

  /** What tools show for an agent on the shared browser. @param {string} agent */
  view(agent) {
    const h = this.holds.get(agent);
    const computerId = this.computer();
    const r = this.pool.row(computerId);
    const running = r && r.state === "running";
    return {
      agent,
      mode: "browser",
      state: running ? String(r.state) : (r ? String(r.state) : "none"),
      screen: null,
      thread: h ? h.thread : null,
      viewers: h ? h.viewers : 0,
      takeover: this.pool.heldBy(agent),
      paused: Boolean(r && r.paused),
      size: this.pool.size(agent),
      since: h ? h.since : (r ? Number(r.updated) : null),
      screens: 0,
      cpus: r ? this.pool.limitsOf(r).cpus : this.pool.opts.cpus,
      memory_gb: r ? Math.round(this.pool.limitsOf(r).memoryMb / 1024 * 10) / 10 : Math.round(this.pool.opts.memoryMb / 1024 * 10) / 10,
    };
  }
}
