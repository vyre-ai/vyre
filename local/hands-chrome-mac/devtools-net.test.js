// @ts-check
// net.*: the buffer, filters, bounded bodies, watch rate limit, Fetch rules (block, mock, headers),
// rule ttl and cleanup, replay from inside the page, and redaction on every return path.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import net, { egressGuard, clearDenied, siteOf } from "./extension/caps/net.js";
import { makeCtx, request } from "./devtools-kit.js";
import { T } from "./test-support/trust.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJlMTIzNDU";
// Built at runtime so no secret-shaped literal sits in shipped source (test/hygiene.test.js).
const FAKE_KEY = "sk" + "-live-abcdefghijklmnop1234";
const SECRETS = ["Bearer " + FAKE_KEY, "sessionid=SESSIONCOOKIE99887766", "REFRESHCOOKIE77665544", "hunter2hunter2", JWT, "csrfvalue123456789abc", "SETCOOKIEVALUE123456"];
const ser = x => JSON.stringify(x);
const op = (k, name, args = {}) => T(net.ops[name])({ tab: 1, ...args }, k.ctx);

function orderRequest(k, id = "r1", extra = {}) {
  request(k, 1, {
    id, method: "POST", url: `https://bakery.example/api/orders?api_key=QUERYKEYVALUE123456&page=2`, type: "XHR",
    headers: { Authorization: "Bearer " + FAKE_KEY, "Content-Type": "application/json", "X-CSRF-Token": "csrfvalue123456789abc" },
    extra: { Cookie: "sessionid=SESSIONCOOKIE99887766; theme=dark" },
    postData: JSON.stringify({ item: "sourdough", password: "hunter2hunter2", note: JWT }),
    resHeaders: { "Content-Type": "application/json", "Set-Cookie": "sessionid=SETCOOKIEVALUE123456; HttpOnly" },
    resExtra: { "Set-Cookie": "refresh=REFRESHCOOKIE77665544; Secure" },
    ...extra,
  });
}

test("net.list and net.get: every return path is redacted", async () => {
  const k = makeCtx({ respond: { "Network.getResponseBody": { body: JSON.stringify({ ok: true, refresh_token: "REFRESHCOOKIE77665544", id: 1001, jwt: JWT }), base64Encoded: false } } });
  await op(k, "net.start");
  orderRequest(k);
  const list = await op(k, "net.list");
  assert.equal(list.requests[0].method, "POST");
  assert.equal(list.requests[0].status, 200);
  assert.equal(list.requests[0].initiator.type, "script");
  assert.equal(list.requests[0].sizes.request > 0, true);
  const got = await op(k, "net.get", { id: "r1", bodies: true });
  for (const out of [list, got, ser(k.emitted)]) {
    const s = ser(out);
    for (const raw of [...SECRETS, "QUERYKEYVALUE123456"]) assert.ok(!s.includes(raw), "leaked " + raw);
  }
  assert.ok(got.requestHeaders.Authorization.startsWith("[redacted"));
  assert.ok(got.requestHeaders.Cookie.startsWith("[redacted"));
  assert.ok(got.responseHeaders["Set-Cookie"].startsWith("[redacted"));
  assert.ok(ser(got.responseBody).includes("1001"), "non-secret values survive");
  assert.equal(list.requests[0].requestBody, undefined, "list has no bodies");
});

test("net.get bounds a body at 100 kB and flags truncation; binary is not returned", async () => {
  const k = makeCtx({ respond: { "Network.getResponseBody": { body: "z ".repeat(200_000), base64Encoded: false } } });
  request(k, 1, {});
  await op(k, "net.start");
  request(k, 1, { id: "big", mime: "text/plain", type: "Fetch" });
  const g = await op(k, "net.get", { id: "big", bodies: true });
  assert.equal(g.responseBodyTruncated, true);
  assert.ok(g.responseBody.length <= 100_000);
  k.respond["Network.getResponseBody"] = { body: "AAAA", base64Encoded: true };
  const b = await op(k, "net.get", { id: "big", bodies: true });
  assert.match(b.responseBody, /binary/);
  await assert.rejects(op(k, "net.get", { id: "gone" }), e => e.code === "not_found");
});

test("a huge JSON body cut before parsing still loses secret-named values", async () => {
  const body = `{"password":"hunter2hunter2","pad":"${"x".repeat(1_100_000)}"}`;
  const k = makeCtx({ respond: { "Network.getResponseBody": { body } } });
  await op(k, "net.start");
  request(k, 1, { id: "j" });
  const g = await op(k, "net.get", { id: "j", bodies: true });
  assert.ok(!ser(g).includes("hunter2hunter2"));
});

test("ring bounds by count and by bytes, oldest first", async () => {
  const k = makeCtx();
  await op(k, "net.start", { maxRequests: 5 });
  for (let i = 0; i < 12; i++) request(k, 1, { id: "q" + i, url: `https://bakery.example/api/n/${i}` });
  const l = await op(k, "net.list");
  assert.equal(l.buffered, 5);
  assert.equal(l.requests[0].id, "q7");
  const k2 = makeCtx();
  await op(k2, "net.start", { maxRequests: 500, maxBytes: 5000 });
  for (let i = 0; i < 30; i++) request(k2, 1, { id: "b" + i, headers: { A: "x".repeat(500) } });
  const l2 = await op(k2, "net.list", { limit: 500 });
  assert.ok(l2.buffered < 12 && l2.buffered >= 1, "byte cap evicted: " + l2.buffered);
  assert.equal(l2.requests.at(-1).id, "b29");
});

