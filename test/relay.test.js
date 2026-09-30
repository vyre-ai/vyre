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
import { parsePairUrl, pairUrl } from "../core/relay/pairing.js";
import { macCoreRefusal } from "../core/relay/index.js";
import { useReleasesFile } from "../core/relay/releases.js";
import { signed } from "../core/presence/person.js";
import { pairTicket, resolveTicket, pairOffer } from "../relay/client/client.js";
import { shellDeviceKey } from "../relay/client/shellkey.js";
import { nodeCrypto, fileKeyStore } from "../relay/client/nodecrypto.js";
import { fromBase64url } from "../relay/client/bytes.js";
import crypto from "node:crypto";
import { tempHome } from "./helpers.js";
import { fakeCoreKeys, macCore } from "./fake-core-keys.js";

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

async function world(t, relayConfig = {}, startOpts = {}) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { name: "alex" }, relay: { enabled: false, url, ...relayConfig }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore(), ...startOpts });
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

test("relay: a pairing that asks for it is handed the one-time enrolment grant for the box's address, the same {grant, expires, rpId} as the setup claim", async t => {
  const { d } = await world(t);
  // No address yet: nothing to enroll at, so no grant, whatever the hello says.
  const bare = await phone(await firstPairing(d), { hello: { enroll: true } });
  assert.equal(bare.reply.enroll, undefined);
  bare.ws.close();
  d.registry.deps.config.network = { ...(d.registry.deps.config.network || {}), address: "https://alex.vyre.run:8443" };
  const minted = await d.registry.call("relay.pair.start", {}, "cli", PROOF);
  const asked = await phone(minted.data.url, { hello: { enroll: true }, presence: false });
  const e = asked.reply.enroll;
  assert.equal(e.rpId, "alex.vyre.run", "the host of the address, no port");
  assert.match(e.grant, /^[A-Za-z0-9_-]{40,}$/);
  assert.ok(e.expires > Date.now() && e.expires <= Date.now() + 5 * 60_000 + 1000);
  const plain = await phone((await d.registry.call("relay.pair.start", {}, "cli", PROOF)).data.url, { presence: false });
  assert.equal(plain.reply.enroll, undefined, "a pairing that did not ask gets none");
  asked.ws.close(); plain.ws.close();
  // The shared client library asks and validates the same way.
  const viaClient = await pairOffer(/** @type {any} */ (parsePairUrl((await d.registry.call("relay.pair.start", {}, "cli", PROOF)).data.url)), { enroll: true, crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(tempHome(t), "k.json")) });
  assert.equal(viaClient.enroll?.rpId, "alex.vyre.run");
  assert.match(String(viaClient.enroll?.grant), /^[A-Za-z0-9_-]{40,}$/);
  const noAsk = await pairOffer(/** @type {any} */ (parsePairUrl((await d.registry.call("relay.pair.start", {}, "cli", PROOF)).data.url)), { crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(tempHome(t), "k2.json")) });
  assert.equal(noAsk.enroll, null);
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

test("relay: relay.devices.node answers a paired device's own Noise identity, for modules only, and its tailnet node once it has reported one", async t => {
  const { d } = await world(t);
  const p = await phone(await firstPairing(d));
  const id = p.reply.device;
  assert.equal((await d.registry.call("relay.devices.node", { id }, "cli")).error.code, "no_such_tool", "not a surface's tool");
  const before = await d.registry.call("relay.devices.node", { id }, "module:link");
  assert.equal(before.data.stableId, id);
  assert.match(before.data.staticKey, /\S/);
  assert.equal(before.data.name, "alex's phone", "the device's own paired name, for a move's \"receive from <name>\" line");
  assert.equal(before.data.node, null, "no tailnet node reported yet");
  assert.deepEqual((await d.registry.call("relay.devices.node", { id: "nobody" }, "module:link")).data, { stableId: null, staticKey: null, name: null, node: null });
});

test("relay: the pairing offer names the box as configured, never the machine's hostname", async t => {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  for (const [cfg, want] of [[{ name: "Northwind Bakery" }, "Northwind Bakery"], [{}, "Vyre box"]]) {
    const root = tempHome(t);
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], ...cfg, relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
    const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore() });
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
  // purpose, this proves the real `globalThis.WebSocket` (which would reach the real relay,
  // never allowed in a test) is never touched, not just a fake one.
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [],
    modules: { disable: ["names", "onboard"] } }));
  const events = [];
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore() });
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

