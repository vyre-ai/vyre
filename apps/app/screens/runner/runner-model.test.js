import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chipOf, movedLine, pickSettings, parseLimit, switchNote, pickHere, hereLine, whyNotLine, DEFAULT_SETTINGS } from "./runner-model.js";

test("runner: the chip says where a session runs, offers the other place, and says why it is on the server", () => {
  assert.deepEqual(chipOf({ where: "mac" }), { label: "On this Mac", tone: "ok", moveTo: "server", moveLabel: "Move to the server", why: "" });
  assert.equal(chipOf({ where: "mac", computer: "Dana's MacBook" })?.label, "On Dana's MacBook");
  const s = chipOf({ where: "server", reason: "lid-closed" });
  assert.deepEqual([s?.label, s?.moveTo, s?.why], ["On the server", "mac", "lid closed"]);
  assert.equal(chipOf({ where: "server", reason: "something new" })?.why, "this Mac could not run it", "an unknown code is never shown as the code");
  assert.equal(chipOf(null), null, "a box without the runner shows no chip");
});

test("runner: the line in the chat names where it moved and why", () => {
  assert.equal(movedLine({ to: "server", reason: "lid-closed" }), "Moved to the server: lid closed.");
  assert.equal(movedLine({ to: "mac", reason: "you" }), "Moved to this Mac: you moved it.");
  assert.equal(movedLine({ to: "server" }), "Moved to the server.");
  assert.equal(movedLine({ to: "server", reason: "crash" }), "Moved to the server: it stopped unexpectedly, and was resumed from its last step.");
});

test("runner: limits are whole numbers in range, settings keep to what is known, and the note under the switch says what it means", () => {
  assert.deepEqual(parseLimit("cpuPercent", "50"), { value: 50 });
  assert.match(parseLimit("cpuPercent", "5").error, /from 10 to 100/);
  assert.match(parseLimit("memoryMb", "abc").error, /whole number/);
  assert.match(parseLimit("memoryMb", "1.5").error, /whole number/);
  assert.deepEqual(parseLimit("memoryMb", "4,096"), { value: 4096 });
  assert.deepEqual(pickSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(pickSettings({ enabled: true, pluggedInOnly: false, cpuPercent: 30, memoryMb: 2048, extra: 1 }), { enabled: true, pluggedInOnly: false, cpuPercent: 30, memoryMb: 2048 });
  assert.match(switchNote({ ...DEFAULT_SETTINGS, enabled: false }), /run on the server/);
  assert.equal(switchNote({ enabled: true, pluggedInOnly: true, cpuPercent: 50, memoryMb: 4096 }), "Sessions may run on this Mac while it is plugged in, up to 50% of the processor and 4 GB of memory. Past a limit, a session moves to the server and carries on.");
  assert.match(switchNote({ enabled: true, pluggedInOnly: false, cpuPercent: 20, memoryMb: 512 }), /512 MB/);
});

test("runner: the sessions here are listed with what they use, and a session that did not run here says why", () => {
  const list = pickHere({ sessions: [{ thread: "t1", title: "Intake", state: "running", cpuPercent: 12.4, memoryMb: 900 }, { thread: "t2", state: "paused", cpuPercent: 0, memoryMb: 2048 }, { nothing: true }] });
  assert.deepEqual(list.map(hereLine), [{ title: "Intake", sub: "Running, 12% processor, 900 MB" }, { title: "A session", sub: "Paused, 0% processor, 2 GB" }]);
  assert.deepEqual(pickHere([]), []);
  assert.equal(whyNotLine("unplugged"), "It did not run on this Mac because this Mac is on battery.");
  assert.equal(whyNotLine(null), "It ran where it was meant to.");
});
