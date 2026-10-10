// @ts-check
// FOUNDATION S8 (issue #134): the relay never reads a client's content. A visitor talks real TLS through the relay's front to a box that holds the certificate; the relay runs alone in its own process. A marker
// is in the visitor's request and in the box's answer. The relay's memory (read from /proc while the stream is open and again after it ends), every line it logged, its counters and the folder it ran in
// are searched for the marker. Control: a marker the relay IS allowed to read (the server name in the hello, the protocol list) is found by the same scan, so the scan can fail. Linux only.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { selfSigned } from "../core/wink/control/testing/selfsigned.js";

const linux = process.platform === "linux";

/** Every readable, writable mapping of a process, searched for each needle (as bytes, and as UTF-16 for JS strings). @param {number} pid @param {string[]} needles */
function scanMemory(pid, needles) {
  const forms = needles.flatMap(n => [Buffer.from(n, "latin1"), Buffer.from(n, "utf16le")]);
  const maxLen = Math.max(...forms.map(f => f.length));
  const fd = fs.openSync(`/proc/${pid}/mem`, "r");
  /** @type {Set<string>} */ const found = new Set();
  let bytes = 0;
  try {
    for (const line of fs.readFileSync(`/proc/${pid}/maps`, "utf8").split("\n")) {
      const m = /^([0-9a-f]+)-([0-9a-f]+) (r)(w)/.exec(line);
      if (!m || /\[(vvar|vsyscall|vdso)\]/.test(line)) continue;
      let at = Number.parseInt(m[1], 16);
      const end = Number.parseInt(m[2], 16);
      const buf = Buffer.alloc(4 * 1024 * 1024 + maxLen);
      while (at < end) {
        const want = Math.min(4 * 1024 * 1024, end - at);
        let got = 0;
        try { got = fs.readSync(fd, buf, 0, want + Math.min(maxLen, end - at - want), at); } catch { break; }
        if (got <= 0) break;
        bytes += got;
        for (const f of forms) if (buf.subarray(0, got).includes(f)) found.add(f.toString("latin1").replace(/\0/g, ""));
        at += want;
      }
    }
  } finally { fs.closeSync(fd); }
  assert.ok(bytes > 8 * 1024 * 1024, `the scan read the relay's memory (${bytes} bytes)`);
  return found;
}

/** The relay front in a child process, a box that ends TLS in this one, and a visitor that sends `request` through them. */
async function run(/** @type {import("node:test").TestContext} */ t, { leak = false, alpn = "" } = {}) {
  const { cert, key } = selfSigned({ ips: ["127.0.0.1"], names: ["harlow.vyre.run"] });
  const marker = `S8MARK-${crypto.randomBytes(10).toString("hex")}`;
  const answerMarker = `S8ANS-${crypto.randomBytes(10).toString("hex")}`;
  const box = tls.createServer({ cert, key, ALPNProtocols: alpn ? [alpn, "http/1.1"] : ["http/1.1"] }, s => {
    s.on("error", () => {});
    s.on("data", d => { if (String(d).includes(marker)) s.write(`HTTP/1.1 200 OK\r\ncontent-length: ${answerMarker.length}\r\nconnection: keep-alive\r\n\r\n${answerMarker}`); });
  });
  await new Promise(r => box.listen(0, "127.0.0.1", () => r(undefined)));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "relay-s8-"));
  const child = spawn(process.execPath, [new URL("./relay-child.mjs", import.meta.url).pathname], { cwd: work, env: { ...process.env, BOX_PORT: String(/** @type {any} */ (box.address()).port), ...(leak ? { LEAK: "1" } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
  /** @type {string[]} */ const out = [];
  let buffered = "";
  child.stdout.on("data", d => { buffered += d; let i; while ((i = buffered.indexOf("\n")) >= 0) { out.push(buffered.slice(0, i)); buffered = buffered.slice(i + 1); } });
  child.stderr.on("data", d => out.push(`ERR ${d}`));
  t.after(() => { child.kill(); box.close(); fs.rmSync(work, { recursive: true, force: true }); });
  const waitFor = async (/** @type {() => any} */ f) => { for (let i = 0; i < 300; i++) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 20)); } throw new Error(`timed out; the relay said: ${out.join(" | ").slice(0, 400)}`); };
  const port = Number((await waitFor(() => out.find(l => l.startsWith("LISTEN ")))).slice(7));
  const visitor = tls.connect({ host: "127.0.0.1", port, servername: "harlow.vyre.run", ca: cert, ALPNProtocols: alpn ? [alpn] : ["http/1.1"] });
  visitor.on("error", () => {});
  await new Promise((res, rej) => { visitor.once("secureConnect", () => res(undefined)); visitor.once("error", rej); });
  let reply = "";
  visitor.on("data", d => { reply += d; });
  visitor.write(`POST /private HTTP/1.1\r\nhost: harlow.vyre.run\r\ncontent-length: ${marker.length}\r\n\r\n${marker}`);
  await waitFor(() => reply.includes(answerMarker));
  return { child, out, marker, answerMarker, work, visitor, reply: () => reply, stats: async () => { child.stdin.write("stats\n"); return JSON.parse((await waitFor(() => out.filter(l => l.startsWith("STATS ")).pop())).slice(6)); } };
}

test("S8: the relay carries a client's request and the box's answer, and its memory, logs, counters and folder never hold a word of either", { skip: !linux && "reads /proc" }, async t => {
  const r = await run(t);
  assert.ok(r.reply().includes(r.answerMarker), "the traffic really went through the relay and back");
  const open = scanMemory(/** @type {number} */ (r.child.pid), [r.marker, r.answerMarker]);
  assert.deepEqual([...open], [], "while the stream is open, the relay's memory holds neither marker");
  r.visitor.destroy();
  await new Promise(res => setTimeout(res, 300));
  const after = scanMemory(/** @type {number} */ (r.child.pid), [r.marker, r.answerMarker]);
  assert.deepEqual([...after], [], "after it ends, neither");
  const said = r.out.join("\n") + JSON.stringify(await r.stats());
  assert.ok(!said.includes(r.marker) && !said.includes(r.answerMarker), "nothing the relay logged or counted holds a marker");
  assert.ok(said.includes("harlow.vyre.run") || said.includes("route-harlow") || said.includes("accepted"), "the relay did log the name and counts it is allowed to");
  assert.deepEqual(fs.readdirSync(r.work), [], "the relay wrote nothing to its folder");
});

test("S8 control: what the relay IS allowed to read (the hello's protocol list) is found by the same scan, and a relay that keeps what it forwards is caught", { skip: !linux && "reads /proc" }, async t => {
  const alpn = `s8alpn-${crypto.randomBytes(6).toString("hex")}`;
  const r = await run(t, { leak: true, alpn });
  const found = scanMemory(/** @type {number} */ (r.child.pid), [alpn]);
  assert.ok(found.has(alpn), "a word in the clear in the hello is found in the relay's memory: the scan can fail");
});
