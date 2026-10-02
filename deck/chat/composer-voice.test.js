// @ts-check
// Tap-to-talk / push-to-talk (deck/chat/core/voice.js + the mic button in composer.js): tap
// starts and stays open, tap again stops (keeps the words); hold past 350 ms, release stops
// (never sends); Enter stops and sends; Esc cancels and removes only what this dictation added.
// Words land at the cursor, never over typed text. A command word at the very end of a final
// ("send it", "new line", "scratch that") is stripped and acted on. Fakes the browser audio/WS
// APIs fake-dom doesn't have - this never touches a real mic or socket. Sample world only.

import { test, mock } from "node:test";
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

let getUserMediaError = /** @type {Error|null} */ (null);
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
    this.url = url; this.readyState = 0; this.closed = false; /** @type {any[]} */ this.sent = [];
    this.onopen = null; this.onmessage = null; this.onclose = null;
    FakeWebSocket.last = this;
    // A real WebSocket's onopen is at least a microtask away (a real round trip in production);
    // FakeWebSocket.autoOpen = false holds it CONNECTING until the test opens it itself, to
    // reproduce a stop() that lands before the socket ever opens.
    if (FakeWebSocket.autoOpen) queueMicrotask(() => this.open());
  }
  open() { if (this.closed) return; this.readyState = 1; this.opened = true; this.onopen?.(); }
  send(/** @type {any} */ data) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
}
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSED = 3;
FakeWebSocket.autoOpen = true;
/** @type {any} */ (FakeWebSocket).last = null;
Object.assign(globalThis, { AudioContext: FakeAudioContext, WebSocket: FakeWebSocket });
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true,
  value: { mediaDevices: { getUserMedia: async () => { if (getUserMediaError) throw getUserMediaError; return { getTracks: () => [{ stop() {} }] }; } } } });

// ---- fake vyred: voice.status/voice.listen/threads.send by module-level answers --------------

/** @type {any} */ let statusAnswer = { key: true, provider: "deepgram" };
/** @type {any} */ let listenAnswer = { path: "/v1/streams/voice/listen?ticket=t1" };
/** @type {any[]} */ let sendCalls = [];
globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1] || "");
  if (tool === "voice.status") return { status: 200, statusText: "", json: async () => ({ data: statusAnswer }) };
  if (tool === "voice.listen") return { status: 200, statusText: "", json: async () => ({ data: listenAnswer }) };
  if (tool === "threads.send") { sendCalls.push(JSON.parse(o.body)); return { status: 200, statusText: "", json: async () => ({ data: { sent: true, uuid: "u1" } }) }; }
  return { status: 200, statusText: "", json: async () => ({ data: {} }) };
});

const { mountComposer } = await import("./composer.js");
const thread = () => "voice-test-" + Math.random().toString(36).slice(2);
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));
/** Drains pending promise chains without touching a timer - safe under mock.timers too, unlike
 *  tick(), since microtasks are never mocked. */
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/** @param {any} c */
const mic = c => $(c.el, ".composer-mic");
/** A quick tap: down, then up before any timer (real or mocked) has had a chance to move - well
 *  under the 350 ms hold threshold either way. */
async function tap(c) {
  mic(c).dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("pointerdown"), { button: 0, pointerId: 1 }));
  await flush();
  mic(c).dispatchEvent(new /** @type {any} */ (globalThis).Event("pointerup"));
  await flush();
}
/** A hold: down, wait past the threshold, then up. */
async function hold(c) {
  mic(c).dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("pointerdown"), { button: 0, pointerId: 1 }));
  await tick(15);
  await tick(370); // past VOICE_HOLD_MS
  mic(c).dispatchEvent(new /** @type {any} */ (globalThis).Event("pointerup"));
  await tick(15);
}
/** @param {any} c @param {string} k */
function key(c, k, extra = {}) { return c.key(Object.assign({ key: k }, extra)); }

test("no voice key: tapping the mic shows the Settings link, never opens a stream", async () => {
  statusAnswer = { key: false, provider: "deepgram" };
  const c = mountComposer({ thread: thread() });
  await tap(c);
  assert.match(text($(c.el, ".composer-note")), /Add a voice key in.*Settings.*voice/);
  assert.equal(mic(c).classList.contains("on"), false);
  c.stop();
});

