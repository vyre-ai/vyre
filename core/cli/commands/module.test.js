// @ts-check
// `vyre module new|check|add` in temp homes. vyred is never started: restart and the /v1/modules
// read are fakes that record their calls. The git source is a bare repo in the temp folder, read
// over file://, so nothing reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tempHome, writeModule } from "../../../test/helpers.js";
import { setJson, EXIT } from "../kit.js";
import { moduleCommand, checkModule, scaffold, agentBrief, testModuleDir } from "./module.js";
import { conformModule } from "../../../packages/module-sdk/conform.js";

process.env.VYRE_NO_DIALOGS = "1";

/** What a test printed: console lines, and the JSON lines written straight to stdout. Once per test. */
const captured = new WeakMap();
function capture(t) {
  if (captured.has(t)) return captured.get(t);
  const c = { lines: /** @type {string[]} */ ([]), json: /** @type {any[]} */ ([]) };
  captured.set(t, c);
  t.mock.method(console, "log", (...a) => { c.lines.push(a.join(" ")); });
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.startsWith("{")) { c.json.push(JSON.parse(chunk)); return true; }
    return write(chunk, ...rest);
  });
  return c;
}
const text = c => c.lines.join("\n");

/** Fakes for the pieces that would reach vyred, recording what they were asked. */
function world(t, { rows = null, tty = false, answers = [], restart = { ok: true, running: true } } = {}) {
  const home = tempHome(t);
  const calls = { restart: 0, modules: 0, asked: /** @type {string[]} */ ([]) };
  /** @type {import("./module.js").Deps} */
  const deps = {
    home, supervisor: "",
    restart: async () => { calls.restart++; return restart; },
    modules: async () => { calls.modules++; return rows ? { data: typeof rows === "function" ? rows() : rows } : { error: { code: "unreachable" } }; },
    io: { tty, ask: async q => { calls.asked.push(q); return answers.shift() || ""; } },
  };
  return { home, deps, calls, modules: path.join(home, "modules") };
}

/** A module folder outside the home, from the sample world. */
function bakery(root, manifest = {}, source = "export default { async start(ctx) { return { async stop() {} }; } };\n") {
  const dir = writeModule(root, "bakery", { apiVersion: 1, description: "Northwind Bakery's orders.", does: { tools: [{ name: "bakery.orders", summary: "list today's orders" }] }, watches: { emits: ["bakery.ordered"] }, ...manifest }, source);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  return dir;
}

// ---------------------------------------------------------------------------------------------
// The Render shape, checked by hand (packages/module-sdk/index.d.ts)

const STATES = ["ok", "wait", "failed", "unknown"];
const FIELDS = {
  table: ["columns", "rows", "empty"], card: ["fields", "state"], text: ["lines"], qr: ["text", "caption"], checks: ["items"],
  prompt: ["name", "label", "choices", "secret", "args", "answer", "flag"], error: ["code", "message", "next"],
};
function assertRender(v) {
  assert.ok(v && Object.keys(FIELDS).includes(v.kind), `kind ${v && v.kind}`);
  for (const k of Object.keys(v)) assert.ok(["kind", "title", "actions", ...FIELDS[v.kind]].includes(k), `${v.kind} has no field ${k}`);
  if (v.title !== undefined) assert.equal(typeof v.title, "string");
  if (v.kind === "card") {
    assert.ok(Array.isArray(v.fields));
    for (const f of v.fields) assert.ok(typeof f.label === "string" && "value" in f);
    if (v.state !== undefined) assert.ok(STATES.includes(v.state));
  }
  if (v.kind === "checks") for (const c of v.items) assert.ok(typeof c.id === "string" && typeof c.label === "string" && STATES.includes(c.state), JSON.stringify(c));
  if (v.kind === "prompt") { assert.ok(typeof v.name === "string" && typeof v.label === "string" && Array.isArray(v.args)); assert.ok(["word", "flag", "stdin", "confirm"].includes(v.answer)); }
  if (v.kind === "error") assert.ok(typeof v.code === "string" && typeof v.message === "string");
}
/** Frames: every line but the last is {v, cmd, view, data}; the last is the done frame. */
function assertFrames(lines, exit) {
  assert.ok(lines.length >= 2, "a frame and the done frame");
  for (const f of lines.slice(0, -1)) {
    assert.equal(f.v, 1);
    assert.equal(typeof f.cmd, "string");
    assert.ok("data" in f);
    assertRender(f.view);
  }
  assert.deepEqual(lines[lines.length - 1], { v: 1, done: true, exit });
}

