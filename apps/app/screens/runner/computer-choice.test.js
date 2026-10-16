// The Computer page's one choice: Always allow, Ask or Never, and the plain status line under it. Against a fake box that answers like runner.settings and runner.settings.set.
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runnerSource } from "./runner-source.ts";
import { CHOICES, choiceOf, pickMode, pickSettings, statusLine, DEFAULT_SETTINGS } from "./runner-model.js";

test("the choice is Never when the switch is off, and the mode when it is on; a box with no mode runs as Always allow", () => {
  assert.deepEqual(CHOICES.map(([v]) => v), ["always", "ask", "never"]);
  assert.deepEqual(CHOICES.map(([, l]) => l), ["Always allow", "Ask", "Never"]);
  assert.equal(pickMode(null), "always");
  assert.equal(pickMode({ enabled: true }), "always");
  assert.equal(pickMode({ mode: "ask" }), "ask");
  assert.equal(pickMode({ mode: "whatever" }), "always");
  assert.equal(choiceOf({ ...DEFAULT_SETTINGS, enabled: false }, "ask"), "never");
  assert.equal(choiceOf({ ...DEFAULT_SETTINGS, enabled: true }, "ask"), "ask");
  assert.equal(choiceOf({ ...DEFAULT_SETTINGS, enabled: true }, "always"), "always");
  assert.equal(choiceOf(null, "always"), "never");
  // the settings shape the rest of the app reads has no mode in it
  assert.deepEqual(pickSettings({ enabled: true, mode: "ask", pluggedInOnly: true, cpuPercent: 50, memoryMb: 4096 }), { enabled: true, pluggedInOnly: true, cpuPercent: 50, memoryMb: 4096 });
});

test("the status line says what the computer does and what runs on it, with no numbers to manage", () => {
  assert.equal(statusLine("never", { running: 3, spaces: ["Acme"] }), "Sessions run on the server.");
  assert.match(statusLine("always", { running: 0 }), /^New chats start on this computer\. A session that left comes back at your next message once this computer has been ready for a minute\. Nothing is running here now\.$/);
  assert.match(statusLine("ask", { running: 1, spaces: ["Acme", "Studio"] }), /^A session runs on this computer when you put it here from its chat\. Shared with Acme and Studio\. 1 session is running here now\.$/);
  assert.match(statusLine("always", { running: 2 }), /2 sessions are running here now\.$/);
  for (const c of /** @type {const} */ (["always", "ask", "never"])) assert.doesNotMatch(statusLine(c, { running: 1 }), /percent|%|megabyte|\bMB\b|\bGB\b/i);
});

test("choosing between Always allow and Ask writes the mode and nothing else", async () => {
  /** @type {{ tool: string, input: any }[]} */ const calls = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { calls.push({ tool, input }); return { data: { ...DEFAULT_SETTINGS, enabled: true, mode: input.mode ?? "always" } }; };
  const src = runnerSource(/** @type {any} */ (call));
  assert.equal(await src.setMode("ask"), "ask");
  assert.equal(await src.mode(), "ask");
  assert.deepEqual(calls[0], { tool: "runner.settings.set", input: { mode: "ask" } });
  assert.deepEqual(calls[1], { tool: "runner.settings", input: {} });
  assert.equal(await src.setMode("always"), "always");
});

test("a box without the runner answers no mode: the page reads Always allow and shows nothing", async () => {
  const src = runnerSource(/** @type {any} */ (async () => ({ error: { code: "no_such_tool", message: "no" } })));
  assert.equal(await src.mode(), "always");
  assert.equal(await src.settings(), null);
});
