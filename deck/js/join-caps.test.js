// @ts-check
// canRelayJoin: whether "Pair with a code" shows on the live step. Server-decided
// (onboard.status.can.relayJoin), never guessed from platform. A missing field is false, same
// as an explicit false — see deck/js/join-caps.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { canRelayJoin } from "./join-caps.js";

const load = name => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"));
const fixture = load("onboard.json");
const relayTrueFixture = load("onboard-relay-true.json");

test("canRelayJoin: false with a reason, from the shipped fixture (a Mac, no vyre-core yet)", () => {
  const status = fixture["onboard.status"];
  assert.equal(status.can.relayJoin, false, "fixture drifted: this test assumes today's Mac-false case");
  const r = canRelayJoin(status);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "Not available on a Mac yet. Needs vyre-core.");
});

test("canRelayJoin: true once anywhere ships it, from onboard-relay-true.json (a server, no reason needed)", () => {
  const status = relayTrueFixture["onboard.status"];
  assert.equal(status.can.relayJoin, true, "fixture drifted: this test assumes the shipped-server true case");
  const r = canRelayJoin(status);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, null);
});

test("canRelayJoin: true wins even if a stale reason string is still attached", () => {
  const r = canRelayJoin({ can: { relayJoin: true, relayJoinReason: "stale" } });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, null);
});

test("canRelayJoin: missing `can` entirely reads as false, no reason", () => {
  assert.deepEqual(canRelayJoin({}), { allowed: false, reason: null });
  assert.deepEqual(canRelayJoin(undefined), { allowed: false, reason: null });
  assert.deepEqual(canRelayJoin(null), { allowed: false, reason: null });
});

test("canRelayJoin: relayJoin present but not strictly true (e.g. a truthy non-bool) reads as false", () => {
  const r = canRelayJoin({ can: { relayJoin: 1, relayJoinReason: "odd server" } });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "odd server");
});
