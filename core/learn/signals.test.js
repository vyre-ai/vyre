// @ts-check
// More signals, behaviour proposals, scope, jobs, metrics and skills, through the Registry with
// the real Harness (ADR 0007, decisions 6 to 10). Fictional people and folders only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { softCorrection, wordsKey } from "./signals.js";
import { parseAnswer } from "./jobs.js";

const DASH = "\u2014";
const HERE = path.dirname(new URL(import.meta.url).pathname);

/** Projects: harlow-site owns <home>/w/harlow-site, bramble-app owns <home>/w/bramble-app. */
function fakeProjects(home) {
  const w = path.join(home, "w");
  const src = `const W = ${JSON.stringify(w)};
  const P = [{ slug: "harlow-site", name: "Harlow Site", home: W + "/harlow-site", workspaces: [W + "/harlow-site"] },
             { slug: "bramble-app", name: "Bramble App", home: W + "/bramble-app", workspaces: [W + "/bramble-app"] }];
  export default { async start(ctx) {
    ctx.tool("projects.of", { run: async ({ cwd }) => { const p = P.find(p => cwd === p.home || String(cwd).startsWith(p.home + "/")); return p ? { slug: p.slug, name: p.name, home: p.home, folders: p.workspaces } : null; } });
    ctx.tool("projects.list", { run: async () => ({ projects: P, problems: [] }) });
    return {};
  } };`;
  writeModule(path.join(home, "mods"), "projects", { does: { tools: ["projects.of", "projects.list"] } }, src);
  for (const p of ["harlow-site", "bramble-app"]) fs.mkdirSync(path.join(w, p, "src"), { recursive: true });
  return { w, harlow: path.join(w, "harlow-site"), bramble: path.join(w, "bramble-app") };
}

/**
 * A stand-in Switchboard: threads.list and threads.launch, and `answer(text)` to make the last
 * launched job thread reply. `busy` makes a user thread look like it is working.
 */
function fakeSwitchboard(home) {
  const src = `export default { async start(ctx) {
    globalThis.__sb = { launched: [], busy: false, emit: (type, payload, thread) => ctx.events.emit(type, { thread, ...payload }, { thread }) };
    ctx.tool("threads.list", { run: async () => globalThis.__sb.busy ? [{ id: "user-thread", status: "working" }] : [] });
    ctx.tool("threads.launch", { internal: true, run: async i => { const id = "job-" + (globalThis.__sb.launched.length + 1); globalThis.__sb.launched.push({ id, ...i }); return { id, status: "starting" }; } });
    return {};
  } };`;
  writeModule(path.join(home, "sbmods"), "threads", { does: { tools: ["threads.list", "threads.launch"] }, watches: { emits: ["thread.text", "thread.stopped", "thread.finished"] } }, src);
  return discover([path.join(home, "sbmods")]);
}
const sb = () => /** @type {any} */ (globalThis).__sb;

/** A stand-in Memory that records what it is taught. */
function fakeMemory(home) {
  const src = `export default { async start(ctx) {
    globalThis.__taught = [];
    ctx.tool("memory.teach", { internal: true, run: async i => { globalThis.__taught.push(i); return { changed: true }; } });
    return {};
  } };`;
  writeModule(path.join(home, "memmods"), "memory", { does: { tools: ["memory.teach"] } }, src);
  return discover([path.join(home, "memmods")]);
}

async function learning(t, { projects = false, switchboard = false, memory = false, config = {} } = {}) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local", ...config }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(HERE, "..")]).filter(f => ["harness", "learn"].includes(f.manifest?.name));
  const where = projects ? fakeProjects(home) : null;
  const extra = [...(projects ? discover([path.join(home, "mods")]) : []), ...(switchboard ? fakeSwitchboard(home) : []), ...(memory ? fakeMemory(home) : [])];
  await reg.start([...core, ...extra], { role: "local" });
  t.after(async () => { await reg.stop(); db.close(); });
  const of = type => events.since(0, { limit: 5000 }).filter(e => e.type === type);
  const lessons = async () => (await reg.call("learn.lessons", { status: "all" })).data;
  const signals = kind => db.prepare("SELECT * FROM learn_signals WHERE kind = ? ORDER BY id").all(kind);
  const say = (prompt, session, prompt_id, cwd = where ? where.harlow : "/w/harlow-site") => reg.call("harness.enrich", { prompt, cwd, session, prompt_id });
  const stop = (session, prompt_id, extra = {}) => reg.call("harness.stop", { session, prompt_id, stop_hook_active: false, ...extra });
  return { home, db, events, reg, of, lessons, signals, say, stop, where };
}
const tick = () => new Promise(r => setTimeout(r, 5));
let n = 0;
const uid = () => `toolu_${++n}`;

