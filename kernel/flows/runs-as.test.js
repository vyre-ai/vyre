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
  assert.deepEqual((await w.store.getVersion(d.id, d.version)).flow.runs_on, { person: ALEX.id, account: "k-alex", provider: "openrouter" }, "the person is the writer, never what was sent");
  const other = await w.runner.define(d.id, classify({ runs_on: { person: BOB.id, account: "k-alex" } }), ALEX);
  assert.equal(other.ok, false); assert.match(JSON.stringify(other.errors), /cannot be set to run on someone else's/);
  const notMine = await w.runner.define(d.id, classify({ runs_on: { account: "k-bob" } }), ALEX);
  assert.equal(notMine.ok, false); assert.match(JSON.stringify(notMine.errors), /not one of your own AI accounts/, "a member can never set it to an account that is not theirs");
  const bobs = await w.runner.define(d.id, classify({ runs_on: { account: "k-bob" } }), BOB);
  assert.equal(bobs.ok, false); assert.match(JSON.stringify(bobs.errors), /only the person who made this Flow, or the owner for themselves/, "someone who did not make it cannot move it to their account");
  const kept = await w.runner.define(d.id, classify({ label: "Triage 2" }), BOB);
  assert.ok(kept.ok, JSON.stringify(kept));
  assert.deepEqual((await w.store.getVersion(d.id, kept.version)).flow.runs_on, { person: ALEX.id, account: "k-alex", provider: "openrouter" }, "an edit that leaves it out keeps it");
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
  assert.deepEqual([asked[0].person, asked[0].account, asked[0].provider, asked[0].purpose], [ALEX.id, "k-alex", "openrouter", "classify"]);
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
