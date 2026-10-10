// @ts-check
// The generic ACP driver against a fake ACP agent (core/sessions/testing/fake-acp.js): conform()'s
// whole scenario including the fixed safety set, bypass-shaped modes filtered, the client's fs and
// terminal methods held to the floor and to the session's folder, and the per-provider hooks.

import "../../../scripts/mac-test-guard.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../../test/helpers.js";
import { SCRATCH } from "../../../test/scratch.mjs";
import { conform } from "../conformance.js";
import { rules } from "../../harness/rules.js";
import { projectCodexConfig, seedTampered, promptTokens, acpProvider, askFor, mediaOf, modelsOf } from "./acp.js";
import { seedFiles } from "../spawn.js";

// Some tests start a fake agent and end before its process does; once the file is done, whatever child of THIS process is still running is stopped, so the run exits on its own (no force exit).
after(() => { for (const h of /** @type {any[]} */ (/** @type {any} */ (process)._getActiveHandles())) if (h && h.constructor && h.constructor.name === "ChildProcess" && h.exitCode === null) { try { h.kill("SIGKILL"); } catch { /* gone */ } } });
import { codexProvider } from "./codex.js";

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp.js");
fs.chmodSync(FAKE, 0o755);

/** A world: a session folder outside the Vyre home, a Vyre home with a vault, the fake's store and log. */
function world(t, over = {}) {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, "vault"), { recursive: true });
  fs.writeFileSync(path.join(home, "vault", "secret.txt"), "the vault value");
  const cwd = fs.mkdtempSync(path.join(SCRATCH, "acp-work-"));
  const store = fs.mkdtempSync(path.join(SCRATCH, "acp-store-"));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); });
  const log = path.join(store, "log.jsonl"), pidFile = path.join(store, "detached.pid");
  const env = { ...process.env, FAKE_ACP_STORE: store, FAKE_ACP_LOG: log, FAKE_ACP_PIDFILE: pidFile };
  const floor = c => rules({ tool: c.tool, input: c.input, cwd: c.cwd, home });
  const provider = acpProvider({ id: "fake", bin: FAKE, floor, ...over });
  const launches = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : []);
  return { home, cwd, store, env, provider, pidFile, launches };
}

/** One session, with its messages, and a way to run a turn to its result. */
function open(w, extra = {}) {
  const got = [];
  const proc = w.provider.run({ id: crypto.randomUUID(), resume: false, cwd: w.cwd, env: w.env, onSpawn() {}, onMessage: m => got.push(m), onExit() {}, ...extra });
  const until = async (test, what) => { for (let i = 0; i < 300; i++) { const f = got.find(test); if (f) return f; await new Promise(r => setTimeout(r, 30)); } throw new Error(`timed out waiting for ${what}`); };
  let turns = 0;
  const say = async text => {
    const from = got.length;
    proc.write({ type: "user", message: { role: "user", content: text } });
    turns++;
    await until(m => m.type === "result" && got.filter(x => x.type === "result").length >= turns, `result of "${text}"`);
    return got.slice(from).filter(m => m.type === "stream_event").map(m => m.event.delta.text || "").join("");
  };
  return { proc, got, until, say };
}

test("acp: conform() passes the whole scenario and the fixed safety set against the fake agent", async t => {
  const w = world(t);
  const fails = await conform(w.provider, { id: crypto.randomUUID(), cwd: w.cwd, env: w.env, detach: { prompt: "detach", pidFile: w.pidFile } });
  assert.deepEqual(fails, []);
});

test("acp: an image goes to an agent that takes images as an image block, and to one that does not as words saying so", async t => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  const msg = { type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }, { type: "text", text: "what is in this picture" }] } };
  const blind = world(t), sighted = world(t);
  sighted.env.FAKE_ACP_IMAGE = "1";
  for (const [w, types, echo] of [[blind, ["text", "text"], /an image was attached, but this model cannot look at images/i], [sighted, ["image", "text"], /^echo: what is in this picture$/]]) {
    const s = open(w);
    await s.until(m => m.type === "system" && m.subtype === "init", "init");
    s.proc.write(msg);
    const text = (await s.until(m => m.type === "result", "result"), s.got.filter(m => m.type === "stream_event").map(m => m.event.delta.text || "").join(""));
    assert.match(text, echo);
    assert.deepEqual(w.launches().filter(l => l.types).pop().types, types);
    await s.proc.stop(1000);
  }
});

test("acp: an entry that says it takes images sends the image block to an agent whose initialize says it does not (Grok Build)", async t => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  const msg = { type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }, { type: "text", text: "what is in this picture" }] } };
  const w = world(t, { takesImages: true });
  const s = open(w);
  await s.until(m => m.type === "system" && m.subtype === "init", "init");
  s.proc.write(msg);
  await s.until(m => m.type === "result", "result");
  assert.deepEqual(w.launches().filter(l => l.types).pop().types, ["image", "text"]);
  await s.proc.stop(1000);
});

test("acp: an entry that needs its MCP servers to come up holds the session's first prompt for that long, and only when it was given servers", async t => {
  const servers = [{ name: "vyre", command: "node", args: ["-e", "0"], env: [] }];
  const settled = world(t, { mcpSettleMs: 500 }), plain = world(t, { mcpSettleMs: 500 });
  const t0 = Date.now();
  const a = open(settled, { mcpServers: servers });
  await a.until(m => m.type === "system" && m.subtype === "init", "init");
  const held = Date.now() - t0;
  await a.proc.stop(1000);
  assert.ok(held >= 450, `the session was ready after ${held} ms, before its MCP servers had a chance to come up`);
  const t1 = Date.now();
  const b = open(plain);
  await b.until(m => m.type === "system" && m.subtype === "init", "init");
  const free = Date.now() - t1;
  await b.proc.stop(1000);
  assert.ok(free < held, `a session with no servers waited ${free} ms, as long as one with servers (${held} ms)`);
});

test("acp: the client advertises fs and terminal, and the entry's args and env reach the agent (never read from the agent's own config)", async t => {
  const w = world(t, { args: o => ["--ask", "untrusted", "--cwd", o.cwd], env: { HOME: "/acct/home" } });
  const s = open(w);
  await s.until(m => m.type === "system" && m.subtype === "init", "init");
  await s.proc.stop(1000);
  const l = w.launches()[0];
  assert.deepEqual(l.clientCaps, { fs: { readTextFile: true, writeTextFile: true }, terminal: true });
  assert.deepEqual(l.launch, ["--ask", "untrusted", "--cwd", w.cwd]);
  assert.equal(l.home, "/acct/home");
});