test("a tap starts and stays open after release; a second tap stops and keeps the words", async () => {
  statusAnswer = { key: true, provider: "deepgram" };
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=tap1" };
  const c = mountComposer({ thread: thread() });
  await tap(c);
  assert.equal(mic(c).classList.contains("on"), true, "stays open after a quick release");
  const ws = /** @type {any} */ (FakeWebSocket).last;
  ws.onmessage({ data: JSON.stringify({ type: "final", text: "hello there" }) });
  assert.equal(c.value(), "hello there");

  await tap(c); // the second tap: stop
  assert.deepEqual(JSON.parse(ws.sent[ws.sent.length - 1]), { type: "end" });
  ws.onmessage({ data: JSON.stringify({ type: "done", text: "hello there" }) });
  assert.equal(mic(c).classList.contains("on"), false);
  assert.equal(c.value(), "hello there", "the words stay");
  c.stop();
});

test("session-view voice states: recording reads Listening, a stop tap reads Transcribing until done, then clears", async () => {
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=states1" };
  const c = mountComposer({ thread: thread() });
  await tap(c);
  assert.match(text($(c.el, ".composer-voice-pill")), /Listening \d:\d\d$/, "recording");
  assert.equal(mic(c).classList.contains("stopping"), false);
  const ws = /** @type {any} */ (FakeWebSocket).last;
  ws.onmessage({ data: JSON.stringify({ type: "final", text: "hello there" }) });

  await tap(c); // the second tap: stop
  assert.equal(mic(c).classList.contains("on"), true, "still open - your server has not answered yet");
  assert.equal(mic(c).classList.contains("stopping"), true, "transcribing");
  assert.equal(mic(c).getAttribute("aria-label"), "Transcribing");
  assert.match(text($(c.el, ".composer-voice-pill")), /Transcribing…$/);

  ws.onmessage({ data: JSON.stringify({ type: "done", text: "hello there" }) });
  assert.equal(mic(c).classList.contains("on"), false);
  assert.equal(mic(c).classList.contains("stopping"), false);
  assert.equal(mic(c).getAttribute("aria-label"), "Talk");
  assert.equal($(c.el, ".composer-voice-pill").hidden, true, "cleared once done answers");
  c.stop();
});

test("no voice key: the mic never reads Transcribing, since it never opened", async () => {
  statusAnswer = { key: false, provider: "deepgram" };
  const c = mountComposer({ thread: thread() });
  await tap(c);
  assert.equal($(c.el, ".composer-voice-pill").hidden, true);
  assert.equal(mic(c).classList.contains("stopping"), false);
  statusAnswer = { key: true, provider: "deepgram" };
  c.stop();
});

test("two quick taps (open, then stop) before the socket ever opens still closes it (reviewer-2's WS-leak finding)", async () => {
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=lateopen1" };
  FakeWebSocket.autoOpen = false; // held CONNECTING: onOpen (voiceListening=true) fires on its
  // own, well before a real socket handshake ever would - the exact gap that leaked before the fix
  try {
    const c = mountComposer({ thread: thread() });
    await tap(c); // opens; voiceListening is already true (onOpen fires independent of ws.onopen)
    await tap(c); // a second tap while listening: stop() - readyState is still CONNECTING here
    const ws = /** @type {any} */ (FakeWebSocket).last;
    assert.equal(ws.opened, undefined, "never opened in this world - onopen was never called");
    assert.equal(ws.closed, true, "cleanup() must close the socket itself; sending 'end' only works once OPEN");
    c.stop();
  } finally { FakeWebSocket.autoOpen = true; }
});

test("a hold past the threshold: release stops (push-to-talk), never sends", async () => {
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=hold1" };
  const c = mountComposer({ thread: thread() });
  await hold(c);
  const ws = /** @type {any} */ (FakeWebSocket).last;
  assert.deepEqual(JSON.parse(ws.sent[ws.sent.length - 1]), { type: "end" }, "release past the hold threshold stops");
  assert.equal(sendCalls.length, 0);
  ws.close(); // as the box's own close would - clears voice.js's 6 s fallback cleanup at once
  c.stop();
});

test("words land at the cursor, never over what was already typed", async () => {
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=cursor1" };
  const c = mountComposer({ thread: thread() });
  c.setText("before  after");
  c.input.setSelectionRange(7, 7); // between the two spaces
  await tap(c);
  const ws = /** @type {any} */ (FakeWebSocket).last;
  ws.onmessage({ data: JSON.stringify({ type: "partial", text: "middle" }) });
  assert.equal(c.value(), "before middle after");
  ws.onmessage({ data: JSON.stringify({ type: "final", text: "middle bit" }) });
  assert.equal(c.value(), "before middle bit after");
  await tap(c);
  ws.close();
  c.stop();
});

