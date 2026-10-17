// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { levelCaps, roleOf, harnessesFor, runBrowse } from "./browse-lib.js";
import { AIS } from "../../lib/skill-library.js";

test("roleOf and levelCaps: members cannot approve space skills", () => {
  assert.equal(roleOf({ role: "admin" }), "admin");
  assert.equal(levelCaps("member").space.approve, false);
  assert.equal(levelCaps("owner").space.plugin, true);
  assert.equal(levelCaps("member").personal.approve, true);
});

test("role-scoped browse caps: owner may install plugins at space level; member may not", () => {
  for (const role of ["owner", "admin"]) {
    assert.equal(levelCaps(role).space.plugin, true, role);
    assert.equal(levelCaps(role).space.draft, true, role);
  }
  assert.equal(levelCaps("member").space.plugin, false);
  assert.equal(levelCaps("member").space.draft, false);
  assert.equal(levelCaps("member").personal.view, true);
});

test("harnessesFor lists every AI for a skill and plugins include codex", () => {
  assert.deepEqual(harnessesFor({ kind: "skill" }), [...AIS]);
  const h = harnessesFor({ kind: "plugin", body: JSON.stringify({ name: "p", description: "x enough words", vendor: "anthropic" }) });
  assert.ok(h.includes("claude") && h.includes("codex"));
});

test("runBrowse filters versions and returns drafts", async () => {
  const pack = await runBrowse({
    shown: (s) => s,
    identityPersonal: () => false,
    visible: async () => [{ id: "space/a", name: "a", level: "space", description: "d", tokens: 1 }],
    versionsFor: async () => [{ name: "a", level: "space", version: 2, state: "draft", scope: "", proposer: "person:p1" }],
    draftsFor: async () => [{ name: "b", level: "personal", version: 1, state: "draft", scope: "p1", proposer: "person:p1" }],
    maySeeVersion: (who, v) => v.level !== "personal" || v.scope === who.person,
    approvedMap: new Map([["space/a", { kind: "skill", body: "---\nname: a\ndescription: enough words here\n---\n" }]]),
  }, { limit: 10 }, { person: "p1", role: "member", chain: null });
  assert.equal(pack.skills.length, 1);
  assert.deepEqual(pack.skills[0].harnesses, [...AIS]);
  assert.equal(pack.drafts.length, 1);
  assert.equal(pack.role, "member");
});
