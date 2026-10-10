// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import { createGate, NOT_FOUND, certPin, parseHeadscaleLog, addrKey, INGRESS_BODY_LIMIT as INGRESS_LIMIT } from "./gate.js";
import { selfSigned } from "./testing/selfsigned.js";
import { encodeProxyV2 } from "../../../lib/publish/proxy.js";

/** A fake Headscale: records every request, answers /key, upgrades /ts2021 and /derp into an echo. */
async function backend() {
  /** @type {{ method: string, url: string, headers: Record<string, any> }[]} */ const seen = [];
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    seen.push({ method: /** @type {string} */ (req.method), url: /** @type {string} */ (req.url), headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ publicKey: "mkey:fake" }));
  });
  srv.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  srv.on("upgrade", (req, socket, head) => {
    seen.push({ method: /** @type {string} */ (req.method), url: /** @type {string} */ (req.url), headers: req.headers });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: " + req.headers.upgrade + "\r\nConnection: Upgrade\r\n\r\n");
    if (head.length) socket.write(Buffer.concat([Buffer.from("HEAD:"), head]));
    socket.on("data", d => socket.write(Buffer.concat([Buffer.from("echo:"), d])));
    socket.on("error", () => {});
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  return { seen, port: /** @type {net.AddressInfo} */ (srv.address()).port, close: () => { for (const s of sockets) s.destroy(); srv.close(); } };
}

/** @param {import("node:test").TestContext} t @param {object} [o] */
async function setup(t, o = {}) {
  const be = await backend();
  const events = [];
  const gate = createGate({ upstream: { port: be.port }, onEvent: e => events.push(e), ...o });
  await gate.listen();
  t.after(async () => { await gate.close(); be.close(); });
  return { be, gate, events, port: /** @type {number} */ (gate.address()?.port) };
}

/** One raw request; resolves to everything the server sent until it closed. */
function raw(port, bytes, { wait = 1500 } = {}) {
  return new Promise(resolve => {
    const chunks = [];
    const c = net.connect(port, "127.0.0.1", () => c.write(bytes));
    c.on("data", d => chunks.push(d));
    const done = () => resolve(Buffer.concat(chunks));
    c.on("close", done); c.on("error", done);
    setTimeout(() => { c.destroy(); }, wait).unref();
  });
}

const get = (p, extra = "") => `GET ${p} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`;

test("gate: only the allow-listed paths reach the backend", async t => {
  const { be, port } = await setup(t, { derp: false });
  const ok = await raw(port, get("/key?v=130", "Connection: close\r\n"));
  assert.match(ok.toString(), /^HTTP\/1\.1 200 /);
  assert.match(ok.toString(), /mkey:fake/);
  assert.equal(be.seen.length, 1);
  assert.equal(be.seen[0].url, "/key?v=130");
  const bad = ["/", "/key/", "/key/..", "/KEY", "/%6bey", "//key", "/key%00", "/api/v1/node", "/ts2021", "/derp", "/derp/probe", "/metrics", "/debug/pprof/", "/admin", "/machine/register", "/key;x", "/ts2021/x", "/a/../key", "http://x/key", "*"];
  for (const p of bad) await raw(port, get(p, "Connection: close\r\n"));
  assert.equal(be.seen.length, 1, "nothing else was forwarded: " + JSON.stringify(be.seen.map(s => s.url)));
});

test("gate: wrong methods and odd query strings on allowed paths are refused", async t => {
  const { be, port } = await setup(t);
  for (const req of [
    "POST /key HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    "DELETE /key HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    "GET /key?a=%0d%0a HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    "GET /key?" + "a".repeat(100) + " HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    "GET /ts2021 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", // not an upgrade
    "GET /key HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    "POST /ts2021 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  ]) assert.deepEqual(await raw(port, req), NOT_FOUND);
  assert.equal(be.seen.length, 0);
});

test("gate: unknown paths are byte-identical 404s, with no banner", async t => {
  const { port } = await setup(t);
  const a = await raw(port, get("/anything", "Connection: close\r\n"));
  const b = await raw(port, get("/other/thing?x=1", "User-Agent: z\r\nConnection: close\r\n"));
  const c = await raw(port, "POST /x HTTP/1.1\r\nHost: y\r\nContent-Length: 3\r\n\r\nabc");
  const d = await raw(port, "NOT HTTP AT ALL\r\n\r\n");
  for (const r of [a, b, c, d]) assert.deepEqual(r, NOT_FOUND);
  const txt = NOT_FOUND.toString().toLowerCase();
  assert.ok(!/server:|date:|node|headscale|version/.test(txt));
});

test("gate: client-supplied forwarding headers are dropped and replaced from the socket", async t => {
  const { be, port } = await setup(t);
  await raw(port, get("/key", "X-Forwarded-For: 6.6.6.6\r\nTrue-Client-IP: 7.7.7.7\r\nX-Real-IP: 8.8.8.8\r\nForwarded: for=9.9.9.9\r\nX-Forwarded-Host: evil\r\nVia: 1.1 x\r\nCF-Connecting-IP: 5.5.5.5\r\nConnection: close\r\n"));
  const h = be.seen[0].headers;
  assert.equal(h["x-forwarded-for"], "127.0.0.1");
  assert.equal(h["true-client-ip"], "127.0.0.1");
  assert.equal(h["x-real-ip"], "127.0.0.1");
  for (const n of ["forwarded", "x-forwarded-host", "via", "cf-connecting-ip"]) assert.equal(h[n], undefined, n);
  // and on the upgrade path
  const r = await raw(port, "POST /ts2021 HTTP/1.1\r\nHost: x\r\nUpgrade: tailscale-control-protocol\r\nConnection: Upgrade\r\nX-Forwarded-For: 6.6.6.6\r\nTrue-Client-IP: 7.7.7.7\r\n\r\n", { wait: 400 });
  assert.match(r.toString(), /101 Switching/);
  const u = be.seen[1].headers;
  assert.equal(u["x-forwarded-for"], "127.0.0.1"); assert.equal(u["true-client-ip"], "127.0.0.1");
});

test("gate: a trusted forwarder names the real address in one header; an untrusted peer cannot", async t => {
  const trusted = await setup(t, { forwarder: { trust: ["127.0.0.0/8"], header: "X-Vyre-Real-Addr" } });
  await raw(trusted.port, get("/key", "X-Vyre-Real-Addr: 203.0.113.9\r\nX-Forwarded-For: 1.1.1.1\r\nConnection: close\r\n"));
  assert.equal(trusted.be.seen[0].headers["x-forwarded-for"], "203.0.113.9");
  assert.equal(trusted.be.seen[0].headers["x-vyre-real-addr"], undefined, "the private header is not passed on");
  await raw(trusted.port, get("/key", "X-Vyre-Real-Addr: not-an-ip\r\nConnection: close\r\n"));
  assert.equal(trusted.be.seen[1].headers["x-forwarded-for"], "127.0.0.1");
  const other = await setup(t, { forwarder: { trust: ["10.9.9.9"], header: "X-Vyre-Real-Addr" } });
  await raw(other.port, get("/key", "X-Vyre-Real-Addr: 203.0.113.9\r\nConnection: close\r\n"));
  assert.equal(other.be.seen[0].headers["x-forwarded-for"], "127.0.0.1", "an untrusted peer's claim is ignored");
});

test("gate: a forwarder's clients keep separate budgets", async t => {
  const { port, gate } = await setup(t, { forwarder: { trust: ["127.0.0.1"], header: "x-vyre-real-addr" }, limits: { upgradesPerWindow: 2 } });
  const up = ip => `POST /ts2021 HTTP/1.1\r\nHost: x\r\nUpgrade: tailscale-control-protocol\r\nConnection: Upgrade\r\nX-Vyre-Real-Addr: ${ip}\r\n\r\n`;
  for (let i = 0; i < 2; i++) assert.match((await raw(port, up("203.0.113.1"), { wait: 200 })).toString(), /101/);
  assert.match((await raw(port, up("203.0.113.1"), { wait: 200 })).toString(), /429/);
  assert.match((await raw(port, up("203.0.113.2"), { wait: 200 })).toString(), /101/, "another client of the same forwarder is untouched");
  assert.ok(gate.stats().limited >= 1);
});

test("gate: upgrades pass bytes both ways, including bytes sent with the request", async t => {
  const { port } = await setup(t);
  const out = await new Promise(resolve => {
    const c = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0), stage = 0;
    c.on("connect", () => c.write("POST /ts2021 HTTP/1.1\r\nHost: x\r\nUpgrade: tailscale-control-protocol\r\nConnection: Upgrade\r\nX-Tailscale-Handshake: abc\r\n\r\nearly"));
    c.on("data", d => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.includes("HEAD:early")) { stage = 1; c.write(Buffer.from([1, 2, 3, 250, 0, 7])); }
      if (stage === 1 && buf.includes(Buffer.concat([Buffer.from("echo:"), Buffer.from([1, 2, 3, 250, 0, 7])]))) { c.destroy(); resolve(buf); }
    });
    setTimeout(() => { c.destroy(); resolve(buf); }, 3000).unref();
  });
  assert.match(/** @type {Buffer} */ (out).toString("latin1"), /101 Switching Protocols/);
  assert.ok(/** @type {Buffer} */ (out).includes(Buffer.concat([Buffer.from("echo:"), Buffer.from([1, 2, 3, 250, 0, 7])])), "binary bytes came back through");
});

