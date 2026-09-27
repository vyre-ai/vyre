// @ts-check
// The box client (client.ts) over the box's own resilience code, with web.js's caller against a
// fake fetch and a fake open: no network. Imports client.ts through Node's type stripping, so it
// is skipped on a Node without it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { caller } from "../../../../core/resilience/web.js";
import { memoryStore } from "../../../../core/resilience/outbox.js";
import { backoff } from "../../../../core/resilience/backoff.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./client.ts");
const BOX = "https://harlow.example.ts.net";

/** @param {number} status @param {unknown} body */
const reply = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

/**
 * Swap the global fetch (web.js calls it) for `f` while `run` runs.
 * @param {(url: string, init: any) => Promise<Response>} f @param {() => Promise<void>} run
 */
async function withFetch(f, run) {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ ((u, init) => f(String(u), init));
  try { await run(); } finally { globalThis.fetch = real; }
}

/** @param {Partial<import("./client.ts").ClientDeps>} [o] */
async function client(o = {}) {
  const { createClient } = await load();
  let n = 0;
  return createClient({
    base: BOX,
    open: async () => ({ status: 200, chunks: (async function* () {})() }),
    caller,
    outboxStore: memoryStore(),
    newKey: () => `key-${++n}`,
    backoff: () => backoff({ min: 1, max: 1 }),
    ...o,
  });
}

/** A stream that stays open until its request is aborted. @param {AbortSignal} signal */
const hang = signal => new Promise(r => signal.addEventListener("abort", r));

/** @param {() => boolean} ok */
async function until(ok) { for (let i = 0; i < 500 && !ok(); i++) await new Promise(r => setTimeout(r, 2)); assert.ok(ok(), "timed out"); }

test("client: call posts JSON to /v1/tools/<tool> with the contract's headers", { skip: !strip }, async () => {
  /** @type {{url: string, init: any}[]} */ const seen = [];
  await withFetch(async (url, init) => { seen.push({ url, init }); return reply(200, { data: { ok: true } }); }, async () => {
    const c = await client();
    const r = await c.call("gate.list", { limit: 5 }, { presence: "device key=k ts=1 nonce=abcdefgh sig=s" });
    assert.deepEqual(r, { data: { ok: true } });
    c.stop();
  });
  assert.equal(seen[0].url, `${BOX}/v1/tools/gate.list`);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.body, '{"limit":5}');
  assert.equal(seen[0].init.headers["content-type"], "application/json");
  assert.equal(seen[0].init.headers["x-vyre-presence"], "device key=k ts=1 nonce=abcdefgh sig=s");
  assert.equal(seen[0].init.headers["idempotency-key"], undefined, "a read carries no key");
  assert.equal(seen[0].init.headers["x-vyre-caller"], undefined);
  assert.equal(seen[0].init.headers.origin, undefined);
});

test("client: errors come back as {error}, never thrown", { skip: !strip }, async () => {
  const refusal = { error: { code: "presence_required", message: "prove it", methods: ["device"] } };
  /** @type {() => Promise<Response>} */ let next = async () => reply(403, refusal);
  await withFetch(() => next(), async () => {
    const c = await client();
    assert.deepEqual(await c.call("gate.approve", { id: "a" }), refusal);
    next = async () => { throw new TypeError("offline"); };
    assert.equal((await c.call("gate.list")).error?.code, "unreachable");
    next = async () => reply(503, "restarting");
    assert.equal((await c.call("gate.list")).error?.code, "restarting");
    next = async () => reply(502, "<html>");
    assert.equal((await c.call("gate.list")).error?.code, "unreachable");
    c.stop();
  });
});

