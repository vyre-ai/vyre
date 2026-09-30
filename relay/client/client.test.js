// @ts-check
// The client's connection over an in-memory relay (testing.js), with node:test's fake timers:
// reconnect and backoff, keepalive and stalls, hidden pages, the Idempotency-Key retry, SSE
// resume and dedupe, and the pairing URL.
import test from "node:test";
import assert from "node:assert/strict";
import { connect, parsePairUrl, keyFingerprint, resolveTicket } from "./client.js";
import { webCrypto, memoryKeyStore } from "./webcrypto.js";
import { memoryBox, serveWith, reply, settle, ROUTE } from "./testing.js";
import { pairUrl, parsePairUrl as boxParse } from "../../core/relay/pairing.js";
import { base32 as boxBase32, ticketDerive, ticketMac, ticketSeal } from "../../core/relay/wire.js";
import { base64url, base32 } from "./bytes.js";
import crypto2 from "node:crypto";

const crypto = webCrypto();

function visible() {
  let hidden = false;
  const fns = new Set();
  return { hidden: () => hidden, on(fn) { fns.add(fn); return () => fns.delete(fn); }, set(h) { hidden = h; for (const f of fns) f(); } };
}

function setup(t, world, extra = {}) {
  const vis = visible();
  const conn = connect({ relay: "ws://relay.test", route: ROUTE, box: base64url(world.box.pub), keyStore: memoryKeyStore(), crypto,
    WebSocket: world.WebSocket, visibility: vis, random: () => 0.5, ...extra });
  const states = [];
  conn.onstate = s => states.push(s);
  t.after(() => conn.close());
  return { conn, vis, states };
}

test("client: the pairing URL parses exactly as the box's parser does", () => {
  const box = Buffer.alloc(32, 9);
  const url = pairUrl({ relay: "wss://relay.vyre.run", route: ROUTE, box, secret: "s3cret", name: "juno" });
  const mine = /** @type {any} */ (parsePairUrl(url)), theirs = /** @type {any} */ (boxParse(url));
  assert.deepEqual({ ...mine, box: Buffer.from(mine.box) }, theirs);
  for (const bad of ["https://vyre.run/pair", "https://example.com/pair#" + url.split("#")[1], url.slice(0, -4), "https://vyre.run/pair#!!"]) assert.equal(parsePairUrl(bad), null, bad);
});

test("client: reconnects with backoff and a fresh handshake each time", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const world = memoryBox({ serve: serveWith((s, h) => reply(s, 200, { path: h.path })) });
  const { conn, states } = setup(t, world);
  await settle(() => conn.state === "open");
  const hash1 = Buffer.from(/** @type {any} */ (conn.channel).hash).toString("hex");
  world.down = true;
  world.sockets.at(-1).drop(1006);
  await settle(() => conn.state === "offline");
  // 1 s, then 2 s, then 4 s: each attempt fails while the relay is down.
  t.mock.timers.tick(999); await settle();
  assert.equal(world.dials, 1);
  t.mock.timers.tick(1); await settle(() => world.dials === 2);
  t.mock.timers.tick(1999); await settle();
  assert.equal(world.dials, 2);
  world.down = false;
  t.mock.timers.tick(1); await settle(() => conn.state === "open");
  assert.equal(world.dials, 3);
  assert.notEqual(Buffer.from(/** @type {any} */ (conn.channel).hash).toString("hex"), hash1, "a new session");
  assert.equal((await (await conn.fetch("/v1/health")).json()).path, "/v1/health");
  assert.deepEqual(states.filter((s, i) => s !== states[i - 1]).slice(0, 3), ["open", "offline", "connecting"]);
});

test("client: backoff caps at 60 s", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const world = memoryBox({ serve: () => {} });
  world.down = true;
  const { conn } = setup(t, world);
  await settle(() => world.dials === 1 && conn.state === "offline");
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(60_000); await settle(() => world.dials === i + 2); }
  const before = world.dials;
  t.mock.timers.tick(59_999); await settle();
  assert.equal(world.dials, before, "no attempt sooner than 60 s");
  t.mock.timers.tick(1); await settle(() => world.dials === before + 1);
});