test("relay: relay.join redeems a code minted on another box, and this device shows up there", async t => {
  // Two real vyred instances, one real local relay/node/server between them (the same fixture
  // relay every other test in this file uses) -- the box mints a code (relay.pair.first, as
  // onboarding does for the very first device), the device (role local, relay's own module
  // widened there) redeems it with relay.join. No phone, no Expo app: this is the CLI/Node path,
  // Node's own crypto provider (relay/client/nodecrypto.js), a real Noise handshake over a real
  // WebSocket, same protocol a phone would run.
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const boxRoot = tempHome(t);
  fs.writeFileSync(path.join(boxRoot, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { name: "alex" }, relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
  const box = await start({ presence: lenient, root: boxRoot, log: () => {}, coreKeys: macCore() });
  t.after(() => box.stop());
  const pairUrl = (await box.registry.call("relay.pair.first", {}, "onboard", PROOF)).data.url;

  const deviceRoot = tempHome(t);
  fs.writeFileSync(path.join(deviceRoot, "config.json"), JSON.stringify({ role: "local", transcripts: [],
    modules: { disable: ["names", "onboard"] } }));
  const device = await start({ presence: lenient, root: deviceRoot, log: () => {}, coreKeys: macCore() });
  t.after(() => device.stop());
  const r = await device.registry.call("relay.join", { url: pairUrl, name: "kit's laptop" }, "cli", PROOF);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.data.name, "alex", "the box's own name, as configured");
  assert.match(r.data.device, /^[a-z2-7]{16}$/);

  const devices = (await box.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices;
  assert.deepEqual(devices.map(x => x.name), ["kit's laptop"]);
  assert.equal(devices[0].id, r.data.device);

  // Redeeming a second code from the same device root reuses the same persisted key, so the box
  // sees the same device id again rather than minting a fresh identity every time.
  const secondUrl = (await box.registry.call("relay.pair.start", {}, "cli", PROOF)).data.url;
  const again = await device.registry.call("relay.join", { url: secondUrl, name: "kit's laptop" }, "cli", PROOF);
  assert.equal(again.data.device, r.data.device, "the same file-backed key, the same device id");

  // becomeDevice degrades cleanly when onboard.machine is not even running (not merged to this
  // branch yet) -- it must still return the pairing result, not throw.
  const thirdUrl = (await box.registry.call("relay.pair.start", {}, "cli", PROOF)).data.url;
  const flip = await device.registry.call("relay.join", { url: thirdUrl, becomeDevice: true }, "cli", PROOF);
  assert.equal(flip.error, undefined, JSON.stringify(flip.error));
  assert.equal(flip.data.device, r.data.device);
});

test("relay: relay.join refuses a guest, an agent's own claim, and a bad code, before any handshake", async t => {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [], modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore() });
  t.after(() => d.stop());
  const bogus = `https://vyre.run/pair#${Buffer.from(JSON.stringify({ v: 1, r: url, i: "a".repeat(26), k: Buffer.alloc(32).toString("base64url"), s: "x", n: "test" })).toString("base64url")}`;
  const bad = await d.registry.call("relay.join", { url: bogus }, "cli", PROOF);
  assert.equal(bad.error.code, "bad_input");
  for (const caller of ["tailnet-guest:sam@example.com", "mcp:agent:kit", "anonymous"]) {
    const r = await d.registry.call("relay.join", { url: bogus }, caller, PROOF);
    assert.equal(r.error.code, "denied", caller);
  }
  // "hook" is refused even earlier, before caller-kind matching reaches relay.join at all: hooks
  // reach only tools declared hook: true, and relay.join is not one.
  assert.equal((await d.registry.call("relay.join", { url: bogus }, "hook", PROOF)).error.code, "no_such_tool");
});

