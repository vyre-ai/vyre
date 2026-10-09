// @ts-check
// The token proof harness (R031-00n): the parts that need no model. Ten tasks, the stream parser, the pass checks, the summary, the dry estimate, the refusal to spend without the go, and
// a whole paid-mode run against a stand-in `claude` that prints Claude Code's stream-json, to show the runner records tokens, calls and pass or fail and stops at the cap.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { devNet, withDevNet } from "../core/vault/request.js";
import { TASKS, toolOf, used, passed, parseStream, summarize, estimate } from "../scripts/lib/token-proof.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const stream = (/** @type {any[]} */ evs) => evs.map((e) => JSON.stringify(e)).join("\n");
const sample = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ text, usd = 0.05) => stream([
  { type: "system", subtype: "init", tools: ["mcp__vyre__tools_find", "mcp__vyre__tools_call", "Bash"] },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: tool, input }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "{}" }] } },
  { type: "result", result: text, is_error: false, num_turns: 2, duration_ms: 1500, total_cost_usd: usd, usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000 } },
]);

test("there are ten tasks, each with a fixed prompt, a tool to look for and a named world", () => {
  assert.deepEqual(TASKS.map((t) => t.id), ["recall", "todo", "record", "flow", "connection", "vault", "file", "teammate", "doc", "skill"]);
  for (const t of TASKS) assert.ok(t.prompt.length > 20 && t.tools.length && t.seed, t.id);
  assert.equal(new Set(TASKS.map((t) => t.prompt)).size, 10);
});

test("a tool call is read through tools_call and the MCP prefix; a check needs the call to have succeeded", () => {
  assert.equal(toolOf("mcp__vyre__tools_call", { tool: "planner.add" }), "planner_add");
  assert.equal(toolOf("mcp__plugin_vyre_vyre__planner_add", {}), "planner_add");
  assert.equal(used([{ name: "mcp__vyre__tools_call", input: { tool: "planner_add" }, ok: true }], ["planner.add"]), true);
  assert.equal(used([{ name: "mcp__vyre__planner_add", ok: false }], ["planner.add"]), false);
  const todo = /** @type {any} */ (TASKS.find((t) => t.id === "todo"));
  assert.equal(passed(todo, { calls: [{ name: "mcp__vyre__planner_add", ok: true }], text: "done" }), true);
  assert.equal(passed(todo, { calls: [{ name: "mcp__vyre__tools_find", ok: true }], text: "done" }), false);
  const recall = /** @type {any} */ (TASKS.find((t) => t.id === "recall"));
  assert.equal(passed(recall, { calls: [{ name: "mcp__vyre__memory_ask", ok: true }], text: "It pays $4,200 a month." }), true);
  assert.equal(passed(recall, { calls: [{ name: "mcp__vyre__memory_ask", ok: true }], text: "I don't know." }), false);
});

test("stream-json becomes tokens, time, turns, calls and the final text", () => {
  const r = parseStream(sample("mcp__vyre__tools_call", { tool: "planner.add", arguments: { text: "x" } }, "Added."));
  assert.deepEqual(r.usage, { input: 100, output: 40, cacheRead: 5000, cacheWrite: 2000 });
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].ok, true);
  assert.equal(r.text, "Added."); assert.equal(r.turns, 2); assert.equal(r.ms, 1500); assert.equal(r.usd, 0.05); assert.equal(r.mcpToolsListed, 2);
  assert.equal(parseStream("not json\n").error, true);
});

test("the summary adds up per arm, and the estimate prices the core arm below the all-tools arm", () => {
  const row = (/** @type {string} */ arm, /** @type {boolean} */ pass) => ({ arm, pass, usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 }, usd: 0.01, ms: 1000, turns: 2, calls: [{}] });
  const s = summarize([row("old", true), row("old", false), row("core", true)]);
  assert.deepEqual(s.map((a) => [a.arm, a.runs, a.pass, a.tokensIn]), [["old", 2, 1, 220], ["core", 1, 1, 110]]);
  const e = estimate({ arms: [{ name: "old", listing: 81500, turns: 3 }, { name: "core", listing: 4300, turns: 5 }], reps: 3 });
  assert.equal(e.arms[0].runs, 30);
  assert.ok(e.arms[1].usd < e.arms[0].usd && e.totalUsd > 0);
});

