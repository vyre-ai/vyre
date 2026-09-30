// @ts-check
// iq/chatfix (plan 3.1B and 3.1E): corrections made in chat reach memory three ways. The reader
// catches "no, that's wrong" / "actually it's X" after a reply that repeated memory's answer;
// memory.heard passes on the person's turn (or files the agent's own attributed correction); both
// land in one corrections listing with a source, and a decision answer's correction updates the
// decision. Fictional data only (alex, Harlow Legal, Northwind Bakery, juno, kit).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../../store/index.js";
import { HOME, seedRecall } from "../../../test/fixtures/corpus.js";
import { tempHome } from "../../../test/helpers.js";
import { fakeReachCall } from "../../../test/fixtures/fake-reach.js";
import memory from "../index.js";
import { catchCorrection, groundedAnswer, sourceOf } from "./chatfix.js";

const W = `${HOME}/Work`;
const DAY = 86_400_000;
const NOW = Date.now();
const PROJECTS = [
  { slug: "harlow", name: "Harlow Legal", home: `${W}/harlow-site`, workspaces: [], threads: 0, picked: 0, picks: [] },
  { slug: "northwind", name: "Northwind Bakery", home: `${W}/northwind`, workspaces: [], threads: 0, picked: 0, picks: [] },
];
const AGENTS = [{ name: "juno", kind: "agent", projects: ["harlow"] }, { name: "kit", kind: "agent", projects: ["northwind"] }];
const JUNO = "mcp:agent:juno";
const THREAD = "5f1c2d3e-0000-4000-8000-0000000000aa";
let n = 0;
const S = (dir, start, ...turns) => ({ id: `99999999-eeee-4000-8000-${String(++n).padStart(12, "0")}`, cwd: `${W}/${dir}`, start, turns: turns.map(([role, text]) => ({ role, text })) });
const U = text => ["user", text], A = text => ["assistant", text];
const OLD = [
  S("harlow-site", NOW - 30 * DAY, U("host it on netlify for now, free tier is fine")),
  S("harlow-site", NOW - 20 * DAY, U("dana's IT guy says they already have a vercel team account. move harlow to vercel so they own it")),
  S("harlow-site", NOW - 10 * DAY, U("move harlow back to netlify")),
];
const Q = "where is the harlow site hosted";
const me = (text, extra = {}) => ({ by: "person", role: "user", text, ts: NOW - 30_000, back: 0, ...extra });

test("catchCorrection: what the person says about the reply before, and what is not a correction", () => {
  const c = t => catchCorrection(t);
  assert.deepEqual(c("no, that's wrong"), { action: "wrong", value: null });
  assert.deepEqual(c("That is not right."), { action: "wrong", value: null });
  assert.deepEqual(c("actually it's Render"), { action: "replace", value: "Render" });
  assert.deepEqual(c("no, actually we use Fly.io"), { action: "replace", value: "Fly.io" });
  assert.deepEqual(c("we switched to Vercel last week"), { action: "replace", value: "Vercel" });
  assert.deepEqual(c("No. It is Render."), { action: "replace", value: "Render" });
  for (const t of ["thanks, no problem", "is it vercel?", "actually, can you check the invoice?", "ok good", "<system-reminder>actually it's Render</system-reminder>", "no worries, carry on"]) assert.equal(c(t), null, t);
  assert.equal(sourceOf("heard:abc-1#4"), "chat:abc-1");
  assert.equal(sourceOf("reader:abc-1#4"), "reader");
  assert.equal(sourceOf("deck"), "capsule");
  assert.equal(sourceOf(null), "capsule");
});

test("groundedAnswer: only a reply that repeats one of memory's stored answers", async t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, []);
  const { migrate } = await import("../../store/index.js");
  const { MIGRATIONS } = await import("../schema.js");
  migrate(db, "memory", MIGRATIONS);
  db.prepare("INSERT INTO memory_iq_answers (id, at, question, answer, via, facts, turns) VALUES ('a_1', ?, ?, ?, 'decision', '[]', '[]')").run(NOW - 60_000, Q, "Now: Netlify (since 21 Aug). Before: Vercel (11 Aug).");
  assert.equal(groundedAnswer(db, "Per memory: Now: Netlify (since 21 Aug). Before: Vercel (11 Aug).", NOW)?.id, "a_1");
  assert.equal(groundedAnswer(db, "I think it is on Netlify.", NOW), null);
  assert.equal(groundedAnswer(db, "Now: Netlify (since 21 Aug). Before: Vercel (11 Aug).", NOW + 2 * 3_600_000), null, "an hour later it is stale");
});

