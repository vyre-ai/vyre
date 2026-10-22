// @ts-check
// computers: each agent's own computer, a shared pool of screens, and take-over (docs/SPEC.md
// section 7.9, team/archive/work-journals/computers.md, ADR 0003).
//
// This file is the tool layer: it decides whose computer a caller may touch and hands the work
// to the pool (containers and screens) and the keyboard (take-over). The switchboard and the
// agents module are used through ctx.call only, and may be missing: this module still starts,
// and says what it cannot do.
//
// Which agent: an agent's own hands call as `mcp:agent:<name>` and get their own computer. Only
// the assistant may name another agent's. Everyone else (the CLI, the Deck, a module) must say
// which agent they mean.
//
// No tool here ever returns or emits the VNC password or the helper token. The one exception is
// computers.endpoint, which is internal (modules only): the hands need the token to reach
// computerd, and they hold it in memory, never in a result they pass on.

import crypto from "node:crypto";
import { cleanLabel } from "../../lib/devicename.js";
import { Pool, MIGRATIONS, NO_DRIVER, LIMITS, STOPPED, UNKNOWN } from "./pool.js";
import { AgentUsers, MIGRATIONS as AGENT_USER_MIGRATIONS } from "./agent-users.js";
import { agentdCtl, execTransport, vncPasswordFor, RELAY_PORT } from "./agentd-ctl.js";
import { SHARED_COMPUTER_ID } from "../../lib/browser-access.js";
import { registerAgentTools } from "./agent-tools.js";
import { ComputerUpdater, assertOwner, trackTurns, sleepAgentsWhenStopped, MIGRATIONS as UPDATE_MIGRATIONS } from "./update.js";
import fs from "node:fs";
import { makeAgentEndpoint } from "./agent-endpoint.js";
import { makeAgentRun } from "./agent-run.js";
import { makeAgentFiles } from "./agent-files.js";
import { registerDeskAsk } from "./desk-ask.js";
import { createCdpAdapter } from "./cdp-adapter.js";
import { Keyboard, isSurface, idleMsOf, IDLE_CHOICES, IDLE_WARN_MS } from "./keyboard.js";
import { FakeDriver } from "./driver/fake.js";
import { DockerDriver } from "./driver/docker.js";
import { Shield } from "./shield.js";
import { Fills } from "./fill.js";
import { tellComputerd } from "./helper.js";
import { SharedBrowser } from "./shared-browser.js";
import { AgentBrowser } from "./agent-browser.js";
import { BrowserGlass } from "./browser-glass.js";
import { BrowserProfiles, AGENT_BROWSER_PROFILE_KEY } from "./browser-profiles.js";
import { resolveMemberBrowserProfileKey } from "../../lib/member-browser-profile-key.js";
import { resolveAgentBrowserProfileKey } from "../../lib/agent-browser-profile-key.js";
import { createMemberKey } from "./member-key.js";
import { personIdOf } from "./person-id.js";
import { beginPrivateMemberBrowser, sealMemberBrowserOnHandback } from "./member-browser-handback.js";
import * as config from "../config/index.js";
import { ensure as ensureBearer } from "../../lib/bearer/index.js";
import { agentClaim } from "../modules/index.js";
import { effectiveComputers } from "../../lib/computers-env.js";
import { plainError, plainComputerError, NO_EXEC_WORDS } from "./plain.js";
import { glassComputers } from "./glass-map.js";
import { AGENT_NAME_RE, modelSessionMustClaimAgent, resolveComputerAgent } from "../../lib/computer-agent.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const AGENT = AGENT_NAME_RE;
/** The person's own surfaces; a module hop is checked against the original caller by the registry. */
const PEOPLE = ["cli", "local", "deck", "capsule", "tailnet", "device"];
/** An agent's own hands (mcp:agent:<name>, a model session) and the harness; only the tools that act on the caller's OWN computer list them. */
const OWN = [...PEOPLE, "module", "mcp", "harness"];

/** The vault item a shared computer's member tokens are derived from (pool.js's memberToken()) --
 * declared in module.json's needs.vault, the same shape as any vault item a module needs. Never
 * generated here: like every other vault item, a person puts it in (vault.put, HUMAN_ONLY)
 * before the first computers.member.add that needs it; fetched fresh each time, never cached, so
 * a person rotating it in the vault directly takes effect on the very next add/rotate/reseed. */
const MEMBER_TOKEN_ITEM = "vyre-shared-computer-member-key";

/** The default path for the docker-api bearer, in a volume box/compose.yml shares between the
 * vyre and docker-api services only -- never vyre-agent's home, and never either process's Env. */
const DEFAULT_BEARER_FILE = "/var/lib/vyre-secrets/docker-api-bearer";

/**
 * The driver the settings in effect ask for (lib/computers-env.js effectiveComputers): the Docker proxy when `computers.docker` is set,
 * which on a box (VYRE_SUPERVISOR=docker) is the docker-api service by default, with the image, network and label prefix its create policy
 * pins; the fake when `computers.driver` is "fake"; else none (`computers.enabled: false` turns a box's off). There is deliberately no
 * fallback to the raw socket. vyred owns the bearer file (bearer.ensure): it generates one here, and docker-api reads it again on the
 * first request that carries it, whichever container started first.
 * @param {any} cfg the computers section of config.json @param {string} key @param {Record<string, string | undefined>} [env]
 * @returns {import("./driver/index.js").Driver|null}
 */
export function pickDriver(cfg, key, env = process.env) {
  const c = effectiveComputers(cfg, env);
  if (c.docker) return new DockerDriver({ url: String(c.docker), bearer: ensureBearer(c.dockerBearerFile || DEFAULT_BEARER_FILE),
    labelPrefix: c.labelPrefix, network: c.network, capAdd: c.capAdd });
  if (c.driver === "fake") return FakeDriver.for(key, c.local ? { local: c.local } : {});
  return null;
}