test("the runner refuses to spend without the go, the cap and a box", () => {
  const run = (/** @type {string[]} */ a, /** @type {Record<string,string>} */ env = {}) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "token-proof.mjs"), ...a], { env: { ...process.env, VYRE_PROOF_PAID: "", ...env }, encoding: "utf8" });
  assert.equal(run(["run", "--max-usd", "1", "--home", os.tmpdir()]).status, 2);
  assert.equal(run(["run", "--home", os.tmpdir()], { VYRE_PROOF_PAID: "yes" }).status, 2);
  assert.equal(run(["run", "--max-usd", "1"], { VYRE_PROOF_PAID: "yes" }).status, 2);
  const dry = run([]);
  assert.equal(dry.status, 0); assert.match(dry.stdout, /Dry estimate/); assert.match(dry.stdout, /tokens/);
});

test("the tee in front of claude passes standard input and output through and keeps a copy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-tee-"));
  const real = path.join(dir, "real.sh");
  fs.writeFileSync(real, "#!/bin/sh\nread l\necho \"got:$l\"\necho \"args:$*\"\n", { mode: 0o755 });
  const tee = path.join(dir, "tee.jsonl");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "token-proof-claude.mjs"), "-p", "x"], { input: "hello\n", env: { ...process.env, TOKEN_PROOF_REAL_CLAUDE: real, TOKEN_PROOF_TEE: tee }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "got:hello\nargs:-p x\n");
  assert.equal(fs.readFileSync(tee, "utf8"), r.stdout);
});

test("only the token proof's own world sets the development network seam of the vault", () => {
  const found = [];
  const walk = (/** @type {string} */ dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === "node_modules" || e.name === ".git") continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|mjs)$/.test(e.name) && /devNet/.test(fs.readFileSync(p, "utf8"))) found.push(path.relative(ROOT, p)); } };
  for (const d of ["core", "kernel", "lib", "scripts", "harness", "local", "modules"]) walk(path.join(ROOT, d));
  assert.deepEqual(found.sort(), ["core/vault/request.js", "scripts/token-proof-world.mjs"]);
  assert.match(fs.readFileSync(path.join(ROOT, "core/vault/request.js"), "utf8"), /withDevNet\(deps\)/);
});

test("the development network seam is refused unless VYRE_SEAL_DEV=1, so no production path reaches it", () => {
  const fake = { transport: async () => { throw new Error("must not run"); }, lookup: async () => [] };
  const before = devNet.deps;
  devNet.deps = fake;
  try {
    const given = { now: () => 1 };
    assert.equal(withDevNet(given, {}), given, "no switch: the dependencies come back untouched");
    assert.equal(withDevNet(given, { VYRE_SEAL_DEV: "0" }), given);
    assert.equal(withDevNet(given, { VYRE_SEAL_DEV: "true" }), given);
    assert.equal(withDevNet(given, { VYRE_SEAL_DEV: "1" }).transport, fake.transport, "only the development switch lays it over");
  } finally { devNet.deps = before; }
  // a release-kind build ignores the seam even with the switch set (it goes through devSwitch)
  const rel = fs.mkdtempSync(path.join(os.tmpdir(), "pk-rel-")); fs.mkdirSync(path.join(rel, "lib"));
  fs.writeFileSync(path.join(rel, "lib", "build-kind.js"), 'export const BUILD_KIND = "release";\n');
  devNet.deps = fake;
  try {
    const given = { now: () => 1 };
    assert.equal(withDevNet(given, { VYRE_SEAL_DEV: "1" }, rel), given, "release-kind build: the seam is ignored with the switch set");
  } finally { devNet.deps = before; fs.rmSync(rel, { recursive: true, force: true }); }
  assert.equal(withDevNet({}, { VYRE_SEAL_DEV: "1" }) && Object.keys(withDevNet({}, { VYRE_SEAL_DEV: "1" })).length, 0, "nothing set: nothing laid over");
});
