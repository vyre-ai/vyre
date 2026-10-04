// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SKILL_MIGRATIONS, shapeOf, stepsOf, fingerprints, createSkills, pluginDirs, template, frontmatter, PLUGIN_NAMES } from "./skills.js";
import { tempHome } from "../../test/helpers.js";

/** An in-memory store with the skill tables, a fake clock and a list of emitted events. */
function setup(t) {
  const db = new DatabaseSync(":memory:");
  for (const sql of SKILL_MIGRATIONS) db.exec(sql);
  const home = tempHome(t);                          // a fake Vyre home; also stands in for the user's home
  const events = [];
  let clock = 1_700_000_000_000;
  const skills = createSkills(db, { now: () => clock++, emit: (name, payload) => events.push({ name, payload }), claudeDir: path.join(home, ".claude") });
  return { db, home, events, skills };
}

const shipSteps = () => stepsOf({ commands: [{ command: "npm test", at: 1 }, { command: "git add -A", at: 3 }, { command: 'git commit -m "wip"', at: 4 }, { command: "git push", at: 5 }], files: [{ tool: "Edit", path: "src/app.js", at: 2 }] });

test("shapeOf: programs, subcommands and kinds, not values", () => {
  assert.equal(shapeOf("git push"), "git push");
  assert.equal(shapeOf("git push origin main"), "git push <name>");
  assert.equal(shapeOf("npm run build"), "npm run build");
  assert.equal(shapeOf("npm run build -- --watch"), "npm run build");
  assert.equal(shapeOf("sed -i 's/a/b/' notes/todo.txt"), "sed -i <file>");
  assert.equal(shapeOf('git commit -m "fix: the header"'), "git commit -m");
  assert.equal(shapeOf("node --test core/learn/skills.test.js"), "node --test <file>");
  assert.equal(shapeOf("FOO=1 sudo /usr/local/bin/pytest tests/"), "pytest <path>");
  assert.equal(shapeOf("npm test && git push"), "npm test", "only the first segment");
  assert.equal(shapeOf("npm test 2>&1 > out.log"), "npm test", "redirects are not tokens");
  assert.equal(shapeOf("curl -s https://example.test/api | jq .data"), "curl -s <url>");
  assert.equal(shapeOf(""), "");
  assert.equal(shapeOf("git log --oneline -n 20"), "git log --oneline -n", "at most two flags, numbers are values");
  const long = "echo " + "x".repeat(100_000);
  const t0 = performance.now();
  shapeOf(long);
  assert.ok(performance.now() - t0 < 50, "bounded by the 2000 character cap");
});

test("stepsOf: commands split into segments, files by class, time order, repeats collapsed, cd dropped", () => {
  const steps = stepsOf({
    commands: [{ command: "cd web && npm test", at: 1 }, { command: "npm test", at: 2 }, { command: "git commit -m x && git push", at: 6 }],
    files: [{ tool: "Edit", path: "web/src/a.ts", at: 3 }, { tool: "MultiEdit", path: "web/src/b.ts", at: 4 }, { tool: "Write", path: "web/src/a.test.ts", at: 5 }, { tool: "Edit", path: "CHANGELOG.md", at: 5.5 }],
  });
  assert.deepEqual(steps, ["npm test", "Edit:code", "Write:test", "Edit:changelog", "git commit -m", "git push"]);
  assert.deepEqual(stepsOf({ commands: ["ls", "ls", "ls"], files: ["README.md"] }), ["ls", "Edit:doc"], "without times, commands then files");
  assert.deepEqual(stepsOf({}), []);
});

