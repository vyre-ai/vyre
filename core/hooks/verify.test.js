// @ts-check
// The three signature schemes on their own, and the Funnel status parser and its mismatches.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verify, sign, TOLERANCE_S } from "./verify.js";
import { parseFunnel, funnelNode, mismatches, openCommand, closeCommand, offCommand } from "./funnel.js";

const SECRET = "whsec_northwind_test_4f1a9c2e7b";
const BODY = Buffer.from(JSON.stringify({ order: 1041, customer: "alex@example.com", items: ["rye loaf"] }));
const NOW = Date.parse("2026-09-27T09:00:00Z");
const T = Math.floor(NOW / 1000);

test("hmac-sha256: hex over the raw body in the named header", () => {
  const route = { scheme: "hmac-sha256", header: "x-northwind-signature" };
  assert.deepEqual(verify(route, { "x-northwind-signature": sign("hmac-sha256", SECRET, BODY) }, BODY, SECRET, NOW), { ok: true });
  assert.deepEqual(verify(route, { "x-northwind-signature": sign("hmac-sha256", SECRET, BODY).toUpperCase() }, BODY, SECRET, NOW), { ok: true }, "hex is case-insensitive");
  assert.equal(verify(route, { "x-northwind-signature": sign("hmac-sha256", "another", BODY) }, BODY, SECRET, NOW).ok, false);
  assert.equal(verify(route, { "x-northwind-signature": sign("hmac-sha256", SECRET, BODY) }, Buffer.from(BODY.toString() + " "), SECRET, NOW).ok, false, "one byte more");
  assert.match(/** @type {any} */ (verify(route, {}, BODY, SECRET, NOW)).why, /no x-northwind-signature header/);
  assert.equal(verify(route, { "x-northwind-signature": "zz" }, BODY, SECRET, NOW).ok, false);
});

test("github: X-Hub-Signature-256 sha256=<hex>", () => {
  const route = { scheme: "github" };
  assert.deepEqual(verify(route, { "x-hub-signature-256": sign("github", SECRET, BODY) }, BODY, SECRET, NOW), { ok: true });
  assert.equal(verify(route, { "x-hub-signature-256": sign("hmac-sha256", SECRET, BODY) }, BODY, SECRET, NOW).ok, false, "bare hex without sha256=");
  assert.equal(verify(route, { "x-hub-signature-256": sign("github", "wrong", BODY) }, BODY, SECRET, NOW).ok, false);
  // The old SHA-1 header is not a signature this route reads.
  const sha1 = "sha1=" + crypto.createHmac("sha1", SECRET).update(BODY).digest("hex");
  assert.equal(verify(route, { "x-hub-signature": sha1 }, BODY, SECRET, NOW).ok, false);
});

test("stripe: t= and v1= over t.body, five minutes either way, and a replayed timestamp is refused", () => {
  const route = { scheme: "stripe" };
  assert.deepEqual(verify(route, { "stripe-signature": sign("stripe", SECRET, BODY, T) }, BODY, SECRET, NOW), { ok: true });
  assert.deepEqual(verify(route, { "stripe-signature": sign("stripe", SECRET, BODY, T - TOLERANCE_S) }, BODY, SECRET, NOW), { ok: true }, "at the edge");
  const old = /** @type {any} */ (verify(route, { "stripe-signature": sign("stripe", SECRET, BODY, T - TOLERANCE_S - 1) }, BODY, SECRET, NOW));
  assert.equal(old.ok, false);
  assert.match(old.why, /more than 5 minutes/);
  assert.equal(verify(route, { "stripe-signature": sign("stripe", SECRET, BODY, T + 400) }, BODY, SECRET, NOW).ok, false, "from the future");
  // A signature for one timestamp does not hold for another: the timestamp is signed.
  const v1 = sign("stripe", SECRET, BODY, T - 3600).split("v1=")[1];
  assert.equal(verify(route, { "stripe-signature": `t=${T},v1=${v1}` }, BODY, SECRET, NOW).ok, false);
  // Two v1 while a secret is rolled: either may match.
  const good = sign("stripe", SECRET, BODY, T).split("v1=")[1];
  assert.deepEqual(verify(route, { "stripe-signature": `t=${T},v1=${"0".repeat(64)},v1=${good},v0=abc` }, BODY, SECRET, NOW), { ok: true });
  assert.equal(verify(route, { "stripe-signature": `t=${T},t=${T},v1=${good}` }, BODY, SECRET, NOW).ok, false, "two timestamps");
  assert.equal(verify(route, { "stripe-signature": `v1=${good}` }, BODY, SECRET, NOW).ok, false, "no timestamp");
  assert.equal(verify(route, { "stripe-signature": `t=${T}` }, BODY, SECRET, NOW).ok, false, "no v1");
});

