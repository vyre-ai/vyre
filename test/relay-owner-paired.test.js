// @ts-check
// Which pairing paths leave the owner's device as the OWNER's (the relay's `owner_paired` fact, written only where his own present act paired it) and which do not (an ungated ticket a module minted). A real vyred and the Node
// relay. For each path: the relay's device info, the facts the daemon would build for that device (callerFacts: owner facts only for the owner's device), and the event bus (the whole stream for the owner's device, the
// cut stream for the other). Run on a test box, never on a person's Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { start, callerFacts } from "../core/daemon/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { parsePairUrl } from "../core/relay/pairing.js";
import { pairTicket, pairOffer } from "../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../relay/client/nodecrypto.js";
import { fromBase64url } from "../relay/client/bytes.js";
import { tempHome } from "./helpers.js";
import { macCore } from "./fake-core-keys.js";

const lenient = {
  required: (/** @type {string} */ tool, /** @type {any} */ def, /** @type {any} */ input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async (/** @type {any} */ { proof }) => (proof ? { ok: true, method: proof.method === "device" ? "device" : "passkey", keyId: proof.key || proof.cred || "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }), summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]), enroll(/** @type {any} */ k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const PROOF = { proof: { method: "passkey", id: "x" } };
process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

async function world(/** @type {any} */ t) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore(), kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const keys = () => fileKeyStore(path.join(tempHome(t), `k-${Math.random().toString(36).slice(2)}.json`));
  return { d, url, keys };
}
const info = async (/** @type {any} */ d, /** @type {string} */ id) => (await d.registry.call("relay.device.info", { id }, "module:vyred")).data;
/** What the daemon builds for a relayed app device: owner facts or none. */
const factsFor = async (/** @type {any} */ d, /** @type {string} */ id) => {
  const row = await info(d, id);
  return callerFacts(`device:${id}`, { caller: `device:${id}` }, {}, d.kernel, false, { ...row, person: null, homeOwner: false });
};
const stream = (/** @type {any} */ d, /** @type {string} */ id) => new Promise(resolve => {
  const srv = http.createServer((req, res) => d.registry.deps.handler({})(req, res, `device:${id}`, { kind: "device", stableId: id }));
  srv.listen(0, "127.0.0.1", () => {
    let body = "", status = -1;
    const r = http.request({ port: /** @type {any} */ (srv.address()).port, host: "127.0.0.1", path: "/v1/events/stream?since=0", method: "GET" }, res => { status = res.statusCode || 0; res.on("data", c => { body += c; }); });
    r.on("error", () => {}); r.end();
    setTimeout(() => { r.destroy(); srv.close(); resolve({ status, body }); }, 1500);
  });
});
const check = async (/** @type {any} */ w, /** @type {string} */ id, /** @type {boolean} */ owner, /** @type {string} */ path) => {
  assert.equal((await info(w.d, id)).ownerPaired, owner, `${path}: the relay says the owner's present act paired it: ${owner}`);
  assert.equal(Boolean(await factsFor(w.d, id)), owner, `${path}: the daemon builds owner facts for it: ${owner}`);
  await w.d.registry.call("planner.add", { kind: "note", title: `SECRET-${path}`, body: "x" }, "cli", { token: (await w.d.kernel.surfaces.open(w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: w.d.kernel.id.owner, path: "direct", session: "s" }), {})).token });
  const s = await stream(w.d, id);
  assert.equal(s.status, 200, `${path}: the stream opens`);
  assert.equal(s.body.includes(`SECRET-${path}`), owner, `${path}: the whole stream for the owner's device, the cut stream for the other`);
};

test("pairing paths: the first device, a confirmed window and a gated ring leave the owner's device the owner's; the classic QR (a bearer ticket: any holder redeems it) and an ungated ticket a module minted do not", { timeout: 150_000 }, async t => {
  const w = await world(t);
  // the first device (onboarding: nobody is on the box yet) and the classic QR, which is a bearer ticket: redeeming it confirms nothing about which device holds it, so it names no owner
  const first = await pairOffer(/** @type {any} */ (parsePairUrl((await w.d.registry.call("relay.pair.first", {}, "onboard", PROOF)).data.url)), { crypto: nodeCrypto(), keyStore: w.keys() });
  await check(w, first.device, true, "first");
  const start1 = await pairOffer(/** @type {any} */ (parsePairUrl((await w.d.registry.call("relay.pair.start", {}, "cli", PROOF)).data.url)), { crypto: nodeCrypto(), keyStore: w.keys() });
  await check(w, start1.device, false, "start");
  // the window: the redeemer is enrolled only after the screen confirms this exact phone
  const SCREEN = "device:abcdefghijklmnop", A = { proof: { method: "passkey", id: "x" }, peer: { stableId: "nodeA", node: "a" }, person: { id: "ps1" } };
  const events = []; w.d.events.on("pairing.*", (/** @type {any} */ e) => events.push([e.type, e.payload]));
  const open = (await w.d.registry.call("relay.pair.window.open", {}, SCREEN, A)).data;
  const redeem = pairTicket(fromBase64url(open.ticket), { relay: (await w.d.registry.call("relay.status", {}, "cli", PROOF)).data.url, name: "Sam's phone", crypto: nodeCrypto(), keyStore: w.keys(), timeout: 20_000 });
  const pending = await new Promise(res => { const iv = setInterval(() => { const e = events.find(x => x[0] === "pairing.requested"); if (e) { clearInterval(iv); res(e[1]); } }, 100); });
  assert.equal((await w.d.registry.call("relay.pair.window.confirm", { window: open.window, device: /** @type {any} */ (pending).device }, SCREEN, { ...A, proof: undefined })).data.confirmed, true);
  await check(w, (await redeem).device, true, "window");
  // an ungated ticket a module minted: nobody was present for it
  const minted = (await w.d.registry.call("relay.ticket.mint", {}, "module:wink")).data;
  const viaModule = await pairTicket(fromBase64url(minted.ticket), { relay: (await w.d.registry.call("relay.status", {}, "cli", PROOF)).data.url, name: "Handed-out phone", crypto: nodeCrypto(), keyStore: w.keys(), timeout: 20_000 });
  await check(w, viaModule.device, false, "module");
});

test("marking: a device that came in by a bearer code is the owner's only after the owner marks it, with presence; nobody else can mark", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const bearer = await pairOffer(/** @type {any} */ (parsePairUrl((await w.d.registry.call("relay.pair.start", {}, "cli", PROOF)).data.url)), { crypto: nodeCrypto(), keyStore: w.keys() });
  await check(w, bearer.device, false, "bearer");
  const tokenFor = async (/** @type {string} */ person) => (await w.d.kernel.surfaces.open(w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person, path: "direct", session: "s" }), {})).token;
  const mark = (/** @type {any} */ meta, /** @type {string} */ id = bearer.device) => w.d.registry.call("relay.devices.mark", { id }, "cli", meta);
  // the card the owner approves names the device, its kind, the day it paired and how the box holds it
  const card = await w.d.registry.tools.get("relay.devices.mark").presence.summary({ id: bearer.device });
  assert.match(card, /paired on \d{4}-\d{2}-\d{2}/); assert.match(card, /a (phone|computer|phone or computer) paired/); assert.match(card, /cannot tell whose it is/); assert.match(card, /Only mark a device you recognise/);
  assert.match(await w.d.registry.tools.get("relay.devices.mark").presence.summary({ id: "zzzzzzzzzzzzzzzz" }), /Mark device zzzzzzzzzzzzzzzz/);
  // no person chain at all, and no presence: refused, nothing marked
  assert.ok((await mark({})).error, "no presence, no mark");
  const noChain = await mark(PROOF);
  assert.ok(noChain.error && /owner/.test(noChain.error.message), `a call with no owner chain is refused: ${JSON.stringify(noChain)}`);
  assert.equal((await info(w.d, bearer.device)).ownerPaired, false);
  // a member's chain (a person who is not the owner) is refused
  let memberToken = null; try { memberToken = await tokenFor("per_" + "m".repeat(26)); } catch { memberToken = null; }
  if (memberToken) { const r = await mark({ ...PROOF, token: memberToken }); assert.ok(r.error, "a member cannot mark"); assert.equal((await info(w.d, bearer.device)).ownerPaired, false); }
  // the owner, with presence, marks a device that exists; an id that does not exist is refused with a next step
  assert.ok((await mark({ ...PROOF, token: await tokenFor(w.d.kernel.id.owner) }, "zzzzzzzzzzzzzzzz")).error, "an unknown device");
  const ok = await mark({ ...PROOF, token: await tokenFor(w.d.kernel.id.owner) });
  assert.ok(!ok.error, JSON.stringify(ok.error));
  await check(w, bearer.device, true, "marked");
});

