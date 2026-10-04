// @ts-check
// batch.run: ordered steps inside the worker, no host round trip, halting on stop, floor, failure
// and hold, with "$0.path" references.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createCtx } from "./extension/lib/ctx.js";
import { dispatch, register  } from "./extension/caps/index.js";
import { createFakeChrome, createFakePage, samplePage } from "./test-support/fake-chrome.js";
import { dispatchT, T } from "./test-support/trust.js";

const calls = [];
register({
  name: "probe",
  ops: {
    "probe.echo": async args => { calls.push(args); return { ok: true, value: args, nested: { id: 7, list: ["a", "b"] } }; },
    "probe.fail": async () => ({ ok: false, why: "nope" }),
    "probe.throw": async () => { throw new Error("boom"); },
  },
});

const world = () => {
  const model = samplePage();
  const chrome = createFakeChrome([{ url: model.url, title: "New contact", active: true }, { url: "https://my.1password.com/vaults" }, { url: "https://harlow.example/" }]);
  const fake = createFakePage(model);
  chrome._.cdp = (t, m, p) => fake.handler(t, m, p);
  calls.length = 0;
  return { chrome, fake, ctx: createCtx({ chrome }) };
};

test("runs steps in order with no host round trip and returns every result", async () => {
  const { ctx } = world();
  const r = await dispatchT("batch.run", { steps: [{ op: "probe.echo", args: { n: 1 } }, { op: "probe.echo", args: { n: 2 } }, { op: "probe.echo", args: { n: 3 } }] }, ctx);
  assert.deepEqual([r.ok, r.done, r.results.length], [true, 3, 3]);
  assert.deepEqual(calls.map(c => c.n), [1, 2, 3]);
});