test("filters: url, method, status (exact and class), type, since, limit", async () => {
  const k = makeCtx();
  await op(k, "net.start");
  request(k, 1, { id: "a", url: "https://bakery.example/api/orders", method: "GET", status: 200, type: "XHR", wallTime: 1000 });
  request(k, 1, { id: "b", url: "https://bakery.example/api/orders", method: "POST", status: 500, type: "Fetch", wallTime: 2000 });
  request(k, 1, { id: "c", url: "https://bakery.example/logo.png", method: "GET", status: 404, type: "Image", wallTime: 3000 });
  const ids = async f => (await op(k, "net.list", { filter: f })).requests.map(r => r.id);
  assert.deepEqual(await ids({ url: "/API/orders" }), ["a", "b"]);
  assert.deepEqual(await ids({ method: "post" }), ["b"]);
  assert.deepEqual(await ids({ status: 404 }), ["c"]);
  assert.deepEqual(await ids({ status: "5xx" }), ["b"]);
  assert.deepEqual(await ids({ status: [200, "4xx"] }), ["a", "c"]);
  assert.deepEqual(await ids({ type: "fetch" }), ["b"]);
  assert.deepEqual(await ids({ since: 1500000 }), ["b", "c"]);
  assert.equal((await op(k, "net.list", { limit: 1 })).requests[0].id, "c");
});

test("failed requests and redirects are kept and described", async () => {
  const k = makeCtx();
  await op(k, "net.start");
  request(k, 1, { id: "f", failed: "net::ERR_BLOCKED_BY_CLIENT" });
  k.push(1, "Network.requestWillBeSent", { requestId: "rd", type: "Document", request: { url: "https://bakery.example/a", method: "GET", headers: {} }, initiator: {} });
  k.push(1, "Network.requestWillBeSent", { requestId: "rd", type: "Document", request: { url: "https://bakery.example/b", method: "GET", headers: {} }, initiator: {}, redirectResponse: { status: 302 } });
  const l = await op(k, "net.list");
  assert.equal(l.requests.find(r => r.id === "f").failed, "net::ERR_BLOCKED_BY_CLIENT");
  assert.equal(l.buffered, 3);
});

test("net.watch emits redacted net.event, rate limited to 20 per second with a drop count", async () => {
  mock.timers.enable({ apis: ["Date"], now: 10_000 });
  try {
    const k = makeCtx();
    const w = await op(k, "net.watch", { filter: { url: "/api/" } });
    assert.ok(w.watchId);
    request(k, 1, { id: "skip", url: "https://bakery.example/logo.png" });
    for (let i = 0; i < 30; i++) orderRequest(k, "w" + i);
    assert.equal(k.emitted.length, 20);
    assert.equal(k.emitted[0].event, "net.event");
    assert.equal(k.emitted[0].tab, 1);
    assert.ok(!ser(k.emitted).includes("QUERYKEYVALUE123456"));
    mock.timers.tick(1500);
    orderRequest(k, "later");
    assert.equal(k.emitted.length, 21);
    assert.equal(k.emitted[20].dropped, 10);
    assert.equal((await op(k, "net.unwatch", { watchId: w.watchId })).removed, 1);
    orderRequest(k, "after");
    assert.equal(k.emitted.length, 21);
  } finally { mock.timers.reset(); }
});

const paused = (k, id, url, method = "GET", headers = {}) => k.push(1, "Fetch.requestPaused", { requestId: id, request: { url, method, headers }, resourceType: "XHR" });
const tick = () => new Promise(r => setImmediate(r));

test("net.on block fails the request through Fetch, and only matching ones", async () => {
  const k = makeCtx();
  const r = await op(k, "net.on", { filter: { url: "/api/orders" }, then: { action: "block" } });
  assert.ok(r.ruleId);
  assert.equal(k.calls("Fetch.enable")[0].params.patterns[0].urlPattern, "*/api/orders*");
  paused(k, "f1", "https://bakery.example/api/orders/1");
  paused(k, "f2", "https://bakery.example/logo.png");
  await tick();
  assert.equal(k.calls("Fetch.failRequest")[0].params.requestId, "f1");
  assert.equal(k.calls("Fetch.failRequest")[0].params.errorReason, "BlockedByClient");
  assert.equal(k.calls("Fetch.continueRequest")[0].params.requestId, "f2");
});

test("net.on mock fulfils with status, headers and a base64 body", async () => {
  const k = makeCtx();
  await op(k, "net.on", { filter: { url: "/api/orders" }, then: { action: "mock", status: 201, headers: { "x-mock": "1" }, body: { ok: true } } });
  paused(k, "m1", "https://bakery.example/api/orders");
  await tick();
  const f = k.calls("Fetch.fulfillRequest")[0].params;
  assert.equal(f.responseCode, 201);
  assert.equal(Buffer.from(f.body, "base64").toString(), '{"ok":true}');
  assert.ok(f.responseHeaders.some(h => h.name === "x-mock"));
  assert.ok(f.responseHeaders.some(h => h.name === "content-type" && /json/.test(h.value)));
  const rules = await op(k, "net.rules");
  assert.equal(rules.rules[0].detail.status, 201);
  assert.ok(!ser(rules).includes('"ok":true'), "rules list does not echo the body");
});

