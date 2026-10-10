import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import { runnerFixtures as F, REASONS, STATES } from "../../../../test/contracts/runner.fixtures.js";
import assert from "node:assert/strict";
import { chipOf, fresher, pickPlacement, movedLine, pickSettings, parseLimit, switchNote, pickHere, hereLine, whyNotLine, DEFAULT_SETTINGS } from "./runner-model.js";

test("runner: the chip says where a session runs, offers the other place, and says why it is on the server", () => {
  assert.deepEqual(chipOf({ where: "mac" }), { label: "On this Mac", tone: "ok", moveTo: "server", moveLabel: "Move to the server", why: "" });
  assert.equal(chipOf({ where: "mac", computer: "Dana's MacBook" })?.label, "On Dana's MacBook");
  const s = chipOf({ where: "server", reason: "lid-closed" });
  assert.deepEqual([s?.label, s?.moveTo, s?.why], ["On the server", "mac", "lid closed"]);
  assert.equal(chipOf({ where: "server", reason: "something new" })?.why, "", "an unknown code is never shown as the code");
  assert.equal(chipOf({ where: "server", reason: "version-skew" })?.why, "this Mac runs an older Vyre");
  assert.equal(chipOf({ where: "server", reason: "lease-expired" })?.why, "this Mac stopped checking in");
  assert.equal(chipOf(null), null, "a box without the runner shows no chip");
  assert.deepEqual(chipOf({ where: "mac", state: "moving" }), { label: "Moving", tone: "plain", moveTo: null, moveLabel: "", why: "" }, "while it moves, only that");
  assert.equal(chipOf({ where: "mac", state: "locked" })?.label, "Locked");
  assert.equal(chipOf({ where: "mac", state: "updating" })?.label, "This Mac is updating");
  assert.equal(chipOf({ where: "mac", state: "paused", reason: "folder" })?.label, "Paused on this Mac");
  const offer = chipOf({ where: "server", reason: "lid-closed", offer: "mac" });
  assert.deepEqual([offer?.label, offer?.moveTo, offer?.moveLabel], ["Bring back to this Mac?", "mac", "Bring it back to this Mac"]);
  assert.equal(fresher(5, 4), false, "an older epoch is ignored");
  assert.equal(fresher(5, 6), true);
  assert.equal(fresher(undefined, 1), true);
  assert.equal(fresher(3, undefined), true);
});

test("runner: the line in the chat names where it moved and why", () => {
  assert.equal(movedLine({ to: "server", reason: "lid-closed" }), "Moved to the server: lid closed.");
  assert.equal(movedLine({ to: "mac", reason: "you" }), "Moved to this Mac: you moved it.");
  assert.equal(movedLine({ to: "server" }), "Moved to the server.");
  assert.equal(movedLine({ to: "server", reason: "brand-new-code" }), "Moved to the server.", "an unknown code is a plain move");
  assert.equal(movedLine({ to: "paused", reason: "folder" }), "Paused: this chat works in a folder on your Mac.");
  assert.equal(movedLine({ to: "server", reason: "version-skew" }), "Moved to the server: this Mac runs an older Vyre.");
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

test("runner: a placement keeps to what the box said, with the state, the offer and the epoch, and nothing else", () => {
  assert.deepEqual(pickPlacement({ where: "server", computer: "Dana's Mac", reason: "lid-closed", since: 5, state: "server", offer: "mac", epoch: 7, secret: "x" }),
    { where: "server", computer: "Dana's Mac", reason: "lid-closed", since: 5, state: "server", offer: "mac", epoch: 7 });
  assert.deepEqual(pickPlacement({ where: "mac", state: "weird", offer: "other" }), { where: "mac", reason: null, since: null });
  assert.equal(pickPlacement({ where: "moon" }), null);
  assert.equal(pickPlacement(null), null);
});

// contracts/runner.md v1: the consumer built against the producer's fixtures (which the producer's own test checks against the real tools).
test("runner: every placement, call and event the contract fixtures hold draws the right chip, line and list", () => {
  const chips = Object.fromEntries(Object.entries(F.placements).map(([k, v]) => [k, chipOf(pickPlacement(v))]));
  assert.deepEqual([chips.onTheComputer?.label, chips.onTheComputer?.moveTo], ["On Office Mac", "server"]);
  assert.deepEqual([chips.handingOver?.label, chips.handingOver?.moveTo], ["Moving", null]);
  assert.deepEqual([chips.movedByCondition?.label, chips.movedByCondition?.moveTo, chips.movedByCondition?.why], ["On the server", "mac", "lid closed"]);
  assert.deepEqual([chips.offeredBack?.label, chips.offeredBack?.moveTo], ["Bring back to this Mac?", "mac"]);
  assert.deepEqual([chips.theServersOwn?.label, chips.theServersOwn?.why], ["On the server", ""]);
  assert.equal(pickPlacement(F.placements.movedByCondition)?.epoch, 2);
  // a pinned session offers no move (pinned is read only in v1)
  const pinned = chipOf(pickPlacement({ ...F.placements.theServersOwn, pinned: true, pin: "server" }));
  assert.deepEqual([pinned?.label, pinned?.moveTo, pinned?.why], ["On the server", null, "it is kept on the server"]);
  assert.deepEqual(pickPlacement({ ...F.placements.onTheComputer, pinned: true, pin: "mac" }), { where: "mac", computer: "Office Mac", reason: null, since: 1_760_000_000_000, state: "here", pinned: true, pin: "mac", epoch: 1 });
  // every reason code in the contract has words, and every state is one the chip knows
  for (const r of REASONS) assert.ok(movedLine({ to: "server", reason: r }).length > "Moved to the server.".length, `${r} has words`);
  for (const st of STATES) assert.ok(chipOf({ where: "mac", state: /** @type {any} */ (st) }), `${st} draws a chip`);
  // the event line
  assert.equal(movedLine(F.events["thread.moved"]), "Moved to the server: lid closed.");
  // the list reads the box's own line and accessory, so Settings and the Lumen list say the same
  const here = pickHere(F.calls.here.output);
  assert.deepEqual(here, [{ thread: F.calls.here.output.sessions[0].thread, title: "A session", computer: "Office Mac", state: "running", cpuPercent: 12, memoryMb: 340, line: "Running, 12% processor, 340 MB", cpu: "12%" }]);
  assert.deepEqual(hereLine(here[0]), { title: "A session", sub: "Running, 12% processor, 340 MB" });
  assert.deepEqual(pickSettings(F.calls.settings.output), F.defaults);
  assert.deepEqual([F.limits.cpuPercent, F.limits.memoryMb], [[10, 100], [512, 65536]]);
});
