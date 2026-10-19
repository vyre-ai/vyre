// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupConnections, whenWords } from "./connections-model.js";

const names = { "u/org/n": "Northwind", "u/org/h": "Harbor & Co", "u/contact/b": "Ben Carter" };
const title = (/** @type {string} */ u) => /** @type {any} */ (names)[u] || u;

test("when a connection holds", () => {
  assert.equal(whenWords("Mar 2023", null), "since Mar 2023");
  assert.equal(whenWords("2019", "Feb 2023"), "since 2019, until Feb 2023");
  assert.equal(whenWords(null, null), "");
});

test("sections by kind and direction, what ended kept last under Before", () => {
  const rows = [
    { id: "1", direction: "from", other: "u/org/n", kind: "Works at", since: "Mar 2023", until: null, note: "Head of Design" },
    { id: "2", direction: "from", other: "u/org/h", kind: "Works at", since: "2019", until: "Feb 2023", note: "" },
    { id: "3", direction: "to", other: "u/contact/b", kind: "Referred by", since: "Jan 2026", until: null, note: "" },
  ];
  const g = groupConnections(rows, title);
  assert.deepEqual(g.map((s) => s.title), ["Works at", "Referred by, from them", "Before: Works at"]);
  assert.deepEqual(g[0].items[0], { id: "1", urn: "u/org/n", title: "Northwind", note: "Head of Design", when: "since Mar 2023", ended: false });
  assert.equal(g[2].items[0].ended, true);
  assert.equal(g[2].items[0].title, "Harbor & Co");
});

test("nothing, or something that is not a list, is no sections", () => {
  assert.deepEqual(groupConnections([], title), []);
  assert.deepEqual(groupConnections(undefined, title), []);
});
