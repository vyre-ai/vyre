// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../../test/scratch.mjs";
import { createPublicGate } from "./publicgate.js";
import * as certsReal from "../../../lib/acme/certs.js";
import * as acmeReal from "../../../lib/acme/acme.js";
import { certPin } from "./gate.js";

const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "pubgate-"));

/** A self-signed certificate for `host` made with the key given (so a renewal with the same key keeps the same pin). Needs openssl, which every test box has. */
async function selfSigned(host, keyPem, names = [host]) {
  const { execFileSync } = await import("node:child_process");
  const d = tmp(), k = path.join(d, "k.pem");
  fs.writeFileSync(k, keyPem);
  const crt = execFileSync("openssl", ["req", "-new", "-x509", "-key", k, "-subj", `/CN=${host}`, "-addext", `subjectAltName=${names.map(n => `DNS:${n}`).join(",")}`, "-days", "90"], { encoding: "utf8" });
  return crt;
}
const newKey = () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function world({ name = /** @type {string | null} */ ("alex"), failIssue = false } = {}) {
  const log = /** @type {string[]} */ ([]);
  const issued = /** @type {any[]} */ ([]);
  const dirCalls = /** @type {string[]} */ ([]);
  const gates = /** @type {any[]} */ ([]);
  const directory = { async acme(/** @type {string} */ n, /** @type {string} */ t) { dirCalls.push(`acme ${n}`); }, async acmeClear(/** @type {string} */ n) { dirCalls.push(`clear ${n}`); }, async publish(/** @type {string} */ n, /** @type {any} */ o) { dirCalls.push(`publish ${n}${o && o.apps ? " apps" : ""}`); },
    async acmeOwn(/** @type {string} */ _t) { dirCalls.push("acme-own"); }, async acmeOwnClear() { dirCalls.push("clear-own"); },
    async hostAdd(/** @type {string} */ h) { dirCalls.push(`host-add ${h}`); if (unproven.has(h)) throw Object.assign(new Error(`point _acme-challenge.${h} at the box`), { code: "not_proven" }); },
    async hostRemove(/** @type {string} */ h) { dirCalls.push(`host-remove ${h}`); } };
  const unproven = /** @type {Set<string>} */ (new Set());
  const acme = {
    DIRECTORIES: { production: "https://prod/dir", staging: "https://stg/dir" },
    covers: acmeReal.covers,
    needsRenewal: (/** @type {string} */ pem, /** @type {number} */ now, /** @type {number} */ days) => { const x = new crypto.X509Certificate(pem); return Date.parse(x.validTo) - now <= days * 86400000; },
    async issue(/** @type {any} */ o) {
      issued.push({ names: o.names, directory: o.directory, hasKey: Boolean(o.certKey) });
      if (failIssue) throw new Error("the CA said no");
      await o.dns.set("_acme-challenge." + o.names[0], "v".repeat(43));   // goes to the directory, not DNS
      await o.dns.clear("alex");
      const key = o.certKey || newKey();
      const cert = await selfSigned(o.names[0], key, o.names);
      return { cert, key, expires: Date.parse(new crypto.X509Certificate(cert).validTo), accountUri: "acct" };
    },
  };
  const createGate = (/** @type {any} */ o) => {
    const g = { o, tlsSet: /** @type {any[]} */ ([]), closed: false, pin: certPin(o.tls.cert),
      async listen() { return { host: "0.0.0.0", port: o.listen.port || 7443 }; },
      setTls(/** @type {any} */ t) { g.tlsSet.push(t); g.pin = certPin(t.cert); },
      hostTls: /** @type {Record<string, any>} */ ({}),
      setHostTls(/** @type {string} */ h, /** @type {any} */ t) { g.hostTls[h] = t; }, dropHostTls(/** @type {string} */ h) { delete g.hostTls[h]; },
      async close() { g.closed = true; } };
    gates.push(g); return g;
  };
  return { log, issued, dirCalls, gates, unproven, mk: (/** @type {any} */ extra = {}) => createPublicGate({ name: () => name, dir: tmp(), directory, upstream: { port: 1234 }, listen: { port: 7443 }, log: m => log.push(m), deps: { createGate, certs: certsReal, acme } , ...extra }) };
}