test("a home with a member: the owner's own device reaches the owner's vault, a device that redeemed a bearer code does not", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const K = w.d.kernel;
  const first = await pairOffer(/** @type {any} */ (parsePairUrl((await w.d.registry.call("relay.pair.first", {}, "onboard", PROOF)).data.url)), { crypto: nodeCrypto(), keyStore: w.keys() });
  const bearer = await pairOffer(/** @type {any} */ (parsePairUrl((await w.d.registry.call("relay.pair.start", {}, "cli", PROOF)).data.url)), { crypto: nodeCrypto(), keyStore: w.keys() });
  // somebody besides the owner is in the home: the vault now keeps a stranger out (with the owner alone it has nobody to keep out and answers anyone)
  const oc = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: K.id.owner, path: "direct", session: "s" });
  await K.gateway.grants.setRole(oc, { person: "per_" + "c".repeat(26), role: "member" }, { presence: { op: "stand-in", fields: {}, n: Math.random() } });
  const vaultList = (/** @type {string} */ id) => new Promise(resolve => {
    const srv = http.createServer((req, res) => w.d.registry.deps.handler({})(req, res, `device:${id}`, { kind: "device", stableId: id }));
    srv.listen(0, "127.0.0.1", () => {
      const rq = http.request({ port: /** @type {any} */ (srv.address()).port, host: "127.0.0.1", path: "/v1/tools/vault.list", method: "POST", headers: { "content-type": "application/json" } }, x => { x.resume(); x.on("end", () => { srv.close(); resolve(x.statusCode); }); });
      rq.end("{}");
    });
  });
  assert.equal(await vaultList(first.device), 200, "the owner's first device");
  assert.equal(await vaultList(bearer.device), 403, "a device that redeemed the classic code is not the owner's");
});
