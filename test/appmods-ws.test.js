// @ts-check
// The WebSocket tunnel of the apps' front (core/appmods/proxy.js serve.upgrade), seen from a stranger on a published server's host (trust rows 39, 40 and 42): a tunnel starts only on the app's 101, is
// capped per app, times out connecting, waiting for the app's answer and sitting idle, and closing either end closes the other; a header with an underscore spelling of X-Vyre-* is dropped.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHostProxy, createTickets } from "../core/appmods/proxy.js";

const HOST = "northwind.acme.vyre.run";
const wait = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/** A front with one open app whose upstream is a raw TCP server we control. @param {import("node:test").TestContext} t @param {(sock: net.Socket, head: string) => void} onUpstream @param {object} [more] */
async function rig(t, onUpstream, more = {}) {
  /** @type {net.Socket[]} */ const ups = [];
  const upstream = net.createServer(sock => { ups.push(sock); let b = ""; sock.on("data", d => { b += d; const i = b.indexOf("\r\n\r\n"); if (i >= 0 && !sock.listenerCount("x")) { sock.emit("x"); onUpstream(sock, b.slice(0, i)); } }); sock.on("error", () => {}); });
  await new Promise(r => upstream.listen(0, "127.0.0.1", () => r(undefined)));
  const origin = `http://127.0.0.1:${/** @type {any} */ (upstream.address()).port}`;
  const tickets = createTickets();
  const proxy = createHostProxy({ tickets, app: async () => ({ origin, origins: [origin], login: null, public: [], passCookies: true, open: true, credentials: async () => ({}) }), ...more });
  const front = http.createServer((req, res) => { proxy(req, res, { url: new URL(req.url || "/", "http://x") }).then(d => { if (!d) { res.writeHead(404); res.end(); } }); });
  front.on("upgrade", (req, socket, head) => { proxy.upgrade(req, socket, head).then(d => { if (!d) socket.destroy(); }); });
  await new Promise(r => front.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { front.closeAllConnections(); front.close(); for (const s of ups) s.destroy(); upstream.close(); });
  const port = /** @type {any} */ (front.address()).port;
  /** A stranger's WebSocket request; resolves with what came back and the socket. @param {string} [extra] */
  const stranger = (extra = "") => new Promise(resolve => {
    const c = net.connect(port, "127.0.0.1", () => c.write(`GET /live HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: vyre_app=FORGED; theme=dark\r\n${extra}\r\n`));
    let b = ""; c.on("data", d => { b += d; }); c.on("error", () => {}); c.on("close", () => { c.emit("done"); });
    setTimeout(() => resolve({ c, text: () => b }), 150);
  });
  return { stranger, ups, port };
}
const SWITCH = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";

