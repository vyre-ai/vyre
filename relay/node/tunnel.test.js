// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tlsMod from "node:tls";
import crypto from "node:crypto";
import { parseClientHello, validHost, createTunnelFront } from "./tunnel.js";

/** The first flight of a real TLS client, captured from node's own tls: with a server name, or without one. @param {string | undefined} servername */
async function realHello(servername) {
  const srv = net.createServer();
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  const got = new Promise(res => srv.once("connection", c => c.once("data", d => { res(d); c.destroy(); })));
  const c = tlsMod.connect({ host: "127.0.0.1", port: /** @type {any} */ (srv.address()).port, ...(servername ? { servername } : {}), rejectUnauthorized: false });
  c.on("error", () => {});
  const hello = /** @type {Buffer} */ (await got);
  c.destroy(); srv.close();
  return hello;
}

test("parseClientHello: a real hello gives its name; partial is incomplete; everything else is refused with a reason", async () => {
  const h = await realHello("harlow.vyre.run");
  assert.deepEqual(parseClientHello(h), { host: "harlow.vyre.run", incomplete: false });
  for (const n of [0, 3, 5, 40, h.length - 1]) assert.equal(parseClientHello(h.subarray(0, n)).incomplete, true, `prefix ${n}`);
  assert.equal(parseClientHello(await realHello(undefined)).why, "no_sni", "an IP address has no name");
  assert.equal(parseClientHello(Buffer.from("GET / HTTP/1.1\r\nhost: harlow.vyre.run\r\n\r\n")).why, "not_tls");
  assert.equal(parseClientHello(Buffer.from("PROXY TCP4 1.2.3.4 5.6.7.8 1 2\r\n")).why, "not_tls", "a PROXY header from a visitor is not a hello");
  assert.equal(parseClientHello(Buffer.from([0x16, 3, 1, 0x7f, 0xff])).why, "bad_record", "a record over 16 KB");
  const upper = Buffer.from(h); const at = upper.indexOf("harlow"); upper[at] = "H".charCodeAt(0);
  assert.equal(parseClientHello(upper).why, "bad_host", "an upper-case name is not what a client sends");
});

test("parseClientHello: no throw and no host on 100000 random and mutated buffers", async () => {
  const h = await realHello("harlow.vyre.run");
  for (let i = 0; i < 100_000; i++) {
    const b = i % 2 ? crypto.randomBytes(1 + (i % 300)) : Buffer.from(h);
    if (i % 2 === 0) for (let k = 0; k < 1 + (i % 4); k++) b[(i * 7 + k * 13) % b.length] = i & 255;
    const r = parseClientHello(b);
    if (r.host !== null) assert.ok(validHost(r.host));
  }
});

test("validHost: no IP literal, no long name, no bad label, no trailing dot", () => {
  for (const ok of ["harlow.vyre.run", "a.b.harlow.vyre.run", "xn--bcher-kva.example"]) assert.equal(validHost(ok), true, ok);
  for (const bad of ["", "localhost", "1.2.3.4", "::1", "harlow.vyre.run.", "Harlow.vyre.run", "-a.vyre.run", "a-.vyre.run", "a..vyre.run", `${"a".repeat(64)}.vyre.run`, `${"a.".repeat(130)}run`, "ha rlow.vyre.run", "harlow.vyre.run\n"]) assert.equal(validHost(bad), false, JSON.stringify(bad));
});

