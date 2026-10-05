// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SessionLog } from "./log.js";
import { serve, serveSSE, serveWS } from "./server.js";
import { connect, wsDuplex } from "./client.js";
import { prng, Sched } from "./testkit.js";

/** A fake connection that records what it is sent. @param {{ buffered?: () => number, onSend?: (f: any) => void }} [o] */
function fakeConn(o = {}) {
  /** @type {any[]} */ const got = [];
  /** @type {(() => void)[]} */ const closers = [];
  /** @type {(() => void)[]} */ const drains = [];
  /** @type {((m: any) => void)[]} */ const msgs = [];
  let closed = false;
  return {
    got, closed: () => closed,
    conn: {
      send(/** @type {any} */ f) { got.push(f); o.onSend?.(f); },
      onClose(/** @type {() => void} */ cb) { closers.push(cb); },
      close() { closed = true; },
      onMessage(/** @type {(m: any) => void} */ cb) { msgs.push(cb); },
      ...(o.buffered ? { buffered: o.buffered, onDrain(/** @type {() => void} */ cb) { drains.push(cb); } } : {}),
    },
    say: (/** @type {any} */ m) => { for (const f of msgs) f(m); },
    drain: () => { for (const f of drains) f(); },
    hangup: () => { closed = true; for (const c of closers) c(); },
    curs: () => got.filter(f => f.cur).map(f => f.cur),
  };
}
const fill = (/** @type {SessionLog} */ log, /** @type {number} */ n) => { for (let i = 0; i < n; i++) log.append("status", { state: "working" }); };

test("serve: replays after `from`, then goes live, in order, with a heartbeat carrying the head", () => {
  const log = new SessionLog("s1", { coalesce: false });
  fill(log, 5);
  const c = fakeConn();
  serve(log, c.conn, { from: 2 });
  assert.deepEqual(c.curs(), [3, 4, 5]);
  assert.equal(c.got[c.got.length - 1].type, "chat.heartbeat");
  assert.equal(c.got[c.got.length - 1].data.head, 5);
  log.append("status", { state: "waiting" });
  assert.deepEqual(c.curs(), [3, 4, 5, 6]);
});

