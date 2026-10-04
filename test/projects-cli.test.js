// @ts-check
// Projects from the terminal, as a person runs them: a real `vyre` process, a real vyred, a temp
// home seeded with the fictional corpus, and a fake `claude` first on PATH that records how it
// was started instead of starting anything.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome, upLeader } from "./helpers.js";
import { open } from "../core/store/index.js";
import { SESSIONS, HOME, seedRecall } from "./fixtures/corpus.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");
const [SITE, INTAKE, , HUB] = SESSIONS.map(s => s.id);

/** A seeded home, and a run() that drives bin/vyre in any folder with optional stdin. */
function world(t) {
  // Registered before tempHome so vyred is stopped while its home still exists: after-hooks run
  // in the order they were added, and a daemon whose home was deleted first is left running.
  t.after(() => run(["down"]));
  // Real paths, as Claude Code records them: on macOS the temp folder is a symlink.
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "alex", "Work");
  const moved = SESSIONS.map(s => ({ ...s, cwd: s.cwd.replace(path.join(HOME, "Work"), work).replace(HOME, path.join(root, "alex")) }));
  for (const s of moved) fs.mkdirSync(s.cwd, { recursive: true });
  const db = open(path.join(root, "vyre.db"));
  seedRecall(db, moved);
  db.close();
  // Recall and Memory are other workstreams; switched off here so this test sees exactly the
  // seeded index and exercises the path where they are not running.
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    projectsDir: path.join(root, "projects"), roots: [work], transcripts: [], modules: { disable: ["recall", "memory"] },
  }));
  const fake = path.join(root, "fakebin");
  fs.mkdirSync(fake);
  const log = path.join(root, "claude-calls.jsonl");
  fs.writeFileSync(path.join(fake, "claude"), `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), project: process.env.VYRE_PROJECT || null }) + "\\n");
`, { mode: 0o755 });
  // No Harness unless a test makes one, so these tests do not change when main's harness/ lands.
  const env = { ...process.env, VYRE_HOME: root, NO_COLOR: "1", PATH: fake + path.delimiter + process.env.PATH,
    VYRE_HARNESS_DIR: path.join(root, "no-harness") };
  function run(args, { cwd = process.cwd(), input = "" } = {}) { return new Promise(resolve => {
    const c = spawn(process.execPath, [BIN, ...args], { cwd, env });
    let o = "";
    c.stdout.on("data", d => { o += d; });
    c.stderr.on("data", d => { o += d; });
    c.on("close", code => { if (process.env.DEBUG_CLI) console.error(args, code, o); resolve({ code, out: o }); });
    c.stdin.end(input);
  }); }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : []);
  return { root, work, run, calls, env };
}

test("cli: vyre new with flags, then piped answers; the hub lands in both projects", async t => {
  const w = world(t);
  const harlow = path.join(w.work, "harlow-site");
  const a = await w.run(["new", "Harlow Legal", "--home", harlow, "--thread", INTAKE, "--thread", "weekly planning",
    "--person", "Dana Reyes <dana@harlowlegal.com>", "--no-pick"]);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /made Harlow Legal/);
  const marker = JSON.parse(fs.readFileSync(path.join(harlow, ".vyre", "project.json"), "utf8"));
  assert.deepEqual(marker.threads, [INTAKE, HUB]);
  assert.deepEqual(marker.people, [{ name: "Dana Reyes", email: "dana@harlowlegal.com" }]);

  // The interactive flow, answered line by line: name, home, a search, a pick, done, people.
  const b = await w.run(["new"], { input: ["Northwind", path.join(w.work, "northwind"), "weekly", "1", "", "Sam Okafor", ""].join("\n") });
  assert.equal(b.code, 0, b.out);
  assert.match(b.out, /Weekly planning/);
  assert.match(b.out, /\[harlow-legal\]/, "the picker did not show the hub is already in a project");
  assert.match(b.out, /Recall is not running/);
  const nw = JSON.parse(fs.readFileSync(path.join(w.work, "northwind", ".vyre", "project.json"), "utf8"));
  assert.deepEqual(nw.threads, [HUB]);

  const list = await w.run(["projects"]);
  assert.match(list.out, /Harlow Legal\s+3 threads/);
  assert.match(list.out, /Northwind\s+3 threads/);
});

