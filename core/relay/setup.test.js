// @ts-check
// The setup session's box half (core/relay/setup.js and the setup path in core/relay/index.js):
// the session's life, the allowlist gate, and end to end against a real vyred and the Node relay
// with the setup page played by relay/client/setup.js. The six refusal checks of tailnet plan
// 3.6b condition 6 are the ones named "refusal" below.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { start } from "../daemon/index.js";
import { createRelay } from "../../relay/node/server.js";
import { keyPair } from "./noise.js";
import { loadKeys } from "./keys.js";
import { deviceSide } from "./channel.js";
import * as wire from "./wire.js";
import { WEB_DENY } from "./index.js";
import { SetupSession, setupGate, setupToolAllowed, SETUP_TOOLS } from "./setup.js";
import { createSetupKey, setupCode, setupHello, setupWords, resolveSetup, mailboxReader } from "../../relay/client/setup.js";
import { pairTicket } from "../../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../../relay/client/nodecrypto.js";
import { fromBase64url } from "../../relay/client/bytes.js";
import { tempHome, writeModule } from "../../test/helpers.js";

// ---- SetupSession, alone ----

/** A clock and a timer under the test's hand. */
function clock() {
  let t = 1_000_000;
  /** @type {Array<{ at: number, fn: () => void }>} */
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const timer = { at: t + ms, fn, unref() {} }; timers.push(timer); return timer; },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    advance(ms) { t += ms; for (const x of timers.filter(y => y.at <= t)) { timers.splice(timers.indexOf(x), 1); x.fn(); } },
    pending: () => timers.length,
  };
}

const newCode = async () => {
  const key = await createSetupKey();
  const secret = crypto.randomBytes(16);
  return { key, secret, code: await setupCode(secret, key.spki) };
};

test("setup session: a code makes a locator and a pairing secret, lives an hour and ends once", async () => {
  const c = clock();
  const { code, secret } = await newCode();
  const ends = [];
  const s = new SetupSession({ code, now: c.now, setTimer: /** @type {any} */ (c.setTimer), clearTimer: /** @type {any} */ (c.clearTimer), onEnd: why => ends.push(why) });
  assert.equal(s.loc, wire.setupDerive("loc", secret).toString("base64url"));
  assert.equal(s.exp, c.now() + wire.SETUP_TTL);
  assert.equal(s.live, true);
  c.advance(59 * 60_000);
  assert.equal(s.live, true);
  c.advance(60_000);
  assert.deepEqual(ends, ["expired"], "the hour ends an unclaimed session, by itself");
  assert.equal(s.live, false);
  assert.equal(s.end("claimed"), false, "ending twice does nothing more");
  assert.deepEqual(ends, ["expired"]);
  const t = new SetupSession({ code, now: c.now, setTimer: /** @type {any} */ (c.setTimer), clearTimer: /** @type {any} */ (c.clearTimer), onEnd: why => ends.push(why) });
  t.end("claimed");
  assert.equal(c.pending(), 0, "ending clears the timer");
  assert.deepEqual(ends, ["expired", "claimed"]);
  assert.throws(() => new SetupSession({ code: "nope" }), { code: "bad_input" });
});

test("setup session: the pairing secret is burned once, and only by a hello that already passed", async () => {
  const { code, key, secret } = await newCode();
  const s = new SetupSession({ code });
  const noise = crypto.randomBytes(32);
  const hello = await setupHello({ ...key, route: "r".repeat(26), noiseStatic: noise, secret });
  assert.ok(s.checkHello({ route: "r".repeat(26), pub: noise, hello }));
  assert.equal(s.takeSecret("wrong"), false);
  assert.equal(s.secUsed, false, "a wrong secret spends nothing");
  assert.equal(s.takeSecret(hello.pair), true);
  assert.equal(s.takeSecret(hello.pair), false, "single use");
  s.end("claimed");
  s.end("x");
});