test("fingerprints: deterministic, whole sequence plus 3 to 6 step runs, capped at 40", () => {
  const s = ["a", "b", "c", "d", "e"];
  const f = fingerprints(s);
  assert.deepEqual(f, fingerprints([...s]), "same steps, same hashes");
  assert.deepEqual(f[0].steps, s, "the whole sequence first");
  assert.match(f[0].hash, /^[0-9a-f]{16}$/);
  // whole(5) + runs of 5 (same as whole, dropped) + 4 (2) + 3 (3)
  assert.equal(f.length, 1 + 2 + 3);
  assert.deepEqual(fingerprints(["a", "b"]), [], "fewer than 3 steps: nothing");
  const many = Array.from({ length: 30 }, (_, i) => `s${i}`);
  const g = fingerprints(many);
  assert.equal(g.length, 40, "a long turn is capped");
  assert.ok(g.every(x => x.steps.length >= 3 && x.steps.length <= 6), "a turn over 12 steps gives runs only");
  assert.equal(new Set(g.map(x => x.hash)).size, 40, "no duplicates");
  assert.equal(fingerprints(Array.from({ length: 12 }, (_, i) => `s${i}`))[0].steps.length, 12);
});

test("the same clean procedure in 3 sessions proposes one skill; a corrected turn does not count", t => {
  const { skills, events } = setup(t);
  const steps = shipSteps();
  assert.deepEqual(steps, ["npm test", "Edit:code", "git add -A", "git commit -m", "git push"]);
  for (const [session, clean] of [["s1", true], ["s2", true], ["s3", false]]) {
    skills.record({ session, seq: 1, project: "harlow-site", steps });
    skills.mark({ session, seq: 1, clean });
  }
  assert.deepEqual(skills.candidates({ min: 3 }), [], "two clean sessions and one corrected: no candidate");
  skills.record({ session: "s4", seq: 7, project: "harlow-site", steps });
  skills.mark({ session: "s4", seq: 6, clean: true });
  assert.deepEqual(skills.candidates(), [], "marking another turn does not make this one clean");
  skills.mark({ session: "s4", seq: 7, clean: true });

  const c = skills.candidates();
  assert.equal(c.length, 1, "overlapping runs collapse to the longest");
  assert.deepEqual(c[0].steps, steps);
  assert.equal(c[0].sessions, 3);
  assert.deepEqual(c[0].scope, { project: "harlow-site" });

  const s = skills.propose(c[0]);
  assert.equal(s.status, "proposed");
  assert.equal(s.name, "learned-npm-test-edit-code-git-add-git-commit-git-push");
  assert.deepEqual(skills.candidates(), [], "a proposed procedure and its shorter runs are not proposed again");
  const ev = events.find(e => e.name === "skill.proposed");
  assert.deepEqual(ev.payload, { skill: s.id, sessions: 3, scope: "project" }, "ids, counts and kinds only");

  skills.dismiss(s.id);
  assert.deepEqual(skills.candidates(), [], "dismissed stays out");
  assert.equal(skills.list({ status: "dismissed" }).length, 1);
});

test("a retired skill's procedure is not proposed again, however often it repeats", t => {
  const { skills, home } = setup(t);
  const steps = shipSteps();
  for (const session of ["s1", "s2", "s3"]) { skills.record({ session, seq: 1, steps }); skills.mark({ session, seq: 1, clean: true }); }
  const s = skills.propose(skills.candidates()[0]);
  skills.install(s.id, { home: path.join(home, "v"), scope: "account" });
  skills.retire(s.id);
  for (const session of ["s4", "s5", "s6"]) { skills.record({ session, seq: 1, steps }); skills.mark({ session, seq: 1, clean: true }); }
  assert.deepEqual(skills.candidates(), [], "retired stays out");
});

test("a clean turn stays clean when the same procedure is recorded again in that session", t => {
  const { skills } = setup(t);
  const steps = ["npm test", "Edit:code", "git push"];
  for (const session of ["a", "b", "c"]) {
    skills.record({ session, seq: 1, steps }); skills.mark({ session, seq: 1, clean: true });
    skills.record({ session, seq: 2, steps });           // repeated, then corrected: never marked
  }
  assert.equal(skills.candidates().length, 1);
  assert.deepEqual(skills.candidates()[0].scope, "all", "no project: account-wide");
});