test("cli: vyre alone, piped, prints the home with this folder's project preselected; context prints the brief", async t => {
  const w = world(t);
  const harlow = path.join(w.work, "harlow-site");
  await w.run(["new", "Harlow Legal", "--home", harlow, "--thread", HUB, "--person", "Dana Reyes", "--no-pick"]);
  await w.run(["new", "Northwind", "--home", path.join(w.work, "northwind"), "--thread", HUB, "--no-pick"]);
  fs.mkdirSync(path.join(harlow, "src"));
  const inside = await w.run([], { cwd: path.join(harlow, "src") });
  assert.equal(inside.code, 0, inside.out);
  assert.match(inside.out, /Projects\n/);
  assert.match(inside.out, /› Harlow Legal {2}2 threads · \S+ · this folder/, "this folder's project is not preselected");
  assert.match(inside.out, /  Northwind {2}3 threads/);
  assert.match(inside.out, /New session without a project/);
  assert.match(inside.out, /Agents\n\s+engineer\b/, "the built-in Engineer is the one agent a fresh home lists");
  assert.doesNotMatch(inside.out, /What a new thread here is told/, "the home opened the project instead of preselecting it");
  const outside = await w.run([], { cwd: w.root });
  assert.match(outside.out, /› Northwind|› Harlow Legal/);
  assert.doesNotMatch(outside.out, /· this folder/);
  const ctx = await w.run(["context"], { cwd: harlow });
  assert.match(ctx.out, /^You are working in the Vyre project "Harlow Legal"/);
  assert.match(ctx.out, /People: Dana Reyes\./);
  assert.doesNotMatch(ctx.out, /northwind/i);
  const none = await w.run(["context"], { cwd: w.root });
  assert.equal(none.code, 1);
});

test("cli: vyre resume hands off to claude --resume in the thread's folder, with the brief", async t => {
  const w = world(t);
  const harlow = path.join(w.work, "harlow-site");
  await w.run(["new", "Harlow Legal", "--home", harlow, "--thread", HUB, "--person", "Dana Reyes", "--no-pick"]);

  // By number, from inside the project: 1 is the newest thread, the picked hub.
  const r = await w.run(["resume", "1"], { cwd: harlow });
  assert.equal(r.code, 0, r.out);
  const [c] = w.calls();
  assert.equal(c.argv[0], "--resume");
  assert.equal(c.argv[1], HUB);
  assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(w.work), "claude ran somewhere other than where the thread ran");
  const brief = c.argv[c.argv.indexOf("--append-system-prompt") + 1];
  assert.match(brief, /"Harlow Legal"/);
  assert.match(brief, /Harlow site rebuild/);
  assert.doesNotMatch(brief, /Weekly planning/, "the brief listed the thread being resumed as another thread");

  // By name, from anywhere, renamed on the way.
  const byName = await w.run(["resume", "harlow site rebuild", "--name", "Harlow launch"]);
  assert.equal(byName.code, 0, byName.out);
  const c2 = w.calls()[1];
  assert.equal(c2.argv[1], SITE);
  assert.equal(fs.realpathSync(c2.cwd), fs.realpathSync(harlow));
  assert.deepEqual(c2.argv.slice(2, 4), ["-n", "Harlow launch"]);
  assert.ok(!c2.argv.includes("--plugin-dir"), "--plugin-dir passed with no Harness installed");

  // A thread in no project resumes without a brief.
  await w.run(["resume", "northwind invoices"]);
  assert.ok(!w.calls()[2].argv.includes("--append-system-prompt"));

  const miss = await w.run(["resume", "nothing like this"]);
  assert.equal(miss.code, 1);
  assert.match(miss.out, /no thread matches/);
});