test("setup session: the allowlist is exactly the plan's, and the extension point never takes pairing, presence or vault tools", () => {
  for (const name of ["relay.setup.status", "wink.server.setup-offer", "link.health", "system.info"]) {
    assert.equal(setupToolAllowed(name), true, name);
  }
  // what the old setup page called is gone from the channel: names, the network step, the passkey claim, the machine step
  for (const name of ["network.wink.status", "names.check", "names.claim", "names.status", "names.domain.check", "relay.setup.claim-token", "onboard.machine", "network.wink.join", "network.wink.leave", "network.wink.whois", "network.wink", "network.tailscale.status", "network.tailscale.login"]) assert.equal(setupToolAllowed(name), false, name);
  for (const name of ["relay.pair.ticket", "relay.setup.end", "relay.setup.begin", "relay.pair.start", "relay.pair.first", "relay.devices.list", "relay.devices.trust", "presence.enroll", "presence.person.start", "vault.reveal", "names.recover", "names.release", "network.wink.statusx", "network.wink.", "network.other", "threads.send", "system.exec", ""]) {
    assert.equal(setupToolAllowed(name), false, name);
  }
  assert.deepEqual([...SETUP_TOOLS].sort(), ["link.health", "relay.setup.status", "system.info", "wink.server.setup-offer"]);
  assert.equal(setupToolAllowed("sessions.accounts.signin"), false, "nothing extra unless the registry lists it");
  assert.equal(setupToolAllowed("sessions.accounts.signin", ["sessions.accounts.signin"]), true);
  for (const bad of ["relay.pair.start", "presence.enroll", "vault.reveal"]) assert.equal(setupToolAllowed(bad, [bad]), false, `${bad} is never taken, even if listed`);
});

/** A fake response that records what the gate answered. */
function res() {
  const r = { status: 0, body: /** @type {any} */ (null), headers: {}, ended: false,
    writeHead(status, headers) { r.status = status; r.headers = headers; },
    end(b) { r.body = b ? JSON.parse(b) : null; r.ended = true; } };
  return r;
}
const request = (method, url) => ({ method, url, headers: {}, resume() {} });

test("setup gate: the setup page mints no pairing ticket (one pairing path: the installer's code, three words); events and paths are the list and nothing else", async () => {
  const { code } = await newCode();
  const s = new SetupSession({ code });
  const seen = [];
  let minted = 0;
  const gate = setupGate({ session: () => s, ownerExists: () => false,
    mintTicket: async () => { minted++; return { ticket: "t" }; },
    handlerFor: policy => (req, rs) => { seen.push({ url: req.url, tool: policy.tool, path: policy.path, eventType: policy.eventType }); rs.writeHead(200, {}); rs.end("{}"); } });
  const call = async (method, url) => { const rs = res(); await gate(request(method, url), rs, "device:x", {}); await new Promise(r => setImmediate(r)); return rs; };

  for (const spelled of ["/v1/tools/relay.pair.ticket", "/v1/tools/relay%2Epair.ticket", "/v1/tools/relay.pair%2eticket"]) {
    const r = await call("POST", spelled);
    assert.equal(r.status, 403, `refusal: relay.pair.ticket, spelled ${spelled}`);
    assert.match(r.body.error.message, /three words/);
  }
  assert.equal(minted, 0, "nothing was minted");
  assert.equal(s.ticket, "none");
  let r;
  // the router's policy is a second layer: only the allowlist by name, and a fixed set of paths
  await call("POST", "/v1/tools/link.health");
  const p = seen.at(-1);
  assert.equal(p.tool("link.health"), true);
  assert.equal(p.tool("relay.devices.list"), false);
  assert.equal(p.path("POST", "/v1/tools/link.health"), true);
  assert.equal(p.path("GET", "/v1/tools"), true);
  for (const [m, u] of [["GET", "/v1/events"], ["GET", "/v1/modules"], ["POST", "/v1/person/token"], ["GET", "/v1/health/x"], ["GET", "/deck/index.html"]]) assert.equal(p.path(m, u), false, `${m} ${u}`);

  r = await call("GET", "/v1/events?type=relay.paired");
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1).eventType, "relay.paired");
  for (const type of ["device.paired", "vault.opened", "", "tailscale.changed", "relay.paired,device.paired"]) {
    r = await call("GET", `/v1/events?type=${encodeURIComponent(type)}`);
    assert.equal(r.status, 404, `event ${type || "(none)"}`);
  }

  // an owner ends the ticket for good, before any spend
  const { code: c2 } = await newCode();
  const s2 = new SetupSession({ code: c2 });
  const gate2 = setupGate({ session: () => s2, ownerExists: () => true, mintTicket: async () => ({}), handlerFor: () => () => {} });
  const rs = res();
  await gate2(request("POST", "/v1/tools/relay.pair.ticket"), rs, "device:x", {});
  assert.equal(rs.status, 403);
  assert.equal(s2.ticket, "none");
  s2.end("claimed");
  const over = res();
  await gate2(request("POST", "/v1/tools/link.health"), over, "device:x", {});
  assert.equal(over.status, 401, "an ended session answers nothing");
  assert.equal(over.body.error.code, "setup_over");
});

