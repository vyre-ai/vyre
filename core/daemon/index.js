// @ts-check
// vyred — the one process per machine that runs every Vyre service.
//
// It opens the store, starts the modules this machine's role calls for, and serves the API on
// a unix socket in VYRE_HOME. Surfaces, the Harness hooks and the CLI all talk to it here and
// nowhere else. Networking is the Wink module's and the relay's; the socket
// is always the local way in and never leaves the machine.

import { ZONE_HEADER, zoneFrom } from "../../lib/time/index.js";
import crypto from "node:crypto";
import fs from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../config/index.js";
import { themeCss } from "../config/theme.js";
import { isRealHome } from "../config/dialogs.js";
import { assertDaemonHost, assertNotWindowsHome } from "./host-guard.js";
import { open, setRepairLog } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { Registry, discover, ownerDevice, currentCall } from "../modules/index.js";
import { devSwitch, isPackaged, PKG_ROOT } from "../../kernel/devbuild.js";
import { build, htmlWithBuild } from "./build.js";
import { serveApp, associationFile, appBase, APP_DIST, cspFor } from "./app.js";
import { watchForList } from "./release-watch.js";
import { readReleaseList } from "../../kernel/modules/release-list.js";
import { acquire } from "./lock.js";
import { Presence, PERSON_ONLY, HUMAN_ONLY, personOnly, fingerprint, parse as parsePresence, core as coreHolder } from "../presence/index.js";
import { readCoreConfig, coreLink } from "../../lib/vyre-core-client.js";
import { peerPid, peerHosting, insideClaude, processTable, ancestry, peerIdentity, loginOf, tmuxClients, controllingTty, canReadPeers, verifiedCapsule, signatureOf } from "./peer.js";
import { PersonSessions, COOKIE, MAX as PERSON_MAX, carried } from "../presence/person.js";
import { registryRules } from "../harness/rules.js";
// lib/, not core/relay/index.js: importing the module itself would be a new kernel -> feature
// edge (reviewer's MEDIUM, 2026-09-28) and would pull the whole relay module - link, bridge,
// redeem, tailnet via relay/client - into the kernel just for one constant.
import { DEFAULT_RELAY } from "../../lib/relay-default.js";
import { within } from "../../lib/within.js";
import { modelLabel } from "../../lib/caller.js";
import { createRemoteKernel } from "../../kernel/remote/client.js";
import { lentServiceFor, lentPlacements } from "./lent-service.js";
import { lentRequest } from "./threadsock.js";
import { createResumeLent } from "../runner/resume-lent.js";
import { winkTransport } from "../../kernel/remote/wink.js";
import { proofSigner } from "../../lib/remote-proof.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The SSE heartbeat. Clients call a stream dead after three missed beats (ADR 0029, R1); the
// chaos tests shorten it.
const HEARTBEAT_MS = Number(process.env.VYRE_SSE_HEARTBEAT_MS) || 15_000;
// How long stop() waits for running tool calls.
const DRAIN_MS = 5_000;

/** A client's Idempotency-Key, when it looks like one (8 to 128 url-safe characters). */
function idemKey(req) {
  const k = String(req.headers["idempotency-key"] || "");
  return /^[A-Za-z0-9_.:-]{8,128}$/.test(k) ? k : undefined;
}
/** A device's signed yes sent with a request (`x-vyre-yes`: base64url JSON, at most 4 KB), over exactly this call (lib/one-yes.js signOf). It reaches the registry's floor and nothing else. @param {import("node:http").IncomingMessage} req */
function yesHeader(req) {
  const h = String(req.headers["x-vyre-yes"] || "");
  return h && h.length <= 5500 && /^[A-Za-z0-9_-]+$/.test(h) ? h : undefined;
}
/**
 * A kernel presence proof sent with a request (`x-vyre-kernel-proof`: base64url JSON, at most 4 KB). It reaches the module as `meta.kernel_proof` and nowhere else: the legacy
 * `x-vyre-presence` proof (`meta.proof`) is never what a kernel act accepts, and this header is never what a legacy tool reads. Anything malformed is simply absent.
 * @param {import("node:http").IncomingMessage} req
 */
function kernelProof(req) {
  const h = String(req.headers["x-vyre-kernel-proof"] || "");
  if (!h || h.length > 5500 || !/^[A-Za-z0-9_-]+$/.test(h)) return undefined;
  try { const o = JSON.parse(Buffer.from(h, "base64url").toString("utf8")); return o && typeof o === "object" && !Array.isArray(o) ? o : undefined; } catch { return undefined; }
}
/**
 * What the kernel may build a person's own chain from, for a call that arrived on a connection the daemon itself proved: a person's surface on the 0600 socket (only the owner can
 * connect, so the uid is the daemon's own; Capsule calls wait for the code-signature check to be wired and get none), or a paired device or a signed-in owner device on a listener
 * (the listener established who it is; the person is the home's owner while a home has one). Set here only, never from anything a client sends; `ctx.kernel.chain(meta)` builds the chain
 * from it with the kernel's own builder, which refuses what does not hold. Null when there is nothing to prove.
 * @param {string} caller @param {any} policy @param {any} via @param {any} k the kernel @param {boolean} [capsuleVerified] the peer on this socket is the pinned Capsule binary @param {{ inside: boolean, outside?: boolean } | undefined} [ancestry] what runs above the caller on the socket (a person's surface label gets facts only with this) @param {{ kind: string, removed: boolean } | null} [device] the home's OWN row for a `device:<id>` caller (relay.device.info), never what the relay says about it
 */
export function callerFacts(caller, policy, via, k, capsuleVerified = false, device = null, ancestry = undefined) {
  if (!k || !k.id) return null;
  // The Capsule is the person only when its own binary is the pinned one (`verifiedCapsule`: the cdhash the person pinned, checked per connection and bound to the pid's start time). An unproven one gets no chain.
  if (!policy.caller && caller === "capsule") return capsuleVerified === true ? { kind: "socket", surface: "capsule", uid: typeof process.getuid === "function" ? process.getuid() : 0, pid: 0, inside_model_process: false, capsule_verified: true } : null;
  // LB-1: the label is only a claim on a socket any process under this uid can open, so a person's surface gets facts ONLY after the daemon measured what runs above the caller (`ancestry`, from
  // `above`): from under a Claude or a thread it is a model's (the builder then makes an agent chain, never a person), and with no measurement, or one that could not read the ancestry, there are none.
  // Only `cli` and `local` are what a person at a terminal sends. `deck` and `mobile` reach a daemon through their own listeners (which set policy.caller), so on the socket they are claims nobody legitimate
  // makes: they get no person facts whatever the ancestry says (team-lead, 4 Oct: a bare deck label with no person session is refused every time, not only when the walk says outside).
  if (!policy.caller && ["cli", "local"].includes(caller)) {
    // Inside a model: facts that make an agent chain. Anything but a DEFINITE outside (an unreadable table, a named server above such as tmux or ssh, a `docker exec`, no peer read) gives none: that call is a person only with a person session (LB-2).
    if (!ancestry || typeof ancestry.inside !== "boolean") return null;
    if (!ancestry.inside && ancestry.outside !== true) return null;
    return { kind: "socket", surface: caller, uid: typeof process.getuid === "function" ? process.getuid() : 0, pid: 0, inside_model_process: ancestry.inside, capsule_verified: false };
  }
  // PH-1: a `device:<id>` is the owner's only if THIS home holds a row for it: paired (a gated pairing makes no row before its confirm), not removed, and an app device. A web browser (trusted or
  // not), a setup page, an id the home never paired and a removed device get no person facts; the relay's say-so is never enough. (tailnet nodes are the tailnet listener's own identity, X-1.)
  if (policy.caller && String(policy.caller).startsWith("device:") && !(device && device.kind === "app" && device.removed === false)) return null;
  if (policy.caller && ownerDevice(policy.caller)) {
    // A paired device is a person only as the person its own row names (`device.person`, from Wink's record of who confirmed it), and only while that person is this home's owner: the owner is never
    // handed to a device just because it is an owner device. A row that names nobody, or somebody else, gets no person facts.
    // Once the home's owner is a claimed identity (the kernel's `owner.adopted`), the row must name exactly that identity; before any claim the owner is the home's own first-start id and a device's row names the home's own pre-claim identity.
    if (String(policy.caller).startsWith("device:")) {
      const claimed = k.grants && typeof k.grants.adopted === "function" ? k.grants.adopted() : null;
      if (!device || typeof device.person !== "string" || !device.person || (claimed && device.person !== k.id.owner)) return null;
    }
    const deviceId = String(policy.caller).startsWith("device:") ? String(policy.caller).slice(7) : String((policy.peer && (policy.peer.stableId || policy.peer.node)) || "owner");
    return { kind: "device", device_key_id: deviceId, person: k.id.owner, path: String(policy.caller).startsWith("device:") ? "relay" : "wink", ...(via && via.person ? { session: String(via.person.id) } : {}) };
  }
  return null;
}
/**
 * The session token a request carries (`x-vyre-kernel-session`), which the registry hands the tool as `meta.token` and nowhere else. It is set here only: the daemon checks the
 * token with the kernel's own Surfaces door, and a tool's input, a module's `ctx.call` and every other header never supply one. No header is simply no session
 * (`undefined`). A header that is present but malformed, invalid, expired or revoked is `null`: the call is REFUSED, never run as if it carried none (reviewer-2 KS-4). The
 * kernel re-checks the token when it is used, so expiry and revocation hold for a long turn.
 * @param {import("node:http").IncomingMessage} req @param {(() => any) | null} kernelOf @returns {Promise<string | null | undefined>}
 */
async function kernelSession(req, kernelOf) {
  const h = req.headers["x-vyre-kernel-session"];
  if (h === undefined) return undefined;
  const t = String(h);
  if (!t || t.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) return null;
  const k = kernelOf ? kernelOf() : null;
  if (!k || !k.surfaces || typeof k.surfaces.verify !== "function") return null;
  try { await k.surfaces.verify(t); return t; } catch { return null; }
}

/** The kernel session of a plugin agent (Claude Code on this computer): one per agent and registry, opened by vyred through the same door a thread's is, renewed by its token function. Never handed to the client. @type {WeakMap<object, Map<string, () => Promise<string | undefined>>>} */
const pluginTokensOf = new WeakMap();
/** @param {any} registry @param {string} agent @returns {Promise<string | undefined>} */
async function pluginToken(registry, agent) {
  const open = registry.deps && registry.deps.kernelSession;
  if (typeof open !== "function") return undefined;
  let mine = pluginTokensOf.get(registry);
  if (!mine) { mine = new Map(); pluginTokensOf.set(registry, mine); }
  let f = mine.get(agent);
  if (!f) { const s = await open({ thread: `plugin:${agent}`, agent }); f = s && s.token; if (!f) return undefined; mine.set(agent, f); }
  const t = await f();
  if (!t) mine.delete(agent);
  return t;
}
export const REPO = path.resolve(HERE, "..", "..");
export const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

/** Where modules come from: Vyre's own folders first, then whatever the user installed. */
export function moduleRoots(root) {
  return [path.join(REPO, "core"), path.join(REPO, "local"), path.join(REPO, "modules"), config.paths(root).modules];
}

/**
 * Start vyred. Returns a handle with the running registry and a stop() for tests.
 * @param {{ root?: string, log?: (m: string, x?: any) => void, rules?: any, presence?: any, sessionFor?: (device: string) => Promise<{ call(tool: string, input: any): Promise<any> }>, kernelPresence?: any,
 *   kernel?: boolean, coreKeys?: any, deviceIdentity?: () => Promise<{ deviceId: string, deviceKey: string }>, person?: (socket: import("node:net").Socket) => Promise<string|{ key: string, tty: string|null }|null> }} [opts] person: a test's stand-in for atTerminal
 */
export async function start(opts = {}) {
  const root = opts.root || config.home();
  // A test daemon never boots on the person's Mac (host-guard.js): one place, every boot passes it.
  assertDaemonHost({ root, real: isRealHome(root) });
  // No home on Windows until 0.3.0 (its own sealing service): one plain line, before the lock, the store or any socket.
  assertNotWindowsHome({ packaged: isPackaged(opts.packageRoot), sealer: opts.kernelSealer });
  // A vyred on any home but ~/.vyre (a demo or dev world started in-process with `root`) raises
  // nothing on screen: every dialog gate reads the environment, so say it there.
  // VYRE_ALLOW_DIALOGS=1 is a person's deliberate custom home (core/config/dialogs.js).
  if (!isRealHome(root) && !process.env.NODE_TEST_CONTEXT && process.env.VYRE_ALLOW_DIALOGS !== "1") process.env.VYRE_NO_DIALOGS = "1";
  const p = config.ensure(root);
  // One vyred per home, whatever path reached it; before the store or any module opens.
  const release = acquire(root);
  try { return await startLocked(opts, root, p, release); }
  catch (e) { release(); throw e; }
}

/**
 * The rest of start(), with the home's lock held.
 * @param {Parameters<typeof start>[0] & {}} opts @param {string} root @param {any} p @param {() => void} release
 */
