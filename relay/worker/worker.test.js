// @ts-check
// The Cloudflare relay against a fake Workers runtime (fake-cf.js): the same behaviours as
// relay/node/server.test.js, each run twice, once with a live object and once with the object
// thrown away after every event (hibernation), plus core/relay/link.js's box side end to end.

import test from "node:test";
import assert from "node:assert/strict";
import worker, * as W from "./index.js";
import { createRuntime } from "./fake-cf.js";
import * as wire from "../../core/relay/wire.js";
import { relayLink } from "../../core/relay/link.js";
import { deviceSide } from "../../core/relay/channel.js";
import { keyPair } from "../../core/relay/noise.js";
import { randomBytes } from "node:crypto";

const BASE = "ws://relay.test";
const { newRouteKey, routeId, authMessage, signRoute, CLOSE } = wire;

/** @param {any} t @param {{ hibernateEveryEvent?: boolean, limits?: object, env?: object }} [o] */
function world(t, o = {}) {
  const rt = createRuntime({ worker, Class: W.RouteRelay, classes: { TICKETS: W.PairTicket }, hibernateEveryEvent: o.hibernateEveryEvent,
    env: { ...(o.limits ? { RELAY_LIMITS: JSON.stringify(o.limits) } : {}), ...(o.env || {}) } });
  t.after(async () => { await rt.settle(); assert.deepEqual(rt.errors.map(String), [], "no errors inside the Worker"); });
  return rt;
}

/** A WebSocket through the fake runtime that queues what it receives. */
function sock(rt, path, ip) {
  const ws = new rt.WebSocket(`${BASE}${path}`, ip);
  ws.binaryType = "arraybuffer";
  const queue = [], waiters = [], closeWaiters = [];
  let closed = null;
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
    queued: () => queue.length,
    closed: () => closed ? Promise.resolve(closed) : new Promise(res => closeWaiters.push(res)),
    isClosed: () => closed,
    json: async function () { return JSON.parse(String(await this.next())); },
  };
}

async function box(rt, key = newRouteKey(), route = routeId(key.pub)) {
  const s = sock(rt, `/v1/box?route=${route}`);
  await s.open();
  const ch = await s.json();
  assert.equal(ch.t, "challenge");
  s.ws.send(JSON.stringify({ t: "auth", pub: key.pub.toString("base64url"), sig: signRoute(key.priv, authMessage(route, Buffer.from(ch.n, "base64url"))).toString("base64url") }));
  return { s, route, key };
}

const live = (rt, route) => rt.object(route).ctx.getWebSockets().filter(ws => ws.deserializeAttachment()?.k !== "gone").length;

test("the Worker's constants and crypto match core/relay/wire.js", async () => {
  assert.equal(W.BOX_AUTH_TAG, wire.BOX_AUTH_TAG);
  assert.deepEqual({ ...W.LIMITS }, { ...wire.LIMITS });
  assert.deepEqual({ ...W.CLOSE }, { ...wire.CLOSE });
  assert.equal(String(W.ROUTE_RE), String(wire.ROUTE_RE));
  for (let i = 0; i < 5; i++) {
    const k = newRouteKey();
    const route = routeId(k.pub);
    assert.equal(await W.routeId(new Uint8Array(k.pub)), route);
    const n = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    const msg = authMessage(route, n);
    assert.deepEqual(Buffer.from(W.authMessage(route, new Uint8Array(n))), msg);
    const sig = signRoute(k.priv, msg);
    assert.equal(await W.verifyRoute(new Uint8Array(k.pub), new Uint8Array(msg), new Uint8Array(sig)), true);
    sig[0] ^= 1;
    assert.equal(await W.verifyRoute(new Uint8Array(k.pub), new Uint8Array(msg), new Uint8Array(sig)), false);
    assert.equal(W.b64url(new Uint8Array(sig)), sig.toString("base64url"));
    assert.deepEqual(Buffer.from(/** @type {Uint8Array} */ (W.unb64url(sig.toString("base64url")))), sig);
  }
  assert.equal(W.sameTicket("abc", "abc"), true);
  assert.equal(W.sameTicket("abc", "abd"), false);
  assert.equal(W.sameTicket("abc", "abcd"), false);
  assert.equal(W.sameTicket("", ""), false);
});

