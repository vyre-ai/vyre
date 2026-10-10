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
import { start, callerFacts } from "../core/daemon/index.js";
import { seams } from "../core/relay/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { joinWithCode } from "../relay/client/join.js";
import { pairTicket, resolveTicket, connect, openChannel, deviceKey as clientDeviceKey } from "../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../relay/client/nodecrypto.js";
import { fromBase64url } from "../relay/client/bytes.js";
import { ackCode } from "../relay/client/code.js";
import { tempHome } from "./helpers.js";
import { allowLoopbackForTests } from "../lib/http.js";
allowLoopbackForTests();   // this file runs its relay on loopback
import { macCore } from "./fake-core-keys.js";
import { card, removal, FORBIDDEN } from "../core/wink/cards.js";
import { peerDoor, composeWinkHome } from "../core/wink/index.js";
import { parseServerQr, parsePhoneQr } from "../core/wink/pairing.js";
import { pairWords, nonceCommit, ticketTag, newNonce } from "../relay/client/pairwords.js";
import { pairServer, parseServerPayload } from "../relay/client/serverpair.js";
import { createServerLinks } from "../core/wink/serverlink.js";
import { openServerPeer } from "../relay/client/peerclient.js";
import { deviceKey } from "../core/wink/devicekey.js";
import workerDir, * as WD from "../names/worker/index.js";
import { createRuntime } from "../relay/worker/fake-cf.js";
import { fakeDns } from "../names/worker/fake-dns.js";
import { memorySeen, idDirectory } from "../lib/identity/directory.js";
import { fileIdentityStore } from "../core/spaces/identity.js";
import { createIdentityOps } from "../core/spaces/identity-ops.js";
import { hooks as spacesHooks } from "../core/spaces/index.js";
import { acceptMessage } from "../lib/spaces/invites.js";

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

/** The new device types the code; resolves the states it showed and the pairing result. */
function typeCode(t, w, input, extra = {}) {
  const states = [];
  const done = joinWithCode({ relay: w.status.url, input, name: "Sam's laptop", onState: s => states.push(s), pollMs: 200, waitMs: 20_000, pairOptions: { crypto: nodeCrypto(), keyStore: keystore(t), timeout: 20_000 }, ...extra });
  return { states, done };
}

/**
 * A phone typing the code it was shown (wink.phone.open): the box-less joining side (relay/client/phonepair.js addThisDevice with a code), the person typing the ack back on the box. The code is the phone's confirmation:
 * the three words are not asked, and the phone is a device when the ack is right.
 * @param {any} t @param {any} w @param {string} code @param {string} offer
 */
async function addPhoneByCode(t, w, code, offer) {
  const { addThisDevice } = await import("../relay/client/phonepair.js");
  const key = crypto.generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  let ack = "";
  const joining = addThisDevice({ code, relay: w.status.url, key: { publicKey, label: "Sam's phone" }, name: "Sam's phone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 50, onAck: a => { ack = a; } });
  joining.catch(() => {});
  await until(() => ack);
  await until(() => w.events.find(e => e[0] === "wink.found"));
  const typed = await w.call("wink.code.ack", { offer, typed: ack });
  // This box holds no name, so it cannot put the phone's key on a name's list; the owner's app does that and reports it (wink.phone.enrolled). Here the report is "could not", so the waiting phone is told at once.
  const asked = await until(() => w.events.find(e => e[0] === "wink.enrol-asked"), 4000).catch(() => null);
  if (asked) assert.equal((await w.call("wink.phone.enrolled", { device: asked[1].device, ok: false, reason: "this test box holds no name" })).data.ok, true);
  return { ack, typed, joining };
}

shardTest("wink: a typed code is two-sided, ends in one device grant and events, and the code never rides the event bus", async t => {
  const w = await world(t);
  const open = await w.call("wink.code.open", { flow: "W2" });
  assert.ok(open.data?.code, JSON.stringify(open.error));
  assert.match(open.data.code, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  assert.match(ack.code, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/, "the new device shows a code to type back");
  const found = await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.ok(found, "the box knows a device is waiting");
  assert.equal((await w.call("wink.offers")).data.offers.length, 1);
  for (const [type, payload] of w.events) assert.ok(!JSON.stringify(payload ?? {}).includes(open.data.code), `${type} never carries the code`);
  // typing the right code back adds it
  const typed = await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code.toLowerCase().replace(/-/g, " ") });
  assert.equal(typed.data?.ok, true, JSON.stringify(typed.error));
  const r = await done;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.paired.device, "the device is paired");
  const access = (await w.call("wink.access")).data;
  assert.equal(access.grants.length, 0, "no grant in any space: a device belongs to the identity");
  assert.equal(access.devices.length, 1);
  assert.equal(access.devices[0].id, r.paired.device);
  assert.equal(access.devices[0].kind, "computer");
  assert.deepEqual(access.devices[0].owner, { kind: "identity", id: access.devices[0].identity });
  const kinds = w.events.map(e => e[0]);
  for (const k of ["wink.offered", "wink.found", "wink.confirmed", "wink.joined"]) assert.ok(kinds.includes(k), `${k} was emitted`);
  assert.ok(!kinds.includes("grant.created"), "no space grant is written for a device");
  assert.equal((await w.call("wink.offers")).data.offers.length, 0, "a used offer is no longer waiting");
});

shardTest("wink: a wrong code typed back closes the code at once and a fresh one is showing; nothing is added", async t => {
  const w = await world(t);
  const open = await w.call("wink.code.open", { flow: "W2" });
  const { states, done } = typeCode(t, w, open.data.code, { waitMs: 1500 });
  await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  const wrong = await w.call("wink.code.ack", { offer: open.data.offer, typed: "WINK-0000-0000" });
  assert.equal(wrong.data?.ok, false);
  assert.ok(w.events.some(e => e[0] === "wink.code-closed"), "the code closed");
  await until(() => w.events.find(e => e[0] === "wink.code-replaced"));
  const status = (await w.call("wink.code.status")).data;
  assert.ok(status.code && status.code !== open.data.code, "a fresh code is showing, with no tap");
  assert.equal((await done).ok, false, "the typing device never pairs");
  assert.equal((await w.call("wink.access")).data.grants.length, 0, "nothing was added");
});

shardTest("wink: the code is the owner's: an agent, a guest and a hook are refused", async t => {
  const w = await world(t);
  for (const caller of ["tailnet:agent:juno", "tailnet-guest:kit", "hook", "anonymous"]) {
    const r = await w.call("wink.code.open", { flow: "W2" }, caller);
    assert.ok(r.error, `${caller} is refused`);
  }
});

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

shardTest("wink: sharing a computer is a node.host grant with limits, and only for a computer that is paired", async t => {
  const w = await world(t);
  assert.equal((await w.call("wink.share", { device: "nopenopenopenope" })).error?.code, "not_found");
  const open = await w.call("wink.code.open", { flow: "W2" });
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code });
  const r = await done;
  // With the kernel the member's side of the compute offer is bound to the computer's own key (the Identity stud's device key a full pairing records); this typed-code pairing records none, so it is set here.
  w.d.registry.deps.db.prepare("UPDATE wink_devices SET node_key = ? WHERE id = ?").run(crypto.randomBytes(32).toString("base64url"), r.paired.device);
  const shared = await w.call("wink.share", { device: r.paired.device, cpu: 0.25, hours_day: 4, awake: true, on_power: true });
  assert.ok(shared.data?.grant, JSON.stringify(shared.error));
  const g = (await w.call("wink.access")).data.grants.find(x => x.source === "wink:W4");
  assert.ok(g);
  assert.ok(g.resource.endsWith(`/node/${r.paired.device}`));
  assert.ok(w.events.some(e => e[0] === "wink.shared"));
  // Sharing is the two sides of the compute offer, not only a grant: the computer now offers compute and its owner accepts, so the runner may lease it for the personal space.
  assert.equal(shared.data.allowed?.ok, true, JSON.stringify(shared.data));
  const dev = (await w.call("wink.access")).data.devices.find(x => x.id === r.paired.device);
  assert.equal(dev.offers.compute, true);
});

shardTest("wink: removing a device takes it from the identity with its connections, and removing it at the relay takes it from the registry", async t => {
  const w = await world(t);
  const open = await w.call("wink.code.open", { flow: "W2" });
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code });
  const r = await done;
  const dev = (await w.call("wink.access")).data.devices[0];
  const out = await w.call("wink.remove", { device: dev.id });
  assert.ok(out.data?.removed, JSON.stringify(out.error));
  assert.match(out.data.prompt, /stop reaching your server at once/);
  assert.equal((await w.call("wink.access")).data.devices.length, 0);
  assert.equal(typeof out.data.closed, "boolean", "it says whether the connections were closed");
  assert.ok(w.events.some(e => e[0] === "wink.removed" && e[1].device === r.paired.device));
  assert.equal((await w.call("wink.remove", { device: dev.id })).error?.code, "not_found");
  // relay.devices.remove is the person's own tool: the surface that asked closes the connections with it.
  if (!out.data.closed) await w.d.registry.call("relay.devices.remove", { id: dev.id }, "cli", PROOF);
  const left = (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.find(d => d.id === r.paired.device);
  assert.ok(!left, "the device is gone");
});

