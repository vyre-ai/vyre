// @ts-check
// The new check kinds (tool, path, after, and paths on any check) and the shapes distill() knows
// (ADR 0007, decision 7). Pure: no store, no daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { distill, invalid, atTool, atStop, loosens, CODE, TESTS } from "./checks.js";
import { writeSnapshot, offlineTool, offlineTouched, offlineStop } from "./offline.js";
import { softCorrection } from "./signals.js";
import { tempHome } from "../../test/helpers.js";

const DASH = "\u2014";
const bash = command => ({ tool: "Bash", input: { command }, ran: [] });

test("distill: an unquoted banned phrase, with or without 'the word'", () => {
  const a = distill("never say circle back");
  assert.deepEqual(a.check, { kind: "text", pattern: "\\bcircle back\\b", flags: "i", label: `"circle back"` });
  assert.equal(a.rule, `Never write "circle back".`);
  assert.equal(a.level, "block");
  const b = distill("don't use the word synergy in emails");
  assert.equal(b.check.pattern, "\\bsynergy\\b");
  assert.equal(b.level, "remind", "soft words: remind");
  assert.ok(atStop(a.check, { text: "Let's Circle Back tomorrow", touched: [] }).problem);
  assert.equal(atStop(a.check, { text: "the circle backs onto", touched: [] }).problem, null, "a whole phrase, not part of a word");
});

test("distill: 'don't use sed -i' is a tool check on the command, not on the program", () => {
  const d = distill("don't use sed -i");
  assert.equal(d.check.kind, "tool");
  assert.equal(d.check.tool, "Bash");
  assert.ok(atTool(d.check, bash("sed -i 's/a/b/' x.txt")).problem);
  assert.ok(atTool(d.check, bash("cd src && sed -i.bak s/a/b/ x")).problem);
  assert.deepEqual(atTool(d.check, bash("sed 's/a/b/' x.txt")), { applied: false, problem: null }, "sed without -i is fine");
  assert.deepEqual(atTool(d.check, bash("grep -i used x")), { applied: false, problem: null });
  assert.deepEqual(atTool(d.check, { tool: "Write", input: { content: "sed -i" }, ran: [] }), { applied: false, problem: null });
});

test("distill: 'never push to main' holds a push to main and nothing else", () => {
  const d = distill("never push to main");
  assert.equal(d.rule, "Never push to main.");
  for (const c of ["git push origin main", "git push -u origin main", "git push origin HEAD:main", "git push --force origin main"]) assert.ok(atTool(d.check, bash(c)).problem, c);
  for (const c of ["git push origin feature/main-menu", "git push origin maintenance", "git pull origin main", "git push"]) assert.equal(atTool(d.check, bash(c)).problem, null, c);
});

test("distill: 'use pnpm not npm' holds npm, says to use pnpm, and names the preference", () => {
  for (const s of ["use pnpm not npm", "use pnpm instead of npm", "use pnpm, not npm", "don't use npm, use pnpm"]) {
    const d = distill(s);
    assert.equal(d.check.kind, "tool", s);
    assert.equal(d.check.instead, "pnpm", s);
    assert.deepEqual(d.prefers, { use: "pnpm", over: "npm" }, s);
    assert.equal(d.rule, "Use pnpm, not npm.", s);
  }
  const c = distill("use pnpm not npm").check;
  assert.match(atTool(c, bash("npm install")).problem, /Use pnpm instead\./);
  assert.ok(atTool(c, bash("cd app && npm run build")).problem);
  assert.equal(atTool(c, bash("pnpm install")).problem, null, "pnpm contains npm but is not it");
  assert.equal(atTool(c, bash("npx vitest")).problem, null);
  assert.equal(distill("always use pnpm instead of npm").level, "block");
});

test("distill: 'don't touch migrations/' is a path check on writes and on commands that write", () => {
  const d = distill("don't touch migrations/");
  assert.deepEqual(d.check, { kind: "path", pattern: "(^|/)migrations/", label: "migrations/" });
  assert.ok(atTool(d.check, { tool: "Edit", input: { file_path: "/w/app/db/migrations/001.sql" }, ran: [] }).problem);
  assert.ok(atTool(d.check, bash("rm db/migrations/001.sql")).problem);
  assert.equal(atTool(d.check, bash("cat db/migrations/001.sql")).problem, null, "reading is fine");
  assert.deepEqual(atTool(d.check, { tool: "Edit", input: { file_path: "/w/app/src/migrate.js" }, ran: [] }), { applied: false, problem: null });
  assert.equal(distill("never edit the vendor folder").check.pattern, "(^|/)vendor/");
  assert.equal(distill("don't change package-lock.json").check.pattern, "(^|/)package-lock\\.json$");
  assert.equal(atStop(d.check, { text: null, touched: ["/w/app/db/migrations/1.sql"] }).applied, false, "a path check holds the call; Stop does not send the turn back for it");
});

