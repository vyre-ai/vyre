// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLACES, builtinEntries, keyOf, clean, cleanList, merge, layout, move, moveBefore, setHidden, setGroup, add, remove, find, hiddenOf, moduleHref, MAX_ENTRIES } from "./model.js";

const DOCS = { module: "docuseal", label: "DocuSeal", screens: [{ id: "documents", label: "Documents", icon: "doc" }, { id: "templates", label: "Templates" }] };
const CAT = { modules: [DOCS], flags: { sites: true } };
const ids = (/** @type {any[]} */ l) => l.map(i => i.id);

test("with nothing stored the sidebar is today's NAV: five places, then more, then search and settings; Sites only where the build has it", () => {
  const l = layout(builtinEntries(), { flags: { sites: true } });
  assert.deepEqual(ids(l.items), ["now", "chat", "projects", "contacts", "drive", "sites"]);
  assert.deepEqual(ids(l.more), ["calendar", "memory", "vault", "flows", "assistants", "kits"]);
  assert.deepEqual(ids(l.bottom), ["search", "settings"]);
  assert.deepEqual(ids(layout(builtinEntries()).items), ["now", "chat", "projects", "contacts", "drive"]);
  assert.equal(PLACES.filter(p => p.group === "main").length, 6);
});

test("an entry is a place, a module screen or a saved view; stored text that is anything else is dropped, and a list is cleaned and capped", () => {
  assert.deepEqual(clean({ kind: "place", id: "now", junk: 1 }), { kind: "place", id: "now" });
  assert.deepEqual(clean({ kind: "module", module: "docuseal", screen: "documents", group: "Work", hidden: true }), { kind: "module", module: "docuseal", screen: "documents", group: "Work", hidden: true });
  assert.deepEqual(clean({ kind: "view", id: "open-leads", label: " Open leads ", href: "/u/records/lead?stage=open" }), { kind: "view", id: "open-leads", label: "Open leads", href: "/u/records/lead?stage=open" });
  for (const bad of [null, "x", {}, { kind: "place" }, { kind: "place", id: "Bad Id" }, { kind: "module", module: "a" }, { kind: "view", id: "x", label: "L", href: "https://evil.example" }, { kind: "view", id: "x", label: "L", href: "/u/../etc" }, { kind: "view", id: "x", label: "", href: "/u/now" }]) assert.equal(clean(bad), null, JSON.stringify(bad));
  assert.equal(clean({ kind: "place", id: "now", group: "bad/group" }).group, undefined);
  assert.deepEqual(cleanList([{ kind: "place", id: "now" }, { kind: "place", id: "now", hidden: true }, 7, { kind: "place", id: "chat" }]).map(keyOf), ["place:now", "place:chat"], "repeats drop, the first wins");
  assert.equal(cleanList(Array.from({ length: 300 }, (_, i) => ({ kind: "place", id: `p${i}` }))).length, MAX_ENTRIES);
  assert.deepEqual(cleanList({ entries: [{ kind: "place", id: "now" }] }).map(keyOf), ["place:now"], "a stored object with entries reads too");
  assert.deepEqual(cleanList("nope"), []);
});

test("a module screen shows once the module is installed and goes quietly when it is not", () => {
  const list = [...builtinEntries(), { kind: "module", module: "docuseal", screen: "documents" }];
  assert.ok(layout(list, CAT).more.some(i => i.label === "Documents" && i.href === moduleHref("docuseal", "documents") && i.icon === "doc"));
  assert.equal(moduleHref("docuseal", "documents"), "/u/module/docuseal/documents", "the app route that opens the screen on the module's own origin");
  assert.ok(!layout(list, { modules: [] }).more.some(i => i.label === "Documents"), "not installed: not drawn, not an error");
  assert.ok(!layout(list, { modules: [{ module: "docuseal", screens: [] }] }).more.some(i => i.label === "Documents"), "the screen is gone from the manifest");
});

