// Pure tests for the Chrome proof harness helpers: latency stats, native-messaging framing (checked
// byte for byte against native-host/stdio.js), extension ids, wrapper and manifest text, arg
// parsing, and the host's byte pipe over a real local socket. No Chrome, no browser, fake-only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { percentile, stats, frame, Deframer, extensionIdFromKey, makeKey, prepareExtension, hostManifest, wrapperScript, parseArgs, parseInstallOutput, HOST_NAME, timeIt } from "./spike/harness/lib.mjs";
import { encode, reader } from "./native-host/stdio.js";
import { summaryLine, PROFILES } from "./spike/harness/run.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("percentile and stats use nearest rank", () => {
  const s = Array.from({ length: 200 }, (_, i) => i + 1);
  assert.equal(percentile(s, 50), 100);
  assert.equal(percentile(s, 95), 190);
  const st = stats(s.map(x => x / 10));
  assert.equal(st.n, 200);
  assert.equal(st.p50, 10);
  assert.equal(st.p95, 19);
  assert.equal(st.min, 0.1);
  assert.equal(st.max, 20);
  assert.equal(stats([]).n, 0);
  assert.equal(stats([5]).p95, 5);
});

test("timeIt runs warmups untimed and returns n samples", async () => {
  let calls = 0; const befores = [];
  const out = await timeIt(4, async () => { calls++; }, { warmup: 2, before: async i => { befores.push(i); } });
  assert.equal(out.length, 4);
  assert.equal(calls, 6);
  assert.equal(befores.length, 6);
});

test("framing matches native-host/stdio.js byte for byte and survives any chunking", () => {
  const msgs = [{ id: 1, op: "ping" }, { id: 2, ok: true, result: { text: "caf\u00e9 \u2713" } }, { event: "hello" }];
  for (const m of msgs) assert.deepEqual(frame(m), encode(m));
  const wire = Buffer.concat(msgs.map(frame));
  for (const size of [1, 2, 3, 5, 7, wire.length]) {
    const d = new Deframer(); const theirs = reader(); const got = []; const got2 = [];
    for (let i = 0; i < wire.length; i += size) { const c = wire.subarray(i, i + size); got.push(...d.push(c)); got2.push(...theirs.push(c)); }
    assert.deepEqual(got, msgs);
    assert.deepEqual(got2, msgs);
    assert.equal(d.pending(), 0);
  }
  const d = new Deframer();
  assert.deepEqual(d.push(frame({ a: 1 }).subarray(0, 3)), []);
  assert.equal(d.pending(), 3);
});