test("acp: a bypass-shaped mode is never listed and never set, whoever asks", async t => {
  const w = world(t);
  const s = open(w);
  const init = await s.until(m => m.type === "system" && m.subtype === "init", "init");
  assert.deepEqual(init.modes.sort(), ["default", "plan"]);
  assert.deepEqual(init.harness.caps, { loadSession: true, image: false, mcpHttp: false, mcpSse: false }, "the init carries what the agent said about itself (R031-85)");
  await assert.rejects(() => s.proc.setMode("bypassPermissions"), { code: "denied" });
  await assert.rejects(() => s.proc.setMode("unknown-mode"), { code: "denied" });
  assert.deepEqual(await s.proc.setMode("plan"), { mode: "plan" });
  assert.equal(await s.say("mode"), "mode: plan");
  await s.proc.stop(1000);
  assert.ok(!w.launches().some(l => l.set_mode && /bypass/i.test(l.set_mode)), "the agent never heard of it");
});

test("acp: memory goes ahead of the person's words on every prompt, the brief only on the first, and a failing memory adds nothing", async t => {
  const w = world(t);
  const asked = [];
  const s = open(w, { system: { text: "VYRE-PROMPT" }, memory: async q => { asked.push(q); return [{ type: "text", text: q.first ? "BRIEF" : "LINES" }]; } });
  assert.equal(await s.say("where is the site hosted"), "echo: VYRE-PROMPT\n\nBRIEFwhere is the site hosted", "the system prompt, then memory, then the person's words");
  assert.equal(await s.say("and the domain"), "echo: LINESand the domain");
  assert.deepEqual(asked, [{ prompt: "where is the site hosted", first: true }, { prompt: "and the domain", first: false }], "memory searches on the person's words only");
  await s.proc.stop(1000);
  const bad = open(world(t), { memory: async () => { throw new Error("iq is down"); } });
  assert.equal(await bad.say("hello"), "echo: hello");
  await bad.proc.stop(1000);
});

test("acp: the agent's plan is said as a plan line and a delete is drawn as an edit", async t => {
  const w = world(t);
  const s = open(w);
  s.proc.write({ type: "user", message: { role: "user", content: "plan" } });
  await s.until(m => m.type === "result", "the result");
  const plan = s.got.find(m => m.type === "system" && m.subtype === "vyre_plan");
  assert.deepEqual(plan.entries.map(e => e.status), ["completed", "in_progress", "pending"]);
  const use = s.got.filter(m => m.type === "assistant").flatMap(m => m.message.content).find(b => b.type === "tool_use");
  assert.equal(use.vyre_kind, "edit", "ACP delete is an edit, though the floor sees Write");
  await s.proc.stop(1000);
});

test("acp: a permission question goes to the person as can_use_tool, and always-allow is never chosen", async t => {
  const w = world(t);
  const s = open(w);
  s.proc.write({ type: "user", message: { role: "user", content: "bash npm test" } });
  const ask = await s.until(m => m.type === "control_request", "the question");
  assert.equal(ask.request.tool_name, "Bash");
  assert.equal(ask.request.input.command, "npm test");
  s.proc.write({ type: "control_response", response: { request_id: ask.request_id, response: { behavior: "allow" } } });
  await s.until(m => m.type === "result", "the result");
  assert.ok(s.got.some(m => m.type === "user" && m.message.content[0].tool_use_id), "allow_once ran the tool (the always option would have said the same, so check the text)");
  assert.match(s.got.filter(m => m.type === "stream_event").map(m => m.event.delta.text).join(""), /Ran it\./);
  await s.proc.stop(1000);
  const d = world(t);
  const s2 = open(d);
  s2.proc.write({ type: "user", message: { role: "user", content: "bash rm -rf build" } });
  const ask2 = await s2.until(m => m.type === "control_request", "the second question");
  s2.proc.write({ type: "control_response", response: { request_id: ask2.request_id, response: { behavior: "deny" } } });
  await s2.until(m => m.type === "result", "the second result");
  assert.match(s2.got.filter(m => m.type === "stream_event").map(m => m.event.delta.text).join(""), /not allowed/);
  await s2.proc.stop(1000);
});

