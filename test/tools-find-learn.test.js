// @ts-check
// tools_find follow-ups: the compact top five and the pointer to the module map on a weak answer, and learning from the call that follows a find (lib/tools-learn.js), which stays local and small.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLearner, stemsOf, LIMITS } from "../lib/tools-learn.js";
import { shapeFind, weak, indexOf, find } from "../harness/mcp/core-tools.js";
import { agentCatalog } from "./tools-universe.js";

const hit = (/** @type {string} */ name, /** @type {number} */ score, /** @type {number} */ agree = 0) => ({ name, score, agree, description: `${name} does a thing. It is long enough to be cut at eighty characters when it is shown compactly, for sure.`, call: { tool: name, arguments: { a: 1 } } });

test("the answer is three in full and the next ones compactly, a close call names the two, and an empty answer points at the module map", () => {
  const found = [hit("a", 90, 3), hit("b", 70), hit("c", 60), hit("d", 50), hit("e", 40)];
  const s = /** @type {any} */ (shapeFind(found, (n) => (n === "d" ? { required: ["x", "y"] } : null)));
  assert.equal(s.tools.length, 3);
  assert.deepEqual(s.tools[0].call, { tool: "tools_call", arguments: { tool: "a", arguments: { a: 1 } } });
  assert.deepEqual(s.also.map((/** @type {any} */ x) => x.name), ["d", "e"]);
  assert.ok(s.also[0].description.length <= 80 && !("call" in s.also[0]));
  assert.deepEqual(s.also[0].needs, ["x", "y"]);
  assert.equal(s.browse, undefined, "a clear answer needs no pointer");
  assert.equal(s.unsure, undefined, "a clear answer is not a close call");
  assert.equal(weak([hit("a", 90, 3), hit("b", 85)]), false, "all three views agree: clear, whatever the margin");
  assert.equal(weak([hit("a", 90, 1), hit("b", 50)]), false, "the first leads by more than a seventh");
  assert.equal(weak([hit("a", 60, 1), hit("b", 58)]), true, "a near tie the views do not agree on");
  assert.equal(weak([]), true);
  const close = /** @type {any} */ (shapeFind([hit("a", 60, 1), hit("b", 58), hit("c", 20)]));
  assert.match(close.unsure, /Close call between a and b/);
  assert.match(close.unsure, /ask them which they mean/);
  assert.equal(close.browse, undefined);
  assert.match(/** @type {any} */ (shapeFind([])).browse, /vyre_core/);
});

test("tools_find returns five by default's worth of candidates from the real catalog", async (t) => {
  const index = indexOf(await agentCatalog(t));
  const s = /** @type {any} */ (shapeFind(find(index, "remind me to call the bank tomorrow", 5)));
  assert.equal(s.tools.length + (s.also ? s.also.length : 0), 5);
});

test("a call that follows a find teaches the pairing: a similar ask later lifts that tool, by a capped amount", () => {
  const l = createLearner();
  assert.equal(l.boosts("write down what the printer said").size, 0);
  l.note("write down what the printer said", "memory_remember");
  const b = l.boosts("write down what the printer said");
  assert.ok((b.get("memory_remember") || 0) > 1 && (b.get("memory_remember") || 0) <= 1 + LIMITS.cap);
  assert.equal(l.boosts("something about holidays").size, 0, "an unrelated ask is not touched");
  assert.ok((l.boosts("write down what the printer displayed").get("memory_remember") || 0) > 1, "a similar ask is");
  for (let i = 0; i < 20; i++) l.note("write down what the printer said", "memory_remember");
  assert.ok((l.boosts("write down what the printer said").get("memory_remember") || 0) <= 1 + LIMITS.cap + 1e-9, "a habit never grows without bound");
  assert.equal(l.size(), 1, "the same pairing is one row");
});

test("it is bounded and forgettable, and what it keeps is stems and tool names in a file only the owner reads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-"));
  const file = path.join(dir, "tools-learned.json");
  const l = createLearner({ file, keep: (s) => ["send", "invoic", "invoice", "quarterli", "quarterly"].includes(s) });
  l.note("send the quarterly invoice to Mrs Whitfield at acme", "mail_send");
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!/Whitfield|quarterly invoice/i.test(raw), "no raw words of the ask");
  assert.deepEqual(JSON.parse(raw).pairs[0].q, stemsOf("send the quarterly invoice to Mrs Whitfield at acme", (s) => ["send", "invoic", "invoice", "quarterli", "quarterly"].includes(s)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(createLearner({ file }).size(), 1, "it survives a restart of the server");
  const many = createLearner();
  for (let i = 0; i < LIMITS.pairs + 50; i++) many.note(`ask number ${i} about topic${i} here`, `tool_${i}`);
  assert.equal(many.size(), LIMITS.pairs);
  l.forget();
  assert.equal(createLearner({ file }).size(), 0);
  assert.equal(createLearner().boosts("x").size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a boost lifts a near neighbour in the ranking but never a poor match over a clear one", async (t) => {
  const index = indexOf(await agentCatalog(t));
  const q = "write down what the printer said";
  const plain = find(index, q, 5);
  const wanted = plain[plain.length - 1].name;
  const boosted = find(index, q, 5, new Map([[wanted, 1 + LIMITS.cap]]));
  assert.ok(boosted.findIndex((x) => x.name === wanted) <= plain.findIndex((x) => x.name === wanted));
  const clear = find(index, "send an email to a client", 1)[0].name;
  assert.equal(find(index, "send an email to a client", 1, new Map([["system_echo", 1 + LIMITS.cap]]))[0].name, clear, "a poor match stays down");
});
