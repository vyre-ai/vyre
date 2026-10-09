// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dgram from "node:dgram";
import { createReach, isPublicV4, isGlobalV6, localAddresses, defaultGateway, parseDescription, relayVerifier } from "./reach.js";
import { createRelay } from "../../relay/node/server.js";

const LAN = () => ({ eth0: [{ family: "IPv4", address: "192.168.1.20", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }] });
const LAN6 = () => ({ eth0: [{ family: "IPv4", address: "192.168.1.20", internal: false }, { family: "IPv6", address: "2a01:4f8:1::7", internal: false }] });

/** A fake router: SSDP answer on UDP, description and SOAP on HTTP. @param {{ external?: string, errors?: Record<string, string>, noIgd?: boolean }} [cfg] */
async function fakeIgd(cfg = {}) {
  const calls = /** @type {{ action: string, body: string }[]} */ ([]);
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", c => { b += c; }); req.on("end", () => {
      if (req.method === "GET") { res.end(`<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>`); return; }
      const action = String(req.headers.soapaction).replace(/"/g, "").split("#")[1];
      calls.push({ action, body: b });
      const err = cfg.errors && cfg.errors[action];
      if (err) { const [code, ...rest] = err.split(":"); res.writeHead(500); res.end(`<e><errorCode>${code}</errorCode><errorDescription>${rest.join(":") || "x"}</errorDescription></e>`); return; }
      res.end(action === "GetExternalIPAddress" ? `<r><NewExternalIPAddress>${cfg.external ?? "93.184.216.9"}</NewExternalIPAddress></r>` : "<r/>");
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  const httpPort = /** @type {any} */ (srv.address()).port;
  const udp = dgram.createSocket("udp4");
  await new Promise(r => udp.bind(0, "127.0.0.1", () => r(undefined)));
  udp.on("message", (_m, rinfo) => { if (!cfg.noIgd) udp.send(Buffer.from(`HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:${httpPort}/desc.xml\r\n\r\n`), rinfo.port, rinfo.address); });
  return { calls, ssdp: { addr: "127.0.0.1", port: /** @type {any} */ (udp.address()).port }, close: () => { srv.closeAllConnections?.(); srv.close(); udp.close(); } };
}

/** A fake NAT-PMP gateway on loopback UDP. @param {{ external?: [number, number, number, number], refuse?: boolean, mapExternal?: number }} [cfg] */
async function fakePmp(cfg = {}) {
  const udp = dgram.createSocket("udp4");
  await new Promise(r => udp.bind(0, "127.0.0.1", () => r(undefined)));
  const seen = /** @type {Buffer[]} */ ([]);
  udp.on("message", (m, rinfo) => {
    seen.push(m);
    const op = m[1];
    if (op === 0) { const a = Buffer.alloc(12); a.writeUInt8(128, 1); a.writeUInt16BE(0, 2); (cfg.external || [93, 184, 216, 7]).forEach((x, i) => { a[8 + i] = x; }); udp.send(a, rinfo.port, rinfo.address); return; }
    const a = Buffer.alloc(16); a.writeUInt8(128 + op, 1); a.writeUInt16BE(cfg.refuse ? 2 : 0, 2); a.writeUInt16BE(m.readUInt16BE(4), 8); a.writeUInt16BE(cfg.mapExternal ?? m.readUInt16BE(6), 10); a.writeUInt32BE(m.readUInt32BE(8) || 0, 12);
    udp.send(a, rinfo.port, rinfo.address);
  });
  return { seen, port: /** @type {any} */ (udp.address()).port, close: () => udp.close() };
}

test("addresses: what counts as public, global IPv6, the machine's own addresses, the gateway", () => {
  for (const ip of ["10.0.0.1", "192.168.1.1", "172.16.0.1", "127.0.0.1", "100.64.0.1", "100.127.255.1", "169.254.1.1", "224.0.0.1", "0.0.0.0", "198.18.0.1", "999.1.1.1", "nope"]) assert.equal(isPublicV4(ip), false, ip);
  for (const ip of ["93.184.216.9", "8.8.8.8", "100.63.0.1", "172.32.0.1"]) assert.equal(isPublicV4(ip), true, ip);
  assert.equal(isGlobalV6("2a01:4f8:1::7"), true);
  assert.equal(isGlobalV6("fe80::1"), false);
  assert.equal(isGlobalV6("fd00::1"), false);
  assert.deepEqual(localAddresses(LAN6), { v6: ["2a01:4f8:1::7"], v4: "192.168.1.20" });
  assert.deepEqual(localAddresses(LAN), { v6: [], v4: "192.168.1.20" });
  assert.equal(defaultGateway(() => "Iface\tDestination\tGateway\tFlags\neth0\t00000000\t0101A8C0\t0003\neth0\t0001A8C0\t00000000\t0001\n"), "192.168.1.1");
  assert.equal(defaultGateway(() => { throw new Error("no /proc"); }), null);
  const d = parseDescription("<x><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></x>", "http://192.168.1.1:5000/desc.xml");
  assert.deepEqual(d, { type: "urn:schemas-upnp-org:service:WANIPConnection:1", controlUrl: "http://192.168.1.1:5000/ctl" });
  assert.equal(parseDescription("<x/>", "http://a/"), null);
});

test("no router and no IPv6: the state is relay and every attempt says why", async () => {
  const igd = await fakeIgd({ noIgd: true });
  const r = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN, ssdp: igd.ssdp, gateway: () => null, timeoutMs: 300 });
  const s = await r.start();
  await r.stop(); igd.close();
  assert.equal(s.state, "relay");
  assert.deepEqual(s.mapped, []);
  assert.deepEqual(s.tried.map(t => t.via), ["ipv6", "upnp", "natpmp"]);
  assert.ok(s.tried.every(t => !t.ok && t.why));
});

