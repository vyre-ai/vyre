// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveApproved } from "./skill-resolve.js";
import { materialise, AIS } from "./skill-library.js";
import { PLUGIN_LAYOUT } from "../core/sessions/config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const row = (/** @type {string} */ name, /** @type {string} */ level, /** @type {string} */ scope = "") => ({ name, level, scope, state: "approved", kind: "skill", body: `---\nname: ${name}\ndescription: Use when testing precedence for ${name}.\n---\n\n# ${name}\n`, version: 1 });

test("resolveApproved: a space skill keeps its name; personal cannot override it", () => {
  const who = { person: "per_alice", agent: null, projects: [], allAgents: false };
  const items = [row("house-style", "space"), row("house-style", "personal", "per_alice"), row("my-habits", "personal", "per_alice")];
  const out = resolveApproved(items, who);
  assert.deepEqual(out.map(i => [i.name, i.level]), [["house-style", "space"], ["my-habits", "personal"]]);
});

test("resolveApproved: among non-space levels the narrower level still wins", () => {
  const who = { person: "per_alice", agent: "kit", projects: ["rivera"], allAgents: false };
  const items = [row("tooling", "personal", "per_alice"), row("tooling", "agent", "kit"), row("tooling", "project", "rivera")];
  const out = resolveApproved(items, who);
  assert.deepEqual(out.map(i => i.name), ["tooling"]);
  assert.equal(out[0].level, "project");
});

for (const ai of AIS) {
  test(`materialise writes skills for harness ${ai}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-mat-${ai}-`));
    const items = [row("alpha", "space"), row("beta", "personal", "per_x")];
    materialise(dir, ai, items, { manifest: PLUGIN_LAYOUT.manifest });
    assert.ok(fs.existsSync(path.join(dir, "skills", "alpha", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(dir, "skills", "beta", "SKILL.md")));
    if (ai === "codex") assert.ok(!fs.existsSync(path.join(dir, ".claude-plugin")));
    else assert.ok(fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json")));
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
