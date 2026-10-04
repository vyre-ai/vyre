// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { distill, atStop, atTool, weakens, invalid, reply, CODE } from "./checks.js";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const DASH = "\u2014";

test("distill: a banned character becomes a text check, firm words start it at block", () => {
  const d = distill("never use em dashes in anything you write");
  assert.equal(d.level, "block");
  assert.deepEqual(d.check, { kind: "text", pattern: "\u2014", label: "an em dash (\u2014)" });
  assert.equal(d.rule, "Never use em dashes.");
  assert.equal(distill("please stop using em-dashes").level, "remind", "soft words fit a check at remind");
});

test("distill: a file to update with code becomes a touched check", () => {
  const d = distill("update CHANGELOG.md whenever you change code");
  assert.equal(d.check.kind, "touched");
  assert.equal(d.check.require, "CHANGELOG.md");
  assert.equal(d.check.when, CODE);
  assert.equal(d.level, "block");
});

test("distill: tests before a commit becomes a before check", () => {
  const d = distill("always run the tests before you commit");
  assert.equal(d.check.kind, "before");
  assert.match("git commit -m x", new RegExp(d.check.command));
  assert.match("npm test", new RegExp(d.check.first));
  assert.equal(d.rule, "Run the tests before every git commit.");
});

test("distill: a quoted phrase becomes a case-insensitive text check", () => {
  const d = distill(`don't ever say "circle back"`);
  assert.deepEqual(d.check, { kind: "text", pattern: "circle back", flags: "i", label: `"circle back"` });
  assert.equal(d.rule, `Never write "circle back".`);
});

test("distill: a firm rule with no known shape is a reminder without a check", () => {
  const d = distill("from now on sign emails to Dana Reyes as Harlow Legal");
  assert.deepEqual(d, { rule: "From now on sign emails to Dana Reyes as Harlow Legal.", when: "always", level: "remind", check: null });
});

test("distill: what is not a correction is null", () => {
  for (const s of ["what did Dana want?", "", "/compact never", "don't worry about the footer", "ship the Harlow site"]) assert.equal(distill(s), null, s);
});

test("invalid: checks are validated", () => {
  assert.equal(invalid(null), null);
  assert.equal(invalid({ kind: "text", pattern: "x" }), null);
  assert.match(invalid({ kind: "text", pattern: "(" }), /./);
  assert.match(invalid({ kind: "nope" }), /unknown check kind/);
});

test("atStop: text checks the reply, counting matches; no reply means it does not apply", () => {
  const c = distill("never use em dashes").check;
  const one = atStop(c, { text: `Sure ${DASH} here it is`, touched: [] });
  assert.equal(one.applied, true);
  assert.match(one.problem, /Your reply has an em dash/);
  assert.match(one.problem, /Sure \u2014 here/);
  assert.match(atStop(c, { text: `a ${DASH} b ${DASH} c`, touched: [] }).problem, /2 of em dash/);
  assert.deepEqual(atStop(c, { text: "Sure, here it is", touched: [] }), { applied: true, problem: null });
  assert.deepEqual(atStop(c, { text: null, touched: [] }), { applied: false, problem: null });
});

test("atStop: touched wants the required file whenever code changed", () => {
  const c = distill("update CHANGELOG.md whenever you change code").check;
  const r = atStop(c, { text: null, touched: ["/w/harlow-site/src/intake.js"] });
  assert.match(r.problem, /changed src\/intake\.js but not CHANGELOG\.md/);
  assert.deepEqual(atStop(c, { text: null, touched: ["/w/harlow-site/src/intake.js", "/w/harlow-site/CHANGELOG.md"] }), { applied: true, problem: null });
  assert.deepEqual(atStop(c, { text: null, touched: ["/w/harlow-site/notes.md"] }), { applied: false, problem: null }, "no code changed");
});

test("atTool: text checks what Write, Edit and MultiEdit put in a file", () => {
  const c = distill("never use em dashes").check;
  assert.match(atTool(c, { tool: "Write", input: { content: `a ${DASH} b` }, ran: [] }).problem, /What this writes has an em dash/);
  assert.ok(atTool(c, { tool: "Edit", input: { new_string: `x${DASH}y` }, ran: [] }).problem);
  assert.ok(atTool(c, { tool: "MultiEdit", input: { edits: [{ new_string: "fine" }, { new_string: `not ${DASH}` }] }, ran: [] }).problem);
  assert.deepEqual(atTool(c, { tool: "Edit", input: { new_string: "fine" }, ran: [] }), { applied: true, problem: null });
  assert.deepEqual(atTool(c, { tool: "Read", input: { file_path: "a" }, ran: [] }), { applied: false, problem: null });
});

test("atTool: before holds the command until the first one has run", () => {
  const c = distill("always run the tests before you commit").check;
  assert.match(atTool(c, { tool: "Bash", input: { command: "git commit -m x" }, ran: [] }).problem, /Run it first/);
  assert.deepEqual(atTool(c, { tool: "Bash", input: { command: "git commit -m x" }, ran: ["npm test"] }), { applied: true, problem: null });
  assert.deepEqual(atTool(c, { tool: "Bash", input: { command: "git status" }, ran: [] }), { applied: false, problem: null });
  assert.deepEqual(atTool(c, { tool: "Write", input: { content: "git commit" }, ran: [] }), { applied: false, problem: null });
});

test("weakens: retiring lessons, reaching the store and stopping vyred ask first", () => {
  for (const t of ["mcp__plugin_vyre_vyre__learn_retire", "mcp__vyre__learn_relax", "mcp__vyre__learn_accept", "learn_retire"]) assert.ok(weakens(t, {}), t);
  assert.equal(weakens("mcp__vyre__learn_edit", { id: 1, level: "block" }), null, "learn.edit only tightens, so it is free");
  for (const command of ["vyre learn retire 1", "sqlite3 ~/.vyre/vyre.db 'delete from learn_lessons'", "vyre down", "pkill vyred",
    "curl --unix-socket ~/.vyre/vyred.sock http://x/v1/tools/learn.retire"]) assert.ok(weakens("Bash", { command }), command);
  for (const command of ["npm test", "vyre learn", "git commit -m x"]) assert.equal(weakens("Bash", { command }), null, command);
  assert.equal(weakens("mcp__vyre__learn_lessons", {}), null);
  assert.equal(weakens("Read", { file_path: "vyre.db" }), null);
});

// The module, run through a Registry with the real Harness, as the hooks reach it.

async function learning(t, home = tempHome(t), extra = []) {
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {}, firstPartyRoots: [path.join(home, "mods")] });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => ["harness", "learn"].includes(f.manifest?.name));
  await reg.start([...core, ...extra], { role: "local" });
  t.after(() => db.close());
  const lesson = async id => (await reg.call("learn.lessons", { status: "all" }, "cli")).data.find(l => l.id === id);
  const add = async text => (await reg.call("learn.add", { text }, "cli")).data;
  const of = type => events.since(0, { limit: 1000 }).filter(e => e.type === type);
  return { reg, db, events, lesson, add, of, home };
}

const tick = () => new Promise(r => setTimeout(r, 5));
const CWD = "/w/harlow-site";