test("distill: 'in docs never use X' narrows a text check to docs, and not the reply", () => {
  const d = distill("in docs never use em dashes");
  assert.equal(d.rule, "In docs: never use em dashes.");
  assert.ok(d.check.paths);
  assert.ok(atTool(d.check, { tool: "Write", input: { file_path: "docs/guide.md", content: `a ${DASH} b` }, ran: [] }).problem);
  assert.ok(atTool(d.check, { tool: "Edit", input: { file_path: "/w/app/README.md", new_string: `a ${DASH} b` }, ran: [] }).problem);
  assert.deepEqual(atTool(d.check, { tool: "Write", input: { file_path: "src/app.js", content: `a ${DASH} b` }, ran: [] }), { applied: false, problem: null });
  assert.deepEqual(atStop(d.check, { text: `a ${DASH} b`, touched: [] }), { applied: false, problem: null });
  assert.equal(distill("in docs never say simply").check.pattern, "\\bsimply\\b");
});

test("distill: 'always run lint after editing ts' is an after check at Stop, ordered", () => {
  const d = distill("always run lint after editing ts");
  assert.deepEqual(d.check, { kind: "after", command: "\\blint\\b", when: "\\.tsx?$", label: "lint ran after changing ts files" });
  assert.equal(d.level, "block");
  const changes = [{ path: "/w/app/src/a.ts", at: 5 }];
  assert.match(atStop(d.check, { text: null, touched: ["/w/app/src/a.ts"], changes, commands: [{ command: "npm run lint", at: 3 }] }).problem, /nothing matching/);
  assert.deepEqual(atStop(d.check, { text: null, touched: ["/w/app/src/a.ts"], changes, commands: [{ command: "npm run lint", at: 6 }] }), { applied: true, problem: null });
  assert.deepEqual(atStop(d.check, { text: null, touched: ["/w/app/src/a.js"], changes: [{ path: "/w/app/src/a.js", at: 1 }], commands: [] }), { applied: false, problem: null });
  assert.equal(distill("always run the tests after changing code").check.command, TESTS);
  assert.equal(distill("always run the tests after changing code").check.when, CODE);
});

test("distill: 'run X before Y' for any two commands", () => {
  const d = distill("always run lint before you push");
  assert.deepEqual([d.check.kind, d.check.command, d.check.first], ["before", "\\bgit\\s+push\\b", "\\blint\\b"]);
  assert.ok(atTool(d.check, bash("git push")).problem);
  assert.equal(atTool(d.check, { ...bash("git push"), ran: ["npm run lint"] }).problem, null);
  const b = distill("always run the build before deploying");
  assert.equal(b.check.command, "\\bdeploy\\b");
  assert.deepEqual(distill("always run the tests before you commit").check.first, TESTS, "the old shape is unchanged");
});

test("distill: scope words set the scope and make a sentence a rule", () => {
  assert.equal(distill("never use em dashes everywhere").scope, "all");
  assert.equal(distill("in this repo use pnpm not npm").scope, "project");
  assert.equal(distill("use pnpm not npm in this project").scope, "project");
  assert.equal(distill("in every project, never push to main").scope, "all");
  assert.equal(distill("run lint before you push in this repo").check.kind, "before", "a scope word is enough to mean it every time");
  assert.equal(distill("never use em dashes").scope, undefined);
});

test("distill: ordinary prompts do not distill", () => {
  for (const s of [
    "run the tests before we merge", "use the blue button not the red one", "don't touch the footer", "never mind, do the header",
    "don't say anything to Dana yet", "don't worry about the footer", "push to main when done", "don't use tables here",
    "can you run lint?", "what does git push --force do?", "the migrations folder is slow", "use a smaller font", "in docs, what is the intro about?",
    "I never said that", "stop", "no", "fix the npm install error", "why did you edit migrations/001.sql",
  ]) assert.equal(distill(s)?.check ?? null, null, s);
  for (const s of ["run the tests before we merge", "use the blue button not the red one", "fix the npm install error", "can you run lint?"]) assert.equal(distill(s), null, s);
});

