// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickItems, pickPasses, pickPending, lastUsed, inPlace, mainField, whoWord, expiryWord } from "./model.js";

test("model: pickers copy named fields only", () => {
  const items = pickItems({ items: [{ name: "a", kind: "login", fields: ["username", "password"], hosts: ["https://x.acme.test"], grants: [{ module: "gate" }], updated: 5, value: "fixture-leak" }] });
  assert.equal(items[0].kindLabel, "Login");
  assert.deepEqual(items[0].holders, [{ agent: "", module: "gate", pass: "", scope: "", watcher: "" }]);
  assert.ok(!JSON.stringify(items).includes("fixture-leak"), "a stray key never reaches the page");
  const passes = pickPasses({ passes: [{ id: "p1", holder: "dana", items: ["a"], mode: "relayed", status: "active" }, { id: "p2", holder: "x", items: [], status: "revoked", revoked: 1 }],
    held: [{ id: "p3", owner: "theo", items: ["b"], mode: "relayed" }] });
  assert.deepEqual(passes.map(p => [p.id, p.direction, p.holder]), [["p1", "to", "dana"], ["p3", "from", "theo"]]);
  assert.equal(pickPasses({ passes: [{ id: "p4", holder: "t", items: [], status: "pending" }] })[0].state, "waiting");
  assert.deepEqual(pickPending({ grants: [{ id: "g1", name: "a", module: "watchers", by: "mcp" }], passes: [] }).map(x => x.kind), ["grant"]);
});

test("model: last used, places, main field, words", () => {
  const used = lastUsed([{ name: "a", action: "release", at: 5 }, { name: "a", action: "release", at: 9 }, { name: "a", action: "change", at: 20 }]);
  assert.equal(used.get("a"), 9, "a change is not a use");
  const items = pickItems([{ name: "a", kind: "login" }, { name: "b", kind: "card" }, { name: "c", kind: "note", state: "archived" }]);
  assert.deepEqual(inPlace(items, "all", new Set()).map(i => i.name), ["a", "b"]);
  assert.deepEqual(inPlace(items, "cards", new Set()).map(i => i.name), ["b"]);
  assert.deepEqual(inPlace(items, "favorites", new Set(["a"])).map(i => i.name), ["a"]);
  assert.deepEqual(inPlace(items, "archive", new Set()).map(i => i.name), ["c"]);
  assert.equal(mainField({ kind: "login", fields: [] }), "password");
  assert.equal(mainField({ kind: "env-set", fields: ["DB_URL"] }), "DB_URL");
  assert.equal(whoWord("module:watchers/q3"), "watchers");
  assert.equal(whoWord("pass:p1:dana"), "dana");
  assert.equal(expiryWord(null), "No end date");
  assert.equal(expiryWord("2026-10-31"), "Until 31 Oct");
});
