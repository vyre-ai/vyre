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
    assert.deepEqual(ready.features, ["registered", "revoke", "code"], "the Worker says it answers ticket registrations, so a box can tell silence from an older relay");

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

  test(`the box's 4401 'device removed' reaches the device as it is said, and nothing else the box writes does${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const b = await box(rt);
    const ready = await b.s.json();
    for (const [code, reason, want] of [[CLOSE.refused, "device removed", { code: CLOSE.refused, reason: "device removed" }],
      [CLOSE.refused, "not a paired device", { code: CLOSE.boxGone, reason: "box closed the connection" }]]) {
      const dev = sock(rt, `/v1/device?route=${b.route}`);
      await dev.open();
      const { c } = await b.s.json();
      const data = sock(rt, `/v1/box?route=${b.route}&c=${c}&t=${ready.ticket}`);
      await data.open();
      await rt.settle();
      data.ws.close(code, reason);
      assert.deepEqual(await dev.closed(), want);
    }
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
    const ticket = Buffer.alloc(8, 7);
    const sealed = wire.ticketSeal(ticket, JSON.stringify({ v: 1, name: "alex", relay: BASE, route: b.route, box: "x".repeat(43), exp }));
    b.s.ws.send(JSON.stringify({ t: "ticket", loc: "a".repeat(43), record: sealed, mac: "b".repeat(43), exp }));
    await rt.settle();
    const stored = JSON.stringify([...rt.object("a".repeat(43), "TICKETS").ctx.storage.map.values()]);
    assert.doesNotMatch(stored, /alex|"route"/, "the PairTicket object holds ciphertext only");

    const res = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: "a".repeat(43) }) }), rt.env);
    assert.equal(res.status, 200);
    const data = /** @type {any} */ (await res.json());
    assert.equal(data.mac, "b".repeat(43));
    assert.equal(data.record, sealed, "handed back byte for byte");
    assert.equal(JSON.parse(wire.ticketOpen(ticket, data.record)).route, b.route);

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
  b.s.ws.send(JSON.stringify({ t: "ticket", loc: "d".repeat(43), record: "s".repeat(64), mac: "e".repeat(43), exp: Date.now() - 1000 }));
  await rt.settle();
  const expired = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: "d".repeat(43) }) }), rt.env);
  assert.equal(expired.status, 404, "a registration with an already-past exp is refused, not stored past its own TTL");
});

test("worker: a plaintext ticket record is refused at registration, so the relay never holds one", async t => {
  const rt = world(t);
  const b = await box(rt);
  await b.s.json();
  const exp = Date.now() + 60_000;
  b.s.ws.send(JSON.stringify({ t: "ticket", loc: "j".repeat(43), record: JSON.stringify({ v: 1, name: "alex" }), mac: "k".repeat(43), exp }));
  await rt.settle();
  const res = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: "j".repeat(43) }) }), rt.env);
  assert.equal(res.status, 404);
  // And the PairTicket object refuses one directly too, not only through the control socket.
  const direct = await rt.env.TICKETS.get(rt.env.TICKETS.idFromName("m".repeat(43))).fetch("https://ticket/register", { method: "PUT", body: JSON.stringify({ record: "{\"name\":\"alex\"}", mac: "k".repeat(43), exp }) });
  assert.equal(direct.status, 400);
});

test("worker: /v1/pair alone answers any origin, without credentials: the preflight, and every POST answer", async t => {
  const rt = world(t);
  const H = BASE.replace(/^ws/, "http");
  const pre = await worker.fetch(new Request(`${H}/v1/pair`, { method: "OPTIONS", headers: { origin: "https://phone.vyre.run", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }), rt.env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.equal(pre.headers.get("access-control-allow-methods"), "POST");
  assert.equal(pre.headers.get("access-control-allow-headers"), "content-type");
  assert.equal(pre.headers.get("access-control-allow-credentials"), null);
  const miss = await worker.fetch(new Request(`${H}/v1/pair`, { method: "POST", headers: { origin: "https://alex.vyre.run", "content-type": "application/json" }, body: JSON.stringify({ loc: "y".repeat(43) }) }), rt.env);
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get("access-control-allow-origin"), "*");
  const bad = await worker.fetch(new Request(`${H}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: "nope" }), rt.env);
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("access-control-allow-origin"), "*");
  for (const p of ["/health", "/v1/box", "/v1/device", "/nothing"]) {
    const r = await worker.fetch(new Request(`${H}${p}`, { headers: { origin: "https://phone.vyre.run" } }), rt.env);
    assert.equal(r.headers.get("access-control-allow-origin"), null, p);
  }
  const other = await worker.fetch(new Request(`${H}/v1/device`, { method: "OPTIONS", headers: { origin: "https://phone.vyre.run" } }), rt.env);
  assert.equal(other.headers.get("access-control-allow-origin"), null);
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
  for (let i = 0; i < 61; i++) b.s.ws.send(JSON.stringify({ t: "ticket", loc: loc(i), record: "s".repeat(64), mac: "g".repeat(43), exp: Date.now() + 60_000 }));
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
  b.s.ws.send(JSON.stringify({ t: "ticket", loc: "h".repeat(43), record: "s".repeat(64), mac: "i".repeat(43), exp }));
  await rt.settle();
  const obj = rt.object("h".repeat(43), "TICKETS");
  assert.equal(await obj.ctx.storage.getAlarm(), exp);
  await obj.run(inst => inst.alarm());
  assert.equal(obj.ctx.storage.map.size, 0, "the alarm cleans up an unresolved ticket");
});

