// @ts-check
// Glass on a phone away from the server (R031-88): the page's WebSocket (the WebView shim) -> the app's bridge -> a RelaySocket on the Noise channel -> the box's relay bridge -> Glass -> the agent's screen
// (a fake Xvnc). Every hop is the production code; only the router that picks Glass for the path, and the channel's two ends, are wired by hand. What this proves that each hop's own test does not: the
// whole RFB handshake and a frame bigger than one relay frame cross the relay, a ticket works once, and a page that names any other stream gets nothing.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { keyPair } from "../relay/noise.js";
import { deviceSide, boxSide } from "../relay/channel.js";
import { bridge } from "../relay/bridge.js";
import { RelaySocket } from "../../relay/client/client.js";
import { createWsBridge } from "../../relay/client/wsbridge.js";
import { Glass } from "./glass.js";
import { fakeXvnc } from "../../test/fixtures/fake-xvnc.js";

const ROUTE = "abcdefghijklmnopqrstuvwxyz", PASSWORD = "s3cr3t8!";

async function pair() {
  const box = keyPair(), dev = keyPair();
  const ends = { device: /** @type {any} */ (null), box: /** @type {any} */ (null) };
  const mk = (/** @type {"device" | "box"} */ to) => ({ send: (/** @type {Uint8Array} */ bytes) => setImmediate(() => ends[to]?.receive(Buffer.from(bytes))), close() {} });
  ends.box = boxSide(mk("device"), { s: box, route: ROUTE, admit: async () => ({ ok: true }) });
  ends.device = deviceSide(mk("box"), { s: dev, box: box.pub, route: ROUTE, hello: { v: 1 } });
  const [{ channel: device }, { channel: boxCh }] = await Promise.all([ends.device.ready, ends.box.ready]);
  return { device, boxCh };
}

/** The whole path, with the page's two ends as plain functions: `page(message)` is what the shim posts, `heard` what it is told. */
async function world(t, { width = 800, height = 600 } = {}) {
  const xvnc = await fakeXvnc({ width, height });
  /** @type {Map<string, any>} */ const tickets = new Map();
  const pool = {
    issue() { const k = crypto.randomBytes(8).toString("hex"); tickets.set(k, { agent: "kit", surface: "glass:phone", slow: false }); return k; },
    redeem(/** @type {string} */ k) { const v = tickets.get(k); tickets.delete(k); return v || null; },
    async viewer() {},
    vnc() { return { host: "127.0.0.1", port: xvnc.port, password: PASSWORD }; },
  };
  const glass = new Glass({ pool: /** @type {any} */ (pool), keyboard: /** @type {any} */ ({ canType: () => false }), log: () => {} });
  const { device, boxCh } = await pair();
  /** @type {string[]} */ const routed = [];
  bridge(boxCh, { caller: "device:phone", peer: {}, handler: () => {}, upgrade: () => (/** @type {any} */ req, /** @type {any} */ socket, /** @type {any} */ head) => {
    routed.push(req.url);
    if (!req.url.startsWith("/v1/streams/computers/glass")) { socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n"); return; }
    glass.handle(req, socket, head, { url: new URL("http://vyred" + req.url) });
  } });
  /** @type {any[]} */ const heard = [];
  /** @type {(() => void)[]} */ const waiters = [];
  const app = createWsBridge({ open: path => { const s = new RelaySocket(); s.attach(device, path, {}); return s; }, post: m => { heard.push(m); while (waiters.length) waiters.shift()?.(); } });
  t.after(() => { app.closeAll(); device.close(); void xvnc.close(); });
  const until = async (/** @type {(h: any[]) => boolean} */ ok) => { while (!ok(heard)) await new Promise(r => { waiters.push(() => r(undefined)); setTimeout(r, 2000); }); };
  const bytes = (/** @type {any[]} */ list) => Buffer.concat(list.filter(m => m.t === "message" && m.b64).map(m => Buffer.from(m.b64, "base64")));
  return { xvnc, pool, app, heard, until, bytes, routed, page: (/** @type {any} */ m) => app.fromPage(JSON.stringify(m)) };
}

test("a phone page reaches the agent's screen over the relay: the RFB handshake, and a frame bigger than one relay frame", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const ticket = w.pool.issue();
  w.page({ t: "open", id: 1, url: `ws://anything/v1/streams/computers/glass?ticket=${ticket}` });
  await w.until(h => h.some(m => m.t === "open"));
  // Glass is the RFB server: version, security types, result, then ServerInit after our version, choice and shared flag
  await w.until(h => w.bytes(h).toString("latin1").startsWith("RFB 003.008\n"));
  w.page({ t: "send", id: 1, b64: Buffer.from("RFB 003.008\n", "latin1").toString("base64") });
  await w.until(h => w.bytes(h).length >= 12 + 2);
  w.page({ t: "send", id: 1, b64: Buffer.from([1]).toString("base64") });
  await w.until(h => w.bytes(h).length >= 12 + 2 + 4);
  w.page({ t: "send", id: 1, b64: Buffer.from([1]).toString("base64") });
  await w.until(h => w.bytes(h).length >= 12 + 2 + 4 + 24 + "agent's screen".length);
  const all = w.bytes(w.heard), init = all.subarray(18);
  assert.deepEqual([init.readUInt16BE(0), init.readUInt16BE(2)], [800, 600], "the screen's size came through the relay");
  // a 1.9 MB framebuffer update: more than one relay frame, so it must arrive in pieces and whole
  const before = w.bytes(w.heard).length;
  w.xvnc.sendFrame();
  const want = 16 + 800 * 600 * 4;
  await w.until(h => w.bytes(h).length - before >= want);
  assert.equal(w.bytes(w.heard).length - before, want, "every pixel byte arrived once");
  assert.equal(w.routed.length, 1);
  w.page({ t: "close", id: 1, code: 1000 });
});

test("the ticket is spent by the first look; a second page with it is refused, and a path that is not Glass never reaches the router", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const ticket = w.pool.issue();
  w.page({ t: "open", id: 1, url: `/v1/streams/computers/glass?ticket=${ticket}` });
  await w.until(h => h.some(m => m.t === "open"));
  w.page({ t: "open", id: 2, url: `/v1/streams/computers/glass?ticket=${ticket}` });
  await w.until(h => h.some(m => m.t === "close" && m.id === 2));
  assert.ok(!w.heard.some(m => m.t === "open" && m.id === 2), "the spent ticket opens nothing");
  w.page({ t: "open", id: 3, url: "/v1/streams/term/shell" });
  w.page({ t: "open", id: 4, url: "/v1/tools/vault.get" });
  await w.until(h => h.filter(m => m.t === "close" && (m.id === 3 || m.id === 4)).length === 2);
  assert.ok(w.heard.filter(m => m.id === 3 || m.id === 4).every(m => m.t === "close" && m.code === 1008), "refused by the app before the relay is used");
  assert.ok(w.routed.every(u => u.startsWith("/v1/streams/computers/glass")), "only Glass paths ever reached the box's router");
});