test("Esc cancels and removes only what this dictation added, not text before or after it", async () => {
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=esc1" };
  const c = mountComposer({ thread: thread() });
  c.setText("keep this, and this");
  c.input.setSelectionRange(10, 10);
  await tap(c);
  const ws = /** @type {any} */ (FakeWebSocket).last;
  ws.onmessage({ data: JSON.stringify({ type: "final", text: " dictated words" }) });
  assert.equal(c.value(), "keep this, dictated words and this");
  const handled = key(c, "Escape");
  assert.equal(handled, true);
  assert.equal(c.value(), "keep this, and this", "back to exactly what it was before listening");
  assert.equal(mic(c).classList.contains("on"), false);
  ws.close();
  c.stop();
});

test("Enter stops and sends; the send button does the same while listening", async () => {
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=enter1" };
  sendCalls = [];
  const c = mountComposer({ thread: thread() });
  await tap(c);
  const ws = /** @type {any} */ (FakeWebSocket).last;
  ws.onmessage({ data: JSON.stringify({ type: "final", text: "ship it" }) });
  const e = Object.assign(new /** @type {any} */ (globalThis).Event("keydown"), { key: "Enter", target: c.input });
  c.input.dispatchEvent(e);
  await tick();
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].text, "ship it");
  assert.equal(c.value(), "", "sent: your server clears");
  assert.equal(mic(c).classList.contains("on"), false);
  ws.close();
  c.stop();
});

test("\"send it\" at the end of a final strips the phrase and sends", async () => {
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=cmd1" };
  sendCalls = [];
  const c = mountComposer({ thread: thread() });
  await tap(c);
  const ws = /** @type {any} */ (FakeWebSocket).last;
  ws.onmessage({ data: JSON.stringify({ type: "final", text: "tell the team we shipped it, send it" }) });
  await tick();
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].text, "tell the team we shipped it,");
  ws.close();
  c.stop();
});

test("\"scratch that\" removes only the last committed phrase", async () => {
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=cmd2" };
  const c = mountComposer({ thread: thread() });
  await tap(c);
  const ws = /** @type {any} */ (FakeWebSocket).last;
  // local/voice/listen.js's "final" is cumulative (its own running "committed" string), so the
  // second final carries the first phrase's text too, per the real protocol.
  ws.onmessage({ data: JSON.stringify({ type: "final", text: "first phrase" }) });
  ws.onmessage({ data: JSON.stringify({ type: "final", text: "first phrase second phrase, scratch that" }) });
  assert.equal(c.value(), "first phrase", "the second phrase never landed - stripped before it was ever inserted");
  await tap(c);
  ws.close();
  c.stop();
});

test("a denied mic permission gets a plain one-line fix, not a raw browser error", async () => {
  getUserMediaError = Object.assign(new Error("denied"), { name: "NotAllowedError" });
  const c = mountComposer({ thread: thread() });
  await tap(c);
  assert.match(text($(c.el, ".composer-note")), /blocked.*browser's settings/i);
  getUserMediaError = null;
  c.stop();
});

test("silence: a 2 minute warning, a 5 minute auto-stop", async () => {
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=silence1" };
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const c = mountComposer({ thread: thread() });
    await tap(c); // tap() only awaits promise chains (flush()), so mocking timers first is safe
    mock.timers.tick(2 * 60_000);
    assert.match(text($(c.el, ".composer-note")), /Still listening/);
    mock.timers.tick(3 * 60_000); // total 5 minutes
    const ws = /** @type {any} */ (FakeWebSocket).last;
    assert.deepEqual(JSON.parse(ws.sent[ws.sent.length - 1]), { type: "end" }, "auto-stopped at 5 minutes");
    c.stop();
  } finally { mock.timers.reset(); }
});

test("Ctrl+M (the exported key/keyUp, the global-shortcut path) taps the same as the mic button", async () => {
  listenAnswer = { path: "/v1/streams/voice/listen?ticket=ctrlm1" };
  const c = mountComposer({ thread: thread() });
  const down = key(c, "m", { ctrlKey: true });
  assert.equal(down, true, "Ctrl+M is handled");
  await tick(5);
  const up = c.keyUp({ key: "m" });
  assert.equal(up, true);
  await tick(15);
  assert.equal(mic(c).classList.contains("on"), true, "a quick tap of the shortcut stays open");
  /** @type {any} */ (FakeWebSocket).last.close();
  c.stop();
});
