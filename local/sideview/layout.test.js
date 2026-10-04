// @ts-check
// The side view's layout rules, without a Mac.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RATIO, leftFrame, pickBrowser, pickSession, ratioOf, rightFrame, screenOf } from "./layout.js";

const win = (/** @type {any} */ o) => ({ pid: 1, bundle: "com.apple.Terminal", app: "Terminal", index: 0, title: "vyre-test", frame: { x: 0, y: 0, w: 800, h: 600 }, minimized: false, standard: true, z: 5, ...o });

test("layout: ratio defaults to 0.29 and is clamped to 0.2-0.5", () => {
  assert.equal(ratioOf(undefined), DEFAULT_RATIO);
  assert.equal(ratioOf("lots"), DEFAULT_RATIO);
  assert.equal(ratioOf(0.1), 0.2);
  assert.equal(ratioOf(0.9), 0.5);
  assert.equal(ratioOf(0.33), 0.33);
});

test("layout: the brief's display, 1800 wide, gives about 29% and 71% edge to edge", () => {
  const area = { x: 0, y: 33, w: 1800, h: 1060 };
  const l = leftFrame(area, 0.29);
  assert.deepEqual(l, { x: 0, y: 33, w: 522, h: 1060 });
  assert.deepEqual(rightFrame(area, l), { x: 522, y: 33, w: 1278, h: 1060 });
});

test("layout: a session window wider than asked pushes the browser over, and the browser keeps 200 points", () => {
  const area = { x: 100, y: 0, w: 1000, h: 800 };
  assert.deepEqual(rightFrame(area, { x: 100, y: 0, w: 400, h: 800 }), { x: 500, y: 0, w: 600, h: 800 });
  assert.equal(rightFrame(area, { x: 100, y: 0, w: 990, h: 800 }).w, 200);
});

test("layout: the front terminal wins, then the top terminal; minimized and odd windows never", () => {
  const ws = [
    win({ pid: 1, z: 3 }), win({ pid: 2, bundle: "com.googlecode.iterm2", z: 1 }),
    win({ pid: 3, bundle: "com.mitchellh.ghostty", z: 0, minimized: true }), win({ pid: 4, bundle: "com.apple.Terminal", z: 0, standard: false }),
    win({ pid: 9, bundle: "com.google.Chrome", z: 2 }),
  ];
  assert.equal(pickSession(ws, { pid: 1, bundle: "com.apple.Terminal" }, "front")?.pid, 1);
  assert.equal(pickSession(ws, { pid: 9, bundle: "com.google.Chrome" }, "front")?.pid, 2);
  assert.equal(pickSession(ws, { pid: 1, bundle: "com.apple.Terminal" }, "terminal")?.pid, 2);
  assert.equal(pickSession(ws, null, { bundle: "com.google.Chrome" })?.pid, 9);
  assert.equal(pickSession(ws, null, { pid: 77 }), null);
  assert.equal(pickBrowser(ws)?.pid, 9);
  assert.equal(pickSession([win({ bundle: "com.apple.Notes" })], null, "front"), null);
});

test("layout: the screen is the one the session's centre is on", () => {
  const screens = [
    { frame: { x: 0, y: 0, w: 1800, h: 1170 }, visible: { x: 0, y: 33, w: 1800, h: 1060 } },
    { frame: { x: 1800, y: 0, w: 2560, h: 1440 }, visible: { x: 1800, y: 25, w: 2560, h: 1415 } },
  ];
  assert.equal(screenOf(screens, { x: 2000, y: 100, w: 500, h: 500 })?.frame.x, 1800);
  assert.equal(screenOf(screens, { x: 10, y: 100, w: 500, h: 500 })?.frame.x, 0);
  assert.equal(screenOf(screens, { x: -5000, y: 0, w: 10, h: 10 })?.frame.x, 0);
});