test("learn: a correction is proposed, Claude is told to ask, and nothing is enforced until it is accepted", async t => {
  const { reg, lesson } = await learning(t);
  const e = await reg.call("harness.enrich", { prompt: "never use em dashes in anything you write", cwd: CWD, session: "s1", prompt_id: "p1", interactive: true }, "cli");
  assert.match(e.data.text, /drafted it as lesson 1, not yet in force/);
  assert.match(e.data.text, /ask whether to keep it/);
  assert.match(e.data.text, /a plain yes keeps it/);
  assert.doesNotMatch(e.data.text, /learn_accept/, "Claude is never told to accept anything itself");
  assert.equal((await lesson(1)).status, "proposed");
  const s = await reg.call("harness.stop", { session: "s1", prompt_id: "p1", text: `Sure ${DASH} done`, stop_hook_active: false }, "cli");
  assert.deepEqual(s.data, { ok: true }, "a proposal holds nothing");
  const again = await reg.call("harness.enrich", { prompt: "never use em dashes", cwd: CWD, session: "s1", prompt_id: "p2" }, "cli");
  assert.match(again.data.text, /still waiting for the user's answer/);
  assert.equal((await reg.call("learn.lessons", {}, "cli")).data.length, 1, "the same correction is not proposed twice");
  assert.equal((await reg.call("learn.accept", { id: 1 }, "cli")).data.status, "active");
});

test("learn: a broken reply is sent back twice, then ends broken, and the next prompt hears about it", async t => {
  const { reg, lesson, of } = await learning(t);
  await reg.call("harness.enrich", { prompt: "never use em dashes in anything you write", cwd: CWD, session: "s1", prompt_id: "p1" }, "cli");
  await reg.call("learn.accept", { id: 1 }, "cli");
  await reg.call("harness.enrich", { prompt: "write the intro for Dana", cwd: CWD, session: "s1", prompt_id: "p2" }, "cli");
  const turn = { session: "s1", prompt_id: "p2", cwd: CWD, text: `Here is the intro ${DASH} short` };
  const b1 = await reg.call("harness.stop", { ...turn, stop_hook_active: false }, "cli");
  assert.equal(b1.data.decision, "block");
  assert.match(b1.data.reason, /Lesson 1: Never use em dashes\./);
  const b2 = await reg.call("harness.stop", { ...turn, stop_hook_active: true }, "cli");
  assert.equal(b2.data.decision, "block", "still broken, sent back again");
  const end = await reg.call("harness.stop", { ...turn, stop_hook_active: true }, "cli");
  assert.deepEqual(end.data, { ok: true }, "the third try ends the turn");
  const l = await lesson(1);
  assert.equal(l.broken, 1);
  assert.equal(l.caught, 2);
  assert.equal(of("lesson.broken").length, 1);
  assert.equal(of("lesson.broken")[0].payload.lesson, 1);
  const next = await reg.call("harness.enrich", { prompt: "now the footer", cwd: CWD, session: "s1", prompt_id: "p3" }, "cli");
  assert.match(next.data.text, /^Vyre lessons\.\nLast turn broke this lesson/, "the next prompt opens with it");
  assert.match(next.data.text, /- Lesson 1: Never use em dashes\./);
  const after = await reg.call("harness.enrich", { prompt: "and the header", cwd: CWD, session: "s1", prompt_id: "p4" }, "cli");
  assert.doesNotMatch(after.data.text, /Last turn broke/, "only the turn after hears it");
});

test("learn: a reply fixed after a block ends clean, counted as caught", async t => {
  const { reg, lesson, of } = await learning(t);
  await reg.call("learn.add", { text: "never use em dashes" }, "cli");
  await reg.call("harness.enrich", { prompt: "write the intro", cwd: CWD, session: "s1", prompt_id: "p1" }, "cli");
  const b = await reg.call("harness.stop", { session: "s1", prompt_id: "p1", text: `a ${DASH} b`, stop_hook_active: false }, "cli");
  assert.equal(b.data.decision, "block");
  const ok = await reg.call("harness.stop", { session: "s1", prompt_id: "p1", text: "a, b", stop_hook_active: true }, "cli");
  assert.deepEqual(ok.data, { ok: true });
  const l = await lesson(1);
  assert.deepEqual([l.applied, l.caught, l.broken], [1, 1, 0]);
  assert.equal(of("lesson.caught").length, 1);
  assert.equal(of("turn.completed").length, 1);
});

test("learn: changing code without the changelog is sent back; files touched before the turn do not count", async t => {
  const { reg, add } = await learning(t);
  const l = await add("update CHANGELOG.md whenever you change code");
  assert.equal(l.check.kind, "touched");
  const edit = file => reg.call("harness.learn", { tool_name: "Edit", tool_input: { file_path: file }, cwd: CWD, session: "s1" }, "cli");
  await edit("src/old.js");
  await tick();
  await reg.call("harness.enrich", { prompt: "fix the intake form", cwd: CWD, session: "s1", prompt_id: "p1" }, "cli");
  assert.deepEqual((await reg.call("harness.stop", { session: "s1", prompt_id: "p1", stop_hook_active: false }, "cli")).data, { ok: true }, "src/old.js was before this turn");
  await tick();
  await reg.call("harness.enrich", { prompt: "and the thank-you page", cwd: CWD, session: "s1", prompt_id: "p2" }, "cli");
  await edit("src/intake.js");
  const b = await reg.call("harness.stop", { session: "s1", prompt_id: "p2", stop_hook_active: false }, "cli");
  assert.equal(b.data.decision, "block");
  assert.match(b.data.reason, /src\/intake\.js but not CHANGELOG\.md/);
  assert.doesNotMatch(b.data.reason, /old\.js/);
  await edit("CHANGELOG.md");
  assert.deepEqual((await reg.call("harness.stop", { session: "s1", prompt_id: "p2", stop_hook_active: true }, "cli")).data, { ok: true });
});

test("learn: a Write with a banned character is denied before it runs, with the lesson quoted", async t => {
  const { reg, add, of } = await learning(t);
  await add("never use em dashes");
  const r = await reg.call("harness.rules", { tool_name: "Write", tool_input: { file_path: "a.md", content: `Harlow ${DASH} Legal` }, cwd: CWD, session: "s1" }, "cli");
  assert.equal(r.data.decision, "deny");
  assert.match(r.data.reason, /Vyre lesson 1, which the user taught: Never use em dashes\./);
  assert.equal(r.data.lesson, 1);
  const held = of("tool.held");
  assert.equal(held.length, 1);
  assert.equal(held[0].payload.lesson, 1);
  assert.equal((await reg.call("harness.rules", { tool_name: "Write", tool_input: { file_path: "a.md", content: "Harlow Legal" }, cwd: CWD, session: "s1" }, "cli")).data.decision, null);
});

test("learn: git commit is held until the tests have run", async t => {
  const { reg, add } = await learning(t);
  assert.equal((await add("always run the tests before you commit")).check.kind, "before");
  const bash = command => reg.call("harness.rules", { tool_name: "Bash", tool_input: { command }, cwd: CWD, session: "s1" }, "cli");
  const held = await bash("git commit -m x");
  assert.equal(held.data.decision, "deny");
  assert.match(held.data.reason, /Run the tests before every git commit/);
  assert.equal((await bash("npm test")).data.decision, null);
  assert.equal((await bash("git commit -m x")).data.decision, null);
});

test("learn: retiring a lesson from inside a turn asks the user, with lessons or not (a human-only tool is always guarded)", async t => {
  const { reg, add } = await learning(t);
  const retire = () => reg.call("harness.rules", { tool_name: "mcp__plugin_vyre_vyre__learn_retire", tool_input: { id: 1 }, session: "s1" }, "cli");
  assert.equal((await retire()).data.decision, "ask");
  await add("never use em dashes");
  const r = await retire();
  assert.equal(r.data.decision, "ask");
  assert.match(r.data.reason, /the user's call/);
});

test("learn: a remind lesson never holds a turn, and broken twice it moves up to ask", async t => {
  const { reg, lesson, of } = await learning(t);
  await reg.call("learn.add", { text: "never use em dashes", level: "remind" }, "cli");
  for (const p of ["p1", "p2"]) {
    await reg.call("harness.enrich", { prompt: "write it", cwd: CWD, session: "s1", prompt_id: p }, "cli");
    assert.deepEqual((await reg.call("harness.stop", { session: "s1", prompt_id: p, text: `a ${DASH} b`, stop_hook_active: false }, "cli")).data, { ok: true });
  }
  const l = await lesson(1);
  assert.equal(l.broken, 2);
  assert.equal(l.level, "ask");
  assert.deepEqual(of("lesson.escalated").map(e => [e.payload.from, e.payload.to]), [["remind", "ask"]]);
  await reg.call("harness.enrich", { prompt: "again", cwd: CWD, session: "s1", prompt_id: "p3" }, "cli");
  assert.equal((await reg.call("harness.stop", { session: "s1", prompt_id: "p3", text: `a ${DASH} b`, stop_hook_active: false }, "cli")).data.decision, "block", "at ask it sends the reply back");
});

test("learn: two different free-text rules are two proposals", async t => {
  const { reg } = await learning(t);
  await reg.call("harness.enrich", { prompt: "from now on sign emails as Harlow Legal", session: "s1", prompt_id: "p1" }, "cli");
  const e = await reg.call("harness.enrich", { prompt: "always cc Dana Reyes on client emails", session: "s1", prompt_id: "p2" }, "cli");
  assert.match(e.data.text, /drafted it as lesson 2, not yet in force/);
  assert.equal((await reg.call("learn.lessons", {}, "cli")).data.length, 2);
});

test("learn: brief lists every active lesson, marking the checked ones", async t => {
  const { reg, add } = await learning(t);
  assert.equal((await reg.call("harness.brief", { cwd: CWD, session: "s1" }, "cli")).data.text, "");
  await add("never use em dashes");
  await add("from now on sign emails as Harlow Legal");
  const b = (await reg.call("harness.brief", { cwd: CWD, session: "s1" }, "cli")).data.text;
  assert.match(b, /- Never use em dashes\. \(checked\)/);
  assert.match(b, /- From now on sign emails as Harlow Legal\.$/m);
});

// The snapshot the hooks use when vyred is down (offline.js), and what they logged meanwhile.

const snapshot = home => JSON.parse(fs.readFileSync(path.join(home, "lessons.json"), "utf8")).lessons;

test("learn: add, retire and escalation rewrite the offline snapshot", async t => {
  const { reg, add, home } = await learning(t);
  assert.deepEqual(snapshot(home), [], "written at start");
  await add("never use em dashes");
  await reg.call("learn.add", { text: "never use en dashes", level: "remind" }, "cli");
  assert.deepEqual(snapshot(home).map(l => [l.id, l.level]), [[1, "block"], [2, "remind"]]);
  assert.equal(fs.statSync(path.join(home, "lessons.json")).mode & 0o777, 0o600);
  await reg.call("learn.retire", { id: 1 }, "cli");
  assert.deepEqual(snapshot(home).map(l => l.id), [2]);
  for (const p of ["p1", "p2"]) {
    await reg.call("harness.enrich", { prompt: "write it", cwd: CWD, session: "s1", prompt_id: p }, "cli");
    await reg.call("harness.stop", { session: "s1", prompt_id: p, text: "a \u2013 b", stop_hook_active: false }, "cli");
  }
  assert.deepEqual(snapshot(home).map(l => [l.id, l.level]), [[2, "ask"]], "escalated in the snapshot too");
});

test("learn: what the hooks logged while vyred was down is counted at start, escalation included", async t => {
  const first = await learning(t);
  await first.add("never use em dashes");
  await first.reg.call("learn.add", { text: "never use en dashes", level: "remind" }, "cli");
  await first.reg.stop();
  const dir = path.join(first.home, "learn-offline");
  fs.mkdirSync(dir, { recursive: true });
  const entries = [{ lesson: 1, kind: "caught" }, { lesson: 1, kind: "caught" }, { lesson: 1, kind: "broken" },
    { lesson: 2, kind: "broken" }, { lesson: 2, kind: "broken" }, { lesson: 99, kind: "broken" }];
  fs.writeFileSync(path.join(dir, "log.jsonl"), entries.map(e => JSON.stringify({ ...e, session: "s1", at: 1 })).join("\n") + "\nnot json\n");
  const second = await learning(t, first.home);
  const a = await second.lesson(1), b = await second.lesson(2);
  assert.deepEqual([a.caught, a.broken, a.level], [2, 1, "block"]);
  assert.deepEqual([b.broken, b.level], [2, "ask"], "a remind lesson broken twice offline moves up");
  assert.deepEqual(second.of("lesson.escalated").map(e => [e.payload.lesson, e.payload.from, e.payload.to]), [[2, "remind", "ask"]]);
  assert.deepEqual(snapshot(first.home).map(l => [l.id, l.level]), [[1, "block"], [2, "ask"]]);
  assert.equal(fs.existsSync(path.join(dir, "log.jsonl")), false, "the log is emptied");
});

test("learn: a draft the user edited to take out every em dash proposes a remind lesson, told once in that thread", async t => {
  const home = tempHome(t);
  const gate = `export default { async start(ctx) {
    const drafts = { 7: { draft: { subject: "Brief", body: "Dana, the brief is ready \\u2014 sending Friday." }, final: { subject: "Brief", body: "Dana, the brief is ready. Sending Friday." }, diff: { removed: ["\\u2014 sending"], added: [". Sending"] } },
                     8: { draft: "Thanks, Dana.", final: "Thanks Dana!", diff: { removed: [","], added: ["!"] } } };
    ctx.tool("gate.get", { effect: "read", run: async ({ id }) => drafts[id] });
    ctx.tool("gate.fire", { effect: "read", run: async ({ id }) => { ctx.events.emit("gate.released", { id, kind: "mail", via: "mail", to: "dana@harlowlegal.com", edited: true, agent: null, thread: "s1", project: null }); return {}; } });
    return {};
  } };`;
  writeModule(path.join(home, "mods"), "gate", { does: { tools: ["gate.get", "gate.fire"] }, watches: { emits: ["gate.released"] } }, gate);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {}, firstPartyRoots: [path.join(home, "mods")] });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => ["harness", "learn"].includes(f.manifest?.name));
  await reg.start([...core, ...discover([path.join(home, "mods")], { firstPartyRoots: [path.join(home, "mods")] })], { role: "local" });
  t.after(() => db.close());

  await reg.call("gate.fire", { id: 8 });
  await reg.call("gate.fire", { id: 7 });
  await new Promise(r => setTimeout(r, 20));
  const lessons = (await reg.call("learn.lessons", { status: "all" }, "cli")).data;
  assert.equal(lessons.length, 1, "only the character taken out everywhere becomes a lesson");
  assert.deepEqual([lessons[0].status, lessons[0].level, lessons[0].check.pattern, lessons[0].source.kind], ["proposed", "remind", "—", "edited"]);
  const kept = db.prepare("SELECT text FROM learn_signals WHERE kind = 'edited'").all().map(r => r.text);
  assert.equal(kept.length, 2);
  assert.ok(kept.every(x => !/Dana|brief/.test(x)), "the message itself is never kept");

  const first = await reg.call("harness.enrich", { prompt: "what next?", cwd: "/w/harlow-site", session: "s1" }, "cli");
  assert.match(first.data.text, /edited a draft.*lesson 1/);
  const again = await reg.call("harness.enrich", { prompt: "and then?", cwd: "/w/harlow-site", session: "s1" }, "cli");
  assert.doesNotMatch(again.data.text, /edited a draft/, "told once");
  await reg.call("gate.fire", { id: 7 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await reg.call("learn.lessons", { status: "all" }, "cli")).data.length, 1, "the same edit again proposes nothing new");
});

