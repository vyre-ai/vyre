// @ts-check
// The public gate against a real ACME server (Pebble, Let's Encrypt's test CA) and the real gate: a real DNS-01 order, a real TLS listener, a real renewal that keeps the pin.
// Skipped unless VYRE_PEBBLE=1. On a test box:
//   docker network create net-g; docker run -d --name net-g-chall --network net-g -p 127.0.0.1:8055:8055 ghcr.io/letsencrypt/pebble-challtestsrv -http01 "" -https01 "" -tlsalpn01 ""
//   docker run -d --name net-g-pebble --network net-g -p 127.0.0.1:14000:14000 -p 127.0.0.1:15000:15000 -e PEBBLE_VA_NOSLEEP=1 ghcr.io/letsencrypt/pebble -config /test/config/pebble-config.json -dnsserver net-g-chall:8053
//   docker cp net-g-pebble:/test/certs/pebble.minica.pem ./minica.pem
//   VYRE_PEBBLE=1 NODE_EXTRA_CA_CERTS=$PWD/minica.pem node --test core/wink/control/publicgate.real.test.js
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { SCRATCH } from "../../../test/scratch.mjs";
import { createPublicGate } from "./publicgate.js";
import { certPin } from "./gate.js";

const skip = process.env.VYRE_PEBBLE !== "1" ? "set VYRE_PEBBLE=1 with a Pebble on 127.0.0.1:14000 to run" : false;
const CHALL = process.env.VYRE_CHALLTESTSRV || "http://127.0.0.1:8055";

/** Look at the certificate a TLS listener serves for `host`, trusting `ca`. @param {number} port @param {string} host @param {string} ca @param {string} [urlPath] */
function get(port, host, ca, urlPath = "/key") {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, servername: host, path: urlPath, method: "GET", ca, headers: { host } }, res => {
      let b = ""; res.on("data", d => { b += d; }); res.on("end", () => resolve({ status: res.statusCode, body: b, cert: /** @type {any} */ (res.socket).getPeerCertificate() }));
    });
    req.on("error", reject); req.end();
  });
}

test("real: a certificate by DNS-01 from Pebble, a TLS gate in front of an upstream, and a renewal that keeps the pin", { skip, timeout: 120_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "pubgate-real-"));
  // the upstream the gate fronts: answers GET /key like a Headscale
  const up = http.createServer((req, res) => { res.end(req.url === "/key" ? '{"publicKey":"mkey:fake"}' : "no"); });
  await new Promise(r => up.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => up.close());
  const upPort = /** @type {any} */ (up.address()).port;
  // the directory stand-in: the challenge value goes to Pebble's DNS (what the hosted directory does in the vyre.run zone)
  const set = [];
  const directory = {
    async acme(/** @type {string} */ name, /** @type {string} */ value) { set.push(name); const r = await fetch(`${CHALL}/set-txt`, { method: "POST", body: JSON.stringify({ host: `_acme-challenge.${name}.vyre.run.`, value }) }); assert.equal(r.status, 200); },
    async acmeClear(/** @type {string} */ name) { await fetch(`${CHALL}/clear-txt`, { method: "POST", body: JSON.stringify({ host: `_acme-challenge.${name}.vyre.run.` }) }); },
    async publish() {},
  };
  const roots = await (await fetch("https://127.0.0.1:15000/roots/0")).text();
  const mk = (/** @type {any} */ extra = {}) => createPublicGate({ name: () => "alex", dir, directory, upstream: { port: upPort }, listen: { host: "127.0.0.1", port: 0 }, acme: "https://127.0.0.1:14000/dir", log: m => console.log(m), ...extra });

  const g = mk();
  const s = await g.start();
  assert.equal(s.state, "up", String(s.why));
  assert.deepEqual(set, ["alex"], "the challenge went through the directory");
  const port = /** @type {number} */ (g.port());
  const r1 = /** @type {any} */ (await get(port, "alex.vyre.run", roots));
  assert.equal(r1.status, 200);
  assert.match(r1.body, /mkey:fake/, "GET /key reaches the upstream through TLS");
  assert.equal(certPin(r1.cert.raw), g.pin(), "the pin is the SPKI of the served certificate");
  const serial1 = r1.cert.serialNumber, pin1 = g.pin();
  // anything else is the gate's one refusal
  assert.equal(/** @type {any} */ (await get(port, "alex.vyre.run", roots, "/api/v1/user")).status, 404);
  await g.stop();

  // a renewal: the same key (so the same pin), a new certificate, served by a gate that starts from the stored one
  const g2 = mk({ renewDays: 100_000 });
  const s2 = await g2.start();
  assert.equal(s2.state, "up", String(s2.why));
  const r2 = /** @type {any} */ (await get(/** @type {number} */ (g2.port()), "alex.vyre.run", roots));
  assert.notEqual(r2.cert.serialNumber, serial1, "a new certificate");
  assert.equal(g2.pin(), pin1, "the same pin");
  await g2.stop();
});
