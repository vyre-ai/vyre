// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { distill } from "./checks.js";
import { writeSnapshot, readSnapshot, offlineTool, offlineTouched, offlineStop, drain, SNAPSHOT } from "./offline.js";
import { tempHome } from "../../test/helpers.js";

const DASH = "\u2014";
const CWD = "/w/harlow-site";

/** A lesson in the learn module's shape, from what the user said. */
const lesson = (id, text, extra = {}) => {
  const d = distill(text);
  return { id, rule: d.rule, when: d.when, level: d.level, scope: "all", check: d.check, status: "active",
    source: { kind: "user" }, applied: 0, caught: 0, broken: 0, created: 1, updated: 1, ...extra };
};
const logOf = root => {
  const f = path.join(root, "learn-offline", "log.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
};

test("writeSnapshot: only active lessons, only what a check needs, readable only by the owner", t => {
  const root = tempHome(t);
  writeSnapshot(root, [lesson(1, "never use em dashes"), lesson(2, "never use en dashes", { status: "retired" }), lesson(3, "always run the tests before you commit", { status: "proposed" })]);
  const f = path.join(root, SNAPSHOT);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(s.lessons.map(l => l.id), [1]);
  assert.deepEqual(Object.keys(s.lessons[0]).sort(), ["check", "id", "level", "rule", "scope"]);
  assert.equal(s.lessons[0].rule, "Never use em dashes.");
});

test("readSnapshot: no project-scoped lessons offline, agent-scoped ones only for that agent, [] when missing or corrupt", t => {
  const root = tempHome(t);
  assert.deepEqual(readSnapshot(root), [], "missing");
  writeSnapshot(root, [lesson(1, "never use em dashes"), lesson(2, "never use en dashes", { scope: { project: "harlow-site" } }),
    lesson(3, "never use emoji", { scope: { agent: "dana" } })]);
  assert.deepEqual(readSnapshot(root).map(l => l.id), [1]);
  assert.deepEqual(readSnapshot(root, "dana").map(l => l.id), [1, 3]);
  assert.deepEqual(readSnapshot(root, "other").map(l => l.id), [1]);
  fs.writeFileSync(path.join(root, SNAPSHOT), "{ not json");
  assert.deepEqual(readSnapshot(root), [], "corrupt");
});

test("offlineStop: sent back twice, then allowed with the lesson broken; a new prompt starts over", t => {
  const root = tempHome(t);
  writeSnapshot(root, [lesson(1, "never use em dashes")]);
  const turn = { root, session: "s1", prompt_id: "p1", text: `Here is the intro ${DASH} short` };
  const b1 = offlineStop({ ...turn, stop_hook_active: false });
  assert.equal(b1.decision, "block");
  assert.match(/** @type {any} */ (b1).reason, /Lesson 1: Never use em dashes\./);
  assert.match(/** @type {any} */ (b1).reason, /\(1 of 2\)/);
  const b2 = offlineStop({ ...turn, stop_hook_active: true });
  assert.equal(b2.decision, "block");
  assert.match(/** @type {any} */ (b2).reason, /\(2 of 2\)/);
  assert.deepEqual(offlineStop({ ...turn, stop_hook_active: true }), { decision: null });
  const log = logOf(root);
  assert.deepEqual(log.map(e => e.kind), ["caught", "caught", "broken"]);
  assert.ok(log.every(e => e.lesson === 1 && e.session === "s1"));
  assert.equal(offlineStop({ ...turn, prompt_id: "p2", stop_hook_active: true }).decision, "block", "a new prompt_id resets the blocks");
  assert.deepEqual(offlineStop({ ...turn, prompt_id: "p2", text: "Here is the intro, short", stop_hook_active: true }), { decision: null });
});

test("offlineTouched + offlineStop: code without the changelog is sent back; files from an older prompt do not count", t => {
  const root = tempHome(t);
  writeSnapshot(root, [lesson(1, "update CHANGELOG.md whenever you change code")]);
  const edit = (prompt_id, file_path) => offlineTouched({ root, session: "s1", prompt_id, cwd: CWD, tool: "Edit", input: { file_path } });
  edit("p0", "src/old.js");
  assert.deepEqual(offlineStop({ root, session: "s1", prompt_id: "p1", stop_hook_active: false }), { decision: null }, "src/old.js was an older prompt");
  edit("p1", "src/intake.js");
  const b = offlineStop({ root, session: "s1", prompt_id: "p1", stop_hook_active: false });
  assert.equal(b.decision, "block");
  assert.match(/** @type {any} */ (b).reason, /src\/intake\.js but not CHANGELOG\.md/);
  assert.doesNotMatch(/** @type {any} */ (b).reason, /old\.js/);
  edit("p1", "CHANGELOG.md");
  assert.deepEqual(offlineStop({ root, session: "s1", prompt_id: "p1", stop_hook_active: true }), { decision: null });
});

test("offlineTool: a banned character is denied, commit waits for tests, retiring a lesson asks", t => {
  const root = tempHome(t);
  const call = (tool, input) => offlineTool({ root, session: "s1", prompt_id: "p1", tool, input });
  writeSnapshot(root, [lesson(1, "never use em dashes"), lesson(2, "always run the tests before you commit")]);
  const w = call("Write", { file_path: "a.md", content: `Harlow ${DASH} Legal` });
  assert.equal(w.decision, "deny");
  assert.equal(w.lesson, 1);
  assert.match(w.reason || "", /Vyre lesson 1, which the user taught: Never use em dashes\./);
  assert.equal(call("Write", { file_path: "a.md", content: "Harlow Legal" }).decision, null);
  const c = call("Bash", { command: "git commit -m x" });
  assert.equal(c.decision, "deny");
  assert.match(c.reason || "", /Run the tests before every git commit/);
  assert.equal(call("Bash", { command: "npm test" }).decision, null);
  assert.equal(call("Bash", { command: "git commit -m x" }).decision, null);
  const r = call("mcp__plugin_vyre_vyre__learn_retire", { id: 1 });
  assert.equal(r.decision, "ask");
  assert.match(r.reason || "", /the user's call/);
});

test("offline: with no snapshot, nothing is checked", t => {
  const root = tempHome(t);
  const base = { root, session: "s1", prompt_id: "p1" };
  assert.deepEqual(offlineTool({ ...base, tool: "Write", input: { content: `a ${DASH} b` } }), { decision: null });
  assert.deepEqual(offlineTool({ ...base, tool: "Bash", input: { command: "git commit -m x" } }), { decision: null });
  assert.deepEqual(offlineTool({ ...base, tool: "mcp__plugin_vyre_vyre__learn_retire", input: { id: 1 } }), { decision: null });
  offlineTouched({ ...base, cwd: CWD, tool: "Edit", input: { file_path: "src/a.js" } });
  assert.deepEqual(offlineStop({ ...base, text: `a ${DASH} b`, stop_hook_active: false }), { decision: null });
  assert.equal(fs.existsSync(path.join(root, "learn-offline")), false, "nothing written");
});

test("drain: returns what was logged, oldest first, and empties the log", t => {
  const root = tempHome(t);
  assert.deepEqual(drain(root), []);
  writeSnapshot(root, [lesson(1, "never use em dashes")]);
  offlineStop({ root, session: "s1", prompt_id: "p1", text: `a ${DASH} b`, stop_hook_active: false });
  offlineTool({ root, session: "s1", prompt_id: "p1", tool: "Write", input: { content: `a ${DASH} b` } });
  const got = drain(root);
  assert.deepEqual(got.map(e => [e.lesson, e.kind]), [[1, "caught"], [1, "caught"]]);
  assert.deepEqual(drain(root), [], "emptied");
  assert.deepEqual(logOf(root), []);
});

test("offlineTouched: an agent-scoped lesson records files for that agent", t => {
  const root = tempHome(t);
  writeSnapshot(root, [lesson(1, "update CHANGELOG.md whenever you change code", { scope: { agent: "dana" } })]);
  const base = { root, session: "s1", prompt_id: "p1", agent: "dana" };
  offlineTouched({ ...base, cwd: CWD, tool: "Edit", input: { file_path: "src/a.js" } });
  assert.equal(offlineStop({ ...base, stop_hook_active: false }).decision, "block");
});

test("offlineTool: tests from before the last change do not count, even in the next prompt", t => {
  const root = tempHome(t);
  writeSnapshot(root, [lesson(1, "always run the tests before you commit")]);
  const call = (prompt_id, command) => offlineTool({ root, session: "s1", prompt_id, tool: "Bash", input: { command } });
  call("p1", "npm test");
  offlineTouched({ root, session: "s1", prompt_id: "p1", cwd: CWD, tool: "Edit", input: { file_path: "src/intake.js" } });
  assert.equal(call("p2", "git commit -m intake").decision, "deny", "the edit came after the tests");
  call("p2", "npm test");
  assert.equal(call("p2", "git commit -m intake").decision, null);
});
