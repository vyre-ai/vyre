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

import { cleanLabel } from "../../lib/devicename.js";
import { Pool, MIGRATIONS, NO_DRIVER, LIMITS, STOPPED, UNKNOWN } from "./pool.js";
import { Keyboard, isSurface, idleMsOf, IDLE_CHOICES, IDLE_WARN_MS } from "./keyboard.js";
import { FakeDriver } from "./driver/fake.js";
import { DockerDriver } from "./driver/docker.js";
import { Shield } from "./shield.js";
import { Fills } from "./fill.js";
import { helper, tellComputerd } from "./helper.js";
import * as egress from "./egress.js";
import * as tailnet from "./tailnet.js";
import * as config from "../config/index.js";
import { ensure as ensureBearer } from "../../lib/bearer/index.js";
import { agentClaim } from "../modules/index.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const AGENT = /^[a-z][a-z0-9-]{0,40}$/;
/** The person's own surfaces; a module hop is checked against the original caller by the registry. */
const PEOPLE = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device"];
/** An agent's own hands (mcp:agent:<name>, a model session) and the harness; only the tools that act on the caller's OWN computer list them. */
const OWN = [...PEOPLE, "module", "mcp", "harness"];

/** The vault item a shared computer's member tokens are derived from (pool.js's memberToken()) --
 * declared in module.json's needs.vault, the same shape tailnet's own authkey item is. Never
 * generated here: like every other vault item, a person puts it in (vault.put, HUMAN_ONLY)
 * before the first computers.member.add that needs it; fetched fresh each time, never cached, so
 * a person rotating it in the vault directly takes effect on the very next add/rotate/reseed. */
const MEMBER_TOKEN_ITEM = "vyre-shared-computer-member-key";

/** The default path for the docker-api bearer, in a volume box/compose.yml shares between the
 * vyre and docker-api services only -- never vyre-agent's home, and never either process's Env. */
const DEFAULT_BEARER_FILE = "/var/lib/vyre-secrets/docker-api-bearer";

/**
 * The driver config asks for: the Docker proxy when `computers.docker` is set, the fake when
 * `computers.driver` is "fake", else none. There is deliberately no fallback to the raw socket.
 * vyred owns the bearer file (bearer.ensure): it generates one on first boot if the box's setup
 * has not already, so a fresh install still gets the file before docker-api needs it to answer.
 * @returns {import("./driver/index.js").Driver|null}
 */
export function pickDriver(cfg, key) {
  if (cfg.docker) return new DockerDriver({ url: String(cfg.docker), bearer: ensureBearer(cfg.dockerBearerFile || DEFAULT_BEARER_FILE),
    labelPrefix: cfg.labelPrefix, network: cfg.network, capAdd: cfg.capAdd });
  if (cfg.driver === "fake") return FakeDriver.for(key, cfg.local ? { local: cfg.local } : {});
  return null;
}

