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
import net from "node:net";
import { PORTS, SIZE } from "./driver/index.js";
import { chromeEnv } from "./egress.js";
import { join as joinTailnet, leave as leaveTailnet } from "./tailnet.js";

export const MIGRATIONS = [
  `CREATE TABLE computers_computers (
     agent TEXT PRIMARY KEY, container TEXT, state TEXT NOT NULL,
     vnc_password TEXT NOT NULL, helper_token TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL, updated INTEGER NOT NULL
   );`,
  // What the container's Chrome was made with for config glass.egress (the PAC data: URL, or ""),
  // so a change reaches a computer the next time it starts rather than never (egress.js).
  `ALTER TABLE computers_computers ADD COLUMN egress TEXT NOT NULL DEFAULT '';`,
  // The computer's own tailnet node, while it has one (config computers.tailnet, tailnet.js):
  // what computers.node.agent maps a whois back to. Cleared when the computer stops or vanishes.
  `ALTER TABLE computers_computers ADD COLUMN stable_id TEXT;
   ALTER TABLE computers_computers ADD COLUMN node TEXT;`,
  // Per-agent limits, set from the Deck. Null means the box's computers.cpus / computers.memoryMb.
  `ALTER TABLE computers_computers ADD COLUMN cpus REAL;
   ALTER TABLE computers_computers ADD COLUMN memory_mb INTEGER;`,
];

