// @ts-check
// computerd's /fs routes on a temp home: the handler on a local server for the contract, and
// computerd itself, spawned with a fake token, for the bearer check, the wiring and the shield.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFs, TRASH } from "./fs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "fake-computerd-token-0123";

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "computerd-fs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs", "readme.md"), "# hello\n");
  fs.writeFileSync(path.join(dir, "todo.txt"), "0123456789");
  fs.mkdirSync(path.join(dir, ".ssh"));
  fs.writeFileSync(path.join(dir, ".ssh", "id_ed25519"), "secret");
  fs.writeFileSync(path.join(dir, "server.pem"), "secret");
  fs.mkdirSync(path.join(dir, ".config", "gcloud"), { recursive: true });
  return dir;
}

/** The handler alone, on 127.0.0.1. */
async function serve(t, root) {
  const handle = createFs({ root });
  const server = http.createServer((req, res) => { handle(req, res, new URL(req.url || "/", "http://computerd")); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }));
  return `http://127.0.0.1:${/** @type {net.AddressInfo} */ (server.address()).port}`;
}

/** @returns {Promise<{ status: number, headers: any, body: Buffer, json: any }>} */
function req(base, method, route, { headers = {}, body } = /** @type {any} */ ({})) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(route, base), { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers }, agent: false }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch {}
        resolve({ status: res.statusCode || 0, headers: res.headers, body: buf, json });
      });
    });
    r.on("error", reject);
    if (body !== undefined) r.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    else r.end();
  });
}

const q = p => encodeURIComponent(p);

test("fs: list hides the deny list and Glass's own files; stat answers", async t => {
  const dir = home(t);
  fs.mkdirSync(path.join(dir, TRASH));
  fs.writeFileSync(path.join(dir, ".vyre-upload-abc"), "x");
  const base = await serve(t, dir);
  const l = await req(base, "GET", "/fs/list?path=");
  assert.equal(l.status, 200);
  assert.deepEqual(l.json.entries.map(e => e.name), [".config", "docs", "todo.txt"]);
  assert.equal(l.json.truncated, false);
  const cfg = await req(base, "GET", "/fs/list?path=.config");
  assert.deepEqual(cfg.json.entries, [], "gcloud is denied at depth, so hidden");
  const s = await req(base, "GET", "/fs/stat?path=todo.txt");
  assert.equal(s.json.kind, "file");
  assert.equal(s.json.size, 10);
  assert.equal((await req(base, "GET", "/fs/stat?path=nope.txt")).status, 404);
});

test("fs: bad paths are 400, denied ones 403, and neither is cleaned up", async t => {
  const base = await serve(t, home(t));
  for (const p of ["/etc/passwd", "../x", "a/../b", "a\0b", "~/x"]) assert.equal((await req(base, "GET", `/fs/stat?path=${q(p)}`)).status, 400, p);
  for (const p of [".ssh", ".ssh/id_ed25519", "server.pem", "docs/.env", ".SSH", ".config/gcloud"]) {
    const r = await req(base, "GET", `/fs/read?path=${q(p)}`);
    assert.equal(r.status, 403, p);
    assert.equal(r.json.error.code, "denied");
  }
});

