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

/**
 * The command line for a headless session. `system` is the composed system prompt (ADR 0030):
 * appended to Claude Code's own, or replacing it; without it, `append` is appended as before.
 * `tools: "none"` is `--tools ""` (no built-in tools) and `--strict-mcp-config` with no config
 * (no MCP servers). `settings: false` is `--setting-sources ""`: none of the user's settings,
 * hooks or CLAUDE.md files. Not `--bare`, which also skips keychain reads, and with them a
 * subscription's login.
 * `plugins` are more plugin folders after the Harness (`plugin`): learned skills, or a job's own.
 * @param {{ id: string, resume?: boolean, forkFrom?: string|null, resumeAt?: string|null, plugin?: string|null, plugins?: string[], model?: string|null, name?: string|null,
 *           append?: string|null, system?: { mode: "append"|"replace", text: string }|null, budgetUsd?: number|null, tools?: "none"|null, settings?: boolean }} o
 */
export function argsFor(o) {
  const a = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--permission-prompts", "host", "--permission-prompt-tool", "stdio"];
  // A fork continues another session's conversation as a new one, with the id given here.
  a.push(...(o.forkFrom ? ["--resume", o.forkFrom, "--fork-session", "--session-id", o.id] : o.resume ? ["--resume", o.id] : ["--session-id", o.id]));
  // A rewind: resume only up to this entry, as Claude Code's double Esc does (the flag the SDK passes).
  if (o.resumeAt && (o.resume || o.forkFrom)) a.push("--resume-session-at", o.resumeAt);
  for (const dir of [o.plugin, ...(o.plugins || [])]) if (dir) a.push("--plugin-dir", dir);
  if (o.tools === "none") a.push("--tools", "", "--strict-mcp-config");
  if (o.settings === false) a.push("--setting-sources", "");
  if (o.model) a.push("--model", o.model);
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
 * @param {string} text @param {string} session @param {{ uuid?: string, priority?: "next"|"now"|"later" }} [o]
 */
export const userLine = (text, session, o = {}) => ({ type: "user", message: { role: "user", content: String(text) }, parent_tool_use_id: null, session_id: session,
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
  const child = spawnSession(o.bin, o.args, { cwd: o.cwd, env: o.env, subreaper: o.subreaper, uid: o.uid, gid: o.gid, onSpawn: o.onSpawn });
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
  const done = (code, signal) => { if (exited) return; exited = true; o.onExit(code, signal, err); };
  child.on("exit", done);
  child.on("error", e => { err = e.message; done(null, null); });

  // Claude Code's SDK opens every session with an initialize request; answering permission
  // questions over stdio expects the same handshake.
  const write = obj => { if (!exited && child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n"); return !exited; };
  write({ type: "control_request", request_id: "vyre-init", request: { subtype: "initialize" } });

  return {
    pid: child.pid,
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
        asked.set(rid, { resolve, reject });
        write({ type: "control_request", request_id: rid, request: { subtype, ...fields } });
        setTimeout(() => { if (asked.delete(rid)) reject(new Error(`Claude Code did not answer ${subtype}`)); }, 15_000).unref?.();
      });
    },
    /** Stop the current turn (as Escape does); the session stays. */
    interrupt() { write({ type: "control_request", request_id: `vyre-int-${Date.now()}`, request: { subtype: "interrupt" } }); return Promise.resolve(); },
    /** End it: close stdin (Claude Code finishes and exits), then TERM, then KILL. */
    stop(grace = 3000) {
      return new Promise(resolve => {
        if (exited) return resolve(undefined);
        child.once("exit", () => resolve(undefined));
        try { child.stdin.end(); } catch {}
        const term = setTimeout(() => killGroup(child, "SIGTERM"), Math.min(500, grace));
        const kill = setTimeout(() => killGroup(child, "SIGKILL"), grace);
        child.once("exit", () => { clearTimeout(term); clearTimeout(kill); });
      });
    },
  };
}
