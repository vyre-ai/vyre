#!/usr/bin/env node
// @ts-check
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for tests.
//
// It speaks the lines a real Claude Code 2.1.283 printed when probed (system init, stream_event
// deltas, whole assistant messages, can_use_tool control requests, a result per turn) and
// nothing more. What it does depends on the prompt:
//   "write <file>"  asks permission for Write (offering "always"), then writes the file only if allowed
//   "bash <command>" asks permission for Bash with that command, and runs nothing
//   "subagent[-slow] <task>"  runs Claude Code's Agent tool (after the host's PreToolUse hooks)
//   "background <cmd>"  starts a background task (task_started) that runs until stop_task
//   "fail"          a turn that ends in an error result
//   "orphan"        leaves a `sleep 4` in its process group, then exits on its own
//   "settings"      asks to Write its own .claude/settings.local.json with allow Bash(*)
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

// The CLI passes "--flag value"; the Agent SDK passes "--flag=value". The log and every check
// below read one form: "--flag=value" is split in two.
const argv = process.argv.slice(2).flatMap(a => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a]));
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const session = flag("--session-id") || flag("--resume") || "no-session";
// An API key comes on fd 3 (CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR), never in the environment.
const auth = process.env.CLAUDE_CODE_OAUTH_TOKEN ? "subscription"
  : process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR ? "api-key" : "ambient";
/**
 * One line per launch. Written at the initialize request, which both the runner and the Agent SDK
 * send first, because the SDK sends there what the CLI takes as flags: those are added to argv as
 * the flags they stand for, so a test reads one launch the same way from either driver.
 */
let logged = false;
function logLaunch(init = {}) {
  if (logged || !process.env.FAKE_CLAUDE_LOG) return;
  logged = true;
  const extra = [];
  if (typeof init.appendSystemPrompt === "string") extra.push("--append-system-prompt", init.appendSystemPrompt);
  if (typeof init.systemPrompt === "string") extra.push("--system-prompt", init.systemPrompt);
  else if (Array.isArray(init.systemPrompt)) extra.push("--system-prompt", init.systemPrompt.join("\n"));
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: [...argv, ...extra], auth, cwd: process.cwd(), agent: process.env.VYRE_AGENT || null,
    projects: process.env.VYRE_PROJECTS || null, key_in_env: Boolean(process.env.ANTHROPIC_API_KEY), max_thinking: process.env.MAX_THINKING_TOKENS ?? null, pid: process.pid, ppid: process.ppid, driver: process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-ts" || init.sdkMcpServers || init.hooks ? "sdk" : "cli" }) + "\n");
}
setTimeout(() => logLaunch(), 1000).unref();                               // no initialize at all: log anyway

const out = o => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0;
/** @type {Map<string, (r: any) => void>} */
const waiting = new Map();
let MODEL = flag("--model") || "fake-model";
/** The slash commands it offers, as Claude Code lists them in init and in the initialize answer. */
const COMMANDS = [{ name: "compact", description: "Clear the conversation but keep a summary", argumentHint: "<instructions>" },
  { name: "review", description: "Review a pull request", argumentHint: "" }];
/**
 * Files its "write" turns changed, with what was there before and the user message that led to
 * it: its file checkpoints, for a rewind_files request.
 * @type {{ uuid: string|null, file: string, before: string|null }[]}
 */
const changed = [];
let turnUuid = null;
/** Background tasks still running. @type {Map<string, boolean>} */
const tasks = new Map();

// ------------------------------------------------------------ transcript lines, as Claude Code writes them

