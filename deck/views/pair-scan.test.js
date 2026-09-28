// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { initial, step } from "./pair-scan.js";

test("pair-scan: the happy path, start to finish", () => {
  let s = initial();
  assert.equal(s.kind, "scanning");
  s = step(s, { type: "found" });
  assert.deepEqual(s, { kind: "resolving" });
  s = step(s, { type: "resolved", box: "Alex's box", fingerprint: "4F2A", handle: "alex", defaultName: "Alex's iPhone" });
  assert.deepEqual(s, { kind: "confirm", box: "Alex's box", fingerprint: "4F2A", handle: "alex", name: "Alex's iPhone" });
  s = step(s, { type: "confirm" });
  assert.deepEqual(s, { kind: "pairing", box: "Alex's box", fingerprint: "4F2A", handle: "alex", name: "Alex's iPhone" });
  s = step(s, { type: "paired" });
  assert.deepEqual(s, { kind: "done", box: "Alex's box", fingerprint: "4F2A", handle: "alex", name: "Alex's iPhone" });
});

test("pair-scan: the device name is editable before confirming, and travels through pairing", () => {
  let s = /** @type {any} */ ({ kind: "confirm", box: "B", fingerprint: "F", handle: "h", name: "Alex's iPhone" });
  s = step(s, { type: "rename", name: "Work phone" });
  assert.equal(s.name, "Work phone");
  s = step(s, { type: "confirm" });
  assert.equal(s.name, "Work phone");
  s = step(s, { type: "paired" });
  assert.equal(s.name, "Work phone");
});

test("pair-scan: a rename is capped at 60 chars", () => {
  const s = /** @type {any} */ ({ kind: "confirm", box: "B", fingerprint: "F", handle: "h", name: "x" });
  const long = "y".repeat(200);
  assert.equal(step(s, { type: "rename", name: long }).name.length, 60);
});

test("pair-scan: expired vs used vs unrecognised tickets get different, retryable words", () => {
  const resolving = { kind: /** @type {const} */ ("resolving") };
  assert.match(step(resolving, { type: "resolveFailed", code: "ticket_expired", message: "" }).message, /expired/);
  assert.match(step(resolving, { type: "resolveFailed", code: "ticket_used", message: "" }).message, /already used/);
  assert.match(step(resolving, { type: "resolveFailed", code: "bad_ticket", message: "" }).message, /didn't look like/);
  for (const code of ["ticket_expired", "ticket_used", "bad_ticket"]) {
    const e = step(resolving, { type: "resolveFailed", code, message: "" });
    assert.equal(e.kind, "error");
    assert.equal(/** @type {any} */ (e).retryable, true);
  }
});

test("pair-scan: a stray late 'found' after the flow already moved on is ignored", () => {
  const confirmState = { kind: /** @type {const} */ ("confirm"), box: "B", fingerprint: "F", handle: "h", name: "N" };
  const after = step(confirmState, { type: "found" });
  assert.deepEqual(after, confirmState); // unchanged: this event doesn't apply from "confirm"
});

test("pair-scan: retry always goes back to scanning, from any state", () => {
  const states = [
    { kind: "scanning" }, { kind: "resolving" },
    { kind: "confirm", box: "B", fingerprint: "F", handle: "h", name: "N" },
    { kind: "pairing", box: "B", fingerprint: "F", handle: "h", name: "N" },
    { kind: "done", box: "B", fingerprint: "F", handle: "h", name: "N" },
    { kind: "error", code: "e", message: "m", retryable: true },
  ];
  for (const s of /** @type {any[]} */ (states)) assert.deepEqual(step(s, { type: "retry" }), { kind: "scanning" });
});

test("pair-scan: pairing refused says so", () => {
  const pairing = { kind: /** @type {const} */ ("pairing"), box: "B", fingerprint: "F", handle: "h", name: "N" };
  const e = step(pairing, { type: "pairFailed", code: "denied", message: "" });
  assert.equal(e.kind, "error");
  assert.match(/** @type {any} */ (e).message, /refused/);
});