test("gate: DERP paths exist only when DERP is on", async t => {
  const off = await setup(t, { derp: false });
  const derp = "GET /derp HTTP/1.1\r\nHost: x\r\nUpgrade: DERP\r\nConnection: Upgrade\r\n\r\n";
  assert.deepEqual(await raw(off.port, derp), NOT_FOUND);
  assert.deepEqual(await raw(off.port, get("/derp/probe", "Connection: close\r\n")), NOT_FOUND);
  assert.equal(off.be.seen.length, 0);
  const on = await setup(t, { derp: true });
  assert.match((await raw(on.port, derp, { wait: 300 })).toString(), /101/);
  assert.match((await raw(on.port, get("/derp/probe", "Connection: close\r\n"))).toString(), /^HTTP\/1\.1 200/);
  assert.deepEqual(on.be.seen.map(s => s.url), ["/derp", "/derp/probe"]);
  assert.deepEqual(await raw(on.port, get("/derp/other", "Connection: close\r\n")), NOT_FOUND);
});

test("gate: limits trip (upgrades per window, concurrent upgrades, connections, a body on /key)", async t => {
  const rate = await setup(t, { limits: { upgradesPerWindow: 3 } });
  const up = "POST /ts2021 HTTP/1.1\r\nHost: x\r\nUpgrade: tailscale-control-protocol\r\nConnection: Upgrade\r\n\r\n";
  const res = [];
  for (let i = 0; i < 5; i++) res.push((await raw(rate.port, up, { wait: 150 })).toString().slice(0, 12));
  assert.deepEqual(res, ["HTTP/1.1 101", "HTTP/1.1 101", "HTTP/1.1 101", "HTTP/1.1 429", "HTTP/1.1 429"]);
  assert.equal(rate.gate.stats().limited, 2);

  const conc = await setup(t, { limits: { maxConcurrentUpgrades: 2 } });
  const held = [];
  for (let i = 0; i < 2; i++) { const c = net.connect(conc.port, "127.0.0.1"); c.write(up); c.on("error", () => {}); held.push(c); }
  await new Promise(r => setTimeout(r, 300));
  assert.match((await raw(conc.port, up, { wait: 200 })).toString(), /429/);
  for (const c of held) c.destroy();
  await new Promise(r => setTimeout(r, 2200)); // the gate lets bytes in flight drain for 1.5 s
  assert.match((await raw(conc.port, up, { wait: 200 })).toString(), /101/, "a slot frees when a session ends");

  const conns = await setup(t, { limits: { maxConnsPerAddr: 3 } });
  const idle = [];
  for (let i = 0; i < 6; i++) { const c = net.connect(conns.port, "127.0.0.1"); c.on("error", () => {}); idle.push(c); }
  await new Promise(r => setTimeout(r, 300));
  assert.equal(conns.gate.stats().limited, 3);
  assert.equal(idle.filter(c => c.destroyed).length, 3);
  for (const c of idle) c.destroy();

  const body = await setup(t, { limits: { maxBodyBytes: 8 } });
  assert.deepEqual(await raw(body.port, "GET /key HTTP/1.1\r\nHost: x\r\nContent-Length: 9\r\nConnection: close\r\n\r\n123456789"), NOT_FOUND);
  assert.deepEqual(await raw(body.port, "GET /key HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n"), NOT_FOUND);
  assert.equal(body.be.seen.length, 0);
});

test("gate: header size, header time, idle time and the handshake deadline", async t => {
  const big = await setup(t, { limits: { maxHeaderBytes: 1024 } });
  const r = await raw(big.port, get("/key", "X-Pad: " + "a".repeat(4000) + "\r\nConnection: close\r\n"));
  assert.deepEqual(r, NOT_FOUND);
  assert.equal(big.be.seen.length, 0);

  const slow = await setup(t, { limits: { idleMs: 200 } });
  const t0 = Date.now();
  await raw(slow.port, "GET /key HTTP/1.1\r\nHost: x\r\n", { wait: 3000 }); // never finishes the head
  assert.ok(Date.now() - t0 < 2000, "an idle connection is dropped");
  assert.ok(slow.gate.stats().timeouts >= 1);

  // a backend that never answers an upgrade: the handshake deadline closes it
  const silent = net.createServer(s => { s.on("data", () => {}); s.on("error", () => {}); });
  await new Promise(r => silent.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => silent.close());
  const gate = createGate({ upstream: { port: /** @type {net.AddressInfo} */ (silent.address()).port }, limits: { handshakeMs: 250 } });
  await gate.listen(); t.after(() => gate.close());
  const t1 = Date.now();
  await raw(/** @type {number} */ (gate.address()?.port), "POST /ts2021 HTTP/1.1\r\nHost: x\r\nUpgrade: tailscale-control-protocol\r\nConnection: Upgrade\r\n\r\n", { wait: 4000 });
  assert.ok(Date.now() - t1 < 2000, "closed by the handshake deadline");
  assert.ok(gate.stats().timeouts >= 1);
});

test("gate: an unreachable backend answers 503, not a hang or a crash", async t => {
  const dead = net.createServer(); await new Promise(r => dead.listen(0, "127.0.0.1", () => r(undefined)));
  const p = /** @type {net.AddressInfo} */ (dead.address()).port; dead.close();
  const gate = createGate({ upstream: { port: p } }); await gate.listen(); t.after(() => gate.close());
  const port = /** @type {number} */ (gate.address()?.port);
  assert.match((await raw(port, get("/key", "Connection: close\r\n"))).toString(), /^HTTP\/1\.1 503/);
  assert.match((await raw(port, "POST /ts2021 HTTP/1.1\r\nHost: x\r\nUpgrade: tailscale-control-protocol\r\nConnection: Upgrade\r\n\r\n")).toString(), /^HTTP\/1\.1 503/);
});