test("relay: relay.join's presence prompt names the box, its relay host and a key fingerprint; a garbage url refuses before any prompt at all", async t => {
  const { d } = await world(t);
  const def = d.registry.tools.get("relay.join");
  const goodUrl = pairUrl({ relay: "wss://relay.example.com", route: "a".repeat(26), box: Buffer.alloc(32, 7), secret: "s", name: "Northwind Bakery" });
  const summary = await def.presence.summary({ url: goodUrl });
  assert.match(summary, /^Pair this device with "Northwind Bakery" on relay\.example\.com \(key [a-z2-7]{4} [a-z2-7]{4}\)$/);

  // A well-formed vyre.run/pair# link whose fragment does not decode to a real offer: the prompt
  // says so plainly rather than falling back to a generic "relay.join {...}" line.
  const nonsense = "https://vyre.run/pair#bm90LWEtcmVhbC1vZmZlcg";
  assert.match(await def.presence.summary({ url: nonsense }), /does not look like a real Vyre pairing code/);

  // A url that is not even shaped like a pairing link: the schema refuses it before presence or
  // run() ever see it, so no prompt of any kind is possible.
  const r = await d.registry.call("relay.join", { url: "https://evil.example/steal-me" }, "cli", PROOF);
  assert.equal(r.error.code, "bad_input");
  const r2 = await d.registry.call("relay.join", { url: nonsense }, "cli", PROOF);
  assert.equal(r2.error.code, "bad_input", "passes the schema pattern but fails parsePairUrl, still refused in run()");

  // The box's own name is text IT chose, landing straight in a Touch ID prompt: a hostile box
  // could try to write its own fake "(key ...)" text after its name, or a long run of junk, to
  // confuse the reader (reviewer, 28 Sep). Stripped, capped at 40, and always followed by this
  // tool's own computed fingerprint, never anything from the name itself.
  const box9 = Buffer.alloc(32, 9);
  const hostileUrl = pairUrl({ relay: "wss://relay.example.com", route: "b".repeat(26), box: box9, secret: "s",
    name: `Real Bakery\u0007 fake trailer: ${"x".repeat(80)}` });
  const hostile = await def.presence.summary({ url: hostileUrl });
  assert.ok(hostile.length < 140, hostile);
  assert.doesNotMatch(hostile, /\u0007/, "the control character is gone");
  const trueFingerprint = (await def.presence.summary({ url: pairUrl({ relay: "wss://relay.example.com", route: "c".repeat(26), box: box9, secret: "s", name: "x" }) }))
    .match(/\(key .+\)$/)[0];
  assert.ok(hostile.endsWith(trueFingerprint), "the trailing fingerprint is always this box's real one, computed here, not anything from the name");
  // The name itself, quoted, is capped well short of the 80-character junk run.
  const quoted = hostile.match(/"([^"]*)"/)[1];
  assert.ok(quoted.length <= 40, quoted);

  // The relay host is the OTHER box's own text too (parsePairUrl only bars whitespace and a
  // slash, so control characters, a right-to-left override and a long junk run all pass its own
  // check): the prompt must strip and cap it exactly like the name.
  const hostileHost = `wss://relay.example.com\u0007\u061c\u180e\u202e${"y".repeat(120)}`;
  const hostileHostUrl = pairUrl({ relay: hostileHost, route: "d".repeat(26), box: box9, secret: "s", name: "Real Bakery" });
  const hostileHostPrompt = await def.presence.summary({ url: hostileHostUrl });
  assert.ok(hostileHostPrompt.length < 200, hostileHostPrompt);
  assert.doesNotMatch(hostileHostPrompt, /[\u0007\u061c\u180e\u202e]/, "the control character, the Arabic letter mark, the Mongolian vowel separator and the RTL override are gone from the host too");
  assert.ok(hostileHostPrompt.endsWith(trueFingerprint), "the fingerprint is still this box's own, unaffected by the host");
  const hostPart = hostileHostPrompt.match(/ on (.+) \(key /)[1];
  assert.ok(hostPart.length <= 64, hostPart);
});

test("relay: relay.join is not available on a Mac without vyre-core to hold its device key", async t => {
  // A pure function of an explicit platform (like installCommand/operator elsewhere), so this
  // does not depend on the OS running the suite: darwin always refuses, every other platform
  // (this test box's own linux included) never does.
  const refusal = macCoreRefusal("darwin");
  assert.equal(refusal.code, "not_available_here");
  assert.match(refusal.message, /vyre-core/);
  assert.equal(macCoreRefusal("linux"), null);
  assert.equal(macCoreRefusal("win32"), null);

  // End to end, as if this box were a Mac: relay/index.js resolves platform once when its
  // start() runs (seam.platform || process.platform), so flip process.platform before starting
  // a fresh daemon, not after. Refused in run(), and before that: no Touch ID prompt at all
  // (presence.when turns off), a caller the lenient test harness would otherwise pass straight
  // through to run().
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", real));
  const { d } = await world(t, {}, { coreKeys: null });
  const def = d.registry.tools.get("relay.join");
  assert.equal(await def.presence.when({ url: "https://vyre.run/pair#anything" }), false, "no prompt on darwin: the call can only refuse");
  const bogus = `https://vyre.run/pair#${Buffer.from(JSON.stringify({ v: 1, r: "wss://relay.example.com", i: "a".repeat(26), k: Buffer.alloc(32).toString("base64url"), s: "x", n: "test" })).toString("base64url")}`;
  const r = await d.registry.call("relay.join", { url: bogus }, "cli", PROOF);
  assert.equal(r.error.code, "not_available_here");
});

