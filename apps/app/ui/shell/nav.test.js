import test from "node:test";
import assert from "node:assert/strict";
import { currentItem, isActive, phoneSplit } from "./nav.js";

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