test("gate: Headscale's log blocks an address that keeps failing; a fake log, no network", async t => {
  const { port, gate, be } = await setup(t, { limits: { failThreshold: 3 } });
  const line = (addr, status, p = "/machine/register") => `2026-10-03T13:33:31Z INF http request bytes=254 elapsed=1.2 method=POST path=${p} proto=HTTP/2.0 remote=${addr}:53326 status=${status}`;
  assert.deepEqual(parseHeadscaleLog(line("203.0.113.5", 401)), { addr: "203.0.113.5", path: "/machine/register", status: 401 });
  // the line a real v0.29.4 wrote when the gate's address was honoured (no source port after the address)
  assert.deepEqual(parseHeadscaleLog("2026-10-03T14:12:15Z INF http request bytes=254 elapsed=990.3 method=POST path=/machine/register proto=HTTP/2.0 remote=203.0.113.7 status=401"),
    { addr: "203.0.113.7", path: "/machine/register", status: 401 });
  assert.equal(parseHeadscaleLog("INF something else"), null);
  gate.reportLog(line("203.0.113.5", 200)); gate.reportLog(line("203.0.113.5", 200)); gate.reportLog(line("203.0.113.5", 200));
  gate.reportLog(line("127.0.0.1", 401, "/api/v1/user"));
  assert.equal(gate.isBlocked("203.0.113.5"), false, "successes and unrelated paths do not count");
  for (let i = 0; i < 3; i++) gate.reportLog(line("203.0.113.5", i === 1 ? 401 : 403));
  assert.equal(gate.isBlocked("203.0.113.5"), true);
  assert.equal(gate.isBlocked("203.0.113.6"), false);
  // the blocked address, arriving as the real address from a trusted forwarder, gets nothing
  const f = await setup(t, { forwarder: { trust: ["127.0.0.1"], header: "x-real" }, limits: { failThreshold: 1 } });
  f.gate.reportLog(line("203.0.113.5", 401));
  assert.deepEqual(await raw(f.port, get("/key", "X-Real: 203.0.113.5\r\nConnection: close\r\n")), Buffer.alloc(0));
  assert.equal(f.be.seen.length, 0);
  assert.match((await raw(f.port, get("/key", "X-Real: 203.0.113.6\r\nConnection: close\r\n"))).toString(), /200/);
  // our own address is blocked when the socket address is the failing one
  gate.block("127.0.0.1", 60_000);
  assert.deepEqual(await raw(port, get("/key", "Connection: close\r\n")), Buffer.alloc(0));
  gate.unblock("127.0.0.1");
  assert.match((await raw(port, get("/key", "Connection: close\r\n"))).toString(), /200/);
  void be;
});

test("addrKey: IPv6 counts per /64", () => {
  assert.equal(addrKey("2001:db8:1:2:3:4:5:6"), addrKey("2001:db8:1:2::9"));
  assert.notEqual(addrKey("2001:db8:1:2::1"), addrKey("2001:db8:1:3::1"));
  assert.equal(addrKey("::ffff:1.2.3.4"), "1.2.3.4");
});

test("gate over TLS: terminates with the supplied certificate, exposes its pin, forwards the same way", async t => {
  const { cert, key } = selfSigned({ ips: ["127.0.0.1"] });
  const { be, gate, port } = await setup(t, { tls: { cert, key } });
  assert.equal(gate.pin, certPin(cert));
  assert.match(/** @type {string} */ (gate.pin), /^sha256\/[A-Za-z0-9+/]{43}=$/);
  const body = await new Promise((resolve, reject) => {
    https.get({ host: "127.0.0.1", port, path: "/key?v=1", ca: cert, servername: "localhost" }, res => {
      let b = ""; res.on("data", d => (b += d)); res.on("end", () => resolve({ status: res.statusCode, b, headers: res.headers }));
    }).on("error", reject);
  });
  assert.equal(/** @type {any} */ (body).status, 200);
  assert.equal(/** @type {any} */ (body).headers.server, undefined);
  assert.equal(be.seen[0].headers["x-forwarded-for"], "127.0.0.1");
  // unknown path over TLS: the same bytes
  const bytes = await new Promise(resolve => {
    const c = tls.connect({ host: "127.0.0.1", port, ca: cert, servername: "localhost" }, () => c.write(get("/nope", "Connection: close\r\n")));
    const ch = []; c.on("data", d => ch.push(d)); c.on("close", () => resolve(Buffer.concat(ch))); c.on("error", () => resolve(Buffer.concat(ch)));
  });
  assert.deepEqual(bytes, NOT_FOUND);
  // a client that does not speak TLS is dropped
  assert.deepEqual(await raw(port, get("/key", "Connection: close\r\n"), { wait: 800 }).then(b => b.toString().startsWith("HTTP/1.1 200")), false);
});

test("gate: TLS to the upstream, pinned", async t => {
  const { cert, key } = selfSigned({ ips: ["127.0.0.1"] });
  const seen = [];
  const up = https.createServer({ cert, key }, (req, res) => { seen.push(req.url); res.end("{}"); });
  await new Promise(r => up.listen(0, "127.0.0.1", () => r(undefined))); t.after(() => up.close());
  const upPort = /** @type {net.AddressInfo} */ (up.address()).port;
  const good = createGate({ upstream: { port: upPort, tls: true, pin: certPin(cert) } });
  await good.listen(); t.after(() => good.close());
  assert.match((await raw(/** @type {number} */ (good.address()?.port), get("/key", "Connection: close\r\n"))).toString(), /^HTTP\/1\.1 200/);
  const bad = createGate({ upstream: { port: upPort, tls: true, pin: certPin(selfSigned().cert) } });
  await bad.listen(); t.after(() => bad.close());
  assert.match((await raw(/** @type {number} */ (bad.address()?.port), get("/key", "Connection: close\r\n"))).toString(), /^HTTP\/1\.1 503/);
  assert.equal(seen.length, 1);
});

// ---- public ingress: two loopback listeners, by exact shape, and nothing else ----

/** A fake hooks listener and a fake share server on loopback; they record every request. */
async function listeners() {
  /** @type {{ who: string, method: string, url: string, headers: Record<string, any>, body: string }[]} */ const seen = [];
  const mk = who => http.createServer((req, res) => {
    let b = ""; req.on("data", d => (b += d));
    req.on("end", () => { seen.push({ who, method: /** @type {string} */ (req.method), url: /** @type {string} */ (req.url), headers: req.headers, body: b }); res.writeHead(who === "hooks" ? 202 : 200, { "content-type": "text/plain", "x-who": who }); res.end(req.method === "HEAD" ? undefined : who === "hooks" ? "" : "shared page"); });
  });
  const hooks = mk("hooks"), share = mk("share");
  await new Promise(r => hooks.listen(0, "127.0.0.1", () => r(undefined)));
  await new Promise(r => share.listen(0, "127.0.0.1", () => r(undefined)));
  return { seen, hooksPort: /** @type {net.AddressInfo} */ (hooks.address()).port, sharePort: /** @type {net.AddressInfo} */ (share.address()).port, close() { hooks.close(); share.close(); hooks.closeAllConnections(); share.closeAllConnections(); } };
}
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv_-0123456789";
const post = (p, body, extra = "") => `POST ${p} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`;

