// @ts-check
// The generic ACP driver against a fake ACP agent (core/sessions/testing/fake-acp.js): conform()'s
// whole scenario including the fixed safety set, bypass-shaped modes filtered, the client's fs and
// terminal methods held to the floor and to the session's folder, and the per-provider hooks.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../../test/helpers.js";
import { SCRATCH } from "../../../test/scratch.mjs";
import { conform } from "../conformance.js";
import { rules } from "../../harness/rules.js";
import { acpProvider, askFor } from "./acp.js";

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
  assert.equal(await s.say("where is the site hosted"), "echo: VYRE-PROMPTBRIEFwhere is the site hosted", "the system prompt, then memory, then the person's words");
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
  assert.match(r.result, /is set to approve everything; Vyre did not start it/);
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
  const toml = grokConfigToml({ id: "proof", model: "x-ai/grok-code-fast-1", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY" });
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