test("net.on headers edits and removes request headers, then continues", async () => {
  const k = makeCtx();
  await op(k, "net.on", { filter: {}, then: { action: "headers", set: { "X-Debug": "1", accept: "text/plain" }, remove: ["x-drop"] } });
  assert.equal(k.calls("Fetch.enable")[0].params.patterns[0].urlPattern, "*");
  paused(k, "h1", "https://bakery.example/a", "GET", { Accept: "*/*", "X-Drop": "me", Keep: "yes" });
  await tick();
  const h = Object.fromEntries(k.calls("Fetch.continueRequest")[0].params.headers.map(x => [x.name, x.value]));
  assert.deepEqual(h, { Keep: "yes", "X-Debug": "1", accept: "text/plain" });
});

test("net.on emit emits and continues; it needs no Fetch action and is not acting", async () => {
  const k = makeCtx({ stopped: () => true });
  const ops = [];
  k.state.floor = (t, o) => { ops.push(o); return { allow: true }; };
  await op(k, "net.on", { filter: { url: "/api/" }, then: { action: "emit" } });
  paused(k, "e1", "https://bakery.example/api/x?token=ABCDEFGHIJKLMNOP1234");
  await tick();
  assert.equal(k.emitted[0].event, "net.event");
  assert.ok(!ser(k.emitted).includes("ABCDEFGHIJKLMNOP1234"));
  assert.equal(k.calls("Fetch.continueRequest").length, 1);
  assert.deepEqual(ops, ["net.on"]);
});

test("acting rules: refused on stop and on the floor, checked as net.intercept", async () => {
  const k = makeCtx({ stopped: () => true });
  await assert.rejects(op(k, "net.on", { filter: {}, then: { action: "block" } }), e => e.code === "stopped");
  const seen = [];
  const k2 = makeCtx({ floor: (t, o) => { seen.push(o); return { allow: false, why: "hands-only" }; } });
  await assert.rejects(op(k2, "net.on", { filter: {}, then: { action: "mock" } }), e => e.code === "blocked");
  assert.deepEqual(seen, ["net.intercept"]);
  assert.equal(k2.calls("Fetch.enable").length, 0);
  await assert.rejects(op(k, "net.on", { filter: {}, then: { action: "explode" } }), e => e.code === "bad_request");
});

test("a rule that throws never leaves the request hanging, except a BLOCK rule whose stop failed: that request is never let through (failRequest, retry, empty 403)", async () => {
  // a mock rule that throws: the request is continued rather than left to hang
  const k1 = makeCtx({ respond: { "Fetch.fulfillRequest": () => { throw new Error("gone"); } } });
  await op(k1, "net.on", { filter: {}, then: { action: "mock", body: "x" } });
  paused(k1, "x1", "https://bakery.example/a");
  await tick(); await tick();
  assert.equal(k1.calls("Fetch.continueRequest")[0].params.requestId, "x1");
  // a block rule whose failRequest throws: fulfilled with a 403 instead, and NEVER continued
  const k2 = makeCtx({ respond: { "Fetch.failRequest": () => { throw new Error("gone"); } } });
  await op(k2, "net.on", { filter: {}, then: { action: "block" } });
  paused(k2, "x2", "https://bakery.example/a");
  await tick(); await tick(); await tick();
  assert.equal(k2.calls("Fetch.continueRequest").length, 0, "a blocked request is never continued");
  assert.equal(k2.calls("Fetch.fulfillRequest")[0].params.responseCode, 403);
  // everything failing: it stays paused, still not continued
  const k3 = makeCtx({ respond: { "Fetch.failRequest": () => { throw new Error("gone"); }, "Fetch.fulfillRequest": () => { throw new Error("gone"); } } });
  await op(k3, "net.on", { filter: {}, then: { action: "block" } });
  paused(k3, "x3", "https://bakery.example/a");
  await tick(); await tick(); await tick();
  assert.equal(k3.calls("Fetch.continueRequest").length, 0);
});


test("rules: ttl removes them and turns Fetch off; net.off removes one; detach and tab close clean up", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1 });
  try {
    const k = makeCtx();
    const a = await op(k, "net.on", { filter: { url: "/a" }, then: { action: "block" }, ttlMs: 10_000 });
    const b = await op(k, "net.on", { filter: { url: "/b" }, then: { action: "block" } });
    assert.equal(a.ttlMs, 10_000);
    assert.equal(b.ttlMs, 300_000);
    assert.equal((await op(k, "net.rules")).rules.length, 2);
    mock.timers.tick(11_000);
    await tick();
    assert.deepEqual((await op(k, "net.rules")).rules.map(r => r.ruleId), [b.ruleId]);
    assert.equal(k.calls("Fetch.enable").at(-1).params.patterns[0].urlPattern, "*/b*");
    await op(k, "net.off", { ruleId: b.ruleId });
    assert.equal(k.calls("Fetch.disable").length, 1);
    await assert.rejects(op(k, "net.off", { ruleId: b.ruleId }), e => e.code === "not_found");

    await op(k, "net.on", { filter: {}, then: { action: "block" } });
    k.push(1, "Inspector.detached", {});
    assert.equal((await op(k, "net.rules")).rules.length, 0, "detach dropped the rules");
    await op(k, "net.on", { filter: {}, then: { action: "block" } });
    net.onEvent({ event: "tabs.removed", tab: 1 }, k.ctx);
    assert.equal((await op(k, "net.rules")).rules.length, 0, "tab close dropped the rules");
    mock.timers.tick(400_000);
    await tick();
  } finally { mock.timers.reset(); }
});

