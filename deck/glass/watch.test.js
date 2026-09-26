// @ts-check
// The live screen's quality levels, which need no browser: by device, and by how the box reaches it.
import test from "node:test";
import assert from "node:assert/strict";

// watch.js imports the Deck's api.js, which reads the page's address when it loads.
const g = /** @type {any} */ (globalThis);
if (!g.location) g.location = new URL("https://box.tail0000.ts.net/glass/kit");
if (!g.window) g.window = g;
const { levels, relayed } = await import("./watch.js");

test("glass watch: laptop 6/2 and phone 5/4 on a direct link, 2/6 on a relay", () => {
  assert.deepEqual(levels(false), [6, 2]);
  assert.deepEqual(levels(true), [5, 4]);
  assert.deepEqual(levels(false, { path: "direct", latencyMs: 12 }), [6, 2]);
  assert.deepEqual(levels(true, { path: "direct", latencyMs: 12 }), [5, 4]);
  assert.deepEqual(levels(false, { path: "relay", latencyMs: 80 }), [2, 6]);
  assert.deepEqual(levels(true, { path: "peer-relay", latencyMs: 30 }), [2, 6]);
  assert.deepEqual(levels(false, { path: "unknown", latencyMs: null }), [6, 2]);
  assert.equal(relayed({ path: "relay" }), true);
  assert.equal(relayed({ path: "direct" }), false);
  assert.equal(relayed(null), false);
});
