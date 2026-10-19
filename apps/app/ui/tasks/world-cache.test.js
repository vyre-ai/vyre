import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENTS_KEPT, MAX_AGE_MS, homeKey, packWorld, pickWorld, unpackWorld } from "./world-cache.js";
import { createLanding } from "../query-order.js";

const T = 1_790_000_000_000;
const world = (title, extra = {}) => ({
  me: "alex", actors: [{ id: "alex", name: "Alex" }], spaces: [{ id: "s1", name: "Home" }],
  types: new Map([["client", { name: "client", fields: [{ name: "name", kind: "text" }, { name: "ssn", kind: "sealed" }, { name: "pin", kind: "text", seal: { level: "ai" } }] }]]),
  tasks: [{ id: "t1", title, record: "vyre://s1/client/c1", state: "ready" }],
  events: Array.from({ length: 80 }, (_, i) => ({ seq: i })),
  calendar: [{ id: "c1", at: T, title: "Call Dana" }],
  records: new Map([["vyre://s1/client/c1", { urn: "vyre://s1/client/c1", type: "client", data: { name: "Dana", ssn: { ref: "seal_1" }, pin: { ref: "seal_2" } } }]]),
  now: T, ...extra,
});

test("each Space keeps its own Home", () => {
  assert.equal(homeKey("s1"), "home.world.s1");
  assert.equal(homeKey(""), "home.world.home");
  assert.notEqual(homeKey("s1"), homeKey("s2"));
});

test("the kept copy is plain JSON with only what Now draws, and never a sealed field's value", () => {
  const packed = packWorld(world("Send the retainer"), () => T);
  const raw = JSON.parse(JSON.stringify(packed));
  assert.equal(raw.events.length, EVENTS_KEPT, "only the newest events Now shows");
  assert.deepEqual(raw.records[0].data, { name: "Dana" }, "sealed fields are left out, the rest kept");
  assert.ok(!JSON.stringify(raw).includes("seal_1") && !JSON.stringify(raw).includes("seal_2"));
  const back = unpackWorld(raw, () => T + 5000);
  assert.ok(back);
  assert.equal(back.now, T + 5000, "now is the time it is opened, not when it was kept");
  assert.ok(back.types instanceof Map && back.types.get("client"));
  assert.ok(back.records instanceof Map && back.records.get("vyre://s1/client/c1"));
  assert.equal(back.tasks[0].title, "Send the retainer");
  assert.equal(back.calendar[0].title, "Call Dana");
});

test("nothing kept, an unknown shape or a copy too old to trust is no copy: the first-run placeholder shows", () => {
  assert.equal(unpackWorld(undefined), null);
  assert.equal(unpackWorld({ v: 2, tasks: [], types: [] }), null);
  assert.equal(unpackWorld({ v: 1, at: T, tasks: "x", types: [] }), null);
  assert.equal(unpackWorld(packWorld(world("x"), () => T), () => T + MAX_AGE_MS + 1), null);
});

test("stale while revalidate: the kept copy draws first, marked stale, then the box's answer replaces it", () => {
  const kept = unpackWorld(JSON.parse(JSON.stringify(packWorld(world("Yesterday's task"), () => T))), () => T + 1000);
  // first open, nothing from the box yet: the copy, no placeholder
  const first = pickWorld(undefined, kept);
  assert.equal(first.stale, true);
  assert.equal(first.world?.tasks[0].title, "Yesterday's task");
  // the refresh lands: it replaces the copy in place
  const fresh = world("Today's task");
  const next = pickWorld(fresh, kept);
  assert.equal(next.stale, false);
  assert.equal(next.world, fresh);
  // the very first run: nothing kept, nothing answered, the only time the placeholder shows
  assert.deepEqual(pickWorld(undefined, null), { world: undefined, stale: false });
});

test("a read overtaken by a box event still lands, and an older answer never replaces a newer one", () => {
  const order = createLanding();
  const a = order.start();
  const b = order.start(); // an event re-ran the read before the first answered
  assert.equal(order.land(a), true, "the first answer shows: a busy box no longer holds the screen on its placeholder");
  assert.equal(order.land(b), true, "the newer answer replaces it");
  const c = order.start(), d = order.start();
  assert.equal(order.land(d), true);
  assert.equal(order.land(c), false, "an older answer arriving late is dropped");
});
