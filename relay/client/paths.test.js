// @ts-check
// Path failover (ADR 0029, R5) with fake timers: a fake direct box (a fetch function) in front of
// the relay path (the real client over the in-memory relay from testing.js).
import test from "node:test";
import assert from "node:assert/strict";
import { createPaths } from "./paths.js";
import { connect } from "./client.js";
import { webCrypto, memoryKeyStore } from "./webcrypto.js";
import { memoryBox, serveWith, reply, settle, ROUTE } from "./testing.js";
import { base64url } from "./bytes.js";

const crypto = webCrypto();

function visible() {
  let hidden = false;
  const fns = new Set();
  return { hidden: () => hidden, on(fn) { fns.add(fn); return () => fns.delete(fn); }, set(h) { hidden = h; for (const f of fns) f(); } };
}

/** A direct box behind a fetch function: "up", "hang" (never answers) or "refuse" (a transport error). */
function directBox() {
  const box = {
    mode: "up",
    /** @type {Array<{ path: string, method: string, key: string|null, last: string|null }>} */ calls: [],
    /** @type {ReadableStreamDefaultController|null} */ sse: null,
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const h = new Headers(init.headers || {});
      box.calls.push({ path: u.pathname, method: init.method || "GET", key: h.get("idempotency-key"), last: h.get("last-event-id") });
      if (box.mode === "refuse") throw new TypeError("fetch failed");
      if (box.mode === "hang") return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      if (u.pathname === "/v1/events/stream") {
        const body = new ReadableStream({ start(c) { box.sse = c; c.enqueue(new TextEncoder().encode(": open\n\nid: 6\ndata: direct\n\n")); } });
        init.signal?.addEventListener("abort", () => { try { box.sse?.error(new DOMException("aborted", "AbortError")); } catch {} });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ via: "direct", path: u.pathname }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return box;
}

function world(t) {
  const seen = [];
  const relay = memoryBox({ serve: serveWith((s, h) => {
    seen.push({ path: h.path, key: h.headers["idempotency-key"] ?? null, last: h.headers["last-event-id"] ?? null });
    if (h.path.startsWith("/v1/events/stream")) {
      s.respond({ status: 200, headers: { "content-type": "text/event-stream" } });
      s.write(Buffer.from(": open\n\nid: 5\ndata: relay\n\n"));
      return;
    }
    reply(s, 200, { via: "relay", path: h.path });
  }) });
  const direct = directBox();
  const vis = visible();
  const moves = [];
  const paths = createPaths({
    paths: [{ kind: "direct", base: "https://juno.example.ts.net" },
      { kind: "relay", relay: "ws://relay.test", route: ROUTE, box: base64url(relay.box.pub), keyStore: memoryKeyStore(), crypto, random: () => 0.5 }],
    fetch: /** @type {any} */ (direct.fetch), WebSocket: relay.WebSocket, visibility: vis, connect,
    onstate: s => moves.push(s.kind),
  });
  t.after(() => paths.close());
  return { relay, direct, vis, paths, seen, moves };
}

test("paths: a direct box that answers is used, and the relay is never dialed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { relay, direct, paths } = world(t);
  const r = await (await paths.fetch("/v1/health")).json();
  assert.equal(r.via, "direct");
  assert.equal(paths.current, "direct");
  assert.deepEqual(direct.calls.map(c => c.path), ["/v1/health", "/v1/health"], "one probe, then the request");
  assert.equal(relay.dials, 0);
});

test("paths: a direct box that does not answer in 1.5 s falls to the relay", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { direct, paths, seen, moves } = world(t);
  direct.mode = "hang";
  const pending = paths.fetch("/v1/tools/notes.add", { method: "POST", body: "{}" });
  await settle();
  t.mock.timers.tick(1499); await settle();
  assert.equal(paths.current, "direct");
  t.mock.timers.tick(1);
  const res = await pending;
  assert.equal((await res.json()).via, "relay");
  assert.equal(paths.current, "relay");
  assert.deepEqual(moves, ["relay"]);
  assert.match(String(seen[0].key), /^[0-9a-f-]{36}$/);
});

test("paths: a transport error moves at once, and the request keeps its Idempotency-Key", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { direct, paths, seen } = world(t);
  await (await paths.fetch("/v1/health")).text();              // direct is known good
  direct.mode = "refuse";
  const res = await paths.fetch("/v1/tools/notes.add", { method: "POST", body: "{\"text\":\"kit\"}" });
  assert.equal((await res.json()).via, "relay");
  const tried = direct.calls.at(-1);
  assert.equal(tried?.path, "/v1/tools/notes.add");
  assert.equal(seen[0].key, tried?.key, "the relay got the same key the direct attempt carried");
});

test("paths: on the relay, the direct path is probed every 60 s only while visible, and an event stream moves back with its cursor", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { relay, direct, vis, paths, seen, moves } = world(t);
  direct.mode = "hang";
  const got = [];
  const ev = paths.events("/v1/events/stream", { onEvent: e => got.push([e.id, e.data]) });
  await settle();
  t.mock.timers.tick(1500);
  await settle(() => got.length === 1);
  assert.equal(paths.current, "relay");
  assert.deepEqual(got, [["5", "relay"]]);

  const probes = () => direct.calls.filter(c => c.path === "/v1/health").length;
  const before = probes();
  t.mock.timers.tick(60_000); await settle();
  assert.equal(probes(), before + 1, "a probe at 60 s");
  t.mock.timers.tick(1500); await settle();                     // it hangs and times out
  assert.equal(paths.current, "relay");

  vis.set(true);
  t.mock.timers.tick(300_000); await settle();
  assert.equal(probes(), before + 1, "no probes while hidden");

  direct.mode = "up";
  vis.set(false);                                              // back to the front: probe now
  await settle(() => paths.current === "direct");
  assert.deepEqual(moves, ["relay", "direct"]);
  await settle(() => got.length === 2);
  assert.deepEqual(got[1], ["6", "direct"]);
  const reopened = direct.calls.filter(c => c.path === "/v1/events/stream").at(-1);
  assert.equal(reopened?.last, "5", "the stream resumed from its cursor on the new path");
  assert.equal(seen.filter(s => s.path === "/v1/events/stream").length, 1);
  await settle(() => relay.sockets.every(s => s.readyState === 3));
  assert.equal(/** @type {any} */ (paths.paths[1]).connection, null, "the relay channel is dropped once direct works");
  ev.close();
});
