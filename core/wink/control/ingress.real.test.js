// @ts-check
// Public ingress end to end over real sockets and the real programs: the TLS public gate (control/gate.js) in front of the REAL hooks listener (core/hooks/listener.js, with
// the real signature check) and the REAL share server (core/artifacts/share-server.js, a child process), reached over HTTPS the way the internet reaches the box.
// No Headscale, no ACME: a self-signed certificate the test trusts. Proves the shapes that get through, that the signature is checked at the home and not at the gate, and that
// the rest of the box's loopback is not reachable through the gate.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "../../../test/scratch.mjs";
import { listen } from "../../hooks/listener.js";
import { verify, sign } from "../../hooks/verify.js";
import { createGate } from "./gate.js";
import { selfSigned } from "./testing/selfsigned.js";

const SHARE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "artifacts", "share-server.js");
const TOKEN = "Zk3pQ9xLmW2vBn7RtYc4Hd_-8s";
const SECRET = "whsec_test_secret";

/** @param {number} port @param {string} ca @param {{ method?: string, path: string, headers?: any, body?: string }} q */
function call(port, ca, q) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, ca, servername: "localhost", method: q.method || "GET", path: q.path, headers: q.headers || {} }, res => {
      const ch = []; res.on("data", d => ch.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString(), headers: res.headers }));
    });
    req.on("error", reject); req.end(q.body);
  });
}

test("real: the public gate carries a signed webhook and a share link from the internet, and nothing else of the box", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ingress-"));
  const { cert, key } = selfSigned({ ips: ["127.0.0.1"], names: ["localhost"] });

  // the home: the real hooks listener, verifying at the home with the route's secret
  /** @type {{ route: string, ok: boolean, body: string }[]} */ const got = [];
  const hooks = await listen({ port: 0, now: Date.now, log: () => {}, open: n => n === "northwind-orders",
    accept: async (name, headers, body) => { const r = verify({ scheme: "hmac-sha256", header: "x-northwind-signature" }, headers, body, SECRET, Date.now()); got.push({ route: name, ok: Boolean(r && /** @type {any} */ (r).ok !== false), body: body.toString() }); return r && /** @type {any} */ (r).ok === false ? 401 : 202; } });
  t.after(() => hooks.close());

  // the home: the real share server as a child process, serving one published page
  const pub = path.join(dir, "public"); fs.mkdirSync(pub, { recursive: true });
  const hash = crypto.createHash("sha256").update(TOKEN).digest("hex");
  fs.mkdirSync(path.join(pub, hash)); fs.writeFileSync(path.join(pub, hash, "index.html"), "<h1>quarterly numbers</h1>"); fs.writeFileSync(path.join(pub, hash, "meta.json"), JSON.stringify({ headers: { "content-type": "text/html; charset=utf-8" } }));
  const sharePort = await new Promise(r => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, [SHARE, "--dir", pub, "--not-uid", "99999", "--port", String(sharePort)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("listening")) res(undefined); }); child.on("exit", c => rej(new Error("share server exited " + c))); setTimeout(() => rej(new Error("share server did not start")), 10_000).unref(); });

  // something else on the box's loopback that must stay unreachable through the gate
  /** @type {string[]} */ const other = [];
  const secretSvc = http.createServer((req, res) => { other.push(String(req.url)); res.end("secret"); });
  await new Promise(r => secretSvc.listen(0, "127.0.0.1", () => r(undefined))); t.after(() => secretSvc.close());

  const gate = createGate({ listen: { host: "127.0.0.1", port: 0 }, tls: { cert, key }, upstream: { port: /** @type {any} */ (secretSvc.address()).port }, ingress: { hooks: () => hooks.port, share: () => sharePort } });
  const at = await gate.listen(); t.after(() => gate.close());

  // a valid signature is checked at the home and accepted
  const body = JSON.stringify({ order: 1042 });
  const good = /** @type {any} */ (await call(at.port, cert, { method: "POST", path: "/hooks/northwind-orders", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-northwind-signature": sign("hmac-sha256", SECRET, body) }, body }));
  assert.equal(good.status, 202);
  // a wrong signature reaches the home too (the gate does not judge it) and the home refuses it
  const bad = /** @type {any} */ (await call(at.port, cert, { method: "POST", path: "/hooks/northwind-orders", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-northwind-signature": "sha256=" + "0".repeat(64) }, body }));
  assert.equal(bad.status, 401);
  assert.deepEqual(got.map(g => [g.route, g.ok]), [["northwind-orders", true], ["northwind-orders", false]]);
  // a route that is not open is the home's 404
  const closed = /** @type {any} */ (await call(at.port, cert, { method: "POST", path: "/hooks/other-route", headers: { "content-type": "application/json", "content-length": 2 }, body: "{}" }));
  assert.equal(closed.status, 404);

  // a public share link
  const page = /** @type {any} */ (await call(at.port, cert, { path: `/s/${TOKEN}` }));
  assert.equal(page.status, 200); assert.match(page.body, /quarterly numbers/);
  assert.equal(/** @type {any} */ (await call(at.port, cert, { path: "/s/AAAAAAAAAAAAAAAAAAAAAAAAAA" })).status, 404);

  // everything else of the box stays out of reach: the same refusal, and the other loopback service was never asked
  for (const p of ["/", "/health", "/key/../hooks/northwind-orders", "/api/v1/vault/list", "/v1/tools/vault.list", "/hooks", "/s", `/s/${TOKEN}/x`, "/.env", "/metrics"]) {
    const r = /** @type {any} */ (await call(at.port, cert, { path: p }));
    assert.ok(r.status === 404 || r.status === 400, `${p} answered ${r.status}`);
  }
  assert.deepEqual(other, [], "nothing else on the box's loopback was reached");
  assert.equal(got.length, 2, "no other delivery reached the hooks listener");
});
