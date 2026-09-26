// @ts-check
// The names service against fakes: the claim flow, the listener's identity rule, the claim code
// for a tagged box, renewal. Nothing here reaches Tailscale, Cloudflare or Let's Encrypt.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as config from "../config/index.js";
import * as certs from "./certs.js";
import { names, checkName } from "./service.js";
import { tempHome } from "../../test/helpers.js";

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !hasOpenssl && "openssl is needed to make a certificate";

function selfSigned(cn, days = 90) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-names-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-subj", `/O=Test CA/CN=${cn}`, "-days", String(days)], { stdio: "ignore" });
    const cert = fs.readFileSync(path.join(dir, "c.pem"), "utf8");
    return { cert, key: fs.readFileSync(path.join(dir, "k.pem"), "utf8"), expires: Date.parse(new crypto.X509Certificate(cert).validTo) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** A world of fakes, and the service built on it. */
function world(t, { tagged = false, owner = "alex@example.com", ips = ["127.0.0.1"], taken = false } = {}) {
  const root = tempHome(t);
  const cfg = config.load(root);
  cfg.network.port = 0;
  const emitted = [], records = [], calls = [];
  const ctx = {
    config: cfg, paths: config.ensure(root), log: () => {},
    events: { emit: (type, payload) => emitted.push({ type, payload }) },
    handler: () => async (req, res, caller) => { calls.push(caller); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: { caller } })); },
  };
  fs.mkdirSync(ctx.paths.certs, { recursive: true });
  const ts = {
    status: async () => ({ installed: true, running: true, backend: "Running", loginUrl: null, tun: true, why: null,
      node: { name: "box", dnsName: "box.example.ts.net", ips, stableId: "n1", tagged }, owner: tagged ? null : owner, certDomains: ["box.example.ts.net"] }),
    whois: async ip => ({ "100.101.1.2": { login: "alex@example.com", tagged: false, node: "phone" }, "100.101.1.3": { login: "sam@example.com", tagged: false, node: "laptop" } })[ip] || null,
    up: async () => ({ loginUrl: "https://login.tailscale.com/a/x" }),
    cert: async (host, crt, key) => { const c = selfSigned(host); fs.writeFileSync(crt, c.cert); fs.writeFileSync(key, c.key); },
    operator: async () => ({ ok: true, fix: null }),
    installCommand: () => "install tailscale",
  };
  const dns = {
    available: async (f, ip) => ({ available: !taken, mine: false }),
    upsertA: async (f, ip) => { records.push({ type: "A", name: f, content: ip, id: "r" + records.length }); return records.at(-1); },
    find: async f => records.filter(r => r.name === f),
    remove: async id => { const i = records.findIndex(r => r.id === id); if (i >= 0) records.splice(i, 1); },
    set: async () => "txt", clear: async () => {},
  };
  let issued = 0;
  const svc = names({ ctx, ts, certs, save: p => config.save(p, root, cfg), dns: async () => dns,
    issue: async ({ names: list }) => { issued++; return selfSigned(list[0]); } });
  t.after(() => svc.close());
  return { root, cfg, ctx, svc, emitted, records, calls, issued: () => issued };
}

/** A request as the listener sees it, from a given peer address. */
function fakeReq(remoteAddress, url = "/v1/health", method = "GET", headers = {}) {
  return { method, url, headers: { host: "alex.vyre.run:0", "tailscale-user-login": "alex@example.com", "x-vyre-caller": "cli", ...headers }, socket: { remoteAddress } };
}
function fakeRes() {
  const r = { status: 0, headers: {}, body: "", headersSent: false,
    setHeader(k, v) { r.headers[k] = v; }, writeHead(s, h = {}) { r.status = s; Object.assign(r.headers, h); r.headersSent = true; }, end(b = "") { r.body += b; } };
  return r;
}

test("names: which names can be had", () => {
  assert.equal(checkName("alex").valid, true);
  assert.equal(checkName("Alex-2").name, "alex-2");
  for (const bad of ["a", "1abc", "-abc", "abc-", "a_b", "www", "api", "a--b", "x".repeat(33)]) assert.equal(checkName(bad).valid, false, bad);
});

test("names: a claim points the name at the tailnet address, gets a certificate and serves", { skip }, async t => {
  const w = world(t, { ips: ["127.0.0.1"] });
  const first = w.svc.claim("alex");
  assert.equal(first.phase, "dns");
  await w.svc.wait();
  const s = w.svc.status();
  assert.equal(s.phase, "serving", s.why || "");
  assert.deepEqual(w.records.map(r => [r.name, r.content]), [["alex.vyre.run", "127.0.0.1"]]);
  assert.equal(w.cfg.name, "alex");
  assert.match(String(s.address), /^https:\/\/alex\.vyre\.run:\d+$/, "a non-443 port is part of the address");
  assert.equal(s.certificate.issuer, "Test CA");
  assert.deepEqual(w.emitted.map(e => e.type).filter(x => x !== "owner.changed"), ["name.claimed", "certificate.issued"]);
  assert.equal(JSON.parse(fs.readFileSync(config.paths(w.root).config, "utf8")).network.address, s.address, "the address is saved");
});

test("names: a taken name fails the claim with a reason and creates nothing", async t => {
  const w = world(t, { taken: true });
  w.svc.claim("alex");
  await w.svc.wait();
  assert.equal(w.svc.status().phase, "failed");
  assert.match(String(w.svc.status().why), /someone else/);
  assert.equal(w.records.length, 0);
});

