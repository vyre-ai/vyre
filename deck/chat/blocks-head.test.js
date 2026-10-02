// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
Object.assign(globalThis, { dispatchEvent: () => true, DOMParser: class { parseFromString() { return { documentElement: doc.createElement("svg") }; } } });
const { headRow } = await import("./blocks.js");

test("a run's header wears the provider badge and names provider and model; with none it wears nothing, and a later answer fills it in", () => {
  const none = /** @type {any} */ (headRow("Vyre", 1, true, null, null));
  assert.equal($(none, ".pmark"), null);
  assert.doesNotMatch(text(none), /Claude|Codex/);
  none.setProv({ provider: "codex", model: "GPT-5" });
  assert.equal($(none, ".pmark").getAttribute("aria-label"), "Written by Codex, GPT-5");
  assert.match(text(none), /Codex, GPT-5/);
  none.setProv({ provider: "claude", model: null });
  assert.equal($(none, ".pmark").getAttribute("aria-label"), "Written by Claude");
  assert.equal(none.querySelectorAll(".pmark").length, 1);
});

test("a finished command with a non-zero exit code says so on its row; exit 0 and no code say nothing", async () => {
  const { toolCard } = await import("./blocks.js");
  const mk = exit => text(/** @type {any} */ (toolCard({ kind: "tool", id: "t", tool: "Bash", input: { command: "npm test" }, output: "ok", done: true, ts: 1, ...(exit === undefined ? {} : { exit }) })));
  assert.match(mk(2), /exit 2/);
  assert.doesNotMatch(mk(0), /exit/);
  assert.doesNotMatch(mk(undefined), /exit/);
});