// Enforcement that cannot be dodged (ADR 0007, decision 11).

/** A stand-in for Projects: one project, harlow-site, owning /w/harlow-site. */
function fakeProjects(home) {
  const src = `const P = { slug: "harlow-site", name: "Harlow Site", home: "/w/harlow-site", workspaces: ["/w/harlow-site"] };
  export default { async start(ctx) {
    ctx.tool("projects.of", { effect: "read", run: async ({ cwd }) => cwd === P.home || String(cwd).startsWith(P.home + "/") ? { slug: P.slug, name: P.name, home: P.home, folders: P.workspaces } : null });
    ctx.tool("projects.list", { effect: "read", run: async () => ({ projects: [P], problems: [] }) });
    return {};
  } };`;
  writeModule(path.join(home, "mods"), "projects", { does: { tools: ["projects.of", "projects.list"] } }, src);
  return discover([path.join(home, "mods")], { firstPartyRoots: [path.join(home, "mods")] });
}

test("learn: a project lesson applies in that project's folders and nowhere else; its scope holds the slug", async t => {
  const home = tempHome(t);
  const { reg, db } = await learning(t, home, fakeProjects(home));
  const l = (await reg.call("learn.add", { text: "never use em dashes", scope: { project: "Harlow Site" } }, "cli")).data;
  assert.deepEqual(l.scope, { project: "harlow-site" }, "a name given is stored as the slug");
  const write = cwd => reg.call("harness.rules", { tool_name: "Write", tool_input: { file_path: "a.md", content: `a ${DASH} b` }, cwd, session: "s1" }, "cli");
  assert.equal((await write("/w/harlow-site/src")).data.decision, "deny", "in the project's folder");
  assert.equal((await write("/w/other")).data.decision, null, "not elsewhere");
  // A lesson written before the slug rule, holding the project's name, still applies.
  db.prepare("UPDATE learn_lessons SET scope = ? WHERE id = ?").run(JSON.stringify({ project: "Harlow Site" }), l.id);
  assert.equal((await write("/w/harlow-site")).data.decision, "deny", "a legacy value still applies");
  const brief = await reg.call("learn.check", { stage: "brief", cwd: "/w/other" }, "module:harness");
  assert.equal(brief.data.text, "", "the brief elsewhere leaves it out");
});