async function pairDevice(t, w) {
  const open = await w.call("wink.code.open", { flow: "W2" });
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found" && e[1].offer === open.data.offer));
  await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code });
  return (await done).paired.device;
}
/** The app's side of a fresh server ask (commit, hear nb, reveal): the words, and a call that completes the adopt. `seed` is the QR's secret, or none for a typed code. */
async function askServer(w, id, seed, owner) {
  const na = newNonce(), commit = await nonceCommit(na), ticket = seed ? Buffer.from(seed).toString("base64url") : "";
  const base = { commit, ...(seed ? { tag: await ticketTag(ticket) } : {}) };
  const mk = more => w.call("wink.server.adopt", { owner, identity: owner.id, pairing: { ...base, ...more } }, `device:${id}`, {});
  const r1 = (await mk({})).data;
  const r2 = (await mk({ reveal: na })).data;
  return { na, nb: r1.nb, ticket, first: r1, words: r2.words, until: r2.until, again: () => mk({ reveal: na }) };
}
/** The phone's side of a fresh phone ask over wink.phone.wait: commit (with its name), hear nb, reveal. */
async function askPhone(w, id, seed, name) {
  const na = newNonce(), commit = await nonceCommit(na), ticket = Buffer.from(seed).toString("base64url");
  const as = `device:${id}`;
  // the box holds a waiting phone when the relay says so (an event), a moment after the redemption
  const r1 = await until(async () => (await w.call("wink.phone.wait", { commit, tag: await ticketTag(ticket), ...(name ? { name } : {}) }, as, {})).data);
  const r2 = (await w.call("wink.phone.wait", { commit, reveal: na }, as, {})).data;
  return { na, nb: r1.nb, ticket, first: r1, words: r2.words };
}
const relayHas = async (w, id) => (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.some(d => d.id === id);

shardTest("wink: a release drops the adopter's relay device and a refused adopt drops the stranger's; wink.access is empty and the device is refused afterwards", async t => {
  const w = await world(t);
  const app = await pairDevice(t, w);
  const as = id => `device:${id}`;
  const me = (await w.call("wink.pair.targets", {})).data.targets[0];
  const adopt = (id, extra = {}) => w.call("wink.server.adopt", { owner: { kind: "identity", id: me.id }, identity: me.id }, as(id), { ...extra });
  // Q-1: the first adoption waits for a yes from the person at the server (a local screen), then the same device completes it
  const first = await askServer(w, app, null, { kind: "identity", id: me.id });
  const asked = await until(async () => { const q = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return q && q.asking ? q : null; });
  assert.match(first.words, /^[a-z]+ [a-z]+ [a-z]+$/, "the app shows three words");
  assert.equal(asked.choices.length, 3, "the server shows three choices");
  assert.equal(asked.words, undefined, "and never the right words");
  assert.ok(asked.choices.includes(first.words), "one of them is the app's words");
  assert.equal((await w.call("wink.server.pair.answer", { yes: true }, "cli", PROOF)).error?.code, "words_needed", "a bare yes is refused");
  assert.equal((await w.call("wink.server.pair.answer", { yes: true, pick: asked.choices.indexOf(first.words) + 1 }, "cli", PROOF)).data.answered, true);
  const fin = await first.again();
  assert.ok(fin.data?.owner, JSON.stringify(fin.error));
  // a second device is refused (naming the owner) and nothing of it is left on the box
  const stranger = await pairDevice(t, w);
  const refused = await adopt(stranger);
  assert.ok(refused.error, "refused");
  assert.match(refused.error.message, /already belongs to Personal/);
  await until(async () => !(await relayHas(w, stranger)));
  assert.ok(!(await w.call("wink.access")).data.devices.some(d => d.id === stranger), "no row for the refused device");
  assert.ok(await relayHas(w, app), "the adopter is still there while it owns the box");
  // the release: the box lets go, then the adopter's device is gone too
  const rel = await w.call("wink.server.release", {}, as(app), {});
  assert.deepEqual(rel.data, { released: true }, JSON.stringify(rel.error));
  await until(async () => !(await relayHas(w, app)));
  await until(async () => (await w.call("wink.access")).data.devices.every(d => d.id !== app));
  assert.equal((await w.call("wink.access", {}, "cli", PROOF)).data.devices.filter(d => d.id === app).length, 0, "wink.access lists nothing for it");
  // the relay is what authenticates a device's calls: with its row removed it is refused there (4401), never admitted as device:<id> again
  const row = (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.find(d => d.id === app);
  assert.equal(row, undefined, "the relay no longer knows it");
});

shardTest("wink: a ring pairing (relay.pair.ticket) is gated: the redeemer is a waiting pairing until the three words are picked on the computer, then it registers a phone, and removing the device at the relay clears it", async t => {
  const w = await world(t);
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: keystore(t) });
  assert.equal(paired.pending, true, "the redemption made a waiting pairing, not a device");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(await relayHas(w, paired.device), false, "no relay device before the confirm");
  assert.equal((await w.call("wink.access")).data.devices.length, 0, "a ring phone is not registered before the words are confirmed");
  assert.equal((await w.call("wink.phone.pairing")).data.asking, false, "and there is no question to say yes to blind");
  const seedless = await askPhone(w, paired.device, new Uint8Array(0), "Alex's iPhone");
  const q = (await w.call("wink.phone.pairing")).data;
  assert.equal(q.asking, true);
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true })).error?.code, "words_needed", "a bare yes adds nothing");
  assert.equal(await relayHas(w, paired.device), false);
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(seedless.words) + 1 })).data.yes, true);
  await until(async () => (await w.call("wink.access")).data.devices.length === 1);
  assert.equal(await relayHas(w, paired.device), true, "the relay makes the device only after the yes");
  const a = (await w.call("wink.access")).data;
  assert.equal(a.devices[0].kind, "phone");
  assert.equal(a.grants.length, 0);
  await w.d.registry.call("relay.devices.remove", { id: paired.device }, "cli", PROOF);
  await until(async () => (await w.call("wink.access")).data.devices.length === 0);
});

shardTest("wink: Add a phone shows a QR and a code, a phone never takes a space target, and the phone's typed-back code adds it as a phone", async t => {
  const w = await world(t);
  assert.equal((await w.call("wink.phone.open", { space: "spc_aaaaaaaaaaaa" })).error?.code, "identity_only");
  const open = await w.call("wink.phone.open", { typed: true });
  assert.ok(open.data?.code, JSON.stringify(open.error));
  assert.match(open.data.qr, /^vyre:\/\/wink\/1\?c=WINK-[0-9A-Z]{4}-[0-9A-Z]{4}&r=/);
  const added = await addPhoneByCode(t, w, open.data.code, open.data.offer);
  assert.equal(added.typed.data.ok, true);
  assert.equal((await added.joining).paired, true);
  const dev = (await w.call("wink.access")).data.devices[0];
  assert.equal(dev.kind, "phone");
  assert.deepEqual(dev.offers, { access: true });
  const scan = await w.call("wink.phone.scan", { payload: open.data.qr, target: { kind: "space", id: "spc_aaaaaaaaaaaa" } });
  assert.equal(scan.error?.code, "identity_only", "a phone is refused a space");
  assert.match(scan.error.message, /not to a space/);
});

