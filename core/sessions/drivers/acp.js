// @ts-check
// The generic ACP driver (plans/sessions.md 3.1, build step 5): one provider driver for any agent
// that speaks the Agent Client Protocol over stdio (Grok's own CLI, Codex through codex-acp, ...).
// What differs per provider is only the entry passed to acpProvider(): which binary, which flags
// and env, and what that provider's own login state is (the caller's HOME).
//
// Hand-rolled, not @agentclientprotocol/sdk (1.5.1 on npm at the time of writing): the part we
// need is a small ndjson JSON-RPC client (initialize, session/new|load, session/prompt,
// session/update, session/request_permission, session/cancel, fs/*, terminal/*), the session is a
// long-lived process Vyre must be able to take down by process group, and a 0.x-then-1.x SDK that
// owns the child's streams is one more thing to pin and re-conform on each bump (plan 6.13). The
// wire below is small enough to conform() on every change instead.
//
// The driver speaks the same session wire Claude's does (core/sessions/conformance.js), so the
// Switchboard, the surfaces and the floor's ask path need no provider-specific code:
//   session/update agent_message_chunk   -> stream_event text_delta (and a whole assistant text at turn end)
//   session/update agent_thought_chunk   -> stream_event thinking_delta
//   session/update tool_call             -> assistant tool_use;  tool_call_update done -> user tool_result
//   session/request_permission           -> control_request can_use_tool (control_cancel_request on cancel)
//   prompt response                      -> result
// A control_response allow answers with the agent's allow_once option, a deny with reject_once. An
// allow_always / reject_always option is never chosen: "always in this project" is Vyre's own rule.
//
// Security (reviewer-2 B2, H2, H3):
//  - The client advertises fs.readTextFile, fs.writeTextFile and terminal, and serves them here, so
//    an agent that honours them does its file and shell work through Vyre. Each call goes past the
//    floor (o.floor, the same function core/harness/rules.js exports as rules(), reached through the
//    ACP tool kind -> Claude tool name mapper below). A floor "deny" is an ACP error; "ask" goes to
//    the person through the same control_request path as any permission question. With no floor
//    given, nothing is served: no floor, no file or shell access.
//  - These methods run as vyred's own uid, not the account's. So files are confined to the
//    session's cwd (realpath, no symlink at the target) whatever the floor says; anything outside
//    is refused. What an agent does natively, past these methods, runs as the account's uid and is
//    the OS boundary's job (per-account uid, plan 3.7 B1), not this driver's.
//  - Modes the agent reports are filtered: anything bypass-shaped is never listed and setMode
//    refuses it. Approval and sandbox flags are the entry's `args`/`env`, passed at every start,
//    never read from the agent's own config file.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spawnSession, killGroup } from "../spawn.js";
import { redact } from "../../transcripts/sanitize.js";
import { within } from "../../../lib/within.js";

/** How long a turn waits for memory before it goes without. */
const MEMORY_MS = 3000;

/** A mode name that would let the agent stop asking. Never offered, never set. */
/**
 * The modes Vyre permits by name: the ones where the agent keeps asking (or cannot write). Anything else an agent reports is
 * refused, never listed and never entered, including a mode a later release adds: an allowlist, because a denylist of bypass
 * words let Codex's "agent-full-access" through once. An entry may narrow it (`allowModes`, intersected with this list), never widen it.
 */
export const ALLOWED_MODES = /^(default|ask|untrusted|on-request|read-?only|workspace-write|plan|agent)$/i;
export const BYPASS_MODE = /bypass|yolo|dangerous|never.?ask|full.?auto|full.?access|auto.?approve|accept.?all|skip.?perm/i;