/** A relay front on a loopback port with a fake directory and a fake box transport. */
async function world(t, { names = { "harlow.vyre.run": "route-harlow", "app.harlow.vyre.run": "route-harlow", "northwind.vyre.run": "route-northwind" }, limits = {}, openFails = false } = {}) {
  /** @type {Record<string, string>} */ const dir = { ...names };
  const opened = [];
  /** @type {any[]} */ const boxes = [];
  const front = createTunnelFront({
    resolve: async host => (dir[host] ? { route: dir[host] } : null),
    open: async (route, visitor, sink) => {
      if (openFails) return null;
      const box = { route, visitor, got: /** @type {Buffer[]} */ ([]), sink, closed: false, write: (/** @type {Buffer} */ b) => { box.got.push(b); return true; }, close: () => { box.closed = true; } };
      opened.push({ route, visitor }); boxes.push(box);
      return box;
    },
    limits: { recheckMs: 3_600_000, ...limits },
  });
  const tlsServer = net.createServer(s => front.tls(s));
  const httpServer = net.createServer(s => front.http(s));
  await new Promise(r => tlsServer.listen(0, "127.0.0.1", () => r(undefined)));
  await new Promise(r => httpServer.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { front.close(); tlsServer.close(); httpServer.close(); });
  const tlsPort = /** @type {any} */ (tlsServer.address()).port, httpPort = /** @type {any} */ (httpServer.address()).port;
  /** @param {Buffer} first */
  const visit = async first => {
    const c = net.connect(tlsPort, "127.0.0.1");
    c.on("error", () => {});
    await new Promise(r => c.once("connect", () => r(undefined)));
    const closed = new Promise(r => c.once("close", () => r(true)));
    c.write(first);
    return { c, closed, data: /** @type {Buffer[]} */ ([]), };
  };
  const waitFor = async (/** @type {() => any} */ f) => { for (let i = 0; i < 200; i++) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 10)); } throw new Error("timed out"); };
  return { front, dir, opened, boxes, tlsPort, httpPort, visit, waitFor };
}

test("tunnel front: a visitor for a served name reaches that Space's box, bytes both ways, the address goes in the open call and not in the bytes", async t => {
  const w = await world(t);
  const hello = await realHello("harlow.vyre.run");
  const v = await w.visit(hello);
  const box = await w.waitFor(() => w.boxes[0]);
  assert.equal(box.route, "route-harlow");
  assert.equal(box.visitor.host, "harlow.vyre.run");
  assert.match(box.visitor.ip, /^127\.0\.0\.1$/);
  await w.waitFor(() => box.got.length);
  assert.deepEqual(Buffer.concat(box.got), hello, "the box gets the hello byte for byte, with nothing in front of it");
  const back = new Promise(res => v.c.once("data", d => res(d)));
  box.sink.data(Buffer.from("server hello"));
  assert.equal(String(await back), "server hello");
  v.c.write("more");
  await w.waitFor(() => Buffer.concat(box.got).toString("latin1").endsWith("more"));
  box.sink.end();
  assert.equal(await v.closed, true, "the box ending ends the visitor");
});

test("tunnel front: a name the directory does not know, no name, an IP name, a plain HTTP request, an oversized hello and a silent visitor are closed with no box opened", async t => {
  const w = await world(t, { limits: {} });
  const cases = [await realHello("evil.example"), await realHello(undefined), Buffer.from("GET / HTTP/1.1\r\nhost: harlow.vyre.run\r\n\r\n"), Buffer.from("PROXY TCP4 1.2.3.4 5.6.7.8 1 2\r\n"), Buffer.concat([Buffer.from([0x16, 3, 1, 0x3f, 0xf0]), Buffer.alloc(16 * 1024)])];
  for (const first of cases) { const v = await w.visit(first); assert.equal(await v.closed, true); }
  assert.equal(w.opened.length, 0);
  assert.ok(w.front.stats.refused.unknown_name >= 1 && w.front.stats.refused.no_sni >= 1 && w.front.stats.refused.not_tls >= 2);
  const silent = await w.visit(Buffer.alloc(0));
  const t0 = Date.now();
  assert.equal(await silent.closed, true);
  assert.ok(Date.now() - t0 < 7000, "closed at the hello deadline");
  assert.equal(w.opened.length, 0);
});