shardTest("wink: the server's own code and typed-back confirmation use the same two-sided path, and a pick-a-number tool does not exist", async t => {
  const w = await world(t);
  const open = await w.call("wink.server.code", {});
  assert.match(open.data.code, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.server.confirm", { offer: open.data.offer, typed: "WINK-0000-0000" })).data.ok, false);
  assert.equal((await done).ok, false);
  for (const gone of ["wink.code.pick", "wink.pick"]) assert.equal((await w.call(gone, {})).error?.code, "no_such_tool", `${gone} is gone`);
});

shardTest("wink: the app's side carries the proof: pair.server without presence is refused, a space pairing by a non-admin is refused, an admin passes; the server's own side stays presence-free", async t => {
  const w = await world(t);
  const bare = { peer: A.peer, person: A.person };
  const own = (await w.call("wink.pair.targets", {})).data.targets[0];
  const code = "WINK-K7QM-4P2X";
  // no presence proof: refused before anything is checked or typed
  const none = await w.call("wink.pair.server", { code, target: { kind: "identity", id: own.id } }, SCREEN, bare);
  assert.equal(none.error?.code, "presence_required", JSON.stringify(none));
  const noneSpace = await w.call("wink.pair.server", { code, target: { kind: "space", id: w.status.space || "spc_aaaaaaaaaaaa" } }, SCREEN, bare);
  assert.equal(noneSpace.error?.code, "presence_required");
  // with presence: a space the person does not administer is refused, then an unreachable code is a plain bad input (the checks passed)
  assert.equal((await w.call("wink.pair.server", { code, target: { kind: "space", id: "spc_aaaaaaaaaaaa" } })).error?.code, "not_admin");
  const spaces = (await w.call("wink.pair.targets", {})).data.targets.filter(x => x.kind === "space");
  assert.ok(spaces.length >= 1, "the owner of this box administers its space");
  assert.equal((await w.call("wink.pair.server", { code: "hello", target: { kind: "space", id: spaces[0].id } })).error?.code, "bad_input");
  assert.equal((await w.call("wink.pair.server", { code: "hello", target: { kind: "identity", id: own.id } })).error?.code, "bad_input");
  // the headless server has no Touch ID: its two calls take no proof
  const open = await w.call("wink.server.code", {}, SCREEN, bare);
  assert.ok(open.data?.code, JSON.stringify(open.error));
  assert.equal((await w.call("wink.server.confirm", { offer: open.data.offer, typed: "WINK-0000-0000" }, SCREEN, bare)).error?.code, "not_found", "reaches the module with no proof");
});

shardTest("wink: a new server code always replaces the old one: the abandoned code stops working and the offer closes", async t => {
  const w = await world(t);
  const first = (await w.call("wink.server.code", {})).data;
  const second = (await w.call("wink.server.code", {})).data;
  assert.ok(second.code && second.code !== first.code, "a different code, not the abandoned one");
  assert.notEqual(second.offer, first.offer);
  const offers = (await w.call("wink.offers")).data.offers;
  assert.ok(!offers.some(o => o.id === first.offer), "the old offer is no longer waiting");
  const old = typeCode(t, w, first.code);
  assert.equal((await old.done).ok, false, "typing the abandoned code fails");
  const { states, done } = typeCode(t, w, second.code);
  await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.server.confirm", { offer: second.offer, typed: "WINK-0000-0000" })).data.ok, false);
  await done;
});

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

shardTest("wink: the code on screen is never derivable from the typed-back code, and the typed-back code is the same on both ends", () => {
  const key = crypto.randomBytes(32);
  assert.equal(ackCode(key), ackCode(key));
  assert.notEqual(ackCode(key), ackCode(crypto.randomBytes(32)));
});

/** Pairs one computer the typed-code way and returns its device id. */
async function pairComputer(t, w) {
  const open = await w.call("wink.code.open", { flow: "W2" });
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code })).data?.ok, true);
  const r = await done;
  assert.equal(r.ok, true);
  return r.paired.device;
}

