// @ts-check
// The pairing window: one proof opens up to 10 minutes of renewing the Wink code from one screen, and a phone that redeems a
// code is enrolled only after that screen confirms it. A real vyred, the Node relay, a fake clock for the window. 127.0.0.1 only.

import "../scripts/mac-test-guard.mjs";
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
import { macCoreRefusal, seams as relaySeams } from "../core/relay/index.js";
import { useReleasesFile } from "../core/relay/releases.js";
import { signed } from "../core/presence/person.js";
import { pairTicket, resolveTicket, pairOffer, connect, keyFingerprint } from "../relay/client/client.js";
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

async function world(t, relayConfig = {}, startOpts = {}, relayOpts = {}) {
  const relay = createRelay(relayOpts);
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { name: "alex" }, relay: { enabled: false, url, ...relayConfig }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore(), ...startOpts });
  t.after(() => d.stop());
  return { d, relay, url, root };
}


const SCREEN = "device:abcdefghijklmnop";
const A = { proof: { method: "passkey", id: "x" }, peer: { stableId: "nodeA", node: "a" }, person: { id: "ps1" } };
const A2 = { peer: { stableId: "nodeA", node: "a" }, person: { id: "ps1" } };
const B = { peer: { stableId: "nodeB", node: "b" }, person: { id: "ps1" } };
const OTHER_SESSION = { peer: { stableId: "nodeA", node: "a" }, person: { id: "ps2" } };

/** A box on a fake clock, with a screen that may open a window. */
async function windowWorld(t) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  const clock = { t: Date.now() };
  relaySeams.set(root, { now: () => clock.t });
  t.after(() => relaySeams.delete(root));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: m => { if (process.env.WLOG) console.log("BOX", m); }, coreKeys: macCore() });
  t.after(() => d.stop());
  const events = [];
  d.events.on("pairing.*", e => events.push([e.type, e.payload]));
  d.events.on("pairing-window.*", e => events.push([e.type, e.payload]));
  const call = (tool, input, caller = SCREEN, meta = A2) => d.registry.call(tool, input, caller, meta);
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  return { d, relay, url, root, clock, events, call, status };
}
const live = w => w.relay; // the Node relay's own ticket map is internal; liveness is read by resolving

test("pairing window: only the owner's own screen can open it, with a proof; a terminal, an agent or a module cannot", async t => {
  const w = await windowWorld(t);
  assert.ok(["denied", "no_such_tool"].includes((await w.call("relay.pair.window.open", {}, "cli", A)).error?.code), "a terminal cannot reach it");
  assert.ok((await w.call("relay.pair.window.open", {}, "module:x", A)).error);
  assert.ok((await w.call("relay.pair.window.open", {}, "agent:kit", A)).error);
  const noProof = await w.call("relay.pair.window.open", {}, SCREEN, A2);
  assert.ok(noProof.error, "no proof, no window");
  
  const ok = await w.call("relay.pair.window.open", {}, SCREEN, A);
  assert.ok(ok.data, JSON.stringify(ok.error));
  assert.equal(ok.data.pingEveryMs, 15000);
  assert.ok(ok.data.window && ok.data.ticket && ok.data.closesAt > w.clock.t);
  assert.deepEqual(w.events.map(e => e[0]).filter(t => t.startsWith("pairing-window.")), ["pairing-window.opened", "pairing-window.renewed"]);
});

