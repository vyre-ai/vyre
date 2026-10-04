// @ts-check
// The memory line of `vyre status`: what memory knows about the user and how much of today's plan share reading used.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoryLine } from "./daemon.js";
import { tempHome } from "../../../test/helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");
/** @returns {Promise<{ code: number, stdout: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, stdout })));
const frames = s => s.trim().split("\n").map(l => JSON.parse(l));

test("vyre status: the memory line", () => {
  const model = { on: true, today_usd: 0.02, cap_usd: 0.05, calls_today: 2, cues_waiting: 40, last: null };
  assert.equal(memoryLine({ facts: 430, current: 412, model }), "memory   412 facts about you, reading 40% of today's plan share");
  assert.equal(memoryLine({ facts: 1, current: 1 }), "memory   1 fact about you", "no model field yet: facts only");
  assert.equal(memoryLine({ facts: 12 }), "memory   12 facts about you");
  assert.equal(memoryLine({ current: 3, model: { on: false, today_usd: 0, cap_usd: 0.05 } }), "memory   3 facts about you, reading off");
  assert.equal(memoryLine({ current: 0, model: { on: true, today_usd: 0, cap_usd: 0.05 } }), "memory   0 facts about you, reading 0% of today's plan share");
  assert.equal(memoryLine({ current: 5, model: { on: true } }), "memory   5 facts about you", "a model object without numbers says nothing");
  assert.equal(memoryLine({ current: 9, model: { on: true, today_usd: 0.25, cap_usd: 0.25, backfill_usd: 1.1, backfill_cap_usd: 2, waiting_turns: 340 } }),
    "memory   9 facts about you, reading 100% of today's plan share, first read 55% of its share, 340 turns to read");
  // Never dollars in front of a person: the reads are a share of their Claude plan, not a charge.
  assert.doesNotMatch(memoryLine({ current: 9, model: { on: true, today_usd: 0.25, cap_usd: 0.25, backfill_usd: 1.1, backfill_cap_usd: 2 } }), /\$/);
  for (const bad of [undefined, null, "x", {}, { facts: "many" }]) assert.equal(memoryLine(bad), null);
});

test("vyre down, status, modules, tools and call: no sub-verbs, so vyre commands lists their arguments", async t => {
  const root = tempHome(t);
  const d = JSON.parse((await run(root, ["commands", "--all", "--json"])).stdout);
  const of = n => d.commands.find(c => c.name === n);
  for (const n of ["down", "status", "modules", "tools", "call"]) assert.deepEqual(of(n).verbs, [], `${n} has no verbs`);
  assert.deepEqual(of("call").args, [{ name: "tool", required: true }, { name: "json", required: false }]);
  assert.deepEqual(of("call").flags, [{ name: "tty" }, { name: "space", value: "name" }]);
  assert.deepEqual(of("down").flags, [{ name: "json" }]);
});

test("vyre down and status --view: a card when nothing runs, an error frame with exit 5 for status", async t => {
  const root = tempHome(t);
  const down = await run(root, ["down", "--view"]);
  assert.equal(down.code, 0, down.stdout);
  const f = frames(down.stdout);
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].view.fields[0].value], ["down", "card", "was not running"]);
  assert.deepEqual(f[0].data, { stopped: false, wasRunning: false });
  const st = await run(root, ["status", "--view"]);
  assert.equal(st.code, 5, st.stdout);
  const s = frames(st.stdout);
  assert.deepEqual([s[0].view.kind, s[0].view.code], ["error", "unreachable"]);
  assert.deepEqual(s.at(-1), { v: 1, done: true, exit: 5 });
});

test("vyre space: a remembered space is read back, shown by bare `vyre space`, and cleared", async t => {
  const root = tempHome(t);
  const { readSpace, writeSpace } = await import("../space-pref.js");
  assert.equal(readSpace(root), null);
  writeSpace("harlow", root);
  assert.equal(readSpace(root), "harlow");
  assert.equal(JSON.parse((await run(root, ["space", "--json"])).stdout).space, "harlow");
  assert.equal((await run(root, ["space", "use", "--clear"])).code, 0);
  assert.equal(readSpace(root), null);
  assert.equal(JSON.parse((await run(root, ["space", "--json"])).stdout).space, null);
});