shardTest("wink.relay.apply: the owner's app signs the instruction, the box checks it; no presence is asked on the box (lead ruling 3 Oct)", async t => {
  const w = await world(t);
  const device = await pairComputer(t, w);
  const box = (await w.d.registry.call("relay.route.id", {}, "module:wink", {})).data.route;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const sign = (i, key = privateKey) => crypto.sign(null, Buffer.from(`vyre-wink-instruction-v1\n${i.box}\n${i.action}\n${i.url || ""}\n${i.ts}\n${i.nonce}`), key).toString("base64url");
  const make = (o = {}) => { const i = { v: 1, action: "relay.enable", url: w.url, box, device, ts: Date.now(), nonce: crypto.randomBytes(12).toString("base64url"), ...o }; return { ...i, sig: o.sig || sign(i) }; };
  const apply = i => w.call("wink.relay.apply", i, "cli", {});
  // no key registered yet: refused, whoever signed
  assert.match((await apply(make())).error?.message || "", /refused/);
  // registering the key is the owner's own act and needs presence
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  assert.equal((await w.call("wink.device.key", { device, key: spki }, SCREEN, { peer: A.peer, person: A.person })).error?.code, "presence_required");
  assert.equal((await w.call("wink.device.key", { device, key: spki })).data?.device, device);
  const good = make();
  const r = await apply(good);
  // The signature checked out and the box asked the relay to switch on through relay.apply (the wink module's own door).
  assert.ok(r.data?.applied === true, JSON.stringify(r.error));
  assert.match((await apply(good)).error?.message || "", /already used/);
  for (const [why, i, re] of [
    ["another box", make({ box: "someone-else" }), /another box/],
    ["a stale time", make({ ts: Date.now() - 5 * 60_000 }), /too old/],
    ["a bad url", make({ url: "http://x" }), /ws:\/\/|wss:\/\//],
    ["an unknown device", make({ device: "ghost" }), /not a device of the owner/],
    ["a tampered url", { ...make(), url: "wss://evil.test" }, /signature/],
    ["another key", make({ sig: sign({ box, action: "relay.enable", url: w.url, ts: 1, nonce: "x" }, crypto.generateKeyPairSync("ed25519").privateKey) }), /signature/],
  ]) assert.match((await apply(i)).error?.message || "", re, why);
  // an agent never applies one, even with a good signature
  assert.equal((await w.call("wink.relay.apply", make(), "tailnet:agent:juno", {})).error?.code, "denied");
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

shardTest("Q-1 and typed code OFF, real daemon: the box makes a QR and a long code with no typed code; a scan only pairs the device, the server asks, and its three words equal what the scanning side derives from its own keys", async t => {
  const w = await world(t);
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  // the typed paths are refused with a plain reason
  assert.equal((await w.call("wink.code.open", { flow: "W2" })).error?.code, "typed_code_off");
  assert.equal((await w.call("wink.server.code", { typed: true }, "cli", PROOF)).error?.code, "typed_code_off");
  assert.equal((await w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target: { kind: "identity", id: (await w.call("wink.pair.targets", {})).data.targets[0].id } })).error?.code, "typed_code_off");
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  assert.ok(made.qr && made.art, "the QR and the long code");
  assert.equal(made.code, undefined, "no short code");
  const scan = parseServerQr(made.qr);
  assert.ok(scan);
  // a scan pairs the device with the box and nothing more: the box has no owner yet
  const paired = await pairTicket(scan.seed, { relay: w.status.url, name: "Sam's phone", crypto: nodeCrypto(), keyStore: keystore(t) });
  const me = (await w.call("wink.pair.targets", {})).data.targets[0];
  const mine = await askServer(w, paired.device, scan.seed, { kind: "identity", id: me.id, name: "Alex" });
  const asked = await until(async () => { const q = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return q && q.asking ? q : null; });
  assert.match(asked.name, /^Alex \(id [A-Za-z0-9]{1,6}\)$/, "the claimed name carries the first characters of the identity id");
  const right = await pairWords(paired.box, paired.device, { ticket: mine.ticket, nonceA: mine.na, nonceB: mine.nb });
  assert.equal(mine.words, right, "the app derives the words from the keys, the ticket and the two fresh nonces");
  assert.ok(asked.choices.includes(right), "the server's choices hold the same words, among two decoys");
  assert.ok(!(await w.call("wink.access")).data.devices.some(d => d.id === "self"), "no owner while the question is open");
  // a stranger cannot answer, a person at the server can
  assert.equal((await w.call("wink.server.pair.answer", { yes: true, pick: 1 }, `device:${paired.device}`, {})).error?.code, "person_session_required", "a paired device with no person session is refused before the tool runs (reach person)");
  assert.equal((await w.call("wink.server.pair.answer", { yes: true, pick: asked.choices.indexOf(right) + 1 }, "cli", PROOF)).data.answered, true);
  const fin = await mine.again();
  assert.ok(fin.data?.owner, JSON.stringify(fin.error));
  // the same ticket cannot be used for a second pairing: the relay refuses the second scanner, and the box does not know another ticket
  await assert.rejects(() => pairTicket(scan.seed, { relay: w.status.url, name: "Eve", crypto: nodeCrypto(), keyStore: keystore(t) }));
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

shardTest("Add a phone, real daemon, typed code OFF: the QR is scanned, both sides derive the same three words, nothing is added until yes, a second scanner is refused", async t => {
  const w = await world(t);
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  assert.equal((await w.call("wink.phone.open", { typed: true })).error?.code, "typed_code_off");
  assert.equal((await w.call("wink.code.ack", { offer: "wo_x", typed: "WINK-0000-0000" })).error?.code, "typed_code_off");
  const open = (await w.call("wink.phone.open", {})).data;
  assert.ok(open.qr && open.art && open.link === open.qr);
  assert.equal(open.code, undefined, "no short code");
  const scan = parsePhoneQr(open.qr);
  assert.ok(scan && scan.seed.length === 16);
  const paired = await pairTicket(scan.seed, { relay: w.status.url, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: keystore(t) });
  assert.equal((await w.call("wink.phone.pairing")).data.asking, false, "no words yet, no question");
  const mine = await askPhone(w, paired.device, scan.seed, "Alex's iPhone");
  const asked = await until(async () => { const q = (await w.call("wink.phone.pairing")).data; return q && q.asking ? q : null; });
  assert.equal(asked.name, "Alex's iPhone", "the name the phone sent, not Device");
  const right = await pairWords(paired.box, paired.device, { ticket: mine.ticket, nonceA: mine.na, nonceB: mine.nb });
  assert.equal(mine.words, right, "the phone derives the words from the keys, the ticket and the two fresh nonces");
  assert.ok(asked.choices.includes(right), "the computer's choices hold the same words, among two decoys");
  assert.equal((await w.call("wink.access")).data.devices.length, 0, "nothing is added before the yes");
  assert.equal(await relayHas(w, paired.device), false, "and the relay has made no device for the phone");
  const wait = (await w.call("wink.phone.wait", {}, `device:${paired.device}`, {})).data;
  assert.deepEqual([wait.state, wait.words], ["waiting", right]);
  // a second scanner of the same code is refused by the relay, and the computer is not asked about it
  await assert.rejects(() => pairTicket(scan.seed, { relay: w.status.url, name: "Eve's phone", crypto: nodeCrypto(), keyStore: keystore(t) }));
  assert.deepEqual((await w.call("wink.phone.pairing")).data.choices, asked.choices);
  const yes = (await w.call("wink.phone.pair.answer", { yes: true, pick: asked.choices.indexOf(right) + 1 })).data;
  assert.equal(yes.yes, true, JSON.stringify(yes));
  const devs = (await w.call("wink.access")).data.devices;
  assert.deepEqual(devs.map(d => d.kind), ["phone"]);
  assert.equal((await w.call("wink.phone.wait", {}, `device:${paired.device}`, {})).data.state, "yes");
});

shardTest("Add a phone, real daemon, typed code OFF: a no, or wrong words, adds nothing and the phone is let go", async t => {
  const w = await world(t);
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  for (const answer of [{ yes: false }, { yes: true, words: "wrong wrong wrong" }]) {
    const open = (await w.call("wink.phone.open", {})).data;
    const scan = parsePhoneQr(open.qr);
    const paired = await pairTicket(scan.seed, { relay: w.status.url, name: "Sam's phone", crypto: nodeCrypto(), keyStore: keystore(t) });
    await askPhone(w, paired.device, scan.seed, "Sam's phone");
    await until(async () => { const q = (await w.call("wink.phone.pairing")).data; return q && q.asking; });
    const r = (await w.call("wink.phone.pair.answer", answer)).data;
    assert.equal(r.yes, false);
    assert.equal((await w.call("wink.access")).data.devices.length, 0);
    assert.equal(await relayHas(w, paired.device), false, "no relay device was ever made for it");
  }
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
/** Every tool the review probed, plus the ones a waiting pairing must never see, whatever kind of ticket it came from. */
const PROBED = ["relay.devices.list", "wink.access", "relay.status", "system.info", "wink.pair.targets", "threads.list", "term.list", "vault.list", "presence.person.start", "presence.enroll", "relay.devices.remove", "relay.devices.drop", "relay.pair.pending.confirm",
  "relay.pair.ticket", "relay.pair.window.open", "wink.phone.pair.answer", "wink.phone.pairing", "wink.phone.open", "wink.server.pair.answer", "wink.server.pairing", "wink.server.code", "wink.server.reset", "wink.server.release", "wink.server.retarget", "wink.remove",
  "wink.offer.set", "wink.pair.server", "wink.storage.remove", "wink.device.key", "wink.relay.apply", "about.text", "identity.sign"];

shardTest("X-1, real daemon and relay: a phone that redeems the QR is a waiting pairing: no device, no presence key, no tool at all but its own wink.phone.wait; a no or a timeout leaves nothing and the ticket is spent", async t => {
  const w = await world(t, { pendingMs: 1500 });
  const open = (await w.call("wink.phone.open", {})).data;
  const scan = parsePhoneQr(open.qr);
  const r = await redeem(t, w, scan.seed, "Eve's phone");
  assert.equal(r.paired.pending, true);
  assert.equal(await relayHas(w, r.paired.device), false, "no relay device, so no device row for it");
  assert.equal((await w.call("wink.access")).data.devices.length, 0);
  const c = r.open();
  // it can reach wink.phone.wait (its own pairing) and nothing else: not one of the probed tools answers, and neither do the paths around them
  const mine = await over(c, "wink.phone.wait", { name: "Eve's phone" });
  assert.equal(mine.status, 200, JSON.stringify(mine));
  for (const tool of PROBED) { const o = await over(c, tool, {}); assert.ok(o.status === 404 || o.status === 403 || o.status === 0, `${tool} is not reachable by a waiting pairing (got ${o.status})`); }
  assert.equal((await over(c, "wink.server.adopt", {})).status, 404, "a phone's waiting pairing cannot adopt a server");
  for (const [method, path] of [["GET", "/v1/tools"], ["GET", "/v1/events"], ["GET", "/v1/state"], ["POST", "/v1/presence/challenge"], ["GET", "/v1/streams/glass/screen"]]) {
    const rr = await Promise.race([c.fetch(path, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) }), new Promise(res => setTimeout(() => res({ status: 0 }), 5000))]);
    assert.ok(rr.status === 404 || rr.status === 403 || rr.status === 0 || rr.status === 405, `${method} ${path} is closed to a waiting pairing (got ${rr.status})`);
  }
  // what wink.phone.wait does is its own: it cannot answer its own question, add itself, or be called with another's name
  // fields the tool does not declare are refused by the registry, so it cannot be told it was answered; the call it does take answers waiting
  const extra = await over(c, "wink.phone.wait", { state: "yes", yes: true, device: "someone" });
  assert.ok(extra.status >= 400 && !(extra.body && extra.body.data), "undeclared fields are refused");
  assert.equal((await over(c, "wink.phone.wait", {})).body.data.state, "waiting");
  assert.equal(await relayHas(w, r.paired.device), false);
  assert.equal((await w.call("wink.access")).data.devices.length, 0);
  // it cannot sign in either: no presence key was enrolled and no session can start
  assert.equal(await deviceRow(w, r.paired.device), undefined);
  // no answer: the pairing ends by itself, the channel closes, a reconnect is refused and the ticket stays spent
  await until(async () => /not a paired device/.test(String(r.open().lastError?.message || "")) || (await over(r.open(), "wink.phone.wait", {})).status !== 200, 8000);
  assert.equal(await relayHas(w, r.paired.device), false, "no device after the timeout");
  await assert.rejects(() => pairTicket(scan.seed, { relay: w.status.url, name: "Eve again", crypto: nodeCrypto(), keyStore: keystore(t) }), /expired or was already used/);
  // a no from the person ends it the same way
  const open2 = (await w.call("wink.phone.open", {})).data;
  const r2 = await redeem(t, w, parsePhoneQr(open2.qr).seed, "Sam's phone");
  await askPhone(w, r2.paired.device, parsePhoneQr(open2.qr).seed, "Sam's phone");
  assert.equal((await w.call("wink.phone.pair.answer", { yes: false })).data.yes, false);
  assert.equal(await relayHas(w, r2.paired.device), false);
  await until(async () => (await over(r2.open(), "wink.phone.wait", {})).status !== 200, 8000);
  assert.equal(await deviceRow(w, r2.paired.device), undefined, "no row, so no presence key either");
});

/** What the home itself says about a device that redeemed a ticket: its own relay row (the PH-1 input) and the person facts the daemon would build for a call that device makes. */
async function homeSaysAbout(w, id) {
  const row = (await w.d.registry.call("relay.device.info", { id }, "module:vyred")).data || null;
  const facts = callerFacts(`device:${id}`, { caller: `device:${id}` }, null, { id: { owner: "per_owner" } }, false, row);
  return { row, facts };
}

for (const withQr of [false, true]) {
  test(`R-2, real daemon and relay: a plain ring ticket (relay.pair.ticket) is a waiting pairing ${withQr ? "while a QR is open" : "on its own"}: no row of any kind, no presence key, no person chain, one tool; the pick makes the row`, async t => {
    const w = await world(t, { pendingMs: 3000 });
    const enrolled = lenient.enrolled.length;
    const qr = withQr ? (await w.call("wink.phone.open", {})).data : null;
    const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
    assert.ok(minted.data?.ticket, JSON.stringify(minted.error));
    assert.equal((await w.d.registry.call("relay.pair.gate", {}, "module:wink")).error?.code, "no_such_tool", "no module has to tell the relay to gate: the gate is not a switch");
    const r = await redeem(t, w, fromBase64url(minted.data.ticket), "Ring interloper");
    assert.equal(r.paired.pending, true, "the redemption made a waiting pairing, not a device");
    assert.equal(await relayHas(w, r.paired.device), false, "no relay device row");
    assert.equal(await deviceRow(w, r.paired.device), undefined);
    const home = await homeSaysAbout(w, r.paired.device);
    assert.equal(home.row, null, "the home holds no row, so no kind app for it");
    assert.equal(home.facts, null, "callerFacts gives the redeemer no person chain");
    assert.equal(lenient.enrolled.length, enrolled, "no presence key was enrolled");
    const c = r.open();
    assert.equal((await over(c, "wink.phone.wait", { name: "Ring interloper" })).status, 200, "its own pairing wait is the one thing it reaches");
    for (const tool of PROBED) { const o = await over(c, tool, {}); assert.ok(o.status === 404 || o.status === 403 || o.status === 0, `${tool} is not reachable by a waiting ring pairing (got ${o.status})`); }
    assert.equal((await over(c, "wink.server.adopt", {})).status, 404);
    assert.equal(lenient.enrolled.length, enrolled, "still no presence key after the probes");
    assert.equal((await w.call("wink.access")).data.devices.length, 0);
    // the person at the computer picks the right words: only then is there a row, of kind app, and only then does the home treat it as the owner's
    const mine = await askPhone(w, r.paired.device, new Uint8Array(0), "Ring interloper");
    const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
    assert.equal((await w.call("wink.phone.pair.answer", { yes: true })).error?.code, "words_needed", "a bare yes confirms nothing");
    assert.equal(await relayHas(w, r.paired.device), false);
    assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(mine.words) + 1 })).data.yes, true);
    await until(async () => relayHas(w, r.paired.device));
    assert.equal((await homeSaysAbout(w, r.paired.device)).row?.kind, "app");
    if (qr) assert.ok(qr.qr, "the QR was open the whole time");
  });
}

