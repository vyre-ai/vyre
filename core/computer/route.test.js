// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget, planRoute, hostOf, registrable, norm } from "./route.js";

const cloud = { id: "cloud", kind: "cloud", name: "Cloud computer" };
const mac = { id: "mac:m1", kind: "mac", name: "Alex's MacBook", aliases: ["my Mac"] };
const office = { id: "mac:m2", kind: "mac", name: "Office Mac mini" };

test("no name means the cloud computer; a name means that computer", () => {
  assert.equal(resolveTarget("", [cloud, mac, office]).target.id, "cloud");
  assert.equal(resolveTarget(undefined, [mac]).target.id, "mac:m1", "the only computer there is");
  assert.equal(resolveTarget("my Mac", [cloud, mac, office]).target.id, "mac:m1");
  assert.equal(resolveTarget("on my mac", [cloud, mac, office]).target.id, "mac:m1");
  assert.equal(resolveTarget("the office computer", [cloud, mac, office]).target.id, "mac:m2", "office is a word only one computer has");
  assert.equal(resolveTarget("Office Mac mini", [cloud, mac, office]).target.id, "mac:m2");
  assert.equal(resolveTarget("the cloud", [cloud, mac]).target.id, "cloud");
});

test("two matches, none, or nothing at all is a question with the real names, never a guess", () => {
  const a = resolveTarget("", [mac, office]);
  assert.equal(a.ok, false);
  assert.deepEqual(a.ask.choices, ["Alex's MacBook", "Office Mac mini"]);
  const b = resolveTarget("mac", [cloud, { id: "x", kind: "mac", name: "Mac one" }, { id: "y", kind: "mac", name: "Mac two" }]);
  assert.equal(b.ask.why, "ambiguous");
  assert.deepEqual(b.ask.choices, ["Mac one", "Mac two"]);
  const c = resolveTarget("the lab pc", [cloud, mac]);
  assert.equal(c.ask.why, "unknown");
  assert.deepEqual(c.ask.choices, ["Cloud computer", "Alex's MacBook"]);
  assert.equal(resolveTarget("my Mac", []).ask.why, "none");
});

test("hosts and the part of a host that names the service", () => {
  assert.equal(hostOf("https://App.Slack.com/x?y=1"), "app.slack.com");
  assert.equal(hostOf("slack.com"), "slack.com");
  assert.equal(hostOf(""), null);
  assert.equal(registrable("app.slack.com"), "slack.com");
  assert.equal(registrable("www.example.co.uk"), "example.co.uk");
  assert.equal(norm("  On My   Mac! "), "on my mac");
});

test("interface first: a Connection beats a learned operation beats the screen; the screen is always one word away", () => {
  const have = { connections: [{ id: "c1", label: "Slack", host: "slack.com" }], sites: [{ site: "https://app.harlow.test", operations: ["listContacts"] }] };
  assert.equal(planRoute({ goal: "send this on Slack to Dana" }, have).route, "connection");
  assert.equal(planRoute({ site: "https://app.slack.com/client" }, have).route, "connection", "by host");
  const op = planRoute({ site: "https://app.harlow.test/contacts" }, have);
  assert.deepEqual([op.route, op.operations], ["operation", ["listContacts"]]);
  assert.equal(planRoute({ site: "https://example.org" }, have).route, "screen");
  assert.equal(planRoute({ goal: "send this on Slack", screen: true }, have).route, "screen", "do it on screen forces the screen");
  assert.equal(planRoute({ goal: "anything" }, {}).route, "screen");
  assert.equal(planRoute({ site: "https://notslack.com" }, { connections: [{ id: "c1", label: "Slack", host: "slack.com" }] }).route, "screen", "a lookalike host is not the service");
});