// ---- end to end ----

const lenient = {
  required: () => false,
  verify: async () => ({ ok: true, method: "passkey", keyId: "k1" }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
  covered: () => false,
  coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]),
  removed: /** @type {any[]} */ ([]),
  enroll(k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};

/** A real vyred with the relay module, a Node relay, and this machine posing as Linux (a Mac refuses the relay's tickets until vyre-core). */
async function world(t, { fixtures = null, disable = ["names", "onboard"], shipped = true, directory = null } = {}) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", /** @type {any} */ (real)));
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { name: "alex", ...(directory ? { directory } : {}) }, relay: { enabled: false, url: base }, modules: { disable } }));
  lenient.enrolled.length = 0;
  if (fixtures) for (const [name, m, src] of fixtures) writeModule(path.join(root, "modules"), name, m, src);
  const d = await start({ presence: lenient, root, log: () => {}, ...(fixtures && shipped ? { firstPartyRoots: [path.join(root, "modules")] } : {}) });
  t.after(() => d.stop());
  return { d, relay, base, root };
}

/** The setup page: makes its key and code, and (with the box's relay) can begin a session, connect, and call the channel. */
async function page(world) {
  const { key, secret, code } = await newCode();
  const begin = async () => (await world.d.registry.call("relay.setup.begin", { code }, "module:onboard")).data;
  const offer = async () => resolveSetup(secret, { relay: world.base, crypto: nodeCrypto() });
  /** @param {{ keys?: any, hello?: any, pair?: boolean, offer?: any, key?: any }} [o] */
  const connect = async (o = {}) => {
    const off = o.offer || (await offer()).offer;
    const keys = o.keys || keyPair();
    const hello = o.hello || await setupHello({ ...(o.key || key), route: off.route, noiseStatic: keys.pub, ...(o.pair === false ? {} : { secret }) });
    const ws = new WebSocket(`${off.relay}/v1/device?route=${off.route}`);
    ws.binaryType = "arraybuffer";
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const side = deviceSide({ send: b => ws.send(b), close: (c, r) => ws.close(c === 1000 || (c >= 3000 && c < 5000) ? c : 4000, r) }, { s: keys, box: off.box, route: off.route, hello });
    ws.onmessage = e => { if (typeof e.data !== "string") side.receive(Buffer.from(e.data)); };
    ws.onclose = e => side.gone(e.reason || "closed");
    const { channel, reply } = await side.ready;
    const call = (tool, input = {}, headers = {}) => new Promise((resolve, reject) => {
      const raw = JSON.stringify(input);
      const s = channel.open({ method: "POST", path: `/v1/tools/${tool}`, headers: { "content-type": "application/json", ...headers } });
      const parts = []; let head;
      s.onhead = h => { head = h; };
      s.ondata = c => parts.push(c);
      s.onend = () => { const body = Buffer.concat(parts).toString(); resolve({ status: head.status, ...(body ? JSON.parse(body) : {}) }); };
      s.onreset = reject;
      s.write(Buffer.from(raw)); s.end();
    });
    return { ws, channel, reply, call, keys, hello };
  };
  return { key, secret, code, begin, offer, connect };
}

const settle = ms => new Promise(r => setTimeout(r, ms));

test("setup: the page resolves the offer, sees the box's check words, and is admitted only with its own key", async t => {
  const w = await world(t);
  const p = await page(w);
  const status = await p.begin();
  assert.equal(status.state, "waiting");
  assert.equal(status.registered, true, "the relay holds the offer");
  const { offer, name } = await p.offer();
  assert.equal(name, "alex");
  const boxWords = (await setupWords(offer.box, p.secret)).join(" ");
  assert.equal(status.words, boxWords, "the words the page shows are the ones the install script prints");
  assert.equal(status.expiresAt <= Date.now() + wire.SETUP_TTL, true);

  const a = await p.connect();
  assert.equal(a.reply.paired, true);
  assert.equal(a.reply.setup, true);
  const enrolled = (await w.d.registry.call("relay.device.presence", { id: a.reply.device }, "module:test")).data.key;
  assert.match(enrolled, /\S/, "the page key is enrolled as this device's presence key");
  assert.equal((await w.d.registry.call("presence.keys", {}, "cli")).data.filter(k => k.id === enrolled && k.kind === "device").length, 1);
  assert.equal((await w.d.registry.call("relay.setup.status", {}, "cli")).data.state, "paired");
  // not a normal device: it is out of the owner's device list, so no notice, and no owner exists for it to count as
  const list = (await w.d.registry.call("relay.devices.list", {}, "cli")).data.devices;
  assert.deepEqual(list, []);
  // and a reconnect of the same device, with the same signature and no pairing secret, comes back in
  const again = await p.connect({ keys: a.keys, pair: false });
  assert.equal(again.reply.device, a.reply.device);
});