shardTest("paired session, real daemon, relay and presence module: the owner's pick records the device and its key, grants a session, the relay trusts it at once, and the device opens its session with no prompt; removal ends it", async t => {
  const w = await world(t);
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ks = keystore(t);
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "software" };
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks, presenceKey });
  assert.equal(paired.pending, true);
  assert.equal(await w.d.registry.call("wink.device.record", { id: paired.device }, "module:presence").then(r => r.data ?? null), null, "nothing recorded before the confirm");
  const mine = await askPhone(w, paired.device, new Uint8Array(0), "Alex's iPhone");
  const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(mine.words) + 1 })).data.yes, true);
  await until(async () => relayHas(w, paired.device));
  // what presence reads back: confirmed by the owner, with the key the device offered; and only presence may ask
  const rec = (await w.d.registry.call("wink.device.record", { id: paired.device }, "module:presence")).data;
  assert.deepEqual([rec.kind, rec.confirmed, rec.confirmedBy === rec.owner, rec.confirmKeyId, rec.hardware], ["phone", true, true, "k1", false]);
  assert.deepEqual([rec.key.x, rec.key.y], [dk.publicKey.export({ format: "jwk" }).x, dk.publicKey.export({ format: "jwk" }).y]);
  assert.ok((await w.d.registry.call("wink.device.record", { id: paired.device }, "module:relay")).error, "only presence asks");
  assert.ok((await w.d.registry.call("wink.device.record", { id: paired.device }, "cli", PROOF)).error);
  // the relay trusts it from the same moment
  assert.equal((await w.d.registry.call("relay.device.info", { id: paired.device }, "module:vyred")).data.trusted, true);
  // the line shows only when the app reports a software key (self-reported, display only; the grant still treats the key as unattested)
  await until(async () => (await w.call("wink.access")).data.devices.find(d => d.id === paired.device)?.software === true);
  // the relay's own device view carries the same self-report, for the Devices screen
  assert.equal((await deviceRow(w, paired.device)).storage, "software");
  // the device gets its challenge over its own channel, signs it, and has a person session with no prompt and no passkey
  const c = connect({ relay: w.status.url, route: paired.route, box: paired.box, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => c.close());
  const ch = (await over(c, "presence.person.pair-challenge", {})).body.data.challenge;
  const sig = crypto.sign("sha256", Buffer.from(`paired-start\n${paired.device}\n${ch}`), { key: dk.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const started = await over(c, "presence.person.start-paired", { sig });
  assert.equal(started.status, 200, JSON.stringify(started));
  assert.ok(started.body.data.token, "a session token");
  const live = () => w.d.registry.call("presence.person.sessions", {}, "cli", PROOF).then(r => (r.data?.sessions || r.data || []).filter(x => x.paired));
  assert.equal((await live()).length, 1);
  // removing the device ends its paired session
  assert.equal((await w.call("wink.remove", { device: paired.device })).data.removed, paired.device);
  await until(async () => (await live()).length === 0);
});

shardTest("paired session on the real kernel: pair, pick, start-paired, then memory.graph answers as the owner with no prompt; the same device without its session gets the sign-in hint; removal ends it", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const w = await world(t, { kernel: true });
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ks = keystore(t);
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "hardware" };
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks, presenceKey });
  const mine = await askPhone(w, paired.device, new Uint8Array(0), "Alex's iPhone");
  const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(mine.words) + 1 })).data.yes, true);
  await until(async () => relayHas(w, paired.device));
  const c = connect({ relay: w.status.url, route: paired.route, box: paired.box, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => c.close());
  const ch = (await over(c, "presence.person.pair-challenge", {})).body.data.challenge;
  const sig = crypto.sign("sha256", Buffer.from(`paired-start\n${paired.device}\n${ch}`), { key: dk.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const started = await over(c, "presence.person.start-paired", { sig });
  assert.equal(started.status, 200, JSON.stringify(started));
  const sessionId = started.body.data.id;
  const sessions = (await w.d.registry.call("presence.person.sessions", {}, "cli", PROOF)).data;
  assert.ok((sessions.sessions || sessions).some(x => x.id === sessionId && x.paired), "the session exists in presence");
  // the call as the daemon makes it for this device: facts from callerFacts and the home's own relay row, the session id that start-paired gave
  const label = `device:${paired.device}`;
  const read = async via => {
    const info = await w.d.registry.call("relay.device.info", { id: paired.device }, "module:vyred");
    const rec = await w.d.registry.call("wink.device.record", { id: paired.device }, "module:vyred");
    const facts = callerFacts(label, { caller: label }, via, w.d.kernel, false, info.data ? { ...info.data, person: rec.data ? rec.data.owner : null } : null);
    return w.d.registry.call("memory.graph", {}, label, { ...via, ...(facts ? { kernelFacts: facts } : {}) });
  };
  const ok = await read({ person: { id: sessionId } });
  assert.ok(!ok.error, `memory.graph with the paired session: ${JSON.stringify(ok.error)}`);
  assert.equal((await read({})).error?.code, "person_session_required", "without its session the same device gets the sign-in hint");
  await w.call("wink.remove", { device: paired.device });
  await until(async () => !(await relayHas(w, paired.device)));
  assert.equal((await read({ person: { id: sessionId } })).error?.code, "denied", "a removed device reads nothing");
});


/** A paired phone with a live person session on the real kernel, and the call a daemon makes for it. */
async function pairedOnKernel(t, { confirmWithRealKey = false } = {}, shared = null) {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const w = shared || await world(t, { kernel: true });
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ks = keystore(t);
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "hardware" };
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks, presenceKey });
  const mine = await askPhone(w, paired.device, new Uint8Array(0), "Alex's iPhone");
  const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  // The owner's confirming key: the stub's fixed "k1", or (confirmWithRealKey) a key really enrolled in presence_keys, so removing it can end the session bound to it.
  let ownerKey = null;
  if (confirmWithRealKey) {
    const ok = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    ownerKey = (await w.d.registry.call("presence.enroll", { kind: "device", name: "Alex's Mac", public_key: ok.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 }, "cli", PROOF)).data.id;
    assert.ok(ownerKey, "an owner key is enrolled");
  }
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(mine.words) + 1 }, SCREEN, ownerKey ? { ...A, proof: { method: "passkey", key: ownerKey } } : A)).data.yes, true);
  await until(async () => relayHas(w, paired.device));
  const c = connect({ relay: w.status.url, route: paired.route, box: paired.box, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => c.close());
  const ch = (await over(c, "presence.person.pair-challenge", {})).body.data.challenge;
  const sig = crypto.sign("sha256", Buffer.from(`paired-start\n${paired.device}\n${ch}`), { key: dk.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const started = await over(c, "presence.person.start-paired", { sig });
  assert.equal(started.status, 200, JSON.stringify(started));
  const sessionId = started.body.data.id, label = `device:${paired.device}`;
  const read = async (via = { person: { id: sessionId } }) => {
    const info = await w.d.registry.call("relay.device.info", { id: paired.device }, "module:vyred");
    const rec = await w.d.registry.call("wink.device.record", { id: paired.device }, "module:vyred");
    const facts = callerFacts(label, { caller: label }, via, w.d.kernel, false, info.data ? { ...info.data, person: rec.data ? rec.data.owner : null } : null);
    return w.d.registry.call("memory.graph", {}, label, { ...via, ...(facts ? { kernelFacts: facts } : {}) });
  };
  assert.ok(!(await read()).error, "the paired session reads memory with no prompt");
  const live = async () => { const x = (await w.d.registry.call("presence.person.sessions", {}, "cli", PROOF)).data; return (x.sessions || x).some(y => y.id === sessionId); };
  assert.equal(await live(), true);
  return { w, paired, sessionId, read, live, ownerKey };
}

shardTest("paired session ends, on the real kernel: a revoked session id is gone at once", async t => {
  const { w, sessionId, live } = await pairedOnKernel(t);
  assert.equal((await w.d.registry.call("presence.person.revoke", { id: sessionId }, "cli", PROOF)).data.revoked, sessionId);
  assert.equal(await live(), false, "a revoked session is gone from presence, so the daemon verifies nothing for it");
});

shardTest("paired session ends, on the real kernel: sign-out-everywhere (wink asks presence to end every paired session) ends the session, and only module:wink may ask", async t => {
  const a = await pairedOnKernel(t);
  assert.ok((await a.w.d.registry.call("presence.person.end-paired", {}, "cli", PROOF)).error, "only module:wink may end paired sessions");
  assert.equal(await a.live(), true, "a refused end changed nothing");
  const ended = await a.w.d.registry.call("presence.person.end-paired", {}, "module:wink");
  assert.ok(ended.data.ended >= 1, JSON.stringify(ended));
  assert.equal(await a.live(), false, "after sign-out-everywhere the session is gone");
});

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

shardTest("one pairing path for a browser: unconfirmed it is web:<id> and reaches wink.phone.wait only; confirmed with the three words its row is kind app with a software key, and it is device:<id>", async t => {
  const w = await world(t);
  const ks = keystore(t);
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Alex's browser", crypto: nodeCrypto(), keyStore: ks, about: { kind: "web", release: "0.3.0" } });
  assert.equal(paired.pending, true);
  const c = connect({ relay: w.status.url, route: paired.route, box: paired.box, name: "Alex's browser", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => c.close());
  assert.equal((await over(c, "wink.phone.wait", { name: "Alex's browser" })).status, 200, "its own pairing wait");
  assert.equal((await over(c, "relay.devices.ask-trust", {})).status, 404, "an unconfirmed browser has the pairing calls only");
  const mine = await askPhone(w, paired.device, new Uint8Array(0), "Alex's browser");
  const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(mine.words) + 1 })).data.yes, true);
  await until(async () => relayHas(w, paired.device));
  const row = await deviceRow(w, paired.device);
  assert.deepEqual([row.kind, row.storage], ["app", "software"], "a confirmed browser is a device like any other, its key in software");
  assert.equal((await w.d.registry.call("relay.device.info", { id: paired.device }, "module:vyred")).data.kind, "app");
  const c2 = connect({ relay: w.status.url, route: paired.route, box: paired.box, name: "Alex's browser", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => c2.close());
  const asked = await over(c2, "relay.devices.ask-trust", {});
  assert.notEqual(asked.status, 200, "device:<id> is not a browser with limits to lift");
});

