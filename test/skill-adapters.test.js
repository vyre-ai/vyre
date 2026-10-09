// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { placement, render, routePlugin, harnessOf } from "../lib/skill-adapters.js";
import { SKILL_HOMES } from "../core/sessions/drivers/skill-homes.js";

const SKILL = { name: "write-a-watcher", description: "Use when they want something watched.", text: "---\nname: write-a-watcher\ndescription: Use when they want something watched.\n---\n\n# Write a watcher\n\nSteps.\n", body: "# Write a watcher\n\nSteps.\n" };

test("placement: each harness reads SKILL.md where it reads it; an unknown harness or a bad name has no place", () => {
  assert.equal(placement(SKILL_HOMES, "claude", "write-a-watcher").path, ".claude/skills/write-a-watcher/SKILL.md");
  assert.equal(placement(SKILL_HOMES, "codex", "write-a-watcher").path, ".codex/skills/write-a-watcher/SKILL.md");
  assert.equal(placement(SKILL_HOMES, "grok", "x"), null);
  assert.equal(placement(SKILL_HOMES, "claude", "../etc"), null);
});

test("render: the SKILL.md goes unchanged where the harness reads skills; where it has none, the same words become instructions", () => {
  const native = /** @type {any} */ (render(SKILL_HOMES, "claude", SKILL, { skills: true }));
  assert.equal(native.mode, "native");
  assert.equal(native.files[0].text, SKILL.text, "never a rewrite");
  assert.equal(/** @type {any} */ (render(SKILL_HOMES, "codex", SKILL, null)).mode, "native", "a harness that did not say is trusted to read its own place");
  const noSkills = /** @type {any} */ (render(SKILL_HOMES, "codex", SKILL, { skills: false }));
  assert.equal(noSkills.mode, "instructions");
  assert.match(noSkills.text, /^## Skill: write-a-watcher\nUse when they want something watched\.\n\n# Write a watcher/);
  assert.equal(/** @type {any} */ (render(SKILL_HOMES, "grok", SKILL, { skills: true })).mode, "instructions", "no known place");
});

test("routePlugin: a plugin runs on its vendor's harness, and on another only where its needs are met, with the reason where not", () => {
  const capsBy = { claude: { subagents: true, mcp: true }, codex: { subagents: false, mcp: true }, grok: null };
  assert.deepEqual(routePlugin("openai", ["subagents"], capsBy), { native: "codex", also: ["claude", "grok"], not: [] });
  const r = routePlugin("anthropic", ["subagents"], capsBy);
  assert.equal(r.native, "claude");
  assert.deepEqual(r.also, ["grok"], "grok never showed otherwise");
  assert.deepEqual(r.not, [{ harness: "codex", reason: "needs subagents; codex does not offer subagents" }]);
  assert.equal(routePlugin("someone-else", [], capsBy).native, null);
  assert.equal(harnessOf("openrouter"), "openrouter");
  assert.equal(harnessOf("codex"), "codex");
});
