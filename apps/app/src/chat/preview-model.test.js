// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { previewActions, previewWord, shareWord } from "./preview-model.js";
import { normalizeBlock } from "./blocks.js";

test("a card says one word for its state and offers one verb at a time", () => {
  assert.equal(previewWord("live"), "Live");
  assert.equal(previewWord("crashed"), "Needs attention");
  assert.deepEqual(previewActions({ state: "live", mode: "session" }), { open: true, keep: true, restart: false, log: false, stop: true });
  assert.deepEqual(previewActions({ state: "live", mode: "supervised" }), { open: true, keep: false, restart: true, log: false, stop: true });
  assert.deepEqual(previewActions({ state: "crashed", mode: "supervised" }), { open: false, keep: false, restart: true, log: true, stop: false });
  assert.deepEqual(previewActions({ state: "stopped", mode: "session" }), { open: false, keep: false, restart: false, log: false, stop: false });
  assert.match(shareWord("project"), /project/);
});

test("a preview block keeps its id and title and never an address", () => {
  const b = normalizeBlock({ block: "preview", id: "0a1b2c3d", title: "Intake form", state: "live", mode: "supervised", access: "team", url: "http://127.0.0.1:5100", port: 5100 });
  assert.deepEqual(b, { block: "preview", id: "0a1b2c3d", title: "Intake form", state: "live", source: "port", mode: "supervised", access: "team", thumb: 0 });
  assert.ok(!JSON.stringify(b).includes("5100") && !JSON.stringify(b).includes("http"));
  assert.equal(normalizeBlock({ block: "preview", id: "nope", title: "x" }).block, "text", "a malformed id degrades to text");
});

test("lifeWord: the agent's own server ends with the chat; a kept one keeps running", async () => {
  const { lifeWord } = await import("./preview-model.js");
  assert.equal(lifeWord("session", "live"), "Ends with this chat");
  assert.equal(lifeWord("supervised", "live"), "Keeps running");
  assert.equal(lifeWord("session", "stopped"), "");
});