test("gate ingress: a signed webhook and a share link reach their own loopback listener, with the real address and no spoofed headers", async t => {
  const ls = await listeners(); t.after(() => ls.close());
  const { be, port } = await setup(t, { ingress: { hooks: () => ls.hooksPort, share: () => ls.sharePort } });
  const h = (await raw(port, post("/hooks/northwind-orders", '{"a":1}', "X-Hub-Signature-256: sha256=abc\r\nX-Forwarded-For: 6.6.6.6\r\nTrue-Client-IP: 6.6.6.6\r\n"))).toString();
  assert.match(h, /^HTTP\/1\.1 202 /);
  assert.deepEqual(ls.seen.map(s => [s.who, s.method, s.url, s.body]), [["hooks", "POST", "/hooks/northwind-orders", '{"a":1}']]);
  assert.equal(ls.seen[0].headers["x-hub-signature-256"], "sha256=abc", "the signature header reaches the home");
  assert.equal(ls.seen[0].headers["x-forwarded-for"], "127.0.0.1", "a client's own forwarding header is replaced by the socket's address");
  assert.equal(ls.seen[0].headers["true-client-ip"], undefined);
  const s = (await raw(port, get(`/s/${TOKEN}`, "Range: bytes=0-3\r\nConnection: close\r\n"))).toString();
  assert.match(s, /^HTTP\/1\.1 200 /);
  assert.match(s, /shared page/);
  assert.equal(ls.seen[1].who, "share"); assert.equal(ls.seen[1].headers.range, "bytes=0-3");
  const hd = (await raw(port, `HEAD /s/${TOKEN}/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).toString();
  assert.match(hd, /^HTTP\/1\.1 200 /);
  assert.equal(be.seen.length, 0, "Headscale was never asked");
  assert.doesNotMatch(s + h, /server:|node|headscale/i);
});

test("gate ingress: everything that is not exactly those two shapes is the same 404 and reaches nothing", async t => {
  const ls = await listeners(); t.after(() => ls.close());
  const { be, port } = await setup(t, { ingress: { hooks: () => ls.hooksPort, share: () => ls.sharePort } });
  const big = "x".repeat(INGRESS_LIMIT + 1);
  const cases = [
    get("/hooks/northwind-orders", "Connection: close\r\n"),                                  // wrong method
    post("/hooks/northwind-orders?x=1", "{}"), post("/hooks/Northwind", "{}"), post("/hooks/a/b", "{}"), post("/hooks/", "{}"), post("/hooks", "{}"), post("/hooks/-a", "{}"),
    post("/hooks/" + "a".repeat(41), "{}"), post("/hooks/%61bc", "{}"), post("//hooks/abc", "{}"), post("/hooks/abc/", "{}"),
    post("/hooks/abc", big),                                                                  // over 256 KB
    "POST /hooks/abc HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",   // wrong type
    "POST /hooks/abc HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
    "POST /hooks/abc HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",     // no length
    "PUT /hooks/abc HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    post(`/s/${TOKEN}`, "{}"), get(`/s/${TOKEN}?x=1`, "Connection: close\r\n"), get(`/s/${TOKEN}/x`, "Connection: close\r\n"), get("/s/short", "Connection: close\r\n"), get("/s/", "Connection: close\r\n"),
    get(`/s/${TOKEN}`, "Upgrade: websocket\r\nConnection: Upgrade\r\n"), get(`/s/${"a".repeat(65)}`, "Connection: close\r\n"),
    get("/", "Connection: close\r\n"), get("/health", "Connection: close\r\n"), get("/api/v1/node", "Connection: close\r\n"), get("/artifacts", "Connection: close\r\n"), get("/.env", "Connection: close\r\n"),
    get("/ts2021", "Connection: close\r\n"), get("/derp", "Connection: close\r\n"), get("/mcp", "Connection: close\r\n"), get("/webhook", "Connection: close\r\n"),
  ];
  for (const c of cases) assert.deepEqual(await raw(port, c), NOT_FOUND, c.split("\r\n")[0]);
  assert.deepEqual(ls.seen, [], "no listener was reached");
  assert.equal(be.seen.length, 0, "Headscale was not reached by an ingress shape");
});

test("gate ingress: off unless set, and a listener that is not up answers the same 404", async t => {
  const ls = await listeners(); t.after(() => ls.close());
  const off = await setup(t);
  assert.deepEqual(await raw(off.port, post("/hooks/abc", "{}")), NOT_FOUND);
  assert.deepEqual(await raw(off.port, get(`/s/${TOKEN}`, "Connection: close\r\n")), NOT_FOUND);
  const { port } = await setup(t, { ingress: { hooks: () => null, share: async () => { throw new Error("down"); } } });
  assert.deepEqual(await raw(port, post("/hooks/abc", "{}")), NOT_FOUND);
  assert.deepEqual(await raw(port, get(`/s/${TOKEN}`, "Connection: close\r\n")), NOT_FOUND);
  assert.deepEqual(ls.seen, []);
});

test("gate ingress: an address that sends too many gets 429 and the next address still gets in", async t => {
  const ls = await listeners(); t.after(() => ls.close());
  const { port } = await setup(t, { ingress: { hooks: () => ls.hooksPort, share: () => ls.sharePort } });
  let limited = 0;
  for (let i = 0; i < 130; i++) if ((await raw(port, get(`/s/${TOKEN}`, "Connection: close\r\n"))).toString().startsWith("HTTP/1.1 429")) limited++;
  assert.ok(limited >= 10, `limited ${limited}`);
});

test("gate ingress: a sender that lies about its length never gets more than the declared bytes to the home's listener", async t => {
  const ls = await listeners(); t.after(() => ls.close());
  const { port } = await setup(t, { ingress: { hooks: () => ls.hooksPort, share: () => ls.sharePort } });
  await raw(port, `POST /hooks/abc HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}${"y".repeat(5000)}`);
  assert.ok(ls.seen.every(s => s.body === "{}" || s.body === ""), JSON.stringify(ls.seen.map(s => s.body.length)));
  assert.ok(!ls.seen.some(s => s.body.includes("y")));
});

// ---- app hosts: <module>.<name>.vyre.run, matched against the running apps before anything is read ----

/** A fake apps front: records every request with its Host and body, answers by echoing the method and Host. */
async function appsFront() {
  /** @type {{ method: string, url: string, headers: Record<string, any>, body: Buffer }[]} */ const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", d => chunks.push(d));
    req.on("end", () => { seen.push({ method: /** @type {string} */ (req.method), url: /** @type {string} */ (req.url), headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(200, { "content-type": "text/plain", "x-front": "1", "set-cookie": "vyre_app=t; Path=/" }); res.end(`${req.method} ${req.headers.host}`); });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  return { seen, port: /** @type {net.AddressInfo} */ (srv.address()).port, close() { srv.close(); srv.closeAllConnections(); } };
}
const SUFFIX = ".alex.vyre.run";
const appsOf = (/** @type {{ port: number }} */ f, hosts = ["docuseal.alex.vyre.run"]) => ({ apps: () => ({ port: f.port, hosts }), appsSuffix: SUFFIX });
const req = (method, host, p, { body = "", headers = "" } = {}) => `${method} ${p} HTTP/1.1\r\nHost: ${host}\r\n${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ""}Connection: close\r\n${headers}\r\n${body}`;

test("gate apps: a running app's host reaches the apps' front with the Host kept, any method and path, the real address, and Headscale is never asked", async t => {
  const f = await appsFront(); t.after(() => f.close());
  const { be, port } = await setup(t, { ingress: { hooks: () => null, share: () => null, ...appsOf(f) } });
  const r = (await raw(port, req("PUT", "docuseal.alex.vyre.run:7443", "/templates/1?x=2", { body: '{"a":1}', headers: "X-Forwarded-For: 6.6.6.6\r\nTrue-Client-IP: 6.6.6.6\r\nCookie: vyre_app=abc\r\nOrigin: https://docuseal.alex.vyre.run:7443\r\n" }))).toString();
  assert.match(r, /^HTTP\/1\.1 200 /);
  assert.match(r, /PUT docuseal\.alex\.vyre\.run:7443\r\n/);
  assert.match(r, /set-cookie: vyre_app=t/i, "the front's cookie goes back");
  assert.deepEqual([f.seen[0].method, f.seen[0].url, f.seen[0].body.toString()], ["PUT", "/templates/1?x=2", '{"a":1}']);
  assert.equal(f.seen[0].headers.host, "docuseal.alex.vyre.run:7443");
  assert.equal(f.seen[0].headers["x-forwarded-for"], "127.0.0.1", "a client's own forwarding header is replaced");
  assert.equal(f.seen[0].headers["true-client-ip"], undefined);
  assert.equal(f.seen[0].headers.cookie, "vyre_app=abc");
  // an app host never reaches Headscale's paths, whatever the path
  const k = (await raw(port, req("GET", "docuseal.alex.vyre.run", "/key?v=130"))).toString();
  assert.match(k, /^HTTP\/1\.1 200 /);
  assert.equal(be.seen.length, 0, "Headscale was never asked");
  assert.equal(f.seen[1].url, "/key?v=130", "the front got the /key");
});

test("gate apps: an unknown or malformed label, the name itself and a list that is empty or down are the same 404, and nothing is read or carried", async t => {
  const f = await appsFront(); t.after(() => f.close());
  const bodyOf = "x".repeat(50_000);
  for (const host of ["nothere.alex.vyre.run", "docuseal.alex.vyre.run.evil.test", "a.b.alex.vyre.run", "-x.alex.vyre.run", "Docu_seal.alex.vyre.run", ".alex.vyre.run", "alex.vyre.run", "docuseal.bob.vyre.run"]) {
    const { be, port } = await setup(t, { ingress: { hooks: () => null, share: () => null, ...appsOf(f) } });
    const r = await raw(port, req("POST", host, "/save", { body: bodyOf }));
    if (host === "alex.vyre.run" || host === "docuseal.bob.vyre.run" || host === "docuseal.alex.vyre.run.evil.test") assert.match(r.toString(), /^HTTP\/1\.1 404 /, host + ": the ordinary path answers 404 too (not an app host)");
    else assert.deepEqual(r, NOT_FOUND, host);
    assert.equal(be.seen.length, 0, host + ": nothing reached Headscale");
  }
  assert.equal(f.seen.length, 0, "the front was never asked for any of them");
  for (const apps of [() => null, () => ({ port: f.port, hosts: [] }), () => { throw new Error("down"); }, async () => ({ port: 0, hosts: ["docuseal.alex.vyre.run"] }), () => ({ port: f.port, hosts: "docuseal.alex.vyre.run" })]) {
    const { port } = await setup(t, { ingress: { hooks: () => null, share: () => null, apps, appsSuffix: SUFFIX } });
    assert.deepEqual(await raw(port, req("GET", "docuseal.alex.vyre.run", "/")), NOT_FOUND);
  }
  assert.equal(f.seen.length, 0);
});

test("gate apps: the host list is asked before the body is read, and an app with no ingress.apps is not an app host at all", async t => {
  const f = await appsFront(); t.after(() => f.close());
  let asked = 0;
  const { port } = await setup(t, { ingress: { hooks: () => null, share: () => null, appsSuffix: SUFFIX, apps: () => { asked++; return { port: f.port, hosts: [] }; } } });
  // declare a big body and send none of it: the answer comes without waiting for it
  const t0 = Date.now();
  const r = await raw(port, `POST /x HTTP/1.1\r\nHost: nothere.alex.vyre.run\r\nContent-Length: 10000000\r\nConnection: close\r\n\r\n`, { wait: 3000 });
  assert.deepEqual(r, NOT_FOUND);
  assert.ok(Date.now() - t0 < 2500, "answered without reading the body");
  assert.equal(asked, 1);
  const off = await setup(t, { ingress: { hooks: () => null, share: () => null } });
  assert.match((await raw(off.port, req("GET", "docuseal.alex.vyre.run", "/key"))).toString(), /^HTTP\/1\.1 200 /, "no apps option: the host header means nothing");
});

test("gate apps: the per-address budget, a refused upgrade, and the body limit (declared and streamed)", async t => {
  const f = await appsFront(); t.after(() => f.close());
  const { port } = await setup(t, { ingress: { hooks: () => null, share: () => null, ...appsOf(f) }, limits: { appsPerWindow: 3, appsBodyBytes: 1000 } });
  const ok = [];
  for (let i = 0; i < 3; i++) ok.push((await raw(port, req("GET", "docuseal.alex.vyre.run", "/"))).toString().slice(0, 12));
  assert.deepEqual(ok, ["HTTP/1.1 200", "HTTP/1.1 200", "HTTP/1.1 200"]);
  assert.match((await raw(port, req("GET", "docuseal.alex.vyre.run", "/"))).toString(), /^HTTP\/1\.1 429 /, "the fourth in the window is limited");
  assert.match((await raw(port, req("GET", "nothere.alex.vyre.run", "/"))).toString(), /^HTTP\/1\.1 429 /, "unknown labels spend the same budget");
  const g = await appsFront(); t.after(() => g.close());
  const big = await setup(t, { ingress: { hooks: () => null, share: () => null, ...appsOf(g) }, limits: { appsBodyBytes: 1000 } });
  assert.match((await raw(big.port, req("POST", "docuseal.alex.vyre.run", "/up", { body: "x".repeat(1001) }))).toString(), /^HTTP\/1\.1 413 /, "declared over the limit");
  assert.equal(g.seen.length, 0);
  assert.match((await raw(big.port, req("POST", "docuseal.alex.vyre.run", "/up", { body: "x".repeat(1000) }))).toString(), /^HTTP\/1\.1 200 /, "at the limit is fine");
  const chunked = `POST /up HTTP/1.1\r\nHost: docuseal.alex.vyre.run\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${(1200).toString(16)}\r\n${"x".repeat(1200)}\r\n0\r\n\r\n`;
  const c = (await raw(big.port, chunked)).toString();
  assert.doesNotMatch(c, /^HTTP\/1\.1 200 /, "a streamed body over the limit is cut");
  // a WebSocket upgrade on an app host is carried to the front, which decides (this front takes none, so nothing opens); the gate's own refusal is for what is not a WebSocket on a running app
  const up = await raw(big.port, `GET /cable HTTP/1.1\r\nHost: docuseal.alex.vyre.run\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  assert.doesNotMatch(up.toString(), /^HTTP\/1\.1 101 /);
});

test("gate apps over TLS: the SNI must be the Host; one label under the name is served, anything else is the 404", async t => {
  const f = await appsFront(); t.after(() => f.close());
  const { cert, key } = selfSigned({ ips: ["127.0.0.1"], names: ["localhost", "docuseal.alex.vyre.run", "other.alex.vyre.run"] });
  const { port } = await setup(t, { tls: { cert, key }, ingress: { hooks: () => null, share: () => null, ...appsOf(f) } });
  const via = (servername, host) => new Promise(resolve => {
    const chunks = [];
    const c = tls.connect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false }, () => c.write(req("GET", host, "/")));
    c.on("data", d => chunks.push(d)); c.on("close", () => resolve(Buffer.concat(chunks).toString())); c.on("error", () => resolve(Buffer.concat(chunks).toString()));
    setTimeout(() => c.destroy(), 2000).unref();
  });
  assert.match(await via("docuseal.alex.vyre.run", "docuseal.alex.vyre.run"), /^HTTP\/1\.1 200 /);
  assert.match(await via("other.alex.vyre.run", "docuseal.alex.vyre.run"), /^HTTP\/1\.1 404 /, "SNI for one app, Host for another");
  assert.match(await via("localhost", "docuseal.alex.vyre.run"), /^HTTP\/1\.1 404 /, "SNI of something else");
  assert.equal(f.seen.length, 1);
});

