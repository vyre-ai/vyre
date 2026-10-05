// @ts-check
// Safe outside writes in the Flow runner's service step: an idempotency key per write (in the ledger before the call, sent to the provider when the connector declares support), a
// read-back that stops the Flow on a mismatch, a per-connector rate that makes the run sleep, the provider's Retry-After honoured, and a resume after a crash that finishes only
// what the ledger says is missing.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";
import { FlowRunner } from "./runner.js";
import { opFor, retryAfterMs, compareReadback, readbackRequest, takesKey } from "./safe-write.js";
import { serviceActionOf } from "./compile.js";

const svcFlow = (/** @type {any[]} */ steps) => ({ format: 1, name: "svc", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps });
const b64 = (/** @type {any} */ o) => Buffer.from(JSON.stringify(o)).toString("base64");
const json = (/** @type {any} */ o, status = 200, headers = {}) => ({ status, ok: status < 300, headers: { "content-type": "application/json", ...headers }, body: b64(o) });
const WRITE = { method: "POST", path: "/matters" };
const declare = (/** @type {any} */ w, /** @type {any} */ extra = {}) => {
  w.cat.connectors.practice = { ...w.cat.connectors.practice, allow: [{ method: "GET", path: "/matters/*" }, { method: "POST", path: "/matters" }], ...extra };
  w.kernel.rules.push({ match: (/** @type {any} */ i) => i.action === "service.call", effect: "allow", reason: "a standing yes" });
};
const RB = { method: "GET", path: "/matters/{id}", vars: { id: "response.json.id" }, compare: { client: "request.body.client" } };
const IDEM_OP = { name: "create_matter", ...WRITE, read: false, outward: true, readback: RB };
const KEY = { idempotency: { header: "Idempotency-Key" } };
const lastRun = async (/** @type {any} */ w, /** @type {string} */ id) => (await w.runner.listRuns({ flow: id }))[0];
const matter = [{ id: "w", kind: "service", connector: "practice", method: "POST", path: "/matters", body: { client: { expr: "trigger.n" } } }];

test("safe-write helpers: operations match by method and path, a key is taken only where the connector and the operation say, Retry-After reads seconds and dates, read-back fills its path and compares only what the write sent", () => {
  const rb = { method: "GET", path: "/matters/{id}", vars: { id: "response.json.data.id" }, compare: { "d.client": "request.body.client", "d.skip": "request.body.absent" } };
  const conn = { idempotency: { header: "Idempotency-Key" }, ops: [{ name: "get", method: "GET", path: "/matters/{id}", read: true }, { name: "new", method: "POST", path: "/matters", outward: true, readback: rb }, { name: "free", method: "POST", path: "/notes", idempotent: false }] };
  assert.equal(opFor(conn, "GET", "/matters/42").name, "get");
  assert.equal(opFor(conn, "POST", "/matters").name, "new");
  assert.equal(opFor(conn, "DELETE", "/matters/42"), null);
  assert.equal(opFor({ allow: [] }, "GET", "/x"), null, "no declaration, no operation");
  assert.equal(takesKey(conn, opFor(conn, "POST", "/matters")), true);
  assert.equal(takesKey(conn, opFor(conn, "POST", "/notes")), false, "an operation may opt out");
  assert.equal(takesKey({ ops: conn.ops }, opFor(conn, "POST", "/matters")), false, "a connector that declares no key support takes none");
  assert.equal(retryAfterMs({ "retry-after": "30" }, 0), 30_000);
  assert.equal(retryAfterMs({ "retry-after": new Date(10_000).toUTCString() }, 4_000), 6_000);
  assert.equal(retryAfterMs({}, 0), null);
  const op = opFor(conn, "POST", "/matters");
  assert.deepEqual(readbackRequest(op, { path: "/matters", body: { client: "R" } }, { data: { id: 7 } }), { method: "GET", path: "/matters/7" });
  assert.equal(readbackRequest(op, { path: "/matters", body: {} }, { nope: 1 }), null);
  assert.deepEqual(compareReadback(op, { path: "/matters", body: { client: "R" } }, { d: { client: "R" } }, { data: { id: 7 } }), { ok: true, mismatches: [] }, "d.skip was not sent, so it is not compared");
  assert.deepEqual(compareReadback(op, { path: "/matters", body: { client: "R" } }, { d: { client: "S" } }, { data: { id: 7 } }), { ok: false, mismatches: [{ field: "d.client", wrote: "R", read: "S" }] });
});

