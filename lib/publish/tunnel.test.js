// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { parseSni, mayServe, createTunnelEnd } from "./tunnel.js";
import { encodeProxyV2, decodeProxyV2, PROXY_V2_SIGNATURE } from "./proxy.js";
import { edgeCompose, caddyfile, isolationProblems, TUNNEL_PORT } from "./edge.js";
import { SPACE } from "./test-kit.js";

const listen = (/** @type {(s: net.Socket) => void} */ on) => new Promise(res => { const s = net.createServer(on); s.listen(0, "127.0.0.1", () => res(s)); });
const portOf = (/** @type {any} */ s) => s.address().port;
/** A real ClientHello for a name, as node's TLS client sends it. */
async function hello(/** @type {string} */ servername, /** @type {import("node:test").TestContext} */ t) {
  /** @type {Buffer} */ let got = Buffer.alloc(0);
  const cap = /** @type {net.Server} */ (await listen(s => { s.on("data", d => { got = Buffer.concat([got, d]); s.destroy(); }); s.on("error", () => {}); }));
  t.after(() => cap.close());
  await new Promise(res => { const c = tls.connect({ host: "127.0.0.1", port: portOf(cap), servername, rejectUnauthorized: false }); c.on("error", () => {}); c.on("close", res); });
  return got;
}

test("parseSni reads the name from a real ClientHello, asks for more when it is split, and refuses anything that is not one", async t => {
  const h = await hello("www.harlow.vyre.run", t);
  assert.deepEqual(parseSni(h), { host: "www.harlow.vyre.run", incomplete: false });
  assert.deepEqual(parseSni(h.subarray(0, 3)), { host: null, incomplete: true });
  assert.deepEqual(parseSni(h.subarray(0, h.length - 10)), { host: null, incomplete: true });
  assert.deepEqual(parseSni(Buffer.from("GET / HTTP/1.1\r\nHost: harlow.vyre.run\r\n\r\n")), { host: null, incomplete: false });
  assert.equal(parseSni(Buffer.alloc(0)).incomplete, true);
  for (let i = 0; i < 40; i++) { const x = Buffer.from(h); x[5 + (i * 7) % (x.length - 5)] ^= 0xff; assert.doesNotThrow(() => parseSni(x)); }
});

test("mayServe: the space's own name, anything under it, and its verified own domains; nothing else", () => {
  const ok = (/** @type {string} */ h) => mayServe("harlow.vyre.run", h, ["harlowlegal.com"]);
  for (const h of ["harlow.vyre.run", "northwind.harlow.vyre.run", "p-1.harlow.vyre.run", "HARLOW.vyre.run", "harlowlegal.com", "www.harlowlegal.com"]) assert.equal(ok(h), true, h);
  for (const h of ["vyre.run", "alex.vyre.run", "evilharlow.vyre.run", "harlow.vyre.run.evil.example", "harlowlegal.com.evil.example", "blog.harlowlegal.com", "", "a b", "127.0.0.1"]) assert.equal(ok(h), false, h);
});

