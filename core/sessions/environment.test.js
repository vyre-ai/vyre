// @ts-check
// The environment brief: built from live reads, the same on every driver, within its budget, and teaching every family of tools an agent can reach.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { environmentOf, FAMILIES, familyOf, BUDGET } from "./environment.js";
import { OPEN } from "../modules/agent-reach.js";
import { noSdk, until, boot } from "./testing/boot.js";

process.env.VYRE_LEGACY_DIRECT_MODEL = "1";

const tools = ["records.types", "records.get", "work.tools", "work.call", "work.situation", "tasks.list", "flows.propose", "approvals.pending", "team.ask", "memory.retrieve", "recall.turn", "mcp.servers", "vault.inject", "projects.list", "spaces.list", "planner.add"];
const base = {
  agent: { name: "kit", kind: "agent", projects: ["northwind"] }, project: "northwind", tools,
  spaces: [{ name: "Studio", role: "owner", current: true }, { name: "Harlow", role: "member" }], space: { name: "Studio", role: "owner" },
  types: [{ name: "client", fields: ["name", "email"] }, { name: "matter", fields: ["title", "stage"] }],
  connectors: [{ name: "gmail", state: "running" }, { name: "slack", state: "failed" }], team: [{ name: "scout", role: "Research" }],
};

test("environment: says what Vyre is, the Space and the others, the records, approvals, memory and where to learn more, from the reads it was given", () => {
  const e = environmentOf(base);
  assert.match(e.text, /^\[Vyre environment\]/);
  assert.match(e.text, /Vyre, the person's own AI workspace[\s\S]*their phone as the key/);
  assert.match(e.text, /This session is in the Space Studio, where the person is owner\./);
  assert.match(e.text, /They also belong to: Harlow \(member\)/);
  assert.match(e.text, /Data does not cross a Space unless the person moves or shares it/);
  assert.match(e.text, /Types here: client \(name, email\), matter \(title, stage\)/);
  assert.match(e.text, /\[sealed: client name\][\s\S]*never try to recover/);
  assert.match(e.text, /Outward acts[\s\S]*held as a task[\s\S]*propose/);
  assert.match(e.text, /memory_turn[\s\S]*word for word/);
  assert.match(e.text, /personal layer[\s\S]*one memory per project/);
  assert.match(e.text, /Connected: gmail, slack \(failed\)/);
  assert.match(e.text, /You are kit, an agent\. You can work in these projects: northwind/);
  assert.match(e.text, /work\.tools[\s\S]*records\.types[\s\S]*work\.situation/);
  assert.match(e.text, /Teammates on this install: scout \(Research\)/);
  assert.ok(!e.text.includes("—") && !e.text.includes("§"));
  assert.equal(environmentOf(base).version, e.version, "the same reads give the same version");
  assert.notEqual(environmentOf({ ...base, spaces: [] , space: null }).version, e.version);
});

test("environment: a source that does not answer drops its line, and a family the agent cannot reach is not taught", () => {
  const e = environmentOf({ ...base, types: null, spaces: [], space: null, connectors: [], team: [], tools: ["memory.retrieve", "recall.turn"] });
  assert.match(e.text, /Memory is automatic/);
  assert.doesNotMatch(e.text, /Types here|Connected:|Teammates on this install|They also belong|work\.call|Vyre Records|Projects? is one record/);
  assert.match(e.text, /Outward acts/, "approvals are always said");
  assert.match(environmentOf({ ...base, types: null }).text, /Ask records\.types for the types/);
});

test("environment: it stays within its budget however large the Space, and never drops what must stay", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ name: `type${i}`, fields: Array.from({ length: 20 }, (_, j) => `field${j}`) }));
  const e = environmentOf({ ...base, types: many, team: Array.from({ length: 80 }, (_, i) => ({ name: `mate${i}`, role: "Role" })), connectors: Array.from({ length: 50 }, (_, i) => ({ name: `c${i}` })) });
  assert.ok(e.chars <= BUDGET + 40, `${e.chars}`);
  for (const id of ["vyre", "you", "approvals", "memory", "learn"]) assert.ok(e.parts.some(p => p.id === id), id);
  assert.match(e.text, /and 288 more \(records\.types\)/);
  const tiny = environmentOf(base, { budget: 1500 });
  assert.ok(tiny.parts.some(p => p.id === "learn"));
  assert.ok(tiny.parts.length < environmentOf(base).parts.length, "lower priority parts go first");
});