// First writer wins, and the setup mailbox (tailnet plan 3.6, 3.6b), on the Worker: the same
// contract as relay/node/server.test.js, with the object thrown away after every event too.
const H = BASE.replace(/^ws/, "http");
const resolveLoc = (rt, loc) => worker.fetch(new Request(`${H}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) }), rt.env);
for (const hibernateEveryEvent of [false, true]) {
  const mode = hibernateEveryEvent ? " (hibernating after every event)" : "";
  test(`worker: a setup offer is first-writer-wins: 409 for another record, 200 for the identical one, contested for resolve${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const a = await box(rt), b = await box(rt);
    await a.s.json(); await b.s.json();
    const secret = Buffer.alloc(16, 5);
    const exp = Date.now() + 3_600_000;
    const rec1 = wire.ticketSeal(secret, JSON.stringify({ v: 1, name: "first" })), rec2 = wire.ticketSeal(secret, JSON.stringify({ v: 1, name: "second" }));
    const loc = "l".repeat(43), mac = "m".repeat(43);
    a.s.ws.send(JSON.stringify({ t: "setup", loc, record: rec1, mac, exp }));
    assert.deepEqual(await a.s.json(), { t: "registered", loc, status: 200 });
    a.s.ws.send(JSON.stringify({ t: "setup", loc, record: rec1, mac, exp }));
    assert.deepEqual(await a.s.json(), { t: "registered", loc, status: 200 }, "a reconnect re-sending is not a clash");
    const first = await resolveLoc(rt, loc);
    assert.equal(first.status, 200);
    assert.equal(/** @type {any} */ (await first.json()).record, rec1);
    assert.equal((await resolveLoc(rt, loc)).status, 200, "a setup offer is not single-use");
    assert.equal(rt.object(loc, "TICKETS").ctx.storage.alarmAt !== null && rt.object(loc, "TICKETS").ctx.storage.alarmAt > Date.now() + 3_000_000, true, "its alarm sweeps at its own hour, not five minutes");
    b.s.ws.send(JSON.stringify({ t: "setup", loc, record: rec2, mac, exp }));
    assert.deepEqual(await b.s.json(), { t: "registered", loc, status: 409 });
    const after = await resolveLoc(rt, loc);
    assert.equal(after.status, 409);
    assert.deepEqual(await after.json(), { error: "contested" });
  });

  test(`worker: Wink tickets are first-writer-wins too, and stay single-use${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent });
    const b = await box(rt);
    await b.s.json();
    const exp = Date.now() + 60_000;
    const one = wire.ticketSeal(Buffer.alloc(8, 1), "{}"), two = wire.ticketSeal(Buffer.alloc(8, 2), "{}");
    b.s.ws.send(JSON.stringify({ t: "ticket", loc: "t".repeat(43), record: one, mac: "m".repeat(43), exp }));
    assert.equal((await b.s.json()).status, 200);
    b.s.ws.send(JSON.stringify({ t: "ticket", loc: "t".repeat(43), record: two, mac: "m".repeat(43), exp }));
    assert.equal((await b.s.json()).status, 409);
    assert.equal((await resolveLoc(rt, "t".repeat(43))).status, 409);
    b.s.ws.send(JSON.stringify({ t: "ticket", loc: "u".repeat(43), record: one, mac: "m".repeat(43), exp }));
    assert.equal((await b.s.json()).status, 200);
    assert.equal((await resolveLoc(rt, "u".repeat(43))).status, 200);
    assert.equal((await resolveLoc(rt, "u".repeat(43))).status, 404);
  });

  test(`worker: the setup mailbox takes lines, only the page's key reads them, and a long poll waits${mode}`, async t => {
    const rt = world(t, { hibernateEveryEvent, env: { SETUP_POLL_MS: "20" } });
    const { createSetupKey, mailboxReader } = await import("../client/setup.js");
    const key = await createSetupKey();
    const secret = randomBytes(16);
    const loc = wire.setupDerive("loc", secret).toString("base64url");
    const fp = wire.setupFingerprint(Buffer.from(key.spki)).toString("base64url");
    const wtok = wire.setupDerive("mbxw", secret).toString("base64url");
    const post = (line, extra = {}) => worker.fetch(new Request(`${H}/v1/setup/mbx`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ loc, fp, wtok, ...(line === undefined ? {} : { line }), ...extra }) }), rt.env);
    const fetchThrough = (url, init) => worker.fetch(new Request(url, init), rt.env);
    const reader = await mailboxReader({ relay: BASE, secret, key, fetch: fetchThrough });
    assert.deepEqual(await reader.next(0), [], "nothing yet: no mailbox");
    assert.equal((await post(wire.mbxSeal(secret, 0, "Found your server"))).status, 200);
    const waiting = reader.next(5);
    assert.deepEqual(await waiting, ["Found your server"]);
    const late = reader.next(5);
    setTimeout(() => post(wire.mbxSeal(secret, 1, "Installing")), 60);
    assert.deepEqual(await late, ["Installing"], "the long poll returned when the line landed");
    assert.deepEqual(await reader.next(0), []);
    const stranger = await createSetupKey();
    await assert.rejects((await mailboxReader({ relay: BASE, secret, key: stranger, fetch: fetchThrough })).next(0), { code: "unauthorized" });
    await assert.rejects((await mailboxReader({ relay: BASE, secret, key, fetch: fetchThrough, now: () => Date.now() - 600_000 })).next(0), { code: "unauthorized" }, "a stale signature");
    // Contested: a second writer's token
    assert.equal((await post(wire.mbxSeal(secret, 0, "theirs"), { wtok: wire.setupDerive("mbxw", randomBytes(16)).toString("base64url") })).status, 409);
    assert.equal((await post(wire.mbxSeal(secret, 2, "mine"))).status, 409, "contested for the first writer too");
    await assert.rejects(reader.next(0), { code: "contested" });
    assert.equal((await resolveLoc(rt, loc)).status, 409, "and resolve says so");
  });
}

