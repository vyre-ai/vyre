// @ts-check
// The names service against fakes: the claim flow, the listener's identity rule, the claim code
// for a tagged box, renewal. Nothing here reaches Tailscale, Cloudflare or Let's Encrypt.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as config from "../config/index.js";
import * as certs from "./certs.js";
import { names, checkName } from "./service.js";
import { tempHome } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !hasOpenssl && "openssl is needed to make a certificate";

function selfSigned(cn, days = 90) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-names-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-subj", `/O=Test CA/CN=${cn}`, "-days", String(days)], { stdio: "ignore" });
    const cert = fs.readFileSync(path.join(dir, "c.pem"), "utf8");
    return { cert, key: fs.readFileSync(path.join(dir, "k.pem"), "utf8"), expires: Date.parse(new crypto.X509Certificate(cert).validTo) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** A world of fakes, and the service built on it. */
function world(t, { tagged = false, owner = "alex@example.com", ips = ["127.0.0.1"], taken = false, agentOf = undefined, deviceOf = undefined, call = undefined, directory = undefined } = {}) {
  const root = tempHome(t);
  const cfg = config.load(root);
  cfg.network.port = 0;
  const emitted = [], records = [], calls = [];
  const ctx = {
    config: cfg, paths: config.ensure(root), log: () => {},
    events: { emit: (type, payload) => emitted.push({ type, payload }) },
    handler: () => async (req, res, caller, peer) => { calls.push(caller); if (peer && peer.origin) calls.push(`from ${peer.origin}`); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: { caller } })); },
    // A stream router that answers every upgrade it is handed, saying who the caller was.
    upgrader: () => (req, socket, head, caller) => { calls.push(`stream ${caller}`); socket.end(`HTTP/1.1 101 Switching Protocols\r\nx-caller: ${caller}\r\n\r\n`); },
    ...(call ? { call } : {}),
  };
  fs.mkdirSync(ctx.paths.certs, { recursive: true });
  const ts = {
    status: async () => ({ installed: true, running: true, backend: "Running", loginUrl: null, tun: true, why: null,
      node: { name: "box", dnsName: "box.example.ts.net", ips, stableId: "n1", tagged }, owner: tagged ? null : owner, certDomains: ["box.example.ts.net"] }),
    whois: async ip => ({ "100.101.1.2": { login: "alex@example.com", tagged: false, node: "phone" }, "100.101.1.3": { login: "sam@example.com", tagged: false, node: "laptop" },
      "100.101.3.1": { login: null, tagged: true, node: "kit", stableId: "nKIT", tags: ["tag:vyre-agent"], caps: {} },
      "100.101.4.1": { login: null, tagged: true, node: "alex-desktop", stableId: "nDESK1", tags: ["tag:vyre-device"], caps: {} },
      "100.101.4.2": { login: null, tagged: true, node: "new-desktop", stableId: "nDESK2", tags: ["tag:vyre-device"], caps: {} } })[ip] || null,
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
  const deps = { ctx, ts, certs, ...(agentOf ? { agentOf } : {}), ...(deviceOf ? { deviceOf } : {}), ...(directory ? { directory } : {}), save: p => config.save(p, root, cfg), dns: async () => dns,
    issue: async ({ names: list }) => { issued++; return selfSigned(list[0]); } };
  const svc = names(deps);
  t.after(() => svc.close());
  /** A new service on the same box, as after vyred restarts. */
  const restart = () => { const again = names(deps); t.after(() => again.close()); return again; };
  return { root, cfg, ctx, ts, svc, emitted, records, calls, issued: () => issued, restart };
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

test("names: a ts.net box serves again after vyred restarts", { skip }, async t => {
  const w = world(t);
  w.svc.fallback();
  await w.svc.wait();
  await w.svc.close();
  const again = w.restart();
  assert.equal(await again.serve(), true, "the ts.net certificate is found without a status call first");
  assert.equal(again.status().listening, true);
  assert.equal(again.status().phase, "serving");
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

test("names: whoami answers the owner and a guest minimally, refuses an agent node, and rate-limits", async t => {
  const w = world(t, { agentOf: async id => (id === "nKIT" ? "kit" : null) });
  w.cfg.name = "alex";
  w.ctx.config.computers = { tailnet: { enabled: true, tag: "tag:vyre-agent" } };
  w.ctx.config.network.guests = { enabled: true, people: { "sam@example.com": { tools: [] } } };
  await w.svc.tailscale();

  const owner = fakeRes();
  await w.svc.onRequest(fakeReq("100.101.1.2", "/v1/whoami"), owner);
  assert.equal(owner.status, 200);
  assert.deepEqual(JSON.parse(owner.body).data, { kind: "owner", name: "alex" });

  const guest = fakeRes();
  await w.svc.onRequest(fakeReq("100.101.1.3", "/v1/whoami", "GET", { "tailscale-user-login": "sam@example.com" }), guest);
  assert.equal(guest.status, 200);
  assert.deepEqual(JSON.parse(guest.body).data, { kind: "guest", name: null }, "a guest learns it is a guest, never the box's own name");

  const agent = fakeRes();
  await w.svc.onRequest(fakeReq("100.101.3.1", "/v1/whoami"), agent);
  assert.equal(agent.status, 403, "an agent's node has no join flow of its own");

  let last;
  for (let i = 0; i < 11; i++) { last = fakeRes(); await w.svc.onRequest(fakeReq("100.101.1.2", "/v1/whoami"), last); }
  assert.equal(last.status, 429, "an 11th call in the same minute is rate-limited");
});

test("names: whois naming this very node is refused even when the address list is stale", async () => {
  const { identifier } = await import("./identity.js");
  const id = identifier({ whois: async () => ({ login: "alex@example.com", tagged: false, node: "box", stableId: "nSELF" }),
    selfIps: () => [], selfId: () => "nSELF", owner: () => "alex@example.com" });
  assert.equal((await id("100.101.1.1")).why, "from this box itself");
});

/** A WebSocket upgrade to the listener, as a browser sends one; resolves to the status line and headers. */
function upgradeTo(port, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, path: "/v1/streams/computers/glass?ticket=x", rejectUnauthorized: false,
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, caller: res.headers["x-caller"] }); });
    req.on("response", res => { res.resume(); resolve({ status: res.statusCode, caller: null }); });
    req.on("error", reject);
    req.end();
  });
}