test("tunnel front: port 80 is a fixed redirect for a host-shaped name and never opens a box", async t => {
  const w = await world(t);
  const ask = async raw => new Promise(res => { const c = net.connect(w.httpPort, "127.0.0.1"); let out = ""; c.on("data", d => { out += d; }); c.on("close", () => res(out)); c.on("error", () => res(out)); c.write(raw); });
  assert.match(await ask("GET /x HTTP/1.1\r\nHost: harlow.vyre.run\r\n\r\n"), /^HTTP\/1\.1 308 .*\r\nlocation: https:\/\/harlow\.vyre\.run\/\r\n/s);
  assert.match(await ask("GET / HTTP/1.1\r\nHost: 1.2.3.4\r\n\r\n"), /^HTTP\/1\.1 400/);
  assert.match(await ask("GET / HTTP/1.1\r\nHost: a.b\r\nx: y\r\n\r\n"), /^HTTP\/1\.1 308/);
  assert.match(await ask("GET / HTTP/1.1\r\nHost: evil.example/..\r\n\r\n"), /^HTTP\/1\.1 400/);
  assert.equal(w.opened.length, 0);
});

test("tunnel front: a claim that leaves the directory closes its streams at the next re-check, and a name is never served from a stale yes", async t => {
  const w = await world(t);
  const hello = await realHello("app.harlow.vyre.run");
  const v = await w.visit(hello);
  await w.waitFor(() => w.boxes[0]);
  delete w.dir["app.harlow.vyre.run"];
  await w.front.recheck();
  assert.equal(await v.closed, true);
  assert.equal(w.front.stats.closedByRecheck, 1);
  assert.ok(w.boxes[0].closed);
  // another Space's name moved to a different route: the stream for it ends too
  const v2 = await w.visit(await realHello("northwind.vyre.run"));
  await w.waitFor(() => w.boxes[1]);
  w.dir["northwind.vyre.run"] = "route-other";
  await w.front.recheck();
  assert.equal(await v2.closed, true);
});

test("tunnel front: slots are freed however a stream ends (12 that end themselves, then 12 more), and the per-address and per-route caps hold", async t => {
  const w = await world(t, { limits: { perIp: 12, perRoute: 12 } });
  const hello = await realHello("harlow.vyre.run");
  for (let round = 0; round < 2; round++) {
    const vs = [];
    for (let i = 0; i < 12; i++) vs.push(await w.visit(hello));
    await w.waitFor(() => w.boxes.length === (round + 1) * 12);
    for (const b of w.boxes.slice(round * 12)) b.sink.end();
    for (const v of vs) assert.equal(await v.closed, true);
    await w.waitFor(() => w.front.open() === 0);
  }
  const held = [];
  for (let i = 0; i < 12; i++) held.push(await w.visit(hello));
  await w.waitFor(() => w.front.open() === 12);
  const over = await w.visit(hello);
  assert.equal(await over.closed, true, "the 13th from one address is refused");
  assert.ok(w.front.stats.refused.per_ip >= 1);
  assert.equal(w.front.open(), 12);
});

test("tunnel front: a box that does not take the stream in time closes the visitor and counts it", async t => {
  const w = await world(t, { openFails: true });
  const v = await w.visit(await realHello("harlow.vyre.run"));
  assert.equal(await v.closed, true);
  assert.equal(w.front.stats.refused.box_unreachable, 1);
  assert.equal(w.front.open(), 0);
});

test("tunnel front: a directory that fails answers no, never a cached yes", async t => {
  let fail = false;
  const w = await world(t);
  const front = createTunnelFront({ resolve: async () => { if (fail) throw new Error("directory down"); return { route: "r" }; }, open: async () => null, limits: { ttlMs: 0 } });
  t.after(() => front.close());
  const srv = net.createServer(s => front.tls(s));
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => srv.close());
  fail = true;
  const c = net.connect(/** @type {any} */ (srv.address()).port, "127.0.0.1"); c.on("error", () => {});
  const closed = new Promise(r => c.once("close", () => r(true)));
  c.write(await realHello("harlow.vyre.run"));
  assert.equal(await closed, true);
  assert.equal(front.stats.refused.unknown_name, 1);
  void w;
});
