// @ts-check
// The phone's stream transport (native-open.ts) under the box's own follow() (stream.js), with a
// fake XMLHttpRequest: frames split at every awkward point, heartbeats, CRLF, and a resume with
// Last-Event-ID after the stream drops. These carry over the old sse.js parser cases.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { follow } from "../../../../core/resilience/stream.js";
import { backoff } from "../../../../core/resilience/backoff.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./native-open.ts");

class FakeXhr {
  /** @type {FakeXhr[]} */ static all = [];
  readyState = 0; status = 0; responseText = ""; url = ""; aborted = false;
  /** @type {Record<string, string>} */ headers = {};
  /** @type {any} */ onreadystatechange = null; /** @type {any} */ onprogress = null; /** @type {any} */ onload = null;
  /** @type {any} */ onerror = null; /** @type {any} */ ontimeout = null; /** @type {any} */ onabort = null;
  constructor() { FakeXhr.all.push(this); }
  /** @param {string} _m @param {string} url */ open(_m, url) { this.url = url; }
  /** @param {string} k @param {string} v */ setRequestHeader(k, v) { this.headers[k] = v; }
  send() {}
  abort() { if (this.aborted) return; this.aborted = true; this.onabort?.(); }
  /** @param {number} status */ answer(status = 200) { this.status = status; this.readyState = 2; this.onreadystatechange?.(); }
  /** @param {string} text */ push(text) { this.responseText += text; this.readyState = 3; this.onprogress?.(); }
  end() { this.readyState = 4; this.onload?.(); }
}

const tick = () => new Promise(r => setTimeout(r, 0));
/** @param {() => boolean} ok */
async function until(ok) { for (let i = 0; i < 500 && !ok(); i++) await new Promise(r => setTimeout(r, 2)); assert.ok(ok(), "timed out"); }

const STREAM =
  "retry: 2000\nid: 6\n\n" +
  ": beat\n\n" +
  'id: 7\nevent: thread.text\ndata: {"id":7,"type":"thread.text","payload":{"text":"hi"}}\n\n' +
  'id: 8\r\nevent: gate.held\r\ndata: {"id":8,"type":"gate.held"}\r\n\r\n' +
  'id: 9\ndata: {"id":9,\ndata: "type":"x"}\n\n';

/** @param {string[]} chunks */
async function run(chunks) {
  const { createOpen } = await load();
  FakeXhr.all = [];
  /** @type {any[]} */ const got = [];
  const s = follow({ paths: ["https://harlow.example.ts.net"], open: createOpen({ XHR: /** @type {any} */ (FakeXhr) }), onEvent: e => got.push(e), backoff: backoff({ min: 1, max: 1 }) });
  await until(() => FakeXhr.all.length === 1);
  const x = FakeXhr.all[0];
  x.answer(200);
  await tick();
  for (const c of chunks) { x.push(c); await tick(); }
  try { await until(() => got.length >= 3); }
  finally { s.stop(); }
  return { got, x, cursor: s.cursor };
}

test("native-open: the whole stream in one chunk gives the events, heartbeats ignored", { skip: !strip }, async () => {
  const { got, x, cursor } = await run([STREAM]);
  assert.deepEqual(got.map(e => e.id), [7, 8, 9]);
  assert.equal(got[0].payload.text, "hi");
  assert.equal(got[2].type, "x", "two data lines join with a newline");
  assert.equal(cursor, 9);
  assert.equal(x.url, "https://harlow.example.ts.net/v1/events/stream?type=*&since=latest");
  assert.equal(x.headers.accept, "text/event-stream");
  assert.equal(x.headers["x-vyre-caller"], undefined);
  assert.equal(x.aborted, true, "stop() aborts the request");
});

const LF = STREAM.replace(/\r\n/g, "\n");

test("native-open: one character at a time parses the same", { skip: !strip }, async () => {
  const { got } = await run([...LF]);
  assert.deepEqual(got.map(e => e.id), [7, 8, 9]);
});

// core/resilience/sse.js turns a chunk's trailing "\r" into "\n" before the "\n" after it
// arrives, so a CRLF split across chunks ends the frame early: the bare `id: 8` moves the cursor
// and the event 8 behind it is dropped. vyred writes LF only, so this waits on the core fix.
test("native-open: a CRLF split between chunks parses the same", { skip: !strip }, async () => {
  const { got } = await run([...STREAM]);
  assert.deepEqual(got.map(e => e.id), [7, 8, 9]);
});

test("native-open: a frame without its blank line is held back", { skip: !strip }, async () => {
  const { createOpen } = await load();
  FakeXhr.all = [];
  const open = createOpen({ XHR: /** @type {any} */ (FakeXhr) });
  const ac = new AbortController();
  const p = open({ base: "https://harlow.example.ts.net", path: "/v1/events/stream", headers: {}, signal: ac.signal });
  const x = FakeXhr.all[0];
  x.answer(200);
  const r = await p;
  assert.equal(r.status, 200);
  x.push("id: 1\ndata: {}\n");
  x.push("\n");
  x.end();
  /** @type {string[]} */ const parts = [];
  for await (const c of r.chunks) parts.push(c);
  assert.deepEqual(parts, ["id: 1\ndata: {}\n", "\n"], "each progress hands on only the new text");
});

test("native-open: a drop resumes with Last-Event-ID and never repeats an event", { skip: !strip }, async () => {
  const { createOpen } = await load();
  FakeXhr.all = [];
  /** @type {number[]} */ const got = [];
  const s = follow({ paths: ["https://harlow.example.ts.net"], open: createOpen({ XHR: /** @type {any} */ (FakeXhr) }), onEvent: e => got.push(e.id), backoff: backoff({ min: 1, max: 1 }) });
  await until(() => FakeXhr.all.length === 1);
  const a = FakeXhr.all[0];
  a.answer(200);
  a.push('id: 3\ndata: {"id":3,"type":"gate.held"}\n\n');
  await until(() => got.length === 1);
  a.onerror?.();
  await until(() => FakeXhr.all.length === 2);
  const b = FakeXhr.all[1];
  assert.equal(b.headers["last-event-id"], "3");
  assert.match(b.url, /since=3/);
  b.answer(200);
  b.push('id: 3\ndata: {"id":3,"type":"gate.held"}\n\nid: 4\ndata: {"id":4,"type":"gate.sent"}\n\n');
  await until(() => got.length === 2);
  s.stop();
  assert.deepEqual(got, [3, 4]);
});

test("native-open: a long response is ended at maxBytes so the stream reconnects", { skip: !strip }, async () => {
  const { createOpen } = await load();
  FakeXhr.all = [];
  const open = createOpen({ XHR: /** @type {any} */ (FakeXhr), maxBytes: 10 });
  const p = open({ base: "https://harlow.example.ts.net", path: "/v1/events/stream", headers: {}, signal: new AbortController().signal });
  const x = FakeXhr.all[0];
  x.answer(200);
  const r = await p;
  x.push(": beat beat beat\n\n");
  assert.equal(x.aborted, true);
  /** @type {string[]} */ const parts = [];
  for await (const c of r.chunks) parts.push(c);
  assert.deepEqual(parts, [": beat beat beat\n\n"]);
});
