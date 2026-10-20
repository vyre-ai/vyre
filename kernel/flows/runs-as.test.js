// @ts-check
// "Runs on": a Flow's AI turns run as its maker (or the person Runs on names), on that person's own account. Runs on is always the writer's own account, changed only by the maker or the owner for
// themselves, and kept when a version leaves it out. Every way a run starts (by hand, a webhook, a schedule) carries the runs-as person. A model step asks the host's model port as that person; with no
// account it stops in plain words, sends nothing, and the person gets a card. A run whose runs-as person did not turn the version on does no AI work at all.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX, BOB } from "./testing/world.js";
import { NO_ACCOUNT, settleRunsOn } from "./runs-as.js";
import { MemoryFlowStore } from "./store.js";

const ACCOUNTS = { per_alex: ["k-alex"], per_bob: ["k-bob"] };
const accountOk = async (/** @type {any} */ q) => (/** @type {any} */ (ACCOUNTS)[q.person] || []).includes(q.account);
const classify = (/** @type {any} */ extra = {}) => ({ format: 1, name: "triage", label: "Triage", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "k", kind: "classify", input: "refund please", labels: ["refund", "other"] }], ...extra });

/** A world whose host answers model calls through `model` (the daemon's flow-model port), with Alex the owner. @param {(q: any) => Promise<any>} model */
const aiWorld = (model, owner = "per_alex") => world({ ports: { model, accountOk, isOwner: async (/** @type {string} */ p) => p === owner } });

