// @ts-check
// The egress gate with fakes all round: a fake tailscaled LocalAPI on a unix socket (status JSON
// the test controls), a fake sidecar SOCKS5 server that records what it is sent and relays to a
// fake target, and the target itself. Nothing here reaches a real tailnet or the internet.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { createGate, verdict, fromEnv, REP, DEFAULTS } from "./egressgate.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** A status in which the exit node (alex-mac) is in use and offering itself. */
function active(peer = {}, top = {}) {
  return {
    BackendState: "Running",
    Self: { HostName: "vyre-egress", Online: true },
    Peer: {
      "nodekey:aa": { HostName: "alex-mac", Online: true, ExitNode: true, ExitNodeOption: true, ...peer },
      "nodekey:bb": { HostName: "northwind-laptop", Online: true, ExitNode: false, ExitNodeOption: false },
    },
    ExitNodeStatus: { ID: "n1", Online: true, TailscaleIPs: ["100.64.0.7/32"] },
    ...top,
  };
}

const listen = (srv, ...a) => new Promise(r => srv.listen(...a, () => r(undefined)));
/** Close a fake server and drop its connections, so no test waits on another's socket. */
const closeSrv = srv => {
  for (const c of srv.conns || []) c.destroy();
  if (typeof srv.closeAllConnections === "function") srv.closeAllConnections();
  return new Promise(r => (srv.listening ? srv.close(() => r(undefined)) : r(undefined)));
};
/** @template {net.Server} S @param {S} srv @returns {S} */
const tracked = srv => {
  /** @type {any} */ (srv).conns = new Set();
  srv.on("connection", c => { /** @type {any} */ (srv).conns.add(c); c.once("close", () => /** @type {any} */ (srv).conns.delete(c)); });
  return srv;
};

/** The fake LocalAPI: answers /localapi/v0/status with whatever `state.body` holds. */
async function fakeLocalApi(t) {
  const sock = path.join(tempHome(t), "ts.sock");
  const state = { body: JSON.stringify(active()), code: 200, reads: 0, hosts: /** @type {string[]} */ ([]) };
  const srv = tracked(http.createServer((req, res) => {
    if (req.url !== "/localapi/v0/status") { res.writeHead(404).end(); return; }
    state.reads++;
    state.hosts.push(String(req.headers.host));
    res.writeHead(state.code, { "content-type": "application/json", connection: "close" }).end(state.body);
  }));
  await listen(srv, sock);
  t.after(() => closeSrv(srv));
  return { sock, state, set: st => { state.body = typeof st === "string" ? st : JSON.stringify(st); } };
}

/** A target that answers every line with "echo:" and the line, counting connections. */
async function fakeTarget(t) {
  const seen = { connections: 0 };
  const srv = tracked(net.createServer(c => { seen.connections++; c.on("data", d => c.write(`echo:${d}`)); c.on("error", () => {}); }));
  await listen(srv, 0, "127.0.0.1");
  t.after(() => closeSrv(srv));
  return { port: /** @type {any} */ (srv.address()).port, seen };
}

/** A SOCKS5 server playing tailscaled's: records its bytes, then connects to the target. */
async function fakeSidecar(t) {
  const seen = { connections: 0, bytes: /** @type {Buffer[]} */ ([]) };
  /** @type {Set<net.Socket>} */
  const socks = new Set();
  const srv = tracked(net.createServer(c => {
    seen.connections++;
    socks.add(c);
    c.on("error", () => {});
    let buf = Buffer.alloc(0), stage = 0;
    const onData = d => {
      seen.bytes.push(Buffer.from(d));
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 + buf[1]) { buf = buf.subarray(2 + buf[1]); c.write(Buffer.from([5, 0])); stage = 1; }
      if (stage === 1 && buf.length >= 10 && buf[3] === 1) {
        const port = buf.readUInt16BE(8);
        const rest = buf.subarray(10);
        stage = 2;
        c.off("data", onData);
        const out = net.connect({ host: `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`, port }, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) out.write(rest);
          c.pipe(out); out.pipe(c);
        });
        socks.add(out);
        out.on("error", () => c.destroy());
      }
    };
    c.on("data", onData);
  }));
  await listen(srv, 0, "127.0.0.1");
  t.after(() => { for (const s of socks) s.destroy(); return closeSrv(srv); });
  return { port: /** @type {any} */ (srv.address()).port, seen };
}

/** A gate on ephemeral ports, closed after the test. */
async function gateFor(t, opts) {
  const log = /** @type {string[]} */ ([]);
  const gate = createGate({ host: "127.0.0.1", port: 0, statusPort: 0, log: m => log.push(m), ...opts });
  const addr = await gate.listen();
  t.after(() => gate.close());
  return { gate, log, ...addr };
}

