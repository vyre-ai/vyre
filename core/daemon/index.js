// @ts-check
// vyred — the one process per machine that runs every Vyre service.
//
// It opens the store, starts the modules this machine's role calls for, and serves the API on
// a unix socket in VYRE_HOME. Surfaces, the Harness hooks and the CLI all talk to it here and
// nowhere else. Networking over Tailscale is layered on later by the names module; the socket
// is always the local way in and never leaves the machine.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../config/index.js";
import { themeCss } from "../config/theme.js";
import { isRealHome } from "../config/dialogs.js";
import { assertDaemonHost } from "./host-guard.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { Registry, discover, ownerDevice } from "../modules/index.js";
import { build, swWithBuild, htmlWithBuild } from "./build.js";
import { serveApp } from "./app.js";
import { acquire } from "./lock.js";
import { Presence, PERSON_ONLY, HUMAN_ONLY, SESSIONABLE, personOnly, fingerprint, parse as parsePresence, core as coreHolder } from "../presence/index.js";
import { readCoreConfig, coreLink } from "../../lib/vyre-core-client.js";
import { peerPid, peerHosting, insideClaude, processTable, loginOf, tmuxClients, controllingTty, canReadPeers, verifiedCapsule, signatureOf, foreground, socketTrust } from "./peer.js";
import { PersonSessions, COOKIE, MAX as PERSON_MAX, carried } from "../presence/person.js";
import { allowedTools } from "../names/guests.js";
import { registryRules } from "../harness/rules.js";
// lib/, not core/relay/index.js: importing the module itself would be a new kernel -> feature
// edge (reviewer's MEDIUM, 2026-09-28) and would pull the whole relay module - link, bridge,
// redeem, tailnet via relay/client - into the kernel just for one constant.
import { DEFAULT_RELAY } from "../../lib/relay-default.js";
import { within } from "../../lib/within.js";

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
export const REPO = path.resolve(HERE, "..", "..");
export const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

/** Where modules come from: Vyre's own folders first, then whatever the user installed. */
export function moduleRoots(root) {
  return [path.join(REPO, "core"), path.join(REPO, "local"), path.join(REPO, "modules"), config.paths(root).modules];
}

/**
 * Start vyred. Returns a handle with the running registry and a stop() for tests.
 * @param {{ root?: string, log?: (m: string, x?: any) => void, rules?: any, presence?: any,
 *   coreKeys?: any, person?: (socket: import("node:net").Socket) => Promise<string|{ key: string, tty: string|null }|null> }} [opts] person: a test's stand-in for atTerminal
 */
export async function start(opts = {}) {
  const root = opts.root || config.home();
  // A test daemon never boots on the person's Mac (host-guard.js): one place, every boot passes it.
  assertDaemonHost({ root, real: isRealHome(root) });
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
  const events = new Events(db);
  // vyred always checks presence. A test may pass a verifier, or a function that builds one on
  // this store (to give the real one fake OS touch points).
  // On a Mac with vyre-core installed (ADR 0040), core holds the trust anchors: every presence
  // check that rests on a key goes to core. Only a root-owned core.json turns this on; Linux never.
  if (process.platform === "darwin" && opts.presence === undefined) {
    const c = readCoreConfig();
    coreHolder.link = c ? coreLink(c) : null;
    if (c) log(`presence: keys and proofs are vyre-core's (${c.socket})`);
  }
  const presence = typeof opts.presence === "function" ? opts.presence({ db, events, log }) : opts.presence || new Presence({ db, events, log, role: cfg.machine, network: () => cfg.network || {} });
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
  const handler = (policy = {}) => (req, res, caller, peer) => route(req, res, { registry, events, cfg, started, streams, root, inflight, drain, people }, { ...policy, caller, ...(peer ? { peer } : {}) })
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
  registry = new Registry({ db, events, config: cfg, paths: p, log, rules, handler, upgrader, presence, firstPartyRoots, coreKeys: opts.coreKeys || null });
  // The eight box-only modules gate on cfg.machine (ADR 0039: solo/server/device), not the
  // legacy cfg.role -- that's what lets a Mac chosen as the server run them.
  await registry.start(discover(moduleRoots(root), { firstPartyRoots }), { role: cfg.machine, ...cfg.modules });

  // A stale socket from a crash would make listen() fail with EADDRINUSE. If nothing answers on
  // it, it is safe to remove; if something does, another vyred is running and this one stops.
  if (fs.existsSync(p.socket)) {
    const alive = await ping(p.socket);
    if (alive) { await registry.stop(); db.close(); throw new Error(`vyred is already running (${p.socket})`); }
    fs.rmSync(p.socket, { force: true });
  }

  const terminalOf = opts.person || (sock => atTerminal(sock, registry, presence));
  const server = http.createServer((req, res) => route(req, res, { registry, events, cfg, started, streams, root, inflight, drain, socket: true, terminalOf }).catch(e => fail(res, e)));
  server.on("upgrade", async (req, socket, head) => {
    try { upgrade(req, socket, head, (await asTaken(socketCaller(req), /** @type {any} */ (socket), registry)).caller); }
    catch { socket.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(p.socket, () => resolve(undefined)); });
  // No POSIX mode on win32: the socket is a named pipe (core/config/index.js's socketPath),
  // which Node already restricts to this user by default; there is no file for chmod to touch.
  if (process.platform !== "win32") fs.chmodSync(p.socket, 0o600);
  fs.writeFileSync(p.pid, String(process.pid));
  log(`vyred ${VERSION} up · role ${cfg.role} · ${registry.status().filter(m => m.state === "running").length} modules`);

  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
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
    db.close();
    fs.rmSync(p.socket, { force: true });
    try { if (fs.readFileSync(p.pid, "utf8") === String(process.pid)) fs.rmSync(p.pid, { force: true }); } catch {}
    release();
    log("vyred down");
  };
  return { registry, events, config: cfg, paths: p, stop };
}

