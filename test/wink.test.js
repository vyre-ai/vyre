// @ts-check
// Wink pairing as grants (core/wink): a typed code, two-sided, ends in one grant and a few events; an invitation becomes a membership;
// sharing a computer is a node.host grant; removal takes the grant and the device with it. A real vyred, the Node relay, a real typing
// device (relay/client/join.js). 127.0.0.1 only. Run on a runner or the test server (daemon tests never run on the person's Mac).

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
// This file has 46 cases of 5 to 25 s each, which ran past the 300 s per-file limit. The cases are dealt out to 7 files (wink.test.js and its -b.. siblings, which set VYRE_WINK_SHARD and import this module), each well inside the per-file limit even on a loaded machine.
const SHARDS = 6;
const SHARD_NAME = String(process.env.VYRE_WINK_SHARD ?? "0"), SHARD = Number(SHARD_NAME);
let dealt = 0;
// The camera reader's case takes about three minutes whatever the machine (the phone's join waits out a window after the typed-back code), so it runs alone, in wink-g.test.js ("slow"); the rest are dealt out.
const SLOW = /the camera reader/;
const shardTest = (/** @type {any[]} */ ...a) => (SLOW.test(String(a[0])) ? SHARD_NAME === "slow" : dealt++ % SHARDS === SHARD) ? /** @type {any} */ (test)(...a) : undefined;
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { start } from "../core/daemon/index.js";
import { seams } from "../core/relay/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { pairTicket, resolveTicket, connect, openChannel, deviceKey as clientDeviceKey } from "../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../relay/client/nodecrypto.js";
import { fromBase64url } from "../relay/client/bytes.js";
import { tempHome } from "./helpers.js";
import { allowLoopbackForTests } from "../lib/http.js";
allowLoopbackForTests();   // this file runs its relay on loopback
import { macCore } from "./fake-core-keys.js";
import { card, removal, FORBIDDEN } from "../core/wink/cards.js";
import { peerDoor, composeWinkHome } from "../core/wink/index.js";
import { parseServerQr } from "../core/wink/pairing.js";
import { nonceCommit, ticketTag, newNonce } from "../relay/client/pairwords.js";
import { pairServer } from "../relay/client/serverpair.js";
import workerDir, * as WD from "../names/worker/index.js";
import { createRuntime } from "../relay/worker/fake-cf.js";
import { fakeDns } from "../names/worker/fake-dns.js";
import { memorySeen, idDirectory } from "../lib/identity/directory.js";
import { fileIdentityStore } from "../core/spaces/identity.js";
import { createIdentityOps } from "../core/spaces/identity-ops.js";
import { hooks as spacesHooks } from "../core/spaces/index.js";

// The short typed code is off in a release build; these tests exercise it, so they turn the development flag on (the daemon reads it at call time).
process.env.VYRE_WINK_TYPED_CODE = "1";
// A ring ticket is gated once the Wink module is up (X-1); the shared test helpers switch that off for tests of the relay's own pairing, and this file is the one that tests it.
delete process.env.VYRE_TEST_UNGATED_RING;
// The older tests pair with the three words alone; owning a server needs the identity proof in a real build (the proof tests below turn this off).
process.env.VYRE_TEST_PAIR_NO_PROOF = "1";