/** Read exactly n bytes from a socket, or fewer if it closes first. */
function readN(sock, n) {
  return new Promise(resolve => {
    let buf = Buffer.alloc(0);
    const onData = d => { buf = Buffer.concat([buf, d]); if (buf.length >= n) { done(); } };
    const done = () => { sock.off("data", onData); sock.off("close", done); sock.pause(); resolve(buf.subarray(0, Math.max(n, 0))); if (buf.length > n) sock.unshift(buf.subarray(n)); };
    sock.on("data", onData);
    sock.once("close", done);
    sock.resume();
  });
}

const ipv4Request = port => Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, port >> 8, port & 255]);

/**
 * A SOCKS5 client: greeting, then a request, returning the method reply, the CONNECT reply and
 * the socket (paused, positioned after the reply).
 */
async function socks5(gatePort, request) {
  const s = net.connect({ host: "127.0.0.1", port: gatePort });
  s.on("error", () => {});
  await new Promise(r => s.once("connect", r));
  s.write(Buffer.from([5, 1, 0]));
  const method = await readN(s, 2);
  s.write(request);
  const rep = await readN(s, 10);
  return { s, method, rep };
}

test("egressgate: with the exit node in use, bytes flow end to end through the gate and the sidecar", async t => {
  const api = await fakeLocalApi(t);
  const target = await fakeTarget(t);
  const side = await fakeSidecar(t);
  const { port, log } = await gateFor(t, { socket: api.sock, upstream: `127.0.0.1:${side.port}` });
  const req = ipv4Request(target.port);
  const { s, method, rep } = await socks5(port, req);
  t.after(() => s.destroy());
  assert.deepEqual([...method], [5, 0]);
  assert.equal(rep[1], 0, "the sidecar's success reached the client");
  s.write("hello");
  assert.equal(String(await readN(s, 10)), "echo:hello");
  assert.equal(side.seen.connections, 1);
  assert.equal(target.seen.connections, 1);
  // The sidecar got a no-auth greeting, then the client's request byte for byte.
  const sent = Buffer.concat(side.seen.bytes);
  assert.deepEqual([...sent.subarray(0, 3)], [5, 1, 0]);
  assert.deepEqual([...sent.subarray(3, 3 + req.length)], [...req]);
  assert.deepEqual(api.state.hosts, ["local-tailscaled.sock"], "the LocalAPI is asked with its own host name");
  assert.deepEqual(log, ["allowing: the exit node is in use again"]);
});

test("egressgate: when the Mac stops offering the exit node, the client gets REP 0x02 and nothing is dialled", async t => {
  const api = await fakeLocalApi(t);
  api.set(active({ ExitNodeOption: false }));
  const target = await fakeTarget(t);
  const side = await fakeSidecar(t);
  const { port, log } = await gateFor(t, { socket: api.sock, upstream: `127.0.0.1:${side.port}` });
  const { s, method, rep } = await socks5(port, ipv4Request(target.port));
  t.after(() => s.destroy());
  assert.deepEqual([...method], [5, 0], "the method negotiation still succeeds");
  assert.deepEqual([...rep], [5, REP.NOT_ALLOWED, 0, 1, 0, 0, 0, 0, 0, 0]);
  await new Promise(r => (s.destroyed || s.readableEnded ? r(undefined) : s.once("close", r)));
  assert.equal(side.seen.connections, 0, "the sidecar never saw a connection");
  assert.equal(target.seen.connections, 0, "the target never saw one");
  assert.equal(log.length, 1);
  assert.match(log[0], /refusing every listed site: .*ExitNodeOption is false/);
});