shardTest("a browser's passkey is enrolled only after the three words, bound to its device id and the app's origin, and removed with the device", async t => {
  const w = await world(t);
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const passkey = { credential_id: crypto.randomBytes(24).toString("base64url"), public_key: kp.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, rp_id: "app.vyre.run" };
  const keys = async () => ((await w.d.registry.call("presence.keys", {}, "cli", PROOF)).data || []).filter(k => k.kind === "passkey");
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Alex's browser", crypto: nodeCrypto(), keyStore: keystore(t), about: { kind: "web", release: "0.3.0" }, passkey });
  assert.equal(paired.pending, true);
  assert.equal((await keys()).length, 0, "nothing is enrolled for an unconfirmed redeemer");
  const mine = await askPhone(w, paired.device, new Uint8Array(0), "Alex's browser");
  const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(mine.words) + 1 })).data.yes, true);
  await until(async () => (await keys()).length === 1);
  assert.equal((await keys())[0].id, passkey.credential_id);
  assert.equal((await deviceRow(w, paired.device)).presence, true);
  const db = w.d.registry.deps.db;
  const bound = db.prepare("SELECT device, origin FROM presence_key_devices WHERE key = ?").get(passkey.credential_id);
  assert.deepEqual([bound.device, bound.origin], [paired.device, "https://app.vyre.run"], "bound to this device and the app's origin");
  await w.call("wink.remove", { device: paired.device });
  await until(async () => (await keys()).length === 0);
});

shardTest("a passkey a browser offers that the box cannot bind is refused, and the device is still paired without it; a phone's offered passkey is never enrolled", async t => {
  const w = await world(t);
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = kp.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const keys = async () => ((await w.d.registry.call("presence.keys", {}, "cli", PROOF)).data || []).filter(k => k.kind === "passkey");
  // a browser whose passkey has no rp_id: nothing to bind it to the app's origin
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Alex's browser", crypto: nodeCrypto(), keyStore: keystore(t), about: { kind: "web", release: "0.3.0" }, passkey: { credential_id: crypto.randomBytes(24).toString("base64url"), public_key: spki, alg: -7, rp_id: "" } });
  const mine = await askPhone(w, paired.device, new Uint8Array(0), "Alex's browser");
  const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(mine.words) + 1 })).data.yes, true);
  await until(async () => relayHas(w, paired.device));
  assert.equal((await keys()).length, 0, "an unbound passkey is not enrolled");
  assert.ok(await deviceRow(w, paired.device), "the browser is still a paired device");
  assert.equal(w.d.registry.deps.db.prepare("SELECT COUNT(*) AS n FROM presence_key_devices").get().n, 0);
  // a phone (not a browser) that offers one anyway gets nothing enrolled from it
  const open = (await w.call("wink.phone.open", {})).data;
  const scan = parsePhoneQr(open.qr);
  const r = await redeem(t, w, scan.seed, "Alex's iPhone", { passkey: { credential_id: crypto.randomBytes(24).toString("base64url"), public_key: spki, alg: -7, rp_id: "app.vyre.run" } });
  const mine2 = await askPhone(w, r.paired.device, scan.seed, "Alex's iPhone");
  const q2 = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q2.choices.indexOf(mine2.words) + 1 })).data.yes, true);
  await until(async () => relayHas(w, r.paired.device));
  assert.equal((await keys()).length, 0, "a phone keeps its device key; an offered passkey is not enrolled");
});

shardTest("X-1, real daemon and relay: the yes makes the device (row, presence key, bridge session) and only the yes; a wrong pick makes nothing", async t => {
  const w = await world(t);
  const open = (await w.call("wink.phone.open", {})).data;
  const scan = parsePhoneQr(open.qr);
  const r = await redeem(t, w, scan.seed, "Alex's iPhone");
  const mine = await askPhone(w, r.paired.device, scan.seed, "Alex's iPhone");
  const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  assert.equal(await deviceRow(w, r.paired.device), undefined, "no row, so no presence key is enrolled for a waiting pairing");
  // a wrong pick is a no and makes nothing
  const decoy = q.choices.findIndex(c => c !== mine.words) + 1;
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: decoy })).data.yes, false);
  assert.equal(await relayHas(w, r.paired.device), false);
  assert.equal(await deviceRow(w, r.paired.device), undefined);
  // a fresh pairing, the right pick
  const open2 = (await w.call("wink.phone.open", {})).data;
  const scan2 = parsePhoneQr(open2.qr);
  const r2 = await redeem(t, w, scan2.seed, "Alex's iPhone");
  const mine2 = await askPhone(w, r2.paired.device, scan2.seed, "Alex's iPhone");
  const q2 = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q2.choices.indexOf(mine2.words) + 1 })).data.yes, true);
  const row = await until(() => deviceRow(w, r2.paired.device));
  assert.equal(row.presence, true, "its presence key is enrolled only now");
  // now it is a paired device: an ordinary connection is admitted and reaches the tools a paired device reaches
  const c = r2.open();
  assert.equal((await over(c, "wink.access", {})).status, 401, "wink.access is the person's own: a device with no person session is asked to sign in");
  assert.equal((await over(c, "relay.status", {})).status, 200);
  assert.equal((await w.call("wink.access")).data.devices.length, 1);
});

