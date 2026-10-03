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
  assert.deepEqual(ready.features, ["registered", "revoke", "code"], "the relay says it answers registrations, so a box can tell silence from an older relay");

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

// First writer wins (tailnet plan 3.6, N2): a locator taken with one record is not overwritten by
// another; the second writer hears 409 and the locator is contested for everyone. The identical
// record and mac again (a reconnect) is 200.
test("a setup offer's locator is first-writer-wins: 409 for another record, 200 for the identical one, contested for resolve", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const a = await box(base), b = await box(base);
  await a.s.json(); await b.s.json();
  const secret = Buffer.alloc(16, 5);
  const exp = Date.now() + 3_600_000;
  const rec1 = ticketSeal(secret, JSON.stringify({ v: 1, name: "first" })), rec2 = ticketSeal(secret, JSON.stringify({ v: 1, name: "second" }));
  const loc = "l".repeat(43), mac = "m".repeat(43);
  a.s.ws.send(JSON.stringify({ t: "setup", loc, record: rec1, mac, exp }));
  assert.deepEqual(await a.s.json(), { t: "registered", loc, status: 200 });
  a.s.ws.send(JSON.stringify({ t: "setup", loc, record: rec1, mac, exp }));
  assert.deepEqual(await a.s.json(), { t: "registered", loc, status: 200 }, "the identical record and mac is a reconnect, not a clash");
  const resolve = () => fetch(`${http}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) });
  const first = await resolve();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).record, rec1);
  assert.equal((await resolve()).status, 200, "a setup offer is not single-use: the page may reload");
  b.s.ws.send(JSON.stringify({ t: "setup", loc, record: rec2, mac, exp }));
  assert.deepEqual(await b.s.json(), { t: "registered", loc, status: 409 });
  const after = await resolve();
  assert.equal(after.status, 409);
  assert.deepEqual(await after.json(), { error: "contested" });
  a.s.ws.send(JSON.stringify({ t: "setup", loc, record: rec1, mac, exp }));
  assert.deepEqual(await a.s.json(), { t: "registered", loc, status: 409 }, "the first writer is told too once it is contested");
});

test("a setup offer is read as often as the page needs; a Wink ticket resolves once", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const b = await box(base);
  await b.s.json();
  const sealed = ticketSeal(Buffer.alloc(16, 1), "{}");
  const far = Date.now() + 24 * 3_600_000;
  b.s.ws.send(JSON.stringify({ t: "setup", loc: "s".repeat(43), record: sealed, mac: "m".repeat(43), exp: far }));
  b.s.ws.send(JSON.stringify({ t: "ticket", loc: "w".repeat(43), record: sealed, mac: "m".repeat(43), exp: far }));
  await b.s.json(); await b.s.json();
  const res = loc => fetch(`${http}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) });
  assert.equal((await res("s".repeat(43))).status, 200);
  assert.equal((await res("w".repeat(43))).status, 200);
  assert.equal((await res("w".repeat(43))).status, 404, "the Wink ticket is single-use as before");
});