test("the person's arrangement wins over the default; what the default gains later still reaches them", () => {
  const base = builtinEntries();
  const mine = setHidden(move(base, "place:kits", 0), "place:vault", true);
  const l = layout(merge(base, mine));
  assert.equal(ids(l.more)[0], "kits", "kits leads its own group");
  assert.ok(!ids([...l.items, ...l.more, ...l.bottom]).includes("vault"), "hidden stays hidden");
  // the admin adds a module screen to the default after the person arranged theirs
  const admin = add(base, { kind: "module", module: "docuseal", screen: "documents" }, { group: "more" });
  const m2 = merge(admin, mine);
  assert.ok(m2.some(e => keyOf(e) === "module:docuseal/documents"), "the later default entry is in");
  assert.ok(layout(m2, CAT).more.some(i => i.label === "Documents"));
  assert.deepEqual(merge(base, []).map(keyOf), base.map(keyOf), "no personal list: the default stands");
  // the order the person chose is kept
  assert.equal(merge(base, mine).map(keyOf)[0], "place:kits");
});

test("move, move before (drag) and group", () => {
  const base = builtinEntries();
  assert.equal(move(base, "place:drive", 0)[0].id, "drive");
  assert.deepEqual(move(base, "place:nope", 0).map(keyOf), base.map(keyOf));
  const dragged = moveBefore(base, "place:kits", "place:now");
  assert.equal(dragged[0].id, "kits");
  assert.equal(dragged[0].group, "main", "dropped before a main entry: it joins main");
  assert.deepEqual(base.map(keyOf), builtinEntries().map(keyOf), "the input list is not changed");
  const grouped = setGroup(base, "place:drive", "Work");
  const l = layout(grouped);
  assert.deepEqual(l.groups.map(g => [g.name, ids(g.items)]), [["Work", ["drive"]]]);
  assert.ok(!ids(l.items).includes("drive"));
  assert.equal(setGroup(base, "place:drive", "bad/name").find(e => e.id === "drive").group, "main", "a bad group name changes nothing");
  assert.equal(setGroup(grouped, "place:drive", null).find(e => e.id === "drive").group, undefined);
});

test("settings can never be hidden or removed, and comes back if a list lost it", () => {
  const base = builtinEntries();
  assert.ok(!setHidden(base, "place:settings", true).find(e => e.id === "settings").hidden);
  assert.ok(!remove(base, "place:settings").find(e => e.id === "settings").hidden);
  const lost = base.filter(e => e.id !== "settings");
  assert.ok(ids(layout(lost).bottom).includes("settings"));
  const forced = base.map(e => (e.id === "settings" ? { ...e, hidden: true } : e));
  assert.ok(ids(layout(/** @type {any} */ (forced)).bottom).includes("settings"));
});

test("add and remove: a place is hidden (and can come back), a module screen or a view is deleted; adding what is there shows it", () => {
  const base = builtinEntries();
  const hid = remove(base, "place:flows");
  assert.equal(hid.find(e => e.id === "flows").hidden, true);
  assert.deepEqual(hiddenOf(hid).map(h => h.label), ["Flows"]);
  assert.ok(!add(hid, { kind: "place", id: "flows" }).find(e => e.id === "flows").hidden, "adding it back shows it");
  const withView = add(base, { kind: "view", id: "open-leads", label: "Open leads", href: "/u/records/lead?stage=open" }, { group: "main" });
  assert.equal(withView.length, base.length + 1);
  assert.ok(ids(layout(withView).items).includes("v-open-leads"));
  assert.ok(withView.map(keyOf).indexOf("view:open-leads") <= withView.map(keyOf).indexOf("place:calendar"), "it lands at the end of its group, before the next group");
  assert.deepEqual(remove(withView, "view:open-leads").map(keyOf), base.map(keyOf));
  assert.equal(add(base, { kind: "view", id: "x", label: "L", href: "https://evil.example" }).length, base.length, "an invalid entry adds nothing");
});

test("find: the assistant's \"put Documents in my sidebar\" finds a module screen by its label, a place by its name, and nothing when two match", () => {
  assert.deepEqual(find("Documents", CAT), { entry: { kind: "module", module: "docuseal", screen: "documents" }, exact: true });
  assert.deepEqual(find("the Calendar page", CAT)?.entry, { kind: "place", id: "calendar" });
  assert.deepEqual(find("temp", CAT)?.entry, { kind: "module", module: "docuseal", screen: "templates" }, "a prefix of one label");
  assert.equal(find("s", CAT), null, "several labels contain it: ambiguous");
  assert.equal(find("nothing like this", CAT), null);
  assert.equal(find("", CAT), null);
  assert.deepEqual(find("open leads", CAT, [{ kind: "view", id: "open-leads", label: "Open leads", href: "/u/records/lead" }])?.entry.kind, "view");
});
