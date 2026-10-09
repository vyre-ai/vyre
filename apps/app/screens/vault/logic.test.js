import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addGrant, heldIn, listOf, removeGrant, REVEAL_MS, useLine, usesToday } from "./logic.js";

const item = (id, sp, kind, grants = [], use = []) => ({ id, sp, kind, name: id, user: "u", secret: "s", use, grants });
const items = [item("a", "juniper", "Login", [{ who: "kit", right: "use" }], [{ who: "kit", for: "Gmail", times: 3, note: "" }]), item("b", "mine", "Login"), item("c", "juniper", "Card")];

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
  const held = [{ id: "1", sp: "juniper", title: "Jane Doe", field: "SSN" }, { id: "2", sp: "mine", title: "Alex", field: "Passport number" }];
  assert.equal(heldIn(held, "mine").length, 1);
  assert.equal(REVEAL_MS, 30000);
});

import { generatePassword, strengthWords } from "./logic.js";
import nodeCrypto from "node:crypto";
test("generator: the length asked for, every class present, no look-alikes, no symbols when off, different each time, and the words for its strength", () => {
  const rnd = (/** @type {Uint8Array} */ a) => nodeCrypto.getRandomValues(a);
  for (const length of [12, 20, 32, 64]) {
    const p = generatePassword(rnd, { length });
    assert.equal(p.length, length);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[0-9]/); assert.match(p, /[!@#$%^&*\-_=+?]/);
    assert.doesNotMatch(p, /[lIO01]/, "no look-alike characters");
  }
  assert.doesNotMatch(generatePassword(rnd, { length: 40, symbols: false }), /[^a-zA-Z0-9]/);
  assert.equal(generatePassword(rnd, { length: 3 }).length, 12, "never shorter than 12");
  assert.equal(generatePassword(rnd, { length: 500 }).length, 64, "never longer than 64");
  assert.notEqual(generatePassword(rnd), generatePassword(rnd));
  // a source that is all zeros still gives the right shape (rejection sampling terminates, classes still present)
  assert.equal(generatePassword((a) => a.fill(0), { length: 16 }).length, 16);
  assert.equal(strengthWords(20, true), "20 characters, about 123 bits. Very strong.".replace("123", String(Math.floor(20 * Math.log2(24 + 24 + 8 + 13)))));
  assert.match(strengthWords(12, false), /Fine for most sites|Strong/);
});
