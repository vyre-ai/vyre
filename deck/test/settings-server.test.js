// @ts-check
// Settings > Server ("Move to a server", docs/design/anywhere.md, ADR 0039): the pure formatting
// and gating logic in deck/js/server-rows.js, checked against the real fixtures it renders in the
// Deck (deck/fixtures/federation.json's move.plan/move.status/move.confirm, deck/fixtures/
// onboard.json's status), the way deck/test/settings-drive.test.js checks Drive's rows against
// Drive's shapes. onboard.machine is real and shipped (anywhere, 73d03d39); federation's move.*
// contract is confirmed (docs/work/federation.md) but the engine itself is not built yet, so the
// fixture is what this test (and the Deck) reads.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fmtBytes, pieceLabel, pieceLine, totalBytes, piecePct, pieceState, readyToConfirm, allReady, mergeEvent, destinationName, forgetGate, FORGET_WAIT_MS } from "../js/server-rows.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const federation = JSON.parse(fs.readFileSync(path.join(HERE, "../fixtures/federation.json"), "utf8"));
const onboard = JSON.parse(fs.readFileSync(path.join(HERE, "../fixtures/onboard.json"), "utf8"));

test("server rows: bytes, short form", () => {
  assert.equal(fmtBytes(400), "0 KB");
  assert.equal(fmtBytes(40_000), "40 KB");
  assert.equal(fmtBytes(2_100_000_000), "2.1 GB");
  assert.equal(fmtBytes(900_000), "900 KB");
  assert.equal(fmtBytes(undefined), "0 KB", "a missing size never throws");
});

test("server rows: the plan fixture's four pieces format as the dry-run screen shows them", () => {
  const plan = federation["federation.move.plan"];
  const pieces = plan.pieces;
  assert.deepEqual(Object.keys(pieces), ["projects", "memory", "vault", "sessions"], "anywhere.md's four, in order");
  assert.equal(pieceLabel("projects", pieces.projects), "Projects");
  assert.equal(pieceLabel("vault", pieces.vault), "Vault");
  assert.equal(pieceLabel("unknown", undefined), "unknown", "a key with no fixture label falls back to the key itself");
  assert.equal(pieceLine(pieces.projects), "14 items · 2.1 GB");
  assert.equal(pieceLine(pieces.vault), "23 items · 40 KB");
  assert.equal(pieceLine(undefined), "0 items · 0 KB", "a missing piece never throws");
  assert.equal(totalBytes(pieces), 2_100_000_000 + 41_000_000 + 40_000 + 900_000);
  assert.equal(destinationName(plan), "kit");
});

test("server rows: the status fixture's five stages read as done/doing/waiting, and only the last is ready to confirm", () => {
  const stages = federation["federation.move.status"].$seq;
  const keys = ["projects", "memory", "vault", "sessions"];
  assert.equal(stages.length, 5);
  assert.equal(piecePct(stages[0].pieces.projects), 15);
  assert.equal(pieceState(stages[0].pieces.projects), "15%");
  assert.equal(pieceState(stages[0].pieces.memory), "Waiting", "of>0 but bytes still 0");
  assert.equal(pieceState(stages[1].pieces.projects), "Done");
  assert.equal(stages[0].stage, "copying");
  assert.equal(stages[3].stage, "verifying");
  for (const s of stages.slice(0, 4)) {
    assert.equal(readyToConfirm(s), false, `stage "${s.stage}" is not ready`);
    assert.equal(allReady(s.pieces, keys), false, `not every piece is done yet at "${s.stage}"`);
  }
  assert.equal(stages[4].stage, "ready");
  assert.equal(readyToConfirm(stages[4]), true);
  assert.equal(allReady(stages[4].pieces, keys), true, "the Deck's own inference agrees with move.status's own stage");
  for (const [k, v] of Object.entries(stages[4].pieces)) assert.equal(pieceState(v), "Done", `${k} is done at the last stage`);
});

test("server rows: allReady and pieceState handle a failed piece and an empty plan", () => {
  assert.equal(pieceState({ bytes: 900000, of: 2100000000, error: "disk full on destination" }), "Failed");
  assert.equal(allReady({ a: { done: true }, b: { done: true, error: "oops" } }, ["a", "b"]), false, "one failed piece blocks ready, even if marked done");
  assert.equal(allReady({}, []), false, "an empty plan is never ready (there is nothing to confirm)");
  assert.equal(piecePct(undefined), 0);
  assert.equal(piecePct({ bytes: 50, of: 0 }), 0, "no total yet, never divide by zero");
});