test("egressgate: every other doubt is a refusal too", async t => {
  const target = await fakeTarget(t);
  const side = await fakeSidecar(t);
  const peerless = active();
  peerless.Peer = { "nodekey:bb": peerless.Peer["nodekey:bb"] };
  const noPeers = active();
  delete noPeers.Peer;
  const cases = [
    ["the route is unapproved", active({ ExitNodeOption: false }), /ExitNodeOption/],
    ["the peer is offline", active({ Online: false }), /offline/],
    ["the peer's Online is missing", active({ Online: undefined }), /offline/],
    ["BackendState is Stopped", active({}, { BackendState: "Stopped" }), /not running/],
    ["BackendState is NeedsLogin", active({}, { BackendState: "NeedsLogin" }), /not running/],
    ["no peer is the exit node", peerless, /no peer/],
    ["no peers at all", noPeers, /no peer/],
    ["ExitNodeStatus says offline", active({}, { ExitNodeStatus: { ID: "n1", Online: false } }), /ExitNodeStatus/],
    ["ExitNodeStatus is null", active({}, { ExitNodeStatus: null }), /ExitNodeStatus/],
    ["the status is garbage", "not json {", /not JSON/],
    ["the status is a list", "[]", /not an object/],
  ];
  for (const [name, status, why] of cases) {
    const api = await fakeLocalApi(t);
    api.set(status);
    const { port, gate, log } = await gateFor(t, { socket: api.sock, upstream: `127.0.0.1:${side.port}` });
    const { s, rep } = await socks5(port, ipv4Request(target.port));
    s.destroy();
    assert.equal(rep[1], REP.NOT_ALLOWED, `${name}: allowed`);
    assert.match(log.join("\n"), why, name);
    await gate.close();
  }
  // The LocalAPI answering an error, and no socket at all.
  const api = await fakeLocalApi(t);
  api.state.code = 500;
  for (const [name, sock, why] of [["the LocalAPI fails", api.sock, /answered 500/], ["the socket is missing", path.join(tempHome(t), "none.sock"), /ENOENT/]]) {
    const { port, gate, log } = await gateFor(t, { socket: sock, upstream: `127.0.0.1:${side.port}` });
    const { s, rep } = await socks5(port, ipv4Request(target.port));
    s.destroy();
    assert.equal(rep[1], REP.NOT_ALLOWED, `${name}: allowed`);
    assert.match(log.join("\n"), why, name);
    await gate.close();
  }
  assert.equal(side.seen.connections, 0, "no refusal ever reached the sidecar");
  assert.equal(target.seen.connections, 0);
});

test("egressgate: verdict passes only the exact healthy shape", () => {
  assert.equal(verdict(active()).allowed, true);
  const noStatusField = active();
  delete noStatusField.ExitNodeStatus;
  assert.equal(verdict(noStatusField).allowed, true, "ExitNodeStatus is checked only when present");
  for (const bad of [null, undefined, 1, "Running", [], {}, active({ ExitNode: "true" }), active({ ExitNodeOption: 1 }),
    active({}, { BackendState: "running" }), active({}, { Peer: { a: { ExitNode: true, ExitNodeOption: true, Online: true }, b: { ExitNode: true, ExitNodeOption: true, Online: true } } })]) {
    assert.equal(verdict(bad).allowed, false, JSON.stringify(bad));
  }
  assert.doesNotMatch(JSON.stringify(verdict(active({ Online: false }))), /alex-mac|100\.64/, "a reason never names the Mac or its address");
});

test("egressgate: domain and IPv6 requests are read and refused the same way; other commands are not relayed", async t => {
  const api = await fakeLocalApi(t);
  api.set(active({ ExitNodeOption: false }));
  const side = await fakeSidecar(t);
  const { port } = await gateFor(t, { socket: api.sock, upstream: `127.0.0.1:${side.port}` });
  const name = Buffer.from("portal.northwind.example");
  const domain = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([1, 187])]);
  const v6 = Buffer.concat([Buffer.from([5, 1, 0, 4]), Buffer.alloc(15), Buffer.from([1, 1, 187])]);
  for (const req of [domain, v6]) {
    const { s, rep } = await socks5(port, req);
    s.destroy();
    assert.equal(rep[1], REP.NOT_ALLOWED);
  }
  const bind = await socks5(port, Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 80]));
  bind.s.destroy();
  assert.equal(bind.rep[1], REP.BAD_COMMAND);
  const atyp = await socks5(port, Buffer.from([5, 1, 0, 9, 0, 0, 0, 0, 0, 0]));
  atyp.s.destroy();
  assert.equal(atyp.rep[1], REP.BAD_ADDRESS);
  // A client that offers no "no authentication" method is told none is acceptable.
  const s = net.connect({ host: "127.0.0.1", port });
  s.on("error", () => {});
  await new Promise(r => s.once("connect", r));
  s.write(Buffer.from([5, 1, 2]));
  assert.deepEqual([...(await readN(s, 2))], [5, 0xff]);
  s.destroy();
  assert.equal(side.seen.connections, 0);
});

test("egressgate: a burst reads the status once, and it is read again after 2 s", async t => {
  const api = await fakeLocalApi(t);
  let clock = 1_000_000;
  const { gate } = await gateFor(t, { socket: api.sock, upstream: "127.0.0.1:9", now: () => clock });
  const burst = await Promise.all(Array.from({ length: 8 }, () => gate.check()));
  assert.ok(burst.every(v => v.allowed));
  assert.equal(api.state.reads, 1, "eight concurrent checks, one read");
  clock += 1999;
  await gate.check();
  assert.equal(api.state.reads, 1, "still cached just under 2 s");
  clock += 2;
  api.set(active({ ExitNodeOption: false }));
  assert.equal((await gate.check()).allowed, false, "past 2 s the new state is seen");
  assert.equal(api.state.reads, 2);
  assert.equal(gate.reads, 2);
});