test("the Worker answers /health and refuses what is not a relay socket", async t => {
  const rt = world(t);
  const h = await rt.fetch("http://relay.test/health");
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true });
  assert.equal((await rt.fetch("http://relay.test/nope")).status, 404);
  const route = routeId(newRouteKey().pub);
  assert.equal((await rt.fetch(`http://relay.test/v1/box?route=${route}`)).status, 426);
  assert.equal((await rt.fetch("http://relay.test/v1/box?route=NOTAROUTE", { upgrade: "websocket" })).status, 400);
  assert.equal((await rt.fetch(`http://relay.test/v1/other?route=${route}`, { upgrade: "websocket" })).status, 400);
});

for (const hibernateEveryEvent of [false, true]) {
  const mode = hibernateEveryEvent ? " (hibernating after every event)" : "";

  test(`a box that signs its route is served, and device frames reach it both ways${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const b = await box(rt);
    const ready = await b.s.json();
    assert.equal(ready.t, "ready");
    assert.deepEqual(ready.waiting, []);

    const dev = sock(rt, `/v1/device?route=${b.route}`);
    await dev.open();
    dev.ws.send(new Uint8Array([1, 2, 3]));         // before the box's data socket: buffered
    dev.ws.send(new Uint8Array([4]));
    const open = await b.s.json();
    assert.equal(open.t, "open");
    await rt.settle();
    assert.ok([...rt.object(b.route).ctx.storage.map.keys()].every(k => k.startsWith(`b/${open.c}/`)));

    const data = sock(rt, `/v1/box?route=${b.route}&c=${open.c}&t=${ready.ticket}`);
    await data.open();
    assert.deepEqual([...await data.next()], [1, 2, 3]);
    assert.deepEqual([...await data.next()], [4]);
    assert.equal(rt.object(b.route).ctx.storage.map.size, 0, "delivered frames leave storage");
    data.ws.send(new Uint8Array([9]));
    assert.deepEqual([...await dev.next()], [9]);
    dev.ws.send(new Uint8Array([7, 7]));
    assert.deepEqual([...await data.next()], [7, 7]);

    dev.ws.close();
    assert.deepEqual(await b.s.json(), { t: "close", c: open.c });
    assert.equal((await data.closed()).code, CLOSE.deviceGone);
    await rt.settle();
    assert.equal(live(rt, b.route), 1, "only the control socket is left");
  });

  test(`a box with the wrong key, or a bad signature, is refused${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const real = newRouteKey();
    const route = routeId(real.pub);

    const imposter = await box(rt, newRouteKey(), route);
    assert.equal((await imposter.s.closed()).code, CLOSE.refused);

    const s = sock(rt, `/v1/box?route=${route}`);
    await s.open();
    await s.json();
    s.ws.send(JSON.stringify({ t: "auth", pub: real.pub.toString("base64url"), sig: Buffer.alloc(64).toString("base64url") }));
    assert.equal((await s.closed()).code, CLOSE.refused);

    const junk = sock(rt, `/v1/box?route=${route}`);
    await junk.open();
    await junk.json();
    junk.ws.send(new Uint8Array([1]));
    assert.equal((await junk.closed()).code, CLOSE.refused);
    await rt.settle();
    assert.equal(live(rt, route), 0);
  });

  test(`an imposter cannot take a served route offline${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const b = await box(rt);
    await b.s.json();
    const imposter = await box(rt, newRouteKey(), b.route);
    assert.equal((await imposter.s.closed()).code, CLOSE.refused);
    const dev = sock(rt, `/v1/device?route=${b.route}`);
    await dev.open();
    assert.equal((await b.s.json()).t, "open", "the real box still gets devices");
    assert.equal(b.s.isClosed(), null);
  });

  test(`a newer box replaces the older one, whose ticket stops working${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const first = await box(rt);
    const oldReady = await first.s.json();
    const second = await box(rt, first.key);
    const ready = await second.s.json();
    assert.equal(ready.t, "ready");
    assert.equal((await first.s.closed()).code, CLOSE.replaced);
    const dev = sock(rt, `/v1/device?route=${first.route}`);
    await dev.open();
    const { t: kind, c } = await second.s.json();
    assert.equal(kind, "open");
    const stale = sock(rt, `/v1/box?route=${first.route}&c=${c}&t=${oldReady.ticket}`);
    await stale.open();
    assert.equal((await stale.closed()).code, CLOSE.refused);
    const good = sock(rt, `/v1/box?route=${first.route}&c=${c}&t=${ready.ticket}`);
    await good.open();
    good.ws.send(new Uint8Array([5]));
    assert.deepEqual([...await dev.next()], [5]);
  });

  test(`a data socket needs the current ticket and a waiting connection${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const b = await box(rt);
    const ready = await b.s.json();
    const dev = sock(rt, `/v1/device?route=${b.route}`);
    await dev.open();
    const { c } = await b.s.json();
    const bad = sock(rt, `/v1/box?route=${b.route}&c=${c}&t=wrong-ticket-wrong-tick`);
    await bad.open();
    assert.equal((await bad.closed()).code, CLOSE.refused);
    const unknown = sock(rt, `/v1/box?route=${b.route}&c=nope&t=${ready.ticket}`);
    await unknown.open();
    assert.equal((await unknown.closed()).code, CLOSE.refused);
    const good = sock(rt, `/v1/box?route=${b.route}&c=${c}&t=${ready.ticket}`);
    await good.open();
    const twice = sock(rt, `/v1/box?route=${b.route}&c=${c}&t=${ready.ticket}`);
    await twice.open();
    assert.equal((await twice.closed()).code, CLOSE.refused, "a connection has one data socket");
    assert.equal(good.isClosed(), null);
  });

  test(`a device for a route with no box is told the box is offline${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const dev = sock(rt, `/v1/device?route=${routeId(newRouteKey().pub)}`);
    await dev.open();
    assert.equal((await dev.closed()).code, CLOSE.boxOffline);
  });

  test(`waiting and open connections are capped per route${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent, limits: { waiting: 2, open: 3 } });
    const b = await box(rt);
    const ready = await b.s.json();
    const devs = [0, 1, 2].map(() => sock(rt, `/v1/device?route=${b.route}`));
    await Promise.all(devs.map(d => d.open()));
    assert.equal((await devs[2].closed()).code, CLOSE.busy);
    const cs = [(await b.s.json()).c, (await b.s.json()).c];
    for (const c of cs) await sock(rt, `/v1/box?route=${b.route}&c=${c}&t=${ready.ticket}`).open();
    await rt.settle();
    const third = sock(rt, `/v1/device?route=${b.route}`);
    await third.open();
    assert.equal((await b.s.json()).t, "open", "two piped, one waiting: under both caps");
    const fourth = sock(rt, `/v1/device?route=${b.route}`);
    await fourth.open();
    assert.equal((await fourth.closed()).code, CLOSE.busy, "three open is the cap");
  });

  test(`a device that sends more than the buffer holds is closed, and the box is told${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent, limits: { buffered: 2 } });
    const b = await box(rt);
    await b.s.json();
    const dev = sock(rt, `/v1/device?route=${b.route}`);
    await dev.open();
    const { c } = await b.s.json();
    for (let i = 0; i < 3; i++) dev.ws.send(new Uint8Array([i]));
    assert.equal((await dev.closed()).code, CLOSE.busy);
    assert.deepEqual(await b.s.json(), { t: "close", c });
    await rt.settle();
    assert.equal(rt.object(b.route).ctx.storage.map.size, 0, "the buffer is gone with the device");
  });

  test(`a frame of 1 MiB is buffered in parts and delivered whole; a bigger one closes with 1009${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const b = await box(rt);
    const ready = await b.s.json();
    const dev = sock(rt, `/v1/device?route=${b.route}`);
    await dev.open();
    const { c } = await b.s.json();
    const big = new Uint8Array(randomBytes(W.LIMITS.frame));
    dev.ws.send(big);
    await rt.settle();
    assert.ok(rt.object(b.route).ctx.storage.map.size > 1, "split under the 128 KiB value limit");
    const data = sock(rt, `/v1/box?route=${b.route}&c=${c}&t=${ready.ticket}`);
    await data.open();
    assert.ok(Buffer.from(big).equals(await data.next()));
    dev.ws.send(new Uint8Array(W.LIMITS.frame + 1));
    assert.equal((await dev.closed()).code, CLOSE.tooBig);
    assert.equal((await data.closed()).code, CLOSE.deviceGone);
    assert.deepEqual(await b.s.json(), { t: "close", c });
  });

  test(`when the box closes a data socket, the device is closed with 4410${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const b = await box(rt);
    const ready = await b.s.json();
    const dev = sock(rt, `/v1/device?route=${b.route}`);
    await dev.open();
    const { c } = await b.s.json();
    const data = sock(rt, `/v1/box?route=${b.route}&c=${c}&t=${ready.ticket}`);
    await data.open();
    await rt.settle();
    data.ws.close(1000);
    assert.equal((await dev.closed()).code, CLOSE.boxGone);
    await rt.settle();
    assert.equal(b.s.queued(), 0, "no close message for a connection the box ended itself");
    assert.equal(live(rt, b.route), 1);
  });

  test(`a box that reconnects is told which connections are still waiting${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const b = await box(rt);
    await b.s.json();
    const dev = sock(rt, `/v1/device?route=${b.route}`);
    await dev.open();
    const { c } = await b.s.json();
    b.s.ws.close(1000);
    await b.s.closed();
    await rt.settle();
    const again = await box(rt, b.key);
    const ready = await again.s.json();
    assert.deepEqual(ready.waiting, [c]);
  });
}

test("a text ping is answered at the edge without waking the object", async t => {
  const rt = world(t);
  const b = await box(rt);
  await b.s.json();
  await rt.settle();
  rt.hibernate();
  const before = rt.constructed;
  b.s.ws.send("ping");
  assert.equal(await b.s.next(), "pong");
  const dev = sock(rt, `/v1/device?route=${b.route}`);
  await dev.open();
  dev.ws.send("ping");
  assert.equal(await dev.next(), "pong");
  assert.equal(rt.object(b.route).ctx.autoAnswered, 2);
  assert.equal(rt.constructed, before + 1, "only the device's connect woke it");
});

test("a whole connection survives hibernation between every step", async t => {
  const rt = world(t);
  const b = await box(rt);
  const ready = await b.s.json();
  await rt.settle(); rt.hibernate();
  const dev = sock(rt, `/v1/device?route=${b.route}`);
  await dev.open();
  const { c } = await b.s.json();
  await rt.settle(); rt.hibernate();
  dev.ws.send(new Uint8Array([1]));
  await rt.settle(); rt.hibernate();
  dev.ws.send(new Uint8Array([2]));
  await rt.settle(); rt.hibernate();
  const data = sock(rt, `/v1/box?route=${b.route}&c=${c}&t=${ready.ticket}`);
  await data.open();
  assert.deepEqual([...await data.next()], [1]);
  assert.deepEqual([...await data.next()], [2]);
  await rt.settle(); rt.hibernate();
  data.ws.send(new Uint8Array([3]));
  assert.deepEqual([...await dev.next()], [3]);
  await rt.settle(); rt.hibernate();
  dev.ws.close(1000);
  assert.deepEqual(await b.s.json(), { t: "close", c });
  assert.equal((await data.closed()).code, CLOSE.deviceGone);
  assert.ok(rt.constructed >= 6, "the object was rebuilt along the way");
});

test("per-address limiting at the Worker, when the rate limiting binding is present", async t => {
  const seen = new Map();
  const DEVICE_LIMITER = { limit: async ({ key }) => { seen.set(key, (seen.get(key) || 0) + 1); return { success: seen.get(key) <= 1 }; } };
  const rt = world(t, { env: { DEVICE_LIMITER } });
  const b = await box(rt);
  await b.s.json();
  const one = sock(rt, `/v1/device?route=${b.route}`, "198.51.100.1");
  await one.open();
  const two = sock(rt, `/v1/device?route=${b.route}`, "198.51.100.1");
  assert.equal((await two.closed()).code, 1006);
  assert.equal(/** @type {any} */ (two.ws).response.status, 429);
  const other = sock(rt, `/v1/device?route=${b.route}`, "198.51.100.2");
  await other.open();
  assert.equal(other.isClosed(), null);
});

for (const hibernateEveryEvent of [false, true]) {
  test(`core/relay/link.js serves a device through the Worker unchanged${hibernateEveryEvent ? " (hibernating after every event)" : ""}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const routeKey = newRouteKey();
    const route = routeId(routeKey.pub);
    const boxKey = keyPair();
    const link = relayLink({
      url: BASE, route, routeKey, boxKey, WebSocket: rt.WebSocket,
      admit: async (_pub, hello) => ({ ok: true, name: hello.name }),
      onchannel: channel => {
        channel.onstream = s => {
          const parts = [];
          s.ondata = b => parts.push(b);
          s.onend = () => { s.respond({ status: 200, headers: {} }); s.write(Buffer.concat(parts).reverse()); s.end(); };
        };
      },
    });
    t.after(() => link.stop());
    assert.equal(await link.ready(2000), true);

    const ws = new rt.WebSocket(`${BASE}/v1/device?route=${route}`);
    ws.binaryType = "arraybuffer";
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const side = deviceSide({ send: b => ws.send(b), close: (c, r) => ws.close(c, r) },
      { s: keyPair(), box: boxKey.pub, route, hello: { v: 1, name: "alex's phone" } });
    ws.onmessage = e => { if (typeof e.data !== "string") side.receive(Buffer.from(e.data)); };
    ws.onclose = e => side.gone(e.reason || "closed");
    const { channel, reply } = await side.ready;
    assert.deepEqual(reply, { ok: true, name: "alex's phone" });

    const body = await new Promise((resolve, reject) => {
      const s = channel.open({ method: "POST", path: "/echo", headers: {} });
      const parts = [];
      s.ondata = b => parts.push(b);
      s.onend = () => resolve(Buffer.concat(parts).toString());
      s.onreset = reject;
      s.write(Buffer.from("Northwind Bakery"));
      s.end();
    });
    assert.equal(body, "yrekaB dniwhtroN");
    assert.equal(link.open, 1);

    ws.close(1000);
    await rt.settle();
    await new Promise(r => setImmediate(r));
    assert.equal(link.open, 0, "the relay's close message ends the box's data socket");
  });
}

