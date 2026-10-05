// @ts-check
// A paired server reaches its home through the relay (the fallback when the direct path is down): the home admits the server's relay key (derived from the peer secret both hold) as a row of
// kind "server", the server opens one peer stream with that key, and the home's door answers it. A random key is not a server; the device list never shows the row; dropping the row closes it.
// A real vyred with the relay module and the Node relay, on 127.0.0.1; the door is a recording stand-in (the real one is core/daemon/peer-door.js, tested there).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { connect } from "../relay/client/client.js";
import { nodeCrypto } from "../relay/client/nodecrypto.js";
import { relayKeyPair } from "../core/wink/directkey.js";
import { peerSession, streamPipe } from "../core/wink/node/peer-wire.js";
import { tempHome } from "./helpers.js";
import { macCore } from "./fake-core-keys.js";

const lenient = {
  required: (/** @type {string} */ tool, /** @type {any} */ def, /** @type {any} */ input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }), summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]), enroll(/** @type {any} */ k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const until = async (/** @type {() => any} */ f, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 25)); } };

test("a paired server's relay key opens one peer stream to its home; a stranger's does not; the row is hidden and can be dropped", async t => {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "home", transcripts: [], network: { name: "home" }, relay: { enabled: true, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore() });
  t.after(() => d.stop());
  /** the stand-in door: it knows one server and records what it was given */
  const SID = "srv_testserver0000000001";
  const seen = /** @type {any[]} */ ([]);
  const door = { space: "home", allow: () => false, accept: () => {}, isServer: (/** @type {string} */ id) => id === SID && !door.gone,
    gone: false,
    acceptServer: (/** @type {any} */ stream, /** @type {{ serverId: string }} */ who) => { seen.push(who.serverId); peerSession(streamPipe(stream), { first: 2, serve: async (/** @type {string} */ tool) => ({ answered: tool, by: who.serverId }) }); } };
  d.registry.deps.peerDoor = () => door;
  await until(() => d.registry.modules.get("relay")?.state === "running");

  const info = /** @type {any} */ ((await d.registry.call("relay.route.id", {}, "module:wink")).data);
  assert.ok(info.route && info.box);
  const secret = Buffer.from("a-peer-secret-both-sides-hold-0123456789").toString("base64url");
  const kp = relayKeyPair(secret);
  assert.deepEqual(relayKeyPair(secret).publicKey, kp.publicKey, "the key is the same every time from the same secret");
  assert.notDeepEqual(relayKeyPair(Buffer.from("another-secret-0123456789abcdef").toString("base64url")).publicKey, kp.publicKey);

  const dial = async (/** @type {{ privateKey: Uint8Array, publicKey: Uint8Array }} */ keys) => {
    const c = connect({ relay: url, route: info.route, box: info.box, name: "a server", crypto: nodeCrypto(), keyStore: { get: async () => keys, set: async () => {} }, backoff: { min: 200, max: 400 } });
    t.after(() => c.close());
    return c;
  };

  // before the home admits it, the key is nobody's
  const early = await dial(kp);
  await assert.rejects(() => Promise.race([early.ready(), new Promise((_, rej) => setTimeout(() => rej(new Error("no channel")), 1500))]), /no channel|not a paired|refus/i);
  early.close();

  const admit = /** @type {any} */ (await d.registry.call("relay.devices.admit-server", { pub: Buffer.from(kp.publicKey).toString("base64url"), server: SID }, "module:wink"));
  assert.ok(admit.data && admit.data.id, JSON.stringify(admit));
  assert.equal(((/** @type {any} */ (await d.registry.call("relay.devices.admit-server", { pub: Buffer.from(kp.publicKey).toString("base64url"), server: SID }, "module:wink"))).data).id, admit.data.id, "admitting twice is the same row");
  const refusedCaller = /** @type {any} */ (await d.registry.call("relay.devices.admit-server", { pub: Buffer.from(kp.publicKey).toString("base64url"), server: SID }, "cli"));
  assert.ok(refusedCaller.error, "only modules may admit a server");

  const c = await dial(kp);
  const chan = await Promise.race([c.ready(), new Promise((_, rej) => setTimeout(() => rej(new Error("the admitted server did not connect")), 8000))]);
  const s = chan.open({ peer: "wink", space: "home" });
  await new Promise((resolve, reject) => { s.onhead = (/** @type {any} */ h) => (h && h.status === 200 ? resolve(undefined) : reject(new Error(`refused ${h && h.status}`))); s.onreset = (/** @type {any} */ why) => reject(new Error(String(why))); });
  const session = peerSession(streamPipe(s), { first: 1 });
  assert.deepEqual(await session.call("network.wink.status", {}), { answered: "network.wink.status", by: SID });
  assert.deepEqual(seen, [SID]);

  // it may not use the relay for anything else: a plain request is refused, and the device list does not show the row
  const shown = /** @type {any} */ ((await d.registry.call("relay.devices.list", {}, "cli", { proof: { method: "passkey", id: "x" } })).data);
  assert.ok(!JSON.stringify(shown).includes(SID) && !JSON.stringify(shown).includes('"server"'), "the device list never shows a server's relay row");

  // a stranger's key (a device that was never admitted) is refused
  const stranger = await dial(await nodeCrypto().generateKeyPair());
  await assert.rejects(() => Promise.race([stranger.ready(), new Promise((_, rej) => setTimeout(() => rej(new Error("no channel")), 1500))]), /no channel|not a paired|refus/i);

  // the door's own check, asked on every stream: a server that is no longer paired gets nothing
  door.gone = true;
  const s2 = chan.open({ peer: "wink", space: "home" });
  const second = await new Promise(resolve => { s2.onhead = (/** @type {any} */ h) => resolve(h && h.status); s2.onreset = () => resolve("reset"); });
  assert.notEqual(second, 200, "a server the home no longer pairs may not open a stream");
  door.gone = false;

  // dropping the row closes its channel
  const dropped = /** @type {any} */ (await d.registry.call("relay.devices.drop-server", { server: SID }, "module:wink"));
  assert.equal(dropped.data.dropped, 1);
  await until(() => c.state !== "open", 5000);
});
