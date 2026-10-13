import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tabsFor, firstTab, panesAt, isTemplateProject, chatLabel } from "./panes.ts";

const free = { name: "Plain chats" };
const tpl = { name: "Rivera", template_snapshot: '{"stages":[]}' };

test("a free-flow project opens on its chats with Files and Memory beside them; a template project opens on its stages first", () => {
  assert.equal(isTemplateProject(free), false);
  assert.equal(isTemplateProject(tpl), true);
  assert.equal(firstTab(free), "chats");
  assert.deepEqual(tabsFor(free).map(([p]) => p), ["chats", "files", "memory", "timeline", "team"]);
  assert.equal(firstTab(tpl), "stages");
  assert.deepEqual(tabsFor(tpl).map(([p]) => p), ["stages", "chats", "files", "memory", "timeline", "team"]);
  assert.equal(firstTab(undefined), "chats");
});

test("panes sit side by side on a wide window: one on a phone and a laptop, two from 1100, three from 1280; the tab chosen is never hidden", () => {
  assert.deepEqual(panesAt(390, "chats", free), ["chats"]);
  assert.deepEqual(panesAt(1024, "files", free), ["files"]);
  assert.deepEqual(panesAt(1200, "chats", free), ["chats", "files"]);
  assert.deepEqual(panesAt(1440, "chats", free), ["chats", "files", "memory"], "a laptop shows all three");
  assert.deepEqual(panesAt(1920, "chats", free), ["chats", "files", "memory"]);
  assert.deepEqual(panesAt(1200, "stages", tpl), ["stages", "chats"]);
  assert.deepEqual(panesAt(1440, "stages", tpl), ["stages", "chats", "files"]);
  assert.deepEqual(panesAt(1920, "stages", tpl), ["stages", "chats", "files"]);
  assert.deepEqual(panesAt(1200, "memory", free), ["chats", "memory"], "a tab outside the pair takes the last place");
  assert.deepEqual(panesAt(1920, "team", tpl), ["team"], "the team is a tab only");
  assert.deepEqual(panesAt(1920, "timeline", tpl), ["timeline"], "so is the timeline");
});

test("the chat button says Chat on a phone, where a longer label would cut the project's name, and the whole phrase on a wide screen", () => {
  assert.equal(chatLabel(390), "Chat");
  assert.equal(chatLabel(1099), "Chat");
  assert.equal(chatLabel(1440), "Chat about this");
});

test("a timeline groups newest-first entries under one heading per day, and an entry opens only what it is about", async () => {
  const { groupByDay, entryAction } = await import("./days.js");
  const DAY = 86_400_000, base = Date.UTC(2026, 9, 10, 12);
  const rows = [{ at: base, id: "a" }, { at: base - 3_600_000, id: "b" }, { at: base - DAY, id: "c" }, { at: 0, id: "d" }];
  assert.deepEqual(groupByDay(rows, "UTC").map((g) => g.items.map((x) => x.id)), [["a", "b"], ["c"], ["d"]]);
  assert.deepEqual(groupByDay([], "UTC"), []);
  assert.deepEqual(entryAction({ type: "chat", id: "x", chat: "chat_1" }), { route: "/u/chats/chat_1" });
  assert.deepEqual(entryAction({ type: "email", id: "rec-9" }), { route: "/u/record/rec-9" });
  assert.deepEqual(entryAction({ type: "flow-run", id: "rec", run: "run_7", flow: "welcome" }), { route: "/u/flows/welcome/runs/run_7" }, "a Flow run opens its run");
  assert.equal(entryAction({ type: "flow-run", id: "rec" }), null, "an older box that names no run has nothing to open");
  for (const type of ["stage", "project-start", "file-share"]) assert.equal(entryAction({ type, id: "x" }), null, type);
});

test("a template project opens on the page its template chose (G21); an unknown or unreadable choice is ignored", () => {
  const files = { name: "R", template_snapshot: JSON.stringify({ opens_on: "files", stages: [] }) };
  assert.equal(firstTab(files), "files");
  assert.deepEqual(tabsFor(files).map(([p]) => p), ["files", "stages", "chats", "memory", "timeline", "team"]);
  assert.equal(firstTab({ name: "R", template_snapshot: JSON.stringify({ opens_on: "dashboard", stages: [] }) }), "stages");
  assert.equal(firstTab({ name: "R", template_snapshot: "not json" }), "stages");
  assert.equal(firstTab({ name: "Free", opens_on: "files" }), "chats", "a free-flow project has no template to choose");
});

test("on a wide window the page a template chose leads the panes, and the others keep their order (G21)", () => {
  const files = { name: "R", template_snapshot: JSON.stringify({ opens_on: "files", stages: [] }) };
  assert.deepEqual(panesAt(1440, "files", files), ["files", "stages", "chats"]);
  assert.deepEqual(panesAt(1100, "files", files), ["files", "stages"]);
  assert.deepEqual(panesAt(1440, "stages", { name: "R", template_snapshot: '{"stages":[]}' }), ["stages", "chats", "files"], "no choice, the usual order");
});

test("the redone project page: the rail's sections, the phone's tabs, and a project with no short name still has a reference", async () => {
  const { railFor, pageTabs, refOf } = await import("./panes.ts");
  assert.deepEqual(railFor(free), ["instructions", "context", "files", "memory", "access"]);
  assert.deepEqual(railFor(tpl), ["stages", "instructions", "context", "files", "memory", "access"]);
  assert.deepEqual(pageTabs().map(([p]) => p), ["chats", "about", "files", "memory", "timeline", "team"]);
  assert.equal(refOf("northwind", "rec-1"), "northwind");
  assert.equal(refOf("", "rec-1"), "rec-1", "no short name: the record id is the reference");
  assert.equal(refOf("", ""), "");
});
