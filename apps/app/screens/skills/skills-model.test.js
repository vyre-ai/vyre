import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { listRows, needsLines, stateWord, versionLine, SEGMENTS } from "./skills-model.js";

const pack = {
  skills: [{ id: "personal/house-style", name: "house-style", level: "personal", description: "How we write" }, { id: "space/stripe-sync", name: "stripe-sync", level: "space", kind: "plugin", description: "Sync payments", declares: { hooks: [{ id: "h", event: "PostToolUse", network: ["api.stripe.com"] }], mcp: [{ name: "stripe", transport: "http" }] } }],
  drafts: [{ name: "intake-checklist", level: "space", version: 2, state: "draft", proposer: "Dana" }, { name: "billing-hook", level: "space", version: 1, state: "draft", kind: "plugin" }],
};

test("the segments are Skills and Plugins, and each list is what is in use, then what waits for a yes", () => {
  assert.deepEqual(SEGMENTS.map((s) => s[1]), ["Skills", "Plugins"]);
  const skills = listRows(pack, "skills");
  assert.deepEqual(skills.map((r) => [r.name, r.state, r.draft]), [["house-style", "In use", false], ["intake-checklist", "Waiting for a yes", true]]);
  assert.equal(skills[0].sub, "How we write · Yours");
  assert.equal(skills[1].sub, "This Space · proposed by Dana");
  assert.deepEqual(listRows(pack, "plugins").map((r) => r.name), ["stripe-sync", "billing-hook"]);
  assert.deepEqual(listRows({}, "skills"), []);
});

test("states are plain words, a version line says its state, and a plugin says what it needs", () => {
  assert.deepEqual(["approved", "draft", "retired", "odd"].map(stateWord), ["In use", "Waiting for a yes", "Retired", ""]);
  assert.equal(versionLine({ name: "x", level: "space", version: 3, state: "retired" }), "Version 3, retired");
  assert.equal(versionLine({ name: "x", level: "space", version: 4, state: "odd" }), "Version 4, odd");
  assert.deepEqual(needsLines(pack.skills[1].declares), ["Reaches api.stripe.com", "Adds the MCP server stripe"]);
  assert.deepEqual(needsLines(undefined), []);
});