/** Any label that names an agent, in whatever form: "mcp:agent:kit", "cli agent:kit", "deck:agent:kit". */
const AGENT_CLAIM = /(?:^|[\s:])agent:([A-Za-z0-9_-]*)/i;
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
const FORBIDDEN_LABEL = /^(module:|tailnet:|tailnet-guest:|device:|link:|onboard$|hook$)/i;

/**
 * Who a socket request says it is. No label is "anonymous", which no tool's callers list names,
 * so a bare curl on the socket is not a person (ADR 0006, finding 2). A label claiming an identity
 * only a listener or the registry sets is "anonymous" too.
 */
export function socketCaller(req) {
  const label = String(req.headers["x-vyre-caller"] || "");
  return !label || FORBIDDEN_LABEL.test(label) ? "anonymous" : label;
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
    && await verifiedCapsule(socket, pid, (registry.deps.presence.capsulePin ? registry.deps.presence.capsulePin() : null), deps.capsuleSeam)) { if (deps.proof) deps.proof.capsule = true; return { inside: false }; }
  // A `vyre` the Capsule spawned by argv: its top is the Capsule itself, named as a server. The pinned
  // cdhash proves that top too (every link below it passed the walk's own checks), so no prompt.
  if (result.server && registry.deps.presence
    && await verifiedCapsule({}, result.server.pid, (registry.deps.presence.capsulePin ? registry.deps.presence.capsulePin() : null), deps.capsuleSeam)) { if (deps.proof) deps.proof.capsule = true; return { inside: false }; }
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
 * proved its session), for every tool: a label is only a claim (docs/work/e2e.md, the team
 * review). "anonymous" stays: the session could say "mcp" itself, so it gains nothing. An ancestry vyred cannot read (a `docker exec` on the box has parent 0) keeps its label
 * here; the person's own actions still refuse it (fromClaude). Asked once per connection.
 * @param {string} caller @param {import("node:net").Socket} socket @param {any} registry @param {string} [thread]
 * @param {Parameters<typeof above>[3]} [deps] test seams for above()
 * @returns {Promise<{ caller: string, model: boolean }>}
 */
export async function asTaken(caller, socket, registry, thread, deps) {
  if (MODEL_LABEL.test(caller) || caller === "anonymous") return { caller, model: false };
  let v = taken.get(socket);
  // A peer vyred cannot read where it normally can (perl failed or timed out) is not taken on its
  // word: a surface's label then counts as a model's, so a stall never reopens the forged label.
  // Only a definite answer stays for the connection's life: inside a model, or read to the top and
  // outside. "Unknown" (an unreadable chain, a peer not found) is asked again on the next call.
  if (!v) {
    const proof = { capsule: false };
    const mine = above(socket, registry, PERSON_LABEL.test(caller) ? caller : undefined, { ...deps, proof }).then(w => ({
      model: Boolean(w.inside || (w.nopid && canReadPeers)),
      definite: Boolean(!w.unreadable && (w.inside || (!w.unknown && !w.nopid))),
      capsule: proof.capsule, server: w.server || null,
    }));
    v = mine;
    taken.set(socket, mine);
    mine.then(a => { if (!a.definite && taken.get(socket) === mine) taken.delete(socket); }, () => { if (taken.get(socket) === mine) taken.delete(socket); });
  }
  const a = await v;
  const asModel = { caller: thread ? `mcp:thread:${thread}` : "mcp", model: true };
  if (a.model) return asModel;
  // Inverted trust: a person's label on the socket is only a claim, and a child that left the claude ancestry
  // (setsid, nohup, a launchd or cron job an agent wrote) sends the same label. The label is kept only for a
  // peer that proves it is the person; everything else is capped at mcp, silently, with no prompt.
  if (socketTrust() === "strict" && PERSON_LABEL.test(caller) && !(await personSocket(socket, registry, a, deps))) return { ...asModel, capped: true };
  return { caller, model: false };
}
const PERSON_LABEL = /^(?:cli|local|deck|capsule|mobile)$/;

