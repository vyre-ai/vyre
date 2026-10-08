// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createNetd, findBinaries, nodeNameFor, PEER_PORT } from "./netd.js";

const home = () => fs.mkdtempSync(path.join(SCRATCH, "netd-"));

/** Fake engines that record what they were asked, in order. */
function fakes({ failHsOnce = false, failNode = false, nodes = /** @type {any[] | null} */ (null) } = {}) {
  const calls = /** @type {string[]} */ ([]);
  let hsFailed = false;
  const policies = /** @type {any[]} */ ([]);
  const deleted = /** @type {number[]} */ ([]);
  const keyIds = /** @type {number[]} */ ([]);
  const createHeadscale = (/** @type {any} */ o) => ({
    listen: { host: "127.0.0.1", port: o.listenPort },
    async start() { calls.push(`hs.start ${o.serverUrl}`); if (failHsOnce && !hsFailed) { hsFailed = true; throw new Error("headscale did not become healthy in time"); } return {}; },
    async stop() { calls.push("hs.stop"); },
    async createPreauthKey() { calls.push("hs.key"); keyIds.push(200 + keyIds.length); return { key: "hskey-fake0123456789", id: keyIds.at(-1) }; },
    prefix: "100.99.1.0/24",
    async listNodes() { return (nodes || [{ id: 1, name: "home", ips: ["100.99.1.1"] }, { id: 2, name: nodeNameFor("devB"), ips: ["100.99.1.2"], preAuthKeyId: 100 }]).filter(n => !deleted.includes(n.id)); },
    async deleteNode(/** @type {number} */ id) { calls.push(`hs.delete ${id}`); deleted.push(id); },
    setPolicy(/** @type {string} */ t) { calls.push("hs.policy"); policies.push(JSON.parse(t)); return { changed: true }; },
  });
  const createGate = (/** @type {any} */ o) => ({
    async listen() { calls.push(`gate.listen ${o.listen.host} up:${o.upstream.port}`); return o.listen; },
    async close() { calls.push("gate.close"); },
  });
  const createHost = (/** @type {any} */ o) => {
    const spaces = /** @type {any[]} */ ([]);
    return {
      addSpace(/** @type {any} */ s) { calls.push(`host.addSpace ${s.id} peerPort:${s.peerPort} key:${s.authKey ? "yes" : "no"}`); spaces.push(s); },
      async start() { calls.push(`host.start fwd:${o.forwarderBin || "none"}`); if (failNode) throw new Error("the node did not come up"); return { nodeKey: "n", ips: ["100.99.1.1"] }; },
      async serveHome(/** @type {string} */ id, /** @type {any} */ x) { calls.push(`host.serveHome ${id} entry:${typeof x.identity.entry} serve:${typeof x.serve}`); },
      async stopAll() { calls.push("host.stopAll"); },
      status: () => spaces.map(s => ({ id: s.id, node: "up", links: [], peers: [], door: "listening" })),
    };
  };
  return { calls, policies, keyIds, deps: { createHeadscale, createGate, createHost, freePort: (() => { let p = 41000; return async () => p++; })() } };
}
/** A home whose pre-auth key 100 was minted for devB (what a pairing's hand-over records). */
function homeWithKeys() { const r = home(); fs.mkdirSync(path.join(r, "wink-net"), { recursive: true }); fs.writeFileSync(path.join(r, "wink-net", "keys.json"), JSON.stringify({ 100: "devB" })); return r; }
const base = (/** @type {any} */ f, /** @type {any} */ extra = {}) => ({
  root: homeWithKeys(), space: async () => "spc_home1", box: async () => "boxid", entry: async () => ({ eid: "x", kind: "device", pub: "p" }),
  devices: () => ["devB"], serve: async () => ({}), binaries: { headscale: "/x/headscale", forwarder: "/x/wink-forwarder" }, deps: f.deps, retryMs: 0, reach: null, ...extra,
});