test("$N.path references an earlier result; nothing else is interpreted", async () => {
  const { ctx } = world();
  const r = await dispatchT("batch.run", { steps: [
    { op: "probe.echo", args: { a: 1 } },
    { op: "probe.echo", args: { id: "$0.nested.id", list: ["$0.nested.list", "$0.nested.list.1"], text: "$0 stays text", expr: "$0.value.a + 1", deep: { x: "$0.value.a" } } },
  ] }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(calls[1], { id: 7, list: [["a", "b"], "b"], text: "$0 stays text", expr: "$0.value.a + 1", deep: { x: 1 } });
});

test("a reference that does not resolve, or reaches a prototype, fails that step", async () => {
  const { ctx } = world();
  for (const bad of ["$0.nope", "$5.x", "$0.constructor", "$0.__proto__"]) {
    const r = await dispatchT("batch.run", { steps: [{ op: "probe.echo", args: {} }, { op: "probe.echo", args: { v: bad } }] }, ctx);
    assert.deepEqual([r.ok, r.failedAt, r.code], [false, 1, "bad_request"], bad);
  }
  assert.equal(calls.filter(c => c.v).length, 0);
});

test("halts at the first failure and says which step", async () => {
  const { ctx } = world();
  const r = await dispatchT("batch.run", { steps: [{ op: "probe.echo", args: { n: 1 } }, { op: "probe.fail" }, { op: "probe.echo", args: { n: 3 } }] }, ctx);
  assert.deepEqual([r.ok, r.done, r.failedAt, r.why, r.results.length], [false, 1, 1, "nope", 2]);
  assert.equal(calls.length, 1);
  const t = await dispatchT("batch.run", { steps: [{ op: "probe.throw" }, { op: "probe.echo", args: {} }] }, ctx);
  assert.deepEqual([t.ok, t.failedAt, t.code, t.why], [false, 0, "error", "boom"]);
  const u = await dispatchT("batch.run", { steps: [{ op: "nothing.here" }] }, ctx);
  assert.deepEqual([u.failedAt, u.code], [0, "unknown_op"]);
});

test("stopOnError:false keeps going", async () => {
  const { ctx } = world();
  const r = await dispatchT("batch.run", { stopOnError: false, steps: [{ op: "probe.fail" }, { op: "probe.echo", args: { n: 2 } }] }, ctx);
  assert.deepEqual([r.ok, r.done, r.failedAt, r.results.length], [false, 1, 0, 2]);
});

test("stop is checked before every step: the person's Esc halts mid-batch", async () => {
  const { ctx } = world();
  register({ name: "stopper", ops: { "stopper.press": async () => { ctx.setStopped(true); return { ok: true }; } } });
  const r = await dispatchT("batch.run", { steps: [{ op: "probe.echo", args: { n: 1 } }, { op: "stopper.press" }, { op: "probe.echo", args: { n: 3 } }] }, ctx);
  assert.deepEqual([r.ok, r.done, r.failedAt, r.code], [false, 2, 2, "stopped"]);
  assert.deepEqual(calls.map(c => c.n), [1]);
  // and while stopped, batch.run itself (an acting op) is refused outright
  await assert.rejects(dispatchT("batch.run", { steps: [{ op: "probe.echo" }] }, ctx), { code: "stopped" });
  ctx.setStopped(false);
  assert.equal((await dispatchT("batch.run", { steps: [{ op: "probe.echo", args: {} }] }, ctx)).ok, true);
});

test("the floor is checked before every step", async () => {
  const { ctx } = world();
  const r = await dispatchT("batch.run", { steps: [
    { op: "page.snapshot", args: { tabId: 1 } },
    { op: "page.snapshot", args: { tabId: 2 } },
    { op: "page.snapshot", args: { tabId: 1 } },
  ] }, ctx);
  assert.deepEqual([r.ok, r.done, r.failedAt, r.code], [false, 1, 1, "blocked"]);
});

test("a held step halts the batch and hands the hold back", async () => {
  const { ctx, fake } = world();
  const r = await dispatchT("batch.run", { steps: [
    { op: "page.fill", args: { tabId: 1, fields: [{ selector: { name: "Email" }, value: "alex@harlow.example" }] } },
    { op: "page.act", args: { tabId: 1, selector: { name: "Save contact" }, kind: "click" } },
    { op: "page.act", args: { tabId: 1, selector: { name: "Cancel" }, kind: "click" } },
  ] }, ctx);
  assert.deepEqual([r.ok, r.done, r.failedAt], [false, 1, 1]);
  assert.equal(r.held.held, true);
  assert.match(r.held.sig, /^[0-9a-f]{14}$/);
  assert.equal(fake.clicks.length, 0);
});

test("malformed batches are refused; a batch cannot contain a batch", async () => {
  const { ctx } = world();
  await assert.rejects(dispatchT("batch.run", {}, ctx), { code: "bad_request" });
  await assert.rejects(dispatchT("batch.run", { steps: [] }, ctx), { code: "bad_request" });
  await assert.rejects(dispatchT("batch.run", { steps: new Array(201).fill({ op: "probe.echo" }) }, ctx), { code: "bad_request" });
  const r = await dispatchT("batch.run", { steps: [{ op: "batch.run", args: { steps: [{ op: "probe.echo" }] } }] }, ctx);
  assert.deepEqual([r.ok, r.code], [false, "bad_request"]);
  const s = await dispatchT("batch.run", { steps: [{ args: {} }] }, ctx);
  assert.equal(s.ok, false);
});

test("page.act and page.fill steps look for their control for a moment by default; a step's own wait, or wait:false, is respected", async () => {
  const { ctx } = world();
  const seen = /** @type {any[]} */ ([]);
  ctx.call = async (/** @type {string} */ _op, /** @type {any} */ a) => { seen.push(a); return { ok: true }; };
  await dispatchT("batch.run", { steps: [{ op: "page.act", args: { selector: { name: "A" } } }, { op: "page.fill", args: { fields: [] } }, { op: "page.act", args: { selector: { name: "B" }, wait: { timeoutMs: 50 } } }] }, ctx);
  assert.deepEqual(seen.map(a => a.wait), [{ timeoutMs: 3000 }, { timeoutMs: 3000 }, { timeoutMs: 50 }]);
  seen.length = 0;
  await dispatchT("batch.run", { wait: false, steps: [{ op: "page.act", args: { selector: { name: "A" } } }] }, ctx);
  assert.equal(seen[0].wait, undefined);
});

test("batch.run: a batch that names a tab runs its page steps on that tab, not the active one; tabs steps keep their own", async () => {
  const calls = [];
  const ctx = { stopped: () => false, call: async (op, a) => { calls.push([op, a]); return { ok: true }; } };
  const { default: batch } = await import("./extension/caps/batch.js");
  await T(batch.ops["batch.run"])({ tabId: 7, steps: [{ op: "page.act", args: { selector: { name: "x" } } }, { op: "page.act", args: { tabId: 9, selector: { name: "y" } } }, { op: "tabs.use", args: { url: "https://a.example" } }] }, ctx);
  assert.equal(calls[0][1].tabId, 7);
  assert.equal(calls[1][1].tabId, 9, "a step that names its own tab keeps it");
  assert.equal(calls[2][1].tabId, undefined);
});

test("batch.run: ghl.save in a batch runs on the batch's tab (it read the active tab before and could not find Save); ghl.section still finds its own", async () => {
  const calls = [];
  const ctx = { stopped: () => false, call: async (op, a) => { calls.push([op, a]); return { ok: true }; } };
  const { default: batch } = await import("./extension/caps/batch.js");
  await T(batch.ops["batch.run"])({ tabId: 7, steps: [{ op: "ghl.save", args: { name: "Save" } }, { op: "ghl.section", args: { section: "workflows" } }] }, ctx);
  assert.equal(calls[0][1].tabId, 7);
  assert.equal(calls[1][1].tabId, undefined);
});

test("trust never travels in args: a step (or any nested arg) that carries asked, writeOk, release or writeBudget is refused outright; only the batch's own trust applies", async () => {
  const calls = /** @type {any[]} */ ([]);
  const ctx = { stopped: () => false, floorAllows: async () => ({ allow: true }), tabs: { get: async () => ({}) }, call: async (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ tr) => { calls.push([op, a, tr]); return { ok: true }; } };
  for (const key of ["asked", "writeOk", "release", "writeBudget"]) {
    await assert.rejects(dispatchT("batch.run", { tabId: 7, steps: [{ op: "api.call", args: { entry: "e", [key]: key === "release" ? { sig: "x" } : true } }] }, ctx), { code: "bad_request" }, key);
  }
  assert.equal(calls.length, 0, "nothing ran");
  await dispatchT("batch.run", { tabId: 7, asked: true, steps: [{ op: "api.call", args: { entry: "e" } }] }, ctx);
  assert.equal(calls[0][1].asked, undefined, "not in args");
  assert.equal(calls[0][2].asked, true, "the batch's own trust passes down beside the args");
  calls.length = 0;
  await dispatchT("batch.run", { tabId: 7, steps: [{ op: "api.call", args: { entry: "e" } }] }, ctx);
  assert.notEqual(calls[0][2].asked, true);
});

test("batch.run: a held write the module's budget covers is run again with writeOk, up to the budget, on the plan's own tab and site and its one API origin", async () => {
  const calls = [];
  const heldW = origin => ({ ok: false, held: true, write: true, kind: "create", method: "POST", origin });
  const ctx = { stopped: () => false, floorAllows: async () => ({ allow: true }), tabs: { get: async id => ({ id, url: id === 8 ? "https://evil.example/x" : "https://app.one.example/w" }) },
    call: async (op, a, tr) => { calls.push([op, a, tr]); return tr && tr.writeOk ? { ok: true, status: 201, method: "POST" } : heldW(a.entry === "other" ? "https://other.example" : "https://api.one.example"); } };
  const { default: batch } = await import("./extension/caps/batch.js");
  const steps = [{ op: "api.call", args: { entry: "a" } }, { op: "api.call", args: { entry: "a" } }, { op: "api.call", args: { entry: "a" } }];
  const budget = { create: 2, edit: 0, tab: 7, tabOrigin: "https://app.one.example", origin: "https://api.one.example" };
  const r = await batch.ops["batch.run"]({ tabId: 7, steps, stopOnError: false }, ctx, { writeBudget: { ...budget } });
  assert.equal(r.covered.length, 2);
  assert.equal(r.results[2].held, true, "the third is beyond the budget");
  assert.equal(calls.filter(c => c[2] && c[2].writeOk === true).length, 2);
  // another API origin is not covered
  const o = await batch.ops["batch.run"]({ tabId: 7, steps: [{ op: "api.call", args: { entry: "a" } }, { op: "api.call", args: { entry: "other" } }], stopOnError: false }, ctx, { writeBudget: { ...budget, create: 5 } });
  assert.equal(o.covered.length, 1, "another origin is not covered");
  // another tab gets nothing, whether the batch runs there or a step names it
  const t1 = await batch.ops["batch.run"]({ tabId: 8, steps, stopOnError: false }, ctx, { writeBudget: { ...budget } });
  assert.equal(t1.covered, undefined, "a batch on another tab covers nothing");
  const t2 = await batch.ops["batch.run"]({ tabId: 7, steps: [{ op: "api.call", args: { entry: "a", tabId: 8 } }], stopOnError: false }, ctx, { writeBudget: { ...budget } });
  assert.equal(t2.covered, undefined, "a step that names another tab covers nothing");
  // tabId = the plan's tab but tab = another one: the op reads tab, so nothing is covered
  const t3 = await batch.ops["batch.run"]({ tabId: 7, steps: [{ op: "api.call", args: { entry: "a", tabId: 7, tab: 8 } }], stopOnError: false }, ctx, { writeBudget: { ...budget } });
  assert.equal(t3.covered, undefined, "two different tab spellings are refused");
  // the tab moved off the plan's site: nothing
  const moved = { ...ctx, tabs: { get: async id => ({ id, url: "https://app.two.example/" }) } };
  assert.equal((await batch.ops["batch.run"]({ tabId: 7, steps, stopOnError: false }, moved, { writeBudget: { ...budget } })).covered, undefined);
  const none = await batch.ops["batch.run"]({ tabId: 7, steps, stopOnError: false }, ctx, {});
  assert.equal(none.covered, undefined);
});

test("batch.parallel reads several tabs at once, each on its own tab; a failing step does not stop the others", async () => {
  const { ctx } = world();
  const r = await dispatchT("batch.parallel", { steps: [{ op: "tabs.list", args: { tab: 1 } }, { op: "page.snapshot", args: { tabId: 3 } }, { op: "page.snapshot", args: { tabId: 2 } }] }, ctx);
  assert.equal(r.results.length, 3);
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[2].ok, false, "tab 2 is a blind page: its step is refused");
  assert.equal(r.ok, false);
  assert.ok(r.done >= 1);
});