test("net.replay runs inside the page through Runtime.evaluate, with credentials included", async () => {
  const k = makeCtx({ respond: { "Runtime.evaluate": { result: { value: { status: 200, mime: "application/json", headers: { "content-type": "application/json", "set-cookie": "sessionid=SETCOOKIEVALUE123456" }, body: JSON.stringify({ ok: true, access_token: "REFRESHCOOKIE77665544" }) } } } } });
  await op(k, "net.start");
  orderRequest(k);
  const out = await op(k, "net.replay", { id: "r1", writeOk: true, overrides: { body: { item: "rye", password: "hunter2hunter2" } } });
  const ev = k.calls("Runtime.evaluate");
  assert.equal(ev.length, 1, "replay is one Runtime.evaluate");
  assert.match(ev[0].params.expression, /fetch\(P\.url, P\.init\)/);
  assert.equal(ev[0].params.awaitPromise, true);
  const payload = JSON.parse(ev[0].params.expression.match(/\}\)\((\{.*\})\)$/s)[1]);
  assert.equal(payload.init.credentials, "include");
  assert.equal(payload.init.method, "POST");
  assert.ok(!Object.keys(payload.init.headers).some(h => h.toLowerCase() === "cookie"), "cookie is the page's own");
  assert.equal(payload.init.headers.Authorization, "Bearer " + FAKE_KEY, "credential goes to the page's own fetch, inside the browser");
  assert.equal(JSON.parse(payload.init.body).item, "rye");
  assert.equal(payload.origin, "https://bakery.example");
  assert.equal(k.calls("Fetch.enable").length, 0);
  const s = ser(out);
  for (const raw of [...SECRETS, "QUERYKEYVALUE123456"]) assert.ok(!s.includes(raw), "leaked " + raw);
  assert.equal(out.status, 200);
  assert.equal(out.replayOf, "r1");
});

test("net.replay: acting for non-GET, refuses foreign origins, and refuses a moved tab", async () => {
  const k = makeCtx({ stopped: () => true, respond: { "Runtime.evaluate": { result: { value: { status: 200, headers: {}, body: "" } } } } });
  await op(k, "net.start");
  orderRequest(k, "p");
  request(k, 1, { id: "g", method: "GET" });
  await assert.rejects(op(k, "net.replay", { id: "p" }), e => e.code === "stopped");
  assert.equal((await op(k, "net.replay", { id: "g" })).status, 200, "GET replay is a read and runs during stop");
  const k2 = makeCtx({ respond: { "Runtime.evaluate": { result: { value: { status: 200, headers: {}, body: "" } } } } });
  await op(k2, "net.start");
  request(k2, 1, { id: "g" });
  await assert.rejects(op(k2, "net.replay", { id: "g", overrides: { url: "https://evil.example/steal" } }), e => e.code === "bad_request");
  const k3 = makeCtx({ respond: { "Runtime.evaluate": { result: { value: { originMismatch: "https://other.example" } } } } });
  await op(k3, "net.start");
  request(k3, 1, { id: "g" });
  await assert.rejects(op(k3, "net.replay", { id: "g" }), e => e.code === "bad_request" && /not the origin/.test(e.message));
  const seen = [];
  const k4 = makeCtx({ floor: (t, o) => { seen.push(o); return { allow: false }; } });
  await assert.rejects(op(k4, "net.replay", { id: "x" }), e => e.code === "blocked");
  assert.deepEqual(seen, ["net.get"]);
});

test("floor refusal blocks every net op", async () => {
  const k = makeCtx({ floor: () => ({ allow: false, why: "blind" }) });
  for (const [name, args] of [["net.start", {}], ["net.list", {}], ["net.get", { id: "1" }], ["net.watch", {}], ["net.unwatch", {}], ["net.on", { then: { action: "emit" } }], ["net.rules", {}], ["net.off", { ruleId: "r1" }], ["net.replay", { id: "1" }]])
    await assert.rejects(op(k, name, args), e => e.code === "blocked", name);
  assert.equal(k.sent.length, 0);
});

test("omitted tab uses the active tab", async () => {
  const k = makeCtx({ active: 9 });
  await T(net.ops["net.start"])({}, k.ctx);
  assert.ok(k.attachedSet.has(9));
});

test("the buffer never outlives the floor: a navigation to a blind page empties it, and a blind record is never listed", async () => {
  const { makeCtx } = await import("./devtools-kit.js");
  const net = (await import("./extension/caps/net.js")).default;
  const k = makeCtx({ active: 3 });
  await T(net.ops["net.start"])({ tab: 3 }, k.ctx);
  const push = (/** @type {string} */ method, /** @type {any} */ p) => k.push(3, method, p);
  push("Network.requestWillBeSent", { requestId: "1", type: "XHR", request: { url: "https://harlow.example/api/x", method: "GET", headers: {} } });
  push("Network.requestWillBeSent", { requestId: "2", type: "XHR", request: { url: "https://chase.com/api/balance", method: "GET", headers: {} } });
  let list = await T(net.ops["net.list"])({ tab: 3 }, k.ctx);
  assert.deepEqual(list.requests.map((/** @type {any} */ r) => r.url), ["https://harlow.example/api/x"], "a blind origin's record is never listed");
  push("Network.requestWillBeSent", { requestId: "3", type: "Document", request: { url: "https://accounts.google.com/signin", method: "GET", headers: {} } });
  list = await T(net.ops["net.list"])({ tab: 3 }, k.ctx);
  assert.equal(list.requests.length, 0, "going to a blind page empties the buffer");
});

