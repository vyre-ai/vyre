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
  // A shared (browser-kind) computer, agent-browsers.md level 2 (team-lead schema, 28 Sep): adds
  // to the table rather than rekeying it, so every existing row (kind defaults to 'desktop') is
  // untouched. A desktop row's own `agent` column is still the one real agent it belongs to; a
  // browser row's `agent` is a synthetic pool id (newComputerId(), below) -- never a real agent's
  // own name -- and computers_members is who is actually sharing it. agent_id is the identity
  // (unique, never reused, matches cdpmux/computerd's own agentId); agent_name is display-only
  // and MAY repeat. generation is bumped to rotate a member's token without removing it (a new
  // generation, same id, a different derived token -- see memberToken()). No token column: per
  // the reviewer and the lead, a member's token is never stored, only derived on demand from a
  // vault-held key (memberTokenKey, the Pool constructor) over computer_id, agent_id and
  // generation, so this table alone is harmless if it ever leaked.
  `ALTER TABLE computers_computers ADD COLUMN kind TEXT NOT NULL DEFAULT 'desktop';
   CREATE TABLE computers_members (
     computer_id TEXT NOT NULL REFERENCES computers_computers(agent),
     agent_id TEXT NOT NULL,
     agent_name TEXT NOT NULL,
     generation INTEGER NOT NULL DEFAULT 0,
     added_at INTEGER NOT NULL,
     PRIMARY KEY (computer_id, agent_id)
   );
   CREATE UNIQUE INDEX computers_members_agent_id ON computers_members(agent_id);`,
  // The reviewer's LOW 1 (28 Sep): computers_members' own generation is lost when a member is
  // removed (the row is deleted outright), so re-adding the same agent id re-derived the SAME
  // token -- a leaked token had no rotate path once the agent came back. This ledger survives
  // removal (it is never deleted), so bumpGeneration() always hands out a number higher than any
  // this agent id has ever used, on this computer or a previous one.
  `CREATE TABLE computers_agent_generations (
     agent_id TEXT PRIMARY KEY,
     generation INTEGER NOT NULL
   );`,
];

/** What a person may set a computer's limits to. */
export const LIMITS = Object.freeze({ cpus: { min: 1, max: 16 }, memoryGb: { min: 1, max: 64 } });

/** How long a Glass ticket lives: long enough to open a WebSocket, too short to be worth stealing. */
export const TICKET_MS = 30_000;
const AGENT = /^[a-z][a-z0-9-]{0,40}$/;

// Said to a person, so it names no file and asks for no edit: what is wrong, in plain words.
export const NO_DRIVER = "Agents' computers are not turned on for this server, so this agent cannot start one.";

// VNC authentication (RFB's DES challenge) only ever uses the first eight bytes of a password,
// so the VNC password is eight characters. It guards a port on an internal network that only
// vyred reaches; the helper token, which carries more weight, gets the full 256 bits.
const vncPassword = () => crypto.randomBytes(6).toString("base64url");
const helperToken = () => crypto.randomBytes(32).toString("base64url");

/** A shared computer's own synthetic id (never a real agent's name): "browser-" plus 16 hex
 * characters, short enough to fit AGENT (and policy.js's own computerLabel regex, the same
 * shape) with room to spare. */
const newComputerId = () => `browser-${crypto.randomBytes(8).toString("hex")}`;

/**
 * A member's own CDP token, derived, never stored (the reviewer + lead, 28 Sep): HMAC-SHA256 of
 * "computerId|agentId|generation" under the vault-held key, base64url-encoded -- 43 characters,
 * comfortably inside policy.js's own [A-Za-z0-9_-]{32,128} token shape. Two different agent ids
 * (or the same id at two different generations) always derive two different tokens; the same
 * inputs always derive the same one, so a member's token never needs to be looked up anywhere,
 * only recomputed from what computers_members already has.
 * @param {string} key @param {string} computerId @param {string} agentId @param {number} generation
 */
function memberToken(key, computerId, agentId, generation) {
  return crypto.createHmac("sha256", key).update(`${computerId}|${agentId}|${generation}`).digest("base64url");
}