test("serve: a frame emitted while the replay is being sent is neither missed nor sent twice", () => {
  const log = new SessionLog("s1", { coalesce: false });
  fill(log, 6);
  let injected = 0;
  const c = fakeConn({ onSend: f => { if ((f.cur === 3 || f.cur === 4) && injected < 2) { injected++; log.append("status", { state: "waiting" }); } } });
  serve(log, c.conn, { from: 0 });
  log.append("status", { state: "working" });
  assert.deepEqual(c.curs(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(injected, 2);
});

test("serve: a frame appended by a live send (re-entrant) arrives once, in order", () => {
  const log = new SessionLog("s1", { coalesce: false });
  let again = true;
  const c = fakeConn({ onSend: f => { if (f.cur === 1 && again) { again = false; log.append("status", { state: "waiting" }); } } });
  serve(log, c.conn, { from: 0 });
  log.append("status", { state: "working" });
  assert.deepEqual(c.curs(), [1, 2]);
});

test("serve: random interleavings of appends and subscribes give every client exactly the frames after its cursor", () => {
  const rnd = prng(77);
  for (let round = 0; round < 100; round++) {
    const log = new SessionLog("s1", { maxFrames: 100000, coalesce: false });
    const n = 5 + Math.floor(rnd() * 40);
    const when = Math.floor(rnd() * n);
    const from = Math.floor(rnd() * (when + 1));
    /** @type {ReturnType<typeof fakeConn>} */ let c = /** @type {any} */ (null);
    for (let i = 0; i < n; i++) {
      if (i === when) { c = fakeConn(); serve(log, c.conn, { from }); }
      log.append("status", { state: "working" });
    }
    const want = Array.from({ length: log.head - from }, (_, k) => from + 1 + k);
    assert.deepEqual(c.curs(), want, `round ${round}: from ${from}, subscribed at ${when} of ${n}`);
  }
});

test("serve: subscribe by message when `from` is not given; a bad from means the head", () => {
  const log = new SessionLog("s1", { coalesce: false });
  fill(log, 4);
  const c = fakeConn();
  serve(log, c.conn);
  assert.deepEqual(c.curs(), [], "nothing until the client says where it is");
  c.say({ t: "subscribe", from: 1 });
  assert.deepEqual(c.curs(), [2, 3, 4]);
  c.say({ t: "subscribe", from: 0 });
  assert.deepEqual(c.curs(), [2, 3, 4], "a second subscribe is ignored");
  const d = fakeConn();
  serve(log, d.conn);
  d.say({ t: "subscribe", from: "nope" });
  assert.deepEqual(d.curs(), []);
  log.append("status", { state: "working" });
  assert.deepEqual(d.curs(), [5], "live only");
});

test("serve: a cursor older than the log, or ahead of it, is sent reset and the connection closes", () => {
  const log = new SessionLog("s1", { maxFrames: 3, coalesce: false });
  fill(log, 10);
  const old = fakeConn();
  serve(log, old.conn, { from: 2 });
  assert.equal(old.got.length, 1);
  assert.equal(old.got[0].type, "chat.reset");
  assert.equal(old.got[0].data.reason, "behind");
  assert.equal(old.closed(), true);
  const ahead = fakeConn();
  serve(log, ahead.conn, { from: 50 });
  assert.equal(ahead.got[0].data.reason, "ahead");
  assert.equal(ahead.closed(), true);
});

test("serve: a slow connection is paused, caught up in order when it drains, and reset when it fell past the ring", () => {
  const log = new SessionLog("s1", { maxFrames: 20, coalesce: false });
  let buffered = 0;
  const c = fakeConn({ buffered: () => buffered });
  const h = serve(log, c.conn, { from: 0, maxBuffered: 1000 });
  fill(log, 3);
  buffered = 5000;
  fill(log, 4);
  assert.deepEqual(c.curs(), [1, 2, 3, 4], "one more frame went out as the buffer filled, then it paused");
  assert.equal(h.paused, true);
  buffered = 0;
  c.drain();
  assert.deepEqual(c.curs(), [1, 2, 3, 4, 5, 6, 7], "caught up in order, no gap, no repeat");
  assert.equal(h.paused, false);
  log.append("status", { state: "working" });
  assert.deepEqual(c.curs().slice(-1), [8]);

  // Now a client that stays slow while the log moves past its ring.
  buffered = 9000;
  fill(log, 1);
  assert.equal(h.paused, true);
  fill(log, 50);
  buffered = 0;
  c.drain();
  const last = c.got[c.got.length - 1];
  assert.equal(last.type, "chat.reset");
  assert.equal(c.closed(), true);
});

test("serve: heartbeats come at most every 25 s, carry what was sent, and stop on close", () => {
  const log = new SessionLog("s1", { coalesce: false });
  const sched = new Sched();
  const c = fakeConn();
  serve(log, c.conn, { from: 0, timers: sched });
  fill(log, 2);
  /** @type {number[]} */ const at = [];
  const orig = c.conn.send;
  c.conn.send = f => { if (f.type === "chat.heartbeat") at.push(sched.t); orig(f); };
  const done = sched.run(() => sched.t >= 100_000, 100);
  return done.then(() => {
    assert.ok(at.length >= 3 && at.length <= 5, `${at.length} heartbeats in 100 s`);
    for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 25_000, "never closer than 25 s");
    assert.equal(c.got.filter(f => f.type === "chat.heartbeat").pop().data.head, 2);
    c.hangup();
    const n = c.got.length;
    log.append("status", { state: "working" });
    assert.equal(c.got.length, n, "closed: nothing more is sent");
    assert.equal(log.subs.size, 0, "and it left the log");
  });
});

test("serve: a send that throws closes the subscription cleanly", () => {
  const log = new SessionLog("s1", { coalesce: false });
  let bad = false;
  const c = fakeConn({ onSend: () => { if (bad) throw new Error("broken pipe"); } });
  serve(log, c.conn, { from: 0 });
  bad = true;
  assert.doesNotThrow(() => log.append("status", { state: "working" }));
  assert.equal(log.subs.size, 0);
});

// ---- real transports ------------------------------------------------------------------------

/** @param {SessionLog} log */
function httpServer(log) {
  const server = http.createServer((req, res) => serveSSE(log, req, res, {}));
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url || "/", "http://x");
    const from = u.searchParams.get("from");
    serveWS(log, req, /** @type {any} */ (socket), head, from === null ? {} : { from: Number(from) });
  });
  return new Promise(res => server.listen(0, "127.0.0.1", () => res({ server, port: /** @type {any} */ (server.address()).port })));
}