test("learn: accept by reply: a plain yes to what the thread was told accepts it, with no tool call", async t => {
  const { reg, lesson, of } = await learning(t);
  await reg.call("harness.enrich", { prompt: "never use em dashes in anything you write", cwd: CWD, session: "s1", prompt_id: "p1", interactive: true }, "cli");
  await reg.call("harness.stop", { session: "s1", prompt_id: "p1", text: "Keep it?", stop_hook_active: false }, "cli");
  const y = await reg.call("harness.enrich", { prompt: "Yes, keep it.", cwd: CWD, session: "s1", prompt_id: "p2", interactive: true }, "cli");
  assert.match(y.data.text, /The user said yes: lesson 1 is in force now/);
  const l = await lesson(1);
  assert.equal(l.status, "active");
  assert.equal(l.source.accepted, "reply");
  assert.equal(of("lesson.learned").length, 1);
  assert.equal((await reg.call("harness.stop", { session: "s1", prompt_id: "p2", text: `a ${DASH} b`, stop_hook_active: false }, "cli")).data.decision, "block", "in force at once");
});

test("learn: a plain no declines; anything else leaves the proposal waiting; another thread's yes accepts nothing", async t => {
  const { reg, lesson } = await learning(t);
  // Each prompt is a whole turn: Claude Code takes the next prompt after the Stop.
  const say = async (prompt, session = "s1", prompt_id = prompt) => {
    const r = await reg.call("harness.enrich", { prompt, cwd: CWD, session, prompt_id, interactive: true }, "cli");
    await reg.call("harness.stop", { session, prompt_id, text: "ok", stop_hook_active: false }, "cli");
    return r;
  };
  await say("never use em dashes in anything you write");
  await say("yes", "s2");
  assert.equal((await lesson(1)).status, "proposed", "s2 was never told about it");
  await say("no, use semicolons instead");
  assert.equal((await lesson(1)).status, "proposed", "not a plain no");
  await say("yes");
  assert.equal((await lesson(1)).status, "proposed", "the window was the next prompt only");
  await say("sure, keep lesson 1");
  assert.equal((await lesson(1)).status, "proposed", "named by number, but told two turns ago: only the turn just before counts");
  await say("never use em dashes");
  await say("sure, keep lesson 1");
  assert.equal((await lesson(1)).status, "active", "named by number, told in the turn just before");
  await say("always run the tests before you commit");
  const n = await say("No thanks");
  assert.match(n.data.text, /The user said no: lesson 2/);
  const two = await lesson(2);
  assert.deepEqual([two.status, two.source.declined], ["retired", true]);
  for (const s of ["yes", "y", "keep it", "yes keep lesson 7", "sure", "do it", "Yes!"]) assert.equal(reply(s)?.yes, true, s);
  for (const s of ["no", "don't", "drop it", "no thanks"]) assert.equal(reply(s)?.yes, false, s);
  for (const s of ["yes but use the other logo", "no idea", "what?", "keep going"]) assert.equal(reply(s), null, s);
  // The answer as its own first sentence, with the next request after it.
  assert.equal(reply("Yes, keep it. Now write two sentences about rye.")?.yes, true);
  assert.equal(reply("No thanks.\nJust fix the test.")?.yes, false);
  for (const s of ["No, I meant the other file. Try again.", "Yes, and also rename it.", "Sure thing, but only in docs. Go on."]) assert.equal(reply(s), null, s);
});

