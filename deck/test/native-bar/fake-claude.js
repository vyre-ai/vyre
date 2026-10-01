#!/usr/bin/env node
// @ts-check
// The native bar's fake claude: speaks `claude -p --input-format stream-json --output-format
// stream-json` the way core/switchboard/testing/fake-claude.js does, but standalone (it runs
// against any Vyre tree) and with one extra prompt:
//
//   "burst <seed>"  streams burstText(seed) as content_block_delta lines on burstPlan's schedule
//                   (50 ms batches of 20 to 400 characters, short stalls), then the whole message,
//                   then three tool calls with their results, then the result line. The
//                   Switchboard coalesces deltas every 50 ms, so the Deck gets thread.text the way
//                   the box sends it.
//   anything else   echoes the prompt back in a few deltas.
//
// FAKE_BAR_LOG, when set, gets one JSON line per burst: the epoch ms of the first and last
// stream_event written, so the harness can time box to screen. FAKE_CLAUDE_TRANSCRIPTS, when set,
// gets each turn as a Claude Code transcript, so the Deck's rich re-read has something to read.
// `--version` answers like Claude Code. Never the real claude. A test helper, not part of the product.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { burstText, burstPlan } from "./stats.js";

if (process.argv.includes("--version")) { process.stdout.write("2.1.283 (Claude Code)\n"); process.exit(0); }

const argv = process.argv.slice(2);
const flag = (/** @type {string} */ n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const session = flag("--session-id") || flag("--resume") || "no-session";
const MODEL = flag("--model") || "fake-model";
const out = (/** @type {any} */ o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
let n = 0;
let interrupted = false;

const TX = process.env.FAKE_CLAUDE_TRANSCRIPTS;
/** @type {string|null} */ let parent = null;
function tx(/** @type {string} */ type, /** @type {any} */ message, extra = {}) {
  if (!TX) return;
  const cwd = process.cwd();
  const dir = path.join(TX, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const uuid = crypto.randomUUID();
  fs.appendFileSync(path.join(dir, `${session}.jsonl`), JSON.stringify({ parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId: session,
    version: "2.1.283", gitBranch: "", entrypoint: "sdk-cli", type, message, uuid, timestamp: new Date().toISOString(), ...extra }) + "\n");
  parent = uuid;
}
const txAssistant = (/** @type {string} */ id, /** @type {any} */ block, stop = /** @type {string|null} */ (null)) => tx("assistant", { id, type: "message", role: "assistant", model: MODEL,
  content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 12, cache_creation_input_tokens: 40, cache_read_input_tokens: 2400, output_tokens: 20 } }, { requestId: `req_${id}` });
const ev = (/** @type {any} */ event) => out({ type: "stream_event", event, session_id: session, parent_tool_use_id: null });

/** Stream `pieces` ([{wait, text}]) as one message; returns the epoch of the first and last delta. */
async function stream(/** @type {{ wait: number, text: string }[]} */ pieces) {
  const id = `msg_${++n}`;
  ev({ type: "message_start", message: { id, role: "assistant", content: [] } });
  let first = 0, last = 0, text = "";
  for (const p of pieces) {
    if (p.wait) await sleep(p.wait);
    if (interrupted) break;
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p.text } });
    last = Date.now(); if (!first) first = last;
    text += p.text;
  }
  txAssistant(id, { type: "text", text }, "end_turn");
  out({ type: "assistant", message: { id, role: "assistant", model: MODEL, content: [{ type: "text", text }] }, session_id: session, parent_tool_use_id: null });
  return { first, last, text };
}

async function tool(/** @type {string} */ name, /** @type {any} */ input, /** @type {string} */ content) {
  const id = `msg_${++n}`, tu = `toolu_${++n}_${crypto.randomBytes(3).toString("hex")}`;
  const block = { type: "tool_use", id: tu, name, input };
  txAssistant(id, block, "tool_use");
  out({ type: "assistant", message: { id, role: "assistant", model: MODEL, content: [block] }, session_id: session, parent_tool_use_id: null });
  await sleep(120);
  const res = { tool_use_id: tu, type: "tool_result", content, is_error: false };
  tx("user", { role: "user", content: [res] }, { toolUseResult: content });
  out({ type: "user", message: { role: "user", content: [res] }, session_id: session, parent_tool_use_id: null });
  await sleep(40);
}

const result = (/** @type {string} */ text, ok = true) => out({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: text,
  total_cost_usd: 0.001, duration_ms: 5, num_turns: 1, stop_reason: interrupted ? "interrupted" : "end_turn", session_id: session,
  usage: { input_tokens: 10, output_tokens: text.length, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } });

async function turn(/** @type {any} */ prompt) {
  const p = String(prompt).trim();
  interrupted = false;
  tx("user", { role: "user", content: String(prompt) });
  const m = /^burst (\d+)/i.exec(p);
  if (m) {
    const seed = Number(m[1]);
    const marker = `[bar-${seed}]`;
    const text = burstText(seed, marker);
    const s = await stream(burstPlan(text, seed));
    if (process.env.FAKE_BAR_LOG) fs.appendFileSync(process.env.FAKE_BAR_LOG, JSON.stringify({ seed, session, first: s.first, last: s.last, chars: s.text.length }) + "\n");
    if (!interrupted) {
      await tool("Read", { file_path: path.join(process.cwd(), `menu-${seed}.md`) }, "     1→# Northwind Bakery menu");
      await tool("Bash", { command: `npm test -- bar-${seed}`, description: "Run the menu tests" }, "# tests 2\n# pass 2\n# fail 0");
      await tool("Grep", { pattern: `tart-${seed}`, path: process.cwd() }, "menu.md:7");
    }
    return result(s.text, !interrupted);
  }
  const s = await stream((`echo: ${p}`.match(/.{1,6}/gs) || []).map((t, i) => ({ wait: i ? 2 : 0, text: t })));
  return result(s.text);
}

out({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", output: "" });
let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === "control_request" && m.request?.subtype === "initialize") {
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    out({ type: "system", subtype: "init", session_id: session, cwd: process.cwd(), model: MODEL, tools: ["Read", "Bash", "Grep"] });
    return;
  }
  if (m.type === "control_request" && m.request?.subtype === "interrupt") {
    interrupted = true;
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    return;
  }
  if (m.type === "user") { const text = m.message.content; queue = queue.then(() => turn(text)); }
}).on("close", () => { queue.then(() => process.exit(0)); });