test("setup refusal 1: a hello with the right fingerprint but no signature, or a wrong one, is refused", async t => {
  const w = await world(t);
  const p = await page(w);
  await p.begin();
  const { offer } = await p.offer();
  const keys = keyPair();
  const good = await setupHello({ ...p.key, route: offer.route, noiseStatic: keys.pub, secret: p.secret });
  await assert.rejects(p.connect({ offer, keys, hello: { ...good, setup: { key: good.setup.key } } }), /closed/, "no signature");
  await assert.rejects(p.connect({ offer, keys, hello: { ...good, setup: { key: good.setup.key, sig: "" } } }), /closed/, "an empty signature");
  const forged = Buffer.from(good.setup.sig, "base64url"); forged[10] ^= 4;
  await assert.rejects(p.connect({ offer, keys, hello: { ...good, setup: { key: good.setup.key, sig: forged.toString("base64url") } } }), /closed/, "a wrong signature");
  const other = await createSetupKey();
  const theirs = await setupHello({ ...other, route: offer.route, noiseStatic: keys.pub, secret: p.secret });
  await assert.rejects(p.connect({ offer, keys, hello: theirs }), /closed/, "a key whose fingerprint is not in the code, even with the right pairing secret");
  assert.equal((await w.d.registry.call("relay.setup.status", {}, "cli")).data.state, "waiting", "nothing above spent the code");
  const ok = await p.connect({ offer, keys, hello: good });
  assert.equal(ok.reply.paired, true, "the real page still gets in");
});

test("setup refusal 2: a hello replayed from another Noise key is refused", async t => {
  const w = await world(t);
  const p = await page(w);
  await p.begin();
  const { offer } = await p.offer();
  const first = keyPair();
  const captured = await setupHello({ ...p.key, route: offer.route, noiseStatic: first.pub, secret: p.secret });
  // Someone who saw the whole hello off a wire replays it from their own Noise key.
  await assert.rejects(p.connect({ offer, keys: keyPair(), hello: captured }), /closed/);
  const ok = await p.connect({ offer, keys: first, hello: captured });
  assert.equal(ok.reply.paired, true);
});

test("setup refusal 3: the setup key can mint no relay.pair.ticket, so no device is paired at the relay by the setup page", async t => {
  const w = await world(t);
  const p = await page(w);
  await p.begin();
  const a = await p.connect();
  const first = await a.call("relay.pair.ticket");
  assert.equal(first.status, 403, JSON.stringify(first));
  assert.match(first.error.message, /three words/);
  assert.equal((await w.d.registry.call("relay.setup.status", {}, "cli")).data.ticket, false);
  const devices = (await w.d.registry.call("relay.devices.list", {}, "cli")).data.devices;
  assert.deepEqual(devices.map(x => x.name), []);
});

test("setup refusal 4: a second browser holding the code cannot pair or reach the setup channel", async t => {
  const w = await world(t);
  const p = await page(w);
  await p.begin();
  const { offer } = await p.offer();
  // The code is (secret16 || fp), so the second browser knows the secret and the fingerprint, and can resolve the offer.
  const second = await createSetupKey();
  const keys = keyPair();
  // A key of its own: fp does not match.
  await assert.rejects(p.connect({ offer, keys, key: second }), /closed/);
  // No setup hello at all, only the pairing secret, as an ordinary device would send it: it is not a device of this box.
  const derived = base64UrlOf(wire.setupDerive("sec", p.secret));
  const plain = { v: 1, name: "intruder", pair: derived };
  await assert.rejects(p.connect({ offer, keys, hello: plain }), /closed/, "the setup secret is no ordinary pairing code");
  assert.deepEqual((await w.d.registry.call("relay.devices.list", {}, "cli")).data.devices, [], "nothing became a device");
  // The real page pairs; a later hello from the real page's key but a different Noise key (a second tab that lost its own) is refused too.
  const a = await p.connect();
  assert.equal(a.reply.paired, true);
  await assert.rejects(p.connect({ offer, keys: keyPair() }), /closed/, "one setup device, and its pairing secret is spent");
  await assert.rejects(p.connect({ offer, keys: keyPair(), pair: false }), /closed/, "and no reconnect from a device the session did not admit");
});
const base64UrlOf = b => Buffer.from(b).toString("base64url");

