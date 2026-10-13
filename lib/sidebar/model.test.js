// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLACES, builtinEntries, keyOf, clean, cleanList, merge, layout, move, moveBefore, setHidden, setGroup, add, remove, find, hiddenOf, moduleHref, MAX_ENTRIES } from "./model.js";

const DOCS = { module: "docuseal", label: "DocuSeal", screens: [{ id: "documents", label: "Documents", icon: "doc" }, { id: "templates", label: "Templates" }] };
const CAT = { modules: [DOCS], flags: { sites: true } };
const ids = (/** @type {any[]} */ l) => l.map(i => i.id);

test("with nothing stored the sidebar is the Quiet structure: five places, an AI group, a Build group only for admins, Settings last; Sites only where the build has it", () => {
  const l = layout(builtinEntries(), { flags: { sites: true }, admin: true });
  assert.deepEqual(ids(l.items), ["now", "chat", "projects", "records", "drive", "sites"]);
  assert.deepEqual(l.groups.map(g => [g.name, ids(g.items)]), [["AI", ["assistants", "flows"]], ["Build", ["templates", "record-types", "kits"]]]);
  assert.deepEqual(ids(l.more), ["calendar", "memory", "vault"]);
  assert.deepEqual(ids(l.bottom), ["settings"]);
  assert.deepEqual(ids(layout(builtinEntries()).items), ["now", "chat", "projects", "records", "drive"]);
  assert.equal(PLACES.filter(p => p.group === "main").length, 6);
});

test("the Build group is for owners and admins: a member never sees it, and cannot find its places by name", () => {
  assert.deepEqual(layout(builtinEntries(), {}).groups.map(g => g.name), ["AI"]);
  assert.deepEqual(layout(builtinEntries(), { admin: false }).groups.map(g => g.name), ["AI"]);
  assert.equal(find("Templates", {}), null);
  assert.equal(find("Templates", { admin: true }).entry.id, "templates");
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
  const mine = setHidden(move(base, "place:memory", 0), "place:vault", true);
  const l = layout(merge(base, mine));
  assert.equal(ids(l.more)[0], "memory", "memory leads its own group");
  assert.ok(!ids([...l.items, ...l.more, ...l.bottom]).includes("vault"), "hidden stays hidden");
  // the admin adds a module screen to the default after the person arranged theirs
  const admin = add(base, { kind: "module", module: "docuseal", screen: "documents" }, { group: "more" });
  const m2 = merge(admin, mine);
  assert.ok(m2.some(e => keyOf(e) === "module:docuseal/documents"), "the later default entry is in");
  assert.ok(layout(m2, CAT).more.some(i => i.label === "Documents"));
  assert.deepEqual(merge(base, []).map(keyOf), base.map(keyOf), "no personal list: the default stands");
  // the order the person chose is kept
  assert.equal(merge(base, mine).map(keyOf)[0], "place:memory");
});

test("move, move before (drag) and group", () => {
  const base = builtinEntries();
  assert.equal(move(base, "place:drive", 0)[0].id, "drive");
  assert.deepEqual(move(base, "place:nope", 0).map(keyOf), base.map(keyOf));
  const dragged = moveBefore(base, "place:memory", "place:now");
  assert.equal(dragged[0].id, "memory");
  assert.equal(dragged[0].group, "main", "dropped before a main entry: it joins main");
  assert.deepEqual(base.map(keyOf), builtinEntries().map(keyOf), "the input list is not changed");
  const grouped = setGroup(base, "place:drive", "Work");
  const l = layout(grouped);
  assert.deepEqual(l.groups.map(g => [g.name, ids(g.items)]), [["Work", ["drive"]], ["AI", ["assistants", "flows"]]]);
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

test("a tag filter is a pinnable saved view: its entry is a view whose href is the tag's page (R031-02)", async () => {
  const { href } = await import("../tags.js");
  const e = { kind: "view", id: "tag-client", label: "#client", href: href("Client") };
  assert.equal(e.href, "/u/tags/client");
  assert.deepEqual(clean(e), e, "the sidebar accepts it as written");
  const list = add(builtinEntries(), e, { group: "main" });
  assert.ok(list.some(x => x.kind === "view" && x.id === "tag-client"), "pinned");
  assert.equal(href("not a/tag"), "/u/tags/", "a bad tag has no page");
});

test("a saved view entry may carry its definition: a records view, cleaned field by field, so a stored list never holds anything else", () => {
  const v = { type: "lead", name: "mine-pipeline", layout: "board", groupBy: "stage", filter: 'stage != "Won"', sort: { field: "value", dir: "desc" }, columns: ["name", "value"] };
  const e = clean({ kind: "view", id: "records-lead-mine-pipeline", label: "Pipeline", href: "/u/records/lead?view=mine-pipeline", icon: "board", hidden: true, view: { ...v, junk: 1 } });
  assert.deepEqual(e.view, v);
  assert.equal(e.hidden, true, "saved, not pinned");
  const keep = (/** @type {any} */ over) => clean({ kind: "view", id: "x", label: "X", href: "/u/records/lead", view: { type: "lead", name: "mine-x", layout: "list", ...over } });
  assert.deepEqual(keep({}).view, { type: "lead", name: "mine-x", layout: "list" });
  for (const bad of [{ layout: "pie" }, { type: "Bad Type" }, { name: "" }]) assert.equal(keep(bad).view, undefined, JSON.stringify(bad) + ": without a type, name and layout the definition goes, the entry stays");
  for (const bad of [{ groupBy: "a b" }, { filter: "x".repeat(2001) }, { filter: 7 }, { sort: { field: "a", dir: "up" } }, { sort: "a" }, { columns: "a" }, { columns: Array.from({ length: 41 }, () => "a") }, { columns: ["a b"] }])
    assert.deepEqual(keep(bad).view, { type: "lead", name: "mine-x", layout: "list" }, JSON.stringify(bad) + ": a bad part is dropped, the view stays");
  assert.equal(clean({ kind: "view", id: "x", label: "X", href: "/u/records/lead", view: "nope" }).view, undefined);
  assert.equal(clean({ kind: "place", id: "now", view: { type: "lead", name: "a", layout: "list" } }).view, undefined, "only a view entry carries one");
});

test("moving, hiding and renaming a saved view keeps its definition, and unpinning (hide) keeps it saved", () => {
  const mk = (/** @type {string} */ n) => clean({ kind: "view", id: `records-lead-${n}`, label: n, href: `/u/records/lead?view=${n}`, view: { type: "lead", name: n, layout: "list" } });
  let list = /** @type {any[]} */ ([mk("a"), mk("b"), mk("c")]);
  list = /** @type {any[]} */ (moveBefore(list, "view:records-lead-c", "view:records-lead-a"));
  assert.deepEqual(ids(list), ["records-lead-c", "records-lead-a", "records-lead-b"]);
  list = /** @type {any[]} */ (setHidden(list, "view:records-lead-a", true));
  assert.equal(list.find(e => e.id === "records-lead-a").view.name, "a");
  assert.equal(cleanList(list).find(e => e.id === "records-lead-a").hidden, true, "still stored after a clean");
});
