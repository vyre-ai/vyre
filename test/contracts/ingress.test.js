// @ts-check
// Contract: public ingress (team/contracts/ingress.md, v2). The real relay, tunnel end and public gate over loopback sockets; the consumers' listeners are stand-ins that record what reached them.
// Consumers import `ingressFixtures` for their own tests: the names, hosts and exact request shapes the door lets through.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { createRelay } from "../../relay/node/server.js";
import { relayLink } from "../../core/relay/link.js";
import { keyPair } from "../../core/relay/noise.js";
import { newRouteKey, routeId } from "../../core/relay/wire.js";
import { createTunnelEnd } from "../../lib/publish/tunnel.js";
import { createGate, NOT_FOUND } from "../../core/wink/control/gate.js";
import { selfSigned } from "../../core/wink/control/testing/selfsigned.js";

export const ingressFixtures = Object.freeze({
  name: "harlow.vyre.run",
  appHost: "documents.harlow.vyre.run",
  /** A firm's own domain for an app's public pages (v2): the DNS record the person adds is the proof, the box holds its certificate. */
  ownHost: "sign.firm.example",
  shareToken: "AbCdEfGhIjKlMnOpQrStUv_-0123456789",
  /** The shapes at the bare name: [method, path, body, listener that gets it]. */
  shapes: Object.freeze([["GET", "/s/AbCdEfGhIjKlMnOpQrStUv_-0123456789", "", "share"], ["POST", "/hooks/northwind-orders", '{"a":1}', "hooks"], ["POST", "/vault-mcp", '{"x":1}', "vaultmcp"], ["POST", "/agents-mcp", '{"x":1}', "agentsmcp"]]),
  /** Requests at the bare name that reach nothing, whatever a consumer wishes. */
  refused: Object.freeze([["GET", "/"], ["GET", "/hooks/northwind-orders"], ["GET", "/s/AbCdEfGhIjKlMnOpQrStUv_-0123456789?x=1"], ["GET", "/agents-mcp"], ["GET", "/vault-mcp"], ["GET", "/api/v1/node"]]),
});
const F = ingressFixtures;

/** @param {number} port @param {string} ca @param {string} servername @param {string} host @param {string} method @param {string} path @param {string} [body] */
const visit = (port, ca, servername, host, method, path, body = "") => new Promise((resolve, reject) => {
  const req = https.request({ host: "127.0.0.1", port, ca, servername, method, path, headers: { host, ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}) }, timeout: 8000 }, res => {
    const ch = /** @type {Buffer[]} */ ([]); res.on("data", d => ch.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString() }));
  });
  req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout"))); if (body) req.write(body); req.end();
});