/** @type {{ start(ctx: any): Promise<any> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const cfg = (ctx.config && ctx.config.computers) || {};
    const driver = pickDriver(cfg, ctx.paths ? ctx.paths.root : "default");
    const emit = (type, payload, where) => ctx.events.emit(type, payload, where);
    // Read when a computer is made, from the live config, so a change needs no vyred restart.
    const egressCfg = () => (ctx.config && ctx.config.glass && ctx.config.glass.egress) || undefined;
    // Also live: computers.tailnet.set changes it without a restart. The key is fetched only when
    // a computer starts with the switch on, and goes straight to that computer, nowhere else.
    const tailnetCfg = () => (ctx.config && ctx.config.computers && ctx.config.computers.tailnet) || undefined;
    const pool = new Pool({ db: ctx.store.db, driver, call: ctx.call, emit, log: ctx.log, config: cfg, egress: egressCfg,
      tailnet: { setting: () => tailnet.setting(tailnetCfg()), key: () => ctx.vault.fetch(tailnet.ITEM) },
      memberTokenKey: () => ctx.vault.fetch(MEMBER_TOKEN_ITEM) });
    // Live too: computers.handback.set changes the idle hand-back for a take-over already running.
    const idleMin = () => ctx.config && ctx.config.computers ? ctx.config.computers.handbackIdleMin : undefined;
    const keyboard = new Keyboard({ pool, call: ctx.call, emit, on: ctx.events.on, log: ctx.log, idleMs: () => idleMsOf(idleMin()) });
    const shield = new Shield({ pool, emit, on: ctx.events.on, log: ctx.log, tell: (agent, on, o) => tellComputerd(pool, agent, on, o) });
    const fills = new Fills({ pool, shield, keyboard, emit, on: ctx.events.on, log: ctx.log, helper: agent => helper(pool, agent) });

    if (!driver) ctx.log("no computer driver configured (computers.docker is not set); computers cannot start");
    else {
      try { await pool.reconcile(); }
      catch (e) { ctx.log(`could not reconcile computers with the ${driver.name} driver: ${/** @type {Error} */ (e).message}`); }
    }

    // Glass is a separate file with its own failure modes (a relay and an RFB parser). A broken
    // or missing one costs the stream, never the pool or the hands.
    /** @type {any} */
    let glass = null;
    try {
      const { Glass } = await import("./glass.js");
      glass = new Glass({ pool, keyboard, log: ctx.log });
      ctx.upgrade("glass", (req, socket, head, info) => glass.handle(req, socket, head, info));
    } catch (e) {
      glass = null;
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
    const sweep = async () => { keyboard.sweep(); await pool.sweep(); };
    const busy = () => pool.checkouts.size > 0 || pool.idle.size > 0 || keyboard.takeovers.size > 0;
    let sweeping = false, timer = null;
    const schedule = () => {
      if (sweepMs <= 0) return;
      timer = setTimeout(async () => {
        if (!sweeping) {
          sweeping = true;
          try { await sweep(); } catch (e) { ctx.log(`sweep failed: ${e.message}`); }
          sweeping = false;
        }
        schedule();
    // The runtime tells us when a computer dies (docker events through the proxy); the sweep is only the backstop.
    const stopDeaths = pool.watchDeaths();
      }, busy() ? sweepMs : idleSweepMs);
      timer.unref();
    };
    schedule();

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
    const resolve = async (input, caller) => {
      const self = agentClaim(caller);
      let agent;
      if (self) {
        if (!input.agent || input.agent === self) agent = self;
        else if ((await kindOf(self)) === "assistant") agent = input.agent;
        else throw new Error(`${self} can only use its own computer, not ${input.agent}'s`);
      } else {
        if (!input.agent) throw new Error("say which agent's computer: agent is required");
        agent = input.agent;
      }
      if (!AGENT.test(String(agent))) throw new Error(`"${agent}" is not an agent name`);
      return String(agent);
    };

    /** A model session that names no agent (a bare "mcp", "mcp:thread:<id>", the harness) has no computer of its own, so it may not name one: the person's surfaces and modules say which agent they mean. */
    const ownOnly = caller => {
      const c = String(caller || "");
      if (!agentClaim(c) && /^(mcp|harness)\b/.test(c)) throw Object.assign(new Error("a model session may only act on its own agent's computer; it names no agent"), { code: "denied" });
    };

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
     * (cli, local, a module, or the assistant) — that needs the caller-identity-matches-claimed-
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

    const tool = (name, description, input, run, extra = {}) => ctx.tool(name, { description, input, run, ...extra });

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
        const computers = [...names].filter(n => !mine || n === mine).sort().map(n => ({ ...pool.view(n), label: labels[n] || null }));
        return { driver: driver ? driver.name : "none", screens: pool.opts.screens, computers };
      });

    tool("computers.get", "One agent's computer.", obj({ agent: str }),
      async (i, { caller }) => pool.view(await resolve(i, caller)));

    tool("computers.checkout", "Give an agent a screen and a running computer (made on first need, thawed if frozen). Waits up to 30 s when screens are busy.",
      obj({ agent: str, thread: str, why: str }), async (i, { caller, thread: live }) => {
        ownOnly(caller);
        if (!driver) throw new Error(NO_DRIVER);
        // A model's thread is the verified one the harness gives the call, never a thread id it names in its input.
        const thread = agentClaim(caller) ? live : i.thread;
        return pool.checkout(await resolve(i, caller), { thread, why: i.why });
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

    tool("computers.takeover", "Take the keyboard of an agent's computer for a person's screen. The agent's hands stop, and the thread's lease moves to that screen. Call again to renew; it lapses after 90 s unrenewed.",
      obj({ agent: str, surface: str }, ["surface"]), async (i, { caller }) => {
        ownOnly(caller);
        const agent = await resolve(i, caller);
        if (!driver) throw new Error(NO_DRIVER);
        const surface = await ownSurface(i, caller);
        // Nobody types into a computer the Vault is signing in on; the fill ends in seconds.
        if (fills.has(agent)) throw Object.assign(new Error(`${agent}'s computer is busy: a sign-in is being filled; try again in a few seconds`), { code: "busy" });
        return keyboard.takeover(agent, surface, caller);
      }, { callers: OWN });

    tool("computers.giveback", "Hand the keyboard back to the agent.", obj({ agent: str, surface: str }, ["surface"]),
      async (i, { caller }) => { ownOnly(caller); return keyboard.giveback(await resolve(i, caller), await ownSurface(i, caller), caller); }, { callers: OWN });

    tool("computers.watch", "A one-use ticket (30 s) to open an agent's screen in Glass. slow: the viewer's link is relayed or slow, so send fewer frames.",
      obj({ agent: str, surface: str, slow: { type: "boolean" } }, ["surface"]),
      async (i, { caller }) => {
        const agent = await resolve(i, caller);
        const surface = await ownSurface(i, caller);
        if (!driver) throw new Error(NO_DRIVER);
        await pool.allowed(agent);
        // A computer that died on its own is not started behind the person's back by opening its screen.
        await pool.verifyAlive(agent).catch(() => false);
        if (pool.died.has(agent) && (pool.row(agent) || {}).state !== "running") throw Object.assign(new Error(STOPPED), { code: "stopped" });
        if (pool.unknown.has(agent)) throw Object.assign(new Error(UNKNOWN), { code: "unavailable" });
        const ticket = pool.ticket(agent, surface, { slow: i.slow === true });
        const { w, h } = pool.size(agent);
        return { ticket, path: `/v1/streams/computers/glass?ticket=${encodeURIComponent(ticket)}`, width: w, height: h };
      });

    tool("computers.endpoint", "Where the agent's Chrome and computerd answer, and computerd's token. Checks out and thaws.",
      obj({ agent: str, thread: str }), async (i, { caller }) => {
        const agent = await resolve(i, caller);
        await pool.checkout(agent, { thread: i.thread, why: "hands" });
        return pool.endpoint(agent);
      }, { internal: true });

    tool("computers.may-act", "May the agent's hands act now? Refused while paused or taken over, with who has the keyboard; while shielded, refused for reads too.",
      obj({ agent: str, tool: str, read: { type: "boolean" } }), async (i, { caller }) => {
        const agent = await resolve(i, caller);
        return shield.mayAct(agent, i.read === true, () => keyboard.mayAct(agent, i.tool));
      }, { internal: true });

    tool("computers.helper", "Where computerd answers, and its token. Thaws and touches without taking a screen.",
      obj({ agent: str }), async (i, { caller }) => helper(pool, await resolve(i, caller)), { internal: true });

    tool("computers.shield", "Shield an agent's computer while a person signs in: its hands refuse reads as well as input.",
      obj({ agent: str, on: { type: "boolean" } }, ["on"]), async (i, { caller }) => shield.set(await resolve(i, caller), i.on === true, { reason: "person" }), { internal: true });

    // ---- fill: the Vault signs an agent in without the agent seeing the login (fill.js) -------

    const vaultOnly = caller => {
      if (String(caller || "") !== "module:vault") throw Object.assign(new Error("only the vault fills a login into an agent's computer"), { code: "denied" });
    };

    tool("computers.fill.begin", "Shield an agent's computer for a Vault fill: the agent's hands and CDP sockets are cut, and the vault gets a CDP address and a token for this fill only, good for 60 s.",
      obj({ agent: str, origin: str }, ["agent", "origin"]), async (i, { caller }) => {
        vaultOnly(caller);
        if (!AGENT.test(String(i.agent || ""))) throw new Error(`"${i.agent}" is not an agent name`);
        return fills.begin(String(i.agent), String(i.origin || ""));
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

    // ---- egress: the listed sites through the user's Mac (egress.js) -------------------------

    const APPLIES = "applies to computers started after the change: a stopped computer is made again with it on its next start (its home stays); a running or frozen one keeps its old setting until computers.stop";

    tool("computers.egress.status", "Whether computers' Chrome sends the listed sites through the user's Mac (config glass.egress), the sites, whether the egress sidecar answers right now, and whether its gate lets listed sites through (only while the Mac is in use as the exit node).",
      obj({}), async () => {
        const raw = egressCfg() || {};
        const via = egress.proxy();
        /** @type {{ enabled: boolean, sites: any[], proxy: string, applies: string, problem?: string }} */
        let out;
        try { out = { ...egress.setting(raw), proxy: via, applies: APPLIES }; }
        catch (e) { out = { enabled: raw.enabled === true, sites: Array.isArray(raw.sites) ? raw.sites : [], proxy: via, applies: APPLIES, problem: /** @type {Error} */ (e).message }; }
        const [p, g] = await Promise.all([egress.probe(via), egress.gateStatus()]);
        // sidecar: whether egress:1055 accepts a connection; gate: whether it would let a listed
        // site through right now (only while the Mac is in use as the exit node), and why not.
        return { ...out, sidecar: p.answers ? { answers: true } : { answers: false, why: p.why }, gate: g };
      });

    tool("computers.egress.set", "Turn the Mac egress on or off, or replace its site list (hostnames, optionally *.hostname). The owner's to change, never an agent's; it applies to computers started afterwards.",
      obj({ enabled: { type: "boolean" }, sites: { type: "array", items: str } }), async (i, { caller }) => {
        const who = String(caller || "");
        if (agentClaim(who)) throw new Error(`"${who}" is an agent; where an agent's browser goes out is the owner's to change`);
        const now = egress.setting(egressCfg());
        const next = { enabled: i.enabled === undefined ? now.enabled : i.enabled === true, sites: i.sites === undefined ? now.sites : egress.checkSites(i.sites) };
        if (!ctx.paths) throw new Error("this vyred has no home to save config in");
        config.save({ glass: { egress: next } }, ctx.paths.root, ctx.config);
        ctx.log(`egress ${next.enabled ? "on" : "off"}, ${next.sites.length} site(s), set by ${who || "unknown"}`);
        return { ...next, applies: APPLIES };
      }, { presence: { summary: i => i && i.enabled === true ? "Send the listed sites through your Mac" : "Change which sites go through your Mac" } });

    // ---- tailnet: each computer as its own ephemeral tagged node (tailnet.js) ----------------

    const JOINS = "applies to computers that start or thaw after the change; one already running keeps what it has until computers.stop, and turning it off never logs a running node out early";
    const notAgent = (caller, what) => {
      const who = String(caller || "");
      if (agentClaim(who)) throw new Error(`"${who}" is an agent; ${what} is the owner's`);
      return who;
    };

    tool("computers.tailnet.status", "Whether computers join the tailnet as their own tagged nodes (config computers.tailnet), the tag, whether the auth key is in the vault and granted (never its value), and each computer's node.",
      obj({}), async (_, { caller }) => {
        notAgent(caller, "the computers' tailnet setting");
        /** @type {{ enabled: boolean, tag: string, applies: string, problem?: string }} */
        let out;
        try { out = { ...tailnet.setting(tailnetCfg()), applies: JOINS }; }
        catch (e) { out = { enabled: false, tag: tailnet.DEFAULT_TAG, applies: JOINS, problem: /** @type {Error} */ (e).message }; }
        /** @type {{ item: string, exists: boolean|null, granted: boolean|null, why?: string }} */
        let vault = { item: tailnet.ITEM, exists: null, granted: null };
        const v = await ctx.call("vault.list", { filter: tailnet.ITEM });
        if (v.error) vault.why = v.error.code === "no_such_tool" ? "the vault is not running" : v.error.message;
        else {
          const it = ((v.data && v.data.items) || []).find(x => x && x.name === tailnet.ITEM);
          vault = { item: tailnet.ITEM, exists: Boolean(it), granted: Boolean(it && (it.grants || []).some(g => g && g.module === "computers" && !g.watcher)) };
        }
        const computers = pool.rows().map(r => ({
          agent: String(r.agent), running: r.state === "running",
          node: r.stable_id ? String(r.node || "") : null, stableId: r.stable_id ? String(r.stable_id) : null,
        }));
        return { ...out, vault, computers };
      });

    tool("computers.tailnet.set", "Turn on or off each computer joining the tailnet as its own ephemeral node tagged tag:vyre-agent. The owner's to change, never an agent's; it applies to computers that start afterwards.",
      obj({ enabled: { type: "boolean" } }, ["enabled"]), async (i, { caller }) => {
        const who = notAgent(caller, "whether an agent's computer joins the tailnet");
        if (typeof i.enabled !== "boolean") throw new Error("enabled must be true or false");
        const now = tailnet.setting(tailnetCfg());
        const next = { enabled: i.enabled, tag: now.tag };
        if (!ctx.paths) throw new Error("this vyred has no home to save config in");
        config.save({ computers: { tailnet: next } }, ctx.paths.root, ctx.config);
        ctx.log(`computers' tailnet nodes ${next.enabled ? "on" : "off"} (${next.tag}), set by ${who || "unknown"}`);
        return { ...next, applies: JOINS };
      }, { presence: { summary: i => i && i.enabled === true ? "Let each agent's computer join your tailnet as its own tagged node" : "Stop agents' computers joining your tailnet" } });

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

    // Which agent a tailnet node is, for the names listener (it maps a tagged node that answers
    // here to the caller `tailnet:agent:<name>`).
    //
    // Identity doctrine: a whois of the agent's node strengthens the x-vyre-agent-key vouch and
    // never replaces it. A node proves which container the request came from; the key proves
    // which thread. Over the tailnet both must name the same agent (the daemon still requires the
    // key); off the tailnet the key alone works as before. Only a stable id recorded when that
    // computer joined counts, and only while it runs: a frozen, stopped or vanished computer's
    // node maps to no one, and a policy grant (vyre.run/cap/agent) never names an agent here.
    tool("computers.node.agent", "The agent whose running computer is this tailnet node (by stable id), or null.",
      obj({ stableId: str }, ["stableId"]), async (i, { caller }) => {
        if (!/^module:/.test(String(caller || ""))) throw new Error("only modules may ask which agent a node is");
        return { agent: pool.agentOfNode(String(i.stableId || "")) };
      }, { internal: true });

    return {
      pool, keyboard, shield, fills, driver, sweep,
      async stop() {
        stopDeaths();
        if (timer) clearTimeout(timer);
        keyboard.stop();
        shield.stop();
        fills.stop();
        pool.wake();
        if (glass && typeof glass.stop === "function") { try { await glass.stop(); } catch {} }
      },
    };
  },
};