async function startLocked(opts, root, p, release) {
  // Which build this process runs, read now: after an upgrade in place, build.json on disk is the
  // new one, and a vyred that read it later would claim the new commit while running old code.
  build();
  const cfg = config.load(root);
  const logFile = path.join(p.logs, new Date().toISOString().slice(0, 10) + ".log");
  const log = opts.log || ((msg, extra) => {
    const line = `${new Date().toISOString()} ${msg}${extra ? " " + JSON.stringify(extra) : ""}\n`;
    try { fs.appendFileSync(logFile, line); } catch {}
  });
  for (const problem of cfg.problems) log("config: " + problem);

  const db = open(p.db);
  // A migration step that found its column already there is a repair for a mis-ordered list: say so in the log (launch's update proof fails on this line for a released upgrade).
  setRepairLog(line => log(line));
  const events = new Events(db);
  events.log = log;
  // vyred always checks presence. A test may pass a verifier, or a function that builds one on
  // this store (to give the real one fake OS touch points).
  // On a Mac with vyre-core installed (ADR 0040), core holds the trust anchors: every presence
  // check that rests on a key goes to core. Only a root-owned core.json turns this on; Linux never.
  if (process.platform === "darwin" && opts.presence === undefined) {
    const c = readCoreConfig();
    coreHolder.link = c ? coreLink(c) : null;
    if (c) log(`presence: keys and proofs are vyre-core's (${c.socket})`);
  }
  // DEVELOPMENT ONLY: the automated walk's presence stand-in is on only for a development build whose home holds a file the owner made by hand (never config, never a tool).
  const devStandIn = () => !isPackaged(opts.packageRoot) && fs.existsSync(path.join(root, "dev-presence-stand-in"));
  const presence = typeof opts.presence === "function" ? opts.presence({ db, events, log }) : opts.presence || new Presence({ db, events, log, role: cfg.machine, standIn: devStandIn, softwareOk: () => devSwitch(process.env.VYRE_SEAL_SOFTWARE, opts.packageRoot), network: () => cfg.network || {} });
  // Who is the person over the network, not only their device (core/presence/person.js).
  const people = new PersonSessions({ db });
  const started = Date.now();
  /** Open event streams, closed on stop so server.close() is not held open by them. */
  const streams = new Set();
  // Tool calls running now, so stop() lets them finish before it closes (ADR 0029, R7), and
  // whether it has begun to: a call that arrives then is told to come back, not half-run.
  /** @type {Set<Promise<any>>} */
  const inflight = new Set();
  const drain = { on: false };
  /** @type {any} */
  let registry;
  // Modules that open listeners of their own (the tailnet, the onboarding page) establish who is
  // calling themselves, then hand the request to this same router with that caller and a policy
  // limiting what it may reach. The router never reads a caller from their headers.
  const handler = (policy = {}) => (req, res, caller, peer) => route(req, res, { registry, events, cfg, started, streams, root, inflight, drain, people, kernelOf: () => kernel }, { ...policy, caller, ...(peer ? { peer } : {}) })
    .catch(e => fail(res, e));
  // WebSockets a module registered with ctx.upgrade, at /v1/streams/<module>/<name>. Upgraded
  // sockets leave the HTTP server's hands, so they are tracked here and ended on stop, or
  // server.close() would wait on a Glass viewer forever. The socket below and every listener a
  // module opens (the tailnet's, through ctx.upgrader) dispatch here, each with the caller it
  // established.
  const upgraded = new Set();
  const upgrade = (req, socket, head, caller) => {
    const url = new URL(req.url || "/", "http://vyred");
    const m = /^\/v1\/streams\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/.exec(url.pathname);
    const u = m && registry.upgrades.get(`${m[1]}/${m[2]}`);
    if (!u) { socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n"); return; }
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    try { u.handler(req, socket, head, { caller, url }); }
    catch (e) { log(`stream ${m[1]}/${m[2]} failed: ${/** @type {Error} */ (e).message}`); socket.destroy(); }
  };
  const upgrader = () => (req, socket, head, caller) => upgrade(req, socket, head, caller);
  // Every call passes the floor's rules (SPEC 5.3), whoever makes it; a test may pass its own.
  const rules = opts.rules || registryRules({ home: root });
  // firstPartyRoots: in-process tests whose fixture modules stand in for Vyre's own. Only a caller
  // of this function can pass it; vyred's own start (main.js) passes nothing, and it is never read
  // from config.json, the environment or the command line.
  const firstPartyRoots = Array.isArray(opts.firstPartyRoots) ? opts.firstPartyRoots.filter(r => typeof r === "string" && path.isAbsolute(r)) : [];
  registry = new Registry({ db, events, config: cfg, paths: p, spaceDir: (/** @type {string} */ id) => path.join(root, "kernel", "spaces", id), log, rules, handler, upgrader, presence, firstPartyRoots, coreKeys: opts.coreKeys || null });
  // The kernel is ON unless this is a development build started with VYRE_KERNEL=0 (or opts.kernel false). When on, it gives the home a
  // Space and a first owner, a durable log and store, and the module host: modules from outside Vyre then run only under the supervisor (core/modules/index.js).
  /** @type {any} */ let kernel = null;
  let basicDevice = false;
  /** @type {(() => Promise<void>) | null} */ let closeKernelSessions = null;
  /** @type {(() => void) | null} */ let reopenLater = null;
  /** @type {(() => void) | null} */ let closeFlowsHost = null;
  {   // the kernel is always on: there is no other mode
    const { bootHomeKernel } = await import("../../kernel/home.js");
    // The record store: VYRE_STORE=sqlite (the default), auto or twenty (stores/twenty/space-store.js). With auto or twenty each Space's records live in its own Twenty, provisioned
    // on first use, when the box can run it; auto falls back to SQLite on a box that cannot (and a new hosted Space asks first), twenty refuses to start instead. The reach, memory
    // profile and gateway container are options of that factory with defaults, not settings.
    /** @type {((space: string, meta?: any) => Promise<any>) | undefined} */ let storeFor;
    const { storeMode } = await import("../../stores/twenty/space-store.js");
    const isServerInstall = config.isServer(cfg.machine);
    // A device install (a laptop or desktop that is not a server) is Basic: its own SQLite store and only the fixed personal types (records/basic-types.js). A development build allows every type.
    /** @type {{ allow: Set<string>, refusal: string } | undefined} */ let basic;
    if (opts.basic === true || (!isServerInstall && isPackaged())) { const { basicAllow, BASIC_REFUSAL } = await import("../../records/basic-types.js"); basic = { allow: basicAllow(), refusal: BASIC_REFUSAL }; basicDevice = true; }
    if (storeMode(process.env, { server: isServerInstall }) !== "sqlite") {
      const { createStoreFor } = await import("../../stores/twenty/space-store.js");
      storeFor = createStoreFor({ home: root, log, server: isServerInstall, degrade: true });
    }
    // Stages made of tasks (kernel/flows/stages.js): entering a stage makes its tasks in the kernel's own task store, and finished tasks move the record on. The gateway calls the two
    // hooks, which are bound late because the module needs the booted kernel. Tasks live only in the kernel store (no task record in Twenty).
    /** @type {any} */ let stages = null;
    // Flows and stages made of tasks run in ONE assembly per Space (core/daemon/flows-host.js): the home's own Space here, and every hosted Space through the Spaces registry's
    // `stageFactory`. The `flows` module only registers the tools over it. A Flow's "Call a service" step reaches the vault's forward after the kernel has allowed it.
    const { createFlowsHost } = await import("./flows-host.js");
    const catalogOfConnectors = async () => { const r = await registry.call("vault.service.catalog", {}, "module:leases"); return r.error ? {} : r.data.connectors; };
    const { createCalendarSyncHost } = await import("./calendar-sync.js");
    const flowsHost = createFlowsHost({ log, onDevice: fn => events.on("link.mac-online", () => fn()), publish: (/** @type {string} */ type, /** @type {any} */ payload) => events.emit("flows", type, payload), tzFor: () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      // The connectors a Flow may call, with their route rules (no host, no secret): the vault's own list.
      connectors: catalogOfConnectors,
      // The registered tools a Flow's call step may run (their module listed them in flow.steps), the triggers it offers (flow.triggers), and the one way to run a step: as the person, through the registry.
      lights: async () => { const r = await registry.call("connectors.connection.list", {}, "module:vyred"); const rows = r && !r.error && r.data && Array.isArray(r.data.connections) ? r.data.connections : []; return Object.fromEntries(rows.filter((/** @type {any} */ c) => c && c.id && c.light).map((/** @type {any} */ c) => [`conn-${c.id}`, String(c.light)])); },
      // The Space's settings for Flows (concurrency, stuck and stale limits, the backlog cap): read through the settings tool, as the daemon itself.
      settings: async (/** @type {string} */ key) => { try { const r = await registry.call("settings.get", { key }, "module:vyred"); return r && !r.error && r.data ? r.data.value : undefined; } catch { return undefined; } },
      // A module's own tool, as the daemon: the proposals of other modules (an agent's change to itself) keep their drafts there.
      agentsSpace: () => (kernel && kernel.id ? kernel.id.space : null),
      callModule: async (/** @type {string} */ tool, /** @type {any} */ input) => { const r = await registry.call(tool, input, "module:vyred"); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data; },
      flowTools: () => registry.flowTools(), flowTriggers: () => registry.flowTriggers(), callFlow: (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ o) => registry.callFlow(tool, input, o),
      // The Space's calendar, in step with an outside one, by default.
      calendarSync: createCalendarSyncHost({ root, log }),
      // The Google accounts the google module holds (a signed-in calendar), read and written through google.api as module:leases (the daemon's own label for the kernel's lease path)
      google: {
        accounts: async () => { const r = await registry.call("google.accounts", {}, "module:leases"); const d = r && !r.error ? r.data : null; return Array.isArray(d) ? d : d && Array.isArray(d.accounts) ? d.accounts : []; },
        api: async (account, req) => { const r = await registry.call("google.api", { account, ...req }, "module:leases"); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data; },
      } });
    registry.deps.flowsHost = flowsHost;
    // Every tool's static gates, its presence requirement and its asked requirement are decided by the kernel's one check (`authorize`) over the compiled rules (kernel/retrofit/gates.js; the golden set proves it changes no decision), not by the registry's inline predicates.
    const { createLegacyGates } = await import("../../kernel/retrofit/gates.js");
    registry.deps.gates = createLegacyGates({ registry });
    // `{{field:...}}` in an outward action: resolved from the record under the person the session's turn is for (their own grants, not the room's view), by the kernel's resolveFields.
    const { resolveFields } = await import("../../kernel/core/fields.js");
    registry.deps.resolveFields = async (/** @type {{ input: any, meta: any }} */ q) => {
      // RF-1: under the turn token's OWN chain (its agent, its grants: an agent narrowed to one project reads only that project), with the chat left out so it is the person's reading and
      // not the room's. Never a full person chain: a field the session itself cannot read refuses the whole action.
      const asker = await kernel.surfaces.chainFor(q.meta.token, { noChat: true });
      return resolveFields({ input: q.input, read: async (/** @type {string} */ urn) => { const [, type, id] = urn.replace("vyre://", "").split("/"); return kernel.gateway.records.get(asker, type, id); } });
    };
    // The owner's reset of the accepted module list (core/modulelist): the kernel checks the chain is exactly the owner and the presence proof; this only hands it over.
    // Everything on this box that holds data, for `vyre wink reset` (core/wink/reset.js): a reset of an owned box refuses while any entry holds data. The vault's own read (lib/vault-wipe.js) is
    // used when this build has it; without it the vault counts as holding data.
    const { createDataStores } = await import("../../lib/data-stores.js");
    /** @type {any} */ let vaultHolds;
    try { vaultHolds = (await import(/* @vite-ignore */ "../../lib/vault-wipe.js")).vaultHolds; } catch { vaultHolds = undefined; }
    registry.deps.devStandIn = devStandIn;
    registry.deps.dataStores = createDataStores({ home: root, db, kernelEvents: () => kernel.log.read(), ...(vaultHolds ? { vaultHolds } : {}) });
    registry.deps.modulesListReset = (/** @type {any} */ chain, /** @type {any} */ proof, /** @type {string} */ ask) => kernel.resetModulesList(chain, proof, ask);
    registry.deps.modulesListResetPayload = (/** @type {string} */ ask) => kernel.modulesListReset(ask);
    // The command line's sign-in (core/signin): the kernel's op for the phone to sign, and the person sessions the daemon holds, so the module can make and end one for a terminal login.
    registry.deps.cliSigninPayload = (/** @type {string} */ ask, /** @type {string} */ terminal) => kernel.cliSigninPayload(ask, terminal);
    registry.deps.cliSigninCheck = (/** @type {any} */ chain, /** @type {any} */ proof, /** @type {string} */ ask, /** @type {string} */ terminal) => kernel.cliSigninCheck(chain, proof, ask, terminal);
    registry.deps.cliSessions = Object.freeze({ start: (/** @type {string} */ terminal) => people.start({ node: `cli:${terminal}`, kind: "cli", label: "command line" }), end: (/** @type {string} */ terminal) => people.revokeNode(`cli:${terminal}`),
      // Is this node already held by a session that is not a stand-in's? (signin.dev never makes one beside a real session.)
      nodeInUse: (/** @type {string} */ node) => people.list().some((/** @type {any} */ r) => r.node === node && r.label !== "stand-in"),
      // DEVELOPMENT ONLY (the module asks devStandIn first): an ordinary cookie person session for the walk's browser, on the node the harness names, marked as the stand-in's.
      startStandIn: (/** @type {string} */ node) => { const s = people.start({ node, kind: "cookie", label: "stand-in" }); try { events.emit("presence", "presence.signed-in", { id: s.id, node, method: "stand-in" }); } catch { /* the session stands; the event is a notice */ } return s; } });
    closeFlowsHost = () => flowsHost.stop();
    // Devices enrol per Space (the user's ruling): the spaces module keeps the list and answers `spaces.devices.enrolled`; a build without that module has no list, so every device is enrolled.
    const deviceEnrolled = async (/** @type {string} */ space, /** @type {string} */ device) => {
      const r = /** @type {any} */ (await registry.call("spaces.devices.enrolled", { device, space }, "module:vyred", { door: true }));
      if (r && r.error) { if (r.error.code === "no_such_tool" || r.error.code === "not_available") return true; return false; }
      return !r || !r.data || r.data.enrolled !== false;
    };
    // What the runner module needs from this computer: the person it belongs to and this computer's device identity ({ deviceId, deviceKey }: the id the Offers name it by and its public key).
    // The identity comes from whoever owns it (`opts.deviceIdentity`: the Wink identity list's entry for this computer, tailnet and windows); until it is given the runner says it is not connected.
    // A session on this person's own server is sealed at every turn into the home's checkpoint store (core/daemon/ownserver-host.js), so the runner module can seal it and recover it.
    // OWN-SERVER SEAL (sessions): a session on this person's own server is sealed at every turn into the home's checkpoint store (core/daemon/ownserver-host.js); the runner module reads `ownServer` off this host.
    // Keep these lines (the import, ownServerHost and the getter) when merging the runner's { member, identity() } passthrough; test/ownserver-daemon.test.js fails if they go.
    const { createOwnServerHost } = await import("./ownserver-host.js");
    /** @type {any} */ let ownServerHost = null;
    /** Computers by device id for the name a chat's status line shows ("Starting on Office Mac..."), read from the relay's list and kept a minute. */
    let nameAt = 0; /** @type {Map<string, string>} */ let nameMap = new Map();
    const nameCache = async () => {
      if (Date.now() - nameAt < 60_000) return nameMap;
      nameAt = Date.now();
      try { const r = /** @type {any} */ (await registry.call("relay.devices.all", {}, "module:vyred")); const list = r && r.data && (Array.isArray(r.data) ? r.data : r.data.devices); if (Array.isArray(list)) nameMap = new Map(list.filter((/** @type {any} */ x) => x && x.id && x.name).map((/** @type {any} */ x) => [String(x.id), String(x.name)])); } catch { /* the names are a nicety */ }
      return nameMap;
    };
    const runnerHost = () => ({
      get ownServer() { return kernel ? (ownServerHost || (ownServerHost = createOwnServerHost({ kernel, registry, root, log }))) : null; },
      get member() { return kernel && kernel.owner; },
      // the sessions lent for a Space and which chat each belongs to (the home's own view; runner.places)
      lentRows: (/** @type {string} */ space) => { const f = /** @type {any} */ (registry.deps).lentRows; return typeof f === "function" ? f(space) : []; },
      // where each lent session runs, for the place tools (core/runner/place-tools.js): the book of every Space this home serves
      get placements() { return lentPlacements(registry); },
      // A chat's agent process on this person's computer, for the Agent SDK (`sandboxSpawn`, contracts/lent-spawn.md): a ChildProcess whose bytes ride `lent.pipe`. Null when this daemon is not the Space's home.
      lentSpawn: (/** @type {string} */ space, /** @type {any} */ i) => { const f = /** @type {any} */ (registry.deps).lentHome; const h = typeof f === "function" ? f(space) : null; if (!h) return null; const proc = h.spawn(i); if (proc.lent && !proc.lent.computer) proc.lent.computer = nameMap.get(proc.lent.device) || null; void nameCache();
        return proc; },
      // A new chat's place (contracts/lent-spawn.md): a ready computer of the person's with the row written, or the box.
      placeNew: async (/** @type {string} */ space, /** @type {any} */ i) => {
        const f = /** @type {any} */ (registry.deps).lentHome; const h = typeof f === "function" ? f(space) : null;
        if (!h) return { where: "box" };
        const r = h.placeNew(i);
        if (r.where !== "mac") return r;
        const names = await nameCache();
        return { ...r, computer: names.get(r.device) || null };
      },
      // The remote Spaces this computer is set to lend itself to (the person's "Run on this computer" for a Space): an enrolled lender beats for each, whether or not it has run a session there.
      lentTo: async () => {
        const id = opts.deviceIdentity ? await opts.deviceIdentity().catch(() => null) : null;
        if (!id) return [];
        /** @type {string[]} */ const out = [];
        try {
          for (const r of /** @type {any[]} */ (db.prepare("SELECT key, value FROM spaces_kv WHERE key LIKE 'lend/%'").all())) {
            const [, space, device] = String(r.key).split("/");
            let v = null; try { v = JSON.parse(r.value); } catch { /* not a record */ }
            if (!space || device !== id.deviceId || !v || v.lent !== true) continue;
            try { const h = kernel.spaces.for(space); if (h && h.hosted === false) out.push(space); } catch { /* not a Space reached over a wire */ }
          }
        } catch { /* no spaces table yet */ }
        return out;
      },
      identity: async () => {
        const id = opts.deviceIdentity ? await opts.deviceIdentity() : null;
        if (!id || typeof id.deviceId !== "string" || !id.deviceId || typeof id.deviceKey !== "string" || !id.deviceKey) throw Object.assign(new Error("this computer has no device identity yet: pair it first, then call again"), { code: "unavailable" });
        return id;
      },
    });
    // A space this device made with a PAIRED SERVER as its home is hosted there: K.for(id) is a RemoteKernel over the Wink peer wire to that server (the one remote path, kernel/remote). The server's device
    // id is the spaces module's row (server-hosted/<id>); the open peer session comes from the Wink module (`wink.sessionFor`), or a test's `opts.sessionFor`. No row or no session function: not a remote space.
    const remoteFor = (/** @type {string} */ id) => {
      const sf = opts.sessionFor || /** @type {any} */ (registry.deps).winkSessionFor;
      let device = null;
      if (typeof sf === "function") { try { const r = /** @type {any} */ (db.prepare("SELECT value FROM spaces_kv WHERE key = ?").get(`server-hosted/${id}`)); if (r) device = JSON.parse(r.value).device; } catch { /* no spaces table yet */ } }
      // A space this person JOINED on someone else's server (an invite accepted here): the spaces module reaches it with a member stream to the home its record names (the module hands the remote up as `memberRemote`)
      if (typeof device !== "string" || !device) { const mr = /** @type {any} */ (registry.deps).memberRemote; if (typeof mr === "function") { try { return mr(id) || null; } catch { return null; } } return null; }
      return createRemoteKernel({ space: id, transport: winkTransport({ sessionFor: async () => sf(device) }), signer: proofSigner });
    };
    const { openrouterDoorDriver } = await import("../sessions/drivers/openrouter.js");
    // The inference door's providers (the API-key chat drivers' door side: the door scans first, this only makes the call with the key the session passes) and what it reports (counts and classes, never values).
    const modelDrivers = { openrouter: openrouterDoorDriver(), "openai-compatible": openrouterDoorDriver() };
    kernel = await bootHomeKernel({ db, root, log, deviceEnrolled, modelDrivers, requireStore: Boolean(storeFor), emitModel: (/** @type {string} */ type, /** @type {any} */ payload) => { try { events.emit("kernel", type, payload); } catch { /* a notice, never a stop */ } }, onOwnerAdopted: (/** @type {string} */ owner, /** @type {string} */ previous) => events.emit("kernel", "owner.adopted", { owner, previous }), runnerHost, remote: remoteFor, standIn: devStandIn, ...(opts.kernelPresence ? { presence: opts.kernelPresence } : {}), ...(opts.kernelSealer ? { sealer: opts.kernelSealer } : {}), ...(opts.kernelDoor ? { door: opts.kernelDoor } : {}), isFirstParty: dir => registry.isFirstParty(dir), ...(storeFor ? { storeFor } : {}), ...(basic ? { basic } : {}),
      // A credentialed request run at the home: the vault's own forward (an internal tool only the lease module may call), under the Space's credential; the kernel has already authorized it.
      // A lent computer's request for a credential at the point of use (kernel leases.use): the member's provider key, by the vault item the Space's definition names, for one request. The vault's credentials port is the
      // one way to it, and it answers only the key of an API-key account (what `sessions.accounts.key` stores): any other item is not resolved here and the caller gets not_found.
      resolveCredential: async (/** @type {any} */ q) => {
        const port = /** @type {any} */ (registry.deps).credentialsPort;
        // a subscription sign-in token (the claude setup-token item) or an API-key account's key: nothing else is resolved here
        const v = q && typeof q.ref === "string" && port ? (q.ref === "claude-setup-token" ? await port.credentials("claude") : typeof port.apiKey === "function" ? await port.apiKey(q.ref) : null) : null;
        if (typeof v !== "string" || !v) throw Object.assign(new Error("that credential is not open to this session (sessions.accounts.list shows the accounts; sign one in first)"), { code: "not_found" });
        return v;
      },
      forwardCredential: async (/** @type {any} */ q) => {
        const r = q.request;
        // A Flow's named connector: the vault holds the connector's route rules and host (vault.service.forward); the kernel has authorized the chain.
        if (!q.route) {
          const via = await registry.call("vault.service.forward", { connector: q.connector, request: r, ...(q.idem ? { idem: q.idem } : {}), ...(q.approval ? { approval: q.approval } : {}), ...(q.bind ? { bind: q.bind } : {}) }, "module:leases", q.files ? { files: q.files } : undefined);
          if (via.error) throw Object.assign(new Error(via.error.message), { code: via.error.code });
          return via.data;
        }
        // A file request goes to vault.forward.file with the route's limits and Drive lists, and the Drive is this call's own door (q.files: the kernel's Drive under the caller's chain, FW-2),
        // handed in-process as meta, never as data a module could name. A plain request carries the route's header names.
        const base = { credential: q.ref, method: r.method, url: `https://${q.route}${r.path}`, ...(r.query ? { query: r.query } : {}), ...(r.headers ? { headers: r.headers } : {}), ...(q.allow_headers ? { allow_headers: q.allow_headers } : {}), session: q.session || q.idem || "home" };
        const out = q.file
          ? await registry.call("vault.forward.file", { ...base, ...(r.upload ? { upload: r.upload } : {}), ...(r.saveTo ? { saveTo: r.saveTo } : {}), ...(q.limits ? { limits: q.limits } : {}), ...(q.drive ? { drive: q.drive } : {}) }, "module:leases", { files: q.files })
          : await registry.call("vault.forward", { ...base, ...(r.body !== undefined ? { body: r.body } : {}) }, "module:leases");
        if (out.error) throw Object.assign(new Error(out.error.message), { code: out.error.code });
        return out.data;
      },
      onStageEnter: (/** @type {any} */ e) => (stages ? stages.onStageEnter(e) : Promise.resolve()), stageTasks: (/** @type {string} */ u, /** @type {string} */ st) => (stages ? stages.stageTasks(u, st) : []),
      stageFactory: async (/** @type {string} */ space, /** @type {any} */ k, /** @type {any} */ meta) => (basic ? null : (await flowsHost.attach(space, k, meta.owner)).stages) });
    // Flows, Kits, roles and views need a server: a Basic device attaches no flows host, so none of their record types is defined and nothing fails at boot.
    stages = basic ? null : (await flowsHost.attach(kernel.id.space, kernel, () => kernel.id.owner)).stages;
    // A sent email is logged on the client it went to: the Gate's release, read back, filed as a Communication on the matching Contacts (core/daemon/sent-mail-log.js).
    if (!basic) {
      const { watchSentMail } = await import("./sent-mail-log.js");
      watchSentMail({ events, kernel: /** @type {any} */ (kernel).gateway, log, call: (tool, input) => registry.call(tool, input, "module:leases"),
        chain: () => /** @type {any} */ (kernel).chains.fromFacts({ kind: "device", device_key_id: "sent-mail-log", person: kernel.id.owner, path: "direct", session: "sent-mail-log" }) });
    }
    // The home's kernel is up. If its record store could not be set up, it holds a store that answers `unavailable` and the setup is tried again in the background (stores/twenty/space-store.js):
    // from here a definition is a person's act and is refused while the store is away. `registry.deps.storeRetry` tries again now.
    if (storeFor && typeof /** @type {any} */ (storeFor).bootDone === "function") { /** @type {any} */ (storeFor).bootDone(); registry.deps.storeRetry = /** @type {any} */ (storeFor).retry; }
    // A module that failed at start only because the store was still starting (a first install makes the Space's database) starts again when the store joins.
    { const ks = /** @type {any} */ (kernel).store; if (ks && typeof ks.attached === "function" && !ks.attached() && typeof ks.whenReady === "function") ks.whenReady(() => registry.startStoreWaiting()); }
    if (typeof kernel.bindCalls === "function") kernel.bindCalls(currentCall);
    // ONE yes (DESIGN-one-yes): the three moments' proofs are checked by the kernel's own presence verifier (the sealing process; it spends the proof). The card's act and fields are the vocabulary the sealer accepts
    // (signOf in lib/one-yes.js); a software key is refused by the sealer on a release build, and a result that does not say how strong the key was never counts as real.
    if (kernel.presence && typeof kernel.presence.check === "function") {
      const { configureYes, signOf } = await import("../../lib/one-yes.js");
      configureYes({
        verify: async (/** @type {any} */ i) => { const sg = signOf(i.moment, { op: i.request ? i.request.op : i.op, fields: i.request ? i.request.fields : i.fields }); return kernel.presence.check({ ...(i.chain ? { chain: i.chain } : {}), op: sg.op, fields: sg.fields, proof: i.proof }); },
        softwareOk: () => devSwitch(process.env.VYRE_SEAL_SOFTWARE, opts.packageRoot),
      });
    }
    // The session credential of a session vyred starts (lib/kernel-session.js): the kernel opens a token for the owner this home runs as, with the thread's chat written
    // in by the kernel after it checks the owner is in it; vyred holds it and the thread's own socket stamps it on every call, so the session never sees it. An unnamed thread
    // runs as the default assistant. A thread with no chat of its own gets a session of no chat. Only the Switchboard is handed this (core/modules/index.js context).
    // The event bus becomes an adapter over the kernel's log: from here every event is a log entry and its id a log position (what was emitted before the boot moves in).
    events.attach(kernel.log, (/** @type {string} */ name) => {
      // An event is logged under the chain of the module that said it, with that module's own trust: an added module's is external, never first-party (the daemon's own sources and Vyre's modules are).
      const rec = registry.modules.get(name);
      return rec && rec.dir && !registry.isFirstParty(rec.dir) ? kernel.chains.fromFacts({ kind: "module", module: String(name), first_party: false }) : kernel.gateway.serviceChain(name);
    }, kernel.id.space);
    { const n = events.importLegacy(db); if (n) log(`events: ${n} events from before the upgrade were copied into the kernel log (thread history and activity)`); }
    // The narrow verbs an added module declared under needs.kernel (`records`: types it may make, read and change; `files`: folders of the Space's Drive it may write into): the module becomes a service
    // of the Space with exactly those grants (the kernel's own install grants, the machinery a built-in module's needs.kernel uses), acts as itself with an EXTERNAL label (what it brings in is never
    // trusted as the person's own), and has no `define`, no removal and no handle.
    registry.deps.moduleKernel = {
      doors: (/** @type {string} */ name, /** @type {{ records?: string[], files?: string[] }} */ want) => {
        const types = want.records || [], folders = (want.files || []).map(f => String(f).replace(/^\/+|\/+$/g, ""));
        const grants = [
          ...(types.length ? types.map(t => ({ prefix: `${t}/*`, actions: ["records.read", "records.create", "records.update"] })) : []),
          ...folders.map(f => ({ prefix: `file/${f}/*`, actions: ["drive.write"] })),
        ];
        const h = kernel.kernelFor({ name, needs: { kernel: { actions: [], grants } } });
        const chain = () => kernel.chains.appendService(undefined, name, false);
        const typeOf = (/** @type {string} */ urn) => String(urn).replace(/^vyre:\/\/[^/]+\//, "").split("/")[0];
        const allowed = new Set(types);
        const only = (/** @type {string} */ t) => { if (!allowed.has(String(t))) throw Object.assign(new Error(`${name}: ${t} is not a record type its needs.kernel.records lists`), { code: "undeclared" }); return String(t); };
        const within = (/** @type {string} */ p) => { const q = String(p).replace(/^\/+/, ""); if (!folders.some(f => q === f || q.startsWith(f + "/"))) throw Object.assign(new Error(`${name}: ${q} is not in a folder its needs.kernel.files lists`), { code: "undeclared" }); return q; };
        return {
          ...(types.length ? { records: {
            create: async (/** @type {string} */ type, /** @type {any} */ data) => h.records.create(chain(), only(type), data),
            get: async (/** @type {string} */ urn) => h.records.get(chain(), only(typeOf(urn)), String(urn).split("/").pop()),
            list: async (/** @type {string} */ type, /** @type {any} */ o = {}) => { const r = await h.records.query(chain(), only(type), { ...(o.filter ? { filter: o.filter } : {}), page: { limit: Math.min(Math.max(Number(o.limit) || 50, 1), 200) } }); return { rows: r.rows, next_cursor: r.next_cursor || null }; },
            update: async (/** @type {string} */ urn, /** @type {any} */ patch, /** @type {number} */ base) => h.records.update(chain(), only(typeOf(urn)), String(urn).split("/").pop(), patch, base),
          } } : {}),
          ...(folders.length ? { files: {
            /** Write a text or base64 file as a new version: `{ path, text }` or `{ path, base64 }`, at most 8 MB. */
            write: async (/** @type {{ path: string, text?: string, base64?: string }} */ f) => {
              const bytes = f.base64 !== undefined ? new Uint8Array(Buffer.from(String(f.base64), "base64")) : new Uint8Array(Buffer.from(String(f.text ?? ""), "utf8"));
              if (bytes.length > 8 * 1024 * 1024) throw Object.assign(new Error("a file here is at most 8 MB: send a smaller one or split it"), { code: "too_large" });
              const r = await h.drive.put(chain(), within(f.path), bytes);
              return { path: within(f.path), version: r.version, size: bytes.length };
            },
          } } : {}),
        };
      },
    };
    const { createKernelSessions } = await import("../../lib/kernel-session.js");
    // The open turns survive a restart as { person, chat, agent } (never a token) in the home's own database; on start each is reopened for its person, or given up and forgotten.
    db.exec("CREATE TABLE IF NOT EXISTS kernel_turns (thread TEXT PRIMARY KEY, body TEXT NOT NULL)");
    const turns = { durable: true,
      get: (/** @type {string} */ t) => { const r = /** @type {any} */ (db.prepare("SELECT body FROM kernel_turns WHERE thread = ?").get(t)); return r ? JSON.parse(r.body) : undefined; },
      set: (/** @type {string} */ t, /** @type {any} */ rec) => { db.prepare("INSERT INTO kernel_turns (thread, body) VALUES (?, ?) ON CONFLICT (thread) DO UPDATE SET body = excluded.body").run(t, JSON.stringify(rec)); },
      delete: (/** @type {string} */ t) => { db.prepare("DELETE FROM kernel_turns WHERE thread = ?").run(t); },
      all: () => /** @type {any[]} */ (db.prepare("SELECT thread, body FROM kernel_turns").all()).map(r => /** @type {[string, any]} */ ([r.thread, JSON.parse(r.body)])) };
    const kernelSessions = createKernelSessions({ kernel, turns, chats: kernel.kernelFor({ name: "kernel-sessions" }).chats, pinned: async (/** @type {any} */ chain, /** @type {string} */ chat) => { const person = chain && chain.hops && chain.hops[0] && chain.hops[0].actor && chain.hops[0].actor.id; if (!person) return false; const r = await registry.call("work.chat.pinned", { person, chat }, "module:vyred"); return Boolean(r && r.data && r.data.kind === "assistant"); } });
    // A chain of exactly that person, built by the kernel as a DEVICE chain of this home (vyred's own key), never from session facts: a chain made from a session token is delegated and may not mint a session (CH-7), so the opener must not be one. A person who is no longer a member gets none.
    const canonPerson = (/** @type {string} */ p) => { const f = kernel.kernelFor({ name: "kernel-sessions" }).canonicalPerson; return typeof f === "function" ? f(p) : p; };
    // A person id kept from before the owner adopted an identity (a stored turn, a queued message) opens as the identity: canonicalPerson maps the replaced id forward and leaves any other as given.
    const personChainFor = async (/** @type {string} */ person) => kernel.chains.fromFacts({ kind: "device", device_key_id: "vyred", person: canonPerson(person), path: "direct" });
    // The chain a direct yes (x-vyre-presence: yes) is checked in: the home's owner as one person, built the same way.
    registry.deps.ownerChain = () => personChainFor(kernel.id.owner);
    // What the link module's calls as `link:box` are judged as (#114): the person at the paired box, whose answer or words the Mac's link already checked against the box's pinned key. The facts are the ones a
    // person's own terminal here would carry, never a model's, so the Mac's chat gate sees the owner's chain. Only core/modules hands these out, and only to the link module's `link:box` calls.
    registry.deps.linkBoxFacts = () => ({ kind: "socket", surface: "local", uid: typeof process.getuid === "function" ? process.getuid() : 0, pid: 0, inside_model_process: false, capsule_verified: false });
    // the home's own Space, which a signed yes names (the refusal carries `sign` so a client signs exactly the bytes the sealing process checks)
    registry.deps.homeSpace = kernel.id.space;
    // What the stream is given of it (needs.daemon "kernelThreads", core/stream): calls on a thread's session and the restart's reopening, never a token and never a way to open a session.
    // The stream reopens the open turns itself at its start so a turn it cannot resume says so in its chat; when no stream asks (it is off), the daemon reopens them once its modules are up.
    let reopenCalled = false;
    const reopenOpts = (/** @type {any} */ o) => ({ personChainFor, ...o });
    registry.deps.kernelThreads = Object.freeze({
      forThread: (/** @type {string} */ thread) => kernelSessions.forThread(thread),
      reopenPending: (/** @type {any} */ o) => { reopenCalled = true; return kernelSessions.reopenPending(reopenOpts(o)); },
    });
    reopenLater = () => { if (!reopenCalled) void kernelSessions.reopenPending(reopenOpts({ timeoutMs: 10_000, onGiveUp: (/** @type {string} */ thread, /** @type {string} */ why) => log(`sessions: could not resume ${thread.slice(0, 8)} (${why})`) })).catch(() => {}); };
    closeKernelSessions = () => kernelSessions.closeAll();
    registry.deps.kernelSessionCount = () => kernelSessions.list().length; // how many are open now (a number, for tests and status: never a token or a way to open one)
    // One Chat (DESIGN-one-chat.md): a run started with no chat of its own (the CLI, a Flow, the assistant, a resumed older thread) gets one, made under the home owner's own chain: the owner is the
    // person, the assistant it runs as is the one listed assistant. A named agent that is not an actor of the Space cannot be listed, so the chat is then the owner alone (a model run for the person).
    // One Chat: the kernel's `chat.created` and `chat.changed` are visible to the Space's owner only, so the daemon reads them as the owner and says them on the module bus, for the work module's
    // Chat record (its mirror of who is in a chat). Only the event's own facts (ids), nothing is written back.
    try {
      kernel.gateway.events.subscribe(await personChainFor(kernel.id.owner), "daemon-chats", { type: "chat.*" }, (/** @type {any} */ e) => {
        // passed on after the kernel has finished writing it (the bus writes to the same kernel log): never from inside the kernel's own delivery
        if (e && (e.type === "chat.created" || e.type === "chat.changed")) setImmediate(() => { try { events.emit("kernel", e.type, { data: e.data }); } catch { /* a notice, never a stop */ } });
      });
    } catch (e) { log(`kernel: chat events are not passed on (${/** @type {Error} */ (e).message})`); }
    // The kernel's name for the agent a thread runs as: the home's assistant is the Space's one assistant actor whatever the person called it; any other named agent is itself.
    const kernelAgentOf = async (/** @type {{ agent?: string | null, rec?: any }} */ q) => {
      let isAssistant = Boolean(q.rec && q.rec.agent_kind === "assistant");
      if (q.agent && !isAssistant) { try { const sc = await registry.call("agents.scope", { name: q.agent }, "module:vyred"); isAssistant = Boolean(sc && sc.data && sc.data.kind === "assistant"); } catch { /* agents is not running: the name stands */ } }
      return isAssistant ? "assistant" : (q.agent || undefined);
    };
    registry.deps.chatFor = async (/** @type {{ thread: string, agent: string | null, agent_kind?: string | null, name?: string | null, project?: string | null }} */ q) => {
      const person = await personChainFor(kernel.id.owner);
      const grants = kernel.gateway.grants;
      // The person's own assistant is identity-level and private: never a listed participant (its acts are the person's, marked via: "assistant"). Any other agent that runs in a Space is an actor of
      // that Space; one that is not yet is registered through the kernel's own registration (grants.addActor), which asks whatever the gate asks. A refusal there is the run's chat refusal, never an
      // owner-only chat that quietly drops the agent.
      const a = q.agent_kind === "assistant" ? undefined : await kernelAgentOf({ agent: q.agent, rec: { agent_kind: q.agent_kind } });
      const isAssistant = a === "assistant";
      const listed = a && !isAssistant ? [a] : [];
      const make = () => grants.chats.create(person, { assistants: listed });
      try { return String((await make()).id); }
      catch (e) {
        if (!listed.length || !/belongs to the Space/.test(String(e && /** @type {any} */ (e).message))) throw e;
        await grants.addActor(person, { kind: "agent", id: listed[0], space: kernel.id.space }, {});
        return String((await make()).id);
      }
    };
    registry.deps.kernelSession = async (/** @type {{ thread: string, agent: string | null, rec?: any, chat?: string, asker?: string, probe?: boolean }} */ q) => {
      // A chat turn: the Switchboard passes `chat` and `asker` only from module:stream (threads.start and threads.send), so the session is the asker's, in that chat, and the kernel checks they are in it.
      // Anything else is the home owner's own thread, as before.
      const person = await personChainFor(q.asker || kernel.id.owner);
      const chat = q.chat || (q.rec && typeof q.rec.chat === "string" ? q.rec.chat : undefined);
      // A probe asks only: is this person in this chat? (the kernel's own check: not_found when they are not). The Switchboard asks before it queues or runs a chat turn.
      if (q.probe) { kernel.gateway.grants.chats.read(person, chat); return null; }
      // The home's assistant acts in the kernel as the one actor it has, the default "assistant" (core/tasks-tools seeds a task's doer as that id, and the Space adds that actor once at setup), whatever name the person
      // gave it: a named assistant (juno) is not a member of the Space of its own, so its session token carried an agent hop the kernel could not find and every call of its own answered not_found.
      // A run with no agent is a model slot in its chat (team/0.3/DESIGN-one-chat.md): its token's agent hop is the slot id the switchboard minted, narrowed to the run's Project. It acts on the person's own
      // chain, holds nothing of its own, and ends with its person's place in the chat. A run in no chat is as before.
      let kernelAgent = await kernelAgentOf(q);
      let project;
      if (!kernelAgent && chat && q.rec && typeof q.rec.slot === "string" && q.rec.slot.startsWith("model:")) {
        kernelAgent = q.rec.slot;
        if (typeof q.rec.project === "string" && q.rec.project) project = q.rec.project;
      }
      const s = await kernelSessions.open({ chain: person, ...(chat ? { chat } : {}), ...(kernelAgent ? { agent: kernelAgent } : {}), ...(project ? { project } : {}), ...(kernelAgent && kernelAgent.startsWith("model:") ? { slotOpen: true } : {}), thread: q.thread });
      return { token: kernelSessions.tokenFor(s.id), end: () => kernelSessions.end(s.id) };
    };
    // The sandbox every Vyre-started session's agent runs in on this computer (the runner's home sandbox: planHome, selfTest, launch; core/sessions/ cannot import core/runner, so the
    // daemon composes it for the Switchboard, behind the kernel flag). It confines a session to its workspace, its provider's own sign-in paths and its own socket, and keeps
    // the person's socket, other sessions' sockets, the daemon's ports and Vyre's key files out of reach; the self-test runs before each session and a failure stops it with a plain
    // reason.
    // On macOS and Linux a Vyre-started session is always confined: a sandbox that cannot be built is a refusal to start the session (with the reason), never a silent unconfined start
    // (reviewer-3 E-2). Only a development build can opt out (VYRE_SESSION_SANDBOX_OFF=1). Windows starts unsandboxed in 0.3, with the notice the user approved.
    if ((process.platform === "darwin" || process.platform === "linux") && devSwitch(process.env.VYRE_SESSION_SANDBOX_OFF)) registry.deps.sandbox = { off: true };
    // The packaged box (ruling 4 Oct, "b"): no bubblewrap there. A session is confined by the container, a uid of its own (never vyred's, never root) and the wall, and that proves itself
    // before every start, as that uid (core/spawner/confine.js). Only under the box's own supervisor with a spawner to ask; anywhere else a missing bwrap still refuses the start.
    else if (process.platform === "linux" && process.env.VYRE_SUPERVISOR === "docker" && (await import("../spawner/client.js")).available()) {
      const { confineSelfTest, ownListeners } = await import("../spawner/confine.js");
      const userHome = process.env.VYRE_USER_HOME || os.homedir();
      const accounts = process.env.VYRE_ACCOUNTS_HOME || "/home/acct", agentHome = process.env.VYRE_AGENT_HOME || "/home/vyre-agent";
      const spawnerSocket = process.env.VYRE_SPAWNER_SOCKET || "/run/vyre/spawner.sock";
      registry.deps.sandbox = { platform: process.platform, home: os.homedir(), vyreHome: root, temp: os.tmpdir(), uid: { confinedBy: "uid",
        selfTest: (/** @type {{ account?: number | null, shared?: boolean, workdirs: string[], signal?: AbortSignal }} */ o) => {
          // Another agent's home: the box's one agent for an account's session, and the first other account's for the agent itself.
          let other = agentHome;
          if (o.account == null) { try { other = fs.readdirSync(accounts).map(n => path.join(accounts, n)).find(f => fs.statSync(f).isDirectory()) || ""; } catch { other = ""; } }
          else { const mine = path.join(accounts, String(o.account)); try { const o2 = fs.readdirSync(accounts).map(n => path.join(accounts, n)).find(f => f !== mine && fs.statSync(f).isDirectory()); if (o2) other = o2; } catch { /* the box's one agent's home stands */ } }
          const own = ownListeners();   // vyred's own listeners are the box's expected ones; any other listener, UDP port or abstract socket refuses the start, with its port named
          return confineSelfTest({ ...o, vyreUid: process.getuid ? process.getuid() : -1, refuseListen: true, allowListen: [...own.tcp, ...own.udp], allowAbstract: own.abstract, out: [
            { name: "Vyre's own home", path: userHome }, { name: "the vault and keys", path: path.join(root, "kernel") }, { name: "the daemon's socket", path: p.socket },
            { name: "the spawner's socket", path: spawnerSocket }, { name: "the spawner's folder", path: path.dirname(spawnerSocket) }, { name: "the box's secrets folder", path: "/var/lib/vyre-secrets" },
            { name: "the key file", path: path.join(root, "kernel", "space.json") }, { name: "the list of accounts", path: accounts, list: true },
            ...(other ? [{ name: "another agent's home", path: other }] : []) ] }).then(r => { if (r.results.listening.length) log(`confinement: a session's uid can connect to port(s) ${[...new Set(r.results.listening)].join(", ")}, which something in the box listens on`); return r; });
        } } };
    }
    else if (process.platform === "darwin" || process.platform === "linux") {
      try {
        const [{ planHome, selfTest, startHomeProxy }, { launch, unavailable: sandboxUnavailable }] = await Promise.all([import("../runner/homesandbox.js"), import("../runner/sandbox.js")]);
        const sandboxWhy = sandboxUnavailable(process.platform); // no bubblewrap, or none allowed: every start is refused with this reason, nothing is spawned
        registry.deps.sandbox = { sandbox: { planHome, selfTest, launch, homeProxy: o => startHomeProxy({ platform: o && o.platform, dir: path.join(root, "run") }) }, platform: process.platform, home: os.homedir(), vyreHome: root,
          // Real targets, made for each self-test and torn down after it: a unix socket standing in for another session's, and a loopback listener standing in for a daemon port. The
          // sandboxed probe must fail to connect to every one of them, and a probe target that does not exist is refused by the runner's own check.
          probes: async () => {
            const net = await import("node:net");
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-probe-"));
            const other = path.join(dir, "other.sock");
            const servers = /** @type {import("node:net").Server[]} */ ([net.createServer(c => c.destroy()), net.createServer(c => c.destroy())]);
            await new Promise(r => servers[0].listen(other, () => r(undefined)));
            await new Promise(r => servers[1].listen(0, "127.0.0.1", () => r(undefined)));
            const port = /** @type {any} */ (servers[1].address()).port;
            return { personSocket: p.socket, otherSocket: other, daemonPorts: [port], keyFile: path.join(root, "kernel", "space.json"),
              release: async () => { for (const s of servers) await new Promise(r => s.close(() => r(undefined))); fs.rmSync(dir, { recursive: true, force: true }); } };
          },
          temp: os.tmpdir(), ...(sandboxWhy ? { unavailable: `Vyre did not start this session because its sandbox cannot run here: ${sandboxWhy}.` } : {}) };
      } catch (e) {
        registry.deps.sandbox = { unavailable: `Vyre could not set up the sandbox for sessions on this computer (${/** @type {Error} */ (e).message}), so it does not start them.` };
      }
    }
    registry.deps.moduleHost = kernel.moduleHost;
    registry.deps.kernelFor = kernel.kernelFor;
    // The relay's peer stream for a paired device (the one remote path to this home's kernel): the relay module reads it from its ctx, per channel, so a door set after it started is used from the next channel on.
    {
      const { createPeerDoor } = await import("./peer-door.js");
      // the invitee door reads the identity's signed list from the spaces module (the names directory, as at pairing: spaces.identity.state, else a lookup by the claimed Vyre name) and this box's own id from the relay
      const ask = async (/** @type {string} */ t, /** @type {any} */ i) => { try { const r = /** @type {any} */ (await registry.call(t, i, "module:vyred", { door: true })); return r && !r.error ? (r.data !== undefined ? r.data : r) : null; } catch { return null; } };
      const identityEntry = async (/** @type {string} */ identity, /** @type {string} */ eid, /** @type {string} */ name) => {
        let st = await ask("spaces.identity.state", { person: identity });
        let entries = st && Array.isArray(st.entries) ? st.entries : [];
        if (!entries.length && name) { st = await ask("spaces.identity.lookup", { name, id: identity }); entries = st && Array.isArray(st.entries) ? st.entries : []; }
        const e = entries.find((/** @type {any} */ x) => x && x.eid === eid && x.kind === "device");
        if (!e || typeof e.pub !== "string") return null;
        // the signed time the entry was added and whether it founded the list, from the verified chain (the door applies the 24-hour newcomer rule with the sealing process's own clock); unknown stays unknown
        let age = e;
        if (typeof e.since !== "number" || typeof e.founder !== "boolean") { const ev = await ask("spaces.identity.evidence", { person: identity, ...(name ? { name } : {}) }); const f = ev && Array.isArray(ev.entries) ? ev.entries.find((/** @type {any} */ x) => x && x.eid === eid && x.kind === "device") : null; if (f) age = f; }
        return { pub: e.pub, ...(e.alg ? { alg: e.alg, ...(e.rp ? { rp: e.rp } : {}) } : {}), ...(e.held ? { held: e.held } : {}), ...(typeof age.since === "number" ? { since: age.since } : {}), ...(typeof age.founder === "boolean" ? { founder: age.founder } : {}) };
      };
      const boxId = async () => { const r = /** @type {any} */ (await registry.call("relay.route.id", {}, "module:vyred", { door: true })); return r && r.data && r.data.box ? String(r.data.box) : null; };
      const isServer = (/** @type {string} */ id) => { try { const w = registry.modules.get("wink"); return Boolean(w && w.handle && w.handle.peers && w.handle.peers.allow(id) === true); } catch { return false; } };
      // The loader that carries a chat on from a computer of the person's: a host's own (opts.resumeLent, or the registry's), else this server's (core/runner/resume-lent.js), which needs the Switchboard to say
      // where the chat's transcript belongs. The packaged box leaves it off until the spawner can place a transcript for an account's own uid.
      const ownLoader = createResumeLent({
        target: async thread => { const r = /** @type {any} */ (await registry.call("threads.transcript-target", { thread }, "module:vyred", { door: true })); return r && r.data ? r.data : null; },
        port: space => { try { return runnerHostOwn()?.port(space) || null; } catch { return null; } },
        say: (type, payload) => { try { events.emit("runner", type, payload, { thread: payload && payload.thread }); } catch { /* a notice */ } },
      });
      const runnerHostOwn = () => (kernel ? (ownServerHost || (ownServerHost = createOwnServerHost({ kernel, registry, root, log }))) : null);
      const loaderOf = () => opts.resumeLent || /** @type {any} */ (registry.deps).resumeLent || (registry.tools.has("threads.transcript-target") && process.env.VYRE_SUPERVISOR !== "docker" ? ownLoader : undefined);
      const lent = lentServiceFor({ root, lentSpec: opts.lentSpec,
        // a session moved to or from a lender's computer: the chat hears it as thread.moved (declared by the link module, which owns the thread.* events a computer's sessions raise)
        emit: (/** @type {string} */ type, /** @type {any} */ payload) => { try { events.emit("link", type, payload, { thread: payload && payload.thread }); } catch (e) { log(`lent: could not say ${type}: ${/** @type {Error} */ (e).message}`); } },
        // the server carries on a session its lender gave up or lost; the loader that turns a lent transcript into a chat is `opts.resumeLent` (or the registry's `resumeLent`, agent-core's). Until it exists the server
        // takes no session from a computer (`canResume`): a move answers "coming in this release" and the computer keeps running the session, because a session taken with nothing to continue it is a session lost.
        resume: async (/** @type {any} */ i) => { const f = loaderOf(); if (typeof f !== "function") throw Object.assign(new Error("nothing continues a lent session yet: start a new session on that computer instead"), { code: "unavailable" }); return f(i); },
        http: (/** @type {string} */ thread, /** @type {string} */ method, /** @type {string} */ p, /** @type {Record<string, string>} */ headers, /** @type {string} */ body) => lentRequest(thread, method, p, headers, body),
        canResume: () => typeof loaderOf() === "function",
        // the member's provider account: the vault item that holds its key and its endpoint (a name, never a value); none means the session gets no model route
        providerAccount: async (/** @type {any} */ i) => {
          // the credential is the owner of this home's own: a member who is not that person gets no model route from it
          if (!i || String(i.person) !== String(kernel.id.owner)) return null;
          try {
            const r = /** @type {any} */ (await registry.call("sessions.accounts.resolve", { provider: "claude" }, "module:vyred")); const a = r && r.data;
            if (!a || typeof a.vault_item !== "string" || !a.vault_item) return null;
            if (a.kind === "api-key") return { item: a.vault_item, base_url: a.base_url || null };
            if (a.kind === "setup-token") return { item: a.vault_item, base_url: null, oauth: true };
            return null;
          } catch { return null; }
        },
        // an Offer for a computer ended: that computer is told at once, down the connection it holds to this home, and stops its sessions and deletes the local work (core/wink/index.js, runner.revoke)
        onRevoke: (/** @type {string} */ space, /** @type {any} */ info) => { const h = /** @type {any} */ (registry.deps).winkHolds; if (!h) return; Promise.resolve().then(() => h.linkTo(String(info.device)).call("wink.lent.revoked", { space })).catch((/** @type {any} */ e) => log(`lent: could not tell ${String(info.device).slice(0, 8)} its grant ended (${String(e && e.code || "failed")}); it finds out at its next poll`)); } });
      const homeMoves = () => { try { const w = registry.modules.get("wink"); return w && w.handle ? w.handle.homeMoves : null; } catch { return null; } };
      // The lent home of a Space this daemon serves exists from the moment anyone asks, not from the first lender's call: after a restart the book of sessions lent before it is readable at once (the chat's chip, the place tools).
      const hostedKernel = (/** @type {string} */ space) => { if (space === kernel.id.space) return kernel; try { const h = kernel.spaces && kernel.spaces.for(space); return h && h.hosted === true ? h.kernel : null; } catch { return null; } };
      registry.deps.lentHome = (/** @type {string} */ space) => { const k = hostedKernel(space); if (k) { try { lent.ensure(space, k); } catch { /* none for this Space */ } } return lent.home(space); };
      registry.deps.lentRows = (/** @type {string} */ space) => { registry.deps.lentHome(space); return lent.rows(space); };
      registry.deps.lentSpaces = () => lent.spaces();
      registry.deps.lentStop = () => lent.stop();
      const door = createPeerDoor({ kernel, registry, events, people, callerFacts, log, identityEntry, boxId, isServer, homeMoves, lent: lent.ensure, services: (/** @type {string} */ space, /** @type {any} */ k) => { const h = /** @type {any} */ (registry.modules.get("sidebar") && registry.modules.get("sidebar").handle); return h && typeof h.peerService === "function" ? { sidebar: h.peerService({ space, kernel: k, registry }) } : {}; }, onSession: (/** @type {string} */ caller, /** @type {any} */ session) => { const h = /** @type {any} */ (registry.deps).winkHolds; if (h) { h.onSession(caller, session); const dev = /^device:([A-Za-z0-9_-]{1,64})$/.exec(caller); if (dev) void registry.call("files.drop.push", { device: dev[1] }, "module:vyred").catch(() => {}); } } });
      registry.deps.peerDoor = () => door;
    }
    // The gate's presence check asks the kernel whether a call is the person's own (exactly one person hop in the chain the daemon's proven facts build), never the caller's label.
    if (presence && typeof kernel.kernelFor === "function") {
      const gateKernel = kernel.kernelFor({ name: "presence-gate" });
      presence.personOf = async (/** @type {any} */ meta) => {
        try { const c = await gateKernel.chain(meta); return Boolean(c && Array.isArray(c.hops) && c.hops.length === 1 && c.hops[0].actor && c.hops[0].actor.kind === "person"); } catch { return false; }
      };
    }
    if (kernel.firstPartyCheck) registry.deps.firstPartyCheck = kernel.firstPartyCheck;
    if (kernel.reservedName) registry.deps.reservedName = kernel.reservedName;
    registry.deps.moduleApprovals = kernel.moduleApprovals;
    log(`kernel on · space ${kernel.id.space}${kernel.fresh ? " (new)" : ""}`);
  }
  // The eight box-only modules gate on cfg.machine (ADR 0039: solo/server/device), not the
  // legacy cfg.role -- that's what lets a Mac chosen as the server run them.
  // The provider sign-in token for the launcher modules (threads, agents), by declaration (needs.daemon: credentials): from the credentials port taken below, never a module grant on the vault
  // items. Late-bound, because the port is taken after the vault starts; until then it answers undefined and the caller keeps its old grant-based read.
  registry.deps.credentials = (/** @type {string} */ provider) => (registry.deps.credentialsPort ? registry.deps.credentialsPort.credentials(provider) : Promise.resolve(undefined));
  // A box's container is the server: a config that says "device" or "solo" there would switch off every box-only module without a word, so it stops here with the reason.
  if (process.env.VYRE_SUPERVISOR === "docker" && !config.isServer(cfg.machine)) throw new Error(`this is a server's container but its config says machine "${cfg.machine}", which turns off every server module; set "machine": "server" in the home's config.json and start again`);
  // A Basic device holds no planner records (the planner and tasks need a server, records/basic-types.js), so the planner does not start there.
  await registry.start(discover(moduleRoots(root), { firstPartyRoots }), { role: cfg.machine, ...cfg.modules, ...(basicDevice ? { disable: [...new Set([...((cfg.modules && cfg.modules.disable) || []), "planner"])] } : {}) });
  if (reopenLater) reopenLater();
  // The session launcher's way to a provider sign-in token: the vault provided it to the registry once, at its own start (`ctx.provide`, core/modules/index.js), so no import of the vault is needed here.
  // It goes to the sandbox the Switchboard reads per session (`lib/agent-sandbox.js` calls `credentials(provider)`). Where the vault did not start (a Mac whose vault is vyre-core's) there is none.
  // Late-bound: if the vault restarts it provides a fresh port, and the sandbox must ask that one, never the port of a stopped vault.
  if (registry.deps.credentialsPort && registry.deps.sandbox) registry.deps.sandbox.credentials = (/** @type {string} */ p) => { const port = registry.deps.credentialsPort; if (!port) throw new Error("the vault is not running, so no sign-in token is available"); return port.credentials(p); };
  // The join card shows the Space's name and fingerprint words. The module that holds the Space's identity (spaces) answers them through `spaces.label` once it has the Space's
  // root key; until then the card has none. Asked at start, then every 30 s until it answers, then every 10 minutes (a rename shows up), never keeping the daemon alive.
  let stopped = false;
  /** @type {NodeJS.Timeout | null} */ let labelTimer = null;
  if (kernel && typeof kernel.setLabel === "function") {
    /** @type {{ name?: string, words?: string } | null} */ let label = null;
    kernel.setLabel(() => label || {});
    const ask = async () => {
      try {
        const r = await registry.call("spaces.label", {}, "module:vyred");
        const d = r && r.data;
        if (d && (typeof d.name === "string" || typeof d.words === "string")) label = { ...(typeof d.name === "string" ? { name: d.name.slice(0, 80) } : {}), ...(typeof d.words === "string" ? { words: d.words.slice(0, 80) } : {}) };
      } catch { /* the module is not there yet */ }
      if (!stopped) { labelTimer = setTimeout(ask, label ? 600_000 : 30_000); labelTimer.unref(); }
    };
    void ask();
  }

  // A stale socket from a crash would make listen() fail with EADDRINUSE. If nothing answers on
  // it, it is safe to remove; if something does, another vyred is running and this one stops.
  if (fs.existsSync(p.socket)) {
    const alive = await ping(p.socket);
    if (alive) { await registry.stop(); db.close(); throw new Error(`vyred is already running (${p.socket})`); }
    fs.rmSync(p.socket, { force: true });
  }

  const terminalOf = opts.person || (sock => atTerminal(sock, registry, presence, devStandIn(), { log }));
  /** @type {ReturnType<typeof watchForList> | null} */ let releaseWatch = null;
  const server = http.createServer((req, res) => route(req, res, { finishing: () => (releaseWatch ? releaseWatch.state() : null), registry, events, cfg, started, streams, root, inflight, drain, people, socket: true, terminalOf, kernelOf: () => kernel }).catch(e => fail(res, e)));
  server.on("upgrade", async (req, socket, head) => {
    try { upgrade(req, socket, head, (await asTaken(socketCaller(req), /** @type {any} */ (socket), registry)).caller); }
    catch { socket.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(p.socket, () => resolve(undefined)); });
  // No POSIX mode on win32: the socket is a named pipe (core/config/index.js's socketPath),
  // which Node already restricts to this user by default; there is no file for chmod to touch.
  if (process.platform !== "win32") fs.chmodSync(p.socket, 0o600);
  fs.writeFileSync(p.pid, String(process.pid));
  // A kernel-on packaged daemon with no signed module list yet (a server an old updater just updated: the list arrives in shell.json after this first start) waits for it and restarts once.
  releaseWatch = kernel && isPackaged() ? watchForList({
    read: () => readReleaseList(opts.packageRoot || PKG_ROOT, undefined),
    onFound: () => { try { process.kill(process.pid, "SIGTERM"); } catch { /* the loop restarts a vyred that exits */ } },
    log, pollMs: Number(process.env.VYRE_FINISH_POLL_MS) || 2000, waitMs: Number(process.env.VYRE_FINISH_MS) || 120_000,
  }) : null;
  log(`vyred ${VERSION} up · role ${cfg.role} · ${registry.status().filter(m => m.state === "running").length} modules`);

  const stop = async () => {
    if (stopped) return; stopped = true;
    if (labelTimer) clearTimeout(labelTimer);
    if (releaseWatch) releaseWatch.stop();
    if (closeKernelSessions) await closeKernelSessions().catch(() => {});
    if (closeFlowsHost) closeFlowsHost();
    try { /** @type {any} */ (registry.deps).lentStop?.(); } catch { /* the home is going down */ }
    // Stop taking calls, and give the ones running up to DRAIN_MS to finish: a write cut off
    // mid-way looks to its client like a failure it will retry (ADR 0029, R7).
    drain.on = true;
    if (inflight.size) await within(Promise.allSettled([...inflight]), DRAIN_MS);
    for (const end of streams) end();
    for (const s of upgraded) s.destroy();
    // A module's own stream (the link's box events) is not in `streams` or `upgraded`; close
    // what is left.
    server.closeAllConnections();
    await new Promise(r => server.close(() => r(undefined)));
    await registry.stop();
    if (kernel) await kernel.stop();
    db.close();
    fs.rmSync(p.socket, { force: true });
    try { if (fs.readFileSync(p.pid, "utf8") === String(process.pid)) fs.rmSync(p.pid, { force: true }); } catch {}
    release();
    log("vyred down");
  };
  return { registry, events, config: cfg, paths: p, stop, kernel };
}

/** Any label that names an agent, in whatever form: "mcp:agent:kit", "cli agent:kit", "deck:agent:kit". */
const AGENT_CLAIM = /(?:^|[\s:])agent:([A-Za-z0-9_-]*)/;
/**
 * The only forms a socket caller may name an agent in: its MCP server's and its hooks' (harness
 * mcp/server.js, hooks/hook.js). A surface's label with an agent in it ("cli:agent:kit") would be
 * vouched by the key and then pass every callers list as that surface, so it is refused.
 */
const AGENT_LABEL = /^(?:mcp|harness):agent:([A-Za-z0-9_-]+)$/;

/** A route that throws after it began a stream cannot send a 500 (headers are out): end the response, never throw from the catch. */
function fail(res, e) {
  if (res.headersSent) { res.destroy(); return; }
  send(res, 500, { error: { code: "internal", message: e.message } });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function rawBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 5_000_000) throw new Error("request too large"); }
  return raw;
}

/** A request's body as bytes, capped, for sync.upload's chunks (never JSON: octet-stream only). */
async function rawBinary(req, max) {
  const parts = [];
  let got = 0;
  for await (const chunk of req) {
    got += chunk.length;
    if (got > max) throw Object.assign(new Error(`a chunk is at most ${max} bytes`), { code: "bad_input" });
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

async function body(req) {
  // The router may have read it already, to check a person session's signature over it.
  const raw = req.vyreRaw !== undefined ? req.vyreRaw : await rawBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("request body is not JSON"); }
}

/**
 * @typedef {{ caller?: string, thread?: string, agent?: string, tool?: (name: string) => boolean, path?: (method: string, pathname: string) => boolean,
 *   eventType?: string, headers?: Record<string, string>, peer?: { node: string, stableId: string|null, login: string|null,
 *   tags?: string[], caps?: Record<string, any[]>, kind?: "owner"|"guest"|"agent", agent?: string, origin?: string } }} Policy
 * A policy from a module's listener: the caller it established, which tools and paths it may reach,
 * the only event type its streams may see, and headers to add to every response. The socket has none.
 */

/**
 * The chat's id for one tool call (X-Vyre-Call-Id), or null. Read only on a session's own paths
 * (its thread socket, or a call vyred bound to a thread by its agent or session key), so a tool can
 * link what it shows (a Glass step) to that call's row in the chat. It is the session's claim,
 * never checked, and no tool decides anything on it. A malformed id is dropped without a word.
 */
export const callId = v => (typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null);

// "link:" is the paired box's person on a Mac, which only the link module may call as (CALL_AS in
// core/modules): threads.answer takes it only with the box's signed assertion checked.
// "web:", "setup:" and "space:" are labels the relay and the spaces listener make (a waiting or browser pairing, the setup page, a visiting person); a socket client never gets them, nor the bare
// class words that only a tool's callers list uses (reviewer-3 LB-1b).
const FORBIDDEN_LABEL = /^(module:|tailnet:|tailnet-guest:|device:|link:|web:|setup:|space:|invitee:|onboard$|hook$|web$|setup$|space$|device$|tailnet$|agent$)/;

/**
 * Who a socket request says it is. No label is "anonymous", which no tool's callers list names,
 * so a bare curl on the socket is not a person (ADR 0006, finding 2). A label claiming an identity
 * only a listener or the registry sets is "anonymous" too.
 */
export function socketCaller(req) {
  const label = String(req.headers["x-vyre-caller"] || "");
  if (!label || FORBIDDEN_LABEL.test(label)) return "anonymous";
  // RC-1: a model's label carries no thread the client chose. `mcp:thread:<id>` is bare `mcp` here; route() rebuilds the thread part from what it verified. A named agent stays: route() checks its key.
  return MODEL_LABEL.test(label) && !AGENT_CLAIM.test(label) ? /** @type {string} */ (modelLabel(label)) : label;
}

/** A model's own label: its tools' callers lists and the agent key already decide what it may do. */
const MODEL_LABEL = /^(mcp|harness)(?=$|[\s:])/;

/**
 * Why a socket call for a person is refused, or null. The label is only a claim, so vyred asks the
 * kernel which process connected (core/daemon/peer.js). From under a `claude`, or under a process
 * vyred runs a thread in, it is a model's shell however it names itself: it is an agent caller,
 * refused silently, and no presence proof or session counts for it. So is a caller whose ancestry
 * vyred cannot read to the top -- unless it claims to be the Capsule and proves it another way
 * (core/daemon/peer.js's verifiedCapsule): the Capsule's own process has this same ambiguous
 * shape (its own session, no controlling terminal) and is not on the terminal-host allowlist, so
 * ancestry alone would always refuse it.
 * @param {import("node:net").Socket} socket @param {any} registry @param {string} [caller]
 */
async function fromClaude(socket, registry, caller) {
  const who = await above(socket, registry, caller);
  if (who.nopid) return "vyred cannot tell which process is calling, so this is refused";
  if (who.inside) return "this comes from inside a Claude session, which acts as an agent: only the person answers, approves and proves presence";
  return who.unknown ? "vyred cannot read which processes this call runs under, so this is refused" : null;
}

/**
 * What runs above the process on this socket: a `claude` or one of vyred's threads (inside), an
 * ancestry vyred cannot read to the top (unknown), or no pid at all (nopid). A caller claiming to
 * be the Capsule gets one more chance before "unknown": its own pinned code identity, checked and
 * cached once per connection (core/daemon/peer.js's verifiedCapsule).
 * @param {import("node:net").Socket} socket @param {any} registry @param {string} [caller]
 * @returns {Promise<{ inside: boolean, unknown?: boolean, nopid?: boolean }>}
 */
/**
 * Retries `check()` a bounded few times while it says unknown with no named server, so a process
 * that exits between the socket connecting and a /proc read (sessions' find, 28 Sep: a real race
 * under a loaded box spawning many short-lived vyre CLI children) gets a second look before this
 * is trusted as final. Never more than `attempts` retries, so this cannot be stretched into a
 * long hang; still fails closed if every attempt agrees. Peer.js's OTHER unknown shapes (an
 * orphan whose group died, or a named server with no readable start time) are deterministic, not
 * a race, so retrying them changes nothing -- harmless, just a little slower.
 * @param {() => { unknown?: boolean, server?: any }} check
 * @param {number} [attempts] @param {number} [delayMs]
 */
export async function retryUnknown(check, attempts = 2, delayMs = 25) {
  let result = check();
  for (let n = 0; result.unknown && !result.server && n < attempts; n++) {
    await new Promise(res => setTimeout(res, delayMs));
    result = check();
  }
  return result;
}

/** Is this pid a running process? (EPERM means it is, and is not ours.) @param {number} pid */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; }
}