test("relay: relay.pair.ticket mints a Vyre-code ticket, a phone resolves and redeems it, and only device.paired + relay.paired fire", async t => {
  const { d } = await world(t);
  const seen = [];
  d.events.on("device.paired", e => seen.push(["device.paired", e.payload || e]));
  d.events.on("relay.paired", e => seen.push(["relay.paired", e.payload || e]));

  const minted = await d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  assert.ok(minted.data, JSON.stringify(minted.error));
  const { ticket, expiresAt } = minted.data;
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 5 * 60_000 + 1000, "5-minute TTL");

  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  const paired = await pairTicket(fromBase64url(ticket), {
    relay: status.url, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(tempHome(t), "phone-key.json")),
  });
  assert.ok(paired.device, "the phone is paired");
  assert.equal(paired.name, "alex", "the box's own configured name round-tripped through the relay's record");
  const devices = (await d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices;
  const row = devices.find(x => x.id === paired.device);
  assert.ok(row, "the device shows up in relay.devices.list");
  assert.equal(row.name, "Alex's iPhone");

  assert.equal(seen.filter(([n]) => n === "device.paired").length, 1);
  const dp = seen.find(([n]) => n === "device.paired");
  assert.match(dp[1].fingerprint, /^[a-z2-7]{4} [a-z2-7]{4}$/, "device.paired carries the new device's own key fingerprint");
  const rp = seen.find(([n]) => n === "relay.paired");
  assert.ok(rp, "relay.paired fires for a ticket pairing");
  assert.deepEqual(rp[1], { device: paired.device, name: "Alex's iPhone", fingerprint: dp[1].fingerprint });

  // Single-use: resolving (and so redeeming) the same ticket again is refused outright.
  await assert.rejects(() => pairTicket(fromBase64url(ticket), { relay: status.url, crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(tempHome(t), "phone-key-2.json")) }),
    /expired or was already used/);
});

test("relay: a computer that chose its own ticket has the box register it; the record carries the box's own origin, own domain included, and no origin when there is none", async t => {
  const { d } = await world(t);
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  const seed = crypto.randomBytes(16);
  // No address yet: no origin in the record.
  let minted = (await d.registry.call("relay.pair.ticket", { seed: seed.toString("base64url") }, "cli", PROOF)).data;
  assert.equal(minted.ticket, undefined, "the app's own ticket is not echoed back");
  assert.ok(minted.expiresAt > Date.now());
  let resolved = await resolveTicket(new Uint8Array(seed), { relay: status.url, crypto: nodeCrypto() });
  assert.equal(resolved.address, null);
  // With an address, the origin (port kept, path dropped) rides in the MAC-covered record.
  d.registry.deps.config.network = { ...(d.registry.deps.config.network || {}), address: "https://harlow.example.com:8443/deck" };
  const seed2 = crypto.randomBytes(16);
  await d.registry.call("relay.pair.ticket", { seed: seed2.toString("base64url") }, "cli", PROOF);
  resolved = await resolveTicket(new Uint8Array(seed2), { relay: status.url, crypto: nodeCrypto() });
  assert.equal(resolved.address, "https://harlow.example.com:8443");
  // A seed is 8 to 32 bytes of base64url; anything else is refused before a ticket exists.
  for (const bad of [crypto.randomBytes(4).toString("base64url"), crypto.randomBytes(33).toString("base64url"), "not base64url!", 5]) {
    const r = await d.registry.call("relay.pair.ticket", { seed: bad }, "cli", PROOF);
    assert.equal(r.error?.code, "bad_input", String(bad));
  }
  // A second box (or a second ask) registering a seed the relay still holds is a failure, not a ticket that quietly does not resolve.
  const held = crypto.randomBytes(16).toString("base64url");
  assert.ok((await d.registry.call("relay.pair.ticket", { seed: held }, "cli", PROOF)).data);
  const twin = await d.registry.call("relay.pair.ticket", { seed: held }, "cli", PROOF);
  assert.equal(twin.error?.code, "conflict", JSON.stringify(twin));
  // The app's own ticket pairs like any other.
  const seed3 = crypto.randomBytes(16);
  await d.registry.call("relay.pair.ticket", { seed: seed3.toString("base64url") }, "cli", PROOF);
  // ...including when the device's private key never leaves its shell: the Noise handshake runs with the shell's own DH.
  const shellPair = crypto.generateKeyPairSync("x25519");
  const shellPub = new Uint8Array(shellPair.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const shell = shellDeviceKey(async (cmd, args) => {
    if (cmd === "device_key_pub") return Buffer.from(shellPub).toString("base64url");
    const remote = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(args.remote, "base64url")]), format: "der", type: "spki" });
    return crypto.diffieHellman({ privateKey: shellPair.privateKey, publicKey: remote }).toString("base64url");
  }, { crypto: nodeCrypto() });
  const paired = await pairTicket(new Uint8Array(seed3), { relay: status.url, ...shell, name: "kit's PC" });
  assert.ok(paired.device);
  void minted;
});

