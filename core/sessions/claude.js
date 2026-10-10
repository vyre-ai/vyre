// @ts-check
// The Claude driver: one Vyre-owned Claude Code session on the Agent SDK (ADR 0030).
//
// It has the same shape as the CLI runner (core/switchboard/runner.js): `run(o)` returns
// { pid, write, alive, stop, interrupt } and calls onMessage with the messages Claude Code prints.
// The SDK speaks the protocol the runner speaks by hand, so what reaches the Switchboard is the
// same stream: system init, stream_event deltas, assistant and user messages, rate-limit events
// and a result per turn. What changes is who answers permission questions. The SDK calls
// canUseTool; this driver turns each call into the `control_request can_use_tool` line the
// Switchboard already raises as an ask, and the Switchboard's answer (a control_response written
// back) resolves it. A cancelled question (the turn was interrupted) becomes the same
// `control_cancel_request` Claude Code sends the runner.
//
// One long-lived query() per session, fed by a push queue that stays open between turns, which
// is what lets any surface type into it later. The child's pid is known (spawnClaudeCodeProcess),
// so the daemon's peer check and threads.pids see it as they see the runner's child.

import { spawnSession, killGroup } from "./spawn.js";
import { vyreMcpConfig } from "../../lib/mcp-config.js";

/** The permission modes Claude Code knows. "bypassPermissions" is here because a person may choose it (threads.mode, person only); no other bypass-shaped name is. */
const CLAUDE_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"]);

/** A push queue the SDK reads user messages from, for the life of the session. */
function inbox() {
  /** @type {any[]} */ const items = [];
  /** @type {((r: IteratorResult<any>) => void) | null} */ let wake = null;
  let ended = false;
  return {
    push(/** @type {any} */ m) { if (ended) return; if (wake) { const w = wake; wake = null; w({ value: m, done: false }); } else items.push(m); },
    end() { ended = true; if (wake) { const w = wake; wake = null; w({ value: undefined, done: true }); } },
    iterable: { [Symbol.asyncIterator]: () => ({
      next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
        : ended ? Promise.resolve({ value: undefined, done: true })
        : new Promise(r => { wake = r; }),
    }) },
  };
}

/**
 * The SDK's options for a launch. The same launch the CLI runner turns into flags (argsFor).
 * @param {{ id: string, native?: string|null, resume?: boolean, forkFrom?: string|null, resumeAt?: string|null, mode?: string|null, plugin?: string|null, plugins?: string[], model?: string|null, name?: string|null,
 *           system?: { mode: "append"|"replace", text: string }|null, append?: string|null, budgetUsd?: number|null,
 *           tools?: "none"|null, settings?: boolean, skippable?: boolean, effort?: string|null, ephemeral?: boolean, bin?: string|null, cwd: string, env: Record<string, string|undefined>, hooks?: any }} o
 */
