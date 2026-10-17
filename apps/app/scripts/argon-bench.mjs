#!/usr/bin/env node
// argon-bench: how long the master password's Argon2id takes in a page, at kernel/identity/master.js MASTER_KDF (64 MiB, 3 passes, one lane), with @noble/hashes' argon2idAsync (what the app uses).
// Run in headless Chromium, once at full speed and once with the CPU throttled 4x and 6x (a mid-range and a low-end phone are about that far behind a CI core). Prints one line per run; exits 0.
// The lead's line: over about 3 seconds on a mid-range phone means hash-wasm (WASM Argon2id, one pinned version) for that function only.
//
//   PW_FROM=<a folder with playwright installed>/ node apps/app/scripts/argon-bench.mjs   (run from the repo root, after `npm ci` in apps/app)
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const nm = path.resolve(here, "..", "node_modules");
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");
const TYPES = { ".js": "text/javascript", ".html": "text/html" };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><title>bench</title>"); }
  const f = path.join(nm, u.replace(/^\/nm\//, ""));
  if (!u.startsWith("/nm/") || !f.startsWith(nm) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--use-mock-keychain", "--password-store=basic"] });
for (const rate of [1, 4, 6]) {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await page.goto(base);
  const ms = await page.evaluate(async (b) => {
    const { argon2idAsync } = await import(`${b}/nm/@noble/hashes/argon2.js`);
    const t0 = performance.now();
    let ticks = 0, last = performance.now(), worst = 0;
    const timer = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; ticks++; }, 50);
    await argon2idAsync(new TextEncoder().encode("correct horse battery staple"), new Uint8Array(16), { t: 3, m: 65536, p: 1, dkLen: 32, asyncTick: 20 });
    clearInterval(timer);
    return { total: Math.round(performance.now() - t0), longestFreezeMs: Math.round(worst) };
  }, base);
  console.log(`argon2id 64 MiB x3, cpu throttle ${rate}x: ${(ms.total / 1000).toFixed(1)} s, longest page freeze ${ms.longestFreezeMs} ms`);
  await page.close();
}
await browser.close();
server.close();
