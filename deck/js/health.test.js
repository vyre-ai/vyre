// @ts-check
// The one formatter for how the box reaches this device (link.health), and its dot's colour.
import test from "node:test";
import assert from "node:assert/strict";

// health.js imports the Deck's api.js, which reads the page's address when it loads.
const g = /** @type {any} */ (globalThis);
if (!g.location) g.location = new URL("https://box.tail0000.ts.net/settings");
if (!g.window) g.window = g;
const { linkLine, linkDot, handshakeLine } = await import("./health.js");

test("health: the line says the path, the relay's region and the latency", () => {
  assert.equal(linkLine({ path: "direct", latencyMs: 12 }), "direct 12 ms");
  assert.equal(linkLine({ path: "relay", relay: "fra", latencyMs: 80 }), "relayed via fra 80 ms");
  assert.equal(linkLine({ path: "relay", relay: null, latencyMs: null }), "relayed");
  assert.equal(linkLine({ path: "peer-relay", latencyMs: 30 }), "peer relay 30 ms");
  assert.equal(linkLine({ path: "unknown", why: "the node is offline" }), "offline");
  assert.equal(linkLine({ path: "unknown", why: "no ping answer" }), "unknown");
  assert.equal(linkLine(null), "unknown");
});

test("health: the dot is green direct, amber on any relay, grey otherwise", () => {
  assert.equal(linkDot({ path: "direct" }), "direct");
  assert.equal(linkDot({ path: "relay" }), "relayed");
  assert.equal(linkDot({ path: "peer-relay" }), "relayed");
  assert.equal(linkDot({ path: "unknown" }), "unknown");
  assert.equal(linkDot(undefined), "unknown");
});

test("health: the handshake line", () => {
  const now = Date.parse("2026-09-27T10:00:00Z");
  assert.equal(handshakeLine({ path: "direct", lastHandshake: now - 20_000 }, now), "last handshake under a minute ago");
  assert.equal(handshakeLine({ path: "relay", lastHandshake: now - 3 * 60_000 }, now), "last handshake 3 min ago");
  assert.equal(handshakeLine({ path: "direct", lastHandshake: null }, now), "no handshake yet");
  assert.equal(handshakeLine({ path: "unknown", why: "this device is not on the tailnet" }, now), "this device is not on the tailnet");
});
