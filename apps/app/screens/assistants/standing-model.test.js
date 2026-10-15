// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rowView, addCall, splitTo, kindAndVia, FOLLOW_WARNING } from "./standing-model.js";

const NOW = Date.UTC(2026, 9, 16);
test("a row reads in the person's words: kind, connection, recipients, cap and use", () => {
  const v = rowView({ id: "g1", agent: "juno", resource: "vyre://spc/outbox/send/mail:m1", to: { patterns: ["*@harlowlegal.com"], lists: ["contact:c1"] }, daily_cap: 20, use: { count: 3, last: [{ at: NOW - 2 * 86_400_000, to: ["dana@harlowlegal.com"] }] } }, () => "alex@harlowlegal.com", NOW);
  assert.equal(v.title, "Send from alex@harlowlegal.com");
  assert.deepEqual(v.chips, ["*@harlowlegal.com", "List contact:c1"]);
  assert.equal(v.meta, "Up to 20 a day · 3 times, last 2 days ago");
  assert.equal(v.following, true);
  assert.deepEqual(v.recent, ["2 days ago to dana@harlowlegal.com"]);
  const pay = rowView({ id: "g2", agent: "juno", resource: "vyre://spc/outbox/spend/pay", to: { patterns: ["billing@vendor.example"] }, max_amount: 50, daily_amount: 100, currency: "USD", expires: Date.UTC(2026, 10, 1) }, undefined, NOW);
  assert.equal(pay.title, "Pay from pay");
  assert.equal(pay.meta, "Up to 50 USD each, 100 a day · Not used yet · Ends 2026-11-01");
  assert.deepEqual(kindAndVia("vyre://spc/outbox/post"), { kind: "post", via: "" });
});

test("the add sheet builds the call, and says what is missing", () => {
  assert.deepEqual(splitTo("dana@harlowlegal.com, *@northwind.example project:p1:clients"), { patterns: ["dana@harlowlegal.com", "*@northwind.example"], lists: ["project:p1:clients"] });
  const base = { agent: "juno", kind: "send", via: "mail:m1", to: "dana@harlowlegal.com", cap: "20", max: "", day: "", currency: "", follow: false, days: "" };
  assert.deepEqual(addCall(base, NOW), { tool: "gate.standing.add", input: { agent: "juno", kind: "send", via: "mail:m1", to: { patterns: ["dana@harlowlegal.com"] }, daily_cap: 20 } });
  assert.equal(/** @type {any} */ (addCall({ ...base, to: "project:p1:clients", follow: true, days: "7" }, NOW)).input.follow_lists, true);
  assert.equal(/** @type {any} */ (addCall({ ...base, days: "7" }, NOW)).input.expires, NOW + 7 * 86_400_000);
  assert.match(/** @type {any} */ (addCall({ ...base, to: " " })).problem, /Name who/);
  assert.match(/** @type {any} */ (addCall({ ...base, cap: "0" })).problem, /1 to 1000/);
  const pay = { ...base, kind: "spend", max: "50", day: "100", currency: "usd" };
  assert.deepEqual(/** @type {any} */ (addCall(pay, NOW)).input, { agent: "juno", kind: "spend", via: "mail:m1", to: { patterns: ["dana@harlowlegal.com"] }, max_amount: 50, daily_amount: 100, currency: "USD" });
  assert.match(/** @type {any} */ (addCall({ ...pay, day: "10" })).problem, /daily limit/);
  assert.match(/** @type {any} */ (addCall({ ...pay, currency: "" })).problem, /currency/);
  assert.match(FOLLOW_WARNING, /edit these lists/);
});

test("a connection is named the way the Gate names it", async () => {
  const { viaOf } = await import("./standing-model.js");
  assert.equal(viaOf({ id: "m1", provider: "imap-smtp" }), "mail:m1");
  assert.equal(viaOf({ id: "g1", provider: "google-oauth" }), "google:g1");
  assert.equal(viaOf({ id: "x", provider: "mcp" }), "");
});
