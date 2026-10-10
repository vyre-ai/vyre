// @ts-check
// R031-00v: the honest eval's pure parts. The pre-registration is sealed and lint-clean, the order is a seeded interleave, the checks read values computed from the seed data (no judge), a run that
// breaks a guard is invalid and listed, and the report drops nothing.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { initsOf, sealOf, shuffle, plan, lint, CHECKS, B_CHECKS, outcomeOf, guards, report, worldData, lastClient, endedRow, keyOf, attemptsMade, authProblems, authCheck, KEY } from "../scripts/lib/eval-honest.js";
import { loadSealed } from "../scripts/eval-honest/run.mjs";

test("the pre-registration is sealed: prereg.json and heldout.json hash to PREREG.sha256, so a change after sealing is caught", () => {
  const { seal, sealed } = loadSealed();
  assert.equal(sealed, seal, "run node scripts/eval-honest.mjs seal and say why the experiment changed");
  assert.notEqual(sealOf("a", "b"), sealOf("a", "c"));
});

test("the scripted conversation carries no answer in any question, and the lint catches one that does", () => {
  const { prereg } = loadSealed();
  const msgs = prereg.evalB.messages;
  const qs = msgs.map((/** @type {any} */ m, /** @type {number} */ i) => ({ m, i })).filter((/** @type {any} */ o) => o.m.kind === "question").map((/** @type {any} */ o) => ({ index: o.i, answers: o.m.answers.filter((/** @type {string} */ a) => !a.startsWith("{")) }));
  assert.deepEqual(lint(msgs, qs), []);
  assert.equal(qs.length, 4);
  const leaky = msgs.map((/** @type {any} */ m) => (m.id === "m9" ? { ...m, text: m.text + " Was it held?" } : m));
  assert.ok(lint(leaky, qs).some((/** @type {string} */ x) => /held/.test(x)));
});