test("batch.parallel refuses an acting op, two steps on one tab, a step with no tab, and more than 6 steps", async () => {
  const { ctx } = world();
  const bad = async steps => dispatchT("batch.parallel", { steps }, ctx);
  await assert.rejects(bad([{ op: "page.act", args: { tab: 1 } }]), e => e.code === "bad_request" && /not a reading op/.test(e.message));
  await assert.rejects(bad([{ op: "batch.run", args: { tab: 1 } }]), e => e.code === "bad_request");
  await assert.rejects(bad([{ op: "tabs.list", args: { tab: 1 } }, { op: "tabs.list", args: { tabId: 1 } }]), e => /twice/.test(e.message));
  await assert.rejects(bad([{ op: "tabs.list", args: {} }]), e => /name its tab/.test(e.message));
  await assert.rejects(bad(Array.from({ length: 7 }, (_, i) => ({ op: "tabs.list", args: { tab: i + 1 } }))), e => /at most 6/.test(e.message));
  await assert.rejects(bad([]), e => e.code === "bad_request");
});

test("batch.parallel runs the steps together: the wall time is the slowest step, not the sum", async () => {
  const { ctx } = world();
  register({ name: "slow", ops: { "slow.read": async () => { await new Promise(r => setTimeout(r, 150)); return { ok: true }; } } });
  const { READING } = await import("./extension/shared/proto.js");
  READING.add("slow.read");
  try {
    const r = await dispatchT("batch.parallel", { steps: [1, 3].map(tab => ({ op: "slow.read", args: { tab } })) }, ctx);
    assert.equal(r.done, 2);
    assert.ok(r.ms < 260, "two 150 ms reads took " + r.ms + " ms");
  } finally { READING.delete("slow.read"); }
});