test("Wink tickets are first-writer-wins too: a second, different register is refused and contests the locator", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const b = await box(base);
  await b.s.json();
  const exp = Date.now() + 60_000;
  const one = ticketSeal(Buffer.alloc(8, 1), "{}"), two = ticketSeal(Buffer.alloc(8, 2), "{}");
  b.s.ws.send(JSON.stringify({ t: "ticket", loc: "t".repeat(43), record: one, mac: "m".repeat(43), exp }));
  assert.equal((await b.s.json()).status, 200);
  b.s.ws.send(JSON.stringify({ t: "ticket", loc: "t".repeat(43), record: two, mac: "m".repeat(43), exp }));
  assert.equal((await b.s.json()).status, 409);
  const res = await fetch(`${http}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: "t".repeat(43) }) });
  assert.equal(res.status, 409);
});

test("the setup mailbox: per-address creation limit, a size cap and a global cap", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const post = (n, extra = {}) => fetch(`${http}/v1/setup/mbx`, { method: "POST", body: JSON.stringify({ loc: `${String(n).padStart(3, "0")}`.padEnd(43, "q"), fp: "f".repeat(22), wtok: "w".repeat(43), ...extra }) });
  for (let i = 0; i < 10; i++) assert.equal((await post(i)).status, 200, `mailbox ${i}`);
  assert.equal((await post(10)).status, 429, "the eleventh new mailbox from one address in an hour");
  assert.equal((await post(0)).status, 200, "an existing one still takes lines");
  // 64 KB total, per mailbox
  const line = "A".repeat(1400);
  let last = 200;
  for (let i = 0; i < 60 && last === 200; i++) last = (await post(0, { line })).status;
  assert.equal(last, 413, "a mailbox holds 64 KB and no more");
  assert.equal((await post(0, { line: "short" })).status, 400, "a line that is not a sealed line");
  const bad = await fetch(`${http}/v1/setup/mbx`, { method: "POST", body: "nope" });
  assert.equal(bad.status, 400);
  const pre = await fetch(`${http}/v1/setup/mbx`, { method: "OPTIONS", headers: { origin: "https://vyre.run" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(String(pre.headers.get("access-control-allow-headers")), /x-vyre-setup-sig/);
});

test("the setup mailbox has a global cap on live mailboxes, whoever asks", async t => {
  const relay = createRelay({ setup: { maxBoxes: 3, createPerIp: 100 } });
  const base = await relay.listen();
  t.after(() => relay.close());
  const post = n => fetch(`${base.replace(/^ws/, "http")}/v1/setup/mbx`, { method: "POST", body: JSON.stringify({ loc: String(n).padEnd(43, "q"), fp: "f".repeat(22), wtok: "w".repeat(43) }) });
  for (let i = 0; i < 3; i++) assert.equal((await post(i)).status, 200);
  assert.equal((await post(3)).status, 429);
  assert.equal((await post(1)).status, 200, "the ones already there keep working");
});

test("a box that closes a data socket with 4401 'device removed' tells the device exactly that; any other close is the generic 4410", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const b = await box(base);
  const ready = await b.s.json();
  for (const [code, reason, want] of [[CLOSE.refused, "device removed", { code: CLOSE.refused, reason: "device removed" }],
    [CLOSE.refused, "not a paired device", { code: CLOSE.boxGone, reason: "box closed the connection" }],
    [3456, "device removed", { code: CLOSE.boxGone, reason: "box closed the connection" }]]) {
    const dev = sock(`${base}/v1/device?route=${b.route}`);
    await dev.open();
    const { c } = await b.s.json();
    const data = sock(`${base}/v1/box?route=${b.route}&c=${c}&t=${ready.ticket}`);
    await data.open();
    data.ws.close(code, reason);
    assert.deepEqual(await dev.closed(), want, `${code} ${reason}`);
  }
});

test("a box withdraws a ticket it registered (revoke), only its own, never a setup offer, and a revoked locator resolves to nothing", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const a = await box(base), b = await box(base);
  assert.ok((await a.s.json()).features.includes("revoke"));
  await b.s.json();
  const secret = Buffer.alloc(8, 5), exp = Date.now() + 5 * 60_000;
  const rec = ticketSeal(secret, JSON.stringify({ v: 1, name: "alex" }));
  const loc = "k".repeat(43), mac = "m".repeat(43);
  a.s.ws.send(JSON.stringify({ t: "ticket", loc, record: rec, mac, exp }));
  assert.equal((await a.s.json()).status, 200);
  b.s.ws.send(JSON.stringify({ t: "revoke", loc }));
  assert.deepEqual(await b.s.json(), { t: "revoked", loc, status: 404 });
  a.s.ws.send(JSON.stringify({ t: "revoke", loc }));
  assert.deepEqual(await a.s.json(), { t: "revoked", loc, status: 200 });
  const gone = await fetch(`${http}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) });
  assert.equal(gone.status, 404);
  // the withdrawn locator is a tombstone until its own exp: nobody, not even another box, registers it again, and it still resolves to nothing
  b.s.ws.send(JSON.stringify({ t: "ticket", loc, record: rec, mac: "n".repeat(43), exp }));
  assert.equal((await b.s.json()).status, 409, "a revoked locator cannot be re-registered");
  a.s.ws.send(JSON.stringify({ t: "ticket", loc, record: rec, mac, exp }));
  assert.equal((await a.s.json()).status, 409, "not even by the box that withdrew it");
  assert.equal((await fetch(`${http}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) })).status, 404);
  const sloc = "j".repeat(43);
  a.s.ws.send(JSON.stringify({ t: "setup", loc: sloc, record: rec, mac, exp: Date.now() + 3_600_000 }));
  assert.equal((await a.s.json()).status, 200);
  a.s.ws.send(JSON.stringify({ t: "revoke", loc: sloc }));
  assert.equal((await a.s.json()).status, 404, "a setup offer is not withdrawn this way");
});

test("/v1/pair charges only misses to an address: a spent miss budget still resolves a real ticket, and there is no global limit", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const a = await box(base);
  await a.s.json();
  const resolve = loc => fetch(`${http}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) });
  let last = 0;
  for (let i = 0; i < 40; i++) last = (await resolve(`m${String(i).padStart(2, "0")}`.padEnd(43, "x"))).status;
  assert.equal(last, 429, "this address's misses ran out");
  const exp = Date.now() + 5 * 60_000, loc = "h".repeat(43);
  a.s.ws.send(JSON.stringify({ t: "ticket", loc, record: ticketSeal(Buffer.alloc(8, 3), JSON.stringify({ v: 1, name: "alex" })), mac: "m".repeat(43), exp }));
  assert.equal((await a.s.json()).status, 200);
  assert.equal((await resolve(loc)).status, 200, "a hit is served even with the miss budget spent");
});