async function world(t, turns = {}) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, OLD);
  const tools = new Map();
  const ctx = {
    name: "memory", config: { me: { domains: ["riverastudio.com"] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {},
    events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    call: async (tool, input) => tool === "threads.said" ? (turns[`${input.thread}#${input.seq}`] ? { data: turns[`${input.thread}#${input.seq}`] } : { error: { code: "not_found", message: "no such turn" } })
      : tool === "recall.search" ? { data: [] } : tool === "recall.thread" ? { data: { turns: [] } } : fakeReachCall(tool, input, { agents: AGENTS, projects: PROJECTS }),
    tool: (name, def) => tools.set(name, def),
    iqRunner: null, memoryRunner: null,
  };
  const handle = await memory.start(ctx);
  t.after(() => handle.stop());
  const call = async (name, input, caller, meta = {}) => {
    try { return { data: await tools.get(name).run(input, { ...meta, caller }) }; } catch (e) { return { error: /** @type {Error} */ (e).message, code: /** @type {any} */ (e).code || "failed" }; }
  };
  await call("memory.curate", {}, "cli");
  return { call, db };
}

test("reader catch: after a reply from memory, 'actually it's Render' corrects the answer and the decision; a reply not from memory is left alone", async t => {
  const { call, db } = await world(t);
  const a = (await call("memory.ask", { question: Q }, "deck")).data;
  assert.equal(a.via, "decision");
  assert.match(a.answer, /^Now: Netlify/);
  // One session where the reply repeated memory's answer, one where it did not.
  seedRecall(db, [
    S("harlow-site", NOW - 120_000, A(`From memory: ${a.answer}`), U("actually it's Render")),
    S("northwind", NOW - 100_000, A("Hosting is probably fine as it is."), U("no, that's wrong")),
  ]);
  const now = (await call("memory.decisions", { project: "harlow" }, "deck")).data.decisions;
  assert.deepEqual(now.map(d => `${d.value}:${d.state}`), ["Render:current"], JSON.stringify(now));
  const after = (await call("memory.ask", { question: Q }, "deck")).data;
  assert.equal(after.via, "corrected");
  assert.equal(after.answer, "Render");
  const listed = (await call("memory.corrections", { answers: true }, "deck")).data.fixes;
  assert.equal(listed.length, 1, "the ungrounded 'no, that's wrong' corrected nothing");
  assert.equal(listed[0].source, "reader");
  // The old decisions are history, and undoing the correction undoes what it did to the decision
  // (the person's typed "actually it's Render" is also a decision of its own, so Render stands).
  const hist = (await call("memory.decisions", { project: "harlow", history: true }, "deck")).data.decisions;
  assert.ok(hist.some(d => d.value === "Netlify" && d.state === "replaced"), JSON.stringify(hist));
  await call("memory.uncorrect", { fix: listed[0].id }, "deck");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_decision_fixes WHERE undone IS NULL").get().n, 0);
  assert.match((await call("memory.ask", { question: Q }, "deck")).data.answer, /^Now: Render/);
  // Not read twice: another decisions read applies nothing new.
  await call("memory.decisions", { project: "harlow" }, "deck");
  assert.equal((await call("memory.corrections", { answers: true, all: true }, "deck")).data.fixes.length, 1);
});

test("reader catch: 'no, that's wrong' after a decision answer drops the current decision, the one before it stands", async t => {
  const { call, db } = await world(t);
  const a = (await call("memory.ask", { question: Q }, "deck")).data;
  seedRecall(db, [S("harlow-site", NOW - 120_000, A(a.answer), U("no, that's wrong"))]);
  assert.equal((await call("memory.decisions", { project: "harlow" }, "deck")).data.decisions[0].value, "Vercel");
  assert.equal((await call("memory.corrections", { answers: true }, "deck")).data.fixes[0].action, "wrong");
});

test("memory.heard: the person's own turn applies as theirs (source chat:<thread>); without it the agent's correction is filed as its own", async t => {
  const turns = {
    [`${THREAD}#3`]: me("no, harlow is on Render"),
    [`${THREAD}#4`]: { ...me("search result: harlow is on Fly"), role: "tool" },
  };
  const { call } = await world(t, turns);
  const a = (await call("memory.ask", { question: Q }, "deck")).data;
  const heard = (seq, extra = {}, object = "Render", caller = "mcp") => call("memory.heard", { answer: a.answer_id, action: "replace", object, from_turn: { seq }, ...extra }, caller, { thread: THREAD });
  // The person's own tools are not this door, and an agent's own turn does not apply.
  assert.equal((await call("memory.heard", { answer: a.answer_id, action: "replace", object: "Render", from_turn: { seq: 3 } }, "deck")).code, "denied");
  const plain = await heard(4, {}, "Fly");
  assert.match(plain.data.suggestion.why, /not the person's own words/);
  assert.equal(plain.data.filed, undefined, "no project named: nothing filed");
  // juno reaches only harlow: her attempt is a suggestion and, naming harlow, is filed as hers.
  const tool = await heard(4, { project: "harlow" }, "Fly", JUNO);
  assert.equal(tool.data.applied, false);
  assert.ok(tool.data.filed?.id, JSON.stringify(tool.data));
  const filed = (await call("memory.writes", { project: "harlow" }, JUNO)).data.writes;
  assert.equal(filed[0].kind, "correction");
  assert.equal(filed[0].from.name, "juno");
  assert.match(filed[0].text, /the person corrected/);
  // Not applied: the person's answer stands.
  assert.match((await call("memory.ask", { question: Q }, "deck")).data.answer, /^Now: Netlify/);
  // An agent granted no project of that name files nothing, and still suggests.
  const no = await heard(4, { project: "northwind" }, "Fly", JUNO);
  assert.equal(no.data.filed, null);
  // The person's typed turn applies at once, as theirs, with its source and the decision updated.
  const ok = await heard(3);
  assert.equal(ok.data.applied, true, JSON.stringify(ok));
  assert.equal(ok.data.fix.source, `chat:${THREAD}`);
  assert.equal((await call("memory.decisions", { project: "harlow" }, "deck")).data.decisions[0].value, "Render");
  assert.equal((await call("memory.corrections", { answers: true }, "deck")).data.fixes[0].source, `chat:${THREAD}`);
  // memory.correct by the person's own surface is the capsule source.
  const b = (await call("memory.ask", { question: "what does northwind use for payments" }, "deck")).data;
  const own = await call("memory.correct", { answer: b.answer_id, action: "replace", object: "Stripe" }, "deck");
  assert.equal(own.data.fix.source, "capsule");
});