test("Runs on is the writer's own account: stamped with them, refused for someone else's, and kept when a version leaves it out", async () => {
  const w = await aiWorld(async () => ({ content: "refund" }));
  const d = await w.runner.define(null, classify({ runs_on: { account: "k-alex", provider: "openrouter" } }), ALEX);
  assert.ok(d.ok, JSON.stringify(d));
  assert.deepEqual((await w.store.getVersion(d.id, d.version)).flow.runs_on, { person: ALEX.id, main: { account: "k-alex", provider: "openrouter" } }, "the person is the writer, never what was sent");
  const other = await w.runner.define(d.id, classify({ runs_on: { person: BOB.id, account: "k-alex" } }), ALEX);
  assert.equal(other.ok, false); assert.match(JSON.stringify(other.errors), /cannot be set to run on someone else's/);
  const notMine = await w.runner.define(d.id, classify({ runs_on: { account: "k-bob" } }), ALEX);
  assert.equal(notMine.ok, false); assert.match(JSON.stringify(notMine.errors), /not one of your own AI accounts/, "a member can never set it to an account that is not theirs");
  const bobs = await w.runner.define(d.id, classify({ runs_on: { account: "k-bob" } }), BOB);
  assert.equal(bobs.ok, false); assert.match(JSON.stringify(bobs.errors), /only the person who made this Flow, or the owner for themselves/, "someone who did not make it cannot move it to their account");
  const kept = await w.runner.define(d.id, classify({ label: "Triage 2" }), BOB);
  assert.ok(kept.ok, JSON.stringify(kept));
  assert.deepEqual((await w.store.getVersion(d.id, kept.version)).flow.runs_on, { person: ALEX.id, main: { account: "k-alex", provider: "openrouter" } }, "an edit that leaves it out keeps it");
  const viaAgent = await w.runner.define(d.id, classify({ runs_on: { account: "k-bob" } }), { kind: "agent", id: "research", space: ALEX.space });
  assert.equal(viaAgent.ok, false, "an assistant never sets it");
});

test("the owner may take a member's Flow onto their own account, for themselves only", async () => {
  const w = await aiWorld(async () => ({ content: "refund" }), "per_alex");
  const d = await w.runner.define(null, classify(), BOB);
  const mine = await w.runner.define(d.id, classify({ runs_on: { account: "k-alex" } }), ALEX);
  assert.ok(mine.ok, JSON.stringify(mine));
  assert.equal((await w.store.getVersion(d.id, mine.version)).flow.runs_on.person, ALEX.id);
  // and the pure rule with no account check at all refuses an account rather than trusting it
  const store = new MemoryFlowStore();
  const r = await settleRunsOn({ before: null, flow: classify({ runs_on: { account: "k-alex" } }), by: ALEX, id: null, store, isOwner: async () => false });
  assert.ok("errors" in r, "no way to check the account: refused");
});

test("every way a run starts carries the runs-as person: by hand, a webhook, a schedule", async () => {
  const w = await aiWorld(async () => ({ content: "refund" }));
  const hand = await install(w, classify());
  const web = await install(w, { ...classify(), name: "hooked", trigger: { on: "web", path: "hook-orders" } });
  const timed = await install(w, { ...classify(), name: "timed", trigger: { on: "time", every_ms: 3_600_000 } });
  const bobs = await install(w, { ...classify(), name: "bobs" }, BOB);
  await w.runner.start(hand.id, {}, w.kernel.as(ALEX), "by-hand").catch(() => null);
  await w.runner.handleWeb("hook-orders", { body: { a: 1 }, trust: "untrusted", key: "d1" });
  await w.runner.tick(); await settle(w); w.advance(2 * 3_600_000); await w.runner.tick();   // as kernel/flows/schedule.test.js: the first tick sets where the schedule counts from
  await w.runner.start(bobs.id, {}, w.kernel.as(BOB), "by-bob").catch(() => null);
  await settle(w);
  const first = async (/** @type {string} */ id) => (await w.runner.listRuns({ flow: id }))[0];
  assert.equal((await first(web.id)).runs_as, ALEX.id, "a webhook-started run");
  assert.equal((await first(timed.id)).runs_as, ALEX.id, "a schedule-started run");
  const b = await first(bobs.id);
  if (b) assert.equal(b.runs_as, BOB.id, "a member's own Flow runs as her");
});

test("a model step asks the host as the runs-as person, on the account Runs on names", async () => {
  /** @type {any[]} */ const asked = [];
  const w = await aiWorld(async (q) => { asked.push(q); return { content: "refund", usage: { input_tokens: 3, output_tokens: 1 } }; });
  const d = await w.runner.define(null, classify({ runs_on: { account: "k-alex", provider: "openrouter" } }), ALEX);
  await w.runner.approve(d.id, d.version, ALEX, d.hash);
  const s = await w.runner.start(d.id, {}, w.kernel.as(ALEX), "m1").catch((/** @type {any} */ e) => ({ error: e }));
  await settle(w);
  const run = (await w.runner.listRuns({ flow: d.id }))[0];
  assert.ok(run, JSON.stringify(s));
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(run.steps.k.output.label, "refund");
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0].person, asked[0].main.account, asked[0].main.provider, asked[0].purpose], [ALEX.id, "k-alex", "openrouter", "classify"]);
  assert.deepEqual(run.steps.k.output.answered_by, undefined, "a port that says nothing of who answered adds nothing");
  // the door is called as the run's own chain, so its record shows the Flow run: the runs-as person and the automation hop (the host checks the person comes first: core/daemon/flows-host.js)
  const hops = asked[0].chain.hops.map((/** @type {any} */ h) => h.actor);
  assert.ok(hops.some((/** @type {any} */ a) => a.kind === "person" && a.id === ALEX.id), JSON.stringify(hops));
  assert.ok(hops.some((/** @type {any} */ a) => a.kind === "automation" && a.id === d.id), JSON.stringify(hops));
});

test("no account: the step stops with the plain words, nothing is sent, and the runs-as person gets a card", async () => {
  let sent = 0;
  const w = await aiWorld(async () => { throw Object.assign(new Error(NO_ACCOUNT), { code: "no_account" }); });
  const model = /** @type {any} */ (w.kernel).model; const orig = model && model.call;
  if (model) model.call = async (/** @type {any} */ i) => { sent++; return orig.call(model, i); };
  const d = await install(w, classify());
  await w.runner.start(d.id, {}, w.kernel.as(ALEX), "n1").catch(() => null);
  await settle(w);
  const run = (await w.runner.listRuns({ flow: d.id }))[0];
  assert.equal(run.state, "failed");
  assert.equal(run.error.message, NO_ACCOUNT);
  assert.equal(sent, 0, "the kernel's door was never asked");
  const cards = (await w.kernel.allTasks()).filter((/** @type {any} */ t) => String(t.title).includes(NO_ACCOUNT));
  assert.equal(cards.length, 1, "one card");
  assert.equal(cards[0].doer.id, ALEX.id, "for the person it runs as");
});

