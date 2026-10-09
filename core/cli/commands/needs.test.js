// @ts-check
// `vyre needs`, `vyre gate` and `vyre threads answer` against a real vyred in a temp home: the
// real Gate holding a draft a model asked for, the real switchboard running the fake Claude
// (core/switchboard/testing/fake-claude.js) until it raises a question and permission asks, and the
// real presence verifier with Touch ID off. The CLI runs as a child with pipes and no terminal,
// as a script would; the one approve that needs a person runs in-process with a fake terminal
// that types back the code vyred wrote.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { Presence } from "../../presence/index.js";
import { call } from "../../daemon/client.js";
import { tempHome } from "../../../test/helpers.js";
import { SCRATCH } from "../../../test/scratch.mjs";
import { merge, nextFor } from "./needs.js";
import { gate, bodyKey } from "./gate.js";
import { answerFor, answersFrom, pickAnswers } from "./threads.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "..", "..", "bin", "vyre");
const FAKE = path.join(HERE, "..", "..", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);

const PALETTE = { question: "Which palette should the Northwind Bakery menu use?", header: "Palette", multiSelect: false,
  options: [{ label: "Warm crust" }, { label: "Fresh mint" }, { label: "Plain" }] };
const SECTIONS = { question: "Which sections go on the first page?", header: "Sections", multiSelect: true,
  options: [{ label: "Breads" }, { label: "Pastries" }, { label: "Specials" }, { label: "Opening hours" }] };

// ------------------------------------------------------------ pure parts

test("needs: drafts and asks become one list, newest first, each with the command that answers it", () => {
  const now = 10_000_000;
  const rows = merge({
    held: [{ id: "d1d1d1d1d1d1d1d1d1", kind: "send", via: "mail", to: ["kit@northwind.example"], summary: "Opening hours", agent: "juno", thread: "t1", project: null, at: now - 7_200_000 }],
    asks: [
      { id: "a1a1a1a1a1a1a1a1a1", kind: "permission", tool: "Bash", summary: "npm test", destination: null, thread: "t2", thread_name: "Menu", agent: null, at: now - 60_000 },
      { id: "q1q1q1q1q1q1q1q1q1", kind: "question", questions: [PALETTE, SECTIONS], summary: "", thread: "t2", thread_name: "Menu", agent: null, at: now - 600_000 },
    ],
    threads: [{ id: "t1", name: "Harlow Legal intake", project: "harlow" }],
  }, now);
  assert.deepEqual(rows.map(r => r.kind), ["permission", "question", "draft"]);
  assert.deepEqual(rows.map(r => r.age), ["1m", "10m", "2h"]);
  assert.equal(rows[2].source, "juno · Harlow Legal intake · harlow");
  assert.equal(rows[2].summary, "send via mail to kit@northwind.example: Opening hours");
  assert.equal(rows[1].summary, `${PALETTE.question} (+1 more)`);
  assert.equal(rows[0].next, "vyre threads answer a1a1a1a1 allow|deny");
  assert.equal(rows[1].next, "vyre threads answer q1q1q1q1");
  assert.equal(rows[2].next, "vyre gate show d1d1d1d1 · vyre gate approve d1d1d1d1");
  assert.equal(nextFor({ kind: "draft", id: "abc" }), "vyre gate show abc · vyre gate approve abc");
});