test("gate apps over TLS: an own host is served with its own certificate by SNI, only while the gate holds that certificate, and the Space's certificate stays for every other name", async t => {
  const f = await appsFront(); t.after(() => f.close());
  const space = selfSigned({ ips: ["127.0.0.1"], names: ["localhost", "alex.vyre.run"] });
  const own = selfSigned({ ips: ["127.0.0.1"], names: ["sign.firm.example"] });
  const { port, gate } = await setup(t, { tls: space, ingress: { hooks: () => null, share: () => null, ...appsOf(f, ["docuseal.alex.vyre.run", "sign.firm.example"]) } });
  /** @returns {Promise<{ pin: string, text: string }>} */
  const via = (servername, host) => new Promise(resolve => {
    const chunks = []; let pin = "";
    const c = tls.connect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false }, () => { pin = certPin(/** @type {any} */ (c.getPeerCertificate(true)).raw); c.write(req("GET", host, "/sign/1/abc")); });
    c.on("data", d => chunks.push(d)); c.on("close", () => resolve({ pin, text: Buffer.concat(chunks).toString() })); c.on("error", () => resolve({ pin, text: Buffer.concat(chunks).toString() }));
    setTimeout(() => c.destroy(), 2000).unref();
  });
  // before the certificate is held: not an app host, the Space's certificate answers, and nothing reaches the front
  const before = await via("sign.firm.example", "sign.firm.example");
  assert.equal(before.pin, certPin(space.cert));
  assert.doesNotMatch(before.text, /^HTTP\/1\.1 200 /);
  assert.equal(f.seen.length, 0);
  gate.setHostTls("Sign.Firm.Example", own);
  assert.deepEqual(gate.hosts(), ["sign.firm.example"]);
  const ok = await via("sign.firm.example", "sign.firm.example");
  assert.equal(ok.pin, certPin(own.cert), "its own certificate by SNI");
  assert.match(ok.text, /^HTTP\/1\.1 200 /);
  assert.equal(f.seen[0].headers.host, "sign.firm.example");
  assert.equal(f.seen[0].url, "/sign/1/abc");
  assert.match((await via("sign.firm.example", "docuseal.alex.vyre.run")).text, /^HTTP\/1\.1 404 /, "the own host's certificate does not carry another host");
  assert.match((await via("docuseal.alex.vyre.run", "sign.firm.example")).text, /^HTTP\/1\.1 404 /, "nor does another SNI carry the own host");
  assert.equal((await via("docuseal.alex.vyre.run", "docuseal.alex.vyre.run")).pin, certPin(space.cert), "the Space's names keep the Space's certificate");
  // a renewed certificate replaces it for the next handshake; dropping the host ends it
  const next = selfSigned({ ips: ["127.0.0.1"], names: ["sign.firm.example"] });
  gate.setHostTls("sign.firm.example", next);
  assert.equal((await via("sign.firm.example", "sign.firm.example")).pin, certPin(next.cert));
  gate.dropHostTls("sign.firm.example");
  assert.equal((await via("sign.firm.example", "sign.firm.example")).pin, certPin(space.cert));
  assert.doesNotMatch((await via("sign.firm.example", "sign.firm.example")).text, /^HTTP\/1\.1 200 /);
  assert.equal(f.seen.length, 3);
});

