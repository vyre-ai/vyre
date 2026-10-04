// @ts-check
// A page chooses the names in the URLs, form bodies and console lines Vyre reads. None of them may
// crash the redactor, and a bad frame may never take the bridge (or the daemon) down.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as redact from "./extension/shared/redact.js";
import { createBridge } from "./bridge.js";
import { encode } from "./native-host/stdio.js";

test("malformed percent escapes in names never throw", () => {
  assert.doesNotThrow(() => redact.url("https://x.test/a?%zz=1&token=abcdef"));
  assert.match(redact.url("https://x.test/a?%zz=1&token=abcdef"), /token=\[redacted/);
  assert.doesNotThrow(() => redact.body("%zz=1&b=2", "application/x-www-form-urlencoded"));
  assert.doesNotThrow(() => redact.request({ url: "https://x.test/?%E0%A4%A=1" }));
  assert.doesNotThrow(() => redact.value({ "%zz": "%E0%A4%A", console: "GET /?%zz=1" }));
  assert.match(redact.guarded(() => { throw new Error("x"); }), /redacted/);
});

test("a hostile frame is dropped and the bridge keeps serving", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-h-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sockPath = path.join(dir, "c.sock");
  const logs = /** @type {string[]} */ ([]);
  const b = createBridge({ sockPath, log: m => logs.push(m) });
  await b.listen();
  t.after(() => b.close());
  const s = net.connect(sockPath);
  await new Promise(r => s.once("connect", r));
  s.write(encode({ event: "hello", protocol: 1, version: "t" }));
  s.write(encode({ event: "net.event", request: { url: "https://x.test/?%zz=1&%E0%A4%A=2", requestBody: "%zz=1" } }));
  s.write(Buffer.from([1, 0, 0, 0, 0x7b])); // a frame that is not JSON
  await new Promise(r => setTimeout(r, 200));
  assert.equal(b.connected(), false, "the malformed frame closes that connection, not the bridge");
  const s2 = net.connect(sockPath);
  await new Promise(r => s2.once("connect", r));
  s2.write(encode({ event: "hello", protocol: 1, version: "t2" }));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(b.connected(), true);
  s.destroy(); s2.destroy();
});

test("only the pinned extension's hello counts, and a replacement is announced", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-p-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sockPath = path.join(dir, "c.sock");
  const ORIGIN = "chrome-extension://jichfmdmnhaphgemkiehddkfcecpncib/";
  const b = createBridge({ sockPath, extensionOrigin: ORIGIN });
  await b.listen();
  t.after(() => b.close());
  const seen = /** @type {any[]} */ ([]);
  b.on(e => seen.push(e));
  const connect = async (/** @type {any[]} */ frames) => {
    const s = net.connect(sockPath);
    await new Promise(r => s.once("connect", r));
    s.on("error", () => {});
    for (const f of frames) s.write(encode(f));
    await new Promise(r => setTimeout(r, 150));
    return s;
  };
  const stranger = await connect([{ event: "hello", protocol: 1, version: "evil" }]);
  assert.equal(b.connected(), false, "a process that only writes hello is not the extension");
  const wrong = await connect([{ event: "host", origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/" }, { event: "hello", protocol: 1, version: "evil2" }]);
  assert.equal(b.connected(), false, "another extension's origin is refused");
  const real = await connect([{ event: "host", origin: ORIGIN, ppid: 1 }, { event: "hello", protocol: 1, version: "0.2.0" }]);
  assert.equal(b.connected(), true);
  const again = await connect([{ event: "host", origin: ORIGIN }, { event: "hello", protocol: 1, version: "0.2.1" }]);
  assert.ok(seen.some(e => e.event === "replaced"), "a replacement is announced");
  for (const s of [stranger, wrong, real, again]) s.destroy();
});