test("acp: Codex's approval for an MCP tool names no server: Vyre's own is let through only when it is the one server and no project config exists; every other is denied and said once", async t => {
  const vyre = [{ name: "vyre", command: "node", args: ["x"], env: [] }];
  const textOf = s => s.got.filter(m => m.type === "stream_event" && m.event.delta && m.event.delta.text).map(m => m.event.delta.text).join("");
  // Vyre's own bridge, on an entry that says vyred gates it, in a clean folder: no question, allowed.
  const a = world(t, { mcpOwn: true });
  const sa = open(a, { mcpServers: vyre });
  assert.match(await sa.say("mcpask"), /mcp: allow_once/);
  assert.ok(!sa.got.some(m => m.type === "control_request"), "no question for Vyre's own MCP server");
  await sa.proc.stop(500);
  // A project config that exists, even an empty one, turns it off: existing is enough, nothing is parsed.
  const q = world(t, { mcpOwn: true });
  fs.mkdirSync(path.join(q.cwd, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(q.cwd, ".codex", "config.toml"), "");
  const sq = open(q, { mcpServers: vyre });
  assert.match(await sq.say("mcpask"), /mcp: cancel/);
  await sq.proc.stop(500);
  // Any project config, in any TOML spelling of an MCP server (or none), turns the shortcut off: denied, never asked blind, said once.
  const spellings = [
    '[mcp_servers.vyre]\ncommand = "evil"\n', 'mcp_servers.vyre.command = "evil"\n', 'mcp_servers = { vyre = { command = "evil" } }\n',
    '["mcp_servers".vyre]\ncommand = "evil"\n', '"mcp_servers".vyre.command = "evil"\n', "[ 'mcp_servers' . 'vyre' ]\ncommand = \"evil\"\n", 'approval_policy = "never"\n',
  ];
  for (const toml of spellings) {
    const d = world(t, { mcpOwn: true });
    fs.mkdirSync(path.join(d.cwd, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(d.cwd, ".codex", "config.toml"), toml);
    const sd = open(d, { mcpServers: vyre });
    const first = await sd.say("mcpask");
    assert.match(first, /mcp: cancel/, toml);
    assert.ok(!sd.got.some(m => m.type === "control_request"), `no blind question: ${toml}`);
    assert.equal(first.trim().replace(/\s+/g, " "), "This project's Codex settings define their own tool servers, so Vyre can't tell which tool is asking. It was refused.mcp: cancel", toml);
    const second = await sd.say("mcpask");
    assert.doesNotMatch(second, /Codex settings define/, "said once");
    assert.match(second, /mcp: cancel/);
    await sd.proc.stop(500);
  }
  // The account's own seeded config edited since Vyre wrote it turns it off too.
  const tam = world(t, { mcpOwn: true, seed: { ".codex/config.toml": 'approval_policy = "on-request"\n' } });
  const th = path.join(tam.store, "th");
  fs.mkdirSync(path.join(th, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(th, ".codex", "config.toml"), '[mcp_servers.x]\ncommand = "evil"\n');
  assert.equal(seedTampered(th, { ".codex/config.toml": 'approval_policy = "on-request"\n' }), true);
  fs.writeFileSync(path.join(th, ".codex", "config.toml"), 'approval_policy = "on-request"\n');
  assert.equal(seedTampered(th, { ".codex/config.toml": 'approval_policy = "on-request"\n' }), false);
  assert.equal(seedTampered(path.join(tam.store, "no-home"), { ".codex/config.toml": "x" }), false);
  // A seeded file that cannot be read is not known to be Vyre's: a directory in its place, and (when not root) a folder with mode 000.
  fs.rmSync(path.join(th, ".codex", "config.toml"));
  fs.mkdirSync(path.join(th, ".codex", "config.toml"));
  assert.equal(seedTampered(th, { ".codex/config.toml": "x" }), true, "a directory where the file should be");
  if (process.getuid && process.getuid() !== 0) {
    fs.rmSync(path.join(th, ".codex", "config.toml"), { recursive: true });
    fs.writeFileSync(path.join(th, ".codex", "config.toml"), "x");
    fs.chmodSync(path.join(th, ".codex"), 0o000);
    try { assert.equal(seedTampered(th, { ".codex/config.toml": "x" }), true, "EACCES"); } finally { fs.chmodSync(path.join(th, ".codex"), 0o700); }
  }
  // A config that exists but cannot be read counts: a directory named config.toml, and (when not root) a .codex folder that cannot be searched.
  const dirCfg = world(t, { mcpOwn: true });
  fs.mkdirSync(path.join(dirCfg.cwd, ".codex", "config.toml"), { recursive: true });
  assert.equal(projectCodexConfig(dirCfg.cwd), true, "a directory named config.toml");
  if (process.getuid && process.getuid() !== 0) {
    const locked = world(t, { mcpOwn: true });
    const cdir = path.join(locked.cwd, ".codex");
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, "config.toml"), "x = 1\n");
    fs.chmodSync(cdir, 0o000);
    try { assert.equal(projectCodexConfig(locked.cwd), true, "an unreadable .codex folder (EACCES)"); } finally { fs.chmodSync(cdir, 0o700); }
    const sl = open(locked, { mcpServers: vyre });
    assert.match(await sl.say("mcpask"), /Codex settings define their own tool servers/);
    await sl.proc.stop(500);
  }
  // A config higher up the tree counts too.
  const up = world(t, { mcpOwn: true });
  fs.mkdirSync(path.join(up.cwd, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(up.cwd, ".codex", "config.toml"), 'x = 1\n');
  assert.equal(projectCodexConfig(path.join(up.cwd, "sub", "deeper")), true);
  assert.equal(projectCodexConfig(a.cwd), false);
  // Without the entry's say-so, or with another or more servers, every MCP approval is denied: nothing is let through on a guess.
  for (const [over, servers] of [[{}, vyre], [{ mcpOwn: true }, [{ name: "other", command: "node", args: [], env: [] }]], [{ mcpOwn: true }, [...vyre, { name: "other", command: "node", args: [], env: [] }]], [{ mcpOwn: true }, []]]) {
    const c = world(t, over);
    const sc = open(c, { mcpServers: servers });
    const out = await sc.say("mcpask");
    assert.match(out, /mcp: cancel/, JSON.stringify([over, servers.map(x => x.name)]));
    assert.ok(!sc.got.some(m => m.type === "control_request"));
    assert.match(out, /Vyre can't tell which tool server is asking\. It was refused\./);
    await sc.proc.stop(500);
  }
});

test("codex entry: starts in workspace-write (or read-only), never agent (Auto review, where a model decides) or full access", async t => {
  const run = async (mode, start) => {
    const w = world(t);
    const got = [];
    const proc = codexProvider({ bin: FAKE }).run({ id: crypto.randomUUID(), resume: false, cwd: w.cwd, env: { ...w.env, HOME: path.join(w.store, "h"), FAKE_ACP_AUTH: "ok", FAKE_ACP_EXTRA_MODE: mode, FAKE_ACP_START_MODE: start }, onSpawn() {}, onMessage: m => got.push(m), onExit() {} });
    for (let i = 0; i < 200 && !got.find(m => m.type === "system" || m.type === "result"); i++) await new Promise(r => setTimeout(r, 30));
    const out = { init: got.find(m => m.type === "system" && m.subtype === "init"), result: got.find(m => m.type === "result") };
    await proc.stop(500);
    return out;
  };
  const ok = await run("workspace-write", "workspace-write");
  assert.ok(ok.init, JSON.stringify(ok.result));
  assert.equal(ok.init.mode, "workspace-write");
  assert.ok(!ok.init.modes.includes("agent") && !ok.init.modes.includes("agent-full-access"), JSON.stringify(ok.init.modes));
  // An agent that only offers "agent" (Auto review) gives Vyre nothing it will start in: the session does not run.
  const auto = await run("agent", "agent");
  assert.equal(auto.init, undefined);
  assert.match(String(auto.result && auto.result.result), /Codex starts in a mode Vyre does not permit \(agent\)/);
});

test("acp: Codex's plan question (switch_mode) is a question card with the plan text and two buttons, Implement and Revise, answered as the matching option", async t => {
  for (const [how, answer, want] of [["Implement", a => ({ behavior: "allow", updatedInput: { ...a.request.input, answers: { "Implement this plan?": "Implement" } } }), "plan: implement_plan"],
    ["Revise", a => ({ behavior: "allow", updatedInput: { ...a.request.input, answers: { "Implement this plan?": "Revise" } } }), "plan: revise_plan"],
    ["declined", () => ({ behavior: "deny", message: "no" }), "plan: revise_plan"]]) {
    const w = world(t);
    const s = open(w);
    s.proc.write({ type: "user", message: { role: "user", content: "planask" } });
    const ask = await s.until(m => m.type === "control_request", `the plan question (${how})`);
    assert.equal(ask.request.tool_name, "AskUserQuestion");
    const q = ask.request.input.questions[0];
    assert.deepEqual([q.question, q.header, q.multiSelect, q.options.map(o => o.label)], ["Implement this plan?", "Plan", false, ["Implement", "Revise"]]);
    assert.equal(q.options[0].preview, "1. Create hello.txt.\n2. Read it back.\n", "the plan text is on the Implement button");
    s.proc.write({ type: "control_response", response: { request_id: ask.request_id, response: answer(ask) } });
    await s.until(m => m.type === "result", "the result");
    assert.match(s.got.filter(m => m.type === "stream_event").map(m => m.event.delta.text).join(""), new RegExp(want), how);
    await s.proc.stop(500);
  }
});

test("acp: a turn's tokens come from the prompt response (Codex's usage, Grok's _meta), shaped as Claude's usage, with the cached part split out", async t => {
  for (const [mode, extra] of [["acp", {}], ["grok", { model: "grok-x", cost_usd_ticks: 113859200 }]]) {
    const w = world(t);
    const s = open(w, { env: { ...w.env, FAKE_ACP_USAGE: mode } });
    s.proc.write({ type: "user", message: { role: "user", content: "hello" } });
    const r = await s.until(m => m.type === "result", "the result");
    // context_used: what the context holds after the turn (the last request's whole input and its output), which a rollover reads as the window's use.
    assert.deepEqual({ ...r.usage }, { input_tokens: 70, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 0, reasoning_tokens: 5, context_used: 120, ...extra }, mode);
    assert.equal(r.model, mode === "grok" ? "grok-x" : undefined, "Grok's model rides on the result, Codex's none in this fake");
    await s.proc.stop(500);
  }
  const w = world(t);
  const s = open(w);
  s.proc.write({ type: "user", message: { role: "user", content: "hello" } });
  assert.deepEqual((await s.until(m => m.type === "result", "the result")).usage, {}, "a response that says nothing gives no tokens");
  await s.proc.stop(500);
  assert.deepEqual(promptTokens(null), {});
  assert.deepEqual(promptTokens({ usage: { inputTokens: "x" } }), {});
  assert.equal(promptTokens({ usage: { inputTokens: 10, cachedReadTokens: 50, outputTokens: 1 } }).input_tokens, 0, "never negative");
});

test("acp: fs/read_text_file goes past the floor first: a vault path is refused and its bytes never leave the disk", async t => {
  const w = world(t);
  const s = open(w);
  // Inside the session's folder: served.
  fs.writeFileSync(path.join(w.cwd, "note.txt"), "hello note");
  assert.equal(await s.say(`readfile ${path.join(w.cwd, "note.txt")}`), "read: hello note");
  // The vault: the floor's rule 8, not the folder check, and the value is never in the answer.
  const vault = await s.say(`readfile ${path.join(w.home, "vault", "secret.txt")}`);
  assert.match(vault, /^read failed: Vyre keeps vault values off every screen/);
  assert.ok(!vault.includes("the vault value"));
  await s.proc.stop(1000);
});

test("acp: files are confined to the session's folder, by real path, and never written through a link", async t => {
  const w = world(t);
  const s = open(w);
  const outside = path.join(SCRATCH, `acp-outside-${crypto.randomUUID().slice(0, 6)}.txt`);
  fs.writeFileSync(outside, "outside");
  t.after(() => fs.rmSync(outside, { force: true }));
  assert.match(await s.say(`readfile ${outside}`), /outside this session's folder/);
  assert.match(await s.say(`writefile ${outside} nope`), /outside this session's folder/);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  fs.symlinkSync(outside, path.join(w.cwd, "link.txt"));
  assert.match(await s.say(`readfile ${path.join(w.cwd, "link.txt")}`), /outside this session's folder/);
  assert.match(await s.say(`writefile ${path.join(w.cwd, "link.txt")} nope`), /not through a link/);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  assert.equal(await s.say(`writefile ${path.join(w.cwd, "made.txt")} fine`), "wrote");
  assert.equal(fs.readFileSync(path.join(w.cwd, "made.txt"), "utf8"), "fine");
  assert.match(await s.say("readfile relative/path"), /path must be absolute/);
  await s.proc.stop(1000);
});

test("acp: with no floor attached, file and shell access are off", async t => {
  const w = world(t, { floor: null });
  const s = open(w);
  fs.writeFileSync(path.join(w.cwd, "note.txt"), "hello note");
  assert.match(await s.say(`readfile ${path.join(w.cwd, "note.txt")}`), /no security floor/);
  assert.match(await s.say("term echo hi"), /no security floor/);
  await s.proc.stop(1000);
});

test("acp: terminal/create runs through the floor: a command that reads the vault is refused, an ordinary one runs in the folder", async t => {
  const w = world(t);
  const s = open(w);
  assert.match(await s.say("term pwd"), new RegExp(`^term: .*${path.basename(w.cwd)}$`));
  const bad = await s.say(`term cat ${path.join(w.home, "vault", "secret.txt")}`);
  assert.match(bad, /^term failed: Vyre keeps vault values off every screen/);
  assert.ok(!bad.includes("the vault value"));
  await s.proc.stop(1000);
});

test("acp: terminal/create with the whole command line in `command` and no args (Grok Build's shape) runs it by the shell, still through the floor", async t => {
  const w = world(t);
  const s = open(w);
  assert.match(await s.say("termline echo from-a-line && pwd"), /term: from-a-line\n/);
  assert.match(await s.say(`termline cat ${path.join(w.home, "vault", "secret.txt")}`), /term failed|denied|refus/i, "the floor still judges it");
  await s.proc.stop(500);
});

test("acp: a floor 'ask' on a client-side call reaches the person as can_use_tool and waits", async t => {
  const w = world(t, { floor: c => (c.tool === "Bash" && /deploy/.test(c.input.command) ? { decision: "ask", reason: "deploys ask" } : null) });
  const s = open(w);
  s.proc.write({ type: "user", message: { role: "user", content: "term echo deploy" } });
  const ask = await s.until(m => m.type === "control_request", "the floor's question");
  assert.equal(ask.request.tool_name, "Bash");
  s.proc.write({ type: "control_response", response: { request_id: ask.request_id, response: { behavior: "deny" } } });
  await s.until(m => m.type === "result", "the result");
  assert.match(s.got.filter(m => m.type === "stream_event").map(m => m.event.delta.text).join(""), /term failed: not allowed/);
  await s.proc.stop(1000);
});

test("acp: askFor maps ACP tool kinds onto the floor's tool names and inputs", () => {
  assert.deepEqual(askFor({ kind: "execute", title: "Run", rawInput: { command: "ls", args: ["-la"] } }), { name: "Bash", input: { command: "ls", args: ["-la"] } });
  assert.deepEqual(askFor({ kind: "edit", title: "Edit a.js", locations: [{ path: "/w/a.js" }] }), { name: "Write", input: { file_path: "/w/a.js" } });
  assert.equal(askFor({ kind: "read", rawInput: { path: "/w/b" } }).input.file_path, "/w/b");
  assert.equal(askFor({ kind: "think", title: "Thinking" }).name, "Thinking");
});

test("grok: the entry starts `grok agent stdio` without auto-update or always-approve, in the account's HOME", async t => {
  const { grokProvider } = await import("./grok.js");
  const w = world(t);
  // A stand-in `grok` that is the fake agent: the launch log shows the flags and HOME it got.
  const bin = path.join(w.store, "grok");
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  fs.chmodSync(bin, 0o755);
  w.provider = grokProvider({ bin, home: "/acct/2000", floor: () => null });
  const s = open(w);
  await s.until(m => m.type === "system" && m.subtype === "init", "init");
  await s.proc.stop(1000);
  const l = w.launches()[0];
  assert.deepEqual(l.launch, ["--no-auto-update", "agent", "stdio"]);
  assert.ok(!l.launch.includes("--always-approve"));
  assert.equal(l.home, "/acct/2000");
  assert.deepEqual(l.grokImports, ["0", "0"], "Grok does not import the person's Claude or Cursor MCP servers");
});

test("acp: Grok is given the Space's skills folder with agent --plugin-dir, between agent and stdio, only when there is one", async t => {
  const { grokProvider } = await import("./grok.js");
  const w = world(t);
  const bin = path.join(w.store, "grok");
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  fs.chmodSync(bin, 0o755);
  w.provider = grokProvider({ bin, home: "/acct/2000", floor: () => null });
  w.env.VYRE_SKILLS_DIR = "/lib/skills/abc";
  const s = open(w);
  await s.until(m => m.type === "system" && m.subtype === "init", "init");
  await s.proc.stop(1000);
  assert.deepEqual(w.launches()[0].launch, ["--no-auto-update", "agent", "--plugin-dir", "/lib/skills/abc", "stdio"]);
});

test("acp: an agent that starts in a bypass-shaped mode is moved to an ask mode, or the session does not run", async t => {
  const w = world(t);
  const a = open({ ...w, env: { ...w.env, FAKE_ACP_START_MODE: "bypassPermissions" } });
  t.after(() => a.proc.stop(1000));
  assert.match(await a.say("mode"), /default/, "it answers once pinned, in the ask mode");
  assert.ok(w.launches().some(l => l.set_mode === "default"), "set_mode to the ask mode was sent");
  const b = open({ ...w, env: { ...w.env, FAKE_ACP_START_MODE: "bypassPermissions", FAKE_ACP_NO_SETMODE: "1" } });
  t.after(() => b.proc.stop(1000));
  const r = await b.until(m => m.type === "result" && m.is_error, "the refusal");
  assert.match(r.result, /starts in a mode Vyre does not permit \(bypassPermissions\) and could not be moved to one it does; Vyre did not start it/);
});

test("acp: fs write and read never follow a link the agent put at the target after the check", async t => {
  const w = world(t);
  const outside = path.join(w.home, "vault", "secret.txt");
  fs.symlinkSync(outside, path.join(w.cwd, "link.txt"));
  const s = open(w);
  t.after(() => s.proc.stop(1000));
  const out = await s.say(`readfile ${path.join(w.cwd, "link.txt")}`);
  assert.doesNotMatch(out, /the vault value/);
  await s.say(`writefile ${path.join(w.cwd, "link.txt")} overwritten`);
  assert.equal(fs.readFileSync(outside, "utf8"), "the vault value", "the write did not go through the link");
});

test("acp: a seed file is written 0600 in the account's HOME at every start, replacing what the agent left; the provider key never reaches a terminal it runs", async t => {
  const { grokConfigToml } = await import("./grok.js");
  const w = world(t);
  const home = fs.mkdtempSync(path.join(SCRATCH, "acp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const toml = grokConfigToml({ id: "proof", model: "x-ai/grok-build-0.1", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY" });
  assert.match(toml, /env_key = "OPENROUTER_API_KEY"/);
  assert.ok(!/sk-/.test(toml), "no key in the file");
  assert.throws(() => grokConfigToml({ model: "m", baseUrl: "http://plain", envKey: "K" }), /https/);
  assert.throws(() => grokConfigToml({ model: "m", baseUrl: "https://x", envKey: "lower" }), /environment variable/);
  fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
  fs.writeFileSync(path.join(home, ".grok", "config.toml"), "always_approve = true\n");
  const provider = acpProvider({ id: "fake", bin: FAKE, seed: { ".grok/config.toml": toml }, secretEnv: ["SECRET_PROVIDER_KEY"], floor: c => rules({ tool: c.tool, input: c.input, cwd: c.cwd, home: w.home }) });
  const got = [];
  const proc = provider.run({ id: crypto.randomUUID(), resume: false, cwd: w.cwd, env: { ...w.env, HOME: home, SECRET_PROVIDER_KEY: "sk-secret-value" }, onSpawn() {}, onMessage: m => got.push(m), onExit() {} });
  t.after(() => proc.stop(1000));
  proc.write({ type: "user", message: { role: "user", content: "term printenv SECRET_PROVIDER_KEY" } });
  for (let i = 0; i < 200 && !got.some(m => m.type === "result"); i++) await new Promise(r => setTimeout(r, 30));
  const text = got.filter(m => m.type === "stream_event").map(m => m.event.delta.text || "").join("");
  assert.doesNotMatch(text, /sk-secret-value/, "a terminal the agent asked for does not hold the provider key");
  assert.equal(fs.readFileSync(path.join(home, ".grok", "config.toml"), "utf8"), toml, "replaced, not merged");
  assert.equal(fs.statSync(path.join(home, ".grok", "config.toml")).mode & 0o777, 0o600);
});

// Measured on the real codex-acp 2.0.1 and Grok Build 1.0.44 (proof-wire): session/new answers "Authentication required"
// (-32000) until authenticate {methodId}; codex offers api-key and chat-gpt, Grok offers grok.com.
test("acp: an agent that wants authenticate gets the entry's method, then session/new is tried again", async t => {
  const w = world(t, { authMethod: (methods, run) => (run.env.OPENAI_API_KEY ? methods.find(m => m.id === "api-key")?.id : methods.find(m => m.id === "chat-gpt")?.id) || null });
  const s = open(w, { env: { ...w.env, FAKE_ACP_AUTH: "ok", OPENAI_API_KEY: "sk-fake" } });
  const init = await s.until(m => m.type === "system" && m.subtype === "init", "init");
  assert.ok(init);
  assert.deepEqual(w.launches().filter(l => l.authenticate).map(l => l.authenticate), ["api-key"], "the key method, because a key is in the environment");
  assert.equal(await s.say("hello"), "echo: hello");
  await s.proc.stop(1000);
  const w2 = world(t, { authMethod: (methods, run) => (run.env.OPENAI_API_KEY ? "api-key" : "chat-gpt") });
  const s2 = open(w2, { env: { ...w2.env, FAKE_ACP_AUTH: "ok" } });
  await s2.until(m => m.type === "system" && m.subtype === "init", "init");
  assert.deepEqual(w2.launches().filter(l => l.authenticate).map(l => l.authenticate), ["chat-gpt"], "no key: the stored login");
  await s2.proc.stop(1000);
});

test("acp: an agent waiting for a browser sign-in, or one that refuses, or one with no usable method, says so plainly", async t => {
  const wait = world(t, { authMethod: () => "chat-gpt", authTimeoutMs: 300 });
  const a = open(wait, { env: { ...wait.env, FAKE_ACP_AUTH: "hang" } });
  const ra = await a.until(m => m.type === "result", "the failure");
  assert.match(ra.result, /Fake is waiting for a sign-in in a browser: sign this account in first/);
  const refuse = world(t, { authMethod: () => "api-key" });
  const b = open(refuse, { env: { ...refuse.env, FAKE_ACP_AUTH: "refuse" } });
  assert.match((await b.until(m => m.type === "result", "the refusal")).result, /Fake did not accept its sign-in \(sign-in refused\)/);
  const none = world(t, { authMethod: () => null });
  const c = open(none, { env: { ...none.env, FAKE_ACP_AUTH: "ok" } });
  assert.match((await c.until(m => m.type === "result", "no method")).result, /needs a sign-in and offers no way Vyre can use: api-key, chat-gpt/);
  // An agent with no authMethod in its entry keeps the old behaviour: the error is the agent's.
  const plain = world(t);
  const d = open(plain, { env: { ...plain.env, FAKE_ACP_AUTH: "ok" } });
  assert.match((await d.until(m => m.type === "result", "no hook")).result, /Authentication required/);
  for (const x of [a, b, c, d]) await x.proc.stop(500);
});

test("acp: a full-access mode is filtered like bypass (codex-acp offers agent-full-access), never offered and never the start mode", async t => {
  const w = world(t);
  const s = open(w);
  const init = await s.until(m => m.type === "system" && m.subtype === "init", "init");
  assert.ok(!init.modes.some(x => /full.?access|bypass/i.test(x)), JSON.stringify(init.modes));
  assert.ok(init.modes.includes("default"));
  await s.proc.stop(500);
});

test("codex entry: a custom endpoint goes through the gateway method, authenticated before any session exists, with its key only in the headers", async t => {
  const w = world(t);
  const provider = codexProvider({ bin: FAKE, custom: { id: "mockmodel", baseUrl: "http://127.0.0.1:9/v1", envKey: "MOCK_MODEL_KEY", model: "m" } });
  const got = [];
  const proc = provider.run({ id: crypto.randomUUID(), resume: false, cwd: w.cwd, env: { ...w.env, HOME: path.join(w.store, "h"), MOCK_MODEL_KEY: "sekret-value", FAKE_ACP_AUTH: "ok", FAKE_ACP_EXTRA_MODE: "workspace-write", FAKE_ACP_START_MODE: "workspace-write" }, onSpawn() {}, onMessage: m => got.push(m), onExit() {} });
  for (let i = 0; i < 200 && !got.find(m => m.type === "system"); i++) await new Promise(r => setTimeout(r, 30));
  assert.ok(got.find(m => m.type === "system" && m.subtype === "init"), JSON.stringify(got.slice(0, 2)));
  const launches = w.launches();
  assert.equal(launches[0].clientCaps.auth._meta.gateway, true, "the client says it supports the gateway method");
  assert.deepEqual(launches[0].launch, [], "no -c flags: they do not reach Codex");
  const au = launches.find(l => l.authenticate);
  assert.equal(au.authenticate, "gateway");
  assert.deepEqual(au.gateway, { baseUrl: "http://127.0.0.1:9/v1", headers: ["Authorization"], providerName: "mockmodel" });
  assert.equal(JSON.stringify(launches).includes("sekret-value"), false, "the key is in a header at the agent, never logged here or in the flags");
  await proc.stop(500);
});

test("codex entry: without a custom endpoint the API key method is used when a key is set, else the stored ChatGPT login", async t => {
  for (const [env, want] of [[{ OPENAI_API_KEY: "sk-fake" }, "api-key"], [{ CODEX_API_KEY: "sk-fake" }, "api-key"], [{}, "chat-gpt"]]) {
    const w = world(t);
    const p = codexProvider({ bin: FAKE });
    const got = [];
    const proc = p.run({ id: crypto.randomUUID(), resume: false, cwd: w.cwd, env: { ...w.env, HOME: path.join(w.store, "h"), FAKE_ACP_AUTH: "ok", FAKE_ACP_EXTRA_MODE: "agent", FAKE_ACP_START_MODE: "agent", OPENAI_API_KEY: "", CODEX_API_KEY: "", ...env }, onSpawn() {}, onMessage: m => got.push(m), onExit() {} });
    for (let i = 0; i < 200 && !got.find(m => m.type === "system"); i++) await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(w.launches().filter(l => l.authenticate).map(l => l.authenticate), [want], JSON.stringify(env));
    assert.equal(w.launches()[0].clientCaps.auth, undefined, "no gateway capability when there is no custom endpoint");
    await proc.stop(500);
  }
});

test("acp: modes are an allowlist: an unknown mode (a new release's) is never listed, never entered, and a start in one is moved or refused", async t => {
  const w = world(t);
  const s = open(w, { env: { ...w.env, FAKE_ACP_EXTRA_MODE: "turbo" } });
  const init = await s.until(m => m.type === "system" && m.subtype === "init", "init");
  assert.deepEqual(init.modes.sort(), ["default", "plan"], "only the permitted modes, not turbo, not bypass, not full access");
  await assert.rejects(() => s.proc.setMode("turbo"), /not available/);
  await assert.rejects(() => s.proc.setMode("agent-full-access"), /not available/);
  await s.proc.stop(500);
  // Starting in an unknown mode: moved to an ask mode.
  const w2 = world(t);
  const s2 = open(w2, { env: { ...w2.env, FAKE_ACP_EXTRA_MODE: "turbo", FAKE_ACP_START_MODE: "turbo" } });
  await s2.until(m => m.type === "system" && m.subtype === "init", "init");
  assert.ok(w2.launches().some(l => l.set_mode === "default"), "moved off turbo to default");
  await s2.proc.stop(500);
  // ...and refused when it cannot be moved.
  const w3 = world(t);
  const s3 = open(w3, { env: { ...w3.env, FAKE_ACP_EXTRA_MODE: "turbo", FAKE_ACP_START_MODE: "turbo", FAKE_ACP_NO_SETMODE: "1" } });
  assert.match((await s3.until(m => m.type === "result", "refused")).result, /starts in a mode Vyre does not permit \(turbo\) and could not be moved to one it does; Vyre did not start it/);
  // An entry can narrow the list.
  const w4 = world(t, { allowModes: /^plan$/ });
  const s4 = open(w4);
  assert.deepEqual((await s4.until(m => m.type === "system" && m.subtype === "init", "init")).modes, ["plan"]);
  await s4.proc.stop(500);
});

test("acp: an entry can pin the start mode on every start; one that offers none of the pinned modes does not run", async t => {
  const w = world(t, { pinMode: ["turbo", "plan"] });
  const s = open(w);
  const init = await s.until(m => m.type === "system" && m.subtype === "init", "init");
  assert.equal(init.mode, "plan", "turbo is not offered (and would not be permitted): the next on the list");
  assert.ok(w.launches().some(l => l.set_mode === "plan"), "set_mode sent, whatever the agent started in");
  await s.proc.stop(500);
  const w2 = world(t, { pinMode: ["agent"] });
  const s2 = open(w2);
  assert.match((await s2.until(m => m.type === "result", "refused")).result, /offers none of the modes Vyre starts it in \(agent\)/);
});

test("acp: what leaves for a person (an authenticate error, an open failure) has credential shapes and this run's secret values stripped", async t => {
  const secret = "s3cr3t-value-for-this-run";
  const shaped = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz0123"].join("-");   // a key-shaped string, built at runtime so no literal looks like a secret
  const w = world(t, { authMethod: () => "api-key", secretEnv: () => ["MY_KEY"] });
  const s = open(w, { env: { ...w.env, MY_KEY: secret, FAKE_ACP_AUTH: "refuse", FAKE_ACP_AUTH_ERR: `bad key ${secret} and ${shaped}` } });
  const r = (await s.until(m => m.type === "result", "the refusal")).result;
  assert.doesNotMatch(r, new RegExp(secret));
  assert.equal(r.includes(shaped), false);
  assert.match(r, /did not accept its sign-in \(bad key \[secret\]/);
});

test("codex entry: a custom endpoint with no key in the environment fails plainly, never with an empty Bearer", async t => {
  const w = world(t);
  const p = codexProvider({ bin: FAKE, custom: { id: "mockmodel", baseUrl: "http://127.0.0.1:9/v1", envKey: "MOCK_MODEL_KEY", model: "m" } });
  const got = [];
  const proc = p.run({ id: crypto.randomUUID(), resume: false, cwd: w.cwd, env: { ...w.env, HOME: path.join(w.store, "h"), FAKE_ACP_AUTH: "ok", FAKE_ACP_EXTRA_MODE: "agent", FAKE_ACP_START_MODE: "agent" }, onSpawn() {}, onMessage: m => got.push(m), onExit() {} });
  for (let i = 0; i < 200 && !got.find(m => m.type === "result"); i++) await new Promise(r => setTimeout(r, 30));
  assert.match(got.find(m => m.type === "result").result, /no key for mockmodel in the environment \(MOCK_MODEL_KEY\)/);
  assert.equal(w.launches().some(l => l.authenticate), false, "nothing was sent to the agent");
  await proc.stop(500);
});

test("acp: an agent that switches its own mode to an unlisted one is put back, or stopped; a listed switch is recorded", async t => {
  const w = world(t);
  const s = open(w, { env: { ...w.env, FAKE_ACP_EXTRA_MODE: "turbo" } });
  await s.until(m => m.type === "system" && m.subtype === "init", "init");
  assert.equal(await s.say("switchmode turbo"), "switched");
  await new Promise(r => setTimeout(r, 300));
  assert.ok(w.launches().some(l => l.set_mode === "default"), "set_mode back to the last listed mode");
  assert.equal(await s.say("mode"), "mode: default", "and the agent is in it");
  assert.equal(s.proc.mode, "default", "never recorded as turbo");
  assert.equal(await s.say("switchmode bypassPermissions"), "switched");
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await s.say("mode"), "mode: default", "a bypass switch is reverted too");
  // A listed switch is fine and recorded.
  await s.say("switchmode plan");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(s.proc.mode, "plan");
  await s.proc.stop(500);
  // It cannot be put back: the session is stopped with a plain reason.
  const w2 = world(t);
  const s2 = open(w2, { env: { ...w2.env, FAKE_ACP_EXTRA_MODE: "turbo", FAKE_ACP_NO_SETMODE: "1" } });
  await s2.until(m => m.type === "system" && m.subtype === "init", "init");
  s2.proc.write({ type: "user", message: { role: "user", content: "switchmode turbo" } });
  const r = await s2.until(m => m.type === "result" && m.is_error, "stopped");
  assert.match(r.result, /switched itself to a mode Vyre does not permit \(turbo\) and could not be put back; Vyre stopped it/);
});

test("acp: an entry's allowModes narrows the default allowlist and never widens it", async t => {
  const w = world(t, { allowModes: /.*/ });
  const s = open(w, { env: { ...w.env, FAKE_ACP_EXTRA_MODE: "turbo" } });
  const init = await s.until(m => m.type === "system" && m.subtype === "init", "init");
  assert.deepEqual(init.modes.sort(), ["default", "plan"], "match-everything still lists only the default allowlist");
  await s.proc.stop(500);
});

test("seedFiles: a symlinked folder or file on the way is refused or replaced, and nothing is written through a link", t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "seed-home-")), target = fs.mkdtempSync(path.join(SCRATCH, "seed-target-"));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true }); });
  seedFiles(home, { ".codex/config.toml": "a\n" });
  assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), "a\n");
  assert.equal(fs.statSync(path.join(home, ".codex", "config.toml")).mode & 0o777, 0o600);
  seedFiles(home, { ".codex/config.toml": "b\n" });
  assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), "b\n", "replaced at every start");
  // The agent plants ~/.codex as a link to a folder outside.
  fs.rmSync(path.join(home, ".codex"), { recursive: true });
  fs.symlinkSync(target, path.join(home, ".codex"));
  assert.throws(() => seedFiles(home, { ".codex/config.toml": "c\n" }), /is not a plain folder/);
  assert.deepEqual(fs.readdirSync(target), [], "nothing was written through the link");
  // The agent plants the file itself as a link to a file outside.
  fs.rmSync(path.join(home, ".codex"));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(target, "victim"), "keep");
  fs.symlinkSync(path.join(target, "victim"), path.join(home, ".codex", "config.toml"));
  seedFiles(home, { ".codex/config.toml": "d\n" });
  assert.equal(fs.readFileSync(path.join(target, "victim"), "utf8"), "keep", "the link target is untouched");
  assert.equal(fs.lstatSync(path.join(home, ".codex", "config.toml")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), "d\n");
});