test("fs: symlinks resolve inside the root or not at all", async t => {
  const dir = home(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "computerd-out-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "x.txt"), "outside");
  fs.symlinkSync(outside, path.join(dir, "escape"));
  fs.symlinkSync(path.join(dir, ".ssh"), path.join(dir, "keys"));
  fs.symlinkSync(path.join(dir, "docs"), path.join(dir, "docs-link"));
  const base = await serve(t, dir);
  assert.equal((await req(base, "GET", "/fs/read?path=escape/x.txt")).status, 403);
  assert.equal((await req(base, "GET", "/fs/list?path=keys")).status, 403);
  assert.equal((await req(base, "GET", "/fs/read?path=docs-link/readme.md")).body.toString(), "# hello\n");
  const l = await req(base, "GET", "/fs/list?path=");
  const byName = Object.fromEntries(l.json.entries.map(e => [e.name, e]));
  assert.equal(byName.escape.kind, "link");
  assert.equal(byName.escape.to, null);
  assert.equal(byName["docs-link"].to, "dir");
  // A write through a link that leads out is refused, not followed.
  fs.symlinkSync(path.join(outside, "x.txt"), path.join(dir, "out.txt"));
  const w = await req(base, "PUT", "/fs/write?path=out.txt&overwrite=1&size=3", { body: "abc" });
  assert.equal(w.status, 403);
  assert.equal(fs.readFileSync(path.join(outside, "x.txt"), "utf8"), "outside");
});

test("fs: read honours one Range with 206, and 416 past the end", async t => {
  const base = await serve(t, home(t));
  const all = await req(base, "GET", "/fs/read?path=todo.txt");
  assert.equal(all.status, 200);
  assert.equal(all.headers["content-length"], "10");
  assert.equal(all.body.toString(), "0123456789");
  const part = await req(base, "GET", "/fs/read?path=todo.txt", { headers: { range: "bytes=2-4" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers["content-range"], "bytes 2-4/10");
  assert.equal(part.headers["content-length"], "3");
  assert.equal(part.body.toString(), "234");
  const tail = await req(base, "GET", "/fs/read?path=todo.txt", { headers: { range: "bytes=-3" } });
  assert.equal(tail.body.toString(), "789");
  const past = await req(base, "GET", "/fs/read?path=todo.txt", { headers: { range: "bytes=50-" } });
  assert.equal(past.status, 416);
  assert.equal(past.headers["content-range"], "bytes */10");
  assert.equal((await req(base, "GET", "/fs/read?path=docs")).status, 400);
});

test("fs: write streams to a temp file and renames only an exact size; 409 without overwrite", async t => {
  const dir = home(t);
  const base = await serve(t, dir);
  const ok = await req(base, "PUT", "/fs/write?path=docs/new.txt&overwrite=0&size=5", { body: "hello" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { size: 5 });
  assert.equal(fs.readFileSync(path.join(dir, "docs", "new.txt"), "utf8"), "hello");
  assert.equal((await req(base, "PUT", "/fs/write?path=docs/new.txt&overwrite=0&size=5", { body: "again" })).status, 409);
  assert.equal((await req(base, "PUT", "/fs/write?path=docs/new.txt&overwrite=1&size=5", { body: "again" })).status, 200);
  assert.equal(fs.readFileSync(path.join(dir, "docs", "new.txt"), "utf8"), "again");
  const short = await req(base, "PUT", "/fs/write?path=short.txt&overwrite=0&size=9", { body: "abc" });
  assert.equal(short.status, 400);
  assert.equal(short.json.error.code, "wrong_size");
  const long = await req(base, "PUT", "/fs/write?path=long.txt&overwrite=0&size=2", { body: "abcdef" }).catch(() => ({ status: "reset" }));
  assert.ok(long.status === 413 || long.status === "reset", String(long.status));
  assert.ok(!fs.existsSync(path.join(dir, "short.txt")) && !fs.existsSync(path.join(dir, "long.txt")));
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith(".vyre-upload-")), [], "a temp file was left behind");
  assert.equal((await req(base, "PUT", "/fs/write?path=id_rsa&overwrite=0&size=1", { body: "x" })).status, 403);
  assert.equal((await req(base, "PUT", "/fs/write?path=docs&overwrite=1&size=1", { body: "x" })).status, 409, "a folder is never replaced by a file");
  assert.equal((await req(base, "PUT", "/fs/write?path=x.txt&overwrite=0", { body: "x" })).status, 400, "size is required");
});

test("fs: move never replaces, mkdir makes one folder, trash moves into ~/.vyre-trash", async t => {
  const dir = home(t);
  const base = await serve(t, dir);
  assert.deepEqual((await req(base, "POST", "/fs/mkdir", { body: { path: "work" } })).json, { created: true });
  assert.equal((await req(base, "POST", "/fs/mkdir", { body: { path: "work" } })).status, 409);
  assert.equal((await req(base, "POST", "/fs/mkdir", { body: { path: ".ssh2/x" } })).status, 404);
  assert.deepEqual((await req(base, "POST", "/fs/move", { body: { from: "todo.txt", to: "work/todo.txt" } })).json, { moved: true });
  assert.ok(fs.existsSync(path.join(dir, "work", "todo.txt")));
  assert.equal((await req(base, "POST", "/fs/move", { body: { from: "docs/readme.md", to: "work/todo.txt" } })).status, 409);
  assert.equal((await req(base, "POST", "/fs/move", { body: { from: "docs/readme.md", to: ".env" } })).status, 403);
  assert.equal((await req(base, "POST", "/fs/move", { body: { from: "work", to: "work/inner" } })).status, 400);
  const tr = await req(base, "POST", "/fs/trash", { body: { path: "work/todo.txt" } });
  assert.equal(tr.status, 200);
  assert.match(tr.json.to, new RegExp(`^${TRASH.replace(".", "\\.")}/.+-todo\\.txt$`));
  assert.ok(fs.existsSync(path.join(dir, tr.json.to)));
  assert.equal((await req(base, "POST", "/fs/trash", { body: { path: "" } })).status, 400, "the home is never trashed");
  assert.equal((await req(base, "POST", "/fs/trash", { body: { path: tr.json.to } })).status, 400);
  // No error message carries the absolute home path.
  const miss = await req(base, "POST", "/fs/trash", { body: { path: "gone.txt" } });
  assert.equal(miss.status, 404);
  assert.ok(!miss.body.toString().includes(dir));
});

/** A free port on 127.0.0.1. */
async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {net.AddressInfo} */ (s.address()).port;
  await new Promise(r => s.close(() => r(undefined)));
  return port;
}

test("computerd: /fs is behind the bearer token, and the shield answers 423 on its eyes and hands", async t => {
  const dir = home(t);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(HERE, "index.js")], {
    env: { ...process.env, COMPUTERD_TOKEN: TOKEN, COMPUTERD_PORT: String(port), COMPUTERD_FS_ROOT: dir }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", d => { if (/listening/.test(String(d))) resolve(undefined); });
    child.once("exit", code => reject(new Error(`computerd exited ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const anon = await req(base, "GET", "/fs/list?path=", { headers: { authorization: "Bearer wrong" } });
  assert.equal(anon.status, 401);
  assert.ok(!anon.body.toString().includes(TOKEN));
  assert.equal((await req(base, "GET", "/fs/read?path=todo.txt")).body.toString(), "0123456789");

  assert.deepEqual((await req(base, "POST", "/shield", { body: { on: true } })).json, { shielded: true });
  for (const [m, r] of [["GET", "/tree"], ["GET", "/screenshot"], ["POST", "/act"], ["POST", "/input"]]) {
    const res = await req(base, m, r, { body: m === "POST" ? {} : undefined });
    assert.equal(res.status, 423, `${m} ${r}`);
    assert.equal(res.json.error.code, "shielded");
  }
  assert.equal((await req(base, "GET", "/fs/stat?path=todo.txt")).status, 200, "files are Glass's, and stay open to it");
  assert.equal((await req(base, "POST", "/shield", { headers: { authorization: "Bearer wrong" }, body: { on: false } })).status, 401);
  assert.deepEqual((await req(base, "POST", "/shield", { body: { on: false } })).json, { shielded: false });
  assert.notEqual((await req(base, "POST", "/act", { body: {} })).status, 423);
});
