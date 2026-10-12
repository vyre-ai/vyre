import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MINE_WORDS, SPACE_WORDS, bodyOf, checkProposal, nextWords, skillsView } from "./skills-model.js";

test("the list is split by whose it is: the Space's and Vyre's together, her own apart; nothing else", () => {
  const v = skillsView({ skills: [
    { id: "space/intake", name: "intake", level: "space", description: "the intake checklist" },
    { id: "vyre/brief", name: "brief", level: "vyre", description: "write a brief" },
    { id: "personal/mine", name: "mine", level: "personal", description: "only mine" },
  ], total: 3 });
  assert.deepEqual(v.space.map((s) => s.name), ["intake"]);
  assert.deepEqual(v.vyre.map((s) => s.name), ["brief"]);
  assert.deepEqual(v.mine.map((s) => s.name), ["mine"]);
  assert.deepEqual(skillsView(null), { mine: [], space: [], vyre: [] });
  assert.match(SPACE_WORDS, /owner or an admin approves it/);
  assert.match(MINE_WORDS, /Only you and your assistant/);
});

test("a proposal becomes a SKILL.md draft, or is refused in words; what happens next is said", () => {
  const ok = checkProposal({ name: "intake-checklist", description: "  what to ask   a new client ", instructions: "Ask for the matter.", level: "space" });
  assert.deepEqual(ok, { input: { name: "intake-checklist", level: "space", kind: "skill", body: "---\nname: intake-checklist\ndescription: what to ask a new client\n---\nAsk for the matter.\n" } });
  assert.equal(bodyOf({ name: "a", description: "b", instructions: "c" }), "---\nname: a\ndescription: b\n---\nc\n");
  assert.match(/** @type {any} */ (checkProposal({ name: "has space", description: "d", instructions: "i", level: "space" })).error, /name is letters, numbers/);
  assert.match(/** @type {any} */ (checkProposal({ name: "ok", description: " ", instructions: "i", level: "space" })).error, /one line/);
  assert.match(/** @type {any} */ (checkProposal({ name: "ok", description: "d", instructions: "", level: "personal" })).error, /instructions/);
  assert.match(nextWords("space", "intake"), /waits for the owner or an admin to approve it/);
  assert.match(nextWords("personal", "mine"), /yours now/);
});

test("the screen reads only the door's skills rows, tags the Space's with the space and her own with Personal, and the Settings row opens it", () => {
  const src = fs.readFileSync(new URL("./SkillsScreen.tsx", import.meta.url), "utf8");
  for (const call of ["skills.list", "skills.get", "skills.draft", "skills.approve"]) assert.ok(src.includes(`"${call}"`), call);
  assert.ok(/list\(\[\.\.\.view\.space, \.\.\.view\.vyre\], spaceTag\)/.test(src) && /list\(view\.mine, homeTag\)/.test(src), "the Space's carry the space's tag, hers the Personal tag");
  assert.ok(/skills\.approve.*personal/s.test(src) && !/skills\.approve", \{ name: ok\.input\.name, level: "space"/.test(src), "she approves only her personal skill");
  assert.ok(fs.readFileSync(new URL("../settings/logic.js", import.meta.url), "utf8").includes('"/u/skills"'), "Settings has a Skills row");
  assert.ok(fs.existsSync(new URL("../../app/u/skills.tsx", import.meta.url)), "the route exists");
});