/** What a person may set a computer's limits to. */
export const LIMITS = Object.freeze({ cpus: { min: 1, max: 16 }, memoryGb: { min: 1, max: 64 } });

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
   *   log?: (m: string) => void, config?: any, now?: () => number, egress?: () => any,
   *   tailnet?: { setting: () => { enabled: boolean, tag: string }, key: () => Promise<string> },
   *   wait?: (ms: number) => Promise<void>, probe?: ((host: string, port: number) => Promise<boolean>) | null }} deps
   *   egress reads config glass.egress when a computer is made, so a change needs no restart.
   *   tailnet reads config computers.tailnet each time a computer starts, and fetches the auth key
   *   from the vault only then, only when that switch is on.
   */
  constructor(deps) {
    const c = deps.config || {};
    this.db = deps.db;
    this.driver = deps.driver;
    this.call = deps.call;
    this.emit = deps.emit;
    this.log = deps.log || (() => {});
    this.now = deps.now || (() => Date.now());
    this.egress = deps.egress || (() => undefined);
    this.tailnet = deps.tailnet || null;
    this.wait = deps.wait;
    // Is the computer's screen answering yet? Only the Docker driver has a real address to dial;
    // the fake's hosts are names nothing resolves, so its computers are ready once started.
    this.probe = deps.probe !== undefined ? deps.probe : deps.driver && deps.driver.name === "docker" ? tcpProbe : null;
    this.opts = {
      screens: Math.max(1, Number(c.screens || 2)),
      idleMs: Number(c.idleMs ?? 60_000),
      freezeMs: Number(c.freezeMs ?? 15_000),
      waitMs: Number(c.waitMs ?? 30_000),
      verifyMs: Number(c.verifyMs ?? 30_000),
      bootMs: Number(c.bootMs ?? 30_000),
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
    /** @type {Map<string, { host: string, ports: { vnc: number, helper: number, tailnet?: number } }>} */
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
    /** A join in flight per agent, so a stop can cut it short and wait for it. */
    /** @type {Map<string, { ctl: AbortController, done: Promise<void> }>} */
    this.joins = new Map();
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
    this.leftTailnet(agent);
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
    // Chrome's proxy script is fixed when the container is made. A stopped computer whose script
    // no longer matches config glass.egress is made again (its home volume stays, so its Chrome
    // profile and sign-ins do too); a running or frozen one keeps what it has until it stops.
    const egress = chromeEnv(this.egress());
    const want = egress.VYRE_PROXY_PAC || "";
    if (st.state === "exited" && String(r.egress || "") !== want) {
      await d.remove(String(r.container));
      this.set(agent, { container: null, state: "none" });
      this.log(`${agent}'s computer made again: its egress setting changed`);
      st = { state: "missing", host: null };
    }
    if (st.state === "missing") {
      // Fresh secrets with every new container: the old ones died with the old container.
      this.set(agent, { vnc_password: vncPassword(), helper_token: helperToken() });
      r = this.row(agent);
      const { w, h } = this.opts.size;
      const { id } = await d.create({
        agent, image: this.opts.image, network: this.opts.network, ...this.limitsOf(r), size: this.opts.size,
        env: { VNC_PASSWORD: r.vnc_password, COMPUTERD_TOKEN: r.helper_token, SCREEN: `${w}x${h}`, ...egress },
        labels: { [`${this.opts.prefix}.computer`]: agent, [`${this.opts.prefix}.managed`]: "true" },
        volume: `${this.opts.prefix}-home-${agent}`,
      });
      this.set(agent, { container: id, state: "stopped", egress: want });
      this.emit("computer.created", { agent });
      this.log(`${agent}'s computer created`);
      st = { state: "exited", host: null };
    }
    const id = String(this.row(agent).container);
    const before = st.state;
    if (st.state === "paused") {
      await d.unpause(id);
      this.emit("computer.thawed", { agent });
    } else if (st.state === "exited") {
      await d.start(id);
    }
    await this.boot(agent, id);
    this.set(agent, { state: "running" });
    // A computer that just started or thawed joins the tailnet (when the switch is on), and so
    // does a running one that has no node yet. It never holds up the checkout.
    if (before !== "running" || !this.row(agent).stable_id) this.joinTailnet(agent);
  }

  /**
   * Wait for a started computer to answer on its screen port. Until now a container that died on
   * boot was marked running anyway: Glass then had nothing to connect to, and the freeze a minute
   * later failed with "container is not running" (the box's first real run, a missing vncpasswd).
   * A computer that stops, or never answers within bootMs, fails the checkout with the reason.
   * @param {string} agent @param {string} id
   */
  async boot(agent, id) {
    const d = /** @type {import("./driver/index.js").Driver} */ (this.driver);
    const deadline = Date.now() + this.opts.bootMs;
    for (;;) {
      const st = await d.inspect(id);
      if (st.state !== "running") {
        this.set(agent, { state: st.state === "missing" ? "none" : "stopped", ...(st.state === "missing" ? { container: null } : {}) });
        this.hosts.delete(agent);
        const code = st.exitCode != null ? ` (exit code ${st.exitCode})` : "";
        throw bootFailure(`${agent}'s computer stopped as soon as it started${code}`, `its image (${this.opts.image}) may be broken: see docker logs ${this.opts.prefix}-computer-${agent} on the box`);
      }
      if (st.host) this.hosts.set(agent, { host: st.host, ports: st.ports || { ...PORTS } });
      const h = this.hosts.get(agent);
      if (!this.probe || (h && await this.probe(h.host, h.ports.vnc))) return;
      if (Date.now() >= deadline) {
        throw bootFailure(`${agent}'s computer started but its screen did not answer within ${Math.round(this.opts.bootMs / 1000)} s`, `see docker logs ${this.opts.prefix}-computer-${agent} on the box`);
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  /** The limits a new container gets: the agent's own, else the box's. */
  limitsOf(r) {
    return { cpus: r && r.cpus != null ? Number(r.cpus) : this.opts.cpus, memoryMb: r && r.memory_mb != null ? Number(r.memory_mb) : this.opts.memoryMb };
  }

  /**
   * Set an agent's processor and memory limits. A container's limits are fixed when it is made,
   * so they apply at the next restart (which makes a new container on the same home).
   * @param {string} agent @param {{ cpus?: number, memory_gb?: number }} l
   */
  limits(agent, l) {
    const set = {};
    if (l.cpus !== undefined) {
      const n = Number(l.cpus);
      if (!Number.isInteger(n) || n < LIMITS.cpus.min || n > LIMITS.cpus.max) throw new Error(`cpus is a whole number of cores from ${LIMITS.cpus.min} to ${LIMITS.cpus.max}`);
      set.cpus = n;
    }
    if (l.memory_gb !== undefined) {
      const n = Number(l.memory_gb);
      if (!Number.isInteger(n) || n < LIMITS.memoryGb.min || n > LIMITS.memoryGb.max) throw new Error(`memory_gb is a whole number of GB from ${LIMITS.memoryGb.min} to ${LIMITS.memoryGb.max}`);
      set.memory_mb = n * 1024;
    }
    if (!Object.keys(set).length) throw new Error("say cpus or memory_gb");
    this.rowFor(agent);
    this.set(agent, set);
    return this.view(agent);
  }

  /**
   * Restart an agent's computer: a new container on the same home volume, with fresh passwords
   * and the agent's current limits. Chrome's profile and every file under /home/agent stay. A
   * checkout or take-over survives it; open Glass viewers reconnect.
   * @param {string} agent
   */
  async restart(agent) {
    if (!this.driver) throw new Error(NO_DRIVER);
    const d = this.driver;
    await this.allowed(agent);
    return this.serial(agent, async () => {
      const r = this.rowFor(agent);
      if (r.container) {
        try { await d.remove(String(r.container)); }
        catch (e) { throw new Error(`could not remove ${agent}'s old computer: ${/** @type {Error} */ (e).message}`); }
      }
      this.leftTailnet(agent);
      this.set(agent, { state: "none", container: null });
      this.hosts.delete(agent);
      await this.ensure(agent);
      if (!this.checkouts.has(agent)) this.idle.set(agent, this.now());
      this.log(`${agent}'s computer restarted`);
      return this.view(agent);
    });
  }

  // ---- the computer's own tailnet node (tailnet.js) --------------------------------------

  /** Start joining, unless the switch is off or a join is already under way. Never throws. */
  joinTailnet(agent) {
    if (!this.tailnet || this.joins.has(agent)) return;
    let cfg;
    try { cfg = this.tailnet.setting(); }
    catch (e) { this.log(`${agent}'s computer did not join the tailnet: ${/** @type {Error} */ (e).message}`); return; }
    if (!cfg.enabled) return;
    // The key goes only to a port the driver names for the tailnet side, never to computerd's own
    // port: computerd runs as the agent's uid, so the agent could stop it and answer there itself.
    if (!this.tailnetSide(agent)) { this.log(`${agent}'s computer did not join the tailnet: its image has no tailnet side apart from the agent's user (no tailnet port); the key was not sent`); return; }
    const ctl = new AbortController();
    const key = this.tailnet.key;
    const done = joinTailnet({ helper: () => /** @type {{ url: string, token: string }} */ (this.tailnetSide(agent)), key, agent, tag: cfg.tag, signal: ctl.signal, ...(this.wait ? { wait: this.wait } : {}) })
      .then(r => {
        if (ctl.signal.aborted) return;
        if (!r.joined) { this.log(`${agent}'s computer did not join the tailnet: ${r.why}`); return; }
        const had = this.row(agent);
        this.set(agent, { stable_id: r.stableId, node: r.node });
        if (!had || had.stable_id !== r.stableId) {
          this.emit("computer.joined", { agent, node: r.node, stableId: r.stableId });
          this.log(`${agent}'s computer joined the tailnet as ${r.node || r.stableId}`);
        }
      })
      .catch(e => this.log(`${agent}'s computer did not join the tailnet: ${/** @type {Error} */ (e).message}`))
      .finally(() => { if (this.joins.get(agent) && this.joins.get(agent).ctl === ctl) this.joins.delete(agent); });
    this.joins.set(agent, { ctl, done });
  }

  /** Where the computer's tailnet side answers, or null when the driver names no port for it. */
  tailnetSide(agent) {
    const h = this.hosts.get(agent), r = this.row(agent);
    if (!h || !r || !h.ports.tailnet) return null;
    return { url: `http://${h.host}:${h.ports.tailnet}`, token: String(r.helper_token) };
  }

  /** The node is gone with the computer: forget it, and say so once. */
  leftTailnet(agent) {
    const r = this.row(agent);
    if (!r || !r.stable_id) return;
    this.set(agent, { stable_id: null, node: null });
    this.emit("computer.left", { agent });
  }

  /**
   * The agent whose running computer joined as this node, or null. Only a stable id recorded at
   * join, and only while that computer is running: a frozen, stopped or vanished one maps to no one.
   * @param {string} stableId
   * @returns {string|null}
   */
  agentOfNode(stableId) {
    if (typeof stableId !== "string" || !stableId) return null;
    const r = /** @type {any} */ (this.db.prepare("SELECT agent, state FROM computers_computers WHERE stable_id = ?").get(stableId));
    if (!r || r.state !== "running" || !this.hosts.has(String(r.agent))) return null;
    return String(r.agent);
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
        if (st && st.state === "missing") { this.leftTailnet(agent); this.set(agent, { state: "none", container: null }); this.hosts.delete(agent); }
        // It died while nobody held it: say stopped, not running, until the next checkout starts it.
        else if (st && st.state === "exited") { this.leftTailnet(agent); this.set(agent, { state: "stopped" }); this.hosts.delete(agent); this.emit("computer.stopped", { agent }); }
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
      const joining = this.joins.get(agent);
      if (joining) { joining.ctl.abort(); await joining.done; }
      if (st.state === "missing") { this.leftTailnet(agent); this.set(agent, { state: "none", container: null }); this.hosts.delete(agent); return { stopped: false }; }
      // A frozen process cannot handle SIGTERM, so a stop would only ever end in the kill.
      if (st.state === "paused") await d.unpause(r.container);
      // A clean stop logs the node out. The node is ephemeral, so if this fails it still goes.
      const side = this.tailnetSide(agent);
      if (st.state !== "exited" && (this.row(agent).stable_id || joining) && side) {
        try { await leaveTailnet(side); }
        catch (e) { this.log(`${agent}'s node was not logged out (it is ephemeral and goes with the container): ${/** @type {Error} */ (e).message}`); }
      }
      if (st.state !== "exited") await d.stop(r.container);
      this.leftTailnet(agent);
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
      if (!c) { this.leftTailnet(r.agent); if (r.container || r.state !== "none") this.set(r.agent, { state: "none", container: null }); continue; }
      known.add(c.id);
      const state = c.state === "running" ? "running" : c.state === "paused" ? "frozen" : "stopped";
      if (state === "stopped") this.leftTailnet(r.agent);
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

  /**
   * A one-use ticket for opening Glass, bound to one agent and one surface. slow: the viewer is
   * on a relayed or slow link, and the relay paces its frame requests (glass.js).
   */
  ticket(agent, surface, { slow = false } = {}) {
    const now = this.now();
    for (const [k, t] of this.tickets) if (t.expires <= now) this.tickets.delete(k);
    const ticket = crypto.randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { agent, surface, slow: Boolean(slow), expires: now + TICKET_MS });
    return ticket;
  }

  /** Spend a ticket. Null when it is unknown, used or expired; a ticket works once either way. */
  redeem(ticket) {
    const t = this.tickets.get(String(ticket || ""));
    if (!t) return null;
    this.tickets.delete(String(ticket));
    if (t.expires <= this.now()) return null;
    return { agent: t.agent, surface: t.surface, slow: Boolean(t.slow) };
  }

  // ---- views -----------------------------------------------------------------------------

  /** One computer as tools show it. Never a password or token. */
  view(agent) {
    const r = this.row(agent), co = this.checkouts.get(agent);
    return {
      agent, state: r ? String(r.state) : "none", screen: co ? co.screen : null, thread: co ? co.thread : null,
      viewers: co ? co.viewers : 0, takeover: this.heldBy(agent), paused: Boolean(r && r.paused), size: this.size(agent),
      since: co ? co.since : r ? Number(r.updated) : null, screens: this.opts.screens,
      cpus: this.limitsOf(r).cpus, memory_gb: Math.round(this.limitsOf(r).memoryMb / 1024 * 10) / 10,
    };
  }
}

/**
 * A computer that did not boot. `short` is the part a person reads first (Glass shows it, and it
 * fits a WebSocket close reason); the message adds where to look on the box.
 * @param {string} short @param {string} more
 */
function bootFailure(short, more) {
  return Object.assign(new Error(`${short}; ${more}`), { boot: true, short });
}

/** Does something accept a TCP connection at host:port? Closed at once; never sends a byte. */
function tcpProbe(host, port) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(2_000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}