test("mediaOf: Codex's image content block keeps its bytes and revised prompt, Grok's ImageGen result names the file under .grok, anything else is none", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const codex = { sessionUpdate: "tool_call_update", status: "completed", content: [{ type: "content", content: { type: "text", text: "Revised prompt: a red circle" } }, { type: "content", content: { type: "image", data: png, mimeType: "image/png", uri: "/h/.codex/generated_images/s/c.png" } }] };
  assert.deepEqual(mediaOf(codex), [{ mime: "image/png", data_b64: png, source: "content-block", prompt: "a red circle" }]);
  const grok = { sessionUpdate: "tool_call_update", status: "completed", rawInput: { variant: "ImageGen", prompt: "a heron" }, rawOutput: { type: "ImageGen", path: "/home/acct/2001/.grok/sessions/%2Fw/abc/images/1.jpg", filename: "1.jpg", session_folder: "images" } };
  assert.deepEqual(mediaOf(grok), [{ file: ".grok/sessions/%2Fw/abc/images/1.jpg", source: "file", prompt: "a heron" }]);
  assert.deepEqual(mediaOf({ content: [{ type: "content", content: { type: "image", data: png, mimeType: "text/html" } }] }), [], "not an image type");
  assert.deepEqual(mediaOf({ rawOutput: { type: "ImageGen", path: "/etc/passwd", session_folder: "images" } }), [], "not under .grok");
  assert.deepEqual(mediaOf({ content: [{ type: "content", content: { type: "text", text: "hi" } }] }), []);
});