/** @type {{ start(ctx: any): Promise<any> }} */
export default {
  async start(ctx) {
    ctx.store.migrate([...MIGRATIONS, ...AGENT_USER_MIGRATIONS, ...UPDATE_MIGRATIONS]);
    // The settings in effect, read live (config can change while vyred runs): config.json's own over what a box implies (lib/computers-env.js).
    const liveCfg = () => effectiveComputers((ctx.config && ctx.config.computers) || {});
    const cfg = liveCfg();
    const driver = pickDriver(cfg, ctx.paths ? ctx.paths.root : "default");
    const emit = (type, payload, where) => ctx.events.emit(type, payload, where);
    // The key every shared-computer member token and every agent's VNC password is derived from: a Space vault item only this module reads. Nothing else provisions it, so the first use makes it (random, 32 bytes),
    // once even when calls race, and reads it back through the same declared-needs check as any later use. If it cannot be made (the vault is locked) the caller gets the vault's own refusal.
    const memberKey = createMemberKey({
      fetch: () => ctx.vault.fetch(MEMBER_TOKEN_ITEM),
      put: async value => {
        const r = await ctx.call("vault.put", { name: MEMBER_TOKEN_ITEM, kind: "secret", description: "Derives the shared computers' member tokens and the agents' screen passwords (created automatically).", fields: { value, made_by: "computers" }, grants: ["computers"], onlyIfAbsent: true });
        if (r && r.error) throw new Error(r.error.message);
        return r && r.data;
      } });
    const pool = new Pool({ db: ctx.store.db, driver, call: ctx.call, emit, log: ctx.log, config: cfg,
      memberTokenKey: () => memberKey() });
    const dataRoot = (ctx.paths && ctx.paths.data) || (ctx.paths && ctx.paths.root ? `${ctx.paths.root}/data` : "data");
    pool.browserProfiles = new BrowserProfiles({
      pool,
      dataRoot,
      agentKey: () => resolveAgentBrowserProfileKey(ctx.call),
      memberKey: personId => resolveMemberBrowserProfileKey(ctx.call, personId),
      log: ctx.log,
    });
    // Live too: computers.handback.set changes the idle hand-back for a take-over already running.
    const idleMin = () => liveCfg().handbackIdleMin;
    const shared = new SharedBrowser({ pool, call: ctx.call, cfg: liveCfg, log: ctx.log });
    const agentBrowser = new AgentBrowser({ pool, shared, cfg: liveCfg });
    const handbackDeps = { agentBrowser, shared, browserProfiles: pool.browserProfiles, log: ctx.log };
    const keyboard = new Keyboard({
      pool, shared, call: ctx.call, emit, on: ctx.events.on, log: ctx.log, idleMs: () => idleMsOf(idleMin()),
      onHandback: (agent, t) => sealMemberBrowserOnHandback(handbackDeps, agent, { personId: String(t.personId), browserSnap: t.browserSnap }),
    });
    // With the space's computer up, an agent's Chrome is its own and the shield and the fill's window are kept by the Chrome link (cdp-adapter.js); otherwise the shared browser's computerd does it.
    const helperFor = async agent => {
      if (!agentdReady()) return agentBrowser.helper(agent);
      await agentTools.place(agent); await agentUsers.wake(agent);
      return cdpAdapter.endpoint(agent);
    };
    const shield = new Shield({ pool, emit, on: ctx.events.on, log: ctx.log, tell: (agent, on, o) => agentdReady() ? cdpAdapter.shield(agent, on, o) : tellComputerd(pool, agent, on,
      { ...o, computerRow: agentBrowser.computerRow(agent) }, a => helperFor(a)) });
    const fills = new Fills({ pool, shield, keyboard, emit, on: ctx.events.on, log: ctx.log, helper: helperFor, register: (agent, values) => cdpAdapter.register(agent, values) });

    if (!driver) ctx.log(`no computer driver configured (computers.docker is not set${cfg.enabled === false || cfg.driver === "none" ? ", and config.json turns computers off" : " and this is not a box"}); computers cannot start`);
    else {
      if (!(ctx.config && ctx.config.computers && ctx.config.computers.docker) && cfg.docker) ctx.log(`computers: this box's docker-api at ${cfg.docker}, image ${cfg.image}, network ${cfg.network}, label prefix ${cfg.labelPrefix}${cfg.agentUsers === true ? ", an agent user each" : ""}`);
      try { await pool.reconcile(); }
      catch (e) { ctx.log(`could not reconcile computers with the ${driver.name} driver: ${/** @type {Error} */ (e).message}`); }
    }

    // Glass is a separate file with its own failure modes (a relay and an RFB parser). A broken
    // or missing one costs the stream, never the pool or the hands.
    /** @type {any} */
    let glass = null;
    /** @type {BrowserGlass|null} */
    let browserGlass = null;
    // How many viewers have each agent's own screen open: a watched agent is not put to sleep for being idle.
    /** @type {Map<string, number>} */
    const screenViewers = new Map();
    /** The agent's own screen for Glass: its relay on the space's computer, a ticket agentd was told about, and the agent's own VNC password. (agentUsers is made below; this runs on a connection, long after.) */
    const agentScreen = {
      open: async (/** @type {string} */ agent) => {
        await agentUsers.wake(agent);
        const h = pool.hosts.get(SHARED_COMPUTER_ID);
        if (!h) throw notSet();
        // the relay lets in vyred's address only: have the computer pin this vyred's address (it can change when vyred is recreated) before the ticket
        await pool.pin(SHARED_COMPUTER_ID);
        const hello = crypto.randomBytes(24).toString("base64url");
        await agentUsers.screenTicket(agent, hello);
        const password = vncPasswordFor(await memberKey(), agent);
        screenViewers.set(agent, (screenViewers.get(agent) || 0) + 1);
        let released = false;
        return { host: h.host, port: RELAY_PORT, password, hello: `${hello}\n`, release: () => { if (released) return; released = true; screenViewers.set(agent, Math.max(0, (screenViewers.get(agent) || 1) - 1)); agentUsers.touch(agent); } };
      },
    };
    /** The agent's Chrome for the code that drives it (hands, fill): a ticket with the relay for its debugging pipe, held as one link per agent in the adapter (cdp-adapter.js). */
    const cdpAdapter = createCdpAdapter({ log: ctx.log, open: async (/** @type {string} */ agent) => {
      const h = pool.hosts.get(SHARED_COMPUTER_ID);
      if (!h) throw notSet();
      await pool.pin(SHARED_COMPUTER_ID);
      const hello = crypto.randomBytes(24).toString("base64url");
      await agentUsers.cdpTicket(agent, hello);
      screenViewers.set(agent, (screenViewers.get(agent) || 0) + 1);
      let released = false;
      return { host: h.host, port: RELAY_PORT, hello: `${hello}\n`, release: () => { if (released) return; released = true; screenViewers.set(agent, Math.max(0, (screenViewers.get(agent) || 1) - 1)); agentUsers.touch(agent); } };
    } });
    /** The agent's terminal for the terminal stream: a one-use ticket with the relay (agentd-relay.js), which starts the terminal as the agent. */
    const agentTerminal = {
      openTerminal: async (/** @type {string} */ agent, /** @type {string} */ session) => {
        const h = pool.hosts.get(SHARED_COMPUTER_ID);
        if (!h) throw notSet();
        await pool.pin(SHARED_COMPUTER_ID);
        const hello = crypto.randomBytes(24).toString("base64url");
        await agentUsers.terminalTicket(agent, hello, session);
        screenViewers.set(agent, (screenViewers.get(agent) || 0) + 1);
        let released = false;
        return { host: h.host, port: RELAY_PORT, hello: `${hello}\n`, release: () => { if (released) return; released = true; screenViewers.set(agent, Math.max(0, (screenViewers.get(agent) || 1) - 1)); agentUsers.touch(agent); } };
      },
    };
    try {
      const { Terminal } = await import("./terminal.js");
      const terminal = new Terminal({ pool, screen: agentTerminal, log: ctx.log });
      ctx.upgrade("terminal", (req, socket, head, info) => terminal.handle(req, socket, head, info));
    } catch (e) { ctx.log(`terminal not available: ${/** @type {Error} */ (e).message}`); }
    try {
      const { Glass } = await import("./glass.js");
      glass = new Glass({ pool, keyboard, log: ctx.log, screen: agentScreen });
      ctx.upgrade("glass", (req, socket, head, info) => glass.handle(req, socket, head, info));
      browserGlass = new BrowserGlass({ pool, agentBrowser, keyboard, log: ctx.log });
      ctx.upgrade("browser-glass", (req, socket, head, info) => browserGlass.handle(req, socket, head, info));
    } catch (e) {
      glass = null;
      browserGlass = null;
      ctx.log(`glass not available: ${/** @type {Error} */ (e).message}`);
    }

    // The real clock, only here. Tests call sweep() themselves with sweepMs 0.
    //
    // A computer waiting to freeze (in pool.idle) needs a check soon after its freezeMs, so the
    // sweep runs at sweepMs while anything is checked out, held idle-pending-freeze, or taken
    // over. Once every computer is either actively watched or already frozen/stopped, there is
    // nothing sweep() can do, so it backs off to idleSweepMs - once a minute by default, per
    // SPEC's floor on polling an install that isn't using computers at all (found by perf).
    const sweepMs = Number(cfg.sweepMs ?? 5_000);
    const idleSweepMs = Number(cfg.idleSweepMs ?? 60_000);
    const sweep = async () => { keyboard.sweep(); await pool.sweep(); await agentUsers.sweep(agent => keyboard.takeovers.has(agent) || pool.checkouts.has(agent) || (screenViewers.get(agent) || 0) > 0).catch(e => ctx.log(`agent screens: ${/** @type {Error} */ (e).message}`)); };
    const busy = () => pool.checkouts.size > 0 || pool.idle.size > 0 || keyboard.takeovers.size > 0;
    let sweeping = false, timer = null, autoUpdateTimer = null;
    const schedule = () => {
      if (sweepMs <= 0) return;
      timer = setTimeout(async () => {
        if (!sweeping) {
          sweeping = true;
          try { await sweep(); } catch (e) { ctx.log(`sweep failed: ${e.message}`); }
          sweeping = false;
        }
        schedule();
      }, busy() ? sweepMs : idleSweepMs);
      timer.unref();
    };
    schedule();
    // The runtime tells us when a computer dies (docker events through the proxy); the sweep is only the backstop.
    // One stream for the module's life: opened here once, never per sweep tick.
    const stopDeaths = pool.watchDeaths();

    /** The agents module's view of one agent, or null when it cannot say. */
    const kindOf = async name => {
      const r = await ctx.call("agents.list", {});
      if (r.error) return null;
      const a = (r.data || []).find(x => x && x.name === name);
      return a ? String(a.kind) : null;
    };

    /**
     * Whose computer this call is about. `agentClaim` (core/modules) finds the agent behind any
     * transport shape, not only "mcp:agent:<name>" - a caller vouched under another surface
     * ("cli agent:<name>", what a person's own CLI gets when an agent runs inside it) gets the
     * same self-or-assistant rule as an agent's own MCP hands (hands-desktop's resolveAgent had
     * the same narrower gap, e2e review 2026-09-28).
     */
    const resolve = (input, caller) => resolveComputerAgent(input, caller, kindOf);
    const ownOnly = modelSessionMustClaimAgent;

    const surfaceOf = input => {
      if (!isSurface(input.surface)) throw new Error(`surface must name a person's screen: glass:<device>, deck:<device>, phone:<device> or capsule:<device>`);
      return String(input.surface);
    };

    /**
     * A surface, refused when the caller is an agent that is not the assistant. `surface` names
     * a person's screen; an ordinary agent is not a person, and take-over/giveback/watch are
     * actions a person takes on an agent's computer, never the reverse. Without this, an agent
     * whose hands were just refused by a take-over could call computers.giveback on itself and
     * end a person's take-over mid-action (found in review, e.g. mid-password during a Glass
     * sign-in). The assistant is exempt: it is how the user reaches these tools from chat or the
     * Capsule, the same trust resolve() already gives it to name another agent's computer.
     *
     * This is a floor, not the whole guard: it stops an ordinary agent claiming to be any
     * surface, but it cannot tell "deck:laptop" from an impersonator on the same trusted channel
     * (cli, local, a module, or the assistant) - that needs the caller-identity-matches-claimed-
     * surface check the Rules layer does for HUMAN_ONLY tools (asked of security 26 Sep, open).
     *
     * It also cannot see past a module that relabels the caller: sight.watch calls this tool as
     * "module:sight" (core/modules/index.js's call wrapper), so an agent proxied through sight
     * would clear this check no matter who it really is. core/sight/index.js's agentCaller runs
     * the same test against sight.watch's own meta.caller before it ever forwards, so the floor
     * holds end to end; a future proxy path needs the same guard on its own side.
     */
    const ownSurface = async (input, caller) => {
      const surface = surfaceOf(input);
      const who = String(caller || "");
      const claim = agentClaim(who);
      if (claim && (await kindOf(claim)) !== "assistant") throw new Error(`"${who}" is an agent, not a person's screen; ${surface} speaks for itself`);
      return surface;
    };

    // The agents of the space's one computer: a Linux user each, a screen woken on demand and closed after 5 idle minutes (agent-users.js).
    // agentd inside the computer does the work, on a root-only unix socket. vyred reaches it only through the driver running agentd-client.js in the computer
    // (`execIn`, the one exec shape policy.js allows); a driver that cannot do that (none configured, the fake) leaves the Computer tab saying so, in plain words (plain.js).
    // What starts work there (a new agent user, a screen, a command, a session, a terminal) first brings the Space's computer up when it is not running: it is made
    // from the current image the first time an agent needs it, so waking an agent works on a fresh server. A failure to bring it up is kept, in plain words, for
    // computers.agent.status to show until the computer runs.
    // Said to a person in the Computer tab, so in plain words with the next step; the code lets the app add the button (computer_unavailable in lib/error-catalogue.js).
    const NOT_SET = "This agent's computer isn't running on your server yet. An owner can set it up in Settings, This computer.";
    const BRINGS_UP = new Set(["createUser", "startScreen", "exec", "runTicket", "terminalTicket"]);
    /** @type {{ code: string, message: string } | null} */
    let spaceProblem = null;
    /** The bring-up in flight (callers join it), and whether it is the computer's first (no container yet). @type {Promise<void> | null} */
    let spaceStarting = null;
    let spaceFirst = false;
    const spaceUp = () => {
      const box = pool.row(SHARED_COMPUTER_ID);
      if (box && box.container && box.state === "running" && pool.hosts.has(SHARED_COMPUTER_ID)) return Promise.resolve();
      if (spaceStarting) return spaceStarting;
      spaceFirst = !(box && box.container);
      if (spaceFirst) ctx.log("starting the Space's agent computer for the first time");
      spaceStarting = (async () => {
        try { await pool.ensureSpace(SHARED_COMPUTER_ID); spaceProblem = null; }
        catch (e) {
          ctx.log(`the Space's agent computer could not start: ${/** @type {Error} */ (e).message}`);
          const p = plainComputerError(e);
          if (p) spaceProblem = p;
          throw plainError(e);
        }
      })().finally(() => { spaceStarting = null; spaceFirst = false; });
      return spaceStarting;
    };
    /** Is the Space's computer being brought up now, and has it never been made? Read by computers.agent.status. */
    const spaceNow = () => {
      const canRun = Boolean(pool.driver && typeof /** @type {any} */ (pool.driver).execIn === "function");
      const box = pool.row(SHARED_COMPUTER_ID);
      return { starting: Boolean(spaceStarting), first: spaceStarting ? spaceFirst : canRun && !(box && box.container) };
    };
    /** Why an agent's computer cannot run here, in plain words, or null. Read by computers.agent.status. */
    const problemNow = () => {
      if (!pool.driver) return plainComputerError(NO_DRIVER);
      if (typeof /** @type {any} */ (pool.driver).execIn !== "function") return { code: "unavailable", message: NO_EXEC_WORDS };
      const box = pool.row(SHARED_COMPUTER_ID);
      return box && box.container && box.state === "running" ? null : spaceProblem;
    };
    const lazy = name => async (/** @type {any[]} */ ...args) => {
      const driver = pool.driver;
      if (!driver) throw plainError(new Error(NO_DRIVER));
      if (typeof /** @type {any} */ (driver).execIn !== "function") throw Object.assign(new Error(NO_EXEC_WORDS), { code: "unavailable" });
      if (BRINGS_UP.has(name)) await spaceUp();
      const box = pool.row(SHARED_COMPUTER_ID);
      if (!box || !box.container) throw Object.assign(new Error(NOT_SET), { code: "computer_unavailable" });
      const exec = (/** @type {string} */ input) => /** @type {any} */ (driver).execIn(String(box.container), input);
      const ctl = agentdCtl({ transport: execTransport(exec), vncKey: () => memberKey() });
      return /** @type {any} */ (ctl)[name](...args);
    };
    const agentUsers = new AgentUsers({ db: ctx.store.db, now: () => Date.now(),
      // a screen that goes to sleep, or a home that is reset or removed, takes the agent's Chrome link with it
      emit: (type, payload, where) => { if (/^computer\.agent-(asleep|reset|removed)$/.test(type)) cdpAdapter.drop(payload.agent); emit(type, payload, where); },
      ctl: { createUser: lazy("createUser"), removeUser: lazy("removeUser"), startScreen: lazy("startScreen"), stopScreen: lazy("stopScreen"), wipeAgentHome: lazy("wipeAgentHome"),
        // the screen relay's tickets, the Chrome link, a harness session, a command and the terminals: every action agentd answers, or AgentUsers says "this computer cannot" and the agent has no Chrome of its own
        screenTicket: lazy("screenTicket"), cdpTicket: lazy("cdpTicket"), runTicket: lazy("runTicket"), terminalTicket: lazy("terminalTicket"), exec: lazy("exec"), terminals: lazy("terminals"), fsTicket: lazy("fsTicket") } });
    // Take-over of an agent's own screen must not check out a desktop. Keyboard is built above, before this table exists.
    keyboard.onSpace = (agent) => Boolean(agentUsers.row(agent));
    // Pool.reconcile has just made the table agree with the runtime: when the space's computer is gone or stopped, no agent's screen is up, whatever the rows said last time.
    { const box = pool.row(SHARED_COMPUTER_ID); if (!box || (box.state !== "running" && box.state !== "frozen")) agentUsers.asleepAll(); }
    const tool = (name, description, input, run, extra = {}) => ctx.tool(name, { description, input, run, ...extra });
    const agentTools = registerAgentTools({ tool, users: agentUsers, call: ctx.call, callers: PEOPLE, problem: problemNow, space: spaceNow, held: agent => keyboard.takeovers.has(agent) || pool.checkouts.has(agent) || (screenViewers.get(agent) || 0) > 0,
      terminal: (agent, session) => {
        const ticket = pool.ticket(agent, `terminal:${session}`, { perAgent: true });
        return { ticket, path: `/v1/streams/computers/terminal?ticket=${encodeURIComponent(ticket)}` };
      },
      watch: (agent, slow, surface) => {
        const ticket = pool.ticket(agent, isSurface(surface) ? surface : "glass:viewer", { slow, perAgent: true });
        const { w, h } = pool.size(agent);
        return { ticket, path: `${agentBrowser.glassPath()}?ticket=${encodeURIComponent(ticket)}`, width: w, height: h };
      } });

    // Bring the space's computer to the image this Vyre wants (update.js). It runs by itself when the server starts after an update; the owner can run it too.
    const runningVersion = () => { try { return String(JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version); } catch { return "0.0.0"; } };
    const updater = new ComputerUpdater({ db: ctx.store.db, pool, users: agentUsers, version: runningVersion(), log: ctx.log, emit,
      held: agent => keyboard.takeovers.has(agent) || pool.checkouts.has(agent) || (screenViewers.get(agent) || 0) > 0 || shield.has(agent),
      turns: () => turnsRunning.size() });
    const turnsRunning = trackTurns(ctx.events.on);
    const offCreated = ctx.events.on("computer.created", e => { if (e && e.payload && e.payload.agent === SHARED_COMPUTER_ID) updater.noteCreated(); });
    // The computer died or was stopped while vyred runs: its screens went with it.
    const offStopped = sleepAgentsWhenStopped(ctx.events.on, agentUsers);
    const ownerOnly = meta => assertOwner(ctx.kernel, meta);
    tool("computers.update", "Bring the Space's agent computer to the image that matches this version of Vyre. It keeps every agent's logins and files, closes their screens first, and checks each agent's folders for the new layout. Terminal jobs running in the old computer end. It runs by itself after a Vyre update; this runs it now. force: replace the computer even if it looks current. Owner only.",
      obj({ force: { type: "boolean" } }), async (i, meta) => { await ownerOnly(meta); return updater.run({ force: i && i.force === true }); });
    tool("computers.update.status", "Whether the Space's agent computer matches this version of Vyre: what it was made from and what this Vyre wants. Owner only.",
      obj({}), async (_i, meta) => { await ownerOnly(meta); return updater.status(); });
    // After an update the server starts on the new Vyre while the computer is still the old one: bring it along once the rest is up, never blocking the start.
    if (driver && cfg.autoUpdate !== false) {
      const t0 = setTimeout(() => { updater.auto().then(r => { if (r.updated) ctx.log(`agent computer: ${r.message}`); else if (r.state === "busy") ctx.log(`agent computer: ${r.message}`); }).catch(e => ctx.log(`agent computer update failed: ${/** @type {Error} */ (e).message}`)); }, Number(cfg.updateDelayMs ?? 20_000));
      t0.unref();
      autoUpdateTimer = t0;
    }

    tool("computers.rename", "Rename an agent's computer: the person's own label for it, shown wherever the computer appears. An empty name goes back to the agent's name.",
      obj({ computer: str, name: str }, ["computer", "name"]), async (i, { caller }) => {
        if (agentClaim(caller)) throw new Error("renaming a computer is the person's, never an agent's");
        const agent = String(i.computer || "");
        if (!AGENT.test(agent)) throw new Error(`"${agent}" is not an agent name`);
        const label = cleanLabel(i.name);
        if (label.length > 64) throw new Error("a name is 1 to 64 printable characters");
        config.save({ computerLabels: { [agent]: label || null } }, ctx.paths.root, ctx.config);
        ctx.events.emit("device.renamed", { kind: "computer", id: agent, name: label || null });
        return { id: agent, name: label || null };
      });

    tool("computers.list", "Every agent's computer: state, screen and thread when checked out, viewers, take-over, pause. Driver none means this machine cannot run computers.",
      obj({}), async (_, { caller }) => {
        const names = new Set(pool.rows().map(r => String(r.agent)));
        const r = await ctx.call("agents.list", {});
        if (!r.error) for (const a of r.data || []) if (a && a.computer === true) names.add(String(a.name));
        const claim = agentClaim(caller);
        const mine = claim && (await kindOf(claim)) !== "assistant" ? claim : null;
        const labels = (ctx.config.computerLabels && typeof ctx.config.computerLabels === "object") ? ctx.config.computerLabels : {};
        const see = (/** @type {string} */ n) => !mine || n === mine;
        const listed = [...names].filter(see).map(n => ({ ...agentBrowser.view(n), label: labels[n] || null }));
        const space = agentUsers.list().filter(u => u && see(String(u.agent_id))).map(u => ({ agent: String(u.agent_id), state: String(u.state) }));
        const have = new Set(listed.map(c => c.agent));
        for (const u of space) if (u.state && u.state !== "none" && !have.has(u.agent)) listed.push({ ...agentBrowser.view(u.agent), label: labels[u.agent] || null });
        const computers = glassComputers(listed, space).map((row) => { const c = { ...row }; delete c.perAgent; return c; });
        return { driver: driver ? driver.name : "none", screens: agentBrowser.mode() === "browser" ? 0 : pool.opts.screens, computers, browse: agentBrowser.mode() };
      });

    tool("computers.get", "One agent's computer.", obj({ agent: str }),
      async (i, { caller }) => {
        const agent = await resolve(i, caller);
        return agentBrowser.view(agent);
      });

    tool("computers.checkout", "Give an agent a screen and a running computer (made on first need, thawed if frozen). Waits up to 30 s when screens are busy.",
      obj({ agent: str, thread: str, why: str }), async (i, { caller, thread: live }) => {
        ownOnly(caller);
        if (!driver) throw new Error(NO_DRIVER);
        // A model's thread is the verified one the harness gives the call, never a thread id it names in its input.
        const thread = agentClaim(caller) ? live : i.thread;
        const agent = await resolve(i, caller);
        return agentBrowser.checkout(agent, { thread, why: i.why });
      }, { callers: OWN });

    tool("computers.release", "Let go of an agent's screen. The computer freezes a little later.", obj({ agent: str }),
      async (i, { caller }) => { ownOnly(caller); return { released: pool.release(await resolve(i, caller), "released") }; }, { callers: OWN });

    tool("computers.stop", "Stop an agent's computer. Its home volume stays; the next checkout starts it again.", obj({ agent: str }),
      async (i, { caller }) => {
        const agent = await resolve(i, caller);
        const t = keyboard.takeovers.get(agent);
        // Stopping the computer ends its take-over unconditionally, whoever held it: this is
        // the module administratively tearing the whole thing down, not one surface giving back
        // to another, so it passes as itself rather than the (possibly different) caller here.
        if (t) await keyboard.giveback(agent, t.surface, "module:computers");
        return pool.stop(agent);
      });

    tool("computers.restart", "Restart an agent's computer: a new container on the same home, so files and Chrome profile stay. Anything open on its screen closes.",
      obj({ agent: str }), async (i, { caller }) => { ownOnly(caller); return pool.restart(await resolve(i, caller)); }, { callers: OWN });

    tool("computers.limits", `Set an agent's processor cores and memory; they apply at the next restart. A person's or the assistant's to set, never an agent's own.`,
      obj({ agent: str, cpus: { type: "number", description: `whole cores, ${LIMITS.cpus.min} to ${LIMITS.cpus.max}` }, memory_gb: { type: "number", description: `whole GB, ${LIMITS.memoryGb.min} to ${LIMITS.memoryGb.max}` } }), async (i, { caller }) => {
        ownOnly(caller);
        const agent = await resolve(i, caller);
        const claim = agentClaim(caller);
        if (claim && (await kindOf(claim)) !== "assistant") throw new Error(`${claim} cannot change a computer's limits; the user sets them`);
        await pool.allowed(agent);
        return pool.limits(agent, { cpus: i.cpus, memory_gb: i.memory_gb });
      }, { callers: OWN });

    tool("computers.stats", "One CPU/RAM/network sample for an agent's computer (docker stats, one buffered request, never a streaming connection). Every field null when the computer is not running or this machine has no driver. Internal: vitals reads this, not the Deck.", obj({ agent: str }),
      async (i, { caller }) => {
        const agent = await resolve(i, caller);
        if (!driver || typeof driver.stats !== "function") return { cpu: null, ram: null, ramLimit: null, netRx: null, netTx: null };
        const row = pool.row(agent);
        if (!row || !row.container || String(row.state) !== "running") return { cpu: null, ram: null, ramLimit: null, netRx: null, netTx: null };
        return driver.stats(row.container);
      }, { internal: true });

    tool("computers.pause", "Pause an agent's hands: its input actions are refused until resumed. The computer keeps running.", obj({ agent: str }),
      async (i, { caller }) => { ownOnly(caller); return pool.pause(await resolve(i, caller), true); }, { callers: OWN });

    tool("computers.resume", "Let a paused agent's hands act again.", obj({ agent: str }),
      async (i, { caller }) => pool.pause(await resolve(i, caller), false));

    tool("computers.takeover", "Take the keyboard of an agent's computer for a person's screen. The agent's hands stop, and the thread's lease moves to that screen. Call again to renew; it lapses after 90 s unrenewed. private: on the shared browser, restore the member's sealed profile and seal it again on handback.",
      obj({ agent: str, surface: str, private: { type: "boolean" } }, ["surface"]), async (i, meta) => {
        const { caller } = meta;
        ownOnly(caller);
        const agent = await resolve(i, caller);
        if (!driver) throw new Error(NO_DRIVER);
        const surface = await ownSurface(i, caller);
        // Nobody types into a computer the Vault is signing in on; the fill ends in seconds.
        if (fills.has(agent)) throw Object.assign(new Error(`${agent}'s computer is busy: a sign-in is being filled; try again in a few seconds`), { code: "busy" });
        const priv = i.private === true;
        let browserSnap = null;
        let personId = null;
        if (priv) {
          const existing = keyboard.takeovers.get(agent);
          if (existing && existing.private && existing.personId && existing.browserSnap) {
            personId = existing.personId;
            browserSnap = existing.browserSnap;
          } else {
            personId = await personIdOf(ctx, meta);
            if (personId) browserSnap = await beginPrivateMemberBrowser(handbackDeps, agent, personId);
          }
        }
        return keyboard.takeover(agent, surface, caller, { private: priv, personId, browserSnap });
      }, { callers: OWN });

    tool("computers.giveback", "Hand the keyboard back to the agent.", obj({ agent: str, surface: str }, ["surface"]),
      async (i, { caller }) => { ownOnly(caller); return keyboard.giveback(await resolve(i, caller), await ownSurface(i, caller), caller); }, { callers: OWN });

    tool("computers.watch", "A one-use ticket (30 s) to open an agent's screen in Glass. slow: the viewer's link is relayed or slow, so send fewer frames.",
      obj({ agent: str, surface: str, slow: { type: "boolean" } }, ["surface"]),
      async (i, { caller }) => {
        const agent = await resolve(i, caller);
        const surface = await ownSurface(i, caller);
        if (!driver) throw new Error(NO_DRIVER);
        // An agent-user row is the screen the Computer tab calls live. It has no desktop, so pool.allowed ("has no computer") does not apply, and the ticket opens that screen.
        const place = agentUsers.row(agent);
        if (!place) {
          await pool.allowed(agent);
          // A computer that died on its own is not started behind the person's back by opening its screen.
          await pool.verifyAlive(agent).catch(() => false);
          if (pool.died.has(agent) && (pool.row(agent) || {}).state !== "running") throw Object.assign(new Error(STOPPED), { code: "stopped" });
          if (pool.unknown.has(agent)) throw Object.assign(new Error(UNKNOWN), { code: "unavailable" });
        }
        const ticket = pool.ticket(agent, surface, { slow: i.slow === true, ...(place ? { perAgent: true } : {}) });
        const { w, h } = pool.size(agent);
        const path = `${agentBrowser.glassPath()}?ticket=${encodeURIComponent(ticket)}`;
        if (agentBrowser.mode() === "browser") {
          return { ticket, path, width: w, height: h, mode: "screencast" };
        }
        return { ticket, path, width: w, height: h };
      });

    // Per-agent users on the space's computer are off until 0.6.2: the box opts in with computers.agentUsers: true, and even then agentd must be up (the shared box has a container and its computerd answered, so its host is registered).
    const agentdReady = () => { if (liveCfg().agentUsers !== true) return false; const box = pool.row(SHARED_COMPUTER_ID); return Boolean(pool.driver && typeof /** @type {any} */ (pool.driver).execIn === "function" && box && box.container && pool.hosts.has(SHARED_COMPUTER_ID)); };
    // The Space's computer for agentBrowser: never the shared browser unless computers.browse is "browser" on purpose. It waits (bounded) for the computer and agentd, and says so loudly when they do not come.
    {
      agentBrowser.log = ctx.log;
      const canExec = Boolean(pool.driver && typeof /** @type {any} */ (pool.driver).execIn === "function");
      agentBrowser.space = !canExec ? null : { endpoint: async agent => {
        const waitMs = Number(liveCfg().agentdWaitMs ?? 90_000), t0 = Date.now();
        let last = NOT_SET, said = false;
        for (;;) {
          // place and wake are what bring the Space's computer up (createUser and startScreen). Waiting for agentdReady first never starts it.
          try {
            await agentTools.place(agent);
            await agentUsers.wake(agent);
            if (agentdReady()) return await cdpAdapter.endpoint(agent);
            last = NOT_SET;
          } catch (e) { last = /** @type {Error} */ (e).message; }
          if (Date.now() - t0 > waitMs) {
            ctx.log(`AGENT COMPUTER NOT READY: ${agent} waited ${Math.round(waitMs / 1000)} s for the Space's computer and agentd (${last}); the shared browser is not used because computers.browse is not "browser"`);
            throw new Error(`the Space's computer is not ready yet (${last}); try again in a moment. The shared browser is used only when computers.browse is "browser".`);
          }
          if (!said) { said = true; ctx.log(`agent computer: starting the Space's computer for ${agent}; waiting up to ${Math.round(waitMs / 1000)} s for agentd`); }
          await new Promise(r => setTimeout(r, 250));
        }
      } };
    }
    const agentEndpoint = makeAgentEndpoint({ resolve, claimOf: agentClaim, mayUse: agentTools.mayUse, place: agentTools.place, wake: a => agentUsers.wake(a), endpoint: a => cdpAdapter.endpoint(a) });

    tool("computers.endpoint", "Where the agent's Chrome and computerd answer, and computerd's token. Thaws the shared browser or checks out a desktop.",
      obj({ agent: str, thread: str }), async (i, meta) => {
        // A hands call arrives as the module. The person or agent who asked is the origin, and that is who the computer belongs to.
        const caller = String(meta && meta.caller || "");
        const who = String((meta && meta.origin) || caller);
        // The agent's own Chrome on the Space's computer, including the first ask, which is what starts that computer. The shared browser is used only when computers.browse is "browser" on purpose.
        if (liveCfg().agentUsers === true && agentBrowser.space && !agentBrowser.explicitShared()) {
          const agent = await resolve(i, who);
          if (agentClaim(who) !== agent) await agentTools.mayUse("use", agent);
          return { helper: await agentBrowser.space.endpoint(agent) };
        }
        if (agentdReady()) return agentEndpoint(i, who);
        const agent = await resolve(i, who);
        const ep = await agentBrowser.endpoint(agent, { thread: i.thread, why: "hands" });
        return { helper: ep.helper };
      }, { internal: true });

    const agentRun = makeAgentRun({ resolve, claimOf: agentClaim, mayUse: agentTools.mayUse, place: agentTools.place,
      ticket: (agent, hello, spec) => agentUsers.runTicket(agent, hello, spec),
      where: async () => {
        const h = pool.hosts.get(SHARED_COMPUTER_ID);
        if (!h) throw notSet();
        // the relay lets in vyred's address only: have the computer pin this vyred's address first
        await pool.pin(SHARED_COMPUTER_ID);
        return { host: h.host, port: RELAY_PORT };
      } });
    tool("computers.run.open", "Start a command as an agent's own Linux user inside its computer, as a stream: answers { host, port, hello } for agentd's relay. Connect, send hello, then use frames (stdin down; stdout, stderr and exit up). For a harness session; the caller is the agent's own session, or needs the right to edit the agent.",
      obj({ agent: str, argv: { type: "array", items: str }, cwd: str, env: { type: "object" } }, ["argv"]), async (i, { caller }) => agentRun(i, caller), { internal: true });

    // ---- the agent's folder on its computer: the one real copy, which Files reads and writes (owner decision, 20 Oct 2026; agent-files.js) ------------------------------------
    //
    // Only the files module calls this: it has already decided that the person behind the call may see (Can use) or change (Can edit) this agent, and refused every agent and model caller
    // (core/files/agent-folder.js, AGENT_FOLDER_RULE). The operation runs as the agent's own Linux user inside the computer, through computerd's own path guard (image/agentd-fs.js).
    // The agent's screen need not be up and is not woken. When the Space's computer itself is not running, `open` starts it in the background and every operation answers `waking`
    // ("Opening this agent's computer...") until it answers; when this server has no agent computers at all, the answer says so plainly.
    const FILES_NOT_SET = "Agent computers are not set up on this server, and an agent's files are kept on its computer, so this folder cannot open here. Ask the Space's owner to set up agent computers.";
    const canHaveFolders = () => Boolean(pool.driver && typeof /** @type {any} */ (pool.driver).execIn === "function" && ctx.config && ctx.config.computers && ctx.config.computers.agentUsers === true);
    /** @type {Promise<any> | null} */ let opening = null;
    // the smallest touch on the computer's wiring: the same ensure update.js runs, once at a time, in the background
    const openComputer = () => { if (!opening) opening = pool.serial(SHARED_COMPUTER_ID, () => pool.ensure(SHARED_COMPUTER_ID)).catch(e => ctx.log(`agent computer: could not open it for Files (${/** @type {Error} */ (e).message})`)).finally(() => { opening = null; }); return opening; };
    const folderReady = async (/** @type {string} */ agent, /** @type {boolean} */ wake) => {
      if (!canHaveFolders()) throw Object.assign(new Error(FILES_NOT_SET), { code: "unavailable" });
      if (!agentdReady()) {
        if (wake) void openComputer();
        throw Object.assign(new Error("Opening this agent's computer\u2026 Wait a few seconds, then try again."), { code: "waking" });
      }
      await agentTools.place(agent);
    };
    const agentFiles = makeAgentFiles({ ready: a => folderReady(a, false), ticket: (a, hello, spec) => agentUsers.fsTicket(a, hello, spec),
      where: async () => { const h = pool.hosts.get(SHARED_COMPUTER_ID); if (!h) throw Object.assign(new Error("Opening this agent's computer\u2026 Wait a few seconds, then try again."), { code: "waking" }); await pool.pin(SHARED_COMPUTER_ID); return { host: h.host, port: RELAY_PORT }; } });
    tool("computers.agent.files", "One operation on an agent's folder on its computer: open (start the computer if it is not running), list, stat, read, write, mkdir, move or trash. Only the files module calls it, after it has checked the person's access to the agent.",
      obj({ agent: str, op: { type: "string", enum: ["open", "list", "stat", "read", "write", "mkdir", "move", "trash"] }, path: str, from: str, to: str, base64: str, overwrite: { type: "boolean" }, max: { type: "number" } }, ["agent", "op"]),
      async (i, { caller }) => {
        if (String(caller || "") !== "module:files") throw Object.assign(new Error("only Files opens an agent's folder, after checking who is asking"), { code: "denied" });
        const agent = String(i.agent || "");
        if (!AGENT.test(agent)) throw Object.assign(new Error(`"${agent}" is not an agent name: files.places lists the agents`), { code: "bad_input" });
        const p = typeof i.path === "string" ? i.path : "";
        switch (i.op) {
          case "open": await folderReady(agent, true); return { state: "open" };
          case "list": return agentFiles.list(agent, p);
          case "stat": return agentFiles.stat(agent, p);
          case "read": { const b = await agentFiles.read(agent, p, typeof i.max === "number" ? { max: i.max } : {}); return { size: b.length, base64: b.toString("base64") }; }
          case "write": {
            const text = String(i.base64 ?? "");
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw Object.assign(new Error("send base64: the file's bytes, standard base64"), { code: "bad_input" });
            return agentFiles.write(agent, p, Buffer.from(text, "base64"), { overwrite: i.overwrite === true });
          }
          case "mkdir": return agentFiles.mkdir(agent, p);
          case "move": return agentFiles.move(agent, String(i.from || ""), String(i.to || ""));
          case "trash": return agentFiles.trash(agent, p);
          default: throw Object.assign(new Error("name the op: open, list, stat, read, write, mkdir, move or trash"), { code: "bad_input" });
        }
      }, { internal: true });

    registerDeskAsk({ tool, users: agentUsers, files: agentFiles, place: a => agentTools.place(a), mayUse: agentTools.mayUse, callers: OWN });

    tool("computers.may-act", "May the agent's hands act now? Refused while paused or taken over, with who has the keyboard; while shielded, refused for reads too.",
      obj({ agent: str, tool: str, read: { type: "boolean" } }), async (i, { caller }) => {
        const agent = await resolve(i, caller);
        return shield.mayAct(agent, i.read === true, () => keyboard.mayAct(agent, i.tool));
      }, { internal: true });

    tool("computers.helper", "Where computerd answers, and its token. Thaws and touches without taking a screen.",
      obj({ agent: str }), async (i, { caller }) => helperFor(await resolve(i, caller)), { internal: true });

    tool("computers.shield", "Shield an agent's computer while a person signs in: its hands refuse reads as well as input.",
      obj({ agent: str, on: { type: "boolean" } }, ["on"]), async (i, { caller }) => shield.set(await resolve(i, caller), i.on === true, { reason: "person" }), { internal: true });

    // ---- fill: the Vault signs an agent in without the agent seeing the login (fill.js) -------

    const vaultOnly = caller => {
      if (String(caller || "") !== "module:vault") throw Object.assign(new Error("only the vault fills a login into an agent's computer"), { code: "denied" });
    };

    tool("computers.fill.begin", "Shield an agent's computer for a Vault fill: the agent's hands and CDP sockets are cut, and the vault gets a CDP address and a token for this fill only, good for 60 s.",
      obj({ agent: str, origin: str, values: { type: "array", items: str } }, ["agent", "origin"]), async (i, { caller }) => {
        vaultOnly(caller);
        if (!AGENT.test(String(i.agent || ""))) throw new Error(`"${i.agent}" is not an agent name`);
        return fills.begin(String(i.agent), String(i.origin || ""), Array.isArray(i.values) ? i.values.filter(v => typeof v === "string") : []);
      }, { internal: true });

    tool("computers.fill.end", "End a Vault fill: its token and socket are dropped and the agent's computer is unshielded. target: the tab signed in, for the agent's hands.",
      obj({ agent: str, fill: str, target: str }, ["agent", "fill"]), async (i, { caller }) => {
        vaultOnly(caller);
        return fills.end(String(i.agent), String(i.fill || ""), { target: i.target, why: "done" });
      }, { internal: true });

    // ---- shared (browser-kind) computers: membership (agent-browsers.md level 2) -------------
    //
    // The owner's own tools, never an agent's or a model's -- PERSON_ONLY (core/presence/index.js)
    // refuses any other caller before these handlers ever run, the same floor computers.takeover
    // and computers.giveback already stand behind. computer/agent are pool.js's own synthetic
    // computer id and agent id, never real names a client sends unchecked -- see pool.js's own
    // AGENT-shaped validation on both.

    tool("computers.member.add", "Add an agent to a shared computer, making the computer first if the id names none yet. Both this and computers.member.remove reload computerd's own identity file, so the change takes effect immediately. The owner's own action.",
      obj({ computer: str, agent: str, name: str }, ["computer", "agent", "name"]),
      async i => pool.addAgent(String(i.computer), String(i.agent), String(i.name)));

    tool("computers.member.remove", "Remove an agent from a shared computer. If it was the last one, the computer stops -- its volume and every member's profile stay; deleting one is computers.member.dispose, a separate action.",
      obj({ computer: str, agent: str }, ["computer", "agent"]),
      async i => pool.removeAgent(String(i.computer), String(i.agent)));

    tool("computers.member.rotate", "Rotate one member's own CDP token without taking it off the computer -- for a leaked token, or routine hygiene. The old token stops working at once; membership itself is unchanged.",
      obj({ computer: str, agent: str }, ["computer", "agent"]),
      async i => pool.rotateAgent(String(i.computer), String(i.agent)));

    tool("computers.member.dispose", "Delete one member's own browser context on a shared computer -- its cookies and logins. Refuses while the agent is still a member; computers.member.remove it first. Call this only after showing the person what it removes; it is never a side effect of computers.member.remove. Does not itself close a live client.",
      obj({ computer: str, agent: str }, ["computer", "agent"]),
      async i => ({ disposed: await pool.disposeContext(String(i.computer), String(i.agent)) }));

    const notAgent = (caller, what) => {
      const who = String(caller || "");
      if (agentClaim(who)) throw new Error(`"${who}" is an agent; ${what} is the owner's`);
      return who;
    };

    // ---- idle hand-back: a take-over with no input goes back to the agent (keyboard.js) --------

    const handback = () => ({ minutes: idleMsOf(idleMin()) / 60_000, choices: [...IDLE_CHOICES], warn_s: IDLE_WARN_MS / 1000 });

    tool("computers.handback.status", "After how many minutes without input a take-over hands the keyboard back to the agent (config computers.handbackIdleMin; 0 is off), the choices, and how many seconds before the holder is warned.",
      obj({}), async () => handback());

    tool("computers.handback.set", "Set after how many minutes without input a take-over hands the keyboard back: 0 (off), 2, 5 or 15. The owner's to change, never an agent's; it applies at once, to a take-over already running too.",
      obj({ minutes: { type: "number", enum: [...IDLE_CHOICES] } }, ["minutes"]), async (i, { caller }) => {
        const who = notAgent(caller, "when a take-over hands back");
        const minutes = Number(i.minutes);
        if (!IDLE_CHOICES.includes(minutes)) throw new Error(`minutes must be one of ${IDLE_CHOICES.join(", ")} (0 is off)`);
        if (!ctx.paths) throw new Error("this vyred has no home to save config in");
        config.save({ computers: { handbackIdleMin: minutes } }, ctx.paths.root, ctx.config);
        ctx.log(`idle hand-back ${minutes ? `after ${minutes} min` : "off"}, set by ${who || "unknown"}`);
        for (const agent of keyboard.takeovers.keys()) keyboard.arm(agent);
        return handback();
      });

    return {
      pool, keyboard, shield, fills, driver, sweep,
      async stop() {
        stopDeaths();
        if (timer) clearTimeout(timer);
        if (autoUpdateTimer) clearTimeout(autoUpdateTimer);
        if (typeof offCreated === "function") offCreated();
        turnsRunning.stop();
        if (typeof offStopped === "function") offStopped();
        keyboard.stop();
        shield.stop();
        fills.stop();
        pool.wake();
        if (glass && typeof glass.stop === "function") { try { await glass.stop(); } catch {} }
      },
    };
  },
};