test("a procedure seen in two projects widens to all", t => {
  const { skills } = setup(t);
  const steps = ["npm test", "Edit:code", "git push"];
  for (const [session, project] of [["a", "p1"], ["b", "p1"], ["c", "p2"]]) { skills.record({ session, seq: 0, project, steps }); skills.mark({ session, seq: 0, clean: true }); }
  assert.equal(skills.candidates()[0].scope, "all");
});

test("template: frontmatter a skill needs, then the steps as a numbered list", () => {
  const body = template({ steps: ["npm test", "Edit:code", "git push"], sessions: 4 });
  assert.equal(body, template({ steps: ["npm test", "Edit:code", "git push"], sessions: 4 }), "deterministic");
  const fm = frontmatter(body);
  assert.equal(fm.name, "learned-npm-test-edit-code-git-push");
  assert.match(fm.description, /^Use when /);
  assert.match(body, /\n1\. Run `npm test`\.\n2\. Edit a code file\.\n3\. Run `git push`\.\n/);
  assert.ok(!body.includes("\u2014"), "no em dashes");
  const long = template({ steps: Array.from({ length: 12 }, (_, i) => `tool${i} verb${i}`) });
  assert.ok(frontmatter(long).name.length <= 64);
  assert.match(frontmatter("no frontmatter").error, /frontmatter/);
  assert.match(frontmatter("---\nname: mine\ndescription: Use when x\n---\n").error, /learned-/);
});

test("propose: a drafted body is validated; a name in use gets a suffix", t => {
  const { skills } = setup(t);
  const cand = { hash: "h1", steps: ["a b", "c d", "e f"], sessions: 3, scope: "all" };
  assert.throws(() => skills.propose(cand, { body: "---\nname: learned-x\ndescription: Does things\n---\n" }), /Use when/);
  const one = skills.propose(cand, { body: "---\nname: learned-ship\ndescription: Use when shipping.\n---\n\n1. Ship.\n" });
  const two = skills.propose({ ...cand, hash: "h2" }, { body: "---\nname: learned-ship\ndescription: Use when shipping.\n---\n\n1. Ship.\n" });
  assert.equal(one.name, "learned-ship");
  assert.equal(two.name, "learned-ship-2");
  assert.match(two.body, /^name: learned-ship-2$/m);
  assert.equal(one.source.kind, "drafted");
});

/** A proposed skill, ready to install. */
const proposed = skills => skills.propose({ hash: "abc", steps: ["npm test", "Edit:code", "git push"], sessions: 3, scope: { project: "harlow-site" } });
const mode = p => fs.statSync(p).mode & 0o777;