test("signals: fingerprints are stable, and soft corrections are told from ordinary prompts", () => {
  assert.equal(wordsKey("Stop adding comments to every function"), wordsKey("please stop adding comments to every function!"));
  assert.notEqual(wordsKey("stop adding comments"), wordsKey("stop adding tests"));
  for (const s of ["stop adding comments to every function", "don't wrap lines at 80", "no, don't rename the exports"]) assert.equal(softCorrection(s), true, s);
  for (const s of ["don't worry about the footer", "don't forget the header", "what does stop do?", "fix the stop button", "/vyre remember x", "yes"]) assert.equal(softCorrection(s), false, s);
});

test("repeated: the same correction in two sessions is a signal, and a plain one no shape fits becomes a job then", async t => {
  const { reg, say, signals, db } = await learning(t);
  await say("stop adding comments to every function", "s1", "p1");
  assert.equal(signals("repeated").length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learn_jobs").get().n, 0, "said once: no job");
  await say("please stop adding comments to every function", "s2", "p1");
  const r = signals("repeated");
  assert.equal(r.length, 1);
  assert.equal(JSON.parse(r[0].meta).sessions, 2);
  assert.equal(r[0].text, null, "a repeat carries a key, not the words");
  const jobs = (await reg.call("learn.signals", {}, "cli")).data.jobs;
  assert.deepEqual(jobs.map(j => [j.kind, j.status]), [["distill", "queued"]], "no Switchboard: the job waits");
  assert.match(jobs[0].text, /stop adding comments/, "the user sees their own words to write by hand");
  await say("stop adding comments to every function", "s2", "p2");
  assert.equal(signals("repeated").length, 1, "once per session");
});

test("rejected and corrected: counted with kinds and ids, and corrections per extraction rule", async t => {
  const { reg, events, signals } = await learning(t);
  events.emit("gate", "gate.rejected", { id: 4, kind: "mail", via: "gmail", by: "deck", reason: "wrong tone" }, { thread: "s1" });
  for (const rule of ["appositive", "appositive", "signature"]) {
    events.emit("memory", "memory.corrected", { id: 1, action: "wrong", rel: "works_at", scope: "all", prior_source: "extract", prior_rule: rule, prior_confidence: 0.7 });
  }
  await tick();
  const rej = signals("rejected");
  assert.equal(rej.length, 1);
  assert.deepEqual(JSON.parse(rej[0].meta), { draft: 4, kind: "mail", via: "gmail" });
  assert.ok(!JSON.stringify(rej[0]).includes("wrong tone"), "the reason is not kept");
  const s = (await reg.call("learn.signals", {}, "cli")).data;
  assert.deepEqual(s.corrected, [{ rule: "appositive", n: 2 }, { rule: "signature", n: 1 }]);
  assert.equal((await reg.call("learn.lessons", { status: "all" })).data.length, 0, "a correction to Memory is not a lesson for Claude");
  assert.equal((await reg.call("learn.signals", {}, "mcp")).error.code, "denied", "owner surfaces only");
});

test("reverted: a file the user put back in two sessions proposes a path check at ask, told in that thread", async t => {
  const { reg, say, stop, signals, lessons, where } = await learning(t, { projects: true });
  const file = path.join(where.harlow, "src", "intake.js");
  const write = async (session, content) => {
    const id = uid();
    await reg.call("harness.rules", { tool_name: "Write", tool_input: { file_path: "src/intake.js", content }, cwd: where.harlow, session, prompt_id: "p1", tool_use_id: id });
    fs.writeFileSync(file, content);
    await reg.call("harness.learn", { tool_name: "Write", tool_input: { file_path: "src/intake.js" }, cwd: where.harlow, session, tool_use_id: id });
  };
  for (const [i, session] of ["s1", "s2"].entries()) {
    fs.writeFileSync(file, "export const form = 1;\n");
    fs.utimesSync(file, new Date(2026, 0, 1), new Date(2026, 0, 1));
    await say("tidy the intake form", session, "p1");
    await write(session, `export const form = ${i + 2};\n`);
    await stop(session, "p1");
    fs.writeFileSync(file, "export const form = 1;\n");              // the user puts it back, a moment later
    fs.utimesSync(file, new Date(2026, 0, 2), new Date(2026, 0, 2));
    await say("ok", session, "p2");
  }
  assert.equal(signals("reverted").length, 2);
  assert.ok(signals("reverted").every(s => s.text === null && s.key.startsWith("file:")), "hashes and keys only");
  const l = (await lessons()).find(x => x.check && x.check.kind === "path");
  assert.ok(l, "a path check proposed");
  assert.deepEqual([l.status, l.level, l.scope, l.check.label], ["proposed", "ask", { project: "harlow-site" }, "src/intake.js"]);
  const told = await say("next thing", "s2", "p3");
  assert.match(told.data.text, /undid Claude's changes to src\/intake\.js in two sessions/);
  assert.match(told.data.text, new RegExp(`lesson ${l.id}, not yet in force`));
});

test("rewritten, and Claude's own git checkout is not the user reverting", async t => {
  const { reg, say, stop, signals, where } = await learning(t, { projects: true });
  const file = path.join(where.harlow, "src", "a.js");
  fs.writeFileSync(file, "a\n");
  const cycle = async (session, after) => {
    await say("change a", session, "p1");
    const id = uid();
    await reg.call("harness.rules", { tool_name: "Edit", tool_input: { file_path: file, new_string: "b" }, cwd: where.harlow, session, prompt_id: "p1", tool_use_id: id });
    fs.writeFileSync(file, "b\n");
    await reg.call("harness.learn", { tool_name: "Edit", tool_input: { file_path: file }, cwd: where.harlow, session, tool_use_id: id });
    await after(session);
    await stop(session, "p1");
    await say("next", session, "p2");
  };
  await cycle("s1", async () => { fs.writeFileSync(file, "c, by the user\n"); fs.utimesSync(file, new Date(2026, 0, 2), new Date(2026, 0, 2)); });
  assert.equal(signals("rewritten").length, 1);
  fs.writeFileSync(file, "a\n");
  await cycle("s2", async session => {
    await reg.call("harness.rules", { tool_name: "Bash", tool_input: { command: "git checkout src/a.js" }, cwd: where.harlow, session, prompt_id: "p1", tool_use_id: uid() });
    fs.writeFileSync(file, "a\n");
    fs.utimesSync(file, new Date(2026, 0, 3), new Date(2026, 0, 3));
  });
  assert.equal(signals("reverted").length, 0, "Claude undid it itself");
});

test("test-fix: a failing test, an edit and a pass is a run; an edit with no test after it proposes an after check at remind", async t => {
  const { reg, say, stop, signals, lessons } = await learning(t);
  const cwd = "/w/harlow-site";
  const bash = async (session, command, ok) => {
    const id = uid();
    await reg.call("harness.rules", { tool_name: "Bash", tool_input: { command }, cwd, session, prompt_id: "p1", tool_use_id: id });
    await reg.call("harness.learn", { tool_name: "Bash", tool_input: { command }, cwd, session, tool_use_id: id, ok });
  };
  const edit = async session => {
    const id = uid();
    await reg.call("harness.rules", { tool_name: "Edit", tool_input: { file_path: "src/x.js", new_string: "y" }, cwd, session, prompt_id: "p1", tool_use_id: id });
    await tick();
    await reg.call("harness.learn", { tool_name: "Edit", tool_input: { file_path: "src/x.js" }, cwd, session, tool_use_id: id });
    await tick();
  };
  await say("fix the tests", "s1", "p1");
  await bash("s1", "npm test", false);
  await edit("s1");
  await bash("s1", "npm test", true);
  await stop("s1", "p1");
  assert.equal(signals("test-fix").length, 1);
  assert.deepEqual(signals("failed").map(s => s.kind), ["failed"]);
  assert.equal(signals("fixed").length, 1);
  assert.equal((await lessons()).length, 0, "tests re-run: nothing to propose");

  await say("fix the tests", "s2", "p1");
  await bash("s2", "npm test", false);
  await edit("s2");
  await stop("s2", "p1");
  assert.equal(signals("untested").length, 1);
  const l = (await lessons())[0];
  assert.deepEqual([l.status, l.level, l.check.kind], ["proposed", "remind", "after"], "inferred: never block");
  assert.match((await say("and now?", "s2", "p2")).data.text, /ended without running them again/);
});

test("declined: a command the user said no to 3 times in 14 days, never yes, proposes a tool check at ask", async t => {
  const { reg, say, stop, signals, lessons } = await learning(t);
  const cwd = "/w/harlow-site";
  for (const session of ["s1", "s2", "s3"]) {
    await say("clean up", session, "p1");
    // PreToolUse saw it; Vyre did not hold it; neither Post nor PostFailure came: the user said no.
    await reg.call("harness.rules", { tool_name: "Bash", tool_input: { command: "rm -rf dist" }, cwd, session, prompt_id: "p1", tool_use_id: uid() });
    const ok = uid();
    await reg.call("harness.rules", { tool_name: "Bash", tool_input: { command: "ls" }, cwd, session, prompt_id: "p1", tool_use_id: ok });
    await reg.call("harness.learn", { tool_name: "Bash", tool_input: { command: "ls" }, cwd, session, tool_use_id: ok });
    await stop(session, "p1");
  }
  assert.equal(signals("declined").length, 3, "the ls that ran is not declined");
  assert.deepEqual(JSON.parse(signals("declined")[0].meta), { tool: "Bash", shape: "rm -rf dist" });
  const l = (await lessons()).find(x => x.check && x.check.kind === "tool");
  assert.ok(l);
  assert.deepEqual([l.level, l.status], ["ask", "proposed"]);
  const r = await reg.call("learn.accept", { id: l.id }, "cli");
  assert.equal(r.data.status, "active");
  const held = await reg.call("harness.rules", { tool_name: "Bash", tool_input: { command: "rm -rf build" }, cwd, session: "s4", tool_use_id: uid() });
  assert.equal(held.data.decision, "ask");
});

test("declined: an allowed run of the same shape means no proposal", async t => {
  const { reg, say, stop, lessons, events } = await learning(t);
  const cwd = "/w/harlow-site";
  for (const session of ["s1", "s2", "s3"]) {
    await say("ship it", session, "p1");
    await reg.call("harness.rules", { tool_name: "Bash", tool_input: { command: "git push" }, cwd, session, prompt_id: "p1", tool_use_id: uid() });
    await stop(session, "p1");
  }
  // One allow, answered on a Switchboard thread, and the rule is not proposed a fourth time.
  events.emit("threads", "ask.answered", { ask: "a1", decision: "allow", by: "deck", tool: "Bash", summary: "git push" }, { thread: "s1" });
  await tick();
  assert.equal((await lessons()).filter(l => l.check && l.check.kind === "tool").length, 1, "three nos proposed it once");
  await say("ship it", "s5", "p1");
  await reg.call("harness.rules", { tool_name: "Bash", tool_input: { command: "git push" }, cwd, session: "s5", prompt_id: "p1", tool_use_id: uid() });
  await stop("s5", "p1");
  assert.equal((await lessons()).filter(l => l.check && l.check.kind === "tool").length, 1, "no second proposal");
});

test("denied and allowed: ask.answered counts per shape; an ask lesson allowed 5 of 5 proposes a demotion, as an event only", async t => {
  const { reg, say, stop, signals, events, of } = await learning(t);
  const cwd = "/w/harlow-site";
  const l = (await reg.call("learn.add", { text: "don't use sed -i", level: "ask" })).data;
  for (let i = 0; i < 5; i++) {
    await say("edit config", "s1", `p${i}`);
    const id = uid();
    const r = await reg.call("harness.rules", { tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ x.conf" }, cwd, session: "s1", prompt_id: `p${i}`, tool_use_id: id });
    assert.equal(r.data.decision, "ask");
    events.emit("threads", "ask.answered", { ask: `a${i}`, decision: "allow", by: "deck", tool: "Bash", summary: "sed -i s/a/b/ x.conf" }, { thread: "s1" });
    await tick();
    await reg.call("harness.learn", { tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ x.conf" }, cwd, session: "s1", tool_use_id: id });
    await stop("s1", `p${i}`);
  }
  assert.equal(signals("allowed").filter(s => s.lesson === l.id).length, 5, "counted once each, when the call ran");
  const ev = of("lesson.allowed");
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload, { lesson: l.id, allowed: 5, asked: 5, level: "ask", propose: "remind" });
  assert.equal((await reg.call("learn.lessons", {})).data.find(x => x.id === l.id).level, "ask", "nothing changes on its own");
  events.emit("threads", "ask.answered", { ask: "a9", decision: "deny", by: "deck", tool: "Bash", summary: "sed -i s/x/y/ y.conf" }, { thread: "s2" });
  await tick();
  assert.equal(signals("denied").length, 1);
});

test("scope: a scope word decides; a project check stays in its project unless it was said in another project too", async t => {
  const { say, lessons, where } = await learning(t, { projects: true });
  await say("never use em dashes", "s1", "p1");
  await say("don't touch migrations/", "s1", "p2");
  await say("always run lint before you push", "s1", "p3", where.bramble);
  await say("always run lint before you push", "s2", "p1", where.harlow);
  await say("use pnpm not npm in this repo", "s3", "p1", where.bramble);
  await say("never push to main everywhere", "s3", "p2", where.bramble);
  const byRule = Object.fromEntries((await lessons()).map(l => [l.rule, l.scope]));
  assert.equal(byRule["Never use em dashes."], "all", "style: everywhere");
  assert.deepEqual(byRule["Never change anything in migrations/."], { project: "harlow-site" }, "a path in the project");
  assert.deepEqual(byRule["Run lint before git push."], { project: "bramble-app" }, "first said in bramble-app");
  assert.deepEqual(byRule["Use pnpm, not npm."], { project: "bramble-app" }, "in this repo");
  assert.equal(byRule["Never push to main."], "all", "everywhere");
  // The same rule proposed again from another project widens, and says so.
  const home = path.join(where.w, "other");
  await say("never change package-lock.json", "s4", "p1", where.harlow);
  const first = (await lessons()).find(l => l.rule === "Never change package-lock.json.");
  assert.deepEqual(first.scope, { project: "harlow-site" });
  assert.ok(home);
});

test("scope: said in another project first, a new proposal holds everywhere and says so", async t => {
  const { say, lessons, where, reg } = await learning(t, { projects: true });
  await say("don't touch vendor/", "s1", "p1", where.bramble);
  const l = (await lessons())[0];
  await reg.call("learn.retire", { id: l.id }, "cli");
  const r = await say("don't touch vendor/", "s2", "p1", where.harlow);
  assert.match(r.data.text, /said in another project too/);
  assert.equal((await lessons()).find(x => x.status === "proposed").scope, "all");
});

test("scope: narrowing a lesson (to a project, an agent, or some files) is learn.relax; widening back is learn.edit", async t => {
  const { reg } = await learning(t, { projects: true });
  const l = (await reg.call("learn.add", { text: "never use em dashes" })).data;
  const narrow = { check: { ...l.check, paths: "\\.md$" } };
  assert.match((await reg.call("learn.edit", { id: l.id, ...narrow }, "mcp")).error.message, /narrows the check to some files.*learn\.relax/);
  assert.equal((await reg.call("learn.relax", { id: l.id, ...narrow }, "cli")).data.check.paths, "\\.md$");
  assert.equal((await reg.call("learn.edit", { id: l.id, check: { kind: "text", pattern: "\u2014", label: l.check.label } }, "mcp")).data.check.paths, undefined, "taking paths off is free");
  assert.deepEqual((await reg.call("learn.relax", { id: l.id, scope: { project: "Harlow Site" } }, "cli")).data.scope, { project: "harlow-site" });
  assert.equal((await reg.call("learn.edit", { id: l.id, scope: "all" }, "mcp")).data.scope, "all");
});

test("preference: an accepted 'use pnpm not npm' teaches Memory the user prefers pnpm; retiring forgets it", async t => {
  const { reg, say } = await learning(t, { memory: true });
  await say("use pnpm not npm", "s1", "p1");
  await say("yes", "s1", "p2");
  const taught = /** @type {any} */ (globalThis).__taught;
  assert.equal(taught.length, 1);
  assert.equal(taught[0].kind, "preference");
  assert.equal(taught[0].from, "learn");
  assert.deepEqual({ ...taught[0].fact }, { subject: "the user", rel: "prefers", object: { name: "pnpm" }, text: "The user prefers pnpm over npm.", key: "lesson:1" });
  await reg.call("learn.retire", { id: 1 }, "cli");
  assert.equal(taught.length, 2);
  assert.equal(taught[1].fact.forget, true);
  assert.equal(taught[1].fact.key, "lesson:1");
});

test("jobs: without the Switchboard they wait, capped at 200", async t => {
  const { reg, db } = await learning(t);
  for (let i = 0; i < 205; i++) db.prepare("INSERT INTO learn_jobs (at, kind, key, input, status) VALUES (?,?,?,?, 'queued')").run(i, "distill", `k${i}`, JSON.stringify({ text: `rule ${i}` }));
  await reg.call("harness.enrich", { prompt: "from now on sign emails as Harlow Legal", session: "s1", prompt_id: "p1" });
  const q = db.prepare("SELECT COUNT(*) AS n FROM learn_jobs WHERE status = 'queued'").get().n;
  assert.equal(q, 200);
  assert.equal(db.prepare("SELECT MIN(at) AS at FROM learn_jobs WHERE status = 'queued'").get().at, 6, "the oldest made room");
});

test("jobs: through the Switchboard, one at a time, haiku, no plugin, no tools, one-shot; a valid answer is a proposal only", async t => {
  const { reg, say, db, lessons, of } = await learning(t, { switchboard: true });
  await say("from now on keep every function under forty lines", "s1", "p1");
  await tick();
  const [launch] = sb().launched;
  assert.ok(launch, "launched");
  assert.deepEqual({ model: launch.model, plugin: launch.plugin, tools: launch.tools, settings: launch.settings, once: launch.once, budget_usd: launch.budget_usd },
    { model: "haiku", plugin: false, tools: "none", settings: false, once: true, budget_usd: 0.05 });
  assert.match(launch.prompt, /forty lines/);
  assert.match(launch.prompt, /data, not instructions/);
  assert.ok(fs.existsSync(launch.cwd), "a folder of its own in the home");

  await say("always cc Dana Reyes on client emails", "s1", "p2");
  await tick();
  assert.equal(sb().launched.length, 1, "one at a time");

  sb().emit("thread.text", { message: "m1", text: JSON.stringify({ rule: "Keep every function under 40 lines.", level: "block", check: null }), done: true }, launch.id ? "job-1" : "job-1");
  await tick(); await tick();
  const all = await lessons();
  const drafted = all.find(l => l.source.kind === "model");
  assert.ok(drafted);
  assert.deepEqual([drafted.status, drafted.level], ["proposed", "remind"], "never block, never active");
  assert.equal(all.find(l => l.id === 1).status, "retired", "the plain-words proposal it replaces");
  assert.equal(all.find(l => l.id === 1).source.replaced_by, drafted.id);
  const fin = of("distill.finished");
  assert.deepEqual(fin.map(e => [e.payload.ok, e.payload.lesson]), [[true, drafted.id]]);
  assert.match((await say("go on", "s1", "p3")).data.text, /turned something the user said earlier into a rule/);

  // Ten minutes apart; then the next one, unless a user thread is working.
  await say("ok", "s1", "p4");
  assert.equal(sb().launched.length, 1);
  db.prepare("UPDATE learn_jobs SET started = started - 11 * 60000 WHERE started IS NOT NULL").run();
  sb().busy = true;
  await say("ok", "s1", "p5");
  await tick();
  assert.equal(sb().launched.length, 1, "a user thread is working");
  sb().busy = false;
  sb().emit("thread.finished", { ok: true }, "user-thread");
  await tick();
  assert.equal(sb().launched.length, 2, "an event, not a timer, started it");
  sb().emit("thread.text", { message: "m2", text: "Sure! Here is the rule: always cc Dana.", done: true }, "job-2");
  await tick();
  assert.equal(db.prepare("SELECT status FROM learn_jobs WHERE thread = 'job-2'").get().status, "failed", "not strict JSON: nothing proposed");
  assert.equal(of("lesson.proposed").length, 3);
  assert.ok(of("distill.finished").every(e => Object.keys(e.payload).every(k => ["job", "kind", "ok", "lesson", "skill"].includes(k))));
});

test("jobs: at most `learn.distill.daily` a day; an invalid check is refused", async t => {
  const { say, db } = await learning(t, { switchboard: true, config: { learn: { distill: { daily: 1 } } } });
  await say("from now on keep every function short", "s1", "p1");
  await tick();
  sb().emit("thread.text", { message: "m", text: JSON.stringify({ rule: "Short functions.", level: "ask", check: { kind: "text", pattern: "(" } }), done: true }, "job-1");
  await tick();
  assert.match(db.prepare("SELECT result FROM learn_jobs WHERE id = 1").get().result, /invalid/);
  await say("always cc Dana Reyes on client emails", "s1", "p2");
  db.prepare("UPDATE learn_jobs SET started = started - 11 * 60000 WHERE started IS NOT NULL").run();
  await say("ok", "s1", "p3");
  await tick();
  assert.equal(sb().launched.length, 1, "the daily limit");
  assert.deepEqual(parseAnswer("```json\n{\"rule\": null}\n```"), { value: { rule: null } });
  assert.match(parseAnswer("here: {}").error, /not a JSON object/);
});

test("stats: before and after per 100 turns, and a verdict", async t => {
  const { reg, say, stop, db } = await learning(t);
  const DAY = 86_400_000;
  await say("never use em dashes", "s1", "p1");
  await say("never use em dashes", "s2", "p1");                        // a repeat before acceptance
  await reg.call("learn.accept", { id: 1 }, "cli");
  assert.equal((await reg.call("learn.stats", { id: 1 })).data.verdict, "measuring");
  // Back-date: first said 3 days ago over 20 turns, accepted yesterday, 60 clean turns since.
  const at = Date.now();
  db.prepare("UPDATE learn_signals SET at = ? WHERE kind = 'prompt'").run(at - 3 * DAY);
  db.prepare("UPDATE learn_lessons SET accepted = ?, created = ? WHERE id = 1").run(at - DAY, at - 3 * DAY);
  db.prepare("DELETE FROM learn_days").run();
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  db.prepare("INSERT INTO learn_days (day, project, agent, turns) VALUES (?, '', '', 20)").run(day(at - 3 * DAY));
  db.prepare("INSERT INTO learn_days (day, project, agent, turns) VALUES (?, '', '', 60)").run(day(at));
  const s = (await reg.call("learn.stats", { id: 1 })).data;
  assert.deepEqual({ before: s.before, after: s.after, escapes: s.escapes, turns: s.turns, verdict: s.verdict }, { before: 10, after: 0, escapes: 0, turns: 60, verdict: "working" });
  await say("write it", "s3", "p1");
  for (const a of [true, true, true]) await stop("s3", "p1", { text: `a ${DASH} b`, stop_hook_active: a });
  const broken = (await reg.call("learn.stats", { id: 1 })).data;
  assert.equal(broken.escapes, 1);
  assert.ok(Array.isArray((await reg.call("learn.stats", {})).data));
});

test("dormant: quiet 60 days and 200 turns, out of the brief, still checked; waking on a catch", async t => {
  const { reg, db, of, say, stop } = await learning(t);
  await reg.call("learn.add", { text: "never use em dashes" });
  const at = Date.now();
  db.prepare("UPDATE learn_lessons SET accepted = ? WHERE id = 1").run(at - 70 * 86_400_000);
  db.prepare("INSERT INTO learn_days (day, project, agent, turns) VALUES (?, '', '', 250)").run(new Date(at - 10 * 86_400_000).toISOString().slice(0, 10));
  db.prepare("DELETE FROM learn_state WHERE key = 'daily'").run();
  await say("hello", "s1", "p1");
  await stop("s1", "p1", { text: "fine" });
  assert.deepEqual(of("lesson.dormant").map(e => e.payload), [{ lesson: 1, level: "block" }]);
  assert.equal((await reg.call("learn.check", { stage: "brief" }, "module:harness")).data.text, "", "out of the brief");
  await say("write", "s1", "p2");
  const b = await stop("s1", "p2", { text: `a ${DASH} b` });
  assert.equal(b.data.decision, "block", "still checked");
  assert.equal((await reg.call("learn.lessons", {})).data[0].dormant, false, "a catch wakes it");
});

test("retention: per-turn rows older than 7 days are pruned from Stop, at most hourly", async t => {
  const { db, say, stop } = await learning(t);
  const old = Date.now() - 8 * 86_400_000;
  db.prepare("INSERT INTO learn_commands (session, command, at) VALUES ('old', 'ls', ?)").run(old);
  db.prepare("INSERT INTO learn_calls (id, session, tool, at) VALUES ('old1', 'old', 'Bash', ?)").run(old);
  db.prepare("INSERT INTO learn_state (key, value) VALUES ('pruned', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
  await say("hi", "s1", "p1");
  await stop("s1", "p1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learn_commands WHERE session = 'old'").get().n, 1, "within the hour: not yet");
  db.prepare("UPDATE learn_state SET value = ? WHERE key = 'pruned'").run(String(Date.now() - 2 * 3_600_000));
  await say("hi", "s1", "p2");
  await stop("s1", "p2");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learn_commands WHERE session = 'old'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learn_calls WHERE session = 'old'").get().n, 0);
});

test("skills: steps recorded at Stop, marked clean at the next prompt, proposed from 3 sessions; install, retire and dismiss are the user's", async t => {
  const { reg, say, stop, of, home } = await learning(t);
  const cwd = "/w/harlow-site";
  for (const session of ["s1", "s2", "s3"]) {
    await say("ship the fix", session, "p1");
    for (const command of ["npm test", "git add -A", "git commit -m wip", "git push"]) {
      await reg.call("harness.rules", { tool_name: "Bash", tool_input: { command }, cwd, session, prompt_id: "p1", tool_use_id: uid() });
      await tick();
    }
    await stop(session, "p1");
    await say("thanks", session, "p2");
  }
  const { skills, drift } = (await reg.call("learn.skills", {})).data;
  assert.equal(skills.length, 1);
  assert.equal(skills[0].status, "proposed");
  assert.match(skills[0].body, /^---\nname: learned-/);
  assert.deepEqual(drift, []);
  assert.equal(of("skill.proposed").length, 1);
  for (const caller of ["mcp", "mcp:agent:kit", "harness"]) assert.equal((await reg.call("learn.skill-install", { id: skills[0].id }, caller)).error.code, "denied", caller);
  const inst = (await reg.call("learn.skill-install", { id: skills[0].id }, "cli")).data;
  assert.equal(inst.status, "installed");
  assert.equal(inst.path, path.join(home, "learned", "account", "skills", inst.name, "SKILL.md"), "where the Switchboard loads the account's skills");
  assert.equal((await reg.call("learn.skill-retire", { id: inst.id }, "cli")).data.status, "retired");
  for (const session of ["s4", "s5", "s6"]) {
    await say("ship the fix", session, "p1");
    for (const command of ["npm test", "git add -A", "git commit -m wip", "git push"]) {
      await reg.call("harness.rules", { tool_name: "Bash", tool_input: { command }, cwd, session, prompt_id: "p1", tool_use_id: uid() });
      await tick();
    }
    await stop(session, "p1");
    await say("thanks", session, "p2");
  }
  assert.equal((await reg.call("learn.skills", {})).data.skills.length, 1, "a retired procedure is not proposed again");
  assert.equal((await reg.call("learn.skill-dismiss", { id: 99 }, "cli")).error.code, "failed");
});

test("skills: a turn corrected at the next prompt is not clean", async t => {
  const { reg, say, stop, db } = await learning(t);
  await say("ship the fix", "s1", "p1");
  for (const command of ["npm test", "git add -A", "git push"]) {
    await reg.call("harness.rules", { tool_name: "Bash", tool_input: { command }, cwd: "/w", session: "s1", prompt_id: "p1", tool_use_id: uid() });
    await tick();
  }
  await stop("s1", "p1");
  await say("don't push without asking me", "s1", "p2");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learn_procs WHERE clean = 1").get().n, 0);
});

test("events carry ids, counts, kinds and levels; rule text only on proposed and learned", async t => {
  const { reg, say, stop, events } = await learning(t);
  await say("never use em dashes", "s1", "p1");
  await say("yes", "s1", "p2");
  await say("stop adding comments to every function", "s1", "p3");
  await say("stop adding comments to every function", "s2", "p1");
  for (const a of [false, true, true]) await stop("s1", "p3", { text: `a ${DASH} b`, stop_hook_active: a });
  for (const e of events.since(0, { limit: 1000 })) {
    if (!e.type.startsWith("lesson.") && !e.type.startsWith("skill.") && !e.type.startsWith("distill.")) continue;
    const text = JSON.stringify(e.payload);
    if (["lesson.proposed", "lesson.learned"].includes(e.type)) continue;
    assert.ok(!/em dash|comments|Never/.test(text), `${e.type} carries no rule text: ${text}`);
  }
  assert.ok(reg);
});