test("acp: a tool call that finishes with a picture reaches the Switchboard as a tool_result with vyre_media, and the bytes are not in its text", async t => {
  const w = world(t);
  const s = open(w);
  await s.say("imagecodex");
  const res = s.got.find(m => m.type === "user" && m.message.content.some(b => b.type === "tool_result" && b.vyre_media));
  assert.ok(res, "a tool_result carried the media");
  const b = res.message.content.find(x => x.vyre_media);
  assert.equal(b.vyre_media[0].mime, "image/png");
  assert.equal(b.vyre_media[0].prompt, "a red circle");
  assert.ok(!String(b.content).includes("iVBOR"), "the bytes are not the text a model or a card reads");
  await s.proc.stop(500);
});

test("mediaOf over the real Grok video capture: exactly the video file is media, and the pictures the model only read are not", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "testing", "real", "media", "grok-video");
  const lines = fs.readFileSync(path.join(dir, "stream.ndjson"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  const found = [], prompts = new Map();
  let readImages = 0;
  for (const l of lines) {
    const u = l.msg && l.msg.params && l.msg.params.update;
    if (u && u.rawInput && u.rawInput.prompt && u.toolCallId) prompts.set(u.toolCallId, u.rawInput.prompt);
    if (!u || u.sessionUpdate !== "tool_call_update" || !(u.status === "completed" || u.status === "failed")) continue;
    if ((u.content || []).some(c => c && c.content && c.content.type === "image")) readImages++;
    const p = u.rawInput && u.rawInput.prompt; if (p) prompts.set(u.toolCallId, p);
    found.push(...mediaOf(u, prompts.get(u.toolCallId)));
  }
  assert.ok(readImages >= 2, "the capture has pictures the model read back");
  assert.equal(found.length, 1);
  assert.match(found[0].file, /^\.grok\/sessions\/[^/]+\/[^/]+\/videos\/1\.mp4$/);
  assert.equal(found[0].source, "file");
  assert.match(found[0].prompt, /red circle/);
  const mp4 = fs.readFileSync(path.join(dir, "video.mp4"));
  assert.equal(mp4.subarray(4, 8).toString("latin1"), "ftyp", "the captured video is a real mp4");
  assert.ok(mp4.length < 20 * 1024 * 1024);
});