test("a run whose runs-as person did not turn this version on does no AI work: the maker is a member, the approver someone else", async () => {
  let asked = 0;
  const w = await aiWorld(async () => { asked++; return { content: "refund" }; });
  const d = await w.runner.define(null, classify(), BOB);
  await w.runner.approve(d.id, d.version, ALEX, d.hash);
  await w.runner.start(d.id, {}, w.kernel.as(ALEX), "g1").catch(() => null);
  await settle(w);
  const run = (await w.runner.listRuns({ flow: d.id }))[0];
  assert.equal(run.runs_as, BOB.id, "it runs as its maker");
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "runs_as");
  assert.equal(asked, 0, "nothing was asked of anyone's account");
});

test("an owner approves a member's Flow with no Runs on: the model step AND an agent in any task slot (reviewer, checker) are refused; a person's task is not", async () => {
  let asked = 0;
  const w = await aiWorld(async () => { asked++; return { content: "refund" }; });
  const flowOf = (/** @type {string} */ name, /** @type {any} */ step) => ({ format: 1, name, label: name, authorship: "human", trigger: { on: "manual" }, steps: [step] });
  const steps = {
    model: { id: "k", kind: "classify", input: "refund please", labels: ["refund", "other"] },
    reviewer: { id: "a", kind: "assign", to: `person:${BOB.id}`, title: "Draft the reply", output: { kind: "note" }, reviewer: { who: "teammate:research" } },
    checker: { id: "a", kind: "assign", to: `person:${BOB.id}`, title: "Check the reply", output: { kind: "note" }, checker: "teammate:research" },
    doer: { id: "a", kind: "assign", to: "teammate:research", title: "Do the reply", output: { kind: "note" } },
    person: { id: "a", kind: "assign", to: `person:${BOB.id}`, title: "Just a person", output: { kind: "note" } },
  };
  /** @type {Record<string, any>} */ const runs = {};
  for (const [name, step] of Object.entries(steps)) {
    const d = await w.runner.define(null, flowOf(`m_${name}`, step), BOB);
    assert.ok(d.ok, `${name}: ${JSON.stringify(d.errors)}`);
    await w.runner.approve(d.id, d.version, ALEX, d.hash);
    await w.runner.start(d.id, {}, w.kernel.as(ALEX), `s-${name}`).catch(() => null);
    await settle(w);
    runs[name] = (await w.runner.listRuns({ flow: d.id }))[0];
  }
  for (const name of ["model", "reviewer", "checker", "doer"]) {
    assert.equal(runs[name].runs_as, BOB.id, `${name}: it runs as its maker`);
    assert.equal(runs[name].state, "failed", `${name}: ${JSON.stringify(runs[name].steps)}`);
    assert.equal(runs[name].error.code, "runs_as", `${name}: refused before anything ran`);
  }
  assert.equal(asked, 0, "no model was asked");
  const tasks = await w.kernel.allTasks();
  for (const title of ["Draft the reply", "Check the reply", "Do the reply"]) assert.ok(!tasks.some((/** @type {any} */ t) => t.title === title), `no task was made for "${title}", so no agent was woken on the approver's account`);
  assert.notEqual(runs.person.error && runs.person.error.code, "runs_as", "a task with no agent in it is not this rule's business");
});