test("SSE: frames carry id: <cur>; no Last-Event-ID is live only, and Last-Event-ID resumes", async () => {
  const log = new SessionLog("s1", { coalesce: false });
  fill(log, 3);
  const { server, port } = /** @type {any} */ (await httpServer(log));
  /** Read ids until `last` shows up, appending one frame shortly after connecting. */
  const read = async (/** @type {Record<string, string>} */ headers, /** @type {number} */ last) => {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers, signal: ac.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    setTimeout(() => log.append("status", { state: "waiting" }), 30);
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of /** @type {any} */ (res.body)) { buf += dec.decode(chunk, { stream: true }); if (new RegExp(`^id: ${last}$`, "m").test(buf)) break; }
    } finally { ac.abort(); }
    return { ids: [...buf.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1])), buf };
  };
  try {
    const live = await read({}, 4);
    assert.deepEqual(live.ids, [4], "live only");
    assert.match(live.buf, /^retry: 500$/m);
    const resumed = await read({ "last-event-id": "1" }, 5);
    assert.deepEqual(resumed.ids, [2, 3, 4, 5], "replayed after 1, then live");
  } finally { server.closeAllConnections?.(); server.close(); }
});

test("WebSocket: a client connects over a real socket, replays, goes live, and resumes after the server drops it", async () => {
  const log = new SessionLog("s1");
  const { server, port } = /** @type {any} */ (await httpServer(log));
  /** @type {Set<import("node:net").Socket>} */ const socks = new Set();
  server.on("connection", (/** @type {any} */ s) => { socks.add(s); s.on("close", () => socks.delete(s)); });
  let text = "";
  /** @type {number[]} */ const curs = [];
  const client = connect({
    open: ({ from }) => wsDuplex(`ws://127.0.0.1:${port}/?x=1`),
    backoff: { base: 10, cap: 50 },
    onFrame: f => { curs.push(f.cur); if (f.type === "chat.text-delta") text += f.data.text; },
  });
  try {
    const until = async (/** @type {() => boolean} */ p) => { for (let i = 0; i < 400 && !p(); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(p(), "condition met"); };
    await until(() => client.state === "live");
    let all = "";
    for (let i = 0; i < 60; i++) {
      const w = `w${i} `; all += w;
      log.append("text-delta", { message: "m", index: 0, text: w });
      if (i === 20 || i === 40) for (const s of socks) s.destroy();
      if (i % 7 === 0) await new Promise(r => setTimeout(r, 5));
    }
    await until(() => client.last === log.head);
    assert.equal(text, all);
    for (let i = 1; i < curs.length; i++) assert.ok(curs[i] > curs[i - 1]);
  } finally { client.close(); for (const s of socks) s.destroy(); server.close(); }
});

test("WebSocket: a refused handshake (no key) gets a 400, not a hang", async () => {
  const log = new SessionLog("s1");
  const { server, port } = /** @type {any} */ (await httpServer(log));
  try {
    const res = await new Promise(resolve => {
      const req = http.request({ port, host: "127.0.0.1", headers: { connection: "Upgrade", upgrade: "websocket" } });
      req.on("response", r => resolve(r.statusCode));
      req.on("upgrade", () => resolve("upgraded"));
      req.on("error", () => resolve("error"));
      req.end();
    });
    assert.equal(res, 400);
  } finally { server.closeAllConnections?.(); server.close(); }
});
