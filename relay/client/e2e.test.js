// @ts-check
// The client end to end: a real vyred with the relay module, the Node relay from relay/node/, and
// kit (alex's phone) as this client, on WebCrypto with a non-extractable key. It pairs from the QR
// URL, calls the box's router as device:<id>, follows the event stream, and survives the relay
// dropping its socket mid-stream. A second world puts a recording box behind the same relay to
// see the Idempotency-Key retry. Everything on 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { HUMAN_ONLY } from "../../core/presence/index.js";
import { createRelay } from "../node/server.js";
import { keyPair } from "../../core/relay/noise.js";
import { newRouteKey, routeId } from "../../core/relay/wire.js";
import { relayLink } from "../../core/relay/link.js";
import { tempHome } from "../../test/helpers.js";
import { pair, connect } from "./client.js";
import { webCrypto, memoryKeyStore } from "./webcrypto.js";
import { serveWith, reply } from "./testing.js";

const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
};
const PROOF = { proof: { method: "passkey", id: "x" } };
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 10)); }
};

/** The relay, and every device socket it accepts, so a test can cut one from the relay's side. */
async function relayWorld(t) {
  const relay = createRelay();
  const url = await relay.listen();
  const devices = [];
  relay.server.on("upgrade", (req, socket) => { if (String(req.url).startsWith("/v1/device")) devices.push(socket); });
  t.after(() => relay.close());
  return { relay, url, devices };
}

test("client e2e: pair from the QR URL, call the router as device:<id>, follow events across a relay drop", async t => {
  const { url, devices } = await relayWorld(t);
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { name: "alex" }, relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());
  const offer = (await d.registry.call("relay.pair.first", {}, "onboard", PROOF)).data.url;

  const keyStore = memoryKeyStore();
  const crypto = webCrypto();
  const paired = await pair(offer, { name: "kit", keyStore, crypto });
  assert.match(paired.device, /^[a-z2-7]{16}$/);
  assert.equal(paired.name, "alex");
  assert.equal((await keyStore.get())?.privateKey.extractable, false);

  const conn = connect({ ...paired, keyStore, crypto, backoff: { min: 200, max: 1000 } });
  t.after(() => conn.close());
  const health = await conn.fetch("/v1/health");
  assert.equal(health.status, 200);
  await health.text();
  // The device list is the person's own (reach person): a paired device with no person session is asked to sign in. An owner-only tool that is not person-reach answers device:<id>.
  const list = await conn.fetch("/v1/tools/relay.devices.list", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(list.status, 401);
  await list.text();
  const status = await conn.fetch("/v1/tools/relay.status", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(status.status, 200, "an owner-only tool answers device:<id>");
  await status.text();

  const got = [];
  let opened = 0;
  const ev = conn.events("/v1/events/stream?type=demo.*&since=latest", { onEvent: e => got.push([Number(e.id), e.event]), onOpen: () => { opened++; } });
  await until(() => opened === 1);
  d.events.emit("test", "demo.one", {});
  await until(() => got.length === 1);

  // The relay drops the device's socket mid-stream; two events happen while kit is away.
  const states = [];
  conn.onstate = s => states.push(s);
  devices.at(-1).destroy();
  await until(() => conn.state !== "open");
  d.events.emit("test", "demo.two", {});
  d.events.emit("test", "demo.three", {});
  await until(() => got.length === 3);
  d.events.emit("test", "demo.four", {});
  await until(() => got.length === 4);
  assert.deepEqual(got.map(g => g[1]), ["demo.one", "demo.two", "demo.three", "demo.four"], "nothing lost, nothing twice");
  assert.ok(got.every((g, i) => i === 0 || g[0] > got[i - 1][0]));
  assert.ok(states.includes("open"), "it reconnected");
  assert.ok(devices.length >= 3, "a new socket (pair, first connect, reconnect)");
  ev.close();
});

test("client e2e: a POST whose response the relay lost is retried once with the same Idempotency-Key", async t => {
  const { url, devices } = await relayWorld(t);
  const routeKey = newRouteKey(), boxKey = keyPair(), route = routeId(routeKey.pub);
  const seen = [];
  let drop = true;
  const link = relayLink({ url, route, routeKey, boxKey, admit: async () => ({ v: 1, box: { name: "juno" }, device: "kitdevice00000000" }),
    onchannel: channel => serveWith((s, h, body) => {
      seen.push({ key: h.headers["idempotency-key"], body: body.toString() });
      // The box ran it, then the relay lost the device's socket before the answer got out.
      if (drop) { drop = false; devices.at(-1).destroy(); return; }
      reply(s, 200, { data: { saved: true } });
    })(channel) });
  t.after(() => link.stop());
  assert.equal(await link.ready(), true);
  const conn = connect({ relay: url, route, box: new Uint8Array(boxKey.pub), keyStore: memoryKeyStore(), crypto: webCrypto(), backoff: { min: 100, max: 500 } });
  t.after(() => conn.close());
  const res = await conn.fetch("/v1/tools/notes.add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Harlow Legal call back" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { data: { saved: true } });
  assert.equal(seen.length, 2);
  assert.match(String(seen[0].key), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(seen[1].key, seen[0].key);
  assert.equal(seen[1].body, seen[0].body);
});
