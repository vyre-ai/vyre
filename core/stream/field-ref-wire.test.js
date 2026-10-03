// @ts-check
// A cited field (field-ref) on every wire form, and the deadline on a resolver that never answers (reviewer F-1, chat-03): the WebSocket form is
// tested in kernel.test.js; here the SSE form (serveSSE) and the relay duplex (testkit makeLink, a hop with its own delay), each per viewer, in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SessionLog } from "./log.js";
import { serve, serveSSE } from "./server.js";
import { connect } from "./client.js";
import { prng, Sched, makeLink } from "./testkit.js";

const FEE = { amount: 4200, currency: "USD" };
const ref = { block: "field-ref", record: "vyre://spc/matter/1", field: "fee", label: "Fee" };
/** A resolver as the kernel's records.get would answer: the manager gets the value, the member nothing. */
const resolverFor = (/** @type {string[]} */ roles) => async (/** @type {string} */ _record, /** @type {string} */ field) => (roles.includes("manager") ? { kind: "money", value: FEE } : (field ? null : null));
const MGR = { id: "person:bob", roles: ["manager"], resolve: resolverFor(["manager"]) };
const MEM = { id: "person:carol", roles: ["member"], resolve: resolverFor(["member"]) };

function filled() {
  const log = new SessionLog("s", { flushMs: 0 });
  log.append("text-delta", { message: "m1", index: 0, text: "The fee is" }, { author: "assistant:kit", acts_for: "person:bob" });
  log.append("text-done", { message: "m1", blocks: [ref] }, { author: "assistant:kit", acts_for: "person:bob" });
  log.append("text-delta", { message: "m2", index: 0, text: "Anything else?" }, { author: "assistant:kit", acts_for: "person:bob" });
  return log;
}
const cited = (/** @type {any[]} */ frames) => frames.find(f => f.type === "session.text-done").data.blocks[0];

/** Read an SSE response until the frame with `message` m2 has arrived. */
async function sse(/** @type {any} */ t, /** @type {SessionLog} */ log, /** @type {any} */ viewer) {
  const s = http.createServer((req, res) => { serveSSE(log, req, res, { from: 0, viewer }); });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { s.closeAllConnections(); s.close(); });
  const port = /** @type {any} */ (s.address()).port;
  const text = await new Promise(resolve => {
    let buf = "";
    const r = http.get({ port, host: "127.0.0.1", path: "/" }, res => { res.on("data", d => { buf += d; if (buf.includes("Anything else?")) { r.destroy(); resolve(buf); } }); });
    r.on("error", () => resolve(buf));
  });
  return { text: String(text), frames: String(text).split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5))).filter(f => f.type && f.type !== "session.heartbeat") };
}

test("SSE form: a cited field is the value for the manager and the chip for the member, in order, with no ref on either wire", async t => {
  const a = await sse(t, filled(), MGR), b = await sse(t, filled(), MEM);
  assert.deepEqual([cited(a.frames).block, cited(a.frames).value], ["field", FEE]);
  assert.equal(cited(b.frames).block, "field");
  assert.equal(cited(b.frames).placeholder, true);
  assert.ok(!b.text.includes("4200") && !b.text.includes("field-ref"));
  assert.ok(!a.text.includes("field-ref"));
  assert.deepEqual(a.frames.map(f => f.cur), b.frames.map(f => f.cur), "the same cursors, in order, for both");
  assert.deepEqual(a.frames.map(f => f.cur), [1, 2, 3]);
});

test("relay form: the same through a hop with its own delay; the member's side holds no value and the order holds", async () => {
  const run = async (/** @type {any} */ viewer) => {
    const sched = new Sched(), rnd = prng(7), log = filled();
    /** @type {any[]} */ const got = [];
    const c = connect({ open: makeLink({ log, sched, rnd, relay: true, faultRate: 0, serveOpts: { viewer } }), timers: sched, random: rnd, onFrame: f => got.push(f) });
    await sched.run(() => got.some(f => f.data && f.data.message === "m2" && f.type === "session.text-delta"), 20_000);
    c.close();
    return got;
  };
  const a = await run(MGR), b = await run(MEM);
  assert.deepEqual([cited(a).block, cited(a).value], ["field", FEE]);
  assert.equal(cited(b).placeholder, true);
  assert.ok(!JSON.stringify(b).includes("4200") && !JSON.stringify(b).includes("field-ref"));
  const cur = (/** @type {any[]} */ g) => g.map(f => f.cur).filter(n => n > 0);
  assert.deepEqual(cur(a), [1, 2, 3]);
  assert.deepEqual(cur(b), [1, 2, 3]);
});

test("F-1: a resolver that never answers costs the cited field a placeholder chip after the deadline, and the frames behind it keep their order", async () => {
  const log = filled();
  const hung = { id: "person:bob", roles: ["manager"], resolveMs: 60, resolve: () => new Promise(() => {}) };
  /** @type {any[]} */ const got = [];
  const t0 = Date.now();
  serve(log, { send: (/** @type {any} */ f) => got.push(JSON.parse(JSON.stringify(f))), onClose: () => {}, close: () => {} }, { from: 0, viewer: hung });
  const end = Date.now() + 3000;
  while (!got.some(f => f.type === "session.text-delta" && f.data.message === "m2") && Date.now() < end) await new Promise(r => setTimeout(r, 10));
  assert.ok(got.some(f => f.type === "session.text-delta" && f.data.message === "m2"), "the frame behind the stuck one still arrives");
  assert.ok(Date.now() - t0 < 2500);
  assert.equal(cited(got).block, "field");
  assert.equal(cited(got).placeholder, true, "the placeholder chip");
  assert.deepEqual(got.map(f => f.cur).filter(n => n > 0), [1, 2, 3], "in order");
});

test("F-1: the default deadline is 3 seconds", async () => {
  const { RESOLVE_MS } = await import("./viewer.js");
  assert.equal(RESOLVE_MS, 3000);
});
