// @ts-check
// The stream module inside a real Registry: switchboard events in, frames out over the ticketed
// WebSocket at /v1/streams/stream/session, with the same one-use ticket rules as term and Glass.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome } from "../../test/helpers.js";
import { connect, wsDuplex } from "./client.js";
import { fakeThreads } from "./fake-threads.js";
import { SCRATCH } from "../../test/scratch.mjs";
import fs from "node:fs";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function world(t) {
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box" }, paths: p, log: () => {} });
  // threads.get is the switchboard's: a stand-in answers it (as the caller), so stream.open can tell a thread from no thread.
  const fake = fs.mkdtempSync(path.join(SCRATCH, "vyre-stream-fake-"));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  fakeThreads(fake);
  await reg.start([...discover([CORE]).filter(f => f.manifest && f.manifest.name === "stream"), ...discover([fake], { firstPartyRoots: [fake] })], { role: "box" });
  assert.equal(reg.modules.get("stream")?.state, "running", reg.modules.get("stream")?.error);
  assert.equal(reg.modules.get("threads")?.state, "running", reg.modules.get("threads")?.error);
  const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  s.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://vyred");
    const m = /^\/v1\/streams\/([a-z-]+)\/([a-z-]+)$/.exec(url.pathname);
    const u = m && reg.upgrades.get(`${m[1]}/${m[2]}`);
    if (!u) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
    u.handler(req, socket, head, { caller: "deck", url });
  });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (s.address()).port;
  t.after(async () => { s.closeAllConnections(); s.close(); await reg.stop(); db.close(); });
  const say = (type, payload, thread = "thr_1") => events.emit("switchboard", type, payload, { thread });
  return { reg, port, say };
}
const call = async (reg, tool, input) => { const r = await reg.call(tool, input, "deck"); if (r.error) throw new Error(`${r.error.code} ${r.error.message}`); return r.data; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (p, ms = 5000) => { const t = Date.now(); while (!p() && Date.now() - t < ms) await sleep(5); assert.ok(p(), "condition met in time"); };

test("stream module: thread events become frames a ticketed client reads, replay then live", async t => {
  const { reg, port, say } = await world(t);
  say("thread.started", { provider: "claude" });
  say("thread.text", { message: "m1", block: 0, delta: "Hello " });
  const o = await call(reg, "stream.open", { chat: "thr_1", from: 0 });
  assert.equal(o.head, 2);
  assert.equal(o.floor, 0);
  assert.match(o.path, /^\/v1\/streams\/stream\/session\?ticket=/);
  /** @type {any[]} */ const got = [];
  const c = connect({ open: () => wsDuplex(`ws://127.0.0.1:${port}${o.path}`), onFrame: f => got.push(f), backoff: { base: 5, cap: 10 } });
  t.after(() => c.close());
  await until(() => got.length >= 2);
  say("thread.text", { message: "m1", block: 0, delta: "world" });
  say("thread.tool", { call: "t1", tool: "Bash", phase: "started", summary: "ls", input: { command: "ls" } });
  say("thread.tool", { call: "t1", phase: "done", output: "a.txt\n" });
  say("ask.raised", { ask: "a1", tool: "Bash", summary: "rm x" });
  await until(() => got.length >= 6);
  assert.deepEqual(got.map(f => f.type), ["session.status", "session.text-delta", "session.text-delta", "session.tool-started", "session.tool-finished", "session.ask"]);
  assert.deepEqual(got.map(f => f.cur), got.map((_, i) => i + 1));
  assert.equal(got[4].data.result.block, "terminal");
});

test("stream module: a ticket works once, a stale or unknown one gets 403, and a session id is checked", async t => {
  const { reg, port } = await world(t);
  const o = await call(reg, "stream.open", { chat: "thr_2" });
  const status = path => new Promise(resolve => {
    const r = http.request({ port, host: "127.0.0.1", path, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    r.on("response", res => resolve(res.statusCode));
    r.on("upgrade", (_res, sock) => { sock.destroy(); resolve(101); });
    r.on("error", () => resolve(0));
    r.end();
  });
  assert.equal(await status(o.path), 101);
  assert.equal(await status(o.path), 403, "spent");
  assert.equal(await status("/v1/streams/stream/session?ticket=nope"), 403);
  await assert.rejects(call(reg, "stream.open", { chat: "bad id with spaces" }), /chat must be a chat id/);
});

test("stream module: a reconnecting client resumes from its cursor across a dropped socket (ticket per attempt)", async t => {
  const { reg, port, say } = await world(t);
  let text = "";
  const c = connect({
    open: async ({ from }) => { const o = await call(reg, "stream.open", { chat: "thr_3", from }); return wsDuplex(`ws://127.0.0.1:${port}${o.path}`); },
    onFrame: f => { if (f.type === "session.text-delta") text += f.data.text; },
    backoff: { base: 5, cap: 20 },
  });
  t.after(() => c.close());
  let all = "";
  for (let i = 0; i < 30; i++) {
    all += `w${i} `;
    say("thread.text", { message: "m", block: 0, delta: `w${i} ` }, "thr_3");
    if (i === 10 || i === 20) { await until(() => c.last >= i); c.reconnect(); }
    await sleep(2);
  }
  await until(() => c.last === 30);
  assert.equal(text, all);
});

test("stream module: events of other kinds or without a thread are not framed", async t => {
  const { reg, say } = await world(t);
  say("settings.changed", { x: 1 });
  reg.deps.events.emit("switchboard", "thread.text", { message: "m", delta: "orphan" }, {});
  const o = await call(reg, "stream.open", { chat: "thr_1" });
  assert.equal(o.head, 0);
});