/**
 * Whether the process on a socket runs under a Claude session or a thread vyred started.
 * `deps` are test seams.
 * @param {import("node:net").Socket} socket @param {any} registry @param {string} [caller]
 * @param {{ capsuleSeam?: any, peerPid?: typeof peerPid, insideClaude?: typeof insideClaude, processTable?: typeof processTable, alive?: (pid: number) => boolean, delayMs?: number }} [deps]
 */
export async function above(socket, registry, caller, deps = {}) {
  const pid = await (deps.peerPid || peerPid)(socket);
  if (!pid) return { inside: false, nopid: true };
  // vyred never connects to its own socket: a peer that is vyred itself is a misread (a recycled
  // descriptor), never the person. Only a test hosting vyred in its own process (peerHosting)
  // is let through.
  if (!peerHosting() && pid === process.pid) return { inside: true, by: pid, self: true };
  const r = await registry.call("threads.pids", {}, "module:vyred");
  // The processes vyred runs threads in, their process groups and sessions (core/sessions/spawn.js
  // keeps a group listed until its last process is gone, so an orphan is still caught).
  const d = r.data || {};
  const threads = [...(d.pids || []), ...(d.pgids || []), ...(d.sids || [])];
  // The first look may read a snapshot shared for a quarter second (and re-reads it on a miss);
  // every retry starts from a table read of its own.
  let looks = 0;
  const table = deps.processTable || processTable;
  const check = deps.insideClaude || insideClaude;
  let result = await retryUnknown(() => check(pid, { threads, look: table({ fresh: looks++ > 0 }) }), 2, deps.delayMs);
  // The pin lives in vyred's own db (presence.capsulePin()), never a file the same uid a model's
  // shell runs as could write to directly. The Capsule (launchd-started, its own session, not on
  // the terminal list) is the one positive proof besides the walk's own.
  if (result.unknown && caller === "capsule" && registry.deps.presence
    && await verifiedCapsule(socket, pid, registry.deps.presence.capsulePin(), deps.capsuleSeam)) return { inside: false };
  // A `vyre` the Capsule spawned by argv: its top is the Capsule itself, named as a server. The pinned
  // cdhash proves that top too (every link below it passed the walk's own checks), so no prompt.
  if (result.server && registry.deps.presence
    && await verifiedCapsule({}, result.server.pid, registry.deps.presence.capsulePin(), deps.capsuleSeam)) return { inside: false };
  // Still unreadable and the caller is gone: it connected, sent and exited before the walk (a
  // forger's fire-and-forget). A real CLI waits for its answer, so it is alive here. Gone counts
  // as a model's, never as the person's.
  if (result.unknown && !result.server && !(deps.alive || alive)(pid)) result = { inside: true, by: pid, exited: true };
  // Fail closed: a chain the walk cannot rely on (a pid it lacks, an empty or timed-out ps read, an
  // unreaped link, a foreign uid, a pid reused, a top that proves nothing) is a model's, never the
  // person's. What stays unknown: a named server (the person proves it once) and a docker exec.
  else if (result.unreadable && !result.server) result = { inside: true, by: pid, unreadable: true };
  return result;
}

