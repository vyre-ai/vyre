// @ts-check
// The edge as it will run: relay/deploy/compose.yml built from this tree and started with Docker (read-only, no capabilities, no new privileges), a stand-in directory, and the box end in this
// process. A signer's TLS client reaches the box through the container's published ports. Proves the image carries every file the tunnel imports, the container runs as it is hardened, the
// ports in the compose file are the ones the relay opens, and a refused host or a suspended name is refused by the container (not only by the in-process relay of ingress.e2e.test.js).
// Skips itself unless VYRE_EDGE_LIVE=1. Run it on a test box with Docker: VYRE_EDGE_LIVE=1 node --test relay/deploy/edge.live.test.js
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { relayLink } from "../../core/relay/link.js";
import { keyPair } from "../../core/relay/noise.js";
import { newRouteKey, routeId } from "../../core/relay/wire.js";
import { createTunnelEnd } from "../../lib/publish/tunnel.js";
import { createGate } from "../../core/wink/control/gate.js";
import { selfSigned } from "../../core/wink/control/testing/selfsigned.js";

const LIVE = process.env.VYRE_EDGE_LIVE === "1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = "harlow.vyre.run", APP_HOST = "documents.harlow.vyre.run", LATE = "late.harlow.vyre.run", SECRET = "s".repeat(40);

/** @param {string[]} args @param {import("node:child_process").SpawnSyncOptions} [o] */
const sh = (args, o = {}) => spawnSync("docker", args, { encoding: "utf8", ...o });

