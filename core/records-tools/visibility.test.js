// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { levelProblem, busyBlock, isPrivateSynced, windowOf, SHARE_LEVELS } from "./visibility.js";
import { createReadRules, OWN_ONLY } from "../../kernel/gateway/private-rows.js";

const NOW = Date.parse("2026-10-19T00:00:00Z");

test("a level is one of three, and an event has no record level", () => {
  assert.deepEqual(SHARE_LEVELS, ["private", "record", "space"]);
  assert.equal(levelProblem("record-note", "record"), "");
  assert.match(levelProblem("event", "record"), /private or space/);
  assert.match(levelProblem("record-note", "everyone"), /Pick one of/);
});

test("a Busy block is the time and nothing else", () => {
  const row = { id: "e1", data: { title: "Dentist", place: "Main St", people: "a@b.co", starts_at: "2026-10-20T09:00:00Z", ends_at: "2026-10-20T10:00:00Z", all_day: false, source: "google" } };
  assert.deepEqual(busyBlock(row), { starts_at: "2026-10-20T09:00:00Z", ends_at: "2026-10-20T10:00:00Z", all_day: false, busy: true });
  assert.equal(JSON.stringify(busyBlock(row)).includes("Dentist"), false);
  assert.equal(isPrivateSynced(row), true);
  assert.equal(isPrivateSynced({ data: { source: "google", visibility: "space" } }), false);
  assert.equal(isPrivateSynced({ data: { source: "vyre" } }), false);
});

test("the busy window defaults to two weeks and is bounded", () => {
  assert.deepEqual(windowOf({}, NOW), { from: "2026-10-19T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" });
  assert.throws(() => windowOf({ from: "2026-10-19", to: "2026-10-18" }, NOW), /after from/);
  assert.throws(() => windowOf({ from: "2026-10-19", to: "2027-03-01" }, NOW), /62 days/);
  assert.throws(() => windowOf({ from: "nope" }, NOW), /dates/);
});

test("the kernel's read rules: a note is its writer's until shared, a synced event is its owner's until shared; both bind staff", async () => {
  assert.ok(OWN_ONLY.has("record-note") && OWN_ONLY.has("event"));
  const attrs = { "u/n": { created_for: "person:ana" }, "u/e": { created_for: "person:ana" } };
  const rules = createReadRules({ store: {}, urn: (t, i) => `u/${i}`, attrsOf: (u) => attrs[u], tasks: null, mayReadRef: async (_c, ref) => ref === "vyre://s/contact/readable" });
  const note = (visibility, record) => ({ urn: "u/n", data: { visibility, ...(record ? { record: { urn: record } } : {}) } });
  const rule = rules["record-note"];
  assert.equal(await rule("ana", note("private"), {}), true, "the writer");
  assert.equal(await rule("ben", note("private"), {}), false, "private is the writer's alone");
  assert.equal(await rule("ben", note("space"), {}), true);
  assert.equal(await rule("ben", note("record", "vyre://s/contact/readable"), {}), true, "shared with a record someone can read");
  assert.equal(await rule("ben", note("record", "vyre://s/contact/hidden"), {}), false, "not a record they can read");
  assert.equal(await rule("ben", note("record"), {}), false);
  const ev = (data) => ({ urn: "u/e", data });
  assert.equal(await rules.event("ben", ev({ source: "vyre" })), true, "the Space's own events are everyone's");
  assert.equal(await rules.event("ben", ev({ source: "google" })), false, "a synced event is private");
  assert.equal(await rules.event("ana", ev({ source: "google" })), true, "to its owner");
  assert.equal(await rules.event("ben", ev({ source: "google", visibility: "space" })), true, "unless shared");
});
