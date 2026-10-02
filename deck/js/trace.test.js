// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";

/** @type {any} */ (globalThis).location = { search: "?trace=1&lag=120" };
const { enabled, lagMs, pressed, routeStart, mark, callStart, lastRoute } = await import("./trace.js");

test("?trace=1 turns it on and ?lag=<ms> sets the added delay", () => {
  assert.equal(enabled, true);
  assert.equal(lagMs, 120);
});

test("a route records its marks once each, in order, and its calls with their start and duration", async () => {
  pressed();
  routeStart("/projects", "projects");
  mark("frame"); mark("frame"); mark("css");
  const done = callStart("projects.list");
  await new Promise(r => setTimeout(r, 15));
  done(true);
  const r = /** @type {any} */ (lastRoute());
  assert.equal(r.key, "/projects");
  assert.deepEqual(r.marks.map((/** @type {any} */ m) => m[0]), ["route", "frame", "css", "data"]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].tool, "projects.list");
  assert.ok(r.calls[0].ms >= 10 && r.calls[0].ok === true);
  assert.ok(r.marks.every((/** @type {any} */ m, /** @type {number} */ i, /** @type {any[]} */ a) => i === 0 || m[1] >= a[i - 1][1]), "times only go forward");
  /** @type {any} */ (globalThis).__deckTrace = undefined;
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref?.();
});
