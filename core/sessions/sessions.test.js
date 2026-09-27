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
import { tempHome, present } from "../../test/helpers.js";
import { installed } from "./sdk.js";
import { optionsFor } from "./claude.js";
import { sessionsConfig } from "./config.js";

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
async function boot(t, { driver = "cli", sessions = {}, vault = {}, role = "box" } = {}) {
  const root = tempHome(t);
  const log = path.join(root, "claude.log");
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG,
    VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, VYRE_SESSIONS_SDK_DIR: process.env.VYRE_SESSIONS_SDK_DIR };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, VYRE_SESSIONS_DRIVER: driver });
  if (SDK) process.env.VYRE_SESSIONS_SDK_DIR = SDK;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role, transcripts: [transcripts],
    sessions: { install: false, ...sessions }, ...(Object.keys(vault).length ? { vault: { keystore: "file" } } : {}) }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const work = fs.mkdtempSync(path.join(root, "work-"));
  const tool = (name, input, caller = "cli") => call(name, input, { root, caller, timeout: 20_000 });
  for (const [name, value] of Object.entries(vault)) {
    assert.ok((await tool("vault.put", { name, kind: name === "anthropic-api-key" ? "api-key" : "secret", fields: { value } })).data);
    assert.equal((await tool("vault.grant", { name, module: "threads" })).data.grant.status, "active");
  }
  const launches = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const events = async id => (await tool("threads.get", { thread: id, limit: 500 })).data.events;
  const finished = async (id, n = 1) => until(async () => (await events(id)).filter(e => e.type === "thread.finished").length >= n, `turn ${n} of ${id.slice(0, 8)}`);
  const said = async id => (await events(id)).filter(e => e.type === "thread.text" && e.payload.done && !e.payload.notice).map(e => e.payload.text);
  return { root, d, work, tool, launches, events, finished, said };
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

  test(`${driver}: on a Mac, Claude Code's own login`, { skip }, async t => {
    const w = await boot(t, { driver, role: "local" });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "whoami", surface: "deck" })).data;
    await w.finished(th.id);
    assert.deepEqual(await w.said(th.id), ["auth=ambient"]);
  });
}