test("a box with no name stays out: state no-name, nothing issued, no listener", async () => {
  const w = world({ name: null });
  const g = w.mk();
  const s = await g.start();
  assert.equal(s.state, "no-name");
  assert.match(String(s.why), /no name yet/);
  assert.equal(w.issued.length, 0);
  assert.equal(w.gates.length, 0);
  assert.equal(g.controlUrl(), null);
  await g.stop();
});

test("a named box gets a certificate through the directory, a TLS gate on the public port, and an address", async () => {
  const w = world();
  const g = w.mk({ publish: true });
  const s = await g.start();
  assert.equal(s.state, "up");
  assert.deepEqual(w.issued.map(i => [i.names, i.directory]), [[["alex.vyre.run"], "https://prod/dir"]]);
  assert.deepEqual(w.dirCalls, ["acme alex", "clear alex", "publish alex"]);
  assert.equal(w.gates.length, 1);
  assert.equal(w.gates[0].o.listen.host, "0.0.0.0");
  assert.equal(w.gates[0].o.listen.port, 7443);
  assert.equal(w.gates[0].o.upstream.port, 1234);
  assert.equal(g.controlUrl(), "https://alex.vyre.run:7443");
  assert.match(String(g.pin()), /^sha256\//);
  assert.equal(s.published, true);
  await g.stop();
  assert.equal(w.gates[0].closed, true);
});

test("the address is published only when the port answers from outside, never before", async () => {
  const w = world();
  let reachable = false;
  const g = w.mk({ reachable: () => reachable });
  const s = await g.start();
  assert.equal(s.state, "up");
  assert.equal(s.published, false, "no outside check yet: the name points nowhere");
  assert.ok(!w.dirCalls.includes("publish alex"));
  reachable = true;
  await g.reachChanged();
  assert.ok(w.dirCalls.includes("publish alex"));
  assert.equal(g.status().published, true);
  await g.stop();
});

test("a good certificate on disk is reused; a near-expiry one is renewed with the same key, so the pin does not move", async () => {
  const w = world();
  const dir = tmp();
  const key = newKey();
  const cert = await selfSigned("alex.vyre.run", key);
  certsReal.save(dir, "alex.vyre.run", { cert, key });
  const g = w.mk({ dir });
  await g.start();
  assert.equal(w.issued.length, 0, "a certificate good for 90 days is not asked for again");
  const pin0 = g.pin();
  await g.stop();

  // 80 days on: inside the 30 day window, so it renews, with the stored key
  const w2 = world();
  const g2 = w2.mk({ dir, now: () => Date.now() + 80 * 86400000 });
  await g2.start();
  assert.equal(w2.issued.length, 1);
  assert.equal(w2.issued[0].hasKey, true, "the key is reused");
  assert.equal(g2.pin(), pin0, "same key, same pin");
  await g2.stop();
});

test("a failed issue is a plain failed state with the reason, the gate is not started, and a retry is scheduled", async () => {
  const w = world({ failIssue: true });
  const g = w.mk();
  const s = await g.start();
  assert.equal(s.state, "failed");
  assert.match(String(s.why), /the CA said no/);
  assert.equal(w.gates.length, 0);
  assert.equal(g.controlUrl(), null);
  await g.stop();
});

test("the staging and test-CA choices", async () => {
  const w = world();
  const g = w.mk({ acme: "staging" });
  await g.start();
  assert.equal(w.issued[0].directory, "https://stg/dir");
  await g.stop();
  const w2 = world();
  const g2 = w2.mk({ acme: "https://localhost:14000/dir" });
  await g2.start();
  assert.equal(w2.issued[0].directory, "https://localhost:14000/dir");
  await g2.stop();
});

test("public ingress: the gate gets the two loopback ports, and the origin links use appears only once the name points here, and goes with the gate", async () => {
  const w = world();
  const ingress = { hooks: () => 7310, share: () => 7311 };
  const told = /** @type {(string | null)[]} */ ([]);
  let reachable = false;
  const g = w.mk({ ingress, onIngress: (/** @type {string | null} */ b) => told.push(b), reachable: () => reachable });
  await g.start();
  assert.equal(w.gates[0].o.ingress, ingress, "the TLS gate was given the ingress ports");
  assert.equal(g.ingressBase(), null, "the gate is up but the name has not been published: no origin yet");
  assert.deepEqual(told, []);
  reachable = true;
  await g.reachChanged();
  assert.equal(g.ingressBase(), "https://alex.vyre.run:7443");
  assert.deepEqual(told, ["https://alex.vyre.run:7443"]);
  await g.reachChanged();
  assert.equal(told.length, 1, "told once");
  await g.stop();
  assert.deepEqual(told, ["https://alex.vyre.run:7443", null]);
  assert.equal(g.ingressBase(), null);
});

test("public ingress: a gate with no ingress never has an origin and passes nothing to the TLS gate", async () => {
  const w = world();
  const g = w.mk({ publish: true });
  await g.start();
  assert.equal(w.gates[0].o.ingress, undefined);
  assert.equal(g.ingressBase(), null);
  await g.stop();
});

test("apps: a box with no app asks for [name] and publishes the name alone; the first app gets [name, *.name] and then the wildcard in DNS; the last one's removal takes the wildcard out of DNS", async () => {
  const w = world();
  let installed = false;
  const g = w.mk({ publish: true, apps: () => installed, ingress: { hooks: () => null, share: () => null, apps: () => ({ port: 9, hosts: [] }) } });
  await g.start();
  assert.deepEqual(w.issued.map(i => i.names), [["alex.vyre.run"]]);
  assert.deepEqual(w.dirCalls.filter(c => c.startsWith("publish")), ["publish alex"]);
  assert.equal(w.gates[0].o.ingress.appsSuffix, ".alex.vyre.run", "the gate is told which suffix is an app host");
  assert.equal(g.status().apps, false);
  // the first app: a new certificate for both names with the SAME key, then the wildcard
  installed = true;
  await g.appsChanged();
  assert.deepEqual(w.issued.map(i => [i.names, i.hasKey]), [[["alex.vyre.run"], false], [["alex.vyre.run", "*.alex.vyre.run"], true]]);
  assert.deepEqual(w.dirCalls.filter(c => c.startsWith("publish")), ["publish alex", "publish alex apps"]);
  assert.equal(g.status().apps, true);
  assert.equal(w.gates.length, 1, "the same gate, new certificate");
  assert.equal(w.gates[0].tlsSet.length, 1);
  // nothing changed: no new order, no new publish
  await g.appsChanged();
  assert.equal(w.issued.length, 2);
  assert.equal(w.dirCalls.filter(c => c.startsWith("publish")).length, 2);
  // the last app removed: the wildcard goes from DNS, the certificate is left (its next renewal asks for the name alone)
  installed = false;
  await g.appsChanged();
  assert.deepEqual(w.dirCalls.filter(c => c.startsWith("publish")), ["publish alex", "publish alex apps", "publish alex"]);
  assert.equal(g.status().apps, false);
  assert.equal(w.issued.length, 2);
  await g.stop();
});

test("apps: a certificate that already covers both names is not ordered again, one that does not is, and a failing apps question means no apps", async () => {
  const w = world();
  const dir = tmp();
  const first = w.mk({ publish: true, dir, apps: () => true });
  await first.start(); await first.stop();
  assert.deepEqual(w.issued.map(i => i.names), [["alex.vyre.run", "*.alex.vyre.run"]]);
  const again = w.mk({ publish: true, dir, apps: () => true });
  await again.start(); await again.stop();
  assert.equal(w.issued.length, 1, "restart with the cert in hand: no order");
  assert.ok(w.dirCalls.includes("publish alex apps"));
  const w2 = world();
  const d2 = tmp();
  const plain = w2.mk({ publish: true, dir: d2 }); await plain.start(); await plain.stop();
  const later = w2.mk({ publish: true, dir: d2, apps: () => true }); await later.start(); await later.stop();
  assert.deepEqual(w2.issued.map(i => i.names), [["alex.vyre.run"], ["alex.vyre.run", "*.alex.vyre.run"]], "a name-only certificate is replaced when an app appears");
  const w3 = world();
  const broken = w3.mk({ publish: true, apps: () => { throw new Error("down"); } });
  await broken.start(); await broken.stop();
  assert.deepEqual(w3.issued.map(i => i.names), [["alex.vyre.run"]]);
});

test("apps: the wildcard is published only once the certificate that covers it is in hand", async () => {
  const w = world({ failIssue: true });
  const g = w.mk({ publish: true, apps: () => true });
  const s = await g.start();
  assert.equal(s.state, "failed");
  assert.deepEqual(w.dirCalls.filter(c => c.startsWith("publish")), [], "no certificate, no address of any kind");
  await g.stop();
});

test("own hosts: a host is listed, gets its own certificate under the own-domain label and is served by SNI; one whose DNS record is missing waits and is not ordered; a removed one is unlisted and dropped", async () => {
  const w = world();
  let hosts = ["sign.firm.example", "later.firm.example"];
  w.unproven.add("later.firm.example");
  const g = w.mk({ publish: true, apps: () => true, hosts: () => hosts, ingress: { hooks: () => null, share: () => null, apps: () => ({ port: 9, hosts: [] }) } });
  await g.start();
  const st = () => Object.fromEntries(g.status().hosts.map((/** @type {any} */ h) => [h.host, h.state]));
  assert.deepEqual(st(), { "sign.firm.example": "live", "later.firm.example": "waiting" });
  assert.deepEqual(w.issued.map(i => i.names), [["alex.vyre.run", "*.alex.vyre.run"], ["sign.firm.example"]], "nothing is ordered for the host that is not proven");
  assert.deepEqual(w.dirCalls.filter(c => /own|host/.test(c)), ["host-add sign.firm.example", "acme-own", "clear-own", "host-add later.firm.example"]);
  assert.deepEqual(Object.keys(w.gates[0].hostTls), ["sign.firm.example"]);
  assert.deepEqual(g.liveHosts(), ["sign.firm.example"]);
  assert.match(g.status().hosts.find((/** @type {any} */ h) => h.host === "later.firm.example").why, /_acme-challenge/);
  // the person adds the record: the next look lists it and orders its certificate
  w.unproven.clear();
  await g.hostsChanged();
  assert.deepEqual(st(), { "sign.firm.example": "live", "later.firm.example": "live" });
  assert.deepEqual(g.liveHosts().sort(), ["later.firm.example", "sign.firm.example"]);
  assert.equal(w.issued.filter(i => i.names[0] === "sign.firm.example").length, 1, "a good certificate on disk is not ordered again");
  // the person removes one
  hosts = ["sign.firm.example"];
  await g.hostsChanged();
  assert.deepEqual(st(), { "sign.firm.example": "live" });
  assert.deepEqual(Object.keys(w.gates[0].hostTls), ["sign.firm.example"]);
  assert.ok(w.dirCalls.includes("host-remove later.firm.example"));
  await g.stop();
});

test("own hosts: a failing question about the hosts, or a box with no hosts option, changes nothing", async () => {
  const w = world();
  const a = w.mk({ publish: true });
  await a.start();
  assert.deepEqual(a.status().hosts, []);
  await a.stop();
  const w2 = world();
  const b = w2.mk({ publish: true, hosts: () => { throw new Error("no"); } });
  assert.equal((await b.start()).state, "up");
  assert.deepEqual(b.status().hosts, []);
  await b.stop();
});
