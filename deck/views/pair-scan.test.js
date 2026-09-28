// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { initial, step } from "./pair-scan.js";

test("pair-scan: the happy path, start to finish", () => {
  let s = initial();
  assert.equal(s.kind, "scanning");
  s = step(s, { type: "found", ticket: "abc123" });
  assert.deepEqual(s, { kind: "resolving", ticket: "abc123" });
  s = step(s, { type: "resolved", box: "Alex's box", fingerprint: "4F2A" });
  assert.deepEqual(s, { kind: "confirm", ticket: "abc123", box: "Alex's box", fingerprint: "4F2A" });
  s = step(s, { type: "confirm" });
  assert.deepEqual(s, { kind: "pairing", box: "Alex's box", fingerprint: "4F2A" });
  s = step(s, { type: "paired", box: "Alex's box" });
  assert.deepEqual(s, { kind: "done", box: "Alex's box" });
});

test("pair-scan: expired vs used vs unrecognised tickets get different, retryable words", () => {
  const resolving = { kind: /** @type {const} */ ("resolving"), ticket: "x" };
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
  const confirmState = { kind: /** @type {const} */ ("confirm"), ticket: "a", box: "B", fingerprint: "F" };
  const after = step(confirmState, { type: "found", ticket: "b" });
  assert.deepEqual(after, confirmState); // unchanged: this event doesn't apply from "confirm"
});

test("pair-scan: retry always goes back to scanning, from any state", () => {
  const states = [
    { kind: "scanning" }, { kind: "resolving", ticket: "a" },
    { kind: "confirm", ticket: "a", box: "B", fingerprint: "F" },
    { kind: "pairing", box: "B", fingerprint: "F" },
    { kind: "done", box: "B" },
    { kind: "error", code: "e", message: "m", retryable: true },
  ];
  for (const s of /** @type {any[]} */ (states)) assert.deepEqual(step(s, { type: "retry" }), { kind: "scanning" });
});

test("pair-scan: pairing refused on the Mac says so", () => {
  const pairing = { kind: /** @type {const} */ ("pairing"), box: "B", fingerprint: "F" };
  const e = step(pairing, { type: "pairFailed", code: "denied", message: "" });
  assert.equal(e.kind, "error");
  assert.match(/** @type {any} */ (e).message, /refused/);
});