export function optionsFor(o) {
  const system = o.system && o.system.mode === "replace" && o.system.text
    ? o.system.text
    : { type: /** @type {const} */ ("preset"), preset: /** @type {const} */ ("claude_code"),
        ...((o.system ? o.system.text : o.append) ? { append: /** @type {string} */ (o.system ? o.system.text : o.append) } : {}) };
  const plugins = [o.plugin, ...(o.plugins || [])].filter(Boolean).map(p => ({ type: /** @type {const} */ ("local"), path: /** @type {string} */ (p) }));
  return {
    cwd: o.cwd,
    env: o.env,
    includePartialMessages: true,
    // native: the session id this thread's Claude runs under now, when a rollover gave it a fresh one (a session id names one transcript); else the thread's own id.
    ...(o.forkFrom ? { resume: o.forkFrom, forkSession: true, sessionId: o.id } : o.resume ? { resume: o.native || o.id } : { sessionId: o.native || o.id }),
    ...(o.resumeAt && (o.resume || o.forkFrom) ? { resumeSessionAt: o.resumeAt } : {}),
    systemPrompt: system,
    settingSources: o.settings === false ? [] : ["user", "project", "local"],
    ...(plugins.length ? { plugins } : {}),
    ...(o.tools === "none" ? { tools: [] } : {}),
    // Only Vyre's own MCP server (lib/mcp-config.js): the account's claude.ai connectors and every other server are not loaded.
    strictMcpConfig: true,
    mcpServers: /** @type {any} */ (Object.fromEntries(Object.entries(vyreMcpConfig(o.plugin).mcpServers).map(([k, v]) => [k, { type: "stdio", command: v.command, args: v.args }]))),
    ...(o.model ? { model: o.model } : {}),
    ...(o.effort ? { effort: /** @type {any} */ (o.effort) } : {}),
    ...(o.mode ? { permissionMode: o.mode } : {}),
    // "Doesn't ask" (bypassPermissions) may be switched on later: only with Vyre's plugin loaded.
    ...(o.skippable ? { allowDangerouslySkipPermissions: true } : {}),
    ...(o.name && !o.resume ? { extraArgs: { name: o.name } } : {}),
    ...(typeof o.budgetUsd === "number" && o.budgetUsd > 0 ? { maxBudgetUsd: o.budgetUsd } : {}),
    ...(o.bin ? { pathToClaudeCodeExecutable: o.bin } : {}),
    ...(o.hooks ? { hooks: o.hooks } : {}),
    // File checkpoints, so a rewind can put the files back too (threads.rewind restore "code").
    // An ephemeral session (threads.quick) writes nothing to disk: no transcript, no checkpoints.
    ...(o.ephemeral ? { persistSession: false } : { enableFileCheckpointing: true }),
  };
}

/**
 * Start one session on the SDK. Same contract as runner.run.
 * @param {any} sdk the loaded SDK module (core/sessions/sdk.js load)
 * @param {Parameters<typeof optionsFor>[0] & { subreaper?: string|null, uid?: number, gid?: number,
 *           onSpawn?: (g: { pid: number, pgid: number, sid: number }) => void, onMessage: (m: any) => void, onExit: (code: number|null, signal: string|null, stderr: string) => void }} o
 */