test("learn: accept, retire and relax refuse local, MCP, agents, hooks and unknown callers, and declare presence", async t => {
  const { reg, add } = await learning(t);
  await add("never use em dashes");
  await reg.call("harness.enrich", { prompt: "always run the tests before you commit", cwd: CWD, session: "s1", prompt_id: "p1" }, "cli");
  // "local" is what any socket client gets by sending no header: `curl --unix-socket` from Claude's shell.
  for (const caller of ["local", "mcp", "mcp:agent:kit", "harness", "unknown"]) {
    assert.equal((await reg.call("learn.accept", { id: 2 }, caller)).error.code, "denied", caller);
    assert.equal((await reg.call("learn.retire", { id: 1 }, caller)).error.code, "denied", caller);
    assert.equal((await reg.call("learn.relax", { id: 1, level: "remind" }, caller)).error.code, "denied", caller);
  }
  for (const caller of ["cli", "local", "deck", "capsule"]) assert.ok((await reg.call("learn.lessons", {}, caller)).data);
  assert.equal((await reg.call("learn.relax", { id: 1, level: "remind" }, "deck")).data.level, "remind");

  // Presence, as ADR 0004's registry will read it: the summary names the lesson.
  const defs = {};
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  const { migrate } = await import("../store/index.js");
  const mod = (await import("./index.js")).default;
  await mod.start({ store: { db, migrate: steps => migrate(db, "learn", steps) }, events: new Events(db), call: async () => ({ error: { code: "no_such_tool" } }),
    log: () => {}, tool: (n, d) => { defs[n] = d; } });
  db.prepare("INSERT INTO learn_lessons (scope, when_text, rule, level, status, source, created, updated) VALUES ('\"all\"','always','Never use em dashes.','block','active','{}',1,1)").run();
  for (const n of ["learn.accept", "learn.retire", "learn.relax", "learn.skill-install", "learn.skill-retire", "learn.skill-dismiss"]) assert.deepEqual(defs[n].callers, ["cli", "deck", "capsule"], n);
  assert.deepEqual(defs["learn.signals"].callers, ["cli", "local", "deck", "capsule"], "reading stays open to local");
  // Accepting, relaxing and retiring are the user's own: no presence, and the callers list above keeps agents out.
  for (const n of ["learn.accept", "learn.retire", "learn.relax"]) assert.equal(defs[n].presence, undefined, n);
  assert.ok(["mcp", "harness"].every(k => defs["learn.edit"].callers.includes(k)), "tightening is free for a model session too (it only tightens)");

  // Human-only refusals carry presence_required and name the tool a surface's presence flow calls.
  await assert.rejects(defs["learn.edit"].run({ id: 1, level: "remind" }), e => e.code === "presence_required" && e.detail.tool === "learn.relax" && e.detail.id === 1);
  db.prepare("INSERT INTO learn_lessons (scope, when_text, rule, level, status, source, created, updated) VALUES ('\"all\"','always','Never say synergy.','remind','proposed','{}',1,1)").run();
  await assert.rejects(defs["learn.edit"].run({ id: 2, level: "block" }), e => e.code === "presence_required" && e.detail.tool === "learn.accept" && e.detail.id === 2);
});

test("learn: learn.edit refuses every weakening and names learn.relax; tightening is free", async t => {
  const { reg, add, lesson } = await learning(t);
  await add("never use em dashes");
  await reg.call("learn.add", { text: "from now on sign emails as Harlow Legal", level: "ask", when: "email" }, "cli");
  const edit = (change, caller = "mcp") => reg.call("learn.edit", { id: 1, ...change }, caller);
  for (const change of [{ level: "ask" }, { scope: { project: "harlow-site" } }, { scope: { agent: "kit" } }, { check: null },
    { check: { kind: "text", pattern: "x", label: "x" } }, { when: "reply" }, { max_level: "ask" }, { pinned: true }, { rule: "Em dashes are fine." }]) {
    const r = await edit(change);
    // presence_required once main's registry passes codes through (b27e6ff); "failed" before it.
    assert.ok(["presence_required", "failed"].includes(r.error?.code), JSON.stringify(change));
    assert.match(r.error.message, /learn\.relax/, JSON.stringify(change));
  }
  assert.deepEqual([(await lesson(1)).level, (await lesson(1)).check.kind], ["block", "text"], "nothing changed");
  assert.equal((await edit({ level: "block", scope: "all", when: "always", max_level: "block", pinned: false })).data.level, "block", "the same or stricter");
  const two = (change) => reg.call("learn.edit", { id: 2, ...change }, "mcp");
  assert.equal((await two({ level: "block" })).data.level, "block", "raised");
  assert.equal((await two({ when: "always" })).data.when, "always", "widened to always");
  assert.ok((await two({ check: { kind: "text", pattern: "Regards", label: "Regards" } })).data.check, "a check added where there was none");
  assert.ok(["presence_required", "failed"].includes((await reg.call("learn.edit", { id: 1, scope: { agent: "kit" } }, "mcp")).error.code));
  assert.deepEqual((await reg.call("learn.relax", { id: 1, scope: { agent: "kit" }, pinned: true }, "cli")).data.scope, { agent: "kit" });
  assert.deepEqual((await reg.call("learn.edit", { id: 1, scope: "all", pinned: false }, "mcp")).data.scope, "all", "widening back is free");
});

test("learn: escalation respects pinned and max_level", async t => {
  const { reg, lesson } = await learning(t);
  await reg.call("learn.add", { text: "never use em dashes", level: "remind" }, "cli");
  await reg.call("learn.add", { text: "never use en dashes", level: "remind" }, "cli");
  await reg.call("learn.relax", { id: 1, pinned: true }, "cli");
  await reg.call("learn.relax", { id: 2, max_level: "ask" }, "cli");
  for (let i = 0; i < 5; i++) {
    await reg.call("harness.enrich", { prompt: "write it", cwd: CWD, session: "s1", prompt_id: `p${i}` }, "cli");
    await reg.call("harness.stop", { session: "s1", prompt_id: `p${i}`, text: `a ${DASH} – b`, stop_hook_active: false }, "cli");
  }
  const one = await lesson(1), two = await lesson(2);
  assert.ok(one.broken >= 2 && two.broken >= 2);
  assert.equal(one.level, "remind", "pinned: no automatic change");
  assert.equal(two.level, "ask", "capped at max_level");
});