test("answers: numbers, labels and own words, single and multi-select, as the Deck's card builds them", () => {
  assert.equal(answerFor(PALETTE, "2"), "Fresh mint");
  assert.equal(answerFor(PALETTE, "warm crust"), "Warm crust");
  assert.equal(answerFor(PALETTE, "Something darker"), "Something darker", "words that match no option are the Other answer");
  assert.throws(() => answerFor(PALETTE, "4"), /options 1 to 3/);
  assert.throws(() => answerFor(PALETTE, "1,2"), /takes one answer/);
  assert.equal(answerFor(SECTIONS, "3,1"), "Breads, Specials", "option order, not typed order");
  assert.equal(answerFor(SECTIONS, "1, Gift boxes, pastries"), "Breads, Pastries, Gift boxes", "typed words last");

  assert.deepEqual(answersFrom([PALETTE, SECTIONS], { pick: ["1", "1,3"] }),
    { answers: { [PALETTE.question]: "Warm crust", [SECTIONS.question]: "Breads, Specials" }, missing: [] });
  const byKey = answersFrom([PALETTE, SECTIONS], { answer: ["Sections=Pastries", "palette=3"] });
  assert.deepEqual(byKey.answers, { [PALETTE.question]: "Plain", [SECTIONS.question]: "Pastries" });
  assert.deepEqual(answersFrom([PALETTE, SECTIONS], { answer: ["2=4"] }).missing, [PALETTE]);
  assert.deepEqual(answersFrom([PALETTE], { answer: ["Warm crust"] }).answers, { [PALETTE.question]: "Warm crust" }, "one question needs no Q=");
  assert.throws(() => answersFrom([PALETTE, SECTIONS], { pick: ["Warm"] }), /option numbers/);
  assert.throws(() => answersFrom([PALETTE, SECTIONS], { answer: ["Colour=1"] }), /no question matches/);
  assert.throws(() => answersFrom([PALETTE, SECTIONS], { answer: ["Warm crust"] }), /question=answer/);
});

test("answers: the picker asks each missing question until it has an answer", async () => {
  const typed = ["9", "1", "2,4"];
  const asked = [];
  const got = await pickAnswers([PALETTE, SECTIONS], {}, async text => { asked.push(text); return typed.shift() || ""; });
  assert.deepEqual(got, { [PALETTE.question]: "Warm crust", [SECTIONS.question]: "Pastries, Opening hours" });
  assert.equal(asked.length, 3, "a bad pick asks again");
});

test("gate: the words a person edits are body, else text, else the longest string", () => {
  assert.equal(bodyKey({ subject: "Hi", body: "x" }), "body");
  assert.equal(bodyKey({ summary: "Weekly update", text: "Ovens are in." }), "text");
  assert.equal(bodyKey({ method: "POST", url: "https://example.com/a/long/path" }), "url");
});

// ------------------------------------------------------------ against a real vyred

/** The CLI as a script runs it: pipes, no controlling terminal. */
function vyre(args, env = {}, input = "") {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env, NO_COLOR: "1" }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", stdout = "";
    p.stdout.on("data", c => { out += c; stdout += c; }); p.stderr.on("data", c => (out += c));
    p.on("close", code => resolve({ code, out, stdout }));
    p.stdin.end(input);
  });
}

async function until(fn, what, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise(r => setTimeout(r, 50));
  }
}

/** A vyred with a held draft, a question ask and two permission asks (one offering always). */
async function world(t) {
  const root = tempHome(t);
  const was = process.env.VYRE_CLAUDE_BIN;
  process.env.VYRE_CLAUDE_BIN = FAKE;
  t.after(() => { if (was === undefined) delete process.env.VYRE_CLAUDE_BIN; else process.env.VYRE_CLAUDE_BIN = was; });
  const transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts);
  // A Gate sender with no credential in the vault: approving reaches the sender, which fails, so
  // nothing can leave the test.
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", transcripts: [transcripts], vault: { keystore: "file" },
    gate: { senders: { mail: { type: "gmail", vault: "no-such-item", from: "alex@example.com" } } } }));
  const screen = [];
  const d = await start({ root, log: () => {}, person: async () => null, presence: deps => new Presence({ ...deps,
    touchid: { available: async () => false, authenticate: async () => ({ ok: false, reason: "unavailable" }) },
    who: async () => ["ttys007"], statTty: () => ({ uid: process.getuid?.() ?? 0, isCharacterDevice: () => true }),
    writeTty: (file, text) => screen.push({ file, text }) }) });
  t.after(() => d.stop());
  const tool = (name, input, caller = "cli") => call(name, input, { root, caller, timeout: 20_000 });
  // The work folder is outside the home: the floor treats everything in VYRE_HOME as Vyre's own.
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // On macOS Claude's sign-in lives in the Keychain, so a sandboxed session needs the setup token from the vault (lib/agent-sandbox.js: sandbox_credential). A made-up one is enough: the fake Claude never uses it.
  const tok = await d.registry.call("vault.put", { name: "claude-setup-token", kind: "secret", value: "sk-ant-oat01-" + "x".repeat(48) }, "module:onboard"); // as core/onboard makes it
  assert.ok(!tok.error, JSON.stringify(tok.error));
  const held = await tool("gate.request", { kind: "send", via: "mail", to: "kit@northwind.example",
    content: { subject: "Opening hours", body: "The shop opens at 7 from Monday." } }, "mcp");
  assert.equal(held.data.state, "held", JSON.stringify(held));
  for (const prompt of ["ask", "bash npm test", "write menu.md"]) {
    const started = await tool("threads.start", { cwd: work, prompt, surface: "deck" });
    assert.ok(started.data, `${prompt}: ${JSON.stringify(started.error || started)}`);
  }
  const asks = await until(async () => { const r = (await tool("threads.asks", {})).data || []; return r.length === 3 ? r : null; }, "three asks");
  return { root, screen, work, tool, draft: held.data.id,
    question: asks.find(a => a.kind === "question"), bash: asks.find(a => a.tool === "Bash"), write: asks.find(a => a.tool === "Write") };
}

