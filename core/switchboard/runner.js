// @ts-check
// runner: one headless Claude Code process, and nothing else.
//
// This is the only file that knows how a headless session is run. Everything above it deals in
// lines of stream-json going in and out, so the process model can change (a container per
// agent, a remote box, Claude Code's own background sessions) by replacing this file.
//
// The child is vyred's: it is spawned by the daemon, not by a surface, so closing the Deck, the
// Capsule or a terminal never ends it. Its stdin stays open for the life of the session, which
// is what lets any surface type into it later.
//
// Flags, checked against `claude --help` on Claude Code 2.1.283:
//   -p --input-format stream-json --output-format stream-json   lines in, lines out
//   --include-partial-messages --verbose                          text as it grows
//   --permission-prompts host --permission-prompt-tool stdio      permission questions come to
//     us as control requests. `--permission-prompts host` alone is not enough on 2.1.283: with
//     no prompt tool named, every question was denied on the spot ("you haven't granted it
//     yet"). `--permission-prompt-tool stdio` is what the SDK passes, and is not in --help.
//   --session-id <uuid> for a new thread, so its id is known before Claude Code says it;
//   --resume <id> for an existing one; --plugin-dir <harness> so every thread loads Vyre.

import { spawnSession, killGroup } from "../sessions/spawn.js";
import { vyreMcpConfig } from "../../lib/mcp-config.js";

/**
 * The command line for a headless session. `system` is the composed system prompt (ADR 0030):
 * appended to Claude Code's own, or replacing it; without it, `append` is appended as before.
 * `tools: "none"` is `--tools ""` (no built-in tools). Every session is `--strict-mcp-config` with Vyre's own server only (vyreMcpConfig). `settings: false` is `--setting-sources ""`: none of the user's settings,
 * hooks or CLAUDE.md files. Not `--bare`, which also skips keychain reads, and with them a
 * subscription's login.
 * `plugins` are more plugin folders after the Harness (`plugin`): learned skills, or a job's own.
 * @param {{ id: string, native?: string|null, resume?: boolean, forkFrom?: string|null, resumeAt?: string|null, mode?: string|null, plugin?: string|null, plugins?: string[], model?: string|null, name?: string|null,
 *           append?: string|null, system?: { mode: "append"|"replace", text: string }|null, budgetUsd?: number|null, tools?: "none"|null, settings?: boolean, skippable?: boolean, effort?: string|null, ephemeral?: boolean }} o
 */
export function argsFor(o) {
  const a = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--permission-prompts", "host", "--permission-prompt-tool", "stdio"];
  // A fork continues another session's conversation as a new one, with the id given here.
  // native: the session id this thread's Claude runs under now, when a rollover gave it a fresh one (a session id names one transcript); else the thread's own id.
  const sid = o.native || o.id;
  a.push(...(o.forkFrom ? ["--resume", o.forkFrom, "--fork-session", "--session-id", o.id] : o.resume ? ["--resume", sid] : ["--session-id", sid]));
  // A rewind: resume only up to this entry, as Claude Code's double Esc does (the flag the SDK passes).
  if (o.resumeAt && (o.resume || o.forkFrom)) a.push("--resume-session-at", o.resumeAt);
  for (const dir of [o.plugin, ...(o.plugins || [])]) if (dir) a.push("--plugin-dir", dir);
  if (o.tools === "none") a.push("--tools", "");
  // Only Vyre's own MCP server, never what the account or the machine adds: a logged-in Claude loads its claude.ai connectors (Gmail, Drive, Docs, Slack...) into every
  // session, and those act as the person outside Vyre's Gate. --strict-mcp-config ignores every other source (the account's connectors, user and project servers,
  // other plugins' servers), and the plugin's own .mcp.json with them, so Vyre's server is named here.
  a.push("--strict-mcp-config", "--mcp-config", JSON.stringify(vyreMcpConfig(o.plugin)));
  if (o.settings === false) a.push("--setting-sources", "");
  if (o.model) a.push("--model", o.model);
  if (o.effort) a.push("--effort", o.effort);
  if (o.ephemeral) a.push("--no-session-persistence");
  // "Doesn't ask" can be switched on later only if the launch allows it: with Vyre's plugin only.
  if (o.skippable) a.push("--allow-dangerously-skip-permissions");
  if (o.mode) a.push("--permission-mode", o.mode);
  if (o.name && !o.resume) a.push("-n", o.name);
  if (o.system && o.system.text) a.push(o.system.mode === "replace" ? "--system-prompt" : "--append-system-prompt", o.system.text);
  else if (o.append) a.push("--append-system-prompt", o.append);
  if (typeof o.budgetUsd === "number" && o.budgetUsd > 0) a.push("--max-budget-usd", o.budgetUsd.toFixed(2));
  return a;
}

