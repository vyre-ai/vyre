// @ts-check
// Public ingress end to end over real sockets, loopback only: a visitor's TLS client -> the Node relay's passthrough front (SNI only) -> the box's outbound link
// (core/relay/link.js) -> the tunnel end (lib/publish/tunnel.js) -> the box's public gate (core/wink/control/gate.js, the certificate is the box's) -> the apps' front.
// Proves: the relay never holds a certificate or reads a byte past the hello; a declared host reaches the dressed page; an undeclared SNI is refused at the relay before any
// box is told; an unlisted path is 404 at the box; the suspend switch stops a name at the next visitor.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { createRelay } from "./server.js";
import { relayLink } from "../../core/relay/link.js";
import { keyPair } from "../../core/relay/noise.js";
import { newRouteKey, routeId } from "../../core/relay/wire.js";
import { createTunnelEnd } from "../../lib/publish/tunnel.js";
import { createGate } from "../../core/wink/control/gate.js";
import { selfSigned } from "../../core/wink/control/testing/selfsigned.js";

const NAME = "harlow.vyre.run", APP_HOST = "documents.harlow.vyre.run";

/** @param {number} port @param {string} ca @param {string} host @param {string} path */
const visit = (port, ca, host, path) => new Promise((resolve, reject) => {
  const req = https.request({ host: "127.0.0.1", port, ca, servername: host, method: "GET", path, headers: { host }, timeout: 8000 }, res => {
    const ch = /** @type {Buffer[]} */ ([]); res.on("data", d => ch.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString() }));
  });
  req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout"))); req.end();
});

test("ingress: a signer outside reaches the dressed signing page through the relay, TLS ends on the box, and everything undeclared is refused", async t => {
  const { cert, key } = selfSigned({ ips: ["127.0.0.1"], names: [NAME, APP_HOST] });

  // the apps' front: one public route; the rest is 404 (paths are filtered here, on the box)
  /** @type {string[]} */ const seenPaths = [];
  const front = http.createServer((req, res) => { seenPaths.push(String(req.url)); if (req.url === "/sign/abc") { res.setHeader("content-type", "text/html"); res.end("<h1>Sign here</h1>"); } else { res.statusCode = 404; res.end("no"); } });
  await new Promise(r => front.listen(0, "127.0.0.1", () => r(undefined))); t.after(() => front.close());
  const other = http.createServer((_q, res) => res.end("private"));
  await new Promise(r => other.listen(0, "127.0.0.1", () => r(undefined))); t.after(() => other.close());

  const gate = createGate({ listen: { host: "127.0.0.1", port: 0 }, tls: { cert, key }, upstream: { port: /** @type {any} */ (other.address()).port },
    ingress: { hooks: () => null, share: () => null, appsSuffix: `.${NAME}`, apps: () => ({ port: /** @type {any} */ (front.address()).port, hosts: [APP_HOST] }) } });
  const at = await gate.listen(); t.after(() => gate.close());

  // the directory's answer, as names/worker resolves it: declared hosts only, with a suspend switch
  const k = newRouteKey(), route = routeId(k.pub);
  const declared = new Set([APP_HOST]); let suspended = false;
  /** @type {string[]} */ const asked = [];
  const relay = createRelay({ tunnel: { resolve: async h => { asked.push(h); return declared.has(h) && !suspended ? { route } : null; } } });
  const base = await relay.listen(); const { tls: tlsPort } = await relay.listenTunnel(); t.after(() => relay.close());

  const end = createTunnelEnd({ name: NAME, port: () => at.port });
  const link = relayLink({ url: base, route, routeKey: k, boxKey: keyPair(), admit: async () => ({ v: 1 }), onchannel: () => {}, ontunnel: (s, v) => end.accept(s, v) });
  t.after(() => link.stop());
  assert.equal(await link.ready(), true);

  // the signer on a phone network: a plain TLS client with the app host as SNI
  const ok = /** @type {any} */ (await visit(tlsPort, cert, APP_HOST, "/sign/abc"));
  assert.equal(ok.status, 200);
  assert.match(ok.body, /Sign here/);

  // an unlisted path is refused on the box, and nothing else of the box's loopback is reachable
  assert.equal(/** @type {any} */ (await visit(tlsPort, cert, APP_HOST, "/admin")).status, 404);
  assert.ok(!seenPaths.includes("/admin"), "the apps' front never saw the unlisted path");

  // a host the box did not declare is refused at the relay: no box is told, no byte goes down
  const before = relay.stats().conns;
  const stranger = tls.connect({ host: "127.0.0.1", port: tlsPort, servername: "evil.vyre.run", rejectUnauthorized: false }); stranger.on("error", () => {});
  await new Promise(r => stranger.once("close", r));
  const bare = tls.connect({ host: "127.0.0.1", port: tlsPort, servername: NAME, rejectUnauthorized: false }); bare.on("error", () => {}); // the name itself is not declared (no share)
  await new Promise(r => bare.once("close", r));
  assert.equal(relay.stats().conns, before);
  assert.ok(asked.includes("evil.vyre.run") && asked.includes(NAME));

  // suspend: the next visitor is refused, with no restart
  suspended = true;
  const v = tls.connect({ host: "127.0.0.1", port: tlsPort, servername: APP_HOST, rejectUnauthorized: false }); v.on("error", () => {});
  await new Promise(r => v.once("close", r));
  suspended = false;
  assert.equal(/** @type {any} */ (await visit(tlsPort, cert, APP_HOST, "/sign/abc")).status, 200, "and lifted, it serves again");
});
