// @ts-check
// The browser adapters (core/resilience/web.js) on their own: the stores over a small in-memory
// IndexedDB and over storage that throws, the lifecycle over fake window and document targets,
// and the transport's auth headers and base path (docs/adr/0029-resilience.md, R1, R2, R3, R5).
// The same transport against vyred and the fault proxies is in chaos.test.js.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { idbStore, cursorStore, cacheStore, lifecycle, open, over } from "../../core/resilience/web.js";
import { follow } from "../../core/resilience/stream.js";
import { outbox, memoryStore } from "../../core/resilience/outbox.js";
import { backoff } from "../../core/resilience/backoff.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Just enough IndexedDB for web.js: open with versions and upgrades, versionchange, one object
 * store per name with out-of-line keys, get/put/delete and a transaction's complete.
 */
function fakeIndexedDB() {
  /** @type {Map<string, { version: number, stores: Map<string, Map<string, any>>, conns: Set<any> }>} */
  const dbs = new Map();
  const counts = { opens: 0, puts: 0 };
  const req = () => /** @type {any} */ ({ result: undefined, error: null });
  function connection(d, version) {
    let closed = false;
    const c = {
      version,
      onversionchange: null,
      objectStoreNames: { contains: n => d.stores.has(n) },
      createObjectStore(n) { d.stores.set(n, new Map()); },
      close() { closed = true; d.conns.delete(c); },
      transaction(n, mode) {
        if (closed) throw Object.assign(new Error("closed"), { name: "InvalidStateError" });
        const m = d.stores.get(n);
        if (!m) throw Object.assign(new Error("no store"), { name: "NotFoundError" });
        const tx = /** @type {any} */ ({});
        const finish = () => queueMicrotask(() => tx.oncomplete?.());
        tx.objectStore = () => ({
          get(k) { const r = req(); queueMicrotask(() => { r.result = structuredClone(m.get(k)); r.onsuccess?.(); }); return r; },
          put(v, k) { if (mode !== "readwrite") throw new Error("readonly"); counts.puts++; m.set(k, structuredClone(v)); finish(); return req(); },
          delete(k) { m.delete(k); finish(); return req(); },
        });
        return tx;
      },
    };
    return c;
  }
  return {
    dbs, counts,
    open(name, version) {
      counts.opens++;
      const r = req();
      queueMicrotask(() => {
        const d = dbs.get(name) ?? { version: 0, stores: new Map(), conns: new Set() };
        dbs.set(name, d);
        const v = version ?? (d.version || 1);
        if (v < d.version) { r.error = { name: "VersionError" }; return r.onerror?.({ preventDefault() {} }); }
        const c = connection(d, v);
        r.result = c;
        if (v > d.version) { for (const o of [...d.conns]) o.onversionchange?.(); d.version = v; r.onupgradeneeded?.(); }
        d.conns.add(c);
        r.onsuccess?.();
      });
      return r;
    },
  };
}

function fakeLocalStorage() {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
}
const throwing = () => { throw Object.assign(new Error("The operation is insecure."), { name: "SecurityError" }); };
const brokenIDB = { open: throwing };
const brokenLS = { getItem: throwing, setItem: throwing, removeItem: throwing };

const entry = (key, n) => ({ key, tool: "chaos.add", input: { n }, at: 1, tries: 0, state: /** @type {const} */ ("sending") });

test("R2: the browser outbox store keeps entries in IndexedDB, one object store per box", async () => {
  const idb = fakeIndexedDB();
  const env = /** @type {any} */ ({ indexedDB: idb, localStorage: null });
  await idbStore("box-alex", env).save([entry("k1", 1), entry("k2", 2)]);
  const back = await idbStore("box-alex", env).load();
  assert.deepEqual(back.map(e => e.key), ["k1", "k2"]);
  assert.deepEqual([...idb.dbs.keys()], ["vyre-resilience"]);
  assert.ok(idb.dbs.get("vyre-resilience")?.stores.has("box-alex"));
  assert.deepEqual(await idbStore("box-juno", env).load(), [], "another box has its own outbox");
});