test("client: pings at most every 60 s; two missed pongs are a stall and it reconnects", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const world = memoryBox({ serve: () => {} });
  const { conn } = setup(t, world);
  await settle(() => conn.state === "open");
  const ws = world.sockets[0];
  t.mock.timers.tick(59_999); await settle();
  assert.equal(ws.pings, 0);
  t.mock.timers.tick(1); await settle();
  assert.equal(ws.pings, 1);
  t.mock.timers.tick(60_000); await settle();
  assert.equal(ws.pings, 2);
  assert.equal(conn.state, "open", "answered pings keep it open");
  world.pong = false;
  t.mock.timers.tick(60_000); await settle();     // ping 3 goes unanswered
  t.mock.timers.tick(60_000); await settle();     // one missed; ping 4
  assert.equal(conn.state, "open");
  t.mock.timers.tick(60_000); await settle(() => conn.state !== "open");  // two missed: a stall
  assert.equal(ws.readyState, 3);
  world.pong = true;
  t.mock.timers.tick(1000); await settle(() => conn.state === "open");
  assert.equal(world.dials, 2);
});

test("client: nothing keeps alive or reconnects while hidden; coming back reconnects at once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const world = memoryBox({ serve: () => {} });
  const { conn, vis } = setup(t, world);
  await settle(() => conn.state === "open");
  vis.set(true);
  t.mock.timers.tick(300_000); await settle();
  assert.equal(world.sockets[0].pings, 0, "no keepalive while hidden");
  world.sockets[0].drop(1006);
  await settle(() => conn.state === "offline");
  t.mock.timers.tick(600_000); await settle();
  assert.equal(world.dials, 1, "no reconnect while hidden");
  vis.set(false);
  await settle(() => conn.state === "open");
  assert.equal(world.dials, 2);
});

test("client: a POST whose response was lost is sent once more on the next channel, with the same Idempotency-Key", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const keys = [];
  let drops = 1;
  const world = memoryBox({ serve: serveWith((s, h, body) => {
    keys.push([h.method, h.headers["idempotency-key"] ?? null, body.toString()]);
    if (h.method === "POST" && drops-- > 0) { world.sockets.at(-1).drop(1006); return; }
    reply(s, 200, { ok: true });
  }) });
  const { conn } = setup(t, world);
  await settle(() => conn.state === "open");
  const pending = conn.fetch("/v1/tools/notes.add", { method: "POST", body: JSON.stringify({ text: "Northwind Bakery order" }), headers: { "content-type": "application/json" } });
  await settle(() => conn.state === "offline");
  t.mock.timers.tick(1000);
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(keys.length, 2);
  assert.match(String(keys[0][1]), /^[0-9a-f-]{36}$/);
  assert.equal(keys[1][1], keys[0][1], "the retry carries the same key");
  assert.equal(keys[1][2], keys[0][2], "and the same body");
  // A key the caller chose is kept; a GET gets none.
  await (await conn.fetch("/x", { method: "PUT", headers: { "Idempotency-Key": "kit-1" } })).text();
  await (await conn.fetch("/y")).text();
  assert.deepEqual(keys.slice(2).map(k => k[1]), ["kit-1", null]);
  // Only once: a second loss is the caller's to handle.
  drops = 2;
  const twice = conn.fetch("/v1/tools/notes.add", { method: "POST", body: "{}" });
  twice.catch(() => {});
  await settle(() => conn.state === "offline");
  t.mock.timers.tick(1000); await settle(() => conn.state === "offline" && world.dials === 3);
  await assert.rejects(twice, /connection lost/);
});

