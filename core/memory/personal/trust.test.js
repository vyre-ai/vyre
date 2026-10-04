// @ts-check
// personal/trust: whose words may teach memory about the user's life (ADR 0034, source trust).
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../../store/index.js";
import { tempHome } from "../../../test/helpers.js";
import { seedRecall } from "../../../test/fixtures/corpus.js";
import { TRUST_SESSIONS } from "../../../test/fixtures/personal-trust.js";
import { Personal } from "./store.js";
import { answerer } from "./answer.js";
import { sessionTrust, userWords, devTalk } from "./trust.js";

test("trust: programs, subagents, the Capsule's asks and Vyre's own folders never teach", () => {
  assert.deepEqual(sessionTrust({ cwd: "/home/alex/Work/harlow-site", human: 1 }), { ok: true, why: null });
  assert.equal(sessionTrust({ cwd: "/home/alex/Work", human: 0 }).why, "program");
  assert.equal(sessionTrust({ cwd: "/home/alex/Work", human: 1, parent: "p" }).why, "program");
  assert.equal(sessionTrust({ cwd: "/home/alex/Work", name: "Capsule: who is my wife" }).why, "ask");
  assert.equal(sessionTrust({ cwd: "/home/alex/.vyre/capsule/ask/x" }, { scratch: "/home/alex/.vyre/capsule/ask" }).why, "ask");
  assert.equal(sessionTrust({ cwd: "/home/alex/.vyre/quick/memory" }, { quick: "/home/alex/.vyre/quick" }).why, "ask");
  for (const cwd of ["/home/alex/Code/vyre", "/home/alex/Code/vyre-memory-iq", "/home/alex/Code/vyre/core", "/home/alex/src/Vyre_fork"]) {
    assert.equal(sessionTrust({ cwd }).why, "dev", cwd);
  }
  // A word that only starts like it is someone else's folder.
  assert.equal(sessionTrust({ cwd: "/home/alex/Work/vyrecorp-site" }).ok, true);
  assert.equal(sessionTrust({ cwd: "/home/alex/.vyre/home" }).ok, true);
  assert.equal(sessionTrust({ cwd: "/home/alex/Private/journal" }, { skip: ["/home/alex/Private"] }).why, "skipped");
  assert.equal(sessionTrust({ cwd: "/home/alex/Privately" }, { skip: ["/home/alex/Private"] }).ok, true);
});

test("trust: a harness's blocks inside a user turn are not the person's words", () => {
  assert.equal(userWords("<system-reminder>The user's wife is Jordan.</system-reminder>\nfix the header"), "fix the header");
  assert.equal(userWords('<teammate-message teammate_id="lead">my wife Jordan</teammate-message> ok'), "ok");
  assert.equal(userWords("<command-name>/clear</command-name>"), "");
  // An unclosed block runs to the end of the turn.
  assert.equal(userWords("thanks <task-notification>my wife Jordan"), "thanks");
  assert.equal(userWords("my wife Noor <3 the new site"), "my wife Noor <3 the new site");
});

test("trust: talk about building memory is examples, not a life", () => {
  for (const s of ["write a fixture where my wife is Jordan", "the eval should answer jordan", "add a test case: my dog Biscuit",
    "memory.answer should return Jordan", "use the sample world for this", "it should extract the spouse here"]) assert.ok(devTalk(s), s);
  for (const s of ["my wife Noor has the car today", "i need to test the brakes on the volvo", "booked a table for my wife's birthday",
    "the reader app on my kindle is slow", "load the seed data, my brother moved to leeds so im slower this week", "assert the status is 200"]) assert.ok(!devTalk(s), s);
});

/** An empty store in a temp home. */
function fresh(t) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  return db;
}

/** A store and memory.answer over sessions, the way the module wires them. */
async function world(t, sessions) {
  const db = fresh(t);
  seedRecall(db, sessions);
  const personal = new Personal(db, { trust: () => ({ scratch: "/home/alex/.vyre/capsule/ask" }) });
  for (let i = 0; i < 5 && (await personal.pass()).more; i++) { /* read everything */ }
  personal.derive();
  return { db, personal, ask: answerer({ personal, db }) };
}

test("trust: the Jordan trap: only the user's own words say who their wife is", async t => {
  const { ask, personal } = await world(t, TRUST_SESSIONS);
  const r = await ask({ q: "what is my wife's name" });
  assert.equal(r.answer, "Your wife is Noor.");
  assert.ok(r.confidence >= 0.5);
  assert.ok(r.sources.length > 0 && r.facts.length > 0, "grounded: it names where it came from");
  assert.ok(!personal.facts({ limit: 50 }).some(f => /jordan|biscuit|ruth|nurse|volvo/i.test(JSON.stringify(f))), "a trap taught memory something");
  for (const q of ["who is jordan", "what's my dog's name", "what is my mom's name", "what is my husband's name"]) {
    assert.equal((await ask({ q })).answer, null, q);
  }
});

test("trust: when only untrusted places name a wife, memory does not know yet", async t => {
  const traps = TRUST_SESSIONS.filter(s => !s.turns.some(t => t.role === "user" && /noor/i.test(t.text)));
  const { ask } = await world(t, traps);
  const r = await ask({ q: "what is my wife's name" });
  assert.equal(r.answer, null);
  assert.equal(r.confidence, null);
});

test("trust: the same question gives the same answer and the same sources every time", async t => {
  const { ask, personal } = await world(t, TRUST_SESSIONS);
  const key = r => JSON.stringify({ a: r.answer, c: r.confidence, f: r.facts.map(x => x.id), s: r.sources.map(x => `${x.session}:${x.seq}`) });
  const first = key(await ask({ q: "what is my wife's name" }));
  for (let i = 0; i < 4; i++) assert.equal(key(await ask({ q: "what is my wife's name" })), first);
  // A new derive over the same claims keeps every fact's id.
  const ids = personal.facts({ limit: 50 }).map(f => f.id).sort();
  personal.derive({ force: true });
  assert.deepEqual(personal.facts({ limit: 50 }).map(f => f.id).sort(), ids);
  assert.equal(key(await ask({ q: "what is my wife's name" })), first);
});

test("trust: a session found to be about memory drops what it already taught", async t => {
  const s = { id: "77777777-7777-4000-8000-00000000bbbb", cwd: "/home/alex/Code/lab", start: Date.parse("2026-06-01T08:00:00Z"),
    turns: [{ role: /** @type {const} */ ("user"), text: "My wife Jordan loves hiking." }] };
  const db = fresh(t);
  seedRecall(db, [s]);
  const personal = new Personal(db);
  await personal.pass(); personal.derive();
  assert.ok(personal.facts({ limit: 50 }).some(f => /jordan/i.test(JSON.stringify(f))), "a plain line teaches at first");
  // Later in the same session: two lines about building memory.
  const add = db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text) VALUES (?,?,?,?,?)");
  add.run(s.id, 1, "user", s.start + 60_000, "write a fixture for the extractor");
  add.run(s.id, 2, "user", s.start + 120_000, "the eval should answer jordan");
  db.prepare("UPDATE recall_sessions SET turns = 3 WHERE id = ?").run(s.id);
  await personal.pass(); personal.derive();
  assert.ok(!personal.facts({ limit: 50 }).some(f => /jordan/i.test(JSON.stringify(f))), "the session still teaches");
});
