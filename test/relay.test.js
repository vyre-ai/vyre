// @ts-check
// The relay end to end (ADR 0026): a real vyred with the relay module, the Node relay from
// relay/node/, and alex's phone as a fake device that scans the QR code (parses the pairing URL),
// runs the Noise handshake and makes requests through the box's own router. Everything on
// 127.0.0.1; no Tailscale, no Cloudflare.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { keyPair } from "../core/relay/noise.js";
import { deviceSide } from "../core/relay/channel.js";
import { parsePairUrl } from "../core/relay/pairing.js";
import { useReleasesFile } from "../core/relay/releases.js";
import { signed } from "../core/presence/person.js";
import crypto from "node:crypto";
import { tempHome } from "./helpers.js";

/** Asks for a proof on every human-only tool and takes any proof: refusals below are about who is calling. */
const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: proof.method === "device" ? "device" : "passkey", keyId: proof.key || proof.cred || "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
  covered: () => false,
  coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]),
  enroll(k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const SPKI = () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
/** A presence proof, which the lenient presence above takes as given. */
const P = { "x-vyre-presence": "passkey id=abc" };
const PROOF = { proof: { method: "passkey", id: "x" } };

async function world(t, relayConfig = {}) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { name: "alex" }, relay: { enabled: false, url, ...relayConfig }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());
  return { d, relay, url, root };
}

/**
 * Alex's phone: scan, connect, handshake. Resolves with a request helper once the box answers. A
 * paired phone sends its presence key, and `signIn()` makes a person session with it (ADR 0032):
 * over the relay a device is a device, and a person's action needs that session.
 */
async function phone(scanned, { keys = keyPair(), pair = true, name = "alex's phone", hello = {}, presence = true } = {}) {
  const offer = /** @type {any} */ (parsePairUrl(scanned));
  assert.ok(offer, "the QR code parses");
  const ws = new WebSocket(`${offer.relay}/v1/device?route=${offer.route}`);
  ws.binaryType = "arraybuffer";
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const side = deviceSide({ send: b => ws.send(b), close: (c, r) => ws.close(c === 1000 || (c >= 3000 && c < 5000) ? c : 4000, r) },
    { s: keys, box: offer.box, route: offer.route, hello: { v: 1, name, ...(pair && presence ? { presenceKey: { public_key: SPKI(), alg: -7 } } : {}), ...hello, ...(pair ? { pair: offer.secret } : {}) } });
  let closed = null;
  ws.onmessage = e => { if (typeof e.data !== "string") side.receive(Buffer.from(e.data)); };
  ws.onclose = e => { closed = { code: e.code, reason: e.reason }; side.gone(e.reason || "closed"); };
  const { channel, reply } = await side.ready;
  /** @type {{ token: string, key: crypto.KeyObject } | null} */
  let session = null;
  /** The person session's headers for one request, signed over method, path, body, time and nonce. */
  const sign = (method, p, raw) => {
    if (!session) return {};
    const t = Date.now(), n = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(signed({ method, path: p, raw, t, n })), { key: session.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return { authorization: `Vyre ${session.token}`, "x-vyre-proof": `t=${t} n=${n} sig=${sig}` };
  };
  /** One request through the channel; resolves with status, headers and the parsed body. */
  const request = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const s = channel.open({ method, path: p, headers: { "content-type": "application/json", ...sign(method, p, raw), ...headers } });
    const parts = [];
    let head;
    s.onhead = h => { head = h; };
    s.ondata = c => parts.push(c);
    s.onend = () => { const raw = Buffer.concat(parts).toString(); resolve({ status: head.status, headers: head.headers, ...(raw ? JSON.parse(raw) : {}) }); };
    s.onreset = reject;
    if (raw) s.write(Buffer.from(raw));
    s.end();
  });
  const call = (tool, input = {}, headers) => request("POST", `/v1/tools/${tool}`, input, headers);
  /**
   * Sign in as the person with this device's own presence key (presence.person.start). The key id
   * is the one the relay enrolled at pairing, which the phone would have kept from the reply.
   * @param {any} d the running vyred
   */
  const signIn = async d => {
    const enrolled = (await d.registry.call("relay.device.presence", { id: reply.device }, "module:test")).data.key;
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const r = await call("presence.person.start", { key: publicKey.export({ format: "jwk" }) },
      { "x-vyre-presence": `device key=${enrolled} ts=${Date.now()} nonce=${crypto.randomBytes(8).toString("hex")} sig=x` });
    assert.equal(r.status, 200, `sign-in: ${JSON.stringify(r)}`);
    session = { token: r.data.token, key: privateKey };
    return r.data;
  };
  return { ws, channel, reply, request, call, keys, closed: () => closed, offer, signIn };
}