/**
 * Whether this peer is the person: the pinned Capsule (or a vyre it spawned), a server the person already proved
 * once (a VS Code or iTerm2 terminal), or a terminal login that `who` lists and that the peer is in the
 * foreground process group of, with no claude above it (atTerminal). A setsid, nohup, cron or launchd child has
 * none of these. @param {any} socket @param {any} registry @param {any} a @param {any} [deps]
 */
async function personSocket(socket, registry, a, deps = {}) {
  if (a.capsule) return true;
  if (a.server && serverTrust.has(`${a.server.exe}:${a.server.pid}:${a.server.started}`)) return true;
  const term = await (deps.terminal || atTerminal)(socket, registry, registry.deps && registry.deps.presence);
  if (!term) return false;
  const pid = await (deps.peerPid || peerPid)(socket);
  const fg = pid ? (deps.foreground || foreground)(pid) : null;
  return Boolean(fg && fg.pgid > 0 && fg.pgid === fg.tpgid);
}
/** @type {WeakMap<object, Promise<{ model: boolean, definite: boolean }>>} */
const taken = new WeakMap();

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
async function atTerminal(socket, registry, presence) {
  if (await fromClaude(socket, registry)) return null;
  const pid = await peerPid(socket);
  if (!pid || !presence || typeof presence.who !== "function") return null;
  const logins = await presence.who();
  const login = loginOf(pid);
  if (login && logins.includes(login.tty)) return { key: login.key, tty: login.tty };
  const clients = tmuxClients(pid);
  if (!clients || !clients.length) return null;
  const r = await registry.call("threads.pids", {}, "module:vyred");
  const threads = (r.data && r.data.pids) || [];
  const keys = [];
  for (const c of clients) {
    const l = insideClaude(c, { threads }).inside ? null : loginOf(c);
    if (!l || !logins.includes(l.tty)) return null;
    keys.push(l.key);
  }
  return { key: "tmux:" + [...new Set(keys)].sort().join("+"), tty: controllingTty(pid) };
}

