// @ts-check
// api.js on core/resilience (docs/adr/0029-resilience.md): the Deck's one event stream is follow()
// over fetch, so the first connection starts at the newest event and every reconnect resumes from
// the cursor, and listeners get the same event objects as before.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { install } from "../test/fake-dom.js";

const define = (/** @type {string} */ k, /** @type {any} */ v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
define("location", { search: "", hostname: "localhost", host: "localhost:4747", origin: "http://localhost:4747", pathname: "/now", hash: "" });
install();
/** @type {Map<string, string>} */
const kept = new Map();
define("localStorage", { getItem: (/** @type {string} */ k) => kept.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { kept.set(k, String(v)); },
  removeItem: (/** @type {string} */ k) => { kept.delete(k); } });
define("sessionStorage", { getItem: () => null, setItem() {}, removeItem() {} });
/** @type {any[]} */
const events = [];
define("dispatchEvent", (/** @type {any} */ e) => { events.push(e); return true; });
// Only a browser opens the stream (api.js looks for EventSource); this says we are one.
define("EventSource", class {});

/** One open stream: what was asked for, and a way to write to it or end it. */
/** @type {{ url: string, headers: Record<string, string>, push: (s: string) => void, end: () => void }[]} */
const streams = [];
/** Tool calls: url, headers, body. */
/** @type {{ url: string, headers: Record<string, string>, body: any }[]} */
const sent = [];
/** What the box does with the next tool call. @type {(url: string, body: any) => { status: number, body: any } | "down"} */
let box = () => ({ status: 200, body: { data: {} } });

// @ts-ignore: a fake fetch for the stream and the tool calls.
globalThis.fetch = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
  if (String(url).includes("/v1/events/stream")) {
    /** @type {ReadableStreamDefaultController<Uint8Array>} */ let ctrl;
    const body = new ReadableStream({ start(c) { ctrl = c; } });
    init.signal?.addEventListener("abort", () => { try { ctrl.error(new Error("aborted")); } catch {} });
    const enc = new TextEncoder();
    streams.push({ url, headers: init.headers || {}, push: s => ctrl.enqueue(enc.encode(s)), end: () => { try { ctrl.close(); } catch {} } });
    return { ok: true, status: 200, body };
  }
  const body = JSON.parse(init.body || "{}");
  sent.push({ url, headers: init.headers || {}, body });
  const r = box(url, body);
  if (r === "down") throw new TypeError("Failed to fetch");
  return { ok: r.status < 400, status: r.status, statusText: "", headers: new Headers(), json: async () => r.body };
};

const api = await import("./api.js");
const tick = () => new Promise(r => setTimeout(r, 20));

test("events: the first stream starts at the newest event, and a reconnect resumes from the cursor", async () => {
  /** @type {any[]} */ const heard = [], all = [];
  const off = api.on("thread.*", e => heard.push(e));
  api.on("*", e => all.push(e));
  await tick();
  assert.equal(streams.length, 1);
  assert.match(streams[0].url, /^http:\/\/localhost:4747\/v1\/events\/stream\?type=\*&since=latest$/);
  assert.equal(streams[0].headers["last-event-id"], undefined);
  assert.equal(streams[0].headers["x-vyre-caller"], "deck");
  const ev = { id: 6, at: 1, type: "thread.text", source: "switchboard", project: "harlow-legal", thread: "t1", payload: { text: "hi" } };
  streams[0].push(": open\n\nretry: 2000\nid: 5\n\n");
  streams[0].push(`id: 6\nevent: thread.text\ndata: ${JSON.stringify(ev)}\n\n`);
  streams[0].push(`id: 6\nevent: thread.text\ndata: ${JSON.stringify(ev)}\n\n`); // a double
  streams[0].push(`id: 7\nevent: gate.held\ndata: ${JSON.stringify({ ...ev, id: 7, type: "gate.held" })}\n\n`);
  await tick();
  assert.deepEqual(heard, [ev], "the same object, once, and only what the prefix names");
  assert.deepEqual(all.map(e => e.id), [6, 7]);
  assert.equal(api.streamState?.state, "open");
  assert.equal(events.filter(e => e.type === "deck:stream").at(-1).detail.state, "open");

  streams[0].end();
  await tick();
  assert.equal(api.streamState?.state, "reconnecting");
  assert.equal(api.reachable, false);
  api.kick(); // the pill's Retry, or a network change: now, not after the backoff
  await tick();
  assert.equal(streams.length, 2);
  assert.match(streams[1].url, /since=7$/);
  assert.equal(streams[1].headers["last-event-id"], "7");
  streams[1].push("retry: 2000\nid: 7\n\n");
  streams[1].push(`id: 8\nevent: thread.text\ndata: ${JSON.stringify({ ...ev, id: 8 })}\n\n`);
  await tick();
  assert.deepEqual(heard.map(e => e.id), [6, 8]);
  assert.equal(api.reachable, true);
  off();
});

test("idempotency: a write carries one key, the same on the retry after a sign-in; a read carries none", async () => {
  sent.length = 0;
  let signIns = 0;
  api.setPersonHandler(async () => { signIns++; });
  let first = true;
  box = () => (first ? (first = false, { status: 401, body: { error: { code: "person_session_required", message: "sign in" } } }) : { status: 200, body: { data: { ok: true } } });
  assert.deepEqual(await api.call("planner.add", { text: "call kit at 6" }, { write: true }), { ok: true });
  assert.equal(signIns, 1);
  assert.equal(sent.length, 2);
  const k = sent[0].headers["idempotency-key"];
  assert.match(k, /^[A-Za-z0-9_.:-]{8,128}$/, "a key the box accepts");
  assert.equal(sent[1].headers["idempotency-key"], k, "the retry is the same write");
  api.setPersonHandler(null);

  sent.length = 0;
  box = () => ({ status: 200, body: { data: [] } });
  await api.call("planner.add", { text: "and again" }, { write: true });
  assert.notEqual(sent[0].headers["idempotency-key"], k, "a new write, a new key");
  await api.call("planner.list", {});
  assert.equal(sent[1].headers["idempotency-key"], undefined, "reads are not kept by the box");
});

