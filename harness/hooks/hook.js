#!/usr/bin/env node
// @ts-check
// Every Harness hook, in one file: `node hook.js <piece>`. It reads the hook's JSON from stdin,
// asks vyred, and prints Claude Code's answer. No logic lives here (see core/harness).
//
// When vyred is not running, every piece prints nothing and exits 0, so Claude Code behaves
// exactly as without Vyre, with two exceptions: the security floor, and the lessons the user
// accepted. Both are pure and local, so they still run in-process when vyred is down (the
// lessons from the snapshot Learning keeps in the home, or read-only from vyre.db when that file
// is gone). Neither is switched off by stopping a daemon.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { call } from "../../core/daemon/client.js";
import { rules } from "../../core/harness/rules.js";
import { interactiveFrom } from "../../core/harness/index.js";
import { reply } from "../../core/learn/checks.js";
import { offlineTool, offlineTouched, offlineStop } from "../../core/learn/offline.js";
import { home, paths } from "../../core/config/index.js";
import { writeKey } from "../../core/switchboard/sessions.js";
import { knows, hookIn, hookOut } from "../../core/sessions/drivers/claude/hooks.js";

const piece = String(process.argv[2]);

async function stdin() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/**
 * Did a person type this prompt? Claude Code runs this hook as a child of its claude process
 * (the pid threads.bind records at SessionStart), so look at that process once: an interactive
 * one has a terminal and no -p, --print, --output-format or --input-format. Our own headless
 * threads (VYRE_THREAD is this session) and agents' threads (VYRE_AGENT) never are. ps is given
 * 500 ms; anything that fails means no.
 * @param {string|undefined} session
 * @returns {Promise<boolean>}
 */
function typedByPerson(session) {
  if (process.env.VYRE_AGENT) return Promise.resolve(false);
  if (process.env.VYRE_THREAD && process.env.VYRE_THREAD === session) return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      execFile("ps", ["-o", "tty=,args=", "-p", String(process.ppid)], { timeout: 500 }, (err, out) => resolve(!err && interactiveFrom(String(out))));
    } catch { resolve(false); }
  });
}

/**
 * Who the user is, as core/about last wrote it: read from the file, not asked of vyred, so it
 * costs a millisecond and holds when vyred is down. A person's own session and the assistant's
 * get it; an agent scoped to some projects does not, since it names projects outside its scope.
 */
function about() {
  if (process.env.VYRE_AGENT && process.env.VYRE_AGENT_KIND !== "assistant") return "";
  try { return fs.readFileSync(path.join(home(), "about.md"), "utf8").slice(0, 1000).trim(); } catch { return ""; }
}

/** What the provider's hook protocol wants printed (core/sessions/drivers/claude/hooks.js), or nothing. @param {string} kind @param {Record<string, any>} d */
const say = (kind, d) => { const o = hookOut(kind, d); if (o) process.stdout.write(o); };

