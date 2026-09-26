// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { distill } from "./checks.js";
import { writeSnapshot, readSnapshot, offlineTool, offlineTouched, offlineStop, drain, fromStore, SNAPSHOT } from "./offline.js";
import { open } from "../store/index.js";
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
  assert.equal(s.version, 2);
  assert.equal(s.lessons[0].rule, "Never use em dashes.");
});

test("readSnapshot: project lessons by cwd prefix, agent-scoped ones only for that agent, [] when missing or corrupt", t => {
  const root = tempHome(t);
  assert.deepEqual(readSnapshot(root), [], "missing");
  writeSnapshot(root, [lesson(1, "never use em dashes"), lesson(2, "never use en dashes", { scope: { project: "harlow-site" } }),
    lesson(3, "never use emoji", { scope: { agent: "dana" } }), lesson(4, "never use semicolons", { scope: { project: "harlow-app" } })],
    { 2: { project: "harlow-site", folders: ["/w/harlow-site"] }, 4: { project: "harlow-app", folders: ["/w/harlow-site/app"] } });
  assert.deepEqual(readSnapshot(root).map(l => l.id), [1], "no cwd, no project");
  assert.deepEqual(readSnapshot(root, undefined, "/w/harlow-site/src").map(l => l.id), [1, 2]);
  assert.deepEqual(readSnapshot(root, undefined, "/w/harlow-site").map(l => l.id), [1, 2]);
  assert.deepEqual(readSnapshot(root, undefined, "/w/harlow-site/app/x").map(l => l.id), [1, 4], "the longest folder wins, as projects.of decides");
  assert.deepEqual(readSnapshot(root, undefined, "/w/harlow-sitemap").map(l => l.id), [1], "a prefix of the name is not the folder");
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
  assert.deepEqual(offlineStop({ ...turn, prompt_id: "p1-other", stop_hook_active: true }), { decision: null },
    "another prompt_id mid-turn does not win more tries: only a Stop that is not a continuation starts over");
  assert.equal(offlineStop({ ...turn, prompt_id: "p2", stop_hook_active: false }).decision, "block", "a real new turn starts over");
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
  assert.equal(offlineTool({ ...base, tool: "mcp__plugin_vyre_vyre__learn_retire", input: { id: 1 } }).decision, "ask", "a human-only tool is guarded with no lesson too");
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

test("offlineTool: order is the order things happened, not the clock (all in one millisecond, or an older state file)", t => {
  const root = tempHome(t);
  t.mock.method(Date, "now", () => 1_790_000_000_000);
  writeSnapshot(root, [lesson(1, "always run the tests before you commit")]);
  const call = (prompt_id, command) => offlineTool({ root, session: "s1", prompt_id, tool: "Bash", input: { command } });
  call("p1", "npm test");
  offlineTouched({ root, session: "s1", prompt_id: "p1", cwd: CWD, tool: "Edit", input: { file_path: "src/intake.js" } });
  assert.equal(call("p1", "git commit -m intake").decision, "deny", "same millisecond, but the edit came after the tests");
  call("p1", "npm test");
  assert.equal(call("p1", "git commit -m intake").decision, null, "same millisecond, but the tests came after the edit");
  // A state file from before the counter: a timestamp in `changed`, commands without `n`.
  fs.writeFileSync(path.join(root, "learn-offline", "s2.json"), JSON.stringify({ prompt: "p1", blocks: 0, touched: [],
    ran: [{ command: "npm test", at: 1_790_000_000_000 }], changed: 1_790_000_000_000 }));
  const old = (command) => offlineTool({ root, session: "s2", prompt_id: "p1", tool: "Bash", input: { command } });
  assert.equal(old("git commit -m x").decision, "deny", "an old entry does not count");
  old("npm test");
  assert.equal(old("git commit -m x").decision, null, "a new run counts, not outranked by the old timestamp");
});

test("readSnapshot: a version 1 snapshot still reads; its project lessons have no folders and do not apply", t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, SNAPSHOT), JSON.stringify({ version: 1, at: 1, lessons: [
    { id: 1, rule: "Never use em dashes.", level: "block", scope: "all", check: distill("never use em dashes").check },
    { id: 2, rule: "Never use en dashes.", level: "block", scope: { project: "harlow-site" }, check: distill("never use en dashes").check }] }));
  assert.deepEqual(readSnapshot(root, undefined, "/w/harlow-site").map(l => l.id), [1]);
});

