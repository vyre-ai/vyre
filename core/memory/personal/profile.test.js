// @ts-check
// The classes of identity memory: how the person works, writes and runs projects, what they build with, and their life.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { classOf, profile } from "./profile.js";

const fact = (rel, object, extra = {}) => ({ id: `${rel}:${object}`, rel, object, obj: `lit:${object}`, subj: "me", confidence: 0.95, current: true, sessions: 2, ...extra });
const personal = facts => ({ lookup: ({ subj, rel }) => facts.filter(f => (!subj || f.subj === subj) && (!rel || f.rel === rel)), called: () => null });

test("classOf: tools are the stack; a preference is writing, project management or working style by its words; everything else is life", () => {
  assert.equal(classOf("uses", "Postgres"), "stack");
  assert.equal(classOf("prefers", "short emails with bullets"), "writing_style");
  assert.equal(classOf("prefers", "a written status update before any meeting"), "pm_style");
  assert.equal(classOf("prefers", "working late"), "working_style");
  assert.equal(classOf("lives_in", "Lisbon"), "life");
  assert.equal(classOf("works_at", "Harlow Legal"), "life");
});

test("profile: every line has its class, and a class can be asked for alone", () => {
  const p = personal([fact("uses", "Postgres"), fact("uses", "Next.js"), fact("prefers", "concise replies"), fact("prefers", "async standups"), fact("prefers", "working late"), fact("lives_in", "Lisbon")]);
  const all = profile(/** @type {any} */ (p)).facts;
  assert.deepEqual(Object.fromEntries(all.map(f => [f.text, f.class])), {
    "You use Postgres.": "stack", "You use Next.js.": "stack", "You prefer concise replies.": "writing_style", "You prefer async standups.": "pm_style", "You prefer working late.": "working_style", "You live in Lisbon.": "life",
  });
  assert.deepEqual(profile(/** @type {any} */ (p), { class: "stack" }).facts.map(f => f.text).sort(), ["You use Next.js.", "You use Postgres."]);
  assert.deepEqual(profile(/** @type {any} */ (p), { class: "pm_style" }).facts.map(f => f.text), ["You prefer async standups."]);
});
