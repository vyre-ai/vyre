// @ts-check
// Codex and Grok on a subscription login run with no inference door connected (the daemon never connects one): the vendor's own CLI reaches its own model with the person's own sign-in, the prompt is scrubbed of
// credentials on its way in, and the session is still Vyre's (the Switchboard's transcript, the Gate on the agent's tools, recall of the turn). An API-key driver still needs the door (lib/door-bridge.test.js).
// This file leaves VYRE_LEGACY_DIRECT_MODEL unset on purpose: the other session tests set it, which is what hid this.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot, until } from "./testing/boot.js";
import { loginDirect, throughDoor } from "../../lib/door-bridge.js";

delete process.env.VYRE_LEGACY_DIRECT_MODEL;

/** memory.prompt answers nothing here: the echoes below are then exactly what the person sent. */
const noMemoryBlocks = w => {
  const realCall = w.d.registry.call.bind(w.d.registry);
  w.d.registry.call = async (tool, input, caller, meta) => tool === "memory.prompt" ? { data: { text: "", blocks: [] } } : realCall(tool, input, caller, meta);
};

const KEY = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";

/** A stand-in `grok` and `codex-acp` first on PATH: the fake ACP agent, its sessions kept in a folder. */
const withAcp = (t, w) => {
  const bin = path.join(w.root, "shim");
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp.js");
  for (const name of ["grok", "codex-acp"]) fs.symlinkSync(fake, path.join(bin, name));
  const saved = { PATH: process.env.PATH, FAKE_ACP_STORE: process.env.FAKE_ACP_STORE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACP_STORE = path.join(w.root, "acp-store");
  fs.mkdirSync(process.env.FAKE_ACP_STORE, { recursive: true });
  // Codex starts in "agent" and Vyre moves it to "workspace-write" (drivers/codex.js).
  Object.assign(process.env, { FAKE_ACP_EXTRA_MODE: "workspace-write", FAKE_ACP_START_MODE: "agent" });
  t.after(() => { for (const k of ["FAKE_ACP_EXTRA_MODE", "FAKE_ACP_START_MODE"]) delete process.env[k]; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
};

for (const provider of ["grok", "codex"]) {
  test(`${provider}: a turn on a login account answers with no door connected, Vyre's Gate still holds a send with a key, and the turns are in Vyre's own record`, async t => {
    const w = await boot(t, { driver: "cli" });
    noMemoryBlocks(w);
    withAcp(t, w);
    assert.equal((await w.tool("sessions.accounts.add", { provider, label: "Mine", kind: "login" })).error, undefined);
    const th = (await w.tool("threads.start", { cwd: w.work, provider, prompt: "hello", surface: "deck" })).data;
    await w.finished(th.id);
    assert.deepEqual(await w.said(th.id), ["echo: hello"], `the turn answered instead of refusing for want of a door: ${JSON.stringify((await w.events(th.id)).map(e => [e.type, String(e.payload && (e.payload.text || e.payload.reason || e.payload.error || "")).slice(0, 90)]))}`);
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "and the prices", surface: "deck" })).error, undefined);
    await w.finished(th.id, 2);
    assert.deepEqual(await w.said(th.id), ["echo: hello", "echo: and the prices"]);
    // A send that carries a key is held by Vyre's Gate before the CLI hears it: the session is Vyre's, not the vendor's.
    assert.equal((await w.tool("threads.send", { thread: th.id, text: `use this key ${KEY} for the build`, surface: "deck" })).error, undefined);
    await until(async () => (await w.events(th.id)).some(e => e.type === "gate.held"), "the Gate to hold the send");
    assert.ok(!(await w.said(th.id)).some(x => x.includes(KEY)), "the key never reached the CLI");
    // Vyre owns the session: the row, the provider and both turns are in its own record.
    const rec = (await w.tool("threads.get", { thread: th.id })).data;
    assert.equal(rec.thread.provider, provider);
    assert.equal((await w.events(th.id)).filter(e => e.type === "thread.finished").length, 2);
    await w.tool("recall.index", {});
    const found = await w.tool("recall.search", { q: "prices" });
    assert.equal(found.error, undefined, JSON.stringify(found.error));
    assert.ok(JSON.stringify(found.data).includes("prices"), `recall finds the turn afterwards: ${JSON.stringify(found.data).slice(0, 300)}`);
  });
}

test("grok: an agent's request to use a tool reaches Vyre's Gate and is answered, not dropped", async t => {
  const w = await boot(t, { driver: "cli" });
  withAcp(t, w);
  const th = (await w.tool("threads.start", { cwd: w.work, provider: "grok", prompt: "mcpask", surface: "deck" })).data;
  await until(async () => (await w.events(th.id)).some(e => e.type === "thread.finished" || /approval|ask/.test(e.type)), "the agent's tool request to be seen");
  const types = (await w.events(th.id)).map(e => e.type);
  assert.ok(types.some(x => /^thread\.(ask|approval|tool|finished)/.test(x)), types.join(","));
});

test("an API-key driver still needs the door; a login CLI does not; with a door both go through it", async () => {
  const ran = [];
  const provider = { id: "p", run(o) { ran.push("ran"); return { pid: 1, alive: true, write: m => ran.push(m), interrupt: async () => {}, stop: async () => {} }; } };
  const got = [];
  // No door: the through-the-door wrapper refuses and starts nothing; the login wrapper runs.
  throughDoor(provider, {}).run({ id: "t", onMessage: m => got.push(m), onExit() {} });
  await new Promise(r => setImmediate(r));
  assert.equal(ran.length, 0);
  assert.match(String(got[0] && got[0].result), /inference door/);
  const h = loginDirect(provider, {}).run({ id: "t2", onMessage() {}, onExit() {} });
  assert.deepEqual(ran, ["ran"]);
  h.write({ type: "user", message: { role: "user", content: `key ${KEY}` } });
  assert.ok(!JSON.stringify(ran).includes(KEY));
  // A door connected: the login wrapper uses it like any process provider.
  const doorCalls = [];
  const door = { async sanitize({ text }) { doorCalls.push(text); return text.replace("secret", "[x]"); }, async result({ text }) { return text; } };
  const hd = loginDirect(provider, { door, chainFor: () => ({}) }).run({ id: "t3", chain: {}, onMessage() {}, onExit() {} });
  hd.write({ type: "user", message: { role: "user", content: "a secret word" } });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(doorCalls, ["a secret word"]);
});