test("names: the listener takes WebSocket upgrades itself rather than routing them as requests", { skip }, async t => {
  const w = world(t, { ips: ["127.0.0.1"] });
  w.svc.claim("alex");
  await w.svc.wait();
  assert.equal(w.svc.status().phase, "serving");
  const port = Number(new URL(String(w.svc.status().address)).port);
  // The test connects from the box's own address, which the identity rule refuses; what matters
  // here is that the upgrade reached the listener's own rules. With no upgrade listener, Node
  // handed it to the request router, which answered 404 (the live box did, 27 Sep).
  const r = await upgradeTo(port, { host: `alex.vyre.run:${port}` });
  assert.equal(r.status, 403);
});

test("names: the owner's WebSockets reach vyred's streams as the owner; nobody else's do", async t => {
  const w = world(t, { agentOf: async id => id === "nKIT" ? "kit" : null });
  w.cfg.computers = { ...(w.cfg.computers || {}), tailnet: { enabled: true, tag: "tag:vyre-agent" } };
  w.cfg.name = "alex";
  await w.svc.tailscale();
  const host = "alex.vyre.run:0";
  /** An upgrade from a peer; resolves to the status line the listener wrote. */
  const up = async (ip, headers) => {
    let out = "";
    const socket = { on() {}, end(x) { out = String(x); }, destroy() {} };
    await w.svc.onUpgrade({ url: "/v1/streams/computers/glass?ticket=x", headers: { host, ...headers }, socket: { remoteAddress: ip } }, socket, Buffer.alloc(0));
    return out.split("\r\n")[0];
  };
  assert.equal(await up("100.101.1.2", { origin: `https://${host}` }), "HTTP/1.1 101 Switching Protocols");
  assert.equal(await up("100.101.1.2", {}), "HTTP/1.1 101 Switching Protocols", "a client that sends no Origin");
  assert.equal(await up("100.101.1.2", { origin: "https://evil.example" }), "HTTP/1.1 403 Forbidden", "another site's page");
  assert.equal(await up("100.101.1.2", { host: "evil.example" }), "HTTP/1.1 421 Misdirected Request", "another host name");
  assert.equal(await up("100.101.1.3", { origin: `https://${host}` }), "HTTP/1.1 403 Forbidden", "someone else on the tailnet");
  assert.equal(await up("100.101.9.9", {}), "HTTP/1.1 403 Forbidden", "an address whois does not know");
  // Streams are the owner's alone: a listed guest gets none, and nor does an agent's node, though
  // both are callers the listener knows.
  w.cfg.network.guests = { enabled: true, people: { "sam@example.com": { tools: ["threads.list"] } } };
  assert.equal(await up("100.101.1.3", { origin: `https://${host}` }), "HTTP/1.1 403 Forbidden", "a listed guest");
  assert.equal(await up("100.101.3.1", {}), "HTTP/1.1 403 Forbidden", "an agent's node");
  assert.deepEqual(w.calls.filter(c => c.startsWith("stream")),
    ["stream tailnet:alex@example.com", "stream tailnet:alex@example.com"]);
});