test("up: headscale, then the gate in front of it, then the node, then the door; the status says up", async () => {
  const f = fakes();
  const n = createNetd(base(f));
  await n.start();
  assert.deepEqual(f.calls.map(c => c.split(" ")[0]), ["hs.start", "gate.listen", "hs.key", "host.addSpace", "host.start", "host.serveHome", "hs.policy"]);
  const acl = f.policies[0].acls;
  assert.equal(acl.length, 1, "one rule: devices reach the hub's door port");
  assert.deepEqual(acl[0].dst, [`n-home:${PEER_PORT}`]);
  assert.deepEqual(acl[0].src, ["n-d-2"], "the home's own node (100.99.1.1) is not a device; the other node is");
  assert.match(f.calls[1], /^gate\.listen 127\.0\.0\.1 up:41001$/, "the gate binds loopback and fronts the headscale's own port");
  assert.equal(f.calls[3], `host.addSpace spc_home1 peerPort:${PEER_PORT} key:yes`);
  const s = n.status();
  assert.equal(s.state, "up");
  assert.deepEqual(s.ips, ["100.99.1.1"]);
  assert.equal(s.public, false);
  assert.ok(n.host() && n.host().status()[0].door === "listening");
  await n.stop();
  assert.deepEqual(f.calls.slice(-3), ["host.stopAll", "gate.close", "hs.stop"]);
});

test("no-binary: a box without the programs says so, starts nothing, and still has a host for the status", async () => {
  const f = fakes();
  const n = createNetd(base(f, { binaries: { headscale: null, forwarder: "/x/f" } }));
  await n.start();
  assert.equal(n.status().state, "no-binary");
  assert.match(String(n.status().why), /headscale/);
  assert.deepEqual(f.calls, []);
  assert.ok(n.host(), "the status port always has a host");
});

test("off: switched off starts nothing", async () => {
  const f = fakes();
  const n = createNetd(base(f, { enabled: false }));
  await n.start();
  assert.equal(n.status().state, "off");
  assert.deepEqual(f.calls, []);
});

test("a failed piece is reported, torn down and retried; the retry comes up", async () => {
  const f = fakes({ failHsOnce: true });
  const n = createNetd(base(f, { retryMs: 5 }));
  await n.start();
  assert.equal(n.status().state, "up");
  assert.ok(f.calls.includes("hs.stop"), "the first attempt was torn down");
  assert.equal(f.calls.filter(c => c.startsWith("hs.start")).length, 2);
});

test("failed with no retry: the node did not come up, the state names it, everything is stopped", async () => {
  const f = fakes({ failNode: true });
  const n = createNetd(base(f));
  await n.start();
  assert.equal(n.status().state, "failed");
  assert.match(String(n.status().why), /did not come up/);
  assert.ok(f.calls.includes("gate.close") && f.calls.includes("hs.stop"));
  assert.ok(n.host(), "a host remains for the status");
});

test("no door dispatcher: the node comes up and answers no peers yet", async () => {
  const f = fakes();
  const logs = /** @type {string[]} */ ([]);
  const n = createNetd(base(f, { serve: null, log: (/** @type {string} */ m) => logs.push(m) }));
  await n.start();
  assert.equal(n.status().state, "up");
  assert.ok(!f.calls.some(c => c.startsWith("host.serveHome")));
  assert.ok(logs.some(l => /no door dispatcher/.test(l)));
});

test("a public control address: the gate listens on every interface and a pairing is handed a one-time key; without one it is handed nothing", async () => {
  const f = fakes();
  const n = createNetd(base(f, { controlUrl: "https://hs.example.vyre.run" }));
  await n.start();
  assert.match(f.calls.find(c => c.startsWith("gate.listen")) || "", /0\.0\.0\.0/);
  const h = await n.handover({});
  assert.equal(h.controlUrl, "https://hs.example.vyre.run");
  assert.equal(h.space, "spc_home1");
  assert.ok(h.authKey);
  const g = fakes();
  const m = createNetd(base(g));
  await m.start();
  assert.equal(await m.handover({}), null, "a loopback-only network gives another machine nothing to dial");
});

test("reach: its status is carried, and it never blocks the network (a configured control address: the gate listens in public, so its port is the one mapped)", async () => {
  const f = fakes();
  const made = /** @type {any[]} */ ([]);
  const reach = { start: () => { made.push("start"); return new Promise(() => {}); }, status: () => ({ state: "relay", public: { v4: null, v6: null, via: null } }), stop: () => {} };
  const n = createNetd(base(f, { controlUrl: "https://home.example:9443", gatePort: 9443, reach: (/** @type {any} */ opts) => { made.push(opts.ports); return reach; } }));
  await n.start();
  assert.equal(n.status().state, "up");
  assert.deepEqual(made, [[{ port: 9443, proto: "tcp" }], "start"]);
  assert.equal(n.status().reach.state, "relay");
});

