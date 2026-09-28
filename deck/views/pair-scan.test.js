// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { initial, step } from "./pair-scan.js";

test("pair-scan: the happy path, start to finish", () => {
  let s = initial();
  assert.equal(s.kind, "scanning");
  s = step(s, { type: "found" });
  assert.deepEqual(s, { kind: "pairing" });
  s = step(s, { type: "paired", box: "Alex's box", fingerprint: "4F2A B91C", name: "Alex's iPhone" });
  assert.deepEqual(s, { kind: "done", box: "Alex's box", fingerprint: "4F2A B91C", name: "Alex's iPhone" });
});

test("pair-scan: a not_found refusal (tailnet's deliberately-collapsed expired/used/unknown) is worded generically", () => {
  const pairing = { kind: /** @type {const} */ ("pairing") };
  const e = step(pairing, { type: "pairFailed", code: "not_found", message: "" });
  assert.equal(e.kind, "error");
  assert.match(/** @type {any} */ (e).message, /expired or was already used/);
  assert.equal(/** @type {any} */ (e).retryable, true);
});

test("pair-scan: rate_limited says to wait", () => {
  const pairing = { kind: /** @type {const} */ ("pairing") };
  const e = step(pairing, { type: "pairFailed", code: "rate_limited", message: "" });
  assert.match(/** @type {any} */ (e).message, /Wait a moment/);
});

test("pair-scan: a stray late 'found' after the flow already moved on is ignored", () => {
  const pairingState = { kind: /** @type {const} */ ("pairing") };
  const after = step(pairingState, { type: "found" });
  assert.deepEqual(after, pairingState); // unchanged: this event doesn't apply from "pairing"
});

test("pair-scan: retry always goes back to scanning, from any state", () => {
  const states = [
    { kind: "scanning" }, { kind: "pairing" },
    { kind: "done", box: "B", fingerprint: "F", name: "N" },
    { kind: "error", code: "e", message: "m", retryable: true },
  ];
  for (const s of /** @type {any[]} */ (states)) assert.deepEqual(step(s, { type: "retry" }), { kind: "scanning" });
});

test("pair-scan: an unrecognised code falls back to the message given, or a generic one", () => {
  const pairing = { kind: /** @type {const} */ ("pairing") };
  const e = step(pairing, { type: "pairFailed", code: "weird_code", message: "" });
  assert.equal(/** @type {any} */ (e).code, "weird_code");
  assert.match(/** @type {any} */ (e).message, /Something went wrong/);
});