test("ingress contract: the declared shapes reach their own listener, everything else is the same refusal, and a stranger's host never reaches a box that did not declare it", async t => {
  const { cert, key } = selfSigned({ ips: ["127.0.0.1"], names: [F.name, F.appHost] });
  /** @type {{ who: string, method: string, url: string }[]} */ const seen = [];
  const listener = (/** @type {string} */ who) => { const s = http.createServer((q, r) => { q.resume(); seen.push({ who, method: String(q.method), url: String(q.url) }); r.setHeader("content-type", "text/plain"); r.end(who); }); return new Promise(res => s.listen(0, "127.0.0.1", () => { t.after(() => { s.close(); s.closeAllConnections(); }); res(/** @type {any} */ (s.address()).port); })); };
  const ports = { share: await listener("share"), hooks: await listener("hooks"), vaultmcp: await listener("vaultmcp"), agentsmcp: await listener("agentsmcp"), apps: await listener("apps"), upstream: await listener("upstream") };

  const gate = createGate({ listen: { host: "127.0.0.1", port: 0 }, tls: { cert, key }, upstream: { port: ports.upstream },
    ingress: { hooks: () => ports.hooks, share: () => ports.share, vaultmcp: () => ports.vaultmcp, agentsmcp: () => ports.agentsmcp, appsSuffix: `.${F.name}`, apps: () => ({ port: ports.apps, hosts: [F.appHost] }) } });
  const at = await gate.listen(); t.after(() => gate.close());

  const k = newRouteKey(), route = routeId(k.pub);
  const declared = new Set([F.name, F.appHost]);
  const relay = createRelay({ tunnel: { resolve: async h => (declared.has(h) ? { route } : null) } });
  const base = await relay.listen(); const { tls: tlsPort } = await relay.listenTunnel(); t.after(() => relay.close());
  const end = createTunnelEnd({ name: F.name, port: () => at.port });
  const link = relayLink({ url: base, route, routeKey: k, boxKey: keyPair(), admit: async () => ({ v: 1 }), onchannel: () => {}, ontunnel: (s, v) => end.accept(s, v) });
  t.after(() => link.stop());
  assert.equal(await link.ready(), true);

  for (const [method, path, body, who] of F.shapes) {
    const r = /** @type {any} */ (await visit(tlsPort, cert, F.name, F.name, method, path, body));
    assert.equal(r.status, 200, `${method} ${path}`);
    assert.equal(r.body, who, `${method} ${path} reached ${who}`);
  }
  const reached = seen.length;
  for (const [method, path] of F.refused) {
    const r = /** @type {any} */ (await visit(tlsPort, cert, F.name, F.name, method, path));
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.body, NOT_FOUND.toString().split("\r\n\r\n")[1], "the same bytes every time");
  }
  assert.equal(seen.length, reached, "a refused request reached no listener, and not Headscale");

  // an app host goes to the apps' front whatever the path (the front, not the door, decides which paths a stranger may see)
  assert.equal(/** @type {any} */ (await visit(tlsPort, cert, F.appHost, F.appHost, "GET", "/sign/abc")).body, "apps");
  // the Host header must be the SNI the relay routed on: another host riding a declared SNI is refused at the gate
  assert.equal(/** @type {any} */ (await visit(tlsPort, cert, F.appHost, F.name, "GET", "/")).status, 404);

  // a host the directory does not know: the relay closes it before any box is told
  for (let i = 0; i < 50 && relay.stats().conns; i++) await new Promise(r => setTimeout(r, 20));
  const before = relay.stats().conns;
  const s = tls.connect({ host: "127.0.0.1", port: tlsPort, servername: "other.harlow.vyre.run", rejectUnauthorized: false }); s.on("error", () => {});
  await new Promise(r => s.once("close", r));
  assert.equal(relay.stats().conns, before);
});

test("ingress contract v2: an own domain is an app host with its own certificate; the relay needs the directory's listing, the box needs to have named it, and the gate needs the certificate", async t => {
  const space = selfSigned({ ips: ["127.0.0.1"], names: [F.name, F.appHost] });
  const own = selfSigned({ ips: ["127.0.0.1"], names: [F.ownHost] });
  /** @type {string[]} */ const hostsSeen = [];
  const front = http.createServer((q, r) => { q.resume(); hostsSeen.push(String(q.headers.host)); r.end("apps"); });
  await new Promise(r => front.listen(0, "127.0.0.1", () => r(undefined))); t.after(() => front.close());
  const other = http.createServer((_q, r) => r.end("upstream"));
  await new Promise(r => other.listen(0, "127.0.0.1", () => r(undefined))); t.after(() => other.close());
  const gate = createGate({ listen: { host: "127.0.0.1", port: 0 }, tls: space, upstream: { port: /** @type {any} */ (other.address()).port },
    ingress: { hooks: () => null, share: () => null, appsSuffix: `.${F.name}`, apps: () => ({ port: /** @type {any} */ (front.address()).port, hosts: [F.appHost, F.ownHost] }) } });
  const at = await gate.listen(); t.after(() => gate.close());
  gate.setHostTls(F.ownHost, own);
  const k = newRouteKey(), route = routeId(k.pub);
  const relay = createRelay({ tunnel: { resolve: async h => (h === F.ownHost ? { route } : null) } });
  const base = await relay.listen(); const { tls: tlsPort } = await relay.listenTunnel(); t.after(() => relay.close());
  const end = createTunnelEnd({ name: F.name, own: () => [F.ownHost], port: () => at.port });
  const link = relayLink({ url: base, route, routeKey: k, boxKey: keyPair(), admit: async () => ({ v: 1 }), onchannel: () => {}, ontunnel: (s, v) => end.accept(s, v) });
  t.after(() => link.stop());
  assert.equal(await link.ready(), true);
  const r = /** @type {any} */ (await visit(tlsPort, own.cert, F.ownHost, F.ownHost, "GET", "/s/abc"));
  assert.deepEqual([r.status, r.body], [200, "apps"]);
  assert.deepEqual(hostsSeen, [F.ownHost], "the front answers by the Host it was given");
  assert.equal(/** @type {any} */ (await visit(tlsPort, own.cert, F.ownHost, F.name, "GET", "/")).status, 404, "another Host riding the own host's SNI is refused at the gate");
});