// ---- the typed Wink code's rendezvous (spec 6.5) ----

const CODE_BODY = { error: "that code did not work" };
const step = (http, body, ip = "198.51.100.1") => fetch(`${http}/v1/wink/code`, { method: "POST", headers: { "content-type": "application/json", "x-test-ip": ip }, body: JSON.stringify(body) });
const byHeader = req => String(req.headers["x-test-ip"] || req.socket.remoteAddress);
const SID = "A".repeat(22);
/** A connected box that has asked for a code. */
async function codeBox(base, key) {
  const b = await box(base, key);
  await b.s.json();
  b.s.ws.send(JSON.stringify({ t: "code.alloc" }));
  const a = await b.s.json();
  return { ...b, a };
}

test("code: a box is given a free rendezvous for 5 minutes, one live code per box, and a new ask replaces the old", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const a = await codeBox(base);
  assert.equal(a.a.t, "code.allocated");
  assert.match(a.a.rv, /^[0-9A-HJKMNP-TV-Z]{2}$/);
  assert.ok(Math.abs(a.a.exp - (Date.now() + 5 * 60_000)) < 5000);
  assert.equal(relay.stats().codes, 1);
  a.s.ws.send(JSON.stringify({ t: "code.alloc" }));
  const again = await a.s.json();
  assert.equal(relay.stats().codes, 1, "one live code per box");
  const b = await codeBox(base);
  assert.notEqual(b.a.rv, again.rv, "two boxes never share a rendezvous");
  assert.equal(relay.stats().codes, 2);
  // Nothing allocated: a release frees it, and so does the box leaving.
  b.s.ws.send(JSON.stringify({ t: "code.release" }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(relay.stats().codes, 1);
  a.s.ws.close();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(relay.stats().codes, 0);
  void http;
});

test("code: the relay forwards a typist's message only to the route that holds the rendezvous, and its answer back", async t => {
  const relay = createRelay({ clientAddress: byHeader });
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const a = await codeBox(base), b = await codeBox(base);
  const p = step(http, { rv: a.a.rv, s: SID, n: 1, m: "Yfirst" });
  const got = await a.s.json();
  assert.deepEqual({ ...got, q: "q" }, { t: "code.msg", q: "q", rv: a.a.rv, s: SID, n: 1, m: "Yfirst" });
  // B's socket saw nothing, and B cannot answer A's request.
  b.s.ws.send(JSON.stringify({ t: "code.reply", q: got.q, m: "forged" }));
  await new Promise(r => setTimeout(r, 40));
  assert.equal(relay.stats().codeRequests, 1, "a reply from another route is ignored");
  a.s.ws.send(JSON.stringify({ t: "code.reply", q: got.q, m: "Ysecond" }));
  const res = await p;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { m: "Ysecond" });
  assert.equal(relay.stats().codeRequests, 0);
  const none = await Promise.race([b.s.next(), new Promise(r => setTimeout(() => r("quiet"), 50))]);
  assert.equal(none, "quiet", "the other box was never told");
});