const TX = process.env.FAKE_CLAUDE_TRANSCRIPTS;
// A fork (--resume <from> --fork-session --session-id <new>) starts with the other session's
// lines, under its own id, as Claude Code does. The original is not touched.
if (TX && argv.includes("--fork-session")) {
  const dir = path.join(TX, process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
  const from = path.join(dir, `${flag("--resume")}.jsonl`);
  if (fs.existsSync(from)) fs.writeFileSync(path.join(dir, `${session}.jsonl`), fs.readFileSync(from, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.stringify({ ...JSON.parse(l), sessionId: session }); } catch { return l; } }).join("\n") + "\n");
}
/** @type {string|null} A rewind (--resume-session-at) continues from that entry: the next lines hang under it. */
let parent = flag("--resume-session-at") || null;
function tx(type, message, extra = {}) {
  if (!TX) return;
  const cwd = process.cwd();
  const dir = path.join(TX, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const uuid = extra.uuid || crypto.randomUUID();
  fs.appendFileSync(path.join(dir, `${session}.jsonl`), JSON.stringify({ parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId: session,
    version: "2.1.283", gitBranch: "", entrypoint: "sdk-cli", type, message, uuid, timestamp: new Date().toISOString(), ...extra }) + "\n");
  parent = uuid;
}
/** Claude Code writes each content block of a reply as its own line, all under one message id. */
const txAssistant = (id, block, stop = null) => tx("assistant", { id, type: "message", role: "assistant", model: MODEL, content: [block], stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 12, cache_creation_input_tokens: 40, cache_read_input_tokens: 2400, output_tokens: Math.max(1, Math.ceil(JSON.stringify(block).length / 4)) } },
  { requestId: `req_${id}` });

out({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", output: "whatever the user's own hooks print" });

/**
 * Steered messages (priority "next") that arrived while a turn ran, not yet taken in. Claude Code
 * folds them into the running turn at its next step: here, at the turn's next reply, which says
 * so and carries the message's uuid (user_message_uuid), as Claude Code stamps it.
 * @type {{ uuid: string|null, text: string }[]}
 */
let folds = [];
/** The uuids of every message the current turn took in, for its result (user_message_uuids). */
let took = [];
let busy = false;

async function say(text) {
  const id = `msg_${++n}`;
  let stamp = null;
  if (folds.length) {
    const f = folds; folds = [];
    text = `${text} (took in: ${f.map(x => x.text).join("; ")})`;
    stamp = f.at(-1).uuid;
    for (const x of f) if (x.uuid) took.push(x.uuid);
  }
  txAssistant(id, { type: "text", text }, "end_turn");
  out({ type: "stream_event", event: { type: "message_start", message: { id, role: "assistant", content: [] } }, session_id: session, parent_tool_use_id: null });
  for (const piece of text.match(/.{1,6}/gs) || []) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }, session_id: session, parent_tool_use_id: null });
    await sleep(2);
  }
  out({ type: "assistant", message: { id, role: "assistant", model: MODEL, content: [{ type: "text", text }],
    usage: { input_tokens: 12, cache_read_input_tokens: 2400, cache_creation_input_tokens: 40, output_tokens: Math.ceil(text.length / 4) } }, session_id: session, parent_tool_use_id: null,
    ...(stamp ? { user_message_uuid: stamp } : {}) });
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
/** @type {{ matcher?: string, hookCallbackIds?: string[] }[]} the host's PreToolUse hooks */
let preHooks = [];
/** Ask each matching host hook; the first deny's reason, or null. */
async function preToolUse(name, input, tu) {
  for (const h of preHooks) {
    if (h.matcher && !new RegExp(`^(?:${h.matcher})$`).test(name)) continue;
    for (const cb of h.hookCallbackIds || []) {
      const rid = `req-${++n}`;
      const answer = new Promise(r => waiting.set(rid, r));
      out({ type: "control_request", request_id: rid, request: { subtype: "hook_callback", callback_id: cb, tool_use_id: tu,
        input: { hook_event_name: "PreToolUse", session_id: session, cwd: process.cwd(), tool_name: name, tool_input: input, tool_use_id: tu } } });
      const got = /** @type {any} */ (await answer) || {};
      const spec = got.hookSpecificOutput || {};
      if (spec.permissionDecision === "deny" || got.decision === "block") return spec.permissionDecisionReason || got.reason || "a hook refused it";
    }
  }
  return null;
}