test("setup: the channel reaches the allowlist and nothing else", async t => {
  const w = await world(t);
  const p = await page(w);
  await p.begin();
  const a = await p.connect();
  assert.equal((await a.call("relay.setup.status")).status, 200);
  assert.equal((await a.call("system.info")).status !== 404, true, "system.info is on the list");
  for (const tool of ["relay.devices.list", "relay.devices.trust", "relay.pair.start", "relay.pair.first", "relay.enable", "relay.status", "presence.enroll", "presence.person.start", "vault.list", "threads.send", "onboard.claim"]) {
    const r = await a.call(tool);
    assert.equal(r.status, 404, `${tool} is not on the list: ${JSON.stringify(r)}`);
  }
  for (const internal of ["relay.setup.end", "relay.setup.begin", "relay.device.presence"]) {
    const r = await a.call(internal, { code: "x" });
    assert.equal(r.status, 404, `${internal} is not callable through the channel`);
  }
  assert.equal((await w.d.registry.call("relay.setup.status", {}, "cli")).data.state, "paired", "the attempts above ended nothing");
});

test("setup: relay.setup.end drops the device, its presence key and its channel, and the door shuts", async t => {
  const w = await world(t);
  const p = await page(w);
  await p.begin();
  const a = await p.connect();
  const enrolled = (await w.d.registry.call("relay.device.presence", { id: a.reply.device }, "module:test")).data.key;
  assert.match(enrolled, /\S/);
  const ended = [];
  w.d.events.on("setup.ended", e => ended.push(e.payload || e));
  assert.equal((await a.call("relay.setup.status")).status, 200);
  // Internal only: the CLI and a person cannot end it, a module (the claim) can.
  assert.equal((await w.d.registry.call("relay.setup.end", {}, "cli")).error?.code, "no_such_tool");
  const r = await w.d.registry.call("relay.setup.end", { reason: "claimed" }, "module:onboard");
  assert.deepEqual(r.data, { ended: true });
  await settle(100);
  assert.equal(a.channel.closed, true, "the channel is closed");
  assert.equal((await w.d.registry.call("relay.device.presence", { id: a.reply.device }, "module:test")).data.key, null, "the device row is gone");
  assert.equal((await w.d.registry.call("presence.keys", {}, "cli")).data.filter(k => k.id === enrolled).length, 0, "and its presence key with it");
  assert.equal((await w.d.registry.call("relay.setup.status", {}, "cli")).data.state, "none");
  assert.deepEqual(ended.map(e => e.why), ["claimed"]);
  await assert.rejects(p.connect({ keys: a.keys, pair: false }), /closed/, "the same key and the same page cannot come back");
  assert.deepEqual((await w.d.registry.call("relay.setup.end", {}, "module:onboard")).data, { ended: false });
});

test("setup: a new install code discards the device of an earlier unclaimed session", async t => {
  const w = await world(t);
  const one = await page(w);
  await one.begin();
  const a = await one.connect();
  assert.equal(a.reply.paired, true);
  const two = await page(w);
  const status = await two.begin();
  assert.equal(status.state, "waiting");
  await settle(100);
  assert.equal(a.channel.closed, true, "the earlier session's channel was closed");
  assert.equal((await w.d.registry.call("relay.device.presence", { id: a.reply.device }, "module:test")).data.key, null);
  await assert.rejects(one.connect({ keys: a.keys, pair: false }), /closed/, "the old page is out");
  const b = await two.connect();
  assert.equal(b.reply.paired, true);
  assert.notEqual(b.reply.device, a.reply.device);
});

test("setup: an owner on the box shuts the setup door, and a code does nothing on a box that has one", async t => {
  const w = await world(t);
  const p = await page(w);
  await p.begin();
  const a = await p.connect();
  // an owner exists once a device is paired by another path (the owner's own ring ticket; the test helpers run the one-step ring)
  const ticket = await w.d.registry.call("relay.pair.ticket", {}, "cli", { proof: { method: "passkey", id: "x" } });
  assert.ok(ticket.data?.ticket, JSON.stringify(ticket.error));
  await pairTicket(fromBase64url(ticket.data.ticket), { relay: w.base, name: "phone", crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(tempHome(t), "k.json")) });
  const status = (await a.call("relay.setup.status")).data;
  assert.equal(status.ownerExists, true);
  await assert.rejects(p.connect({ keys: keyPair(), pair: false }), /closed/, "no new setup device once there is a person");
  const q = await page(w);
  const r = await w.d.registry.call("relay.setup.begin", { code: q.code }, "module:onboard");
  assert.equal(r.error?.code, "denied");
});