/**
 * @typedef {{ agent: string, thread: string|null, screen: number, since: number, touched: number, viewers: number, verified?: number }} Checkout
 */

/** What a person is told when the computer they were watching died, or is dead when they ask for its screen. */
export const STOPPED = "This computer stopped. Start it again?";
/** What a person is told when the container runtime cannot be asked about a computer. */
export const UNKNOWN = "Can't check this computer right now.";

export class Pool {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, driver: import("./driver/index.js").Driver|null,
   *   call: (tool: string, input: any) => Promise<any>, emit: (type: string, payload: any, where?: any) => any,
   *   log?: (m: string) => void, config?: any, now?: () => number, egress?: () => any,
   *   tailnet?: { setting: () => { enabled: boolean, tag: string }, key: () => Promise<string> },
   *   memberTokenKey?: () => Promise<string>,
   *   wait?: (ms: number) => Promise<void>, probe?: ((host: string, port: number) => Promise<boolean>) | null }} deps
   *   egress reads config glass.egress when a computer is made, so a change needs no restart.
   *   tailnet reads config computers.tailnet each time a computer starts, and fetches the auth key
   *   from the vault only then, only when that switch is on.
   *   memberTokenKey: a shared computer's members' tokens are derived (memberToken(), below),
   *   never stored -- this fetches the vault-held key they are derived from, only when a shared
   *   computer's membership actually changes (addAgent/removeAgent), the same lazy shape as
   *   tailnet's own key().
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
    this.memberTokenKey = deps.memberTokenKey || null;
    this.wait = deps.wait;
    // Is the computer's screen answering yet? Only the Docker driver has a real address to dial;
    // the fake's hosts are names nothing resolves, so its computers are ready once started.
    /** Agents whose computer died on its own since it last started: Glass tells a viewer so instead of starting it. @type {Set<string>} */
    this.died = new Set();
    /** Agents whose computer the runtime could not be asked about at the last check. @type {Set<string>} */
    this.unknown = new Set();
    /** When the sweep last looked at every running computer (its backstop runs once a minute). */
    this.lastVerify = -Infinity;
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

  /** Who holds the screens, for a person to read: "kit (watched by 1), juno (taken over by you)". */
  holders() {
    return [...this.checkouts.values()].map(c => {
      const h = this.heldBy(c.agent);
      // Only the owner can take over, so a held screen is theirs: "taken over by you".
      return `${c.agent} (${h ? "taken over by you" : c.viewers ? `watched by ${c.viewers}` : "working"})`;
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
        // No secret in Env: every docker exec inherits it. They go in by seed() below.
        env: { SCREEN: `${w}x${h}`, ...egress },
        labels: { [`${this.opts.prefix}.computer`]: agent, [`${this.opts.prefix}.managed`]: "true" },
        volume: `${this.opts.prefix}-home-${agent}`,
        browserVolume: `${this.opts.prefix}-browser-${agent}`,
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
      // The secrets, as a file only vyre's uid reads, before every start (policy.js bootTar).
      const s = this.row(agent);
      await d.seed(id, { computerd_token: String(s.helper_token), vnc_password: String(s.vnc_password) });
      // A shared computer's identity file MUST exist before computerd's own first read of it, on
      // EVERY start (a fresh container's first boot, and any later restart alike): AGENT_MODE is
      // decided once, at whatever moment computerd first reads the file, and never revisited --
      // seeding it only after start (reseedMembers, called from addAgent right after this) would
      // leave a fresh boot in legacy, unscoped mode for that whole process's life, no matter how
      // many times /agents/reload is called afterward. Always the CURRENT member list, the same
      // "reseed with the latest, every start" pattern .boot's own seed() just above already uses.
      if (s.kind === "browser") await this.seedMembersBeforeStart(agent, id);
      await d.start(id);
    }
    await this.boot(agent, id);
    this.set(agent, { state: "running" });
    this.died.delete(agent);
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
      // The screen AND computerd (its port answers a little after Xvnc: the first hands call right after a checkout used to hit a refused connection).
      // computerd starts after Xvnc, so its port answering means the screen is up too. The screen's own port is dialled
      // only when there is no computerd to ask: every connection to it that does not log in counts against Xvnc's
      // host blacklist, and enough of them make Glass's first real connection from this address refused.
      if (!this.probe) return;
      if (h && await this.probe(h.host, h.ports.helper ? h.ports.helper : h.ports.vnc)) {
        // Show computerd the token once: it then answers vyred's address alone (another computer on the network is refused).
        await this.pin(agent).catch(() => {});
        return;
      }
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
        else if (st && st.state === "exited") { this.leftTailnet(agent); this.set(agent, { state: "stopped" }); this.hosts.delete(agent); this.died.add(agent); this.emit("computer.stopped", { agent }); }
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

  /**
   * Make the computer's computerd (and its screen) answer this vyred and nothing else on the network: one authenticated
   * call pins vyred's address there. Done after a computer starts, and before a screen is opened, since vyred's own
   * address can change when its container is recreated while the computer keeps running.
   * @param {string} agent
   */
  async pin(agent) {
    const e = this.endpoint(agent).helper;
    const r = await fetch(new URL("/ping", e.url), { headers: { authorization: `Bearer ${e.token}` }, signal: AbortSignal.timeout(3_000) });
    if (!r.ok) throw new Error(`computerd answered ${r.status}`);
  }

  /**
   * Is the agent's computer still running? A container that died (killed, out of memory, crashed) is
   * marked stopped at once: its checkout and viewers are released, the tailnet node is forgotten, and
   * computer.stopped is emitted, so nothing keeps saying "running". Returns true when it was dead.
   * @param {string} agent
   */
  async verifyAlive(agent) {
    // Behind whatever is already happening to this computer (a stop of ours makes the same container exit, and must not read as a death).
    return this.serial(agent, async () => {
      const d = this.driver;
      const r = this.row(agent);
      if (!d || !r || r.state !== "running" || !r.container) return false;
      /** @type {any} */
      let st;
      try { st = await d.inspect(r.container); } catch { st = undefined; }
      // The runtime would not say: the computer is neither running nor dead as far as anyone knows. It is shown as unknown,
      // never as running, until a check succeeds.
      if (st === undefined) { this.unknown.add(agent); return false; }
      this.unknown.delete(agent);
      if (!st || st.state === "running" || st.state === "paused") return false;
      this.leftTailnet(agent);
      this.release(agent, "stopped");
      this.set(agent, st.state === "missing" ? { state: "none", container: null } : { state: "stopped" });
      this.hosts.delete(agent);
      this.died.add(agent);
      this.emit("computer.stopped", { agent, died: true });
      this.log(`${agent}'s computer died (${st.state}${st.exitCode != null ? `, exit code ${st.exitCode}` : ""})`);
      return true;
    });
  }

  /**
   * Hear about a computer's death from the container runtime instead of polling for it: the driver's event stream
   * (die, oom, kill, stop) names the container, and that computer is checked at once. After a reconnect every running
   * computer is checked once, since an event can be lost while the stream is down. Returns a stop function; a driver with
   * no event stream (the fake, or a runtime without one) leaves the sweep's backstop as the only signal.
   */
  watchDeaths() {
    const d = /** @type {any} */ (this.driver);
    if (!d || typeof d.watchEvents !== "function") return () => {};
    const all = () => { for (const r of this.rows()) if (r.state === "running") this.verifyAlive(r.agent).catch(() => {}); };
    const w = d.watchEvents(e => {
      const r = this.rows().find(x => x.container && (x.container === e.id || String(x.container).startsWith(e.id) || e.id.startsWith(String(x.container))));
      if (r && r.state === "running") this.verifyAlive(r.agent).catch(() => {});
    }, { onGap: all, log: m => this.log(m) });
    return () => w.stop();
  }

  /** Release idle checkouts and freeze computers idle past freezeMs. index.js calls it on a timer, tests by hand. */
  async sweep() {
    // The backstop for a death the runtime's event stream did not report (no stream, or an event lost): one local inspect
    // per running computer, at most once a minute (SPEC principle 8), however often the sweep itself runs.
    if (this.now() - this.lastVerify >= 55_000) {
      this.lastVerify = this.now();
      for (const r of this.rows()) if (r.state === "running") await this.verifyAlive(r.agent).catch(() => {});
    }
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
    // vyred's address can change while a computer keeps running (its container recreated). computerd re-pins on the first
    // valid token from the new address, so show each running computer the token once after a start.
    if (this.probe) for (const r of this.rows()) if (r.state === "running" && this.hosts.has(r.agent)) await this.pin(r.agent).catch(() => {});
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

  // ---- shared (browser-kind) computers, agent-browsers.md level 2 ------------------------
  //
  // A browser-kind row is made and driven through exactly the same machinery as a desktop row
  // (rowFor/ensure/boot/endpoint all key off the `agent` column generically, and never assumed it
  // was a real agent's own name) -- the only things genuinely new here are the row's own kind,
  // the members table, and computerd's identity file. `computerId` is the row's own synthetic id
  // (newComputerId(), never a real agent), used everywhere a desktop call would take an agent name.

  /** @returns {any} */
  members(computerId) { return /** @type {any[]} */ (this.db.prepare("SELECT * FROM computers_members WHERE computer_id = ? ORDER BY agent_id").all(computerId)); }

  /**
   * Add an agent to a shared computer, making the computer first if computerId names none yet.
   * Both add and remove reload computerd's own identity file (the reviewer + lead, 28 Sep): a
   * membership change that only reseeds the file, with nobody ever asking computerd to notice,
   * would leave the new agent unable to connect until something else happened to restart it.
   * @param {string} computerId @param {string} agentId @param {string} agentName
   */
  async addAgent(computerId, agentId, agentName) {
    if (!AGENT.test(String(computerId || ""))) throw new Error(`"${computerId}" is not a computer id`);
    if (!AGENT.test(String(agentId || ""))) throw new Error(`"${agentId}" is not an agent id`);
    return this.serial(computerId, async () => {
      // LOW 2 (reviewer, 28 Sep): an agent belongs to at most one shared computer at a time.
      // computers_members_agent_id's own unique index enforces this at the storage layer, but the
      // ON CONFLICT below would otherwise silently reseed this agent onto THIS computer while it
      // still looks (to anything querying computers_members) like a member of whichever one it
      // was already on. Checked and refused, loudly, BEFORE anything else here -- including
      // making computerId's own row, if it did not exist yet, which a refused call must leave no
      // trace of at all, not an empty shared computer nobody asked for.
      const elsewhere = /** @type {any} */ (this.db.prepare("SELECT computer_id FROM computers_members WHERE agent_id = ?").get(agentId));
      if (elsewhere && elsewhere.computer_id !== computerId) {
        throw new Error(`${agentId} is already a member of ${elsewhere.computer_id}; remove it there first`);
      }
      const madeComputer = !this.row(computerId);
      let r = this.row(computerId);
      if (!r) {
        const at = this.now();
        this.db.prepare(`INSERT INTO computers_computers (agent, container, state, vnc_password, helper_token, paused, created, updated, kind)
          VALUES (?, NULL, 'none', ?, ?, 0, ?, ?, 'browser')`).run(computerId, vncPassword(), helperToken(), at, at);
        r = this.row(computerId);
      } else if (r.kind !== "browser") {
        throw new Error(`${computerId} already exists and is not a shared computer`);
      }
      // reviewer's LOW 2 (29 Sep): failure below (ensure() or the reseed can fail, e.g. no
      // memberTokenKey or computerd unreachable) must not leave a member row nobody asked for
      // behind. Remembered here, before the insert, so a genuinely new member is deleted outright
      // on failure, and an already-existing one (this same call, retried, or any other reason
      // addAgent runs again for a member already here) is put back exactly as it was rather than
      // removed. The ledger's own bump is never rolled back -- it is meant to only ever go up, and
      // a generation skipped by a failed attempt is not a bug, just one never handed out.
      const before = /** @type {any} */ (this.db.prepare("SELECT agent_name, generation FROM computers_members WHERE computer_id = ? AND agent_id = ?").get(computerId, agentId));
      const generation = this.bumpGeneration(agentId);
      this.db.prepare(`INSERT INTO computers_members (computer_id, agent_id, agent_name, generation, added_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET agent_name = excluded.agent_name, generation = excluded.generation`)
        .run(computerId, agentId, agentName, generation, this.now());
      try {
        await this.ensure(computerId);
        await this.reseedMembers(computerId);
      } catch (e) {
        if (before) {
          this.db.prepare("UPDATE computers_members SET agent_name = ?, generation = ? WHERE computer_id = ? AND agent_id = ?")
            .run(before.agent_name, before.generation, computerId, agentId);
        } else {
          this.db.prepare("DELETE FROM computers_members WHERE computer_id = ? AND agent_id = ?").run(computerId, agentId);
          if (madeComputer) {
            // reviewer's LOW (29 Sep): ensure() may have already created, seeded, even started a
            // real container before a later step (boot, or the reseed) failed -- deleting the row
            // outright would orphan it: nothing in computers_computers would ever name it again for
            // freeze/sweep/reconcile to find. Tear down whatever exists before removing the row, so
            // "no trace" means the driver's own state too, not just this table. Best-effort: a
            // driver that is already gone or already stopped must not block the row's own cleanup.
            const cur = this.row(computerId);
            if (cur && cur.container && this.driver) {
              try { await this.driver.stop(String(cur.container)); } catch {}
              try { await this.driver.remove(String(cur.container)); } catch {}
              this.hosts.delete(computerId);
            }
            this.db.prepare("DELETE FROM computers_computers WHERE agent = ?").run(computerId);
          }
        }
        throw e;
      }
      this.emit("computer.member-added", { computer: computerId, agent: agentId, generation });
      this.log(`${agentId} added to shared computer ${computerId} (generation ${generation})`);
      return { computer: computerId, generation };
    });
  }

  /**
   * The next generation for an agent id, from a ledger that is never deleted (unlike
   * computers_members, whose row disappears on removeAgent) -- so a generation, once used, is
   * never handed out again for this agent, on this computer or a different one later. Always
   * one higher than any this agent id has ever used.
   * @param {string} agentId @returns {number}
   */
  bumpGeneration(agentId) {
    const cur = /** @type {any} */ (this.db.prepare("SELECT generation FROM computers_agent_generations WHERE agent_id = ?").get(agentId));
    const next = cur ? cur.generation + 1 : 0;
    this.db.prepare(`INSERT INTO computers_agent_generations (agent_id, generation) VALUES (?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET generation = excluded.generation`).run(agentId, next);
    return next;
  }

  /**
   * Rotate a member's own token without taking it off the computer -- the reviewer's LOW 1 (28
   * Sep): a leaked token needs a path to invalidate itself that does not require removeAgent then
   * addAgent, which would also churn the membership row's own added_at and emit remove/add events
   * for something that never actually left.
   * @param {string} computerId @param {string} agentId
   */
  async rotateAgent(computerId, agentId) {
    return this.serial(computerId, async () => {
      const r = this.row(computerId);
      if (!r || r.kind !== "browser") throw new Error(`${computerId} is not a shared computer`);
      const had = this.db.prepare("SELECT 1 FROM computers_members WHERE computer_id = ? AND agent_id = ?").get(computerId, agentId);
      if (!had) throw new Error(`${agentId} is not on ${computerId}`);
      const generation = this.bumpGeneration(agentId);
      this.db.prepare("UPDATE computers_members SET generation = ? WHERE computer_id = ? AND agent_id = ?").run(generation, computerId, agentId);
      await this.reseedMembers(computerId);
      this.emit("computer.member-rotated", { computer: computerId, agent: agentId, generation });
      this.log(`${agentId}'s token on ${computerId} rotated (generation ${generation})`);
      return { computer: computerId, agent: agentId, generation };
    });
  }

  /**
   * Remove an agent from a shared computer. If it was the last one, the container is stopped --
   * never removed, and never its volume -- so its members' cookies and logins survive; deleting
   * them is disposeContext()'s own job, a separate, explicit action a person previews first (the
   * lead's ruling, 28 Sep), never a side effect of removal.
   * @param {string} computerId @param {string} agentId
   */
  async removeAgent(computerId, agentId) {
    return this.serial(computerId, async () => {
      const r = this.row(computerId);
      if (!r || r.kind !== "browser") throw new Error(`${computerId} is not a shared computer`);
      const had = this.db.prepare("SELECT 1 FROM computers_members WHERE computer_id = ? AND agent_id = ?").get(computerId, agentId);
      if (!had) throw new Error(`${agentId} is not on ${computerId}`);
      this.db.prepare("DELETE FROM computers_members WHERE computer_id = ? AND agent_id = ?").run(computerId, agentId);
      const left = /** @type {any} */ (this.db.prepare("SELECT COUNT(*) AS n FROM computers_members WHERE computer_id = ?").get(computerId)).n;
      this.emit("computer.member-removed", { computer: computerId, agent: agentId });
      this.log(`${agentId} removed from shared computer ${computerId}`);
      if (left === 0) {
        const cur = this.row(computerId);
        if (cur.container && cur.state === "running") { await this.driver.stop(String(cur.container)); this.hosts.delete(computerId); }
        this.set(computerId, { state: cur.container ? "stopped" : "none" });
        this.log(`${computerId} has no members left; stopped, its volume kept`);
        return { computer: computerId, stopped: true };
      }
      // Deleting the row is not enough on its own: computerd's own copy is the FILE, not this
      // table, and it only notices a change when the file is rewritten (reseedMembers, not just
      // reloadMembers) and then reloaded -- omitting the deleted id from the file entirely is
      // what actually revokes it, the same way an add's file rewrite is what lets a new one in.
      await this.reseedMembers(computerId);
      return { computer: computerId, stopped: false };
    });
  }

  /**
   * Recomputes every current member's token and writes the whole list to computerd
   * (seedAgentTokens), then tells computerd to reload it. Used after an add (a new member must
   * be seeded before it can connect) and, indirectly, after a removal that leaves members behind
   * (reloadMembers, below, does the reload half alone since the file need not be rewritten to
   * remove a name from computerd's own live map -- computerd's own reload already refuses to
   * revoke by omission of a still-valid pair, so the file DOES need rewriting either way; kept as
   * one path for clarity, not two that could drift).
   * @param {string} computerId
   */
  async reseedMembers(computerId) {
    const wrote = await this._writeMemberTokens(computerId);
    if (wrote) await this.reloadMembers(computerId);
  }

  /**
   * Writes the current member list's derived tokens to computerd's .agent-tokens (seedAgentTokens
   * alone -- no reload, since the container may not even be running yet). Called from ensure(),
   * right before a browser-kind container's every start (so the file exists before computerd's
   * own first read of it), and from reseedMembers, right before telling a running one to reload.
   * @param {string} computerId @param {string} [containerId] known already by ensure(); looked
   *   up from the row otherwise.
   * @returns {Promise<boolean>} whether there was anyone to write (false only means "no members
   *   at all", which removeAgent handles itself; ensure() never calls this with zero members).
   */
  async _writeMemberTokens(computerId, containerId) {
    if (!this.driver) throw new Error(NO_DRIVER);
    if (!this.memberTokenKey) throw new Error("no member-token key configured (computers.memberTokenKey)");
    const members = this.members(computerId);
    if (members.length === 0) return false;
    const key = await this.memberTokenKey();
    const agents = members.map(m => ({ id: m.agent_id, name: m.agent_name, token: memberToken(key, computerId, m.agent_id, m.generation) }));
    const id = containerId || String(this.row(computerId).container);
    await this.driver.seedAgentTokens(id, agents);
    return true;
  }

  /**
   * ensure()'s own hook, called right before a browser-kind container's `start` (see there for
   * why this cannot wait until after start). Not exported beyond this file's own use in ensure().
   * @param {string} computerId @param {string} containerId
   */
  async seedMembersBeforeStart(computerId, containerId) {
    await this._writeMemberTokens(computerId, containerId);
  }

  /**
   * Tells computerd to re-read AGENT_TOKENS_FILE (POST /agents/reload), the owner token only --
   * the same control-plane class as the shield. Only meaningful while the computer is actually
   * running; a stopped one has nothing listening, and reseedMembers on the next start (ensure's
   * own seed()) carries the current membership anyway.
   * @param {string} computerId @param {string} [why] a removed agent id, for the log line only
   */
  async reloadMembers(computerId, why) {
    const r = this.row(computerId);
    if (!r || r.state !== "running" || !this.hosts.has(computerId)) return;
    const h = this.endpoint(computerId).helper;
    const res = await this._helperFetch(new URL("/agents/reload", h.url), { method: "POST", headers: { authorization: `Bearer ${h.token}` } });
    let body; try { body = await res.json(); } catch { body = null; }
    if (!res.ok) throw new Error(`computerd refused to reload ${computerId}'s agents: ${(body && body.error && body.error.message) || res.status}`);
    if (why) this.log(`${computerId} reloaded after removing ${why}${body && body.revoked && body.revoked.length ? `; revoked ${body.revoked.join(", ")}` : ""}`);
    return body;
  }

  /**
   * fetch(), tolerating computerd's own startup lag: ensure()'s boot() only waits for the VNC
   * port (5900) to answer, since that is what a desktop-kind checkout actually needs -- computerd
   * itself (7000) can still be a moment behind it, real on the box (found live, 28 Sep: the very
   * first reload right after a fresh browser-kind computer's own first start hit ECONNREFUSED).
   * Retries a connection failure only (never a real HTTP error, which is computerd's own answer,
   * not its absence) for up to 10s, the same order of magnitude as a VNC probe's own patience.
   * @param {URL} url @param {RequestInit} init
   */
  async _helperFetch(url, init) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(3_000) });
      } catch (e) {
        if (Date.now() >= deadline) throw e;
        await new Promise(r => setTimeout(r, 250));
      }
    }
  }

  /**
   * The explicit, previewed deletion of one member's browser context (cookies, logins) -- never
   * a side effect of removeAgent, a reload, or a crash (the reviewer + lead, 28 Sep). A caller
   * should removeAgent first if the member is still on the computer; this alone does not close
   * any live client. Only meaningful while the computer is running.
   * @param {string} computerId @param {string} agentId
   */
  async disposeContext(computerId, agentId) {
    const r = this.row(computerId);
    if (!r || r.kind !== "browser") throw new Error(`${computerId} is not a shared computer`);
    // reviewer's LOW 1 (29 Sep): dispose wipes the context computerd hands out on the agent's
    // NEXT connection, not the one it may be mid-session on right now -- disposing a still-member
    // agent would hand its live client a fresh context out from under it without warning. Refuse
    // while the agent is still on the computer; removeAgent first (which itself never disposes).
    const stillMember = this.db.prepare("SELECT 1 FROM computers_members WHERE computer_id = ? AND agent_id = ?").get(computerId, agentId);
    if (stillMember) throw new Error(`${agentId} is still a member of ${computerId}; remove it first, then dispose`);
    if (r.state !== "running" || !this.hosts.has(computerId)) throw new Error(`${computerId} is not running; nothing to tell computerd`);
    const h = this.endpoint(computerId).helper;
    const res = await this._helperFetch(new URL("/agents/dispose", h.url), {
      method: "POST", headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: agentId }),
    });
    let body; try { body = await res.json(); } catch { body = null; }
    if (!res.ok) throw new Error(`computerd refused to dispose ${agentId}'s context: ${(body && body.error && body.error.message) || res.status}`);
    this.log(`${agentId}'s browser context on ${computerId} disposed`);
    return Boolean(body && body.disposed);
  }

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
      agent, state: r ? (this.unknown.has(agent) && r.state === "running" ? "unknown" : String(r.state)) : "none", screen: co ? co.screen : null, thread: co ? co.thread : null,
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
