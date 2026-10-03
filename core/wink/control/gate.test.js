// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import { createGate, NOT_FOUND, certPin, parseHeadscaleLog, addrKey } from "./gate.js";
import { selfSigned } from "./testing/selfsigned.js";

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