test("egress guard: a child frame that attached a moment ago (capture had not seen it yet) is guarded before the script runs, with the guard on before its capture", async () => {
  const k = makeCtx({ active: 1 });
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  // a session appears in the tab's child list without the capture having been told (the race: attached between start and the guard)
  k.children.push({ sessionId: "S-NEW", targetId: "F9", type: "iframe", url: "https://b.example/x" });
  const eg = await egressGuard(k.ctx, 1);
  const fetchOn = k.sent.filter(s => s.method === "Fetch.enable" && s.session === "S-NEW");
  assert.equal(fetchOn.length >= 1, true, "Fetch is on for the new session");
  await eg.stop();
});

test("egress guard fails CLOSED: a request judged blocked is never continued, whatever failRequest does; it is failed, retried, fulfilled as an empty 403, and marked leaked only if everything failed (looped)", async () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let n = 0; n < 150; n++) {
    const k = makeCtx({ active: 1 });
    await net.ops["net.start"]({ tab: 1 }, k.ctx);
    const eg = await egressGuard(k.ctx, 1);
    const failFail = rnd() < 0.5, failFulfill = rnd() < 0.4;
    let failCalls = 0;
    k.respond["Fetch.failRequest"] = () => { failCalls++; if (failFail) throw new Error("Timed out (unacknowledged)"); return {}; };
    k.respond["Fetch.fulfillRequest"] = () => { if (failFulfill) throw new Error("session gone"); return {}; };
    k.push(1, "Fetch.requestPaused", { requestId: `evil${n}`, request: { url: "https://collector.example/steal?d=secret", method: "GET" }, resourceType: "Fetch" });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const continued = k.sent.filter(s => s.method === "Fetch.continueRequest" && s.params.requestId === `evil${n}`);
    assert.equal(continued.length, 0, `never continued (run ${n}, failFail ${failFail}, failFulfill ${failFulfill})`);
    const out = await eg.stop();
    assert.equal(out.length, 1);
    assert.equal(!!out[0].leaked, failFail && failFulfill, "marked leaked only when the request could not be stopped by any means");
    if (failFail) assert.equal(failCalls, 2, "failRequest was tried twice before the fulfilled 403");
  }
});

test("egress guard refuses to run a script when a child frame will not take the interception", async () => {
  const k = makeCtx({ active: 1 });
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  k.children.push({ sessionId: "S-STUCK", targetId: "F1", type: "iframe", url: "https://b.example/x" });
  k.respond["Fetch.enable"] = (/** @type {any} */ _p, /** @type {number} */ _t, /** @type {string|undefined} */ session) => { if (session === "S-STUCK") throw new Error("Timed out waiting for a response"); return {}; };
  await assert.rejects(egressGuard(k.ctx, 1), { code: "blocked" });
});

test("egress guard: children start PAUSED while it is up; Fetch goes on BEFORE a child is resumed; a child that could not be guarded stays paused, the script is terminated, and it is released only after the guard is down", async () => {
  const k = makeCtx({ active: 1 });
  const pauses = /** @type {boolean[]} */ ([]);
  /** @type {any} */ (k.ctx.cdp).setPause = async (/** @type {number} */ _t, /** @type {boolean} */ on) => { pauses.push(on); return true; };
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  const eg = await egressGuard(k.ctx, 1);
  assert.deepEqual(pauses, [true], "pausing on before the script");
  // a dedicated worker the page starts while the guard is up: it attaches waiting
  k.push(1, "Target.attachedToTarget", { sessionId: "S-W1", waitingForDebugger: true, targetInfo: { targetId: "W1", type: "worker", url: "blob:https://a.example/x" } });
  await new Promise(r => setTimeout(r, 5));
  const order = k.sent.filter(s => s.session === "S-W1").map(s => s.method);
  assert.ok(order.indexOf("Fetch.enable") >= 0 && order.indexOf("Runtime.runIfWaitingForDebugger") > order.indexOf("Fetch.enable"), `Fetch before resume: ${order.join(",")}`);
  // a child whose Fetch.enable fails: NOT resumed while the script runs, the script is terminated
  k.respond["Fetch.enable"] = (/** @type {any} */ _p, /** @type {number} */ _t, /** @type {string|undefined} */ session) => { if (session === "S-F2") throw new Error("Timed out"); return {}; };
  k.push(1, "Target.attachedToTarget", { sessionId: "S-F2", waitingForDebugger: true, targetInfo: { targetId: "F2", type: "iframe", url: "https://b.example/x" } });
  await new Promise(r => setTimeout(r, 5));
  const f2 = k.sent.filter(s => s.session === "S-F2").map(s => s.method === "Runtime.evaluate" ? "eval:" + s.params.expression : s.method);
  assert.ok(f2.indexOf("eval:location.replace('about:blank')") >= 0 && f2.indexOf("Runtime.runIfWaitingForDebugger") > f2.indexOf("eval:location.replace('about:blank')"), "an unguarded child is emptied while it waits, and only then resumed: " + f2.join());
  assert.ok(k.sent.some(s => s.method === "Runtime.terminateExecution"), "the script is stopped");
  const out = await eg.stop();
  assert.ok(out.some((/** @type {any} */ o) => o.method === "GUARD" && o.stopped && /could not be guarded/.test(o.origin)), "the result says it was stopped");
  assert.equal(pauses[pauses.length - 1], false, "pausing is off again when the guard goes, which is what releases the waiting child");
});