/** Takes any presence proof: refusals below are about who calls and what the module decides. */
const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: proof.key || "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
  covered: () => false,
  coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]),
  enroll(k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const PROOF = { proof: { method: "passkey", id: "x" } };
const SCREEN = "device:abcdefghijklmnop";
const A = { ...PROOF, peer: { stableId: "nodeA", node: "a" }, person: { id: "ps1" } };

async function world(t, opt = {}) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const logs = [];
  const root = tempHome(t);
  if (opt.seam) { seams.set(root, { ...(seams.get(root) || {}), ...opt.seam }); t.after(() => seams.delete(root)); }
  if (opt.pendingMs || opt.abandonMs) { seams.set(root, { ...(opt.pendingMs ? { pendingMs: opt.pendingMs } : {}), ...(opt.abandonMs ? { abandonMs: opt.abandonMs } : {}) }); t.after(() => seams.delete(root)); }
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: true, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ ...(opt.realPresence ? {} : { presence: lenient }), root, log: m => { logs.push(String(m)); if (process.env.WLOG) console.error(m); }, coreKeys: macCore(), kernelPresence: { check: async () => null }, ...(opt.kernel ? { kernel: true } : {}) });
  t.after(() => d.stop());
  const events = [];
  d.events.on("*", e => events.push([e.type, e.payload]));
  // With the kernel on, the owner's device is the facts the listener proves (a paired app row and a person session), never the label SCREEN stands for.
  let screenRow = false; // the screen's own paired row is made the first time it calls, so a test that never uses it sees none
  const screenFacts = { kind: "device", device_key_id: SCREEN.slice(7), person: d.kernel.id.owner, path: "relay", session: "ps1" };
  const call = (tool, input = {}, caller = SCREEN, meta = A) => (caller === SCREEN && meta && meta.person && !screenRow && (screenRow = true, d.registry.deps.db.prepare("INSERT OR IGNORE INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'screen', 'p', 1, 'app', 0, NULL)").run(SCREEN.slice(7)), true), d.registry.call(tool, input, caller, caller === SCREEN && meta && meta.person && !meta.kernelFacts ? { ...meta, kernelFacts: screenFacts, kernel_proof: { op: "stand-in", fields: {}, n: 1 } } : meta));
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  return { d, url, root, events, call, status, logs };
}
const until = async (f, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 25)); } };
const keystore = t => fileKeyStore(path.join(tempHome(t), "k.json"));