test("egressgate: a burst of connections through the gate reads the status once", async t => {
  const api = await fakeLocalApi(t);
  api.set(active({ ExitNodeOption: false }));
  const { port } = await gateFor(t, { socket: api.sock, upstream: "127.0.0.1:9" });
  const all = await Promise.all(Array.from({ length: 6 }, () => socks5(port, ipv4Request(80))));
  for (const { s, rep } of all) { s.destroy(); assert.equal(rep[1], REP.NOT_ALLOWED); }
  assert.equal(api.state.reads, 1);
});

test("egressgate: a refusal is logged once per change of reason, not once per connection", async t => {
  const api = await fakeLocalApi(t);
  let clock = 0;
  const { gate, log } = await gateFor(t, { socket: api.sock, upstream: "127.0.0.1:9", now: () => clock });
  const step = async st => { api.set(st); clock += 5000; await gate.check(); };
  await step(active({ ExitNodeOption: false }));
  await step(active({ ExitNodeOption: false }));
  await step(active({ ExitNodeOption: false }));
  await step(active({ Online: false }));
  await step(active());
  await step(active());
  await step(active({ ExitNodeOption: false }));
  assert.equal(log.length, 4, log.join("\n"));
  assert.match(log[0], /ExitNodeOption/);
  assert.match(log[1], /offline/);
  assert.match(log[2], /allowing/);
  assert.match(log[3], /ExitNodeOption/);
});

test("egressgate: GET /status answers the verdict; anything else is 404", async t => {
  const api = await fakeLocalApi(t);
  api.set(active({ Online: false }));
  const { statusPort } = await gateFor(t, { socket: api.sock, upstream: "127.0.0.1:9" });
  const get = p => new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: statusPort, path: p, agent: false }, res => {
    let b = ""; res.on("data", c => (b += c)); res.on("end", () => resolve({ code: res.statusCode, body: b }));
  }).on("error", reject));
  const ok = /** @type {any} */ (await get("/status"));
  assert.equal(ok.code, 200);
  assert.deepEqual(Object.keys(JSON.parse(ok.body)).sort(), ["allowed", "reason"]);
  assert.equal(JSON.parse(ok.body).allowed, false);
  assert.equal((/** @type {any} */ (await get("/"))).code, 404);
});

test("egressgate: nothing is left running while idle, and close leaves nothing behind", async t => {
  const count = kind => process.getActiveResourcesInfo().filter(k => k === kind).length;
  const api = await fakeLocalApi(t);
  const target = await fakeTarget(t);
  const side = await fakeSidecar(t);
  const timers = count("Timeout");
  const servers = count("TCPServerWrap");
  const gate = createGate({ host: "127.0.0.1", port: 0, statusPort: 0, socket: api.sock, upstream: `127.0.0.1:${side.port}`, log: () => {} });
  const { port } = await gate.listen();
  assert.equal(count("TCPServerWrap"), servers + 2, "the SOCKS5 port and the status port");
  assert.equal(count("Timeout"), timers, "no timer once listening");
  const { s } = await socks5(port, ipv4Request(target.port));
  s.write("x");
  await readN(s, 6);
  s.destroy();
  api.set(active({ ExitNodeOption: false }));
  // Past the 2 s cache, so the next connection reads the status again.
  await new Promise(r => setTimeout(r, 2100));
  const again = await socks5(port, ipv4Request(target.port));
  assert.equal(again.rep[1], REP.NOT_ALLOWED);
  again.s.destroy();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(count("Timeout"), timers, "no timer left behind by a relayed or a refused connection");
  await gate.close();
  assert.equal(count("TCPServerWrap"), servers, "both ports closed");
  assert.equal(count("Timeout"), timers);
});

test("egressgate: its ports, upstream and socket come from the env, with the compose defaults", () => {
  assert.deepEqual({ ...DEFAULTS }, { host: "0.0.0.0", port: 1055, statusPort: 1057, upstream: "egress-node:1056", socket: "/var/run/egress-node/tailscaled.sock", cacheMs: 2000 });
  assert.ok(fromEnv({ VYRE_EGRESS_GATE_PORT: "0", VYRE_EGRESS_UPSTREAM: "127.0.0.1:1" }), "an env builds a gate without listening");
  assert.throws(() => fromEnv({ VYRE_EGRESS_UPSTREAM: "nowhere" }), /not a host:port/);
});