// ---------------------------------------------------------------------------------------------
// new

test("new writes the files, they pass check, and their own test passes", async t => {
  const { deps, modules } = world(t);
  const c = capture(t);
  assert.equal(await moduleCommand(["new", "bake"], deps), EXIT.OK);
  const dir = path.join(modules, "bake");
  for (const f of ["module.json", "index.js", "bake.test.js", "README.md", "package.json", "AGENTS.md", "jsconfig.json"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8"));
  assert.deepEqual({ name: m.name, version: m.version, apiVersion: m.apiVersion, roles: m.roles, does: m.does, watches: m.watches },
    { name: "bake", version: "0.1.0", apiVersion: 1, roles: ["box", "local"], does: { tools: [{ name: "bake.hello", summary: "say hello", reach: "anyone" }] }, watches: { emits: ["bake.said"] } });
  assert.match(text(c), /vyre module test/);
  assert.match(text(c), /vyre down && vyre up/);
  assert.match(text(c), /vyre call bake\.hello/);

  const r = await checkModule(dir, { repo: path.resolve(import.meta.dirname, "..", "..", ".."), node: process.execPath });
  assert.deepEqual(r.problems, []);
  assert.ok(r.ok);
  assert.equal(await moduleCommand(["check", dir], deps), EXIT.OK);

  // Its own run, not a child of this one: without NODE_TEST_CONTEXT it reports as it would for alex.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = execFileSync(process.execPath, ["--test", path.join(dir, "bake.test.js")], { cwd: dir, encoding: "utf8", env });
  assert.match(run, /pass 2/);
  assert.match(run, /fail 0/);
  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /docs\/build\/first-module\.md/);
  assert.match(readme, /AGENTS\.md/);
  // The template is module API 1 from the start: it conforms as an added module.
  assert.deepEqual(await conformModule(dir), []);
  for (const f of Object.values(scaffold("bake"))) assert.ok(!f.includes("\u2014") && !f.includes("\u00a7"));
});

test("new --dir makes it elsewhere and points at vyre module add", async t => {
  const { deps, home } = world(t);
  const c = capture(t);
  const parent = path.join(home, "work");
  setJson(true);
  t.after(() => setJson(false));
  assert.equal(await moduleCommand(["new", "kit-notes", "--dir", parent], deps), EXIT.OK);
  const d = c.json.at(-1);
  assert.equal(d.created, true);
  assert.equal(d.dir, path.join(parent, "kit-notes"));
  assert.ok(d.next.includes(`vyre module add ${path.join(parent, "kit-notes")}`));
  assert.ok(d.files.includes("kit-notes.test.js"));
});

test("new refuses a bad name, a shipped name, a running name and a folder that is there", async t => {
  const { deps, modules } = world(t, { rows: [{ name: "juno-log", state: "running" }] });
  const c = capture(t);
  assert.equal(await moduleCommand(["new", "Bake"], deps), EXIT.USAGE);
  assert.equal(await moduleCommand(["new", "b"], deps), EXIT.USAGE);
  assert.match(text(c), /not a module name/);
  assert.equal(await moduleCommand(["new", "commands"], deps), EXIT.FAILED);
  assert.match(text(c), /one of Vyre's own modules/);
  assert.equal(await moduleCommand(["new", "juno-log"], deps), EXIT.FAILED);
  assert.match(text(c), /already runs a module named juno-log/);
  fs.mkdirSync(path.join(modules, "bake"), { recursive: true });
  assert.equal(await moduleCommand(["new", "bake"], deps), EXIT.FAILED);
  assert.match(text(c), /already there/);
  assert.deepEqual(fs.readdirSync(path.join(modules, "bake")), [], "nothing was written into a folder that was there");
  assert.equal(await moduleCommand(["new"], deps), EXIT.USAGE);
  assert.equal(await moduleCommand([], deps), EXIT.USAGE);
  assert.equal(await moduleCommand(["frob"], deps), EXIT.USAGE);
});

test("new writes AGENTS.md, the agent brief without its front matter", async t => {
  const { deps, modules } = world(t);
  capture(t);
  assert.equal(await moduleCommand(["new", "kit-log"], deps), EXIT.OK);
  const agents = fs.readFileSync(path.join(modules, "kit-log", "AGENTS.md"), "utf8");
  const brief = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "docs", "build", "AGENT-BRIEF.md"), "utf8");
  assert.equal(agents, agentBrief());
  assert.ok(brief.startsWith("---\n") && !agents.startsWith("---"));
  assert.ok(brief.endsWith(agents));
  assert.match(agents, /^# Writing a Vyre module/);
  assert.match(agentBrief(path.join(modules, "nowhere")), /AGENT-BRIEF\.md/, "a checkout without docs still points at the brief");
});

// ---------------------------------------------------------------------------------------------
// test

test("test runs conformance, then the module's own tests", async t => {
  const { deps, modules, home } = world(t);
  const c = capture(t);
  assert.equal(await moduleCommand(["new", "bake"], deps), EXIT.OK);
  const dir = path.join(modules, "bake");
  const r = await testModuleDir(dir, { repo: path.resolve(import.meta.dirname, "..", "..", ".."), node: process.execPath });
  assert.deepEqual({ ok: r.ok, failures: r.failures, pass: r.tests.pass, fail: r.tests.fail, files: r.tests.files }, { ok: true, failures: [], pass: 2, fail: 0, files: ["bake.test.js"] });
  assert.equal(await moduleCommand(["test", dir], deps), EXIT.OK);
  assert.match(text(c), /conforms to module API 1/);
  assert.match(text(c), /2 passed, 0 failed/);

  // A tool without examples, and a test that fails: both are reported, and the exit is 1.
  const bad = path.join(home, "bad");
  fs.cpSync(dir, bad, { recursive: true });
  fs.writeFileSync(path.join(bad, "index.js"), fs.readFileSync(path.join(bad, "index.js"), "utf8").replace(/\n\s*examples: \[.*\],/, ""));
  fs.writeFileSync(path.join(bad, "bake.test.js"), fs.readFileSync(path.join(bad, "bake.test.js"), "utf8").replace('"Hello, alex!"', '"Hi, alex!"'));
  setJson(true);
  t.after(() => setJson(false));
  assert.equal(await moduleCommand(["test", bad], deps), EXIT.FAILED);
  const d = c.json.at(-1);
  assert.equal(d.ok, false);
  assert.ok(d.failures.some(f => /bake\.hello has no examples/.test(f)), d.failures.join("; "));
  assert.deepEqual({ ok: d.tests.ok, pass: d.tests.pass, fail: d.tests.fail }, { ok: false, pass: 1, fail: 1 });
});

// ---------------------------------------------------------------------------------------------
// check

test("check reports a schema problem, a loader problem, a missing entry and a syntax error", async t => {
  const { deps, home } = world(t);
  const root = path.join(home, "src");
  const repo = path.resolve(import.meta.dirname, "..", "..", "..");
  const node = process.execPath;
  const by = (r, id) => r.checks.find(x => x.id === id);

  // An unknown key: the schema says so, the loader lets it by.
  const schema = await checkModule(bakery(path.join(root, "a"), { colour: "red" }), { repo, node });
  assert.equal(by(schema, "schema").state, "failed");
  assert.equal(by(schema, "loader").state, "ok");
  assert.ok(schema.problems.some(p => /colour is not a manifest key/.test(p)), schema.problems.join("; "));

  // requires with ranges is module API 1; a range the loader can't read is its problem.
  const ranged = await checkModule(bakery(path.join(root, "b"), { requires: { memory: ">=0.1" } }), { repo, node });
  assert.equal(by(ranged, "loader").state, "ok");
  const loader = await checkModule(bakery(path.join(root, "b2"), { requires: { memory: "newest please" } }), { repo, node });
  assert.equal(by(loader, "loader").state, "failed");
  assert.ok(loader.problems.includes(`requires "memory": "newest please" is not a version range`), loader.problems.join("; "));

  const noEntry = bakery(path.join(root, "c"));
  fs.rmSync(path.join(noEntry, "index.js"));
  const missing = await checkModule(noEntry, { repo, node });
  assert.equal(by(missing, "entry").state, "failed");
  assert.equal(by(missing, "syntax").state, "unknown");
  assert.ok(missing.problems.includes("the entry file index.js is missing"));

  const broken = await checkModule(bakery(path.join(root, "d"), {}, "export default { async start(ctx) {\n  return { stop( };\n};\n"), { repo, node });
  assert.equal(by(broken, "syntax").state, "failed");
  assert.ok(broken.problems.some(p => /SyntaxError/.test(p) && /index\.js line \d+/.test(p)), broken.problems.join("; "));

  // A module from outside Vyre says its apiVersion.
  const noApi = await checkModule(writeModule(path.join(root, "e"), "bakery", {}, "export default {};\n"), { repo, node });
  assert.ok(noApi.problems.some(p => /apiVersion is required/.test(p)));

  const noManifest = await checkModule(path.join(root, "nowhere"), { repo, node });
  assert.equal(noManifest.ok, false);
  assert.equal(by(noManifest, "manifest").state, "failed");
});

test("check --json is { ok, module, problems } with exit 0 clean and 1 with problems", async t => {
  const { deps, home } = world(t);
  const c = capture(t);
  setJson(true);
  t.after(() => setJson(false));
  const good = bakery(path.join(home, "good"));
  assert.equal(await moduleCommand(["check", good, "--json"], deps), EXIT.OK);
  const ok = c.json.at(-1);
  assert.deepEqual({ ok: ok.ok, module: ok.module, problems: ok.problems }, { ok: true, module: "bakery", problems: [] });
  const bad = bakery(path.join(home, "bad"), { does: { tools: ["orders"] } });
  assert.equal(await moduleCommand(["check", bad, "--json"], deps), EXIT.FAILED);
  const no = c.json.at(-1);
  assert.equal(no.ok, false);
  assert.equal(no.module, "bakery");
  assert.ok(no.problems.length >= 1 && no.problems.every(p => typeof p === "string"));
  assert.equal(c.json.length, 2, "one line per run");
  // The default folder is the one it runs in.
  t.mock.method(process, "cwd", () => good);
  assert.equal(await moduleCommand(["check"], deps), EXIT.OK);
});

// ---------------------------------------------------------------------------------------------
// add

test("add from a folder: checks, copies without .git, restarts once, reports the state", async t => {
  const w = world(t, { rows: () => [{ name: "bakery", version: "0.1.0", state: "running" }] });
  const c = capture(t);
  const src = bakery(path.join(w.home, "src"), { needs: { credentials: [{ id: "supplier", kind: "api-credential", provider: "flourco", purpose: "place flour orders" }], network: ["orders.example.com"] } });
  fs.mkdirSync(path.join(src, ".git"));
  fs.writeFileSync(path.join(src, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.symlinkSync("/etc", path.join(src, "elsewhere"));
  assert.equal(await moduleCommand(["add", src, "--yes"], w.deps), EXIT.OK);
  const dest = path.join(w.modules, "bakery");
  assert.ok(fs.existsSync(path.join(dest, "module.json")));
  assert.ok(!fs.existsSync(path.join(dest, ".git")), "no .git");
  assert.ok(!fs.existsSync(path.join(dest, "elsewhere")), "no symlink");
  assert.ok(!fs.lstatSync(dest).isSymbolicLink(), "a copy, not a link");
  assert.equal(w.calls.restart, 1);
  assert.match(text(c), /Tools\s+bakery\.orders/);
  assert.match(text(c), /Credentials\s+supplier \(place flour orders\)/);
  assert.match(text(c), /Network\s+orders\.example\.com/);
  assert.match(text(c), /add only code you trust/);
  assert.match(text(c), /running/);
  // Nothing is left staged in the home.
  assert.deepEqual(fs.readdirSync(w.home).filter(n => n.startsWith(".module-add-")), []);
});

test("add from a file:// git repo, and --json reports a module that failed to start", async t => {
  const w = world(t, { rows: [{ name: "bakery", version: "0.1.0", state: "failed", error: "orders is not defined" }] });
  const c = capture(t);
  const work = bakery(path.join(w.home, "work"));
  const git = (/** @type {string[]} */ ...a) => execFileSync("git", ["-c", "user.name=alex", "-c", "user.email=alex@example.com", ...a], { cwd: work, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "bakery");
  const bare = path.join(w.home, "bakery.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare], { stdio: "pipe" });
  setJson(true);
  t.after(() => setJson(false));
  assert.equal(await moduleCommand(["add", `file://${bare}`, "--yes", "--json"], w.deps), EXIT.FAILED);
  const d = c.json.at(-1);
  assert.equal(d.installed, true);
  assert.equal(d.reload, "restarted");
  assert.equal(d.state, "failed");
  assert.equal(d.error, "orders is not defined");
  assert.equal(c.json.length, 1, "one line");
  const dest = path.join(w.modules, "bakery");
  assert.ok(fs.existsSync(path.join(dest, "index.js")));
  assert.ok(!fs.existsSync(path.join(dest, ".git")), "the clone's .git stays behind");
  assert.equal(w.calls.restart, 1);
});

test("add refuses a failing module, a name that is there, a shipped name, and asks off a terminal", async t => {
  const w = world(t, { rows: [] });
  const c = capture(t);
  const bad = bakery(path.join(w.home, "bad"), { does: { tools: ["orders"] } });
  assert.equal(await moduleCommand(["add", bad, "--yes"], w.deps), EXIT.FAILED);
  assert.match(text(c), /did not pass the check/);
  assert.ok(!fs.existsSync(path.join(w.modules, "bakery")));

  const good = bakery(path.join(w.home, "good"));
  // No terminal and no --yes: it says what to pass, and changes nothing.
  assert.equal(await moduleCommand(["add", good], w.deps), EXIT.USAGE);
  assert.match(text(c), /needs --yes/);
  assert.ok(!fs.existsSync(path.join(w.modules, "bakery")));

  // A terminal: a no changes nothing, a yes adds it.
  const tty = world(t, { tty: true, answers: ["n", "y"], rows: [] });
  assert.equal(await moduleCommand(["add", good], { ...tty.deps }), EXIT.FAILED);
  assert.ok(!fs.existsSync(path.join(tty.modules, "bakery")));
  assert.equal(await moduleCommand(["add", good], { ...tty.deps }), EXIT.OK);
  assert.equal(tty.calls.asked.length, 2);
  assert.ok(fs.existsSync(path.join(tty.modules, "bakery", "module.json")));

  // The same name again.
  assert.equal(await moduleCommand(["add", good, "--yes"], tty.deps), EXIT.FAILED);
  assert.match(text(c), /already there/);
  assert.equal(tty.calls.restart, 1, "restarted only for the one that went in");

  // A shipped name: refused without replaces, and replaces needs --yes.
  const shipped = writeModule(path.join(w.home, "shipped"), "commands", { apiVersion: 1, description: "A stand-in for commands.", does: { tools: [{ name: "commands.list" }] } }, "export default {};\n");
  assert.equal(await moduleCommand(["add", shipped, "--yes"], w.deps), EXIT.FAILED);
  assert.match(text(c), /one of Vyre's own modules/);
  const replacing = writeModule(path.join(w.home, "replacing"), "commands", { apiVersion: 1, description: "A stand-in for commands.", replaces: "commands", does: { tools: [{ name: "commands.list" }] } }, "export default {};\n");
  assert.equal(await moduleCommand(["add", replacing], w.deps), EXIT.USAGE);
  assert.match(text(c), /needs your explicit yes/);
  assert.equal(await moduleCommand(["add", replacing, "--yes"], w.deps), EXIT.OK);
  assert.ok(fs.existsSync(path.join(w.modules, "commands", "module.json")));

  assert.equal(await moduleCommand(["add", path.join(w.home, "nowhere"), "--yes"], w.deps), EXIT.USAGE);
  assert.equal(await moduleCommand(["add"], w.deps), EXIT.USAGE);
  assert.equal(await moduleCommand(["check", "--yes"], w.deps), EXIT.USAGE);
});

test("add in the box's container leaves the restart to the host", async t => {
  const w = world(t);
  const c = capture(t);
  const good = bakery(path.join(w.home, "good"));
  assert.equal(await moduleCommand(["add", good, "--yes"], { ...w.deps, supervisor: "docker" }), EXIT.OK);
  assert.equal(w.calls.restart, 0);
  assert.match(text(c), /docker compose restart vyre/);
});

test("add says so when vyred did not restart", async t => {
  const w = world(t, { restart: { ok: false, note: "the running vyred did not stop" } });
  const c = capture(t);
  const good = bakery(path.join(w.home, "good"));
  assert.equal(await moduleCommand(["add", good, "--yes"], w.deps), EXIT.FAILED);
  assert.match(text(c), /did not restart: the running vyred did not stop/);
  assert.ok(fs.existsSync(path.join(w.modules, "bakery")), "the module stays in");
});

// ---------------------------------------------------------------------------------------------
// --view

test("--view prints frames that fit Render, and a prompt instead of asking", async t => {
  const w = world(t, { rows: [{ name: "bakery", version: "0.1.0", state: "running" }] });
  const c = capture(t);
  const take = () => c.json.splice(0);

  assert.equal(await moduleCommand(["new", "bake", "--view"], w.deps), EXIT.OK);
  let f = take();
  assertFrames(f, 0);
  assert.equal(f[0].cmd, "module new");
  assert.equal(f[0].view.kind, "card");
  assert.equal(f[0].data.module, "bake");

  assert.equal(await moduleCommand(["check", path.join(w.modules, "bake"), "--view"], w.deps), EXIT.OK);
  f = take();
  assertFrames(f, 0);
  assert.equal(f[0].view.kind, "checks");
  assert.ok(f[0].view.items.every(i => i.state === "ok"));
  assert.deepEqual(Object.keys(f[0].data).sort(), ["dir", "module", "ok", "problems"]);

  const bad = bakery(path.join(w.home, "bad"), { colour: "red" });
  assert.equal(await moduleCommand(["check", bad, "--view"], w.deps), EXIT.FAILED);
  f = take();
  assertFrames(f, 1);
  assert.ok(f[0].view.items.some(i => i.id === "schema" && i.state === "failed" && /colour/.test(i.note)));

  const good = bakery(path.join(w.home, "good"));
  assert.equal(await moduleCommand(["add", good, "--view"], w.deps), EXIT.USAGE);
  f = take();
  assertFrames(f, 2);
  assert.equal(f[0].view.kind, "prompt");
  assert.equal(f[0].view.answer, "confirm");
  assert.deepEqual(f[0].view.args, ["module", "add", good, "--yes", "--view"]);
  assert.equal(w.calls.restart, 0);

  assert.equal(await moduleCommand(["add", good, "--yes", "--view"], w.deps), EXIT.OK);
  f = take();
  assertFrames(f, 0);
  assert.equal(f[0].view.kind, "card");
  assert.equal(f[0].view.state, "ok");
  assert.equal(f[0].data.state, "running");

  assert.equal(await moduleCommand(["new", "commands", "--view"], w.deps), EXIT.FAILED);
  f = take();
  assertFrames(f, 1);
  assert.equal(f[0].view.kind, "error");
  assert.equal(f[0].data.error.code, "name_taken");

  assert.equal(await moduleCommand(["frob", "--view"], w.deps), EXIT.USAGE);
  assertFrames(take(), 2);
  assert.deepEqual(c.lines, [], "nothing for a person's eyes under --view");
});