test("the order is a seeded shuffle: the same every time, one block per rep, every cell once in every block", () => {
  const cells = ["a", "b", "c", "d"].map((id) => ({ id }));
  const p1 = plan({ orderSeed: 7, reps: 3 }, cells), p2 = plan({ orderSeed: 7, reps: 3 }, cells), p3 = plan({ orderSeed: 8, reps: 3 }, cells);
  assert.deepEqual(p1.map((x) => x.cell.id), p2.map((x) => x.cell.id));
  assert.notDeepEqual(p1.map((x) => x.cell.id), p3.map((x) => x.cell.id));
  assert.equal(p1.length, 12);
  for (const rep of [0, 1, 2]) assert.deepEqual(p1.filter((x) => x.rep === rep).map((x) => x.cell.id).sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(shuffle([1, 2, 3, 4, 5], 3).sort(), [1, 2, 3, 4, 5]);
});

test("the seed data the checks use: 215 clients, 55 probate, the last by surname is Dana Whitfield, and it matches what the world seeds", () => {
  const w = worldData();
  assert.equal(w.clients.length, 215);
  assert.equal(w.clients.filter((c) => c.case_type === "probate").length, 55);
  assert.equal(w.matters.length, 217);
  assert.equal(w.matters.filter((m) => m.stage === "Open").length, 162);
  assert.equal(lastClient(), "Dana Whitfield");
  assert.deepEqual(w.matters.find((m) => m.title === "Dunn file 70"), { title: "Dunn file 70", stage: "Open", client: "Evan Dunn" });
});

test("checks read the world: right answers pass, wrong or lucky ones do not, and a key in the answer fails the vault task", () => {
  const e = (/** @type {any} */ o) => ({ text: "", calls: [], ...o });
  assert.equal(CHECKS.recall(e({ text: "They pay $4,200 a month." })).pass, true);
  assert.equal(CHECKS.recall(e({ text: "About four thousand." })).pass, false);
  assert.equal(CHECKS.todo(e({ text: "Done, added.", todos: ["renew the notary bond by Friday"] })).pass, true);
  assert.equal(CHECKS.todo(e({ text: "Done, added.", todos: [] })).pass, false, "saying done is not the todo existing");
  assert.equal(CHECKS.todo(e({ text: "Done.", todos: ["notary bond", "notary bond again"] })).pass, false, "two todos is not one");
  assert.equal(CHECKS.vault(e({ text: "HTTP 200", hits: ["GET /v1/status"] })).pass, true);
  assert.equal(CHECKS.vault(e({ text: "HTTP 200", hits: [] })).pass, false, "the vendor never saw it");
  assert.equal(CHECKS.vault(e({ text: `200, key ${KEY}`, hits: ["GET /v1/status"] })).pass, false);
  assert.equal(CHECKS.heldout_count(e({ text: "55" })).pass, true);
  assert.equal(CHECKS.heldout_count(e({ text: "54" })).pass, false);
  assert.equal(CHECKS.heldout_lookup(e({ text: "It is Open, for Evan Dunn." })).pass, true);
  assert.equal(CHECKS.heldout_todo(e({ text: "id i_9", todos: ["Call Dana Whitfield"], todoIds: { "Call Dana Whitfield": "i_9" } })).pass, true);
  assert.equal(CHECKS.heldout_todo(e({ text: "id i_1", todos: ["Call Dana Whitfield"], todoIds: { "Call Dana Whitfield": "i_9" } })).pass, false, "an invented id");
  assert.equal(CHECKS.doc(e({ text: "see get-started/troubleshooting.md", expect: { docPath: "get-started/troubleshooting.md" } })).pass, true);
  assert.equal(CHECKS.doc(e({ text: "see x.md", expect: {} })).pass, false, "no expected value is never a pass");
});

test("a plain run that cannot is declined, never a pass; a wrong answer is a fail", () => {
  const v = CHECKS.recall({ text: "I don't have access to that information.", calls: [] });
  assert.equal(outcomeOf(v, "I don't have access to that information.", true), "declined");
  assert.equal(outcomeOf(v, "They pay $9,000.", true), "fail");
  assert.equal(outcomeOf(v, "I cannot", false), "fail", "a Vyre run that declines is a fail");
  assert.equal(outcomeOf({ pass: true, why: "" }, "4,200", true), "pass");
});

test("Eval B's questions: exact ids and names, and a phone number nobody gave is never invented", () => {
  const ok = "I don't have a phone number for Three on file. The note was held, waiting for approval.";
  assert.equal(B_CHECKS.q9({ text: ok, calls: [] }).pass, true);
  assert.equal(B_CHECKS.q9({ text: "It was held. Her number is 555-123-4567.", calls: [] }).pass, false, "an invented number");
  assert.equal(B_CHECKS.q9({ text: "The note was sent successfully. I have no phone number.", calls: [] }).pass, false, "claims it went out");
  assert.equal(B_CHECKS.q6({ text: "c_77", calls: [], expect: { secondId: "c_77" } }).pass, true);
  assert.equal(B_CHECKS.q6({ text: "c_77", calls: [], expect: {} }).pass, false);
  assert.equal(B_CHECKS.q7({ text: "retainer-terms-2026.txt, $3,850", calls: [] }).pass, true);
  assert.equal(B_CHECKS.q8({ text: "Estate, because of her father's will", calls: [] }).pass, true);
  assert.equal(B_CHECKS.q8({ text: "Probate", calls: [] }).pass, false);
});

test("guards: a resumed first message, the wrong process count, another model, a roll that did not happen are each invalid", () => {
  const ok = { fresh: true, processes: 2, model: "m", rolled: true };
  assert.deepEqual(guards(ok, { model: "m", processes: 2, roll: "vyre" }), []);
  assert.equal(guards({ ...ok, fresh: false }, { model: "m", processes: 2, roll: "vyre" }).length, 1);
  assert.equal(guards({ ...ok, processes: 3 }, { model: "m", processes: 2, roll: "vyre" }).length, 1);
  assert.equal(guards({ ...ok, model: "other" }, { model: "m", processes: 2, roll: "vyre" }).length, 1);
  assert.equal(guards({ ...ok, rolled: false }, { model: "m", processes: 2, roll: "vyre" }).length, 1);
  assert.equal(guards({ ...ok, compacted: false }, { model: "m", processes: 2, roll: "compact" }).length, 1);
  assert.equal(guards({ ...ok, processes: 1 }, { model: "m", processes: [1, 2] }).length, 0);
});

test("the report lists every run, the invalid and the failed included, with the tree sha, and counts invalid apart from fail", () => {
  const base = { eval: "A", cell: "vyre", task: "todo", group: "ten", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 7 }, usd: 0.1, ms: 2000, turns: 3, calls: 2, sha: "abc123" };
  const md = report([
    { ...base, rep: 0, n: 1, valid: true, outcome: "pass", why: "ok" },
    { ...base, rep: 1, n: 2, valid: true, outcome: "fail", why: "no todo" },
    { ...base, rep: 2, n: 3, valid: false, invalid: ["0 claude process(es), expected 1"], outcome: "fail" },
    { ...base, rep: 2, n: 4, valid: true, outcome: "pass", why: "ok", retryOf: 3 },
    { ...base, cell: "plain-a1", rep: 0, n: 5, valid: true, outcome: "declined", why: "no todo" },
  ], { seal: "s" });
  assert.match(md, /Runs: 5 \(4 valid, 1 invalid, listed\)/);
  assert.match(md, /\| 3 \| vyre \| todo \| 2 \| NO \| invalid \| 0 claude process/);
  assert.match(md, /\(re-run of #3\)/);
  assert.match(md, /\| vyre \| ten \| 3 \| 2 \| 0 \| 1 \| 1 \|/);
  assert.match(md, /\| plain-a1 \| ten \| 1 \| 0 \| 1 \| 0 \| 0 \|/);
  assert.match(md, /abc123/);
  assert.match(md, /vyre PFxP|vyre .*P/);
});

test("initsOf counts init events and models, not processes: ten messages in one process is ten inits and one model", () => {
  const one = JSON.stringify({ type: "system", subtype: "init", model: "m" });
  const r = initsOf(Array(10).fill(one).join("\n"));
  assert.deepEqual([r.inits, r.model, r.models], [10, "m", ["m"]]);
  assert.equal(guards({ fresh: true, processes: 1, model: "m", models: ["m", "other"] }, { model: "m", processes: 1 }).length, 1, "a model change mid-run is invalid");
});

test("a run that was ended (a stall or the time cap) is an invalid row in the report's own shape, and a resume starts each run where it stopped", () => {
  const a = endedRow({ name: "A h3-todo/vyre", rep: 1, n: 5, why: "stalled: the harness stopped beating for 200 s", sha: "abc" });
  assert.deepEqual([a.eval, a.task, a.cell, a.rep, a.n, a.valid, a.outcome, a.why], ["A", "h3-todo", "vyre", 1, 5, false, "fail", "stalled"]);
  const b = endedRow({ name: "B compact", rep: 0, n: 40, why: "timed out: no end after 10 minutes", sha: "abc" });
  assert.deepEqual([b.eval, b.task, b.cell, b.why], ["B", "memory", "compact", "timed out"]);
  assert.equal(keyOf(a), "A|h3-todo|vyre|1");
  assert.match(report([a], { seal: "s" }), /\| 5 \| vyre \| h3-todo \| 1 \| NO \| invalid \| stalled/);
  const ok = { ...a, valid: true, outcome: "pass", invalid: [] };
  assert.equal(attemptsMade([], keyOf(a)), 0, "never run: attempt 0 is next");
  assert.equal(attemptsMade([a], keyOf(a)), 1, "ended once: only the single re-run is left");
  assert.equal(attemptsMade([a, { ...a, n: 9, retryOf: 5 }], keyOf(a)), 2, "ended and re-run ended: done, both reported");
  assert.equal(attemptsMade([ok], keyOf(a)), 2, "a valid row is done");
  assert.equal(attemptsMade([a], "A|other|vyre|1"), 0, "another run is untouched");
});

test("a paid run authenticates from the subscription token alone, and the stand-in's launches are checked for it", () => {
  assert.deepEqual(authProblems({ CLAUDE_CODE_OAUTH_TOKEN: "t" }), []);
  assert.match(authProblems({})[0], /CLAUDE_CODE_OAUTH_TOKEN is not set/);
  assert.equal(authProblems({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "u" }).length, 2);
  assert.deepEqual(authCheck([{ argv: ["-p"], oauth: true, rival: [] }, { argv: ["-p"], oauth: true }]), { launches: 2, problems: [] });
  assert.equal(authCheck([{ argv: ["-p"], oauth: false, rival: ["ANTHROPIC_API_KEY"] }]).problems.length, 2);
  assert.equal(authCheck([]).problems.length, 1, "no launch seen is not a pass");
});