// Wink pairing tickets (ADR 0045): the box's control socket registers a locator/record/mac with
// its own PairTicket object; /v1/pair resolves it, single-use, same contract as
// relay/node/server.test.js's own ticket tests.
for (const hibernateEveryEvent of [false, true]) {
  test(`worker: a box registers a pairing ticket, /v1/pair resolves it once${hibernateEveryEvent ? " (hibernating after every event)" : ""}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const b = await box(rt);
    await b.s.json(); // "ready"
    const exp = Date.now() + 5 * 60_000;
    b.s.ws.send(JSON.stringify({ t: "ticket", loc: "a".repeat(43), record: JSON.stringify({ v: 1, name: "alex", relay: BASE, route: b.route, box: "x".repeat(43), exp }), mac: "b".repeat(43), exp }));
    await rt.settle();

    const res = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: "a".repeat(43) }) }), rt.env);
    assert.equal(res.status, 200);
    const data = /** @type {any} */ (await res.json());
    assert.equal(data.mac, "b".repeat(43));
    const record = JSON.parse(data.record);
    assert.equal(record.route, b.route);

    // Single-use: the same locator resolves nothing a second time.
    const again = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: "a".repeat(43) }) }), rt.env);
    assert.equal(again.status, 404);
  });
}

test("worker: /v1/pair 404s an unknown or expired locator, and never leaks the pairing secret", async t => {
  const rt = world(t);
  const unknown = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: "c".repeat(43) }) }), rt.env);
  assert.equal(unknown.status, 404);

  const b = await box(rt);
  await b.s.json();
  b.s.ws.send(JSON.stringify({ t: "ticket", loc: "d".repeat(43), record: JSON.stringify({ v: 1, name: "alex" }), mac: "e".repeat(43), exp: Date.now() - 1000 }));
  await rt.settle();
  const expired = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: "d".repeat(43) }) }), rt.env);
  assert.equal(expired.status, 404, "a registration with an already-past exp is refused, not stored past its own TTL");
});

test("worker: /v1/pair refuses a bad locator and a malformed body before ever asking a PairTicket object", async t => {
  const rt = world(t);
  const bad = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: "short" }) }), rt.env);
  assert.equal(bad.status, 400);
  const garbage = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: "not json" }), rt.env);
  assert.equal(garbage.status, 400);
});

test("worker: a control socket cannot register a ticket beyond the per-route cap", async t => {
  const rt = world(t);
  const b = await box(rt);
  await b.s.json();
  // A fixed-width, zero-padded index with a non-digit filler, so "f006" and "f060" can never
  // collide the way `f${i}`.padEnd(...,"0") would (i=6 and i=60 padded with "0" are the same
  // string).
  const loc = i => `f${String(i).padStart(3, "0")}`.padEnd(43, "z");
  for (let i = 0; i < 61; i++) b.s.ws.send(JSON.stringify({ t: "ticket", loc: loc(i), record: "{}", mac: "g".repeat(43), exp: Date.now() + 60_000 }));
  await rt.settle();
  // The 61st registration is over the cap; its locator resolves nothing.
  const over = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: loc(60) }) }), rt.env);
  assert.equal(over.status, 404);
  const under = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: loc(0) }) }), rt.env);
  assert.equal(under.status, 200, "under the cap still registers");
});

test("worker: an unresolved ticket sets an alarm at its own exp, which cleans it up either way", async t => {
  const rt = world(t);
  const b = await box(rt);
  await b.s.json();
  const exp = Date.now() + 60_000;
  b.s.ws.send(JSON.stringify({ t: "ticket", loc: "h".repeat(43), record: "{}", mac: "i".repeat(43), exp }));
  await rt.settle();
  const obj = rt.object("h".repeat(43), "TICKETS");
  assert.equal(await obj.ctx.storage.getAlarm(), exp);
  await obj.run(inst => inst.alarm());
  assert.equal(obj.ctx.storage.map.size, 0, "the alarm cleans up an unresolved ticket");
});