test("R2: an outbox on the browser store survives a reload and delivers what was queued", async () => {
  const idb = fakeIndexedDB();
  const env = /** @type {any} */ ({ indexedDB: idb, localStorage: null });
  const refuse = async () => ({ error: { code: "unreachable", message: "offline" } });
  const first = await outbox({ store: idbStore("box-alex", env), call: refuse, backoff: backoff({ min: 60_000, jitter: 0 }) });
  await first.add("chaos.add", { n: 1 }, { key: "key-1" });
  await first.add("chaos.add", { n: 2 }, { key: "key-2" });
  first.stop();
  const got = [];
  const second = await outbox({ store: idbStore("box-alex", env), call: async (tool, input, key) => { got.push(key); return { data: input }; } });
  await second.kick();
  assert.deepEqual(got, ["key-1", "key-2"]);
  assert.deepEqual(await idbStore("box-alex", env).load(), []);
});

test("R2: stores for several boxes opened at once each get their object store", async () => {
  const idb = fakeIndexedDB();
  const env = /** @type {any} */ ({ indexedDB: idb, localStorage: null });
  const boxes = ["box-a", "box-b", "box-c", "box-d"];
  await Promise.all(boxes.map((b, i) => idbStore(b, env).save([entry("k" + i, i)])));
  for (const [i, b] of boxes.entries()) assert.deepEqual((await idbStore(b, env).load()).map(e => e.key), ["k" + i]);
  assert.deepEqual([...(idb.dbs.get("vyre-resilience")?.stores.keys() ?? [])].sort(), boxes);
});

test("R1: the cursor store persists the cursor per box and coalesces a burst of saves", async () => {
  const idb = fakeIndexedDB();
  const env = /** @type {any} */ ({ indexedDB: idb, localStorage: null });
  const c = cursorStore("box-alex", env);
  assert.equal(await c.load(), null);
  for (let n = 1; n <= 200; n++) c.save(n);
  await sleep(20);
  assert.equal(await cursorStore("box-alex", env).load(), 200);
  assert.ok(idb.counts.puts < 10, `200 saves made ${idb.counts.puts} writes`);
  assert.equal(await cursorStore("box-juno", env).load(), null);
});

test("R3: the cache store keeps each view's last state with when it was saved and its cursor", async () => {
  const env = /** @type {any} */ ({ indexedDB: fakeIndexedDB(), localStorage: null });
  const c = cacheStore("box-alex", env);
  assert.equal(await c.get("now"), null);
  await c.set("now", { cards: ["Harlow Legal intake"] }, { cursor: 41, now: () => 1000 });
  await c.set("thread:t1", { text: "hello kit" });
  const again = cacheStore("box-alex", env);
  assert.deepEqual(await again.get("now"), { value: { cards: ["Harlow Legal intake"] }, at: 1000, cursor: 41 });
  assert.deepEqual((await again.get("thread:t1"))?.value, { text: "hello kit" });
  await again.del("now");
  assert.equal(await cacheStore("box-alex", env).get("now"), null);
});

test("R3: with IndexedDB refused, the stores fall back to localStorage and still persist", async () => {
  const ls = fakeLocalStorage();
  const env = /** @type {any} */ ({ indexedDB: brokenIDB, localStorage: ls });
  await idbStore("box-alex", env).save([entry("k1", 1)]);
  cursorStore("box-alex", env).save(7);
  await cacheStore("box-alex", env).set("needs", [1, 2]);
  await sleep(10);
  assert.deepEqual((await idbStore("box-alex", env).load()).map(e => e.key), ["k1"]);
  assert.equal(await cursorStore("box-alex", env).load(), 7);
  assert.deepEqual((await cacheStore("box-alex", env).get("needs"))?.value, [1, 2]);
  assert.ok([...ls.m.keys()].every(k => k.startsWith("vyre-resilience:box-alex:")));
});

test("R3: storage that throws everywhere (a private window) degrades to memory and never throws", async () => {
  const env = /** @type {any} */ ({ indexedDB: brokenIDB, localStorage: brokenLS });
  const store = idbStore("box-alex", env);
  await store.save([entry("k1", 1)]);
  assert.deepEqual((await store.load()).map(e => e.key), ["k1"], "the page keeps it for as long as it lives");
  const c = cursorStore("box-alex", env);
  c.save(3);
  await sleep(10);
  assert.equal(await c.load(), 3);
  const cache = cacheStore("box-alex", env);
  await cache.set("planner", { days: 1 });
  assert.deepEqual((await cache.get("planner"))?.value, { days: 1 });
  await cache.del("planner");
  assert.equal(await cache.get("planner"), null);
  assert.equal(await cursorStore("box-alex", env).load(), null, "a fresh page starts from nothing");
  // No storage at all, and a transaction that throws after the database opened.
  const none = /** @type {any} */ ({ indexedDB: null, localStorage: null });
  assert.deepEqual(await idbStore("box-alex", none).load(), []);
  const idb = fakeIndexedDB();
  const quota = /** @type {any} */ ({ indexedDB: idb, localStorage: brokenLS });
  await idbStore("box-q", quota).load();
  for (const conn of idb.dbs.get("vyre-resilience")?.conns ?? []) conn.transaction = () => { throw Object.assign(new Error("full"), { name: "QuotaExceededError" }); };
  const q = idbStore("box-q", quota);
  await q.save([entry("k9", 9)]);
  assert.deepEqual((await q.load()).map(e => e.key), ["k9"]);
});

