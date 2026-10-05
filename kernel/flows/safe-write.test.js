// @ts-check
// Safe outside writes in the Flow runner's service step: an idempotency key per write (in the ledger before the call, sent to the provider when the connector declares support), a
// read-back that stops the Flow on a mismatch, a per-connector rate that makes the run sleep, the provider's Retry-After honoured, and a resume after a crash that finishes only
// what the ledger says is missing.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";
import { FlowRunner } from "./runner.js";
import { opFor, retryAfterMs, compareReadback, readbackPath, providerKey, keyPlacement, ConnectorRate } from "./safe-write.js";

const svcFlow = (/** @type {any[]} */ steps) => ({ format: 1, name: "svc", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps });
const b64 = (/** @type {any} */ o) => Buffer.from(JSON.stringify(o)).toString("base64");
const json = (/** @type {any} */ o, status = 200, headers = {}) => ({ status, ok: status < 300, headers: { "content-type": "application/json", ...headers }, body: b64(o) });
const WRITE = { method: "POST", path: "/matters" };
const declare = (/** @type {any} */ w, /** @type {any} */ extra = {}) => {
  w.cat.connectors.practice = { ...w.cat.connectors.practice, allow: [{ method: "GET", path: "/matters/*" }, { method: "POST", path: "/matters" }], ...extra };
  w.kernel.rules.push({ match: (/** @type {any} */ i) => i.action === "service.call", effect: "allow", reason: "a standing yes" });
};
const IDEM_OP = { name: "create_matter", ...WRITE, outward: true, idem: { header: "Idempotency-Key" }, readback: { path: "/matters/{id}", id: "id", match: { client: "client" } } };
const lastRun = async (/** @type {any} */ w, /** @type {string} */ id) => (await w.runner.listRuns({ flow: id }))[0];
const matter = [{ id: "w", kind: "service", connector: "practice", method: "POST", path: "/matters", body: { client: { expr: "trigger.n" } } }];

test("safe-write helpers: operations match by method and path, the key is opaque and placed as declared, Retry-After reads seconds and dates, read-back compares only paired fields", () => {
  const conn = { ops: [{ name: "get", method: "GET", path: "/matters/{id}", read: true }, { name: "new", method: "POST", path: "/matters", idem: { header: "Idempotency-Key" } }] };
  assert.equal(opFor(conn, "GET", "/matters/42").name, "get");
  assert.equal(opFor(conn, "POST", "/matters").name, "new");
  assert.equal(opFor(conn, "DELETE", "/matters/42"), null);
  assert.equal(opFor({ allow: [] }, "GET", "/x"), null, "no declaration, no operation");
  const k = providerKey("run_abc:w");
  assert.match(k, /^vyre-[0-9a-f]{32}$/);
  assert.equal(providerKey("run_abc:w"), k);
  assert.ok(!k.includes("run_abc"));
  assert.deepEqual(keyPlacement({ idem: { header: "Idempotency-Key" } }, k), { headers: { "Idempotency-Key": k } });
  assert.deepEqual(keyPlacement({ idem: { param: "request_id" } }, k), { query: { request_id: k } });
  assert.deepEqual(keyPlacement({}, k), {});
  assert.equal(retryAfterMs({ "retry-after": "30" }, 0), 30_000);
  assert.equal(retryAfterMs({ "retry-after": new Date(10_000).toUTCString() }, 4_000), 6_000);
  assert.equal(retryAfterMs({}, 0), null);
  assert.equal(readbackPath({ path: "/matters/{id}", id: "data.id" }, { data: { id: 7 } }), "/matters/7");
  assert.equal(readbackPath({ path: "/matters/{id}", id: "data.id" }, { nope: 1 }), null);
  assert.deepEqual(compareReadback({ match: { "d.client": "client" } }, { client: "Rivera", extra: 1 }, { d: { client: "Rivera", other: 2 } }), { ok: true, diffs: [] });
  assert.deepEqual(compareReadback({ match: { client: "client" } }, { client: "Rivera" }, { client: "Rivero" }), { ok: false, diffs: ["client"] });
  const r = new ConnectorRate();
  assert.equal(r.wait("c", { per_min: 2 }, 1000), 0); r.note("c", 1000); r.note("c", 2000);
  assert.equal(r.wait("c", { per_min: 2 }, 3000), 58_000, "the third waits until the first is a minute old");
  assert.equal(r.wait("c", { per_min: 2 }, 61_001), 0);
  assert.equal(r.wait("c", undefined, 3000), 0, "no declared rate, no wait");
});

test("a write carries the provider's idempotency key as declared, and the ledger holds the key and the attempt BEFORE the call is made", async () => {
  /** @type {any[]} */ const seen = [];
  /** @type {any} */ let w; /** @type {any} */ let flowId;
  const port = async (/** @type {any} */ q) => {
    seen.push(q);
    if (q.request.method === "POST") { const run = await lastRun(w, flowId); seen.at(-1).ledger = JSON.parse(JSON.stringify(run.steps.w)); return json({ id: "m-9", client: q.request.body.client }); }
    return json({ id: "m-9", client: "Rivera" });
  };
  w = await world({ ports: { service: port } });
  declare(w, { ops: [IDEM_OP] });
  flowId = (await install(w, svcFlow(matter))).id;
  w.kernel.inbound("payment.received", { n: "Rivera" });
  await settle(w);
  const post = seen.find(s => s.request.method === "POST");
  assert.match(post.request.headers["Idempotency-Key"], /^vyre-[0-9a-f]{32}$/);
  assert.ok(post.ledger.sent_at && post.ledger.attempts === 1 && post.ledger.idem, "recorded before the call");
  const run = await lastRun(w, flowId);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.deepEqual(run.steps.w.output.readback, { ok: true, path: "/matters/m-9", checked: 1 });
});

