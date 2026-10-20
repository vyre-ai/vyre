// @ts-check
// A provider switch keeps the WHOLE conversation (carry.js and rollover.js seedOf): every turn word for word when it fits the new model's window, no turn cut short, every tool call with what it
// returned; past the window the oldest part is summarised, and the chat is told in one quiet line. A fake Switchboard: the model service and Recall answer from memory.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CARRY, carryFor, resultsOf, summarisedLine, windowOf } from "./carry.js";
import { seedOf } from "./rollover.js";

/** @param {{ context?: number, blocks?: any[] }} [o] */
const fakeSb = (o = {}) => ({ deps: { call: async (/** @type {string} */ tool, /** @type {any} */ i) => {
  if (tool === "models.list") return { data: { models: [{ id: "lab-wide", name: "Lab Wide", context: 1_000_000 }, { id: "lab-small", name: "Lab Small", context: o.context ?? 20_000 }] } };
  if (tool === "recall.transcript") return i.session === "s-old" ? { data: { blocks: o.blocks ?? [] } } : { error: { code: "not_found", message: "no session" } };
  return { data: null };
} } });

const BLOCKS = [
  { kind: "text", seq: 1, text: "hello" },
  { kind: "tool", seq: 2, ts: 1000, tool: "Bash", input: { command: "ls invoices" }, output: "march.pdf\napril.pdf", error: false },
  { kind: "tool", seq: 3, ts: 2000, tool: "mcp__vyre__records_find", input: { type: "invoice" }, output: JSON.stringify({ rows: [{ id: "inv_7", total: 120 }] }), error: false },
  { kind: "tool", seq: 4, ts: 3000, tool: "Read", input: { path: "missing.txt" }, output: "no such file", error: true },
];

test("a switch carries every turn word for word when it fits the new model's window, with no turn cut short, and every tool call with what it returned", async () => {
  const sb = fakeSb({ blocks: BLOCKS });
  const carry = await carryFor(sb, { chain: ["s-old", "s-gone"], provider: "claude", model: "lab-wide" });
  assert.equal(carry.name, "Lab Wide");
  assert.equal(carry.window, 1_000_000);
  assert.ok(carry.limits.tailChars > 1_000_000, "the budget follows the model's own window, not a 20,000 character tail");
  assert.deepEqual(carry.results.map((r) => [r.name, r.error]), [["Bash", false], ["mcp__vyre__records_find", false], ["Read", true]], "every tool call of the sessions Recall can read, a missing one giving none");
  // 60 turns of 4,000 characters each and one of 12,000: far past the old 20,000 character tail and its 3,000 character turns
  const tail = Array.from({ length: 60 }, (_, i) => ({ who: i % 2 ? "assistant" : "person", text: `turn ${i} ` + "x".repeat(4000) }));
  tail.push({ who: "person", text: "the long one " + "y".repeat(12_000) });
  const seed = seedOf({ kind: "switch", tail, limits: carry.limits, results: carry.results });
  assert.equal(seed.summarised, 0, "nothing had to be summarised");
  assert.equal(seed.tail, 61, "every turn is there word for word");
  assert.ok(seed.text.includes("turn 0 ") && seed.text.includes("y".repeat(12_000)), "the first turn and the long one whole");
  assert.ok(!/\[\+\d+ characters/.test(seed.text), "no turn was cut short");
  assert.ok(seed.text.includes("march.pdf") && seed.text.includes("inv_7") && seed.text.includes("no such file"), "the tool results themselves, not only receipts");
  assert.ok(seed.text.includes("records_find") && seed.text.includes("(failed)"), "each call by name, a failed one said");
});

test("past the new model's window the oldest part is summarised, the newest stays word for word, and the chat says so in one quiet line", async () => {
  const sb = fakeSb({ context: 20_000 });
  const carry = await carryFor(sb, { chain: [], provider: "openrouter", model: "lab-small" });
  assert.equal(carry.limits.tailChars, Math.max(CARRY.minChars, Math.floor(20_000 * CARRY.share * CARRY.charsPerToken)));
  const tail = Array.from({ length: 40 }, (_, i) => ({ who: i % 2 ? "assistant" : "person", text: `point ${i}: ` + "z".repeat(3000) }));
  const seed = seedOf({ kind: "switch", tail, limits: carry.limits, results: [] });
  assert.ok(seed.summarised > 0 && seed.summarised < 40, `the oldest ${seed.summarised} turns were summarised`);
  assert.equal(seed.summarised + seed.tail, 40, "every turn is either summarised or word for word: none is dropped");
  assert.ok(seed.text.includes("Earlier in this conversation, summarised"));
  assert.ok(seed.text.includes("point 0:"), "the oldest turn is still there, in brief");
  assert.ok(seed.text.includes("point 39: " + "z".repeat(3000)), "the newest turn is whole");
  assert.equal(summarisedLine(carry.name), "The oldest part of this chat was summarised to fit Lab Small's context.");
  // a rollover (the same model, a fresh window) is unchanged: it summarises nothing here
  assert.equal(seedOf({ kind: "roll", tail }).summarised, 0);
});

test("the window and name come from the one model service; a model it does not list keeps its id and a safe window", async () => {
  assert.deepEqual(await windowOf(fakeSb(), "claude", "lab-wide"), { context: 1_000_000, name: "Lab Wide" });
  assert.deepEqual(await windowOf(fakeSb(), "codex", "not-listed"), { context: CARRY.fallbackWindow, name: "not-listed" });
  assert.equal((await windowOf(fakeSb(), "codex", null)).name, "Codex");
  assert.deepEqual((await resultsOf(fakeSb({ blocks: BLOCKS }), ["s-old"], 1500)).map((r) => r.name), ["mcp__vyre__records_find", "Read"], "a return to a provider carries what it missed");
});