test("environment: every family of tools an agent can reach is taught in the brief or named for learning more", async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ vault: { keystore: "file" }, recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const reachable = new Set();
  for (const label of ["mcp:agent:kit", "mcp"]) for (const x of d.registry.listTools(label)) reachable.add(familyOf(x.name));
  // An assistant does what its person can: the person-reach tools the agent rules leave open.
  const cli = new Set(d.registry.listTools("cli").map(x => x.name));
  for (const x of OPEN) if (cli.has(x)) reachable.add(familyOf(x));
  const unknown = [...reachable].filter(f => !FAMILIES[f]).sort();
  assert.deepEqual(unknown, [], `add these tool families to FAMILIES in core/sessions/environment.js, taught or named for learning more: ${unknown.join(", ")}`);
  // and the live tool builds the brief from the registry
  const r = await d.registry.call("sessions.environment", { agent: "kit", agent_kind: "agent" }, "module:vyred");
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.match(r.data.text, /Vyre environment/);
  assert.ok(r.data.families.includes("memory") && r.data.families.includes("threads"));
  for (const f of r.data.families) assert.ok(FAMILIES[f], `${f} is reachable and not in FAMILIES`);
});

// ---------------------------------------------------------------------------------------------------- the same brief on every driver

const shim = (t, w, name) => {
  const bin = path.join(w.root, "shim");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp.js"), path.join(bin, name));
  const saved = { PATH: process.env.PATH, FAKE_ACP_STORE: process.env.FAKE_ACP_STORE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACP_STORE = path.join(w.root, "acp-store");
  fs.mkdirSync(process.env.FAKE_ACP_STORE, { recursive: true });
  // Codex starts in "agent" and Vyre moves it to "workspace-write" (drivers/codex.js).
  Object.assign(process.env, { FAKE_ACP_EXTRA_MODE: "workspace-write", FAKE_ACP_START_MODE: "agent" });
  t.after(() => { for (const k of ["FAKE_ACP_EXTRA_MODE", "FAKE_ACP_START_MODE"]) delete process.env[k]; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
};
const noMemoryBlocks = w => {
  const real = w.d.registry.call.bind(w.d.registry);
  w.d.registry.call = async (tool, input, caller, meta) => tool === "memory.prompt" ? { data: { text: "", blocks: [] } } : real(tool, input, caller, meta);
};

for (const driver of ["cli", "sdk"]) {
  const skip = driver === "sdk" ? noSdk : false;
  test(`${driver}: a Claude, a Codex and a Grok session each receive the same environment brief, ahead of the person's words`, { skip }, async t => {
    const w = await boot(t, { driver });
    shim(t, w, "grok");
    shim(t, w, "codex-acp");
    noMemoryBlocks(w);
    const brief = async () => (await w.d.registry.call("sessions.environment", {}, "module:vyred")).data;
    const want = await brief();
    const seen = {};
    // Claude: the system-prompt append, in the launch's own arguments.
    const c = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
    await w.finished(c.id);
    const launch = w.launches().at(-1);
    const at = launch.argv.indexOf("--append-system-prompt");
    seen.claude = at >= 0 ? launch.argv[at + 1] : "";
    for (const provider of ["grok", "codex"]) {
      const th = (await w.tool("threads.start", { cwd: w.work, provider, prompt: "where is it hosted", surface: "deck" })).data;
      await w.finished(th.id);
      seen[provider] = (await w.said(th.id))[0];
      // A second prompt does not repeat it.
      await w.tool("threads.send", { thread: th.id, text: "and the domain", surface: "deck" });
      await w.finished(th.id, 2);
      assert.doesNotMatch((await w.said(th.id))[1], /Vyre environment/, `${provider}: once per process`);
    }
    for (const [who, text] of Object.entries(seen)) {
      assert.ok(text.includes("[Vyre environment]"), who);
      assert.ok(text.includes(want.text.split("\n\n")[0]), `${who} has the same opening`);
      assert.match(text, /Outward acts[\s\S]*propose/, who);
      assert.match(text, /memory_turn/, who);
    }
    // For the ACP agents the person's words come after it.
    for (const who of ["grok", "codex"]) assert.match(seen[who], /\[\/Vyre environment\][\s\S]*where is it hosted$/, who);
    // and a resumed ACP session is told again.
    const th = (await w.tool("threads.start", { cwd: w.work, provider: "grok", prompt: "one", surface: "deck" })).data;
    await w.finished(th.id);
    await w.tool("threads.stop", { thread: th.id });
    await w.tool("threads.send", { thread: th.id, text: "after the stop", surface: "deck" });
    await w.finished(th.id, 2);
    assert.match((await w.said(th.id))[1], /\[Vyre environment\][\s\S]*after the stop$/, "a resumed session knows the state as it is now");
  });

  test(`${driver}: a replacing role prompt replaces only the role layer: the environment stays, first`, { skip }, async t => {
    const w = await boot(t, { driver });
    noMemoryBlocks(w);
    assert.equal((await w.tool("sessions.prompt.set", { scope: "assistant", text: "You are terse.", mode: "replace" })).error, undefined);
    const r = (await w.d.registry.call("sessions.prompt.compose", { agent_kind: "assistant", agent: "juno" }, "module:vyred")).data;
    assert.equal(r.mode, "replace");
    assert.ok(r.text.startsWith("[Vyre environment]"));
    assert.ok(r.text.indexOf("You are terse.") > r.text.indexOf("[/Vyre environment]"));
  });
}