// ---- the Vault MCP route: exactly POST /vault-mcp, the Authorization header through, nothing else opened ----

/** A fake Vault MCP listener on loopback that records what reaches it. */
async function mcpListener() {
  /** @type {{ method: string, url: string, headers: Record<string, any>, body: string }[]} */ const seen = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => { seen.push({ method: /** @type {string} */ (req.method), url: /** @type {string} */ (req.url), headers: req.headers, body: b }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }); });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  return { seen, port: /** @type {net.AddressInfo} */ (srv.address()).port, close() { srv.close(); srv.closeAllConnections(); } };
}
const mcpPost = (body, extra = "") => `POST /vault-mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`;

test("gate ingress, Vault MCP: POST /vault-mcp reaches the vault's listener with the pass token, the real address and no spoofed header", async t => {
  const m = await mcpListener(); t.after(() => m.close());
  const { be, port } = await setup(t, { ingress: { hooks: () => null, share: () => null, vaultmcp: () => m.port } });
  const r = (await raw(port, mcpPost('{"jsonrpc":"2.0"}', "Authorization: Bearer vmcp_abc\r\nX-Forwarded-For: 6.6.6.6\r\n"))).toString();
  assert.match(r, /^HTTP\/1\.1 200 /);
  assert.deepEqual(m.seen.map(s => [s.method, s.url, s.body]), [["POST", "/vault-mcp", '{"jsonrpc":"2.0"}']]);
  assert.equal(m.seen[0].headers.authorization, "Bearer vmcp_abc", "the token reaches the vault");
  assert.equal(m.seen[0].headers["x-forwarded-for"], "127.0.0.1", "the socket's address, not the client's claim");
  assert.equal(be.seen.length, 0);
});