/**
 * A server this process lives in (tmux, screen, sshd, Ghostty, iTerm2's server, a setsid'd model
 * -- anything insideClaude names rather than flatly refusing), once trusted -- for the rest of
 * that exact server's life (the lead's decision, 28 Sep: nobody with a real, unlisted terminal
 * gets locked out; one proof, then trusted). A Map, not a socket-scoped cache, since the same
 * server is reached over many different connections (every pane or ssh session's own call). Keyed
 * by the server's exe, pid and start time, never a bare pid (a recycled pid never matches an old
 * key) and never shared with a different server (a model-started one is its own process with its
 * own pid and start time, so it always needs its own proof -- it can never inherit the person's).
 * @type {Map<string, true>}
 */
const serverTrust = new Map();

/**
 * One presence proof on any call trusts that server for every later call from any of its panes or
 * sessions, until it exits. @param {{exe:string,pid:number,started:string}} server
 * @param {string|string[]|undefined} proofHeader @param {string} caller @param {any} registry
 */
// Hardware or a key a model cannot read, same as presence's own SESSION_FROM (a session opens
// only from one of these too). NOT "tty": a model in its own detached tmux pane, or under a
// setsid'd script/pty, IS the terminal that method writes its code to, so it could read the code
// and answer its own challenge -- circular, not a proof at all here (the reviewer's MEDIUM,
// 28 Sep). NOT "code" or "session" either, for the same reason: nothing here needs the person to
// be at a DIFFERENT terminal.
const SERVER_TRUST_METHODS = new Set(["touchid", "capsule", "device", "passkey"]);