test("relay: resolveTicket confirms who a ticket pairs with, before pairing, so a phone can show and pairOffer separately", async t => {
  const { d } = await world(t);
  const minted = (await d.registry.call("relay.pair.ticket", {}, "cli", PROOF)).data;
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  const resolved = await resolveTicket(fromBase64url(minted.ticket), { relay: status.url, crypto: nodeCrypto() });
  assert.equal(resolved.name, "alex");
  assert.match(resolved.fingerprint, /^[a-z2-7]{4} [a-z2-7]{4}$/);
  assert.equal(resolved.offer.route, status.route);
  assert.equal(resolved.handle, "alex", "the claimed vyre.run handle, covered by the same MAC as everything else");
  // Confirmed by a person reading exactly that name and fingerprint (not built here, the whole
  // point): only now does the handshake run, as its own separate step.
  const paired = await pairOffer(resolved.offer, { name: "alex's phone", crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(tempHome(t), "phone-key.json")) });
  assert.ok(paired.device);
  const row = (await d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.find(x => x.id === paired.device);
  assert.equal(row.name, "alex's phone");

  // Resolving again (the ticket is single-use) refuses before any pairing attempt at all.
  await assert.rejects(() => resolveTicket(fromBase64url(minted.ticket), { relay: status.url, crypto: nodeCrypto() }), /expired or was already used/);
});

