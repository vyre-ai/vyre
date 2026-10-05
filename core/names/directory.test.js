// @ts-check
// The box's side of the name directory: the signed client, and the names service claiming,
// recovering and checking a domain through it. The directory is the real Worker
// (names/worker) on the fake Workers runtime, over a fake Cloudflare DNS API. No network.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as config from "../config/index.js";
import { names } from "./service.js";
import { directory, authMessage, AUTH_TAG } from "./directory.js";
import worker, * as W from "../../names/worker/index.js";
import { fakeDns } from "../../names/worker/fake-dns.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import * as wire from "../relay/wire.js";
import { tempHome } from "../../test/helpers.js";

const HOUR = 3_600_000;
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
  assert.equal(r.fresh, true, "a new claim says so; there is no recovery code");
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
function boxService(t, h, { resolver = undefined, accountUri = undefined } = {}) {
  const root = tempHome(t);
  const cfg = config.load(root);
  const b = h.box();
  const emitted = [], log = [];
  const ctx = { config: cfg, paths: config.ensure(root), log: m => log.push(m), events: { emit: (type, payload) => emitted.push({ type, payload }) } };
  const svc = names({ ctx, save: p => config.save(p, root, cfg), directory: b.client, resolver, accountUri });
  return { svc, ctx, cfg, emitted, log, box: b, root };
}

test("names.claim: the name is held at once, there is no recovery code anywhere, and no address is published", async t => {
  const h = hosted(t), a = boxService(t, h);
  const out = /** @type {any} */ (await a.svc.claim("alex"));
  assert.equal(out.recoveryCode, undefined, "no recovery code is made");
  const s = a.svc.status();
  assert.equal(s.phase, "named");
  assert.equal(s.why, null);
  assert.equal(a.cfg.name, "alex");
  assert.equal(s.listening, false);
  assert.equal(s.address, null, "an address is published once the built-in network has one");
  assert.deepEqual(kinds(a.emitted), ["name.claimed"]);
  assert.ok(!/recovery/i.test(JSON.stringify([s, a.emitted, a.log])), "and no status, event or log speaks of one");
  assert.equal(h.dns.records.length, 0, "nothing is pointed anywhere");
  await a.svc.claim();
});

test("names.claim and names.check: taken, reserved, mine", async t => {
  const h = hosted(t), a = boxService(t, h), b = boxService(t, h);
  await a.svc.claim("alex");
  const taken = /** @type {any} */ (await b.svc.claim("alex"));
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

test("names.release: the name goes back for good, and the box forgets it", async t => {
  const h = hosted(t), a = boxService(t, h);
  await a.svc.claim("alex");
  await a.svc.release();
  assert.ok(!a.cfg.network.via);
  assert.equal(h.dns.records.length, 0);
  assert.ok(a.emitted.some(e => e.type === "name.released"));
  assert.equal((await h.box().client.check("alex")).status, "ok", "a name that was never pointed anywhere is simply free again");
});

test("names.domain.check: the CNAME to <routehash>.acme.vyre.run and the optional CAA, live", async t => {
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

test("directory: under a test runner the real fetch refuses the hosted directory and any non-loopback host at the call, and allows a fake on 127.0.0.1 or an injected fetch", async () => {
  const signer = { identity: async () => ({ route: "r", pub: Buffer.alloc(32) }), sign: async () => Buffer.alloc(64) };
  for (const base of ["https://names.vyre.run", "https://example.com", "http://10.0.0.5:8787"]) {
    assert.doesNotThrow(() => directory({ base, signer }), "building it reaches nothing, so a daemon test can start the names module");
    await assert.rejects(() => directory({ base, signer }).check("kit"), e => /** @type {any} */ (e).code === "test_guard", base);
  }
  await assert.rejects(() => directory({ signer }).check("kit"), e => /** @type {any} */ (e).code === "test_guard", "the default base is the hosted one");
  assert.doesNotThrow(() => directory({ base: "http://127.0.0.1:8787", signer }));
  let asked = 0;
  await directory({ base: "https://names.vyre.run", signer, fetch: async () => { asked++; return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) }); } }).check("kit").catch(() => {});
  assert.equal(asked, 1, "a test's own fetch never leaves the process");
});

test("names.watch: a box with no name asks the directory nothing, and makes no route key", async t => {
  const h = hosted(t), a = boxService(t, h);
  let asked = 0, identity = 0;
  const mine = a.box.client.mine;
  a.box.client.mine = async () => { asked++; return mine(); };
  a.box.signer.identity = async () => { identity++; throw new Error("no"); };
  assert.equal(await a.svc.watch(), null);
  assert.deepEqual([asked, identity], [0, 0]);
  a.cfg.network.via = "vyre.run";
  await a.svc.watch().catch(() => {});
  assert.equal(asked, 1, "once a name is held here it does watch");
});
