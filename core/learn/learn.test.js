// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { distill, atStop, atTool, weakens, invalid, CODE } from "./checks.js";
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
  for (const t of ["mcp__plugin_vyre_vyre__learn_retire", "mcp__vyre__learn_edit", "learn_retire"]) assert.ok(weakens(t, {}), t);
  for (const command of ["vyre learn retire 1", "sqlite3 ~/.vyre/vyre.db 'delete from learn_lessons'", "vyre down", "pkill vyred",
    "curl --unix-socket ~/.vyre/vyred.sock http://x/v1/tools/learn.retire"]) assert.ok(weakens("Bash", { command }), command);
  for (const command of ["npm test", "vyre learn", "git commit -m x"]) assert.equal(weakens("Bash", { command }), null, command);
  assert.equal(weakens("mcp__vyre__learn_lessons", {}), null);
  assert.equal(weakens("Read", { file_path: "vyre.db" }), null);
});

// The module, run through a Registry with the real Harness, as the hooks reach it.

async function learning(t, home = tempHome(t)) {
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => ["harness", "learn"].includes(f.manifest?.name));
  await reg.start(core, { role: "local" });
  t.after(() => db.close());
  const lesson = async id => (await reg.call("learn.lessons", { status: "all" })).data.find(l => l.id === id);
  const add = async text => (await reg.call("learn.add", { text })).data;
  const of = type => events.since(0, { limit: 1000 }).filter(e => e.type === type);
  return { reg, db, events, lesson, add, of, home };
}

const tick = () => new Promise(r => setTimeout(r, 5));
const CWD = "/w/harlow-site";