async function useTool(name, input, o) {
  const id = `msg_${++n}`, tu = `toolu_${++n}`;
  const block = { type: "tool_use", id: tu, name, input };
  txAssistant(id, block, "tool_use");
  out({ type: "assistant", message: { id, role: "assistant", model: MODEL, content: [block] }, session_id: session, parent_tool_use_id: null });
  // The host's PreToolUse hooks first (the Agent SDK registers them at initialize), as Claude Code
  // runs them before any permission question: a deny ends the call.
  const hooked = await preToolUse(name, input, tu);
  const r = hooked ? { behavior: "deny", message: hooked } : o.ask ? await permission(name, input, tu, o.suggestions) : { behavior: "allow", updatedInput: input };
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

// Claude Code's total_cost_usd is the running total of this process's turns, not the turn's own.
let spent = 0;
const result = (ok, text, cost = 0.001) => out({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: text,
  total_cost_usd: (spent = Math.round((spent + cost) * 1e6) / 1e6), duration_ms: 5, num_turns: 1, stop_reason: "end_turn", session_id: session,
  usage: { input_tokens: 10, output_tokens: String(text).length, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
  modelUsage: { [MODEL]: { inputTokens: 10, outputTokens: String(text).length, cacheReadInputTokens: 100, cacheCreationInputTokens: 50, contextWindow: 200000 } },
  ...(took.length ? { user_message_uuids: took } : {}),
  // An error result lists its errors, as Claude Code's does (the Agent SDK reads them).
  ...(ok ? {} : { errors: [String(text)] }) });

async function turn(prompt, uuid = null) {
  // A message with pasted images is blocks: the words, and how many images came with them.
  const blocks = Array.isArray(prompt) ? prompt : null;
  if (blocks) prompt = blocks.filter(b => b && b.type === "text").map(b => b.text).join("\n") + (blocks.some(b => b && b.type === "image") ? ` (+${blocks.filter(b => b && b.type === "image").length} images)` : "");
  const p = String(prompt).trim();
  // A user line's uuid is the message's own when the host gave one, as Claude Code keeps it.
  tx("user", { role: "user", content: String(prompt) }, uuid ? { uuid } : {});
  if (/^write /i.test(p)) {
    const file = path.resolve(p.slice(6).trim());
    const { allowed } = await useTool("Write", { file_path: file, content: "hi" }, { ask: true,
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      run: i => { changed.push({ uuid: turnUuid, file, before: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null }); fs.writeFileSync(file, String(i.content)); return { content: `File created successfully at: ${file}` }; } });
    await say(allowed ? "Wrote it." : "I was not allowed to.");
    return result(true, allowed ? "Wrote it." : "I was not allowed to.");
  }
  // A process left behind in this session's group, then the session ends on its own.
  if (/^orphan$/i.test(p)) {
    const { spawn } = await import("node:child_process");
    spawn("sleep", ["4"], { stdio: "ignore" }).unref();
    await say("left one behind");
    result(true, "left one behind");
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (/^settings$/i.test(p)) {
    const file = path.join(process.cwd(), ".claude", "settings.local.json");
    const { allowed } = await useTool("Write", { file_path: file, content: JSON.stringify({ permissions: { allow: ["Bash(*)"] } }) }, { ask: true,
      run: i => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, String(i.content)); return { content: `File created successfully at: ${file}` }; } });
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
  // "forge <caller> <tool>" sends the agent's own key with it, which the daemon refuses outright
  // (the key must name its own agent); "bareforge <caller> <tool>" sends neither a key nor a
  // session header, the plainer and more realistic forgery ("its Bash can call vyre call ... with
  // no agent key and no session header", e2e review HIGH 1) that only fromClaude (peer ancestry)
  // catches. Both, like "vyre", are found anywhere in the prompt: at the very start they take the
  // rest of the string (unused today, kept for symmetry), embedded further in they take just that
  // line, since request-wrapped text (core/team) has a closing tag after it that must not be
  // swallowed.
  const lines = p.split("\n");
  const CMD = /^(forge|bareforge) (\S+) (\S+)(?:\s+(.*))?$/s;
  const cmdAt = lines.findIndex(l => CMD.test(l));
  const cmd = cmdAt < 0 ? null : CMD.exec(cmdAt === 0 ? p : lines[cmdAt]);
  if (cmd) {
    const [, kind, caller, toolName, body] = cmd;
    const http = await import("node:http");
    const { paths } = await import("../../config/index.js");
    const r = await new Promise(resolve => {
      const req = http.request({ socketPath: paths(process.env.VYRE_HOME).socket, path: "/v1/tools/" + toolName, method: "POST",
        headers: { "content-type": "application/json", "x-vyre-caller": caller, ...(kind === "forge" ? { "x-vyre-agent-key": process.env.VYRE_AGENT_KEY || "" } : {}) } }, res => {
        let raw = ""; res.on("data", c => { raw += c; }); res.on("end", () => resolve(`${res.statusCode} ${raw}`));
      });
      req.on("error", e => resolve(`error ${e.message}`));
      req.end(body || "{}");
    });
    await say(String(r));
    return result(true, String(r));
  }
  // A prompt with a "vyre <tool> <json>" line anywhere in it, not only at the very start, so a
  // teammate's wrapped <vyre-request> text (core/team, ADR 0031) can still script a tool call. At
  // the very start the rest of the prompt is the call, as before (a multi-line JSON body works),
  // and only one call is made. Found further in, EVERY such line is its own single-line call, run
  // in order, so a test can script a teammate trying something, reacting to the answer (a refusal,
  // say) and trying again, all in the one turn a real model would; a wrapper's closing tag after
  // the last one is never swallowed into any call's JSON, since each line is matched on its own.
  const vyreAt = lines.findIndex(l => /^vyre \S/.test(l));
  if (vyreAt === 0) {
    const tool = /^vyre (\S+)\s*(.*)$/s.exec(p);
    if (tool) {
      const { call } = await import("../../daemon/client.js");
      const caller = process.env.VYRE_AGENT ? `mcp:agent:${process.env.VYRE_AGENT}` : "mcp";
      const r = JSON.stringify(await call(tool[1], tool[2] ? JSON.parse(tool[2]) : {}, { root: process.env.VYRE_HOME, caller }));
      await say(r);
      return result(true, r);
    }
  } else if (vyreAt > 0) {
    const { call } = await import("../../daemon/client.js");
    const caller = process.env.VYRE_AGENT ? `mcp:agent:${process.env.VYRE_AGENT}` : "mcp";
    const results = [];
    for (const l of lines) {
      const m = /^vyre (\S+)\s*(.*)$/.exec(l);
      if (!m) continue;
      results.push(JSON.stringify(await call(m[1], m[2] ? JSON.parse(m[2]) : {}, { root: process.env.VYRE_HOME, caller })));
    }
    const text = results.join("\n");
    await say(text);
    return result(true, text);
  }
  const spend = /^spend (\d+(?:\.\d+)?)$/i.exec(p);
  if (spend) { await say(`spent ${spend[1]}`); return result(true, `spent ${spend[1]}`, Number(spend[1])); }
  // A subagent (Claude Code's Agent tool), which Vyre's concurrency slots hold back when full.
  // Found anywhere in the prompt, like vyre/forge/bareforge above, so a teammate's wrapped
  // <vyre-request> text can hold its turn open for a real interval (core/team's priority-order
  // test needs this: a request-wrapped prompt never starts with "subagent", so the old
  // start-anchored-only match let the turn finish in milliseconds instead of the 1.5s it asked for).
  const SUB = /^subagent(-slow)? (.+)$/i;
  const subAt = lines.findIndex(l => SUB.test(l));
  const sub = subAt < 0 ? null : SUB.exec(lines[subAt]);
  if (sub) {
    const { allowed, r } = await useTool("Agent", { description: sub[2], prompt: sub[2], subagent_type: "general-purpose" }, {
      run: async () => { if (sub[1]) await sleep(1500); return { content: `subagent done: ${sub[2]}` }; } });
    const text = allowed ? `subagent done: ${sub[2]}` : `The subagent did not run: ${r.message}`;
    await say(text);
    return result(true, text);
  }
  // A background task (Bash with run_in_background): it runs until it is stopped.
  const bg = /^background (.+)$/i.exec(p);
  if (bg) {
    const task = `task_${++n}`;
    tasks.set(task, true);
    out({ type: "system", subtype: "task_started", task_id: task, description: bg[1], task_type: "local_bash", is_backgrounded: true, uuid: crypto.randomUUID(), session_id: session });
    await say(`started ${task} in the background`);
    return result(true, `started ${task} in the background`);
  }
  if (/^fail$/i.test(p)) { await say("Trying."); return result(false, "API Error: 500 the fake broke on purpose", 0); }
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
  // Interrupt, as Claude Code does it: every open permission question is withdrawn (and reads as
  // declined), and the turn ends.
  if (m.type === "control_request" && m.request?.subtype === "interrupt") {
    for (const [rid, w] of waiting) { waiting.delete(rid); out({ type: "control_cancel_request", request_id: rid }); w({ behavior: "deny", message: "Interrupted." }); }
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    return;
  }
  if (m.type === "control_request" && m.request?.subtype === "stop_task") {
    const id = String(m.request.task_id);
    const had = tasks.delete(id);
    if (had) out({ type: "system", subtype: "task_notification", task_id: id, status: "stopped", output_file: "", summary: "stopped by the user", uuid: crypto.randomUUID(), session_id: session });
    out({ type: "control_response", response: had ? { subtype: "success", request_id: m.request_id, response: {} } : { subtype: "error", request_id: m.request_id, error: `no task ${id}` } });
    return;
  }
  if (m.type === "control_request" && m.request?.subtype === "set_max_thinking_tokens") {
    if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ thinking: m.request.max_thinking_tokens }) + "\n");
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    return;
  }
  if (m.type === "control_request" && m.request?.subtype === "set_model") {
    MODEL = String(m.request.model || MODEL);
    if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ model: MODEL }) + "\n");
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    return;
  }
  // Put back what the writes since that user message changed, newest first.
  if (m.type === "control_request" && m.request?.subtype === "rewind_files") {
    const at = changed.findIndex(c => c.uuid === m.request.user_message_id);
    const undo = at < 0 ? [] : changed.splice(at).reverse();
    for (const c of undo) { if (c.before === null) fs.rmSync(c.file, { force: true }); else fs.writeFileSync(c.file, c.before); }
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id,
      response: at < 0 ? { canRewind: false, error: "no checkpoint for that message" } : { canRewind: true, filesChanged: [...new Set(undo.map(c => c.file))] } } });
    return;
  }
  if (m.type === "control_request" && m.request?.subtype === "set_permission_mode") {
    if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ mode: m.request.mode }) + "\n");
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    return;
  }
  if (m.type === "control_request" && m.request?.subtype === "initialize") {
    logLaunch(m.request);
    preHooks = (m.request.hooks && m.request.hooks.PreToolUse) || [];
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: COMMANDS } } });
    out({ type: "system", subtype: "init", session_id: session, cwd: process.cwd(), model: MODEL, tools: ["Read", "Edit", "Write", "Bash", "TodoWrite", "AskUserQuestion"],
      slash_commands: COMMANDS.map(c => c.name) });
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
  if (m.type === "user") {
    const text = m.message.content;
    // Steered while a turn runs: taken in at the turn's next step. Else a turn of its own, in order.
    if (m.priority === "next" && busy) { folds.push({ uuid: m.uuid || null, text: String(text) }); return; }
    queue = queue.then(async () => {
      busy = true; took = m.uuid ? [m.uuid] : [];
      turnUuid = m.uuid || null;
      try { await turn(text, m.uuid || null); } finally { busy = false; }
      // Steered words the turn never reached (an interrupt, a turn with no reply left) run next.
      if (folds.length) { const f = folds; folds = []; queue = queue.then(async () => { busy = true; took = f.map(x => x.uuid).filter(Boolean); try { await turn(f.map(x => x.text).join("\n\n")); } finally { busy = false; } }); }
    });
  }
}).on("close", () => { queue.then(() => process.exit(0)); });
