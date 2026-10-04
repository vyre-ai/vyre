// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { search, fuzzy } from "./search.js";

const items = [
  { name: "harlow-drive", description: "Harlow Legal's shared Drive", hosts: ["https://drive.google.com"], kindLabel: "Login", fields: ["username", "password"] },
  { name: "github-harlow-site", description: "Deploys the site", hosts: ["https://api.github.com"], kindLabel: "API key", fields: ["value"] },
  { name: "launch-env", description: "", hosts: [], kindLabel: "Env set", fields: ["DATABASE_URL", "STRIPE_KEY"] },
  { name: "acme-visa", description: "Company card", hosts: [], kindLabel: "Card", fields: ["number", "expiry", "cvc"] },
];

test("search: an empty query keeps everything in order", () => {
  assert.deepEqual(search(items, "  ").map(i => i.name), items.map(i => i.name));
});

test("search: names, hosts, descriptions, kinds and field names", () => {
  assert.equal(search(items, "hdrive")[0].name, "harlow-drive", "a subsequence of the name");
  assert.deepEqual(search(items, "github.com").map(i => i.name), ["github-harlow-site"], "a host");
  assert.deepEqual(search(items, "stripe").map(i => i.name), ["launch-env"], "a field name");
  assert.deepEqual(search(items, "card").map(i => i.name), ["acme-visa"], "the kind");
  assert.deepEqual(search(items, "company").map(i => i.name), ["acme-visa"], "the description");
});

test("search: every word must match, and name hits rank first", () => {
  assert.deepEqual(search(items, "harlow site").map(i => i.name), ["github-harlow-site"]);
  assert.equal(search(items, "harlow")[0].name, "harlow-drive");
  assert.deepEqual(search(items, "zzz"), []);
});

test("search: values are not searchable because items carry none", () => {
  // The search reads only these keys; anything else on an item is ignored.
  const withJunk = [{ ...items[0], value: "fixture-secret-value" }];
  assert.deepEqual(search(withJunk, "fixture-secret"), []);
});

test("fuzzy: contiguous and boundary matches score higher", () => {
  assert.ok(fuzzy("dri", "harlow-drive") > fuzzy("hdi", "harlow-drive"));
  assert.equal(fuzzy("xyz", "harlow-drive"), 0);
});