test("learn: after the cap the break is visible: payload, next prompt, and the week's brief; a new prompt_id mid-turn wins nothing", async t => {
  const { reg, add, of } = await learning(t);
  await add("never use em dashes");
  await reg.call("harness.enrich", { prompt: "write the intro", cwd: CWD, session: "s1", prompt_id: "p1" }, "cli");
  const turn = { session: "s1", cwd: CWD, text: `a ${DASH} b` };
  assert.equal((await reg.call("harness.stop", { ...turn, prompt_id: "p1", stop_hook_active: false }, "cli")).data.decision, "block");
  assert.equal((await reg.call("harness.stop", { ...turn, prompt_id: "p1", stop_hook_active: true }, "cli")).data.decision, "block");
  const forged = await reg.call("harness.stop", { ...turn, prompt_id: "p1-forged", stop_hook_active: true }, "cli");
  assert.deepEqual(forged.data, { ok: true }, "a different prompt_id in the same turn does not reset the count");
  const broken = of("lesson.broken");
  assert.equal(broken.length, 1);
  assert.deepEqual(Object.keys(broken[0].payload).sort(), ["lesson", "level", "session", "stage"]);
  assert.deepEqual(broken[0].payload, { lesson: 1, session: "s1", level: "block", stage: "stop" });
  const b = (await reg.call("harness.brief", { cwd: CWD, session: "s2" }, "cli")).data.text;
  assert.match(b, /Lesson 1 was broken 1 time this week: Never use em dashes\./);
  const next = await reg.call("harness.enrich", { prompt: "now the footer", cwd: CWD, session: "s1", prompt_id: "p2" }, "cli");
  assert.match(next.data.text, /^Vyre lessons\.\nLast turn broke this lesson/);
});

test("learn: guards ask at every level, online, even for a lesson scoped elsewhere", async t => {
  const home = tempHome(t);
  const { reg } = await learning(t, home, fakeProjects(home));
  await reg.call("learn.add", { text: "never use em dashes", level: "remind", scope: { project: "harlow-site" } }, "cli");
  const rules = (tool_name, tool_input) => reg.call("harness.rules", { tool_name, tool_input, cwd: "/w/other", session: "s1" }, "cli");
  // The floor (ADR 0004) denies Vyre's own state and the human-only vyre commands outright,
  // which is stricter than the lesson guards' ask.
  assert.equal((await rules("Write", { file_path: path.join(home, "lessons.json"), content: "{}" })).data.decision, "deny");
  assert.equal((await rules("Bash", { command: "vyre call learn.retire '{\"id\":1}'" })).data.decision, "deny");
  assert.equal((await rules("Bash", { command: "npm test" })).data.decision, null);
});

test("learn: a forged enrich mid-turn restarts nothing: the same prompt_id is a duplicate, a new one keeps the turn's edits and its no declines nothing", async t => {
  const { reg, lesson } = await learning(t);
  await reg.call("learn.add", { text: "update CHANGELOG.md whenever you change code" }, "cli");
  // A forge claims interactive too; only the turn's state stops it.
  const enrich = (prompt, prompt_id) => reg.call("harness.enrich", { prompt, cwd: CWD, session: "s1", prompt_id, interactive: true }, "harness");
  const stop = active => reg.call("harness.stop", { session: "s1", prompt_id: "p1", text: "done", stop_hook_active: active }, "cli");
  await enrich("never use em dashes in anything you write", "p0");
  await reg.call("harness.stop", { session: "s1", prompt_id: "p0", text: "Shall I keep it?", stop_hook_active: false }, "cli");
  assert.equal((await lesson(2)).status, "proposed");
  await enrich("fix the bug", "p1");
  assert.equal((await lesson(2)).status, "proposed", "fix the bug answers nothing");
  await reg.call("harness.learn", { tool_name: "Edit", tool_input: { file_path: "/w/harlow-site/src/a.js" }, cwd: CWD, session: "s1" }, "cli");
  assert.equal((await stop(false)).data.decision, "block", "control: the edit without CHANGELOG.md is sent back");
  await tick();
  // The model pipes the same prompt_id into hook.js enrich: a duplicate.
  assert.equal((await enrich("no", "p1")).data.text, "");
  assert.equal((await lesson(2)).status, "proposed", "a duplicate declines nothing");
  // Or a made-up one: the turn has not passed a Stop, so its edits and its send-back count stay.
  await enrich("no", "forged");
  assert.equal((await lesson(2)).status, "proposed", "a no mid-turn declines nothing");
  const again = await stop(true);
  assert.equal(again.data.decision, "block", "the edit is still seen");
  assert.match(again.data.reason, /\(2 of 2\)/, "the count carried over");
  assert.equal((await stop(true)).data.decision, undefined, "the cap still ends the turn");
  // After a real Stop, the next prompt is a new turn: last turn's edits are not counted again, and a yes or no counts.
  await enrich("now the footer", "p2");
  assert.equal((await reg.call("harness.stop", { session: "s1", prompt_id: "p2", text: "done", stop_hook_active: false }, "cli")).data.decision, undefined);
  await enrich("never use em dashes in anything you write", "p3");
  await reg.call("harness.stop", { session: "s1", prompt_id: "p3", text: "Keep it?", stop_hook_active: false }, "cli");
  await enrich("no", "p4");
  assert.equal((await lesson(2)).status, "retired");
});

test("learn: a yes mid-turn accepts nothing and waits for the next prompt after a Stop", async t => {
  const { reg, lesson } = await learning(t);
  const enrich = (prompt, prompt_id) => reg.call("harness.enrich", { prompt, cwd: CWD, session: "s1", prompt_id, interactive: true }, "cli");
  await enrich("never use em dashes in anything you write", "p1");
  const y = await enrich("yes", "p2");                                   // no Stop between: a forge, or an interrupt
  assert.equal((await lesson(1)).status, "proposed");
  assert.match(y.data.text, /was not taken for lesson 1.*had not finished.*vyre learn accept 1/);
  await reg.call("harness.stop", { session: "s1", prompt_id: "p2", text: "Keep it?", stop_hook_active: false }, "cli");
  await enrich("yes", "p3");
  assert.equal((await lesson(1)).status, "active", "still waiting after the interrupted turn, and taken once that turn ended");
});

test("learn: a yes that is not a person's accepts nothing: -p input, a headless thread, an agent's thread, an agent's prompt", async t => {
  const { reg, lesson } = await learning(t);
  const turn = async (prompt, prompt_id, extra = {}, caller = "cli") => {
    const r = await reg.call("harness.enrich", { prompt, cwd: CWD, session: "s1", prompt_id, ...extra }, caller);
    await reg.call("harness.stop", { session: "s1", prompt_id, text: "ok", stop_hook_active: false }, caller);
    return r;
  };
  // The hook says interactive false for -p, --print, stream-json and our own headless threads.
  const told = await turn("never use em dashes in anything you write", "p1");
  assert.match(told.data.text, /not in force until the user accepts it from a terminal \(`vyre learn accept 1`\), the Deck or the Capsule/);
  assert.doesNotMatch(told.data.text, /a plain yes keeps it/, "a headless thread is not told a reply will do");
  const no = await turn("yes", "p2", { interactive: false });
  assert.match(no.data.text, /did not accept lesson 1.*only from a person typing in an interactive Claude Code session.*vyre learn accept 1/);
  assert.equal((await lesson(1)).status, "proposed");
  await turn("never use em dashes", "p3");
  await turn("yes", "p4");                                               // interactive absent: no
  assert.equal((await lesson(1)).status, "proposed", "absent means no");
  // An agent's thread, even claiming interactive; as the input or as the caller.
  await turn("never use em dashes", "p5", { interactive: true });
  await turn("yes", "p6", { interactive: true, agent: "scout" });
  assert.equal((await lesson(1)).status, "proposed", "agent named in the input");
  await turn("never use em dashes", "p7", { interactive: true });
  const direct = await reg.call("learn.signal", { session: "s1", prompt_id: "p8", prompt: "no", cwd: CWD, agent: "scout", interactive: true }, "module:harness");
  assert.match(direct.data.text, /did not decline lesson 1/);
  assert.equal((await lesson(1)).status, "proposed", "an agent's no declines nothing either");
  await reg.call("harness.stop", { session: "s1", prompt_id: "p8", text: "ok", stop_hook_active: false }, "cli");
  // A person, in the turn right after: accepted.
  await turn("never use em dashes", "p9", { interactive: true });
  await turn("yes", "p10", { interactive: true });
  assert.equal((await lesson(1)).status, "active");
});