const firstPairing = async d => {
  const r = await d.registry.call("relay.pair.first", {}, "onboard", PROOF);
  assert.ok(r.data, JSON.stringify(r.error));
  return r.data.url;
};

test("relay: the first device pairs during onboarding and reaches the box's router as device:<id>", async t => {
  const { d } = await world(t);
  const url = await firstPairing(d);
  const p = await phone(url);
  assert.equal(p.reply.paired, true);
  assert.match(p.reply.device, /^[a-z2-7]{16}$/);
  assert.equal(p.reply.box.name, "alex");

  const health = await p.request("GET", "/v1/health");
  assert.equal(health.status, 200);

  const list = await p.call("relay.devices.list");
  assert.equal(list.status, 200, JSON.stringify(list));
  assert.deepEqual(list.data.devices.map(x => [x.id, x.name, x.online, x.path]), [[p.reply.device, "alex's phone", true, "relay"]]);

  const events = (await d.registry.call("relay.status", {}, "cli")).data;
  assert.equal(events.devices, 1);
  assert.equal(events.connected, true);
});

test("relay: a relayed device is a device; a person's action needs its person session, then presence", async t => {
  const { d } = await world(t);
  const p = await phone(await firstPairing(d));
  // ADR 0032: without a person session, even a presence proof is not enough.
  const device = await p.call("relay.pair.start", {}, P);
  assert.equal(device.status, 401, JSON.stringify(device));
  assert.equal(device.error.code, "person_session_required");
  assert.equal((await p.call("relay.devices.list")).status, 200, "reads stay the device's");
  // Signed in with its own presence key, the device is the person, and presence still decides.
  await p.signIn(d);
  const bare = await p.call("relay.pair.start");
  assert.equal(bare.status, 403);
  assert.equal(bare.error.code, "presence_required");
  const proved = await p.call("relay.pair.start", {}, P);
  assert.equal(proved.status, 200, JSON.stringify(proved));
  assert.ok(parsePairUrl(proved.data.url));
});

test("relay: the QR code works once; a stranger's key and a reused code are refused", async t => {
  const { d } = await world(t);
  const url = await firstPairing(d);
  const p = await phone(url);
  await assert.rejects(phone(url, { name: "someone else" }), /closed|expired|already/);
  await assert.rejects(phone(url, { pair: false }), /closed|not a paired/);
  // The paired phone comes back later with its own key and no code.
  const again = await phone(url, { keys: p.keys, pair: false });
  assert.equal(again.reply.device, p.reply.device);
  assert.equal(again.reply.paired, undefined);
});

test("relay: the first-device path closes once a person exists", async t => {
  const { d } = await world(t);
  await phone(await firstPairing(d));
  const r = await d.registry.call("relay.pair.first", {}, "onboard", PROOF);
  assert.equal(r.error?.code, "denied");
  // Only the onboarding page may ask for it at all.
  assert.equal((await d.registry.call("relay.pair.first", {}, "cli", PROOF)).error?.code, "denied");
});

test("relay: removing a device closes its connection at once and it cannot come back", async t => {
  const { d } = await world(t);
  const url = await firstPairing(d);
  const p = await phone(url);
  const r = await d.registry.call("relay.devices.remove", { id: p.reply.device }, "cli", PROOF);
  assert.ok(r.data, JSON.stringify(r.error));
  await new Promise(res => setTimeout(res, 50));
  assert.equal(p.channel.closed, true);
  await assert.rejects(phone(url, { keys: p.keys, pair: false }), /closed|not a paired/);
});

test("relay: a socket client cannot claim to be a device", async t => {
  const { d } = await world(t);
  await phone(await firstPairing(d));
  const { socketCaller } = await import("../core/daemon/index.js");
  assert.equal(socketCaller({ headers: { "x-vyre-caller": "device:abcdefghijklmnop" } }), "anonymous");
});

test("relay: an event stream stays open and delivers events through the channel", async t => {
  const { d } = await world(t);
  const p = await phone(await firstPairing(d));
  const s = p.channel.open({ method: "GET", path: "/v1/events/stream", headers: { accept: "text/event-stream" } });
  s.end();
  const head = await new Promise(res => { s.onhead = res; });
  assert.equal(head.status, 200);
  assert.match(String(head.headers["content-type"]), /text\/event-stream/);
  const chunk = new Promise(res => { s.ondata = c => { if (String(c).includes("device.paired")) res(String(c)); }; });
  // Pair another device from the box: its event reaches alex's phone live.
  const url = (await d.registry.call("relay.pair.start", {}, "cli", PROOF)).data.url;
  await phone(url, { name: "alex's laptop" });
  assert.match(await chunk, /device\.paired/);
  s.reset("done");
});