shardTest("wink: an invitation is sealed into a ticket; the invited person's redemption writes a membership grant", async t => {
  const w = await world(t);
  const inv = await w.call("wink.invite", { role: "member", projects: ["intake"], days: 2 });
  assert.ok(inv.data?.ticket, JSON.stringify(inv.error));
  const ticket = fromBase64url(inv.data.ticket);
  // A lookup uses a ticket up on the relay, so the card is read from a twin invitation and the first one is redeemed.
  const twin = await w.call("wink.invite", { role: "member", projects: ["intake"], days: 2 });
  const looked = await resolveTicket(fromBase64url(twin.data.ticket), { relay: w.status.url, crypto: nodeCrypto() });
  assert.equal(looked.invite.kind, "invite", "the card's offer is read from the sealed record");
  assert.equal(looked.invite.role, "member");
  assert.deepEqual(looked.invite.projects, ["intake"]);
  const paired = await pairTicket(ticket, { relay: w.status.url, name: "Chris's laptop", crypto: nodeCrypto(), keyStore: keystore(t) });
  assert.equal(paired.device, undefined, "no device is enrolled by an invitation");
  // the kernel keeps the grant a moment after the redemption (the admission runs on the relay's event), so the screen's list is read when it has it
  const grants = await until(async () => { const l = (await w.call("wink.access")).data.grants; return l.length ? l : null; });
  assert.equal(grants.length, 1);
  assert.equal(grants[0].source, "wink:W5");
  assert.equal(grants[0].subject.actor.kind, "person");
  await until(() => w.events.some(e => e[0] === "wink.joined" && e[1].role === "member"));
  assert.equal((await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.filter(d => d.id !== SCREEN.slice(7)).length, 0, "no device row for the invitee (the screen's own row is this test world's)");
  // the invitation is single use
  await assert.rejects(() => pairTicket(ticket, { relay: w.status.url, crypto: nodeCrypto(), keyStore: keystore(t) }), /expired or was already used/);
});

shardTest("wink: a sensitive role waits for the admin's approval, and decline adds nothing", async t => {
  const w = await world(t);
  const inv = await w.call("wink.invite", { role: "admin" });
  const ticket = fromBase64url(inv.data.ticket);
  await pairTicket(ticket, { relay: w.status.url, name: "Chris's laptop", crypto: nodeCrypto(), keyStore: keystore(t) });
  assert.equal((await w.call("wink.access")).data.grants.length, 0, "no grant yet");
  const pending = (await w.call("wink.offers")).data.offers.find(o => o.state === "pending");
  assert.ok(pending, "the offer waits for the admin");
  assert.match(pending.receiver.fingerprint, /^[a-z2-7]{4} [a-z2-7]{4}$/, "with the invitee's fingerprint words");
  const ok = await w.call("wink.approve", { offer: pending.id });
  assert.ok(ok.data?.grant, JSON.stringify(ok.error));
  assert.equal((await w.call("wink.access")).data.grants.length, 1);
  const inv2 = await w.call("wink.invite", { role: "admin" });
  await pairTicket(fromBase64url(inv2.data.ticket), { relay: w.status.url, name: "Eve's laptop", crypto: nodeCrypto(), keyStore: keystore(t) });
  const p2 = (await w.call("wink.offers")).data.offers.find(o => o.state === "pending");
  assert.equal((await w.call("wink.decline", { offer: p2.id })).data.declined, true);
  assert.equal((await w.call("wink.access")).data.grants.length, 1, "still only the approved one");
  assert.equal((await w.call("wink.invite", { role: "owner" })).error?.code, "bad_input");
});

const relayHas = async (w, id) => (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.some(d => d.id === id);

shardTest("wink cards: every card and prompt is in the words of wink-copy.md and never names a network, a key or a ticket", () => {
  const kinds = ["phone", "computer", "server", "invite", "lend", "share"];
  for (const kind of kinds) {
    const c = card({ kind: /** @type {any} */ (kind), receiver: { name: "Alex's iPhone", fingerprint: "7KQM 4P2X", os: "mac" }, approver: { name: "your phone", fingerprint: "9f8e 7d6c" }, space: kind === "invite" || kind === "lend" ? "Harlow Legal" : "Personal", inviter: { name: "Chris", fingerprint: "ab12 cd34" }, server: "harlow-home", quota: "4 GB, 2 sessions at a time" });
    for (const v of [c.title, c.goesInto, c.allows, c.forHowLong, c.primary, c.secondary, c.who, c.from || ""]) assert.doesNotMatch(v, FORBIDDEN, `${kind}: "${v}"`);
    assert.match(c.goesInto, /^Goes into: /, `${kind} says which space it goes into`);
    assert.doesNotMatch(c.primary, /^Allow$/, "a button names the action");
    assert.ok(c.who.includes("7KQM 4P2X"), "the fingerprint is beside the name");
  }
  assert.equal(card({ kind: "phone", receiver: { name: "Alex's iPhone", fingerprint: "7KQM 4P2X" } }).primary, "Add with Face ID");
  assert.equal(card({ kind: "invite", receiver: { name: "Sam" }, space: "Harlow Legal", inviter: { name: "Chris" } }).primary, "Join Harlow Legal");
  assert.equal(card({ kind: "lend", receiver: {}, space: "Harlow Legal", server: "harlow-home" }).primary, "Use harlow-home");
  assert.equal(card({ kind: "share", receiver: {} }).open, true, "the share card is marked for app-design's words");
  for (const what of ["device", "member", "leave", "lent", "share"]) {
    const p = removal({ what: /** @type {any} */ (what), name: "Alex's iPad", member: "Sam", space: "Harlow Legal", count: 3 });
    assert.doesNotMatch(p.prompt, FORBIDDEN);
    assert.equal(p.hold, true);
    assert.doesNotMatch(p.prompt, /unreadable/);
  }
});

shardTest("peerDoor: allow answers from the wink module's registry and accept is the host's own relay door, ready for the relay bridge", () => {
  const accepted = [];
  const door = peerDoor({ wink: { peers: { allow: d => d === "srv1" } }, host: { acceptRelay: space => (s, who) => accepted.push([space, who]) }, space: "harlow" });
  assert.equal(door.space, "harlow");
  assert.equal(door.allow("srv1"), true);
  assert.equal(door.allow("x"), false);
  door.accept({}, { deviceId: "srv1" });
  assert.deepEqual(accepted, [["harlow", { deviceId: "srv1" }]]);
});

shardTest("H-1, real daemon: wink.server.handover answers no module but wink, no device and no empty caller (reviewer-3 probe: module:evil got home, authKey and peerSecret)", async t => {
  const w = await world(t);
  for (const caller of ["module:evil", "module:platform", "module:relay", "device:abcdefghijklmnop", "cli", "deck", "tailnet:owner", "anonymous"]) {
    const r = await w.d.registry.call("wink.server.handover", {}, caller, PROOF);
    assert.ok(r.error, `refused for ${caller}`);
    assert.equal(r.data?.handover, undefined, "no secret in the answer");
  }
  const own = await w.d.registry.call("wink.server.handover", {}, "module:wink", {});
  assert.deepEqual(own.data, { handover: null }, "the Wink module itself is answered (nothing handed over yet)");
});

shardTest("composeWinkHome: sets ctx.peerDoor, builds the serve wrapper with the host's pathOf, hands the held connections to Wink, and gives the app side its handover seam", async () => {
  const accepted = [], served = [], hosted = [];
  const wink = { peers: { allow: d => d === "srv1" }, holds: { onSession: (c, s) => accepted.push([c, s]) }, ownHandover: () => ({ home: "100.64.0.1:8443", authKey: "KEY", peerSecret: "SECRET" }) };
  const host = { acceptRelay: space => (s, who) => accepted.push([space, who]), pathOf: c => (c === "device:wink1" ? "wink" : "relay"), serveHome: async (space, o) => { hosted.push([space, o]); } };
  const wrapped = [];
  const kernel = { serverFor: () => null, personOf: () => "per_x", withKernelCall: (next, o) => { wrapped.push(o); return (c, t, i) => next(c, t, i); } };
  const registryServe = async (c, t, i) => { served.push([c, t]); return "ok"; };
  const ctx = {};
  const identity = { entry: async () => null };
  const w = composeWinkHome({ ctx, host, kernel, wink, space: "harlow", serve: registryServe, identity, handoverSource: async q => ({ home: "h", controlUrl: "http://c", device: q.device }) });
  // the relay module's door
  const door = ctx.peerDoor();
  assert.equal(door.space, "harlow");
  assert.equal(door.allow("srv1"), true);
  assert.equal(door.allow("x"), false);
  door.accept({}, { deviceId: "srv1" });
  assert.deepEqual(accepted.pop(), ["harlow", { deviceId: "srv1" }]);
  // the kernel wrapper got the host's own path report
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].pathOf("device:wink1"), "wink");
  assert.equal(wrapped[0].pathOf("device:relay1"), "relay");
  assert.equal(w.pathOf("device:wink1"), "wink");
  assert.equal(await w.serve("device:a", "about.text", {}), "ok");
  // serveHome passes the identity port, the serve wrapper for both doors and the holds hook
  await w.serveHome();
  assert.equal(hosted.length, 1);
  assert.equal(hosted[0][0], "harlow");
  assert.equal(hosted[0][1].identity, identity);
  assert.equal(typeof hosted[0][1].serve, "function");
  assert.equal(typeof hosted[0][1].relayServe, "function");
  hosted[0][1].onSession("device:srv2", { session: 1 });
  assert.deepEqual(accepted.pop(), ["device:srv2", { session: 1 }]);
  // the app side's seam and the server's own hand-over (in-process, never a tool)
  assert.deepEqual(await w.handover({ target: { kind: "space", id: "harlow" }, device: "srv_a" }), { home: "h", controlUrl: "http://c", device: "srv_a" });
  assert.equal(w.own().authKey, "KEY");
  const none = composeWinkHome({ host, wink, space: "harlow" });
  assert.equal(await none.handover({ target: { kind: "identity", id: "p" }, device: "d" }), null, "with no source the pairing hands over only the device id");
  await assert.rejects(() => none.serveHome(), e => e.code === "bad_input");
  assert.throws(() => composeWinkHome({ host, space: "harlow" }), /wink module/);
  w.stop();
  assert.equal(ctx.peerDoor, undefined);
});