test("worker: the setup mailbox holds 64 KB, limits per address and per locator, has no global limit, and answers any origin", async t => {
  let allow = true, locAllow = true, globalSpent = 0;
  const limiter = fn => ({ limit: async () => ({ success: fn() }) });
  const rt = world(t, { env: { SETUP_LIMITER: limiter(() => allow), SETUP_LOC_LIMITER: limiter(() => locAllow), SETUP_LIMITER_GLOBAL: { limit: async () => { globalSpent++; return { success: false }; } }, SETUP_POLL_MS: "20" } });
  const loc = "z".repeat(43);
  const post = (line, extra = {}) => worker.fetch(new Request(`${H}/v1/setup/mbx`, { method: "POST", headers: { origin: "https://vyre.run" }, body: JSON.stringify({ loc, fp: "f".repeat(22), wtok: "w".repeat(43), ...(line ? { line } : {}), ...extra }) }), rt.env);
  const first = await post();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("access-control-allow-origin"), "*");
  const line = "A".repeat(1400);
  let last = 200, n = 0;
  while (last === 200 && n < 80) { last = (await post(line)).status; n++; }
  assert.equal(last, 413);
  assert.ok(n <= 47 && n >= 45, `64 KB of 1400-character lines, got ${n}`);
  assert.equal((await post("short")).status, 400);
  assert.equal((await worker.fetch(new Request(`${H}/v1/setup/mbx`, { method: "POST", body: "x".repeat(9000) }), rt.env)).status, 413);
  allow = false;
  assert.equal((await post()).status, 429, "per-address limiter");
  allow = true; locAllow = false;
  assert.equal((await post()).status, 429, "per-locator limiter");
  locAllow = true;
  assert.equal((await post()).status, 200, "a spent global budget (the old one, bound here as always-refusing) blocks nobody");
  assert.equal(globalSpent, 0, "no global limiter is consulted any more");
  assert.equal((await post(undefined, { loc: "y".repeat(43) })).status, 200, "another locator is unaffected");
  const pre = await worker.fetch(new Request(`${H}/v1/setup/mbx`, { method: "OPTIONS", headers: { origin: "https://vyre.run" } }), rt.env);
  assert.equal(pre.status, 204);
  assert.match(String(pre.headers.get("access-control-allow-headers")), /x-vyre-setup-key/);
  const badLoc = await worker.fetch(new Request(`${H}/v1/setup/mbx?loc=short`), rt.env);
  assert.equal(badLoc.status, 400);
});

