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
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { Registry, discover, ownerDevice } from "../modules/index.js";
import { build, swWithBuild } from "./build.js";
import { serveApp } from "./app.js";
import { acquire } from "./lock.js";
import { Presence, PERSON_ONLY, HUMAN_ONLY, SESSIONABLE, fingerprint, parse as parsePresence } from "../presence/index.js";
import { peerPid, insideClaude, controllingTty } from "./peer.js";
import { PersonSessions, COOKIE, MAX as PERSON_MAX, carried } from "../presence/person.js";
import { allowedTools } from "../names/guests.js";
import { registryRules } from "../harness/rules.js";

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
 *   person?: (socket: import("node:net").Socket) => Promise<string|null> }} [opts] person: a test's stand-in for atTerminal
 */
export async function start(opts = {}) {
  const root = opts.root || config.home();
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
  const presence = typeof opts.presence === "function" ? opts.presence({ db, events, log }) : opts.presence || new Presence({ db, events, log, role: cfg.role, network: () => cfg.network || {} });
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
    .catch(e => send(res, 500, { error: { code: "internal", message: e.message } }));
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
  registry = new Registry({ db, events, config: cfg, paths: p, log, rules, handler, upgrader, presence });
  await registry.start(discover(moduleRoots(root)), { role: cfg.role, ...cfg.modules });

  // A stale socket from a crash would make listen() fail with EADDRINUSE. If nothing answers on
  // it, it is safe to remove; if something does, another vyred is running and this one stops.
  if (fs.existsSync(p.socket)) {
    const alive = await ping(p.socket);
    if (alive) { await registry.stop(); db.close(); throw new Error(`vyred is already running (${p.socket})`); }
    fs.rmSync(p.socket, { force: true });
  }

  const terminalOf = opts.person || (sock => atTerminal(sock, registry, presence));
  const server = http.createServer((req, res) => route(req, res, { registry, events, cfg, started, streams, root, inflight, drain, socket: true, terminalOf }).catch(e => {
    send(res, 500, { error: { code: "internal", message: e.message } });
  }));
  server.on("upgrade", (req, socket, head) => upgrade(req, socket, head, socketCaller(req)));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(p.socket, () => resolve(undefined)); });
  fs.chmodSync(p.socket, 0o600);
  fs.writeFileSync(p.pid, String(process.pid));
  log(`vyred ${VERSION} up · role ${cfg.role} · ${registry.status().filter(m => m.state === "running").length} modules`);

  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    // Stop taking calls, and give the ones running up to DRAIN_MS to finish: a write cut off
    // mid-way looks to its client like a failure it will retry (ADR 0029, R7).
    drain.on = true;
    if (inflight.size) await Promise.race([Promise.allSettled([...inflight]), new Promise(r => setTimeout(r, DRAIN_MS).unref())]);
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

/** A caller that names an agent: "mcp:agent:kit", "harness:agent:kit", "mcp agent:kit". */
const AGENT_CLAIM = /(?:^|[\s:])agent:([A-Za-z0-9_-]*)/;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function rawBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 5_000_000) throw new Error("request too large"); }
  return raw;
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

const FORBIDDEN_LABEL = /^(module:|tailnet:|tailnet-guest:|device:|onboard$|hook$)/;

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
 * vyred cannot read to the top.
 * @param {import("node:net").Socket} socket @param {any} registry
 */
async function fromClaude(socket, registry) {
  const pid = await peerPid(socket);
  if (!pid) return "vyred cannot tell which process is calling, so this is refused";
  const r = await registry.call("threads.pids", {}, "module:vyred");
  // The processes vyred runs threads in, their process groups and sessions (core/sessions/spawn.js
  // keeps a group listed until its last process is gone, so an orphan is still caught).
  const d = r.data || {};
  const who = insideClaude(pid, { threads: [...(d.pids || []), ...(d.pgids || []), ...(d.sids || [])] });
  if (who.inside) return "this comes from inside a Claude session, which acts as an agent: only the person answers, approves and proves presence";
  return who.unknown ? "vyred cannot read which processes this call runs under, so this is refused" : null;
}

/**
 * The login terminal the person on the socket is typing in ("ttys003"), or null. Null from under a
 * `claude` or a thread (fromClaude), and null without a login terminal `who` lists: a double-forked
 * or setsid'd process has none, and `script`, tmux or expect ptys are not logins. The kernel says
 * which process connected and which terminal it runs in, so no label or file can fake it. This is
 * what lets one proof serve the CLI for 30 minutes, as a session serves the Deck (the no-nag rule;
 * the CLI is a first-class surface).
 * @param {import("node:net").Socket} socket @param {any} registry @param {any} presence
 * @returns {Promise<string|null>}
 */