test("relay: resolveTicket refuses a record whose own expiry has passed, even with a valid MAC", async t => {
  const { d } = await world(t);
  const minted = (await d.registry.call("relay.pair.ticket", {}, "cli", PROOF)).data;
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  const raw = fromBase64url(minted.ticket);
  const { ticketDerive, ticketMac, ticketSeal, ticketOpen } = await import("../core/relay/wire.js");
  const loc = ticketDerive("loc", Buffer.from(raw)).toString("base64url");
  const res = await fetch(`${status.url.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) });
  const body = await res.json();
  const record = JSON.parse(ticketOpen(Buffer.from(raw), body.record));
  const expired = ticketSeal(Buffer.from(raw), JSON.stringify({ ...record, exp: Date.now() - 1000 }));
  const mac = ticketMac(Buffer.from(raw), expired).toString("base64url");
  const badFetch = async () => ({ ok: true, status: 200, json: async () => ({ record: expired, mac }) });
  await assert.rejects(() => resolveTicket(raw, { relay: status.url, fetch: badFetch, crypto: nodeCrypto() }), /expired or was already used/);
  assert.equal(record.handle, "alex", "the claimed handle travels in the record, covered by the same MAC");
});

test("relay: resolveTicket/pairOffer throw stable .code values, not just messages", async t => {
  const { d } = await world(t);
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  const gone = await resolveTicket(Buffer.alloc(8, 1), { relay: status.url, crypto: nodeCrypto() }).catch(e => e);
  assert.equal(gone.code, "ticket_gone");

  const minted = (await d.registry.call("relay.pair.ticket", {}, "cli", PROOF)).data;
  const raw = fromBase64url(minted.ticket);
  const { ticketDerive, ticketMac, ticketSeal, ticketOpen } = await import("../core/relay/wire.js");
  const loc = ticketDerive("loc", Buffer.from(raw)).toString("base64url");
  const res = await fetch(`${status.url.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) });
  const body = await res.json();
  const tampered = ticketSeal(Buffer.from(raw), JSON.stringify({ ...JSON.parse(ticketOpen(Buffer.from(raw), body.record)), box: Buffer.alloc(32, 9).toString("base64url") }));
  const badFetch = async () => ({ ok: true, status: 200, json: async () => ({ record: tampered, mac: body.mac }) });
  const bad = await resolveTicket(raw, { relay: status.url, fetch: badFetch, crypto: nodeCrypto() }).catch(e => e);
  assert.equal(bad.code, "bad_record");

  // A record with a valid MAC that the ticket's "enc" key doesn't open (sealed under the MAC key
  // instead, say): still bad_record, never a parse of whatever bytes came back.
  const wrongKey = (() => {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", ticketDerive("mac", Buffer.from(raw)), nonce);
    c.setAAD(Buffer.from("vyre-pair-record\n1"));
    return Buffer.concat([nonce, c.update(ticketOpen(Buffer.from(raw), body.record)), c.final(), c.getAuthTag()]).toString("base64url");
  })();
  const wrongFetch = async () => ({ ok: true, status: 200, json: async () => ({ record: wrongKey, mac: ticketMac(Buffer.from(raw), wrongKey).toString("base64url") }) });
  assert.equal((await resolveTicket(raw, { relay: status.url, fetch: wrongFetch, crypto: nodeCrypto() }).catch(e => e)).code, "bad_record");

  const limited = await resolveTicket(Buffer.alloc(8, 2), { relay: status.url, fetch: async () => ({ ok: false, status: 429 }), crypto: nodeCrypto() }).catch(e => e);
  assert.equal(limited.code, "rate_limited");
});

test("relay: resolveTicket's handle is null when no vyre.run name is claimed, not a guess", async t => {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore() });
  t.after(() => d.stop());
  const minted = (await d.registry.call("relay.pair.ticket", {}, "cli", PROOF)).data;
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  const resolved = await resolveTicket(fromBase64url(minted.ticket), { relay: status.url, crypto: nodeCrypto() });
  assert.equal(resolved.handle, null);
  assert.equal(resolved.identity, null, "no owner.id yet (anywhere's core/onboard), stubbed as null, never guessed");
  assert.equal(resolved.name, "Vyre box", "boxName()'s own fallback, unaffected by the missing handle");
});

test("relay: resolveTicket's identity fingerprint is sha256(\"vyre:person:v1:\" + owner.id).slice(0,8), covered by the MAC", async t => {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  const ownerId = "0123456789abcdef0123456789abcdef";
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, owner: { id: ownerId }, relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore() });
  t.after(() => d.stop());
  const minted = (await d.registry.call("relay.pair.ticket", {}, "cli", PROOF)).data;
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  const resolved = await resolveTicket(fromBase64url(minted.ticket), { relay: status.url, crypto: nodeCrypto() });
  const want = crypto.createHash("sha256").update(`vyre:person:v1:${ownerId}`).digest().subarray(0, 8).toString("base64url");
  assert.equal(resolved.identity, want);
  assert.equal(resolved.identity, "WrNLxox2PS8", "lib/identity.js's own worked vector for this id");
});

test("relay: a device's own name at ticket pairing is sanitised and capped like the box's own name", async t => {
  const { d } = await world(t);
  const minted = (await d.registry.call("relay.pair.ticket", {}, "cli", PROOF)).data;
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  const hostileName = `Alex\u0007's phone‮${"z".repeat(120)}`;
  const paired = await pairTicket(fromBase64url(minted.ticket), {
    relay: status.url, name: hostileName, crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(tempHome(t), "phone-key.json")),
  });
  const row = (await d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.find(x => x.id === paired.device);
  assert.ok(row.name.length <= 64, row.name);
  assert.doesNotMatch(row.name, /[\u0007‮]/);
});

