// @ts-check
// The box client against a fake fetch: no network. Imports client.ts through Node's type
// stripping, so it is skipped on a Node without it.

import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./client.ts");

/** @param {number} status @param {unknown} body @param {Record<string,string>} [headers] */
function reply(status, body, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

test("client: call posts JSON to /v1/tools/<tool> with the contract's headers", { skip: !strip }, async () => {
  const { call, configure } = await load();
  /** @type {{url: string, init: any}[]} */ const seen = [];
  configure({ baseUrl: "https://vyre.example.ts.net/", fetch: async (u, init) => { seen.push({ url: String(u), init }); return reply(200, { data: { ok: true } }); } });
  const r = await call("gate.list", { limit: 5 }, { presence: "device key=k ts=1 nonce=abcdefgh sig=s" });
  assert.deepEqual(r, { data: { ok: true } });
  assert.equal(seen[0].url, "https://vyre.example.ts.net/v1/tools/gate.list");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.body, '{"limit":5}');
  assert.equal(seen[0].init.headers["content-type"], "application/json");
  assert.equal(seen[0].init.headers["x-vyre-presence"], "device key=k ts=1 nonce=abcdefgh sig=s");
  assert.equal(seen[0].init.headers["x-vyre-caller"], undefined);
  assert.equal(seen[0].init.headers.origin, undefined);
});

test("client: errors come back as {error}, never thrown", { skip: !strip }, async () => {
  const { call, configure } = await load();
  configure({ baseUrl: "", fetch: async () => reply(403, { error: { code: "presence_required", message: "prove it", methods: ["device"] } }) });
  assert.deepEqual(await call("gate.approve", { id: "a" }), { error: { code: "presence_required", message: "prove it", methods: ["device"] } });
  configure({ fetch: async () => { throw new TypeError("offline"); } });
  assert.equal((await call("gate.list")).error?.code, "network");
  configure({ fetch: async () => reply(502, "<html>") });
  assert.equal((await call("gate.list")).error?.code, "bad_response");
});

test("client: a presence session the box opened lands in meta", { skip: !strip }, async () => {
  const { call, configure } = await load();
  configure({ baseUrl: "", fetch: async () => reply(200, { data: 1 }, { "x-vyre-presence-session": "session id=s secret=x expires=9" }) });
  /** @type {{session?: string}} */ const meta = {};
  await call("vault.reveal", { name: "northwind" }, { keep: true }, meta);
  assert.equal(meta.session, "session id=s secret=x expires=9");
});

test("client: events resumes with Last-Event-ID after the stream drops", { skip: !strip }, async () => {
  const { events, configure } = await load();
  /** @type {{url: string, headers: Record<string,string>}[]} */ const opens = [];
  const frames = ['id: 3\nevent: gate.held\ndata: {"id":3,"type":"gate.held"}\n\n', 'id: 4\nevent: gate.sent\ndata: {"id":4,"type":"gate.sent"}\n\n'];
  configure({
    baseUrl: "",
    fetch: async (u, init) => {
      opens.push({ url: String(u), headers: /** @type {any} */ (init?.headers) });
      const body = frames.shift();
      if (!body) return new Response(new ReadableStream({ start() {} }), { status: 200 });
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200 });
    },
  });
  /** @type {number[]} */ const got = [];
  const sub = events(e => got.push(e.id), { retryMs: 1 });
  while (opens.length < 3) await new Promise(r => setTimeout(r, 2));
  sub.close();
  assert.deepEqual(got, [3, 4]);
  assert.match(opens[0].url, /since=latest/);
  assert.equal(opens[0].headers["last-event-id"], undefined);
  assert.equal(opens[1].headers["last-event-id"], "3");
  assert.equal(opens[2].headers["last-event-id"], "4");
  assert.equal(sub.lastId(), 4);
});
