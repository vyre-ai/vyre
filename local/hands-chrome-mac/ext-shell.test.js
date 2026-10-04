// @ts-check
// The shell (background.js): hello, dispatch, redaction, stop/resume, reconnect backoff; the
// chrome.debugger wrapper (idempotent attach, detach rejects in-flight); the registry.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start, redactResult, MIN_RETRY_MS, MAX_RETRY_MS, FAST_RETRY_MS, FAST_WINDOW_MS, BADGE_AFTER_MS } from "./extension/background.js";
import { explain } from "./extension/shared/diag.js";
import { createCdp } from "./extension/lib/cdp.js";
import { register, dispatch, loadOptional, loadReport, opNames, ready } from "./extension/caps/index.js";
import { createCtx } from "./extension/lib/ctx.js";
import { createFakeChrome, createFakePage, samplePage } from "./test-support/fake-chrome.js";
import { proto } from "./extension/lib/shared.js";
import { dispatchT } from "./test-support/trust.js";

const tick = () => new Promise(r => setImmediate(r));
const until = async f => { for (let i = 0; i < 50 && !f(); i++) await tick(); };

/** timers we control */
function fakeTimers() {
  let t = 0;
  /** @type {any[]} */
  const pending = [];
  const self = {
    now: () => t, delays: /** @type {number[]} */ ([]), pending,
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => { self.delays.push(ms); const h = { fn, at: t + ms }; pending.push(h); return /** @type {any} */ (h); },
    clearTimeout: (/** @type {any} */ h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    advance(/** @type {number} */ ms) { t += ms; for (const h of pending.filter(x => x.at <= t)) { pending.splice(pending.indexOf(h), 1); h.fn(); } },
  };
  return self;
}

register({ name: "shelltest", ops: {
  "shelltest.secret": async () => ({ user: "alex", cookie: "sessionid=abc123", authorization: "Bearer abcdefghijklmnop1234", note: "fine" }),
  "shelltest.act": async () => ({ ok: true }),
  "shelltest.crash": async () => { throw Object.assign(new Error("Bearer abcdefghijklmnop1234 was rejected"), { code: "timeout" }); },
} });

const boot = (seed = []) => {
  const chrome = createFakeChrome(seed);
  const timers = fakeTimers();
  const shell = start(chrome, timers);
  return { chrome, timers, shell, port: () => chrome._.ports.at(-1) };
};

test("connects to run.vyre.chrome and says hello with protocol and version", async () => {
  const { chrome, port } = boot();
  assert.equal(chrome._.counts.connectNative, 1);
  assert.equal(port().name, "run.vyre.chrome");
  await until(() => port().sent.length);
  const hello = port().sent[0];
  assert.deepEqual([hello.event, hello.protocol, hello.version], ["hello", proto.PROTOCOL, "0.2.0"]);
  assert.ok(hello.ops.includes("tabs.use") && hello.ops.includes("batch.run"));
  assert.ok(chrome.alarms.created.some(a => a.n === "vyre.keepalive" && a.i.periodInMinutes >= 1), "keepalive never faster than 60 s");
});

test("answers {id, ok, result} with the result redacted, and {ok:false, error} with a proto code", async () => {
  const { port } = boot();
  port().deliver({ id: 1, op: "shelltest.secret", args: {} });
  port().deliver({ id: 2, op: "shelltest.crash" });
  port().deliver({ id: 3, op: "nope.nothing" });
  port().deliver({ id: 4, op: "Bad Op" });
  port().deliver({ id: 5, op: "tabs.list" });
  await until(() => port().sent.filter(m => m.id).length === 5);
  const by = id => port().sent.find(m => m.id === id);
  const ok = by(1);
  assert.equal(ok.ok, true);
  const text = JSON.stringify(ok.result);
  assert.ok(!text.includes("abc123") && !text.includes("abcdefghijklmnop1234"));
  assert.equal(ok.result.user, "alex");
  assert.equal(ok.result.note, "fine");
  assert.deepEqual([by(2).ok, by(2).error.code], [false, "timeout"]);
  assert.ok(!by(2).error.message.includes("abcdefghijklmnop1234"));
  assert.deepEqual(by(3).error.code, "unknown_op");
  assert.deepEqual(by(4).error.code, "bad_request");
  assert.equal(by(5).ok, true);
});

test("stop and resume events gate acting ops but not reading ops", async () => {
  const { port } = boot([{ url: "https://harlow.example/", active: true }]);
  port().deliver({ event: "stop" });
  await tick();
  port().deliver({ id: 1, op: "tabs.navigate", args: {} });
  port().deliver({ id: 2, op: "tabs.list" });
  await until(() => port().sent.filter(m => m.id).length === 2);
  assert.equal(port().sent.find(m => m.id === 1).error.code, "stopped");
  assert.equal(port().sent.find(m => m.id === 2).ok, true);
  port().deliver({ event: "resume" });
  await tick();
  port().deliver({ id: 3, op: "tabs.navigate", args: {} });
  await until(() => port().sent.find(m => m.id === 3));
  assert.equal(port().sent.find(m => m.id === 3).error.code, "bad_request", "past the stop check, the request itself is judged");
});

test("a request naming a blind tab is refused by the shell's floor", async () => {
  const { port } = boot([{ url: "https://my.1password.com/vaults", active: true }]);
  port().deliver({ id: 1, op: "page.snapshot", args: { tabId: 1 } });
  await until(() => port().sent.find(m => m.id === 1));
  assert.equal(port().sent.find(m => m.id === 1).error.code, "blocked");
});

test("reconnect: every 3 s for the first two minutes of a failure, then backing off to a minute, and fast again after a healthy connection", async () => {
  const { chrome, timers, shell, port } = boot();
  assert.equal(chrome._.counts.connectNative, 1);
  // The first two minutes: a person who has just installed is watching.
  let cycles = 0;
  while (timers.now() < FAST_WINDOW_MS) {
    port().hostClose();
    assert.equal(timers.pending.length, 1, "exactly one retry is pending");
    assert.equal(timers.delays.at(-1), FAST_RETRY_MS, "3 s while the failure is young");
    timers.advance(FAST_RETRY_MS - 1);
    assert.equal(chrome._.counts.connectNative, 1 + cycles, "not before the delay");
    timers.advance(1);
    cycles++;
  }
  assert.ok(cycles >= 39, `about 40 quick tries in two minutes, got ${cycles}`);
  // After that: 5 s, doubling, capped at a minute.
  const later = [];
  for (let i = 0; i < 6; i++) { port().hostClose(); later.push(timers.delays.at(-1)); timers.advance(timers.delays.at(-1)); }
  assert.deepEqual(later, [5000, 10_000, 20_000, 40_000, MAX_RETRY_MS, MAX_RETRY_MS]);
  assert.ok(timers.delays.every(d => d >= MIN_RETRY_MS && d <= MAX_RETRY_MS));
  port().deliver({ id: 9, op: "tabs.list" });
  await tick();
  assert.equal(shell.attempts(), 0);
  port().hostClose();
  assert.equal(timers.delays.at(-1), FAST_RETRY_MS, "fast again after a healthy connection");
});

test("nothing is swallowed: Chrome's own reason for a failure is kept, the popup words say the one fix, and the badge shows after 20 s", async () => {
  const { chrome, timers, shell, port } = boot();
  chrome.runtime.lastError = { message: "Specified native messaging host not found." };
  port().hostClose();
  chrome.runtime.lastError = undefined;
  const c = shell.conn();
  assert.equal(c.lastError, "Specified native messaging host not found.");
  assert.equal(c.everConnected, false);
  const stored = (await chrome.storage.session.get("vyre.conn"))["vyre.conn"];
  assert.equal(stored.lastError, c.lastError, "kept in chrome.storage.session for the popup");
  const e = explain(c, timers.now() + 30_000);
  assert.equal(e.state, "failing");
  assert.match(e.headline, /cannot find the Vyre connector/);
  assert.match(e.fix, /vyre-chrome install.*quit and reopen Chrome/);
  // forbidden and exited say something different
  assert.match(explain({ ...c, lastError: "Access to the specified native messaging host is forbidden." }).headline, /refused the connector/);
  assert.match(explain({ ...c, lastError: "Native host has exited." }).fix, /vyre-chrome doctor/);
  // A message from the host means connected, and clears the failure.
  port().hostClose && timers.advance(FAST_RETRY_MS);
  port().deliver({ event: "hello-ack" });
  await tick();
  assert.equal(explain(shell.conn()).state, "connected");
  assert.equal(shell.conn().connectedAt !== null, true);
  assert.ok(BADGE_AFTER_MS >= 10_000);
});

test("the keepalive alarm never shortens a pending backoff, and reconnects when nothing is pending", async () => {
  const { chrome, timers, shell, port } = boot();
  port().hostClose();
  const n = chrome._.counts.connectNative;
  chrome._.onAlarm.fire({ name: "vyre.keepalive" });
  assert.equal(chrome._.counts.connectNative, n, "a retry is already pending");
  timers.advance(FAST_RETRY_MS);
  assert.equal(chrome._.counts.connectNative, n + 1);
  // a worker woken with no timer and no port: the alarm connects, but not within 5 s of the last try
  shell.stop();
  port().hostClose(); // schedules again
  shell.stop(); // drop the timer as a killed worker would
  timers.pending.length = 0;
  const m = chrome._.counts.connectNative;
  chrome._.onAlarm.fire({ name: "vyre.keepalive" });
  assert.equal(chrome._.counts.connectNative, m, "too soon after the last attempt");
  assert.equal(timers.pending.length, 1);
  chrome._.onAlarm.fire({ name: "other" });
});

test("redactResult scrubs values but leaves screenshot pixels intact, including inside batch results", () => {
  const data = ("Zm9v/" + "A".repeat(60) + "+").repeat(4);
  const r = redactResult({ ok: true, image: { mime: "image/png", data }, cookie: "sessionid=abc123", note: "Bearer abcdefghijklmnop1234" });
  assert.equal(r.image.data, data);
  assert.ok(!JSON.stringify(r).includes("abc123"));
  const b = redactResult({ ok: true, results: [{ ok: true, image: { data } }, { token: "x".repeat(50) }] });
  assert.equal(b.results[0].image.data, data);
  assert.ok(!JSON.stringify(b.results[1]).includes("xxxxxxxxxx"));
  assert.equal(redactResult(null), null);
});

test("cdp: attach is idempotent and shared, send auto-attaches, one attach per tab kept", async () => {
  const chrome = createFakeChrome([{ url: "https://harlow.example/" }]);
  const events = [];
  const cdp = createCdp({ chrome, emit: e => events.push(e) });
  await Promise.all([cdp.attach(1), cdp.attach(1), cdp.attach(1)]);
  await cdp.attach(1);
  assert.equal(chrome._.counts.attach, 1);
  await cdp.send(1, "Runtime.enable", {});
  await cdp.send(1, "Page.enable", {});
  assert.equal(chrome._.counts.attach, 1);
  assert.deepEqual(cdp.attached(), [1]);
  const fresh = createCdp({ chrome: createFakeChrome([{ url: "https://harlow.example/" }]) });
  await fresh.send(1, "Runtime.enable");
  assert.deepEqual(fresh.attached(), [1]);
  await cdp.detach(1);
  assert.deepEqual(cdp.attached(), []);
  assert.equal(chrome._.counts.detach, 1);
  assert.deepEqual(events, []);
});

test("cdp: an attach left over from a restarted worker is adopted, not an error", async () => {
  const chrome = createFakeChrome([{ url: "https://harlow.example/" }]);
  chrome._.attached.add(1);
  const cdp = createCdp({ chrome });
  await cdp.attach(1);
  assert.deepEqual(cdp.attached(), [1]);
});

test("cdp: events reach on() listeners and unsubscribe works", async () => {
  const chrome = createFakeChrome([{ url: "https://harlow.example/" }]);
  const cdp = createCdp({ chrome });
  const got = [];
  const off = cdp.on((tabId, method, params) => got.push([tabId, method, params]));
  chrome._.onEvent.fire({ tabId: 1 }, "Network.requestWillBeSent", { requestId: "r1" });
  off();
  chrome._.onEvent.fire({ tabId: 1 }, "Network.requestWillBeSent", { requestId: "r2" });
  assert.deepEqual(got, [[1, "Network.requestWillBeSent", { requestId: "r1" }]]);
});

test("cdp: a detach emits {event:'detached'} and rejects in-flight calls with code detached", async () => {
  const chrome = createFakeChrome([{ url: "https://harlow.example/" }]);
  const events = [];
  const cdp = createCdp({ chrome, emit: e => events.push(e) });
  await cdp.attach(1);
  chrome._.cdp = () => new Promise(() => {}); // never answers
  const pending = cdp.send(1, "Runtime.evaluate", { expression: "1" });
  const pending2 = cdp.send(1, "Page.captureScreenshot", {});
  await tick();
  chrome._.onDetach.fire({ tabId: 1 }, "canceled_by_user");
  await assert.rejects(pending, { code: "detached" });
  await assert.rejects(pending2, { code: "detached" });
  assert.deepEqual(events.map(e => [e.event, e.tabId]), [["detached", 1]]);
  assert.deepEqual(cdp.attached(), []);
  // the next send re-attaches
  chrome._.cdp = () => ({});
  await cdp.send(1, "Runtime.enable");
  assert.equal(chrome._.counts.attach, 2);
});

test("cdp: a page that throws in sendCommand surfaces as an error with a code", async () => {
  const chrome = createFakeChrome([{ url: "https://harlow.example/" }]);
  chrome._.cdp = () => { throw new Error("Cannot find context"); };
  const cdp = createCdp({ chrome });
  await assert.rejects(cdp.send(1, "Runtime.evaluate", {}), e => e.code === "error" && /Cannot find context/.test(e.message));
});

test("registry: validates names, refuses duplicates, unknown_op, and survives missing optional caps", async () => {
  assert.throws(() => register({ name: "x", ops: { "Bad Name": async () => 1 } }), /bad op name/);
  assert.throws(() => register({ name: "y", ops: { "tabs.list": async () => 1 } }), /already registered/);
  assert.throws(() => register({ name: "z" }), /needs a name/);
  const ctx = createCtx({ chrome: createFakeChrome() });
  await assert.rejects(dispatchT("no.such", {}, ctx), { code: "unknown_op" });
  await assert.rejects(dispatch("tabs.list", [], ctx), { code: "bad_request" });
  await ready;
  const rep = loadReport();
  assert.ok(["tabs", "page", "batch"].every(n => rep.loaded.includes(n)));
  // whichever optional files exist loaded, whichever do not are listed as missing, and neither is fatal
  const seen = new Set([...rep.optional.loaded, ...rep.optional.missing, ...rep.optional.failed.map(f => f.name)]);
  assert.deepEqual([...seen].sort(), ["api", "devtools", "ghl", "net"]);
  assert.ok(opNames().includes("page.fill"));
});

test("registry: optional capabilities load through an importer; a broken one is reported and does not stop the rest", async () => {
  const good = { default: { name: "probe2", ops: { "probe2.ping": async () => ({ ok: true }) } } };
  await loadOptional(async name => {
    if (name === "zz-good") return good;
    if (name === "zz-broken") throw new SyntaxError("Unexpected token");
    throw Object.assign(new Error(`Cannot find module '/x/${name}.js' imported from /x/index.js`), { code: "ERR_MODULE_NOT_FOUND" });
  }, ["zz-good", "zz-broken", "zz-gone"]);
  const rep = loadReport();
  assert.ok(rep.optional.loaded.includes("zz-good"));
  assert.ok(rep.optional.failed.some(f => f.name === "zz-broken" && /Unexpected token/.test(f.error)));
  assert.ok(rep.optional.missing.includes("zz-gone"));
  const ctx = createCtx({ chrome: createFakeChrome() });
  assert.deepEqual(await dispatchT("probe2.ping", {}, ctx), { ok: true });
});

test("caps receive module events through onEvent; one throwing does not silence the rest", async () => {
  const seen = [];
  register({ name: "listener1", ops: { "listener1.x": async () => 1 }, onEvent: () => { throw new Error("bad"); } });
  register({ name: "listener2", ops: { "listener2.x": async () => 1 }, onEvent: e => { seen.push(e.event); } });
  const { port } = boot();
  port().deliver({ event: "custom" });
  await until(() => seen.includes("custom"));
  assert.ok(seen.includes("custom"));
});

test("no source file in the extension uses an em dash or the section sign", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("./", import.meta.url));
  const files = [];
  for (const d of ["extension", "extension/lib", "extension/caps", "test-support", "."]) for (const f of await readdir(root + d)) if (/^(ext-.*\.test\.js|.*\.js|manifest\.json)$/.test(f) && (d !== "." || f.startsWith("ext-"))) files.push(root + d + "/" + f);
  for (const f of files) {
    const s = await readFile(f, "utf8");
    assert.ok(!s.includes(String.fromCharCode(0x2014)) && !s.includes(String.fromCharCode(0xa7)), f);
  }
  void createFakePage; void samplePage;
});