test("outward comes from the declared operation: an outward op is held, a read and a draft op (a write that is not outward) are not; an undeclared connector keeps the method rule", () => {
  const cat = { connectors: { g: { ops: [{ method: "POST", path: "/drafts", outward: false }, { method: "POST", path: "/send", outward: true }, { method: "GET", path: "/m/*", read: true }] }, plain: { allow: [] } } };
  assert.equal(serviceActionOf(cat, { connector: "g", method: "POST", path: "/drafts" }), "service.read");
  assert.equal(serviceActionOf(cat, { connector: "g", method: "POST", path: "/send" }), "service.call");
  assert.equal(serviceActionOf(cat, { connector: "g", method: "GET", path: "/m/1" }), "service.read");
  assert.equal(serviceActionOf(cat, { connector: "plain", method: "POST", path: "/x" }), "service.call");
});

test("a write's key and attempt are in the ledger BEFORE the call is made, the runner passes the key on (the vault adds the provider's header), and the read-back runs", async () => {
  /** @type {any[]} */ const seen = [];
  /** @type {any} */ let w; /** @type {any} */ let flowId;
  const port = async (/** @type {any} */ q) => {
    seen.push(q);
    if (q.request.method === "POST") { const run = await lastRun(w, flowId); seen.at(-1).ledger = JSON.parse(JSON.stringify(run.steps.w)); return json({ id: "m-9", client: q.request.body.client }); }
    return json({ id: "m-9", client: "Rivera" });
  };
  w = await world({ ports: { service: port } });
  declare(w, { ...KEY, ops: [IDEM_OP] });
  flowId = (await install(w, svcFlow(matter))).id;
  w.kernel.inbound("payment.received", { n: "Rivera" });
  await settle(w);
  const post = seen.find(s => s.request.method === "POST");
  assert.equal(post.request.headers, undefined, "the vault, not the runner, adds the provider's header");
  assert.equal(post.idem, post.ledger.idem);
  assert.ok(post.ledger.sent_at && post.ledger.attempts === 1 && post.ledger.idem, "recorded before the call");
  const run = await lastRun(w, flowId);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.deepEqual(run.steps.w.output.readback, { ok: true, path: "/matters/m-9", checked: 1 });
});

test("a connector that declares nothing at all keeps the old behaviour: no safe-write bookkeeping in the ledger", async () => {
  /** @type {any[]} */ const seen = [];
  const w2 = await world({ ports: { service: async (/** @type {any} */ q) => { seen.push(q); return json({ id: "m-2" }); } } });
  w2.cat.connectors.practice = { ...w2.cat.connectors.practice, allow: [{ method: "POST", path: "/matters" }] };
  w2.kernel.rules.push({ match: (/** @type {any} */ i) => i.action === "service.call", effect: "allow", reason: "yes" });
  await install(w2, svcFlow(matter));
  w2.kernel.inbound("payment.received", { n: "B" });
  await settle(w2);
  assert.equal(seen.length, 1);
  assert.equal((await lastRun(w2, (await w2.runner.listRuns({}))[0].flow)).steps.w.sent_at, undefined);
});

test("read-back: a record the provider kept differently stops the Flow, pauses it, writes nothing after, and puts a card in front of the owner", async () => {
  /** @type {any[]} */ const seen = [];
  const w = await world({ ports: { service: async (/** @type {any} */ q) => { seen.push(q); return q.request.method === "POST" ? json({ id: "m-5" }) : json({ id: "m-5", client: "Rivero" }); } } });
  declare(w, { ...KEY, ops: [IDEM_OP] });
  const { id } = await install(w, svcFlow([...matter, { id: "after", kind: "create", type: "payment", set: { client: "should not exist" } }]));
  w.kernel.inbound("payment.received", { n: "Rivera" });
  await settle(w);
  const run = await lastRun(w, id);
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "readback_mismatch", JSON.stringify(run.error));
  assert.match(run.error.message, /these fields differ: client/);
  assert.equal([...(w.kernel.tables.get("payment") || new Map()).values()].length, 0, "nothing ran after it");
  const card = w.kernel.tasks.find((/** @type {any} */ t) => t.form && t.form.kind === "readback_mismatch");
  assert.ok(card, "the owner is told");
  assert.equal(card.form.connector, "practice");
  assert.ok((await w.store.active(id)) === null || (await w.store.active(id)) === undefined, "the Flow is paused");
});

