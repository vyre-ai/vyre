import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tabsFor, firstTab, panesAt, isTemplateProject } from "./panes.ts";

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
