// @ts-check
// Sign in by name, the relay's part: a request mailbox per name. A box that serves a name says so on its control socket (signin.watch { loc }); a new device posts
// { loc, s } to /v1/signin and the relay hands it to those boxes. The answer to the new device is the same whether any box serves the name or not, and a name is asked
// about a few times a minute, never more.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRelay } from "./server.js";
import { newRouteKey, routeId, authMessage, signRoute } from "../../core/relay/wire.js";

function sock(/** @type {string} */ url) {
  const ws = new WebSocket(url);
  const queue = /** @type {string[]} */ ([]), waiters = /** @type {any[]} */ ([]);
  ws.onmessage = e => { const v = String(e.data); const w = waiters.shift(); w ? w(v) : queue.push(v); };
  return {
    ws,
    open: () => new Promise((res, rej) => { ws.onopen = () => res(undefined); ws.onerror = rej; }),
    next: (ms = 1500) => queue.length ? Promise.resolve(queue.shift()) : new Promise(res => { const t = setTimeout(() => res(null), ms); waiters.push((/** @type {string} */ v) => { clearTimeout(t); res(v); }); }),
    json: async function () { const v = await this.next(); return v ? JSON.parse(v) : null; },
  };
}
async function box(/** @type {string} */ base) {
  const key = newRouteKey(), route = routeId(key.pub);
  const s = sock(`${base}/v1/box?route=${route}`);
  await s.open();
  const ch = await s.json();
  s.ws.send(JSON.stringify({ t: "auth", pub: key.pub.toString("base64url"), sig: signRoute(key.priv, authMessage(route, Buffer.from(ch.n, "base64url"))).toString("base64url") }));
  assert.equal((await s.json()).t, "ready");
  return s;
}
const LOC = "a".repeat(43), SEED = "b".repeat(22);
const ask = (/** @type {string} */ base, /** @type {any} */ body) => fetch(`${base.replace(/^ws/, "http")}/v1/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a request reaches the box that serves the name, and the answer is the same when none does", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const b = await box(base);
  const none = await ask(base, { loc: "z".repeat(43), s: SEED });
  b.ws.send(JSON.stringify({ t: "signin.watch", loc: LOC }));
  await new Promise(r => setTimeout(r, 100));
  const served = await ask(base, { loc: LOC, s: SEED });
  assert.equal(served.status, none.status, "online or not, the same status");
  assert.deepEqual(await served.json(), await none.json(), "online or not, the same body");
  const got = await b.json();
  assert.deepEqual(got, { t: "signin.ask", loc: LOC, s: SEED });
});

test("a name is asked about a few times a minute, then refused in words", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await ask(base, { loc: LOC, s: SEED })).status);
  assert.deepEqual(codes.slice(0, 3), [202, 202, 202]);
  assert.equal(codes[5], 429);
  const r = await ask(base, { loc: LOC, s: SEED });
  assert.match(String((await r.json()).error), /wait a minute/);
});

test("a malformed request is refused and reaches no box", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const b = await box(base);
  b.ws.send(JSON.stringify({ t: "signin.watch", loc: LOC }));
  await new Promise(r => setTimeout(r, 100));
  for (const bad of [{}, { loc: "x", s: SEED }, { loc: LOC, s: "short" }, { loc: LOC }]) assert.equal((await ask(base, bad)).status, 400, JSON.stringify(bad));
  assert.equal(await b.next(300), null);
});

test("a watch ends when the box goes away", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const b = await box(base);
  b.ws.send(JSON.stringify({ t: "signin.watch", loc: LOC }));
  await new Promise(r => setTimeout(r, 100));
  b.ws.close();
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await ask(base, { loc: LOC, s: SEED })).status, 202, "still the same answer");
});