test("server rows: destinationName falls back the way both callers need", () => {
  assert.equal(destinationName(federation["federation.move.confirm"]), "kit", "move.confirm's own destination");
  assert.equal(destinationName({ ...onboard["onboard.status"], server: { name: "kit-mini" } }), "kit-mini", "onboard.status has no destination field yet, so a server.name fallback is used");
  assert.equal(destinationName({ host: "alex-box" }), "alex-box", "a bare host, oldest fallback");
  assert.equal(destinationName({}), "your server", "no identity at all");
});

test("server rows: the 24-hour forget gate, never automatic either side of it", () => {
  const now = Date.parse("2026-09-28T00:00:00Z");
  assert.equal(forgetGate(now, now).ready, false, "not ready the moment it moves");
  assert.equal(forgetGate(now, now).hoursLeft, 24);
  assert.equal(forgetGate(now, now + FORGET_WAIT_MS - 3_600_000).hoursLeft, 1, "rounds up, never shows 0 hours left while still gated");
  assert.equal(forgetGate(now, now + FORGET_WAIT_MS - 3_600_000).ready, false);
  assert.equal(forgetGate(now, now + FORGET_WAIT_MS).ready, true, "ready at exactly 24 hours");
  assert.equal(forgetGate(now, now + FORGET_WAIT_MS + 3_600_000).ready, true, "and any time after");
});

test("server rows: mergeEvent applies one federation move.* event onto a pieces snapshot", () => {
  const base = { projects: { bytes: 0, of: 2100000000, done: false }, vault: { bytes: 40000, of: 40000, done: true } };
  const progressed = mergeEvent(base, { type: "move.progress", payload: { moveId: "m1", piece: "projects", bytes: 315000000, of: 2100000000 } });
  assert.equal(progressed.projects.bytes, 315000000);
  assert.equal(progressed.projects.done, false, "progress alone never marks a piece done");
  assert.equal(progressed.vault.bytes, 40000, "an event for one piece never touches another");

  const done = mergeEvent(progressed, { type: "move.piece.done", payload: { moveId: "m1", piece: "projects" } });
  assert.equal(done.projects.done, true);
  assert.equal(done.projects.bytes, 2100000000, "piece.done fills bytes to the total, in case the last progress event was missed");

  const failed = mergeEvent(base, { type: "move.failed", payload: { moveId: "m1", piece: "vault", error: "disk full on destination" } });
  assert.equal(failed.vault.error, "disk full on destination");

  assert.deepEqual(mergeEvent(base, { type: "move.confirmed", payload: { moveId: "m1" } }), base, "an event this Deck does not otherwise act on changes nothing");
});

test("server rows: replaying buffered events onto a later baseline lands the same as applying them live", () => {
  // reviewer-2's race-window finding (26ba1830): an event during the move.status round trip
  // must not be lost. Replaying it onto the baseline once that call resolves should be
  // indistinguishable from having applied it before the baseline was ever fetched.
  const events = [
    { type: "move.progress", payload: { moveId: "m1", piece: "vault", bytes: 20000, of: 40000 } },
    { type: "move.piece.done", payload: { moveId: "m1", piece: "vault" } },
  ];
  const baseline = { vault: { bytes: 0, of: 40000, done: false } };
  const replayed = events.reduce(mergeEvent, baseline);
  assert.equal(replayed.vault.done, true);
  assert.equal(replayed.vault.bytes, 40000);
});

test("server rows: onboard.status's machine field, read by drawServer the same as the live onboarding step", () => {
  assert.equal(onboard["onboard.status"].machine, "solo", "the fixture's default machine, matching a fresh install");
  assert.equal(onboard["onboard.machine"].cases.solo.machine, "solo");
  assert.equal(onboard["onboard.machine"].cases.server.machine, "server");
  // anywhere (73d03d39): service always comes back null for now, the launchd installer isn't
  // built yet. Nothing in the Deck should assume it is populated until anywhere says otherwise.
  assert.equal(onboard["onboard.machine"].cases.server.service, null);
});