test("main and fallback are both the saver's own: stamped with them, refused for someone else's, the fallback checked like the main one", async () => {
  const w = await aiWorld(async () => ({ content: "refund" }));
  const ACC = { per_alex: ["k-alex", "k-alex-2"], per_bob: ["k-bob"] };
  const ok = async (/** @type {any} */ q) => (/** @type {any} */ (ACC)[q.person] || []).includes(q.account);
  w.runner.ports.accountOk = ok;
  const d = await w.runner.define(null, classify({ runs_on: { main: { account: "k-alex", model: "x/main" }, fallback: { account: "k-alex-2", model: "x/back" } } }), ALEX);
  assert.ok(d.ok, JSON.stringify(d));
  assert.deepEqual((await w.store.getVersion(d.id, d.version)).flow.runs_on, { person: ALEX.id, main: { account: "k-alex", model: "x/main" }, fallback: { account: "k-alex-2", model: "x/back" } });
  const theirs = await w.runner.define(d.id, classify({ runs_on: { main: { account: "k-alex" }, fallback: { account: "k-bob" } } }), ALEX);
  assert.equal(theirs.ok, false); assert.match(JSON.stringify(theirs.errors), /runs_on.fallback.account.*not one of your own/);
  const bobs = await w.runner.define(d.id, classify({ runs_on: { main: { account: "k-bob" } } }), BOB);
  assert.equal(bobs.ok, false, "a member who did not make it cannot move it to her account"); assert.match(JSON.stringify(bobs.errors), /only the person who made this Flow/);
  const same = await w.runner.define(d.id, classify({ runs_on: { main: { account: "k-alex" }, fallback: { account: "k-alex" } } }), ALEX);
  assert.equal(same.ok, false, "the fallback is another account");
});

test("the step's run log says which account answered and why the fallback did; the runs-as person gets one card a day while the main one fails", async () => {
  const w = await aiWorld(async () => ({ content: "refund", answered: { which: "fallback", label: "Grok key", provider: "openai-compatible", main_label: "Claude sign-in", main_kind: "credits" } }));
  const d = await install(w, { ...classify(), steps: [{ id: "k", kind: "classify", input: "refund please", labels: ["refund", "other"], model: "x/step" }] });
  for (const key of ["c1", "c2"]) await w.runner.start(d.id, {}, w.kernel.as(ALEX), key).catch(() => null);
  await settle(w);
  const runs = await w.runner.listRuns({ flow: d.id });
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.equal(run.state, "done", JSON.stringify(run.error));
    assert.deepEqual(run.steps.k.output.answered_by, { account: "Grok key", provider: "openai-compatible", which: "fallback", why: "Main was out of credits, so the fallback answered" });
  }
  const cards = (await w.kernel.allTasks()).filter((/** @type {any} */ t) => t.title === "Your Claude sign-in for Triage is out of credits");
  assert.equal(cards.length, 1, "one card a day, however many runs");
  assert.equal(cards[0].doer.id, ALEX.id);
});

test("an AI step's own model goes to the port, for the main account", async () => {
  /** @type {any[]} */ const asked = [];
  const w = await aiWorld(async (q) => { asked.push(q); return { content: "refund" }; });
  const d = await install(w, { ...classify(), steps: [{ id: "k", kind: "classify", input: "refund please", labels: ["refund", "other"], model: "x/step" }] });
  await w.runner.start(d.id, {}, w.kernel.as(ALEX), "m").catch(() => null);
  await settle(w);
  assert.equal(asked[0].model, "x/step");
});

test("when the main account fails with a kind a fallback could help and none answers, the step fails and the card still says so", async () => {
  const w = await aiWorld(async () => { throw Object.assign(new Error("OpenRouter answered 402: no credits"), { kind: "credits", status: 402, account_label: "My key" }); });
  const d = await install(w, classify());
  await w.runner.start(d.id, {}, w.kernel.as(ALEX), "f").catch(() => null);
  await settle(w);
  const run = (await w.runner.listRuns({ flow: d.id }))[0];
  assert.equal(run.state, "failed");
  assert.ok((await w.kernel.allTasks()).some((/** @type {any} */ t) => t.title === "Your My key for Triage is out of credits"));
});
