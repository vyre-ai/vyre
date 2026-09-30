// @ts-check
// health(): the reach shape from a paths object or a Connection, and since only moving with the reach.
import test from "node:test";
import assert from "node:assert/strict";
import { health, watch } from "./health.js";

const direct = good => ({ kind: "direct", good });
const relay = state => ({ kind: "relay", good: state === "open", connection: state ? { state } : null });

test("health: the direct path current is direct, with the tailnet round trip only when measured", () => {
  const p = { index: 0, paths: [direct(true), relay("open")] };
  assert.deepEqual(health(p, { since: 10 }), { reach: "direct", why: "Connected to your server over Tailscale.", since: 10 });
  assert.deepEqual(health(p, { since: 10, rtt: 23 }).tailnet, { path: "direct", latencyMs: 23 });
  const failing = health({ index: 0, paths: [direct(false), relay("offline")] }, { since: 10 });
  assert.equal(failing.reach, "none");
  assert.equal(failing.fix?.action, "open-tailscale");
});

test("health: on the relay path it is relay while the channel is open, and none while connecting or offline", () => {
  const at = state => health({ index: 1, paths: [direct(false), relay(state)] }, { since: 5 });
  assert.deepEqual(at("open"), { reach: "relay", why: "Connected to your server through Vyre's relay.", since: 5 });
  assert.equal(at("open").tailnet, undefined);
  const connecting = at("connecting");
  assert.equal(connecting.reach, "none");
  assert.equal(connecting.fix, undefined, "connecting needs no click");
  const off = at("offline");
  assert.equal(off.reach, "none");
  assert.deepEqual(off.fix, { action: "retry", label: "Try again" });
  assert.equal(health({ index: 0, paths: [relay(null)] }, { since: 5 }).reach, "none", "not yet connected");
});

test("health: a bare Connection is the relay, and nothing at all is none", () => {
  assert.equal(health({ state: "open" }, { since: 1 }).reach, "relay");
  assert.equal(health({ state: "offline" }, { since: 1 }).reach, "none");
  const nothing = health(null, { since: 1 });
  assert.equal(nothing.reach, "none");
  assert.ok(nothing.fix);
});

test("health: watch keeps since at the start of the current reach", () => {
  const clock = { t: 100 };
  const p = { index: 1, paths: [direct(false), relay("open")] };
  const w = watch(p, { now: () => clock.t });
  assert.equal(w.read().since, 100);
  clock.t = 500;
  assert.equal(w.read().since, 100, "same reach, same since");
  p.index = 0; p.paths[0] = direct(true);
  const back = w.read();
  assert.deepEqual([back.reach, back.since], ["direct", 500]);
  clock.t = 900;
  p.index = 1; p.paths[1] = relay("offline");
  const down = w.read();
  assert.deepEqual([down.reach, down.since], ["none", 900]);
});