test("names: the listener serves only the owner, from another device, whatever the headers say", { skip }, async t => {
  const w = world(t);
  w.cfg.name = "alex";
  await w.svc.tailscale();
  const owner = fakeRes();
  await w.svc.onRequest(fakeReq("100.101.1.2"), owner);
  assert.equal(owner.status, 200);
  assert.deepEqual(JSON.parse(owner.body), { data: { caller: "tailnet:alex@example.com" } }, "the caller comes from whois, never from x-vyre-caller");
  assert.equal(owner.headers["strict-transport-security"], "max-age=31536000");
  for (const ip of ["100.101.1.3", "127.0.0.1", "172.17.0.2"]) {
    const r = fakeRes();
    await w.svc.onRequest(fakeReq(ip), r);
    assert.equal(r.status, 403, ip);
    assert.equal(JSON.parse(r.body).error.code, "not_owner");
  }
  assert.equal(w.calls.length, 1, "nothing but the owner reached the router");
  assert.ok(w.emitted.some(e => e.type === "owner.seen"), "the first owner request is announced, so the loopback door can close");
});

test("names: a real TLS connection from this box itself is refused", { skip }, async t => {
  const w = world(t, { ips: ["127.0.0.1"] });
  w.svc.claim("alex");
  await w.svc.wait();
  const port = Number(new URL(String(w.svc.status().address)).port);
  const status = await new Promise((resolve, reject) => {
    https.get({ host: "127.0.0.1", port, path: "/v1/health", rejectUnauthorized: false, headers: { "tailscale-user-login": "alex@example.com" } },
      res => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  assert.equal(status, 403);
});

test("names: a tagged box has no owner until a tailnet login opens the one-time claim link", { skip }, async t => {
  const w = world(t, { tagged: true });
  await w.svc.tailscale();
  assert.equal(w.cfg.network.owner, undefined);
  const { path: claim } = w.svc.claimCode();
  const stranger = fakeRes();
  await w.svc.onRequest(fakeReq("100.101.1.2", "/onboard/claim?c=wrong"), stranger);
  assert.equal(stranger.status, 403);
  const r = fakeRes();
  await w.svc.onRequest(fakeReq("100.101.1.2", claim), r);
  assert.equal(r.status, 302);
  assert.equal(w.cfg.network.owner, "alex@example.com");
  const again = fakeRes();
  await w.svc.onRequest(fakeReq("100.101.1.3", claim), again);
  assert.equal(again.status, 403, "the code works once, and there is an owner now");
});

test("names: an untagged box takes its node's login as the owner", async t => {
  const w = world(t);
  await w.svc.tailscale();
  assert.equal(w.cfg.network.owner, "alex@example.com");
});

test("names: the ts.net fallback serves the tailnet's own name", { skip }, async t => {
  const w = world(t);
  w.svc.fallback();
  await w.svc.wait();
  const s = w.svc.status();
  assert.equal(s.phase, "serving", s.why || "");
  assert.equal(s.via, "ts.net");
  assert.match(String(s.address), /^https:\/\/box\.example\.ts\.net/);
  assert.equal(fs.statSync(path.join(w.ctx.paths.certs, "box.example.ts.net.key")).mode & 0o777, 0o600);
});

test("names: renewal waits until 30 days are left, then swaps the certificate in", { skip }, async t => {
  const w = world(t);
  w.svc.claim("alex");
  await w.svc.wait();
  assert.equal(await w.svc.renew(), false, "a fresh certificate is not renewed");
  certs.save(w.ctx.paths.certs, "alex.vyre.run", selfSigned("alex.vyre.run", 10));
  const before = w.issued();
  assert.equal(await w.svc.renew(), true);
  assert.equal(w.issued(), before + 1);
  assert.ok(w.emitted.some(e => e.type === "certificate.issued" && e.payload.renewed));
});

test("names: release removes the record and stops serving", { skip }, async t => {
  const w = world(t);
  w.svc.claim("alex");
  await w.svc.wait();
  const s = await w.svc.release();
  assert.equal(w.records.length, 0);
  assert.equal(s.listening, false);
  assert.equal(s.address, null);
});

test("names: the owner's browser cannot be made to call a tool from another site", async t => {
  const w = world(t);
  w.cfg.name = "alex";
  await w.svc.tailscale();
  const cases = [
    [{ "content-type": "text/plain" }, 403, "a simple POST needs no preflight, so it must be refused"],
    [{ "content-type": "application/x-www-form-urlencoded" }, 403, "a form post"],
    [{ "content-type": "application/json", origin: "https://evil.example" }, 403, "another origin"],
    [{ "content-type": "application/json", origin: "https://alex.vyre.run:0" }, 200, "this box's own page"],
    [{ "content-type": "application/json" }, 200, "a non-browser client (the Mac's vyred) sends no Origin"],
  ];
  for (const [headers, status, why] of cases) {
    const r = fakeRes();
    await w.svc.onRequest(fakeReq("100.101.1.2", "/v1/tools/names.owner", "POST", headers), r);
    assert.equal(r.status, status, why);
  }
  const wrongHost = fakeRes();
  await w.svc.onRequest(fakeReq("100.101.1.2", "/v1/health", "GET", { host: "evil.example" }), wrongHost);
  assert.equal(wrongHost.status, 421);
});

test("names: whois naming this very node is refused even when the address list is stale", async () => {
  const { identifier } = await import("./identity.js");
  const id = identifier({ whois: async () => ({ login: "alex@example.com", tagged: false, node: "box", stableId: "nSELF" }),
    selfIps: () => [], selfId: () => "nSELF", owner: () => "alex@example.com" });
  assert.equal((await id("100.101.1.1")).why, "from this box itself");
});
