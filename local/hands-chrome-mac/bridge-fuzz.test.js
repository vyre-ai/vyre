// @ts-check
// A seeded fuzz of the Chrome bridge from the extension side: garbage bytes, and well-formed but
// hostile frames (the kind a page can cause the extension to relay: odd types, prototype keys,
// malformed escapes, huge and deeply nested values, replies nobody asked for). Whatever arrives, the
// bridge keeps serving, nothing throws out of it, and a real extension still gets its calls through.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createBridge } from "./bridge.js";
import { encode, reader, MAX } from "./native-host/stdio.js";

/** mulberry32: a small seeded PRNG so a failure replays exactly. @param {number} a */
const rng = a => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (/** @type {() => number} */ r, /** @type {any[]} */ xs) => xs[Math.floor(r() * xs.length)];

function nested(/** @type {number} */ n) { let o = /** @type {any} */ ({ leaf: "%zz" }); for (let i = 0; i < n; i++) o = i % 2 ? { a: o } : [o]; return o; }

function hostile(/** @type {() => number} */ r) {
  const junk = () => pick(r, [null, true, 42, -1, 1e308, "", "%zz", "%E0%A4%A", "x".repeat(50_000), [], {}, [[[]]], { "__proto__": { polluted: 1 } }, { constructor: { prototype: { polluted: 1 } } }, nested(1500), Array.from({ length: 5000 }, (_, i) => i), "\u0000‮", "Bearer abcdefghijklmnop1234567890"]);
  const url = () => pick(r, ["https://x.test/?%zz=1", "https://x.test/?%E0%A4%A=2&token=abcdef", "not a url", "", "http://[::1", "chrome://settings", junk()]);
  return pick(r, [
    () => ({ event: junk() }),
    () => ({ event: "hello", protocol: junk(), version: junk(), ops: junk(), caps: junk() }),
    () => ({ event: "host", origin: junk(), ppid: junk() }),
    () => ({ event: "net.event", request: { url: url(), requestBody: junk(), responseHeaders: junk(), status: junk() } }),
    () => ({ event: pick(r, ["stop", "resume", "replaced", "disconnected", "__proto__", "constructor"]), ...junk() }),
    () => ({ id: junk(), ok: junk(), result: junk() }),
    () => ({ id: "m1", ok: false, error: junk() }),
    () => ({ id: "m9999", ok: true, result: junk() }),
    () => ({ id: "m1", ok: true, result: { url: url(), image: junk(), held: true, signature: junk() } }),
    () => junk(),
    () => [junk(), junk()],
    () => ({}),
  ])();
}

function garbage(/** @type {() => number} */ r) {
  const n = Math.floor(r() * 300);
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(r() * 256);
  const kind = Math.floor(r() * 5);
  if (kind === 1) { const h = Buffer.alloc(4); h.writeUInt32LE(MAX + 1 + Math.floor(r() * 1000), 0); return Buffer.concat([h, b]); }
  if (kind === 2) { const h = Buffer.alloc(4); h.writeUInt32LE(Math.floor(r() * 64), 0); return Buffer.concat([h, b]); }
  if (kind === 3) return Buffer.concat([Buffer.from([0, 0, 0, 0]), b]);
  return b;
}

const tick = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const connect = async (/** @type {string} */ p) => { const s = net.connect(p); s.on("error", () => {}); await new Promise(r => s.once("connect", r)); return s; };

test("fuzz: garbage and hostile frames never stop the bridge, and a real extension still works", async t => {
  const seed = Number(process.env.VYRE_FUZZ_SEED) || 20260930;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-z-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sockPath = path.join(dir, "chrome.sock");
  const r = rng(seed);
  const logs = /** @type {string[]} */ ([]);
  const uncaught = /** @type {any[]} */ ([]);
  const onUncaught = (/** @type {any} */ e) => { uncaught.push(e); };
  process.on("uncaughtException", onUncaught);
  t.after(() => process.off("uncaughtException", onUncaught));
  const b = createBridge({ sockPath, log: m => logs.push(m), timeoutMs: 2000 });
  await b.listen();
  t.after(() => b.close());
  b.on(() => {});

  // Phase 1: many short-lived connections, each throwing garbage or hostile frames at the bridge.
  const socks = [];
  for (let i = 0; i < 120; i++) {
    const s = await connect(sockPath);
    socks.push(s);
    const n = 1 + Math.floor(r() * 6);
    for (let j = 0; j < n; j++) {
      if (r() < 0.35) s.write(garbage(r));
      else { try { s.write(encode(hostile(r))); } catch { /* an unencodable value is the fuzzer's problem, not the bridge's */ } }
    }
    if (r() < 0.5) s.destroy();
  }
  await tick(300);
  assert.deepEqual(uncaught, [], "nothing threw out of the bridge");

  // Phase 2: a well-behaved extension connects and is served, even with a hostile peer on the socket.
  const good = await connect(sockPath);
  const rd = reader();
  good.on("data", d => {
    let frames = [];
    try { frames = rd.push(d); } catch { return; }
    for (const f of frames) if (f && f.id && f.op) good.write(encode({ id: f.id, ok: true, result: { ok: true, echoed: f.op } }));
  });
  good.write(encode({ event: "hello", protocol: 1, version: "fuzz" }));
  for (let i = 0; i < 20; i++) { await tick(25); if (b.connected()) break; }
  assert.equal(b.connected(), true, "a real extension still connects after the fuzz");
  const res = await b.call("tabs.list", {});
  assert.equal(res.echoed, "tabs.list");

  // Phase 3: hostile well-formed frames from the LIVE extension itself. It stays up, or if a frame
  // knocks it off, the next connection is served: the bridge is never the thing that stops.
  for (let i = 0; i < 150; i++) { try { good.write(encode(hostile(r))); } catch { /* skip */ } }
  await tick(300);
  assert.deepEqual(uncaught, [], "nothing threw out of the bridge from the live connection either");
  const again = await connect(sockPath);
  const rd2 = reader();
  again.on("data", d => { try { for (const f of rd2.push(d)) if (f && f.id && f.op) again.write(encode({ id: f.id, ok: true, result: { ok: true } })); } catch { /* ignore */ } });
  again.write(encode({ event: "hello", protocol: 1, version: "fuzz2" }));
  for (let i = 0; i < 20; i++) { await tick(25); if (b.connected()) break; }
  assert.equal(b.connected(), true);
  assert.equal((await b.call("page.snapshot", {})).ok, true, `still serving (seed ${seed})`);

  // Nothing a frame carried may have polluted Object.prototype.
  assert.equal(/** @type {any} */ ({}).polluted, undefined, "no prototype pollution");
  for (const s of [...socks, good, again]) s.destroy();
});