test("the tunnel end carries a stream to the fixed loopback target, byte for byte, and refuses names that are not the space's", async t => {
  /** @type {Buffer[]} */ const seen = [];
  let upstreamOpened = 0;
  const caddy = /** @type {net.Server} */ (await listen(s => { upstreamOpened++; s.on("data", d => { seen.push(d); s.write(Buffer.concat([Buffer.from("echo:"), d.subarray(0, 4)])); }); s.on("error", () => {}); }));
  t.after(() => caddy.close());
  const relay = [];
  const end = createTunnelEnd({ name: "harlow.vyre.run", own: () => ["harlowlegal.com"], proxy: false, port: portOf(caddy), idleMs: 2000, helloMs: 300, maxStreams: 3 });
  const socks = /** @type {net.Socket[]} */ ([]);
  t.after(() => { end.closeAll(); for (const s of socks) s.destroy(); });
  // the relay side of the transport: each public connection becomes a stream handed to the end
  const transport = /** @type {net.Server} */ (await listen(s => end.accept(s)));
  t.after(() => transport.close());
  const dial = () => { const c = net.connect({ host: "127.0.0.1", port: portOf(transport) }); c.on("error", () => {}); socks.push(c); return c; };
  const closed = (/** @type {net.Socket} */ c) => new Promise(res => { if (c.destroyed) res(null); c.on("close", () => res(null)); });
  const data = (/** @type {net.Socket} */ c) => new Promise(res => c.once("data", d => res(d)));

  const good = await hello("northwind.harlow.vyre.run", t);
  const c1 = dial();
  c1.write(good.subarray(0, 20)); // split: the end waits for the rest
  await new Promise(r => setTimeout(r, 50));
  assert.equal(upstreamOpened, 0, "nothing is dialled until the name is known");
  c1.write(good.subarray(20));
  assert.equal((await data(c1)).toString(), `echo:${good.subarray(0, 4).toString("latin1")}`);
  assert.deepEqual(Buffer.concat(seen), good, "Caddy got exactly the bytes the public client sent");
  assert.equal(upstreamOpened, 1);
  const own = dial(); own.write(await hello("harlowlegal.com", t)); await data(own);
  assert.equal(upstreamOpened, 2, "a verified own domain goes through");

  for (const bad of ["alex.vyre.run", "harlow.vyre.run.evil.example"]) {
    const c = dial(); c.write(await hello(bad, t)); await closed(c);
  }
  const plain = dial(); plain.write(Buffer.from("GET / HTTP/1.1\r\nHost: harlow.vyre.run\r\n\r\n")); await closed(plain);
  const silent = dial(); await closed(silent);
  assert.equal(upstreamOpened, 2, "no refused stream reached Caddy");
  assert.deepEqual(end.stats.refused, { foreign_name: 2, no_sni: 1, no_hello: 1 });
  // the limit on open streams: two are open (c1 and own), a third is fine, a fourth is refused
  const c3 = dial(); c3.write(good); await data(c3);
  const c4 = dial(); c4.on("error", () => {}); await closed(c4);
  assert.equal(end.stats.refused.too_many, 1);
  assert.equal(end.open(), 3);
});

test("tunnel mode: Caddy publishes only a loopback port, isolation still holds, and a public port is still refused", () => {
  const c = edgeCompose(SPACE, [], { tunnel: true });
  assert.deepEqual(c.services.caddy.ports, [`127.0.0.1:${TUNNEL_PORT}:443`]);
  assert.deepEqual(isolationProblems(c), []);
  assert.deepEqual(edgeCompose(SPACE, []).services.caddy.ports, ["80:80", "443:443", "443:443/udp"], "the default is unchanged");
  const bad = edgeCompose(SPACE, [], { tunnel: true });
  bad.services.caddy.ports = ["0.0.0.0:18443:443"];
  assert.ok(isolationProblems(bad).some(p => /only caddy publishes/.test(p)));
  bad.services.caddy.ports = [`127.0.0.1:${TUNNEL_PORT}:443`];
  bad.services.buildkit.ports = [`127.0.0.1:${TUNNEL_PORT}:443`];
  assert.ok(isolationProblems(bad).some(p => /buildkit: only caddy publishes/.test(p)));
  const tcf = caddyfile([], [], { spaceName: "harlow.vyre.run", tunnel: true });
  assert.ok(tcf.includes("auto_https off"), "Caddy runs no ACME of any kind in tunnel mode (PT-1)");
  assert.ok(!/acme|tls internal|on_demand|tls-alpn|http_challenge/i.test(tcf), "no challenge of any kind is configured");
  assert.ok(!caddyfile([], [], { spaceName: "harlow.vyre.run" }).includes("auto_https off"));
});

