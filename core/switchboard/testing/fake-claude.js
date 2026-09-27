#!/usr/bin/env node
// @ts-check
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for tests.
//
// It speaks the lines a real Claude Code 2.1.283 printed when probed (system init, stream_event
// deltas, whole assistant messages, can_use_tool control requests, a result per turn) and
// nothing more. What it does depends on the prompt:
//   "write <file>"  asks permission for Write (offering "always"), then writes the file only if allowed
//   "bash <command>" asks permission for Bash with that command, and runs nothing
//   "ask"           asks an AskUserQuestion (a single-select with previews, then a multi-select)
//                   and says back the answers it got
//   "demo"          a rich turn: thinking, Read, an Edit and a Bash each behind a permission ask,
//                   a TodoWrite, then a markdown reply
//   "limit"         on a setup token, fails as a subscription at its limit would
//   "whoami"        says which credential it was given (never the value)
//   "spend <usd>"   a turn that cost that much
//   "nearlimit"     a rate-limit warning (85% of the five-hour limit), then a normal turn
//   "lowlimit"      a rate-limit warning at 27% of the seven-day limit, then a normal turn
//   "forge <caller> <tool>"  calls a vyred tool as <caller>, carrying this thread's agent key
//   "vyre <tool> <json>"  calls a vyred tool the way the MCP server does inside this thread
//                   (caller mcp:agent:<VYRE_AGENT>, or mcp), and says the JSON it got back
//   anything else   echoes the prompt back in a few deltas
// FAKE_CLAUDE_LOG, when set, gets one line per launch with argv and credential kind.
// FAKE_CLAUDE_RESPONSES, when set, gets each answer to a can_use_tool request, as received.
// FAKE_CLAUDE_TRANSCRIPTS, when set, is a projects folder: every turn is also written the way
// Claude Code writes it, to <dir>/<cwd with each non-alphanumeric char as "-">/<session>.jsonl.

import crypto from "node:crypto";
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
const MODEL = flag("--model") || "fake-model";

// ------------------------------------------------------------ transcript lines, as Claude Code writes them

const TX = process.env.FAKE_CLAUDE_TRANSCRIPTS;
/** @type {string|null} */
let parent = null;
function tx(type, message, extra = {}) {
  if (!TX) return;
  const cwd = process.cwd();
  const dir = path.join(TX, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const uuid = crypto.randomUUID();
  fs.appendFileSync(path.join(dir, `${session}.jsonl`), JSON.stringify({ parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId: session,
    version: "2.1.283", gitBranch: "", entrypoint: "sdk-cli", type, message, uuid, timestamp: new Date().toISOString(), ...extra }) + "\n");
  parent = uuid;
}
/** Claude Code writes each content block of a reply as its own line, all under one message id. */
const txAssistant = (id, block, stop = null) => tx("assistant", { id, type: "message", role: "assistant", model: MODEL, content: [block], stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 12, cache_creation_input_tokens: 40, cache_read_input_tokens: 2400, output_tokens: Math.max(1, Math.ceil(JSON.stringify(block).length / 4)) } },
  { requestId: `req_${id}` });

out({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", output: "whatever the user's own hooks print" });

async function say(text) {
  const id = `msg_${++n}`;
  txAssistant(id, { type: "text", text }, "end_turn");
  out({ type: "stream_event", event: { type: "message_start", message: { id, role: "assistant", content: [] } }, session_id: session, parent_tool_use_id: null });
  for (const piece of text.match(/.{1,6}/gs) || []) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }, session_id: session, parent_tool_use_id: null });
    await sleep(2);
  }
  out({ type: "assistant", message: { id, role: "assistant", model: MODEL, content: [{ type: "text", text }] }, session_id: session, parent_tool_use_id: null });
}

async function think(text) {
  const id = `msg_${++n}`, block = { type: "thinking", thinking: text, signature: "fake-signature" };
  txAssistant(id, block);
  out({ type: "assistant", message: { id, role: "assistant", model: MODEL, content: [block] }, session_id: session, parent_tool_use_id: null });
  await sleep(2);
}

/** A can_use_tool request, answered by whoever writes the control_response. */
function permission(name, input, tu, suggestions) {
  const rid = `req-${++n}`;
  const answer = new Promise(r => waiting.set(rid, r));
  out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: name, input, tool_use_id: tu,
    ...(suggestions ? { permission_suggestions: suggestions } : {}) } });
  return /** @type {Promise<any>} */ (answer);
}

const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

/**
 * One tool call: the tool_use, a permission ask when `ask`, the tool's result (from `run`, given
 * the input Claude Code would run with) or the rejection, all as stream-json and transcript lines.
 * @param {string} name @param {any} input
 * @param {{ ask?: boolean, suggestions?: any[], run: (input: any) => Promise<{ content: string, result?: any, error?: boolean }> | { content: string, result?: any, error?: boolean } }} o
 */