test("egress guard: an unguardable child that cannot be emptied stays paused and is never handed to the fallback resume; the no-Fetch tolerance is for worker types only", async () => {
  const k = makeCtx({ active: 1 });
  const resumed = /** @type {string[]} */ ([]);
  /** @type {any} */ (k.ctx.cdp).resumed = (/** @type {string} */ sid) => { resumed.push(sid); };
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  const eg = await egressGuard(k.ctx, 1);
  k.respond["Fetch.enable"] = (/** @type {any} */ _p, /** @type {number} */ _t, /** @type {string|undefined} */ session) => { if (session === "S-X" || session === "S-W") throw new Error("'Fetch.enable' wasn't found"); return {}; };
  k.respond["Runtime.evaluate"] = (/** @type {any} */ p, /** @type {number} */ _t, /** @type {string|undefined} */ session) => { if (session === "S-X" && /location\.replace/.test(String(p.expression))) throw new Error("no"); return { result: { value: [] } }; };
  // a FRAME answering "no Fetch domain" is not a worker: it fails the guard, and with the evaluate refused it stays paused
  k.push(1, "Target.attachedToTarget", { sessionId: "S-X", waitingForDebugger: true, targetInfo: { targetId: "X", type: "iframe", url: "https://b.example/x" } });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(k.sent.some(s => s.session === "S-X" && s.method === "Runtime.runIfWaitingForDebugger"), false, "left paused");
  assert.ok(resumed.includes("S-X"), "and dropped from the fallback's list");
  k.push(1, "Target.attachedToTarget", { sessionId: "S-W", waitingForDebugger: true, targetInfo: { targetId: "W", type: "shared_worker", url: "blob:https://a.example/w" } });
  await new Promise(r => setTimeout(r, 10));
  assert.ok(k.sent.some(s => s.session === "S-W" && s.method === "Runtime.runIfWaitingForDebugger"), "a shared worker without the Fetch domain is resumed");
  const out = await eg.stop();
  assert.ok(out.some((/** @type {any} */ o) => o.method === "GUARD"), "the frame that could not be guarded is reported");
});

test("egress guard: the diagnostics name where each allowed origin came from, what the guard judged, and which sessions took Fetch; only completed unguarded requests count as 'the page talks to it'", async () => {
  const k = makeCtx({ active: 1 });
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  k.push(1, "Network.requestWillBeSent", { requestId: "a1", type: "XHR", documentURL: "https://app.example/", request: { url: "https://api.example/x", method: "GET", headers: {} } });
  k.push(1, "Network.responseReceived", { requestId: "a1", type: "XHR", response: { url: "https://api.example/x", status: 200, headers: {}, mimeType: "application/json" } });
  k.push(1, "Network.requestWillBeSent", { requestId: "a2", type: "XHR", documentURL: "https://app.example/", request: { url: "https://unanswered.example/x", method: "GET", headers: {} } });
  const eg = await egressGuard(k.ctx, 1);
  const d = /** @type {any} */ (eg).diag();
  assert.ok(d.allowed["https://api.example"] === "response", JSON.stringify(d.allowed));
  assert.equal(d.allowed["https://unanswered.example"], undefined, "a request that never got an answer is not evidence");
  await eg.stop();
});


test("egress guard: what the guard blocked never becomes allowed by being observed: the next guard still blocks it", async () => {
  const k = makeCtx({ active: 1 });
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  const eg1 = await egressGuard(k.ctx, 1);
  // the guarded script's request to a fresh origin is captured (Network sees the attempt) AND judged blocked
  k.push(1, "Network.requestWillBeSent", { requestId: "n1", type: "Fetch", documentURL: "https://app.example/", request: { url: "https://collector.example/steal?d=1", method: "GET", headers: {} } });
  k.push(1, "Fetch.requestPaused", { requestId: "p1", request: { url: "https://collector.example/steal?d=1", method: "GET" }, resourceType: "Fetch" });
  await new Promise(r => setTimeout(r, 5));
  const out1 = await eg1.stop();
  assert.equal(out1.length, 1, "the first attempt was blocked");
  // the second guard: the buffer holds that attempt, but it is not evidence that the page talks to that origin
  const eg2 = await egressGuard(k.ctx, 1);
  assert.ok(!eg2.allowed.includes("https://collector.example"), "the blocked origin did not become allowed");
  k.push(1, "Fetch.requestPaused", { requestId: "p2", request: { url: "https://collector.example/steal?d=2", method: "GET" }, resourceType: "Fetch" });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(k.calls("Fetch.failRequest").filter(s => s.params.requestId === "p2").length, 1, "and is blocked again");
  const out2 = await eg2.stop();
  assert.equal(out2.length, 1);
  assert.equal(out2[0].type, "Fetch", "the blocked entry says what kind of request it was");
});