test("a tunnel starts only on the app's 101: a plain 200 that keeps the connection alive is answered 502 and nothing more the client sends reaches the app", async t => {
  /** @type {string[]} */ const seen = [];
  const { stranger, ups } = await rig(t, (sock, head) => { seen.push(head); sock.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok"); sock.on("data", d => seen.push("MORE:" + d)); });
  const s = /** @type {any} */ (await stranger());
  assert.match(s.text(), /^HTTP\/1\.1 502 /);
  s.c.write("GET /admin HTTP/1.1\r\nHost: x\r\nX-Vyre-Viewer: owner\r\n\r\n");
  await wait(150);
  assert.ok(!seen.some(x => x.startsWith("MORE:")), "a second request never reached the app");
  assert.ok(ups.every(u => u.destroyed), "and the upstream is closed");
});

test("a 101 is a tunnel both ways, and closing the client closes the app's side", async t => {
  const { stranger, ups } = await rig(t, (sock) => { sock.write(SWITCH); sock.on("data", d => sock.write(d)); });
  const s = /** @type {any} */ (await stranger());
  assert.match(s.text(), /^HTTP\/1\.1 101 /);
  s.c.write("hello");
  await wait(150);
  assert.ok(s.text().endsWith("hello"), "bytes go both ways");
  s.c.end();
  await wait(200);
  assert.ok(ups[0].destroyed, "the app's side is closed when the client closes cleanly");
});

test("the tunnels of one app are capped, and a slot comes back when one closes", async t => {
  const { stranger } = await rig(t, (sock) => { sock.write(SWITCH); }, { wsMax: 2 });
  const a = /** @type {any} */ (await stranger()), b = /** @type {any} */ (await stranger()), c = /** @type {any} */ (await stranger());
  assert.match(a.text(), /^HTTP\/1\.1 101 /); assert.match(b.text(), /^HTTP\/1\.1 101 /);
  assert.match(c.text(), /^HTTP\/1\.1 503 /, "the third is told to come back");
  a.c.destroy();
  await wait(200);
  const d = /** @type {any} */ (await stranger());
  assert.match(d.text(), /^HTTP\/1\.1 101 /, "a closed tunnel gives its slot back");
});

test("an app that never answers is cut off after the head timeout, and an idle tunnel after the idle timeout", async t => {
  const { stranger, ups } = await rig(t, () => { /* silence */ }, { wsHeadMs: 150 });
  const s = /** @type {any} */ (await stranger());
  await wait(300);
  assert.ok(ups[0].destroyed, "no answer: the upstream is closed");
  assert.ok(s.c.destroyed || s.c.readyState !== "open", "and the client with it");
  const idle = await rig(t, (sock) => { sock.write(SWITCH); }, { wsIdleMs: 200 });
  const i = /** @type {any} */ (await idle.stranger());
  assert.match(i.text(), /^HTTP\/1\.1 101 /);
  await wait(450);
  assert.ok(idle.ups[0].destroyed, "idle: the tunnel is closed");
});

test("every spelling of Vyre's header family is dropped on the way to the app", async t => {
  /** @type {string[]} */ const heads = [];
  const { stranger } = await rig(t, (sock, head) => { heads.push(head); sock.write(SWITCH); });
  await stranger("X-Vyre-Viewer: owner\r\nX_Vyre_Viewer: owner\r\nx_vyre_person: per_owner\r\nX-Other: kept\r\n");
  const h = heads[0].toLowerCase();
  assert.ok(!/x[-_]vyre/.test(h), `no Vyre header reached the app:\n${heads[0]}`);
  assert.ok(h.includes("x-other: kept"), "other headers pass");
});

test("bytes pipelined after the upgrade request wait for the app's 101: an upstream that answers 200 never sees a second request, one that answers 101 gets them", async t => {
  /** @type {string[]} */ const seen = [];
  const bad = await rig(t, (sock, head) => { seen.push(head); sock.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n"); sock.on("data", d => seen.push("PIPELINED:" + d)); });
  await new Promise(resolve => {
    const c = net.connect(/** @type {any} */ (bad.port), "127.0.0.1", () => c.write(`GET /live HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n\r\nGET /admin HTTP/1.1\r\nHost: ${HOST}\r\nX-Vyre-Viewer: owner\r\n\r\n`));
    c.on("error", () => {}); c.on("close", resolve); setTimeout(resolve, 400);
  });
  await wait(100);
  assert.equal(seen.filter(x => x.startsWith("PIPELINED:")).length, 0, "the pipelined second request never reached the app");
  assert.equal(seen.filter(x => /^GET /.test(x)).length, 1, "the app saw exactly one request line");
  /** @type {string[]} */ const got = [];
  const good = await rig(t, (sock) => { sock.write(SWITCH); sock.on("data", d => got.push(String(d))); });
  await new Promise(resolve => {
    const c = net.connect(/** @type {any} */ (good.port), "127.0.0.1", () => c.write(`GET /live HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n\r\nFIRSTFRAME`));
    c.on("error", () => {}); setTimeout(resolve, 400);
  });
  assert.ok(got.join("").includes("FIRSTFRAME"), "after the 101 the held bytes are the tunnel's");
});

test("all tunnels of all apps are capped together", async t => {
  const a = await rig(t, (sock) => { sock.write(SWITCH); }, { wsTotalMax: 1 });
  const first = /** @type {any} */ (await a.stranger());
  assert.match(first.text(), /^HTTP\/1\.1 101 /);
  const second = /** @type {any} */ (await a.stranger());
  assert.match(second.text(), /^HTTP\/1\.1 503 /);
});