test("install: account, project, private project and agent each land in their own place, 0600 in 0700", t => {
  const { skills, home, events } = setup(t);
  const vyre = path.join(home, "vyre-home");
  const projectHome = path.join(home, "Vyre", "projects", "harlow-site");
  fs.mkdirSync(projectHome, { recursive: true });

  const a = skills.install(proposed(skills).id, { home: vyre, scope: "account" });
  assert.equal(a.path, path.join(vyre, "learned", "account", "skills", a.name, "SKILL.md"));
  const manifest = JSON.parse(fs.readFileSync(path.join(vyre, "learned", "account", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "vyre-learned");
  assert.equal(mode(a.path), 0o600);
  assert.equal(mode(path.dirname(a.path)), 0o700);
  assert.equal(mode(path.join(vyre, "learned", "account")), 0o700);
  assert.equal(mode(path.join(vyre, "learned", "account", ".claude-plugin", "plugin.json")), 0o600);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(a.path, "utf8"), a.body);

  const p = skills.install(proposed(skills).id, { home: vyre, scope: "project", projectHome });
  assert.equal(p.path, path.join(projectHome, ".claude", "skills", p.name, "SKILL.md"));
  assert.equal(mode(p.path), 0o600);

  const q = skills.install(proposed(skills).id, { home: vyre, scope: "project", private: true });
  assert.equal(q.path, path.join(vyre, "learned", "projects", "harlow-site", "skills", q.name, "SKILL.md"), "the slug comes from the skill's scope");
  assert.equal(JSON.parse(fs.readFileSync(path.join(vyre, "learned", "projects", "harlow-site", ".claude-plugin", "plugin.json"), "utf8")).name, "vyre-learned-harlow-site",
    "a private project's skills are the plugin vyre-learned-<slug>, as the Switchboard loads it");

  const g = skills.install(proposed(skills).id, { home: vyre, scope: "agent", agent: "scout" });
  assert.equal(g.path, path.join(vyre, "learned", "agents", "scout", "skills", g.name, "SKILL.md"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(vyre, "learned", "agents", "scout", ".claude-plugin", "plugin.json"), "utf8")).name, "vyre-learned-agent-scout");
  assert.equal(mode(g.path), 0o600);

  assert.deepEqual(pluginDirs(vyre, { project: "harlow-site", agent: "scout" }),
    [path.join(vyre, "learned", "account"), path.join(vyre, "learned", "projects", "harlow-site"), path.join(vyre, "learned", "agents", "scout")]);
  assert.deepEqual(pluginDirs(vyre, { project: "other", agent: "../scout" }), [path.join(vyre, "learned", "account")], "only folders that exist, never a path that climbs");
  assert.deepEqual(pluginDirs(path.join(home, "empty")), []);

  const inst = events.filter(e => e.name === "skill.installed");
  assert.deepEqual(inst.map(e => e.payload.scope), ["account", "project", "project", "agent"]);
  assert.deepEqual(Object.keys(inst[0].payload).sort(), ["scope", "skill"]);
  assert.throws(() => skills.install(a.id, { home: vyre, scope: "account" }), /installed/, "installed once");
});

test("plugin names: vyre-learned, vyre-learned-<slug>, vyre-learned-agent-<name>, always lower-case kebab", () => {
  assert.equal(PLUGIN_NAMES.account, "vyre-learned");
  assert.equal(PLUGIN_NAMES.project("harlow-site"), "vyre-learned-harlow-site");
  assert.equal(PLUGIN_NAMES.project("Harlow_Site.v2"), "vyre-learned-harlow-site-v2");
  assert.equal(PLUGIN_NAMES.agent("Scout"), "vyre-learned-agent-scout");
});