test("read-back: a write whose answer does not name the record, or a read that fails, is a mismatch too; a match passes", async () => {
  for (const [answer, readStatus, code] of [[{ nothing: 1 }, 200, "readback_mismatch"], [{ id: "m-6" }, 404, "readback_mismatch"], [{ id: "m-6" }, 200, null]]) {
    const w = await world({ ports: { service: async (/** @type {any} */ q) => (q.request.method === "POST" ? json(answer) : readStatus === 200 ? json({ id: "m-6", client: "Rivera" }) : json({}, 404)) } });
    declare(w, { ...KEY, ops: [IDEM_OP] });
    const { id } = await install(w, svcFlow(matter));
    w.kernel.inbound("payment.received", { n: "Rivera" });
    await settle(w);
    const run = await lastRun(w, id);
    if (code) assert.equal(run.error && run.error.code, code, JSON.stringify(run.error)); else assert.equal(run.state, "done", JSON.stringify(run.error));
  }
});

test("the vault gave up on a provider's rate limit (rate_limited, retryAfter): the run sleeps that long, the clock wakes it, and the same write is sent again with the same key", async () => {
  /** @type {any[]} */ const seen = [];
  const w = await world({ ports: { service: async (/** @type {any} */ q) => { seen.push(q); if (seen.length === 1) throw Object.assign(new Error("rate limited"), { code: "rate_limited", retryAfter: 45 }); return q.request.method === "POST" ? json({ id: "m-1" }) : json({ id: "m-1", client: "Rivera" }); } } });
  declare(w, { ...KEY, rate: { per_minute: 60, retry_after: true }, ops: [IDEM_OP] });
  const { id } = await install(w, svcFlow(matter));
  w.kernel.inbound("payment.received", { n: "Rivera" });
  await settle(w);
  let run = await lastRun(w, id);
  assert.equal(run.state, "waiting");
  assert.ok(run.waiting.wake_at - w.clock.t >= 44_000 && run.waiting.wake_at - w.clock.t <= 46_000);
  w.advance(46_000);
  await w.runner.tick(); await settle(w);
  run = await lastRun(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  const posts = seen.filter(q => q.request.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].idem, posts[1].idem, "the same key");
});

test("Retry-After: a 429 is waited out and the same write is sent again with the same key, once it is allowed", async () => {
  /** @type {any[]} */ const seen = [];
  const w = await world({ ports: { service: async (/** @type {any} */ q) => { seen.push(q); return seen.length === 1 ? json({ error: "slow down" }, 429, { "retry-after": "30" }) : q.request.method === "POST" ? json({ id: "m-8" }) : json({ id: "m-8", client: "Rivera" }); } } });
  declare(w, { ...KEY, ops: [IDEM_OP] });
  const { id } = await install(w, svcFlow(matter));
  w.kernel.inbound("payment.received", { n: "Rivera" });
  await settle(w);
  assert.equal(seen.length, 1);
  let run = await lastRun(w, id);
  assert.equal(run.state, "waiting");
  assert.ok(run.waiting.wake_at - w.clock.t >= 29_000 && run.waiting.wake_at - w.clock.t <= 31_000, "it waits what the provider said");
  w.advance(31_000);
  await w.runner.tick(); await settle(w);
  run = await lastRun(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  const posts = seen.filter(s => s.request.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].idem, posts[1].idem);
});

/** A second runner over the first one's store and kernel: what a restart builds. The first is left hanging mid-call, as a crash leaves it. */
function restarted(/** @type {any} */ w, /** @type {any} */ port) {
  const chains = { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.moduleChain({ module: "flows", approver: x.approver }) };
  return new FlowRunner({ kernel: w.kernel, store: w.store, catalog: () => w.cat, chains, clock: () => w.clock.t, emit: () => {}, ports: { roles: w.runner.ports.roles, service: port } });
}
const hang = () => new Promise(() => {});
const until = async (/** @type {() => Promise<any>} */ f) => { for (let i = 0; i < 100; i++) { const v = await f(); if (v) return v; await new Promise(r => setTimeout(r, 10)); } assert.fail("timed out"); };