async function main() {
  if (!knows(piece)) return;
  const h = hookIn(await stdin());
  // prompt_id names the turn; VYRE_AGENT, set by the Switchboard, names the agent a lesson may be scoped to.
  const base = { cwd: h.cwd, session: h.session, prompt_id: h.turn, agent: process.env.VYRE_AGENT || undefined };
  // An agent's thread carries its projects (set by the switchboard); the brief and Enrich stay inside them.
  const scope = process.env.VYRE_PROJECTS ? { projects: process.env.VYRE_PROJECTS } : {};
  // Inside an agent's thread the hooks say which agent they are, and the client sends the thread's
  // key with it (VYRE_AGENT_KEY), so vyred can tell that claim from a made-up one.
  const opts = { caller: base.agent ? `harness:agent:${base.agent}` : "harness", timeout: 3000 };
  const down = r => r.error && ["unreachable", "timeout"].includes(r.error.code);
  const offline = { root: home(), session: h.session, prompt_id: h.turn, agent: base.agent, cwd: h.cwd };
  // Where Claude Code loaded the Harness from: its hooks are the ones Learning guards.
  const plugin_root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  if (piece === "brief") {
    const project = process.env.VYRE_PROJECT || undefined;
    // Inside our own headless child VYRE_THREAD is its session id; anything else (a terminal
    // resume of the same id) may be a second writer, which harness.brief warns about.
    const headless = Boolean(process.env.VYRE_THREAD) && process.env.VYRE_THREAD === h.session;
    const r = await call("harness.brief", { ...base, ...scope, source: h.source, headless, ...(project ? { project } : {}) }, opts);
    const context = [about(), r.data && r.data.text].filter(Boolean).join("\n\n");
    say("brief", { context });
    // Bind this session to its claude process (this hook's parent, as the MCP server's is), so the
    // MCP server can say which session its calls come from. Every SessionStart: /clear changes the id.
    if (h.session && !down(r)) {
      const pid = process.ppid;
      const b = await call("threads.bind", { session: h.session, pid }, opts);
      // The pid vyred bound: claude's, which is this hook's parent, or its parent when /bin/sh forked.
      if (b.data && b.data.key) try { writeKey(paths(home()).sessions, Number(b.data.pid) || pid, b.data); } catch {}
    }
  } else if (piece === "enrich") {
    const prompt = h.prompt;
    // Only a plain yes or no can answer a lesson, so only then is ps worth running (about 10 ms).
    const interactive = reply(prompt) ? await typedByPerson(h.session) : false;
    const r = await call("harness.enrich", { ...base, ...scope, prompt, interactive, ...(h.transcript ? { transcript: h.transcript } : {}) }, opts);
    // The window warning (core/harness/meter.js) is the person's to read, once: a systemMessage beside the context Claude gets.
    const notice = r.data && typeof r.data.notice === "string" ? r.data.notice : "";
    const text = r.data && r.data.text ? r.data.text : "";
    say("enrich", { context: text, notice });
  } else if (piece === "rules") {
    const input = { ...base, tool_name: h.tool.name, tool_input: h.tool.input, ...(h.tool.id ? { tool_use_id: h.tool.id } : {}), plugin_root };
    const r = await call("harness.rules", input, opts);
    // "denied": vyred's registry runs the floor on every call's input, so a call that reaches into
    // the vault (the path is in tool_input) is refused before harness.rules looks. The floor here
    // then decides, as it does when vyred is down.
    let v = r.data || (r.error && ["unreachable", "timeout", "no_such_tool", "denied"].includes(r.error.code)
      ? rules({ tool: input.tool_name, input: input.tool_input, cwd: h.cwd, agent: process.env.VYRE_AGENT || null }) : null);
    if (down(r) && v && !v.decision) v = offlineTool({ ...offline, tool: input.tool_name, input: input.tool_input, pluginRoot: plugin_root });
    if (v && v.decision) say("rules", { decision: v.decision, reason: v.reason });
  } else if (piece === "learn") {
    const r = await call("harness.learn", { ...base, tool_name: h.tool.name, tool_input: h.tool.input,
      ...(h.tool.id ? { tool_use_id: h.tool.id } : {}) }, opts);
    if (down(r)) offlineTouched({ ...offline, tool: h.tool.name, input: h.tool.input });
  } else if (piece === "fail") {
    // PostToolUseFailure (Claude Code 2.1.283 sends tool_name, tool_input, tool_use_id, error,
    // is_interrupt). Read tolerantly: a field a later release drops is simply absent. Only the
    // head of the error goes to vyred. With vyred down, nothing: a failure changes no file.
    await call("harness.learn", { ...base, tool_name: h.tool.name, tool_input: h.tool.input, ok: false,
      ...(h.tool.id ? { tool_use_id: h.tool.id } : {}),
      ...(h.error ? { error_head: h.error.slice(0, 200) } : {}), ...(h.interrupted ? { interrupted: true } : {}) }, opts);
  } else if (piece === "end") {
    // SessionEnd (clear, logout, exit): the Project hub closes this session's summary. Said once, never blocks, says nothing to Claude.
    await call("harness.end", { ...base, ...(h.reason ? { reason: h.reason.slice(0, 40) } : {}) }, opts);
  } else if (piece === "stop") {
    const text = h.lastText;
    // Our own headless child (VYRE_THREAD is its session id) has no one to decline a call.
    const headless = Boolean(process.env.VYRE_THREAD) && process.env.VYRE_THREAD === h.session;
    const r = await call("harness.stop", { ...base, text, stop_hook_active: h.stopActive, ...(headless ? { headless: true } : {}) }, opts);
    const d = down(r) ? offlineStop({ ...offline, text, stop_hook_active: h.stopActive }) : r.data;
    // Stop's answer is top level, not hookSpecificOutput. The reason goes to Claude, which continues.
    if (d && d.decision === "block") say("stop", { decision: "block", reason: d.reason });
  }
}

main().catch(() => {}).finally(() => { process.exitCode = 0; });
