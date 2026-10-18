// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("the ask box starts a thread with the right agent and sends the words as its first message", { skip: !strip }, async () => {
  const { askSource } = await import("./ask-source.ts");
  const seen = /** @type {any[]} */ ([]);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { seen.push([tool, input]); return tool === "work.agent.thread.new" ? { data: { thread: "th1" } } : { data: {} }; };
  const s = askSource(/** @type {any} */ (call), { ring: async () => ({ id: "th1", ring: "r" }), surface: "app", zone: "UTC", uuid: () => "m1" });
  assert.deepEqual(await s.ask("@juno what is open today", ["alex", "juno"], "alex"), { thread: "th1" });
  assert.deepEqual(seen, [["work.agent.thread.new", { agent: "juno", title: "what is open today", id: "th1", ring: "r" }], ["stream.send", { chat: "th1", text: "what is open today", message: "m1", surface: "app", tz: "UTC" }]]);
  assert.deepEqual(await s.ask("  ", ["alex"], "alex"), { problem: "Type what you want to ask." });
  assert.deepEqual(await s.ask("hi", ["alex"], ""), { problem: "There is no assistant to ask yet." });
});

test("a thread that cannot start sends nothing and says why", { skip: !strip }, async () => {
  const { askSource } = await import("./ask-source.ts");
  const seen = /** @type {any[]} */ ([]);
  const call = async (/** @type {string} */ tool) => { seen.push(tool); return { error: { code: "denied", message: "no access" } }; };
  const s = askSource(/** @type {any} */ (call), { ring: async () => ({}), surface: "app", zone: "UTC", uuid: () => "m" });
  assert.deepEqual(await s.ask("hi", ["alex"], "alex"), { problem: "no access" });
  assert.deepEqual(seen, ["work.agent.thread.new"]);
});
