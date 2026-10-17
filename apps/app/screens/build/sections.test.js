// Build's rules: which section a path is in, and how the arrow keys step.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { BUILD_SECTIONS, BUILD_PREFIXES, sectionOf, stepSection } from "./sections.js";

test("five sections, Playbooks through Kits", () => {
  assert.deepEqual(BUILD_SECTIONS.map((s) => s[1]), ["Playbooks", "Skills and plugins", "Objects", "Documents", "Kits"]);
});

test("a path is in a section by its own route or inside it, the old routes included", () => {
  assert.equal(sectionOf("/u/playbooks"), "playbooks");
  assert.equal(sectionOf("/u/templates"), "playbooks");
  assert.equal(sectionOf("/u/templates/abc"), "playbooks");
  assert.equal(sectionOf("/u/settings/customize/matter"), "objects");
  assert.equal(sectionOf("/u/skills"), "skills");
  assert.equal(sectionOf("/u/kits/estate?x=1"), "kits");
  assert.equal(sectionOf("/u/documents?tab=made"), "documents");
  assert.equal(sectionOf("/u/settings"), null);
  assert.equal(sectionOf("/u/settings/rules"), null);
});

test("the arrows step through the list and stop at the ends", () => {
  assert.equal(stepSection("playbooks", 1), "/u/skills");
  assert.equal(stepSection("skills", 1), "/u/settings/customize");
  assert.equal(stepSection("objects", 1), "/u/documents?tab=templates");
  assert.equal(stepSection("documents", 1), "/u/kits");
  assert.equal(stepSection("kits", 1), null);
  assert.equal(stepSection("playbooks", -1), null);
  assert.equal(stepSection(null, 1), "/u/playbooks");
});

test("every Build path is one the sidebar can drill into", () => {
  assert.deepEqual(BUILD_PREFIXES, ["/u/playbooks", "/u/templates", "/u/skills", "/u/settings/customize", "/u/documents", "/u/kits"]);
});

import { panelFor, backTo } from "../../ui/shell/sidebar-stack.js";
test("the sidebar drills into Build for every Build path, and Settings keeps its own", () => {
  for (const p of ["/u/playbooks", "/u/templates/x", "/u/skills", "/u/documents", "/u/kits", "/u/kits/estate", "/u/settings/customize", "/u/settings/customize/matter"]) assert.equal(panelFor(p, ""), "build", p);
  assert.equal(panelFor("/u/settings/rules", ""), "settings");
  assert.equal(backTo("/u/playbooks", ""), "/u/playbooks?side=main");
});
