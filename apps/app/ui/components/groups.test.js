// The pure half of GroupedList: sections in order, add, rename, move, remove, collapse. An item says which group it is in by `group`; no group is the default section.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { sectionsOf, addGroup, renameGroup, moveGroup, removeGroup, toggleGroup } from "./groups.js";

const G = [{ name: "Client details" }, { name: "Assets", collapsed: true }];
const I = [{ id: 1, group: "Assets" }, { id: 2 }, { id: 3, group: "Client details" }, { id: 4, group: "Gone" }, { id: 5, group: "Assets" }];

test("sections: the default one first, then the groups in order, items keep their order, an unknown group falls to the default", () => {
  const s = sectionsOf(G, I);
  assert.deepEqual(s.map((x) => [x.name, x.items.map((i) => i.id), !!x.collapsed]), [["", [2, 4], false], ["Client details", [3], false], ["Assets", [1, 5], true]]);
});

test("no groups at all is one flat section with no header", () => {
  const s = sectionsOf([], I);
  assert.equal(s.length, 1);
  assert.equal(s[0].flat, true);
});

test("an empty group still shows, an empty default does not", () => {
  const s = sectionsOf(G, []);
  assert.deepEqual(s.map((x) => x.name), ["Client details", "Assets"]);
});

test("add: trimmed, never blank, never twice (any case)", () => {
  assert.deepEqual(addGroup(G, " Beneficiaries ").map((g) => g.name), ["Client details", "Assets", "Beneficiaries"]);
  assert.equal(addGroup(G, "assets"), G);
  assert.equal(addGroup(G, "  "), G);
});

test("rename: the group and every item in it change together; a blank or taken name is refused", () => {
  const r = renameGroup(G, I, "Assets", "Property");
  assert.deepEqual(r.groups.map((g) => g.name), ["Client details", "Property"]);
  assert.deepEqual(r.items.filter((i) => i.group === "Property").map((i) => i.id), [1, 5]);
  assert.equal(renameGroup(G, I, "Assets", "client details").groups, G);
  assert.equal(renameGroup(G, I, "Assets", " ").groups, G);
});

test("move a group up or down; the ends stay", () => {
  assert.deepEqual(moveGroup(G, "Assets", -1).map((g) => g.name), ["Assets", "Client details"]);
  assert.equal(moveGroup(G, "Client details", -1), G);
  assert.equal(moveGroup(G, "Assets", 1), G);
});

test("remove a group: its items go to the default section, nothing is lost", () => {
  const r = removeGroup(G, I, "Assets");
  assert.deepEqual(r.groups.map((g) => g.name), ["Client details"]);
  assert.equal(r.items.length, I.length);
  assert.deepEqual(r.items.filter((i) => !i.group).map((i) => i.id), [1, 2, 5]);
});

test("collapse toggles one group", () => {
  assert.deepEqual(toggleGroup(G, "Client details").map((g) => !!g.collapsed), [true, true]);
  assert.deepEqual(toggleGroup(G, "Assets").map((g) => !!g.collapsed), [false, false]);
});