test("client: a write goes through the outbox with one Idempotency-Key across retries", { skip: !strip }, async () => {
  /** @type {any[]} */ const seen = [];
  /** @type {any[]} */ const changes = [];
  let fail = 2;
  await withFetch(async (url, init) => {
    seen.push({ url, init });
    if (fail-- > 0) throw new TypeError("no route to the box");
    return reply(200, { data: { sent: true } });
  }, async () => {
    const c = await client({ onOutbox: ch => changes.push(ch) });
    const { key, answered } = await c.send("threads.send", { thread: "juno", text: "Northwind Bakery order is in" });
    assert.equal(key, "key-1");
    assert.equal(changes[0].pending[0].state, "sending", "shown at once as sending");
    assert.deepEqual(await answered, { data: { sent: true } });
    assert.equal(c.pending.length, 0, "gone on the box's answer");
    c.stop();
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map(s => s.init.headers["idempotency-key"]), ["key-1", "key-1", "key-1"]);
  assert.ok(changes.some(ch => ch.pending[0]?.state === "waiting"), "kept while the box was out of reach");
  assert.deepEqual(changes.at(-1).done.data, { sent: true });
});

test("client: a write needing presence waits, then goes with the proof", { skip: !strip }, async () => {
  /** @type {any[]} */ const seen = [];
  await withFetch(async (url, init) => {
    seen.push(init.headers);
    return init.headers["x-vyre-presence"] ? reply(200, { data: { approved: true } }) : reply(403, { error: { code: "presence_required", message: "prove it" } });
  }, async () => {
    const c = await client();
    const { key, answered } = await c.send("gate.approve", { id: "g1" });
    await until(() => c.pending[0]?.state === "needs_presence");
    await c.prove(key, "device key=k ts=1 nonce=abcdefgh sig=s");
    assert.deepEqual(await answered, { data: { approved: true } });
    c.stop();
  });
  assert.equal(seen[1]["idempotency-key"], seen[0]["idempotency-key"]);
});

test("client: events resume with Last-Event-ID from the saved cursor", { skip: !strip }, async () => {
  /** @type {any[]} */ const opens = [];
  const bodies = ['id: 3\ndata: {"id":3,"type":"gate.held"}\n\n', 'id: 4\ndata: {"id":4,"type":"gate.sent"}\n\n'];
  /** @type {number[]} */ const saved = [];
  const c = await client({
    open: async req => {
      opens.push(req);
      const b = bodies.shift();
      return { status: 200, chunks: (async function* () { if (b) yield b; else await hang(req.signal); })() };
    },
    cursor: { load: async () => 2, save: n => saved.push(n) },
  });
  /** @type {number[]} */ const got = [];
  c.events(e => got.push(e.id));
  await until(() => opens.length >= 3);
  c.stop();
  assert.deepEqual(got, [3, 4]);
  assert.equal(opens[0].headers["last-event-id"], "2");
  assert.equal(opens[1].headers["last-event-id"], "3");
  assert.equal(opens[2].headers["last-event-id"], "4");
  assert.deepEqual(saved, [3, 4]);
});

test("client: auth headers ride on every call and stream open, signed per request", { skip: !strip }, async () => {
  /** @type {string[][]} */ const asked = [];
  const auth = {
    headers: async (/** @type {string} */ m, /** @type {string} */ u, /** @type {string} */ b) => { asked.push([m, u, b]); return { authorization: "Vyre abc", "x-vyre-proof": `sig-for-${m}` }; },
    required() {},
  };
  /** @type {any[]} */ const seen = [];
  /** @type {any[]} */ const opens = [];
  await withFetch(async (url, init) => { seen.push(init.headers); return reply(200, { data: 1 }); }, async () => {
    const c = await client({ auth, open: async req => { opens.push(req); return { status: 200, chunks: (async function* () { await hang(req.signal); })() }; } });
    await c.call("agents.list", { owner: "alex" });
    c.events(() => {});
    await until(() => opens.length === 1);
    c.stop();
  });
  assert.deepEqual(asked[0], ["POST", `${BOX}/v1/tools/agents.list`, '{"owner":"alex"}']);
  assert.equal(asked[1][0], "GET");
  assert.equal(asked[1][1], `${BOX}/v1/events/stream?type=*&since=latest`);
  assert.equal(seen[0].authorization, "Vyre abc");
  assert.equal(opens[0].headers["x-vyre-proof"], "sig-for-GET");
});