/** ACP tool kind -> the Claude tool name the floor's rules know (rules.js is Claude-tool-name shaped until build step 8). */
const KIND_TOOL = { read: "Read", edit: "Write", delete: "Write", move: "Write", search: "Grep", execute: "Bash", fetch: "WebFetch" };
/** ACP tool kind -> the kind a surface draws (delete and move are edits; execute is a run; the rest are "other"). */
const KIND_SEEN = { read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", execute: "run", fetch: "fetch" };

/**
 * The ask the Switchboard shows, from an ACP tool call.
 * @param {any} tc ACP toolCall @returns {{ name: string, input: Record<string, any> }}
 */
export function askFor(tc) {
  const raw = tc && tc.rawInput && typeof tc.rawInput === "object" ? { ...tc.rawInput } : {};
  const name = KIND_TOOL[tc && tc.kind] || String((tc && tc.title) || "Tool");
  const loc = Array.isArray(tc && tc.locations) && tc.locations[0] && tc.locations[0].path;
  if (name === "Bash") { if (typeof raw.command !== "string") raw.command = [raw.command, ...(Array.isArray(raw.args) ? raw.args : [])].filter(x => typeof x === "string").join(" ") || String(tc.title || ""); }
  else if (["Read", "Write"].includes(name)) { if (typeof raw.file_path !== "string") raw.file_path = String(raw.path || loc || ""); }
  return { name, input: raw };
}

const text = c => (typeof c === "string" ? c : Array.isArray(c) ? c.map(b => (b && b.type === "text" ? String(b.text) : "")).join("") : c && c.type === "text" ? String(c.text) : "");

/** Every descendant pid of `pid`, from one ps snapshot (portable to macOS and Linux). */
function descendants(pid) {
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map(l => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [p, pp] of rows) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
    const out = [], todo = [pid];
    while (todo.length) for (const k of kids.get(/** @type {number} */ (todo.pop())) || []) { out.push(k); todo.push(k); }
    return out;
  } catch { return []; }
}
/** Does a .codex/config.toml in this folder or any above it define an MCP server? Codex loads those on top of the account's own config. @param {string} dir */
export function projectDefinesMcp(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    try { if (/^\s*(?:\[\s*(?:\[\s*)?mcp_servers|"?mcp_servers"?\s*[.=])/m.test(fs.readFileSync(path.join(d, ".codex", "config.toml"), "utf8"))) return true; } catch { /* none here */ }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return false;
}
const kill = (pid, sig) => { try { process.kill(pid, sig); } catch {} };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; } };

/** Sessions the agent knows, by Vyre thread id, for a resume in this vyred. The caller may pass a persistent one. */
const remembered = new Map();

/**
 * @param {{ id: string, bin: string, askMode?: RegExp, seed?: Record<string, string> | ((o: any) => Record<string, string>), secretEnv?: string[] | ((o: any) => string[]), args?: string[] | ((o: any) => string[]), env?: Record<string, string> | ((o: any) => Record<string, string>),
 *   capabilities?: Record<string, any>, floor?: (call: { tool: string, input: any, cwd?: string }) => { decision: "deny"|"ask"|null, reason?: string },
 *   allowModes?: RegExp, pinMode?: string[],
 *   authMethod?: (methods: { id: string, name?: string }[], run: any) => string|null, authTimeoutMs?: number,
 *   authFirst?: boolean, clientCapabilities?: Record<string, any>, authParams?: (methodId: string, run: any) => Record<string, any>,
 *   sessions?: { get(id: string): string|undefined, set(id: string, agent: string): void } }} entry
 */
export function acpProvider(entry) {
  const known = entry.sessions || { get: id => remembered.get(id), set: (id, a) => { remembered.set(id, a); } };
  return {
    id: entry.id,
    driver: "acp",
    capabilities: { streaming: true, resume: true, interrupt: true, modes: true, steering: false, usage: "coarse", ...(entry.capabilities || {}) },
    /** @param {any} o */
    run(o) { return runAcp(entry, known, o); },
  };
}

