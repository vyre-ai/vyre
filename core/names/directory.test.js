// @ts-check
// The box's side of the name directory: the signed client, and the names service claiming,
// pointing, recovering and checking a domain through it. The directory is the real Worker
// (names/worker) on the fake Workers runtime, over a fake Cloudflare DNS API. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as config from "../config/index.js";
import * as certs from "./certs.js";
import { names } from "./service.js";
import { directory, authMessage, AUTH_TAG } from "./directory.js";
import { codeHash } from "./rules.js";
import worker, * as W from "../../names/worker/index.js";
import { fakeDns } from "../../names/worker/fake-dns.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import * as wire from "../relay/wire.js";
import { tempHome } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";

const HOUR = 3_600_000;
const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !hasOpenssl && "openssl is needed to make a certificate";

function selfSigned(cn) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-names-dir-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-subj", `/O=Test CA/CN=${cn}`, "-days", "90"], { stdio: "ignore" });
    const cert = fs.readFileSync(path.join(dir, "c.pem"), "utf8");
    return { cert, key: fs.readFileSync(path.join(dir, "k.pem"), "utf8"), expires: Date.parse(new crypto.X509Certificate(cert).validTo) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The hosted directory, over fakes. */
function hosted(t, env = {}) {
  const dns = fakeDns();
  const clock = { t: Date.now() };
  const rt = createRuntime({ worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", ...env } });
  t.after(async () => { await rt.settle(); assert.deepEqual(rt.errors.map(String), [], "no errors inside the Worker"); });
  let n = 0;
  /** A route key and a client for one box, each from its own address. */
  const box = (o = {}) => {
    const key = wire.newRouteKey(), route = wire.routeId(key.pub), ip = `198.51.100.${++n}`;
    const signer = { identity: async () => ({ route, pub: key.pub }), sign: async m => wire.signRoute(key.priv, m), ...o };
    const fetch = (url, init) => { const h = new Headers(init && init.headers); h.set("cf-connecting-ip", ip); return worker.fetch(new Request(url, { ...init, headers: h }), rt.env); };
    return { key, route, signer, fetch, client: directory({ base: "https://names.test", signer, fetch: /** @type {any} */ (fetch), now: () => clock.t }) };
  };
  return { dns, clock, rt, box };
}

/** Event types, without the owner.changed a fresh box always emits. */
const kinds = list => list.map(e => e.type).filter(x => x !== "owner.changed");
const fail = async (p, code) => { await assert.rejects(p, e => { assert.equal(/** @type {any} */ (e).code, code); return true; }); };

test("directory client: signs with the route key, and every failure carries a code", async t => {
  const h = hosted(t), a = h.box();
  assert.equal((await a.client.check("alex")).status, "ok");
  const r = await a.client.claim("alex");
  assert.equal(r.name, "alex");
  assert.match(String(r.code), /^([a-z2-7]{4}-){6}[a-z2-7]{2}$/);
  assert.equal((await a.client.check("alex")).status, "mine");
  assert.equal((await h.box().client.check("alex")).status, "taken");
  await fail(h.box().client.claim("alex"), "taken");
  await fail(a.client.claim("vyre"), "reserved");
  await fail(a.client.claim("ab"), "invalid");
  await fail(a.client.point("alex", "8.8.8.8"), "not_tailnet");
  // a client whose fetch cannot connect says so, in one plain sentence
  const down = directory({ base: "https://names.test", signer: a.signer, fetch: /** @type {any} */ (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }) });
  await assert.rejects(down.check("alex"), /not reachable \(ENOTFOUND\)/);
  await fail(down.check("alex"), "unreachable");
  assert.throws(() => directory({ base: "ftp://x", signer: a.signer }), /http/);
});

test("directory client: what it signs is what the Worker checks, and a signer that fails stops the call", async t => {
  const h = hosted(t);
  const seen = [];
  const a = h.box({ sign: async m => { seen.push(m.toString()); return wire.signRoute(/** @type {any} */ (a0.key).priv, m); } });
  const a0 = a;
  await a.client.claim("alex");
  assert.equal(seen.length, 1);
  const [tag, route, ts, nonce, method, target, bodyHash] = seen[0].split("\n");
  assert.deepEqual([tag, route, method, target], [AUTH_TAG, a.route, "POST", "/v1/names/claim"]);
  assert.equal(bodyHash, crypto.createHash("sha256").update(JSON.stringify({ name: "alex" })).digest("hex"));
  assert.ok(Number(ts) > 0 && nonce.length >= 16);
  assert.equal(authMessage({ route: "r", ts: 1, nonce: "n", method: "GET", target: "/x", bodyHash: "h" }).toString(), `${AUTH_TAG}\nr\n1\nn\nGET\n/x\nh`);
  assert.equal(AUTH_TAG, W.AUTH_TAG);
  const broken = h.box({ identity: async () => { throw new Error("the relay keys are not available (relay.route.id)"); } });
  await assert.rejects(broken.client.claim("bobby"), /relay keys are not available/);
  assert.equal((await h.box().client.check("bobby")).status, "ok", "and nothing was claimed");
});

/** A names service for one box, on the hosted directory. */
function boxService(t, h, { ips = [], tun = true, resolver = undefined, accountUri = undefined, issueDns = false } = {}) {
  const root = tempHome(t);
  const cfg = config.load(root);
  cfg.network.port = 0;
  const b = h.box();
  const emitted = [], log = [];
  const ctx = { config: cfg, paths: config.ensure(root), log: m => log.push(m), events: { emit: (type, payload) => emitted.push({ type, payload }) },
    handler: () => async () => {}, upgrader: () => () => {} };
  fs.mkdirSync(ctx.paths.certs, { recursive: true });
  const state = { ips, tun, issued: [] };
  const ts = {
    status: async () => ({ installed: true, running: true, backend: "Running", loginUrl: null, tun: state.tun, why: null,
      node: { name: "box", dnsName: "box.example.ts.net", ips: state.ips, stableId: "n1", tagged: false }, owner: "alex@example.com", certDomains: [] }),
    whois: async () => null, up: async () => ({}), cert: async () => {}, operator: async () => ({ ok: true }), installCommand: () => "",
  };
  const deps = { ctx, ts, certs, save: p => config.save(p, root, cfg), directory: b.client, listen: async () => {}, resolver, accountUri,
    issue: async ({ names: list, dns }) => {
      // As acme.issue does: a TXT under _acme-challenge for the name, then clear it.
      const handle = await dns.set(`_acme-challenge.${list[0]}`, "v".repeat(43));
      state.issued.push({ name: list[0], txtWhileIssuing: h.dns.at(`_acme-challenge.${list[0]}`, "TXT").length });
      await dns.clear(handle);
      return selfSigned(list[0]);
    } };
  const svc = names(deps);
  t.after(() => svc.close());
  return { svc, ctx, cfg, emitted, log, state, box: b, root };
}

test("names.claim before Tailscale: named at once, the recovery code only in the answer", { skip }, async t => {
  const h = hosted(t), a = boxService(t, h, { ips: [] });
  const out = /** @type {any} */ (await a.svc.claim("alex"));
  assert.match(out.recoveryCode, /^([a-z2-7]{4}-){6}[a-z2-7]{2}$/);
  await a.svc.wait();
  const s = a.svc.status();
  assert.equal(s.phase, "named");
  assert.match(String(s.why), /connect Tailscale/);
  assert.equal(a.cfg.name, "alex");
  assert.deepEqual(kinds(a.emitted), ["name.claimed"]);
  const everywhere = JSON.stringify([s, a.emitted, a.log]);
  assert.ok(!everywhere.includes(out.recoveryCode.replace(/-/g, "")) && !everywhere.includes(out.recoveryCode), "the code is in no status, event or log");
  assert.equal(h.dns.records.length, 0);
});

test("names.claim once on the tailnet: the address, the certificate through directory challenges, serving", { skip }, async t => {
  const h = hosted(t), a = boxService(t, h, { ips: [] });
  await a.svc.claim("alex");
  await a.svc.wait();
  a.state.ips = ["100.101.1.2", "fd7a:115c:a1e0:ab12:4843:cd96:6265:f9d0"];
  const again = /** @type {any} */ (await a.svc.claim());
  assert.equal(again.recoveryCode, null, "no second code");
  await a.svc.wait();
  assert.equal(a.svc.status().phase, "serving", a.svc.status().why || "");
  assert.deepEqual(h.dns.at("alex.vyre.run").map(r => [r.type, r.content]), [["A", "100.101.1.2"], ["AAAA", "fd7a:115c:a1e0:ab12:4843:cd96:6265:f9d0"]]);
  assert.deepEqual(a.state.issued, [{ name: "alex.vyre.run", txtWhileIssuing: 1 }]);
  assert.equal(h.dns.at("_acme-challenge.alex.vyre.run").length, 0, "cleared afterwards");
  assert.deepEqual(kinds(a.emitted), ["name.claimed", "certificate.issued"]);
  assert.match(String(a.cfg.network.address), /^https:\/\/alex\.vyre\.run/);
});

test("names.claim: a public or private address is refused by the directory and the claim fails", { skip }, async t => {
  const h = hosted(t), a = boxService(t, h, { ips: ["192.168.1.5"] });
  await a.svc.claim("alex");
  await a.svc.wait();
  assert.equal(a.svc.status().phase, "failed");
  assert.match(String(a.svc.status().why), /tailnet addresses/);
  assert.equal(h.dns.records.length, 0);
});

test("names.claim and names.check: taken, reserved, mine", { skip }, async t => {
  const h = hosted(t), a = boxService(t, h), b = boxService(t, h);
  await a.svc.claim("alex");
  const taken = /** @type {any} */ (await b.svc.claim("alex"));
  assert.equal(taken.recoveryCode, null);
  assert.equal(b.svc.status().phase, "failed");
  assert.match(String(b.svc.status().why), /someone else/);
  assert.notEqual(b.cfg.name, "alex", "no name was saved on the loser");
  assert.deepEqual(kinds(b.emitted), []);
  assert.equal((await b.svc.check("alex")).available, false);
  assert.equal((await a.svc.check("alex")).available, true, "mine counts as available");
  assert.equal((await b.svc.check("bobby")).available, true);
  const reserved = await b.svc.check("google");
  assert.deepEqual([reserved.valid, reserved.available], [false, false]);
  assert.equal((await b.svc.check("ab")).valid, false);
  assert.throws(() => b.svc.claim("vyre"), /reserved/);
});

test("names.release: a pointed name is a tombstone, its records go", { skip }, async t => {
  const h = hosted(t), a = boxService(t, h, { ips: ["100.101.1.2"] });
  await a.svc.claim("alex");
  await a.svc.wait();
  assert.equal(h.dns.at("alex.vyre.run").length, 1);
  await a.svc.release();
  assert.equal(h.dns.records.length, 0);
  assert.ok(a.emitted.some(e => e.type === "name.released"));
  assert.equal((await h.box().client.check("alex")).status, "taken", "for good");
});

test("names.recover: the old box cancels by itself; with it offline the name moves after 72 hours", { skip }, async t => {
  const h = hosted(t), old = boxService(t, h, { ips: ["100.101.1.2"] });
  const { recoveryCode } = /** @type {any} */ (await old.svc.claim("alex"));
  await old.svc.wait();
  // A reinstalled box, no owner yet: only the code.
  const fresh = boxService(t, h, { ips: [] });
  await assert.rejects(fresh.svc.recover({ name: "alex", code: "aaaa-bbbb-cccc-dddd-eeee-ff" }), /do not match/);
  await assert.rejects(fresh.svc.recover({ name: "alex", code: "" }), /code is needed/);
  const r = await fresh.svc.recover({ name: "alex", code: recoveryCode.toUpperCase() });
  assert.equal(r.pendingUntil, h.clock.t + 72 * HOUR);
  assert.match(r.recoveryCode, /^([a-z2-7]{4}-){6}[a-z2-7]{2}$/);
  assert.notEqual(r.recoveryCode, recoveryCode);
  assert.equal(fresh.cfg.network.recovering, "alex");
  assert.notEqual(fresh.cfg.name, "alex", "the name is adopted only when the rebind lands");
  // The old box is online: its next look cancels the rebind with no click, and announces it.
  await old.svc.watch();
  assert.deepEqual(kinds(old.emitted).slice(-2), ["name.recovery-pending", "name.recovery-cancelled"]);
  assert.equal(old.emitted.at(-2)?.payload.name, "alex.vyre.run");
  h.clock.t += 80 * HOUR;
  await fresh.svc.watch();
  assert.equal(fresh.cfg.network.recovering, "alex", "still waiting: it never moved");
  assert.deepEqual(kinds(fresh.emitted), []);
  assert.equal((await old.box.client.check("alex")).status, "mine");
  // A second try while the old box is off lands after the wait.
  await fresh.svc.recover({ name: "alex", code: recoveryCode });
  h.clock.t += 73 * HOUR;
  const m = await fresh.svc.watch();
  assert.equal(m && m.name, "alex");
  assert.equal(fresh.cfg.name, "alex");
  assert.ok(!fresh.cfg.network.recovering, "no longer recovering");
  assert.deepEqual(kinds(fresh.emitted), ["name.recovered"]);
  assert.equal((await old.box.client.check("alex")).status, "taken");
  // it can go on to point and serve the name
  fresh.state.ips = ["100.101.7.7"];
  await fresh.svc.claim();
  await fresh.svc.wait();
  assert.equal(fresh.svc.status().phase, "serving", fresh.svc.status().why || "");
  assert.deepEqual(h.dns.at("alex.vyre.run").map(x => x.content), ["100.101.7.7"]);
});

test("names.recover: the hash the box sends is the hash of the code it shows", async t => {
  const h = hosted(t), a = h.box(), b = h.box();
  const { code } = await a.client.claim("alex");
  const sent = [];
  const spy = directory({ base: "https://names.test", signer: b.signer, now: () => h.clock.t, fetch: /** @type {any} */ (async (url, init) => { sent.push(JSON.parse(init.body || "{}")); return b.fetch(url, init); }) });
  const svc = names({ ctx: /** @type {any} */ ({ config: { network: {} }, paths: {}, log() {}, events: { emit() {} } }), save() {}, ts: /** @type {any} */ ({}), certs, directory: spy, issue: /** @type {any} */ (async () => {}) });
  const r = await svc.recover({ name: "alex", code: String(code) });
  assert.equal(sent[0].next, codeHash("alex", r.recoveryCode));
  assert.ok(!JSON.stringify(sent).includes(r.recoveryCode), "the new code itself never leaves the box");
});

test("names.domain.check: the CNAME to <routehash>.acme.vyre.run and the optional CAA, live", { skip }, async t => {
  const h = hosted(t);
  const dns = { cname: /** @type {Record<string, string[]>} */ ({}), caa: /** @type {Record<string, any[]>} */ ({}) };
  const resolver = {
    resolveCname: async host => { if (!dns.cname[host]) throw Object.assign(new Error("no"), { code: "ENODATA" }); return dns.cname[host]; },
    resolveCaa: async host => { if (!dns.caa[host]) throw Object.assign(new Error("no"), { code: "ENOTFOUND" }); return dns.caa[host]; },
  };
  const a = boxService(t, h, { resolver, accountUri: async () => "https://acme.example/acct/42" });
  await assert.rejects(a.svc.domainCheck("example.com"), /claim a name first/);
  await a.svc.claim("alex");
  const zone = (await a.box.client.mine()).acmeZone;
  assert.equal(zone, `${await W.routeHash(a.box.route)}.acme.vyre.run`);
  let r = await a.svc.domainCheck("Example.com");
  assert.deepEqual([r.ok, r.cname.ok, r.cname.found, r.cname.host, r.cname.expected, r.caa.present, r.caa.ok], [false, false, [], "_acme-challenge.example.com", zone, false, false]);
  dns.cname["_acme-challenge.example.com"] = ["other.example.net."];
  assert.equal((await a.svc.domainCheck("example.com")).cname.ok, false);
  dns.cname["_acme-challenge.example.com"] = [zone + "."];
  r = await a.svc.domainCheck("example.com");
  assert.deepEqual([r.ok, r.cname.ok, r.caa.present, r.caa.ok, r.caa.optional], [true, true, false, false, true]);
  dns.caa["example.com"] = [{ critical: 0, issue: "letsencrypt.org; accounturi=https://acme.example/acct/42" }];
  r = await a.svc.domainCheck("example.com");
  assert.deepEqual([r.caa.present, r.caa.ok], [true, true]);
  dns.caa["example.com"] = [{ critical: 0, issue: "letsencrypt.org; accounturi=https://acme.example/acct/99" }];
  assert.equal((await a.svc.domainCheck("example.com")).caa.ok, false);
  for (const bad of ["", "alex.vyre.run", "vyre.run", "localhost", "a b.com", "http://x.com"]) await assert.rejects(a.svc.domainCheck(bad), /not a domain of your own/, bad);
  // the directory only ever writes the challenge under that label
  const token = "y".repeat(43);
  assert.equal((await a.box.client.acmeOwn(token)).fqdn, zone);
  assert.equal(h.dns.at(zone, "TXT").length, 1);
  await a.box.client.acmeOwnClear();
  assert.equal(h.dns.at(zone, "TXT").length, 0);
});

test("directory: under a test runner the real fetch refuses the hosted directory and any non-loopback host, and allows a fake on 127.0.0.1 or an injected fetch", () => {
  const signer = { identity: async () => ({ route: "r", pub: Buffer.alloc(32) }), sign: async () => Buffer.alloc(64) };
  for (const base of ["https://names.vyre.run", "https://example.com", "http://10.0.0.5:8787"]) {
    assert.throws(() => directory({ base, signer }), e => e.code === "test_guard", base);
  }
  assert.throws(() => directory({ signer }), e => e.code === "test_guard", "the default base is the hosted one");
  assert.doesNotThrow(() => directory({ base: "http://127.0.0.1:8787", signer }));
  assert.doesNotThrow(() => directory({ base: "http://localhost:8787", signer }));
  assert.doesNotThrow(() => directory({ base: "https://names.vyre.run", signer, fetch: async () => ({}) }), "a test's own fetch never leaves the process");
});
