import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupOf, daysLeftOf, valueField, REVEAL_MS, healthOf, summaryOf, visible, groupsOf, breakage, share, unshare, GROUPS } from "./redesign.js";

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

test("health: not known yet is not unused; known never used is", () => {
  assert.equal(healthOf(v({ lastUsedDays: undefined })), "ok");
  assert.equal(healthOf(v({ lastUsedDays: null })), "unused");
});

test("a stored item is placed in a group by kind and name", () => {
  assert.equal(groupOf("login", "Gmail"), "Logins");
  assert.equal(groupOf("api-key", "Stripe"), "API keys");
  assert.equal(groupOf("secret", "resend-main"), "Sending services");
  assert.equal(groupOf("secret", "twilio-auth"), "Phone");
  assert.equal(groupOf("mcp-connection", "x"), "MCP keys");
  assert.equal(groupOf("ssh-key", "nas"), "SSH and notes");
  assert.equal(groupOf("secret", "firm-signing"), "Firm keys");
  assert.equal(groupOf("ai-signin", "claude"), "API keys");
});

test("days left and the field to reveal", () => {
  assert.equal(daysLeftOf(undefined), null);
  assert.equal(daysLeftOf("2026-10-20", Date.parse("2026-10-13")), 7);
  assert.equal(daysLeftOf("2026-10-10", Date.parse("2026-10-13")), -3);
  assert.equal(valueField(["username", "password"]), "password");
  assert.equal(valueField(["x"]), "x");
});