test("resume after a crash, provider takes a key: the write is sent again with the SAME key and finishes; the ledger said it might have gone out", async () => {
  /** @type {any[]} */ const first = [], second = [];
  const w = await world({ ports: { service: (/** @type {any} */ q) => { first.push(q); return hang(); } } });
  declare(w, { ...KEY, ops: [IDEM_OP] });
  const { id } = await install(w, svcFlow(matter));
  w.kernel.inbound("payment.received", { n: "Rivera" });
  const run0 = await until(async () => { const r = await lastRun(w, id); return r && r.steps.w && r.steps.w.sent_at ? r : null; });
  assert.equal(run0.state, "running");
  const r2 = restarted(w, async (/** @type {any} */ q) => { second.push(q); return q.request.method === "POST" ? json({ id: "m-3" }) : json({ id: "m-3", client: "Rivera" }); });
  await r2.recover(); await r2.drain();
  const run = await lastRun(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(second.filter(q => q.request.method === "POST").length, 1);
  assert.equal(first[0].idem, second[0].idem, "the same key");
});

test("resume after a crash, provider takes no key: the write is NOT sent again, the owner is told, and a person's retry sends it", async () => {
  /** @type {any[]} */ const second = [];
  const w = await world({ ports: { service: () => hang() } });
  declare(w, { ops: [{ name: "create_matter", ...WRITE, read: false }] });
  const { id } = await install(w, svcFlow(matter));
  w.kernel.inbound("payment.received", { n: "Rivera" });
  await until(async () => { const r = await lastRun(w, id); return r && r.steps.w && r.steps.w.sent_at ? r : null; });
  const r2 = restarted(w, async (/** @type {any} */ q) => { second.push(q); return json({ id: "m-4" }); });
  await r2.recover(); await r2.drain();
  let run = await lastRun(w, id);
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "outcome_unknown", JSON.stringify(run.error));
  assert.equal(second.length, 0, "nothing was sent");
  await w.kernel.pump(); await w.kernel.idle();
  assert.ok(w.kernel.tasks.find((/** @type {any} */ t) => t.form && t.form.kind === "outcome_unknown"), "the owner is told: " + JSON.stringify(w.kernel.tasks.map((/** @type {any} */ t) => [t.title, t.form && t.form.kind])));
  await r2.retry(run.id); await r2.drain();
  run = await lastRun(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(second.length, 1);
});

test("resume after a crash between the write and its read-back: only the read-back is made; the write is not repeated", async () => {
  /** @type {any[]} */ const first = [], second = [];
  const w = await world({ ports: { service: (/** @type {any} */ q) => { first.push(q); return q.request.method === "POST" ? Promise.resolve(json({ id: "m-7" })) : hang(); } } });
  declare(w, { ops: [{ name: "create_matter", ...WRITE, read: false, readback: RB }] });
  const { id } = await install(w, svcFlow(matter));
  w.kernel.inbound("payment.received", { n: "Rivera" });
  await until(async () => first.some(q => q.request.method === "GET") ? true : null);
  const r2 = restarted(w, async (/** @type {any} */ q) => { second.push(q); return json({ id: "m-7", client: "Rivera" }); });
  await r2.recover(); await r2.drain();
  const run = await lastRun(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.deepEqual(second.map(q => q.request.method), ["GET"], "only the missing step ran");
});

test("SW-1: a 503 on a write with no idempotency key is sent ONCE and ends outcome_unknown with a card; with a key, or on a read, it waits and goes again", async () => {
  /** @type {any[]} */ const seen = [];
  const w = await world({ ports: { service: async (/** @type {any} */ q) => { seen.push(q); return seen.length === 1 ? json({}, 503, { "retry-after": "5" }) : json({ id: "m-1" }); } } });
  declare(w, { ops: [{ name: "create_matter", ...WRITE, read: false }] });
  const { id } = await install(w, svcFlow(matter));
  w.kernel.inbound("payment.received", { n: "Rivera" });
  await settle(w);
  w.advance(10_000); await w.runner.tick(); await settle(w);
  assert.equal(seen.filter(q => q.request.method === "POST").length, 1, "one POST, never two");
  const run = await lastRun(w, id);
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "outcome_unknown");
  await w.kernel.idle();
  assert.ok(w.kernel.tasks.find((/** @type {any} */ t) => t.form && t.form.kind === "outcome_unknown"), "the owner is told");
  // with a key the provider dedupes, so the resend is safe
  /** @type {any[]} */ const seen2 = [];
  const w2 = await world({ ports: { service: async (/** @type {any} */ q) => { seen2.push(q); return seen2.length === 1 ? json({}, 503, { "retry-after": "5" }) : q.request.method === "POST" ? json({ id: "m-1" }) : json({ id: "m-1", client: "Rivera" }); } } });
  declare(w2, { ...KEY, ops: [IDEM_OP] });
  const f2 = await install(w2, svcFlow(matter));
  w2.kernel.inbound("payment.received", { n: "Rivera" });
  await settle(w2);
  w2.advance(10_000); await w2.runner.tick(); await settle(w2);
  assert.equal((await lastRun(w2, f2.id)).state, "done");
  assert.equal(seen2.filter(q => q.request.method === "POST").length, 2);
});
