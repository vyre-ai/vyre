import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addGrant, heldIn, listOf, removeGrant, REVEAL_MS, useLine, usesToday } from "./logic.js";

const item = (id, sp, kind, grants = [], use = []) => ({ id, sp, kind, name: id, user: "u", secret: "s", use, grants });
const items = [item("a", "harlow", "Login", [{ who: "kit", right: "use" }], [{ who: "kit", for: "Gmail", times: 3, note: "" }]), item("b", "mine", "Login"), item("c", "harlow", "Card")];

test("a list is one kind in the spaces in view", () => {
  assert.deepEqual(listOf(items, "all", "Login").map((v) => v.id), ["a", "b"]);
  assert.deepEqual(listOf(items, "mine", "Login").map((v) => v.id), ["b"]);
});

test("grants: remove one, share again replaces the right", () => {
  assert.equal(removeGrant(items, "a", "kit")[0].grants.length, 0);
  const g = addGrant(addGrant(items, "b", "juno", "use"), "b", "juno", "fill");
  assert.deepEqual(g[1].grants, [{ who: "juno", right: "fill" }]);
});

test("use is counted and said plainly", () => {
  assert.equal(usesToday(items[0]), 3);
  assert.equal(useLine(items[0]), "u · used 3 times today");
  assert.equal(useLine(items[1]), "u · not used yet");
});

test("held fields follow the space and Reveal lasts 30 seconds", () => {
  const held = [{ id: "1", sp: "harlow", title: "Jane Doe", field: "SSN" }, { id: "2", sp: "mine", title: "Alex", field: "Passport number" }];
  assert.equal(heldIn(held, "mine").length, 1);
  assert.equal(REVEAL_MS, 30000);
});