test("learn: guards hold online with no lesson active; the lesson files wait for one", async t => {
  const { reg, home } = await learning(t);
  const rules = (tool_name, tool_input, extra = {}) => reg.call("harness.rules", { tool_name, tool_input, cwd: "/w/other", session: "s1", ...extra }, "cli");
  // Vyre's own state is the floor's (ADR 0004): denied outright, stricter than an ask.
  assert.equal((await rules("Bash", { command: `rm ${home}/vyre.db` })).data.decision, "deny");
  assert.equal((await rules("Write", { file_path: path.join(home, "learned", "skills", "x", "SKILL.md"), content: "x" })).data.decision, "deny");
  assert.equal((await rules("Bash", { command: "echo '{}' | node /p/harness/hooks/hook.js enrich" }, { plugin_root: "/p/harness" })).data.decision, "ask");
  assert.equal((await rules("Edit", { file_path: "/p/harness/hooks/hooks.json" }, { plugin_root: "/p/harness" })).data.decision, "ask");
  assert.equal((await rules("Edit", { file_path: "/p/harness/hooks/hooks.json" })).data.decision, null, "a checkout that is not the loaded plugin");
  assert.equal((await rules("Bash", { command: "claude plugin disable vyre" })).data.decision, "ask");
  assert.equal((await rules("Bash", { command: `rm ${home}/lessons.json` })).data.decision, "deny", "no lesson guards it, but the floor guards Vyre's home");
  assert.equal((await rules("Bash", { command: "npm test" })).data.decision, null);
});

test("weakens: every route to switching lessons off is asked; ordinary work is not", () => {
  const home = "/Users/someone/.vyre";
  const w = (tool, input) => weakens(tool, input, { home, cwd: input.cwd || "/w/site", pluginRoot: "/repo/vyre/harness" });
  const asked = [
    ["Write", { file_path: `${home}/lessons.json`, content: "{}" }],
    ["Edit", { file_path: `${home}/learn-offline/s1.json` }],
    ["Write", { file_path: `${home}/learned/skills/x/SKILL.md` }],
    ["Write", { file_path: `${home}/vyre.db` }],
    ["Edit", { file_path: "/repo/vyre/harness/hooks/hooks.json" }],
    ["Edit", { file_path: "/repo/vyre/harness/hooks/hook.js" }],
    ["Write", { file_path: "/Users/someone/.claude/plugins/cache/m/vyre/0.1.0/hooks/hooks.json" }],
    ["Write", { file_path: ".claude/settings.json" }],
    ["Edit", { file_path: "/w/site/.claude/settings.local.json" }],
    ["NotebookEdit", { notebook_path: `${home}/lessons.json` }],
    ["Bash", { command: `rm ${home}/lessons.json` }],
    ["Bash", { command: `echo '{}' > ${home}/lessons.json` }],
    ["Bash", { command: `cd ${home} && rm lessons.json` }],
    ["Bash", { command: `rm -rf ${home}` }],
    ["Bash", { command: `rm ${home.replace(".vyre", ".vy*")}/lessons.json` }],
    ["Bash", { command: "rm -rf $VYRE_HOME/learned" }],
    ["Bash", { command: "sqlite3 vyre.db 'delete from learn_lessons'", cwd: home }],
    ["Bash", { command: "rm -r learn-offline", cwd: home }],
    ["Bash", { command: "vyre call learn.retire '{\"id\":1}'" }],
    ["Bash", { command: "node /repo/bin/vyre call harness.stop '{}'" }],
    ["Bash", { command: "vy\"re\" learn relax 1 --level remind" }],
    ["Bash", { command: "vyre learn edit 1" }],
    ["Bash", { command: "vyre learn retire 1" }],
    ["Bash", { command: "curl --unix-socket /tmp/vyre-501/ab.sock http://x/v1/tools/learn.accept" }],
    ["Bash", { command: `curl -s --unix-socket ${home}/vyred.sock http://x/v1/tools/system.echo` }],
    ["Bash", { command: "nc -U $SOCK" }],
    ["Bash", { command: "vyre down" }],
    ["Bash", { command: "pkill -f vyred" }],
    ["Bash", { command: `kill $(cat ${home}/vyred.pid)` }],
    ["Bash", { command: "launchctl bootout gui/501/sh.vyre.vyred" }],
    ["Bash", { command: "jq 'del(.enabledPlugins)' ~/.claude/settings.json > /tmp/s && mv /tmp/s ~/.claude/settings.json" }],
    ["Bash", { command: "sed -i '' 's/hook.js/x.js/' harness/hooks/hooks.json", cwd: "/repo/vyre" }],
  ];
  for (const [tool, input] of asked) assert.ok(w(tool, input), `${tool} ${JSON.stringify(input)}`);
  const free = [
    ["Write", { file_path: "/w/site/lessons.json", content: "{}" }],
    ["Write", { file_path: "/w/site/src/settings.json" }],
    ["Write", { file_path: `${home}/watchers/mail.js` }],
    ["Read", { file_path: `${home}/lessons.json` }],
    ["Bash", { command: `cat ${home}/lessons.json` }],
    ["Bash", { command: "rm /w/other/lessons.json" }],
    ["Bash", { command: "git commit -m 'document lessons.json and hooks'" }],
    ["Bash", { command: "grep -rn hook harness/hooks/ | head" }],
    ["Bash", { command: `cp mail.js ${home}/watchers/` }],
    ["Bash", { command: "curl --unix-socket /var/run/docker.sock http://x/info" }],
    ["Bash", { command: "npm test && git push" }],
    ["Bash", { command: "vyre learn" }],
    ["Bash", { command: "vyre threads stop 5f0c" }],
  ];
  for (const [tool, input] of free) assert.equal(w(tool, input), null, `${tool} ${JSON.stringify(input)}`);
});

