// @ts-check
// pool: one computer per agent, and a few screens shared between them.
//
// A computer is a container with the agent's own home volume. It is made the first time the
// agent needs to look at something, and after that it is only ever started, frozen and thawed:
// its home survives everything but an explicit removal. Screens are the scarce part. A box can
// keep many frozen containers but only run a couple of desktops well, so a computer runs only
// while it is checked out, and a checkout lasts only while someone needs it: the agent's hands
// touch it on every action, and an open Glass viewer or a take-over holds it outright.
//
// Checkouts live in memory. After a restart nothing is checked out, which is true: the hands
// and viewers that held them went with the old vyred. The computers table is what survives, and
// reconcile() makes it agree with what the driver says is actually running.
//
// Time comes from `now()` and the timers from `sweep()`, so tests move the clock instead of
// waiting a minute; only index.js runs a real interval.

import crypto from "node:crypto";
import { PORTS, SIZE } from "./driver/index.js";

export const MIGRATIONS = [
  `CREATE TABLE computers_computers (
     agent TEXT PRIMARY KEY, container TEXT, state TEXT NOT NULL,
     vnc_password TEXT NOT NULL, helper_token TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL, updated INTEGER NOT NULL
   );`,
];

/** How long a Glass ticket lives: long enough to open a WebSocket, too short to be worth stealing. */
export const TICKET_MS = 30_000;
const AGENT = /^[a-z][a-z0-9-]{0,40}$/;

export const NO_DRIVER = "no computer driver is configured on this machine: set computers.docker in config.json to the restricted Docker proxy";

// VNC authentication (RFB's DES challenge) only ever uses the first eight bytes of a password,
// so the VNC password is eight characters. It guards a port on an internal network that only
// vyred reaches; the helper token, which carries more weight, gets the full 256 bits.
const vncPassword = () => crypto.randomBytes(6).toString("base64url");
const helperToken = () => crypto.randomBytes(32).toString("base64url");

/**
 * @typedef {{ agent: string, thread: string|null, screen: number, since: number, touched: number, viewers: number, verified?: number }} Checkout
 */