test("reach (NW2-2): a box with no name, or with the public gate off, has only the loopback gate and nothing is ever mapped for it", async () => {
  const f = fakes(), p = fakePublic();
  let made = 0;
  const spy = () => { made++; return { start: async () => {}, status: () => ({ state: "relay" }), stop: () => {} }; };
  const noName = createNetd(base(f, { name: () => null, directory: dirStub, reach: spy, deps: { ...f.deps, createPublicGate: p.createPublicGate } }));
  await noName.start();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(noName.status().state, "up");
  assert.equal(made, 0, "no public gate is listening, so no port is mapped");
  assert.equal(noName.status().reach, null);
  await noName.stop();
  const f2 = fakes();
  const off = createNetd(base(f2, { name: () => "alex", reach: spy }));   // no directory: no public gate at all
  await off.start();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(made, 0, "no public gate, so nothing is mapped");
  await off.stop();
});

test("reach (NW2-2): a named box maps the PUBLIC gate's port, and only once that gate is up with its certificate", async () => {
  const f = fakes();
  const order = /** @type {string[]} */ ([]);
  /** @type {() => void} */ let release = () => {};
  const gateUp = new Promise(r => { release = () => r(undefined); });
  const p = fakePublic();
  const createPublicGate = (/** @type {any} */ o) => { const g = p.createPublicGate(o); const start = g.start; g.start = async () => { order.push("gate starting"); await gateUp; order.push("gate up"); return start.call(g); }; return g; };
  const n = createNetd(base(f, { name: () => "alex", directory: dirStub, reach: (/** @type {any} */ opts) => { order.push(`reach ${JSON.stringify(opts.ports)}`); return { start: async () => { order.push("reach start"); }, status: () => ({ state: "relay" }), stop: () => {} }; }, deps: { ...f.deps, createPublicGate } }));
  await n.start();
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, ["gate starting"], "nothing is mapped while the gate is still getting its certificate");
  release();
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(order, ["gate starting", "gate up", 'reach [{"port":7443,"proto":"tcp"}]', "reach start"]);
  await n.stop();
});

test("reach (NW2-2): a public gate that failed to get its certificate maps nothing", async () => {
  const f = fakes(), p = fakePublic({ state: "failed" });
  let made = 0;
  const n = createNetd(base(f, { name: () => "alex", directory: dirStub, reach: () => { made++; return { start: async () => {}, status: () => ({ state: "relay" }), stop: () => {} }; }, deps: { ...f.deps, createPublicGate: p.createPublicGate } }));
  await n.start();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(made, 0);
  await n.stop();
});

test("findBinaries: under node --test nothing is found unless both programs are named", () => {
  assert.deepEqual(findBinaries({ NODE_TEST_CONTEXT: "child" }), { headscale: null, forwarder: null });
  assert.deepEqual(findBinaries({ VYRE_HEADSCALE_BIN: "/nope/hs", VYRE_WINK_FORWARDER_BIN: "/nope/f", NODE_TEST_CONTEXT: "child" }), { headscale: null, forwarder: null }, "a named path must exist and run");
  const t = home(), hs = path.join(t, "hs"), fw = path.join(t, "fw");
  fs.writeFileSync(hs, "#!/bin/sh\n", { mode: 0o755 }); fs.writeFileSync(fw, "#!/bin/sh\n", { mode: 0o755 });
  assert.deepEqual(findBinaries({ VYRE_HEADSCALE_BIN: hs, VYRE_WINK_FORWARDER_BIN: fw, NODE_TEST_CONTEXT: "child" }), { headscale: hs, forwarder: fw });
});

test("join policy: a node reaches the door only while its device row exists; a node bound to no row gets no rule and is deleted", async () => {
  const nodes = [{ id: 1, name: "home", ips: ["100.99.1.1"] }, { id: 2, name: "anything-it-chose", ips: ["100.99.1.2"], preAuthKeyId: 100 }, { id: 3, name: nodeNameFor("devB"), ips: ["100.99.1.3"], preAuthKeyId: 999 }];
  const f = fakes({ nodes });
  const n = createNetd(base(f));
  await n.start();
  assert.deepEqual(f.policies.at(-1).acls[0].src, ["n-d-2"], "only the node whose device has a row is a device");
  assert.ok(f.calls.includes("hs.delete 3"), "a node that took devB's name but joined with no key minted for devB is bound to nothing and removed, once no join key is outstanding");
  assert.ok(!f.calls.includes("hs.delete 2"));
});

test("join policy: removing the device row takes the rule away and deletes the node on the next sync", async () => {
  let live = ["devB"];
  const f = fakes();
  const n = createNetd(base(f, { devices: () => live }));
  await n.start();
  assert.deepEqual(f.policies.at(-1).acls[0].src, ["n-d-2"]);
  live = [];
  await n.deviceChanged();
  assert.ok(f.calls.includes("hs.delete 2"));
  assert.equal(f.policies.at(-1).acls.length, 0, "no device is left to reach the door");
});