/** What the proof is over -- so a signature made for one server's prompt can never answer a
 * different one's, and so the client signs exactly what the presence_required error already told
 * it about this leader. */
const sessionInput = server => ({ exe: server.exe, pid: server.pid, started: server.started });

/** How the person is told what is asking. peer.js keys an unreadable root leader "uid0" (sshd,
 * cron, a login manager: vyred cannot read which binary), so that one is described, not named. */
const serverName = server => server.exe === "uid0"
  ? `a system service running as root that Vyre cannot identify (pid ${server.pid}, started ${server.started}; for example sshd, cron or a login manager)`
  : `${server.exe} (pid ${server.pid}, started ${server.started})`;

/** The code signature of the process on this socket, or null when it cannot be read. @param {import("node:net").Socket} socket */
async function signedBy(socket) {
  const pid = await peerPid(socket);
  return pid ? signatureOf(pid) : null;
}

async function serverTrusted(server, proofHeader, caller, registry) {
  const key = `${server.exe}:${server.pid}:${server.started}`;
  if (serverTrust.has(key)) return true;
  const presence = registry.deps.presence;
  // Test seam only: a verifier handed to start() in-process may already trust the leader its own
  // test runs under (test/fixtures/vyred-leader.js, temp homes only), so CLI tests run over ssh on
  // the testbox. vyred's own Presence has no such method, and main.js never passes a verifier.
  if (presence && typeof presence.trustsServer === "function" && presence.trustsServer(server) === true) { serverTrust.set(key, true); return true; }
  const proof = parsePresence(/** @type {string} */ (proofHeader));
  // DEVELOPMENT ONLY: on a development build whose owner made the hand-made stand-in file (false on a packaged build, see devStandIn), the stand-in answers this ask too, so a walk over ssh (the root sshd leader
  // vyred cannot read) can reach the acts that need a person, the way it already does for every other proof ask. The proof is logged as method "stand-in" by the verifier; nothing else changes.
  if (presence && String(proofHeader || "").trim() === "stand-in" && typeof presence.standIn === "function" && presence.standIn() === true) { serverTrust.set(key, true); return true; }
  if (!presence || !proof || !SERVER_TRUST_METHODS.has(proof.method)) return false;
  // Plain wording, naming exactly what is asking -- the lead's decision, 28 Sep: a model can name
  // its own process anything, so the reason must be specific enough that a real person can tell
  // their own Warp window from a model-caused prompt apart, not just "an app wants to act as you".
  const summary = `A program Vyre doesn't recognise wants to act as you: ${serverName(server)}. Did you just open this?`;
  const r = await presence.verify({ tool: "session.trust", input: sessionInput(server), caller, proof, def: { presence: { summary: async () => summary } } });
  if (r.ok) { serverTrust.set(key, true); return true; }
  return false;
}

/**
 * A socket caller as vyred takes it. Any label but a model's own (a surface's, core/modules
 * SURFACE_LABELS, or one no surface uses yet) from a process under a `claude` or a thread is that
 * model's shell, so it is the session's own label ("mcp", or "mcp:thread:<id>" when the call
 * proved its session), for every tool: a label is only a claim (team/archive/work-journals/e2e.md, the team
 * review). "anonymous" stays: the session could say "mcp" itself, so it gains nothing. An ancestry vyred cannot read (a `docker exec` on the box has parent 0) keeps its label
 * here, but a label alone is never a person: `outside` is false for it, so callerFacts builds no person chain for it, and it is a person only with a person session (LB-2). The person's own actions still refuse it (fromClaude). Asked once per connection.
 * @param {string} caller @param {import("node:net").Socket} socket @param {any} registry @param {string} [thread]
 * @param {Parameters<typeof above>[3]} [deps] test seams for above()
 * `outside` is true only when the ancestry was read to the top and nothing above the caller is a model or a named server: the one answer from which a surface's label may become a person's chain (callerFacts).
 * An unreadable table, a peer not found, a named server above the caller (tmux, ssh, a terminal app) or a `docker exec` with no parent is NOT outside: such a call is a person only with a person session, never by its label (LB-2).
 * @returns {Promise<{ caller: string, model: boolean, outside: boolean }>}
 */
