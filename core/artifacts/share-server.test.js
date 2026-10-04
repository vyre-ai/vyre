// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { tempHome } from "../../test/helpers.js";

const SCRIPT = path.join(import.meta.dirname, "share-server.js");

/** @param {any} t @param {string} dir */
async function serve(t, dir) {
  const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${dir}`, `--allow-fs-read=${SCRIPT}`, `--allow-fs-write=${dir}`, SCRIPT, "--dir", dir, "--port", "0", "--not-uid", "99999"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGTERM"));
  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", b => { out += b; const m = /listening (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.on("exit", c => reject(new Error(`exited ${c}`)));
  });
  return /** @type {number} */ (port);
}

/** @param {number} port @param {string} p @param {string} [method] */
const req = (port, p, method = "GET") => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port, path: p, method }, res => { let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body })); });
  r.on("error", reject);
  r.end();
});

test("share server: answers GET on /s/<token> only, from its own folder, under Node's permission model", async t => {
  const home = tempHome(t);
  const dir = path.join(home, "public");
  fs.mkdirSync(dir);
  const token = "Tok3nTok3nTok3nTok3nTok3";
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  fs.mkdirSync(path.join(dir, hash));
  fs.writeFileSync(path.join(dir, hash, "index.html"), "<p>Northwind Bakery menu</p>");
  fs.writeFileSync(path.join(dir, hash, "meta.json"), JSON.stringify({ expires_at: null, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "sandbox; default-src 'none'" } }));
  fs.writeFileSync(path.join(home, "secret.txt"), "not for the public");
  const port = await serve(t, dir);
  const ok = /** @type {any} */ (await req(port, `/s/${token}`));
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "<p>Northwind Bakery menu</p>");
  assert.equal(ok.headers["content-security-policy"], "sandbox; default-src 'none'");
  assert.equal(/** @type {any} */ (await req(port, `/s/${token}`, "POST")).status, 405);
  assert.equal(/** @type {any} */ (await req(port, `/s/${token}`, "HEAD")).status, 200);
  for (const p of ["/", "/s/", "/s/short", "/s/../secret.txt", `/s/${token}/../../secret.txt`, "/secret.txt", `/s/${hash}`]) {
    const r = /** @type {any} */ (await req(port, p));
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes("not for the public"));
  }
  assert.equal(fs.readFileSync(path.join(dir, hash, "views"), "utf8"), "1", "a GET is counted, a HEAD is not");
});