test("gate ingress, Vault MCP: every other shape under the gate is still the same 404, with the route on", async t => {
  const m = await mcpListener(); t.after(() => m.close());
  const ls = await listeners(); t.after(() => ls.close());
  const { be, port } = await setup(t, { ingress: { hooks: () => ls.hooksPort, share: () => ls.sharePort, vaultmcp: () => m.port } });
  const big = "x".repeat(64 * 1024 + 1);
  const head = "Host: x\r\nContent-Length: 2\r\nConnection: close\r\n";
  const cases = [
    get("/vault-mcp", "Connection: close\r\n"), `PUT /vault-mcp HTTP/1.1\r\n${head}Content-Type: application/json\r\n\r\n{}`,
    mcpPost("{}").replace("POST /vault-mcp ", "POST /vault-mcp?x=1 "), mcpPost("{}").replace("POST /vault-mcp ", "POST /vault-mcp/ "), mcpPost("{}").replace("POST /vault-mcp ", "POST /vault-mcp/x "),
    mcpPost("{}").replace("POST /vault-mcp ", "POST /Vault-Mcp "), mcpPost("{}").replace("POST /vault-mcp ", "POST //vault-mcp "), mcpPost("{}").replace("POST /vault-mcp ", "POST /vault-mcp%2f "),
    mcpPost("{}").replace("application/json", "text/plain"), mcpPost(big),
    `POST /vault-mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,
    `POST /vault-mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`,
    get("/mcp", "Connection: close\r\n"), get("/vault", "Connection: close\r\n"), post("/vault-mcp/hooks/abc", "{}"), get("/api/v1/node", "Connection: close\r\n"), get("/", "Connection: close\r\n"),
  ];
  for (const c of cases) assert.deepEqual(await raw(port, c), NOT_FOUND, c.split("\r\n")[0]);
  assert.deepEqual(m.seen, [], "the vault's listener was reached by none of them");
  assert.deepEqual(ls.seen, []);
  assert.equal(be.seen.length, 0);
  // off unless set, and a listener that is not up answers the same 404
  const off = await setup(t, { ingress: { hooks: () => null, share: () => null } });
  assert.deepEqual(await raw(off.port, mcpPost("{}")), NOT_FOUND);
  const down = await setup(t, { ingress: { hooks: () => null, share: () => null, vaultmcp: () => null } });
  assert.deepEqual(await raw(down.port, mcpPost("{}")), NOT_FOUND);
});

test("gate ingress, Vault MCP: the gate's own per-source limit sits in front of the vault's, and the hook limit is its own", async t => {
  const m = await mcpListener(); t.after(() => m.close());
  const { port } = await setup(t, { ingress: { hooks: () => m.port, share: () => null, vaultmcp: () => m.port } });
  let limited = 0;
  for (let i = 0; i < 62; i++) { const r = (await raw(port, mcpPost("{}"))).toString(); if (/^HTTP\/1\.1 429 /.test(r)) limited++; }
  assert.ok(limited >= 1 && limited <= 3, `the 61st request from one source is refused (${limited})`);
  assert.match((await raw(port, post("/hooks/abc", "{}"))).toString(), /^HTTP\/1\.1 200 /, "webhooks have their own window");
});

// ---- the outside agents' MCP: exactly POST /agents-mcp, the same discipline as /vault-mcp, its own listener and its own budget ----

test("gate ingress, agents MCP: POST /agents-mcp reaches the outside module's listener with the agent's token and the real address; the vault's route is its own", async t => {
  const a = await mcpListener(), v = await mcpListener(); t.after(() => { a.close(); v.close(); });
  const { be, port } = await setup(t, { ingress: { hooks: () => null, share: () => null, vaultmcp: () => v.port, agentsmcp: () => a.port } });
  const r = (await raw(port, mcpPost('{"jsonrpc":"2.0"}', "Authorization: Bearer vag_abc\r\nX-Forwarded-For: 6.6.6.6\r\n").replace("POST /vault-mcp ", "POST /agents-mcp "))).toString();
  assert.match(r, /^HTTP\/1\.1 200 /);
  assert.deepEqual(a.seen.map(s => [s.method, s.url, s.body]), [["POST", "/agents-mcp", '{"jsonrpc":"2.0"}']]);
  assert.equal(a.seen[0].headers.authorization, "Bearer vag_abc", "the token reaches the outside module");
  assert.equal(a.seen[0].headers["x-forwarded-for"], "127.0.0.1");
  assert.deepEqual(v.seen, [], "and the vault's listener heard nothing");
  await raw(port, mcpPost("{}"));
  assert.equal(v.seen.length, 1); assert.equal(a.seen.length, 1);
  assert.equal(be.seen.length, 0);
});

test("gate ingress, agents MCP: every other shape is the same 404, off unless set, 404 while its listener is not up, and its budget is its own", async t => {
  const a = await mcpListener(); t.after(() => a.close());
  const big = "x".repeat(64 * 1024 + 1);
  const at = (/** @type {string} */ body, /** @type {string} */ from = "/vault-mcp") => mcpPost(body).replace(`POST ${from} `, "POST /agents-mcp ");
  const { port } = await setup(t, { ingress: { hooks: () => null, share: () => null, agentsmcp: () => a.port } });
  const cases = [
    get("/agents-mcp", "Connection: close\r\n"), `PUT /agents-mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{}`,
    at("{}").replace("POST /agents-mcp ", "POST /agents-mcp?x=1 "), at("{}").replace("POST /agents-mcp ", "POST /agents-mcp/ "), at("{}").replace("POST /agents-mcp ", "POST /Agents-Mcp "),
    at("{}").replace("POST /agents-mcp ", "POST //agents-mcp "), at("{}").replace("POST /agents-mcp ", "POST /agents-mcp%2f "), at("{}").replace("application/json", "text/plain"), at(big),
    mcpPost("{}"), // the vault's route is not on: its own listener was never given
    get("/agents", "Connection: close\r\n"), get("/mcp", "Connection: close\r\n"),
  ];
  for (const c of cases) assert.deepEqual(await raw(port, c), NOT_FOUND, c.split("\r\n")[0]);
  assert.deepEqual(a.seen, []);
  const off = await setup(t, { ingress: { hooks: () => null, share: () => null } });
  assert.deepEqual(await raw(off.port, at("{}")), NOT_FOUND);
  const down = await setup(t, { ingress: { hooks: () => null, share: () => null, agentsmcp: () => null } });
  assert.deepEqual(await raw(down.port, at("{}")), NOT_FOUND);
  const lim = await setup(t, { ingress: { hooks: () => null, share: () => null, vaultmcp: () => a.port, agentsmcp: () => a.port } });
  let limited = 0;
  for (let i = 0; i < 62; i++) { const r = (await raw(lim.port, at("{}"))).toString(); if (/^HTTP\/1\.1 429 /.test(r)) limited++; }
  assert.ok(limited >= 1 && limited <= 3, `the 61st request from one source is refused (${limited})`);
  assert.match((await raw(lim.port, mcpPost("{}"))).toString(), /^HTTP\/1\.1 200 /, "the vault's route has its own window");
});

// ---- the tunnel end's PROXY v2 header: the visitor's address, not loopback's (REVIEW-LEDGER row 8)
const UPGRADE = "POST /ts2021 HTTP/1.1\r\nHost: x\r\nUpgrade: tailscale-control-protocol\r\nConnection: Upgrade\r\n\r\n";
const via = (/** @type {string} */ ip, /** @type {string} */ http1) => Buffer.concat([/** @type {Buffer} */ (encodeProxyV2(ip, 40000)), Buffer.from(http1)]);
const head = (/** @type {Buffer} */ b) => b.toString().slice(0, 12);

test("gate tunnel address: a loopback peer's PROXY v2 header names the visitor; the budget, the block and the forwarded address are that visitor's, not 127.0.0.1's", async t => {
  const ls = await listeners(); t.after(() => ls.close());
  const { gate, port } = await setup(t, { limits: { upgradesPerWindow: 3 }, ingress: { hooks: () => ls.hooksPort, share: () => ls.sharePort } });
  const A = "203.0.113.7", B = "198.51.100.9";
  // one stranger spends its own three upgrades and is limited; another stranger, through the same loopback hop, is not
  const a = [], b = [];
  for (let i = 0; i < 5; i++) a.push(head(await raw(port, via(A, UPGRADE), { wait: 150 })));
  assert.deepEqual(a, ["HTTP/1.1 101", "HTTP/1.1 101", "HTTP/1.1 101", "HTTP/1.1 429", "HTTP/1.1 429"]);
  for (let i = 0; i < 3; i++) b.push(head(await raw(port, via(B, UPGRADE), { wait: 150 })));
  assert.deepEqual(b, ["HTTP/1.1 101", "HTTP/1.1 101", "HTTP/1.1 101"], "the other visitor has its own budget");
  // a plain connection from loopback with no header is loopback, and has its own budget as well
  assert.equal(head(await raw(port, UPGRADE, { wait: 150 })), "HTTP/1.1 101");
  // a block is the visitor's: theirs is closed before a byte, the other is served
  gate.block(A);
  assert.equal((await raw(port, via(A, get("/key", "Connection: close\r\n")))).length, 0, "the blocked visitor gets nothing");
  assert.match((await raw(port, via(B, get("/key", "Connection: close\r\n")))).toString(), /^HTTP\/1\.1 200 /);
  assert.equal(gate.isBlocked("127.0.0.1"), false, "loopback was never blocked");
  // the address the listeners behind the gate see is the visitor's (core/outside/listener.js keys its own limit on it)
  const h = (await raw(port, via(B, post("/hooks/northwind-orders", "{}", "X-Forwarded-For: 6.6.6.6\r\n")))).toString();
  assert.match(h, /^HTTP\/1\.1 202 /);
  assert.equal(ls.seen.at(-1).headers["x-forwarded-for"], B);
  // IPv6 is budgeted per /64 like any other
  const six = [];
  for (let i = 0; i < 5; i++) six.push(head(await raw(port, via(`2001:db8:1:2::${i + 1}`, UPGRADE), { wait: 150 })));
  assert.deepEqual(six, ["HTTP/1.1 101", "HTTP/1.1 101", "HTTP/1.1 101", "HTTP/1.1 429", "HTTP/1.1 429"], "five hosts of one /64 share three upgrades");
});

test("gate tunnel address: a header that arrives in pieces is read, a bad one closes the connection, and a peer that is not trusted is never read as a header", async t => {
  const { be, port } = await setup(t, { limits: { handshakeMs: 400 } });
  const piece = (/** @type {Buffer} */ bytes, /** @type {number[]} */ cuts) => new Promise(resolve => {
    const chunks = []; const c = net.connect(port, "127.0.0.1"); c.on("data", d => chunks.push(d)); c.on("close", () => resolve(Buffer.concat(chunks))); c.on("error", () => {});
    let at = 0;
    const step = async () => { for (const n of [...cuts, bytes.length]) { c.write(bytes.subarray(at, n)); at = n; await new Promise(r => setTimeout(r, 40)); } };
    void step(); setTimeout(() => c.destroy(), 1500).unref();
  });
  const whole = via("192.0.2.44", get("/key", "Connection: close\r\n"));
  assert.match((await piece(whole, [5, 14, 20, 40])).toString(), /^HTTP\/1\.1 200 /);
  assert.equal(be.seen.at(-1).headers["x-forwarded-for"], "192.0.2.44");
  // starts as a header but is not one: closed, nothing reaches Headscale
  const bad = Buffer.from(whole); bad[12] = 0x11;
  const seen = be.seen.length;
  assert.equal((await raw(port, bad)).length, 0);
  assert.equal(be.seen.length, seen);
  // a loopback peer that starts a header and never finishes it is dropped at the handshake deadline
  const t0 = Date.now();
  await piece(whole.subarray(0, 10), []);
  assert.ok(Date.now() - t0 < 1400, "an unfinished header does not hold the connection");

  // when the peer is not on the trust list the same bytes are only bytes: the request is garbage and the address stays the socket's
  const u = await setup(t, { proxy: { trust: ["10.0.0.0/8"] } });
  assert.deepEqual(await raw(u.port, whole), NOT_FOUND);
  assert.equal(u.be.seen.length, 0);
  assert.match((await raw(u.port, get("/key", "Connection: close\r\n"))).toString(), /^HTTP\/1\.1 200 /);
  assert.equal(u.be.seen.at(-1).headers["x-forwarded-for"], "127.0.0.1");
});

test("gate tunnel address: over TLS the header comes first, the handshake and the request follow, and the limits are the visitor's", async t => {
  const { cert, key } = selfSigned({ ips: ["127.0.0.1"], names: ["x"] });
  const ls = await listeners(); t.after(() => ls.close());
  const { gate, port } = await setup(t, { tls: { cert, key }, limits: { upgradesPerWindow: 3 }, ingress: { hooks: () => ls.hooksPort, share: () => ls.sharePort } });
  const visit = (/** @type {string} */ ip, /** @type {string} */ http1) => new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(/** @type {Buffer} */ (encodeProxyV2(ip, 4242)));
      const c = tls.connect({ socket: sock, ca: cert, servername: "x" }, () => c.write(http1));
      const chunks = []; c.on("data", d => chunks.push(d)); c.on("close", () => resolve(Buffer.concat(chunks))); c.on("error", () => resolve(Buffer.concat(chunks)));
      setTimeout(() => c.destroy(), 1500).unref();
    });
    sock.on("error", () => resolve(Buffer.alloc(0)));
  });
  const A = "203.0.113.7", B = "198.51.100.9";
  const h = await visit(B, post("/hooks/northwind-orders", "{}"));
  assert.match(h.toString(), /^HTTP\/1\.1 202 /);
  assert.equal(ls.seen.at(-1).headers["x-forwarded-for"], B, "the address survives the TLS socket");
  const a = [];
  for (let i = 0; i < 5; i++) a.push(head(await visit(A, UPGRADE)));
  assert.deepEqual(a, ["HTTP/1.1 101", "HTTP/1.1 101", "HTTP/1.1 101", "HTTP/1.1 429", "HTTP/1.1 429"]);
  assert.equal(head(await visit(B, UPGRADE)), "HTTP/1.1 101", "the other visitor still has a budget");
  gate.block(A);
  assert.equal((await visit(A, get("/key"))).length, 0);
  assert.match((await visit(B, get("/key", "Connection: close\r\n"))).toString(), /^HTTP\/1\.1 200 /);
});

// ---- a WebSocket on an app host (a published server's live page): carried to the apps' front, with the real address, under its own budgets
/** A front that answers a WebSocket handshake and echoes what it is sent, and remembers the heads it was given. */
async function wsFront() {
  /** @type {Record<string, any>[]} */ const heads = [];
  const srv = http.createServer((_q, r) => { r.writeHead(200).end("plain"); });
  srv.on("upgrade", (q, sock) => {
    heads.push({ url: q.url, ...q.headers });
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n");
    sock.on("data", d => sock.write(Buffer.concat([Buffer.from("echo:"), d]))); sock.on("error", () => {});
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  return { heads, port: /** @type {net.AddressInfo} */ (srv.address()).port, close() { srv.close(); srv.closeAllConnections(); } };
}
const wsReq = (/** @type {string} */ host, extra = "") => `GET /live?x=1 HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;

test("gate apps: a WebSocket on a running app's host is carried both ways to the front, with the real address and no spoofed header; Headscale is never asked", async t => {
  const f = await wsFront(); t.after(() => f.close());
  const { be, port } = await setup(t, { ingress: { hooks: () => null, share: () => null, ...appsOf(f) } });
  const c = net.connect(port, "127.0.0.1");
  t.after(() => c.destroy());
  const got = [];
  c.on("data", d => got.push(d));
  c.write(wsReq("docuseal.alex.vyre.run", "X-Forwarded-For: 6.6.6.6\r\nCookie: a=1\r\nAuthorization: Bearer mine\r\n"));
  await new Promise(r => setTimeout(r, 200));
  assert.match(Buffer.concat(got).toString(), /^HTTP\/1\.1 101 /);
  c.write("hello");
  await new Promise(r => setTimeout(r, 200));
  assert.match(Buffer.concat(got).toString(), /echo:hello$/);
  const h = f.heads[0];
  assert.equal(h.url, "/live?x=1");
  assert.equal(h.host, "docuseal.alex.vyre.run");
  assert.equal(h["x-forwarded-for"], "127.0.0.1", "the socket's address replaces the client's own header");
  assert.equal(h.cookie, "a=1"); assert.equal(h.authorization, "Bearer mine", "the visitor's own cookie and credentials reach the front, which decides");
  assert.equal(be.seen.length, 0, "Headscale was never asked");
});

test("gate apps: only a GET with Upgrade: websocket to a running app's host is carried; anything else is the same 404, and the upgrades have their own budget", async t => {
  const f = await wsFront(); t.after(() => f.close());
  const { port, gate } = await setup(t, { ingress: { hooks: () => null, share: () => null, ...appsOf(f) }, limits: { appsUpgradesPerWindow: 3, appsConcurrentUpgrades: 2, upgradesPerWindow: 1 } });
  assert.deepEqual(await raw(port, wsReq("unknown.alex.vyre.run")), NOT_FOUND, "an app that is not running");
  assert.deepEqual(await raw(port, wsReq("a.b.alex.vyre.run")), NOT_FOUND, "two labels");
  assert.deepEqual(await raw(port, wsReq("docuseal.alex.vyre.run").replace("Upgrade: websocket", "Upgrade: h2c")), NOT_FOUND, "another protocol");
  assert.deepEqual(await raw(port, wsReq("docuseal.alex.vyre.run").replace("GET ", "POST ")), NOT_FOUND, "a POST");
  assert.equal(f.heads.length, 0, "none of those reached the front");
  // Headscale's own budget is one per window here; the app's is its own
  const open = [];
  for (let i = 0; i < 2; i++) { const c = net.connect(port, "127.0.0.1"); c.on("error", () => {}); c.write(wsReq("docuseal.alex.vyre.run")); open.push(c); }
  await new Promise(r => setTimeout(r, 250));
  assert.equal(f.heads.length, 2);
  const over = net.connect(port, "127.0.0.1"); const out = []; over.on("data", d => out.push(d)); over.on("error", () => {}); over.write(wsReq("docuseal.alex.vyre.run"));
  await new Promise(r => setTimeout(r, 250));
  assert.match(Buffer.concat(out).toString(), /^HTTP\/1\.1 429 /, "past the concurrent budget");
  over.destroy(); for (const c of open) c.destroy();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(gate.stats().limited >= 1, true);
  const up = "POST /ts2021 HTTP/1.1\r\nHost: x\r\nUpgrade: tailscale-control-protocol\r\nConnection: Upgrade\r\n\r\n";
  assert.equal(head(await raw(port, up, { wait: 150 })), "HTTP/1.1 101", "Headscale's control channel is not starved by the apps' upgrades");
});
