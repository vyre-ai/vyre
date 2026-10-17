// @ts-check
// The terminal stream: a ticket names one agent and one terminal, is spent once, and a glass-only ticket does not open it (nor a terminal ticket Glass).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";
import { Terminal } from "./terminal.js";
import { Glass } from "./glass.js";
import { encodeClientFrame, FrameParser } from "../../lib/ws.js";

const WSKEY = "dGhlIHNhbXBsZSBub25jZQ==";
const req = () => ({ headers: { upgrade: "websocket", "sec-websocket-key": WSKEY } });

function fakePool() {
  const tickets = new Map();
  return { tickets, issue(/** @type {any} */ t) { const k = crypto.randomBytes(8).toString("hex"); tickets.set(k, t); return k; }, redeem(/** @type {string} */ k) { const v = tickets.get(k); tickets.delete(k); return v || null; } };
}

async function serve(handler) {
  const server = net.createServer(sock => handler(sock));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { server, port: /** @type {any} */ (server.address()).port };
}
const status = (port) => new Promise(resolve => {
  const s = net.connect(port, "127.0.0.1"); let buf = "";
  s.on("data", d => { buf += d; if (buf.includes("\r\n")) { resolve(buf.split("\r\n")[0]); s.destroy(); } });
  s.on("close", () => resolve(buf.split("\r\n")[0] || "closed"));
});

test("a terminal ticket opens the stream once; a screen ticket, an unknown one and a spent one are refused before any handshake", async t => {
  const pool = fakePool();
  const term = new Terminal({ pool, screen: { openTerminal: async () => { throw new Error("no"); } } });
  const ticket = pool.issue({ agent: "kit", surface: "terminal:work", perAgent: true });
  const screen = pool.issue({ agent: "kit", surface: "glass:laptop", perAgent: true });
  const shared = pool.issue({ agent: "kit", surface: "terminal:work", perAgent: false });
  let next = "";
  const { server, port } = await serve(sock => term.handle(req(), sock, Buffer.alloc(0), { url: new URL(`http://vyred/x?ticket=${next}`) }));
  t.after(() => server.close());
  for (const [what, k, want] of [["a screen ticket", screen, /^HTTP\/1\.1 403/], ["an unknown ticket", "nope", /^HTTP\/1\.1 403/], ["a ticket not for a per-agent computer", shared, /^HTTP\/1\.1 403/], ["a good ticket", ticket, /^HTTP\/1\.1 101/], ["the same ticket again", ticket, /^HTTP\/1\.1 403/]]) {
    next = k;
    assert.match(await status(port), want, what);
  }
});

test("what the person types reaches the relay after its hello, and what the relay prints reaches the person; leaving releases the hold", async t => { try { await body(t); } catch (e) { console.log("PROBE-T", e && e.stack); throw e; } });
async function body(t) {
  /** @type {Buffer[]} */ const relayGot = [];
  const relay = await serve(sock => { sock.on("data", d => { relayGot.push(d); sock.write("$ ready"); }); });
  t.after(() => relay.server.close());
  const pool = fakePool();
  /** @type {string[]} */ const events = [];
  const term = new Terminal({ pool, screen: { openTerminal: async (agent, session) => { events.push(`open ${agent} ${session}`); return { host: "127.0.0.1", port: relay.port, hello: "H".repeat(32) + "\n", release: () => events.push("release") }; } } });
  const ticket = pool.issue({ agent: "kit", surface: "terminal:work-1", perAgent: true });
  const front = await serve(sock => term.handle(req(), sock, Buffer.alloc(0), { url: new URL(`http://vyred/x?ticket=${ticket}`) }));
  t.after(() => front.server.close());
  const b = net.connect(front.port, "127.0.0.1");
  await new Promise(r => b.once("connect", r));
  /** @type {Buffer[]} */ const frames = []; const parser = new FrameParser();
  let head = Buffer.alloc(0), upgraded = false;
  const got = new Promise(resolve => b.on("data", d => {
    if (!upgraded) { head = Buffer.concat([head, d]); const i = head.indexOf("\r\n\r\n"); if (i < 0) return; upgraded = true; d = head.subarray(i + 4); }
    for (const f of parser.push(d)) if (!("control" in f)) { frames.push(f.message); resolve(undefined); }
  }));
  b.write(encodeClientFrame(Buffer.from("ls\n")));
  await got;
  assert.equal(frames[0].toString(), "$ ready");
  assert.equal(Buffer.concat(relayGot).toString(), "H".repeat(32) + "\nls\n", "the hello first, then the typing");
  assert.deepEqual(events, ["open kit work-1"]);
  b.destroy();
  await new Promise(r => setTimeout(r, 150));
  assert.deepEqual(events, ["open kit work-1", "release"]);
}

test("Glass refuses a terminal's ticket", async t => {
  const pool = fakePool();
  const ticket = pool.issue({ agent: "kit", surface: "terminal:work", perAgent: true });
  const glass = new Glass({ pool: /** @type {any} */ (pool), keyboard: /** @type {any} */ ({}), log: () => {} });
  const { server, port } = await serve(sock => glass.handle(req(), sock, Buffer.alloc(0), { url: new URL(`http://vyred/x?ticket=${ticket}`) }));
  t.after(() => server.close());
  assert.match(await status(port), /^HTTP\/1\.1 403/);
});
