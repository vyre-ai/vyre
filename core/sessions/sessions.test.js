// @ts-check
// Vyre-owned sessions (ADR 0030), end to end: vyred in a temp home, the fake `claude`
// (core/switchboard/testing/fake-claude.js), and every tool called as a surface calls it.
//
// The tests marked "sdk" run the real Claude Agent SDK against the fake. They need the pinned SDK
// installed somewhere (VYRE_SESSIONS_SDK_DIR, as on testbox) and are skipped without it, so the
// suite never downloads anything. Everything else runs on either driver.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present, writeModule } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { installed } from "./sdk.js";
import { optionsFor } from "./claude.js";
import { sessionsConfig } from "./config.js";
import { resume } from "../cli/commands/projects.js";
import { safePermissions, MODES, MIGRATIONS, purposeOf } from "../switchboard/index.js";
import { conform } from "./conformance.js";
import { claudeProvider } from "./providers.js";
import { load as loadSdk } from "./sdk.js";
import crypto from "node:crypto";
import { Sessions, shellCommand } from "../switchboard/sessions.js";
import { callerKind, callerAllowed } from "../modules/index.js";
import { open as openStore } from "../store/index.js";

const TINI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-tini.js");
fs.chmodSync(TINI, 0o755);

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);
const SDK = process.env.VYRE_SESSIONS_SDK_DIR || "";
const noSdk = !SDK || !installed(SDK) ? "the Agent SDK is not installed here (set VYRE_SESSIONS_SDK_DIR)" : false;

const until = async (fn, what, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 40));
  }
};

/**
 * A vyred in a temp home, on `driver`. `sessions` is config.json's sessions block; `vault` items
 * are put and granted to module threads (the box's own credential) unless `grant` is false.
 */