// ---- X-1 (ruling, 4 Oct 2026): nothing exists for a redeemer until the confirm ----

/** A call over a redeemer's own channel to the box, as the relay hands it: { status, body } (status 0 when it never answered). */
async function over(c, tool, input = {}) {
  try {
    const r = await Promise.race([c.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }), new Promise((_, rej) => setTimeout(() => rej(new Error("no answer")), 5000))]);
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, body: null, error: String(/** @type {any} */ (e).message) }; }
}
/** A redeemer: it redeems a ticket from its own key file, offering a presence key, and can open its own channel to the box afterwards. */
async function redeem(t, w, seed, name = "Redeemer", extra = {}) {
  const ks = keystore(t);
  const presenceKey = { public_key: crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 };
  const paired = await pairTicket(seed, { relay: w.status.url, name, crypto: nodeCrypto(), keyStore: ks, presenceKey, ...extra });
  const open = () => { const c = connect({ relay: w.status.url, route: paired.route, box: paired.box, name, crypto: nodeCrypto(), keyStore: ks }); t.after(() => c.close()); return c; };
  return { paired, ks, open };
}
const deviceRow = async (w, id) => (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.find(d => d.id === id);
shardTest("BR-2 over the relay: a browser's channel is web:<id> (it may ask to be trusted, about itself), an app's is device:<id> (it may not), an unknown id gets no channel, and none reaches vault.session.status", async t => {
  process.env.VYRE_TEST_UNGATED_RING = "1";
  t.after(() => { delete process.env.VYRE_TEST_UNGATED_RING; });
  const w = await world(t);
  const via = async about => {
    const ks = keystore(t);
    const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
    const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: about.kind === "web" ? "A browser" : "A phone", crypto: nodeCrypto(), keyStore: ks, about });
    assert.ok(paired.device && !paired.pending, JSON.stringify(paired));
    const c = connect({ relay: w.status.url, route: paired.route, box: paired.box, name: "x", crypto: nodeCrypto(), keyStore: ks });
    t.after(() => c.close());
    return { c, id: paired.device, paired };
  };
  const browser = await via({ kind: "web", release: "0.3.0" });
  const asked = await over(browser.c, "relay.devices.ask-trust", {});
  assert.equal(asked.status, 200, JSON.stringify(asked));
  assert.equal(asked.body.data.asked, true, "web:<id> is a browser asking about itself");
  const phone = await via({ kind: "app" });
  const refused = await over(phone.c, "relay.devices.ask-trust", {});
  assert.notEqual(refused.status, 200, "device:<id> is not a browser");
  const asBrowser = await over(browser.c, "vault.session.status", {});
  assert.equal(asBrowser.body?.error?.code, "no_such_tool", `a browser: ${JSON.stringify(asBrowser)}`);
  // (a confirmed app device is `device:<id>`, the class the platform's PH-1 and the kernel gates decide for; that layer is not this test's)
  // an id the home never paired has no channel at all
  const stranger = connect({ relay: w.status.url, route: browser.paired.route, box: browser.paired.box, name: "z", crypto: nodeCrypto(), keyStore: keystore(t) });
  t.after(() => stranger.close());
  const none = await over(stranger, "vault.session.status", {});
  assert.ok(none.status === 0 || none.status === 404 || none.status === 401, `an unknown id reaches nothing (${none.status})`);
});

