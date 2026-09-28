// @ts-check
// Settings > Server ("Move to a server", docs/design/anywhere.md, ADR 0039): the pure formatting
// and gating logic in deck/js/server-rows.js, checked against the real fixtures it renders in the
// Deck (deck/fixtures/federation.json's move.plan/move.confirm, deck/fixtures/onboard.json's
// status), the way deck/test/settings-drive.test.js checks Drive's rows against Drive's shapes.
// The move.* and onboard.machine tool shapes are launch's own proposal, not yet confirmed by
// federation or shipped by anywhere (docs/work/launch-surfaces.md); this is why the test reads
// the fixtures rather than the (not yet real) tools directly.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fmtBytes, pieceLabel, pieceLine, totalBytes, pieceState, readyToConfirm, destinationName, forgetGate, FORGET_WAIT_MS } from "../js/server-rows.js";

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
  assert.equal(stages.length, 5);
  assert.equal(pieceState(stages[0].pieces.projects), "15%");
  assert.equal(pieceState(stages[0].pieces.memory), "Waiting");
  assert.equal(pieceState(stages[1].pieces.projects), "Done");
  for (const s of stages.slice(0, 4)) assert.equal(readyToConfirm(s), false);
  assert.equal(readyToConfirm(stages[4]), true);
  for (const [k, v] of Object.entries(stages[4].pieces)) assert.equal(pieceState(v), "Done", `${k} is done at the last stage`);
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

test("server rows: onboard.status's machine field, read by drawServer the same as the live onboarding step", () => {
  assert.equal(onboard["onboard.status"].machine, "solo", "the fixture's default machine, matching a fresh install");
  assert.equal(onboard["onboard.machine"].cases.solo.machine, "solo");
  assert.equal(onboard["onboard.machine"].cases.server.machine, "server");
  assert.ok(onboard["onboard.machine"].cases.server.service.installed, "the server card's inline launchd install");
});