async function useTool(name, input, o) {
  const id = `msg_${++n}`, tu = `toolu_${++n}`;
  const block = { type: "tool_use", id: tu, name, input };
  txAssistant(id, block, "tool_use");
  out({ type: "assistant", message: { id, role: "assistant", model: MODEL, content: [block] }, session_id: session, parent_tool_use_id: null });
  const r = o.ask ? await permission(name, input, tu, o.suggestions) : { behavior: "allow", updatedInput: input };
  const allowed = r.behavior === "allow";
  const done = allowed ? await o.run(r.updatedInput || input) : { content: REJECTED, error: true, result: `Error: ${REJECTED}` };
  const res = { tool_use_id: tu, type: "tool_result", content: done.content, is_error: Boolean(done.error) };
  tx("user", { role: "user", content: [res] }, { toolUseResult: done.result ?? done.content });
  out({ type: "user", message: { role: "user", content: [res] }, session_id: session, parent_tool_use_id: null });
  await sleep(2);
  return { allowed, r };
}

// ------------------------------------------------------------ sample content (the made-up sample world only)

const QUESTIONS = [
  { question: "Which palette should the Northwind Bakery menu use?", header: "Palette", multiSelect: false, options: [
    { label: "Warm crust", description: "Browns and cream, like the shop front.", preview: "## Northwind Bakery\n\nBackground #f5ecd9, headings #6b3e1f\n\n- Sourdough loaf, 6.50\n- Rye, 5.75" },
    { label: "Fresh mint", description: "Pale green with dark text, lighter for summer.", preview: "## Northwind Bakery\n\nBackground #e6f2ec, headings #1f4d3a\n\n- Sourdough loaf, 6.50\n- Rye, 5.75" },
    { label: "Plain", description: "Black on white, nothing else." },
  ] },
  { question: "Which sections go on the first page?", header: "Sections", multiSelect: true, options: [
    { label: "Breads", description: "Loaves baked each morning." },
    { label: "Pastries", description: "Croissants, tarts and buns." },
    { label: "Specials", description: "What changes with the season." },
    { label: "Opening hours", description: "Days and times the shop is open." },
  ] },
];

const MENU = ["# Northwind Bakery menu", "", "## Breads", "- Sourdough loaf, 6.50", "- Rye, 5.75", "", "## Specials", "- Summer berry tart, 5.00", ""].join("\n");
const OLD = "## Specials\n- Summer berry tart, 5.00";
const NEW = "## Specials\n- Pumpkin loaf, 5.50\n- Apple cider donut, 3.25";
const TESTS = ["> northwind-menu@1.0.0 test", "> node --test", "", "ok 1 - the menu lists every special", "ok 2 - every price has two decimals",
  "1..2", "# tests 2", "# pass 2", "# fail 0"].join("\n");
const TODOS = [
  { content: "Add the autumn specials to the menu", status: "completed", activeForm: "Adding the autumn specials to the menu" },
  { content: "Update the price list on the site", status: "in_progress", activeForm: "Updating the price list on the site" },
  { content: "Ask kit to review the copy", status: "pending", activeForm: "Asking kit to review the copy" },
];

const result = (ok, text, cost = 0.001) => out({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: text,
  total_cost_usd: cost, duration_ms: 5, num_turns: 1, stop_reason: "end_turn", session_id: session,
  usage: { input_tokens: 10, output_tokens: String(text).length, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } });

async function turn(prompt) {
  const p = String(prompt).trim();
  tx("user", { role: "user", content: String(prompt) });
  if (/^write /i.test(p)) {
    const file = path.resolve(p.slice(6).trim());
    const { allowed } = await useTool("Write", { file_path: file, content: "hi" }, { ask: true,
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      run: i => { fs.writeFileSync(file, String(i.content)); return { content: `File created successfully at: ${file}` }; } });
    await say(allowed ? "Wrote it." : "I was not allowed to.");
    return result(true, allowed ? "Wrote it." : "I was not allowed to.");
  }
  if (/^bash /i.test(p)) {
    const { allowed } = await useTool("Bash", { command: p.slice(5).trim(), description: "Run it" }, { ask: true, run: () => ({ content: "" }) });
    await say(allowed ? "Ran it." : "I was not allowed to.");
    return result(true, allowed ? "Ran it." : "I was not allowed to.");
  }
  if (/^ask$/i.test(p)) {
    let got = null;
    const { allowed, r } = await useTool("AskUserQuestion", { questions: QUESTIONS }, { ask: true,
      run: i => {
        got = i.answers || {};
        const said = Object.entries(got).map(([q, a]) => `"${q}"="${a}"`).join(", ");
        return { content: `User has answered your questions: ${said}. You can now continue with the user's answers in mind.`, result: { questions: i.questions, answers: got } };
      } });
    const text = allowed ? `answers: ${JSON.stringify(got)}` : `You declined the question${r.message ? `: ${r.message}` : "."}`;
    await say(text);
    return result(true, text);
  }
  if (/^demo$/i.test(p)) {
    const file = path.join(process.cwd(), "menu.md");
    await think("alex wants the autumn specials on the Northwind Bakery menu. Read the menu first, swap the summer tart for the two autumn items, then run the tests before saying it is done.");
    await useTool("Read", { file_path: file }, { run: () => ({ content: MENU.split("\n").map((l, i) => `${String(i + 1).padStart(6)}\u2192${l}`).join("\n"),
      result: { type: "text", file: { filePath: file, content: MENU, numLines: MENU.split("\n").length, startLine: 1, totalLines: MENU.split("\n").length } } }) });
    const edit = await useTool("Edit", { file_path: file, old_string: OLD, new_string: NEW, replace_all: false }, { ask: true,
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      run: () => ({ content: `The file ${file} has been updated successfully.`, result: { filePath: file, oldString: OLD, newString: NEW, replaceAll: false, userModified: false } }) });
    const tests = await useTool("Bash", { command: "npm test", description: "Run the menu tests" }, { ask: true,
      suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }],
      run: () => ({ content: TESTS, result: { stdout: TESTS, stderr: "", interrupted: false, isImage: false } }) });
    await useTool("TodoWrite", { todos: TODOS }, { run: () => ({ content: "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
      result: { oldTodos: [], newTodos: TODOS } }) });
    const text = [
      "## Autumn specials",
      "",
      edit.allowed ? "The Northwind Bakery menu now lists two autumn specials in place of the summer tart:" : "You declined the edit, so the menu still has the summer tart. The change I would make:",
      "",
      "- **Pumpkin loaf**, 5.50",
      "- **Apple cider donut**, 3.25",
      "",
      tests.allowed ? "The tests pass:" : "I did not run the tests. To run them yourself:",
      "",
      "```sh",
      "npm test",
      ...(tests.allowed ? ["# tests 2", "# pass 2", "# fail 0"] : []),
      "```",
      "",
      "Next I will update the price list on the site, then ask kit to review the copy.",
    ].join("\n");
    await say(text);
    return result(true, text, 0.042);
  }
  if (/^limit$/i.test(p) && auth === "subscription") {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } });
    return result(false, "Claude usage limit reached.", 0);
  }
  // What a careless forgery from this thread's Bash looks like: its own key, someone else's name.
  const forge = /^forge (\S+) (\S+)$/.exec(p);
  if (forge) {
    const http = await import("node:http");
    const { paths } = await import("../../config/index.js");
    const r = await new Promise(resolve => {
      const req = http.request({ socketPath: paths(process.env.VYRE_HOME).socket, path: "/v1/tools/" + forge[2], method: "POST",
        headers: { "content-type": "application/json", "x-vyre-caller": forge[1], "x-vyre-agent-key": process.env.VYRE_AGENT_KEY || "" } }, res => {
        let raw = ""; res.on("data", c => { raw += c; }); res.on("end", () => resolve(`${res.statusCode} ${raw}`));
      });
      req.on("error", e => resolve(`error ${e.message}`));
      req.end("{}");
    });
    await say(String(r));
    return result(true, String(r));
  }
  const tool = /^vyre (\S+)\s*(.*)$/s.exec(p);
  if (tool) {
    const { call } = await import("../../daemon/client.js");
    const caller = process.env.VYRE_AGENT ? `mcp:agent:${process.env.VYRE_AGENT}` : "mcp";
    const r = JSON.stringify(await call(tool[1], tool[2] ? JSON.parse(tool[2]) : {}, { root: process.env.VYRE_HOME, caller }));
    await say(r);
    return result(true, r);
  }
  const spend = /^spend (\d+(?:\.\d+)?)$/i.exec(p);
  if (spend) { await say(`spent ${spend[1]}`); return result(true, `spent ${spend[1]}`, Number(spend[1])); }
  if (/^lowlimit$/i.test(p)) {
    out({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", resetsAt: 1790000000, utilization: 0.27 } });
    await say("plenty left"); return result(true, "plenty left", 0);
  }
  if (/^nearlimit$/i.test(p)) {
    out({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1790000000, utilization: 0.85 } });
    await say("still here"); return result(true, "still here", 0);
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
    out({ type: "system", subtype: "init", session_id: session, cwd: process.cwd(), model: MODEL, tools: ["Read", "Edit", "Write", "Bash", "TodoWrite", "AskUserQuestion"] });
    return;
  }
  if (m.type === "control_response") {
    const w = waiting.get(m.response.request_id);
    if (w) {
      waiting.delete(m.response.request_id);
      if (process.env.FAKE_CLAUDE_RESPONSES) fs.appendFileSync(process.env.FAKE_CLAUDE_RESPONSES, JSON.stringify(m.response.response) + "\n");
      w(m.response.response);
    }
    return;
  }
  if (m.type === "user") { const text = m.message.content; queue = queue.then(() => turn(text)); }
}).on("close", () => { queue.then(() => process.exit(0)); });
