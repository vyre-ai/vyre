// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DRAG_TYPE, carriesRows, dragWords, movedLine, parentOf, pickable, pickerCrumbs, plan, takesMoves } from "./move-model.js";

const f = (path, extra = {}) => ({ root: "space", path, name: path.split("/").pop(), dir: false, ...extra });
const d = (path, extra = {}) => f(path, { dir: true, ...extra });

test("parentOf: the folder a path is in, empty at the top", () => {
  assert.equal(parentOf("a/b/c.txt"), "a/b");
  assert.equal(parentOf("a.txt"), "");
});

test("only the Space and a linked folder take moves", () => {
  assert.equal(takesMoves({ root: "space" }), true);
  assert.equal(takesMoves({ root: "linked", link: "l1" }), true);
  assert.equal(takesMoves({ root: "linked" }), false);
  assert.equal(takesMoves({ root: "box" }), false);
  assert.equal(takesMoves({ root: "shared" }), false);
});

test("plan: rows go into another folder of the same place", () => {
  const r = plan([f("a.txt"), d("Plans")], { root: "space", path: "Clients" });
  assert.deepEqual(r.go.map((x) => x.path), ["a.txt", "Plans"]);
  assert.equal(r.said, "");
  assert.deepEqual(plan([f("x/a.txt")], { root: "space", path: "" }).go.map((x) => x.path), ["x/a.txt"], "to the top");
});

test("plan: a row already in the folder stays without a word; all of them there says so once", () => {
  const r = plan([f("Clients/a.txt"), f("b.txt")], { root: "space", path: "Clients" });
  assert.deepEqual(r.go.map((x) => x.path), ["b.txt"]);
  assert.equal(r.said, "");
  assert.equal(plan([f("Clients/a.txt")], { root: "space", path: "Clients" }).said, "That is already where it is.");
});

test("plan: a folder cannot go into itself or below itself, but may go to a sibling with a similar name", () => {
  assert.match(plan([d("Plans")], { root: "space", path: "Plans" }).said, /Plans cannot go into itself/);
  assert.match(plan([d("Plans")], { root: "space", path: "Plans/2026" }).said, /Plans cannot go into itself/);
  assert.deepEqual(plan([d("Plans")], { root: "space", path: "Plans-old" }).go.map((x) => x.path), ["Plans"]);
});

test("plan: nothing crosses places, and nothing moves to a place that takes no moves", () => {
  assert.match(plan([f("a.txt", { root: "linked", link: "l1" })], { root: "space", path: "" }).said, /another place/);
  assert.match(plan([f("a.txt", { root: "linked", link: "l1" })], { root: "linked", link: "l2", path: "" }).said, /another place/);
  assert.equal(plan([f("a.txt", { root: "linked", link: "l1" })], { root: "linked", link: "l1", path: "Plans" }).go.length, 1);
  assert.match(plan([f("a.txt")], { root: "box", path: "" }).said, /inside the Space/);
  assert.match(plan([f("a.txt")], null).said, /inside the Space/);
  assert.equal(plan([], { root: "space", path: "" }).said, "Pick something to move.");
});

test("a mix keeps what can go and reports nothing when something does", () => {
  const r = plan([d("Plans"), f("a.txt")], { root: "space", path: "Plans" });
  assert.deepEqual(r.go.map((x) => x.path), ["a.txt"]);
  assert.equal(r.said, "");
});

test("the toast and the drag words", () => {
  assert.equal(movedLine(1, "Clients", 0), "Moved 1 item to Clients.");
  assert.equal(movedLine(3, "Clients", 1), "Moved 3 items to Clients. 1 stayed where it belongs.");
  assert.equal(movedLine(2, "Clients", 2), "Moved 2 items to Clients. 2 stayed where they belong.");
  assert.equal(dragWords([f("a.txt")], "Clients"), "Move a.txt to Clients");
  assert.equal(dragWords([f("a.txt"), f("b.txt")], "Clients"), "Move 2 items to Clients");
});

test("the drag type tells a row of this list from a file from outside", () => {
  assert.equal(carriesRows({ types: [DRAG_TYPE, "text/plain"] }), true);
  assert.equal(carriesRows({ types: ["Files"] }), false);
  assert.equal(carriesRows(null), false);
});

test("the picker offers folders, not the ones being moved, and crumbs name the way in", () => {
  const listing = [d("Plans"), f("a.txt"), d("Clients"), d("Archive")];
  assert.deepEqual(pickable(listing, [d("Plans"), f("a.txt")]).map((x) => x.path), ["Clients", "Archive"]);
  assert.deepEqual(pickerCrumbs("Space", [{ name: "Clients", path: "Clients" }, { name: "Dana", path: "Clients/Dana" }]), [{ name: "Space", key: "" }, { name: "Clients", key: "Clients" }, { name: "Dana", key: "Clients/Dana" }]);
});