export class Pool {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, driver: import("./driver/index.js").Driver|null,
   *   call: (tool: string, input: any) => Promise<any>, emit: (type: string, payload: any, where?: any) => any,
   *   log?: (m: string) => void, config?: any, now?: () => number }} deps
   */
  constructor(deps) {
    const c = deps.config || {};
    this.db = deps.db;
    this.driver = deps.driver;
    this.call = deps.call;
    this.emit = deps.emit;
    this.log = deps.log || (() => {});
    this.now = deps.now || (() => Date.now());
    this.opts = {
      screens: Math.max(1, Number(c.screens || 2)),
      idleMs: Number(c.idleMs ?? 60_000),
      freezeMs: Number(c.freezeMs ?? 15_000),
      waitMs: Number(c.waitMs ?? 30_000),
      verifyMs: Number(c.verifyMs ?? 30_000),
      image: String(c.image || "vyre/computer:0.1"),
      network: c.network ? String(c.network) : undefined,
      prefix: String(c.labelPrefix || "vyre"),
      cpus: Number(c.cpus || 2),
      memoryMb: Number(c.memoryMb || 3072),
      size: c.size && c.size.w && c.size.h ? { w: Number(c.size.w), h: Number(c.size.h) } : { ...SIZE },
    };
    /** @type {Map<string, Checkout>} */
    this.checkouts = new Map();
    /** Running computers nobody has checked out, and since when: the freeze clock. */
    /** @type {Map<string, number>} */
    this.idle = new Map();
    /** Where each running computer answers, from the driver's last inspect. */
    /** @type {Map<string, { host: string, ports: { vnc: number, helper: number } }>} */
    this.hosts = new Map();
    /** @type {Map<string, { agent: string, surface: string, expires: number }>} */
    this.tickets = new Map();
    /** @type {Array<() => void>} */
    this.waiters = [];
    /** @type {Map<string, Promise<any>>} */
    this.locks = new Map();
    /** The surface holding a take-over of this agent's computer, or null. The keyboard sets it. */
    /** @type {(agent: string) => string|null} */
    this.heldBy = () => null;
  }

  // ---- the table -------------------------------------------------------------------------

  /** @returns {any} */
  row(agent) { return this.db.prepare("SELECT * FROM computers_computers WHERE agent = ?").get(agent) || null; }
  rows() { return /** @type {any[]} */ (this.db.prepare("SELECT * FROM computers_computers ORDER BY agent").all()); }

  /** The agent's row, made (state none, fresh secrets) if it has none yet. */
  rowFor(agent) {
    const r = this.row(agent);
    if (r) return r;
    const at = this.now();
    this.db.prepare(`INSERT INTO computers_computers (agent, container, state, vnc_password, helper_token, paused, created, updated)
      VALUES (?, NULL, 'none', ?, ?, 0, ?, ?)`).run(agent, vncPassword(), helperToken(), at, at);
    return this.row(agent);
  }

  set(agent, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE computers_computers SET ${keys.map(k => `${k} = ?`).join(", ")}, updated = ? WHERE agent = ?`)
      .run(...keys.map(k => fields[k]), this.now(), agent);
  }

  isPaused(agent) { const r = this.row(agent); return Boolean(r && r.paused); }

  // ---- who may have a computer -----------------------------------------------------------

  /**
   * The agent's record, if it may have a computer. The agents module decides: only an agent
   * whose record says `computer: true` gets one. Without that module nothing can say, so the
   * answer is no, with the reason.
   */
  async allowed(agent) {
    if (!AGENT.test(String(agent || ""))) throw new Error(`"${agent}" is not an agent name`);
    const r = await this.call("agents.list", {});
    if (r.error) {
      if (r.error.code === "no_such_tool") throw new Error("the agents module is not running, so there is no way to tell which agents have a computer");
      throw new Error(`could not read the agents: ${r.error.message}`);
    }
    const a = (r.data || []).find(x => x && x.name === agent);
    if (!a) throw new Error(`no agent ${agent}`);
    if (a.computer !== true) throw new Error(`${agent} has no computer; set computer: true on the agent to give it one`);
    return a;
  }

  // ---- one thing at a time per agent -----------------------------------------------------

  /** Run fn after whatever is already running for this agent. A checkout and a freeze never interleave. */
  serial(agent, fn) {
    const prev = this.locks.get(agent) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(agent, tail);
    tail.then(() => { if (this.locks.get(agent) === tail) this.locks.delete(agent); });
    return next;
  }

  // ---- checkouts -------------------------------------------------------------------------

  /**
   * Give the agent a screen and a running computer. Checking out what is already checked out
   * only touches it (and records the thread, when given).
   * @param {string} agent
   * @param {{ thread?: string|null, why?: string }} [o]
   * @returns {Promise<{ agent: string, screen: number, thread: string|null }>}
   */
  async checkout(agent, o = {}) {
    if (!this.driver) throw new Error(NO_DRIVER);
    return this.serial(agent, async () => {
      let held = this.checkouts.get(agent);
      if (held) {
        if (o.thread) held.thread = o.thread;
        held.touched = this.now();
        await this.verify(agent, held);
        held = this.checkouts.get(agent);
        if (held) return { agent, screen: held.screen, thread: held.thread };
        // verify() found the container gone and released the checkout: fall through and make a
        // fresh one, the same as if nothing had ever been checked out.
      }
      await this.allowed(agent);
      const co = await this.claim(agent, o.thread || null);
      try { await this.ensure(agent); }
      catch (e) { this.checkouts.delete(agent); this.wake(); throw e; }
      this.idle.delete(agent);
      this.emit("computer.checked-out", { agent, thread: co.thread, screen: co.screen }, co.thread ? { thread: co.thread } : {});
      this.log(`${agent} checked out screen ${co.screen}${o.why ? ` (${o.why})` : ""}`);
      return { agent, screen: co.screen, thread: co.thread };
    });
  }

  /**
   * A checked-out computer is trusted between calls, and freeze() only ever looks at idle ones,
   * so nothing had ever asked whether an actively-held container was still there — found on the
   * box's first real run, by hand, when a container removed out from under vyred mid-checkout
   * left `computers.get` reporting "running" until the next `computers.stop` forced a look.
   * Every `verifyMs`, an already-held checkout is asked once; a container gone releases it, so
   * the next call rebuilds it instead of trusting a screen nobody can actually reach. Called from
   * inside checkout()'s own `serial()`, so this never races a stop, a release or another checkout
   * of the same agent.
   * @param {string} agent @param {Checkout} held
   */
  async verify(agent, held) {
    const now = this.now();
    if (now - (held.verified ?? held.since) < this.opts.verifyMs) return;
    held.verified = now;
    const r = this.row(agent);
    if (!r || !r.container) return;
    let st;
    try { st = await this.driver.inspect(r.container); }
    catch { return; } // a network hiccup talking to the proxy is not evidence the container is gone
    if (st.state !== "missing") return;
    this.set(agent, { state: "none", container: null });
    this.hosts.delete(agent);
    this.checkouts.delete(agent);
    this.emit("computer.released", { agent, why: "vanished" }, held.thread ? { thread: held.thread } : {});
    this.log(`${agent}'s computer vanished while checked out; releasing so the next checkout rebuilds it`);
    this.wake();
  }

  /** Free screen numbers, 1-based: "screen 1" is what a person reads on the board. */
  freeScreen() {
    const used = new Set([...this.checkouts.values()].map(c => c.screen));
    for (let s = 1; s <= this.opts.screens; s++) if (!used.has(s)) return s;
    return 0;
  }

  /**
   * Take a screen: a free one, else the least recently touched one nobody is watching or has
   * taken over, else wait for one to come free. The checkout is recorded in the same tick the
   * screen is found, so two agents can never be handed the same screen.
   */
  async claim(agent, thread) {
    const deadline = Date.now() + this.opts.waitMs;
    for (;;) {
      let screen = this.freeScreen();
      if (!screen) {
        const victim = [...this.checkouts.values()].filter(c => c.viewers === 0 && !this.heldBy(c.agent))
          .sort((a, b) => a.touched - b.touched)[0];
        if (victim) { screen = victim.screen; this.release(victim.agent, "evicted"); }
      }
      if (screen) {
        const at = this.now();
        /** @type {Checkout} */
        const co = { agent, thread, screen, since: at, touched: at, viewers: 0 };
        this.checkouts.set(agent, co);
        return co;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`every screen is in use (${this.holders()}); try again when one is released`);
      await new Promise(resolve => {
        const done = () => { clearTimeout(t); this.waiters = this.waiters.filter(w => w !== done); resolve(undefined); };
        const t = setTimeout(done, left);
        this.waiters.push(done);
      });
    }
  }

  /** Who holds the screens, for a person to read: "kit (watched by 1), juno (taken over by glass:laptop)". */
  holders() {
    return [...this.checkouts.values()].map(c => {
      const h = this.heldBy(c.agent);
      return `${c.agent} (${h ? `taken over by ${h}` : c.viewers ? `watched by ${c.viewers}` : "working"})`;
    }).join(", ");
  }

  /** A screen came free: let every waiter look again. */
  wake() {
    for (const done of [...this.waiters]) done();
  }

  touch(agent) {
    const co = this.checkouts.get(agent);
    if (co) co.touched = this.now();
    return Boolean(co);
  }

  /**
   * Let go of the screen. The computer keeps running until the freeze clock runs out, so an
   * agent that comes back within freezeMs finds it warm.
   * @param {string} agent
   * @param {"released"|"idle"|"evicted"|"stopped"} [why]
   */
  release(agent, why = "released") {
    const co = this.checkouts.get(agent);
    if (!co) return false;
    this.checkouts.delete(agent);
    const r = this.row(agent);
    if (r && r.state === "running") this.idle.set(agent, this.now());
    this.emit("computer.released", { agent, why }, co.thread ? { thread: co.thread } : {});
    this.log(`${agent} released screen ${co.screen} (${why})`);
    this.wake();
    return true;
  }

  /**
   * A Glass viewer opened (+1) or closed (-1). A viewer needs to look, so the first one checks
   * out (and thaws); the last one leaving starts the idle clock from then, not from the agent's
   * last touch.
   */
  async viewer(agent, delta) {
    if (delta > 0) {
      await this.checkout(agent, { why: "watch" });
      const co = this.checkouts.get(agent);
      if (co) co.viewers += 1;
      return co ? co.viewers : 0;
    }
    const co = this.checkouts.get(agent);
    if (!co) return 0;
    co.viewers = Math.max(0, co.viewers - 1);
    co.touched = this.now();
    return co.viewers;
  }

  // ---- the container ---------------------------------------------------------------------

  /** Make the agent's computer exist and run: create it, start it, or thaw it, as needed. */
  async ensure(agent) {
    const d = /** @type {import("./driver/index.js").Driver} */ (this.driver);
    let r = this.rowFor(agent);
    let st = r.container ? await d.inspect(r.container) : { state: "missing", host: null };
    if (st.state === "missing") {
      // Fresh secrets with every new container: the old ones died with the old container.
      this.set(agent, { vnc_password: vncPassword(), helper_token: helperToken() });
      r = this.row(agent);
      const { w, h } = this.opts.size;
      const { id } = await d.create({
        agent, image: this.opts.image, network: this.opts.network, cpus: this.opts.cpus, memoryMb: this.opts.memoryMb, size: this.opts.size,
        env: { VNC_PASSWORD: r.vnc_password, COMPUTERD_TOKEN: r.helper_token, SCREEN: `${w}x${h}` },
        labels: { [`${this.opts.prefix}.computer`]: agent, [`${this.opts.prefix}.managed`]: "true" },
        volume: `${this.opts.prefix}-home-${agent}`,
      });
      this.set(agent, { container: id, state: "stopped" });
      this.emit("computer.created", { agent });
      this.log(`${agent}'s computer created`);
      st = { state: "exited", host: null };
    }
    const id = String(this.row(agent).container);
    if (st.state === "paused") {
      await d.unpause(id);
      this.emit("computer.thawed", { agent });
    } else if (st.state === "exited") {
      await d.start(id);
    }
    const now = await d.inspect(id);
    if (now.host) this.hosts.set(agent, { host: now.host, ports: now.ports || { ...PORTS } });
    this.set(agent, { state: "running" });
  }

  /** Freeze a computer nobody has checked out. Docker pause keeps memory and costs no CPU. */
  async freeze(agent) {
    return this.serial(agent, async () => {
      if (this.checkouts.has(agent)) return false;
      this.idle.delete(agent);
      const r = this.row(agent);
      if (!r || r.state !== "running" || !r.container || !this.driver) return false;
      try { await this.driver.pause(r.container); }
      catch (e) {
        const st = await this.driver.inspect(r.container).catch(() => null);
        if (st && st.state === "missing") { this.set(agent, { state: "none", container: null }); this.hosts.delete(agent); }
        this.log(`could not freeze ${agent}'s computer: ${/** @type {Error} */ (e).message}`);
        return false;
      }
      this.set(agent, { state: "frozen" });
      this.emit("computer.frozen", { agent });
      this.log(`${agent}'s computer frozen`);
      return true;
    });
  }

  /** Stop the container; the home volume stays. */
  async stop(agent) {
    if (!this.driver) throw new Error(NO_DRIVER);
    const d = this.driver;
    this.release(agent, "stopped");
    return this.serial(agent, async () => {
      this.idle.delete(agent);
      const r = this.row(agent);
      if (!r || !r.container) return { stopped: false };
      const st = await d.inspect(r.container);
      if (st.state === "missing") { this.set(agent, { state: "none", container: null }); this.hosts.delete(agent); return { stopped: false }; }
      // A frozen process cannot handle SIGTERM, so a stop would only ever end in the kill.
      if (st.state === "paused") await d.unpause(r.container);
      if (st.state !== "exited") await d.stop(r.container);
      this.set(agent, { state: "stopped" });
      this.hosts.delete(agent);
      this.emit("computer.stopped", { agent });
      this.log(`${agent}'s computer stopped`);
      return { stopped: true };
    });
  }

  /** Pause or resume the agent's hands. The container is untouched; this is about who acts. */
  pause(agent, on) {
    const r = this.rowFor(agent);
    if (Boolean(r.paused) !== on) {
      this.set(agent, { paused: on ? 1 : 0 });
      this.emit(on ? "computer.paused" : "computer.resumed", { agent });
    }
    return { paused: on };
  }

  // ---- time ------------------------------------------------------------------------------

  /** Release idle checkouts and freeze computers idle past freezeMs. index.js calls it on a timer, tests by hand. */
  async sweep() {
    const now = this.now();
    for (const co of [...this.checkouts.values()]) {
      if (co.viewers === 0 && !this.heldBy(co.agent) && now - co.touched >= this.opts.idleMs) this.release(co.agent, "idle");
    }
    const due = [...this.idle.entries()].filter(([, at]) => this.now() - at >= this.opts.freezeMs).map(([a]) => a);
    for (const agent of due) await this.freeze(agent);
  }

  // ---- restart ---------------------------------------------------------------------------

  /**
   * Make the table agree with the driver after vyred starts. A row whose container is gone goes
   * back to none (the next checkout makes a new one); a running container nobody checked out
   * starts its freeze clock; a managed container with no row is removed, since its passwords
   * died with the table and nothing can reach it any more.
   */
  async reconcile() {
    if (!this.driver) return;
    const live = await this.driver.list();
    const byId = new Map(live.map(c => [c.id, c]));
    const known = new Set();
    for (const r of this.rows()) {
      const c = r.container ? byId.get(r.container) : null;
      if (!c) { if (r.container || r.state !== "none") this.set(r.agent, { state: "none", container: null }); continue; }
      known.add(c.id);
      const state = c.state === "running" ? "running" : c.state === "paused" ? "frozen" : "stopped";
      this.set(r.agent, { state });
      if (state === "running") this.idle.set(r.agent, this.now());
      if (state !== "stopped") {
        const st = await this.driver.inspect(c.id).catch(() => null);
        if (st && st.host) this.hosts.set(r.agent, { host: st.host, ports: st.ports || { ...PORTS } });
      }
    }
    for (const c of live) {
      if (known.has(c.id)) continue;
      try { await this.driver.remove(c.id); this.log(`removed ${c.agent}'s orphaned computer ${c.id}: its passwords were lost with the table`); }
      catch (e) { this.log(`could not remove orphaned computer ${c.id}: ${/** @type {Error} */ (e).message}`); }
    }
  }

  // ---- what Glass and the hands need -----------------------------------------------------

  /** Where the agent's computer answers VNC, and its password. Internal: never in a tool result or event. */
  vnc(agent) {
    const h = this.hosts.get(agent), r = this.row(agent);
    if (!h || !r || r.state !== "running") return null;
    return { host: h.host, port: h.ports.vnc, password: String(r.vnc_password) };
  }

  /**
   * computerd's URL and token, for the hands. Chrome's own debugging port is not handed out
   * directly: it stays loopback-only inside the container, and hands-chrome reaches it only
   * through computerd's authenticated `/cdp/...` proxy at this same URL (see cdp.js).
   */
  endpoint(agent) {
    const h = this.hosts.get(agent), r = this.row(agent);
    if (!h || !r) throw new Error(`${agent}'s computer is not running`);
    return { helper: { url: `http://${h.host}:${h.ports.helper}`, token: String(r.helper_token) } };
  }

  size(_agent) { return { ...this.opts.size }; }

  /** A one-use ticket for opening Glass, bound to one agent and one surface. */
  ticket(agent, surface) {
    const now = this.now();
    for (const [k, t] of this.tickets) if (t.expires <= now) this.tickets.delete(k);
    const ticket = crypto.randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { agent, surface, expires: now + TICKET_MS });
    return ticket;
  }

  /** Spend a ticket. Null when it is unknown, used or expired; a ticket works once either way. */
  redeem(ticket) {
    const t = this.tickets.get(String(ticket || ""));
    if (!t) return null;
    this.tickets.delete(String(ticket));
    if (t.expires <= this.now()) return null;
    return { agent: t.agent, surface: t.surface };
  }

  // ---- views -----------------------------------------------------------------------------

  /** One computer as tools show it. Never a password or token. */
  view(agent) {
    const r = this.row(agent), co = this.checkouts.get(agent);
    return {
      agent, state: r ? String(r.state) : "none", screen: co ? co.screen : null, thread: co ? co.thread : null,
      viewers: co ? co.viewers : 0, takeover: this.heldBy(agent), paused: Boolean(r && r.paused), size: this.size(agent),
      since: co ? co.since : r ? Number(r.updated) : null,
    };
  }
}
