import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { allItems, currentItem, isActive, isTopLevel, phoneSplit } from "./nav.js";

const item = (id, href, match) => ({ id, label: id, icon: "now", href, match });

test("an item is current at its href and below it, not beside it", () => {
  assert.equal(isActive("/u/now", item("now", "/u/now")), true);
  assert.equal(isActive("/u/now/", item("now", "/u/now")), true);
  assert.equal(isActive("/u/projects/estate", item("p", "/u/projects")), true);
  assert.equal(isActive("/u/projects-old", item("p", "/u/projects")), false);
  assert.equal(isActive("/u/now?x=1", item("now", "/u/now")), true);
});

test("match prefixes make more routes belong to one item", () => {
  const settings = item("settings", "/u/settings", ["/u/appearance", "/u/spaces"]);
  assert.equal(isActive("/u/spaces", settings), true);
  assert.equal(isActive("/u/appearance", settings), true);
  assert.equal(isActive("/u/memory", settings), false);
});

test("the longest matching href wins", () => {
  const all = [item("records", "/u/records"), item("contacts", "/u/records/contact")];
  assert.equal(currentItem("/u/records/contact/c1", all)?.id, "contacts");
  assert.equal(currentItem("/u/records/matter", all)?.id, "records");
  assert.equal(currentItem("/u/elsewhere", all), null);
});

test("a phone shows four tabs and puts the rest under More", () => {
  const nav = { items: ["a", "b", "c", "d", "e"].map((i) => item(i, "/u/" + i)), more: [item("m", "/u/m")], bottom: [item("s", "/u/s")] };
  const { tabs, more } = phoneSplit(nav);
  assert.deepEqual(tabs.map((t) => t.id), ["a", "b", "c", "d"]);
  assert.deepEqual(more.map((t) => t.id), ["e", "m", "s"]);
});

test("a place named by the nav is top level; a task, a project or a record page is pushed", () => {
  const all = [item("now", "/u/now"), item("projects", "/u/projects", ["/u/project"]), item("settings", "/u/settings")];
  assert.equal(isTopLevel("/u/now", all), true);
  assert.equal(isTopLevel("/u/projects", all), true);
  assert.equal(isTopLevel("/u/records/matter", all), true);
  assert.equal(isTopLevel("/u/task/t1", all), false);
  assert.equal(isTopLevel("/u/project/p1", all), false);
  assert.equal(isTopLevel("/u/record/r1", all), false);
  assert.equal(isTopLevel("/u/now/needs", all), false);
  assert.equal(isTopLevel("/u/settings/account", all), false);
});

test("named groups: every item counts for current and top-level, and a phone's More lists them after the extra main items, each with its group", () => {
  const nav = { items: [item("a", "/u/a"), item("b", "/u/b"), item("c", "/u/c"), item("d", "/u/d"), item("e", "/u/e")], more: [item("m", "/u/m")], bottom: [item("s", "/u/settings")], groups: [{ name: "Work", items: [item("w", "/u/w")] }] };
  assert.deepEqual(allItems(nav).map((i) => i.id), ["a", "b", "c", "d", "e", "w", "m", "s"]);
  assert.equal(currentItem("/u/w", allItems(nav))?.id, "w");
  assert.equal(isTopLevel("/u/w", allItems(nav)), true);
  const { tabs, more } = phoneSplit(nav);
  assert.deepEqual(tabs.map((i) => i.id), ["a", "b", "c", "d"]);
  assert.deepEqual(more.map((i) => i.id), ["e", "w", "m", "s"]);
  assert.equal(more.find((i) => i.id === "w").group, "Work");
  assert.equal(phoneSplit({ items: nav.items, more: [], bottom: [] }).more.length, 1, "no groups: as before");
});