test("worker: a box withdraws a ticket it registered (revoke), only its own, and a revoked locator resolves to nothing", async t => {
  const rt = world(t);
  const a = await box(rt), b = await box(rt);
  const ready = await a.s.json();
  assert.ok(ready.features.includes("revoke"), "the relay says it can withdraw a ticket");
  await b.s.json();
  const exp = Date.now() + 5 * 60_000, loc = "r".repeat(43);
  const sealed = wire.ticketSeal(Buffer.alloc(8, 5), JSON.stringify({ v: 1, name: "alex", relay: BASE, route: a.route, box: "x".repeat(43), exp }));
  a.s.ws.send(JSON.stringify({ t: "ticket", loc, record: sealed, mac: "b".repeat(43), exp }));
  assert.equal((await a.s.json()).status, 200);
  // another box cannot withdraw it
  b.s.ws.send(JSON.stringify({ t: "revoke", loc }));
  assert.deepEqual(await b.s.json(), { t: "revoked", loc, status: 404 });
  // its own can, once, and then nothing resolves
  a.s.ws.send(JSON.stringify({ t: "revoke", loc }));
  assert.deepEqual(await a.s.json(), { t: "revoked", loc, status: 200 });
  const gone = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) }), rt.env);
  assert.equal(gone.status, 404);
  // the withdrawn locator is a tombstone until its own exp: no other box registers it again, and it still resolves to nothing
  b.s.ws.send(JSON.stringify({ t: "ticket", loc, record: sealed, mac: "d".repeat(43), exp }));
  assert.equal((await b.s.json()).status, 409, "a revoked locator cannot be re-registered by an outsider");
  const still = await worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) }), rt.env);
  assert.equal(still.status, 404);
  a.s.ws.send(JSON.stringify({ t: "revoke", loc }));
  assert.equal((await a.s.json()).status, 404, "a second withdrawal finds nothing");
  // a setup offer is not a Wink ticket and is not withdrawn this way
  const sloc = "s".repeat(43);
  a.s.ws.send(JSON.stringify({ t: "setup", loc: sloc, record: sealed, mac: "c".repeat(43), exp }));
  assert.equal((await a.s.json()).status, 200);
  a.s.ws.send(JSON.stringify({ t: "revoke", loc: sloc }));
  assert.equal((await a.s.json()).status, 404);
});

test("worker: /v1/pair serves a hit and a contested ticket with no charge, charges only a miss to its own address, and has no global limit", async t => {
  const rt = world(t);
  const b = await box(rt);
  await b.s.json();
  const exp = Date.now() + 5 * 60_000, ticket = Buffer.alloc(8, 9);
  const sealed = wire.ticketSeal(ticket, JSON.stringify({ v: 1, name: "alex", relay: BASE, route: b.route, box: "x".repeat(43), exp }));
  b.s.ws.send(JSON.stringify({ t: "ticket", loc: "f".repeat(43), record: sealed, mac: "b".repeat(43), exp }));
  await rt.settle();
  let global = 0, charged = [];
  // the old global binding, bound here as always-refusing to prove it is never consulted
  rt.env.PAIR_LIMITER_GLOBAL = { limit: async () => { global++; return { success: false }; } };
  rt.env.PAIR_LIMITER = { limit: async ({ key }) => { charged.push(key); return { success: key !== "203.0.113.7" }; } };
  const resolve = (loc, ip = "203.0.113.5") => worker.fetch(new Request(`${BASE.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ loc }) }), rt.env);
  // an address that has spent its own miss budget still gets a real ticket resolved
  assert.equal((await resolve("g".repeat(43), "203.0.113.7")).status, 429, "its miss is refused");
  assert.equal((await resolve("f".repeat(43), "203.0.113.7")).status, 200, "its hit is served");
  assert.deepEqual(charged, ["203.0.113.7"], "only the miss was charged");
  // another address is unaffected by it, and a plain miss answers as a miss
  assert.equal((await resolve("h".repeat(43))).status, 404);
  assert.equal(global, 0, "a global limiter, if one is still bound, is never consulted");
});