test("a refusal never carries the secret or the signature it expected", () => {
  const cases = [
    [{ scheme: "hmac-sha256", header: "x-sig" }, { "x-sig": "00" }],
    [{ scheme: "github" }, { "x-hub-signature-256": "sha256=" + "1".repeat(64) }],
    [{ scheme: "stripe" }, { "stripe-signature": `t=${T},v1=${"2".repeat(64)}` }],
    [{ scheme: "none" }, {}],
  ];
  for (const [route, headers] of cases) {
    const r = verify(route, headers, BODY, SECRET, NOW);
    const text = JSON.stringify(r);
    assert.equal(r.ok, false);
    assert.ok(!text.includes(SECRET), text);
    for (const s of ["hmac-sha256", "github"]) assert.ok(!text.includes(sign(s, SECRET, BODY).replace("sha256=", "")), text);
    assert.ok(!text.includes(sign("stripe", SECRET, BODY, T).split("v1=")[1]), text);
  }
  assert.equal(verify({ scheme: "github" }, { "x-hub-signature-256": sign("github", "", BODY) }, BODY, "", NOW).ok, false, "an empty secret checks nothing");
});

// ---- funnel -------------------------------------------------------------------------------

const HOST = "vyre.tail0000.ts.net";
const served = (paths, { port = 8443, funnel = true, target = p => `http://127.0.0.1:7310${p}` } = {}) => ({
  TCP: { [port]: { HTTPS: true } },
  Web: { [`${HOST}:${port}`]: { Handlers: Object.fromEntries(paths.map(p => [p, { Proxy: target(p) }])) } },
  ...(funnel ? { AllowFunnel: { [`${HOST}:${port}`]: true } } : {}),
});

test("funnel status: handlers, which are public, foreground sessions and raw TCP", () => {
  assert.deepEqual(parseFunnel({}), []);
  assert.deepEqual(parseFunnel(served(["/hooks/northwind-orders"])), [{ host: HOST, port: 8443, path: "/hooks/northwind-orders", kind: "proxy", target: "http://127.0.0.1:7310/hooks/northwind-orders", funnel: true }]);
  assert.equal(parseFunnel(served(["/hooks/a"], { funnel: false }))[0].funnel, false, "served on the tailnet only");
  const fg = parseFunnel({ Foreground: { s1: served(["/"], { port: 10000, target: () => "http://127.0.0.1:3000" }) } });
  assert.deepEqual(fg.map(s => [s.path, s.port, s.funnel]), [["/", 10000, true]]);
  const tcp = parseFunnel({ TCP: { 10000: { TCPForward: "127.0.0.1:22" } }, AllowFunnel: { [`${HOST}:10000`]: true } });
  assert.deepEqual(tcp, [{ host: "", port: 10000, path: "", kind: "tcp", target: "127.0.0.1:22", funnel: true }]);
});

test("funnel node: the funnel and https attributes and the allowed ports from CapMap", () => {
  const st = { Self: { DNSName: `${HOST}.`, CapMap: { funnel: null, https: null, "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000": null } } };
  assert.deepEqual(funnelNode(st), { dnsName: HOST, funnel: true, https: true, ports: [443, 8443, 10000] });
  assert.deepEqual(funnelNode({ Self: { DNSName: `${HOST}.`, CapMap: {} } }), { dnsName: HOST, funnel: false, https: false, ports: null });
});

test("funnel mismatches: a route not served, a path with no route, the wrong target, 443, and anything else public", () => {
  const hooks = { port: 7310, enabled: true };
  assert.deepEqual(mismatches(["northwind-orders"], parseFunnel(served(["/hooks/northwind-orders"])), hooks), []);
  const none = mismatches(["northwind-orders"], [], hooks);
  assert.equal(none[0].kind, "route-not-served");
  assert.equal(none[0].fix, openCommand("northwind-orders", 7310));
  // Served only on the tailnet is not published.
  assert.equal(mismatches(["northwind-orders"], parseFunnel(served(["/hooks/northwind-orders"], { funnel: false })), hooks)[0].kind, "route-not-served");
  const stale = mismatches([], parseFunnel(served(["/hooks/harlow-forms"])), hooks);
  assert.deepEqual(stale.map(m => [m.kind, m.route, m.harmless]), [["funnel-without-route", "harlow-forms", true]]);
  assert.match(stale[0].message, /404/);
  assert.equal(stale[0].fix, closeCommand("harlow-forms"));
  const wrong = mismatches(["northwind-orders"], parseFunnel(served(["/hooks/northwind-orders"], { target: () => "http://127.0.0.1:9999/" })), hooks);
  assert.equal(wrong[0].kind, "wrong-target");
  const on443 = mismatches(["northwind-orders"], parseFunnel(served(["/hooks/northwind-orders"], { port: 443 })), hooks).map(m => m.kind);
  assert.ok(on443.includes("funnel-on-443") && on443.includes("wrong-target"), on443.join());
  assert.equal(mismatches([], parseFunnel(served(["/"], { port: 10000, target: () => "http://127.0.0.1:3000" })), hooks)[0].kind, "funnel-other");
  assert.ok(mismatches(["northwind-orders"], parseFunnel(served(["/hooks/northwind-orders"])), { port: 7310, enabled: false }).some(m => m.kind === "listener-off"));
});

test("funnel commands: 8443, never 443, a path per route, and the close and off lines", () => {
  assert.equal(openCommand("northwind-orders", 7310), "tailscale funnel --bg --https=8443 --set-path=/hooks/northwind-orders http://127.0.0.1:7310/hooks/northwind-orders");
  assert.equal(closeCommand("northwind-orders"), "tailscale funnel --https=8443 --set-path=/hooks/northwind-orders off");
  assert.equal(offCommand(), "tailscale funnel --https=8443 off");
});