test("UPnP: the port is mapped, proven from outside, called direct, and deleted on stop", async () => {
  const igd = await fakeIgd();
  const checks = /** @type {any[]} */ ([]);
  const r = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN, ssdp: igd.ssdp, gateway: () => null, timeoutMs: 800, verify: async c => { checks.push(c); return true; } });
  const s = await r.start();
  assert.equal(s.state, "direct");
  assert.deepEqual(s.public, { v4: "93.184.216.9", v6: null, via: "upnp" });
  assert.equal(s.mapped.length, 1);
  assert.equal(s.mapped[0].verified, true);
  assert.deepEqual(checks[0], { addr: "93.184.216.9", port: 8443, proto: "tcp", via: "upnp" });
  const add = igd.calls.find(c => c.action === "AddPortMapping");
  assert.ok(add && /<NewInternalClient>192\.168\.1\.20</.test(add.body) && /<NewProtocol>TCP</.test(add.body) && /<NewLeaseDuration>3600</.test(add.body));
  await r.stop();
  assert.ok(igd.calls.some(c => c.action === "DeletePortMapping" && /<NewExternalPort>8443</.test(c.body)), "the mapping was taken off the router");
  assert.equal(r.status().state, "relay");
  igd.close();
});

test("UPnP: mapped but not reachable from outside stays relay; with no verifier it never says direct", async () => {
  const igd = await fakeIgd();
  const a = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN, ssdp: igd.ssdp, gateway: () => null, timeoutMs: 800, verify: async () => false });
  const sa = await a.start(); await a.stop();
  assert.equal(sa.state, "relay");
  assert.match(sa.tried.find(t => t.via === "upnp")?.why || "", /not reachable from outside/);
  const b = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN, ssdp: igd.ssdp, gateway: () => null, timeoutMs: 800 });
  const sb = await b.start(); await b.stop();
  assert.equal(sb.state, "relay");
  assert.match(sb.tried.find(t => t.via === "upnp")?.why || "", /no outside check/);
  igd.close();
});

test("UPnP: a router that only does permanent leases is asked for one; a taken port moves to another", async () => {
  const igd = await fakeIgd({ errors: { AddPortMapping: "725:OnlyPermanentLeasesSupported" } });
  const a = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN, ssdp: igd.ssdp, gateway: () => null, timeoutMs: 800 });
  await a.start();
  assert.ok(igd.calls.filter(c => c.action === "AddPortMapping").length >= 2);
  await a.stop(); igd.close();
  const igd2 = await fakeIgd({ errors: { AddPortMapping: "718:ConflictInMappingEntry" } });
  const b = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN, ssdp: igd2.ssdp, gateway: () => null, timeoutMs: 800, disable: ["natpmp"] });
  const sb = await b.start(); await b.stop(); igd2.close();
  assert.equal(sb.state, "relay");
  assert.ok(igd2.calls.filter(c => c.action === "AddPortMapping").length === 4, "it tried other external ports, then gave up");
});

test("a router behind carrier-grade NAT or with a private outside address is not direct, and says so", async () => {
  const igd = await fakeIgd({ external: "100.72.5.5" });
  const r = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN, ssdp: igd.ssdp, gateway: () => null, timeoutMs: 800, verify: async () => true, disable: ["natpmp"] });
  const s = await r.start(); await r.stop(); igd.close();
  assert.equal(s.state, "relay");
  assert.match(s.tried.find(t => t.via === "upnp")?.why || "", /CGNAT/);
  assert.equal(igd.calls.some(c => c.action === "AddPortMapping"), false, "no mapping is made on a router that cannot be reached");
});

