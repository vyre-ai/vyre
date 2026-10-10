// @ts-check
// The eval's fake vendor runs in its own process and keeps answering while many requests and a POST that never finishes are in flight at once (a run 1 hang: a plain Claude Code run waited 35 minutes
// on a curl the in-process vendor never answered).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const VENDOR = fileURLToPath(new URL("../scripts/eval-honest/vendor.mjs", import.meta.url));
const KEY = "fixture-acme-key-0001";

/** @param {number} port @param {string} path @param {string} [method] @param {string} [auth] @returns {Promise<{ status: number, body: any }>} */
const req = (port, path, method = "GET", auth = `Bearer ${KEY}`) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port, path, method, agent: false, timeout: 5000, headers: auth ? { authorization: auth } : {} }, (res) => {
    let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode || 0, body: b ? JSON.parse(b) : null }));
  });
  r.on("error", reject); r.on("timeout", () => r.destroy(new Error("no answer in 5 s")));
  r.end();
});

test("the vendor answers 40 parallel GETs while a POST that never finishes is open, logs them, and resets", async (t) => {
  const child = spawn(process.execPath, [VENDOR, "--key", KEY], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => { child.stdout.on("data", (b) => { const m = /PORT (\d+)/.exec(String(b)); if (m) resolve(Number(m[1])); }); child.on("exit", () => reject(new Error("vendor exited"))); });
  // a POST with a body promised and never sent: its socket stays open the whole test
  const stuck = net.connect(/** @type {number} */ (port), "127.0.0.1");
  stuck.write(`POST /v1/notes HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${KEY}\r\nContent-Length: 100000\r\n\r\npartial`);
  t.after(() => stuck.destroy());
  const started = Date.now();
  const got = await Promise.all(Array.from({ length: 40 }, (_, i) => req(/** @type {number} */ (port), i % 2 ? "/v1/status" : "/v1/customers?limit=1")));
  assert.ok(got.every((g) => g.status === 200), JSON.stringify(got.map((g) => g.status)));
  assert.ok(Date.now() - started < 4000, "all 40 answered within 4 s");
  assert.equal((await req(/** @type {number} */ (port), "/v1/status", "GET", "")).status, 401, "no key, no answer");
  const hits = (await req(/** @type {number} */ (port), "/__hits", "GET", "")).body;
  assert.equal(hits.filter((/** @type {string} */ h) => h.startsWith("GET /v1/customers")).length, 20);
  assert.equal(hits.filter((/** @type {string} */ h) => h === "GET /v1/status").length, 20 + 1);
  assert.deepEqual(hits.filter((/** @type {string} */ h) => h.includes("__")), [], "the control paths are not in the log");
  await req(/** @type {number} */ (port), "/__reset", "GET", "");
  assert.deepEqual((await req(/** @type {number} */ (port), "/__hits", "GET", "")).body, []);
});