test("setup: a second server that used the same code first makes the offer contested for the box, the page and the mailbox", async t => {
  const w = await world(t);
  const p = await page(w);
  // Another box registers this code's locator before ours does (a second server given the same code).
  const other = wire.newRouteKey();
  const route = wire.routeId(other.pub);
  const ws = new WebSocket(`${w.base}/v1/box?route=${route}`);
  const inbox = [];
  ws.onmessage = e => inbox.push(JSON.parse(String(e.data)));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await settle(30);
  ws.send(JSON.stringify({ t: "auth", pub: other.pub.toString("base64url"), sig: wire.signRoute(other.priv, wire.authMessage(route, Buffer.from(inbox[0].n, "base64url"))).toString("base64url") }));
  await settle(30);
  const loc = wire.setupDerive("loc", p.secret).toString("base64url");
  const theirRecord = wire.ticketSeal(p.secret, JSON.stringify({ v: 1, name: "impostor" }));
  ws.send(JSON.stringify({ t: "setup", loc, record: theirRecord, mac: wire.ticketMac(p.secret, theirRecord).toString("base64url"), exp: Date.now() + 3_600_000 }));
  await settle(30);
  assert.equal(inbox.at(-1).status, 200, "they got there first");
  const status = await p.begin();
  assert.equal(status.state, "contested", "our box hears 409 and says so, for the install script to print");
  assert.equal((await w.d.registry.call("relay.setup.status", {}, "cli")).data.state, "contested");
  await assert.rejects(p.offer(), { code: "contested" });
  await assert.rejects(p.connect({ offer: { relay: w.base, route: "a".repeat(26), box: Buffer.alloc(32) } }), /./);
  const reader = await mailboxReader({ relay: w.base, secret: p.secret, key: p.key });
  await assert.rejects(reader.next(0), { code: "contested" });
  ws.close();
});

test("setup: a hello for a box with no setup session is refused, and so is a plain code the box never made", async t => {
  const w = await world(t);
  const p = await page(w);
  await w.d.registry.call("relay.enable", {}, "cli", { proof: { method: "passkey", id: "x" } });
  await settle(100);
  const status = (await w.d.registry.call("relay.status", {}, "cli")).data;
  assert.deepEqual(status.tunnel, { url: null, connected: false }, "no public door until an address is set");
  assert.equal((await w.d.registry.call("relay.setup.status", {}, "cli")).data.state, "none");
  // The relay is up but no setup was begun; nothing is registered for this code, so the page finds no offer at all.
  await assert.rejects(p.offer(), { code: "ticket_gone" });
  // And a device that dials the route with a setup hello anyway is closed without a word.
  const k = loadKeys(w.root);
  const off = { relay: w.base, route: status.route, box: k.box.pub };
  await assert.rejects(p.connect({ offer: off }), /closed/);
});

test("route key: only a name-directory message for this box's own route is signed, and the signature verifies", async t => {
  const w = await world(t);
  const id = (await w.d.registry.call("relay.route.id", {}, "module:names")).data;
  assert.match(id.route, /\S/);
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(id.pub, "base64url")]), format: "der", type: "spki" });
  const good = Buffer.from(`vyre-names-v1\n${id.route}\n1\nn\nPOST\n/v1/names/claim\nabc`);
  const { sig } = (await w.d.registry.call("relay.route.sign", { message: good.toString("base64url") }, "module:names")).data;
  assert.equal(crypto.verify(null, good, pub, Buffer.from(sig, "base64url")), true);
  for (const bad of [`vyre-names-v1\n${"x".repeat(26)}\n1`, `vyre-relay-auth\n${id.route}\n1`, ""]) {
    const r = await w.d.registry.call("relay.route.sign", { message: Buffer.from(bad).toString("base64url") }, "module:names");
    assert.ok(r.error, "a foreign message is never signed");
  }
  const person = await w.d.registry.call("relay.route.id", {}, "cli");
  assert.ok(person.error, "modules only");
  assert.equal((await w.d.registry.call("relay.route.id", {}, "module:vyred")).data.box, id.box, "the daemon's own door (the invitee door) reads this box's id");
  for (const tool of ["relay.route.id", "relay.route.sign", "relay.setup.begin", "relay.setup.end"]) {
    const r = await w.d.registry.call(tool, { message: good.toString("base64url"), code: "x", reason: "x" }, "module:sneaky");
    assert.ok(r.error, `${tool} is refused to a module that is not on its list`);
  }
});