async function boot(t, { driver = "cli", sessions = {}, vault = {}, role = "box", modules = [] } = {}) {
  const root = tempHome(t);
  const log = path.join(root, "claude.log");
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG,
    VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, VYRE_SESSIONS_SDK_DIR: process.env.VYRE_SESSIONS_SDK_DIR, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, VYRE_SESSIONS_DRIVER: driver, FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  if (SDK) process.env.VYRE_SESSIONS_SDK_DIR = SDK;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role, transcripts: [transcripts],
    sessions: { install: false, ...sessions }, ...(Object.keys(vault).length ? { vault: { keystore: "file" } } : {}) }));
  // Internal tools answer only modules: a module that asks threads.pids for the test.
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.pids"] } }, `
    export default { async start(ctx) {
      ctx.tool("probe.pids", { input: { type: "object" }, run: async () => (await ctx.call("threads.pids", {})).data });
      return { async stop() {} };
    } };`);
  for (const m of modules) writeModule(path.join(root, "modules"), m.name, m.manifest, m.source);
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  // The work folder is outside the home: the security floor treats everything in VYRE_HOME as
  // Vyre's own state, as it does on a real machine.
  const work = fs.mkdtempSync(path.join(SCRATCH, "vyre-work-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const tool = (name, input, caller = "cli") => call(name, input, { root, caller, timeout: 20_000 });
  for (const [name, value] of Object.entries(vault)) {
    assert.ok((await tool("vault.put", { name, kind: name === "anthropic-api-key" ? "api-key" : "secret", fields: { value } })).data);
    assert.equal((await tool("vault.grant", { name, module: "threads" })).data.grant.status, "active");
  }
  const launches = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const events = async id => (await tool("threads.get", { thread: id, limit: 500 })).data.events;
  const finished = async (id, n = 1) => until(async () => (await events(id)).filter(e => e.type === "thread.finished").length >= n, `turn ${n} of ${id.slice(0, 8)}`);
  const said = async id => (await events(id)).filter(e => e.type === "thread.text" && e.payload.done && !e.payload.notice).map(e => e.payload.text);
  return { root, d, work, tool, launches, events, finished, said, transcripts };
}

/**
 * A session a terminal `claude` wrote, as an older Claude Code left it: a summary line, no
 * entrypoint, version 1.0.40. `ageMs` 0 is a session busy in a terminal right now.
 */
function terminalSession(transcripts, cwd, { ageMs = 120_000, id = crypto.randomUUID() } = {}) {
  const dir = path.join(transcripts, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const base = { sessionId: id, cwd, version: "1.0.40", userType: "external", isSidechain: false };
  fs.writeFileSync(file, [
    { type: "summary", summary: "Northwind Bakery menu", leafUuid: "u2" },
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: new Date(Date.now() - ageMs).toISOString(), message: { role: "user", content: "start the menu for Northwind Bakery" } },
    { ...base, type: "assistant", uuid: "u2", parentUuid: "u1", timestamp: new Date(Date.now() - ageMs).toISOString(),
      message: { id: "msg_old_1", role: "assistant", model: "claude-3-5-sonnet", content: [{ type: "text", text: "Started the menu." }] } },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, when, when);
  return { id, file };
}

// ------------------------------------------------------------ pure parts

test("config: the approved defaults per machine, and overrides", () => {
  const was = process.env.VYRE_SESSIONS_DRIVER;
  delete process.env.VYRE_SESSIONS_DRIVER;
  try {
    assert.deepEqual((({ auth, claude, idle_minutes, max_live }) => ({ auth, claude, idle_minutes, max_live }))(sessionsConfig({ role: "box" })),
      { auth: "setup-token", claude: "bundled", idle_minutes: 10, max_live: 6 });
    assert.deepEqual((({ auth, claude, max_live }) => ({ auth, claude, max_live }))(sessionsConfig({ role: "local" })), { auth: "login", claude: "installed", max_live: 0 });
    const c = sessionsConfig({ role: "box", sessions: { driver: "sdk", auth: "api-key", idle_minutes: 0, max_live: 2, claude: "/opt/claude" } });
    assert.deepEqual([c.driver, c.auth, c.idle_minutes, c.max_live, c.claude], ["sdk", "api-key", 0, 2, "/opt/claude"]);
    assert.equal(sessionsConfig({ role: "box", sessions: { auth: "nonsense", idle_minutes: -1 } }).auth, "setup-token");
  } finally { if (was !== undefined) process.env.VYRE_SESSIONS_DRIVER = was; }
});

test("sdk options: the same launch the CLI runner turns into flags", () => {
  const base = { id: "11111111-2222-3333-4444-555555555555", cwd: "/w", env: {} };
  const o = optionsFor({ ...base, plugin: "/h", plugins: ["/l"], model: "m", name: "Intake", system: { mode: "append", text: "Your name is juno." }, budgetUsd: 2, bin: "/c" });
  assert.equal(o.sessionId, base.id);
  assert.deepEqual(o.systemPrompt, { type: "preset", preset: "claude_code", append: "Your name is juno." });
  assert.deepEqual(o.plugins, [{ type: "local", path: "/h" }, { type: "local", path: "/l" }]);
  assert.deepEqual([o.model, o.maxBudgetUsd, o.pathToClaudeCodeExecutable, o.extraArgs.name], ["m", 2, "/c", "Intake"]);
  assert.deepEqual(o.settingSources, ["user", "project", "local"]);
  const r = optionsFor({ ...base, resume: true, system: { mode: "replace", text: "Only this." }, tools: "none", settings: false });
  assert.equal(r.resume, base.id);
  assert.equal(r.sessionId, undefined);
  assert.equal(r.systemPrompt, "Only this.");
  assert.deepEqual([r.tools, r.strictMcpConfig, r.settingSources, r.extraArgs], [[], true, [], undefined]);
});

test("modes: an answer never hands back bypassPermissions, and a person picks only default, acceptEdits or plan", () => {
  assert.deepEqual(MODES, ["default", "acceptEdits", "plan"]);
  const offered = [{ type: "setMode", mode: "bypassPermissions", destination: "session" }, { type: "setMode", mode: "acceptEdits", destination: "session" },
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }, { type: "setMode", mode: "dontAsk" }, null];
  assert.deepEqual(safePermissions(offered).map(x => x.mode || x.type), ["acceptEdits", "addRules"]);
});

test("bind: on Linux the hook's parent is dash's `sh -c`, and the claude above it is bound", t => {
  const root = tempHome(t);
  const db = openStore(path.join(root, "vyre.db"));
  t.after(() => db.close());
  db.exec(MIGRATIONS[1]);
  const procs = { 300: { ppid: 200, args: "/bin/sh -c node /opt/vyre/harness/hooks/run.js brief" }, 200: { ppid: 1, args: "/usr/bin/claude" },
    400: { ppid: 1, args: "/bin/sh -c sleep 5" }, 500: { ppid: 300, args: "node run.js" } };
  const s = new Sessions(db, { children: () => [], alive: pid => Boolean(procs[pid]), isClaude: pid => procs[pid] && procs[pid].args === "/usr/bin/claude",
    proc: pid => procs[pid] || null });
  const b = s.bind("11111111-2222-3333-4444-555555555555", 300);
  assert.equal(b.pid, 200, "the claude above the shell");
  assert.equal(s.boundPid("11111111-2222-3333-4444-555555555555"), 200);
  assert.throws(() => s.bind("22222222-2222-3333-4444-555555555555", 400), /not a running claude/, "a shell under no claude");
  assert.throws(() => s.bind("33333333-2222-3333-4444-555555555555", 500), /not a running claude/, "only a shell is walked past");
  assert.ok(shellCommand("/bin/sh -c x") && shellCommand("dash -c x") && !shellCommand("/bin/sh script.sh"));
});

test("callers: a Vyre-owned session's MCP caller is an mcp caller, like an agent's", () => {
  assert.equal(callerKind("mcp:thread:0f3a-11"), "mcp");
  assert.equal(callerKind("mcp:agent:juno"), "mcp");
  assert.equal(callerAllowed(["cli", "mcp"], "mcp:thread:0f3a-11"), true);
  assert.equal(callerAllowed(["cli", "deck"], "mcp:thread:0f3a-11"), false);
});

test("models: Opus for real work, the fast model for quick answers and jobs; purpose from the launch", () => {
  assert.equal(purposeOf({}, null), "chat");
  assert.equal(purposeOf({}, "harlow-legal"), "project");
  assert.equal(purposeOf({ agent: "kit" }, null), "agent");
  assert.equal(purposeOf({ lean: true }, null), "job");
  assert.equal(purposeOf({ once: true, tools: "none" }, "harlow-legal"), "job");
  assert.equal(purposeOf({ purpose: "capsule", lean: true }, null), "capsule");
});

test("conformance: the CLI runner passes the provider contract", async t => {
  const cwd = fs.mkdtempSync(path.join(SCRATCH, "vyre-conform-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const fails = await conform(claudeProvider({ sdk: null, bin: FAKE }), { id: crypto.randomUUID(), cwd, env: { ...process.env } });
  assert.deepEqual(fails, []);
});

test("conformance: the Agent SDK driver passes the provider contract", { skip: noSdk }, async t => {
  const cwd = fs.mkdtempSync(path.join(SCRATCH, "vyre-conform-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const module = await loadSdk(SDK);
  const fails = await conform(claudeProvider({ sdk: { module, bin: null }, bin: FAKE }), { id: crypto.randomUUID(), cwd, env: { ...process.env } });
  assert.deepEqual(fails, []);
});

test("providers: a module adds one through its manifest, with no core change, and a session runs on it", async t => {
  const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "switchboard", "runner.js");
  const w = await boot(t, { modules: [{ name: "echo-provider", manifest: { does: { providers: ["echo"] } }, source: `
    import { argsFor, run } from ${JSON.stringify(runner)};
    export default { async start(ctx) {
      ctx.provider("echo", { id: "echo", capabilities: { streaming: true }, run: o => run({ ...o, bin: ${JSON.stringify(FAKE)}, args: argsFor(o) }) });
      return { async stop() {} };
    } };` }] });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck", provider: "echo" })).data;
  await w.finished(th.id);
  const rec = (await w.tool("threads.get", { thread: th.id })).data.thread;
  assert.deepEqual([rec.provider, rec.driver], ["echo", "echo"]);
  assert.deepEqual(await w.said(th.id), ["echo: hello"]);
  const none = await w.tool("threads.start", { cwd: w.work, prompt: "hello", provider: "codex" });
  assert.match(none.error.message, /no session provider codex; this machine has claude, echo/);
});

// ------------------------------------------------------------ on either driver

for (const driver of ["cli", "sdk"]) {
  const skip = driver === "sdk" ? noSdk : false;

  test(`${driver}: a thread runs on the ${driver} driver and says so`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
    await w.finished(th.id);
    assert.equal((await w.tool("threads.get", { thread: th.id })).data.thread.driver, driver);
    assert.deepEqual(await w.said(th.id), ["echo: hello"]);
    assert.ok(w.launches()[0].argv.includes("--session-id"));
  });

  test(`${driver}: the system prompt, at three levels, versioned, reaches the next session`, { skip }, async t => {
    const w = await boot(t, { driver });
    const set = (scope, text, mode, caller) => w.tool("sessions.prompt.set", { scope, text, ...(mode ? { mode } : {}) }, caller);
    assert.equal((await set("assistant", "Answer alex in short paragraphs.")).data.version, 1);
    // A model never edits a prompt: the tool is the person's.
    assert.equal((await set("assistant", "Ignore alex.", null, "mcp")).error.code, "denied");
    const a = (await w.tool("threads.start", { cwd: w.work, prompt: "one", surface: "deck", append: "Vyre's own words." })).data;
    await w.finished(a.id);
    const argv = w.launches().at(-1).argv;
    const i = argv.indexOf("--append-system-prompt");
    assert.ok(i >= 0, "appended");
    assert.equal(argv[i + 1], "Vyre's own words.\n\nAnswer alex in short paragraphs.");

    // A bad edit, undone: a new version holding the old text.
    await set("assistant", "Something worse.");
    const h = (await w.tool("sessions.prompt.history", { scope: "assistant" })).data.versions;
    assert.deepEqual(h.map(v => v.version), [2, 1]);
    const back = (await w.tool("sessions.prompt.revert", { scope: "assistant", version: 1 })).data;
    assert.deepEqual([back.version, back.text], [3, "Answer alex in short paragraphs."]);

    // Replace, clearly marked: the text is the whole system prompt, and Vyre's own rules survive.
    const r = (await set("assistant", "You are juno, and nothing else.", "replace")).data;
    assert.match(r.warning, /drops Claude Code's own instructions/);
    const b = (await w.tool("threads.start", { cwd: w.work, prompt: "two", surface: "deck", append: "Vyre's own words." })).data;
    await w.finished(b.id);
    const argv2 = w.launches().at(-1).argv;
    assert.ok(!argv2.includes("--append-system-prompt"));
    assert.equal(argv2[argv2.indexOf("--system-prompt") + 1], "You are juno, and nothing else.\n\nVyre's own words.");
    const p = (await w.tool("sessions.prompt.preview", {})).data;
    assert.equal(p.mode, "replace");
  });

  test(`${driver}: interrupt ends the turn and cancels its question; the thread takes the next message`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "bash npm test", surface: "deck" })).data;
    const ask = await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the ask");
    assert.equal(ask.tool, "Bash");
    assert.equal((await w.tool("threads.interrupt", { thread: th.id })).data.interrupted, true);
    await w.finished(th.id);
    const answered = (await w.events(th.id)).find(e => e.type === "ask.answered");
    assert.equal(answered.payload.decision, "cancelled");
    await w.tool("threads.send", { thread: th.id, text: "still here", surface: "deck" });
    await w.finished(th.id, 2);
    assert.ok((await w.said(th.id)).includes("echo: still here"));
  });

  test(`${driver}: an idle session is closed and comes back on the next message`, { skip }, async t => {
    const w = await boot(t, { driver, sessions: { idle_minutes: 0.02 } });           // 1.2 s
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
    await w.finished(th.id);
    await w.tool("threads.release", { thread: th.id, surface: "deck" });
    const stopped = await until(async () => (await w.events(th.id)).find(e => e.type === "thread.stopped"), "the idle close");
    assert.equal(stopped.payload.reason, "idle");
    await w.tool("threads.send", { thread: th.id, text: "back", surface: "deck" });
    await w.finished(th.id, 2);
    assert.ok((await w.said(th.id)).includes("echo: back"));
    const resumed = w.launches().at(-1).argv;
    assert.equal(resumed[resumed.indexOf("--resume") + 1], th.id, "resumed, same session");
  });

  test(`${driver}: the cap closes the longest-idle session to make room, and refuses when all are busy`, { skip }, async t => {
    const w = await boot(t, { driver, sessions: { max_live: 1 } });
    const a = (await w.tool("threads.start", { cwd: w.work, prompt: "hello" })).data;
    await w.finished(a.id);
    // Someone at its keyboard keeps a session open; nobody is.
    await w.tool("threads.release", { thread: a.id });
    const b = (await w.tool("threads.start", { cwd: w.work, prompt: "bash npm test" })).data;
    assert.ok(b.id, "made room");
    const gone = await until(async () => (await w.events(a.id)).find(e => e.type === "thread.stopped"), "a closed");
    assert.equal(gone.payload.reason, "idle");
    await until(async () => (await w.tool("threads.asks", { thread: b.id })).data[0], "b asks");
    const c = await w.tool("threads.start", { cwd: w.work, prompt: "hello" });
    assert.equal(c.error.code, "busy");
    assert.match(c.error.message, /sessions\.max_live/);
  });

  test(`${driver}: the box's own credential: the vault's setup token, the API key behind it`, { skip }, async t => {
    const w = await boot(t, { driver, sessions: { auth: "setup-token" },
      vault: { "claude-setup-token": "fake-setup-value", "anthropic-api-key": "fake-api-value" } });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "whoami", surface: "deck" })).data;
    await w.finished(th.id);
    assert.deepEqual(await w.said(th.id), ["auth=subscription"]);
    assert.equal((await w.tool("threads.get", { thread: th.id })).data.thread.auth, "subscription");
    // The limit: the thread goes on under the API key, resumed.
    await w.tool("threads.send", { thread: th.id, text: "limit", surface: "deck" });
    await until(async () => (await w.tool("threads.get", { thread: th.id })).data.thread.auth === "api-key", "the fallback");
    const all = JSON.stringify(await w.events(th.id));
    assert.ok(!all.includes("fake-setup-value") && !all.includes("fake-api-value"), "no credential reaches an event");
  });

  test(`${driver}: from inside a session, a person-only call is refused, even claiming to be the CLI`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "forge cli sessions.prompt.set", surface: "deck" })).data;
    await w.finished(th.id);
    await w.tool("threads.send", { thread: th.id, text: "forge cli threads.answer", surface: "deck" });
    await w.finished(th.id, 2);
    const [edit, answer] = await w.said(th.id);
    for (const r of [edit, answer]) assert.match(r, /^403 .*denied/, r);
    assert.equal((await w.tool("sessions.prompt.get", { scope: "assistant" })).data.prompt, null, "nothing was set");
  });

  test(`${driver}: open in terminal hands an idle session over to claude --resume, and a busy one is left alone`, { skip }, async t => {
    const w = await boot(t, { driver });
    const bin = path.join(w.root, "fakebin");
    fs.mkdirSync(bin);
    const calls = path.join(w.root, "terminal.jsonl");
    fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`, { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = bin + path.delimiter + PATH;
    t.after(() => { process.env.PATH = PATH; });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "bash npm test", surface: "deck" })).data;
    await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the ask");
    assert.notEqual(await resume({ id: th.id, label: "Intake", cwd: w.work }), 0, "a session waiting on a question is not taken");
    assert.ok(!fs.existsSync(calls));
    await w.tool("threads.interrupt", { thread: th.id });
    await w.finished(th.id);
    assert.equal(await resume({ id: th.id, label: "Intake", cwd: w.work }), 0);
    const argv = JSON.parse(fs.readFileSync(calls, "utf8").trim());
    assert.deepEqual(argv.slice(0, 2), ["--resume", th.id]);
    assert.equal((await w.tool("threads.get", { thread: th.id })).data.thread.status, "stopped", "vyred let go of it first");
  });

  test(`${driver}: the floor refuses a session's write to its own permission settings before anyone is asked`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "settings", surface: "deck" })).data;
    await w.finished(th.id);
    assert.equal((await w.events(th.id)).filter(e => e.type === "ask.raised").length, 0, "nobody was asked");
    assert.ok(!fs.existsSync(path.join(w.work, ".claude", "settings.local.json")), "nothing was written");
    const said = (await w.events(th.id)).filter(e => e.type === "thread.text" && e.payload.done).map(e => e.payload.text);
    assert.ok(said.some(x => /^Refused Write: Claude Code's permission and settings files are changed by the person/.test(x)), said.join(" | "));
    assert.ok(said.includes("I was not allowed to."));
  });

  test(`${driver}: only a person changes a session's mode, and never to bypassPermissions`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
    await w.finished(th.id);
    const r = (await w.tool("threads.mode", { thread: th.id, mode: "acceptEdits" }, "deck")).data;
    assert.deepEqual(r, { thread: th.id, mode: "acceptEdits" });
    await until(() => w.launches().some(l => l.mode === "acceptEdits"), "the mode to reach Claude Code");
    assert.ok((await w.events(th.id)).some(e => e.type === "mode.changed" && e.payload.mode === "acceptEdits"));
    assert.ok((await w.tool("threads.mode", { thread: th.id, mode: "bypassPermissions" })).error, "bypass is not offered");
    for (const caller of ["mcp", "mcp:agent:juno", "mcp:thread:abc", "harness"]) assert.equal((await w.tool("threads.mode", { thread: th.id, mode: "plan" }, caller)).error.code, "denied", caller);
    await w.tool("threads.send", { thread: th.id, text: "forge cli threads.mode", surface: "deck" });
    await w.finished(th.id, 2);
    assert.match((await w.said(th.id)).at(-1), /^403 .*denied/, "from inside the session, even as the CLI");
  });

  test(`${driver}: sessions run under the subreaper, and their group is reported until the last process in it is gone`, { skip }, async t => {
    const w = await boot(t, { driver, sessions: { subreaper: TINI } });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
    await w.finished(th.id);
    const launch = w.launches().find(l => l.argv);
    const pids = (await w.tool("probe.pids", {})).data;
    assert.ok(pids.pids.includes(launch.ppid), "the subreaper's pid is a session pid");
    assert.ok(pids.pgids.includes(launch.ppid) && pids.sids.includes(launch.ppid), "its group and session are reported");
    // A process left in the group outlives the session: the group is still reported.
    await w.tool("threads.send", { thread: th.id, text: "orphan", surface: "deck" });
    await until(async () => (await w.events(th.id)).some(e => e.type === "thread.stopped"), "the session to end");
    const after = (await w.tool("probe.pids", {})).data;
    assert.ok(!after.pids.includes(launch.ppid), "the session itself is gone");
    assert.ok(after.pgids.includes(launch.ppid), "its group is still reported while the orphan runs");
    await until(async () => !(await w.tool("probe.pids", {})).data.pgids.includes(launch.ppid), "the group to end", 10_000);
  });

  test(`${driver}: the model comes from the purpose map, a project override and an agent, and the chip says it`, { skip }, async t => {
    const w = await boot(t, { driver, sessions: { models: { capsule: "claude-haiku-4-5" } } });
    const a = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
    await w.finished(a.id);
    const started = (await w.events(a.id)).find(e => e.type === "thread.started").payload;
    assert.deepEqual([started.provider, started.model, started.purpose, started.auth], ["claude", "opus", "chat", "ambient"]);
    assert.equal(w.launches().at(-1).argv[w.launches().at(-1).argv.indexOf("--model") + 1], "opus");
    const q = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", lean: true, purpose: "capsule" })).data;
    assert.equal(q.model, "claude-haiku-4-5", "config overrides a purpose");
    const job = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", lean: true })).data;
    assert.equal(job.model, "haiku", "a lean thread is a job, on the fast model");
    assert.ok(!(await w.tool("projects.create", { name: "Harlow Legal", home: w.work })).error);
    assert.equal((await w.tool("sessions.models.set", { scope: "project:harlow-legal", model: "sonnet" })).data.model, "sonnet");
    assert.equal((await w.tool("sessions.models.set", { scope: "project:harlow-legal", model: "opus" }, "mcp")).error.code, "denied", "a model never picks models");
    const p = (await w.tool("threads.start", { project: "harlow-legal", prompt: "hello" })).data;
    assert.equal(p.model, "sonnet");
    const e = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", model: "haiku" })).data;
    assert.equal(e.model, "haiku", "an explicit model wins");
    const map = (await w.tool("sessions.models.get", {})).data;
    assert.deepEqual([map.purposes.chat.model, map.purposes.memory.model, map.purposes.capsule.model, map.projects["harlow-legal"]], ["opus", "haiku", "claude-haiku-4-5", "sonnet"]);
  });

  test(`${driver}: a session a terminal started, by an older Claude Code, is resumed through Vyre on the first message, once in the list`, { skip }, async t => {
    const w = await boot(t, { driver });
    const old = terminalSession(w.transcripts, w.work);
    const r = (await w.tool("threads.send", { thread: old.id, text: "carry on", surface: "deck" })).data;
    assert.deepEqual(r, { sent: true, thread: old.id });
    await w.finished(old.id);
    const rec = (await w.tool("threads.get", { thread: old.id })).data.thread;
    assert.deepEqual([rec.driver, rec.cwd], [driver, w.work], "resumed by Vyre, in the transcript's own folder");
    const argv = w.launches().at(-1).argv;
    assert.equal(argv[argv.indexOf("--resume") + 1], old.id);
    assert.deepEqual(await w.said(old.id), ["echo: carry on"]);
    const lines = fs.readFileSync(old.file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(lines[0].type, "summary", "the old lines are kept as they were");
    assert.ok(lines.some(l => l.type === "user" && l.message.content === "carry on"), "the new turn is in the same transcript");
    // One row per session, and the live text keys to the transcript's own message id.
    assert.equal((await w.tool("threads.list", {})).data.filter(x => x.id === old.id).length, 1);
    const live = (await w.events(old.id)).find(e => e.type === "thread.text" && e.payload.done).payload.message;
    assert.ok(lines.some(l => l.type === "assistant" && l.message.id === live), "live and history share the message id");
  });

  test(`${driver}: a session live in a terminal is queued, never typed into, and a fork carries on as a copy`, { skip }, async t => {
    const w = await boot(t, { driver });
    const busy = terminalSession(w.transcripts, w.work, { ageMs: 0 });
    const before = fs.readFileSync(busy.file, "utf8");
    const q = (await w.tool("threads.send", { thread: busy.id, text: "add the autumn specials", surface: "deck" })).data;
    assert.equal(q.queued, true);
    assert.equal(q.busy, "terminal");
    assert.ok(!w.launches().some(l => l.argv && l.argv.includes(busy.id)), "no second writer was started");
    const f = (await w.tool("threads.fork", { thread: busy.id, prompt: "from here", surface: "deck" })).data;
    assert.notEqual(f.id, busy.id);
    await w.finished(f.id);
    const argv = w.launches().at(-1).argv;
    assert.equal(argv[argv.indexOf("--resume") + 1], busy.id);
    assert.ok(argv.includes("--fork-session"));
    assert.equal(argv[argv.indexOf("--session-id") + 1], f.id);
    assert.equal((await w.events(f.id)).find(e => e.type === "thread.started").payload.forked_from, busy.id);
    assert.deepEqual(await w.said(f.id), ["echo: from here"]);
    assert.equal(fs.readFileSync(busy.file, "utf8"), before, "the original transcript is untouched");
    const copy = fs.readFileSync(path.join(path.dirname(busy.file), `${f.id}.jsonl`), "utf8");
    assert.match(copy, /start the menu for Northwind Bakery/, "the fork starts with the conversation so far");
  });

  test(`${driver}: on a Mac, Claude Code's own login`, { skip }, async t => {
    const w = await boot(t, { driver, role: "local" });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "whoami", surface: "deck" })).data;
    await w.finished(th.id);
    assert.deepEqual(await w.said(th.id), ["auth=ambient"]);
  });
}
