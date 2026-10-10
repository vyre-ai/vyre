// The runner screens against the producer's fixtures (team/contracts/runner.md, test/contracts/runner.fixtures.js, which test/contracts/runner.test.js checks against the real tools):
// the tool names the app calls, the answers it reads, and a word for every reason code the contract lists.
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runnerFixtures as fx, REASONS, STATES, CHAT } from "../../../../test/contracts/runner.fixtures.js";
import { runnerSource } from "./runner-source.ts";
import { chipOf, hereLine, movedLine, pickHere, pickPlacement, pickSettings, REASON_WORDS, whyNotLine } from "./runner-model.js";

/** A box that answers each tool with the fixture for it and remembers what it was asked. */
const box = () => {
  const calls = /** @type {{ tool: string, input: any }[]} */ ([]);
  const answers = /** @type {Record<string, any>} */ ({
    "runner.placement": fx.placements.movedByCondition, "runner.move": fx.calls.move.output, "runner.why-not": fx.calls.whyNot.output, "runner.settings": fx.calls.settings.output,
    "runner.settings.set": fx.calls.settingsSet.output, "runner.here": fx.calls.here.output, "runner.pause-all": fx.calls.pauseAll.output, "runner.resume-all": fx.calls.resumeAll.output,
  });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { calls.push({ tool, input }); return tool in answers ? { data: answers[tool] } : { error: { code: "no_such_tool", message: "no" } }; };
  return { calls, src: runnerSource(/** @type {any} */ (call)) };
};

test("runner contract: the app calls the tools by the contract's names, with the contract's inputs", async () => {
  const { calls, src } = box();
  await src.placement(CHAT); await src.move(CHAT, "server"); await src.whyNot(CHAT); await src.settings();
  await src.setSettings({ enabled: true, pluggedInOnly: true, cpuPercent: 40, memoryMb: 4096 }); await src.here(); await src.pauseAll(); await src.resumeAll();
  assert.deepEqual(calls.map((c) => c.tool), ["runner.placement", "runner.move", "runner.why-not", "runner.settings", "runner.settings.set", "runner.here", "runner.pause-all", "runner.resume-all"]);
  assert.deepEqual(calls[1].input, fx.calls.move.input);
  assert.deepEqual(calls[2].input, fx.calls.whyNot.input);
  assert.deepEqual(calls[4].input, { enabled: true, pluggedInOnly: true, cpuPercent: 40, memoryMb: 4096 });
});

test("runner contract: each placement the chip has to draw reads as the words DESIGN-run-on-my-computer promises", () => {
  const chip = (/** @type {any} */ p) => chipOf(pickPlacement(p));
  assert.equal(chip(fx.placements.onTheComputer)?.label, "On Office Mac");
  assert.equal(chip(fx.placements.handingOver)?.label, "Moving");
  assert.deepEqual([chip(fx.placements.movedByCondition)?.label, chip(fx.placements.movedByCondition)?.why], ["On the server", "lid closed"]);
  assert.deepEqual([chip(fx.placements.offeredBack)?.label, chip(fx.placements.offeredBack)?.moveTo], ["Bring back to this Mac?", "mac"]);
  assert.deepEqual([chip(fx.placements.theServersOwn)?.label, chip(fx.placements.theServersOwn)?.moveTo], ["On the server", "mac"]);
  for (const p of Object.values(fx.placements)) assert.ok(chipOf(pickPlacement(p)), "every placement the contract lists draws a chip");
});

test("runner contract: every reason code and state the contract lists has words, and a stranger says nothing", () => {
  for (const r of REASONS) assert.ok(REASON_WORDS[r], `no words for the reason ${r}`);
  for (const r of REASONS) assert.match(movedLine({ to: "server", reason: r }), /^Moved to the server: .+\.$/);
  assert.equal(movedLine({ to: "server", reason: "from-the-future" }), "Moved to the server.");
  for (const s of STATES) assert.ok(chipOf(pickPlacement({ ...fx.placements.onTheComputer, state: s })), `the state ${s} draws a chip`);
  assert.equal(whyNotLine(fx.calls.whyNot.output.reason), "It did not run on this Mac because lid closed.");
});

test("runner contract: settings and the list read as the contract's answers; the list reads the producer's own line", () => {
  assert.deepEqual(pickSettings(fx.calls.settings.output), fx.defaults);
  const [row] = pickHere(fx.calls.here.output);
  assert.deepEqual([row.thread, row.title, row.computer, row.state, row.cpuPercent, row.memoryMb], [CHAT, "A session", "Office Mac", "running", 12, 340]);
  assert.equal(hereLine(row).sub, "Running, 12% processor, 340 MB");
  assert.deepEqual(Object.keys(row).sort(), ["computer", "cpu", "cpuPercent", "line", "memoryMb", "state", "thread", "title"], "the list keeps the producer's own line and accessory, so Settings and the Lumen list read the same");
});

test("runner contract: a box without the runner reads as nothing, never an error", async () => {
  const src = runnerSource(/** @type {any} */ (async () => ({ error: { code: "no_such_tool", message: "no" } })));
  assert.equal(await src.placement(CHAT), null);
  assert.equal(await src.settings(), null);
  assert.deepEqual(await src.here(), []);
});
