import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { REVEAL_MS, healthOf, summaryOf, visible, groupsOf, breakage, share, unshare, GROUPS } from "./redesign.js";

const v = (o) => ({ id: "x", sp: "juniper", group: "Logins", name: "Gmail", detail: "a@b", secret: "s", usedBy: [], shared: [], lastUsedDays: 1, ...o });

test("a reveal lasts 60 seconds", () => assert.equal(REVEAL_MS, 60_000));

test("health: expired, expiring within 14 days, unused after 90 days or never, else ok", () => {
  assert.equal(healthOf(v({ daysLeft: -1 })), "expired");
  assert.equal(healthOf(v({ daysLeft: 14 })), "expiring");
  assert.equal(healthOf(v({ daysLeft: 15 })), "ok");
  assert.equal(healthOf(v({ lastUsedDays: 91 })), "unused");
  assert.equal(healthOf(v({ lastUsedDays: null })), "unused");
  assert.equal(healthOf(v({})), "ok");
});

test("summary says what needs a look, or that all is healthy", () => {
  assert.equal(summaryOf([v({}), v({})]).line, "2 items, all healthy");
  assert.equal(summaryOf([v({ daysLeft: 3 }), v({ lastUsedDays: null }), v({})]).line, "3 items: 1 expiring soon, 1 unused");
});

test("scope and search: Mine is the member's own, Space is the rest", () => {
  const items = [v({ id: "a", sp: "mine", name: "Passport" }), v({ id: "b", name: "Clio" }), v({ id: "c", name: "Stripe", group: "API keys" })];
  assert.deepEqual(visible(items, "mine").map((i) => i.id), ["a"]);
  assert.deepEqual(visible(items, "space").map((i) => i.id), ["b", "c"]);
  assert.deepEqual(visible(items, "space", "api").map((i) => i.id), ["c"]);
});

test("groups follow the fixed order and skip empty ones", () => {
  assert.deepEqual(groupsOf([v({ group: "Logins" }), v({ group: "Firm keys" })]).map((g) => g.name), ["Firm keys", "Logins"]);
  assert.equal(GROUPS.length, 7);
});

test("delete warns what would break", () => {
  assert.equal(breakage(v({})), "Nothing uses it.");
  assert.equal(breakage(v({ usedBy: [{ kind: "flow", name: "Intake" }, { kind: "agent", name: "Kit" }, { kind: "flow", name: "Billing" }] })), "Deleting it stops 2 flows (Intake, Billing), 1 agent (Kit).");
});

test("sharing: again replaces the level; unshare removes", () => {
  let items = [v({ id: "a" })];
  items = share(items, "a", "kit", "use");
  items = share(items, "a", "kit", "edit");
  assert.deepEqual(items[0].shared, [{ who: "kit", level: "edit" }]);
  assert.deepEqual(unshare(items, "a", "kit")[0].shared, []);
});