test("code: unknown, released, expired, refused and silent all get the same answer, and a miss creates no state", async t => {
  const relay = createRelay({ clientAddress: byHeader, code: { waitMs: 150 } });
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const a = await codeBox(base);
  const free = [...("0123456789ABCDEFGHJKMNPQRSTVWXYZ")].map(c => c + "0").find(rv => rv !== a.a.rv) || "00";
  const out = [];
  out.push(await step(http, { rv: free, s: SID, n: 1, m: "Y" }, "198.51.100.10"));
  assert.equal(relay.stats().codes, 1, "an unknown rendezvous creates nothing");
  // refused by the box (no m)
  let p = step(http, { rv: a.a.rv, s: SID, n: 1, m: "Y" }, "198.51.100.11");
  let got = await a.s.json();
  a.s.ws.send(JSON.stringify({ t: "code.reply", q: got.q }));
  out.push(await p);
  // silent
  out.push(await step(http, { rv: a.a.rv, s: SID, n: 3, m: "Y" }, "198.51.100.12"));
  await a.s.json();
  // released
  a.s.ws.send(JSON.stringify({ t: "code.release" }));
  await new Promise(r => setTimeout(r, 30));
  out.push(await step(http, { rv: a.a.rv, s: SID, n: 1, m: "Y" }, "198.51.100.13"));
  // expired
  const b = await codeBox(base);
  const real = Date.now;
  Date.now = () => real() + 6 * 60_000;
  try { out.push(await step(http, { rv: b.a.rv, s: SID, n: 1, m: "Y" }, "198.51.100.14")); } finally { Date.now = real; }
  const bodies = [];
  for (const r of out) { assert.equal(r.status, 404); bodies.push(await r.json()); }
  for (const x of bodies) assert.deepEqual(x, CODE_BODY);
  assert.equal(relay.stats().codeRequests, 0);
});

test("code: the preflight answers any origin, a bad request is 400 whatever is live", async t => {
  const relay = createRelay({ clientAddress: byHeader });
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const pre = await fetch(`${http}/v1/wink/code`, { method: "OPTIONS", headers: { origin: "https://alex.vyre.run" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const a = await codeBox(base);
  for (const bad of [{ rv: "UU", s: SID, n: 1, m: "Y" }, { rv: a.a.rv, s: "short", n: 1, m: "Y" }, { rv: a.a.rv, s: SID, n: 2, m: "Y" }, { rv: a.a.rv, s: SID, n: 1, m: "" }, { rv: a.a.rv, s: SID, n: 1, m: "x".repeat(300) }, { rv: a.a.rv, s: SID, n: 1, m: "a b" }]) {
    assert.equal((await step(http, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(relay.stats().codeRequests, 0, "nothing was forwarded");
});

test("code: sessions are charged per address (10 a minute), another address is untouched, and there is no global budget", async t => {
  const relay = createRelay({ clientAddress: byHeader, code: { waitMs: 80 } });
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const a = await codeBox(base);
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await step(http, { rv: a.a.rv, s: SID, n: 1, m: "Y" }, "203.0.113.5")).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404), "ten sessions served (the silent box times out)");
  assert.deepEqual(statuses.slice(10), [429, 429], "the eleventh is refused");
  // Another address is served at once, and a spent address does not block it.
  const p = step(http, { rv: a.a.rv, s: SID, n: 1, m: "Y" }, "203.0.113.6");
  // drain the ten forwarded to the box, then answer the newest
  let last;
  for (let i = 0; i < 11; i++) last = await a.s.json();
  a.s.ws.send(JSON.stringify({ t: "code.reply", q: last.q, m: "Yb" }));
  assert.equal((await p).status, 200, "another address is not charged for this one's");
});

test("code: a miss is charged again to its own address (30 a minute), and a hit is still served after that", async t => {
  const relay = createRelay({ clientAddress: byHeader, code: { sessionPerMin: 1000, stepPerMin: 1000 } });
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const a = await codeBox(base);
  const free = "ZZ" === a.a.rv ? "ZY" : "ZZ";
  let last = 0;
  for (let i = 0; i < 40; i++) last = (await step(http, { rv: free, s: SID, n: 1, m: "Y" }, "203.0.113.9")).status;
  assert.equal(last, 429, "its misses ran out");
  const p = step(http, { rv: a.a.rv, s: SID, n: 1, m: "Y" }, "203.0.113.9");
  const got = await a.s.json();
  a.s.ws.send(JSON.stringify({ t: "code.reply", q: got.q, m: "Yb" }));
  assert.equal((await p).status, 200, "a live code is served to an address whose miss budget is spent");
  assert.equal((await step(http, { rv: free, s: SID, n: 1, m: "Y" }, "203.0.113.10")).status, 404, "another address still gets the plain miss");
});
