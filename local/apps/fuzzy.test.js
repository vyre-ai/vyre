// @ts-check
// fuzzy: the scores that decide which people a typed name offers, and when one of them is strong
// enough for "Did you mean ...?".

import { test } from "node:test";
import assert from "node:assert/strict";
import { distance, score, rank, STRONG } from "./fuzzy.js";

test("fuzzy: distance counts edits and gives up past the limit", () => {
  assert.equal(distance("juno", "juno"), 0);
  assert.equal(distance("jono", "juno"), 1);
  assert.equal(distance("kit", "kitt"), 1);
  assert.equal(distance("alex", "alxe"), 2);
  assert.equal(distance("alex", "harlow", 2), 3, "past the limit it answers max + 1");
  assert.equal(distance("a", "abcdef", 2), 3, "a length gap past the limit answers at once");
  assert.equal(distance("", "ab"), 2);
});

test("fuzzy: the same name, or the id, scores 1; case, space and a leading @ or # do not count", () => {
  assert.equal(score("Juno", "juno"), 1);
  assert.equal(score("  @juno ", "Juno"), 1);
  assert.equal(score("#general", "general"), 1);
  assert.equal(score("c3", "Ammi jee", "c3"), 1);
});

test("fuzzy: a prefix or the first word is strong; every word's start is strong only from the first", () => {
  assert.equal(score("ammi", "Ammi jee"), 0.9);
  assert.equal(score("jun", "Juno Park"), 0.9);
  assert.equal(score("juno", "Juno Park"), 0.9);
  assert.equal(score("ju pa", "Juno Park"), 0.85);
  assert.ok(score("ju pa", "Juno Park") >= STRONG);
  assert.equal(score("park", "Juno Park"), 0.8, "a later word alone is a candidate, not a Did you mean");
  assert.ok(score("park", "Juno Park") < STRONG);
});

test("fuzzy: a slip of a letter or two is a weak match, and short names must match exactly", () => {
  assert.equal(score("jono", "juno"), 0.7);
  assert.equal(score("jono", "Juno Park"), 0.7, "against the first word");
  assert.equal(score("harlw legal", "Harlow Legal"), 0.7);
  assert.equal(score("northwnd bakry", "Northwind Bakery"), 0.7, "two slips from six letters up");
  assert.equal(score("jx", "jo"), 0, "two letters get no slips");
  assert.equal(score("kat", "kit"), 0.7);
  assert.equal(score("zed", "juno"), 0);
  assert.equal(score("", "juno"), 0);
  assert.equal(score("juno", ""), 0);
});

test("fuzzy: rank keeps matches only, best first, ties by title, up to the limit", () => {
  const people = [
    { id: "c1", title: "Juno Park" }, { id: "c2", title: "Jules" }, { id: "c3", title: "Ammi jee" },
    { id: "c4", title: "kit" }, { id: "c5", title: "June" },
  ];
  assert.deepEqual(rank("ju", people).map(t => t.title), ["Jules", "June", "Juno Park"]);
  assert.deepEqual(rank("juno", people).map(t => [t.title, t.score]), [["Juno Park", 0.9], ["June", 0.7]]);
  assert.deepEqual(rank("ju", people, 2).map(t => t.id), ["c2", "c5"]);
  assert.deepEqual(rank("zed", people), []);
  assert.equal(rank("ammi", people)[0].id, "c3", "the target's own fields are kept");
});