test("offline: a project lesson holds in its folder and not elsewhere, and guards ask everywhere", t => {
  const root = tempHome(t);
  writeSnapshot(root, [lesson(1, "never use em dashes", { scope: { project: "harlow-site" } })], { 1: { project: "harlow-site", folders: ["/w/harlow-site"] } });
  const w = cwd => offlineTool({ root, session: "s1", prompt_id: "p1", cwd, tool: "Write", input: { file_path: "a.md", content: `a ${DASH} b` } });
  assert.equal(w("/w/harlow-site/src").decision, "deny");
  assert.equal(w("/w/other").decision, null);
  const g = offlineTool({ root, session: "s1", prompt_id: "p1", cwd: "/w/other", tool: "Bash", input: { command: `rm ${root}/lessons.json` } });
  assert.equal(g.decision, "ask", "the guard holds outside the project too");
  offlineTouched({ root, session: "s2", prompt_id: "p1", cwd: "/w/harlow-site", tool: "Edit", input: { file_path: "a.md" } });
  assert.equal(offlineStop({ root, session: "s2", prompt_id: "p1", cwd: "/w/harlow-site", text: `a ${DASH} b`, stop_hook_active: false }).decision, "block");
  assert.deepEqual(offlineStop({ root, session: "s3", prompt_id: "p1", cwd: "/w/other", text: `a ${DASH} b`, stop_hook_active: false }), { decision: null });
});

test("offline: with lessons.json gone, the lessons are read read-only from vyre.db, project folders included", t => {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db"));
  db.exec(`CREATE TABLE learn_lessons (id INTEGER PRIMARY KEY, scope TEXT, when_text TEXT, rule TEXT, check_json TEXT, level TEXT, status TEXT, source TEXT);
    CREATE TABLE projects_projects (slug TEXT PRIMARY KEY, name TEXT, home TEXT, spec TEXT, at INTEGER);`);
  const put = db.prepare("INSERT INTO learn_lessons (scope, when_text, rule, check_json, level, status, source) VALUES (?,?,?,?,?,?,'{}')");
  put.run('"all"', "always", "Never use em dashes.", JSON.stringify(distill("never use em dashes").check), "block", "active");
  put.run(JSON.stringify({ project: "harlow-site" }), "always", "Never use en dashes.", JSON.stringify(distill("never use en dashes").check), "block", "active");
  put.run('"all"', "always", "Never use emoji.", JSON.stringify(distill("never use emoji").check), "block", "retired");
  put.run('"all"', "always", "Be brief.", null, "remind", "active");
  db.prepare("INSERT INTO projects_projects VALUES (?,?,?,?,?)").run("harlow-site", "Harlow Site", "/w/harlow-site", JSON.stringify({ workspaces: ["/w/harlow-site", "/w/harlow-api"] }), 1);
  const t0 = performance.now();
  const got = fromStore(root);
  const ms = performance.now() - t0;
  assert.ok(ms < 100, `fromStore took ${ms.toFixed(1)} ms`);
  assert.deepEqual(got.map(l => [l.id, l.project || null]), [[1, null], [2, "harlow-site"]], "active lessons with a check only");
  assert.deepEqual(readSnapshot(root, undefined, "/w/harlow-api/src").map(l => l.id), [1, 2], "no lessons.json: read from the store");
  const w = offlineTool({ root, session: "s1", prompt_id: "p1", cwd: "/w/harlow-site", tool: "Write", input: { content: `a ${DASH} b` } });
  assert.equal(w.decision, "deny");
  fs.writeFileSync(path.join(root, SNAPSHOT), "{ torn");
  assert.equal(readSnapshot(root).length, 1, "an unreadable file falls back too");
  db.close();
  assert.deepEqual(fromStore(tempHome(t)), [], "no store: nothing, and no throw");
  fs.writeFileSync(path.join(root, "vyre.db"), "not a database");
  assert.deepEqual(fromStore(root), [], "a broken store: nothing, and no throw");
});