test("extension id is 32 letters a-p, stable for a key, and a manifest key is honoured", () => {
  const k = makeKey();
  assert.match(k.id, /^[a-p]{32}$/);
  assert.equal(extensionIdFromKey(Buffer.from(k.keyB64, "base64")), k.id);
  assert.notEqual(makeKey().id, k.id);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spike-lib-test-"));
  try {
    const a = prepareExtension(path.join(here, "spike", "extension"), path.join(tmp, "a"));
    assert.match(a.id, /^[a-p]{32}$/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, "a", "manifest.json"), "utf8")).key);
    // a second prepare of the already-keyed copy keeps the id
    const b = prepareExtension(path.join(tmp, "a"), path.join(tmp, "b"));
    assert.equal(b.id, a.id);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("host manifest pins the extension origin; wrappers set the socket env and quote paths", () => {
  const m = hostManifest({ wrapper: "/x/host.sh", id: "a".repeat(32) });
  assert.equal(m.name, HOST_NAME);
  assert.equal(m.type, "stdio");
  assert.deepEqual(m.allowed_origins, [`chrome-extension://${"a".repeat(32)}/`]);
  const posix = wrapperScript({ platform: "linux", node: "/usr/bin/node", hostJs: "/it's/host.js", sock: "/tmp/s.sock", home: "/tmp/h" });
  assert.match(posix, /^#!\/bin\/sh\n/);
  assert.match(posix, /VYRE_CHROME_SOCK='\/tmp\/s\.sock'/);
  assert.match(posix, /'\/it'\\''s\/host\.js'/);
  const win = wrapperScript({ platform: "win32", node: "C:\\node\\node.exe", hostJs: "C:\\h\\host.js", sock: "\\\\.\\pipe\\p", home: "C:\\t" });
  assert.match(win, /set VYRE_CHROME_SOCK=\\\\\.\\pipe\\p\r\n/);
  assert.match(win, /"C:\\node\\node\.exe" "C:\\h\\host\.js" %\*/);
});

test("parseArgs and parseInstallOutput", () => {
  assert.deepEqual(parseArgs(["--out", "a.json", "--diag", "--calls=50", "--keep"]), { out: "a.json", diag: true, calls: "50", keep: true });
  assert.deepEqual(parseInstallOutput("downloading...\nchrome@131.0.6778.85 /tmp/chrome/mac/Google Chrome for Testing.app/x\n"), { version: "131.0.6778.85", path: "/tmp/chrome/mac/Google Chrome for Testing.app/x" });
  assert.equal(parseInstallOutput("nothing useful"), null);
});

test("summaryLine reports a pass and names failed stages", () => {
  const good = { os: "linux-x64", chrome: "1.2.3", headless: "new", stages: { sw_hello: { ok: true, sinceLaunchMs: 900 }, attach: { hostRoundTrip: { p50: 4.1 } }, ping_latency: { latency: { p50: 0.9, p95: 2 } }, eval_latency: { latency: { p50: 1.5, p95: 3 } }, host_loopback: { latency: { p50: 0.3, p95: 0.6 } } } };
  assert.match(summaryLine(good, true), /PASS linux-x64 chrome 1\.2\.3 headless=new: hello 900 ms, attach p50 4\.1 ms, ping p50\/p95 0\.9\/2 ms/);
  const bad = { os: "win32-x64", chrome: "1", headless: "new", stages: { sw_hello: { ok: false, error: "no hello" } } };
  assert.match(summaryLine(bad, false), /FAIL .*hello NO.*failed: sw_hello \(no hello\)/);
  assert.equal(PROFILES.spike.eval("1", "u").op, "eval");
  assert.equal(PROFILES.real.eval("1").op, "page.eval");
});

test("spike host is a byte pipe between stdio and the socket (real host.js, real wrapper, no Chrome)", { skip: process.platform === "win32" }, async () => {
  const tmp = fs.mkdtempSync("/tmp/vyre-t-");
  const sock = path.join(tmp, "c.sock");
  const wrapper = path.join(tmp, "host.sh");
  fs.writeFileSync(wrapper, wrapperScript({ node: process.execPath, hostJs: path.join(here, "spike", "host", "host.js"), sock, home: tmp }));
  fs.chmodSync(wrapper, 0o755);
  const server = net.createServer(conn => {
    const rd = new Deframer();
    conn.on("data", d => { for (const m of rd.push(d)) conn.write(frame({ id: m.id, ok: true, result: { echo: m.op } })); });
  });
  await new Promise(r => server.listen(sock, r));
  const child = spawn(wrapper, [], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const rd = new Deframer();
    const got = new Promise(resolve => { const seen = []; child.stdout.on("data", d => { seen.push(...rd.push(d)); if (seen.length === 3) resolve(seen); }); });
    for (let i = 0; i < 3; i++) child.stdin.write(frame({ id: i, op: "ping" + i }));
    const out = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error("host relay timed out")), 8000))]);
    assert.deepEqual(out.map(m => m.result.echo), ["ping0", "ping1", "ping2"]);
    child.stdin.end();
    await new Promise(r => child.once("exit", r));
  } finally {
    try { child.kill(); } catch { /* gone */ }
    server.close(); server.closeAllConnections?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("spike extension manifest is MV3 with only debugger, nativeMessaging, tabs", () => {
  const m = JSON.parse(fs.readFileSync(path.join(here, "spike", "extension", "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ["debugger", "nativeMessaging", "tabs"]);
  assert.equal(m.background.service_worker, "background.js");
});