/**
 * A user turn, as stream-json input. `uuid` is the message's own id (the transcript line's, and
 * the key Claude Code echoes back); `priority: "next"` steers it into a running turn at the next
 * step, as a message typed while Claude Code works does.
 * @param {string} text @param {string} session @param {{ uuid?: string, priority?: "next"|"now"|"later", images?: { media_type: string, data: string }[] }} [o]
 */
export const userLine = (text, session, o = {}) => ({ type: "user", parent_tool_use_id: null, session_id: session,
  // Pasted images go first, as image blocks, then the words.
  message: { role: "user", content: o.images && o.images.length
    ? [...o.images.map(i => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })), { type: "text", text: String(text) }]
    : String(text) },
  ...(o.uuid ? { uuid: o.uuid } : {}), ...(o.priority ? { priority: o.priority } : {}) });

/**
 * The answer to a can_use_tool request, as the Agent SDK sends it. Allowing passes the input back
 * unchanged; a question's answers go back inside it (`updatedInput.answers`, keyed by question
 * text); "always" also hands back Claude Code's own permission suggestions, so it stops asking.
 * @param {string} requestId @param {"allow"|"deny"|"always"} decision @param {any} input @param {string} [message]
 * @param {{ answers?: Record<string, string>, permissions?: any[]|null }} [extra]
 */
export function answerLine(requestId, decision, input, message, extra = {}) {
  const updatedInput = extra.answers ? { ...(input || {}), answers: extra.answers } : input || {};
  const response = decision === "deny"
    ? { behavior: "deny", message: message || "The user declined this." }
    : { behavior: "allow", updatedInput, ...(decision === "always" && extra.permissions ? { updatedPermissions: extra.permissions } : {}) };
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
}

/**
 * Start one session. Calls onMessage for every parsed stdout line and onExit once.
 * @param {{ bin: string, args: string[], cwd: string, env: Record<string, string|undefined>, subreaper?: string|null, uid?: number, gid?: number,
 *           onSpawn?: (g: { pid: number, pgid: number, sid: number }) => void,
 *           onMessage: (m: any) => void, onExit: (code: number|null, signal: string|null, stderr: string) => void }} o
 */
