// @ts-check
// The link's Tailscale calls under tests: never the user's real Tailscale, always the fake a
// test names in VYRE_TAILSCALE_BIN.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { tailscaleBin, whois, tailnetPeers, certNames, REAL_APP } from "./transport.js";

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** Run fn with these env vars set (undefined removes one), then put them back. */
async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

test("transport: under node --test the real Tailscale is never resolved without an opt-in", async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "this runs under node --test");
  await withEnv({ VYRE_TAILSCALE_BIN: undefined, VYRE_TEST_REAL_TAILSCALE: undefined }, async () => {
    assert.equal(tailscaleBin(), null);
    assert.notEqual(tailscaleBin(), REAL_APP);
    // Every caller degrades to "no tailscale here" rather than reaching for the real one.
    assert.equal(await whois("100.64.0.1"), null);
    assert.deepEqual(await tailnetPeers(), []);
  });
});

test("transport: VYRE_TAILSCALE_BIN is used for whois and status", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-ts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "tailscale");
  const whoisJson = JSON.stringify({ Node: { StableID: "nBOX", Name: "box.example.ts.net.", Tags: [] }, UserProfile: { LoginName: "owner@example.com" } });
  const statusJson = JSON.stringify({ Peer: { a: { ID: "nBOX", HostName: "box", DNSName: "box.example.ts.net.", Online: true, TailscaleIPs: ["100.64.0.2"] },
    b: { ID: "nOFF", HostName: "off", DNSName: "off.example.ts.net.", Online: false, TailscaleIPs: ["100.64.0.3"] } } });
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = whois ]; then echo '${whoisJson}'; else echo '${statusJson}'; fi\n`, { mode: 0o755 });
  await withEnv({ VYRE_TAILSCALE_BIN: bin }, async () => {
    assert.equal(tailscaleBin(), bin);
    assert.deepEqual(await whois("100.64.0.2"), { stableId: "nBOX", node: "box.example.ts.net", login: "owner@example.com", tagged: false });
    assert.deepEqual(await tailnetPeers(), [{ ip: "100.64.0.2", dns: "box.example.ts.net", stableId: "nBOX", host: "box" }]);
  });
});

test("transport: reading a peer's certificate names sends nothing on that connection", { skip: !hasOpenssl && "openssl is needed to make a certificate" }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-cert-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", path.join(dir, "k.pem"),
    "-out", path.join(dir, "c.pem"), "-subj", "/CN=box", "-addext", "subjectAltName=DNS:box.example.com,DNS:*.example.com", "-days", "1"], { stdio: "ignore" });
  let received = 0, connections = 0;
  // Application data only arrives decrypted on a TLS socket; count every byte of it. The TCP
  // connection is counted separately, so the test knows the probe really reached this server.
  const server = tls.createServer({ cert: fs.readFileSync(path.join(dir, "c.pem")), key: fs.readFileSync(path.join(dir, "k.pem")) }, socket => {
    socket.on("data", d => { received += d.length; });
    socket.on("error", () => {});
  });
  server.on("connection", () => { connections++; });
  server.on("tlsClientError", () => {});
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  const names = await certNames("127.0.0.1", "box.example.com", 3000, /** @type {any} */ (server.address()).port);
  assert.deepEqual(names, ["box.example.com"], "wildcards are left out");
  await new Promise(r => setTimeout(r, 100));
  assert.equal(connections, 1);
  assert.equal(received, 0, "no application data is ever written on the unverified connection");
});