export async function asTaken(caller, socket, registry, thread, deps) {
  if (MODEL_LABEL.test(caller) || caller === "anonymous") return { caller, model: false, outside: false };
  let v = taken.get(socket);
  // A peer vyred cannot read where it normally can (perl failed or timed out) is not taken on its
  // word: a surface's label then counts as a model's, so a stall never reopens the forged label.
  // Only a definite answer stays for the connection's life: inside a model, or read to the top and
  // outside. "Unknown" (an unreadable chain, a peer not found) is asked again on the next call.
  if (!v) {
    // A peer read that comes back empty (a busy box starving the helper) is retried a few times, short and bounded, while the connection is still open: a real person's CLI must not be refused because
    // a helper ran late. Still empty: the call is not taken on its word (a model's, as before) and the refusal says Vyre could not tell who was calling.
    const measure = async () => {
      let w = await above(socket, registry, undefined, deps);
      for (let n = 0; n < PEER_RETRIES && w.nopid && canReadPeers && !socket.destroyed; n++) {
        await new Promise(r => setTimeout(r, deps && typeof deps.peerRetryMs === "number" ? deps.peerRetryMs : 60 * (n + 1)));
        w = await above(socket, registry, undefined, deps);
      }
      return w;
    };
    const mine = measure().then(w => ({
      model: Boolean(w.inside || (w.nopid && canReadPeers)),
      definite: Boolean(!w.unreadable && (w.inside || (!w.unknown && !w.nopid))),
      outside: Boolean(!w.inside && !w.unreadable && !w.unknown && !w.nopid && !w.server && canReadPeers),
      server: !w.inside && w.server ? w.server : null,
      couldNotTell: Boolean((w.nopid && canReadPeers) || w.unreadable),
      // which half failed, for the log and the refusal: the kernel gave no pid for the socket, or the pid's ancestry could not be read
      why: w.nopid && canReadPeers ? "peer_pid_unread" : w.unreadable ? "process_chain_unreadable" : undefined,
    }));
    v = mine;
    taken.set(socket, mine);
    // A measurement that did not come out definite (a slow or failed peer read, an unreadable table) is "unknown": never a person, asked again on the next call, and logged ONCE per connection (a model's
    // shell must not be able to fill the log by calling again and again).
    mine.then(a => { if (!a.definite) { if (!told.has(socket)) { told.add(socket); try { registry.deps && typeof registry.deps.log === "function" && registry.deps.log(`ancestry: unknown for a socket call (${a.why || "not definite"}; not a person; asked again next call)`); } catch { /* logging never decides */ } } if (taken.get(socket) === mine) taken.delete(socket); } }, () => { if (taken.get(socket) === mine) taken.delete(socket); });
  }
  const a = await v;
  return a.model ? { caller: thread ? `mcp:thread:${thread}` : "mcp", model: true, outside: false, couldNotTell: a.couldNotTell, ...(a.why ? { why: a.why } : {}) } : { caller, model: false, outside: a.outside, server: a.server, couldNotTell: a.couldNotTell, ...(a.why ? { why: a.why } : {}) };
}
const PEER_RETRIES = 3;
/** Sockets whose unknown ancestry was already logged. @type {WeakSet<object>} */
const told = new WeakSet();
/** @type {WeakMap<object, Promise<{ model: boolean, definite: boolean, outside: boolean, server: any, couldNotTell: boolean }>>} */
const taken = new WeakMap();

/** The tools that need the calling terminal's login, never a model's shell: the command line's sign-in. */
const SIGNIN_TOOLS = new Set(["signin.ask", "signin.status", "signin.end"]);

/**
 * The ancestry callerFacts takes for a socket call, from asTaken's answer. `outside` is the daemon's own measurement. DEVELOPMENT ONLY: with the hand-made stand-in file (`standIn`, which is false in a
 * release-kind build, see devStandIn) a call that is not inside a model counts as outside too, so a CLI at a terminal over ssh is the signed-in owner on a dev box and can seed and walk it. A caller
 * inside a model has already been relabelled `mcp` and never gets person facts, stand-in or not. `cliSession` is a live command-line session (`vyre signin`) carried by this call and pinned to the
 * terminal login the daemon measured for it: the same person facts, on a release build too.
 * @param {{ model: boolean, outside?: boolean, server?: any }} shell @param {boolean} standIn @param {boolean} [cliSession] @returns {{ inside: boolean, outside: boolean }}
 */
export function surfaceAncestry(shell, standIn, cliSession = false) {
  const named = standIn === true && shell.model !== true && isLoginServer(shell.server);
  return { inside: shell.model === true, outside: shell.outside === true || (shell.model !== true && (cliSession === true || named)) };
}

/** What the development stand-in is for: a login over ssh. A named server at the top of the chain that is ROOT-owned (uid 0) and a login program, run from a system folder. A server any user process can start (tmux, screen, a terminal app, a daemonized sh) is as easy for a model to start as a setsid'd shell, so those use the real `vyre signin` (SI-1, SI-1b). */
const LOGIN_SERVERS = new Set(["sshd", "login"]);
const SYSTEM_DIRS = ["/usr/", "/bin/", "/sbin/", "/Applications/", "/System/", "/Library/"];
/** @param {any} server */
export function isLoginServer(server) {
  const exe = server && typeof server.exe === "string" ? server.exe : "";
  if (exe === "uid0") {
    // vyred runs as the login user and the kernel hides /proc/<pid>/exe of a root process from it, so the walk records "uid0" with the process's comm and command line. A root-owned sshd or login
    // is named by both, and the uid is the kernel's word that it is root's: a user process called sshd has its own uid, and tmux, screen and a daemonized shell are never uid 0.
    const cmd = typeof server.cmd === "string" ? server.cmd : "";
    return server.uid === 0 && LOGIN_SERVERS.has(String(server.comm || "")) && /^(?:\S*\/)?(?:sshd|login)(?::|\s|$)/.test(cmd);
  }
  return Boolean(exe) && server.uid === 0 && LOGIN_SERVERS.has(path.basename(exe)) && SYSTEM_DIRS.some(d => exe.startsWith(d));
}

/**
 * The login the person on the socket is typing in, as a key ("ttys003#812@<start>"), or null. Null
 * from under a `claude` or a thread (fromClaude), and null without a login terminal `who` lists: a
 * double-forked or setsid'd process has none, and `script` or expect ptys are not logins. The key
 * names the login's leader and its start time, so a new login that reuses the tty number starts
 * with nothing. A tmux pane counts when every client attached to its session runs in such a login
 * with no claude above it (tmux attached from a login shell); the key is then those logins. The
 * kernel says which process connected and which terminal it runs in, so no label or file can fake
 * it. This is what lets one proof serve the CLI for 30 minutes, as a session serves the Deck (the
 * no-nag rule; the CLI is a first-class surface).
 * @param {import("node:net").Socket} socket @param {any} registry @param {any} presence
 * @returns {Promise<{ key: string, tty: string|null }|null>} tty: the caller's own terminal, where a notice goes
 */
export async function atTerminal(socket, registry, presence, standIn = false, deps = {}) {
  const d = { above, peerPid, loginOf, tmuxClients, insideClaude, loginFrom, ...deps };
  /** Why no terminal, said once in the daemon log (never a secret: a pid, a tty name and the logins `who` lists). @param {string} why */
  const no = why => { try { const say = typeof d.log === "function" ? d.log : registry.deps && typeof registry.deps.log === "function" ? registry.deps.log : null; if (say) say(`terminal: refused, ${why}`); } catch { /* logging never decides */ } return null; };
  // The development stand-in (a hand-made file in a development build) is the one thing that replaces this guard; a real build never passes it.
  /** @type {any} */ let who = null;
  if (!standIn) {
    who = await d.above(socket, registry);
    if (who.nopid || who.inside || (who.unknown && !who.server)) return no("ancestry " + (who.nopid ? "has no peer pid" : who.inside ? "is inside a model" : "is unknown with no named server"));
  }
  const pid = await d.peerPid(socket);
  if (!pid || !presence || typeof presence.who !== "function") return no(!pid ? "no peer pid" : "no presence.who");
  const logins = await presence.who();
  // SG-1 (reviewer-2): the login the person types in is a root-owned login server (sshd, login) at the top, or a tmux the person attached to from one. A user-owned named server (a model that
  // double-forked and kept the person's tty) is not a login, whatever `who` lists: only the walk's own `outside` (no server at all) or a login server passes for the caller itself.
  const callerOk = standIn || !who.unknown || isLoginServer(who.server);
  const login = d.loginOf(pid);
  if (callerOk && login && logins.includes(login.tty)) return { key: login.key, tty: login.tty, from: await d.loginFrom(login.tty) };
  const clients = d.tmuxClients(pid);
  if (!clients || !clients.length) return no(`no login: ${callerOk ? "" : "a user-owned server is not a login; "}the caller's terminal is ${login ? login.tty : "none"} and who lists ${logins.join(",") || "nothing"}`);
  const r = await registry.call("threads.pids", {}, "module:vyred");
  const threads = (r.data && r.data.pids) || [];
  const keys = [];
  let from = null;
  for (const c of clients) {
    const ins = d.insideClaude(c, { threads });
    // A client must read as the person's own: not inside a model, and not an unknown chain unless it tops out at a root login server.
    if (ins.inside || (ins.unknown && !standIn && !isLoginServer(ins.server))) return no("a tmux client is not a person's login (inside a model or a user-owned server)");
    const l = d.loginOf(c);
    if (!l || !logins.includes(l.tty)) return no(`a tmux client is not a listed login (${l ? l.tty : "none"})`);
    keys.push(l.key);
    from = from || await d.loginFrom(l.tty);
  }
  return { key: "tmux:" + [...new Set(keys)].sort().join("+"), tty: controllingTty(pid), from };
}

/** Where the login on this terminal came from, as `who` records it ("203.0.113.9", "127.0.0.1"), or null when it lists none. @param {string} tty @returns {Promise<string|null>} */
function loginFrom(tty) {
  return new Promise(resolve => {
    execFile("/usr/bin/who", [], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      for (const line of String(stdout).split("\n")) {
        const cols = line.trim().split(/\s+/);
        if (cols[1] === tty) { const m = /\(([^)]*)\)\s*$/.exec(line); return resolve(m && m[1] ? m[1].slice(0, 80) : null); }
      }
      resolve(null);
    });
  });
}