test("setup boot: a code starts only with a stamp from the last hour; missing, garbage, future and stale ones are refused", async t => {
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; });
  const { code } = await newCode();
  const sec = Math.floor(Date.now() / 1000);
  for (const [at, expect] of [[String(sec - 3700), "none"], [String(sec - 60), "waiting"], [String(Date.now() - 60_000), "waiting"], [undefined, "none"], ["abc", "none"], ["99999999999", "none"], [String(9e15), "none"], [String(Date.now() - 3_700_000), "none"], ["", "none"]]) {
    process.env.VYRE_SETUP_CODE = code;
    if (at !== undefined) process.env.VYRE_SETUP_CODE_AT = at; else delete process.env.VYRE_SETUP_CODE_AT;
    const w = await world(t);
    await settle(150);
    const st = (await w.d.registry.call("relay.setup.status", {}, "cli")).data;
    assert.equal(st.state, expect, `stamp ${at}`);
    if (expect === "none") { assert.equal(st.failed, true, `stamp ${at}: the status says the code was not used`); assert.match(st.why, /older than an hour|no valid time/, "and why"); } else assert.notEqual(st.failed, true);
    assert.equal(process.env.VYRE_SETUP_CODE, undefined, "taken out of the environment either way");
    await w.d.stop();
  }
});

test("setup boot: a relay that is not answering yet is tried again for the code's hour, and the status says it is retrying; a box with an owner is refused at once with its reason", async t => {
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; });
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", /** @type {any} */ (real)));
  const first = createRelay();
  const base = await first.listen();
  const port = Number(new URL(base).port);
  await first.close();
  const { code } = await newCode();
  process.env.VYRE_SETUP_CODE = code;
  process.env.VYRE_SETUP_CODE_AT = String(Math.floor(Date.now() / 1000));
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: false, url: base, setupRetryMs: 40 }, modules: { disable: ["names", "onboard"] } }));
  lenient.enrolled.length = 0;
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());
  const status = async () => (await d.registry.call("relay.setup.status", {}, "cli")).data;
  let st = await status();
  for (let i = 0; i < 60 && !st.retrying && st.state === "none"; i++) { await settle(50); st = await status(); }
  // the relay is not there: either the session waits for it (state waiting, not registered) or the boot is retrying; neither is a failure
  assert.notEqual(st.failed, true, `not given up: ${JSON.stringify(st)}`);
  const second = createRelay();
  await second.listen(port);
  t.after(() => second.close());
  for (let i = 0; i < 200; i++) { st = await status(); if (st.state === "waiting" && st.registered) break; await settle(50); }
  assert.equal(st.state, "waiting", `the relay came up and the setup began: ${JSON.stringify(st)}`);
  assert.equal(st.registered, true, "and the offer is registered");
});

test("web deny: an untrusted paired browser cannot make a setup claim, and can still read the network status", () => {
  assert.equal(WEB_DENY.test("relay.setup.claim"), true);
  assert.equal(WEB_DENY.test("relay.setup.claim-token"), false, "a different tool, the setup page's own");
  for (const ok of ["network.wink.status", "link.health", "system.info"]) assert.equal(WEB_DENY.test(ok), false, ok);
});

// ---- the setup channel, one session, end to end ----

/** A local stand-in for names.vyre.run: checks each request's route signature and remembers claims. */
async function fakeDirectory(t) {
  const http = await import("node:http");
  const { authMessage } = await import("../names/directory.js");
  const out = { claims: /** @type {any[]} */ ([]), unsigned: 0, url: "" };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const h = req.headers, url = new URL(req.url || "/", "http://x");
      const send = data => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data })); };
      try {
        const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(String(h["x-vyre-pub"]), "base64url")]), format: "der", type: "spki" });
        const msg = authMessage({ route: String(h["x-vyre-route"]), ts: String(h["x-vyre-ts"]), nonce: String(h["x-vyre-nonce"]), method: String(req.method), target: url.pathname + url.search, bodyHash: crypto.createHash("sha256").update(body).digest("hex") });
        if (!crypto.verify(null, msg, pub, Buffer.from(String(h["x-vyre-sig"]), "base64url"))) throw new Error("bad signature");
      } catch { out.unsigned++; res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { code: "denied", message: "unsigned" } })); }
      if (url.pathname === "/v1/names/claim") { const first = out.claims.length === 0; out.claims.push(JSON.parse(body)); return send({ name: JSON.parse(body).name, mine: true, fresh: first }); }
      if (url.pathname === "/v1/names/mine") return send({ name: "alex", state: "live", pointed: false, ips: {}, pending: null, notices: [] });
      res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "not_found", message: url.pathname } }));
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => srv.close(r)));
  out.url = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
  return out;
}

