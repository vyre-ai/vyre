// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createRelay } from "./server.js";
import { newRouteKey, routeId, authMessage, signRoute, CLOSE, ticketSeal } from "../../core/relay/wire.js";

/** A WebSocket that queues what it receives, so a test can await the next message or the close. */
function sock(url) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const queue = [], waiters = [];
  let closed = null;
  const closeWaiters = [];
  ws.onmessage = e => {
    const v = typeof e.data === "string" ? e.data : Buffer.from(e.data);
    const w = waiters.shift();
    w ? w(v) : queue.push(v);
  };
  ws.onclose = e => { closed = { code: e.code, reason: e.reason }; closeWaiters.splice(0).forEach(f => f(closed)); };
  return {
    ws,
    open: () => new Promise((res, rej) => { ws.onopen = () => res(undefined); ws.onerror = rej; }),
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(res => waiters.push(res)),
    closed: () => closed ? Promise.resolve(closed) : new Promise(res => closeWaiters.push(res)),
    json: async function () { return JSON.parse(String(await this.next())); },
  };
}

async function box(base, key = newRouteKey(), route = routeId(key.pub)) {
  const s = sock(`${base}/v1/box?route=${route}`);
  await s.open();
  const ch = await s.json();
  assert.equal(ch.t, "challenge");
  s.ws.send(JSON.stringify({ t: "auth", pub: key.pub.toString("base64url"), sig: signRoute(key.priv, authMessage(route, Buffer.from(ch.n, "base64url"))).toString("base64url") }));
  return { s, route, key };
}

test("a box that signs its route is served, and device frames reach it both ways", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());

  const b = await box(base);
  const ready = await b.s.json();
  assert.equal(ready.t, "ready");

  const dev = sock(`${base}/v1/device?route=${b.route}`);
  await dev.open();
  dev.ws.send(new Uint8Array([1, 2, 3]));           // before the box's data socket: buffered
  const open = await b.s.json();
  assert.equal(open.t, "open");

  const data = sock(`${base}/v1/box?route=${b.route}&c=${open.c}&t=${ready.ticket}`);
  await data.open();
  assert.deepEqual([...await data.next()], [1, 2, 3]);
  data.ws.send(new Uint8Array([9]));
  assert.deepEqual([...await dev.next()], [9]);

  dev.ws.close();
  assert.deepEqual(await b.s.json(), { t: "close", c: open.c });
  assert.equal((await data.closed()).code, CLOSE.deviceGone);
});

test("a box with the wrong key, or a bad signature, is refused", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const real = newRouteKey();
  const route = routeId(real.pub);

  const imposter = await box(base, newRouteKey(), route);
  assert.equal((await imposter.s.closed()).code, CLOSE.refused);

  const s = sock(`${base}/v1/box?route=${route}`);
  await s.open();
  await s.json();
  s.ws.send(JSON.stringify({ t: "auth", pub: real.pub.toString("base64url"), sig: Buffer.alloc(64).toString("base64url") }));
  assert.equal((await s.closed()).code, CLOSE.refused);
  assert.equal(relay.stats().routes, 0);
});

test("an imposter cannot take a served route offline", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const b = await box(base);
  await b.s.json();
  const imposter = await box(base, newRouteKey(), b.route);
  await imposter.s.closed();
  const dev = sock(`${base}/v1/device?route=${b.route}`);
  await dev.open();
  assert.equal((await b.s.json()).t, "open", "the real box still gets devices");
});

test("a data socket needs the current ticket", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const b = await box(base);
  await b.s.json();
  const dev = sock(`${base}/v1/device?route=${b.route}`);
  await dev.open();
  const { c } = await b.s.json();
  const bad = sock(`${base}/v1/box?route=${b.route}&c=${c}&t=wrong-ticket-wrong-tick`);
  await bad.open();
  assert.equal((await bad.closed()).code, CLOSE.refused);
});

test("a device for a route with no box is told the box is offline", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const dev = sock(`${base}/v1/device?route=${routeId(newRouteKey().pub)}`);
  await dev.open();
  assert.equal((await dev.closed()).code, CLOSE.boxOffline);
});

test("waiting connections are capped per route", async t => {
  const relay = createRelay({ limits: { waiting: 2 } });
  const base = await relay.listen();
  t.after(() => relay.close());
  const b = await box(base);
  await b.s.json();
  const devs = [0, 1, 2].map(() => sock(`${base}/v1/device?route=${b.route}`));
  await Promise.all(devs.map(d => d.open()));
  assert.equal((await devs[2].closed()).code, CLOSE.busy);
});

test("a text ping is answered by the relay and never forwarded", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const b = await box(base);
  await b.s.json();
  b.s.ws.send("ping");
  assert.equal(await b.s.next(), "pong");
});

test("a pairing ticket's record must be sealed: a plaintext one is refused, a sealed one resolves once", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const b = await box(base);
  assert.equal((await b.s.json()).t, "ready");
  const exp = Date.now() + 60_000;
  const ticket = Buffer.alloc(8, 3);
  const sealed = ticketSeal(ticket, JSON.stringify({ v: 1, name: "alex", route: b.route }));
  b.s.ws.send(JSON.stringify({ t: "ticket", loc: "p".repeat(43), record: JSON.stringify({ v: 1, name: "alex" }), mac: "q".repeat(43), exp }));
  b.s.ws.send(JSON.stringify({ t: "ticket", loc: "r".repeat(43), record: sealed, mac: "q".repeat(43), exp }));
  const http = base.replace(/^ws/, "http");
  const resolve = loc => fetch(`${http}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) });
  // The two registrations ride one socket in order; poll the sealed one until it lands.
  let ok;
  for (let i = 0; i < 20 && !(ok = await resolve("r".repeat(43))).ok; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).record, sealed);
  assert.equal((await resolve("p".repeat(43))).status, 404, "the plaintext record was never stored");
});

test("/v1/pair alone answers any origin, without credentials: the preflight, and every POST answer", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const pre = await fetch(`${http}/v1/pair`, { method: "OPTIONS", headers: { origin: "https://phone.vyre.run", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.equal(pre.headers.get("access-control-allow-methods"), "POST");
  assert.equal(pre.headers.get("access-control-allow-headers"), "content-type");
  assert.equal(pre.headers.get("access-control-allow-credentials"), null);
  const miss = await fetch(`${http}/v1/pair`, { method: "POST", headers: { origin: "https://alex.vyre.run", "content-type": "application/json" }, body: JSON.stringify({ loc: "z".repeat(43) }) });
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get("access-control-allow-origin"), "*", "an error answer is readable too, so the phone sees ticket_gone");
  assert.equal(miss.headers.get("access-control-allow-credentials"), null);
  for (const p of ["/health", "/v1/box", "/v1/device", "/nothing"]) {
    const r = await fetch(`${http}${p}`, { headers: { origin: "https://phone.vyre.run" } });
    assert.equal(r.headers.get("access-control-allow-origin"), null, p);
  }
  const other = await fetch(`${http}/v1/device`, { method: "OPTIONS", headers: { origin: "https://phone.vyre.run" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null, "no preflight answer anywhere else");
});