test("relay: a browser from the web app is a web device, limited until trusted from another device", async t => {
  const { d } = await world(t);
  const seen = [];
  d.events.on("device.paired", e => seen.push(e));
  const p = await phone(await firstPairing(d));
  await p.signIn(d);
  const url = (await p.call("relay.pair.start", {}, P)).data.url;
  const web = await phone(url, { name: "Harlow Legal laptop", hello: { kind: "web", release: "0.4.2", manifest: "a".repeat(64) } });

  const list = (await p.call("relay.devices.list")).data.devices;
  const w = list.find(x => x.id === web.reply.device);
  assert.equal(w.kind, "web");
  assert.equal(w.trusted, false);
  assert.equal(w.build, "unknown", "a release this box has never seen is flagged");
  assert.equal(list.find(x => x.id === p.reply.device).kind, "app");
  const notice = seen.map(e => e.payload || e.data || e).find(e => e.id === web.reply.device);
  assert.deepEqual([notice.kind, notice.release, notice.build], ["web", "0.4.2", "unknown"], "the pairing notice says what joined");

  // The web device reads freely but cannot mint devices or lift its own limits, even with presence.
  assert.equal((await web.call("relay.devices.list")).status, 200);
  const mint = await web.call("relay.pair.start", {}, P);
  assert.equal(mint.status, 404, JSON.stringify(mint));
  assert.equal((await web.call("relay.devices.trust", { id: web.reply.device, trusted: true }, P)).status, 404);
  assert.equal((await web.call("vault.reveal", { id: "x" }, P)).status, 404);

  // alex trusts it from the phone; the browser's channel closes and its next one has the tools
  // back. Being trusted lifts the relay's limits, not ADR 0032: it still signs in as the person.
  const trust = await p.call("relay.devices.trust", { id: web.reply.device, trusted: true }, P);
  assert.equal(trust.status, 200, JSON.stringify(trust));
  const again = await phone(url, { keys: web.keys, pair: false, hello: { kind: "web" } });
  const lifted = await again.call("relay.pair.start", {}, P);
  assert.equal(lifted.error && lifted.error.code, "person_session_required", JSON.stringify(lifted));
});

test("relay: a web device unused past relay.web_expiry_days is removed at its next knock", async t => {
  const { d } = await world(t, { web_expiry_days: 1e-8 });
  const p = await phone(await firstPairing(d));
  await p.signIn(d);
  const url = (await p.call("relay.pair.start", {}, P)).data.url;
  const web = await phone(url, { name: "kiosk", hello: { kind: "web" } });
  web.ws.close();
  await new Promise(r => setTimeout(r, 20));
  await assert.rejects(phone(url, { keys: web.keys, pair: false, hello: { kind: "web" } }), /unused too long|closed/);
  const ids = (await p.call("relay.devices.list")).data.devices.map(x => x.id);
  assert.deepEqual(ids, [p.reply.device], "the phone, an app device, never expires");
});

test("relay: the web app's loader asks the box which build to load, and the owner can pin one", async t => {
  const { d, root } = await world(t);
  const list = path.join(root, "releases.json");
  const rel = (release, c) => ({ release, sha: c.repeat(40), manifest: c.repeat(64) });
  fs.writeFileSync(list, JSON.stringify({ releases: [rel("0.4.2", "a"), rel("0.10.0", "b"), rel("0.9.9", "c")] }));
  useReleasesFile(list);
  t.after(() => useReleasesFile());
  const p = await phone(await firstPairing(d));
  await p.signIn(d);
  const url = (await p.call("relay.pair.start", {}, P)).data.url;
  const web = await phone(url, { name: "Northwind Bakery laptop", hello: { kind: "web", release: "0.4.2", manifest: "a".repeat(64) } });

  const newest = await web.call("relay.web.release");
  assert.equal(newest.status, 200, JSON.stringify(newest));
  assert.deepEqual([newest.data.release, newest.data.path, newest.data.pinned], ["0.10.0", `/v/${"b".repeat(40)}/`, false], "semver order, not string order");
  assert.equal((await p.call("relay.devices.list")).data.devices.find(x => x.id === web.reply.device).build, "known");

  assert.equal((await web.call("relay.web.pin", { release: "0.4.2" }, P)).status, 404, "an untrusted browser cannot pick its own code");
  assert.equal((await p.call("relay.web.pin", { release: "1.0.0" }, P)).status, 400);
  assert.equal((await p.call("relay.web.pin", { release: "0.4.2" }, P)).status, 200);
  const pinned = (await web.call("relay.web.release")).data;
  assert.deepEqual([pinned.release, pinned.pinned], ["0.4.2", true]);
});