test("pairing window: a renewal needs the same screen and node, while pinging, within the limits, and leaves one live ticket", async t => {
  const w = await windowWorld(t);
  const open = (await w.call("relay.pair.window.open", {}, SCREEN, A)).data;
  const id = open.window;
  const resolves = async ticket => (await fetch(`${w.url.replace(/^ws/, "http")}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: Buffer.from(await (await import("../core/relay/wire.js")).ticketDerive("loc", fromBase64url(ticket))).toString("base64url") }) })).status;
  // from another node, or another caller: refused
  assert.equal((await w.call("relay.pair.window.renew", { window: id }, SCREEN, B)).error?.code, "denied");
  assert.equal((await w.call("relay.pair.window.renew", { window: id }, "device:bcdefghijklmnopq", A2)).error?.code, "denied");
  assert.equal((await w.call("relay.pair.window.renew", { window: id }, SCREEN, OTHER_SESSION)).error?.code, "denied", "another session on the same node");
  // too soon: refused
  assert.equal((await w.call("relay.pair.window.renew", { window: id }, SCREEN, A2)).error?.code, "rate_limited");
  // after 15 s, with a ping: renews, the old ticket is withdrawn, the new one is live (exactly one live ticket)
  w.clock.t += 16_000;
  await w.call("relay.pair.window.ping", { window: id }, SCREEN, A2);
  const r = await w.call("relay.pair.window.renew", { window: id }, SCREEN, A2);
  assert.ok(r.data?.ticket, JSON.stringify(r.error));
  await new Promise(res => setTimeout(res, 200));
  assert.equal(await resolves(open.ticket), 404, "the previous ticket was withdrawn at the relay");
  assert.equal(await resolves(r.data.ticket), 200, "the new one is live");
  // a second renewal replaces that one
  w.clock.t += 16_000;
  await w.call("relay.pair.window.ping", { window: id }, SCREEN, A2);
  const r2 = await w.call("relay.pair.window.renew", { window: id }, SCREEN, A2);
  assert.ok(r2.data?.ticket);
  await new Promise(res => setTimeout(res, 200));
  assert.equal(await resolves(r2.data.ticket), 200);
  assert.equal(await resolves(r.data.ticket), 404, "two renewals leave exactly one live ticket");
  // the 40 per window limit
  let last = null;
  for (let i = 0; i < 45; i++) { w.clock.t += 16_000; await w.call("relay.pair.window.ping", { window: id }, SCREEN, A2); last = await w.call("relay.pair.window.renew", { window: id }, SCREEN, A2); if (last.error) break; }
  assert.ok(last && last.error, "the renewals run out");
});

test("pairing window: 30 seconds of silence, the 10 minute end, or a close ends it, and a renewal after any of them is refused", async t => {
  const w = await windowWorld(t);
  let id = (await w.call("relay.pair.window.open", {}, SCREEN, A)).data.window;
  w.clock.t += 31_000;
  const silent = await w.call("relay.pair.window.renew", { window: id }, SCREEN, A2);
  assert.equal(silent.error?.code, "denied", "no ping for 30 s: refused");
  assert.ok(w.events.some(e => e[0] === "pairing-window.closed" && e[1].reason === "silence"));
  assert.equal((await w.call("relay.pair.window.renew", { window: id }, SCREEN, A2)).error?.code, "not_found", "and the window is gone");
  id = (await w.call("relay.pair.window.open", {}, SCREEN, A)).data.window;
  for (let i = 0; i < 44; i++) { w.clock.t += 14_000; await w.call("relay.pair.window.ping", { window: id }, SCREEN, A2); }
  assert.equal((await w.call("relay.pair.window.renew", { window: id }, SCREEN, A2)).error?.code, "denied", "past 10 minutes: refused");
  id = (await w.call("relay.pair.window.open", {}, SCREEN, A)).data.window;
  assert.equal((await w.call("relay.pair.window.close", { window: id }, SCREEN, A2)).data.closed, true);
  assert.equal((await w.call("relay.pair.window.renew", { window: id }, SCREEN, A2)).error?.code, "not_found");
  assert.ok(w.events.filter(e => e[0] === "pairing-window.closed").length >= 3, "each ending is an event with its reason");
});

test("pairing window: a phone that redeems a code is enrolled only after the screen confirms it, and the window then closes", async t => {
  const w = await windowWorld(t);
  const open = (await w.call("relay.pair.window.open", {}, SCREEN, A)).data;
  const id = open.window;
  const keyStore = fileKeyStore(path.join(tempHome(t), "phone-key.json"));
  const redeem = pairTicket(fromBase64url(open.ticket), { relay: w.status.url, name: "Sam's phone", crypto: nodeCrypto(), keyStore, timeout: 20_000 });
  let redeemError = null;
  redeem.catch(e => { redeemError = e; });
  const pending = await new Promise((resolve, reject) => { const iv = setInterval(() => { const e = w.events.find(x => x[0] === "pairing.requested"); if (e) { clearInterval(iv); resolve(e[1]); } else if (redeemError) { clearInterval(iv); reject(redeemError); } }, 20); setTimeout(() => reject(new Error("no pairing.requested event")), 8000); });
  assert.match(pending.fingerprint, /^[a-z2-7]{4} [a-z2-7]{4}$/);
  assert.equal(pending.name, "Sam's phone");
  const before = (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices;
  assert.equal(before.length, 0, "nothing is enrolled before the confirm");
  // the wrong device id, another screen: refused
  assert.equal((await w.call("relay.pair.window.confirm", { window: id, device: "nope" }, SCREEN, A2)).error?.code, "not_found");
  assert.equal((await w.call("relay.pair.window.confirm", { window: id, device: pending.device }, SCREEN, B)).error?.code, "denied");
  assert.equal((await w.call("relay.pair.window.confirm", { window: id, device: pending.device }, SCREEN, A2)).data.confirmed, true);
  const paired = await redeem;
  assert.ok(paired.device);
  assert.equal((await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.length, 1);
  assert.ok(w.events.some(e => e[0] === "pairing-window.closed" && e[1].reason === "completed"));
  assert.equal((await w.call("relay.pair.window.renew", { window: id }, SCREEN, A2)).error?.code, "not_found", "a renewal after completion is refused");
});

test("pairing window: a redeem with no confirm does not enrol, and closing the window refuses the waiting phone", async t => {
  const w = await windowWorld(t);
  const open = (await w.call("relay.pair.window.open", {}, SCREEN, A)).data;
  const keyStore = fileKeyStore(path.join(tempHome(t), "phone-key.json"));
  const redeem = pairTicket(fromBase64url(open.ticket), { relay: w.status.url, name: "Sam's phone", crypto: nodeCrypto(), keyStore, timeout: 20_000 });
  const assertRefused = assert.rejects(redeem);
  await new Promise(res => setTimeout(res, 500));
  assert.equal((await w.call("relay.pair.window.close", { window: open.window }, SCREEN, A2)).data.closed, true);
  await assertRefused;
  assert.equal((await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.length, 0, "no confirm, no device");
});

test("pairing window: it closes at once when its person session signs out, and opening needs a person session", async t => {
  const w = await windowWorld(t);
  assert.equal((await w.call("relay.pair.window.open", {}, SCREEN, { proof: A.proof, peer: A.peer })).error?.code, "person_session_required", "no person session, no window");
  const id = (await w.call("relay.pair.window.open", {}, SCREEN, A)).data.window;
  w.d.events.emit("presence", "presence.signed-out", { id: "ps2" });
  assert.equal((await w.call("relay.pair.window.ping", { window: id }, SCREEN, A2)).data.closesInMs > 0, true, "another session signing out leaves it open");
  w.d.events.emit("presence", "presence.signed-out", { id: "ps1" });
  assert.equal((await w.call("relay.pair.window.ping", { window: id }, SCREEN, A2)).error?.code, "not_found", "its own session signing out closes it");
  for (let i = 0; i < 50 && !w.events.some(e => e[0] === "pairing-window.closed"); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(w.events.some(e => e[0] === "pairing-window.closed" && e[1].reason === "session ended"));
});

test("pairing window: 'Not you?' frees the pending slot at once, the window stays open, and each phone's own screen gets the same fingerprint the box shows", async t => {
  const w = await windowWorld(t);
  const open = (await w.call("relay.pair.window.open", {}, SCREEN, A)).data;
  const id = open.window;
  const waitFor = (n) => new Promise((resolve, reject) => { const iv = setInterval(() => { const es = w.events.filter(x => x[0] === "pairing.requested"); if (es.length >= n) { clearInterval(iv); resolve(es[n - 1][1]); } }, 20); setTimeout(() => { clearInterval(iv); reject(new Error("no pairing.requested event")); }, 8000); });
  // a stranger's phone redeems first and sits in the one pending slot
  let junkFp = null;
  const junkStore = fileKeyStore(path.join(tempHome(t), "junk-key.json"));
  const junk = pairTicket(fromBase64url(open.ticket), { relay: w.status.url, name: "Stranger", crypto: nodeCrypto(), keyStore: junkStore, timeout: 20_000, onFingerprint: fp => { junkFp = fp; } });
  const junkRefused = assert.rejects(junk);
  const first = await waitFor(1);
  assert.equal(junkFp, first.fingerprint, "the phone's own screen shows the fingerprint the box shows");
  // one key, three readings: the callback, the box's pairing.requested event, and the client's own fingerprint of the key it holds
  assert.equal(await keyFingerprint((await junkStore.get()).publicKey, nodeCrypto()), first.fingerprint, "the same key gives the same fingerprint on both ends");
  // one key, three readings: the callback, the box's event, and the client's own fingerprint of the key it holds
  assert.equal((await w.call("relay.pair.window.reject", { window: id, device: "nope" }, SCREEN, A2)).error?.code, "not_found");
  assert.equal((await w.call("relay.pair.window.reject", { window: id, device: first.device }, SCREEN, B)).error?.code, "denied", "only the screen that opened the window");
  assert.equal((await w.call("relay.pair.window.reject", { window: id, device: first.device }, SCREEN, A2)).data.rejected, true);
  await junkRefused;
  assert.ok(w.events.some(e => e[0] === "pairing.rejected" && e[1].device === first.device));
  assert.equal((await w.call("relay.pair.window.ping", { window: id }, SCREEN, A2)).data.closesInMs > 0, true, "the window is still open");
  // the real phone gets a fresh code and takes the free slot
  w.clock.t += 16_000;
  const r = await w.call("relay.pair.window.renew", { window: id }, SCREEN, A2);
  assert.ok(r.data?.ticket, JSON.stringify(r.error));
  let realFp = null;
  const real = pairTicket(fromBase64url(r.data.ticket), { relay: w.status.url, name: "Sam's phone", crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(tempHome(t), "real-key.json")), timeout: 20_000, onFingerprint: fp => { realFp = fp; } });
  const second = await waitFor(2);
  assert.equal(realFp, second.fingerprint);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal((await w.call("relay.pair.window.confirm", { window: id, device: second.device }, SCREEN, A2)).data.confirmed, true);
  assert.ok((await real).device);
  assert.equal((await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.length, 1, "only the real phone is enrolled");
});