test("TB-2 and PT-1: strict_sni_host everywhere; in tunnel mode every site loads the box's own certificate files, the files are read-only configs, and a name outside the space is not served", () => {
  for (const tunnel of [false, true]) assert.ok(caddyfile([], [], { spaceName: "harlow.vyre.run", tunnel }).includes("strict_sni_host"), `strict_sni_host (tunnel ${tunnel})`);
  const work = [{ id: "dep_0123456789abcdef", kind: "static", name: "northwind", stage: "Production" }];
  const cf = caddyfile([], work, { spaceName: "harlow.vyre.run", tunnel: true });
  const heads = cf.match(/^[a-z0-9.-]+ \{$/gm) || [];
  assert.ok(heads.length >= 2, `the space's own name and the site: ${heads}`);
  assert.equal((cf.match(/^\ttls \/certs\/edge\.crt \/certs\/edge\.key$/gm) || []).length, heads.length, "every site block loads the files");
  const c = edgeCompose(SPACE, [], { tunnel: true });
  assert.deepEqual(c.services.caddy.configs.map(x => x.source).sort(), ["caddyfile", "edgecert", "edgekey", "joinpage"]);
  assert.deepEqual(isolationProblems(c), []);
  c.configs.edgekey = { file: "/etc/shadow" };
  assert.ok(isolationProblems(c).some(p => /config edgekey/.test(p)));
  assert.ok(!edgeCompose(SPACE, []).services.caddy.configs.some(x => x.source === "edgecert"), "off the tunnel there is no certificate file");
  // an own domain is not served over the tunnel (no DNS-01 for it): refused, not silently served without a certificate
  const own = [{ host: "harlowlegal.com", verified: true, deployment: "dep_0123456789abcdef" }];
  assert.throws(() => caddyfile(own, work, { spaceName: "harlow.vyre.run", tunnel: true }), e => /** @type {any} */ (e).code === "tunnel_own_domain");
  assert.ok(caddyfile(own, work, { spaceName: "harlow.vyre.run" }).includes("harlowlegal.com"), "off the tunnel it is as before");
});

test("TB-4: the byte cap is per direction and a capped stream ends cleanly", async t => {
  const caddy = /** @type {net.Server} */ (await listen(s => { s.on("data", () => s.write(Buffer.alloc(5000, 1))); s.on("error", () => {}); }));
  t.after(() => caddy.close());
  const end = createTunnelEnd({ name: "harlow.vyre.run", proxy: false, port: portOf(caddy), maxBytes: 4000, idleMs: 3000, helloMs: 500 });
  const socks = /** @type {net.Socket[]} */ ([]);
  t.after(() => { end.closeAll(); for (const x of socks) x.destroy(); });
  const transport = /** @type {net.Server} */ (await listen(s => end.accept(s)));
  t.after(() => transport.close());
  const good = await hello("harlow.vyre.run", t);
  // a download over the cap with a tiny upload: ends with a FIN (no error event on the visitor side), counted as bytes_down, and the upload side was never over
  const c = net.connect({ host: "127.0.0.1", port: portOf(transport) }); socks.push(c);
  let err = null; c.on("error", e => { err = e; });
  c.write(good);
  await new Promise(res => c.on("close", res));
  assert.equal(err, null, "a clean close");
  assert.equal(end.stats.refused.bytes_down, undefined);
  // an upload over the cap is its own reason, and a stream that uploaded a little but downloads a lot is not charged for the sum
  const small = createTunnelEnd({ name: "harlow.vyre.run", proxy: false, port: portOf(caddy), maxBytes: 6000, idleMs: 3000, helloMs: 500 });
  t.after(() => small.closeAll());
  const tr2 = /** @type {net.Server} */ (await listen(s => small.accept(s)));
  t.after(() => tr2.close());
  const d = net.connect({ host: "127.0.0.1", port: portOf(tr2) }); socks.push(d);
  let got = 0; d.on("data", x => { got += x.length; }); d.on("error", () => {});
  d.write(good);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(got, 5000, "5000 down under a 6000 cap per direction while the hello went up (about 500 bytes): the sum would have been over 5500 but each direction is under");
  assert.equal(small.open(), 1, "still open");
});

test("the tunnel end puts the visitor's address, which the relay saw, in a PROXY v2 header ahead of the hello, and refuses a stream with none", async t => {
  /** @type {Buffer[]} */ const seen = [];
  const gate = /** @type {net.Server} */ (await listen(s => { s.on("data", d => { seen.push(d); }); s.on("error", () => {}); }));
  t.after(() => gate.close());
  const end = createTunnelEnd({ name: "harlow.vyre.run", port: portOf(gate), idleMs: 2000, helloMs: 300 });
  const socks = /** @type {net.Socket[]} */ ([]);
  t.after(() => { end.closeAll(); for (const x of socks) x.destroy(); });
  let visitor = /** @type {any} */ (null);
  const transport = /** @type {net.Server} */ (await listen(s => end.accept(s, visitor)));
  t.after(() => transport.close());
  const good = await hello("harlow.vyre.run", t);
  const wait = () => new Promise(r => setTimeout(r, 150));
  const send = async (/** @type {any} */ v) => { visitor = v; seen.length = 0; const c = net.connect({ host: "127.0.0.1", port: portOf(transport) }); c.on("error", () => {}); socks.push(c); c.write(good); await wait(); return Buffer.concat(seen); };

  for (const [ip, port] of [["203.0.113.7", 51234], ["::ffff:198.51.100.9", 4000], ["2001:db8:1::42", 65535]]) {
    const got = await send({ host: "harlow.vyre.run", ip, port });
    const h = /** @type {any} */ (decodeProxyV2(got));
    assert.equal(h.state, "ok", ip);
    assert.equal(h.addr, ip.replace(/^::ffff:/, ""), ip);
    assert.equal(h.port, port);
    assert.deepEqual(got.subarray(h.length), good, "the hello follows the header byte for byte");
  }
  for (const bad of [undefined, {}, { ip: "" }, { ip: "not an address", port: 1 }, { ip: "1.2.3.4.5" }]) {
    const got = await send(bad);
    assert.equal(got.length, 0, `no address (${JSON.stringify(bad)}): nothing is sent, the stranger is not lumped in as loopback`);
  }
  assert.equal(end.stats.refused.no_address, 5);
});

test("PROXY v2 header: round trip, the signature must lead, a short or oversized or foreign-version header is not read, LOCAL names no one", () => {
  const h = encodeProxyV2("192.0.2.55", 8443);
  assert.deepEqual(decodeProxyV2(h), { state: "ok", length: 28, addr: "192.0.2.55", port: 8443 });
  const six = encodeProxyV2("2001:db8::1", 1);
  assert.deepEqual(decodeProxyV2(six), { state: "ok", length: 52, addr: "2001:db8::1", port: 1 });
  assert.equal(encodeProxyV2("999.1.1.1", 1), null);
  assert.equal(encodeProxyV2("", 1), null);
  for (let i = 0; i < h.length; i++) assert.equal(decodeProxyV2(h.subarray(0, i)).state, i === 0 ? "more" : "more", `partial ${i}`);
  assert.equal(decodeProxyV2(Buffer.from("GET / HTTP/1.1\r\n")).state, "none");
  assert.equal(decodeProxyV2(Buffer.from([0x16, 3, 1, 0, 200])).state, "none");
  const v1 = Buffer.from(h); v1[12] = 0x11; assert.equal(decodeProxyV2(v1).state, "bad");
  const cmd = Buffer.from(h); cmd[12] = 0x22; assert.equal(decodeProxyV2(cmd).state, "bad");
  const big = Buffer.from(h); big.writeUInt16BE(60000, 14); assert.equal(decodeProxyV2(big).state, "bad");
  const local = Buffer.from(h); local[12] = 0x20; assert.deepEqual(decodeProxyV2(local), { state: "ok", length: 28, addr: null, port: null });
  assert.ok(h.subarray(0, 12).equals(PROXY_V2_SIGNATURE));
});
