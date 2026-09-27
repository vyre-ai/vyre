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

after(() => api.stopEvents());