export function run(sdk, o) {
  const input = inbox();
  /** @type {Map<string, (r: any) => void>} */ const waiting = new Map();
  /** @type {import("node:child_process").ChildProcess|null} */ let child = null;
  let err = "", exited = false, n = 0, code = /** @type {number|null} */ (null), sig = /** @type {string|null} */ (null);
  let pumped = false, died = false;
  const say = m => { try { o.onMessage(m); } catch {} };
  const done = () => { if (exited || !pumped || !(died || !child)) return; exited = true; o.onExit(code, sig, err); };

  const canUseTool = (tool, toolInput, opts) => new Promise(resolve => {
    const rid = `vyre-${++n}`;
    waiting.set(rid, resolve);
    opts?.signal?.addEventListener("abort", () => {
      if (!waiting.delete(rid)) return;
      say({ type: "control_cancel_request", request_id: rid });
      resolve({ behavior: "deny", message: "Cancelled." });
    }, { once: true });
    say({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: tool, input: toolInput,
      tool_use_id: opts?.toolUseID || null, permission_suggestions: opts?.suggestions || undefined,
      decision_reason: opts?.decisionReason || undefined, description: opts?.title || undefined,
      ...(opts?.blockedPath ? { blocked_path: opts.blockedPath } : {}), ...(opts?.mcpServer ? { mcp_server: opts.mcpServer } : {}) } });
  });

  const options = {
    ...optionsFor(o),
    canUseTool,
    stderr: (/** @type {string} */ c) => { err = (err + c).slice(-2000); },
    // Own the spawn: the pid is Vyre's to know, and a stop takes the whole tree.
    spawnClaudeCodeProcess: (/** @type {any} */ sp) => {
      const c = spawnSession(sp.command, sp.args, { cwd: sp.cwd, env: sp.env, signal: sp.signal, subreaper: o.subreaper, uid: o.uid, gid: o.gid, account: o.account, onSpawn: o.onSpawn, sandboxSpawn: /** @type {any} */ (o).sandboxSpawn, lentSpawn: /** @type {any} */ (o).lentSpawn });
      child = c;
      c.on("exit", (cd, s) => { code = cd; sig = s; died = true; done(); });
      c.on("error", e => { err = e.message; died = true; done(); });
      return c;
    },
  };

  /** @type {any} */ let q;
  try { q = sdk.query({ prompt: input.iterable, options }); }
  catch (e) { err = /** @type {Error} */ (e).message; pumped = true; died = true; queueMicrotask(done); return stub(); }

  (async () => {
    try { for await (const m of q) say(m); }
    catch (e) { err = (err + "\n" + String(/** @type {any} */ (e)?.message || e)).slice(-2000); }
    pumped = true;
    // The child may already be gone, or never have started (a missing binary).
    if (!child) died = true;
    done();
  })();

  /** Every process of this session: the SDK's child leads its own group. */
  const kill = (/** @type {NodeJS.Signals} */ s) => killGroup(child, s);

  function stub() { return { pid: undefined, write: () => false, get alive() { return false; }, stop: () => Promise.resolve(undefined), interrupt: () => Promise.resolve(undefined) }; }

  return {
    get pid() { return child ? child.pid : undefined; },
    /** A line as the runner takes it: a user turn, or the answer to a permission question. */
    write(/** @type {any} */ obj) {
      if (exited) return false;
      if (obj && obj.type === "user") { input.push(obj); return true; }
      if (obj && obj.type === "control_response") {
        const r = obj.response || {};
        const w = waiting.get(r.request_id);
        if (w) { waiting.delete(r.request_id); w(r.response); }
        return true;
      }
      if (obj && obj.type === "control_request" && obj.request && obj.request.subtype === "interrupt") { q.interrupt().catch(() => {}); return true; }
      return true;                                                         // initialize and the like: the SDK does its own
    },
    get alive() { return !exited; },
    /**
     * A control request, through the SDK's own call for it.
     * @param {string} subtype @param {Record<string, any>} [f]
     */
    async control(subtype, f = {}) {
      if (exited) throw new Error("the session has ended");
      if (subtype === "set_model") { await q.setModel(f.model); return {}; }
      if (subtype === "rewind_files") return q.rewindFiles(f.user_message_id, f.dry_run ? { dryRun: true } : undefined);
      if (subtype === "supported_commands") return { commands: await q.supportedCommands() };
      if (subtype === "stop_task") { await q.stopTask(f.task_id); return {}; }
      if (subtype === "apply_flag_settings") { await q.applyFlagSettings(f.settings || {}); return {}; }
      if (subtype === "set_max_thinking_tokens") { await q.setMaxThinkingTokens(f.max_thinking_tokens ?? null); return {}; }
      throw new Error(`no ${subtype} on the Agent SDK driver`);
    },
    /** A permission mode a person chose (the Switchboard checks which). */
    /** Only the modes Claude Code has; anything else, a bypass-shaped name above all, is refused here (conform's fixed set). */
    async setMode(/** @type {string} */ mode) {
      if (!CLAUDE_MODES.has(String(mode))) throw Object.assign(new Error(`${mode} is not a permission mode: use one of default, acceptEdits, plan, dontAsk or auto`), { code: "denied" });
      if (!exited) await q.setPermissionMode(mode);
    },
    /** Stop the current turn; the session stays. */
    async interrupt() { if (!exited) await q.interrupt().catch(() => {}); },
    /** End it: close the input (Claude Code finishes and exits), then TERM, then KILL, the whole tree. */
    stop(grace = 3000) {
      return new Promise(resolve => {
        if (exited) return resolve(undefined);
        const t = setInterval(() => { if (exited) { clearInterval(t); clearTimeout(term); clearTimeout(hard); resolve(undefined); } }, 25);
        // Open questions are not answered: the process ends with them, as the runner's does.
        waiting.clear();
        input.end();
        const term = setTimeout(() => kill("SIGTERM"), Math.min(500, grace));
        const hard = setTimeout(() => { kill("SIGKILL"); try { q.close(); } catch {} }, grace);
      });
    },
  };
}