test("pluginDirs: the same folders, in the same order, as the Switchboard's learnedDirs", t => {
  const home = tempHome(t);
  const vyre = path.join(home, "vyre-home");
  for (const d of ["account", "projects/harlow-site", "agents/scout"]) {
    fs.mkdirSync(path.join(vyre, "learned", d, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(vyre, "learned", d, ".claude-plugin", "plugin.json"), "{}");
  }
  fs.mkdirSync(path.join(vyre, "learned", "projects", "bare"), { recursive: true });
  assert.deepEqual(pluginDirs(vyre, { project: "harlow-site", agent: "scout" }),
    ["account", "projects/harlow-site", "agents/scout"].map(d => path.join(vyre, "learned", d)));
  assert.deepEqual(pluginDirs(vyre, { project: "bare" }), [path.join(vyre, "learned", "account")], "a folder with no plugin.json is not a plugin");
});

test("install: never under ~/.claude, never outside its roots, never over someone else's skill", t => {
  const { skills, home } = setup(t);
  const vyre = path.join(home, "vyre-home");
  const s = proposed(skills);
  // A project whose home is the user's home would put the skill in ~/.claude/skills.
  assert.throws(() => skills.install(s.id, { home: vyre, scope: "project", projectHome: home }), /refusing to write under/);
  assert.ok(!fs.existsSync(path.join(home, ".claude")), "nothing written");
  // A symlinked learned/skills that points into ~/.claude is caught by the real path.
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(path.join(vyre, "learned", "account"), { recursive: true });
  fs.symlinkSync(path.join(home, ".claude", "skills"), path.join(vyre, "learned", "account", "skills"));
  assert.throws(() => skills.install(s.id, { home: vyre, scope: "account" }), /refusing to write under/);
  assert.deepEqual(fs.readdirSync(path.join(home, ".claude", "skills")), []);
  fs.unlinkSync(path.join(vyre, "learned", "account", "skills"));
  // Names that climb, and relative homes.
  assert.throws(() => skills.install(s.id, { home: vyre, scope: "agent", agent: "../../x" }), /agent's name/);
  assert.throws(() => skills.install(s.id, { home: vyre, scope: "project", private: true, project: "../x" }), /slug/);
  assert.throws(() => skills.install(s.id, { home: "relative", scope: "account" }), /absolute/);
  assert.throws(() => skills.install(s.id, { home: vyre, scope: "global" }), /scope must be/);
  // The user's own skill with the same name is not overwritten.
  const projectHome = path.join(home, "proj");
  const theirs = path.join(projectHome, ".claude", "skills", s.name, "SKILL.md");
  fs.mkdirSync(path.dirname(theirs), { recursive: true });
  fs.writeFileSync(theirs, "the user's own\n");
  assert.throws(() => skills.install(s.id, { home: vyre, scope: "project", projectHome }), /different skill already exists/);
  assert.equal(fs.readFileSync(theirs, "utf8"), "the user's own\n");
  assert.equal(skills.list({ status: "proposed" }).length, 1, "still proposed");
});

test("drift: a changed or missing file is reported; retire removes the file", t => {
  const { skills, home, events } = setup(t);
  const vyre = path.join(home, "vyre-home");
  const a = skills.install(proposed(skills).id, { home: vyre, scope: "account" });
  const b = skills.install(proposed(skills).id, { home: vyre, scope: "agent", agent: "scout" });
  assert.deepEqual(skills.drift(), []);
  fs.appendFileSync(a.path, "\n4. Also deploy.\n");
  fs.rmSync(b.path);
  assert.deepEqual(skills.drift().map(d => [d.id, d.state]), [[a.id, "changed"], [b.id, "missing"]]);

  const r = skills.retire(a.id);
  assert.equal(r.status, "retired");
  assert.ok(!fs.existsSync(a.path), "file gone");
  assert.ok(!fs.existsSync(path.dirname(a.path)), "its empty folder too");
  assert.ok(fs.existsSync(path.join(vyre, "learned", "account", ".claude-plugin", "plugin.json")), "the plugin stays");
  assert.deepEqual(skills.drift().map(d => d.id), [b.id]);
  assert.throws(() => skills.retire(a.id), /retired/);
  assert.deepEqual(events.find(e => e.name === "skill.retired").payload, { skill: a.id });
});

test("events never carry a skill's body", t => {
  const { skills, home, events } = setup(t);
  const s = proposed(skills);
  skills.install(s.id, { home: path.join(home, "v"), scope: "account" });
  skills.retire(s.id);
  assert.deepEqual(events.map(e => e.name), ["skill.proposed", "skill.installed", "skill.retired"]);
  for (const e of events) {
    const text = JSON.stringify(e.payload);
    assert.ok(!("body" in e.payload), e.name);
    assert.ok(!text.includes("Run `") && !text.includes("---"), `${e.name} carries no body text`);
  }
});

test("record: one transaction, at most 40 rows a turn, nothing without a session; prune forgets old rows", t => {
  const { skills, db } = setup(t);
  assert.equal(skills.record({ session: "", seq: 0, steps: ["a", "b", "c"] }), 0);
  assert.equal(skills.record({ session: "s", seq: 0, steps: ["a", "b"] }), 0);
  assert.equal(skills.record({ session: "s", seq: 1, steps: Array.from({ length: 50 }, (_, i) => `x${i}`) }), 40);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learn_procs").get().n, 40);
  assert.equal(skills.prune({ days: 0 }), 40);
});
