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
import { tempHome } from "./helpers.js";

/** Asks for a proof on every human-only tool and takes any proof: refusals below are about who is calling. */
const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
};
const PROOF = { proof: { method: "passkey", id: "x" } };

async function world(t) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { name: "alex" }, relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());
  return { d, relay, url, root };
}

/** Alex's phone: scan, connect, handshake. Resolves with a request helper once the box answers. */
async function phone(scanned, { keys = keyPair(), pair = true, name = "alex's phone" } = {}) {
  const offer = /** @type {any} */ (parsePairUrl(scanned));
  assert.ok(offer, "the QR code parses");
  const ws = new WebSocket(`${offer.relay}/v1/device?route=${offer.route}`);
  ws.binaryType = "arraybuffer";
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const side = deviceSide({ send: b => ws.send(b), close: (c, r) => ws.close(c === 1000 || (c >= 3000 && c < 5000) ? c : 4000, r) },
    { s: keys, box: offer.box, route: offer.route, hello: { v: 1, name, ...(pair ? { pair: offer.secret } : {}) } });
  let closed = null;
  ws.onmessage = e => { if (typeof e.data !== "string") side.receive(Buffer.from(e.data)); };
  ws.onclose = e => { closed = { code: e.code, reason: e.reason }; side.gone(e.reason || "closed"); };
  const { channel, reply } = await side.ready;
  /** One request through the channel; resolves with status, headers and the parsed body. */
  const request = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const s = channel.open({ method, path: p, headers: { "content-type": "application/json", ...headers } });
    const parts = [];
    let head;
    s.onhead = h => { head = h; };
    s.ondata = c => parts.push(c);
    s.onend = () => { const raw = Buffer.concat(parts).toString(); resolve({ status: head.status, headers: head.headers, ...(raw ? JSON.parse(raw) : {}) }); };
    s.onreset = reject;
    if (body !== undefined) s.write(Buffer.from(JSON.stringify(body)));
    s.end();
  });
  const call = (tool, input = {}, headers) => request("POST", `/v1/tools/${tool}`, input, headers);
  return { ws, channel, reply, request, call, keys, closed: () => closed, offer };
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
  assert.deepEqual(list.data.devices.map(x => [x.id, x.name, x.online]), [[p.reply.device, "alex's phone", true]]);

  const events = (await d.registry.call("relay.status", {}, "cli")).data;
  assert.equal(events.devices, 1);
  assert.equal(events.connected, true);
});

test("relay: a device is a person that may ask, and presence still decides", async t => {
  const { d } = await world(t);
  const p = await phone(await firstPairing(d));
  const bare = await p.call("relay.pair.start");
  assert.equal(bare.status, 403);
  assert.equal(bare.error.code, "presence_required");
  const proved = await p.call("relay.pair.start", {}, { "x-vyre-presence": "passkey id=abc" });
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