async function atTerminal(socket, registry, presence) {
  if (await fromClaude(socket, registry)) return null;
  const pid = await peerPid(socket);
  const tty = pid ? controllingTty(pid) : null;
  if (!tty || !presence || typeof presence.who !== "function") return null;
  return (await presence.who()).includes(tty) ? tty : null;
}

async function route(req, res, { registry, events, cfg, started, streams, root, inflight, drain, people = null, socket = false, terminalOf = null }, /** @type {Policy} */ policy = {}) {
  const url = new URL(req.url || "/", "http://vyred");
  // On the socket the header is only a label, and anything on the box can send it (Claude's own
  // processes included). "module:*" is what the registry uses between modules, "hook" is what the
  // webhook route sets, and "tailnet:*" and "onboard" are identities only a listener establishes
  // (ADR 0002). None of them may be claimed over the socket; such a claim, or none, is "anonymous".
  const caller = policy.caller || socketCaller(req);
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
  if (req.method === "GET" && url.pathname === "/v1/health") {
    const mods = registry.status();
    // last_event lets a surface follow the stream from now: `since=0` would replay the whole
    // log, and a guessed cursor past the end drops every live event.
    const last = /** @type {any} */ (events.db.prepare("SELECT MAX(id) AS id FROM events").get());
    const b = build();
    return send(res, 200, { data: { version: VERSION, commit: b.commit, dirty: b.dirty, pid: process.pid, role: cfg.role, uptime: Date.now() - started, supervisor: process.env.VYRE_SUPERVISOR || null, last_event: Number(last && last.id) || 0,
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
  if (req.method === "POST" && url.pathname.startsWith("/v1/tools/")) {
    const name = decodeURIComponent(url.pathname.slice("/v1/tools/".length));
    if (drain.on) { res.setHeader("retry-after", "2"); return send(res, 503, { error: { code: "restarting", message: "vyred is restarting; try again in a moment" } }); }
    const input = await body(req);
    // A person's action on the socket: a person-only tool, one that needs presence for this input,
    // or any call carrying a presence proof or session.
    const def = registry.tools.get(name);
    // link.call carries another tool to the box: what it carries is what counts.
    const inner = name === "link.call" && input && typeof input.tool === "string" ? input.tool : null;
    const personal = PERSON_ONLY.has(name) || name === "link.signin" || Boolean(req.headers["x-vyre-presence"])
      || Boolean(inner && (PERSON_ONLY.has(inner) || HUMAN_ONLY.has(inner)))
      || Boolean(def && (registry.deps.presence ? registry.deps.presence.required(name, def, input) : def.presence));
    if (socket && personal && !MODEL_LABEL.test(caller)) {
      const why = await fromClaude(req.socket, registry);
      if (why) return send(res, 403, { error: { code: "denied", message: why } });
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
    const result = await registry.call(name, input, caller, { ...via, proof, ...(terminal ? { terminal } : {}), ...(call ? { call } : {}),
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
    const status = !result.error ? 200 : result.error.code === "person_session_required" ? 401 : result.error.code === "no_such_tool" ? 404 : ["denied", "presence_required", "no_dialog"].includes(result.error.code) ? 403 : result.error.code === "bad_input" ? 400
      : result.error.code === "idempotency_conflict" ? 409 : 500;
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
  // The Deck's colours from config, read on every request so a changed theme needs no restart.
  if (req.method === "GET" && url.pathname === "/theme.css") {
    res.writeHead(200, { "content-type": "text/css", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    return res.end(themeCss((config.load(root).theme || {}).colors));
  }
  // The one app (ADR 0027), beside the Deck until it takes over /.
  if (req.method === "GET" && (url.pathname === "/app" || url.pathname.startsWith("/app/"))) return serveApp(res, url.pathname);
  if (req.method === "GET" && !url.pathname.startsWith("/v1/")) return serveDeck(res, url.pathname);
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

/**
 * The Deck: static files from deck/ in the repo (the deck workstream builds them). Paths that
 * are not files get index.html, so the Deck can route on the client. Nothing outside deck/ is
 * ever served, whatever the path says.
 */
function serveDeck(res, pathname) {
  const dir = path.join(REPO, "deck");
  const shell = path.join(dir, "index.html");
  let file = path.resolve(dir, "." + path.posix.normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(dir + path.sep) && file !== dir) return send(res, 404, { error: { code: "not_found", message: pathname } });
  // A path that is not a file at all (any client route) wants the one shell. A path that IS a
  // real directory (a view's own folder of modules, e.g. deck/chat/) wants that shell too, unless
  // the directory happens to carry its own index.html: a bare 404 there would be surprising, since
  // nothing about the URL said "this is a module", only that a browser asked for a page.
  let wantsShell = false;
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
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache",
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'" });
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