const SIGNIN_FIXTURE = `export default { async start(ctx) {
  ctx.tool("sessionsfx.accounts.signin", { input: { type: "object", properties: {} }, run: async () => ({ started: true }) });
  ctx.tool("sessionsfx.accounts.other", { input: { type: "object", properties: {} }, run: async () => ({ other: true }) });
  return { async stop() {} };
} };`;

test("setup: modules declare setupTools in module.json and the setup channel reaches exactly those; one session survives a call and a second call", async t => {
  const dirFake = await fakeDirectory(t);
  const w = await world(t, { disable: ["onboard"], directory: dirFake.url, fixtures: [
    ["sessionsfx", { does: { tools: ["sessionsfx.accounts.signin", "sessionsfx.accounts.other"] }, setupTools: ["sessionsfx.accounts.signin"] }, SIGNIN_FIXTURE],
  ] });
  // the registry's list: the tool the module owns and declared (no shipped module declares any now)
  const listed = await new Promise(r => { const c = w.d.registry.context({ name: "probe", does: { tools: [] } }); r(c.declaredSetupTools()); });
  assert.deepEqual([...listed].sort(), ["sessionsfx.accounts.signin"], "only the fixture's own field");

  const p = await page(w);
  await p.begin();
  const a = await p.connect();
  assert.equal((await a.call("sessionsfx.accounts.signin")).data.started, true, "the module's declared tool is reachable");
  assert.notEqual((await a.call("sessionsfx.accounts.other")).status, 200, "a tool the module did not list is not");
  assert.equal((await a.call("system.info")).status, 200, "and a tool of the fixed list is");
  assert.notEqual((await a.call("names.claim", { name: "alex" })).status, 200, "the old page's name step is not on the channel any more");
  assert.equal((await a.call("sessionsfx.accounts.signin")).data.started, true);
  assert.equal((await w.d.registry.call("relay.setup.status", {}, "cli")).data.state, "paired", "the session survived all of it");
  assert.notEqual((await a.call("relay.setup.end")).status, 200, "and the channel cannot end it, even though the module listed the tool");
});

test("setup: an added module carrying setupTools is refused at load, so its field counts for nothing, and a manifest listing a tool it does not declare is refused", async t => {
  const w = await world(t, { shipped: false, fixtures: [["sneaky", { does: { tools: ["sneaky.signin"] }, setupTools: ["sneaky.signin"] },
    `export default { async start(ctx) { ctx.tool("sneaky.signin", { input: { type: "object", properties: {} }, run: async () => ({ ok: true }) }); return { async stop() {} }; } };`]] });
  assert.equal(w.d.registry.status().find(m => m.name === "sneaky")?.state, "invalid", "setupTools is built in only (the platform's added-module rules)");
  const declared = w.d.registry.context({ name: "probe", does: { tools: [] } }).declaredSetupTools();
  assert.ok(!declared.some(x => x.startsWith("sneaky.")), "and its field counts for nothing");
  assert.ok(!declared.includes("sessions.accounts.signin"), "no shipped module declares one now");
  const { validate } = await import("../modules/index.js");
  for (const bad of [["relay.setup.end"], ["sessionsfx.accounts.missing"], "sessionsfx.accounts.signin", [5]]) {
    assert.ok(validate({ name: "sessionsfx", version: "0.1.0", does: { tools: ["sessionsfx.accounts.signin"] }, setupTools: bad }, { firstParty: true }).some(p => /setupTools/.test(p)), JSON.stringify(bad));
  }
  assert.deepEqual(validate({ name: "sessionsfx", version: "0.1.0", does: { tools: ["sessionsfx.accounts.signin"] }, setupTools: ["sessionsfx.accounts.signin"] }, { firstParty: true }), []);
});
