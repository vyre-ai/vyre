import { test } from "node:test";
import assert from "node:assert/strict";
import { TermClient, HOLD_MAX } from "./client.js";

/** A fake WebSocket the test drives by hand. */
class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeWS.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen(); }
  msg(d) { this.onmessage({ data: d }); }
  drop(code = 1006, reason = "") { this.readyState = 3; this.onclose({ code, reason }); }
}
const bytes = (n, fill = 1) => new Uint8Array(n).fill(fill).buffer;
const flush = () => new Promise((r) => setImmediate(r));
function make() {
  FakeWS.all = [];
  const got = { bytes: [], states: [], sizes: [], cuts: [], asked: [], timers: [] };
  const c = new TermClient({
    WebSocket: FakeWS,
    getTicket: async (from) => { got.asked.push(from); return { url: `ws://box/pty?ticket=t${got.asked.length}&from=${from}` }; },
    onBytes: (b) => got.bytes.push(b), onState: (s) => got.states.push(s), onSize: (s) => got.sizes.push(s), onCut: (m) => got.cuts.push(m),
    timers: { set: (f, ms) => { got.timers.push({ f, ms }); return got.timers.length; }, clear: () => {} },
  });
  return { c, got };
}

test("client: a first connect asks from 0, counts every byte, and adopts the box's at", async () => {
  const { c, got } = make();
  await c.connect();
  assert.deepEqual(got.asked, [0]);
  const ws = FakeWS.all[0];
  assert.match(ws.url, /from=0$/);
  ws.open();
  ws.msg(bytes(100)); ws.msg(bytes(28));
  assert.equal(c.offset, 128);
  assert.equal(got.bytes.length, 2);
  ws.msg(JSON.stringify({ t: "at", offset: 128 }));
  assert.equal(c.offset, 128);
  // A box that counts further than we did (bytes lost while vyred was down) wins.
  ws.msg(JSON.stringify({ t: "at", offset: 200 }));
  assert.equal(c.offset, 200);
});

test("client: a drop reconnects from the last offset, with backoff, and the replay continues from there", async () => {
  const { c, got } = make();
  await c.connect();
  const a = FakeWS.all[0];
  a.open();
  a.msg(bytes(5000));
  a.drop();
  assert.equal(got.timers.length, 1);
  assert.equal(got.timers[0].ms, 250);
  got.timers[0].f();
  await flush();
  assert.deepEqual(got.asked, [0, 5000]);
  const b = FakeWS.all[1];
  assert.match(b.url, /from=5000$/);
  b.open();
  b.msg(bytes(10));
  assert.equal(c.offset, 5010);
  // A second drop before it opened: the wait grows.
  b.drop();
  assert.equal(got.timers[1].ms, 250 * 1, "a socket that opened resets the wait");
  got.timers[1].f(); await flush();
  FakeWS.all[2].drop();
  assert.equal(got.timers[2].ms, 500);
  assert.equal(got.states.at(-1).state, "reconnecting");
});

test("client: a cut moves the offset to where the replay starts and tells the screen to clear", async () => {
  const { c, got } = make();
  c.offset = 10;
  await c.connect();
  const ws = FakeWS.all[0];
  ws.open();
  ws.msg(JSON.stringify({ t: "cut", from: 4000, asked: 10 }));
  assert.equal(c.offset, 4000);
  ws.msg(bytes(50));
  assert.equal(c.offset, 4050);
  assert.deepEqual(got.cuts, [{ t: "cut", from: 4000, asked: 10 }]);
});

test("client: keys typed while away are held (4 KB) and sent after the reattach", async () => {
  const { c, got } = make();
  c.input("ls");
  await c.connect();
  const ws = FakeWS.all[0];
  c.input("pw");
  ws.open();
  assert.deepEqual(ws.sent, [{ t: "in", d: "lspw" }]);
  ws.drop();
  c.input("x".repeat(HOLD_MAX + 100));
  assert.equal(c.held.length, HOLD_MAX);
  got.timers[0].f(); await flush();
  const b = FakeWS.all[1];
  b.open();
  assert.equal(b.sent[0].d.length, HOLD_MAX);
  c.input("live");
  assert.deepEqual(b.sent.at(-1), { t: "in", d: "live" });
});

test("client: size is sent on open and when it changes; take asks for ownership; size frames say who owns", async () => {
  const { c, got } = make();
  c.resize(100, 30);
  await c.connect();
  const ws = FakeWS.all[0];
  ws.open();
  assert.deepEqual(ws.sent[0], { t: "size", cols: 100, rows: 30 });
  ws.msg(JSON.stringify({ t: "size", cols: 80, rows: 24, owner: false }));
  assert.deepEqual(got.sizes.at(-1), { cols: 80, rows: 24, owner: false });
  c.take();
  assert.deepEqual(ws.sent.at(-1), { t: "take", cols: 100, rows: 30 });
  ws.msg(JSON.stringify({ t: "size", cols: 100, rows: 30, owner: true }));
  assert.equal(c.owner, true);
});

test("client: a close 1000 is the terminal ending (no reconnect); close() stops for good", async () => {
  const { c, got } = make();
  await c.connect();
  FakeWS.all[0].open();
  FakeWS.all[0].drop(1000, "exited");
  assert.equal(got.timers.length, 0);
  assert.deepEqual([got.states.at(-1).state, got.states.at(-1).reason], ["ended", "exited"]);
  const d = make();
  await d.c.connect();
  FakeWS.all[0].open();
  d.c.close();
  FakeWS.all[0].drop();
  assert.equal(d.got.timers.length, 0);
  assert.equal(d.got.states.at(-1).state, "closed");
});

test("client: a ticket that fails is retried, not fatal", async () => {
  FakeWS.all = [];
  const timers = [];
  let n = 0;
  const c = new TermClient({ WebSocket: FakeWS, getTicket: async () => { if (n++ < 1) throw new Error("offline"); return { url: "ws://x" }; }, timers: { set: (f, ms) => (timers.push({ f, ms }), 1), clear() {} } });
  await c.connect();
  assert.equal(FakeWS.all.length, 0);
  assert.equal(timers.length, 1);
  timers[0].f(); await flush();
  assert.equal(FakeWS.all.length, 1);
});