test("learn: a correction is proposed, Claude is told to ask, and nothing is enforced until it is accepted", async t => {
  const { reg, lesson } = await learning(t);
  const e = await reg.call("harness.enrich", { prompt: "never use em dashes in anything you write", cwd: CWD, session: "s1", prompt_id: "p1" });
  assert.match(e.data.text, /drafted it as lesson 1, not yet in force/);
  assert.match(e.data.text, /ask whether to keep it/);
  assert.match(e.data.text, /learn_accept/);
  assert.equal((await lesson(1)).status, "proposed");
  const s = await reg.call("harness.stop", { session: "s1", prompt_id: "p1", text: `Sure ${DASH} done`, stop_hook_active: false });
  assert.deepEqual(s.data, { ok: true }, "a proposal holds nothing");
  const again = await reg.call("harness.enrich", { prompt: "never use em dashes", cwd: CWD, session: "s1", prompt_id: "p2" });
  assert.match(again.data.text, /still waiting for the user's yes/);
  assert.equal((await reg.call("learn.lessons", {})).data.length, 1, "the same correction is not proposed twice");
  assert.equal((await reg.call("learn.accept", { id: 1 })).data.status, "active");
});

test("learn: a broken reply is sent back twice, then ends broken, and the next prompt hears about it", async t => {
  const { reg, lesson, of } = await learning(t);
  await reg.call("harness.enrich", { prompt: "never use em dashes in anything you write", cwd: CWD, session: "s1", prompt_id: "p1" });
  await reg.call("learn.accept", { id: 1 });
  await reg.call("harness.enrich", { prompt: "write the intro for Dana", cwd: CWD, session: "s1", prompt_id: "p2" });
  const turn = { session: "s1", prompt_id: "p2", cwd: CWD, text: `Here is the intro ${DASH} short` };
  const b1 = await reg.call("harness.stop", { ...turn, stop_hook_active: false });
  assert.equal(b1.data.decision, "block");
  assert.match(b1.data.reason, /Lesson 1: Never use em dashes\./);
  const b2 = await reg.call("harness.stop", { ...turn, stop_hook_active: true });
  assert.equal(b2.data.decision, "block", "still broken, sent back again");
  const end = await reg.call("harness.stop", { ...turn, stop_hook_active: true });
  assert.deepEqual(end.data, { ok: true }, "the third try ends the turn");
  const l = await lesson(1);
  assert.equal(l.broken, 1);
  assert.equal(l.caught, 2);
  assert.equal(of("lesson.broken").length, 1);
  assert.equal(of("lesson.broken")[0].payload.lesson, 1);
  const next = await reg.call("harness.enrich", { prompt: "now the footer", cwd: CWD, session: "s1", prompt_id: "p3" });
  assert.match(next.data.text, /Last turn broke this lesson/);
  assert.match(next.data.text, /- Never use em dashes\./);
  const after = await reg.call("harness.enrich", { prompt: "and the header", cwd: CWD, session: "s1", prompt_id: "p4" });
  assert.doesNotMatch(after.data.text, /Last turn broke/, "only the turn after hears it");
});

test("learn: a reply fixed after a block ends clean, counted as caught", async t => {
  const { reg, lesson, of } = await learning(t);
  await reg.call("learn.add", { text: "never use em dashes" });
  await reg.call("harness.enrich", { prompt: "write the intro", cwd: CWD, session: "s1", prompt_id: "p1" });
  const b = await reg.call("harness.stop", { session: "s1", prompt_id: "p1", text: `a ${DASH} b`, stop_hook_active: false });
  assert.equal(b.data.decision, "block");
  const ok = await reg.call("harness.stop", { session: "s1", prompt_id: "p1", text: "a, b", stop_hook_active: true });
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
  const edit = file => reg.call("harness.learn", { tool_name: "Edit", tool_input: { file_path: file }, cwd: CWD, session: "s1" });
  await edit("src/old.js");
  await tick();
  await reg.call("harness.enrich", { prompt: "fix the intake form", cwd: CWD, session: "s1", prompt_id: "p1" });
  assert.deepEqual((await reg.call("harness.stop", { session: "s1", prompt_id: "p1", stop_hook_active: false })).data, { ok: true }, "src/old.js was before this turn");
  await tick();
  await reg.call("harness.enrich", { prompt: "and the thank-you page", cwd: CWD, session: "s1", prompt_id: "p2" });
  await edit("src/intake.js");
  const b = await reg.call("harness.stop", { session: "s1", prompt_id: "p2", stop_hook_active: false });
  assert.equal(b.data.decision, "block");
  assert.match(b.data.reason, /src\/intake\.js but not CHANGELOG\.md/);
  assert.doesNotMatch(b.data.reason, /old\.js/);
  await edit("CHANGELOG.md");
  assert.deepEqual((await reg.call("harness.stop", { session: "s1", prompt_id: "p2", stop_hook_active: true })).data, { ok: true });
});

test("learn: a Write with a banned character is denied before it runs, with the lesson quoted", async t => {
  const { reg, add, of } = await learning(t);
  await add("never use em dashes");
  const r = await reg.call("harness.rules", { tool_name: "Write", tool_input: { file_path: "a.md", content: `Harlow ${DASH} Legal` }, cwd: CWD, session: "s1" });
  assert.equal(r.data.decision, "deny");
  assert.match(r.data.reason, /Vyre lesson 1, which the user taught: Never use em dashes\./);
  assert.equal(r.data.lesson, 1);
  const held = of("tool.held");
  assert.equal(held.length, 1);
  assert.equal(held[0].payload.lesson, 1);
  assert.equal((await reg.call("harness.rules", { tool_name: "Write", tool_input: { file_path: "a.md", content: "Harlow Legal" }, cwd: CWD, session: "s1" })).data.decision, null);
});

test("learn: git commit is held until the tests have run", async t => {
  const { reg, add } = await learning(t);
  assert.equal((await add("always run the tests before you commit")).check.kind, "before");
  const bash = command => reg.call("harness.rules", { tool_name: "Bash", tool_input: { command }, cwd: CWD, session: "s1" });
  const held = await bash("git commit -m x");
  assert.equal(held.data.decision, "deny");
  assert.match(held.data.reason, /Run the tests before every git commit/);
  assert.equal((await bash("npm test")).data.decision, null);
  assert.equal((await bash("git commit -m x")).data.decision, null);
});

test("learn: retiring a lesson from inside a turn asks the user, but only when there are lessons", async t => {
  const { reg, add } = await learning(t);
  const retire = () => reg.call("harness.rules", { tool_name: "mcp__plugin_vyre_vyre__learn_retire", tool_input: { id: 1 }, session: "s1" });
  assert.equal((await retire()).data.decision, null);
  await add("never use em dashes");
  const r = await retire();
  assert.equal(r.data.decision, "ask");
  assert.match(r.data.reason, /the user's call/);
});

test("learn: a remind lesson never holds a turn, and broken twice it moves up to ask", async t => {
  const { reg, lesson, of } = await learning(t);
  await reg.call("learn.add", { text: "never use em dashes", level: "remind" });
  for (const p of ["p1", "p2"]) {
    await reg.call("harness.enrich", { prompt: "write it", cwd: CWD, session: "s1", prompt_id: p });
    assert.deepEqual((await reg.call("harness.stop", { session: "s1", prompt_id: p, text: `a ${DASH} b`, stop_hook_active: false })).data, { ok: true });
  }
  const l = await lesson(1);
  assert.equal(l.broken, 2);
  assert.equal(l.level, "ask");
  assert.deepEqual(of("lesson.escalated").map(e => [e.payload.from, e.payload.to]), [["remind", "ask"]]);
  await reg.call("harness.enrich", { prompt: "again", cwd: CWD, session: "s1", prompt_id: "p3" });
  assert.equal((await reg.call("harness.stop", { session: "s1", prompt_id: "p3", text: `a ${DASH} b`, stop_hook_active: false })).data.decision, "block", "at ask it sends the reply back");
});

test("learn: two different free-text rules are two proposals", async t => {
  const { reg } = await learning(t);
  await reg.call("harness.enrich", { prompt: "from now on sign emails as Harlow Legal", session: "s1", prompt_id: "p1" });
  const e = await reg.call("harness.enrich", { prompt: "always cc Dana Reyes on client emails", session: "s1", prompt_id: "p2" });
  assert.match(e.data.text, /drafted it as lesson 2, not yet in force/);
  assert.equal((await reg.call("learn.lessons", {})).data.length, 2);
});

test("learn: brief lists every active lesson, marking the checked ones", async t => {
  const { reg, add } = await learning(t);
  assert.equal((await reg.call("harness.brief", { cwd: CWD, session: "s1" })).data.text, "");
  await add("never use em dashes");
  await add("from now on sign emails as Harlow Legal");
  const b = (await reg.call("harness.brief", { cwd: CWD, session: "s1" })).data.text;
  assert.match(b, /- Never use em dashes\. \(checked\)/);
  assert.match(b, /- From now on sign emails as Harlow Legal\.$/m);
});

// The snapshot the hooks use when vyred is down (offline.js), and what they logged meanwhile.

const snapshot = home => JSON.parse(fs.readFileSync(path.join(home, "lessons.json"), "utf8")).lessons;

test("learn: add, retire and escalation rewrite the offline snapshot", async t => {
  const { reg, add, home } = await learning(t);
  assert.deepEqual(snapshot(home), [], "written at start");
  await add("never use em dashes");
  await reg.call("learn.add", { text: "never use en dashes", level: "remind" });
  assert.deepEqual(snapshot(home).map(l => [l.id, l.level]), [[1, "block"], [2, "remind"]]);
  assert.equal(fs.statSync(path.join(home, "lessons.json")).mode & 0o777, 0o600);
  await reg.call("learn.retire", { id: 1 });
  assert.deepEqual(snapshot(home).map(l => l.id), [2]);
  for (const p of ["p1", "p2"]) {
    await reg.call("harness.enrich", { prompt: "write it", cwd: CWD, session: "s1", prompt_id: p });
    await reg.call("harness.stop", { session: "s1", prompt_id: p, text: "a \u2013 b", stop_hook_active: false });
  }
  assert.deepEqual(snapshot(home).map(l => [l.id, l.level]), [[2, "ask"]], "escalated in the snapshot too");
});

test("learn: what the hooks logged while vyred was down is counted at start, escalation included", async t => {
  const first = await learning(t);
  await first.add("never use em dashes");
  await first.reg.call("learn.add", { text: "never use en dashes", level: "remind" });
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
    ctx.tool("gate.get", { run: async ({ id }) => drafts[id] });
    ctx.tool("gate.fire", { run: async ({ id }) => { ctx.events.emit("gate.released", { id, kind: "mail", via: "mail", to: "dana@harlowlegal.com", edited: true, agent: null, thread: "s1", project: null }); return {}; } });
    return {};
  } };`;
  writeModule(path.join(home, "mods"), "gate", { does: { tools: ["gate.get", "gate.fire"] }, watches: { emits: ["gate.released"] } }, gate);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => ["harness", "learn"].includes(f.manifest?.name));
  await reg.start([...core, ...discover([path.join(home, "mods")])], { role: "local" });
  t.after(() => db.close());

  await reg.call("gate.fire", { id: 8 });
  await reg.call("gate.fire", { id: 7 });
  await new Promise(r => setTimeout(r, 20));
  const lessons = (await reg.call("learn.lessons", { status: "all" })).data;
  assert.equal(lessons.length, 1, "only the character taken out everywhere becomes a lesson");
  assert.deepEqual([lessons[0].status, lessons[0].level, lessons[0].check.pattern, lessons[0].source.kind], ["proposed", "remind", "—", "edited"]);
  const kept = db.prepare("SELECT text FROM learn_signals WHERE kind = 'edited'").all().map(r => r.text);
  assert.equal(kept.length, 2);
  assert.ok(kept.every(x => !/Dana|brief/.test(x)), "the message itself is never kept");

  const first = await reg.call("harness.enrich", { prompt: "what next?", cwd: "/w/harlow-site", session: "s1" });
  assert.match(first.data.text, /edited a draft.*lesson 1/);
  const again = await reg.call("harness.enrich", { prompt: "and then?", cwd: "/w/harlow-site", session: "s1" });
  assert.doesNotMatch(again.data.text, /edited a draft/, "told once");
  await reg.call("gate.fire", { id: 7 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await reg.call("learn.lessons", { status: "all" })).data.length, 1, "the same edit again proposes nothing new");
});