test("a connector that declares no idempotency support gets no key header, and one that declares nothing at all keeps the old behaviour", async () => {
  /** @type {any[]} */ const seen = [];
  const w = await world({ ports: { service: async (/** @type {any} */ q) => { seen.push(q); return json({ id: "m-1" }); } } });
  declare(w, { ops: [{ name: "create_matter", ...WRITE }] });
  await install(w, svcFlow(matter));
  w.kernel.inbound("payment.received", { n: "A" });
  await settle(w);
  assert.equal(seen[0].request.headers, undefined);
  const w2 = await world({ ports: { service: async (/** @type {any} */ q) => { seen.push(q); return json({ id: "m-2" }); } } });
  w2.cat.connectors.practice = { ...w2.cat.connectors.practice, allow: [{ method: "POST", path: "/matters" }] };
  w2.kernel.rules.push({ match: (/** @type {any} */ i) => i.action === "service.call", effect: "allow", reason: "yes" });
  await install(w2, svcFlow(matter));
  w2.kernel.inbound("payment.received", { n: "B" });
  await settle(w2);
  assert.equal(seen.length, 2);
  assert.equal((await lastRun(w2, (await w2.runner.listRuns({}))[0].flow)).steps.w.sent_at, undefined, "an undeclared connector has no safe-write bookkeeping");
});

test("read-back: a record the provider kept differently stops the Flow, pauses it, writes nothing after, and puts a card in front of the owner", async () => {
  /** @type {any[]} */ const seen = [];
  const w = await world({ ports: { service: async (/** @type {any} */ q) => { seen.push(q); return q.request.method === "POST" ? json({ id: "m-5" }) : json({ id: "m-5", client: "Rivero" }); } } });
  declare(w, { ops: [IDEM_OP] });
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
    declare(w, { ops: [IDEM_OP] });
    const { id } = await install(w, svcFlow(matter));
    w.kernel.inbound("payment.received", { n: "Rivera" });
    await settle(w);
    const run = await lastRun(w, id);
    if (code) assert.equal(run.error && run.error.code, code, JSON.stringify(run.error)); else assert.equal(run.state, "done", JSON.stringify(run.error));
  }
});

test("a connector's per-minute rate makes the run sleep until the next call is allowed, and the clock wakes it", async () => {
  /** @type {number[]} */ const at = [];
  /** @type {any} */ let w;
  w = await world({ ports: { service: async () => { at.push(w.clock.t); return json({ id: "x" }); } } });
  declare(w, { rate: { per_min: 2 }, ops: [{ name: "get", method: "GET", path: "/matters/{id}", read: true }] });
  const { id } = await install(w, svcFlow([1, 2, 3].map(n => ({ id: `g${n}`, kind: "service", connector: "practice", method: "GET", path: `/matters/${n}` }))));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  assert.equal(at.length, 2, "two calls went, the third is held back");
  let run = await lastRun(w, id);
  assert.equal(run.state, "waiting");
  assert.equal(run.waiting.kind, "time");
  const start = at[0];
  assert.ok(run.waiting.wake_at >= start + 59_000, "it sleeps for about the rest of the minute");
  w.advance(61_000);
  await w.runner.tick(); await settle(w);
  assert.equal(at.length, 3);
  run = await lastRun(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.ok(at[2] - at[0] >= 60_000, "never more than two calls in a minute");
});

test("Retry-After: a 429 is waited out and the same write is sent again with the same key, once it is allowed", async () => {
  /** @type {any[]} */ const seen = [];
  const w = await world({ ports: { service: async (/** @type {any} */ q) => { seen.push(q); return seen.length === 1 ? json({ error: "slow down" }, 429, { "retry-after": "30" }) : q.request.method === "POST" ? json({ id: "m-8" }) : json({ id: "m-8", client: "Rivera" }); } } });
  declare(w, { ops: [IDEM_OP] });
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
  assert.equal(posts[0].request.headers["Idempotency-Key"], posts[1].request.headers["Idempotency-Key"], "the same key");
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
  declare(w, { ops: [IDEM_OP] });
  const { id } = await install(w, svcFlow(matter));
  w.kernel.inbound("payment.received", { n: "Rivera" });
  const run0 = await until(async () => { const r = await lastRun(w, id); return r && r.steps.w && r.steps.w.sent_at ? r : null; });
  assert.equal(run0.state, "running");
  const r2 = restarted(w, async (/** @type {any} */ q) => { second.push(q); return q.request.method === "POST" ? json({ id: "m-3" }) : json({ id: "m-3", client: "Rivera" }); });
  await r2.recover(); await r2.drain();
  const run = await lastRun(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(second.filter(q => q.request.method === "POST").length, 1);
  assert.equal(first[0].request.headers["Idempotency-Key"], second[0].request.headers["Idempotency-Key"]);
});

test("resume after a crash, provider takes no key: the write is NOT sent again, the owner is told, and a person's retry sends it", async () => {
  /** @type {any[]} */ const second = [];
  const w = await world({ ports: { service: () => hang() } });
  declare(w, { ops: [{ name: "create_matter", ...WRITE }] });
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
  declare(w, { ops: [{ name: "create_matter", ...WRITE, readback: IDEM_OP.readback }] });
  const { id } = await install(w, svcFlow(matter));
  w.kernel.inbound("payment.received", { n: "Rivera" });
  await until(async () => first.some(q => q.request.method === "GET") ? true : null);
  const r2 = restarted(w, async (/** @type {any} */ q) => { second.push(q); return json({ id: "m-7", client: "Rivera" }); });
  await r2.recover(); await r2.drain();
  const run = await lastRun(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.deepEqual(second.map(q => q.request.method), ["GET"], "only the missing step ran");
});