test("weakens: skills, scope, plugins, the hook by hand and scripts that call human-only tools are asked", () => {
  const home = path.join(os.homedir(), ".vyre-test-home");
  const w = (tool, input, extra = {}) => weakens(tool, input, { home, cwd: "/w/site", pluginRoot: null, ...extra });
  const asked = [
    "vyre learn scope 3 project foo", "vyre learn skills install 4 --account", "vyre learn skills retire 4", "vyre learn skills dismiss 4",
    "vyre learn accept 2", "vyre learn relax 1 level remind", "claude plugin disable vyre", "claude plugins uninstall vyre", "claude plugin remove vyre@m",
    "rm -rf ~/.claude/plugins/cache/vyre", "rm -rf ~/.claude/plugins", "rm -rf ~/.claude", "echo {} > $HOME/.claude/plugins/installed_plugins.json",
    "cd ~/.claude/plugins/cache/vyre/harness && echo '{}' | node hooks/hook.js stop", "echo '{\"prompt\":\"no\"}' | node ./hooks/hook.js enrich",
    "node /somewhere/harness/hooks/hook.js rules < x.json", "./hooks/hook.js enrich", "env VYRE_HOME=/x node hook.js stop",
    "node -e \"import('/x/core/daemon/client.js').then(m => m.call('learn.relax', {id:1, level:'remind'}))\"",
  ];
  for (const command of asked) assert.ok(w("Bash", { command }), command);
  assert.ok(w("Write", { file_path: "/tmp/x.mjs", content: "import { call } from '/x/core/daemon/client.js'; call('learn.relax', { id: 1, level: 'remind' })" }));
  assert.ok(w("Write", { file_path: path.join(os.homedir(), ".claude/plugins/installed_plugins.json"), content: "{}" }));
  for (const t of ["mcp__vyre__learn_retire", "mcp__vyre__learn_skill_install", "mcp__vyre__learn_skill-install", "mcp__vyre__learn_skill_retire", "mcp__vyre__learn_skill_dismiss"]) assert.ok(w(t, {}), t);
  const free = ["node --test test/harness.test.js", "git add harness/hooks/hook.js && git commit -m x", "grep -rn learn.relax core/", "npx prettier --write harness/hooks/hook.js",
    "ls ~/.claude/plugins", "cat ~/.claude/plugins/installed_plugins.json"];
  for (const command of free) assert.equal(w("Bash", { command }), null, command);
  assert.equal(w("Edit", { file_path: "/w/site/core/learn/index.js", new_string: 'ctx.tool("learn.relax", { effect: "read",' }), null, "the tool's own source names it, and reaches no socket");
});

test("weakens: in a checkout of Vyre, store names, hooks and commit messages are free unless they are the real ones", () => {
  const home = path.join(os.homedir(), ".vyre");
  const repo = "/Users/someone/src/vyre";
  const w = (tool, input, extra = {}) => weakens(tool, input, { home, cwd: repo, pluginRoot: null, ...extra });
  assert.equal(w("Bash", { command: "git commit -m 'fix: vyre.db lock'" }), null);
  assert.equal(w("Bash", { command: 'git commit -am "stop rm -rf ~/.vyre/vyre.db in tests"' }), null);
  assert.equal(w("Bash", { command: "git commit --message='touch lessons.json'" }), null);
  assert.equal(w("Bash", { command: "rm -rf /tmp/t1/vyre.db" }), null);
  assert.equal(w("Bash", { command: "rm -rf lessons.json learn-offline vyre.db" }), null, "bare names outside the home");
  assert.ok(w("Bash", { command: "rm -rf lessons.json vyre.db" }, { cwd: home }), "bare names with cwd in the home");
  assert.ok(w("Bash", { command: "git commit -m x && rm ~/.vyre/vyre.db" }), "only the message is prose");
  assert.equal(w("Edit", { file_path: "./harness/hooks/hook.js" }), null);
  assert.equal(w("Edit", { file_path: `${repo}/harness/hooks/hooks.json` }), null);
  assert.equal(w("Bash", { command: "sed -i '' s/a/b/ harness/hooks/hook.js" }), null);
  // The same checkout, loaded as the plugin (claude --plugin-dir): its hooks are the real ones.
  assert.ok(w("Edit", { file_path: "./harness/hooks/hook.js" }, { pluginRoot: `${repo}/harness` }));
  assert.ok(w("Bash", { command: "sed -i '' s/a/b/ harness/hooks/hook.js" }, { pluginRoot: `${repo}/harness` }));
});

test("weakens: with no lesson active, the store, learned/, hooks, plugins and human-only tools stay guarded; lesson files and stopping vyred do not", () => {
  const home = "/Users/someone/.vyre";
  const w = (tool, input) => weakens(tool, input, { home, cwd: "/w/site", pluginRoot: "/p/harness", lessons: false });
  for (const [tool, input] of [
    ["Write", { file_path: `${home}/learned/skills/x/SKILL.md` }], ["Bash", { command: `rm ${home}/vyre.db` }], ["Edit", { file_path: "/p/harness/hooks/hooks.json" }],
    ["Bash", { command: "vyre learn skills install 1" }], ["Bash", { command: "claude plugin disable vyre" }], ["Bash", { command: "vyre call learn.retire '{}'" }],
    ["Bash", { command: "node /p/harness/hooks/hook.js enrich" }], ["mcp__vyre__learn_relax", {}],
  ]) assert.ok(w(tool, input), `${tool} ${JSON.stringify(input)}`);
  for (const [tool, input] of [["Write", { file_path: `${home}/lessons.json` }], ["Bash", { command: "vyre down" }], ["Bash", { command: "vyre learn retire 1" }]]) {
    assert.equal(w(tool, input), null, `${tool} ${JSON.stringify(input)}`);
  }
});

test("learn: a snapshot changed or removed while vyred was down is recorded as tampered and rewritten", async t => {
  const first = await learning(t);
  await first.add("never use em dashes");
  const file = path.join(first.home, "lessons.json");
  const good = fs.readFileSync(file, "utf8");
  await first.reg.stop();
  fs.writeFileSync(file, JSON.stringify({ version: 2, lessons: [] }));
  const second = await learning(t, first.home);
  assert.equal(second.of("lesson.tampered").length, 1);
  assert.deepEqual(second.of("lesson.tampered")[0].payload, {});
  const sig = second.db.prepare("SELECT kind, text, session, lesson FROM learn_signals WHERE kind = 'tampered'").all();
  assert.deepEqual(sig.map(r => ({ ...r })), [{ kind: "tampered", text: null, session: null, lesson: null }], "no content kept");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).lessons, JSON.parse(good).lessons, "rewritten");
  await second.reg.stop();
  fs.rmSync(file);
  const third = await learning(t, first.home);
  assert.equal(third.of("lesson.tampered").length, 2, "removed counts too");
  await third.reg.stop();
  const fourth = await learning(t, first.home);
  assert.equal(fourth.of("lesson.tampered").length, 2, "an untouched file is not tampered");
});

test("learn: the snapshot carries each project lesson's slug and folders", async t => {
  const home = tempHome(t);
  const { reg } = await learning(t, home, fakeProjects(home));
  await reg.call("learn.add", { text: "never use em dashes", scope: { project: "harlow-site" } }, "cli");
  const s = JSON.parse(fs.readFileSync(path.join(home, "lessons.json"), "utf8"));
  assert.equal(s.version, 2);
  assert.deepEqual([s.lessons[0].project, s.lessons[0].folders], ["harlow-site", ["/w/harlow-site"]]);
});
