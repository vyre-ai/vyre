// @ts-check
// runner — one headless Claude Code process, and nothing else.
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

import { spawn } from "node:child_process";

/**
 * The command line for a headless session.
 * `tools: "none"` is `--tools ""` (no built-in tools) and `--strict-mcp-config` with no config
 * (no MCP servers). `settings: false` is `--setting-sources ""`: none of the user's settings,
 * hooks or CLAUDE.md files. Not `--bare`, which also skips keychain reads, and with them a
 * subscription's login.
 * @param {{ id: string, resume?: boolean, plugin?: string|null, model?: string|null, name?: string|null,
 *           append?: string|null, budgetUsd?: number|null, tools?: "none"|null, settings?: boolean }} o
 */
export function argsFor(o) {
  const a = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--permission-prompts", "host", "--permission-prompt-tool", "stdio"];
  a.push(...(o.resume ? ["--resume", o.id] : ["--session-id", o.id]));
  if (o.plugin) a.push("--plugin-dir", o.plugin);
  if (o.tools === "none") a.push("--tools", "", "--strict-mcp-config");
  if (o.settings === false) a.push("--setting-sources", "");
  if (o.model) a.push("--model", o.model);
  if (o.name && !o.resume) a.push("-n", o.name);
  if (o.append) a.push("--append-system-prompt", o.append);
  if (typeof o.budgetUsd === "number" && o.budgetUsd > 0) a.push("--max-budget-usd", o.budgetUsd.toFixed(2));
  return a;
}

/** A user turn, as stream-json input. */
export const userLine = (text, session) => ({ type: "user", message: { role: "user", content: String(text) }, parent_tool_use_id: null, session_id: session });

/** The answer to a can_use_tool request. Allowing passes the input back unchanged. */
export function answerLine(requestId, decision, input, message) {
  const response = decision === "allow"
    ? { behavior: "allow", updatedInput: input || {} }
    : { behavior: "deny", message: message || "The user declined this." };
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
}

/**
 * Start one session. Calls onMessage for every parsed stdout line and onExit once.
 * @param {{ bin: string, args: string[], cwd: string, env: Record<string, string|undefined>,
 *           onMessage: (m: any) => void, onExit: (code: number|null, signal: string|null, stderr: string) => void }} o
 */
export function run(o) {
  const child = spawn(o.bin, o.args, { cwd: o.cwd, env: /** @type {any} */ (o.env), stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", err = "", exited = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }       // a stray non-JSON line is not a session event
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
    /** End it: close stdin (Claude Code finishes and exits), then TERM, then KILL. */
    stop(grace = 3000) {
      return new Promise(resolve => {
        if (exited) return resolve(undefined);
        child.once("exit", () => resolve(undefined));
        try { child.stdin.end(); } catch {}
        const term = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, Math.min(500, grace));
        const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, grace);
        child.once("exit", () => { clearTimeout(term); clearTimeout(kill); });
      });
    },
  };
}