test("acp: the init message carries the models the agent offers (id and label only) and the plan its sign-in named, never an email", async t => {
  const w = world(t, { authMethod: methods => methods.find(m => m.id === "chat-gpt")?.id || null });
  const s = open(w, { env: { ...w.env, FAKE_ACP_AUTH: "ok", FAKE_ACP_MODELS: "1", FAKE_ACP_PLAN: "SuperGrok" } });
  const init = await s.until(m => m.type === "system" && m.subtype === "init", "init");
  assert.deepEqual(init.models, [{ id: "m1", label: "Model 1" }, { id: "m2", label: "Model 2" }, { id: "c1", label: "Codex 1" }, { id: "c2", label: "Codex 2" }]);
  assert.equal(init.plan, "SuperGrok");
  assert.ok(!JSON.stringify(init).includes("someone@example.com"));
  assert.deepEqual(modelsOf({}), []);
  await s.proc.stop(500);
});

test("acp: a command's exit code arrives as data on the tool result, from Grok's rawOutput and Codex's terminal_exit", async t => {
  const w = world(t);
  const s = open(w);
  await s.say("exitcode");
  const done = s.got.filter(m => m.type === "user").flatMap(m => m.message.content).filter(b => b.type === "tool_result");
  assert.deepEqual(done.map(b => [b.tool_use_id, b.exit_code, b.is_error]), [["g1", 1, false], ["c1", 2, false]]);
  await s.proc.stop(500);
});