test("join policy: a node that joined inside a key's window waits for its row, and gets no rule meanwhile", async () => {
  let live = /** @type {string[]} */ ([]);
  const nodes = [{ id: 1, name: "home", ips: ["100.99.1.1"] }];
  const f = fakes({ nodes });
  const n = createNetd(base(f, { devices: () => live, controlUrl: "https://hs.example.vyre.run" }));
  await n.start();
  const h = await n.handover({ device: "devB" });
  assert.equal(h.hostname, nodeNameFor("devB"));
  assert.equal(h.peerAddr, "100.99.1.1:8443", "a paired server is told where the home's door is");
  nodes.push({ id: 2, name: h.hostname, ips: ["100.99.1.2"], preAuthKeyId: f.keyIds.at(-1) });   // the device used its key
  await n.deviceChanged();
  assert.ok(!f.calls.includes("hs.delete 2"), "inside the window a node is not deleted");
  assert.equal(f.policies.at(-1).acls.length, 0, "no row yet, no rule");
  live = ["devB"];
  await n.deviceChanged();
  assert.deepEqual(f.policies.at(-1).acls[0].src, ["n-d-2"]);
  await n.stop();
});

/** A public gate stand-in that records how it was made and answers like the real one. */
function fakePublic(/** @type {{ published?: boolean, state?: string }} */ { published = false, state = "up" } = {}) {
  const made = /** @type {any[]} */ ([]);
  const createPublicGate = (/** @type {any} */ o) => {
    const g = { o, started: false, stopped: false,
      async start() { g.started = true; return g.status(); },
      status: () => ({ state: o.name() ? state : "no-name", why: o.name() ? null : "this box has no name yet", name: "alex.vyre.run", port: 7443, expires: 1, pin: "sha256/abc", published }),
      controlUrl: () => "https://alex.vyre.run:7443", ingressBase: () => (o.ingress && published && state === "up" ? "https://alex.vyre.run:7443" : null), pin: () => "sha256/abc", reachChanged: async () => {}, async stop() { g.stopped = true; } };
    made.push(g); return g;
  };
  return { made, createPublicGate };
}
const dirStub = { acme: async () => {}, acmeClear: async () => {}, publish: async () => {} };

test("public gate: a named box tells Headscale its public address and starts the TLS gate; the loopback gate stays for the home's own node", async () => {
  const f = fakes(), p = fakePublic();
  const n = createNetd(base(f, { name: () => "alex", directory: dirStub, deps: { ...f.deps, createPublicGate: p.createPublicGate } }));
  await n.start();
  assert.match(f.calls[0], /^hs\.start https:\/\/alex\.vyre\.run:7443$/);
  assert.match(f.calls[1], /^gate\.listen 127\.0\.0\.1/);
  assert.equal(p.made.length, 1);
  assert.equal(p.made[0].started, true);
  assert.equal(p.made[0].o.listen.port, 7443);
  assert.equal(p.made[0].o.dir.endsWith(path.join("wink-net", "certs")), true);
  const s = n.status();
  assert.equal(s.state, "up");
  assert.equal(s.controlUrl, "https://alex.vyre.run:7443");
  assert.equal(s.publicGate.state, "up");
  await n.stop();
  assert.equal(p.made[0].stopped, true);
});

test("public gate: a box with no name stays loopback-only and says so", async () => {
  const f = fakes(), p = fakePublic();
  const n = createNetd(base(f, { name: () => null, directory: dirStub, deps: { ...f.deps, createPublicGate: p.createPublicGate } }));
  await n.start();
  assert.match(f.calls[0], /^hs\.start http:\/\/127\.0\.0\.1:/);
  const s = n.status();
  assert.equal(s.publicGate.state, "no-name");
  assert.match(s.publicGate.why, /no name yet/);
  assert.equal(s.public, false);
  assert.equal(await n.handover({}), null, "nothing another machine could reach: the relay carries everything");
  await n.stop();
});

test("public gate: the hand-over carries the public address and the pin only once the name points here", async () => {
  const f = fakes();
  const unpublished = createNetd(base(f, { name: () => "alex", directory: dirStub, deps: { ...f.deps, createPublicGate: fakePublic({ published: false }).createPublicGate } }));
  await unpublished.start();
  assert.equal(await unpublished.handover({ device: "devB" }), null, "the name points nowhere reachable yet: no direct join is offered");
  await unpublished.stop();
  const f2 = fakes();
  const ok = createNetd(base(f2, { name: () => "alex", directory: dirStub, deps: { ...f2.deps, createPublicGate: fakePublic({ published: true }).createPublicGate } }));
  await ok.start();
  const h = await ok.handover({ device: "devB" });
  assert.equal(h.controlUrl, "https://alex.vyre.run:7443");
  assert.equal(h.pin, undefined, "no pin is sent: the forwarder cannot enforce one, the gate's certificate is checked against the public CAs");
  assert.equal(h.hostname, nodeNameFor("devB"));
  assert.equal(h.authKey, "hskey-fake0123456789");
  await ok.stop();
});