/** A terminal that reads the code vyred wrote to the login terminal and types it back. */
const terminal = screen => ({
  openTty: () => 99, ttyName: () => "/dev/ttys007", print() {}, close() {},
  prompt: async () => /type this code[^:]*: ([A-Z0-9]+)/i.exec(screen.at(-1)?.text || "")?.[1] || "",
});

test("needs and gate: list, show, revise (flags and $EDITOR), approve needs a person, reject", async t => {
  const w = await world(t);
  const env = { VYRE_HOME: w.root };
  const s = w.draft.slice(0, 8);

  const nj = await vyre(["needs", "--json"], env);
  assert.equal(nj.code, 0, nj.out);
  const rows = JSON.parse(nj.stdout);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(r => r.kind).sort(), ["draft", "permission", "permission", "question"]);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].at >= r.at), "newest first");
  assert.equal(rows.find(r => r.kind === "draft").next, `vyre gate show ${s} · vyre gate approve ${s}`);
  const human = await vyre(["needs"], env);
  assert.equal(human.code, 0, human.out);
  assert.match(human.out, /4 waiting on you/);
  assert.match(human.out, new RegExp(`${s}\\s+draft`));
  assert.match(human.out, /send via mail to kit@northwind\.example: Opening hours/);
  assert.match(human.out, new RegExp(`vyre threads answer ${w.question.id.slice(0, 8)}\\b`));
  // --view: one table, each row ending with the command that answers it, then done.
  const nv = (await vyre(["needs", "--view"], env)).stdout.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual([nv[0].cmd, nv[0].view.kind, nv[0].view.title], ["needs", "table", "4 waiting on you"]);
  assert.deepEqual(nv[0].view.columns.map(c => c.key), ["short", "kind", "age", "summary", "source", "next"]);
  assert.equal(nv[0].view.columns.at(-1).label, "Answer with");
  assert.deepEqual(nv[0].data.map(r => [r.id, r.next]), rows.map(r => [r.id, r.next]), "data is what --json prints");
  assert.deepEqual(nv.at(-1), { v: 1, done: true, exit: 0 });

  const list = await vyre(["drafts", "--json"], env);
  assert.equal(list.code, 0, list.out);
  assert.deepEqual(JSON.parse(list.stdout).map(d => d.id), [w.draft]);
  const show = await vyre(["gate", "show", s], env);
  assert.equal(show.code, 0, show.out);
  assert.match(show.out, /send via mail/);
  assert.match(show.out, /to\s+kit@northwind\.example/);
  assert.match(show.out, /subject\s+Opening hours/);
  assert.match(show.out, /The shop opens at 7 from Monday\./);
  assert.match(show.out, /approving it asks you to prove it is you/);
  assert.match(show.out, new RegExp(`vyre gate approve ${s}`));
  assert.equal(JSON.parse((await vyre(["gate", "show", s, "--json"], env)).stdout).draft.body, "The shop opens at 7 from Monday.");
  const sv = JSON.parse((await vyre(["gate", "show", s, "--view"], env)).stdout.split("\n")[0]);
  assert.deepEqual([sv.cmd, sv.view.kind, sv.view.title, sv.view.state], ["gate show", "card", "send via mail", "wait"]);
  assert.deepEqual(sv.view.fields.slice(0, 4), [{ label: "Id", value: s }, { label: "To", value: "kit@northwind.example" },
    { label: "Subject", value: "Opening hours" }, { label: "Words", value: "The shop opens at 7 from Monday." }]);
  // --view never opens an editor: it asks for the words, naming the command that takes them.
  const rv = await vyre(["gate", "revise", s, "--view"], { ...env, EDITOR: "false", VISUAL: "" });
  assert.equal(rv.code, 2, rv.stdout);
  const rp = JSON.parse(rv.stdout.split("\n")[0]);
  assert.deepEqual([rp.view.kind, rp.view.name, rp.view.args, rp.view.answer, rp.view.flag], ["prompt", "text", ["gate", "revise", s], "flag", "text"]);
  assert.equal(rp.data.current, "The shop opens at 7 from Monday.");

  const byFlag = await vyre(["gate", "revise", s, "--text", "The shop opens at 8 from Monday.", "--subject", "New opening hours"], env);
  assert.equal(byFlag.code, 0, byFlag.out);
  let got = (await w.tool("gate.get", { id: w.draft })).data;
  assert.deepEqual([got.state, got.final.subject, got.final.body], ["held", "New opening hours", "The shop opens at 8 from Monday."]);

  const editor = path.join(w.root, "editor.sh");
  fs.writeFileSync(editor, `#!/bin/sh\ngrep -q "opens at 8" "$1" || exit 3\nprintf 'Open 8 to 4, Monday to Saturday.\\n' > "$1"\n`, { mode: 0o755 });
  const edited = await vyre(["gate", "revise", s], { ...env, EDITOR: editor, VISUAL: "" });
  assert.equal(edited.code, 0, edited.out);
  got = (await w.tool("gate.get", { id: w.draft })).data;
  assert.equal(got.final.body, "Open 8 to 4, Monday to Saturday.", "the editor's trailing newline is not kept");
  assert.equal(got.final.subject, "New opening hours");
  const same = await vyre(["gate", "revise", s], { ...env, EDITOR: "true", VISUAL: "" });
  assert.match(same.out, /nothing changed/);

  // A script, or a model's shell: no terminal, so no proof, exit 3, and still held.
  const blind = await vyre(["gate", "approve", s], env);
  assert.equal(blind.code, 3, blind.out);
  assert.match(blind.out, /needs a person at a terminal/);
  assert.equal((await w.tool("gate.get", { id: w.draft })).data.state, "held");

  // The person at their terminal: the proof goes through and the Gate sends the revision. The
  // sender has no credential, so it fails and the draft stays held, saying so.
  const printed = [];
  const write = process.stdout.write;
  process.stdout.write = /** @type {any} */ (c => { printed.push(String(c)); return true; });
  let code;
  try { code = await gate(["approve", s], { io: terminal(w.screen) }); } finally { process.stdout.write = write; }
  assert.equal(code, 1, printed.join(""));
  assert.match(printed.join(""), /not sent: .*still held/);
  assert.equal(w.screen.at(-1).file, "/dev/ttys007", "the code went to the person's login terminal");
  got = (await w.tool("gate.get", { id: w.draft })).data;
  assert.equal(got.state, "held");
  assert.ok(got.error, "the sender's failure is on the draft");

  const rej = await vyre(["gate", "reject", s, "not", "this", "week"], env);
  assert.equal(rej.code, 0, rej.out);
  assert.match(rej.out, /discarded/);
  got = (await w.tool("gate.get", { id: w.draft })).data;
  assert.deepEqual([got.state, got.error], ["rejected", "not this week"]);
  assert.deepEqual(JSON.parse((await vyre(["gate", "--json"], env)).stdout), []);
  assert.match((await vyre(["gate"], env)).out, /nothing is held at the Gate/);

  const bad = await vyre(["gate", "approve", "zzzz"], env);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /nothing at the Gate has id zzzz/);
  assert.match(bad.out, /next: /);
  const done = await vyre(["gate", "approve", w.draft], env);
  assert.equal(done.code, 1, done.out);
  assert.match(done.out, /is already rejected/);
  assert.equal((await vyre(["gate", "frobnicate"], env)).code, 2);

  // Every verb gate() takes is in vyre commands, and nothing it refuses; needs takes no verbs.
  const listed = JSON.parse((await vyre(["commands", "gate", "--json"], env)).stdout).commands[0].verbs;
  assert.deepEqual(listed.map(v => [v.verb, v.aliases || []]), [["list", ["ls"]], ["show", ["get"]], ["approve", ["send"]], ["reject", ["discard"]], ["revise", ["edit"]]]);
  assert.deepEqual(listed.filter(v => v.read).map(v => v.verb), ["list", "show"]);
  assert.equal(listed.find(v => v.verb === "approve").person, true);
  const needs = JSON.parse((await vyre(["commands", "needs", "--json"], env)).stdout).commands[0];
  assert.deepEqual([needs.verbs, needs.args], [[], []]);
});

