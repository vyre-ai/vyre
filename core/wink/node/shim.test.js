// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { SCRATCH } from "../../../test/scratch.mjs";
import { startShim, spkiPin, parsePin } from "./shim.js";

let haveOpenssl = true;
try { execFileSync("openssl", ["version"], { stdio: "ignore" }); } catch { haveOpenssl = false; }
const skip = haveOpenssl ? false : "openssl is not installed";

/** A fresh self-signed certificate for localhost, no authority behind it. */
function makeCert(/** @type {string} */ dir, /** @type {string} */ name) {
  const key = path.join(dir, name + ".key"), crt = path.join(dir, name + ".crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", crt, "-days", "2",
    "-subj", "/CN=control.example", "-addext", "subjectAltName=DNS:localhost,DNS:control.example,IP:127.0.0.1"], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt), crtPath: crt };
}

/** An upstream "control server": records every request that reaches it and what Host it saw. */
async function upstream(/** @type {{ key: Buffer, cert: Buffer }} */ c, /** @type {any} */ behave = {}) {
  const seen = /** @type {{ method: string, url: string, host: string }[]} */ ([]);
  const server = https.createServer({ key: c.key, cert: c.cert }, (req, res) => {
    seen.push({ method: req.method || "", url: req.url || "", host: String(req.headers.host) });
    if (behave.redirect) { res.writeHead(302, { location: "https://evil.example/" }); return res.end(); }
    res.writeHead(200, { "content-type": "text/plain" }); res.end("key:" + req.url);
  });
  server.on("upgrade", (req, sock) => {
    seen.push({ method: req.method || "", url: req.url || "", host: String(req.headers.host) });
    if (behave.noUpgrade) { sock.end("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n"); return; }
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${req.headers.upgrade}\r\nConnection: Upgrade\r\n\r\n`);
    sock.on("data", d => sock.write(Buffer.concat([Buffer.from("echo:"), d])));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  return { seen, port, url: `https://127.0.0.1:${port}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }) };
}

function get(/** @type {string} */ base, /** @type {string} */ p, /** @type {string} */ method = "GET") {
  return new Promise((resolve, reject) => {
    const r = http.request(base + p, { method, agent: false }, res => { let b = ""; res.on("data", d => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    r.on("error", reject); r.end();
  });
}

function upgrade(/** @type {number} */ port, /** @type {string} */ p, /** @type {string} */ proto) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: ${proto}\r\n\r\n`));
    let buf = "";
    s.on("data", d => { buf += d; if (buf.includes("\r\n\r\n") && !buf.includes("hello")) { if (buf.startsWith("HTTP/1.1 101")) s.write("hello"); else { s.destroy(); resolve(buf); } } if (buf.includes("echo:hello")) { s.destroy(); resolve(buf); } });
    s.on("error", reject); setTimeout(() => { s.destroy(); resolve(buf); }, 3000);
  });
}

test("shim: a server with the pinned key passes, with no authority anywhere; Host is rewritten", { skip }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "shim-"));
  const c = makeCert(dir, "a");
  const up = await upstream(c);
  const events = /** @type {any[]} */ ([]);
  const shim = await startShim({ upstream: up.url, pin: spkiPin(c.cert), onEvent: e => events.push(e) });
  t.after(async () => { await shim.close(); await up.close(); });
  assert.match(shim.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const r = /** @type {any} */ (await get(shim.url, "/key?v=130"));
  assert.deepEqual(events, []);
  assert.deepEqual([r.status, r.body], [200, "key:/key?v=130"]);
  assert.equal(up.seen[0].host, `127.0.0.1:${up.port}`);
  assert.deepEqual(events, []);
});

test("shim: another certificate for the same name is refused, and nothing reaches the server", { skip }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "shim-"));
  const real = makeCert(dir, "real"), impostor = makeCert(dir, "impostor");
  const up = await upstream(impostor);
  const events = /** @type {any[]} */ ([]);
  const shim = await startShim({ upstream: up.url, pin: spkiPin(real.cert), onEvent: e => events.push(e) });
  t.after(async () => { await shim.close(); await up.close(); });
  const r = /** @type {any} */ (await get(shim.url, "/key"));
  assert.equal(r.status, 502);
  assert.equal(up.seen.length, 0, "no request bytes reach an unpinned server");
  assert.equal(events[0].type, "pin-mismatch");
  assert.equal(shim.stats.pinMismatch, 1);
  // the upgrade path is pinned too
  const u = /** @type {string} */ (await upgrade(shim.port, "/ts2021", "tailscale-control-protocol"));
  assert.ok(!u.startsWith("HTTP/1.1 101"));
  assert.equal(up.seen.length, 0);
});

test("shim: no fallback to system CAs, even when the server's certificate IS system-trusted", { skip }, async t => {
  // A child process trusts certificate A through NODE_EXTRA_CA_CERTS (its system store). The shim, pinned to
  // another key, must still refuse A, though a plain https request to A succeeds in the same process.
  const dir = fs.mkdtempSync(path.join(SCRATCH, "shim-"));
  const a = makeCert(dir, "trusted"), b = makeCert(dir, "other");
  const script = `
    import https from "node:https"; import http from "node:http";
    import fs from "node:fs";
    import { startShim } from ${JSON.stringify(path.resolve(import.meta.dirname, "shim.js"))};
    const srv = https.createServer({ key: fs.readFileSync(${JSON.stringify(path.join(dir, "trusted.key"))}), cert: fs.readFileSync(${JSON.stringify(a.crtPath)}) }, (q, s) => s.end("ok"));
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const direct = await new Promise(res => https.get({ host: "localhost", port, agent: false }, r => res(r.statusCode)).on("error", e => res("err:" + e.code)));
    const shim = await startShim({ upstream: "https://127.0.0.1:" + port, pin: ${JSON.stringify(spkiPin(b.cert))} });
    const viaShim = await new Promise(res => http.get(shim.url + "/key", { agent: false }, r => res(r.statusCode)).on("error", e => res("err:" + e.code)));
    console.log(JSON.stringify({ direct, viaShim }));
    await shim.close(); srv.closeAllConnections(); srv.close();`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: a.crtPath }, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop() || "{}"), { direct: 200, viaShim: 502 });
});

test("shim: the control upgrade and the DERP upgrade carry bytes both ways; other upgrades are refused", { skip }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "shim-"));
  const c = makeCert(dir, "a");
  const up = await upstream(c);
  const shim = await startShim({ upstream: up.url, pin: spkiPin(c.cert) });
  t.after(async () => { await shim.close(); await up.close(); });
  for (const [p, proto] of [["/ts2021", "tailscale-control-protocol"], ["/derp", "DERP"]]) {
    const out = /** @type {string} */ (await upgrade(shim.port, p, proto));
    assert.ok(out.startsWith("HTTP/1.1 101"), p);
    assert.ok(out.includes("echo:hello"), p);
  }
  assert.ok(up.seen.every(s => s.host === `127.0.0.1:${up.port}`));
  const n = up.seen.length;
  assert.ok(/** @type {string} */ (await upgrade(shim.port, "/ts2021", "websocket")).startsWith("HTTP/1.1 403"));
  assert.ok(/** @type {string} */ (await upgrade(shim.port, "/other", "DERP")).startsWith("HTTP/1.1 403"));
  assert.equal(up.seen.length, n);
});

test("shim: refuses other paths and methods, absolute URLs, and any upstream redirect", { skip }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "shim-"));
  const c = makeCert(dir, "a");
  const up = await upstream(c, { redirect: true });
  const events = /** @type {any[]} */ ([]);
  const shim = await startShim({ upstream: up.url, pin: spkiPin(c.cert), onEvent: e => events.push(e) });
  t.after(async () => { await shim.close(); await up.close(); });
  assert.equal(/** @type {any} */ (await get(shim.url, "/admin")).status, 403);
  assert.equal(/** @type {any} */ (await get(shim.url, "/key", "POST")).status, 405);
  assert.equal(/** @type {any} */ (await get(shim.url, "//evil.example/key")).status, 403);
  assert.equal(up.seen.length, 0);
  // a redirect from the server is never passed on
  const r = /** @type {any} */ (await get(shim.url, "/key"));
  assert.equal(r.status, 502);
  assert.ok(events.some(e => e.type === "refused" && /redirect/.test(e.why)));
  // an upgrade answered with anything but 101 is refused
  const up2 = await upstream(c, { noUpgrade: true });
  const shim2 = await startShim({ upstream: up2.url, pin: spkiPin(c.cert) });
  t.after(async () => { await shim2.close(); await up2.close(); });
  assert.ok(/** @type {string} */ (await upgrade(shim2.port, "/ts2021", "tailscale-control-protocol")).startsWith("HTTP/1.1 502"));
});

test("shim: a pin is required and the upstream must be a bare https host", async () => {
  await assert.rejects(startShim({ upstream: "https://127.0.0.1:1", pin: /** @type {any} */ (undefined) }), /pin/);
  await assert.rejects(startShim({ upstream: "https://127.0.0.1:1", pin: "nothex" }), /pin must be/);
  await assert.rejects(startShim({ upstream: "http://127.0.0.1:1", pin: "00".repeat(32) }), /https/);
  await assert.rejects(startShim({ upstream: "https://127.0.0.1:1/path", pin: "00".repeat(32) }), /bare host/);
  assert.equal(parsePin("ab".repeat(32)).length, 32);
  assert.equal(parsePin("sha256/" + Buffer.alloc(32, 7).toString("base64")).length, 32);
});
