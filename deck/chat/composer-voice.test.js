// @ts-check
// Push-to-talk (deck/chat/core/voice.js + the mic button in composer.js): voice.status gates the
// empty state, holding the button opens the stream and partial/final text lands in the box,
// releasing ends it cleanly, Esc cancels mid-listen. Fakes the browser audio/WS APIs fake-dom
// doesn't have - this never touches a real mic or socket. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, $, text } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});

// ---- fake browser audio/WS: voice.js never sees a real mic or socket in this file ------------

class FakeAudioContext {
  constructor() { this.state = "running"; this.destination = {}; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
  createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
  async close() { this.state = "closed"; }
}
class FakeWebSocket {
  /** @param {string} url */
  constructor(url) {
    this.url = url; this.readyState = 0; /** @type {any[]} */ this.sent = [];
    this.onopen = null; this.onmessage = null; this.onclose = null;
    FakeWebSocket.last = this;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(/** @type {any} */ data) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
}
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSED = 3;
/** @type {any} */ (FakeWebSocket).last = null;
Object.assign(globalThis, { AudioContext: FakeAudioContext, WebSocket: FakeWebSocket });
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true,
  value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } } });

// ---- fake vyred: voice.status/voice.listen by a module-level answer the test sets ------------

/** @type {any} */ let statusAnswer = { key: false, provider: "deepgram" };
/** @type {any} */ let listenAnswer = { path: "/v1/streams/voice/listen?ticket=t1" };
globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1] || "");
  if (tool === "voice.status") return { status: 200, statusText: "", json: async () => ({ data: statusAnswer }) };
  if (tool === "voice.listen") return { status: 200, statusText: "", json: async () => ({ data: listenAnswer }) };
  return { status: 200, statusText: "", json: async () => ({ data: {} }) };
});

const { mountComposer } = await import("./composer.js");
const thread = () => "voice-test-" + Math.random().toString(36).slice(2);
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));

/** @param {any} c */
function press(c) { c.el.querySelector(".composer-mic").dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("pointerdown"), { button: 0 })); }
/** @param {any} c */
function release(c) { c.el.querySelector(".composer-mic").dispatchEvent(new /** @type {any} */ (globalThis).Event("pointerup")); }

test("no voice key: holding the mic shows the Settings link, never opens a stream", async () => {
  statusAnswer = { key: false, provider: "deepgram" };
  const c = mountComposer({ thread: thread() });
  press(c);
  await tick();
  assert.match(text($(c.el, ".composer-note")), /Add a voice key in.*Settings.*push-to-talk/);
  assert.equal($(c.el, ".composer-mic").classList.contains("on"), false);
  c.stop();
});

test("holding the mic streams partial/final text into the box; release ends it cleanly", async () => {
  statusAnswer = { key: true, provider: "deepgram" };
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=t2" };
  const c = mountComposer({ thread: thread() });
  c.setText("earlier words ");
  press(c);
  await tick();
  assert.equal($(c.el, ".composer-mic").classList.contains("on"), true, "the button shows it is listening");
  const ws = /** @type {any} */ (FakeWebSocket).last;
  assert.match(ws.url, /\/v1\/streams\/voice\/listen\?ticket=t2$/);

  ws.onmessage({ data: JSON.stringify({ type: "partial", text: "hey there" }) });
  assert.equal(c.value(), "earlier words hey there");
  ws.onmessage({ data: JSON.stringify({ type: "final", text: "hey there," }) });
  assert.equal(c.value(), "earlier words hey there,");

  release(c);
  await tick();
  assert.deepEqual(JSON.parse(ws.sent[ws.sent.length - 1]), { type: "end" });
  ws.onmessage({ data: JSON.stringify({ type: "done", text: "hey there, run the tests" }) });
  assert.equal(c.value(), "earlier words hey there, run the tests");
  assert.equal($(c.el, ".composer-mic").classList.contains("on"), false, "back to idle once done");
  c.stop();
});

test("an error from the box ends the mic state and shows its words", async () => {
  statusAnswer = { key: true, provider: "deepgram" };
  const c = mountComposer({ thread: thread() });
  press(c);
  await tick();
  const ws = /** @type {any} */ (FakeWebSocket).last;
  ws.onmessage({ data: JSON.stringify({ type: "error", code: "provider_error" }) });
  assert.match(text($(c.el, ".composer-note")), /could not be reached/i);
  assert.equal($(c.el, ".composer-mic").classList.contains("on"), false);
  c.stop();
});

test("Esc cancels a listening session (sends end, same as releasing)", async () => {
  statusAnswer = { key: true, provider: "deepgram" };
  const c = mountComposer({ thread: thread() });
  press(c);
  await tick();
  const ws = /** @type {any} */ (FakeWebSocket).last;
  const handled = c.key(/** @type {any} */ ({ key: "Escape" }));
  assert.equal(handled, true);
  await tick();
  assert.deepEqual(JSON.parse(ws.sent[ws.sent.length - 1]), { type: "end" });
  ws.close(); // as the box's own close would: clears the 6 s fallback cleanup immediately
  c.stop();
});