test("idempotency: an owner's answer the box wants a passkey for goes again with the same key", async () => {
  sent.length = 0;
  box = url => (url === "/v1/presence/challenge" ? { status: 200, body: { data: { challenge: "c1", webauthn: { challenge: "AAAA", rpId: "localhost" } } } }
    : sent.filter(x => x.url.startsWith("/v1/tools/")).length === 1 ? { status: 403, body: { error: { code: "presence_required", message: "prove it" } } } : { status: 200, body: { data: { state: "answered" } } });
  const bytes = (/** @type {string} */ s) => new TextEncoder().encode(s).buffer;
  define("PublicKeyCredential", class {});
  define("navigator", { userAgent: "iPhone", onLine: true, credentials: { get: async () => ({ rawId: bytes("cred"),
    response: { authenticatorData: bytes("ad"), clientDataJSON: bytes("cd"), signature: bytes("sig") } }) } });
  await api.call("threads.answer", { ask: "a1", decision: "allow", surface: "deck" }, { presence: "asked", key: "k-answer-0001" });
  const tools = sent.filter(x => x.url === "/v1/tools/threads.answer");
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map(x => x.headers["idempotency-key"]), ["k-answer-0001", "k-answer-0001"]);
  assert.match(tools[1].headers["x-vyre-presence"], /^passkey /);
});

/** End the open stream and bring a new one up, as a box that comes back does. */
async function reconnect() {
  streams.at(-1)?.end();
  await tick();
  api.kick();
  await tick();
  streams.at(-1)?.push(`retry: 2000\nid: 8\n\n`);
  await tick();
}
const tools = (/** @type {string} */ t) => sent.filter(x => x.url === "/v1/tools/" + t);

test("outbox: a send the box did not get waits, says so, and goes once when the stream is back, with the same key", async () => {
  sent.length = 0;
  let up = false;
  box = url => (url === "/v1/tools/threads.send" && !up ? "down" : { status: 200, body: { data: { sent: true } } });
  let waited = 0;
  const p = api.queued("threads.send", { thread: "t1", text: "the Northwind Bakery order is in", surface: "deck" }, { onWait: () => { waited++; } });
  await tick();
  assert.equal(waited, 1, "the view hears that it waits, once");
  assert.equal(tools("threads.send").length, 1);
  const key = tools("threads.send")[0].headers["idempotency-key"];
  assert.ok(key);
  up = true;
  await reconnect();
  assert.deepEqual(await p, { data: { sent: true } });
  assert.equal(tools("threads.send").length, 2, "tried, then delivered once");
  assert.equal(tools("threads.send")[1].headers["idempotency-key"], key, "the replay is the same write");
  await reconnect();
  assert.equal(tools("threads.send").length, 2, "nothing goes twice");
  assert.equal(waited, 1);
});

test("outbox: a refusal on its merits (4xx) is the view's error and is never tried again", async () => {
  sent.length = 0;
  box = () => ({ status: 400, body: { error: { code: "bad_input", message: "ask a9 was already answered" } } });
  const r = await api.queued("threads.answer", { ask: "a9", decision: "allow", surface: "deck" });
  assert.ok(r.error instanceof api.ApiError);
  assert.equal(r.error.code, "bad_input");
  assert.equal(r.error.message, "ask a9 was already answered");
  // A tool's own "timeout" (a Mac that did not answer) is an answer too, not "not now".
  box = () => ({ status: 500, body: { error: { code: "timeout", message: "alex-mac did not answer in time" } } });
  const t = await api.queued("threads.send", { thread: "t2", text: "hello", surface: "deck", machine: "alex-mac" });
  assert.equal(t.error.code, "timeout");
  box = () => ({ status: 200, body: { data: {} } });
  await reconnect();
  assert.equal(tools("threads.answer").length, 1);
  assert.equal(tools("threads.send").length, 1);
});

test("outbox: a write that needs a passkey is never queued; offline it fails at once", async () => {
  sent.length = 0;
  /** @type {any} */ (navigator).onLine = false;
  const r = await api.queued("gate.approve", { id: "g1" }, { presence: true });
  assert.equal(r.error.code, "offline");
  assert.equal(sent.length, 0, "no challenge, no passkey, nothing sent");
  /** @type {any} */ (navigator).onLine = true;
  box = url => (url === "/v1/presence/challenge" ? { status: 200, body: { data: { challenge: "c2", webauthn: { challenge: "AAAA", rpId: "localhost" } } } } : "down");
  const down = await api.queued("gate.approve", { id: "g1" }, { presence: true });
  assert.equal(down.error.code, "offline", "the box went away after the passkey: the existing offline error");
  assert.equal(tools("gate.approve").length, 1);
  assert.ok(tools("gate.approve")[0].headers["idempotency-key"]);
  box = () => ({ status: 200, body: { data: {} } });
  await reconnect();
  assert.equal(tools("gate.approve").length, 1, "not replayed: the proof was for that moment");
});

after(() => api.stopEvents());