test("relay: a device reports its path; the box measures the relay round trip and learns its tailnet node", async t => {
  const { d } = await world(t);
  const moves = [];
  d.events.on("device.moved", e => moves.push(e.payload));
  const p = await phone(await firstPairing(d));
  const id = p.reply.device;

  const r = await p.call("relay.devices.path", { path: "relay", rtt: 42 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.match(r.data.link, /^[A-Za-z0-9_-]{22}$/);
  let me = (await p.call("relay.devices.list")).data.devices[0];
  assert.equal(me.path, "relay");
  assert.equal(typeof me.rtt, "number", "the box pinged the device over the channel");

  // The same phone over the tailnet: its node, from whois, is linked by the code, once.
  const node = { stableId: "nABC123", node: "alex-iphone", login: "alex@example.com", tags: [], caps: {} };
  assert.equal((await d.registry.call("relay.devices.path", { path: "direct", rtt: 18 }, "tailnet:alex@example.com", { peer: node })).error.code, "bad_input", "an unlinked node is nobody");
  assert.equal((await d.registry.call("relay.devices.path", { path: "direct", id, code: "wrong" }, "tailnet:alex@example.com", { peer: node })).error.code, "denied");
  const linked = await d.registry.call("relay.devices.path", { path: "direct", rtt: 18, id, code: r.data.link }, "tailnet:alex@example.com", { peer: node });
  assert.deepEqual(linked.data, { path: "direct", device: id });
  assert.equal((await d.registry.call("relay.devices.path", { path: "direct", id, code: r.data.link }, "tailnet:alex@example.com", { peer: node })).error.code, "denied", "the code works once");

  p.ws.close();
  await new Promise(res => setTimeout(res, 50));
  me = (await d.registry.call("relay.devices.list", {}, "cli")).data.devices[0];
  assert.deepEqual([me.path, me.rtt, me.node, me.online], ["direct", 18, "alex-iphone", true]);
  assert.deepEqual(moves.map(m => m.path), ["relay", "direct"]);
  assert.equal((await d.registry.call("relay.devices.path", { path: "direct" }, "tailnet:alex@example.com", { peer: { ...node, stableId: "nOTHER" } })).error.code, "bad_input", "another node is not this device");
});

test("relay: relay.device.presence names the key a device enrolled, for modules only", async t => {
  const { d } = await world(t);
  const p = await phone(await firstPairing(d));
  const id = p.reply.device;
  assert.equal((await d.registry.call("relay.device.presence", { id }, "cli")).error.code, "no_such_tool", "not a surface's tool");
  assert.match((await d.registry.call("relay.device.presence", { id }, "module:presence")).data.key, /\S/, "the key enrolled at pairing");
  const url = await (async () => { await p.signIn(d); return (await p.call("relay.pair.start", {}, P)).data.url; })();
  const bare = await phone(url, { name: "kit's tablet", presence: false });
  assert.deepEqual((await d.registry.call("relay.device.presence", { id: bare.reply.device }, "module:presence")).data, { key: null }, "paired without a presence key");
  assert.deepEqual((await d.registry.call("relay.device.presence", { id: "nobody" }, "module:presence")).data, { key: null });
});

test("relay: the pairing offer names the box as configured, never the machine's hostname", async t => {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  for (const [cfg, want] of [[{ name: "Northwind Bakery" }, "Northwind Bakery"], [{}, "Vyre box"]]) {
    const root = tempHome(t);
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], ...cfg, relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
    const d = await start({ presence: lenient, root, log: () => {} });
    t.after(() => d.stop());
    const offer = /** @type {any} */ (parsePairUrl((await firstPairing(d))));
    assert.equal(offer.name, want);
    assert.notEqual(offer.name, (await import("node:os")).hostname().split(".")[0]);
  }
});

test("relay: loads on a Solo Mac (role local) but opens no connection until the person enables it", async t => {
  // Widened to roles ["box", "local"] for a phone joining a Solo Mac (28 Sep 2026). The module
  // must not go near the network just from loading: settings().enabled defaults to false, and
  // start() only calls startLink() when it is already true. No injected WebSocket seam here on
  // purpose — this proves the real `globalThis.WebSocket` (which would reach the real relay,
  // never allowed in a test) is never touched, not just a fake one.
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [],
    modules: { disable: ["names", "onboard"] } }));
  const events = [];
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());
  const off = d.events.on("relay.connected", () => events.push("connected"));
  const off2 = d.events.on("relay.disconnected", () => events.push("disconnected"));
  t.after(() => { off(); off2(); });
  assert.equal(d.registry.modules.get("relay").state, "running", "the module loads under local");
  const s = await d.registry.call("relay.status", {}, "cli");
  assert.deepEqual({ enabled: s.data.enabled, connected: s.data.connected }, { enabled: false, connected: false });
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(events, [], "no connection attempt just from loading, disabled by default");
});