shardTest("X-1, real daemon and relay: a server's QR redeemer reaches only wink.server.adopt; the pick at the server console decides; no or a timeout leaves nothing and spends the ticket", async t => {
  const w = await world(t, { pendingMs: 2500 });
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const scan = parseServerQr(made.qr);
  const r = await redeem(t, w, scan.seed, "Eve's app");
  assert.equal(r.paired.pending, true);
  assert.equal(await relayHas(w, r.paired.device), false, "no relay device for a server's scanner before the confirm");
  const c = r.open();
  for (const tool of PROBED) { const o = await over(c, tool, {}); assert.ok(o.status === 404 || o.status === 403 || o.status === 0, `${tool} is not reachable by a server's scanner (got ${o.status})`); }
  assert.equal((await over(c, "wink.phone.wait", {})).status, 404, "a server's scanner has no phone question to wait on");
  // its one door: wink.server.adopt, which only asks the person at the server; nobody owns the box and no device exists
  const me = (await w.call("wink.pair.targets", {})).data.targets[0];
  const owner = { kind: "identity", id: me.id, name: "Alex" };
  const na = newNonce(), commit = await nonceCommit(na), tag = await ticketTag(Buffer.from(scan.seed).toString("base64url"));
  const first = await over(c, "wink.server.adopt", { owner, identity: me.id, pairing: { commit, tag } });
  assert.equal(first.status, 200, JSON.stringify(first));
  const second = await over(c, "wink.server.adopt", { owner, identity: me.id, pairing: { commit, tag, reveal: na } });
  assert.equal(second.body.data.pending, true);
  assert.equal(await relayHas(w, r.paired.device), false, "asking made no device");
  assert.equal((await w.call("wink.access")).data.devices.some(d => d.id === "self"), false);
  // the question is the server console's: a model client, a hook, a paired device and the scanner itself cannot see or answer it
  const right = await pairWords(r.paired.box, r.paired.device, { ticket: Buffer.from(scan.seed).toString("base64url"), nonceA: na, nonceB: first.body.data.nb });
  for (const caller of ["mcp", "harness", "hook", "module:evil", "session:s1", "agent:kit", "tailnet:owner", `device:${r.paired.device}`, "anonymous"]) {
    assert.ok((await w.call("wink.server.pairing", {}, caller, PROOF)).error, `${caller} cannot see the question`);
    assert.ok((await w.call("wink.server.pair.answer", { yes: true, pick: 1 }, caller, PROOF)).error, `${caller} cannot answer it`);
  }
  const q = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data;
  assert.ok(q.asking && q.choices.includes(right));
  // the person says yes with the right pick: only then does the relay make the device, and the scanner's call returns the owner
  assert.equal((await w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(right) + 1 }, "cli", PROOF)).data.yes, true);
  const done = await over(c, "wink.server.adopt", { owner, identity: me.id, pairing: { commit, tag, reveal: na } });
  assert.ok(done.body?.data?.owner, JSON.stringify(done));
  const row = await until(() => deviceRow(w, r.paired.device));
  assert.ok(row, "the device exists after the yes");
  assert.equal(row.presence, true, "with its presence key, made only now");
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

shardTest("X-1 and the ring, real daemon and relay: device.paired says how the device came (via, and gate for a confirmed gated ticket); the ungated ring is the one a module-less relay still takes", async t => {
  const w = await world(t);
  const paired = () => w.events.filter(e => e[0] === "device.paired").map(e => e[1]);
  // a typed code (module-minted, ungated)
  await pairDevice(t, w);
  assert.equal(paired().at(-1).via, "module");
  assert.equal(paired().at(-1).gate, undefined);
  // a gated phone ticket, confirmed by the yes
  const open = (await w.call("wink.phone.open", {})).data;
  const scan = parsePhoneQr(open.qr);
  const r = await redeem(t, w, scan.seed, "Alex's iPhone");
  assert.equal(paired().length, 1, "no device.paired before the confirm");
  const mine = await askPhone(w, r.paired.device, scan.seed, "Alex's iPhone");
  const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(mine.words) + 1 });
  await until(() => paired().length === 2);
  assert.deepEqual([paired().at(-1).via, paired().at(-1).gate], ["module", "phone"]);
  // the ring: gated while the module confirms (via ring, gate ring), the old one-step ring only where nothing confirms (the test switch stands for a relay with no module)
  const ring = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const rr = await redeem(t, w, fromBase64url(ring.data.ticket), "Ring phone");
  assert.equal(rr.paired.pending, true);
  const ms = await askPhone(w, rr.paired.device, new Uint8Array(0), "Ring phone");
  const qq = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  await w.call("wink.phone.pair.answer", { yes: true, pick: qq.choices.indexOf(ms.words) + 1 });
  await until(() => paired().length === 3);
  assert.deepEqual([paired().at(-1).via, paired().at(-1).gate], ["ring", "ring"]);
  process.env.VYRE_TEST_UNGATED_RING = "1";
  t.after(() => { delete process.env.VYRE_TEST_UNGATED_RING; });
  const ring2 = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const open2 = await pairTicket(fromBase64url(ring2.data.ticket), { relay: w.status.url, name: "Old ring", crypto: nodeCrypto(), keyStore: keystore(t) });
  assert.notEqual(open2.pending, true, "with no confirmer the ring pairs as it always did");
  await until(() => paired().length === 4);
  assert.deepEqual([paired().at(-1).via, paired().at(-1).gate], ["ring", undefined]);
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
const linksFor = (t, f) => {
  const links = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "Alex's iPhone", sign: f.sign,
    channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) });
  t.after(() => links.close());
  return links;
};










// ---- the identity proof in the FIRST adopt call, checked against the names directory (lead ruling, 4 Oct) ----

/** One pairing attempt against a fresh real server; resolves the outcome and the server's world. */
async function attemptPairing(t, ident, { sign = ident.sign, owner = { id: ident.id, name: "Alex", vyre: "alex" }, answer = true } = {}) {
  const noProof = process.env.VYRE_TEST_PAIR_NO_PROOF;
  delete process.env.VYRE_TEST_PAIR_NO_PROOF;
  t.after(() => { if (noProof !== undefined) process.env.VYRE_TEST_PAIR_NO_PROOF = noProof; });
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const w = await world(t, { kernel: true });
  const code = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  let shown = "";
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "hardware" };
  const pairing = pairServer({ payload: code.qr, owner, deviceKind: "phone", presenceKey, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 100, ...(sign ? { signIdentity: sign } : {}), onWords: x => { shown = x; } });
  pairing.catch(() => {});
  const q = await until(async () => { const x = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; }, 3000).catch(() => null);
  if (q && answer) { await until(async () => shown); await w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 }, "cli", PROOF); }
  return { w, asked: Boolean(q), result: await pairing.then(r => ({ ok: r }), e => ({ err: e })) };
}























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

// ---- RC1: the typed code on a release build (user ruling 5 Oct 2026) ----
/** Turns the typed code to its release default (on; the development flag unset) for one test. @param {any} t */
const releaseTyped = t => { const saved = process.env.VYRE_WINK_TYPED_CODE; delete process.env.VYRE_WINK_TYPED_CODE; t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; }); };

shardTest("typed code, release: wink.phone.open gives the QR and a typed code on the same window; the code lasts 10 minutes, is single use, and ends the QR too", async t => {
  releaseTyped(t);
  const w = await world(t);
  const open = await w.call("wink.phone.open", {});
  assert.ok(open.data?.qr && open.data?.art, JSON.stringify(open.error));
  assert.match(open.data.code, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/, "the typed code beside the QR");
  assert.ok(open.data.code_offer);
  const life = open.data.code_expires - Date.now();
  assert.ok(life > 9 * 60_000 && life <= 10 * 60_000 + 2000, `10 minutes, not ${life} ms`);
  // asking again while it shows is the same code, not a churn of new ones
  assert.equal((await w.call("wink.phone.open", {})).data.code, open.data.code);
  const added = await addPhoneByCode(t, w, open.data.code, open.data.code_offer);
  assert.equal(added.typed.data.ok, true, JSON.stringify(added.typed.error));
  const done = await added.joining;
  assert.equal(done.paired, true, "the phone is paired when the ack is typed back: no three words to pick");
  assert.equal((await w.call("wink.access")).data.devices[0].kind, "phone");
  // used: the code does not work again, and the QR is spent with it
  const again = await joinWithCode({ relay: w.status.url, input: open.data.code, name: "Second phone", pollMs: 100, waitMs: 1500, pairOptions: { crypto: nodeCrypto(), keyStore: keystore(t) } });
  assert.equal(again.ok, false, "single use");
  assert.equal(await w.call("wink.phone.open", {}).then(r => r.data.code === open.data.code), false, "a fresh window, not the used code");
});