shardTest("X-1, real daemon and relay: a server's scanner nobody answers leaves nothing behind when the time runs out, and the ticket is spent", async t => {
  const w = await world(t, { pendingMs: 1500 });
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const scan = parseServerQr(made.qr);
  const r = await redeem(t, w, scan.seed, "Eve's app");
  assert.equal(r.paired.pending, true);
  await until(async () => (await over(r.open(), "wink.server.adopt", {})).status !== 200, 8000);
  assert.equal(await relayHas(w, r.paired.device), false);
  assert.equal(await deviceRow(w, r.paired.device), undefined);
  await assert.rejects(() => pairTicket(scan.seed, { relay: w.status.url, name: "again", crypto: nodeCrypto(), keyStore: keystore(t) }), /expired or was already used/);
  // a scanner who says no at the console ends the same way
  const made2 = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const scan2 = parseServerQr(made2.qr);
  const r2 = await redeem(t, w, scan2.seed, "Sam's app");
  const me = (await w.call("wink.pair.targets", {})).data.targets[0];
  const na = newNonce();
  const base = { owner: { kind: "identity", id: me.id }, identity: me.id, pairing: { commit: await nonceCommit(na), tag: await ticketTag(Buffer.from(scan2.seed).toString("base64url")) } };
  const c2 = r2.open();
  assert.equal((await over(c2, "wink.server.adopt", base)).status, 200);
  assert.equal((await over(c2, "wink.server.adopt", { ...base, pairing: { ...base.pairing, reveal: na } })).body.data.pending, true);
  assert.equal((await w.call("wink.server.pair.answer", { yes: false }, "cli", PROOF)).data.yes, false);
  assert.equal(await relayHas(w, r2.paired.device), false);
  await until(async () => (await over(r2.open(), "wink.server.adopt", {})).status !== 200, 8000);
  assert.equal(await deviceRow(w, r2.paired.device), undefined);
});