test("threads answer: a question by --pick and --answer, shown first; always with and without a project; deny", async t => {
  const w = await world(t);
  const env = { VYRE_HOME: w.root };
  const q = w.question.id.slice(0, 8);

  // No answer and no terminal: the question and its options are shown, then how to answer.
  const none = await vyre(["threads", "answer", q], env);
  assert.equal(none.code, 2, none.out);
  assert.match(none.out, /Which palette should the Northwind Bakery menu use\?/);
  assert.match(none.out, /1\s+Warm crust/);
  assert.match(none.out, /\(pick any\)/);
  assert.match(none.out, /--pick N/);
  assert.equal((await vyre(["threads", "answer", q, "always"], env)).code, 2, "always is for permissions");

  const ok = await vyre(["threads", "answer", q, "--pick", "2", "--answer", "Sections=1,Specials"], env);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /answered/);
  const said = await until(async () => {
    const g = (await w.tool("threads.get", { thread: w.question.thread })).data;
    return g.events.find(e => e.type === "thread.text" && e.payload.done && /^answers:/.test(e.payload.text || ""));
  }, "the fake to say the answers");
  assert.equal(said.payload.text, `answers: ${JSON.stringify({ [PALETTE.question]: "Fresh mint", [SECTIONS.question]: "Breads, Specials" })}`);

  // A permission with no decision and no terminal: shown, then refused as a usage mistake.
  const b = w.bash.id.slice(0, 8);
  const bare = await vyre(["threads", "answer", b], env);
  assert.equal(bare.code, 2, bare.out);
  assert.match(bare.out, /asks to run Bash/);
  assert.match(bare.out, /npm test/);

  // Write offers always, but this thread has no project, so there is no always for one project.
  const wr = w.write.id.slice(0, 8);
  assert.equal(w.write.always, true, JSON.stringify(w.write));
  const scoped = await vyre(["threads", "answer", wr, "always", "--scope", "project"], env);
  assert.equal(scoped.code, 1, scoped.out);
  assert.match(scoped.out, /no always for one project/);
  const always = await vyre(["threads", "answer", wr, "--always", "--json"], env);
  assert.equal(always.code, 0, always.out);
  assert.deepEqual(JSON.parse(always.stdout), { ask: w.write.id, answered: true, decision: "always" });

  // The old form still works.
  const deny = await vyre(["threads", "answer", b, "deny", "not", "now"], env);
  assert.equal(deny.code, 0, deny.out);
  assert.match(deny.out, /denied/);
  assert.equal((await w.tool("threads.asks", {})).data.length, 0);
  const left = await vyre(["needs"], env);
  assert.equal(left.code, 0, left.out);
  assert.match(left.out, /1 waiting on you/, "only the held draft is left");
  assert.doesNotMatch(left.out, /threads answer/);
  assert.equal((await w.tool("gate.reject", { id: w.draft })).data.state, "rejected");
  assert.match((await vyre(["needs"], env)).out, /nothing is waiting on you/);
});