test("invalid: the new kinds and paths are validated", () => {
  assert.equal(invalid({ kind: "tool", tool: "Bash", command: "\\bnpm\\b" }), null);
  assert.equal(invalid({ kind: "tool", tool: "WebFetch" }), null);
  assert.match(invalid({ kind: "tool" }), /tool or command/);
  assert.match(invalid({ kind: "tool", command: "(" }), /./);
  assert.equal(invalid({ kind: "path", pattern: "(^|/)vendor/" }), null);
  assert.match(invalid({ kind: "path" }), /pattern/);
  assert.equal(invalid({ kind: "after", command: "lint" }), null);
  assert.match(invalid({ kind: "after" }), /command/);
  assert.match(invalid({ kind: "text", pattern: "x", paths: "(" }), /paths/);
  assert.match(invalid({ kind: "tool", tool: "Bash", instead: "x".repeat(100) }), /instead/);
});

test("tool check by name holds that tool only", () => {
  const c = { kind: "tool", tool: "WebFetch", label: "WebFetch" };
  assert.ok(atTool(c, { tool: "WebFetch", input: { url: "https://example.test" }, ran: [] }).problem);
  assert.deepEqual(atTool(c, { tool: "WebSearch", input: {}, ran: [] }), { applied: false, problem: null });
});

test("loosens: adding paths narrows; taking them off widens, which is free", () => {
  const l = { level: "block", scope: "all", when: "always", check: { kind: "text", pattern: "x", label: "x" }, max_level: null, pinned: false, rule: "r" };
  assert.deepEqual(loosens(l, { check: { ...l.check, paths: "\\.md$" } }), ["narrows the check to some files"]);
  const narrow = { ...l, check: { ...l.check, paths: "\\.md$" } };
  assert.deepEqual(loosens(narrow, { check: { kind: "text", pattern: "x", label: "x" } }), []);
});

test("offline: tool, path and after checks work with vyred down", t => {
  const root = tempHome(t);
  const mk = (id, text) => { const d = distill(text); return { id, rule: d.rule, level: "block", scope: "all", check: d.check, status: "active" }; };
  writeSnapshot(root, [mk(1, "use pnpm not npm"), mk(2, "don't touch migrations/"), mk(3, "always run lint after editing ts")]);
  const base = { root, session: "s1", prompt_id: "p1", cwd: "/w/app" };
  assert.equal(offlineTool({ ...base, tool: "Bash", input: { command: "npm install" } }).decision, "deny");
  assert.equal(offlineTool({ ...base, tool: "Edit", input: { file_path: "db/migrations/1.sql" } }).decision, "deny");
  assert.equal(offlineTool({ ...base, tool: "Bash", input: { command: "pnpm run lint" } }).decision, null);
  offlineTouched({ ...base, tool: "Edit", input: { file_path: "src/a.ts" } });
  const s = offlineStop({ ...base, stop_hook_active: false });
  assert.equal(s.decision, "block", "lint ran before the change, not after");
  assert.match(/** @type {any} */ (s).reason, /Lesson 3/);
  offlineTool({ ...base, tool: "Bash", input: { command: "pnpm run lint" } });
  assert.equal(offlineStop({ ...base, stop_hook_active: true }).decision, null);
});

test("distill: questions, words about someone else and instructions for now are not rules", () => {
  for (const s of [
    "can you check why we never push to main in CI?", "Explain why the README says never use sed -i", "add a test that users never see the em dash",
    "fix the bug where users are never logged out", "why does the script always run npm install?", "don't push to main yet, I want to review first",
    "stop the server", "don't touch the migrations folder for this PR", "don't use rm here, use trash", "I always forget: what's the git command to squash?",
    "use pnpm not npm for this install", "never push to main for now", "when does the linter always run",
  ]) assert.equal(distill(s), null, s);
  for (const s of ["stop the server", "don't push to main yet, I want to review first", "can you stop adding comments?", "quit the app"]) assert.equal(softCorrection(s), false, s);
  for (const s of ["stop adding comments everywhere", "please don't reformat files", "no, avoid the class syntax"]) assert.equal(softCorrection(s), true, s);
  // Directed at Claude, at the start of a clause: still rules.
  for (const s of ["never push to main", "please never push to main", "yes, and never push to main", "OK. Always run the tests before you commit",
    "you never use em dashes", "when you edit ts, always run lint after editing ts"]) assert.ok(distill(s)?.check, s);
});
