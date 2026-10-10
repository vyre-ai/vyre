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
  assert.deepEqual(entryAction({ type: "flow-run", id: "rec", run: "run_7", flow: "welcome" }), { route: "/u/flows/welcome?run=run_7" }, "a Flow run opens its run");
  assert.equal(entryAction({ type: "flow-run", id: "rec" }), null, "an older box that names no run has nothing to open");
  for (const type of ["stage", "project-start", "file-share"]) assert.equal(entryAction({ type, id: "x" }), null, type);
});