test("public gate: a configured control address wins and no second gate is made", async () => {
  const f = fakes(), p = fakePublic();
  const n = createNetd(base(f, { controlUrl: "https://hs.example.org", name: () => "alex", directory: dirStub, deps: { ...f.deps, createPublicGate: p.createPublicGate } }));
  await n.start();
  assert.match(f.calls[0], /^hs\.start https:\/\/hs\.example\.org$/);
  assert.equal(p.made.length, 0);
  await n.stop();
});

test("public gate: claiming a name restarts the network so the address follows it", async () => {
  const f = fakes(), p = fakePublic();
  let name = /** @type {string | null} */ (null);
  const n = createNetd(base(f, { name: () => name, directory: dirStub, deps: { ...f.deps, createPublicGate: p.createPublicGate } }));
  await n.start();
  assert.equal(n.status().controlUrl?.startsWith("http://127.0.0.1"), true);
  name = "alex";
  await n.nameChanged();
  assert.equal(n.status().controlUrl, "https://alex.vyre.run:7443");
  await n.stop();
});

test("public gate apps: netd hands the gate the apps question and passes an app being installed or removed on to it", async () => {
  const apps = async () => true;
  const f = fakes(), p = fakePublic();
  let changed = 0;
  const n = createNetd(base(f, { name: () => "alex", directory: dirStub, apps, deps: { ...f.deps, createPublicGate: (/** @type {any} */ o) => { const g = p.createPublicGate(o); g.appsChanged = async () => { changed++; }; return g; } } }));
  await n.start();
  assert.equal(p.made[0].o.apps, apps);
  await n.appsChanged();
  assert.equal(changed, 1);
  await n.stop();
  // without a public gate (or with a gate that predates apps) it is a no-op, never an error
  const f2 = fakes(), p2 = fakePublic();
  const n2 = createNetd(base(f2, { name: () => null, directory: dirStub, deps: { ...f2.deps, createPublicGate: p2.createPublicGate } }));
  await n2.start();
  await n2.appsChanged();
  await n2.stop();
});

test("public ingress: netd hands the gate the two loopback ports and reports the origin links use, in plain states", async () => {
  const ports = { hooks: () => 7310, share: () => 7311 };
  const told = /** @type {any[]} */ ([]);
  const f = fakes(), p = fakePublic({ published: false });
  const n = createNetd(base(f, { name: () => "alex", directory: dirStub, ingress: ports, onIngress: (/** @type {any} */ b) => told.push(b), deps: { ...f.deps, createPublicGate: p.createPublicGate } }));
  await n.start();
  assert.equal(p.made[0].o.ingress, ports);
  assert.equal(typeof p.made[0].o.onIngress, "function");
  p.made[0].o.onIngress("https://alex.vyre.run:7443");
  assert.deepEqual(told, ["https://alex.vyre.run:7443"]);
  const waiting = n.ingress();
  assert.equal(waiting.state, "waiting"); assert.equal(waiting.base, null); assert.match(String(waiting.why), /does not point at it yet/);
  await n.stop();
  const f2 = fakes(), p2 = fakePublic({ published: true });
  const up = createNetd(base(f2, { name: () => "alex", directory: dirStub, ingress: ports, deps: { ...f2.deps, createPublicGate: p2.createPublicGate } }));
  await up.start();
  assert.deepEqual(up.ingress(), { state: "up", base: "https://alex.vyre.run:7443" });
  await up.stop();
  const f3 = fakes();
  const none = createNetd(base(f3, { name: () => null, directory: dirStub, ingress: ports, deps: { ...f3.deps, createPublicGate: fakePublic().createPublicGate } }));
  await none.start();
  assert.equal(none.ingress().state, "no-name");
  await none.stop();
  const f4 = fakes();
  const unwired = createNetd(base(f4, { name: () => "alex", directory: dirStub, deps: { ...f4.deps, createPublicGate: fakePublic().createPublicGate } }));
  await unwired.start();
  assert.equal(unwired.ingress().state, "off");
  await unwired.stop();
});