test("relay: the relay never learns the pairing secret or reads the record, and a tampered record fails the phone's MAC check", async t => {
  const { ticketDerive, ticketSeal, ticketOpen } = await import("../core/relay/wire.js");
  const { d } = await world(t);
  const minted = (await d.registry.call("relay.pair.ticket", {}, "cli", PROOF)).data;
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  const raw = fromBase64url(minted.ticket);
  // The same locator a phone would derive from the ticket (this is what proves the derivation
  // matches byte for byte between core/relay/wire.js and relay/client/client.js: a phone that
  // derived it differently would never find the record at all).
  const loc = ticketDerive("loc", Buffer.from(raw)).toString("base64url");
  const res = await fetch(`${status.url.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(Object.keys(body).sort().join(","), "mac,record", "nothing else, and certainly no secret, ever leaves the relay");
  assert.doesNotMatch(body.record, /vyre-pair-sec/);
  // The record is ciphertext to the relay (the lead's ruling, 28 Sep): no name, handle, route or
  // box key in what it stores, and only the ticket's own "enc" key opens it.
  assert.match(body.record, /^[A-Za-z0-9_-]+$/);
  assert.throws(() => JSON.parse(Buffer.from(body.record, "base64url").toString("utf8")));
  const opened = JSON.parse(ticketOpen(Buffer.from(raw), body.record));
  for (const clear of [opened.name, opened.route, opened.box]) assert.ok(!body.record.includes(clear) && !Buffer.from(body.record, "base64url").toString("latin1").includes(clear), clear);
  const keys = ["loc", "sec", "mac", "enc"].map(w => ticketDerive(/** @type {any} */ (w), Buffer.from(raw)).toString("hex"));
  assert.equal(new Set(keys).size, 4, "the enc key is domain-separated from the locator, secret and MAC key");

  // A tampered record (a dishonest relay operator substituting their own box) fails the MAC a
  // phone checks locally, before it ever tries to pair with what the record names.
  const tampered = ticketSeal(Buffer.from(raw), JSON.stringify({ ...opened, box: Buffer.alloc(32, 9).toString("base64url") }));
  const badFetch = async () => ({ ok: true, status: 200, json: async () => ({ record: tampered, mac: body.mac }) });
  await assert.rejects(() => pairTicket(raw, { relay: status.url, fetch: badFetch, crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(tempHome(t), "phone-key.json")) }),
    /does not check out/);
});

test("relay: relay.pair.ticket refuses on darwin, before any Touch ID prompt, the same as relay.join", async t => {
  const refusal = macCoreRefusal("darwin");
  assert.equal(refusal.code, "not_available_here");
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", real));
  const { d } = await world(t, {}, { coreKeys: null });
  const def = d.registry.tools.get("relay.pair.ticket");
  assert.equal(await def.presence.when(), false, "no prompt on darwin: the call can only refuse");
  const r = await d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  assert.equal(r.error.code, "not_available_here");
});

test("relay: on a Mac with vyre-core holding the keys, the box pairs a phone end to end through core's dh and signature, and no key file is written", async t => {
  assert.equal(macCoreRefusal("darwin", true), null);
  assert.equal(macCoreRefusal("darwin", false).code, "not_available_here");
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", real));
  const core = fakeCoreKeys({ made: false });
  const { d, root } = await world(t, {}, { coreKeys: core });
  const def = d.registry.tools.get("relay.pair.ticket");
  assert.equal(await def.presence.when(), true, "the ticket is offered once core holds the keys");
  const url = await firstPairing(d);
  const p = await phone(url);
  assert.equal(p.reply.paired, true);
  assert.ok(core.calls.boxDh >= 2, "the handshake's static DHs were answered by core");
  assert.ok(core.calls.routeSign >= 1, "the relay's challenge was signed by core");
  assert.equal(fs.existsSync(path.join(root, "relay", "keys.json")), false, "no key file at the login uid");
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  assert.equal(status.connected, true);
  const ts = (await d.registry.call("relay.tailnet.status", {}, "cli", PROOF)).data;
  assert.equal(ts.available, true, "a Mac server can hand paired desktops a tailnet key once core holds its keys");
  assert.equal(ts.why, null);
  // relay.join is offered too: its device key is core's as well, so a garbage code is refused as garbage, not as "not on a Mac"
  const j = await d.registry.call("relay.join", { url: "vyre://x" }, "cli", PROOF);
  assert.equal(j.error.code, "bad_input");
});

test("relay: /v1/pair is rate-limited per IP", async t => {
  const { d } = await world(t);
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  const base = status.url.replace(/^ws/, "http");
  let last;
  for (let i = 0; i < 31; i++) last = await fetch(`${base}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: "x".repeat(24) }) });
  assert.equal(last.status, 429);
});
