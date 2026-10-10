// @ts-check
// A page in a native WebView reaching the box's screen stream: the shim in the page, the bridge in the app, and a fake socket for the channel. The page's WebSocket works as a browser's does and can reach
// nothing but the allowed stream.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createWsBridge, webviewShim, MAX_MESSAGE } from "./wsbridge.js";

/** A stand-in for a RelaySocket: opens when told, echoes what it is sent, and remembers how it was closed. */
class FakeSocket {
  constructor(path) { this.path = path; this.readyState = 0; this.sent = []; this.closedWith = null; this.onopen = this.onmessage = this.onclose = this.onerror = null; }
  open() { this.readyState = 1; this.onopen?.({}); }
  send(d) { this.sent.push(d); }
  push(data) { this.onmessage?.({ data }); }
  close(code, reason) { this.closedWith = [code, reason]; this.readyState = 3; }
  drop(code = 1006, reason = "connection lost") { this.readyState = 3; this.onclose?.({ code, reason, wasClean: code === 1000 }); }
}

/** A page with the shim run in it, wired to a bridge by the two postMessage hops a WebView has. */
function world(over = {}) {
  /** @type {FakeSocket[]} */ const opened = [];
  /** @type {any} */ const page = { ReactNativeWebView: { postMessage: m => bridge.fromPage(m) } };
  const bridge = createWsBridge({ open: path => { const s = new FakeSocket(path); opened.push(s); return s; }, post: m => ctx.window.__vyreWs(m), ...over });
  /** @type {any} */ const ctx = { window: page };
  ctx.window.window = ctx.window; ctx.window.WebSocket = class NativeWS {};
  ctx.btoa = s => Buffer.from(s, "binary").toString("base64"); ctx.atob = s => Buffer.from(s, "base64").toString("binary");
  vm.createContext({ ...ctx, window: page, btoa: ctx.btoa, atob: ctx.atob, Uint8Array, ArrayBuffer, String, JSON, Error });
  vm.runInContext(webviewShim(), vm.createContext(Object.assign(page, { window: page, btoa: ctx.btoa, atob: ctx.atob, Uint8Array, ArrayBuffer, String, JSON, Error })));
  return { page, bridge, opened, WS: page.WebSocket };
}

test("the page's WebSocket opens a stream on the box, sends and hears text and bytes, and closes cleanly", () => {
  const w = world();
  const ws = new w.WS("ws://192.168.1.5:7300/v1/streams/computers/glass?ticket=abc");
  assert.equal(ws.readyState, 0);
  assert.equal(w.opened.length, 1);
  assert.equal(w.opened[0].path, "/v1/streams/computers/glass?ticket=abc", "only the path and the ticket go on: the page's host is nothing");
  const heard = [];
  ws.onopen = () => heard.push("open"); ws.onmessage = e => heard.push(e.data instanceof ArrayBuffer ? Array.from(new Uint8Array(e.data)) : e.data); ws.onclose = e => heard.push(["close", e.code, e.wasClean]);
  const extra = []; ws.addEventListener("message", () => extra.push(1));
  w.opened[0].open();
  assert.equal(ws.readyState, 1); assert.deepEqual(heard, ["open"]);
  ws.send("RFB 003.008\n"); ws.send(new Uint8Array([1, 2, 255]).buffer); ws.send(new Uint8Array([9, 8, 7, 6]).subarray(1, 3));
  assert.deepEqual(w.opened[0].sent.map(d => (typeof d === "string" ? d : Array.from(d))), ["RFB 003.008\n", [1, 2, 255], [8, 7]]);
  w.opened[0].push("hello"); w.opened[0].push(new Uint8Array([0, 128, 255]).buffer);
  assert.deepEqual(heard.slice(1), ["hello", [0, 128, 255]]);
  assert.equal(extra.length, 2, "listeners added with addEventListener hear it too");
  ws.close(1000, "done");
  assert.deepEqual(w.opened[0].closedWith, [1000, ""]);
  assert.equal(ws.readyState, 3);
  assert.deepEqual(heard[heard.length - 1], ["close", 1000, true]);
  assert.throws(() => ws.send("x"), /not open/);
  assert.equal(w.bridge.open, 0);
});

test("a stream the page may not open is closed at once with a code the page sees; the page cannot choose a header, a host or another path", () => {
  const w = world();
  for (const url of ["ws://host/v1/streams/term/shell", "ws://host/v1/tools/glass.open", "ws://host/v1/streams/computers/glass/../../x", "ws://host/v1/streams/computers/glass#frag", "garbage:::"]) {
    const ws = new w.WS(url); let code = null; ws.onclose = e => { code = e.code; };
    assert.equal(code, 1008, url);
  }
  assert.equal(w.opened.length, 0, "nothing reached the channel");
  const rel = new w.WS("/v1/streams/computers/glass?ticket=r"); assert.equal(w.opened[0].path, "/v1/streams/computers/glass?ticket=r", "a relative URL is the same stream");
  void rel;
});

test("a page holds at most two streams; the third is refused, and one that is closed frees its place", () => {
  const w = world();
  const a = new w.WS("ws://h/v1/streams/computers/glass?ticket=1"), b = new w.WS("ws://h/v1/streams/computers/glass?ticket=2");
  let code = null; const c = new w.WS("ws://h/v1/streams/computers/glass?ticket=3"); c.onclose = e => { code = e.code; };
  assert.equal(c.readyState, 3); assert.equal(w.opened.length, 2); void a;
  w.opened[0].open(); b.close();
  const d = new w.WS("ws://h/v1/streams/computers/glass?ticket=4"); assert.equal(w.opened.length, 3, "a place was freed"); void code; void d;
});

test("a channel that drops tells the page it was not a clean close; a message too big for one relay frame closes the stream instead of being sent", () => {
  const w = world();
  const ws = new w.WS("ws://h/v1/streams/computers/glass?ticket=1"); const closes = []; ws.onclose = e => closes.push([e.code, e.wasClean]);
  w.opened[0].open(); w.opened[0].drop(1006, "connection lost");
  assert.deepEqual(closes, [[1006, false]]);
  const big = new w.WS("ws://h/v1/streams/computers/glass?ticket=2"); const bigCloses = []; big.onclose = e => bigCloses.push(e.code);
  w.opened[1].open();
  big.send(new Uint8Array(MAX_MESSAGE + 1).buffer);
  assert.deepEqual(bigCloses, [1009]); assert.equal(w.opened[1].sent.length, 0); assert.deepEqual(w.opened[1].closedWith, [1009, "message too big"]);
});

test("messages from a page that is not speaking the protocol are ignored; closeAll ends what the page held", () => {
  const w = world();
  for (const junk of ["", "not json", "null", '{"t":"open"}', '{"t":"send","id":1}', '{"t":"nope","id":1}', { t: "open", id: -1 }]) w.bridge.fromPage(junk);
  assert.equal(w.opened.length, 0);
  new w.WS("ws://h/v1/streams/computers/glass?ticket=1"); w.opened[0].open();
  w.bridge.closeAll();
  assert.deepEqual(w.opened[0].closedWith, [1001, "page closed"]); assert.equal(w.bridge.open, 0);
});
