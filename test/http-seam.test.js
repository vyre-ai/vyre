// @ts-check
// The loopback seam in lib/http.js (allowLoopbackForTests) is for test files only. Production code never imports it, nothing reads an environment variable or a setting for it, and a fresh process
// (a daemon is one) that has every plausible switch set still refuses a request to its own loopback.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { ROOT } from "./source-files.js";

test("only lib/http.js and test files mention the seam", () => {
  /** @type {string[]} */ let files = [];
  try { files = execFileSync("git", ["ls-files"], { cwd: ROOT, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n"); } catch { /* the test boxes run from a copied tree */ }
  if (files.length < 100) {
    files = [];
    const walk = (/** @type {string} */ dir) => { for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) { if (e.name === "node_modules" || e.name === ".git") continue; const r = path.join(dir, e.name); if (e.isDirectory()) walk(r); else files.push(r); } };
    walk("");
  }
  files = files.filter(f => /\.(js|mjs|cjs|ts)$/.test(f));
  const isTest = (/** @type {string} */ f) => /\.test\.|^test\/|\/testing\/|\/test\//.test(f);
  const users = files.filter(f => !isTest(f) && f !== "lib/http.js" && fs.readFileSync(path.join(ROOT, f), "utf8").includes("allowLoopbackForTests"));
  assert.deepEqual(users, [], "production code must not call the loopback test seam");
});

test("lib/http.js reads no environment variable and no setting to open the seam", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/http.js"), "utf8");
  assert.equal(/process\.env|\bconfig\b/.test(src.replace(/^\s*(\/\/|\*).*$/gm, "")), false);
});

test("a fresh process with every switch set still refuses loopback", async t => {
  const s = http.createServer((q, r) => r.end("secret")); await new Promise(r => s.listen(0, "127.0.0.1", () => r(null))); t.after(() => s.close());
  const port = /** @type {any} */ (s.address()).port;
  const code = `import { httpFetch } from ${JSON.stringify(path.join(ROOT, "lib/http.js"))};
    try { await httpFetch("http://127.0.0.1:${port}/", { retries: 0 }); console.log("REACHED"); } catch (e) { console.log("REFUSED " + e.code); }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, VYRE_ALLOW_LOOPBACK: "1", VYRE_TEST: "1", NODE_ENV: "test", ALLOW_LOOPBACK: "1", VYRE_LOOPBACK_FOR_TESTS: "1" }, encoding: "utf8" });
  assert.match(r.stdout, /REFUSED not_https/);
});