test("names: the hosted app's origin gets CORS for the owner, and its calls reach the router marked with it", async t => {
  const w = world(t);
  w.cfg.name = "alex";
  w.cfg.network.guests = { enabled: true, people: { "sam@example.com": { tools: ["threads.list"] } } };
  await w.svc.tailscale();
  const app = "https://app.vyre.run";
  const send = async (ip, url, method, headers) => { const r = fakeRes(); await w.svc.onRequest(fakeReq(ip, url, method, headers), r); return r; };
  // The preflight: exact origin, the allowed methods and headers, and Chrome's private-network ask.
  const pre = await send("100.101.1.2", "/v1/tools/threads.list", "OPTIONS", { origin: app, "access-control-request-method": "POST",
    "access-control-request-headers": "content-type, authorization, x-vyre-proof, x-vyre-presence, idempotency-key, last-event-id", "access-control-request-private-network": "true" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["access-control-allow-origin"], app);
  assert.equal(pre.headers["access-control-allow-private-network"], "true");
  assert.equal(pre.headers.vary, "Origin");
  assert.equal(pre.headers["access-control-allow-credentials"], undefined, "no cookies, ever");
  assert.equal((await send("100.101.1.2", "/v1/tools/x", "OPTIONS", { origin: app, "access-control-request-method": "DELETE" })).status, 403, "a method it never needs");
  for (const h of ["x-vyre-caller", "x-vyre-session"]) {
    assert.equal((await send("100.101.1.2", "/v1/tools/x", "OPTIONS", { origin: app, "access-control-request-method": "POST", "access-control-request-headers": h })).status, 403, h);
  }
  // The probe answers without vyred, and says nothing but that the box is reachable.
  const probe = await send("100.101.1.2", "/v1/health", "GET", { origin: app });
  assert.deepEqual([probe.status, JSON.parse(probe.body)], [200, { data: { reachable: true } }]);
  // A call reaches the router with the origin beside the caller (the router wants the session).
  const json = { origin: app, "content-type": "application/json" };
  const r = await send("100.101.1.2", "/v1/tools/threads.list", "POST", json);
  assert.deepEqual([r.status, r.headers["access-control-allow-origin"]], [200, app]);
  assert.deepEqual(w.calls, ["tailnet:alex@example.com", "from https://app.vyre.run"]);
  assert.equal((await send("100.101.1.2", "/v1/tools/threads.list", "POST", { origin: app, "content-type": "text/plain" })).status, 403, "still JSON only");
  // A guest or an agent's node from the same origin gets no CORS at all.
  const guest = await send("100.101.1.3", "/v1/tools/threads.list", "POST", json);
  assert.deepEqual([guest.status, guest.headers["access-control-allow-origin"]], [403, undefined]);
  const guestPre = await send("100.101.1.3", "/v1/tools/threads.list", "OPTIONS", { origin: app, "access-control-request-method": "POST" });
  assert.deepEqual([guestPre.status, guestPre.headers["access-control-allow-origin"]], [403, undefined]);
  // Another site, or the hosted origin once the owner empties the list, is refused as before.
  assert.equal((await send("100.101.1.2", "/v1/tools/threads.list", "POST", { ...json, origin: "https://app.vyre.run.evil.example" })).status, 403);
  w.cfg.network.origins = [];
  assert.equal((await send("100.101.1.2", "/v1/tools/threads.list", "POST", json)).status, 403);
  assert.equal(w.calls.length, 2);
});

test("names: a WebSocket from the hosted app is the owner's, like any other", async t => {
  const w = world(t);
  w.cfg.name = "alex";
  await w.svc.tailscale();
  const up = async (ip, headers) => {
    let out = "";
    const socket = { on() {}, end(x) { out = String(x); }, destroy() {} };
    await w.svc.onUpgrade({ url: "/v1/streams/computers/glass?ticket=x", headers: { host: "alex.vyre.run:0", ...headers }, socket: { remoteAddress: ip } }, socket, Buffer.alloc(0));
    return out.split("\r\n")[0];
  };
  assert.equal(await up("100.101.1.2", { origin: "https://app.vyre.run" }), "HTTP/1.1 101 Switching Protocols");
  assert.equal(await up("100.101.1.3", { origin: "https://app.vyre.run" }), "HTTP/1.1 403 Forbidden", "not the owner");
  w.cfg.network.origins = [];
  assert.equal(await up("100.101.1.2", { origin: "https://app.vyre.run" }), "HTTP/1.1 403 Forbidden", "the list emptied");
});

test("names: a tag:vyre-device node is its bound paired desktop, device:<id>; unbound, it may only present a bind code (ADR 0046)", async t => {
  /** @type {any[]} */
  const binds = [];
  const w = world(t, {
    deviceOf: async id => (id === "nDESK1" ? "abcdefghijklmnop" : null),
    call: async (tool, input) => { binds.push({ tool, input }); return input.code === "good" ? { data: { device: input.device, node: input.stableId } } : { error: { code: "denied", message: "that bind code has expired or was already used" } }; },
  });
  w.cfg.name = "alex";
  await w.svc.tailscale();

  const bound = fakeRes();
  await w.svc.onRequest(fakeReq("100.101.4.1", "/v1/health"), bound);
  assert.equal(bound.status, 200);
  assert.equal(JSON.parse(bound.body).data.caller, "device:abcdefghijklmnop", "never tailnet:<owner>, and never a caller made from the tag");

  const unbound = fakeRes();
  await w.svc.onRequest(fakeReq("100.101.4.2", "/v1/health"), unbound);
  assert.equal(unbound.status, 403, "an unbound device node reaches nothing but the bind");

  /** A POST with a JSON body the listener reads as a stream. */
  const post = (ip, body, headers = { "content-type": "application/json" }) => Object.assign(fakeReq(ip, "/v1/tailnet/bind", "POST", headers), {
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  });
  const ok = fakeRes();
  await w.svc.onRequest(post("100.101.4.2", { device: "qrstuvwxyzabcdef", code: "good", stableId: "nDESK1" }), ok);
  assert.equal(ok.status, 200);
  assert.deepEqual(binds.at(-1), { tool: "relay.devices.bind", input: { stableId: "nDESK2", node: "new-desktop", device: "qrstuvwxyzabcdef", code: "good" } },
    "the node id is whois's own, never the one in the body");

  const bad = fakeRes();
  await w.svc.onRequest(post("100.101.4.2", { device: "qrstuvwxyzabcdef", code: "bad" }), bad);
  assert.equal(bad.status, 403);

  const plain = fakeRes();
  await w.svc.onRequest(post("100.101.4.2", { device: "qrstuvwxyzabcdef", code: "good" }, { "content-type": "text/plain" }), plain);
  assert.equal(plain.status, 403, "a bind must be JSON, like every other POST");

  const agent = fakeRes();
  await w.svc.onRequest(post("100.101.3.1", { device: "qrstuvwxyzabcdef", code: "good" }), agent);
  assert.equal(agent.status, 403, "only a tag:vyre-device node may present a bind code");
  assert.equal(binds.length, 2, "neither refused request reached the relay");
});

test("names: a box whose name support moved to another server is told once, and a normal answer tells nothing", async t => {
  const answers = [{ name: null, moved: { name: "alex", at: 5 } }, { name: null, moved: { name: "alex", at: 5 } }, { name: null }];
  const w = world(t, { directory: { mine: async () => answers.shift() } });
  w.cfg.name = "alex";
  w.cfg.network.via = "vyre.run";
  await w.svc.watch();
  await w.svc.watch();
  await w.svc.watch();
  assert.deepEqual(w.emitted.filter(e => e.type === "name.moved").map(e => e.payload), [{ name: "alex.vyre.run", at: 5 }]);
});