/** @param {any} entry @param {any} known @param {any} o */
function runAcp(entry, known, o) {
  const floor = o.floor || entry.floor || null;
  const args = typeof entry.args === "function" ? entry.args(o) : entry.args || [];
  const extra = typeof entry.env === "function" ? entry.env(o) : entry.env || {};
  const cwd = o.cwd || process.cwd();
  // Files the entry has Vyre put in the account's HOME at every start (a provider's own config: the
  // agent could otherwise have edited what it reads), written as the account's uid, mode 0600.
  const seed = typeof entry.seed === "function" ? entry.seed(o) : entry.seed || undefined;
  // The provider's key is the CLI's own; the shells it asks Vyre to run (terminal/create) never get it.
  const secretEnv = new Set(typeof entry.secretEnv === "function" ? entry.secretEnv(o) : entry.secretEnv || []);
  /** Anything that leaves for a person or a transcript (an error, the agent's stderr tail) is stripped of credential shapes and of this run's own secret values. */
  const scrub = t => {
    let out = redact(String(t ?? "")).text;
    for (const n of secretEnv) { const v = o.env && o.env[n]; if (typeof v === "string" && v.length >= 6) out = out.split(v).join("[secret]"); }
    return out;
  };
  const child = spawnSession(entry.bin, args, { cwd, env: { ...(o.env || {}), ...extra }, subreaper: o.subreaper, uid: o.uid, gid: o.gid, account: o.account, ...(seed ? { seed } : {}), onSpawn: o.onSpawn });
  const say = m => { try { o.onMessage(m); } catch {} };

  let buf = "", err = "", exited = false, rpcId = 0, ready = false, busy = false, sid = "", loaded = false;
  /** @type {Map<number, { resolve: (r: any) => void, reject: (e: any) => void }>} */ const calls = new Map();
  /** @type {Map<string, { rpc: number, options: any[] }>} permission questions open with a person */ const asks = new Map();
  /** @type {Set<string>} */ const announced = new Set();
  /** @type {Map<string, any>} */ const terminals = new Map();
  /** @type {any[]} */ const queue = [];
  let modes = /** @type {{ id: string, name?: string }[]} */ ([]), mode = null, turnText = "", askN = 0, tn = 0, cancelling = false, tree = /** @type {number[]} */ ([]);
  let firstPrompt = true;

  const send = obj => { if (!exited && child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\n"); };
  const request = (method, params, timeoutMs = 0) => new Promise((resolve, reject) => {
    const id = ++rpcId;
    calls.set(id, { resolve, reject });
    send({ id, method, params });
    if (timeoutMs > 0) setTimeout(() => { if (calls.delete(id)) reject(Object.assign(new Error(`${method} did not answer in ${Math.round(timeoutMs / 1000)} s`), { code: "timeout" })); }, timeoutMs).unref?.();
  });
  const respond = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      handle(m).catch(e => { if (m && m.id !== undefined && m.method) fail(m.id, -32603, String(e && e.message || e)); });
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", c => { err = (err + c).slice(-2000); });
  child.stdin.on("error", () => {});
  const done = (code, signal) => {
    if (exited) return; exited = true;
    for (const t of terminals.values()) { try { killGroup(t.child, "SIGKILL"); } catch {} }
    for (const p of tree) kill(p, "SIGKILL");
    for (const c of calls.values()) c.reject(new Error("the agent ended"));
    o.onExit(code, signal, scrub(err));
  };
  child.on("exit", done);
  child.on("error", e => { err = e.message; done(null, null); });

  /** @param {any} m */
  async function handle(m) {
    if (m.method === undefined && m.id !== undefined) {           // a response to us
      const c = calls.get(m.id); if (!c) return; calls.delete(m.id);
      if (m.error) c.reject(Object.assign(new Error(String(m.error.message || "agent error")), { code: m.error.code })); else c.resolve(m.result || {});
      return;
    }
    if (m.method === "session/update") return update(m.params && m.params.update || {});
    if (m.method === "session/request_permission") return permission(m);
    if (m.method === "fs/read_text_file") return fsRead(m);
    if (m.method === "fs/write_text_file") return fsWrite(m);
    if (typeof m.method === "string" && m.method.startsWith("terminal/")) return terminal(m);
    if (m.id !== undefined && m.method) fail(m.id, -32601, `no such method ${m.method}`);
  }

  function announce(tc) {
    const id = String(tc.toolCallId || tc.id || "");
    if (!id || announced.has(id)) return id;
    announced.add(id);
    const a = askFor(tc);
    say({ type: "assistant", message: { id: `acp-${id}`, content: [{ type: "tool_use", id, name: a.name, input: a.input, vyre_kind: KIND_SEEN[tc.kind] || "other" }] } });
    return id;
  }

  /**
   * The agent says it changed its own mode. A listed mode is recorded; an unlisted one (a bypass mode, one a new release added, one
   * its own config chose) is never recorded and is reverted with session/set_mode to the last listed mode, or the session is stopped.
   * An agent that lists no modes at all (Grok) has nothing to enforce, but a bypass-shaped name still stops it.
   * @param {string} id
   */
  function modeUpdate(id) {
    if (modes.some(x => x.id === id)) { mode = id; return; }
    if (!modes.length && !BYPASS_MODE.test(id)) return;
    const back = mode && modes.some(x => x.id === mode) ? mode : (Array.isArray(entry.pinMode) ? entry.pinMode.find(m => modes.some(x => x.id === m)) : null) || (modes[0] && modes[0].id) || null;
    const halt = () => {
      say({ type: "result", subtype: "error", is_error: true, result: `${entry.id[0].toUpperCase() + entry.id.slice(1)} switched itself to a mode Vyre does not permit (${String(id).slice(0, 60)}) and could not be put back; Vyre stopped it`, total_cost_usd: 0 });
      try { killGroup(child, "SIGKILL"); } catch {}
    };
    if (!back) return halt();
    request("session/set_mode", { sessionId: sid, modeId: back }, 10_000).then(() => { mode = back; }, halt);
  }

  function update(u) {
    const kind = u.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const t = text(u.content);
      if (t) { turnText += t; say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } }); }
    } else if (kind === "agent_thought_chunk") {
      const t = text(u.content);
      if (t) say({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: t } } });
    } else if (kind === "tool_call") {
      announce(u);
      if (u.status === "completed" || u.status === "failed") toolDone(u);
    } else if (kind === "tool_call_update") {
      if (!announced.has(String(u.toolCallId))) announce(u);
      if (u.status === "completed" || u.status === "failed") toolDone(u);
    } else if (kind === "current_mode_update" && typeof u.currentModeId === "string") {
      modeUpdate(u.currentModeId);
    } else if (kind === "plan" && Array.isArray(u.entries)) {
      say({ type: "system", subtype: "vyre_plan", entries: u.entries });
    } else if (kind === "usage_update") {
      usage = { context_used: Number(u.used) || 0, context_size: Number(u.size) || 0, ...(u.cost && typeof u.cost.amount === "number" ? { cost: u.cost.amount } : {}) };
    }
  }
  let usage = /** @type {any} */ (null);
  /** Whether the shortcut for Vyre's own MCP server may be used in this session (set at every start). */
  let ownMcpSafe = false;
  function toolDone(u) {
    const body = Array.isArray(u.content) ? u.content.map(c => text(c && c.content !== undefined ? c.content : c)).join("") : "";
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: String(u.toolCallId), is_error: u.status === "failed", content: body }] } });
  }

  /** A permission question: to the person as can_use_tool; the answer picks an allow_once or reject_once option. */
  async function permission(m) {
    const p = m.params || {};
    const tc = p.toolCall || {};
    // MEASURED on codex-acp 2.1.0: before an MCP tool runs, Codex asks with kind "execute", NO title and NO rawInput, and says only
    // _meta.is_mcp_tool_approval. It names neither the server nor the tool, so asking the person "run this command" with a blank command
    // would be a lie. The session's own MCP servers are known here (mcpServers in session/new): with exactly one, the question is about
    // one of ITS tools. Vyre's own server ("vyre") is gated by vyred itself on every call (reach, the Gate, presence), so an entry that
    // says so (`mcpOwn`) lets that approval through at once; any other server's is put to the person, named by its server.
    // BUT the approval cannot say WHICH server it is for, and Codex also loads MCP servers from a project's own .codex/config.toml, which
    // an agent with workspace write can create for the next start (measured: a project config that redefines "vyre" replaces it, runs
    // unsandboxed, and inherits the approval setting). So the shortcut holds only when no .codex/config.toml from the session folder up
    // defines an MCP server, checked at every start (ownMcpSafe); otherwise every MCP approval goes to the person.
    if (p._meta && p._meta.is_mcp_tool_approval === true) {
      const servers = (Array.isArray(o.mcpServers) ? o.mcpServers : []).map(x => String((x && x.name) || ""));
      const only = servers.length === 1 ? servers[0] : "";
      const opts = Array.isArray(p.options) ? p.options : [];
      const once = opts.find(x => x && x.kind === "allow_once");
      if (entry.mcpOwn && only === "vyre" && once && ownMcpSafe) { respond(m.id, { outcome: { outcome: "selected", optionId: once.optionId } }); return; }
      const rid = `acp-perm-${++askN}`;
      asks.set(rid, { rpc: m.id, options: opts });
      say({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: only ? `mcp__${only}` : "mcp", input: { note: "an MCP tool; the agent did not say which" }, tool_use_id: String(tc.toolCallId || "") } });
      return;
    }
    announce(tc);
    const a = askFor(tc);
    const rid = `acp-perm-${++askN}`;
    asks.set(rid, { rpc: m.id, options: Array.isArray(p.options) ? p.options : [] });
    say({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: a.name, input: a.input, tool_use_id: String(tc.toolCallId || "") } });
  }

  /** @param {any} r the control_response body */
  function answer(r) {
    const a = asks.get(r.request_id); if (!a) return;
    asks.delete(r.request_id);
    const body = r.response || {};
    const want = body.behavior === "allow" ? "allow_once" : "reject_once";
    const opt = a.options.find(x => x && x.kind === want);
    respond(a.rpc, { outcome: opt ? { outcome: "selected", optionId: opt.optionId } : { outcome: "cancelled" } });
  }

  function withdrawAsks() {
    for (const [rid, f] of [...pendingLocal]) { pendingLocal.delete(rid); f(false); say({ type: "control_cancel_request", request_id: rid }); }
    for (const [rid, a] of [...asks]) { asks.delete(rid); respond(a.rpc, { outcome: { outcome: "cancelled" } }); say({ type: "control_cancel_request", request_id: rid }); }
  }

  /** The floor, and the cwd confinement, for one client-side call. Throws an ACP error to send back. */
  async function gate(tool, input, file) {
    const v = floor ? floor({ tool, input, cwd }) : { decision: "deny", reason: "no security floor is attached to this session, so file and shell access is off" };
    if (v && v.decision === "deny") throw Object.assign(new Error(String(v.reason || "the floor refused this")), { code: -32003 });
    if (v && v.decision === "ask") {
      const rid = `acp-perm-${++askN}`;
      const okay = await new Promise(resolve => {
        pendingLocal.set(rid, resolve);
        say({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: tool, input, tool_use_id: "" } });
      });
      if (!okay) throw Object.assign(new Error("not allowed"), { code: -32003 });
    }
    if (file !== undefined) return confine(file, tool === "Write");
    return null;
  }
  /** @type {Map<string, (ok: boolean) => void>} */ const pendingLocal = new Map();

  /** A path inside the session's cwd, by real path; never through a symlink at the target. */
  function confine(p, forWrite) {
    if (typeof p !== "string" || !path.isAbsolute(p)) throw Object.assign(new Error("path must be absolute"), { code: -32602 });
    const root = fs.realpathSync(cwd);
    const abs = path.resolve(p);
    let real;
    if (forWrite) {
      real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
      try { if (fs.lstatSync(real).isSymbolicLink()) throw Object.assign(new Error("not through a link"), { code: -32003 }); } catch (e) { if (/** @type {any} */ (e).code === -32003) throw e; }
    } else real = fs.realpathSync(abs);
    if (real !== root && !real.startsWith(root + path.sep)) throw Object.assign(new Error("outside this session's folder"), { code: -32003 });
    return real;
  }

  /**
   * Open a confined path without racing the check: O_NOFOLLOW, then the open file itself is asked
   * where it is (Linux: /proc/self/fd; elsewhere its dev and inode must equal the path's and the
   * folder must still resolve inside the session's folder). The agent owns the folder and can swap
   * a file or a parent for a link between the check and the open; these methods run as vyred.
   * @param {string} real @param {number} flags
   */
  function openConfined(real, flags) {
    const root = fs.realpathSync(cwd);
    const inside = q => q === root || q.startsWith(root + path.sep);
    const fd = fs.openSync(real, flags | fs.constants.O_NOFOLLOW, 0o644);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: -32003 });
      let where = null;
      try { where = fs.realpathSync(`/proc/self/fd/${fd}`); } catch {}
      if (where !== null) { if (!inside(where)) throw Object.assign(new Error("outside this session's folder"), { code: -32003 }); }
      else {
        const l = fs.lstatSync(real);
        if (l.dev !== st.dev || l.ino !== st.ino || !inside(path.join(fs.realpathSync(path.dirname(real)), path.basename(real)))) throw Object.assign(new Error("the file changed while it was opened"), { code: -32003 });
      }
      return fd;
    } catch (e) { try { fs.closeSync(fd); } catch {} throw e; }
  }

  async function fsRead(m) {
    const p = m.params || {};
    const real = await gate("Read", { file_path: p.path }, p.path);
    let c;
    { const fd = openConfined(/** @type {string} */ (real), fs.constants.O_RDONLY); try { c = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); } }
    if (p.line || p.limit) { const ls = c.split("\n"); const s = Math.max(0, (Number(p.line) || 1) - 1); c = ls.slice(s, p.limit ? s + Number(p.limit) : undefined).join("\n"); }
    respond(m.id, { content: c });
  }
  async function fsWrite(m) {
    const p = m.params || {};
    const real = await gate("Write", { file_path: p.path, content: String(p.content ?? "") }, p.path);
    // Not truncated until the open file has been checked.
    const fd = openConfined(/** @type {string} */ (real), fs.constants.O_WRONLY | fs.constants.O_CREAT);
    try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, String(p.content ?? "")); } finally { fs.closeSync(fd); }
    respond(m.id, null);
  }

  async function terminal(m) {
    const p = m.params || {};
    if (m.method === "terminal/create") {
      const command = [p.command, ...(Array.isArray(p.args) ? p.args : [])].join(" ");
      await gate("Bash", { command });
      const tid = `term-${++tn}`;
      const env = { ...(o.env || {}), ...Object.fromEntries((Array.isArray(p.env) ? p.env : []).filter(e => e && typeof e.name === "string" && !/^(LD_|DYLD_|NODE_OPTIONS)/.test(e.name)).map(e => [e.name, String(e.value)])) };
      for (const k of secretEnv) delete env[k];
      const t = { output: "", truncated: false, exit: /** @type {any} */ (null), waiters: /** @type {any[]} */ ([]), child: /** @type {any} */ (null), limit: Number(p.outputByteLimit) || 1_000_000 };
      // MEASURED on Grok Build 1.0.46: it sends the whole command line as `command` with no `args` ("/usr/bin/bash -lc 'touch x'"), which as
      // an executable path is ENOENT. A command with spaces and no args is a command line, run by the shell the floor already judged it as.
      const argv = Array.isArray(p.args) ? p.args.map(String) : [];
      const line = String(p.command);
      const [exe, args] = !argv.length && /\s/.test(line.trim()) ? ["/bin/sh", ["-c", line]] : [line, argv];
      t.child = spawnSession(exe, args, { cwd: p.cwd ? confine(String(p.cwd), false) : cwd, env, subreaper: o.subreaper, uid: o.uid, gid: o.gid, account: o.account });
      const add = d => { t.output += d; if (t.output.length > t.limit) { t.output = t.output.slice(-t.limit); t.truncated = true; } };
      t.child.stdout.setEncoding("utf8"); t.child.stderr.setEncoding("utf8");
      t.child.stdout.on("data", add); t.child.stderr.on("data", add);
      t.child.on("exit", (code, signal) => { t.exit = { exitCode: code, signal }; for (const w of t.waiters) w(t.exit); });
      t.child.on("error", e => { add(e.message); t.exit = { exitCode: 127, signal: null }; for (const w of t.waiters) w(t.exit); });
      terminals.set(tid, t);
      return respond(m.id, { terminalId: tid });
    }
    const t = terminals.get(String(p.terminalId));
    if (!t) return fail(m.id, -32602, "no such terminal");
    if (m.method === "terminal/output") return respond(m.id, { output: t.output, truncated: t.truncated, ...(t.exit ? { exitStatus: t.exit } : {}) });
    if (m.method === "terminal/wait_for_exit") return respond(m.id, t.exit || await new Promise(r => t.waiters.push(r)));
    if (m.method === "terminal/kill") { killGroup(t.child, "SIGKILL"); return respond(m.id, null); }
    if (m.method === "terminal/release") { killGroup(t.child, "SIGKILL"); terminals.delete(String(p.terminalId)); return respond(m.id, null); }
    fail(m.id, -32601, `no such method ${m.method}`);
  }

  // ---------------------------------------------------------------- the session
  async function open() {
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, ...(entry.clientCapabilities || {}) }, clientInfo: { name: "vyre", version: "0.2" } });
    const caps = init.agentCapabilities || {};
    const prior = o.resume ? known.get(o.id) : undefined;
    const servers = Array.isArray(o.mcpServers) ? o.mcpServers : [];
    ownMcpSafe = !projectDefinesMcp(cwd);
    // Real agents (codex-acp, Grok Build) answer session/new with "Authentication required" (-32000) until the client calls
    // authenticate {methodId}. The entry names the method it wants from what the agent offers (never a prompt to the person):
    // an API key method when the key is in the environment, else the stored login. An agent that then waits for a browser
    // sign-in is a session that is not signed in, said plainly.
    const methods = Array.isArray(init.authMethods) ? init.authMethods.filter(x => x && typeof x.id === "string") : [];
    const label = entry.id[0].toUpperCase() + entry.id.slice(1);
    const withAuth = async (method, params) => {
      try { return await request(method, params); } catch (e) {
        const err = /** @type {any} */ (e);
        if (err.code !== -32000 || !methods.length || typeof entry.authMethod !== "function") throw e;
        const methodId = entry.authMethod(methods, o);
        if (!methodId) throw new Error(`${label} needs a sign-in and offers no way Vyre can use: ${methods.map(x => x.id).join(", ")}`);
        try { await request("authenticate", { methodId, ...(typeof entry.authParams === "function" ? entry.authParams(methodId, o) : {}) }, entry.authTimeoutMs || 20_000); } catch (a) {
          throw new Error(/** @type {any} */ (a).code === "timeout" ? `${label} is waiting for a sign-in in a browser: sign this account in first` : `${label} did not accept its sign-in (${scrub(String(/** @type {any} */ (a).message)).slice(0, 200)})`);
        }
        return request(method, params);
      }
    };
    // An entry that must configure the agent before any session exists (Codex's gateway: where the model is) authenticates first.
    if (entry.authFirst && methods.length && typeof entry.authMethod === "function") {
      const methodId = entry.authMethod(methods, o);
      if (!methodId) throw new Error(`${label} needs a sign-in and offers no way Vyre can use: ${methods.map(x => x.id).join(", ")}`);
      try { await request("authenticate", { methodId, ...(typeof entry.authParams === "function" ? entry.authParams(methodId, o) : {}) }, entry.authTimeoutMs || 20_000); } catch (a) {
        throw new Error(/** @type {any} */ (a).code === "timeout" ? `${label} is waiting for a sign-in in a browser: sign this account in first` : `${label} did not accept its sign-in (${scrub(String(/** @type {any} */ (a).message)).slice(0, 200)})`);
      }
    }
    let r;
    if (prior && (caps.loadSession || (caps.sessionCapabilities && caps.sessionCapabilities.resume))) {
      const method = caps.loadSession ? "session/load" : "session/resume";
      r = await withAuth(method, { sessionId: prior, cwd, mcpServers: servers });
      sid = prior; loaded = true;
    } else {
      r = await withAuth("session/new", { cwd, mcpServers: servers });
      sid = String(r.sessionId || "");
    }
    if (!sid) throw new Error("the agent gave no session id");
    known.set(o.id, sid);
    const m = r.modes || {};
    const allow = entry.allowModes || ALLOWED_MODES;
    const permitted = x => Boolean(x) && typeof x.id === "string" && allow.test(x.id) && ALLOWED_MODES.test(x.id) && !BYPASS_MODE.test(x.id + " " + (x.name || ""));
    modes = (Array.isArray(m.availableModes) ? m.availableModes : []).filter(permitted);
    mode = typeof m.currentModeId === "string" && modes.some(x => x.id === m.currentModeId) ? m.currentModeId : null;
    // Fail closed: an agent that starts in a mode Vyre does not list (one that approves everything, a mode a new release added, or
    // one its own config file, which the agent can edit, chose) is moved to an ask mode, or the session does not run.
    const rawMode = String(m.currentModeId || "");
    if (rawMode && !modes.some(x => x.id === rawMode)) {
      const ask = entry.askMode || /^(default|ask|untrusted|on-request|read-?only|workspace-write|plan|agent)$/i;
      const to = modes.find(x => ask.test(x.id));
      let ok = false;
      if (to) { try { await request("session/set_mode", { sessionId: sid, modeId: to.id }); mode = to.id; ok = true; } catch {} }
      if (!ok) throw new Error(`${entry.id[0].toUpperCase() + entry.id.slice(1)} starts in a mode Vyre does not permit (${rawMode}) and could not be moved to one it does; Vyre did not start it`);
    }
    // An entry can pin the start mode to an explicit list, on every start (and a resume): the agent's own config cannot choose it.
    if (Array.isArray(entry.pinMode)) {
      const want = entry.pinMode.find(id => modes.some(x => x.id === id));
      if (!want) throw new Error(`${entry.id[0].toUpperCase() + entry.id.slice(1)} offers none of the modes Vyre starts it in (${entry.pinMode.join(", ")}); Vyre did not start it`);
      if (mode !== want) await request("session/set_mode", { sessionId: sid, modeId: want });
      mode = want;
    }
    const model = r.models && r.models.currentModelId || o.model || null;
    ready = true;
    say({ type: "system", subtype: "init", session_id: o.id, agent_session_id: sid, model, modes: modes.map(x => x.id), mode, resumed: loaded });
    pump();
  }
  open().catch(e => { err = scrub(String(e && e.message || e)); say({ type: "result", subtype: "error", is_error: true, result: err, total_cost_usd: 0 }); });

  function pump() {
    if (!ready || busy || exited || !queue.length) return;
    const blocks = queue.shift();
    busy = true; cancelling = false; turnText = "";
    // The person's own words, before Vyre's prompt is put in front of them: what memory searches on.
    const words = blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
    const first = firstPrompt && !loaded;
    const sys = first && o.system && o.system.text ? [{ type: "text", text: String(o.system.text) }] : [];
    firstPrompt = false;
    // Memory, as Claude gets it: the brief on the first prompt and up to 5 quoted lines on every one,
    // ahead of the person's words, scoped by vyred to this thread's own agent and project (the
    // caller passes memory(); a slow or failing memory adds nothing and never holds the turn).
    const memory = o.memory ? within(Promise.resolve().then(() => o.memory({ prompt: words, first })), MEMORY_MS, []).catch(() => []) : Promise.resolve([]);
    memory.then(extra => request("session/prompt", { sessionId: sid, prompt: [...sys, ...(Array.isArray(extra) ? extra : []), ...blocks] })).then(r => r, e => ({ error: e })).then(r => {
      withdrawAsks();
      if (turnText) say({ type: "assistant", message: { id: `acp-turn-${Date.now()}`, content: [{ type: "text", text: turnText }] } });
      const bad = r && r.error;
      say({ type: "result", subtype: bad ? "error" : "success", is_error: Boolean(bad), result: bad ? String(r.error.message || r.error) : turnText,
        stop_reason: r && r.stopReason || null, total_cost_usd: usage && usage.cost || 0, usage: usage || {} });
      busy = false; pump();
    });
  }

  const promptBlocks = c => {
    if (typeof c === "string") return [{ type: "text", text: c }];
    return (Array.isArray(c) ? c : []).map(b => b && b.type === "text" ? { type: "text", text: String(b.text) }
      : b && b.type === "image" && b.source ? { type: "image", data: String(b.source.data), mimeType: String(b.source.media_type) } : null).filter(Boolean);
  };

  return {
    get pid() { return child.pid; },
    get alive() { return !exited; },
    /** The agent's own modes, bypass-shaped ones removed, and the current one when it is safe. */
    get modes() { return modes.map(x => x.id); },
    get mode() { return mode; },
    /** @param {any} obj */
    write(obj) {
      if (exited) return false;
      if (obj && obj.type === "user") { const b = promptBlocks(obj.message && obj.message.content); if (b.length) { queue.push(b); pump(); } return true; }
      if (obj && obj.type === "control_response" && obj.response) {
        const rid = obj.response.request_id;
        if (pendingLocal.has(rid)) { const f = pendingLocal.get(rid); pendingLocal.delete(rid); if (f) f(Boolean(obj.response.response && obj.response.response.behavior === "allow")); return true; }
        answer({ request_id: rid, response: obj.response.response });
      }
      return true;
    },
    /** Change the agent's mode. A bypass-shaped or unknown one is refused, whatever asked. */
    async setMode(id) {
      const want = String(id || "");
      if (!modes.some(x => x.id === want)) throw Object.assign(new Error(`mode ${want} is not available here`), { code: "denied" });
      await request("session/set_mode", { sessionId: sid, modeId: want });
      mode = want;
      return { mode };
    },
    /** Stop the turn; the session stays. Open questions are withdrawn at once. */
    interrupt() {
      cancelling = true;
      if (sid) send({ method: "session/cancel", params: { sessionId: sid } });
      withdrawAsks();
      return Promise.resolve();
    },
    /** End it: the group first, then whatever the agent's tools detached from it (they are found before the group goes). */
    stop(grace = 3000) {
      return new Promise(resolve => {
        if (exited) return resolve(undefined);
        tree = child.pid ? descendants(child.pid) : [];
        child.once("exit", () => { for (const p of tree) if (alive(p)) kill(p, "SIGKILL"); resolve(undefined); });
        try { withdrawAsks(); child.stdin.end(); } catch {}
        for (const p of tree) kill(p, "SIGTERM");
        const term = setTimeout(() => killGroup(child, "SIGTERM"), Math.min(500, grace));
        const hard = setTimeout(() => { killGroup(child, "SIGKILL"); for (const p of tree) kill(p, "SIGKILL"); }, grace);
        child.once("exit", () => { clearTimeout(term); clearTimeout(hard); });
      });
    },
  };
}
