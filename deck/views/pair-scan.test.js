// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { initial, step } from "./pair-scan.js";

test("pair-scan: the happy path, start to finish", () => {
  let s = initial();
  assert.equal(s.kind, "scanning");
  s = step(s, { type: "found" });
  assert.deepEqual(s, { kind: "resolving" });
  s = step(s, { type: "resolved", name: "Alex's box", fingerprint: "a1b2 c3d4", handle: "alex" });
  assert.deepEqual(s, { kind: "confirm", name: "Alex's box", fingerprint: "a1b2 c3d4", handle: "alex" });
  s = step(s, { type: "confirm" });
  assert.deepEqual(s, { kind: "pairing", name: "Alex's box", fingerprint: "a1b2 c3d4", handle: "alex" });
  s = step(s, { type: "paired", box: "Alex's box", deviceName: "Alex's iPhone" });
  assert.deepEqual(s, { kind: "done", box: "Alex's box", fingerprint: "a1b2 c3d4", deviceName: "Alex's iPhone", handle: "alex" });
});

test("pair-scan: a handle-less box stays null through to done (no redirect offered)", () => {
  let s = /** @type {any} */ ({ kind: "resolving" });
  s = step(s, { type: "resolved", name: "B", fingerprint: "F", handle: null });
  s = step(s, { type: "confirm" });
  s = step(s, { type: "paired", box: "B", deviceName: "N" });
  assert.equal(s.handle, null);
});

test("pair-scan: 'not this one' drops back to scanning without pairing", () => {
  const confirmState = { kind: /** @type {const} */ ("confirm"), name: "B", fingerprint: "F", handle: null };
  const after = step(confirmState, { type: "notThisOne" });
  assert.deepEqual(after, { kind: "scanning" });
});

test("pair-scan: 404-shaped, rate-limited and MAC/shape failures get distinct, retryable words", () => {
  const resolving = { kind: /** @type {const} */ ("resolving") };
  const notFound = step(resolving, { type: "resolveFailed", code: "not_found", message: "" });
  assert.match(/** @type {any} */ (notFound).message, /expired or was already used/);
  const rate = step(resolving, { type: "resolveFailed", code: "rate_limited", message: "" });
  assert.match(/** @type {any} */ (rate).message, /Wait a moment/);
  const bad = step(resolving, { type: "resolveFailed", code: "bad_ticket", message: "" });
  assert.match(/** @type {any} */ (bad).message, /doesn't check out/);
  for (const e of [notFound, rate, bad]) { assert.equal(e.kind, "error"); assert.equal(/** @type {any} */ (e).retryable, true); }
});

test("pair-scan: a stray late 'found' after the flow already moved on is ignored", () => {
  const confirmState = { kind: /** @type {const} */ ("confirm"), name: "B", fingerprint: "F", handle: null };
  const after = step(confirmState, { type: "found" });
  assert.deepEqual(after, confirmState); // unchanged: this event doesn't apply from "confirm"
});

test("pair-scan: retry always goes back to scanning, from any state", () => {
  const states = [
    { kind: "scanning" }, { kind: "resolving" },
    { kind: "confirm", name: "B", fingerprint: "F", handle: null },
    { kind: "pairing", name: "B", fingerprint: "F", handle: null },
    { kind: "done", box: "B", fingerprint: "F", deviceName: "N", handle: null },
    { kind: "error", code: "e", message: "m", retryable: true },
  ];
  for (const s of /** @type {any[]} */ (states)) assert.deepEqual(step(s, { type: "retry" }), { kind: "scanning" });
});

test("pair-scan: a pairing-time failure (after confirm) is worded too", () => {
  const pairing = { kind: /** @type {const} */ ("pairing"), name: "B", fingerprint: "F", handle: null };
  const e = step(pairing, { type: "pairFailed", code: "bad_ticket", message: "" });
  assert.equal(e.kind, "error");
  assert.match(/** @type {any} */ (e).message, /doesn't check out/);
});