test("NAT-PMP: asks the gateway for the address and the port, proves it, and releases it on stop", async () => {
  const pmp = await fakePmp();
  const igd = await fakeIgd({ noIgd: true });
  const r = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN, ssdp: igd.ssdp, gateway: () => "127.0.0.1", pmpPort: pmp.port, timeoutMs: 400, verify: async () => true });
  const s = await r.start();
  assert.equal(s.state, "direct");
  assert.deepEqual(s.public, { v4: "93.184.216.7", v6: null, via: "natpmp" });
  assert.equal(s.mapped[0].via, "natpmp");
  const map = pmp.seen.find(m => m[1] === 2);
  assert.ok(map && map.readUInt16BE(4) === 8443 && map.readUInt32BE(8) === 3600);
  await r.stop();
  const del = pmp.seen.filter(m => m[1] === 2).pop();
  assert.equal(del && del.readUInt32BE(8), 0, "a zero lifetime deletes the mapping");
  pmp.close(); igd.close();
});

test("NAT-PMP: a refusal, and an answer that is a private address, leave the relay as the path", async () => {
  const igd = await fakeIgd({ noIgd: true });
  const refuse = await fakePmp({ refuse: true });
  const a = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN, ssdp: igd.ssdp, gateway: () => "127.0.0.1", pmpPort: refuse.port, timeoutMs: 400, verify: async () => true });
  const sa = await a.start(); await a.stop();
  assert.equal(sa.state, "relay"); assert.match(sa.tried.find(t => t.via === "natpmp")?.why || "", /refused/);
  const priv = await fakePmp({ external: [10, 0, 0, 2] });
  const b = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN, ssdp: igd.ssdp, gateway: () => "127.0.0.1", pmpPort: priv.port, timeoutMs: 400, verify: async () => true });
  const sb = await b.start(); await b.stop();
  assert.equal(sb.state, "relay"); assert.match(sb.tried.find(t => t.via === "natpmp")?.why || "", /private/);
  refuse.close(); priv.close(); igd.close();
});

test("IPv6: a global address is a candidate, and direct only when the outside check reaches it", async () => {
  const igd = await fakeIgd({ noIgd: true });
  const closed = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN6, ssdp: igd.ssdp, gateway: () => null, timeoutMs: 300, verify: async () => false });
  const sc = await closed.start(); await closed.stop();
  assert.equal(sc.state, "relay"); assert.equal(sc.public.v6, "2a01:4f8:1::7");
  assert.match(sc.tried[0].why || "", /firewall/);
  const open = createReach({ ports: [{ port: 8443, proto: "tcp" }], interfaces: LAN6, ssdp: igd.ssdp, gateway: () => null, timeoutMs: 300, verify: async c => c.addr === "2a01:4f8:1::7" });
  const so = await open.start(); await open.stop(); igd.close();
  assert.equal(so.state, "direct"); assert.equal(so.public.via, "ipv6");
});

test("the relay's reach check dials only the caller's own address, only a high port, and says whether it answered", async t => {
  const dialed = /** @type {any[]} */ ([]);
  const relay = createRelay({ reach: { allowPrivate: true, dial: async (a, p) => { dialed.push([a, p]); return p === 9999; } } });
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const post = (/** @type {any} */ b) => fetch(`${http}/v1/reach/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.deepEqual(await (await post({ port: 9999 })).json(), { reachable: true, addr: "127.0.0.1", port: 9999 });
  assert.equal((await (await post({ port: 9998 })).json()).reachable, false);
  assert.equal((await post({ port: 80 })).status, 400, "a low port is refused");
  assert.equal((await post({ port: 9999, addr: "8.8.8.8" })).status, 400, "another address is refused");
  assert.deepEqual(dialed.map(d => d[0]), ["127.0.0.1", "127.0.0.1"]);
  const v = relayVerifier(http);
  assert.equal(await v({ addr: "127.0.0.1", port: 9999, proto: "tcp", via: "upnp" }), true);
  assert.equal(await v({ addr: "127.0.0.1", port: 9990, proto: "tcp", via: "upnp" }), false);
});

test("the relay's reach check refuses a private caller by default and is rate limited", async t => {
  const relay = createRelay({ reach: { dial: async () => { throw new Error("must not dial"); }, perMin: 2 } });
  const base = await relay.listen();
  t.after(() => relay.close());
  const post = () => fetch(`${base.replace(/^ws/, "http")}/v1/reach/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ port: 9999 }) });
  const a = await (await post()).json();
  assert.equal(a.reachable, false); assert.match(a.why, /not a public one/);
  await post();
  assert.equal((await post()).status, 429);
});
