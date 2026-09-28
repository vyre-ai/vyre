// @ts-check
// core/style (docs/adr/0037-style.md): style.append composes the house-voice block plus a
// person's own free-text addition, or null when style is off for a project or the account; on
// and off, get and set, all ride core/settings' own storage and person-only gate, so these
// tests are mostly about the composition and the callers gate, not a new store.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { HOUSE_VOICE } from "./index.js";
import { PATTERNS } from "../../lib/plain-prose.js";
import fs from "node:fs";

/** A vyred in a temp home, with a project already made. No sessions driver needed: style has no session of its own. */
async function boot(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", sessions: { install: false }, projectsDir: path.join(root, "projects") }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const tool = async (name, input, caller = "cli", extra = {}) => {
    const r = await call(name, input, { root, caller, timeout: 20_000, ...extra });
    if (r.error) throw Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code });
    return r.data;
  };
  const project = await tool("projects.create", { name: "Harlow Legal" });
  return { root, d, tool, project };
}

test("style.append: on by default, no override, is the fixed house voice and nothing else", async t => {
  const { tool, project } = await boot(t);
  const r = await tool("style.append", { project: project.slug });
  assert.equal(r.text, HOUSE_VOICE);
});

test("style.append: a person's own rules, set at project level, ride along after the house voice", async t => {
  const { tool, project } = await boot(t);
  await tool("settings.set", { key: "style.rules", value: "sign off notes with initials", project: project.slug, level: "project" });
  const r = await tool("style.append", { project: project.slug });
  assert.match(r.text, /^Write in Vyre's house voice/);
  assert.match(r.text, /sign off notes with initials$/);
});

test("style.append: a person turning style off for the project returns null, the account default stays on for another project", async t => {
  const { tool, project } = await boot(t);
  const other = await tool("projects.create", { name: "Northwind Bakery" });
  await tool("settings.set", { key: "style.enabled", value: false, project: project.slug, level: "project" });
  assert.equal((await tool("style.append", { project: project.slug })).text, null);
  assert.equal((await tool("style.append", { project: other.slug })).text, HOUSE_VOICE);
});

test("style.append: the account default turns every project off unless a project override turns it back on", async t => {
  const { tool, project } = await boot(t);
  await tool("settings.set", { key: "style.enabled", value: false, level: "account" });
  assert.equal((await tool("style.append", { project: project.slug })).text, null);
  await tool("settings.set", { key: "style.enabled", value: true, project: project.slug, level: "project" });
  assert.equal((await tool("style.append", { project: project.slug })).text, HOUSE_VOICE);
});

test("style.enabled and style.rules are person-only to set, the same gate every other Vyre setting uses", async t => {
  const { root, project } = await boot(t);
  const r = await call("settings.set", { key: "style.enabled", value: false, project: project.slug, level: "project" }, { root, caller: "mcp", timeout: 20_000 });
  assert.ok(r.error);
});

test("style.append refuses a bare mcp caller (reviewer's earlier LOW on team.project-append, same class of leak)", async t => {
  const { root, project } = await boot(t);
  const r = await call("style.append", { project: project.slug }, { root, caller: "mcp", timeout: 20_000 });
  assert.ok(r.error);
  assert.equal(r.error.code, "denied");
});

test("style.rules: capped at 500 characters (team-lead's ask), the type check's own 4000-character default is not the effective limit", async t => {
  const { root, project } = await boot(t);
  const r = await call("settings.set", { key: "style.rules", value: "x".repeat(501), project: project.slug, level: "project" }, { root, caller: "cli", timeout: 20_000 });
  assert.ok(r.error);
  assert.match(r.error.message, /500/);
  const ok = await call("settings.set", { key: "style.rules", value: "x".repeat(500), project: project.slug, level: "project" }, { root, caller: "cli", timeout: 20_000 });
  assert.ok(!ok.error);
});

test("the house voice itself follows its own rules: no em dash, about 150 words", () => {
  assert.ok(!HOUSE_VOICE.includes("—"), "HOUSE_VOICE must never itself use an em dash");
  const words = HOUSE_VOICE.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 200, `HOUSE_VOICE is ${words} words, meant to stay around 150`);
});

test("style.patterns: a fixed list, matching the house voice's own bans (em dash first)", async t => {
  const { tool } = await boot(t);
  const { patterns } = await tool("style.patterns", {});
  assert.ok(patterns.length > 0);
  assert.equal(patterns[0].id, "em-dash");
  for (const p of patterns) {
    const re = new RegExp(p.pattern, p.flags);
    assert.ok(re instanceof RegExp, `${p.id}'s pattern must compile`);
  }
  const em = patterns.find(p => p.id === "em-dash");
  assert.ok(new RegExp(em.pattern, em.flags).test("a sentence — with an em dash"));
});