async function route(req, res, { registry, events, cfg, started, streams, root, inflight, drain, people = null, socket = false, terminalOf = null, kernelOf = null, finishing = () => null }, /** @type {Policy} */ policy = {}) {
  const url = new URL(req.url || "/", "http://vyred");
  // On the socket the header is only a label, and anything on the box can send it (Claude's own
  // processes included). "module:*" is what the registry uses between modules, "hook" is what the
  // webhook route sets, and "tailnet:*" and "onboard" are identities only a listener establishes
  // (ADR 0002). None of them may be claimed over the socket; such a claim, or none, is "anonymous".
  let caller = policy.caller || socketCaller(req);
  for (const [k, v] of Object.entries(policy.headers || {})) res.setHeader(k, v);
  if (policy.path && !policy.path(req.method || "GET", url.pathname)) return send(res, 404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
  if (policy.tool && url.pathname.startsWith("/v1/tools/") && !policy.tool(decodeURIComponent(url.pathname.slice("/v1/tools/".length)))) {
    return send(res, 404, { error: { code: "no_such_tool", message: "no such tool here" } });
  }
  // Naming an agent ("mcp:agent:<name>", "harness:agent:<name>") is a claim Memory, the Gate and
  // the Switchboard act on, and naming the assistant reaches every project. So it must come with
  // the key the Switchboard put in that agent's thread (x-vyre-agent-key); without it, nothing.
  // What vyred has checked about the caller, which tools get beside it: run(input, { caller, thread, agent, peer }).
  // The tailnet peer a network listener established (node, stableId, login) rides here too.
  /** @type {{ thread?: string, agent?: string, peer?: any, person?: { id: string, kind: string } }} */
  const via = policy.peer ? { peer: policy.peer } : {};
  // A session's own socket (core/daemon/threadsock.js): vyred bound the thread and the agent when
  // it opened it, so neither is read from the call, and no key is asked for.
  if (policy.thread) { via.thread = String(policy.thread); if (policy.agent) via.agent = String(policy.agent); }
  // The person, not only their device (core/presence/person.js, ADR 0032). A node signed in as the
  // owner over the tailnet, and a paired device over the relay (`device:<id>`), are the owner's
  // devices; the person is a browser or app holding a person session made on that one device
  // (pinned to its tailnet node or relay device id). A signed session covers its body, so the
  // body is read here once and kept for body().
  const device = Boolean(policy.caller && ownerDevice(policy.caller));
  const nodeId = device && policy.peer ? (policy.peer.stableId || policy.peer.node || null) : null;
  const crossOrigin = Boolean(policy.peer && /** @type {any} */ (policy.peer).origin);
  /** @type {{ id: string, kind: string } | null} */
  let person = null;
  if (device && people && carried(req.headers)) {
    let raw = "";
    if (req.method !== "GET" && req.method !== "HEAD") {
      try { raw = await rawBody(req); } catch (e) { return send(res, 400, { error: { code: "bad_input", message: /** @type {Error} */ (e).message } }); }
      /** @type {any} */ (req).vyreRaw = raw;
    }
    const c = people.check({ headers: req.headers, node: nodeId, method: req.method, path: url.pathname + url.search, raw });
    if (c && c.ok && c.rotateOnly && url.pathname !== "/v1/tools/presence.person.rotate") {
      // A paired session past its rotation plus grace: the secret is good for the one call that replaces it.
      return send(res, 401, { error: { code: "person_session_required", message: "this device's sign-in must be renewed before anything else; it renews itself, or sign in again" } });
    }
    if (c && c.ok) person = { id: c.id, kind: c.kind };
    // The credential this box issued, for a device whose key was since removed: said once, in plain
    // words, with its own code (only the holder of the real credential gets it, person.js check).
    else if (c && c.removed) return send(res, 401, { error: { code: "device_removed", message: c.why } });
    // A bad bearer is refused outright; a lapsed cookie is only a device, and the tool decides.
    else if (c && String(req.headers.authorization || "").startsWith("Vyre ")) return send(res, 401, { error: { code: "person_session_required", message: c.why } });
  }
  // From another origin (the hosted app), nothing at all without a person session: no tool, no
  // tool list, no events, no modules. Only that the box is there, and the token trade.
  if (crossOrigin && !person) {
    if (req.method === "GET" && url.pathname === "/v1/health") return send(res, 200, { data: { reachable: true } });
    if (!(req.method === "POST" && url.pathname === "/v1/person/token")) return send(res, 401, { error: { code: "person_session_required", message: "sign in to this box from the app first" } });
  }
  if (person) via.person = person;
  // A listener's own identity (policy.caller) is established by the listener, not claimed. The
  // one exception is an agent's own tailnet node (`tailnet:agent:<name>`): whois strengthens the
  // agent's key and never replaces it, so that caller must carry the key of that same agent too.
  // Off the tailnet the key alone works as before.
  const agentNode = Boolean(policy.caller && /^tailnet:agent:/.test(policy.caller));
  const said = policy.caller && !agentNode ? null : AGENT_CLAIM.exec(caller);
  if (agentNode && !(said && policy.peer && policy.peer.agent === said[1])) {
    return send(res, 403, { error: { code: "denied", message: "this node's agent is not the one its caller names" } });
  }
  /** @type {string | null} */ let pluginAgent = null;
  if (policy.thread) {
    // Bound above; a key or a session claim on this socket changes nothing.
  } else if (said && !agentNode && !AGENT_LABEL.test(caller)) {
    return send(res, 403, { error: { code: "denied", message: "an agent is named only as mcp:agent:<name> or harness:agent:<name>" } });
  } else if (said) {
    const key = String(req.headers["x-vyre-agent-key"] || "");
    const v = key ? await registry.call("threads.vouch", { agent: said[1], key }, "module:vyred") : null;
    if (v && v.data && v.data.thread) Object.assign(via, { thread: v.data.thread, agent: said[1] });
    else {
      // Claude Code on this computer (core/pluginagent): an agent the person granted once, with no thread of its own. Its key is checked the same way, and the daemon stamps its kernel token below.
      const plug = key ? await registry.call("pluginagent.vouch", { agent: said[1], key }, "module:vyred").catch(() => null) : null;
      if (!(plug && plug.data && plug.data.ok === true)) return send(res, 403, { error: { code: "denied", message: `the caller names agent ${said[1] || "(none)"}, and no thread of that agent is running with this key` } });
      // Not a thread's agent: its calls are a model's own (`mcp`), and what it is comes from the kernel token vyred stamps, never from the label.
      pluginAgent = said[1];
    }
  } else if (req.headers["x-vyre-agent-key"]) {
    // An agent's key on a caller that names no agent: something inside an agent's thread (its
    // Bash, say) claiming to be the user or a surface. Refused out loud rather than taken as either.
    return send(res, 403, { error: { code: "denied", message: "this request carries an agent's key, so it must name that agent (mcp:agent:<name> or harness:agent:<name>)" } });
  } else if (req.headers["x-vyre-session"]) {
    // Any other caller may say which session it is in (the MCP server does, from the key its
    // session's SessionStart hook was given). A claim that does not check out is refused.
    const session = String(req.headers["x-vyre-session"]);
    const key = String(req.headers["x-vyre-session-key"] || "");
    const v = key ? await registry.call("threads.vouch", { session, key }, "module:vyred") : null;
    if (!(v && v.data && v.data.thread)) return send(res, 403, { error: { code: "denied", message: `the caller says it is in session ${session.slice(0, 8)}, and vyred has no running session bound with this key` } });
    via.thread = v.data.thread;
  }
  // RC-1: a model's label is built here from what was verified above, never passed through as the client sent it.
  if (!policy.caller && MODEL_LABEL.test(caller)) caller = /** @type {string} */ (modelLabel(caller, via));
  // A plain model caller (Claude Code through Vyre's MCP, no verified thread or agent): who it is, from the kernel, for the threads tools that
  // narrow it. Set here only, over anything a client could send: meta.peerSession "<claude pid>:<start>" and meta.peerCwd, null where unreadable.
  if (socket && !via.thread && !via.agent && MODEL_LABEL.test(caller)) {
    const pid = await peerPid(req.socket).catch(() => null);
    const who = pid ? peerIdentity(pid, processTable()) : { session: null, cwd: null };
    Object.assign(via, { peerSession: who.session, peerCwd: who.cwd });
  }
  // What a verified agent is really granted, from its stored row (agents.scope), never from
  // anything the caller sent: a tool that scopes by project reads meta.granted ("*" or slugs).
  // A named agent with no row is granted nothing.
  if (via.agent) {
    const g = await registry.call("agents.scope", { name: via.agent, ...(via.thread ? { thread: via.thread } : {}) }, "module:vyred");
    /** @type {any} */ (via).granted = g && g.data ? g.data.projects : [];
    /** @type {any} */ (via).agentKind = g && g.data ? g.data.kind : null;
    if (g && g.data && Array.isArray(g.data.only)) /** @type {any} */ (via).agentOnly = g.data.only;
  }
  // A person's label from a model's shell is the session's own, whatever the tool (asTaken).
  const shell = socket && !policy.caller ? await asTaken(caller, req.socket, registry, via.thread) : { caller, model: false };
  // A command-line session (`vyre signin`): the credential rides as the bearer header, and counts only for a cli or local label that is not inside a model, from the terminal login it was made for. The login
  // is what the daemon measures (terminalOf: the kernel's own view of the peer, a model's shell gets none), never anything the call says. A credential that does not fit is simply no session.
  let cliSession = false;
  if (socket && people && !policy.caller && !shell.model && /^(cli|local)$/.test(caller) && carried(req.headers)) {
    const t = terminalOf ? await terminalOf(req.socket).catch(() => null) : null;
    const key = t && typeof t === "object" ? t.key : t;
    const c = key ? people.check({ headers: req.headers, node: `cli:${key}`, method: req.method, path: url.pathname + url.search, raw: "" }) : null;
    if (c && c.ok && c.kind === "cli") { cliSession = true; via.person = { id: c.id, kind: "cli" }; }
  }
  caller = shell.caller;
  if (req.method === "GET" && url.pathname === "/v1/health") {
    const mods = registry.status();
    // last_event lets a surface follow the stream from now: `since=0` would replay the whole
    // log, and a guessed cursor past the end drops every live event.
    const last = { id: events.latestId() };
    const b = build();
    return send(res, 200, { data: { version: VERSION, commit: b.commit, dirty: b.dirty, pid: process.pid, role: cfg.role, machine: cfg.machine, uptime: Date.now() - started, supervisor: process.env.VYRE_SUPERVISOR || null, finishing: finishing(), last_event: Number(last && last.id) || 0,
      // How to run this vyred's own CLI (node and bin/vyre): the Capsule runs `vyre ...` typed in
      // its box by argv, never through a shell, and must run the same version.
      cli: [process.execPath, path.join(REPO, "bin", "vyre")],
      // Where the memory is, in MB: a stress run tells a heap that grows from a native cache filling.
      memory: Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, Math.round(v / 1048576 * 10) / 10])),
      modules: { running: mods.filter(m => m.state === "running").length, failed: mods.filter(m => ["failed", "invalid"].includes(m.state)).length },
      // Which record store this server uses, where that came from and how many records it sees (null when the kernel is off); never a quiet fallback.
      records_store: kernelOf && kernelOf() ? await (await import("../../stores/store-status.js")).storeStatus({ root, server: config.isServer(cfg.machine), store: /** @type {any} */ (kernelOf()).store }).catch((/** @type {Error} */ e) => ({ store: "unknown", note: e.message })) : null } });
  }
  // The plugin agent reaches the tool door and nothing else (no events, hooks, challenges or module listing): its grant names tools, and the tool door is where the grant is checked.
  if (pluginAgent && !((req.method === "GET" && url.pathname === "/v1/tools") || (req.method === "POST" && url.pathname.startsWith("/v1/tools/")))) return send(res, 403, { error: { code: "not_in_grant", message: "Claude Code on this computer reaches only the tools its grant names" } });
  if (req.method === "GET" && url.pathname === "/v1/modules") return send(res, 200, { data: registry.status() });
  if (req.method === "GET" && url.pathname === "/v1/tools") {
    let data = registry.listTools(caller, via).filter(t => !policy.tool || policy.tool(t.name));
    // The plugin agent is offered only what its grant names.
    if (pluginAgent) {
      const ask = await registry.call("pluginagent.allows", { tools: data.map(t => t.name) }, "module:vyred").catch(() => null);
      const ok = new Set(ask && ask.data && Array.isArray(ask.data.allowed) ? ask.data.allowed : []);
      data = data.filter(t => ok.has(t.name));
    }
    return send(res, 200, { data });
  }
  if (device && req.method === "POST" && url.pathname === "/v1/person/token") {
    // The hosted app trades the sign-in page's one-time code, its PKCE verifier and the public
    // half of its key for a bearer session. The one call from another origin that needs none.
    let raw = "", b;
    try { raw = /** @type {any} */ (req).vyreRaw !== undefined ? /** @type {any} */ (req).vyreRaw : await rawBody(req); b = raw ? JSON.parse(raw) : {}; }
    catch (e) { return send(res, 400, { error: { code: "bad_input", message: /** @type {Error} */ (e).message } }); }
    const r = people ? people.exchange({ code: String(b.code || ""), verifier: String(b.verifier || ""), key: b.key, node: nodeId || "", origin: policy.peer && /** @type {any} */ (policy.peer).origin || null,
      request: { headers: req.headers, method: req.method || "POST", path: url.pathname + url.search, raw } }) : { error: { code: "denied", message: "no person sessions here" } };
    if (r.data) events.emit("presence", "presence.signed-in", { id: r.data.id, node: policy.peer && policy.peer.node, app: true });
    // The native app's biometric key (vyre.human), or a Mac's Secure Enclave key (`vyre link
    // signin`, a loopback code): enrolled as a device presence key with the
    // sign-in it rides on (a passkey on the box's page, moments ago), so its HUMAN_ONLY proofs
    // (x-vyre-presence `device ...`, the same 30-minute session as Touch ID) need no passkey.
    const h = b.human;
    if (r.data && /** @type {any} */ (r).native && h && h.kty === "EC" && h.crv === "P-256" && typeof h.x === "string" && typeof h.y === "string" && !h.d
      && !(b.key && h.x === b.key.x && h.y === b.key.y) && registry.deps.presence && typeof registry.deps.presence.enroll === "function") {
      try {
        const spki = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: h.x, y: h.y }, format: "jwk" }).export({ format: "der", type: "spki" }).toString("base64url");
        const k = registry.deps.presence.enroll({ kind: "device", name: `${/** @type {any} */ (r).label || "phone"} (biometric)`, public_key: spki, alg: -7 });
        events.emit("presence", "presence.enrolled", { id: k.id, kind: k.kind, name: k.name });
        r.data.human = { key: k.id };
      } catch (e) {
        // The same key signing in again: it is enrolled already, under its fingerprint.
        const spki = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: h.x, y: h.y }, format: "jwk" }).export({ format: "der", type: "spki" }).toString("base64url");
        r.data.human = /already enrolled/.test(/** @type {Error} */ (e).message) ? { key: fingerprint(spki) } : { error: /** @type {Error} */ (e).message };
      }
    }
    const out = { ...(r.data ? { data: r.data } : {}), ...(r.error ? { error: r.error } : {}) };
    return send(res, r.error ? (r.error.code === "bad_input" ? 400 : 403) : 200, out);
  }
  if (device && req.method === "POST" && url.pathname === "/v1/person/end") {
    if (person) { people.revoke(person.id); events.emit("presence", "presence.signed-out", { id: person.id }); }
    res.setHeader("set-cookie", `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    return send(res, 200, { data: { ended: Boolean(person) } });
  }
  // sync.upload's chunk data: octet-stream only, never JSON (e2e, session-import review), so it
  // never goes through body()'s JSON parse. Only a paired peer's own tailnet node reaches it -
  // never the relay, a guest or an agent's node, since none of those carry policy.peer.stableId
  // the way an owner device's does. sync.upload.chunk (core/link/box.js) checks the rest: which
  // peer, whether its sync switch is on, quota, and that this upload is that peer's own.
  if (req.method === "POST" && url.pathname.startsWith("/v1/sync/upload/")) {
    const upload = decodeURIComponent(url.pathname.slice("/v1/sync/upload/".length));
    const offset = Number(url.searchParams.get("offset"));
    if (!policy.peer || !policy.peer.stableId) return send(res, 403, { error: { code: "denied", message: "sync.upload is for a paired device's own tailnet connection only" } });
    if (!Number.isFinite(offset) || offset < 0) return send(res, 400, { error: { code: "bad_input", message: "offset must be a non-negative number" } });
    let data;
    try { data = await rawBinary(req, 4 * 1024 * 1024); }
    catch (e) { return send(res, 400, { error: { code: /** @type {any} */ (e).code || "bad_input", message: /** @type {Error} */ (e).message } }); }
    // A companion core's proof rides in a header (never the URL, which gets logged); sync.upload.chunk asks core/link to check it.
    const companion = typeof req.headers["x-vyre-companion"] === "string" ? req.headers["x-vyre-companion"] : null;
    const r = await registry.call("sync.upload.chunk", { upload, offset, data, ...(companion ? { companion } : {}) }, caller, { peer: policy.peer });
    return send(res, r.error ? (r.error.code === "denied" ? 403 : r.error.code === "bad_input" ? 400 : 409) : 200, r);
  }
  if (req.method === "POST" && url.pathname.startsWith("/v1/tools/")) {
    const name = decodeURIComponent(url.pathname.slice("/v1/tools/".length));
    if (drain.on) { res.setHeader("retry-after", "2"); return send(res, 503, { error: { code: "restarting", message: "vyred is restarting; try again in a moment" } }); }
    const input = await body(req);
    // The plugin agent holds only what its grant names (pluginagent.ALLOWED, decided in core/pluginagent): any other tool, link.call's carried one included, is refused here, before anything runs.
    if (pluginAgent) {
      const carried = name === "link.call" && input && typeof input.tool === "string" ? input.tool : null;
      const ask = await registry.call("pluginagent.allows", { tools: carried ? [name, carried] : [name] }, "module:vyred").catch(() => null);
      const ok = ask && ask.data && Array.isArray(ask.data.allowed) && ask.data.allowed.includes(name) && (!carried || ask.data.allowed.includes(carried));
      if (!ok) return send(res, 403, { error: { code: "not_in_grant", message: `Claude Code on this computer was not given ${carried || name}: it reads memory, recall and the sessions of your projects, and suggests to memory` } });
    }
    // A person's action on the socket: a person-only tool, one that needs presence for this input,
    // or any call carrying a presence proof or session.
    const def = registry.tools.get(name);
    // link.call carries another tool to the box: what it carries is what counts.
    const inner = name === "link.call" && input && typeof input.tool === "string" ? input.tool : null;
    const personal = personOnly(name, def) || name === "link.signin" || Boolean(req.headers["x-vyre-presence"]) || Boolean(req.headers["x-vyre-yes"]) || Boolean(req.headers["x-vyre-approval"])
      || Boolean(inner && (PERSON_ONLY.has(inner) || HUMAN_ONLY.has(inner)))
      || Boolean(def && (registry.deps.presence ? registry.deps.presence.required(name, def, input) : def.presence));
    if (socket && personal && (shell.model || !MODEL_LABEL.test(caller))) {
      const who = await above(req.socket, registry, caller);
      if (who.nopid) return send(res, 403, { error: { code: "denied", message: "vyred cannot tell which process is calling, so this is refused" } });
      if (who.inside) return send(res, 403, { error: { code: "denied", message: "this comes from inside a Claude session, which acts as an agent: only the person answers, approves and proves presence" } });
      if (who.unknown) {
        if (!(who.server && await serverTrusted(who.server, req.headers["x-vyre-presence"], caller, registry))) {
          // The full path, pid and start time, never a basename: a model can name its own process
          // anything (`exec -a login`, `-title`), and the whole point of naming it in the prompt
          // is that the PERSON can tell a real terminal from a model-caused one apart (the
          // reviewer's MEDIUM, 28 Sep).
          const all = registry.deps.presence ? await registry.deps.presence.methods() : [];
          // `server` rides the error as structured fields too, not only inside the message: a
          // client signs its proof over exactly this (sessionInput), so it needs it verbatim, not
          // parsed back out of a sentence.
          return send(res, who.server ? 401 : 403, who.server
            ? { error: { code: "presence_required", message: `this runs inside ${serverName(who.server)}: prove you're here once for this session`, methods: all.filter(m => SERVER_TRUST_METHODS.has(m)), server: sessionInput(who.server) } }
            : { error: { code: "denied", message: "vyred cannot read which processes this call runs under, so this is refused" } });
        }
      }
    }
    // Held in `inflight` until the answer has left, not just until the tool returns: stop()
    // closes every connection once these settle.
    // (A module's own listener may hand over a response that is not a stream; nothing to wait on.)
    const done = typeof res.once === "function" ? new Promise(r => { res.once("finish", r); res.once("close", r); }) : Promise.resolve();
    inflight.add(done);
    done.then(() => inflight.delete(done));
    const proof = parsePresence(req.headers["x-vyre-presence"]);
    // For a tool one proof covers, the CLI's terminal: its window is bound to it (core/presence).
    const terminal = socket && terminalOf && SIGNIN_TOOLS.has(name) && /^(cli|local)$/.test(caller) ? await terminalOf(req.socket) : null;
    if (socket && SIGNIN_TOOLS.has(name) && !terminal) { try { if (typeof events.log === "function") events.log(`terminal: ${name} got no terminal key (${terminalOf ? `caller label ${caller}, ${/^(cli|local)$/.test(caller) ? "the terminal check refused: see the line above" : "not cli or local, so it was never asked"}` : "no terminal check in this daemon"})`); } catch { /* logging never decides */ } }
    // Only a caller vyred bound to a thread above says which chat tool call this is.
    const call = via.thread ? callId(req.headers["x-vyre-call-id"]) : null;
    // presence.capsule.pin judges the calling binary's own signature, read here from the socket's
    // pid: only vyred's router can hand a tool this (a module's ctx.call carries no meta).
    const signed = socket && name === "presence.capsule.pin" ? await signedBy(req.socket) : undefined;
    // A caller that asks for application/x-ndjson gets the tool's live draft on this connection only:
    // one {"draft":...} line per update, then {"result":...}. No draft function for anyone else, and
    // a draft is never an event. Only the router sets this; a module's ctx.call carries no meta.
    const ndjson = /application\/x-ndjson/.test(String(req.headers.accept || "")) && typeof res.writeHead === "function";
    let live = false;
    const draft = ndjson ? d => {
      if (res.writableEnded || res.destroyed) return;
      if (!live) { live = true; res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" }); }
      res.write(JSON.stringify({ draft: d }) + "\n");
    } : null;
    // threads.bind names a claude process: it must be the caller's own, or one above it (the hook runs under its claude). A session
    // cannot bind another running claude's pid and so take its key. Where the OS cannot say who is calling, the tool's own claudeOf check stands.
    if (socket && name === "threads.bind" && input && Number.isInteger(Number(input.pid))) {
      const caller_pid = await peerPid(req.socket).catch(() => null);
      if (!caller_pid) { try { /** @type {any} */ (registry).deps.log("daemon: threads.bind from a peer the OS cannot name; only the tool's own claude check applies"); } catch { /* no log */ } }
      if (caller_pid) {
        const mine = ancestry(caller_pid, processTable()).chain.map(c => c.pid);
        let ok = mine.includes(Number(input.pid)); // the caller's own process or one above it: a hook under its claude
        // Tests only: a test process stands in for the hook and binds the fake claude it started (its descendant). In production a descendant never counts.
        if (!ok && process.env.NODE_TEST_CONTEXT) ok = ancestry(Number(input.pid), processTable()).chain.some(c => c.pid === caller_pid);
        if (!ok) {
          // Or a process vyred itself started (a headless thread's claude), for a session id nothing is bound to yet.
          const [pids, origin] = await Promise.all([registry.call("threads.pids", {}, "module:vyred"), registry.call("threads.origin", { session: String(input.session || "") }, "module:vyred")]);
          ok = Boolean(pids.data && Array.isArray(pids.data.pids) && pids.data.pids.includes(Number(input.pid)) && origin.data && !origin.data.bound);
        }
        if (!ok) return send(res, 403, { error: { code: "denied", message: "a session binds only its own process or one vyred started, not another's" } });
      }
    }
    // The plugin agent's token is vyred's, set here and never the client's: its session is opened by the daemon for that agent and renewed before it runs out.
    if (pluginAgent) {
      delete req.headers["x-vyre-kernel-session"];
      const t = await pluginToken(registry, pluginAgent).catch(() => null);
      if (t) req.headers["x-vyre-kernel-session"] = t;
    }
    const sessionToken = await kernelSession(req, kernelOf);
    if (sessionToken === null) return send(res, 401, { error: { code: "no_session", message: "this call carries a session credential that is not valid, so it was not made" } });
    // The Capsule's chain needs its own proof (the pinned binary on this connection), asked only for a Capsule label on the socket and only when a kernel is on.
    let capsuleOk = false;
    if (socket && !policy.caller && caller === "capsule" && kernelOf && kernelOf() && registry.deps.presence && typeof registry.deps.presence.capsulePin === "function") {
      try { capsuleOk = (await verifiedCapsule(req.socket, await peerPid(req.socket).catch(() => null), registry.deps.presence.capsulePin(), registry.deps.capsuleSeam)) === true; } catch { capsuleOk = false; }
    }
    // The home's own row for a relay device, asked of the relay module's internal tool; null when none, removed, or the relay is off.
    let deviceRow = null;
    if (policy.caller && String(policy.caller).startsWith("device:") && kernelOf && kernelOf()) {
      try { const r = await registry.call("relay.device.info", { id: String(policy.caller).slice(7) }, "module:vyred"); deviceRow = r && r.data ? r.data : null; } catch { deviceRow = null; }
      if (deviceRow) { try { const w = await registry.call("wink.device.record", { id: String(policy.caller).slice(7) }, "module:vyred"); deviceRow = { ...deviceRow, person: w && w.data && typeof w.data.owner === "string" ? w.data.owner : null }; } catch { deviceRow = { ...deviceRow, person: null }; } }
    }
    // LB-1: a person's-surface label on the socket is a person only after the ancestry measurement `asTaken` made above (a model's shell was relabelled and never reaches here as a surface label);
    // `callerFacts` itself takes that measurement as input and gives nothing without it, so no new call path can build a person from the label alone.
    /** @type {{ inside: boolean, outside?: boolean } | undefined} */
    const measured = socket && !policy.caller ? surfaceAncestry(shell, typeof registry.deps.devStandIn === "function" && registry.deps.devStandIn() === true, cliSession) : undefined; // not `ancestry`: that is the imported function used earlier in this handler
    const facts = callerFacts(caller, policy, via, kernelOf ? kernelOf() : null, capsuleOk, deviceRow, measured);
    // The zone the calling device says it is in, only if it is a real one: tools read it as `meta.zone` (lib/time personZone); nothing a module passes can set it.
    const deviceZone = typeof req.headers[ZONE_HEADER] === "string" ? zoneFrom(req.headers[ZONE_HEADER], "") : "";
    let result = await registry.call(name, input, caller, { ...via, ...(deviceZone ? { zone: deviceZone } : {}), ...(facts ? { kernelFacts: facts } : {}), proof, ...(draft ? { draft } : {}), ...(terminal ? { terminal } : {}), ...(call ? { call } : {}), ...(signed !== undefined ? { codeSignature: signed } : {}),
      idempotencyKey: idemKey(req), ...(yesHeader(req) ? { yes: yesHeader(req) } : {}), ...(kernelProof(req) ? { kernel_proof: kernelProof(req) } : {}), ...(typeof req.headers["x-vyre-approval"] === "string" ? { approval: req.headers["x-vyre-approval"].slice(0, 60) } : {}), ...(sessionToken ? { token: sessionToken } : {}) });
    // The caller said cli or local, the daemon could not read who was on the socket (a busy box, an unreadable table) and so did not take the label: say that, not "not a signed-in person".
    if (socket && !policy.caller && shell.couldNotTell && /^(cli|local)$/.test(String(req.headers["x-vyre-caller"] || "")) && result.error && ["denied", "no_such_tool"].includes(result.error.code)) result = { error: { code: "caller_unknown", message: "Vyre could not tell who is calling; try again", ...(shell.why ? { reason: shell.why } : {}) } };
    // A new person session for the Deck goes in the cookie, never in the body a script could read.
    if (name === "presence.person.start" && result.data && result.data.kind === "cookie" && result.data.token) {
      res.setHeader("set-cookie", `${COOKIE}=${result.data.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(PERSON_MAX / 1000)}`);
      delete result.data.token;
    }
    const status = !result.error ? 200 : result.error.code === "person_session_required" ? 401 : ["no_such_tool", "not_found"].includes(result.error.code) ? 404 : ["denied", "presence_required", "no_dialog"].includes(result.error.code) ? 403 : result.error.code === "bad_input" ? 400
      : result.error.code === "idempotency_conflict" ? 409 : 500;
    if (live) { res.end(JSON.stringify({ result }) + "\n"); return; }
    return send(res, status, result);
  }
  // A presence proof that needs a challenge first: tty writes a code to a login terminal, passkey
  // returns WebAuthn options for the Deck (docs/adr/0004-presence.md).
  if (req.method === "POST" && url.pathname === "/v1/presence/challenge") {
    const b = await body(req);
    const result = await registry.presenceChallenge(String(b.tool || ""), b.input || {}, String(b.method || ""), { tty: b.tty, ...(policy.peer ? { peer: policy.peer } : {}) });
    return send(res, !result.error ? 200 : result.error.code === "no_such_tool" ? 404 : result.error.code === "bad_input" ? 400 : 403, result);
  }
  // Webhooks: POST /v1/<module>/<name>/hook reaches that module's hook tool (watchers.hook) with
  // the name, the token from x-vyre-token or ?token=, and the JSON body. The tool checks the token.
  const hook = req.method === "POST" && /^\/v1\/([a-z][a-z0-9-]*)\/([^/]+)\/hook$/.exec(url.pathname);
  if (hook) {
    const token = String(req.headers["x-vyre-token"] || url.searchParams.get("token") || "");
    let payload;
    try { payload = await body(req); } catch (e) { return send(res, 400, { error: { code: "bad_input", message: /** @type {Error} */ (e).message } }); }
    const result = await registry.call(`${hook[1]}.hook`, { name: decodeURIComponent(hook[2]), token, body: payload }, "hook");
    return send(res, result.error ? (result.error.code === "no_such_tool" ? 404 : 403) : 202, result);
  }
  if (req.method === "GET" && url.pathname === "/v1/events") {
    return send(res, 200, { data: events.since(Number(url.searchParams.get("since") || 0), {
      type: url.searchParams.get("type"), project: url.searchParams.get("project"), limit: Math.min(1000, Number(url.searchParams.get("limit") || 200)) }) });
  }
  if (req.method === "GET" && url.pathname === "/v1/events/stream") {
    if (policy.eventType) url.searchParams.set("type", policy.eventType);
    return stream(req, res, url, events, streams);
  }
  if (req.method === "GET" && url.pathname === "/v1/events" && policy.eventType) return send(res, 404, { error: { code: "not_found", message: url.pathname } });
  const own = registry.routes.get(url.pathname);
  if (own) {
    // A route answers only the methods it declared: a read-only one never a write, a writing one never a GET (the fetch-site rule).
    const info = registry.routeInfo.get(url.pathname);
    if (info && !info.methods.includes(req.method)) return send(res, 405, { error: { code: "method_not_allowed", message: `${url.pathname} answers ${info.methods.join(", ")}` } });
    return own(req, res, { caller, url });
  }
  // What a surface paints (ADR 0035): the appearance module's answer for one device, as CSS for
  // the Deck and module frames or JSON for the Capsule and the phone. The hub's rev is the ETag,
  // so a surface that follows settings.changed asks again with If-None-Match and gets a 304 when
  // nothing it paints moved. Without the appearance module, the Deck's colours from config.
  if (req.method === "GET" && (url.pathname === "/theme.css" || url.pathname === "/v1/theme")) {
    const css = url.pathname === "/theme.css";
    const q = url.searchParams.get("device");
    const device = q && /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,127}$/.test(q) ? q
      : /^(?:tailnet:(?!agent:)[^\s:]+|device:[a-z2-7]{16})$/.test(String(caller)) ? String(caller) : undefined;
    const r = registry.tools.has("appearance.resolve") ? await registry.call("appearance.resolve", { ...(device ? { device } : {}) }, caller) : null;
    if (!r || r.error || !r.data) {
      if (!css) return send(res, 404, { error: { code: "not_found", message: "the appearance module is not running" } });
      res.writeHead(200, { "content-type": "text/css", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      return res.end(themeCss((config.load(root).theme || {}).colors));
    }
    const tag = `"${r.data.rev ?? r.data.version ?? 0}${device ? "-" + device : ""}"`;
    const head = { "cache-control": "no-cache", etag: tag, vary: "cookie, authorization", "x-content-type-options": "nosniff" };
    if (req.headers["if-none-match"] === tag) { res.writeHead(304, head); return res.end(); }
    res.writeHead(200, { ...head, "content-type": css ? "text/css" : "application/json" });
    return res.end(css ? String(r.data.css || "") : JSON.stringify({ data: r.data }));
  }
  // The browser half of the resilience client (ADR 0029), which the Deck imports as
  // ../../core/resilience/<file>.js: that resolves here in a browser and to the repo file in Node,
  // so the Deck and its tests load the one copy. Only these five files; nothing else in core/.
  const res29 = req.method === "GET" && /^\/core\/resilience\/(backoff|sse|stream|outbox|web)\.js$/.exec(url.pathname);
  if (res29) return serveFile(res, path.join(REPO, "core", "resilience", res29[1] + ".js"), cfg);
  // tailnet's relay client (ADR 0045/0037 "Wink"), which the Deck imports as
  // ../../relay/client/<file>.js (deck/js/pair-ticket.js, deck/js/pair-scan.js): that resolves
  // here in a browser and to the repo file in Node, so the Deck and its tests load the one copy.
  // Only these nine files - client.js's own browser-safe closure (checked by hand: channel.js,
  // bytes.js, response.js, sse.js, webcrypto.js, noise.js) plus seedwords.js and words.js, which deck/js/add-pc-card.js
  // (Settings, Add a Windows PC) imports - nothing else in relay/client/
  // (nodecrypto.js is Node-only and never imported from the Deck). A real browser hitting
  // /pair/scan without this fell straight through to serveDeck's catch-all shell (team-lead,
  // reviewer of stage, 2026-09-28) - headless tests missed it because they never loaded the page
  // through a real vyred the way a phone does.
  const resRelay = req.method === "GET" && /^\/relay\/client\/(client|channel|bytes|response|sse|webcrypto|noise|seedwords|words)\.js$/.exec(url.pathname);
  if (resRelay) return serveFile(res, path.join(REPO, "relay", "client", resRelay[1] + ".js"), cfg);
  // The kernel's contracts, which the Deck imports as ../../kernel/contracts/index.js (deck/ui/tasks.js, deck/ui/fields.js): constant tables only, data and no logic, so the
  // Deck and the kernel load the one copy and nothing drifts. This file and nothing else under kernel/.
  if (req.method === "GET" && url.pathname === "/kernel/contracts/index.js") return serveFile(res, path.join(REPO, "kernel", "contracts", "index.js"), cfg);
  // The pure libs the Deck shares with Node, so both load the one copy: lib/avatar-seed (ADR 0043
  // section 6, a project tile's bytes) and lib/caps-flags (PLAN.md C14b, provider capabilities).
  // Exact paths only, nothing else in lib/.
  if (req.method === "GET" && DECK_LIBS.has(url.pathname)) return serveFile(res, path.join(REPO, ...url.pathname.slice(1).split("/")), cfg);
  // The verified-link files for the iPhone and Android apps (app-wire): public, tiny, and absent until the deploy sets the signing identities.
  if (req.method === "GET" && url.pathname.startsWith("/.well-known/")) {
    const body = associationFile(url.pathname);
    if (body) { res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" }); return res.end(body); }
  }
  // The one app (ADR 0027), beside the Deck until it takes over /. Once config app.root flips
  // (mobile's client-side migration, off by default: core/config/index.js), /app/* is a 301 to
  // the same path under "/" instead, so an installed /app/ Home Screen icon or a stale bookmark
  // still opens once "/" serves the app.
  if (req.method === "GET" && (url.pathname === "/app" || url.pathname.startsWith("/app/"))) {
    if (cfg.app?.root) {
      // Never let this become a protocol-relative Location: "/app//evil.example" (or a
      // "\" the URL parser already turned into "/") would otherwise slice down to "//evil.example",
      // which a browser reads as scheme-relative and leaves the box for. Collapse every leading
      // slash or backslash left after the "/app/" prefix before putting the one back.
      const rest = (url.pathname === "/app" || url.pathname === "/app/") ? "" : url.pathname.slice(5).replace(/^[/\\]+/, "");
      const to = "/" + rest + url.search;
      res.writeHead(301, { location: to, "cache-control": "no-cache" });
      return res.end();
    }
    return serveApp(res, url.pathname, { csp: cspFor(req.headers.host, cfg.appmods?.base) });
  }
  // The pre-app pages live in web/ (plain pages the app signs in through), in both modes; a file web/ does not hold falls through.
  if (req.method === "GET" && !url.pathname.startsWith("/v1/") && serveWeb(res, url.pathname, cfg)) return;
  // config app.root: the app answers every other page address from an export built for the root (npm run export:web:root). An export built for /app/ (or none) cannot serve at /, so that is 404 no_app: no other web app answers.
  if (req.method === "GET" && cfg.app?.root && !url.pathname.startsWith("/v1/") && !ROOT_BOX.test(url.pathname)) {
    if (appBase(APP_DIST) !== "") return send(res, 404, { error: { code: "no_app", message: "the app on this machine was built for /app/ or not built; build it for the root with npm run export:web:root" } });
    return serveApp(res, url.pathname, { csp: cspFor(req.headers.host, cfg.appmods?.base) });
  }
  return send(res, 404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
}

/**
 * Live events as server-sent events: everything after `since` first (so a surface that was
 * away catches up without a gap), then each new event as it happens. `type` filters the same way
 * as events.on: "thread.started", "thread.*" or "*". The SSE id is the event id, so a browser's
 * EventSource resumes from Last-Event-ID on its own.
 */
function stream(req, res, url, events, streams) {
  // A client that went away while the request was being routed (or while the daemon was stopping) has no 'close' left to come: nothing to start, nothing to leak.
  if (req.destroyed || res.destroyed || res.writableEnded) return;
  const type = url.searchParams.get("type") || "*";
  // since=latest skips the backlog: a surface that renders current state from tools only needs
  // what happens next, and replaying a long log to reach "now" is wasted work.
  const sinceParam = url.searchParams.get("since");
  const latest = !req.headers["last-event-id"] && sinceParam === "latest";
  const lastId = latest ? events.latestId() : Number(req.headers["last-event-id"] || sinceParam || 0);
  const match = type === "*" ? () => true : type.endsWith(".*") ? e => e.type.startsWith(type.slice(0, -1)) : e => e.type === type;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  // Flush now, before any backlog write: an empty backlog would otherwise leave the client with
  // no bytes at all until the first live event or the 15s heartbeat, so it has no way to tell
  // "connected, listening" apart from "still connecting". A caller that emits right after opening
  // the stream (a Deck view, or a test) can then race the listener registration below and lose
  // that event to a window the client had no signal it needed to wait out.
  res.flushHeaders();
  // And one byte of body: iOS URLSession reports nothing (it sits on "connecting", up to the 15s
  // heartbeat) until the body starts, whatever the headers say.
  res.write(": open\n\n");
  const write = e => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  let cursor = lastId;
  // A cursor past the newest id cannot be replayed (the log was reset, or the surface followed
  // another box). Say so, and follow from now: the surface reloads through tools (ADR 0029, R1).
  const can = events.resumable(cursor);
  if (!can.ok) {
    cursor = can.from;
    // Shaped like an event, so a client that does not know `reset` still parses it; one that does
    // sets its cursor to `id` (lower than its own) and reloads.
    write({ id: cursor, at: Date.now(), type: "stream.reset", source: "vyred", project: null, thread: null, payload: { from: cursor, reason: "cursor_ahead" } });
  }
  // Reconnect after 2 s, and hold the cursor from the first byte: an `id:` with no data sets the
  // browser's Last-Event-ID without firing an event, so a stream that drops before its first
  // event still resumes from here instead of from "latest" (ADR 0029, R1).
  res.write(`retry: 2000\nid: ${cursor}\n\n`);
  // Backlog in pages, then live. Anything emitted while paging is caught by the cursor check.
  for (;;) {
    const page = events.since(cursor, { limit: 500 });
    for (const e of page) { cursor = e.id; if (match(e)) write(e); }
    if (page.length < 500) break;
  }
  // Every event moves the cursor, matched or not, so a filtered stream resumes near the head.
  const off = events.on("*", e => { if (e.id > cursor) { cursor = e.id; if (match(e)) write(e); } });
  // The heartbeat carries the cursor too; a client that hears nothing for 45 s reconnects.
  const beat = setInterval(() => res.write(`id: ${cursor}\n: beat\n\n`), HEARTBEAT_MS);
  beat.unref(); // a heartbeat never keeps the process alive; the stream ends with its connection or with the daemon
  const end = () => { off(); clearInterval(beat); streams.delete(end); res.end(); };
  streams.add(end);
  req.on("close", end);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
  ".ttf": "font/ttf", ".map": "application/json" };

/** At the root (config app.root) these stay the box's: the pre-app pages and what they load, and the signed release files. */
const ROOT_BOX = /^\/(onboard|person|release|css|js|vendor|fonts|theme\.css|icon\.svg|favicon\.svg|icon-[^/]+|apple-touch-icon\.png|splash|kernel|lib)(\/|\.|$)/;

/** The lib files vyred serves to the Deck (pure, import-free, shared with Node). */
const DECK_LIBS = new Set(["/lib/wink-code/geometry.js", "/lib/wink-code/payload.js", "/lib/wink-code/rs.js", "/lib/wink-code/decode-core2.js", "/lib/wink-code/vyrecode2.js", "/lib/wink-code/identity.js", "/lib/avatar-seed/index.js", "/lib/caps-flags/index.js", "/lib/theme/contrast.js", "/kernel/contracts/index.js"]);

/**
 * The pre-app pages (web/): the owner wizard, the device and passkey pages and the person's sign-in, with the code, styles, fonts and
 * vendor files they load. Plain files, the same address in both modes. True when this answered; false when web/ holds no such file, so the
 * Deck (or, at the root, the app) answers as before. A folder with an index.html serves it (the build stamped in), a folder without one is not a file.
 * @param {any} res @param {string} pathname @param {any} cfg
 */
export function serveWeb(res, pathname, cfg) {
  const dir = path.join(REPO, "web");
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  let file = path.resolve(dir, "." + path.posix.normalize(rel));
  if (!file.startsWith(dir + path.sep)) return false;
  // Tests and sample data live beside the pages in the repo and are never served. Compared in lower case: a Mac's file system is case-insensitive.
  const low = path.relative(dir, file).toLowerCase();
  if (low.split(path.sep).some(seg => seg === "test" || seg === "fixtures") || /\.test\.m?js$/.test(low)) return false;
  let page = false;
  try { if (fs.statSync(file).isDirectory()) { file = path.join(file, "index.html"); page = true; } } catch { return false; }
  let buf;
  try { buf = fs.readFileSync(file); } catch { return false; }
  if (page || path.basename(file) === "index.html") buf = Buffer.from(htmlWithBuild(buf.toString("utf8")));
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", ...deckHeaders(cfg) });
  res.end(buf);
  return true;
}

/**
 * The relay origins Wink's pre-pairing fetch needs in connect-src (ADR 0045's resolveTicket(),
 * a plain cross-origin POST to `<relay>/v1/pair` that runs BEFORE any pairing, so it cannot ride
 * the one already-open channel ADR 0026's "no CORS/connect-src needed" reasoning covers - that
 * reasoning only ever applied to traffic AFTER pairing). Always the production default
 * (DEFAULT_RELAY); also this box's own configured relay (relay.status's url), so a self-hosted
 * relay (relay/client/README.md's own documented case) is never silently blocked either. Exact
 * origins only, both wss: (the socket pairOffer opens) and the matching https: (resolveTicket's
 * own fetch, same scheme swap relay/client/client.js does) - never a wildcard. The configured
 * relay is checked against a strict wss://<hostname>[:<port>] shape (reviewer's LOW,
 * 2026-09-28): wss: only, never plain ws: (which would put a bare http: origin in connect-src),
 * and a hostname charset only - no `;`, `'` or anything else that doesn't belong in a header.
 * @param {any} cfg
 */
function relaySources(cfg) {
  const urls = new Set([DEFAULT_RELAY]);
  const configured = cfg && cfg.relay && cfg.relay.url;
  if (typeof configured === "string" && /^wss:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(configured)) urls.add(configured);
  const out = [];
  for (const u of urls) out.push(u, u.replace(/^ws/, "http"));
  return out.join(" ");
}

/** What every Deck file goes out with. @param {any} cfg */
function deckHeaders(cfg) {
  return { "cache-control": "no-cache", "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' ${relaySources(cfg)}; frame-ancestors 'none'` };
}

/** One module from outside deck/ that the Deck imports (core/resilience, relay/client), with the Deck's headers. @param {any} cfg */
function serveFile(res, file, cfg) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return send(res, 404, { error: { code: "not_found", message: path.basename(file) } }); }
  res.writeHead(200, { "content-type": "text/javascript", ...deckHeaders(cfg) });
  res.end(buf);
}

/** Does anything answer on this socket? */
export function ping(socket, timeout = 1500) {
  return new Promise(resolve => {
    const req = http.request({ socketPath: socket, path: "/v1/health", method: "GET", timeout }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}