test("the edge container carries a signer to a box, refuses what is not declared, and runs hardened", { skip: !LIVE, timeout: 600_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-live-"));
  // the directory, as the relay asks it: which route serves a host (a stand-in for the Worker at names.vyre.run)
  const k = newRouteKey(), route = routeId(k.pub);
  let suspended = false;
  /** @type {string[]} */ const asked = [];
  const directory = http.createServer((req, res) => {
    const u = new URL(String(req.url), "http://x");
    const h = String(u.searchParams.get("host"));
    if (u.pathname !== "/v1/tunnel/resolve" || req.headers["x-vyre-relay"] !== SECRET) { res.writeHead(401).end(); return; }
    asked.push(h);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ route: h === APP_HOST || (h === LATE && !suspended) ? route : null }));
  });
  await new Promise(r => directory.listen(0, "0.0.0.0", () => r(undefined))); t.after(() => directory.close());
  const dirPort = /** @type {any} */ (directory.address()).port;

  const override = path.join(dir, "override.yml");
  fs.writeFileSync(override, "services:\n  relay:\n    extra_hosts: [ \"host.docker.internal:host-gateway\" ]\n");
  const project = `vyre-edge-live-${process.pid}`;
  // fixed ports (found free now) so the edge can be restarted below and the box's link finds it where it was, as at a real address
  const free = () => new Promise(resolve => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => resolve(p)); }); });
  const [tlsP, httpP, ctlP] = [await free(), await free(), await free()];
  const env = { ...process.env, VYRE_RELAY_SECRET: SECRET, VYRE_TUNNEL_DIRECTORY: `http://host.docker.internal:${dirPort}`, EDGE_TLS_BIND: `127.0.0.1:${tlsP}`, EDGE_HTTP_BIND: `127.0.0.1:${httpP}`, EDGE_CONTROL_BIND: `127.0.0.1:${ctlP}` };
  const compose = (/** @type {string[]} */ ...a) => sh(["compose", "-p", project, "-f", path.join(HERE, "compose.yml"), "-f", override, ...a], { env });
  t.after(() => { compose("down", "-v", "--timeout", "3"); fs.rmSync(dir, { recursive: true, force: true }); });
  const up = compose("up", "-d", "--build", "relay");
  assert.equal(up.status, 0, up.stderr);
  const [control, tlsPort, httpPort] = [ctlP, tlsP, httpP];
  const published = ["8080", "9443", "9080"].map(inner => Number(/:(\d+)\s*$/m.exec(compose("port", "relay", inner).stdout)?.[1]));
  assert.deepEqual(published, [ctlP, tlsP, httpP], "the compose file publishes the control link, the passthrough and the redirect where it was told to");

  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) { try { healthy = (await fetch(`http://127.0.0.1:${control}/health`)).ok; } catch { await new Promise(r => setTimeout(r, 500)); } }
  assert.ok(healthy, "the relay answered on its control port");

  // hardening, as the compose file asks for it
  const inside = (/** @type {string} */ cmd) => compose("exec", "-T", "relay", "sh", "-c", cmd);
  assert.equal(inside("id -u").stdout.trim(), "1000", "not root");
  assert.notEqual(inside("touch /app/x").status, 0, "the image is read-only");
  assert.match(inside("grep CapEff /proc/1/status").stdout, /0000000000000000/, "no capabilities");
  assert.equal(inside("test -w /data").status, 0, "/data is the one place it writes");

  // the box end here: its gate holds the certificate, the container only carries bytes
  const { cert, key } = selfSigned({ ips: ["127.0.0.1"], names: [NAME, APP_HOST] });
  const front = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.statusCode = req.url === "/sign/abc" ? 200 : 404; res.end(req.url === "/sign/abc" ? "<h1>Sign here</h1>" : "no"); });
  await new Promise(r => front.listen(0, "127.0.0.1", () => r(undefined))); t.after(() => front.close());
  const gate = createGate({ listen: { host: "127.0.0.1", port: 0 }, tls: { cert, key }, upstream: { port: 9 },
    ingress: { hooks: () => null, share: () => null, appsSuffix: `.${NAME}`, apps: () => ({ port: /** @type {any} */ (front.address()).port, hosts: [APP_HOST] }) } });
  const at = await gate.listen(); t.after(() => gate.close());
  const end = createTunnelEnd({ name: NAME, port: () => at.port });
  const link = relayLink({ url: `http://127.0.0.1:${control}`, route, routeKey: k, boxKey: keyPair(), admit: async () => ({ v: 1 }), onchannel: () => {}, ontunnel: (s, v) => end.accept(s, v) });
  t.after(() => link.stop());
  assert.equal(await link.ready(), true, "the box's outbound link reached the container");

  const visit = (/** @type {string} */ host, /** @type {string} */ p) => new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port: tlsPort, ca: cert, servername: host, method: "GET", path: p, headers: { host }, timeout: 8000 }, res => {
      const ch = /** @type {Buffer[]} */ ([]); res.on("data", d => ch.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString() }));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout"))); req.end();
  });
  const ok = /** @type {any} */ (await visit(APP_HOST, "/sign/abc"));
  assert.equal(ok.status, 200); assert.match(ok.body, /Sign here/, "a signer reaches the page through the container, TLS ended on the box");
  assert.equal(/** @type {any} */ (await visit(APP_HOST, "/admin")).status, 404, "an unlisted path is the box's 404");

  // a name the directory does not know is closed at the container: no byte reaches the box
  const stranger = tls.connect({ host: "127.0.0.1", port: tlsPort, servername: "evil.vyre.run", rejectUnauthorized: false }); stranger.on("error", () => {});
  await new Promise(r => stranger.once("close", r));
  assert.ok(asked.includes("evil.vyre.run"), "the container asked the directory, and was told no");

  // port 80 is the fixed redirect, never the box
  const plain = await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: httpPort, path: "/x", headers: { host: APP_HOST }, timeout: 5000 }, res => { res.resume(); resolve({ status: res.statusCode, location: String(res.headers.location || "") }); }).on("error", reject));
  assert.ok([301, 308].includes(/** @type {any} */ (plain).status) && /^https:\/\//.test(/** @type {any} */ (plain).location), `port 80 redirects to https (${JSON.stringify(plain)})`);

  // the edge restarts (an update, a crash): the box's outbound link comes back by itself and a signer is served again, with nobody touching the box
  assert.equal(compose("restart", "-t", "2", "relay").status, 0);
  let served = null;
  for (let i = 0; i < 60 && !(served && /** @type {any} */ (served).status === 200); i++) {
    served = await new Promise(resolve => { const req = https.request({ host: "127.0.0.1", port: tlsP, ca: cert, servername: APP_HOST, method: "GET", path: "/sign/abc", headers: { host: APP_HOST }, timeout: 3000 }, res => { res.resume(); resolve({ status: res.statusCode }); }); req.on("error", () => resolve(null)); req.on("timeout", () => req.destroy()); req.end(); });
    if (!(served && /** @type {any} */ (served).status === 200)) await new Promise(r => setTimeout(r, 1000));
  }
  assert.equal(/** @type {any} */ (served) && /** @type {any} */ (served).status, 200, "after the edge restarted, the box reconnected and the signer is served");

  // a name suspended before its first visit is refused (the container keeps an answer for 60 s, so an already-visited name closes within a minute)
  suspended = true;
  const after = tls.connect({ host: "127.0.0.1", port: tlsPort, servername: LATE, rejectUnauthorized: false }); after.on("error", () => {});
  await new Promise(r => after.once("close", r));
  assert.ok(asked.includes(LATE), "and it asked the directory, which said no");
});