test("client: an event stream resumes with Last-Event-ID after a drop and drops replayed ids", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const opens = [];
  /** @type {any} */
  let live = null;
  const world = memoryBox({ serve: serveWith((s, h) => {
    opens.push(h.headers["last-event-id"] ?? null);
    s.respond({ status: 200, headers: { "content-type": "text/event-stream" } });
    s.write(Buffer.from(": open\n\n"));
    // A server that replays one event too many on resume: the client must drop it.
    if (h.headers["last-event-id"] === "2") s.write(Buffer.from("id: 2\nevent: note\ndata: {\"n\":2}\n\nid: 3\nevent: note\ndata: {\"n\":3}\n\n"));
    live = s;
  }) });
  const { conn } = setup(t, world);
  const got = [];
  const ev = conn.events("/v1/events/stream", { onEvent: e => got.push([e.id, e.event, JSON.parse(e.data).n]) });
  await settle(() => live !== null);
  live.write(Buffer.from("id: 1\nevent: note\ndata: {\"n\":1}\n\nid: 2\nevent: note\n"));
  live.write(Buffer.from("data: {\"n\":2}\n\n"));
  await settle(() => got.length === 2);
  world.sockets.at(-1).drop(1006);
  live = null;
  await settle(() => conn.state === "offline");
  t.mock.timers.tick(2000);                        // the reconnect at 1 s, the stream's retry at 2 s
  await settle(() => got.length === 3);
  assert.deepEqual(opens, [null, "2"]);
  assert.deepEqual(got, [["1", "note", 1], ["2", "note", 2], ["3", "note", 3]]);
  assert.equal(ev.lastEventId, "3");
  ev.close();
});

test("client: 45 s without a byte is a dead stream; it reopens from the cursor", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const opens = [];
  /** @type {any} */
  let live = null;
  const world = memoryBox({ serve: serveWith((s, h) => {
    opens.push(h.headers["last-event-id"] ?? null);
    s.respond({ status: 200, headers: { "content-type": "text/event-stream" } });
    s.write(Buffer.from("id: 7\ndata: x\n\n"));
    live = s;
  }) });
  const { conn } = setup(t, world);
  const got = [];
  conn.events("/v1/events/stream", { onEvent: e => got.push(e.id) });
  await settle(() => got.length === 1);
  t.mock.timers.tick(45_000);
  await settle();
  assert.equal(opens.length, 1);
  t.mock.timers.tick(2000);                        // the stream's retry hint
  await settle(() => opens.length === 2);
  assert.deepEqual(opens, [null, "7"]);
  assert.deepEqual(got, ["7"], "the replayed id is dropped");
});

test("client: a refused device learns why and keeps retrying quietly", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const world = memoryBox({ serve: () => {}, admit: async () => { throw new Error("not a paired device"); } });
  const { conn } = setup(t, world);
  await settle(() => conn.lastError !== null);
  assert.match(String(conn.lastError?.message), /not a paired device/);
  assert.equal(conn.state, "offline");
});

test("client: base32 and keyFingerprint match core/relay/wire.js's own byte for byte (ADR 0045)", async () => {
  const buf = crypto2.randomBytes(37);
  assert.equal(base32(buf), boxBase32(buf), "the same RFC 4648 lowercase, no-padding alphabet");

  const box = crypto2.randomBytes(32);
  const want = boxBase32(crypto2.createHash("sha256").update(box).digest()).slice(0, 8);
  const fp = await keyFingerprint(box, crypto);
  assert.equal(fp, `${want.slice(0, 4)} ${want.slice(4)}`, "reads identically to the box's own Touch ID prompt fingerprint");
});

test("client: resolveTicket opens a record the box sealed, with WebCrypto (the phone's own provider)", async () => {
  const ticket = crypto2.randomBytes(8);
  const box = crypto2.randomBytes(32);
  const record = ticketSeal(ticket, JSON.stringify({ v: 1, name: "alex", handle: "alex", identity: null, relay: "wss://relay.vyre.run", route: ROUTE, box: box.toString("base64url"), exp: Date.now() + 60_000 }));
  const mac = ticketMac(ticket, record).toString("base64url");
  let sent;
  const fetch = async (_url, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ record, mac }) }; };
  const r = await resolveTicket(new Uint8Array(ticket), { relay: "wss://relay.vyre.run", fetch, crypto: webCrypto() });
  assert.equal(sent.loc, ticketDerive("loc", ticket).toString("base64url"));
  assert.equal(r.name, "alex");
  assert.equal(r.offer.route, ROUTE);
  assert.equal(r.offer.secret, ticketDerive("sec", ticket).toString("base64url"));
  assert.notEqual(ticketSeal(ticket, "same"), ticketSeal(ticket, "same"), "a fresh random nonce each seal, never a fixed one");
});