/** A world with a page on app.example that has talked to api.example (and, optionally, more), then a guard. */
async function guardedWorld(extra = async (/** @type {any} */ _k) => {}) {
  const k = makeCtx({ active: 1 });
  k.ctx.tabs = { ...k.ctx.tabs, get: async () => ({ id: 1, url: "https://app.example/w" }) };
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  const seen = (/** @type {string} */ id, /** @type {string} */ url) => { k.push(1, "Network.requestWillBeSent", { requestId: id, type: "XHR", documentURL: "https://app.example/w", request: { url, method: "GET", headers: {} } }); k.push(1, "Network.responseReceived", { requestId: id, type: "XHR", response: { url, status: 200, headers: {}, mimeType: "application/json" } }); };
  seen("s1", "https://api.example/x");
  await extra(k);
  return { k, seen };
}
const paused1 = (/** @type {any} */ k, /** @type {string} */ id, /** @type {string} */ url, /** @type {any} */ extra = {}) => { k.push(1, "Fetch.requestPaused", { requestId: id, request: { url, method: "POST", ...extra }, resourceType: "Fetch" }); };
const tick1 = () => new Promise(r => setTimeout(r, 5));

test("egress: two evals in a row to a never-seen origin are BOTH held (the first attempt never vouches for the origin)", async () => {
  const { k } = await guardedWorld();
  for (const n of [1, 2]) {
    const eg = await egressGuard(k.ctx, 1);
    // the attempt is captured (requestWillBeSent) and reaches the guard
    k.push(1, "Network.requestWillBeSent", { requestId: `e${n}`, type: "Fetch", documentURL: "https://app.example/w", request: { url: `https://collector.example/steal?n=${n}`, method: "GET", headers: {} } });
    paused1(k, `p${n}`, `https://collector.example/steal?n=${n}`);
    await tick1();
    assert.equal(k.calls("Fetch.failRequest").filter(s => s.params.requestId === `p${n}`).length, 1, `held on run ${n}`);
    assert.equal((await eg.stop()).length, 1);
  }
});

test("egress: a script-made <iframe src=fresh> stays in the DOM after it is blocked, and a second eval still holds that origin", async () => {
  const { k } = await guardedWorld();
  const eg1 = await egressGuard(k.ctx, 1);
  // the script's iframe: a frame stub with that origin shows up in the frame list afterwards, but it never loaded a document
  k.push(1, "Network.requestWillBeSent", { requestId: "f1", type: "Document", documentURL: "https://app.example/w", request: { url: "https://fresh.example/page", method: "GET", headers: {} } });
  await eg1.stop();
  /** @type {any} */ (k.ctx).frames = { list: async () => [{ index: 0, frameId: "TOP", how: "top", readable: true, origin: "https://app.example", url: "https://app.example/w" }, { index: 1, frameId: "element:TOP:1", how: "none", readable: false, origin: "https://fresh.example", url: "https://fresh.example/page" }] };
  const eg2 = await egressGuard(k.ctx, 1);
  assert.ok(!eg2.allowed.includes("https://fresh.example"), "the DOM's stub and the attempt vouch for nothing");
  paused1(k, "pf", "https://fresh.example/steal");
  await tick1();
  assert.equal(k.calls("Fetch.failRequest").filter(s => s.params.requestId === "pf").length, 1);
  await eg2.stop();
});

test("egress: a GHL-style builder iframe calling its own API is allowed; a 1 KB request to a third-party analytics origin the page uses is held; a small one is not", async () => {
  const { k, seen } = await guardedWorld(async k => {
    k.ctx.frames = { list: async () => [{ index: 0, frameId: "TOP", how: "top", readable: true, origin: "https://app.example", url: "https://app.example/w" }, { index: 1, frameId: "B", how: "session", readable: true, origin: "https://builder.leadconnectorhq.com", url: "https://builder.leadconnectorhq.com/x" }] };
  });
  seen("s2", "https://backend.leadconnectorhq.com/workflow/1");
  seen("s3", "https://analytics.thirdparty.example/collect");
  // The script runs IN the builder frame: its site is first party. A third-party iframe the page merely loaded is not (see the next test).
  const eg = await egressGuard(k.ctx, 1, { index: 1, frameId: "B", how: "session", readable: true, origin: "https://builder.leadconnectorhq.com", url: "https://builder.leadconnectorhq.com/x" });
  assert.ok(eg.allowed.includes("https://builder.leadconnectorhq.com"), "a frame that loaded a document");
  const big = "x".repeat(1024);
  paused1(k, "api1", "https://backend.leadconnectorhq.com/workflow/1", { postData: big });
  paused1(k, "an1", "https://analytics.thirdparty.example/collect", { postData: big });
  paused1(k, "an2", "https://analytics.thirdparty.example/collect", { postData: "ping" });
  await tick1();
  const failed = k.calls("Fetch.failRequest").map(s => s.params.requestId);
  assert.ok(!failed.includes("api1"), "the builder's own API gets any size: same site as the frame");
  assert.ok(failed.includes("an1"), "1 KB to a third party is held");
  assert.ok(!failed.includes("an2"), "a beacon-sized request to it is not");
  await eg.stop();
  assert.equal(siteOf("https://backend.leadconnectorhq.com"), siteOf("https://builder.leadconnectorhq.com"));
  assert.equal(siteOf("https://a.example.co.uk"), siteOf("https://b.example.co.uk"));
  assert.notEqual(siteOf("https://a.example.co.uk"), siteOf("https://a.other.co.uk"));
});

