import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import { runnerFixtures as F, REASONS, STATES } from "../../../../test/contracts/runner.fixtures.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chipOf, fresher, pickPlacement, movedLine, pickSettings, parseLimit, switchNote, pickHere, hereLine, whyNotLine, DEFAULT_SETTINGS } from "./runner-model.js";

test("runner: no screen moves a session on a timer; the home takes a silent computer's sessions, and only the person's tap moves one", () => {
  // A chat on screen used to ask the box to move its session to Space's Cloud whenever the computer looked offline for a minute. Every open screen did it, as "you", with no cooldown, so a computer that came and went
  // bounced sessions and the reason shown was wrong. The home's own sweep is the one mechanism (placement-book lapsed, reason "offline", one move).
  const src = fs.readFileSync(new URL("../../src/chat/placement.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /setInterval/, "the placement hook polls nothing");
  const moves = src.match(/runner\.move\(/g) || [];
  assert.equal(moves.length, 1, "one call to runner.move: the chip's tap");
  assert.doesNotMatch(src, /runner\.move\([^)]*"server"/, "no screen names Space's Cloud as the place to move to on its own");
});

test("runner: the chip says where a session runs, offers the other place, and says why it is on Space's Cloud", () => {
  assert.deepEqual(chipOf({ where: "mac" }), { label: "On My Computer", tone: "ok", moveTo: "server", moveLabel: "Move to Space's Cloud", why: "" });
  assert.equal(chipOf({ where: "mac", computer: "Dana's MacBook" })?.label, "On Dana's MacBook");
  const s = chipOf({ where: "server", reason: "lid-closed" });
  assert.deepEqual([s?.label, s?.moveTo, s?.why], ["On Space's Cloud", "mac", "lid closed"]);
  assert.equal(chipOf({ where: "server", reason: "something new" })?.why, "", "an unknown code is never shown as the code");
  assert.equal(chipOf({ where: "server", reason: "version-skew" })?.why, "My Computer runs an older Vyre");
  assert.equal(chipOf({ where: "server", reason: "lease-expired" })?.why, "My Computer stopped checking in");
  assert.equal(chipOf(null), null, "a box without the runner shows no chip");
  assert.deepEqual(chipOf({ where: "mac", state: "moving" }), { label: "Moving", tone: "plain", moveTo: null, moveLabel: "", why: "" }, "while it moves, only that");
  assert.equal(chipOf({ where: "mac", state: "locked" })?.label, "Locked");
  assert.equal(chipOf({ where: "mac", state: "updating" })?.label, "My Computer is updating");
  assert.equal(chipOf({ where: "mac", state: "paused", reason: "folder" })?.label, "Paused on My Computer");
  const offer = chipOf({ where: "server", reason: "lid-closed", offer: "mac" });
  assert.deepEqual([offer?.label, offer?.moveTo, offer?.moveLabel], ["Bring back to My Computer?", "mac", "Bring it back to My Computer"]);
  assert.equal(fresher(5, 4), false, "an older epoch is ignored");
  assert.equal(fresher(5, 6), true);
  assert.equal(fresher(undefined, 1), true);
  assert.equal(fresher(3, undefined), true);
});

test("runner: the line in the chat names where it moved and why", () => {
  assert.equal(movedLine({ to: "server", reason: "lid-closed" }), "Moved to Space's Cloud: lid closed.");
  assert.equal(movedLine({ to: "mac", reason: "you" }), "Moved to My Computer: you moved it.");
  assert.equal(movedLine({ to: "server" }), "Moved to Space's Cloud.");
  assert.equal(movedLine({ to: "server", reason: "brand-new-code" }), "Moved to Space's Cloud.", "an unknown code is a plain move");
  assert.equal(movedLine({ to: "paused", reason: "folder" }), "Paused: this chat works in a folder on your Mac.");
  assert.equal(movedLine({ to: "server", reason: "version-skew" }), "Moved to Space's Cloud: My Computer runs an older Vyre.");
  assert.equal(movedLine({ to: "server", reason: "crash" }), "Moved to Space's Cloud: it stopped unexpectedly, and was resumed from its last step.");
});

test("runner: limits are whole numbers in range, settings keep to what is known, and the note under the switch says what it means", () => {
  assert.deepEqual(parseLimit("cpuPercent", "50"), { value: 50 });
  assert.match(parseLimit("cpuPercent", "5").error, /from 10 to 100/);
  assert.match(parseLimit("memoryMb", "abc").error, /whole number/);
  assert.match(parseLimit("memoryMb", "1.5").error, /whole number/);
  assert.deepEqual(parseLimit("memoryMb", "4,096"), { value: 4096 });
  assert.deepEqual(pickSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(pickSettings({ enabled: true, pluggedInOnly: false, cpuPercent: 30, memoryMb: 2048, extra: 1 }), { enabled: true, pluggedInOnly: false, cpuPercent: 30, memoryMb: 2048 });
  assert.match(switchNote({ ...DEFAULT_SETTINGS, enabled: false }), /run on Space's Cloud/);
  assert.equal(switchNote({ enabled: true, pluggedInOnly: true, cpuPercent: 50, memoryMb: 4096 }), "Sessions may run on My Computer while it is plugged in, up to 50% of the processor and 4 GB of memory. Past a limit, a session moves to Space's Cloud and carries on.");
  assert.match(switchNote({ enabled: true, pluggedInOnly: false, cpuPercent: 20, memoryMb: 512 }), /512 MB/);
});

test("runner: the sessions here are listed with what they use, and a session that did not run here says why", () => {
  const list = pickHere({ sessions: [{ thread: "t1", title: "Intake", state: "running", cpuPercent: 12.4, memoryMb: 900 }, { thread: "t2", state: "paused", cpuPercent: 0, memoryMb: 2048 }, { nothing: true }] });
  assert.deepEqual(list.map(hereLine), [{ title: "Intake", sub: "Running, 12% processor, 900 MB" }, { title: "A session", sub: "Paused, 0% processor, 2 GB" }]);
  assert.deepEqual(pickHere([]), []);
  assert.equal(whyNotLine("unplugged"), "It did not run on My Computer because My Computer is on battery.");
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
  assert.deepEqual([chips.movedByCondition?.label, chips.movedByCondition?.moveTo, chips.movedByCondition?.why], ["On Space's Cloud", "mac", "lid closed"]);
  assert.deepEqual([chips.offeredBack?.label, chips.offeredBack?.moveTo], ["Bring back to My Computer?", "mac"]);
  assert.deepEqual([chips.theServersOwn?.label, chips.theServersOwn?.why], ["On Space's Cloud", ""]);
  assert.equal(pickPlacement(F.placements.movedByCondition)?.epoch, 2);
  // a pinned session offers no move (pinned is read only in v1)
  const pinned = chipOf(pickPlacement({ ...F.placements.theServersOwn, pinned: true, pin: "server" }));
  assert.deepEqual([pinned?.label, pinned?.moveTo, pinned?.why], ["On Space's Cloud", null, "it is kept on Space's Cloud"]);
  assert.deepEqual(pickPlacement({ ...F.placements.onTheComputer, pinned: true, pin: "mac" }), { where: "mac", computer: "Office Mac", reason: null, since: 1_760_000_000_000, state: "here", pinned: true, pin: "mac", epoch: 1 });
  // every reason code in the contract has words, and every state is one the chip knows
  for (const r of REASONS) assert.ok(movedLine({ to: "server", reason: r }).length > "Moved to Space's Cloud.".length, `${r} has words`);
  for (const st of STATES) assert.ok(chipOf({ where: "mac", state: /** @type {any} */ (st) }), `${st} draws a chip`);
  // the event line
  assert.equal(movedLine(F.events["thread.moved"]), "Moved to Space's Cloud: lid closed.");
  // the list reads the box's own line and accessory, so Settings and the Lumen list say the same
  const here = pickHere(F.calls.here.output);
  assert.deepEqual(here, [{ thread: F.calls.here.output.sessions[0].thread, title: "A session", computer: "Office Mac", state: "running", cpuPercent: 12, memoryMb: 340, line: "Running, 12% processor, 340 MB", cpu: "12%" }]);
  assert.deepEqual(hereLine(here[0]), { title: "A session", sub: "Running, 12% processor, 340 MB" });
  assert.deepEqual(pickSettings(F.calls.settings.output), F.defaults);
  assert.deepEqual([F.limits.cpuPercent, F.limits.memoryMb], [[10, 100], [512, 65536]]);
});

test("runner: while a chat's process starts on a computer the status line says so, never a silent wait; a fallback says Space's Cloud runs it instead", async () => {
  const { placingWords, placingLine } = await import("./runner-model.js");
  assert.equal(placingWords({ state: "starting", computer: "Dana's MacBook" }), "Starting on Dana's MacBook...");
  assert.equal(placingWords({ state: "starting" }), "Starting on your computer...", "a computer the relay does not list is never shown by an id");
  assert.equal(placingWords({ state: "up", computer: "Dana's MacBook" }), "", "once it is up the line is gone");
  assert.equal(placingWords({ state: "fallback", computer: "Dana's MacBook" }), "");
  assert.equal(placingWords(null), "");
  assert.equal(placingLine({ state: "fallback", computer: "Dana's MacBook", reason: "unavailable" }), "Dana's MacBook did not answer. Running on Space's Cloud instead.");
  assert.equal(placingLine({ state: "fallback" }), "Your computer did not answer. Running on Space's Cloud instead.");
  assert.equal(placingLine({ state: "starting", computer: "x" }), "");
  assert.equal(placingLine({ state: "fallback", computer: "  " }), "Your computer did not answer. Running on Space's Cloud instead.");
});

test("runner: a lease is one quiet line in words: who borrowed which computer and what limit holds", async () => {
  const { leaseLine } = await import("./runner-model.js");
  assert.equal(leaseLine({ computer: "Dana's MacBook", limit: "provider" }), "This chat borrowed Dana's MacBook. It can reach the AI provider and nothing else.");
  assert.equal(leaseLine({ computer: "Dana's MacBook", limit: "internet" }), "This chat borrowed Dana's MacBook. It can reach the internet.");
  assert.equal(leaseLine({ computer: "Dana's MacBook", limit: null }), "This chat borrowed Dana's MacBook.");
  assert.equal(leaseLine({ limit: "provider" }), "This chat borrowed one of your computers. It can reach the AI provider and nothing else.", "a computer with no name is never shown by its id");
  assert.equal(leaseLine({ computer: "Dana's MacBook", limit: "something new" }), "This chat borrowed Dana's MacBook.", "a limit this app does not know says nothing");
  assert.equal(leaseLine({ computer: "Dana's MacBook", limit: "provider" }, "Kit"), "Kit borrowed Dana's MacBook. It can reach the AI provider and nothing else.");
  assert.equal(leaseLine(null), "");
});
