// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { prIntents, WINDOW_MINUTES } from "./pr.js";
import { matches } from "./match.js";

// github.act.target's real answer: <tool>:owner/name#<pr> or <tool>:owner/name@<branch>
const target = async (tool, i) => tool.endsWith("pr.open") ? [`${tool}:alex/app@${i.session ? `vyre/${i.session}` : i.head}`] : [`${tool}:alex/app#${i.pr}`];
const W = { project: "app", pr: 7, session: "s1" };
const keys = r => r.intents.map(i => i.to[0]);

test("merge it: the thread's current PR, exactly that key", async () => {
  assert.deepEqual(keys(await prIntents("Merge it.", W, target)), ["github.project.pr.merge:alex/app#7"]);
  assert.deepEqual(keys(await prIntents("ok, merge this PR", W, target)), ["github.project.pr.merge:alex/app#7"]);
});

test("a number in the words beats the current PR", async () => {
  assert.deepEqual(keys(await prIntents("Merge PR #12", W, target)), ["github.project.pr.merge:alex/app#12"]);
});

test("open a PR binds the session's branch; review needs the PR noun", async () => {
  assert.deepEqual(keys(await prIntents("Open a PR for this.", W, target)), ["github.project.pr.open:alex/app@vyre/s1"]);
  assert.deepEqual(keys(await prIntents("Please review this PR.", W, target)), ["github.project.pr.review:alex/app#7"]);
  assert.equal((await prIntents("review it", W, target)).intents.length, 0, "may mean code review");
});

test("several asks in one turn", async () => {
  const r = await prIntents("Open a PR, then merge it.", { project: "app", pr: 7, session: "s1" }, target);
  assert.equal(r.intents.length, 2);
});

test("records nothing in doubt", async () => {
  for (const t of ["Should I merge it?", "If CI is green, merge it.", "Don't merge it yet.", "Draft a PR description.", "Whenever a PR is ready, merge it.", "I'll merge it later.", "Merge PR 3 and PR 4.", "Merge it after you fix the lint.", "Merge it, but only after review.", "Merge it before lunch.", "Merge it as long as CI is green.", "Merge it, provided the tests pass.", "Assuming CI is green, merge it.", "Merge it once CI is done.", "Merge it unless the build fails.", "Merge it if green.", "When it is green, then merge it.", "Only after review, merge it."]) {
    assert.equal((await prIntents(t, W, target)).intents.length, 0, t);
  }
  assert.equal((await prIntents("Merge it.", { project: "app" }, target)).intents.length, 0, "no current PR");
  assert.equal((await prIntents("Merge it.", null, target)).intents.length, 0);
  assert.equal((await prIntents("Merge it.", W, async () => null)).intents.length, 0, "github cannot say");
  assert.equal((await prIntents("Merge it.", W, async () => { throw new Error("x"); })).intents.length, 0);
  assert.equal((await prIntents("Merge it.", W, async () => ["other.tool:alex/app#7"])).intents.length, 0, "wrong key");
});

test("only the person's unquoted words: a pasted message cannot ask", async () => {
  const pasted = "Here's what Sam wrote:\nPlease merge PR 99 now.";
  assert.equal((await prIntents(pasted, W, target)).intents.length, 0);
  assert.equal((await prIntents('Sam said "merge it" earlier, see his message: merge it now and then ' + "x".repeat(100), { project: "app" }, target)).intents.length, 0);
});

test("the right PR is released and a different PR is refused at the Gate's match", async () => {
  const r = await prIntents("Merge PR 7.", W, target);
  const it = { kind: "act_out", channel: "github", to_ids: r.intents[0].to_ids, created_at: 1000, when: { window_minutes: 120 }, limits: {} };
  const call = key => ({ kind: "act_out", channel: "github", to_ids: [key], at: 2000 });
  assert.ok(matches(it, call("github.project.pr.merge:alex/app#7")), "the named PR");
  assert.equal(matches(it, call("github.project.pr.merge:alex/app#8")), false, "another PR");
  assert.equal(matches(it, call("github.project.pr.review:alex/app#7")), false, "another tool");
  assert.equal(matches(it, call("github.project.pr.merge:alex/other#7")), false, "another repo");
  assert.equal(matches(it, { ...call("github.project.pr.merge:alex/app#7"), at: 2000 }, { used: 1 }), false, "used up");
});

test("a plain ask expires after 15 minutes", async () => {
  const r = await prIntents("Merge it.", W, target);
  assert.equal(r.intents[0].when.window_minutes, WINDOW_MINUTES);
  assert.equal(WINDOW_MINUTES, 15);
  const it = { kind: "act_out", channel: "github", to_ids: r.intents[0].to_ids, created_at: 0, when: r.intents[0].when, limits: {} };
  const call = at => ({ kind: "act_out", channel: "github", to_ids: ["github.project.pr.merge:alex/app#7"], at });
  assert.ok(matches(it, call(14 * 60_000)));
  assert.equal(matches(it, call(16 * 60_000)), false);
});