test("egress: an asked approval clears the denied origins for the tab", async () => {
  const { k } = await guardedWorld();
  const eg = await egressGuard(k.ctx, 1);
  k.push(1, "Network.requestWillBeSent", { requestId: "x1", type: "Fetch", documentURL: "https://app.example/w", request: { url: "https://approved.example/a", method: "GET", headers: {} } });
  await eg.stop();
  const t = /** @type {any} */ (k.ctx).__t;
  void t;
  await clearDenied(k.ctx, 1);
  // the page later really talks to it (a completed response outside a guard): now it is allowed
  k.push(1, "Network.requestWillBeSent", { requestId: "x2", type: "XHR", documentURL: "https://app.example/w", request: { url: "https://approved.example/b", method: "GET", headers: {} } });
  k.push(1, "Network.responseReceived", { requestId: "x2", type: "XHR", response: { url: "https://approved.example/b", status: 200, headers: {}, mimeType: "x" } });
  const eg2 = await egressGuard(k.ctx, 1);
  assert.ok(eg2.allowed.includes("https://approved.example"));
  await eg2.stop();
});

test("egress: third parties share one budget per guard (1 KB, 8 requests), a loaded third-party iframe is not first party, and a size-capped origin is not denied for the tab", async () => {
  const { k, seen } = await guardedWorld(async k => {
    k.ctx.frames = { list: async () => [{ index: 0, frameId: "TOP", how: "top", readable: true, origin: "https://app.example", url: "https://app.example/w" }, { index: 1, frameId: "C", how: "session", readable: true, origin: "https://chat.widget.example", url: "https://chat.widget.example/" }] };
  });
  seen("s2", "https://chat.widget.example/api");
  const eg = await egressGuard(k.ctx, 1);
  for (let i = 0; i < 9; i++) paused1(k, "c" + i, "https://chat.widget.example/api?i=" + i, { postData: "p" });
  paused1(k, "big", "https://chat.widget.example/api", { postData: "x".repeat(400) });
  await tick1();
  const failed = k.calls("Fetch.failRequest").map(s => s.params.requestId);
  assert.ok(!failed.includes("c0") && !failed.includes("c7"), "the first eight small requests pass");
  assert.ok(failed.includes("c8"), "the ninth is over the per-guard count");
  assert.ok(failed.includes("big"), "an oversize one is held");
  await eg.stop();
  const eg2 = await egressGuard(k.ctx, 1);
  assert.ok(eg2.allowed.includes("https://chat.widget.example"), "a size-capped origin stays allowed for the tab afterwards");
  await eg2.stop();
});

test("egress probe: every readable frame on an allowed origin is probed (its own nonce path), and the test-only noFetch guard is DNR alone: no Fetch, no probe", async () => {
  const { k } = await guardedWorld(async k => {
    k.ctx.frames = { list: async () => [{ index: 0, frameId: "TOP", how: "top", readable: true, origin: "https://app.example", url: "https://app.example/w" }, { index: 1, frameId: "B", how: "session", readable: true, origin: "https://app.example", url: "https://app.example/inner" }] };
  });
  const eg = await egressGuard(k.ctx, 1);
  const probes = k.calls("Runtime.evaluate").map(c => /__vyre_probe_[a-z0-9]+_(\d+)/.exec(String(c.params.expression || ""))).filter(Boolean).map(m => /** @type {RegExpExecArray} */ (m)[1]);
  assert.ok(probes.includes("0") && probes.includes("1"), "both frames were probed: " + probes.join());
  await eg.stop();
  const k2 = (await guardedWorld(async () => {})).k;
  const before = k2.calls("Fetch.enable").length;
  const eg2 = await egressGuard(k2.ctx, 1, null, { noFetch: true });
  assert.equal(k2.calls("Fetch.enable").length, before, "no Fetch on a noFetch guard");
  assert.equal(k2.calls("Runtime.evaluate").filter(c => /__vyre_probe_/.test(String(c.params.expression || ""))).length, 0, "and no probe");
  assert.ok(/** @type {any} */ (k2.ctx).dnr.rules.length >= 1, "the DNR rule is still set");
  await eg2.stop();
});

test("egress guard: a worker target has no Fetch domain in Chrome; that one error is tolerated (the DNR rules cover it) and the worker is resumed, any other enable failure is not", async () => {
  const k = makeCtx({ active: 1 });
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  const eg = await egressGuard(k.ctx, 1);
  k.respond["Fetch.enable"] = (/** @type {any} */ _p, /** @type {number} */ _t, /** @type {string|undefined} */ session) => { if (session === "S-W9") throw new Error("'Fetch.enable' wasn't found"); return {}; };
  k.push(1, "Target.attachedToTarget", { sessionId: "S-W9", waitingForDebugger: true, targetInfo: { targetId: "W9", type: "worker", url: "blob:https://a.example/w" } });
  await new Promise(r => setTimeout(r, 5));
  assert.ok(k.sent.some(s => s.session === "S-W9" && s.method === "Network.enable"), "capture still goes on");
  assert.ok(k.sent.some(s => s.session === "S-W9" && s.method === "Runtime.runIfWaitingForDebugger"), "the worker is resumed");
  assert.equal(k.sent.some(s => s.method === "Runtime.terminateExecution"), false, "the script is not stopped for it");
  const out = await eg.stop();
  assert.equal(out.some((/** @type {any} */ o) => o.method === "GUARD"), false);
});