// ---- device-first pairing leaves the device usable (wink-2, 4 Oct): session, peer, kernel ----


/** The names directory stand-in (the real Worker on the fake runtime) and a device that really claimed `alex` there: the identity a server's owner proof is checked against. */
async function standinIdentity(t) {
  const dns = fakeDns();
  const clock = { t: Date.UTC(2026, 9, 4, 12, 0, 0) };
  const rt = createRuntime({ worker: workerDir, Class: WD.Directory, classes: { DIRECTORY: WD.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", RESOLVE_TXT: async () => [] } });
  let n = 0;
  const state = { down: false };
  const fetchDir = async (url, init) => { if (state.down) throw new Error("unreachable"); return workerDir.fetch(new Request(url, { ...init, headers: { ...(init.headers || {}), "cf-connecting-ip": `198.51.${(n >> 8) & 255}.${n++ & 255}` } }), rt.env); };
  const seen = memorySeen();
  const store = fileIdentityStore(path.join(tempHome(t), "spaces"));
  const idDir = idDirectory({ base: "http://127.0.0.1:1", fetch: fetchDir, now: () => clock.t, seen });
  const ops = createIdentityOps({ store, dir: idDir, seen, now: () => clock.t, emit() {}, stretch: { memoryKiB: 64, passes: 1 } });
  await ops.create({ name: "alex", password: "four plain words here", deviceLabel: "Alex's phone", code: (await idDir.reserve("alex")).code });
  spacesHooks.fetch = /** @type {any} */ (fetchDir);
  spacesHooks.now = () => clock.t;
  t.after(async () => { spacesHooks.fetch = null; spacesHooks.now = null; await rt.settle(); });
  return { id: store.status().id, state, store, ops: () => store.ops(), clock,
    sign: async m => ({ eid: store.status().eid, sig: Buffer.from(await store.sign(Buffer.from(m))).toString("base64url") }) };
}

/** A box-less device pairs a fresh server and picks the words; resolves what the device then holds. */
async function pairFreshServer(t, { kind = "phone", about, presenceStorage = "hardware", ident = null, devKey = null, realPresence = false } = {}) {
  ident = ident || await standinIdentity(t);
  // the real rule: a server is owned only with the identity proof, checked against the directory
  const noProof = process.env.VYRE_TEST_PAIR_NO_PROOF;
  delete process.env.VYRE_TEST_PAIR_NO_PROOF;
  t.after(() => { if (noProof !== undefined) process.env.VYRE_TEST_PAIR_NO_PROOF = noProof; });
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const w = await world(t, { kernel: true, realPresence });
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ks = keystore(t);
  const presenceKey = devKey ? devKey.presenceKey : { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: presenceStorage, ...(presenceStorage === "hardware" ? { signer: "secure_enclave" } : {}) };
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const owner = { id: ident.id, name: "Alex", vyre: "alex" };
  let shown = "";
  const pairing = pairServer({ payload: made.qr, owner, signIdentity: ident.sign, deviceKind: kind, keyStorage: presenceStorage, ...(about ? { about } : {}), name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks, presenceKey, pollMs: 100, onWords: x => { shown = x; } });
  pairing.catch(() => {});
  const q = await until(async () => { const x = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; });
  await until(async () => shown);
  assert.equal((await w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 }, "cli", PROOF)).data.yes, true);
  const done = await pairing;
  return { w, dk, ks, ident, owner, done, made, sign: m => crypto.sign("sha256", Buffer.from(m), { key: dk.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}









// ---- the identity proof in the FIRST adopt call, checked against the names directory (lead ruling, 4 Oct) ----























// ---- Add this device from another device: the joining side (relay/client/phonepair.js), a box-less device with its own identity key ----


// ---- a recovered phone (tailnet, 4 Oct): its key is on the identity's list by recovery and was never paired with this server ----


// ---- step 13 (walker): a removed server's route is refused ----


// ---- IV-5 (reviewer-3): invitee channels have a pool and a life of their own ----

// ---- walker (4 Oct): an unowned server with a leftover paired device refused a new pairing silently ----
shardTest("an unowned server lets go of devices left by a pairing that never completed ownership when a new pairing starts, and every refused hello is logged with its reason", async t => {
  process.env.VYRE_TEST_UNGATED_RING = "1";
  t.after(() => { delete process.env.VYRE_TEST_UNGATED_RING; });
  const w = await world(t);
  const crypt = nodeCrypto();
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const left = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Leftover phone", crypto: crypt, keyStore: keystore(t) });
  assert.equal(await relayHas(w, left.device), true, "the leftover phone has a row");
  // a refused hello says why in the log
  const strangerKeys = await clientDeviceKey({ keyStore: keystore(t), crypto: crypt });
  await assert.rejects(() => openChannel({ relay: w.status.url, route: left.route, box: Buffer.from(left.box, "base64url"), keys: strangerKeys, hello: { v: 1, pair: "x".repeat(22) }, crypto: crypt, WebSocket: globalThis.WebSocket }));
  assert.ok(w.logs.some(l => /relay: refused a hello \(this pairing code has expired or was already used/.test(l)), "the refusal is in the log");
  // a new owner pairing starts: the leftover is let go
  const made = await w.call("wink.server.code", { qr: true }, "cli", PROOF);
  assert.ok(made.data && made.data.qr, JSON.stringify(made.error));
  assert.equal(await relayHas(w, left.device), false, "the leftover row is gone");
  assert.ok(w.logs.some(l => /let go of 1 leftover device/.test(l)));
});

shardTest("relay.devices.clear-leftover refuses for itself when the server is owned, and a flood of refused hellos logs one line per reason per minute with a count", async t => {
  const f = await pairFreshServer(t);
  const row = async () => (await f.w.d.registry.call("relay.device.info", { id: f.done.device }, "module:vyred")).data;
  assert.equal((await row()).removed, false);
  const r = await f.w.d.registry.call("relay.devices.clear-leftover", {}, "module:wink");
  assert.equal(r.error && r.error.code, "owned", JSON.stringify(r));
  assert.equal((await row()).removed, false, "an owned server's device is still there");
  // the owned check is the relay's own: other callers never get that far
  assert.ok((await f.w.d.registry.call("relay.devices.clear-leftover", {}, "module:evil")).error);
  // 12 refused hellos with the same reason: one line, then a count at the next minute
  const crypt = nodeCrypto();
  for (let i = 0; i < 12; i++) {
    const k = await clientDeviceKey({ keyStore: keystore(t), crypto: crypt });
    await assert.rejects(() => openChannel({ relay: f.w.status.url, route: f.done.route, box: Buffer.from(f.done.box, "base64url"), keys: k, hello: { v: 1, pair: "x".repeat(22) }, crypto: crypt, WebSocket: globalThis.WebSocket }));
  }
  const lines = f.w.logs.filter(l => /relay: refused a hello \(this pairing code has expired/.test(l));
  assert.equal(lines.length, 1, `one log line for twelve identical refusals (${lines.length})`);
});

