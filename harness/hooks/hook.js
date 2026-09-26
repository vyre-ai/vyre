#!/usr/bin/env node
// @ts-check
// Every Harness hook, in one file: `node hook.js <piece>`. It reads the hook's JSON from stdin,
// asks vyred, and prints Claude Code's answer. No logic lives here (see core/harness).
//
// When vyred is not running, every piece prints nothing and exits 0, so Claude Code behaves
// exactly as without Vyre, with one exception: the security floor. The rules are pure and
// local, so they still run in-process when vyred is down. The floor cannot be switched off by
// stopping a daemon.

import { call } from "../../core/daemon/client.js";
import { rules } from "../../core/harness/rules.js";

const EVENT = { brief: "SessionStart", enrich: "UserPromptSubmit", rules: "PreToolUse", learn: "PostToolUse", stop: "Stop" };
const piece = /** @type {keyof typeof EVENT} */ (process.argv[2]);

async function stdin() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/** @param {string} hookEventName @param {Record<string, any>} fields */
const answer = (hookEventName, fields) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, ...fields } }));

async function main() {
  if (!(piece in EVENT)) return;
  const h = await stdin();
  // prompt_id names the turn; VYRE_AGENT, set by the Switchboard, names the agent a lesson may be scoped to.
  const base = { cwd: h.cwd, session: h.session_id, prompt_id: h.prompt_id, agent: process.env.VYRE_AGENT || undefined };
  // An agent's thread carries its projects (set by the switchboard); the brief and Enrich stay inside them.
  const scope = process.env.VYRE_PROJECTS ? { projects: process.env.VYRE_PROJECTS } : {};
  const opts = { caller: "harness", timeout: 3000 };

  if (piece === "brief") {
    const project = process.env.VYRE_PROJECT || undefined;
    const r = await call("harness.brief", { ...base, ...scope, source: h.source, ...(project ? { project } : {}) }, opts);
    if (r.data && r.data.text) answer(EVENT.brief, { additionalContext: r.data.text });
  } else if (piece === "enrich") {
    const r = await call("harness.enrich", { ...base, ...scope, prompt: String(h.prompt || "") }, opts);
    if (r.data && r.data.text) answer(EVENT.enrich, { additionalContext: r.data.text });
  } else if (piece === "rules") {
    const input = { ...base, tool_name: String(h.tool_name || ""), tool_input: h.tool_input || {} };
    const r = await call("harness.rules", input, opts);
    const v = r.data || (r.error && ["unreachable", "timeout", "no_such_tool"].includes(r.error.code)
      ? rules({ tool: input.tool_name, input: input.tool_input, cwd: h.cwd }) : null);
    if (v && v.decision) answer(EVENT.rules, { permissionDecision: v.decision, permissionDecisionReason: v.reason || "Vyre security floor" });
  } else if (piece === "learn") {
    await call("harness.learn", { ...base, tool_name: String(h.tool_name || ""), tool_input: h.tool_input || {} }, opts);
  } else if (piece === "stop") {
    const text = typeof h.last_assistant_message === "string" ? h.last_assistant_message : undefined;
    const r = await call("harness.stop", { ...base, text, stop_hook_active: Boolean(h.stop_hook_active) }, opts);
    // Stop's answer is top level, not hookSpecificOutput. The reason goes to Claude, which continues.
    if (r.data && r.data.decision === "block") process.stdout.write(JSON.stringify({ decision: "block", reason: r.data.reason }));
  }
}

main().catch(() => {}).finally(() => { process.exitCode = 0; });