shardTest("typed code, release: three wrong tries close the code and a fresh one replaces it", async t => {
  releaseTyped(t);
  const w = await world(t);
  const open = await w.call("wink.phone.open", {});
  const good = open.data.code;
  const rv = good.replace(/-/g, "").slice(4, 6);
  const wrong = i => `WINK-${rv}${"0123"[i]}-${"ABCDEF"[i]}${"GHJKMN"[i]}${"PQRSTV"[i]}${"WXYZ01"[i]}`.replace(/(WINK-..)(.)-(....)/, (m, a, b, c) => `${a}${b}-${c}`);
  for (let i = 0; i < 3; i++) {
    const r = await joinWithCode({ relay: w.status.url, input: `WINK-${rv}${"23"[i % 2]}${"456"[i]}-${"789"[i]}ABC`, name: "Guesser", pollMs: 100, waitMs: 800, pairOptions: { crypto: nodeCrypto(), keyStore: keystore(t) } });
    assert.equal(r.ok, false, `wrong try ${i + 1} fails`);
  }
  // the third wrong try closed it: even the right code is refused now
  const late = await joinWithCode({ relay: w.status.url, input: good, name: "Late", pollMs: 100, waitMs: 800, pairOptions: { crypto: nodeCrypto(), keyStore: keystore(t) } });
  assert.equal(late.ok, false, "the closed code answers nothing");
  const fresh = await until(async () => { const s = await w.call("wink.code.status", {}); return s.data && s.data.code && s.data.code !== good ? s.data.code : null; }, 4000);
  assert.match(fresh, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});

shardTest("typed code, release: wink.code.carry is the spaces module's alone, and an invitation's link rides the typed code to wink.code.redeem and out of wink.pair.status", async t => {
  releaseTyped(t);
  const w = await world(t);
  const link = "https://northwind.vyre.run/join/inv_abc.eyJwaW4iOiJ4In0";
  assert.equal((await w.call("wink.code.carry", { link }, "cli")).error?.code, "no_such_tool", "internal: no surface reaches it");
  assert.equal((await w.call("wink.code.carry", { link }, "module:wink")).error?.code, "denied", "only the spaces module");
  assert.equal((await w.call("wink.code.carry", { link: "http://x" }, "module:spaces")).error?.code, "bad_input", "an https link only");
  const c = await w.call("wink.code.carry", { link, space: "northwind.vyre.run" }, "module:spaces");
  assert.match(c.data?.code, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/, JSON.stringify(c.error));
  for (const [type, payload] of w.events) assert.ok(!JSON.stringify(payload ?? {}).includes(c.data.code) && !JSON.stringify(payload ?? {}).includes("inv_abc"), `${type} never carries the code or the link`);
  // the invitee's side: type the code, show the ack
  assert.equal((await w.call("wink.code.redeem", { code: "no way!" })).error?.code, "bad_input");
  const r = await w.call("wink.code.redeem", { code: c.data.code, for: "invite" });
  assert.match(r.data?.ack, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/, JSON.stringify(r.error));
  assert.equal((await w.call("wink.pair.status", { pairing: r.data.pairing })).data.state, "waiting");
  // nothing is delivered until the inviter types the ack back; a wrong ack delivers nothing and closes the code
  await until(() => w.events.find(e => e[0] === "wink.found"));
  const typed = await w.call("wink.code.ack", { offer: c.data.offer, typed: r.data.ack });
  assert.equal(typed.data?.ok, true, JSON.stringify(typed.error));
  const done = await until(async () => { const s = (await w.call("wink.pair.status", { pairing: r.data.pairing })).data; return s.state === "done" ? s : null; }, 12_000);
  assert.deepEqual(done.invite, { link, space: "northwind.vyre.run" }, "the same link the long form is");
  assert.equal(done.ack, undefined);
});

shardTest("typed code, release: a wrong ack for an invitation's code delivers nothing", async t => {
  releaseTyped(t);
  const w = await world(t);
  const c = await w.call("wink.code.carry", { link: "https://northwind.vyre.run/join/inv_abc.x" }, "module:spaces");
  const r = await w.call("wink.code.redeem", { code: c.data.code });
  assert.ok(r.data?.ack, JSON.stringify(r.error));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: c.data.offer, typed: "WINK-0000-0000" })).data.ok, false);
  await new Promise(res => setTimeout(res, 2500));
  const s = (await w.call("wink.pair.status", { pairing: r.data.pairing })).data;
  assert.notEqual(s.state, "done");
  assert.equal(s.invite, undefined);
});

shardTest("typed code, release: the kill switch (wink.typedCode false) refuses every typed path", async t => {
  const saved = process.env.VYRE_WINK_TYPED_CODE; process.env.VYRE_WINK_TYPED_CODE = "0"; t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const w = await world(t);
  assert.equal((await w.call("wink.code.redeem", { code: "WINK-K7QM-4P2X" })).error?.code, "typed_code_off");
  assert.equal((await w.call("wink.code.carry", { link: "https://a.b/c" }, "module:spaces")).data.code, null);
  assert.equal((await w.call("wink.phone.open", {})).data.code, undefined, "the QR alone");
});

shardTest("typed code, release: a device with no box redeems an invitation's code with redeemInviteCode: the ack it shows is typed back, and the link comes out", async t => {
  releaseTyped(t);
  const { redeemInviteCode } = await import("../relay/client/join.js");
  const w = await world(t);
  const link = "https://northwind.vyre.run/join/inv_xyz.eyJwaW4iOiJ5In0";
  const c = await w.call("wink.code.carry", { link, space: "northwind.vyre.run" }, "module:spaces");
  assert.match(c.data?.code, /^WINK-/, JSON.stringify(c.error));
  /** @type {string} */ let ack = "";
  const redeeming = redeemInviteCode({ relay: w.status.url, input: c.data.code, onAck: a => { ack = a; }, pollMs: 100, waitMs: 20_000 });
  await until(() => ack);
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: c.data.offer, typed: ack })).data.ok, true);
  assert.deepEqual(await redeeming, { ok: true, link, space: "northwind.vyre.run" });
  assert.equal((await redeemInviteCode({ relay: w.status.url, input: "WINK-ZZZZ-ZZZZ", waitMs: 500, pollMs: 50 })).ok, false);
});

shardTest("typed code, release: a browser with no box pairs to the server by the code its phone shows (joinWithCode, about web): the ack typed back on the phone is the yes, and the device is a web device", async t => {
  releaseTyped(t);
  const w = await world(t);
  const open = await w.call("wink.code.open", { flow: "W2" });
  assert.match(open.data?.code, /^WINK-/, JSON.stringify(open.error));
  const states = [];
  const done = joinWithCode({ relay: w.status.url, input: open.data.code, name: "Sam's browser", onState: s => states.push(s), pollMs: 100, waitMs: 20_000, pairOptions: { crypto: nodeCrypto(), keyStore: keystore(t), about: { kind: "web" } } });
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code })).data.ok, true);
  const r = await done;
  assert.equal(r.ok, true, JSON.stringify(r));
  const dev = (await w.call("wink.access")).data.devices.find(d => d.id === r.paired.device);
  assert.ok(dev, "the browser is a device of the identity");
  // a wrong code pairs nothing
  assert.equal((await joinWithCode({ relay: w.status.url, input: "WINK-ZZZZ-ZZZZ", name: "x", waitMs: 500, pollMs: 50, pairOptions: { crypto: nodeCrypto(), keyStore: keystore(t) } })).ok, false);
});

shardTest("the camera reader: wink.phone.open and an invitation's code carry the avatar bytes of the same code, and addThisDevice takes them in place of typing", async t => {
  const saved = process.env.VYRE_WINK_TYPED_CODE; delete process.env.VYRE_WINK_TYPED_CODE; t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const { avatarBytesToCode } = await import("../relay/client/avatarcode.js");
  const { addThisDevice } = await import("../relay/client/phonepair.js");
  const w = await world(t);
  const open = (await w.call("wink.phone.open", {})).data;
  assert.equal(avatarBytesToCode(Buffer.from(open.avatar, "base64url")), open.code, "the avatar is the code, as a picture");
  // the phone that decoded the ring pairs with it: the typed code's own pairing, the ack typed back
  const phone = open;
  const key = crypto.generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  let ack = "";
  const joining = addThisDevice({ avatar: Buffer.from(phone.avatar, "base64url"), relay: w.status.url, key: { publicKey }, name: "Sam's phone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 50, onAck: a => { ack = a; } });
  joining.catch(() => {});
  await until(() => ack);
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: phone.code_offer, typed: ack })).data.ok, true);
  assert.equal((await joining).paired, true);
  // an invitation's code has its avatar too (a newer code replaces the one showing, so this comes after the pairing)
  const carry = (await w.call("wink.code.carry", { link: "https://northwind.vyre.run/join/inv_abc.x" }, "module:spaces")).data;
  assert.equal(avatarBytesToCode(Buffer.from(carry.avatar, "base64url")), carry.code);
  await assert.rejects(() => addThisDevice({ avatar: [1, 2, 3, 4, 5, 6, 7, 8], relay: w.status.url, key: { publicKey }, crypto: nodeCrypto(), keyStore: keystore(t) }), e => e.code === "bad_code");
});
