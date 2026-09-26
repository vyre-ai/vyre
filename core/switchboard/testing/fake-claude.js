#!/usr/bin/env node
// @ts-check
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for tests.
//
// It speaks the lines a real Claude Code 2.1.283 printed when probed (system init, stream_event
// deltas, whole assistant messages, can_use_tool control requests, a result per turn) and
// nothing more. What it does depends on the prompt:
//   "write <file>"  asks permission for Write, then writes the file only if allowed
//   "limit"         on a setup token, fails as a subscription at its limit would
//   "whoami"        says which credential it was given (never the value)
//   "vyre <tool> <json>"  calls a vyred tool the way the MCP server does inside this thread
//                   (caller mcp:agent:<VYRE_AGENT>, or mcp), and says the JSON it got back
//   anything else   echoes the prompt back in a few deltas
// FAKE_CLAUDE_LOG, when set, gets one line per launch with argv and credential kind.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const session = flag("--session-id") || flag("--resume") || "no-session";
const auth = process.env.CLAUDE_CODE_OAUTH_TOKEN ? "subscription" : process.env.ANTHROPIC_API_KEY ? "api-key" : "ambient";
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, auth, cwd: process.cwd(), agent: process.env.VYRE_AGENT || null, projects: process.env.VYRE_PROJECTS || null }) + "\n");

const out = o => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0;
/** @type {Map<string, (r: any) => void>} */
const waiting = new Map();

out({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", output: "whatever the user's own hooks print" });

async function say(text) {
  const id = `msg_${++n}`;
  out({ type: "stream_event", event: { type: "message_start", message: { id, role: "assistant", content: [] } }, session_id: session, parent_tool_use_id: null });
  for (const piece of text.match(/.{1,6}/gs) || []) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }, session_id: session, parent_tool_use_id: null });
    await sleep(2);
  }
  out({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] }, session_id: session, parent_tool_use_id: null });
}

const result = (ok, text, cost = 0.001) => out({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: text,
  total_cost_usd: cost, duration_ms: 5, num_turns: 1, stop_reason: "end_turn", session_id: session });

async function turn(prompt) {
  const p = String(prompt).trim();
  if (/^write /i.test(p)) {
    const file = path.resolve(p.slice(6).trim());
    const tu = `toolu_${++n}`;
    out({ type: "assistant", message: { id: `msg_${++n}`, role: "assistant", content: [{ type: "tool_use", id: tu, name: "Write", input: { file_path: file, content: "hi" } }] }, session_id: session, parent_tool_use_id: null });
    const rid = `req-${n}`;
    const answer = new Promise(r => waiting.set(rid, r));
    out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: file, content: "hi" }, tool_use_id: tu } });
    const r = await answer;
    const allowed = r.behavior === "allow";
    if (allowed) fs.writeFileSync(file, "hi");
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tu, is_error: !allowed, content: allowed ? "written" : "denied" }] }, session_id: session, parent_tool_use_id: null });
    await say(allowed ? "Wrote it." : "I was not allowed to.");
    return result(true, allowed ? "Wrote it." : "I was not allowed to.");
  }
  if (/^limit$/i.test(p) && auth === "subscription") {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } });
    return result(false, "Claude usage limit reached.", 0);
  }
  const tool = /^vyre (\S+)\s*(.*)$/s.exec(p);
  if (tool) {
    const { call } = await import("../../daemon/client.js");
    const caller = process.env.VYRE_AGENT ? `mcp:agent:${process.env.VYRE_AGENT}` : "mcp";
    const r = JSON.stringify(await call(tool[1], tool[2] ? JSON.parse(tool[2]) : {}, { root: process.env.VYRE_HOME, caller }));
    await say(r);
    return result(true, r);
  }
  if (/^whoami$/i.test(p)) { await say(`auth=${auth}`); return result(true, `auth=${auth}`, auth === "api-key" ? 0.25 : 0); }
  await say(`echo: ${p}`);
  return result(true, `echo: ${p}`);
}

let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === "control_request" && m.request?.subtype === "initialize") {
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    out({ type: "system", subtype: "init", session_id: session, cwd: process.cwd(), model: flag("--model") || "fake-model", tools: ["Write"] });
    return;
  }
  if (m.type === "control_response") { const w = waiting.get(m.response.request_id); if (w) { waiting.delete(m.response.request_id); w(m.response.response); } return; }
  if (m.type === "user") { const text = m.message.content; queue = queue.then(() => turn(text)); }
}).on("close", () => { queue.then(() => process.exit(0)); });