/** A stream and an outbox that count what the lifecycle asked of them. */
function fakes() {
  const calls = [];
  const stream = /** @type {any} */ ({ pause: () => calls.push("pause"), resume: () => calls.push("resume"), kick: () => calls.push("kick") });
  const box = { kick: () => calls.push("outbox.kick") };
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const show = state => { doc.visibilityState = state; doc.dispatchEvent(new Event("visibilitychange")); };
  const page = (type, persisted) => win.dispatchEvent(Object.assign(new Event(type), { persisted }));
  return { calls, stream, box, win, doc, show, page };
}

test("R3: the lifecycle pauses a hidden page and resumes it once when it comes back, and unwires", () => {
  const f = fakes();
  const off = lifecycle(f.stream, { win: f.win, doc: f.doc, outbox: f.box });
  f.show("hidden"); f.show("hidden");
  f.show("visible"); f.show("visible");
  assert.deepEqual(f.calls, ["pause", "resume", "outbox.kick"]);
  // Back/forward cache: pagehide then pageshow, with the visibility events around them.
  f.calls.length = 0;
  f.show("hidden"); f.page("pagehide", true);
  f.page("pageshow", true); f.show("visible");
  assert.deepEqual(f.calls, ["pause", "resume", "outbox.kick"]);
  // A pageshow from the cache on a page that was never hidden: the connection is gone, kick.
  f.calls.length = 0;
  f.page("pageshow", true);
  f.page("pageshow", false);
  assert.deepEqual(f.calls, ["kick", "outbox.kick"]);
  f.calls.length = 0;
  off();
  f.show("hidden"); f.win.dispatchEvent(new Event("online"));
  assert.deepEqual(f.calls, []);
});

test("R3, R5: a network change kicks the stream, and coming online kicks the outbox too", () => {
  const f = fakes();
  const off = lifecycle(f.stream, { win: f.win, doc: f.doc, outbox: f.box });
  f.win.dispatchEvent(new Event("offline"));
  assert.deepEqual(f.calls, ["kick"]);
  f.win.dispatchEvent(new Event("online"));
  assert.deepEqual(f.calls, ["kick", "kick", "outbox.kick"]);
  off();
});

test("R3: a page wired while hidden starts paused, and the lifecycle works with no stream or no outbox", () => {
  const f = fakes();
  f.doc.visibilityState = "hidden";
  const off = lifecycle(f.stream, { win: f.win, doc: f.doc });
  assert.deepEqual(f.calls, ["pause"]);
  f.show("visible");
  assert.deepEqual(f.calls, ["pause", "resume"]);
  off();
  const g = fakes();
  const off2 = lifecycle(null, { win: g.win, doc: g.doc, outbox: g.box });
  g.win.dispatchEvent(new Event("online"));
  assert.deepEqual(g.calls, ["outbox.kick"]);
  off2();
  assert.doesNotThrow(() => lifecycle(null, { win: undefined, doc: undefined })());
});

test("R2: outbox.kick skips the backoff wait but does not ask for presence again", async () => {
  let n = 0;
  const answers = [{ error: { code: "unreachable", message: "x" } }, { data: 1 }];
  const box = await outbox({ store: memoryStore(), call: async () => answers[Math.min(n++, 1)], backoff: backoff({ min: 60_000, jitter: 0 }) });
  const { answered } = await box.add("chaos.add", { n: 1 });
  await sleep(10);
  assert.equal(box.pending[0]?.state, "waiting");
  await box.kick();
  assert.deepEqual(await answered, { data: 1 });
  let asked = 0;
  const gated = await outbox({ store: memoryStore(), call: async () => { asked++; return { error: { code: "presence_required", message: "Touch ID" } }; } });
  await gated.add("gate.approve", { id: "g1" });
  await sleep(10);
  await gated.kick();
  assert.equal(asked, 1);
  assert.equal(gated.pending[0]?.state, "needs_presence");
  box.stop(); gated.stop();
});

