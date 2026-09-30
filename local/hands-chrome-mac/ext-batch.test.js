// @ts-check
// batch.run: ordered steps inside the worker, no host round trip, halting on stop, floor, failure
// and hold, with "$0.path" references.
import test from "node:test";
import assert from "node:assert/strict";
import { createCtx } from "./extension/lib/ctx.js";
import { dispatch, register } from "./extension/caps/index.js";
import { createFakeChrome, createFakePage, samplePage } from "./test-support/fake-chrome.js";

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
  const r = await dispatch("batch.run", { steps: [{ op: "probe.echo", args: { n: 1 } }, { op: "probe.echo", args: { n: 2 } }, { op: "probe.echo", args: { n: 3 } }] }, ctx);
  assert.deepEqual([r.ok, r.done, r.results.length], [true, 3, 3]);
  assert.deepEqual(calls.map(c => c.n), [1, 2, 3]);
});

test("$N.path references an earlier result; nothing else is interpreted", async () => {
  const { ctx } = world();
  const r = await dispatch("batch.run", { steps: [
    { op: "probe.echo", args: { a: 1 } },
    { op: "probe.echo", args: { id: "$0.nested.id", list: ["$0.nested.list", "$0.nested.list.1"], text: "$0 stays text", expr: "$0.value.a + 1", deep: { x: "$0.value.a" } } },
  ] }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(calls[1], { id: 7, list: [["a", "b"], "b"], text: "$0 stays text", expr: "$0.value.a + 1", deep: { x: 1 } });
});

test("a reference that does not resolve, or reaches a prototype, fails that step", async () => {
  const { ctx } = world();
  for (const bad of ["$0.nope", "$5.x", "$0.constructor", "$0.__proto__"]) {
    const r = await dispatch("batch.run", { steps: [{ op: "probe.echo", args: {} }, { op: "probe.echo", args: { v: bad } }] }, ctx);
    assert.deepEqual([r.ok, r.failedAt, r.code], [false, 1, "bad_request"], bad);
  }
  assert.equal(calls.filter(c => c.v).length, 0);
});

test("halts at the first failure and says which step", async () => {
  const { ctx } = world();
  const r = await dispatch("batch.run", { steps: [{ op: "probe.echo", args: { n: 1 } }, { op: "probe.fail" }, { op: "probe.echo", args: { n: 3 } }] }, ctx);
  assert.deepEqual([r.ok, r.done, r.failedAt, r.why, r.results.length], [false, 1, 1, "nope", 2]);
  assert.equal(calls.length, 1);
  const t = await dispatch("batch.run", { steps: [{ op: "probe.throw" }, { op: "probe.echo", args: {} }] }, ctx);
  assert.deepEqual([t.ok, t.failedAt, t.code, t.why], [false, 0, "error", "boom"]);
  const u = await dispatch("batch.run", { steps: [{ op: "nothing.here" }] }, ctx);
  assert.deepEqual([u.failedAt, u.code], [0, "unknown_op"]);
});

test("stopOnError:false keeps going", async () => {
  const { ctx } = world();
  const r = await dispatch("batch.run", { stopOnError: false, steps: [{ op: "probe.fail" }, { op: "probe.echo", args: { n: 2 } }] }, ctx);
  assert.deepEqual([r.ok, r.done, r.failedAt, r.results.length], [false, 1, 0, 2]);
});

test("stop is checked before every step: the person's Esc halts mid-batch", async () => {
  const { ctx } = world();
  register({ name: "stopper", ops: { "stopper.press": async () => { ctx.setStopped(true); return { ok: true }; } } });
  const r = await dispatch("batch.run", { steps: [{ op: "probe.echo", args: { n: 1 } }, { op: "stopper.press" }, { op: "probe.echo", args: { n: 3 } }] }, ctx);
  assert.deepEqual([r.ok, r.done, r.failedAt, r.code], [false, 2, 2, "stopped"]);
  assert.deepEqual(calls.map(c => c.n), [1]);
  // and while stopped, batch.run itself (an acting op) is refused outright
  await assert.rejects(dispatch("batch.run", { steps: [{ op: "probe.echo" }] }, ctx), { code: "stopped" });
  ctx.setStopped(false);
  assert.equal((await dispatch("batch.run", { steps: [{ op: "probe.echo", args: {} }] }, ctx)).ok, true);
});

test("the floor is checked before every step", async () => {
  const { ctx } = world();
  const r = await dispatch("batch.run", { steps: [
    { op: "page.snapshot", args: { tabId: 1 } },
    { op: "page.snapshot", args: { tabId: 2 } },
    { op: "page.snapshot", args: { tabId: 1 } },
  ] }, ctx);
  assert.deepEqual([r.ok, r.done, r.failedAt, r.code], [false, 1, 1, "blocked"]);
});

test("a held step halts the batch and hands the hold back", async () => {
  const { ctx, fake } = world();
  const r = await dispatch("batch.run", { steps: [
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
  await assert.rejects(dispatch("batch.run", {}, ctx), { code: "bad_request" });
  await assert.rejects(dispatch("batch.run", { steps: [] }, ctx), { code: "bad_request" });
  await assert.rejects(dispatch("batch.run", { steps: new Array(201).fill({ op: "probe.echo" }) }, ctx), { code: "bad_request" });
  const r = await dispatch("batch.run", { steps: [{ op: "batch.run", args: { steps: [{ op: "probe.echo" }] } }] }, ctx);
  assert.deepEqual([r.ok, r.code], [false, "bad_request"]);
  const s = await dispatch("batch.run", { steps: [{ args: {} }] }, ctx);
  assert.equal(s.ok, false);
});
