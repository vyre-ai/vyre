// @ts-check
// The module's socket, over a real unix socket in a temp dir with a fake extension client:
// framing both ways, id matching, timeouts, no_extension, a second hello replacing the first,
// stale socket cleanup, and redaction of everything on arrival.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { createBridge } from "./bridge.js";
import { fakeExtension, until } from "./fake-extension.js";
import { encode } from "./native-host/stdio.js";

/** A short temp dir (unix socket paths are capped near 104 bytes on macOS). */
const tmp = (/** @type {any} */ t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vc-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const start = async (/** @type {any} */ t, opts = {}) => {
  const dir = tmp(t);
  const sockPath = path.join(dir, "run", "chrome.sock");
  const b = createBridge({ sockPath, ...opts });
  await b.listen();
  t.after(() => b.close());
  return { b, dir, sockPath };
};

test("bridge: the run folder is 0700 and the socket 0600", async t => {
  const { sockPath } = await start(t);
  assert.equal(fs.statSync(path.dirname(sockPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(sockPath).mode & 0o777, 0o600);
});

test("bridge: no extension connected is no_extension, and so is one that has not said hello", async t => {
  const { b, sockPath } = await start(t);
  await assert.rejects(b.call("tabs.list"), { code: "no_extension" });
  const x = await fakeExtension(sockPath, { hello: false });
  assert.equal(b.connected(), false);
  await assert.rejects(b.call("tabs.list"), { code: "no_extension" });
  await x.hello();
  await until(() => b.connected());
  assert.equal(b.info().version, "0.2.0");
});

test("bridge: requests and answers are matched by id, whatever the order they come back in", async t => {
  const { b, sockPath } = await start(t);
  const x = await fakeExtension(sockPath, {
    handler: async (op, args) => { await new Promise(r => setTimeout(r, args.wait)); return { op, n: args.n }; },
  });
  await until(() => b.connected());
  const [slow, fast] = await Promise.all([b.call("page.snapshot", { n: 1, wait: 60 }), b.call("tabs.list", { n: 2, wait: 0 })]);
  assert.deepEqual(slow, { op: "page.snapshot", n: 1 });
  assert.deepEqual(fast, { op: "tabs.list", n: 2 });
  assert.equal(x.got.filter(m => m.op).length, 2);
});

test("bridge: the extension's own error code comes back on the rejection", async t => {
  const { b, sockPath } = await start(t);
  await fakeExtension(sockPath, { handler: () => { throw Object.assign(new Error("nothing matches that selector"), { code: "not_found" }); } });
  await until(() => b.connected());
  await assert.rejects(b.call("page.act", {}), { code: "not_found", message: /nothing matches/ });
});

test("bridge: a call that is never answered times out, and a late answer is ignored", async t => {
  const { b, sockPath } = await start(t, { timeoutMs: 1000 });
  const x = await fakeExtension(sockPath, { handler: () => new Promise(() => {}) });
  await until(() => b.connected());
  const t0 = Date.now();
  await assert.rejects(b.call("page.snapshot", {}, { timeoutMs: 60 }), { code: "timeout" });
  assert.ok(Date.now() - t0 < 500);
  const id = x.ops("page.snapshot")[0].id;
  await x.send({ id, ok: true, result: { late: true } }); // must not throw or resolve anything
  await assert.rejects(b.call("net.replay", {}, { timeoutMs: 20 }), { code: "timeout" });
});

test("bridge: a per-op override beats the default", async t => {
  const { b, sockPath } = await start(t, { timeoutMs: 5000, opTimeouts: { "page.wait": 30 } });
  await fakeExtension(sockPath, { handler: () => new Promise(() => {}) });
  await until(() => b.connected());
  const t0 = Date.now();
  await assert.rejects(b.call("page.wait", {}), { code: "timeout" });
  assert.ok(Date.now() - t0 < 1000);
});

test("bridge: a second hello replaces the first; the first one's pending calls fail, new calls go to the new one", async t => {
  const { b, sockPath } = await start(t);
  const first = await fakeExtension(sockPath, { handler: () => new Promise(() => {}) });
  await until(() => b.connected());
  const stuck = b.call("page.snapshot", {});
  stuck.catch(() => {});
  const second = await fakeExtension(sockPath, { hello: { version: "0.2.1" }, handler: () => ({ from: "second" }) });
  await until(() => b.info() && b.info().version === "0.2.1");
  await assert.rejects(stuck, { code: "no_extension" });
  assert.deepEqual(await b.call("tabs.list", {}), { from: "second" });
  await first.closed();
  assert.equal(b.connected(), true, "the old connection closing does not disconnect the new one");
  assert.equal(second.ops("tabs.list").length, 1);
});

test("bridge: closing the live connection rejects what is pending, fans out a disconnect and reports not connected", async t => {
  const { b, sockPath } = await start(t);
  const seen = /** @type {string[]} */ ([]);
  b.on(e => seen.push(e.event));
  const x = await fakeExtension(sockPath, { handler: () => new Promise(() => {}) });
  await until(() => b.connected());
  const p = b.call("page.snapshot", {});
  p.catch(() => {});
  await until(() => x.ops("page.snapshot").length === 1);
  await x.close();
  await assert.rejects(p, { code: "no_extension" });
  await until(() => !b.connected());
  assert.deepEqual(seen, ["hello", "disconnected"]);
});

test("bridge: a hello for another protocol is refused and the connection closed", async t => {
  const { b, sockPath } = await start(t);
  const x = await fakeExtension(sockPath, { hello: false });
  await x.send({ event: "hello", protocol: 99 });
  await x.closed();
  assert.equal(b.connected(), false);
  assert.ok(x.events().some(e => e.event === "bad_protocol"));
});

test("bridge: a stale socket file is replaced, a live one is not", async t => {
  const dir = tmp(t);
  const sockPath = path.join(dir, "chrome.sock");
  // A process that binds the socket and is killed leaves the file behind: the real stale case.
  const r = spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sockPath)}, () => process.kill(process.pid, "SIGKILL"))`]);
  assert.ok(r.signal === "SIGKILL" || r.status !== 0);
  assert.ok(fs.existsSync(sockPath), "the test needs a stale socket to begin with");
  const b = createBridge({ sockPath });
  await b.listen();
  t.after(() => b.close());
  await fakeExtension(sockPath);
  await until(() => b.connected());

  const other = createBridge({ sockPath });
  await assert.rejects(other.listen(), { code: "in_use" });
  assert.equal(b.connected(), true, "the live listener was left alone");
});

test("bridge: every result and event payload is redacted again on arrival", async t => {
  const { b, sockPath } = await start(t);
  const seen = /** @type {any[]} */ ([]);
  b.on(e => seen.push(e));
  const x = await fakeExtension(sockPath, {
    handler: () => ({ cookie: "sid=abc123", nested: { password: "hunter2hunter2", note: "Bearer abcdefghijklmnopqrstuvwxyz0123" }, title: "Inbox", list: [{ token: "t0k3n" }] }),
  });
  await until(() => b.connected());
  const r = await b.call("page.snapshot", {});
  const text = JSON.stringify(r);
  for (const leak of ["abc123", "hunter2", "abcdefghijklmnopqrstuvwxyz", "t0k3n"]) assert.ok(!text.includes(leak), `${leak} leaked`);
  assert.equal(r.title, "Inbox");
  assert.match(r.cookie, /redacted/);

  await x.send({ event: "net.event", request: { url: "https://app.example/x?access_token=zzzzzzzzzzzz", authorization: "Bearer qqqqqqqqqqqqqqqqqqqq" } });
  await until(() => seen.some(e => e.event === "net.event"));
  const ev = JSON.stringify(seen.find(e => e.event === "net.event"));
  assert.ok(!ev.includes("qqqqqqqq"));
});

test("bridge: an error message from the extension is redacted too", async t => {
  const { b, sockPath } = await start(t);
  await fakeExtension(sockPath, { handler: () => { throw Object.assign(new Error("failed with Bearer abcdefghijklmnopqrstuvwxyz0123"), { code: "error" }); } });
  await until(() => b.connected());
  await assert.rejects(b.call("page.act", {}), e => !/abcdefghijklmnopqrstuvwxyz/.test(String(e.message)));
});

test("bridge: a held act keeps its page signature (redact would mask the key called signature)", async t => {
  const { b, sockPath } = await start(t);
  await fakeExtension(sockPath, { handler: () => ({ held: true, signature: "9f3a", fields: [{ name: "Email", value: "alex@example.com" }] }) });
  await until(() => b.connected());
  const r = await b.call("page.act", {});
  assert.equal(r.signature, "9f3a");
});

test("bridge: input from a connection that has not said hello is not believed", async t => {
  const { b, sockPath } = await start(t);
  const seen = /** @type {any[]} */ ([]);
  b.on(e => seen.push(e));
  const raw = net.connect(sockPath);
  await new Promise(r => raw.once("connect", r));
  raw.write(encode({ event: "stop" }));
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(seen, []);
  raw.destroy();
});

test("bridge: a url field loses secret query parameters even when the value does not look like a secret", async t => {
  const { b, sockPath } = await start(t);
  await fakeExtension(sockPath, { handler: () => ({ tabs: [{ id: 1, url: "https://harlow.example/intake?token=abcdefghijklmnop&page=2" }] }) });
  await until(() => b.connected());
  const r = await b.call("tabs.list", {});
  assert.ok(!r.tabs[0].url.includes("abcdefghijklmnop"));
  assert.ok(r.tabs[0].url.includes("page=2"));
});
