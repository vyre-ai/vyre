// @ts-check
// The installed web app's pure pieces: routing a worker's navigate message, and push.seen's timing.

import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./model.ts");

test("pwa: a navigate message routes to its path without /app", { skip: !strip }, async () => {
  const { navigateTarget } = await load();
  assert.equal(navigateTarget({ type: "vyre:navigate", path: "/app/need/abc" }), "/need/abc");
  assert.equal(navigateTarget({ type: "vyre:navigate", path: "/app/session/juno?ask=kit" }), "/session/juno?ask=kit");
  assert.equal(navigateTarget({ type: "vyre:navigate", path: "/app/" }), "/");
  assert.equal(navigateTarget({ type: "vyre:navigate", path: "/app" }), "/");
  assert.equal(navigateTarget({ type: "vyre:navigate", path: "/app?x=1" }), "/?x=1");
});

test("pwa: anything else is not a route", { skip: !strip }, async () => {
  const { navigateTarget } = await load();
  for (const bad of [null, "x", 1, {}, { type: "vyre:navigate" }, { type: "other", path: "/app/x" },
    { type: "vyre:navigate", path: "https://evil.example/app/x" }, { type: "vyre:navigate", path: "//evil.example/app/x" },
    { type: "vyre:navigate", path: "/deck/now" }, { type: "vyre:navigate", path: "/apple" }, { type: "vyre:navigate", path: "/app/\\evil" },
    { type: "vyre:navigate", path: 7 }]) {
    assert.equal(navigateTarget(bad), null, JSON.stringify(bad));
  }
});

test("pwa: push.seen reports on show and hide, and on input only after a quiet minute", { skip: !strip }, async () => {
  const { seenReporter, SEEN_EVERY } = await load();
  /** @type {boolean[]} */ const sent = [];
  let t = 1_000;
  const r = seenReporter(v => sent.push(v), () => t);
  r.input(true);
  assert.deepEqual(sent, [true], "the first input reports when nothing has yet");
  t += 10_000; r.input(true);
  assert.deepEqual(sent, [true], "not again within the minute");
  t += SEEN_EVERY; r.input(false);
  assert.deepEqual(sent, [true], "never while hidden");
  r.input(true);
  assert.deepEqual(sent, [true, true]);
  r.hidden(); r.shown();
  assert.deepEqual(sent, [true, true, false, true]);
  t += 5_000; r.input(true);
  assert.equal(sent.length, 4, "a show counts as a report");
});