test("R1, R5: the browser transport sends the caller's auth and cursor headers, keeps a relay base path, and stops on abort", { timeout: 10_000 }, async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, last: req.headers["last-event-id"] });
    if (!req.url?.includes("/v1/events/stream")) { res.writeHead(404); return res.end("no"); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("retry: 2000\nid: 5\n\n");
    // One event split inside its frame and inside a two-byte character.
    const frame = Buffer.from('data: {"id":6,"type":"thread.text","payload":{"n":"café"}}\n\n');
    const cut = frame.indexOf(0xc3) + 1;
    res.write(frame.subarray(0, cut));
    setTimeout(() => res.write(frame.subarray(cut)), 20);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/relay/box-alex/`;
  const ac = new AbortController();
  const r = await open({ base, path: "/v1/events/stream?since=4", headers: { authorization: "Bearer sample-token", "last-event-id": "4" }, signal: ac.signal });
  assert.equal(r.status, 200);
  let text = "";
  const reading = (async () => { try { for await (const c of r.chunks) text += c; } catch { /* aborted */ } })();
  await new Promise(res => { const tick = setInterval(() => { if (text.includes("\n\n", text.indexOf("data:"))) { clearInterval(tick); res(undefined); } }, 10); });
  ac.abort();
  await reading;
  assert.match(text, /id: 5/);
  assert.match(text, /"n":"café"/);
  assert.deepEqual(seen[0], { url: "/relay/box-alex/v1/events/stream?since=4", auth: "Bearer sample-token", last: "4" });
  const missing = await open({ base, path: "/v1/nothing", headers: {}, signal: new AbortController().signal });
  assert.equal(missing.status, 404);
  for await (const _ of missing.chunks) assert.fail("a refused open yields nothing");
  await assert.rejects(open({ base: "unix:/tmp/vyred.sock", path: "/v1/health", headers: {}, signal: ac.signal }), /http\(s\)/);
});

test("R5: over() runs follow and the outbox on a path-fetch (relay/client's paths), with one logical path and the key kept", async t => {
  /** @type {{ path: string, init: any }[]} */
  const seen = [];
  const enc = new TextEncoder();
  let opens = 0;
  // A stand-in for createPaths().fetch: it takes a path, not a URL, and answers a Response.
  const pathFetch = async (/** @type {string} */ path, /** @type {any} */ init) => {
    seen.push({ path, init });
    if (path.startsWith("/v1/tools/")) return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    opens++;
    const body = new ReadableStream({ start(c) {
      c.enqueue(enc.encode("id: 4\n\n"));
      c.enqueue(enc.encode(`id: 5\ndata: ${JSON.stringify({ id: 5, type: "thread.text", payload: { n: 5 } })}\n\n`));
      if (opens > 1) c.close();
    } });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const { open: openOver, caller } = over(pathFetch);
  const got = [];
  const s = follow({ paths: ["box"], open: openOver, cursor: 3, onEvent: e => got.push(e.id), backoff: backoff({ min: 20, max: 40, jitter: 0 }) });
  t.after(() => s.stop());
  for (let i = 0; i < 100 && !got.length; i++) await sleep(10);
  assert.deepEqual(got, [5]);
  assert.match(seen[0].path, /^\/v1\/events\/stream\?/, "a path, not a URL: the paths layer picks the way");
  assert.equal(seen[0].init.headers["last-event-id"], "3");

  const box = await outbox({ store: memoryStore(), call: caller({ headers: { authorization: "Bearer t" } }), newKey: () => "k-1" });
  t.after(() => box.stop());
  await box.add("threads.send", { thread: "t1", text: "hi kit" });
  for (let i = 0; i < 100 && !seen.some(x => x.path.startsWith("/v1/tools/")); i++) await sleep(10);
  const post = seen.find(x => x.path === "/v1/tools/threads.send");
  assert.ok(post);
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.headers["idempotency-key"], "k-1", "the key rides with the write, for the paths layer to keep on a move");
  assert.equal(post.init.headers.authorization, "Bearer t");
});
