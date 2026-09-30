// @ts-check
// The native host over streams: bytes both ways untouched, frame boundaries kept across chunk
// splits, {event:"no_module"} told once with a slow retry, and exit 0 when either side closes.
// One test runs the real launcher against a socket that is not there (no Chrome involved).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Duplex, PassThrough } from "node:stream";
import net from "node:net";
import { relay, socketPath, connectTo } from "./native-host/host.js";
import { encode, reader } from "./native-host/stdio.js";
import { install } from "./native-host/install.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const nap = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/** Two connected in-memory duplexes: what one writes the other reads. */
function pair() {
  /** @type {Duplex} */ let a; /** @type {Duplex} */ let b;
  const mk = (/** @type {() => Duplex} */ peer) => new Duplex({ read() {}, write(c, _e, cb) { peer().push(c); cb(); }, final(cb) { peer().push(null); cb(); } });
  a = mk(() => b); b = mk(() => a);
  return { a, b };
}
const collect = (/** @type {any} */ stream) => { const rd = reader(); /** @type {any[]} */ const out = []; stream.on("data", (/** @type {Buffer} */ d) => out.push(...rd.push(d))); return out; };

test("host: frames go both ways, whole and unchanged, even when chunks split them", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const { a, b } = pair();
  const toModule = /** @type {Buffer[]} */ ([]);
  b.on("data", d => toModule.push(d));
  const fromHost = collect(stdout);
  const done = relay(stdin, stdout, async () => a);
  await nap(10);
  const f1 = encode({ event: "hello", protocol: 1 }), f2 = encode({ id: "m1", ok: true, result: { a: 1 } });
  const both = Buffer.concat([f1, f2]);
  stdin.write(both.subarray(0, 7)); stdin.write(both.subarray(7, f1.length + 3)); stdin.write(both.subarray(f1.length + 3));
  b.write(encode({ id: "m1", op: "tabs.list", args: {} }).subarray(0, 5));
  b.write(encode({ id: "m1", op: "tabs.list", args: {} }).subarray(5));
  await nap(30);
  assert.ok(Buffer.concat(toModule).equals(both), "module side received the exact bytes");
  assert.deepEqual(fromHost, [{ id: "m1", op: "tabs.list", args: {} }]);
  stdin.end();
  assert.equal(await done, 0);
});

test("host: it never reads frame content, so a body that is not JSON still crosses intact", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const { a, b } = pair();
  const got = /** @type {Buffer[]} */ ([]);
  b.on("data", d => got.push(d));
  const done = relay(stdin, stdout, async () => a);
  await nap(10);
  const junk = Buffer.concat([Buffer.from([4, 0, 0, 0]), Buffer.from("{{{{")]);
  stdin.write(junk);
  await nap(20);
  assert.ok(Buffer.concat(got).equals(junk));
  stdin.end(); await done;
});

test("host: no module is said once, retried no faster than the interval, and the first frame is handed over when it appears", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const seen = collect(stdout);
  let tries = 0;
  const { a, b } = pair();
  const got = /** @type {Buffer[]} */ ([]);
  b.on("data", d => got.push(d));
  const done = relay(stdin, stdout, async () => { tries++; if (tries < 4) throw new Error("ENOENT"); return a; }, { retryMs: 40 });
  await nap(5);
  const hello = encode({ event: "hello", protocol: 1 });
  stdin.write(hello);
  await nap(30);
  assert.deepEqual(seen, [{ event: "no_module" }]);
  assert.ok(tries <= 2, `retried too fast: ${tries}`);
  await nap(150);
  assert.ok(tries >= 4);
  assert.deepEqual(seen, [{ event: "no_module" }], "told once, not on every retry");
  assert.ok(Buffer.concat(got).equals(hello), "the hello that had nowhere to go reached the module");
  stdin.end(); await done;
});

test("host: it never busy-loops while the module is missing", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  let tries = 0;
  const done = relay(stdin, stdout, async () => { tries++; throw new Error("ENOENT"); }, { retryMs: 50 });
  await nap(220);
  stdin.end();
  assert.equal(await done, 0);
  assert.ok(tries >= 2 && tries <= 6, `tries ${tries}`);
  const after = tries;
  await nap(120);
  assert.equal(tries, after, "no attempts after exit");
});

test("host: exits 0 when Chrome closes stdin, and closes the module's socket", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const { a, b } = pair();
  const done = relay(stdin, stdout, async () => a);
  await nap(10);
  stdin.end();
  assert.equal(await done, 0);
  assert.equal(a.destroyed, true);
  void b;
});

test("host: exits 0 when the module closes the socket (a real unix socket)", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-s-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, "s.sock");
  const server = net.createServer(sock => { sock.write(encode({ event: "hi" })); setTimeout(() => sock.destroy(), 30); });
  await new Promise(r => server.listen(p, () => r(null)));
  t.after(() => server.close());
  const stdin = new PassThrough(), stdout = new PassThrough();
  const seen = collect(stdout);
  assert.equal(await relay(stdin, stdout, connectTo(p)), 0);
  assert.deepEqual(seen, [{ event: "hi" }]);
});

test("host: the socket path follows VYRE_CHROME_SOCK, then VYRE_HOME, then the home folder; a pipe on Windows", () => {
  assert.equal(socketPath({ env: { VYRE_CHROME_SOCK: "/x/s" }, platform: "darwin", home: "/h" }), "/x/s");
  assert.equal(socketPath({ env: { VYRE_HOME: "/v" }, platform: "linux", home: "/h" }), "/v/run/chrome.sock");
  assert.equal(socketPath({ env: {}, platform: "darwin", home: "/h" }), "/h/.vyre/run/chrome.sock");
  assert.equal(socketPath({ env: {}, platform: "win32", home: "C:\\Users\\alex", user: "alex" }), "\\\\.\\pipe\\vyre-chrome-alex");
});

test("host: the launcher runs the node recorded at install time and exits 0 when stdin closes", { skip: process.platform === "win32" }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-h-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of ["host.js", "stdio.js", "run-host.sh", "run-host.cmd"]) fs.copyFileSync(path.join(HERE, "native-host", f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, "..", "shared"), { recursive: true });
  install({ home: dir, platform: "linux", extensionId: "a".repeat(32), hostDir: dir, browsers: ["chrome"] });
  assert.equal(fs.readFileSync(path.join(dir, "node-path"), "utf8"), process.execPath);
  const p = spawn(path.join(dir, "run-host.sh"), ["chrome-extension://" + "a".repeat(32) + "/"], { env: { ...process.env, VYRE_CHROME_SOCK: path.join(dir, "no-such.sock") }, stdio: ["pipe", "pipe", "inherit"] });
  const out = collect(p.stdout);
  const code = new Promise(r => p.on("exit", r));
  const end = Date.now() + 3000;
  while (!out.length && Date.now() < end) await nap(10);
  assert.deepEqual(out[0], { event: "no_module" });
  p.stdin.end();
  assert.equal(await code, 0);
});