export function run(o) {
  // Its own group and session, under the subreaper where there is one (core/sessions/spawn.js).
  const child = spawnSession(o.bin, o.args, { cwd: o.cwd, env: o.env, subreaper: o.subreaper, uid: o.uid, gid: o.gid, account: o.account, onSpawn: o.onSpawn, sandboxSpawn: /** @type {any} */ (o).sandboxSpawn, lentSpawn: /** @type {any} */ (o).lentSpawn });
  let buf = "", err = "", exited = false, n = 0;
  /** @type {Map<string, { resolve: (r: any) => void, reject: (e: Error) => void }>} control requests Vyre sent, waiting for their answer */
  const asked = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }       // a stray non-JSON line is not a session event
      // The answer to a control request Vyre sent (control()) goes back to it, not to the session.
      if (m && m.type === "control_response" && m.response && asked.has(m.response.request_id)) {
        const a = asked.get(m.response.request_id); asked.delete(m.response.request_id);
        if (m.response.subtype === "error") a.reject(new Error(String(m.response.error || "Claude Code refused it"))); else a.resolve(m.response.response || {});
        continue;
      }
      try { o.onMessage(m); } catch {}
    }
  });
  // Only the tail is kept: enough to say why a session died, never a growing buffer.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", c => { err = (err + c).slice(-2000); });
  // A write after the child died raises EPIPE on stdin; it is reported through onExit instead.
  child.stdin.on("error", () => {});
  const done = (code, signal) => { if (exited) return; exited = true; o.onExit(code, signal, err, /** @type {any} */ (child).moved); };
  child.on("exit", done);
  child.on("error", e => { err = e.message; done(null, null); });

  // Claude Code's SDK opens every session with an initialize request; answering permission
  // questions over stdio expects the same handshake.
  const write = obj => { if (!exited && child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n"); return !exited; };
  write({ type: "control_request", request_id: "vyre-init", request: { subtype: "initialize" } });

  return {
    // A getter: through the box's spawner the pid is known a moment after the call.
    get pid() { return child.pid; },
    write,
    get alive() { return !exited; },
    /**
     * A control request (set_model, rewind_files, stop_task and the like), answered by Claude Code.
     * @param {string} subtype @param {Record<string, any>} [fields]
     */
    control(subtype, fields = {}) {
      if (exited) return Promise.reject(new Error("the session has ended"));
      const rid = `vyre-ctl-${++n}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (asked.delete(rid)) reject(new Error(`Claude Code did not answer ${subtype}`)); }, 15_000);
        asked.set(rid, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
        write({ type: "control_request", request_id: rid, request: { subtype, ...fields } });
      });
    },
    /** Stop the current turn (as Escape does); the session stays. */
    interrupt() { write({ type: "control_request", request_id: `vyre-int-${Date.now()}`, request: { subtype: "interrupt" } }); return Promise.resolve(); },
    /**
     * End it: close stdin (Claude Code finishes and exits), then TERM, then KILL, then let go
     * regardless. SIGKILL cannot be ignored by the child itself, but killGroup's -pid targets a
     * process GROUP the child is only in when `detached` truly took (core/sessions/spawn.js) -
     * a grandchild that ended up outside it (or a kill that missed for any other reason) would
     * leave this waiting on an "exit" that never comes. Past `grace` plus one more beat, stop
     * waiting and destroy our own pipes to the child: whatever the OS process is doing, vyred's
     * own event loop must never hang on it (registry.stop()'s MODULE_STOP_MS races each module
     * the same way; this is the one open-ended await underneath that race - settings.test.js
     * hang, fcce3d4a). Seen as a real, non-deterministic hang on GitHub's Node 24 runners only
     * (3 of 4 recent runs), never reproduced on testbox; this is the fix either way, since an
     * unbounded await on a child's exit is wrong regardless of why it stalls.
     */
    stop(grace = 3000) {
      return new Promise(resolve => {
        if (exited) return resolve(undefined);
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(term); clearTimeout(kill); clearTimeout(giveUp);
          // Release Node's own handles on the child's stdio: an open pipe keeps this process
          // alive even after we've stopped waiting for the OS process to actually go.
          try { child.stdout?.destroy(); } catch {}
          try { child.stderr?.destroy(); } catch {}
          try { child.stdin?.destroy(); } catch {}
          resolve(undefined);
        };
        child.once("exit", finish);
        try { child.stdin.end(); } catch {}
        const term = setTimeout(() => killGroup(child, "SIGTERM"), Math.min(500, grace));
        const kill = setTimeout(() => killGroup(child, "SIGKILL"), grace);
        const giveUp = setTimeout(finish, grace + 2000);
      });
    },
  };
}