test("cli: vyre start opens a new named thread in the project's home; pick and unpick change the marker", async t => {
  const w = world(t);
  const harlow = path.join(w.work, "harlow-site");
  await w.run(["new", "Harlow Legal", "--home", harlow, "--no-pick"]);
  const s = await w.run(["start", "intake", "copy"], { cwd: harlow });
  assert.equal(s.code, 0, s.out);
  const [c] = w.calls();
  assert.deepEqual(c.argv.slice(0, 3), ["-n", "intake copy", "--append-system-prompt"]);

  // With the Harness installed it is loaded, and its SessionStart hook brings the brief instead.
  const harness = path.join(w.root, "harness");
  fs.mkdirSync(path.join(harness, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(harness, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vyre" }));
  w.env.VYRE_HARNESS_DIR = harness;
  await w.run(["start", "--project", "harlow-legal"]);
  await w.run(["resume", "harlow site rebuild"]);
  for (const x of w.calls().slice(1)) {
    assert.equal(x.argv[x.argv.indexOf("--plugin-dir") + 1], harness);
    assert.ok(!x.argv.includes("--append-system-prompt"), "the brief was passed twice: by flag and by the Harness");
    assert.equal(x.project, "harlow-legal", "the Harness hook was not told which project was chosen");
  }
  w.env.VYRE_HARNESS_DIR = path.join(w.root, "no-harness");
  assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(harlow));

  const p = await w.run(["pick", "harlow-legal", "weekly planning", INTAKE]);
  assert.match(p.out, /2 picked into harlow-legal/);
  const marker = () => JSON.parse(fs.readFileSync(path.join(harlow, ".vyre", "project.json"), "utf8"));
  assert.deepEqual(marker().threads, [HUB, INTAKE]);
  const u = await w.run(["unpick", "harlow-legal", HUB]);
  assert.match(u.out, /1 unpicked/);
  assert.deepEqual(marker().threads, [INTAKE]);
});

test("cli: vyre pick takes a live thread id straight away, before Recall has indexed it", async t => {
  const w = world(t);
  const harlow = path.join(w.work, "harlow-live");
  await w.run(["new", "Harlow Legal", "--home", harlow, "--no-pick"]);
  // A session id that exists nowhere in the seeded corpus: exactly the shape of a chat someone
  // just started, before the next index run has ever seen it.
  const LIVE = "22222222-bbbb-4000-8000-000000000099";
  const p = await w.run(["pick", "harlow-legal", LIVE]);
  assert.match(p.out, /1 picked into harlow-legal/, p.out);
  const marker = JSON.parse(fs.readFileSync(path.join(harlow, ".vyre", "project.json"), "utf8"));
  assert.deepEqual(marker.threads, [LIVE]);
  // A ref that merely looks close to an id but isn't one is still refused, not swallowed.
  const bad = await w.run(["pick", "harlow-legal", "not-a-real-id"]);
  assert.match(bad.out, /no thread matches/);
});

test("cli: vyre projects move --dry-run on a box says what would move and changes nothing; names and a real move are refused", async t => {
  const w = world(t);
  // A box whose homes still sit in the old folder, with a work folder to move them to.
  const old = path.join(w.root, "home", "Vyre", "projects");
  const work = path.join(w.root, "work");
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(work);
  w.env.VYRE_OLD_PROJECTS_DIR = old;
  w.env.VYRE_WORK_DIR = work;
  delete w.env.VYRE_PROJECTS_MOVE;
  fs.writeFileSync(path.join(w.root, "config.json"), JSON.stringify({
    role: "box", projectsDir: old, roots: [w.work], transcripts: [], modules: { disable: ["recall", "memory"] },
  }));
  // The real verifier, trusting only the terminal server this test runs under (the testbox's sshd).
  assert.equal((await upLeader(w.root, w.env)).code, 0);
  const home = path.join(old, "harlow-legal");
  const made = await w.run(["new", "Harlow Legal", "--home", home, "--no-pick"]);
  assert.equal(made.code, 0, made.out);

  const named = await w.run(["projects", "move", "harlow-legal"]);
  assert.equal(named.code, 2, named.out);
  assert.match(named.out, /vyre projects move takes no names/);
  assert.match(named.out, /next: vyre projects move --dry-run shows what would move/);

  const dry = await w.run(["projects", "move", "--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /Would move 1 project/);
  assert.match(dry.out, /harlow-legal/);
  assert.match(dry.out, /nothing has changed/);

  const j = await w.run(["projects", "move", "--dry-run", "--json"]);
  assert.equal(j.code, 0, j.out);
  const r = JSON.parse(j.out);
  assert.equal(r.dry, true);
  assert.deepEqual(r.moved, ["harlow-legal"]);
  assert.equal(r.to, path.join(work, "projects"));
  assert.ok(Array.isArray(r.rewrites) && r.rewrites.length > 0, "the rewrites are listed");
  assert.ok(fs.lstatSync(home).isDirectory() && !fs.lstatSync(home).isSymbolicLink(), "the home did not move");
  assert.equal(fs.existsSync(path.join(work, "projects")), false, "nothing was made in the work folder");
  assert.equal(fs.existsSync(path.join(w.root, "projects-moved.json")), false, "no record was written");

  // The real move stays off until box-deploy switches it on.
  const real = await w.run(["projects", "move", "--json"]);
  assert.equal(real.code, 1, real.out);
  assert.equal(JSON.parse(real.out).error.code, "move_off");
  assert.ok(fs.lstatSync(home).isDirectory() && !fs.lstatSync(home).isSymbolicLink());
});
