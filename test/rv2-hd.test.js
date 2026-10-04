// reviewer-2 repros HD-1 to HD-3 against origin/work/v0.3 (drop into test/). Each must fail today and pass with its fix.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";
import { until, FAKE } from "../core/sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

const code = r => (r && r.error && r.error.code) || (r && r.data ? "OK" : "none");

test("HD-1: onboard tools called by a model (mcp, mcp:thread:t, mcp:agent:a, module:other) must be denied", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const key = "sk-ant-api03-" + "x".repeat(60);
  const calls = [["onboard.claude", { mode: "api-key", key }], ["onboard.name", { action: "claim", name: "rv2probe", confirm: true }], ["onboard.tailscale", { action: "connect" }], ["onboard.finish", {}]];
  const seen = [];
  for (const caller of ["mcp", "mcp:thread:t", "mcp:agent:a", "module:other"]) for (const [tool, input] of calls) {
    const r = await d.registry.call(tool, input, caller);
    seen.push(`${caller} ${tool} -> ${code(r)}${r.error ? " (" + String(r.error.message).slice(0, 60) + ")" : " data=" + JSON.stringify(r.data).slice(0, 90)}`);
  }
  console.log("HD-1 results:\n  " + seen.join("\n  "));
  const items = await d.registry.call("vault.list", {}, "cli"); console.log("HD-1 vault items after:", JSON.stringify(items.error || items.data).slice(0, 200));
  assert.deepEqual(seen.filter(s => !/-> (denied|no_such_tool|not_allowed|forbidden)/.test(s) ), [], "every model caller must be refused for being a model, not for some later reason");
});

test("HD-2: threads.start must ignore undeclared keys: resume must not write into another live thread, agent must not borrow an agent", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts"); fs.mkdirSync(transcripts);
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "rv2", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-"))); t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const b = await d.registry.call("threads.start", { cwd: work, prompt: "hello from B", surface: "deck" }, "cli");
  assert.ok(b.data, JSON.stringify(b.error));
  await until(async () => (await d.registry.call("threads.get", { thread: b.data.id, limit: 500 }, "cli")).data.events.some(e => e.type === "thread.finished"), "B first turn");
  // a model caller adds keys the schema does not list
  const a = await d.registry.call("threads.start", { cwd: work, prompt: "INJECTED-BY-A", resume: b.data.id, agent: "juno", agent_kind: "assistant" }, "mcp");
  console.log("HD-2 start result:", JSON.stringify(a.error || { id: a.data && a.data.id, resumedB: a.data && a.data.id === b.data.id, agent: a.data && a.data.agent }));
  await new Promise(r => setTimeout(r, 1500));
  const evs = (await d.registry.call("threads.get", { thread: b.data.id, limit: 500 }, "cli")).data.events;
  const wrote = evs.some(e => JSON.stringify(e).includes("INJECTED-BY-A"));
  const borrowed = a.data && a.data.agent;
  assert.equal(wrote, false, "resume from a model caller must not type into another live thread");
  assert.ok(!borrowed, "agent and agent_kind from a model caller must be ignored");
});

test("HD-3: link.call must refuse a model caller before it forwards anything", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [] }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const listed = (await d.registry.call("tools.list", {}, "cli")).data;
  const r = await d.registry.call("link.call", { tool: "artifacts.share", input: {} }, "mcp:thread:t1");
  console.log("HD-3 link.call as mcp:thread:t1 ->", JSON.stringify(r.error || r.data).slice(0, 160));
  assert.ok(r.error && /^(denied|no_such_tool|not_allowed)$/.test(r.error.code), `a model caller must be refused for being a model (got ${r.error ? r.error.code : "OK"}: a pairing error means the tool let it through to remote())`);
});