async function route(req, res, { registry, events, cfg, started, streams, root, inflight, drain, people = null, socket = false, terminalOf = null }, /** @type {Policy} */ policy = {}) {
  const url = new URL(req.url || "/", "http://vyred");
  // On the socket the header is only a label, and anything on the box can send it (Claude's own
  // processes included). "module:*" is what the registry uses between modules, "hook" is what the
  // webhook route sets, and "tailnet:*" and "onboard" are identities only a listener establishes
  // (ADR 0002). None of them may be claimed over the socket; such a claim, or none, is "anonymous".
  let caller = policy.caller || socketCaller(req);
  for (const [k, v] of Object.entries(policy.headers || {})) res.setHeader(k, v);
  // A guest from another tailnet (ADR 0014 part 8) reaches only its own tools: the ones the owner
  // listed or the policy granted it, and of those only GUEST_SAFE (core/names/guests.js). Every
  // other tool, and every other path but the Deck's files, is "no such" thing, not "denied", so
  // a guest learns nothing about what else is here.
  if (caller.startsWith("tailnet-guest:")) {
    const mine = new Set(allowedTools(cfg.network, policy.peer));
    const isTool = url.pathname.startsWith("/v1/tools/");
    if (isTool && !(req.method === "POST" && mine.has(decodeURIComponent(url.pathname.slice("/v1/tools/".length))))) {
      return send(res, 404, { error: { code: "no_such_tool", message: "no such tool here" } });
    }
    if (req.method === "GET" && url.pathname === "/v1/tools") {
      return send(res, 200, { data: registry.listTools(caller).filter(t => mine.has(t.name)) });
    }
    if (!isTool && !(req.method === "GET" && !url.pathname.startsWith("/v1/"))) {
      return send(res, 404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
    }
  }
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
  if (policy.thread) {
    // Bound above; a key or a session claim on this socket changes nothing.
  } else if (said && !agentNode && !AGENT_LABEL.test(caller)) {
    return send(res, 403, { error: { code: "denied", message: "an agent is named only as mcp:agent:<name> or harness:agent:<name>" } });
  } else if (said) {
    const key = String(req.headers["x-vyre-agent-key"] || "");
    const v = key ? await registry.call("threads.vouch", { agent: said[1], key }, "module:vyred") : null;
    if (!(v && v.data && v.data.thread)) return send(res, 403, { error: { code: "denied", message: `the caller names agent ${said[1] || "(none)"}, and no thread of that agent is running with this key` } });
    Object.assign(via, { thread: v.data.thread, agent: said[1] });
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
  // What a verified agent is really granted, from its stored row (agents.scope), never from
  // anything the caller sent: a tool that scopes by project reads meta.granted ("*" or slugs).
  // A named agent with no row is granted nothing.
  if (via.agent) {
    const g = await registry.call("agents.scope", { name: via.agent }, "module:vyred");
    /** @type {any} */ (via).granted = g && g.data ? g.data.projects : [];
    /** @type {any} */ (via).agentKind = g && g.data ? g.data.kind : null;
  }
  // A person's label from a model's shell is the session's own, whatever the tool (asTaken).
  const shell = socket && !policy.caller ? await asTaken(caller, req.socket, registry, via.thread) : { caller, model: false };
  caller = shell.caller;
  if (req.method === "GET" && url.pathname === "/v1/health") {
    const mods = registry.status();
    // last_event lets a surface follow the stream from now: `since=0` would replay the whole
    // log, and a guessed cursor past the end drops every live event.
    const last = /** @type {any} */ (events.db.prepare("SELECT MAX(id) AS id FROM events").get());
    const b = build();
    return send(res, 200, { data: { version: VERSION, commit: b.commit, dirty: b.dirty, pid: process.pid, role: cfg.role, machine: cfg.machine, uptime: Date.now() - started, supervisor: process.env.VYRE_SUPERVISOR || null, last_event: Number(last && last.id) || 0,
      // How to run this vyred's own CLI (node and bin/vyre): the Capsule runs `vyre ...` typed in
      // its box by argv, never through a shell, and must run the same version.
      cli: [process.execPath, path.join(REPO, "bin", "vyre")],
      // Where the memory is, in MB: a stress run tells a heap that grows from a native cache filling.
      memory: Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, Math.round(v / 1048576 * 10) / 10])),
      modules: { running: mods.filter(m => m.state === "running").length, failed: mods.filter(m => ["failed", "invalid"].includes(m.state)).length } } });
  }
  if (req.method === "GET" && url.pathname === "/v1/modules") return send(res, 200, { data: registry.status() });
  if (req.method === "GET" && url.pathname === "/v1/tools") return send(res, 200, { data: registry.listTools(caller).filter(t => !policy.tool || policy.tool(t.name)) });
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
    const r = await registry.call("sync.upload.chunk", { upload, offset, data }, caller, { peer: policy.peer });
    return send(res, r.error ? (r.error.code === "denied" ? 403 : r.error.code === "bad_input" ? 400 : 409) : 200, r);
  }
  if (req.method === "POST" && url.pathname.startsWith("/v1/tools/")) {
    const name = decodeURIComponent(url.pathname.slice("/v1/tools/".length));
    if (drain.on) { res.setHeader("retry-after", "2"); return send(res, 503, { error: { code: "restarting", message: "vyred is restarting; try again in a moment" } }); }
    const input = await body(req);
    // A person's action on the socket: a person-only tool, one that needs presence for this input,
    // or any call carrying a presence proof or session.
    const def = registry.tools.get(name);
    // link.call carries another tool to the box: what it carries is what counts.
    const inner = name === "link.call" && input && typeof input.tool === "string" ? input.tool : null;
    const personal = personOnly(name, def) || name === "link.signin" || Boolean(req.headers["x-vyre-presence"])
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
    const terminal = socket && terminalOf && SESSIONABLE.has(name) && /^(cli|local)$/.test(caller) ? await terminalOf(req.socket) : null;
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
    const result = await registry.call(name, input, caller, { ...via, proof, ...(draft ? { draft } : {}), ...(terminal ? { terminal } : {}), ...(call ? { call } : {}), ...(signed !== undefined ? { codeSignature: signed } : {}),
      keep: req.headers["x-vyre-presence-keep"] === "1", idempotencyKey: idemKey(req) });
    // A new person session for the Deck goes in the cookie, never in the body a script could read.
    if (name === "presence.person.start" && result.data && result.data.kind === "cookie" && result.data.token) {
      res.setHeader("set-cookie", `${COOKIE}=${result.data.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(PERSON_MAX / 1000)}`);
      delete result.data.token;
    }
    // A session the proof opened goes back in a header, in the form x-vyre-presence takes.
    if (result.session) {
      const s = result.session;
      delete result.session;
      res.setHeader("x-vyre-presence-session", `session id=${s.session} secret=${s.secret} expires=${s.expires}`);
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
  if (own) return own(req, res, { caller, url });
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
  // The pure libs the Deck shares with Node, so both load the one copy: lib/avatar-seed (ADR 0043
  // section 6, a project tile's bytes) and lib/caps-flags (PLAN.md C14b, provider capabilities).
  // Exact paths only, nothing else in lib/.
  if (req.method === "GET" && DECK_LIBS.has(url.pathname)) return serveFile(res, path.join(REPO, ...url.pathname.slice(1).split("/")), cfg);
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
    return serveApp(res, url.pathname);
  }
  if (req.method === "GET" && !url.pathname.startsWith("/v1/")) return serveDeck(res, url.pathname, cfg);
  return send(res, 404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
}

/**
 * Live events as server-sent events: everything after `since` first (so a surface that was
 * away catches up without a gap), then each new event as it happens. `type` filters the same way
 * as events.on: "thread.started", "thread.*" or "*". The SSE id is the event id, so a browser's
 * EventSource resumes from Last-Event-ID on its own.
 */
function stream(req, res, url, events, streams) {
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
  const end = () => { off(); clearInterval(beat); streams.delete(end); res.end(); };
  streams.add(end);
  req.on("close", end);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
  ".ttf": "font/ttf", ".map": "application/json" };

/** The lib files vyred serves to the Deck (pure, import-free, shared with Node). */
const DECK_LIBS = new Set(["/lib/avatar-seed/index.js", "/lib/caps-flags/index.js"]);

/**
 * The Deck: static files from deck/ in the repo (the deck workstream builds them). Paths that
 * are not files get index.html, so the Deck can route on the client. Nothing outside deck/ is
 * ever served, whatever the path says.
 */
function serveDeck(res, pathname, cfg) {
  const dir = path.join(REPO, "deck");
  const shell = path.join(dir, "index.html");
  let file = path.resolve(dir, "." + path.posix.normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(dir + path.sep) && file !== dir) return send(res, 404, { error: { code: "not_found", message: pathname } });
  // Sample data (deck/fixtures, deck/chat/fixtures) is for dev worlds and tests only: a real box
  // never serves it, so no ?fixtures=1 link can put sample threads in front of a person (0.2
  // honesty pass, PLAN.md D2). Dev worlds set VYRE_DECK_FIXTURES=1.
  if (process.env.VYRE_DECK_FIXTURES !== "1" && path.relative(dir, file).split(path.sep).includes("fixtures")) {
    return send(res, 404, { error: { code: "not_found", message: pathname } });
  }
  // A path that is not a file at all (any client route) wants the one shell. A path that IS a
  // real directory (a view's own folder of modules, e.g. deck/chat/) wants that shell too, unless
  // the directory happens to carry its own index.html: a bare 404 there would be surprising, since
  // nothing about the URL said "this is a module", only that a browser asked for a page.
  let wantsShell = false;
  // The release's signed files (deck/sw.js verifyShell): a missing one is a plain 404, never the shell.
  if (/^\/release\/(SHA256SUMS|SHA256SUMS\.sig|shell\.json)$/.test(pathname) && !fs.existsSync(file)) return send(res, 404, { error: { code: "not_found", message: pathname } });
  try { if (fs.statSync(file).isDirectory()) { file = path.join(file, "index.html"); wantsShell = true; } }
  catch { file = shell; wantsShell = true; }
  let buf;
  try { buf = fs.readFileSync(file); }
  catch {
    if (wantsShell && file !== shell) { try { buf = fs.readFileSync(shell); } catch {} }
    if (!buf) return send(res, 404, { error: { code: "no_deck", message: "the Deck is not built on this machine" } });
  }
  // The service worker carries the build, so a release is a new sw.js and a phone swaps its cache
  // at once (deck/sw.js BUILD).
  if (file === path.join(dir, "sw.js")) buf = Buffer.from(swWithBuild(buf.toString("utf8")));
  if (file === shell || wantsShell) buf = Buffer.from(htmlWithBuild(buf.toString("utf8")));
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", ...deckHeaders(cfg) });
  res.end(buf);
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
    "content-security-policy": `default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ${relaySources(cfg)}; frame-ancestors 'none'` };
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
