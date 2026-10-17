// @ts-check
// The Connect apps screen's rules (connect-model.js): which apps show under a query and a chip, what each button says, and who an app can be shared with at which Vault level.
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, LEVELS, buttonOf, chipOf, countLine, levelsFor, sampleApps, setupLine, shareLine, viewOf, withShare, withoutShare } from "./connect-model.js";

test("the chips are the ones the owner named, and every sample app lands under one of them", () => {
  assert.deepEqual(CATEGORIES.map(([id]) => id), ["all", "productivity", "communication", "design", "code", "data", "more"]);
  const chips = new Set(CATEGORIES.map(([id]) => id));
  for (const a of sampleApps()) assert.ok(chips.has(chipOf(a)) && chipOf(a) !== "all", a.id);
  assert.equal(chipOf({ category: "dev" }), "code");
  assert.equal(chipOf({ category: "crm" }), "data");
  assert.equal(chipOf({ category: "something odd" }), "more");
  assert.equal(chipOf({}), "more");
});

test("the button says Add for one tap, Set up for a row that needs setup, Connected once it is; a setup row says what it needs first", () => {
  assert.equal(buttonOf({ state: "one-tap" }), "Add");
  assert.equal(buttonOf({ state: "setup" }), "Set up");
  assert.equal(buttonOf({ state: "connected" }), "Connected");
  assert.equal(setupLine({ state: "setup", setup: "token" }), "Needs setup: a token you paste");
  assert.equal(setupLine({ state: "setup", setup: "app" }), "Needs setup: your team's own developer app");
  assert.equal(setupLine({ state: "one-tap" }), "");
});

test("the plain view recommends up to three apps not yet connected, and lists the rest with connected first, then one tap, then setup", () => {
  const v = viewOf(sampleApps());
  assert.deepEqual(v.recommended.map((a) => a.id), ["linear", "stripe", "gohighlevel"]);
  assert.equal(v.count, 1);
  assert.equal(v.list[0].id, "notion", "connected first");
  const states = v.list.map((a) => a.state);
  assert.deepEqual(states, [...states].sort((a, b) => ["connected", "one-tap", "setup"].indexOf(a) - ["connected", "one-tap", "setup"].indexOf(b)));
  assert.ok(v.list.every((a) => !v.recommended.some((r) => r.id === a.id)), "a recommended app is not listed twice");
  assert.equal(v.list.length + v.recommended.length, sampleApps().length);
});

test("a query or a chip drops the recommendations and narrows the list; the count of connected apps does not move", () => {
  const all = sampleApps();
  const q = viewOf(all, { query: "pay" });
  assert.deepEqual(q.list.map((a) => a.id), ["stripe"], "the blurb counts");
  assert.deepEqual(q.recommended, []);
  assert.equal(q.count, 1);
  const code = viewOf(all, { category: "code" });
  assert.deepEqual(code.list.map((a) => a.id), ["linear", "sentry"]);
  assert.deepEqual(code.recommended, []);
  assert.deepEqual(viewOf(all, { category: "code", query: "sentry" }).list.map((a) => a.id), ["sentry"]);
  const none = viewOf(all, { query: "zzz nothing" });
  assert.equal(none.empty, true);
  assert.deepEqual(none.list, []);
  assert.deepEqual(viewOf(all, { category: "all", query: "  " }).recommended.length, 3, "blank words and the All chip are the plain view");
  assert.deepEqual(viewOf(all, { query: "NOTION" }).list.map((a) => a.id), ["notion"], "case does not matter");
});

test("the count line", () => {
  assert.equal(countLine(0), "Nothing connected yet");
  assert.equal(countLine(1), "1 connected");
  assert.equal(countLine(12), "12 connected");
});

test("a person can be given any level; an agent only Fill in, whatever is asked", () => {
  assert.deepEqual(levelsFor("person").map(([v]) => v), ["fill", "read", "edit"]);
  assert.deepEqual(levelsFor("agent"), [["fill", "Fill in"]]);
  assert.deepEqual(LEVELS.map(([, l]) => l), ["Fill in", "Read", "Edit and rotate"]);
  let shares = withShare([], { who: "alex", kind: "person", level: "edit" });
  shares = withShare(shares, { who: "juno", kind: "agent", level: "edit" });
  assert.deepEqual(shares, [{ who: "alex", kind: "person", level: "edit" }, { who: "juno", kind: "agent", level: "fill" }], "an agent is held at Fill in");
  assert.equal(withShare([], { who: "sam", kind: "person", level: "owner" })[0].level, "fill", "an unknown level is Fill in");
});

test("sharing again changes the level instead of adding a second line, a person and an agent of one name are two, and stopping removes only that one", () => {
  let shares = withShare([], { who: "kit", kind: "person", level: "read" });
  shares = withShare(shares, { who: "kit", kind: "agent", level: "fill" });
  shares = withShare(shares, { who: "kit", kind: "person", level: "edit" });
  assert.equal(shares.length, 2);
  assert.equal(shares.find((s) => s.kind === "person").level, "edit");
  assert.deepEqual(withoutShare(shares, "kit", "person").map((s) => s.kind), ["agent"]);
  assert.deepEqual(withoutShare(shares, "nobody", "person"), shares);
});

test("the share line says who and at what, or that it is only you", () => {
  assert.equal(shareLine([]), "Only you");
  assert.equal(shareLine([{ who: "alex", level: "edit" }, { who: "juno", level: "fill" }]), "Shared with alex (Edit and rotate), juno (Fill in)");
});
