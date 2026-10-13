import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { RAIL_KEY, readCollapsed, writeCollapsed, isToggleKey, railWidth } from "./rail-state.js";
import { panelFor, withSide, backTo, PANELS, filterItems, groupItems } from "./sidebar-stack.js";

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), m }; };

test("collapsed is remembered per device, and a broken or missing store means expanded", () => {
  const s = store();
  assert.equal(readCollapsed(s), false);
  writeCollapsed(s, true);
  assert.equal(s.m.get(RAIL_KEY), "1");
  assert.equal(readCollapsed(s), true);
  writeCollapsed(s, false);
  assert.equal(readCollapsed(s), false);
  assert.equal(readCollapsed({ getItem() { throw new Error("blocked"); } }), false);
  assert.doesNotThrow(() => writeCollapsed({ setItem() { throw new Error("blocked"); } }, true));
  assert.equal(readCollapsed(null), false);
});

test("the shortcut is Cmd or Ctrl with a backslash, and nothing else", () => {
  assert.equal(isToggleKey({ key: "\\", metaKey: true }), true);
  assert.equal(isToggleKey({ key: "\\", ctrlKey: true }), true);
  assert.equal(isToggleKey({ key: "\\" }), false);
  assert.equal(isToggleKey({ key: "\\", ctrlKey: true, shiftKey: true }), false);
  assert.equal(isToggleKey({ key: "b", metaKey: true }), false);
});

test("the rail is wide when expanded and slim when folded", () => {
  assert.ok(railWidth(false, 248) === 248);
  assert.ok(railWidth(true, 248) < 80 && railWidth(true, 248) >= 56);
});

test("a path inside a place drills the sidebar into that place's panel; the place's own front page shows the main sidebar", () => {
  assert.equal(panelFor("/u/project/p1"), "projects");
  assert.equal(panelFor("/u/projects"), null);
  assert.equal(panelFor("/u/chats/c9"), "chats");
  assert.equal(panelFor("/u/chats"), null);
  assert.equal(panelFor("/u/records/contact"), "records");
  assert.equal(panelFor("/u/record/r1"), "records");
  assert.equal(panelFor("/u/drive/folder-1"), "drive");
  assert.equal(panelFor("/u/flows/f1"), "flows");
  assert.equal(panelFor("/u/assistants/a1"), "agents");
  assert.equal(panelFor("/u/settings/devices"), "settings");
  assert.equal(panelFor("/u/settings"), "settings", "Settings opens on its sections");
  assert.equal(panelFor("/u/now"), null);
  assert.equal(panelFor("/u/project/p1/"), "projects", "a trailing slash is the same place");
  assert.equal(panelFor("/u/projectx/p1"), null, "a prefix is a whole segment, not a string start");
});

test("Back keeps the page and folds the sidebar to the main one, in the URL, so a reload keeps it; leaving the place resets it", () => {
  assert.equal(panelFor("/u/project/p1", "?side=main"), null);
  assert.equal(panelFor("/u/project/p1", "side=main&x=1"), null);
  assert.equal(panelFor("/u/project/p1", "?x=1"), "projects");
  assert.equal(withSide("/u/project/p1", "", "main"), "/u/project/p1?side=main");
  assert.equal(withSide("/u/records/lead", "?view=open", "main"), "/u/records/lead?view=open&side=main");
  assert.equal(withSide("/u/records/lead", "?view=open&side=main", "main"), "/u/records/lead?view=open&side=main");
  assert.equal(withSide("/u/records/lead", "?view=open&side=main", null), "/u/records/lead?view=open");
  assert.equal(backTo("/u/project/p1", ""), "/u/project/p1?side=main");
  assert.equal(backTo("/u/now", ""), null, "nothing to go back from on the main sidebar");
});

test("every panel has a title, a root and prefixes under /u", () => {
  for (const p of PANELS) { assert.ok(p.id && p.title && p.root.startsWith("/u/")); assert.ok(p.prefixes.every((x) => x.startsWith("/u/"))); }
});

test("a panel's list filters by a typed word and groups by a field, keeping order", () => {
  const items = [{ id: "a", label: "Smith probate", group: "Matter" }, { id: "b", label: "Jones estate", group: "Matter" }, { id: "c", label: "Spring ads", group: "Campaign" }];
  assert.deepEqual(filterItems(items, "  PRO ").map((i) => i.id), ["a"]);
  assert.deepEqual(filterItems(items, "").map((i) => i.id), ["a", "b", "c"]);
  assert.deepEqual(groupItems(items).map((g) => [g.label, g.items.map((i) => i.id)]), [["Matter", ["a", "b"]], ["Campaign", ["c"]]]);
  assert.deepEqual(groupItems([{ id: "x", label: "X" }]).map((g) => g.label), [""], "no group: one unlabelled section");
});
