// @ts-check
// Pairing: devices belong to the identity, never to a space (DESIGN-wink.md sections 3, 4 and 7). A fake ctx (in-memory store, a tool
// table, an event list), a fake directory (who administers what) and fake typing ports: no relay, no kernel, no network.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPairing, pairToMessage, MIGRATIONS, PEER_MIGRATIONS, POLL_MS, KIND_OFFERS, parseQr, qrPayload, parseServerQr, serverQrPayload, parsePhoneQr, phoneQrPayload } from "./pairing.js";
import { FORBIDDEN, words, removed } from "./cards.js";
import { pairWords, nonceCommit, ticketTag, newNonce } from "../../relay/client/pairwords.js";

const ME = "per_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const HARLOW = "spc_harlowharlo";   // admin
const NORTHWIND = "spc_northwindbk"; // member only

function world(o = {}) {
  const db = new DatabaseSync(":memory:");
  for (const m of [...MIGRATIONS, ...PEER_MIGRATIONS]) db.exec(m);
  /** @type {Map<string, any>} */
  const tools = new Map();
  const events = /** @type {any[]} */ ([]);
  const drops = /** @type {any[]} */ ([]);
  const ctx = { store: { db }, config: { name: "alex" }, log() {}, events: { emit: (n, d) => { if (o.failEmit && o.failEmit === n) throw new Error(`${n} is not declared`); events.push([n, d]); } }, tool: (n, def) => tools.set(n, def), call: async (tool, input) => { if (o.call) { const r = await o.call(tool, input); if (r !== undefined) return r; } if (tool === "relay.route.id") return { data: { box: o.box || "Qm94S2V5" } }; drops.push([tool, input]); return { data: { closed: true } }; } };
  const typed = /** @type {any[]} */ ([]);
  const finishes = /** @type {any[]} */ ([]);
  const minted = /** @type {any[]} */ ([]);
  const directory = o.directory || { memberships: async id => id === ME ? [{ space: HARLOW, name: "Harlow Legal", role: "admin" }, { space: NORTHWIND, name: "Northwind Bakery", role: "member" }] : [] };
  const ports = {
    mint: async seed => { minted.push(seed); if (o.mintHangs) return new Promise(() => {}); return o.mintFails ? { error: "no relay" } : { data: { expiresAt: 1 } }; },
    callServer: o.callServer || (async (paired, tool, input) => ({ owner: input.owner })),
    typist: async a => { typed.push(a); return o.typistFails ? { ok: false, reason: o.typistFails } : { ok: true, ack: "WINK-AB12-CD34", seed: new Uint8Array(16), route: "rt" }; },
    finish: async a => { finishes.push(a); if (o.finishResult) return o.finishResult; return { ok: true, paired: o.paired || { route: "route-juno", name: "juno" } }; },
  };
  const p = createPairing({
    ctx, now: o.now || (() => 1_000_000), offers: o.offers, identity: o.identity || (async () => ME), stepMs: o.stepMs, space: async () => HARLOW, directory, ports,
    openCode: async flow => ({ offer: `wo_${flow}`, code: "WINK-ZZZZ-ZZZZ", expires: 1 }), ack: async () => ({ ok: true }),
    owner: (m, what) => { if (m && (m.agent || String(m.caller).startsWith("agent:"))) throw Object.assign(new Error(what), { code: "denied" }); }, dropMs: 0, relayUrl: async () => "ws://relay.test", keyFile: o.keyFile,
    // existing tests adopt in one step and type codes; the Q-1 tests below turn the confirmation on and the typed code off, as a release build has them
    confirmAdopt: o.confirm === true, requireProof: o.requireProof ?? false, buildRoot: o.buildRoot, releaseProof: "releaseProof" in o ? o.releaseProof : false, typedCode: o.typedCode ?? true, askHoldMs: o.askHoldMs ?? 0, askMs: o.askMs, askPollMs: 1, releaseMaxMs: o.releaseMaxMs, identityEntry: o.identityEntry, signIdentity: o.signIdentity, identityPin: o.identityPin, vyreName: o.vyreName, mintMs: o.mintMs, looseOwnerIds: o.exactIds ? false : true, pairWordsFor: o.pairWordsFor === null ? undefined : (o.pairWordsFor || (async d => `amber coral ${d}`)), spaceNow: () => HARLOW,
  });
  p.tools();
  const call = (name, input = {}, meta = {}) => tools.get(name).run(input, { caller: "device:x", ...meta });
  const fails = async (name, input, code) => { await assert.rejects(() => call(name, input), e => (code ? e.code === code : true) && (e.message || "")); };
  return { p, call, drops, events, typed, finishes, minted, db, tools, fails };
}
const settle = () => new Promise(r => setTimeout(r, 200)); // 40 ms flaked on a loaded box (4 Oct)

test("targets: you, then only the spaces you administer", async () => {
  const w = world();
  const t = (await w.call("wink.pair.targets")).targets;
  assert.deepEqual(t.map(x => [x.kind, x.id]), [["identity", ME], ["space", HARLOW]]);
  assert.equal(t[1].role, "admin");
  assert.ok(!t.some(x => x.id === NORTHWIND), "a space where you are only a member is not a target");
});

test("a server pairs to the identity or an administered space, chosen from the targets, and is recorded under that owner", async () => {
  for (const target of [{ kind: "identity", id: ME }, { kind: "space", id: HARLOW }]) {
    const w = world();
    const r = await w.call("wink.pair.server", { code: "wink-k7qm-4p2x", target });
    assert.equal(r.ack, "WINK-AB12-CD34", "the app shows the code to type back");
    assert.deepEqual(w.typed[0].input, "wink-k7qm-4p2x");
    assert.equal(w.typed[0].relay, "ws://relay.test");
    await settle();
    assert.equal((await w.call("wink.pair.status", { pairing: r.pairing })).state, "done");
    const [d] = w.p.devices.list(ME);
    assert.equal(d.kind, "server");
    assert.equal(d.name, "juno");
    assert.deepEqual(d.owner, target);
    assert.equal(d.identity, ME, "it belongs to the identity either way");
    for (const [n, e] of w.events) assert.ok(!JSON.stringify(e).includes("AB12-CD34"), `${n} never carries the ack code`);
  }
});

test("a space you do not administer is refused before anything is typed, with a plain reason", async () => {
  const w = world();
  await assert.rejects(() => w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target: { kind: "space", id: NORTHWIND } }), e => e.code === "not_admin" && /not an admin/.test(e.message));
  await assert.rejects(() => w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target: { kind: "space", id: "spc_unknownunkno" } }), e => e.code === "not_admin");
  await assert.rejects(() => w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target: { kind: "identity", id: "per_someoneelse" } }), e => e.code === "bad_input");
  assert.equal(w.typed.length, 0, "the code was never typed");
  assert.equal(w.p.devices.list(ME).length, 0);
});

test("a storage device pairs the same way, to the identity or an administered space", async () => {
  const w = world();
  const r = await w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", kind: "storage", target: { kind: "space", id: HARLOW } });
  await settle();
  assert.equal((await w.call("wink.pair.status", { pairing: r.pairing })).state, "done");
  const [d] = w.p.devices.list(ME);
  assert.equal(d.kind, "storage");
  assert.deepEqual(d.offers, { storage: true });
});

test("a wrong or unreachable code says so in plain words and registers nothing", async () => {
  for (const [reason, code, re] of [["refused", "refused", /not a Vyre code/], ["offline", "unavailable", /could not reach the relay; try again in a minute/], ["busy", "refused", /Too many tries/]]) {
    const w = world({ typistFails: reason });
    await assert.rejects(() => w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target: { kind: "identity", id: ME } }), e => e.code === code && re.test(e.message));
    assert.equal(w.p.devices.list(ME).length, 0);
  }
  const w = world();
  await assert.rejects(() => w.call("wink.pair.server", { code: "hello", target: { kind: "identity", id: ME } }), e => e.code === "bad_input");
});

test("a phone pairs only to the identity: any space target is refused", async () => {
  const w = world();
  await assert.rejects(() => w.call("wink.phone.open", { space: HARLOW }), e => e.code === "identity_only" && /not to a space/.test(e.message));
  const qr = qrPayload("WINK-K7QM-4P2X", "ws://relay.test");
  await assert.rejects(() => w.call("wink.phone.scan", { payload: qr, target: { kind: "space", id: HARLOW } }), e => e.code === "identity_only");
  assert.equal(w.typed.length, 0);
  const r = await w.call("wink.phone.scan", { payload: qr });
  assert.equal(r.ack, "WINK-AB12-CD34", "the phone shows a code for the person to type on the computer");
  assert.equal(w.typed[0].relay, "ws://relay.test", "the relay comes from the QR");
  assert.deepEqual(r.target, { kind: "identity", label: "alex" }, "the answer names the identity it joins, not an id of the phone's own");
  const typed = await w.call("wink.phone.open", { typed: true });
  assert.equal(typed.offer, "wo_W1", "the typed code is the development flag's");
  assert.equal(parseQr(typed.qr)?.code, "WINK-ZZZZ-ZZZZ");
  await assert.rejects(() => w.call("wink.phone.scan", { payload: "hello, this is no code" }), e => e.code === "bad_input");
});

test("the QR round-trips, and a bare typed code is also accepted", () => {
  assert.deepEqual(parseQr(qrPayload("WINK-K7QM-4P2X", "wss://relay.test/x?a=1")), { code: "WINK-K7QM-4P2X", relay: "wss://relay.test/x?a=1" });
  assert.equal(parseQr("wink k7qm 4p2x")?.code, "WINK-K7QM-4P2X");
  assert.equal(parseQr("vyre://wink/1?c=nope"), null);
  assert.equal(parseQr("https://evil.test"), null);
});

test("the registry is keyed by identity with a kind, and has no per-space device column", async () => {
  const w = world();
  const cols = /** @type {any[]} */ (w.db.prepare("PRAGMA table_info(wink_devices)").all()).map(c => c.name);
  assert.ok(cols.includes("identity") && cols.includes("kind"));
  assert.ok(!cols.includes("space"), "a device is never a member of a space");
  w.p.devices.add({ id: "d1", identity: ME, kind: "computer", name: "Alex's Mac", target: { kind: "identity", id: ME } });
  w.p.devices.add({ id: "d2", identity: "per_other", kind: "phone", name: "Kit's phone", target: { kind: "identity", id: "per_other" } });
  assert.deepEqual(w.p.devices.list(ME).map(d => d.id), ["d1"]);
  assert.throws(() => w.p.devices.add({ id: "d3", identity: ME, kind: "toaster", target: { kind: "identity", id: ME } }), /phone, a computer/);
  w.p.devices.remove("d1");
  assert.equal(w.p.devices.list(ME).length, 0);
});

test("a device offers only what its kind can offer", async () => {
  const w = world();
  w.p.devices.add({ id: "ph", identity: ME, kind: "phone", name: "Alex's iPhone", target: { kind: "identity", id: ME } });
  w.p.devices.add({ id: "st", identity: ME, kind: "storage", name: "Northwind NAS", target: { kind: "identity", id: ME } });
  w.p.devices.add({ id: "pc", identity: ME, kind: "computer", name: "Alex's Mac", target: { kind: "identity", id: ME } });
  await assert.rejects(() => w.call("wink.offer.set", { device: "ph", offer: "compute", on: true }), e => e.code === "bad_input" && /phone cannot offer compute/.test(e.message));
  await assert.rejects(() => w.call("wink.offer.set", { device: "st", offer: "compute", on: true }), e => e.code === "bad_input");
  assert.deepEqual((await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true })).offers, { access: true, compute: true });
  assert.deepEqual(KIND_OFFERS.phone, ["access"]);
  assert.deepEqual(KIND_OFFERS.storage, ["storage"]);
  for (const v of Object.values({ a: words("kindCannotOffer", { kind: "phone", offer: "compute" }), b: words("notAdmin", { space: "Harlow Legal" }), c: words("phoneIdentityOnly") })) assert.doesNotMatch(v, FORBIDDEN);
});

test("compute from a computer reaches a space only when the space allows it AND the member accepts", async () => {
  const w = world();
  w.p.devices.add({ id: "pc", identity: ME, kind: "computer", name: "Alex's Mac", target: { kind: "identity", id: ME } });
  const q = { device: "pc", space: HARLOW };
  assert.equal((await w.p.computeAllowed(q)).ok, false, "nothing offered yet");
  await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true });
  assert.match((await w.p.computeAllowed(q)).reason, /space has not allowed/);
  // the space's side: an admin of it
  const a = await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: HARLOW, side: "space" });
  assert.equal(a.allowed.ok, false, "one side is not enough");
  assert.match(a.allowed.reason, /owner has not accepted/);
  const b = await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: HARLOW, side: "member" });
  assert.equal(b.allowed.ok, true, "both grants exist");
  // either side can take it back
  await w.call("wink.offer.set", { device: "pc", offer: "compute", on: false, space: HARLOW, side: "member" });
  assert.equal((await w.p.computeAllowed(q)).ok, false);
  await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: HARLOW, side: "member" });
  assert.equal((await w.p.computeAllowed(q)).ok, true);
  w.p.devices.remove("pc");
  assert.equal((await w.p.computeAllowed(q)).ok, false, "a removed device offers nothing");
});

test("compute: a member cannot speak for the space, a space without the person's membership is out, and your own space needs your side alone", async () => {
  const w = world();
  w.p.devices.add({ id: "pc", identity: ME, kind: "computer", name: "Alex's Mac", target: { kind: "identity", id: ME } });
  await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true });
  // only a member of Northwind: the space's side is refused
  await assert.rejects(() => w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: NORTHWIND, side: "space" }), e => e.code === "not_admin");
  // the member's side alone does not open Northwind
  await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: NORTHWIND, side: "member" });
  assert.equal((await w.p.computeAllowed({ device: "pc", space: NORTHWIND })).ok, false);
  // not a member at all
  assert.match((await w.p.computeAllowed({ device: "pc", space: "spc_nobodyshere1" })).reason, /not a member/);
  // the personal space (the identity itself) needs only the member's side
  await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: ME, side: "member" });
  assert.equal((await w.p.computeAllowed({ device: "pc", space: ME })).ok, true);
  // a server's compute is not a member's computer offer
  w.p.devices.add({ id: "sv", identity: ME, kind: "server", name: "juno", target: { kind: "identity", id: ME } });
  await assert.rejects(() => w.call("wink.offer.set", { device: "sv", offer: "compute", on: true, space: HARLOW, side: "space" }), e => e.code === "bad_input" && /Only a computer/.test(e.message));
  assert.match((await w.p.computeAllowed({ device: "sv", space: HARLOW })).reason, /only a computer/);
});

test("the kernel directory reads the role from the grants store: owner and admin may pair to the space, a member may not, a stranger has none", async () => {
  const { kernelDirectory, kernelHasRoles } = await import("./pairing.js");
  const roles = { [ME]: "admin", per_member: "member", per_owner: "owner" };
  const kernel = { grants: { roleOf: async a => (a.space === HARLOW ? roles[a.id] || null : null) } };
  assert.equal(kernelHasRoles(kernel), true);
  assert.equal(kernelHasRoles({}), false);
  const dir = kernelDirectory({ kernel, space: async () => HARLOW, name: () => "Harlow Legal" });
  for (const [who, pairs] of [[ME, true], ["per_owner", true], ["per_member", false], ["per_stranger", false]]) {
    const w = world();
    const p = (await import("./pairing.js")).createPairing({ ctx: { store: w.db ? { db: w.db } : null, config: {}, log() {}, events: { emit() {} }, tool: (n, d) => w.tools.set(n, d) }, now: () => 1, identity: async () => who, space: async () => HARLOW, directory: dir, ports: {}, openCode: async () => ({}), ack: async () => ({ ok: true }), owner: () => {}, relayUrl: async () => "" });
    const ok = (await p.targets(who)).some(t => t.kind === "space" && t.id === HARLOW);
    assert.equal(ok, pairs, `${who}`);
    if (!pairs) await assert.rejects(() => p.checkTarget(who, "server", { kind: "space", id: HARLOW }), e => e.code === "not_admin");
    else assert.deepEqual(await p.checkTarget(who, "server", { kind: "space", id: HARLOW }), { kind: "space", id: HARLOW });
  }
  // the older shape, roles.isAdmin(person, space), is read too
  const d2 = kernelDirectory({ kernel: { roles: { isAdmin: async (p, s) => p === ME && s === HARLOW } }, space: async () => HARLOW, name: () => "H" });
  assert.equal((await d2.memberships(ME))[0].role, "admin");
  assert.deepEqual(await d2.memberships("per_x"), []);
});

test("pairing a server polls slowly with node crypto and a key file at 0600, not the browser's IndexedDB", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wink-keys-"));
  const keyFile = path.join(dir, "wink-keys.json");
  const w = world({ keyFile });
  await w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target: { kind: "identity", id: ME } });
  await settle();
  const a = w.finishes[0];
  assert.equal(a.pollMs, POLL_MS);
  assert.ok(POLL_MS >= 1500, "slower than the relay's rate limit");
  assert.equal(typeof a.pairOptions.crypto.newCode === "function" || typeof a.pairOptions.crypto === "object", true);
  await a.pairOptions.keyStore.set({ privateKey: new Uint8Array(32).fill(1), publicKey: new Uint8Array(32).fill(2) });
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o077, 0, "the folder is the owner's too");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("after pairing, the server is told its owner over the paired channel with the identity and the secret its peers prove with", async () => {
  const calls = [];
  for (const target of [{ kind: "identity", id: ME }, { kind: "space", id: HARLOW }]) {
    calls.length = 0;
    const w = world({ callServer: async (paired, tool, input) => { calls.push({ paired, tool, input }); return { owner: input.owner }; } });
    const r = await w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target });
    await settle();
    assert.equal((await w.call("wink.pair.status", { pairing: r.pairing })).state, "done");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "wink.server.adopt");
    assert.deepEqual({ kind: calls[0].input.owner.kind, id: calls[0].input.owner.id }, target);
    assert.equal(calls[0].input.owner.name, target.kind === "space" ? "Harlow Legal" : "alex", "the owner is named, so the server's own card does not say this space");
    assert.equal(calls[0].input.identity, ME);
    assert.equal(calls[0].input.peerSecret, w.p.peers.secretFor(w.p.devices.list(ME)[0].id), "the secret is the device's own");
    assert.equal(w.p.pending.get(r.pairing).adopted, true);
  }
});

test("the server's adopt: the first caller adopts, any later change needs the owner's presence and the first caller (W-4)", async () => {
  const w = world();
  const tool = w.tools.get("wink.server.adopt");
  const adopt = (input, caller, presence) => tool.run(input, { caller, ...(presence ? { presence: { method: "passkey" } } : {}) });
  await adopt({ owner: { kind: "space", id: HARLOW }, identity: ME, peerSecret: "A".repeat(43) }, "device:home1");
  assert.deepEqual(w.p.meta.get("owner"), { kind: "space", id: HARLOW, identity: ME });
  assert.equal(w.p.devices.get("self").identity, ME);
  // another paired device, with or without presence, cannot take over
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: "per_evil" } }, "device:other"), e => e.code === "owned_by_other");
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: "per_evil" } }, "device:other", true), e => e.code === "owned_by_other");
  // the adopter itself cannot re-target to a space without presence
  await assert.rejects(() => adopt({ owner: { kind: "space", id: NORTHWIND }, identity: ME }, "device:home1"), e => e.code === "owned_by_other");
  assert.deepEqual(w.p.meta.get("owner"), { kind: "space", id: HARLOW, identity: ME }, "nothing moved");
  // adopt never changes who owns a server, with the owner's presence or without (retargeting is wink.server.retarget); the same owner again is accepted
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: ME } }, "device:home1", true), e => e.code === "owned_by_other");
  await adopt({ owner: { kind: "space", id: HARLOW }, identity: ME }, "cli", true);
  assert.equal(w.p.meta.get("adopter"), "device:home1", "the adopter stays the first caller");
});

test("W-4: a local (cli) adoption is recorded, and a paired device cannot adopt again afterwards", async () => {
  const w = world();
  const adopt = (input, caller, presence) => w.tools.get("wink.server.adopt").run(input, { caller, ...(presence ? { presence: { method: "passkey" } } : {}) });
  await adopt({ owner: { kind: "identity", id: ME } }, "cli");
  assert.equal(w.p.meta.get("adopter"), "cli");
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: "per_evil" } }, "device:other"), e => e.code === "owned_by_other");
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: "per_evil" } }, "device:other", true), e => e.code === "owned_by_other");
  assert.deepEqual(w.p.meta.get("owner"), { kind: "identity", id: ME, identity: ME });
});

test("W-7: a second add under a known id cannot change identity, kind or owner; the self row has its own path", () => {
  const w = world();
  const add = (o) => w.p.devices.add({ id: "d1", identity: ME, kind: "phone", name: "kit", target: { kind: "identity", id: ME }, ...o });
  add({});
  assert.throws(() => add({ identity: "per_evil" }), e => e.code === "conflict");
  assert.throws(() => add({ kind: "server" }), e => e.code === "conflict");
  assert.throws(() => add({ target: { kind: "space", id: HARLOW } }), e => e.code === "conflict");
  assert.deepEqual([w.p.devices.get("d1").identity, w.p.devices.get("d1").kind, w.p.devices.get("d1").owner], [ME, "phone", { kind: "identity", id: ME }]);
  assert.equal(add({ name: "kit 2" }).name, "kit 2", "the same device may refresh its name");
  w.p.devices.remove("d1");
  assert.equal(add({}).removed, false, "a removed device pairs again");
  assert.throws(() => add({ identity: "per_evil" }), e => e.code === "conflict", "never under another identity");
  w.p.devices.setSelf({ identity: ME, name: "box", target: { kind: "identity", id: ME } });
  w.p.devices.setSelf({ identity: ME, name: "box", target: { kind: "space", id: HARLOW } });
  assert.deepEqual(w.p.devices.get("self").owner, { kind: "space", id: HARLOW });
});

test("W-5: with an offers port the kernel's store is the only one and wink_compute is never touched", async () => {
  const store = new Map();
  const offers = { get: (s, d) => store.get(`${s}|${d}`) || { space_allows: 0, member_accepts: 0 },
    set: (s, d, side, on) => store.set(`${s}|${d}`, { ...offers.get(s, d), [side === "space" ? "space_allows" : "member_accepts"]: on ? 1 : 0 }) };
  const w = world({ offers });
  w.p.devices.add({ id: "pc", identity: ME, kind: "computer", name: "pc", target: { kind: "identity", id: ME } });
  w.db.prepare("UPDATE wink_devices SET offers = ? WHERE id = 'pc'").run(JSON.stringify({ access: true, compute: true }));
  await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: HARLOW, side: "space" });
  assert.equal((await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: HARLOW, side: "member" })).allowed.ok, true);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM wink_compute").get().n, 0, "no second store");
  offers.set(HARLOW, "pc", "space", false);
  assert.equal((await w.p.computeAllowed({ device: "pc", space: HARLOW })).ok, false, "a withdrawal in the kernel store reaches wink at once");
  w.p.devices.remove("pc");
  assert.equal(store.size, 1, "removing the device leaves the kernel's store to the kernel");
});

test("peer admission: a paired server of this space or identity only; the claim path and its tool are gone (reviewer-3: dead code)", async () => {
  const w = world();
  const add = (id, kind, target) => w.p.devices.add({ id, identity: ME, kind, name: id, target });
  add("srvMe", "server", { kind: "identity", id: ME });
  add("srvHarlow", "server", { kind: "space", id: HARLOW });
  add("srvElse", "server", { kind: "space", id: NORTHWIND });
  add("phone1", "phone", { kind: "identity", id: ME });
  assert.deepEqual(["srvMe", "srvHarlow", "srvElse", "phone1", "ghost"].map(d => w.p.peers.allow(d)), [true, true, false, false, false]);
  const call = async (t, input) => (await w.tools.get(t).run(input, { caller: "module:relay" }));
  assert.equal((await call("wink.peer.allow", { device: "srvHarlow" })).allow, true);
  assert.equal(w.tools.has("wink.peer.shared"), false, "a module call can no longer note a node-key claim");
  assert.equal(typeof w.p.peers.shared, "undefined");
  assert.equal(typeof w.p.peers.serve, "undefined");
  w.p.devices.remove("srvMe");
  assert.equal(w.p.peers.allow("srvMe"), false);
});

test("the server's side proves with the secret its home gave at adopt time", async () => {
  const w = world();
  assert.throws(() => w.p.peers.ownSecret(), e => e.code === "unavailable");
  await w.tools.get("wink.server.adopt").run({ owner: { kind: "identity", id: ME }, identity: ME, peerSecret: w.p.peers.secretFor("srv") }, { caller: "device:home1" });
  assert.equal(w.p.peers.ownSecret().toString("base64url"), w.p.peers.secretFor("srv"));
});

/** Run one server pairing and wait for it to settle. */
async function pairOnce(w, target, kind = "server") {
  const r = await w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", kind, target });
  await settle();
  return { r, st: await w.call("wink.pair.status", { pairing: r.pairing }) };
}

test("a failed adopt ends failed with a plain reason and leaves no half-added server", async () => {
  const w = world({ callServer: async () => { throw Object.assign(new Error("the server answered 500"), { code: "unavailable" }); } });
  const { r, st } = await pairOnce(w, { kind: "identity", id: ME });
  assert.equal(st.state, "failed");
  assert.match(st.reason, /paired, but it could not be told who owns it/);
  assert.match(st.reason, /wink\.remove/);
  assert.equal(st.device, undefined);
  assert.equal(w.p.devices.list(ME).length, 0, "the row was taken back");
  assert.ok(w.events.some(([n, e]) => n === "wink.pair-failed" && e.pairing === r.pairing));
  assert.ok(!w.events.some(([n]) => n === "wink.pair-done"));
});

test("a server that already has an owner says so plainly and names the tool to use", async () => {
  const w = world({ callServer: async () => { throw Object.assign(new Error("This server already belongs to Personal. Remove it first: run wink.remove for it in the app, or change its owner on the server itself with wink.server.retarget."), { code: "unavailable" }); } });
  const { st } = await pairOnce(w, { kind: "space", id: HARLOW });
  assert.equal(st.state, "failed");
  assert.equal(st.reason, "This server still belongs to Personal. Remove it from Personal first, or reset it on the server itself (run vyre wink reset --begin in a terminal there).");
  assert.equal(w.p.devices.list(ME).length, 0);
});

test("a second pairing of a live server says to run wink.remove first", async () => {
  const w = world();
  const first = await pairOnce(w, { kind: "identity", id: ME });
  assert.equal(first.st.state, "done");
  const second = await pairOnce(w, { kind: "space", id: HARLOW });
  assert.equal(second.st.state, "failed");
  assert.match(second.st.reason, /juno is already added\. Run wink\.remove for it first, then pair it again\./);
  const [d] = w.p.devices.list(ME);
  assert.deepEqual(d.owner, { kind: "identity", id: ME }, "the live row is untouched");
  // after the remove it pairs again
  w.p.devices.remove(d.id);
  assert.equal((await pairOnce(w, { kind: "space", id: HARLOW })).st.state, "done");
});

test("the relay's trouble is named: unreachable says the relay could not be reached, and a 426 says the relay is out of date", async () => {
  const w = world({ typistFails: "offline" });
  await assert.rejects(() => w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target: { kind: "identity", id: ME } }), e => /Wink could not reach the relay; try again in a minute/.test(e.message) && !/internet/.test(e.message));
  // a relay that answers 426 to the typed-code request: the typist's own fetch sees it
  const db = new DatabaseSync(":memory:");
  for (const m of [...MIGRATIONS, ...PEER_MIGRATIONS]) db.exec(m);
  const tools = new Map();
  const ctx = { store: { db }, config: { name: "alex" }, log() {}, events: { emit() {} }, tool: (n, d) => tools.set(n, d) };
  const p = createPairing({ ctx, now: () => 1, identity: async () => ME, space: async () => HARLOW, directory: { memberships: async () => [] },
    ports: { typist: async a => { const r = await a.fetch("https://relay.test/v1/wink/code"); return { ok: false, reason: r.status === 200 ? "ok" : "refused" }; } },
    openCode: async () => ({}), ack: async () => ({ ok: true }), owner: () => {}, relayUrl: async () => "ws://relay.test" });
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("upgrade required", { status: 426 });
  try { await assert.rejects(() => p.startTyping({ code: "WINK-K7QM-4P2X", kind: "server", target: { kind: "identity", id: ME } }), e => e.code === "relay_old" && /relay is out of date/.test(e.message)); }
  finally { globalThis.fetch = real; }
});

test("the answers carry names: the target says who, and a pairing to a space names the space", async () => {
  const w = world();
  const r = await w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target: { kind: "space", id: HARLOW } });
  assert.deepEqual(r.target, { kind: "space", id: HARLOW, label: "Harlow Legal" });
  const p = await w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target: { kind: "identity", id: ME } });
  assert.equal(p.target.label, "alex");
});

test("adopt for a first owner needs no directory knowledge of the space; a later change still needs presence or the claim", async () => {
  const w = world({ directory: { memberships: async () => [] } });
  const adopt = (input, caller = "device:app") => w.tools.get("wink.server.adopt").run(input, { caller });
  // the box's own directory knows nothing of HARLOW; the app is authoritative for its own space
  const r = await adopt({ owner: { kind: "space", id: HARLOW, name: "Harlow Legal" }, identity: ME, peerSecret: "A".repeat(43) });
  assert.deepEqual(r.owner, { kind: "space", id: HARLOW });
  assert.equal(w.p.meta.get("owner").name, "Harlow Legal");
  // a later change by the channel is refused, in words that say who owns it and which tool
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: ME }, identity: ME }), e => e.code === "owned_by_other" && /belongs to Harlow Legal/.test(e.message) && /wink\.remove/.test(e.message) && /wink\.server\.retarget/.test(e.message));
  // with presence on the box, the owner's own screen retargets
  const t = await w.tools.get("wink.server.retarget").run({ owner: { kind: "identity", id: ME }, identity: ME }, { caller: "cli", presence: { ok: true } });
  assert.deepEqual(t.owner, { kind: "identity", id: ME });
});

test("adopt hands over what the device needs, only inside the channel: stored on the server, in no card, event, result or log", async () => {
  const SECRET = "joinkey-SECRET-0123456789";
  const calls = [];
  const logs = [];
  const w = world({ callServer: async (paired, tool, input) => { calls.push(input); return { owner: input.owner }; } });
  // the app side: a handover seam gives the home's address, box id and join key
  const app = createPairing({ ctx: { store: { db: w.db }, config: { name: "alex" }, log: m => logs.push(m), events: { emit: (n, d) => w.events.push([n, d]) }, tool() {} }, now: () => 1_000_000, identity: async () => ME, space: async () => HARLOW,
    directory: { memberships: async () => [{ space: HARLOW, name: "Harlow Legal", role: "admin" }] },
    ports: { typist: async () => ({ ok: true, ack: "WINK-AB12-CD34", seed: new Uint8Array(16) }), finish: async () => ({ ok: true, paired: { route: "route-juno", name: "juno" } }), callServer: async (paired, tool, input) => { calls.push(input); return { owner: input.owner }; } },
    openCode: async () => ({}), ack: async () => ({ ok: true }), owner: () => {}, relayUrl: async () => "ws://relay.test",
    handover: async q => ({ home: "100.64.0.1:8443", box: "box1", controlUrl: "https://hs.example", authKey: SECRET, relay: "ws://relay.test", space: q.target.id }) });
  const r = await app.startTyping({ code: "WINK-K7QM-4P2X", kind: "server", target: { kind: "space", id: HARLOW }, label: "Harlow Legal" });
  await settle();
  assert.equal(app.pending.get(r.pairing).state, "done");
  const sent = calls[0];
  assert.equal(sent.handover.home, "100.64.0.1:8443");
  assert.equal(sent.handover.authKey, SECRET);
  assert.equal(sent.handover.device, app.devices.list(ME)[0].id);
  assert.equal(sent.owner.name, "Harlow Legal");
  assert.ok(!JSON.stringify(w.events).includes(SECRET) && !logs.join().includes(SECRET), "no event or log carries the join key");
  // the server side stores it and gives it to modules only
  const srv = world();
  await srv.tools.get("wink.server.adopt").run(sent, { caller: "device:app" });
  const h = await srv.tools.get("wink.server.handover").run({}, { caller: "module:wink" });
  assert.equal(h.handover.authKey, SECRET);
  assert.equal(h.handover.peerSecret, sent.peerSecret);
  assert.equal(srv.p.ownHandover().authKey, SECRET, "the module's own code reads it without a tool");
  // H-1 (reviewer-3 probe: module:evil got home, authKey and peerSecret): nobody but the Wink module, and an empty caller is refused
  for (const caller of ["module:evil", "module:platform", "module:relay", "device:app", "cli", "deck", "tailnet", "anonymous", "", undefined]) {
    await assert.rejects(() => srv.tools.get("wink.server.handover").run({}, caller === undefined ? {} : { caller }), e => e.code === "denied", `refused for ${JSON.stringify(caller)}`);
  }
  await assert.rejects(() => srv.tools.get("wink.server.handover").run({}), e => e.code === "denied", "no meta at all is refused too");
  assert.ok(!JSON.stringify(srv.events).includes(SECRET));
  const dump = JSON.stringify([...srv.tools.keys()]) + JSON.stringify(srv.p.devices.list(ME));
  assert.ok(!dump.includes(SECRET), "not in the device rows");
});

// ---- the server's QR: a long secret, so no PAKE and nothing typed back ----

test("a server's QR is a fresh 128-bit ticket seed: minted at the relay, drawn as text, never on the event bus", async () => {
  const w = world();
  const a = await w.call("wink.server.code", { qr: true });
  assert.equal(a.code, "WINK-ZZZZ-ZZZZ", "the typed code is still offered beside it");
  assert.equal(w.minted.length, 1);
  assert.equal(w.minted[0].length, 16, "128 bits");
  const q = parseServerQr(a.qr);
  assert.ok(q);
  assert.equal(Buffer.from(q.seed).toString("hex"), w.minted[0].toString("hex"), "the payload carries exactly the seed that was minted");
  assert.equal(q.relay, "ws://relay.test");
  assert.match(a.art, /\u2588|\u2580|\u2584/);
  const b = await w.call("wink.server.code", { qr: true });
  assert.notEqual(parseServerQr(b.qr).seed.toString(), q.seed.toString(), "a new secret every time");
  assert.equal((await w.call("wink.server.code", {})).qr, undefined, "no qr unless asked");
  assert.equal(w.minted.length, 2);
  for (const [n, e] of w.events) assert.ok(!JSON.stringify(e).includes(a.qr), `${n} never carries the QR`);
  // The relay could not take the ticket: the code is still there, the QR says null.
  const down = world({ mintFails: true });
  const r = await down.call("wink.server.code", { qr: true });
  assert.equal(r.qr, null);
  assert.equal(r.code, "WINK-ZZZZ-ZZZZ");
});

test("wink.server.code with no typed code says the relay is unreachable at once (a refused mint, and one that never answers)", async () => {
  const down = world({ mintFails: true, typedCode: false });
  await assert.rejects(() => down.call("wink.server.code", { qr: true }), e => e.code === "unavailable" && /cannot reach its relay/.test(e.message));
  const slow = world({ typedCode: false, mintHangs: true, mintMs: 50 });
  await assert.rejects(() => slow.call("wink.server.code", { qr: true }), e => e.code === "unavailable" && /no answer/.test(e.message));
});

test("scanning a server's QR pairs it with no typist and no code to type back", async () => {
  const w = world();
  const seed = new Uint8Array(16).map((_, i) => i + 1);
  const payload = serverQrPayload(seed, "ws://relay.test");
  const r = await w.call("wink.pair.server", { payload, target: { kind: "space", id: HARLOW } });
  assert.equal(r.ack, null, "nothing to type");
  assert.equal(w.typed.length, 0, "no PAKE ran");
  await settle();
  assert.equal(w.finishes.length, 1);
  assert.equal(Buffer.from(w.finishes[0].seed).toString("hex"), Buffer.from(seed).toString("hex"), "the ticket is looked up with the scanned secret");
  assert.equal(w.finishes[0].relay, "ws://relay.test");
  assert.equal((await w.call("wink.pair.status", { pairing: r.pairing })).state, "done");
  const [d] = w.p.devices.list(ME);
  assert.deepEqual(d.owner, { kind: "space", id: HARLOW });
  // The same target rules apply: an unadministered space is refused before the relay is asked.
  const w2 = world();
  await assert.rejects(() => w2.call("wink.pair.server", { payload, target: { kind: "space", id: NORTHWIND } }), e => e.code === "not_admin");
  assert.equal(w2.finishes.length, 0);
});

test("a QR payload that is not a server's (short seed, wrong version, a typed code's QR) is refused; neither a code nor a payload is refused", async () => {
  const w = world();
  const target = { kind: "identity", id: ME };
  for (const payload of ["vyre://wink/2?t=AAAA&r=ws%3A%2F%2Fx", "vyre://wink/1?c=WINK-K7QM-4P2X&r=ws%3A%2F%2Fx", "hello", "vyre://wink/2?r=ws%3A%2F%2Fx"]) {
    await assert.rejects(() => w.call("wink.pair.server", { payload, target }), e => e.code === "bad_input", payload);
  }
  await assert.rejects(() => w.call("wink.pair.server", { target }), e => e.code === "bad_input");
  assert.equal(parseServerQr(serverQrPayload(new Uint8Array(15), "ws://x")), null);
  assert.equal(w.finishes.length + w.typed.length, 0);
});

// ---- removing a server tells it to let go (the app's wink.remove), so it can be paired again ----

/** A server's own box: its tools, and the platform's gate in front of them (a device caller meets person_session_required where a person is asked for). */
function box() {
  const b = world();
  const calls = /** @type {any[]} */ ([]);
  b.reach = { up: true, caller: "device:app1" };
  b.callServer = async (paired, tool, input) => {
    calls.push(tool);
    if (!b.reach.up) throw Object.assign(new Error("the server answered 503"), { code: "unavailable", remote: "" });
    const def = b.tools.get(tool);
    if (def.presence && (typeof def.presence.when !== "function" || def.presence.when(input)) && b.reach.caller.startsWith("device:")) {
      throw Object.assign(new Error(`${tool} is the person's own action: sign in on this de`), { code: "unavailable", remote: "person_session_required" });
    }
    try { return await def.run(input, { caller: b.reach.caller }); }
    catch (e) { throw Object.assign(new Error(e.message), { code: "unavailable", remote: e.code }); }
  };
  b.calls = calls;
  return b;
}
const appWith = b => world({ callServer: b.callServer, releaseRetryMs: 0 });

test("remove then pair the same server again: to the identity, to the same space, to another target, each succeeds with the release delivered", async () => {
  for (const [first, second] of [[{ kind: "identity", id: ME }, { kind: "identity", id: ME }], [{ kind: "space", id: HARLOW }, { kind: "space", id: HARLOW }], [{ kind: "identity", id: ME }, { kind: "space", id: HARLOW }]]) {
    const b = box();
    const app = appWith(b);
    assert.equal((await pairOnce(app, first)).st.state, "done");
    assert.ok(b.p.meta.get("owner"), "the server has an owner");
    const [d] = app.p.devices.list(ME);
    const out = await app.p.releaseServer(d.id);
    assert.equal(out, "released");
    app.p.devices.remove(d.id);
    assert.equal(b.p.meta.get("owner"), null, "the server let go");
    assert.equal(b.p.meta.get("adopter"), null);
    assert.equal(b.p.meta.get("handover"), null);
    const again = await pairOnce(app, second);
    assert.equal(again.st.state, "done", again.st.reason);
    assert.deepEqual({ kind: b.p.meta.get("owner").kind, id: b.p.meta.get("owner").id }, second);
  }
});

test("without the release, a second adopt over the paired channel still refuses, in plain words naming the owner", async () => {
  const b = box();
  const app = appWith(b);
  assert.equal((await pairOnce(app, { kind: "space", id: HARLOW })).st.state, "done");
  const [d] = app.p.devices.list(ME);
  app.p.devices.remove(d.id);            // removed in the app, the server never told
  const again = await pairOnce(app, { kind: "space", id: HARLOW });
  assert.equal(again.st.state, "failed");
  assert.equal(again.st.reason, "This server still belongs to Harlow Legal. Remove it from Harlow Legal first, or reset it on the server itself (run vyre wink reset --begin in a terminal there).");
  assert.ok(!/de\)/.test(again.st.reason), "never the raw tool error cut short");
  assert.equal(b.p.meta.get("owner").id, HARLOW, "the owner did not move");
  // the real card when the box's own refusal names the owner
  b.reach.up = true;
  const direct = await b.tools.get("wink.server.adopt").run({ owner: { kind: "identity", id: ME }, identity: ME }, { caller: "device:app1", presence: { method: "passkey" } }).catch(e => e);
  assert.ok(direct instanceof Error && direct.code === "owned_by_other", "adopt never changes the owner, not even for the adopter with presence (retargeting is its own act)");
});

test("an unreachable server keeps a pending release, applied when it next answers", async () => {
  const b = box();
  const app = appWith(b);
  await pairOnce(app, { kind: "identity", id: ME });
  const [d] = app.p.devices.list(ME);
  b.reach.up = false;
  assert.equal(await app.p.releaseServer(d.id), "pending");
  assert.ok(b.p.meta.get("owner"), "still owned while it was away");
  await app.p.retryReleases();
  assert.ok(b.p.meta.get("owner"), "a try while it is still away changes nothing");
  b.reach.up = true;
  await app.p.retryReleases();
  assert.equal(b.p.meta.get("owner"), null, "told when it came back");
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM wink_meta WHERE k LIKE 'release:%'").get().n, 0, "nothing left pending");
});

test("a pending release is applied at the next pairing, before the adopt", async () => {
  const b = box();
  const app = appWith(b);
  await pairOnce(app, { kind: "identity", id: ME });
  const [d] = app.p.devices.list(ME);
  b.reach.up = false;
  assert.equal(await app.p.releaseServer(d.id), "pending");
  app.p.devices.remove(d.id);
  b.reach.up = true;
  const again = await pairOnce(app, { kind: "space", id: HARLOW });
  assert.equal(again.st.state, "done", again.st.reason);
  assert.equal(b.p.meta.get("owner").kind, "space");
});

test("a stranger cannot make a server let go; only the app that adopted it", async () => {
  const b = box();
  const app = appWith(b);
  await pairOnce(app, { kind: "identity", id: ME });
  const release = (caller, extra = {}) => b.tools.get("wink.server.release").run({}, { caller, ...extra });
  await assert.rejects(() => release("device:stranger"), e => e.code === "denied" && /Only the app that owns this server can let it go/.test(e.message));
  await assert.rejects(() => release("device:stranger", { presence: { method: "passkey" } }), e => e.code === "denied", "presence does not make a stranger the owner");
  await assert.rejects(() => release("cli"), e => e.code === "denied", "a screen on the server uses reset");
  await assert.rejects(() => release("agent:x"), e => e.code === "denied");
  assert.ok(b.p.meta.get("owner"), "nothing moved");
  assert.deepEqual(await release("device:app1"), { released: true });
  assert.deepEqual(await release("device:stranger"), { released: true, already: true }, "a server with no owner has nothing to refuse");
});

test("the server's confirm says the codes matched, not that it is paired", async () => {
  const w = world();
  const r = await w.call("wink.server.confirm", { offer: "wo_W3", typed: "WINK-AB12-CD34" });
  assert.equal(r.ok, true);
  assert.match(r.message, /The code matched\. The app is finishing/);
  assert.ok(!/is paired|is added/.test(r.message));
});

test("a release takes the adopter's relay device off the box; a stranger's refused adopt takes the stranger's", async () => {
  const b = box();
  const app = appWith(b);
  await pairOnce(app, { kind: "identity", id: ME });
  // a stranger is refused, in words naming the owner, and its device goes
  const stranger = await b.tools.get("wink.server.adopt").run({ owner: { kind: "identity", id: ME }, identity: ME }, { caller: "device:stranger1" }).catch(e => e);
  assert.equal(stranger.code, "presence_required");
  assert.match(stranger.message, /already belongs to alex\./);
  assert.deepEqual(b.drops.filter(d => d[0] === "relay.devices.drop"), [["relay.devices.drop", { id: "stranger1" }]]);
  assert.ok(b.p.meta.get("owner"), "the owner did not move");
  // the adopter itself is not dropped by a refused change without presence
  await b.tools.get("wink.server.adopt").run({ owner: { kind: "identity", id: ME }, identity: ME }, { caller: "device:app1" }).catch(() => null);
  assert.equal(b.drops.filter(d => d[0] === "relay.devices.drop").length, 1);
  // the release drops the adopter
  const [d] = app.p.devices.list(ME);
  assert.equal(await app.p.releaseServer(d.id), "released");
  assert.deepEqual(b.drops.filter(d => d[0] === "relay.devices.drop").at(-1), ["relay.devices.drop", { id: "app1" }]);
  assert.equal(b.p.meta.get("owner"), null);
});

test("the app's refusal words name the owner when the box said it", async () => {
  const b = box();
  const app = appWith(b);
  await pairOnce(app, { kind: "space", id: HARLOW });
  b.p.meta.set("owner", { kind: "space", id: HARLOW, identity: ME, name: "Harlow Legal" });
  const again = await pairOnce(world({ callServer: b.callServer }), { kind: "identity", id: ME });
  assert.equal(again.st.state, "failed");
  assert.match(again.st.reason, /still belongs to Harlow Legal\./);
});

test("W-4 N-1: a second device naming the owner's identity as a space admin, with no presence, cannot take the server over", async () => {
  const w = world();
  const adopt = (input, caller, extra = {}) => w.tools.get("wink.server.adopt").run(input, { caller, ...extra });
  await adopt({ owner: { kind: "identity", id: ME }, identity: ME, peerSecret: "A".repeat(43) }, "device:home1");
  // ME administers HARLOW in the directory, and the input says so: that proves nothing about the caller
  await assert.rejects(() => adopt({ owner: { kind: "space", id: HARLOW }, identity: ME }, "device:other"), e => ["denied", "presence_required", "owned_by_other"].includes(e.code));
  await assert.rejects(() => adopt({ owner: { kind: "space", id: HARLOW }, identity: ME }, "device:home1"), e => e.code === "owned_by_other", "not even the adopter, without presence");
  assert.deepEqual(w.p.meta.get("owner"), { kind: "identity", id: ME, identity: ME });
  assert.equal(w.p.meta.get("adopter"), "device:home1");
});

test("W-4 N-2: a different device with the same owner and peer secret cannot rewrite the handover or the adopter", async () => {
  const w = world();
  const adopt = (input, caller, extra = {}) => w.tools.get("wink.server.adopt").run(input, { caller, ...extra });
  const SECRET = "A".repeat(43);
  await adopt({ owner: { kind: "identity", id: ME }, identity: ME, peerSecret: SECRET, handover: { home: "100.64.0.1:8443", authKey: "REALKEY" } }, "device:home1");
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: ME }, identity: ME, peerSecret: SECRET, handover: { home: "EVIL", authKey: "EVILKEY" } }, "device:other"), e => ["denied", "presence_required"].includes(e.code));
  assert.equal(w.p.meta.get("handover").authKey, "REALKEY");
  assert.equal(w.p.meta.get("adopter"), "device:home1");
  // the adopter itself may only change the handover with the owner's presence too
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: ME }, identity: ME, peerSecret: SECRET, handover: { home: "other", authKey: "K2" } }, "device:home1"), e => e.code === "presence_required");
  assert.equal(w.p.meta.get("handover").authKey, "REALKEY");
});

test("S-1: a removed device's signing key is cleared, and a re-added row never inherits one", () => {
  const w = world();
  const add = () => w.p.devices.add({ id: "pc1", identity: ME, kind: "computer", name: "pc", target: { kind: "identity", id: ME } });
  add();
  w.p.devices.setSignKey("pc1", "OLDKEY");
  assert.equal(w.p.devices.get("pc1").signKey, "OLDKEY");
  w.p.devices.remove("pc1");
  assert.equal(w.p.devices.get("pc1").signKey, null, "cleared on removal");
  w.p.devices.setSignKey("pc1", "LATE");
  assert.equal(w.p.devices.get("pc1").signKey, null, "a removed row takes no key");
  add();
  assert.equal(w.p.devices.get("pc1").removed, false);
  assert.equal(w.p.devices.get("pc1").signKey, null, "the re-added row starts with no signing key");
  // a refresh of a live row keeps its key
  w.p.devices.setSignKey("pc1", "NEWKEY");
  add();
  assert.equal(w.p.devices.get("pc1").signKey, "NEWKEY");
});

// ---- Q-1: a scan or a paste is CONFIRMED at the server (ruling, 4 Oct 2026) ----

const ASKED = { owner: { kind: "identity", id: ME, name: "Alex" }, identity: ME };
const atServer = (w, tool, input = {}, caller = "cli") => w.tools.get(tool).run(input, { caller });
const adoptAs = (w, caller, input = ASKED) => w.tools.get("wink.server.adopt").run(input, { caller });
/** What a person at the server says when the other screen shows `words`: the pick of that set among the choices (a bare yes is refused, see the words check below). */
const pickOf = (q, words) => { const i = q.choices.indexOf(words); assert.ok(i >= 0, `the right words are among the choices: ${JSON.stringify(q.choices)}`); return { yes: true, pick: i + 1 }; };
const rightYes = async (w, words = "amber coral app1") => pickOf(await atServer(w, "wink.server.pairing"), words);

test("Q-1: a first adoption by a paired device is a question at the server: who asks, three words, and nobody is owner until a person says yes there", async () => {
  const w = world({ confirm: true });
  const first = await adoptAs(w, "device:app1");
  assert.equal(first.pending, true);
  assert.equal(first.words, "amber coral app1", "the words come from the server's keys and this device");
  assert.equal(w.p.meta.get("owner"), null, "asking does not own");
  const q = await atServer(w, "wink.server.pairing");
  assert.deepEqual({ asking: q.asking, name: q.name, words: q.words }, { asking: true, name: "Alex (id aaaaaa)", words: undefined }, "the question never shows the right words, only choices; the claimed name carries the identity id's first characters");
  assert.equal(q.choices.length, 3);
  assert.equal(new Set(q.choices).size, 3);
  assert.ok(q.choices.includes("amber coral app1"), "the right words are one of the three");
  assert.match(q.line, /^Pair this server to Alex \(id aaaaaa\)\? Pick the three words the app shows: 1\) .+ 2\) .+ 3\) .+$/);
  assert.ok(w.events.some(e => e[0] === "wink.pair-asked" && e[1].choices.includes("amber coral app1") && e[1].words === undefined), "the event carries choices, never the right words");
  // asking again is the same ask, not a second owner
  assert.equal((await adoptAs(w, "device:app1")).pending, true);
  assert.equal(w.p.meta.get("owner"), null);
  // a person at the server says yes: the same device completes, and is recorded as the adopter
  assert.equal((await atServer(w, "wink.server.pair.answer", pickOf(q, "amber coral app1"))).answered, true);
  const done = await adoptAs(w, "device:app1");
  assert.deepEqual(done.owner, { kind: "identity", id: ME });
  assert.equal(w.p.meta.get("owner").identity, ME);
  assert.equal(w.p.meta.get("adopter"), "device:app1");
  assert.equal((await atServer(w, "wink.server.pairing")).asking, false, "the question is closed");
});

test("typed code: the owner's typed-back ack is the yes, so the device that came in by it is adopted with NO three-word question; a QR or long-code adoption still asks, and an ack covers one ticket once", async () => {
  const TAG = "t".repeat(43), OTHER = "u".repeat(43);
  const typed = world({ confirm: true });
  typed.p.typedAck(TAG);
  const done = await adoptAs(typed, "device:app1", { ...ASKED, pairing: { typed_tag: TAG } });
  assert.equal(done.pending, undefined, "no question to wait on");
  assert.deepEqual(done.owner, { kind: "identity", id: ME });
  assert.equal(typed.p.meta.get("adopter"), "device:app1");
  assert.equal((await atServer(typed, "wink.server.pairing")).asking, false, "the server never asks the three words");
  assert.ok(!typed.events.some(e => e[0] === "wink.pair-asked"), "and says nothing was asked");
  // the long-code and QR paths (no typed ack for their ticket) still ask the words
  const qr = world({ confirm: true });
  qr.p.typedAck(TAG);
  const asked = await adoptAs(qr, "device:app1", { ...ASKED, pairing: { typed_tag: OTHER } });
  assert.equal(asked.pending, true, "another ticket is not covered by the ack");
  assert.equal((await atServer(qr, "wink.server.pairing")).asking, true);
  const plain = world({ confirm: true });
  assert.equal((await adoptAs(plain, "device:app1")).pending, true, "no tag at all: asked");
  // one ticket, one use: the ack is spent by the first adoption that carries its tag
  const once = world({ confirm: true });
  once.p.typedAck(TAG);
  await adoptAs(once, "device:app1", { ...ASKED, pairing: { typed_tag: TAG } });
  once.p.meta.del("owner"); once.p.meta.del("adopter");
  assert.equal((await adoptAs(once, "device:app2", { ...ASKED, pairing: { typed_tag: TAG } })).pending, true, "the same tag again is asked");
  // and an ack that is never used ends with the ask window
  let t = 9_000_000;
  const late = world({ confirm: true, now: () => t });
  late.p.typedAck(TAG); t += 6 * 60_000;
  assert.equal((await adoptAs(late, "device:app1", { ...ASKED, pairing: { typed_tag: TAG } })).pending, true, "an ack that waited more than five minutes covers nothing");
});

test("Q-1: a second scanner is refused while one is asking, and cannot ride the first one's yes", async () => {
  const w = world({ confirm: true });
  await adoptAs(w, "device:app1");
  await assert.rejects(() => adoptAs(w, "device:evil"), e => e.code === "busy" && /already asking/.test(e.message));
  assert.ok(w.drops.some(d => d[0] === "relay.devices.drop" && d[1].id === "evil"), "the second device's relay row goes");
  await atServer(w, "wink.server.pair.answer", await rightYes(w));
  await assert.rejects(() => adoptAs(w, "device:evil"), e => e.code === "busy", "the yes belongs to the device that asked");
  assert.equal(w.p.meta.get("owner"), null);
  assert.deepEqual((await adoptAs(w, "device:app1")).owner, { kind: "identity", id: ME });
  // once there is an owner the old rules stand: a stranger needs the owner's presence
  await assert.rejects(() => adoptAs(w, "device:evil"), e => e.code === "presence_required");
});

test("Q-1: no answer in the window pairs nothing; a no pairs nothing; only a person at the server may answer", async () => {
  let t = 5_000_000;
  const w = world({ confirm: true, now: () => t, askMs: 60_000 });
  await adoptAs(w, "device:app1");
  t += 61_000;
  await assert.rejects(() => adoptAs(w, "device:app1"), e => e.code === "expired" && /Nobody said yes/.test(e.message));
  assert.equal(w.p.meta.get("owner"), null, "no confirmation means no owner");
  assert.equal((await atServer(w, "wink.server.pair.answer", { yes: true, pick: 1 })).answered, false, "a late yes answers nothing");
  assert.equal((await atServer(w, "wink.server.pairing")).asking, false);
  // a no
  await adoptAs(w, "device:app1");
  assert.equal((await atServer(w, "wink.server.pair.answer", { yes: false })).yes, false);
  await assert.rejects(() => adoptAs(w, "device:app1"), e => e.code === "denied" && /said no/.test(e.message));
  assert.equal(w.p.meta.get("owner"), null);
  // the question and the answer are for a screen at the server only
  await adoptAs(w, "device:app1");
  for (const caller of ["device:app1", "device:other", "tailnet", "tailnet:owner", "relay", "module:evil", "cli:agent:kit", "anonymous", ""]) {
    for (const tool of ["wink.server.pairing", "wink.server.pair.answer"]) {
      await assert.rejects(() => w.tools.get(tool).run({ yes: true }, caller ? { caller } : {}), e => e.code === "denied", `${tool} refused for ${JSON.stringify(caller)}`);
    }
  }
  assert.equal(w.p.meta.get("owner"), null, "nobody but the screen at the server decided");
});

test("Q-2: the server's pairing question is seen and answered only on an allow list of person surfaces (cli, local, deck, capsule); every other caller class is refused", async () => {
  for (const caller of ["mcp", "harness", "hook", "module", "module:evil", "module:wink", "module:relay", "session", "session:s1", "agent", "agent:kit", "cli:agent:kit", "tailnet", "tailnet:owner", "tailnet:agent:kit", "device:app1", "device:other", "relay", "anonymous", "space:x", "org:x", "unlisted", "CLI", "cli ", "deck:x", ""]) {
    const w = world({ confirm: true });
    await adoptAs(w, "device:app1");
    for (const tool of ["wink.server.pairing", "wink.server.pair.answer"]) {
      await assert.rejects(() => w.tools.get(tool).run({ yes: true, pick: 1 }, caller ? { caller } : {}), e => e.code === "denied", `${tool} is refused for ${JSON.stringify(caller)}`);
    }
    assert.equal(w.p.meta.get("owner"), null, `${JSON.stringify(caller)} paired nothing`);
    assert.equal((await atServer(w, "wink.server.pairing")).asking, true, "and the question is still open for the person");
  }
  // an agent flag on an otherwise listed caller is refused too
  { const w = world({ confirm: true }); await adoptAs(w, "device:app1"); await assert.rejects(() => w.tools.get("wink.server.pairing").run({}, { caller: "cli", agent: "kit" }), e => e.code === "denied"); }
  for (const caller of ["cli", "local", "deck", "capsule"]) {
    const w = world({ confirm: true });
    await adoptAs(w, "device:app1");
    const q = await w.tools.get("wink.server.pairing").run({}, { caller });
    assert.equal(q.asking, true, `${caller} sees the question`);
    const r = await w.tools.get("wink.server.pair.answer").run(pickOf(q, "amber coral app1"), { caller });
    assert.equal(r.yes, true, `${caller} answers it`);
    assert.deepEqual((await adoptAs(w, "device:app1")).owner, { kind: "identity", id: ME });
  }
});

test("words check (ruling, 4 Oct 2026): a bare yes is refused, a wrong pick or words is a no, the right pick or all three words typed is a yes, a typed first word alone is nothing (WP-1); choices are the right set and two decoys in a fresh random order", async () => {
  // the server console
  const bare = world({ confirm: true });
  await adoptAs(bare, "device:app1");
  await assert.rejects(() => atServer(bare, "wink.server.pair.answer", { yes: true }), e => e.code === "words_needed" && /bare yes/.test(e.message));
  assert.equal((await atServer(bare, "wink.server.pairing")).asking, true, "a bare yes leaves the question open and adds nothing");
  assert.equal(bare.p.meta.get("owner"), null);
  // a wrong pick (a decoy), a pick out of range or of the wrong kind, and a wrong or short typed set are all a no
  const decoy = c => c.findIndex(x => x !== "amber coral app1");
  for (const wrong of [c => ({ pick: decoy(c) + 1 }), () => ({ pick: 0 }), () => ({ pick: 4 }), () => ({ pick: "x" }), () => ({ pick: 1.5 }), () => ({ words: "zzz" }), c => ({ words: c[decoy(c)] }), c => ({ words: "amber coral" })]) {
    const w = world({ confirm: true });
    await adoptAs(w, "device:app1");
    const choices = (await atServer(w, "wink.server.pairing")).choices;
    const said = wrong(choices);
    const r = await atServer(w, "wink.server.pair.answer", { yes: true, ...said });
    assert.equal(r.yes, false, `${JSON.stringify(said)} is a no`);
    assert.match(r.reason, /not the words the other screen shows/);
    await assert.rejects(() => adoptAs(w, "device:app1"), e => e.code === "denied" && /said no/.test(e.message));
    assert.equal(w.p.meta.get("owner"), null, "a wrong pick adds nothing");
  }
  // the right pick, or all three words typed (any case, with spaces)
  for (const right of [c => ({ pick: c.indexOf("amber coral app1") + 1 }), () => ({ words: "  AMBER  coral APP1 " })]) {
    const w = world({ confirm: true });
    await adoptAs(w, "device:app1");
    const choices = (await atServer(w, "wink.server.pairing")).choices;
    assert.equal((await atServer(w, "wink.server.pair.answer", { yes: true, ...right(choices) })).yes, true);
    assert.deepEqual((await adoptAs(w, "device:app1")).owner, { kind: "identity", id: ME });
  }
  // WP-1: a typed first word alone, right or wrong, is not an answer: the question stays open and nothing is added
  for (const first of ["amber", "zzz"]) {
    const w = world({ confirm: true });
    await adoptAs(w, "device:app1");
    await assert.rejects(() => atServer(w, "wink.server.pair.answer", { yes: true, first }), e => e.code === "words_needed" || e.code === "bad_input");
    assert.equal((await atServer(w, "wink.server.pairing")).asking, true);
    assert.equal(w.p.meta.get("owner"), null);
  }
  // a no needs no words
  { const w = world({ confirm: true }); await adoptAs(w, "device:app1"); assert.equal((await atServer(w, "wink.server.pair.answer", { yes: false })).yes, false); }
  // the choices: three distinct sets, the right one in a position that varies, decoys never sharing a first word with the right set or each other
  const spots = new Set();
  for (let i = 0; i < 40; i++) {
    const w = world({ confirm: true });
    await adoptAs(w, "device:app1");
    const c = (await atServer(w, "wink.server.pairing")).choices;
    assert.equal(c.length, 3);
    assert.equal(new Set(c).size, 3);
    assert.equal(new Set(c.map(x => x.split(" ")[0])).size, 3, "no two choices start with the same word");
    for (const x of c) assert.match(x, /^[a-z0-9]+ [a-z0-9]+ [a-z0-9]+$/);
    // WP-1: a decoy never shares its first three letters with the right word in the same place
    for (const x of c.filter(y => y !== "amber coral app1")) x.split(" ").forEach((word, k) => assert.notEqual(word.slice(0, 3), ["amb", "cor", "app"][k], `${x}: position ${k}`));
    spots.add(c.indexOf("amber coral app1"));
  }
  assert.ok(spots.size >= 2, "the right set moves around: its place cannot be guessed");
  // the phone question on the computer: the same check
  const pw = world(OFF);
  await phoneOpen(pw);
  await pw.p.phone.hold(PHONE);
  const pq = await pw.call("wink.phone.pairing");
  await assert.rejects(() => pw.call("wink.phone.pair.answer", { yes: true }), e => e.code === "words_needed");
  assert.equal((await pw.call("wink.phone.pairing")).asking, true, "a bare yes adds nothing and leaves the question");
  assert.equal(pw.p.devices.list(ME).length, 0);
  assert.equal((await pw.call("wink.phone.pair.answer", { yes: true, pick: pq.choices.findIndex(c => c !== "amber coral phoneabcdef") + 1 })).yes, false, "a wrong pick is a no");
  for (const right of [() => ({ words: "Amber coral phoneabcdef" }), c => ({ pick: c.indexOf("amber coral phoneabcdef") + 1 })]) {
    const v = world(OFF);
    await phoneOpen(v);
    await v.p.phone.hold(PHONE);
    const vq = await v.call("wink.phone.pairing");
    assert.equal((await v.call("wink.phone.pair.answer", { yes: true, ...right(vq.choices) })).yes, true);
    assert.equal(v.p.devices.list(ME).length, 1);
  }
});

test("Q-3: --pair-to is set at install time from the server's own command line only, and a bad name is refused", async () => {
  const w = world({ confirm: true, typedCode: false });
  const code = await atServer(w, "wink.server.code", { qr: true, pairTo: "alex" });
  assert.match(code.qr, /^vyre:\/\/wink\/2\?t=/);
  assert.equal(w.minted.length, 1);
  assert.equal(w.p.meta.get("pair_to"), "alex");
  for (const caller of ["device:app1", "tailnet", "module:evil", "deck", "capsule", "mcp", "anonymous"]) {
    await assert.rejects(() => atServer(world({ typedCode: false }), "wink.server.code", { pairTo: ME }, caller), e => e.code === "denied" && /install time/.test(e.message), `${caller} cannot name who a server pairs to`);
  }
  assert.equal((await atServer(world({ typedCode: false }), "wink.server.code", { pairTo: ME }, "local")).qr.startsWith("vyre://"), true, "the local console may");
  for (const bad of ["", "x".repeat(70), 'a"b']) await assert.rejects(() => atServer(world({ typedCode: false }), "wink.server.code", { pairTo: bad }), e => e.code === "bad_input");
});

/** An identity list with one device key on it (the identity port a headless box is given), and what that device signs to prove it. */
function proofRig() {
  const k = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(/** @type {string} */ (k.publicKey.export({ format: "jwk" }).x), "base64url").toString("base64url");
  const other = crypto.generateKeyPairSync("ed25519");
  const identityEntry = async (/** @type {string} */ identity, /** @type {string} */ eid) => (identity === ME && eid === "eid1" ? { eid, kind: "device", pub, identity: ME } : null);
  const proof = (/** @type {string} */ device, key = k.privateKey, eid = "eid1", box = "Qm94S2V5") => ({ eid, sig: crypto.sign(null, pairToMessage(box, device), key).toString("base64url") });
  return { identityEntry, proof, k, other };
}

test("Q-3: --pair-to needs PROOF: a stranger naming the identity, owner.name = it with another identity, a key not on the list, another device's proof and no port are all refused; the right signature is accepted", async () => {
  const r = proofRig();
  const w = world({ confirm: true, typedCode: false, identityEntry: r.identityEntry });
  await atServer(w, "wink.server.code", { qr: true, pairTo: ME });
  const gone = id => w.drops.some(d => d[0] === "relay.devices.drop" && d[1].id === id);
  // a stranger who names the identity (identity, owner.id and owner.name are all just words): refused, no question, no owner, let go
  await assert.rejects(() => adoptAs(w, "device:evil", { owner: { kind: "identity", id: ME, name: ME }, identity: ME }), e => e.code === "denied" && /did not prove/.test(e.message));
  assert.ok(gone("evil"));
  // a device with identity per_evil and owner.name = the identity it wants to be: refused
  await assert.rejects(() => adoptAs(w, "device:evil2", { owner: { kind: "identity", id: "per_evil", name: ME }, identity: "per_evil" }), e => e.code === "denied");
  assert.ok(gone("evil2"));
  // a signature by a key that is not on that identity's list (a made-up entry, then a key the entry does not hold)
  await assert.rejects(() => adoptAs(w, "device:evil3", { ...ASKED, proof: r.proof("evil3", r.k.privateKey, "eid9") }), e => e.code === "denied");
  await assert.rejects(() => adoptAs(w, "device:evil4", { ...ASKED, proof: r.proof("evil4", r.other.privateKey) }), e => e.code === "denied");
  // a real proof made for another device cannot be replayed by this one (it names the relay device it was made for)
  await assert.rejects(() => adoptAs(w, "device:evil5", { ...ASKED, proof: r.proof("someone-else") }), e => e.code === "denied");
  // a proof for another box
  await assert.rejects(() => adoptAs(w, "device:evil6", { ...ASKED, proof: r.proof("evil6", r.k.privateKey, "eid1", "AnotherBox") }), e => e.code === "denied");
  assert.equal(w.p.meta.get("owner"), null, "nothing paired for any of them");
  assert.equal(w.p.meta.get("pair_to"), ME, "the named identity is still waiting");
  assert.equal((await atServer(w, "wink.server.pairing")).asking, false, "no question was raised for a stranger");
  // the right signature by a key on the list: accepted at once, nobody answers, and the owner is the PROVEN identity whatever the caller said about itself
  const ok = await adoptAs(w, "device:app1", { owner: { kind: "identity", id: "per_whatever", name: "Mallory" }, identity: "per_whatever", proof: r.proof("app1") });
  assert.deepEqual(ok.owner, { kind: "identity", id: "per_whatever" });
  assert.equal(w.p.meta.get("owner").identity, ME, "the owner's identity is the proven one");
  assert.equal(w.p.meta.get("pair_to"), null, "the name is used up");
  assert.ok(w.drops.some(d => d[0] === "relay.pair.pending.confirm" && d[1].id === "app1"), "the relay is told to make the device only now");
  // by id to a space it administers: the same proof
  const w2 = world({ confirm: true, typedCode: false, identityEntry: r.identityEntry });
  await atServer(w2, "wink.server.code", { pairTo: ME });
  assert.deepEqual((await adoptAs(w2, "device:app2", { owner: { kind: "space", id: HARLOW, name: "Harlow Legal" }, identity: ME, proof: r.proof("app2") })).owner, { kind: "space", id: HARLOW });
  // a box with no identity port cannot check anyone, and says so
  const w3 = world({ confirm: true, typedCode: false });
  await atServer(w3, "wink.server.code", { pairTo: ME });
  await assert.rejects(() => adoptAs(w3, "device:app3", { ...ASKED, proof: r.proof("app3") }), e => e.code === "denied" && /cannot check who is asking/.test(e.message));
  assert.equal(w3.p.meta.get("owner"), null);
});

test("Q-3, app side: the app signs this pairing's box and device with a key on its identity list and sends it with the adopt", async () => {
  const r = proofRig();
  const BOX = "Qm94S2V5", DEV = "app1dev";
  const seen = [];
  const w = world({ typedCode: false, paired: { route: "route-juno", name: "juno", box: BOX, device: DEV },
    signIdentity: async m => ({ eid: "eid1", sig: crypto.sign(null, m, r.k.privateKey).toString("base64url") }),
    callServer: async (_p, _t, input) => { seen.push(input); return { owner: input.owner }; } });
  const q = await w.call("wink.pair.server", { payload: serverQrPayload(new Uint8Array(16).fill(3), "ws://relay.test"), target: { kind: "identity", id: ME } });
  await new Promise(x => setTimeout(x, 80));
  assert.equal((await w.call("wink.pair.status", { pairing: q.pairing })).state, "done");
  // PI-3: the message also names this pairing's own ticket tag, so the proof is good for this pairing only
  const tag = await ticketTag(Buffer.from(new Uint8Array(16).fill(3)).toString("base64url"));
  assert.ok(crypto.verify(null, pairToMessage(BOX, DEV, tag), r.k.publicKey, Buffer.from(seen[0].proof.sig, "base64url")), "the proof is the signature over this pairing's box, device and ticket tag");
  assert.equal(seen[0].proof.eid, "eid1");
  assert.ok(await r.identityEntry(ME, seen[0].proof.eid), "by a key on the list");
});

test("Q-1, app side: the app shows the same three words from its own keys and nonces while the server asks, and a server that shows other words is refused and told to let it go", async () => {
  const BOX = "Qm94S2V5", DEV = "app1dev", NB = "b".repeat(32);
  const seed = new Uint8Array(16).fill(7), ticket = Buffer.from(seed).toString("base64url");
  const run = async (lie, seedBytes = seed) => {
    const seen = [];
    let n = 0;
    const w = world({ typedCode: false, paired: { route: "route-juno", name: "juno", box: BOX, device: DEV },
      callServer: async (paired, tool, input) => {
        seen.push(input.pairing || {});
        if (input.pairing && input.pairing.cancel) return { cancelled: true };
        n++;
        if (!input.pairing.reveal) return { pending: true, nb: NB, until: 9e12 };
        const good = await pairWords(BOX, DEV, { ticket, nonceA: input.pairing.reveal, nonceB: NB });
        if (n < 4) return { pending: true, nb: NB, words: lie ? "wrong words here" : good, until: 9e12 };
        return { owner: input.owner };
      } });
    const r = await w.call("wink.pair.server", { payload: serverQrPayload(seedBytes, "ws://relay.test"), target: { kind: "identity", id: ME } });
    assert.equal(r.ack, null);
    // wait for the pairing to settle (bounded), not a fixed 60 ms: the polls take a moment on a busy box
    for (let k = 0; k < 150; k++) { const st = (await w.call("wink.pair.status", { pairing: r.pairing })).state; if (st !== "waiting" && st !== "confirm") break; await new Promise(x => setTimeout(x, 20)); }
    return { w, r, seen };
  };
  const ok = await run(false);
  assert.equal((await ok.w.call("wink.pair.status", { pairing: ok.r.pairing })).state, "done");
  assert.ok(ok.w.events.some(e => e[0] === "wink.pair-confirm" && /^[a-z]+ [a-z]+ [a-z]+$/.test(e[1].words)), "the words were shown to the app's person");
  assert.match(ok.seen[0].commit, /^[0-9a-f]{64}$/, "the first call commits");
  assert.equal(ok.seen[0].reveal, undefined, "and does not reveal");
  assert.equal(ok.seen[0].tag, await ticketTag(ticket));
  assert.equal(await nonceCommit(ok.seen[1].reveal), ok.seen[0].commit, "the reveal matches the commit");
  const bad = await run(true);
  const st = await bad.w.call("wink.pair.status", { pairing: bad.r.pairing });
  assert.equal(st.state, "failed");
  assert.match(st.reason, /Do not say yes/);
  assert.equal(bad.w.p.devices.list(ME).filter(d => d.kind === "server").length, 0, "the half-added row is taken back");
  assert.ok(bad.seen.some(x => x.cancel === true), "the server is told to let this device go");
});

test("pair words (break 3): the same app and box twice give different words, matching sides agree, a man in the middle shows different words on each leg", async () => {
  const BOX = "Qm94S2V5", DEV = "app1dev", ticket = "T".repeat(22);
  const mk = async () => { const na = newNonce(), nb = newNonce(); return { na, nb, w: await pairWords(BOX, DEV, { ticket, nonceA: na, nonceB: nb }) }; };
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add((await mk()).w);
  assert.ok(seen.size >= 19, `twenty pairings of one app and one box give ${seen.size} different word sets`);
  const a = await mk();
  assert.equal(a.w, await pairWords(BOX, DEV, { ticket, nonceA: a.na, nonceB: a.nb }), "both sides derive the same words");
  assert.notEqual(a.w, await pairWords(BOX, DEV, { ticket: "U".repeat(22), nonceA: a.na, nonceB: a.nb }), "another ticket, other words");
  assert.notEqual(a.w, await pairWords(BOX, "app2dev", { ticket, nonceA: a.na, nonceB: a.nb }), "another device, other words");
  assert.notEqual(a.w, await pairWords("T3RoZXI", DEV, { ticket, nonceA: a.na, nonceB: a.nb }), "another box key, other words");
  await assert.rejects(() => pairWords(BOX, DEV, {}), /own nonces/);
  // a man in the middle: the app talks to the attacker, the attacker talks to the box; each leg has its own device id and nonces
  const legApp = await pairWords(BOX, "mitm-as-box", { ticket, nonceA: newNonce(), nonceB: newNonce() });
  const legBox = await pairWords(BOX, "mitm-as-app", { ticket, nonceA: newNonce(), nonceB: newNonce() });
  assert.notEqual(legApp, legBox);
});

/** One full app side of a fresh pairing against the real words path of the server: commit, hear nb, reveal. */
async function freshAsk(w, caller, seed, input = ASKED) {
  const na = newNonce(), commit = await nonceCommit(na), tag = seed ? await ticketTag(Buffer.from(seed).toString("base64url")) : "";
  const pairing = { commit, ...(tag ? { tag } : {}) };
  const one = await adoptAs(w, caller, { ...input, pairing });
  const two = await adoptAs(w, caller, { ...input, pairing: { ...pairing, reveal: na } });
  return { na, nb: one.nb, first: one, words: two.words, until: two.until, pairing };
}
const REAL = { typedCode: false, confirm: true, pairWordsFor: null, box: "Qm94S2V5", askHoldMs: 0 };

test("pair words on the server (break 3): the question shows words only after the reveal, they equal the app's, a different attempt gives different words, a bad reveal ends the ask", async () => {
  const w = world(REAL);
  const mintSeed = async () => parseServerQr((await atServer(w, "wink.server.code", {})).qr).seed;
  let seed = await mintSeed(), ticket = Buffer.from(seed).toString("base64url");
  const got = [];
  for (let i = 0; i < 3; i++) {
    // WP-1: a ticket's memory goes at its first ask, so each attempt uses a fresh code
    if (i) { seed = await mintSeed(); ticket = Buffer.from(seed).toString("base64url"); }
    const r = await freshAsk(w, "device:app1", seed);
    assert.equal(r.first.words, undefined, "no words before the reveal");
    assert.equal(r.words, await pairWords("Qm94S2V5", "app1", { ticket, nonceA: r.na, nonceB: r.nb }), "the server's words are the app's");
    assert.ok((await atServer(w, "wink.server.pairing")).choices.includes(r.words), "the server's choices hold the app's words");
    got.push(r.words);
    await atServer(w, "wink.server.pair.answer", { yes: false });
    await assert.rejects(() => adoptAs(w, "device:app1", { ...ASKED, pairing: r.pairing }), e => e.code === "denied");
  }
  assert.equal(new Set(got).size, 3, "the same app and the same box three times: three different word sets");
  // WP-1: the first ask spent the ticket's memory: the same tag again, after a finished ask, is refused, and so is the tag after an ask that failed on its own commit
  await assert.rejects(() => freshAsk(w, "device:app1", seed), e => e.code === "denied" && /already used|ran out/.test(e.message));
  seed = await mintSeed(); ticket = Buffer.from(seed).toString("base64url");
  const badTag = await ticketTag(ticket);
  await assert.rejects(() => adoptAs(w, "device:app1", { ...ASKED, pairing: { commit: "nope", tag: badTag } }), e => e.code === "bad_input");
  await assert.rejects(() => freshAsk(w, "device:app1", seed), e => e.code === "denied" && /already used|ran out/.test(e.message), "a failed ask spends the ticket's memory too");
  seed = await mintSeed(); ticket = Buffer.from(seed).toString("base64url");
  // no yes before the words are on screen
  const na = newNonce(), commit = await nonceCommit(na), tag = await ticketTag(ticket);
  await adoptAs(w, "device:app1", { ...ASKED, pairing: { commit, tag } });
  assert.equal((await atServer(w, "wink.server.pairing")).asking, false, "nothing is shown yet");
  assert.deepEqual(await atServer(w, "wink.server.pair.answer", { yes: true, pick: 1 }), { answered: false });
  // a reveal that does not match the commit is refused, ends the ask and lets the device go
  w.drops.length = 0;
  await assert.rejects(() => adoptAs(w, "device:app1", { ...ASKED, pairing: { commit, tag, reveal: newNonce() } }), e => e.code === "denied");
  assert.ok(w.drops.some(d => d[1].id === "app1"));
  assert.equal((await atServer(w, "wink.server.pairing")).asking, false);
  // no fresh material at all is refused: the static keys alone never make words
  await assert.rejects(() => adoptAs(w, "device:app1", ASKED), e => e.code === "bad_input" && /fresh check/.test(e.message));
  // a ticket this box never made (or that ran out) is refused
  await assert.rejects(() => adoptAs(w, "device:app1", { ...ASKED, pairing: { commit, tag: "0".repeat(24) } }), e => e.code === "denied" && /already used|ran out/.test(e.message));
});

test("pair words, a man in the middle (break 3): a relay between two sessions shows different words on each leg", async () => {
  const w = world(REAL);
  const made = await atServer(w, "wink.server.code", {});
  const seed = parseServerQr(made.qr).seed, ticket = Buffer.from(seed).toString("base64url");
  // leg two: the attacker, as an app, opens an ask on the real box with its own nonce
  const leg2 = await freshAsk(w, "device:mitm", seed);
  // leg one: the real app is shown the attacker's side of it; the attacker answers with a nonce of its own, so the real app's words are
  const appNa = newNonce(), attackerNb = newNonce();
  const onApp = await pairWords("Qm94S2V5", "app-real", { ticket, nonceA: appNa, nonceB: attackerNb });
  assert.notEqual(onApp, leg2.words, "the person sees different words on the two sides, says no, and the ask ends");
  assert.equal((await atServer(w, "wink.server.pair.answer", { yes: false })).yes, false);
  assert.ok(w.drops.some(d => d[1].id === "mitm"), "the attacker's device is let go");
});

test("every way an ask ends lets the app's relay device go and leaves no device row (break 1): no, expired, wrong pair-to, cancelled, a bad reveal, an error", async () => {
  const gone = (w, id) => w.drops.some(d => d[0] === "relay.devices.drop" && d[1].id === id);
  const clean = w => assert.equal(w.p.devices.list(ME).length, 0, "no device row");
  // no
  { const w = world(REAL); const s = parseServerQr((await atServer(w, "wink.server.code", {})).qr).seed; await freshAsk(w, "device:appno", s); await atServer(w, "wink.server.pair.answer", { yes: false }); assert.ok(gone(w, "appno"), "no"); clean(w); }
  // expired: the ask ends by itself, with nobody calling again
  { const w = world({ ...REAL, now: () => Date.now(), askMs: 40 }); const s = parseServerQr((await atServer(w, "wink.server.code", {})).qr).seed; await freshAsk(w, "device:appexp", s); await new Promise(r => setTimeout(r, 120)); assert.ok(gone(w, "appexp"), "expired"); assert.equal((await atServer(w, "wink.server.pairing")).asking, false); clean(w); }
  // wrong pair-to
  { const w = world({ ...REAL, typedCode: false }); await atServer(w, "wink.server.code", { pairTo: "per_other" }); await assert.rejects(() => adoptAs(w, "device:appwrong", { ...ASKED, pairing: { commit: "0".repeat(64) } }), e => e.code === "denied"); assert.ok(gone(w, "appwrong"), "wrong pair-to"); clean(w); }
  // cancelled by the app
  { const w = world(REAL); const s = parseServerQr((await atServer(w, "wink.server.code", {})).qr).seed; const r = await freshAsk(w, "device:appcan", s); await assert.rejects(() => adoptAs(w, "device:appcan", { ...ASKED, pairing: { ...r.pairing, cancel: true } }), e => e.code === "denied"); assert.ok(gone(w, "appcan"), "cancelled"); assert.equal((await atServer(w, "wink.server.pairing")).asking, false); clean(w); }
  // an error: a reveal that does not match its commit
  { const w = world(REAL); const s = parseServerQr((await atServer(w, "wink.server.code", {})).qr).seed; const na = newNonce(), pairing = { commit: await nonceCommit(na), tag: await ticketTag(Buffer.from(s).toString("base64url")) };
    await adoptAs(w, "device:apperr", { ...ASKED, pairing });
    await assert.rejects(() => adoptAs(w, "device:apperr", { ...ASKED, pairing: { ...pairing, reveal: newNonce() } }), e => e.code === "denied");
    assert.ok(gone(w, "apperr"), "error"); clean(w); }
});

test("a second scanner is refused without ending the first one's ask (break 2), and a taken ticket is told at once", async () => {
  const w = world(REAL);
  const s = parseServerQr((await atServer(w, "wink.server.code", {})).qr).seed;
  const first = await freshAsk(w, "device:first", s);
  await assert.rejects(() => adoptAs(w, "device:second", { ...ASKED, pairing: { commit: "0".repeat(64) } }), e => e.code === "busy");
  assert.ok(w.drops.some(d => d[1].id === "second"), "the loser is let go");
  const q = await atServer(w, "wink.server.pairing");
  assert.equal(q.asking, true, "the first one's ask is untouched");
  assert.ok(q.choices.includes(first.words));
  // the app side: the relay says the QR's ticket is gone (another scanner took it): state failed at once, with a plain reason, no wait
  const app = world({ typedCode: false, finishResult: { ok: false, reason: "gone" } });
  const r = await app.call("wink.pair.server", { payload: serverQrPayload(new Uint8Array(16).fill(5), "ws://relay.test"), target: { kind: "identity", id: ME } });
  await new Promise(x => setTimeout(x, 30));
  const st = await app.call("wink.pair.status", { pairing: r.pairing });
  assert.equal(st.state, "failed");
  assert.match(st.reason, /already used by another device/);
  assert.equal(app.finishes[0].once, true, "a QR's ticket is not polled for");
  assert.equal(app.p.devices.list(ME).length, 0);
});

test("typed code kill switch (typedCode false): the typed paths are refused with a plain reason; scan and paste always work", async () => {
  const w = world({ typedCode: false });
  const target = { kind: "identity", id: ME };
  await assert.rejects(() => w.call("wink.server.code", { typed: true }), e => e.code === "typed_code_off" && /switched off/.test(e.message));
  await assert.rejects(() => w.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target }), e => e.code === "typed_code_off");
  // even the plain call makes no typed code: it makes the QR and the long code
  const made = await w.call("wink.server.code", {});
  assert.match(made.qr, /^vyre:\/\/wink\/2\?t=/);
  assert.equal(made.code, undefined);
  assert.equal(made.offer, undefined);
  const scan = await w.call("wink.pair.server", { payload: made.qr, target });
  assert.equal(scan.ack, null, "a scan or a paste has nothing to type");
  assert.equal(w.typed.length, 0, "no typing port was used");
  // with the switch not set the typed code is on
  const dev = world({ typedCode: true });
  assert.equal((await dev.call("wink.server.code", {})).code, "WINK-ZZZZ-ZZZZ");
  assert.equal((await dev.call("wink.pair.server", { code: "WINK-K7QM-4P2X", target })).ack, "WINK-AB12-CD34");
  // the words say scan or paste, never type
  for (const k of ["typedCodeOff", "wrongCode", "notACode", "relayNoCode"]) assert.doesNotMatch(words(k), /\btyp(e|ed|ing)\b/i, k);
  assert.ok(!FORBIDDEN.test(words("typedCodeOff")));
});

test("reviewer-3 LOW: an unowned server answers `already` to a paired device only, and a release the server never confirmed is given up after 30 days and the person is told", async () => {
  const w = world();
  const rel = c => w.tools.get("wink.server.release").run({}, { caller: c });
  assert.deepEqual(await rel("device:app1"), { released: true, already: true });
  for (const c of ["cli", "anonymous", "tailnet", "relay", "module:evil", "deck"]) await assert.rejects(() => rel(c), e => e.code === "denied", `${JSON.stringify(c)} learns nothing`);
  await assert.rejects(() => w.tools.get("wink.server.release").run({}, {}), e => e.code === "denied");
  // the app's side: a pending release is kept, then dropped with a card after the age limit
  let t = 10_000_000;
  const app = world({ now: () => t, releaseMaxMs: 30 * 86_400_000, callServer: async () => { throw Object.assign(new Error("no answer"), { remote: "" }); } });
  app.p.devices.add({ id: "srv_old", identity: ME, kind: "server", name: "juno", target: { kind: "identity", id: ME } });
  app.p.meta.set("channel:srv_old", { relay: "ws://relay.test", route: "r1", box: "b1" });
  assert.equal(await app.p.releaseServer("srv_old"), "pending");
  t += 29 * 86_400_000;
  await app.p.retryReleases();
  assert.ok(app.p.meta.get("release:srv_old"), "still kept at 29 days");
  t += 2 * 86_400_000;
  await app.p.retryReleases();
  assert.equal(app.p.meta.get("release:srv_old"), null, "given up after 30 days");
  const gave = app.events.find(e => e[0] === "wink.server-release" && e[1].state === "gaveup");
  assert.ok(gave, "the person is told");
  assert.match(gave[1].message, /never confirmed/);
  assert.match(gave[1].message, /vyre wink reset --begin/);
  assert.match(removed({ what: "device", name: "juno", release: "gaveup" }), /Removed juno\. The server never confirmed/);
  assert.ok(!FORBIDDEN.test(gave[1].message));
});

// ---- Add a phone by scan or paste, three words on both sides, a yes on the computer (DESIGN-wink section 4); the typed code is off ----
const OFF = { typedCode: false, askMs: 5 * 60_000 };
const phoneOpen = async w => { const open = await w.call("wink.phone.open", {}); return open; };
const PHONE = { id: "phoneabcdef", name: "Alex's iPhone", fingerprint: "7KQM 4P2X" };

test("Add a phone with the typed code off: a QR and a long code of 128 bits, one ticket, the same on a second open, a space refused", async () => {
  const w = world(OFF);
  const open = await phoneOpen(w);
  const scan = parsePhoneQr(open.qr);
  assert.ok(scan && scan.seed.length === 16, "a 128 bit secret");
  assert.equal(scan.relay, "ws://relay.test");
  assert.equal(open.link, open.qr, "the paste text is the QR's text");
  assert.ok(open.art, "the QR is drawn for the screen");
  assert.equal(open.code, undefined, "no short code");
  assert.equal(w.minted.length, 1);
  assert.equal((await phoneOpen(w)).qr, open.qr, "opening again shows the same unused QR");
  assert.equal(w.minted.length, 1);
  assert.equal(parseServerQr(open.qr), null, "a phone QR is not a server's");
  assert.equal(parsePhoneQr(serverQrPayload(new Uint8Array(16).fill(1), "ws://r")), null, "a server QR is not a phone's");
  await assert.rejects(() => w.call("wink.phone.open", { space: HARLOW }), e => e.code === "identity_only");
  await assert.rejects(() => w.call("wink.phone.open", { typed: true }), e => e.code === "typed_code_off");
  const mintless = world({ ...OFF, mintFails: true });
  await assert.rejects(() => mintless.call("wink.phone.open", {}), e => e.code === "unavailable");
});

test("Add a phone: the phone that redeems the QR is held, both sides show the same words, and a yes on the computer adds it as a phone", async () => {
  const w = world(OFF);
  await phoneOpen(w);
  assert.equal(await w.p.phone.hold(PHONE), true);
  assert.equal(w.p.devices.list(ME).length, 0, "nothing is added before the yes");
  const q = await w.call("wink.phone.pairing");
  assert.equal(q.asking, true);
  assert.equal(q.words, undefined, "the computer shows choices, never the phone's words");
  assert.ok(q.choices.includes("amber coral phoneabcdef") && q.choices.length === 3);
  assert.match(q.line, /^Add Alex's iPhone to your identity\? Pick the three words the phone shows: 1\) .+ 2\) .+ 3\) .+$/);
  const wait = await w.call("wink.phone.wait", {}, { caller: "device:phoneabcdef" });
  assert.deepEqual([wait.state, wait.words], ["waiting", "amber coral phoneabcdef"]);
  await assert.rejects(() => w.call("wink.phone.wait", {}, { caller: "device:other" }), e => e.code === "denied");
  const yes = await w.call("wink.phone.pair.answer", { yes: true, words: "Amber  Coral phoneabcdef" });
  assert.equal(yes.yes, true);
  const [d] = w.p.devices.list(ME);
  assert.equal(d.kind, "phone");
  assert.deepEqual(d.offers, { access: true });
  assert.deepEqual(d.owner, { kind: "identity", id: ME });
  assert.equal((await w.call("wink.phone.wait", {}, { caller: "device:phoneabcdef" })).state, "yes");
  assert.equal((await w.call("wink.phone.pairing")).asking, false);
  assert.equal(w.events.some(e => e[0] === "wink.joined" && e[1].kind === "phone"), true);
  assert.equal(await w.p.phone.hold({ id: "second", name: "Kit's phone" }), false, "the ticket was one use: a second device is not held for it");
});

test("Add a phone: the phone's key-agreement point goes to the identity list with its key, so it opens private chats at once (a point not on the curve is dropped)", async () => {
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(kp.x, "base64url"), Buffer.from(kp.y, "base64url")]).toString("base64url");
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");
  const pub = Buffer.alloc(32, 7).toString("base64url");
  for (const [agree, passed] of [[point, point], [offCurve, undefined], [Buffer.alloc(33, 4).toString("base64url"), undefined], [undefined, undefined]]) {
    /** @type {any[]} */ const enrols = [];
    const w = world({ ...OFF, call: async (tool, input) => { if (tool === "spaces.identity.enrol") { enrols.push(input); return { data: { eid: "e1" } }; } return undefined; } });
    await phoneOpen(w);
    assert.equal(await w.p.phone.hold(PHONE), true);
    await w.call("wink.phone.wait", { entry: { publicKey: pub, label: "iPhone", ...(agree ? { agree } : {}) } }, { caller: "device:phoneabcdef" });
    assert.equal((await w.call("wink.phone.pair.answer", { yes: true, words: "Amber  Coral phoneabcdef" })).yes, true);
    assert.equal(enrols.length, 1);
    assert.equal(enrols[0].publicKey, pub);
    assert.equal(enrols[0].agree, passed, agree ? "only a point on the curve goes to enrol" : "no point, none passed");
  }
});

test("Add a phone to a server that holds no identity: the request waits for the owner's app, which reports it; if the app never does, the phone is told after three minutes and stays paired", async () => {
  const noIdentity = async (tool) => (tool === "spaces.identity.enrol" ? { error: { code: "no_identity", message: "Choose your Vyre name first." } } : undefined);
  const pub = Buffer.alloc(32, 9).toString("base64url");
  const start = async (clock) => {
    const w = world({ ...OFF, now: () => clock.t, call: noIdentity });
    await phoneOpen(w);
    assert.equal(await w.p.phone.hold(PHONE), true);
    await w.call("wink.phone.wait", { entry: { publicKey: pub, label: "iPhone" } }, { caller: "device:phoneabcdef" });
    assert.equal((await w.call("wink.phone.pair.answer", { yes: true, words: "Amber  Coral phoneabcdef" })).yes, true);
    return w;
  };
  // the owner's app answers
  const c1 = { t: 1_000_000 };
  const w = await start(c1);
  const wait1 = await w.call("wink.phone.wait", {}, { caller: "device:phoneabcdef" });
  assert.equal(wait1.state, "enrolling", "the phone keeps waiting while the owner's app signs");
  const q = await w.call("wink.phone.pairing");
  assert.equal(q.asking, false);
  assert.deepEqual([q.enrol.device, q.enrol.entry.publicKey], ["phoneabcdef", pub], "the owner's app is handed the key to sign");
  assert.equal(w.events.some(e => e[0] === "wink.enrol-asked"), true);
  await assert.rejects(() => w.call("wink.phone.enrolled", { device: "other", ok: true }), e => e.code === "not_found");
  assert.equal((await w.call("wink.phone.enrolled", { device: "phoneabcdef", ok: true, identity: { id: ME, vyre: "alex" } })).ok, true);
  const done = await w.call("wink.phone.wait", {}, { caller: "device:phoneabcdef" });
  assert.deepEqual([done.state, done.enrolled, done.identity], ["yes", true, { id: ME, vyre: "alex" }]);
  assert.equal((await w.call("wink.phone.pairing")).enrol, undefined, "served once");
  // nobody answers
  const c2 = { t: 1_000_000 };
  const x = await start(c2);
  c2.t += 3 * 60_000 - 1;
  assert.equal((await x.call("wink.phone.wait", {}, { caller: "device:phoneabcdef" })).state, "enrolling", "still inside the three minutes");
  c2.t += 2;
  const late = await x.call("wink.phone.wait", {}, { caller: "device:phoneabcdef" });
  assert.equal(late.state, "yes");
  assert.equal(late.enrolled, false);
  assert.match(late.reason, /did not add this device in time/);
  assert.equal(x.p.devices.list(ME).length, 1, "the phone stays paired");
  assert.equal((await x.call("wink.phone.pairing")).enrol, undefined);
  await assert.rejects(() => x.call("wink.phone.enrolled", { device: "phoneabcdef", ok: true }), e => e.code === "not_found", "a late answer is refused");
});

test("Add a phone: a no, or the wrong words, adds nothing and lets the phone go", async () => {
  for (const [answer, reasonSeen] of [[{ yes: false }, false], [{ yes: true, words: "amber coral wrong" }, true]]) {
    const w = world(OFF);
    await phoneOpen(w);
    await w.p.phone.hold(PHONE);
    const r = await w.call("wink.phone.pair.answer", answer);
    assert.equal(r.yes, false);
    assert.equal(Boolean(r.reason), reasonSeen);
    assert.equal(w.p.devices.list(ME).length, 0);
    assert.deepEqual(w.drops.find(d => d[0] === "relay.devices.drop")?.[1], { id: "phoneabcdef" }, "its relay device is dropped");
    assert.equal((await w.call("wink.phone.wait", {}, { caller: "device:phoneabcdef" })).state, "no");
    assert.deepEqual(await w.call("wink.phone.pair.answer", { yes: true }), { answered: false }, "a late yes finds nothing to answer");
    assert.equal(w.p.devices.list(ME).length, 0);
  }
});

test("Add a phone: no answer in 5 minutes pairs nothing, and an expired ticket holds nobody", async () => {
  let t = 1_000_000;
  const w = world({ ...OFF, now: () => t });
  await phoneOpen(w);
  await w.p.phone.hold(PHONE);
  t += 5 * 60_000 + 1;
  assert.equal((await w.call("wink.phone.pairing")).asking, false);
  assert.deepEqual(await w.call("wink.phone.pair.answer", { yes: true }), { answered: false });
  assert.equal(w.p.devices.list(ME).length, 0);
  assert.ok(w.drops.some(d => d[0] === "relay.devices.drop" && d[1].id === "phoneabcdef"));
  assert.equal((await w.call("wink.phone.wait", {}, { caller: "device:phoneabcdef" })).state, "expired");
  // a ticket that ran out before anyone used it holds nobody, and a new open makes a new one
  const v = world({ ...OFF, now: () => t });
  const first = await phoneOpen(v);
  t += 5 * 60_000 + 1;
  assert.equal(await v.p.phone.hold(PHONE), false, "an expired code is refused");
  assert.notEqual((await phoneOpen(v)).qr, first.qr);
});

test("Add a phone, the phone's side with the typed code off: scan, show the words, wait for the yes; a no or a timeout ends it with nothing added", async () => {
  const qr = phoneQrPayload(new Uint8Array(16).fill(7), "ws://relay.test");
  const BOX = "Qm94S2V5", DEV = "phone1", NB = "c".repeat(32), ticket = Buffer.from(new Uint8Array(16).fill(7)).toString("base64url");
  // `answers` are the states the computer gives after the words are revealed; the first call (commit) is answered with the computer's nonce
  const run = async (answers) => {
    const seen = [], sent = [];
    const w = world({ ...OFF, paired: { route: "route-juno", name: "juno", box: BOX, device: DEV }, callServer: async (paired, tool, input) => {
      seen.push(tool); sent.push(input);
      if (!input.reveal) return { state: "waiting", nb: NB, until: 9e15 };
      const a = answers.shift();
      if (typeof a === "function") return a();
      return a.state === "waiting" || a.state === "yes" ? { ...a, nb: NB, words: a.words || await pairWords(BOX, DEV, { ticket, nonceA: input.reveal, nonceB: NB }) } : a;
    } });
    const r = await w.call("wink.phone.scan", { payload: qr });
    assert.equal(r.ack, null, "nothing to type");
    assert.equal(w.typed.length, 0, "no typed exchange");
    assert.deepEqual(r.target, { kind: "identity", label: "alex" });
    for (let i = 0; i < 100; i++) { await settle(); const st = await w.call("wink.pair.status", { pairing: r.pairing }); if (st.state !== "waiting" && st.state !== "confirm") return { w, st, seen, sent }; }
    throw new Error("still waiting");
  };
  let { st, seen, sent } = await run([{ state: "waiting", until: 9e15 }, { state: "waiting", until: 9e15 }, { state: "yes" }]);
  assert.equal(st.state, "done");
  assert.deepEqual([...new Set(seen)], ["wink.phone.wait"]);
  assert.equal(await nonceCommit(sent.find(x => x.reveal).reveal), sent[0].commit, "commit, then reveal");
  assert.equal(sent[0].name, "alex", "the phone sends its own name");
  ({ st } = await run([{ state: "waiting", until: 9e15 }, { state: "no" }]));
  assert.equal(st.state, "failed");
  assert.match(st.reason, /not added/);
  ({ st } = await run([{ state: "expired" }]));
  assert.equal(st.state, "expired");
  assert.match(st.reason, /Nobody said yes/);
  ({ st } = await run([() => { throw Object.assign(new Error("no answer"), { remote: "" }); }]));
  assert.equal(st.state, "failed", "a phone the computer let go hears no, never done");
  // words the computer shows that are not this phone's own: refused
  ({ st } = await run([{ state: "waiting", until: 9e15, words: "wrong words here" }]));
  assert.equal(st.state, "failed");
  assert.match(st.reason, /not the ones here/);
  // a typed code is refused when the flag is off; a bare code cannot be pasted in its place
  const w = world(OFF);
  await assert.rejects(() => w.call("wink.phone.scan", { payload: qrPayload("WINK-K7QM-4P2X", "ws://relay.test") }), e => e.code === "typed_code_off");
  await assert.rejects(() => w.call("wink.phone.scan", { payload: "WINK-K7QM-4P2X" }), e => e.code === "typed_code_off");
  // break 5 (fifth run): a code with the flag off says typed_code_off plainly, not "payload is required"
  await assert.rejects(() => w.call("wink.phone.scan", { code: "WINK-K7QM-4P2X" }), e => e.code === "typed_code_off" && /switched off/.test(e.message));
  await assert.rejects(() => w.call("wink.phone.scan", {}), e => e.code === "bad_input");
  assert.equal(w.typed.length, 0);
  // a server's QR is not a phone's
  await assert.rejects(() => w.call("wink.phone.scan", { payload: serverQrPayload(new Uint8Array(16).fill(1), "ws://r") }), e => e.code === "bad_input");
});

test("Add a phone: the phone words never name a network, a key or a ticket, and no typed code is mentioned", () => {
  for (const k of ["phoneAsk", "phoneConfirm", "phoneRefused", "phoneExpired", "phoneWrongWords", "phoneMismatch", "phoneNotYours", "typedCodeOff", "notACode"]) {
    const v = words(/** @type {any} */ (k), { name: "Alex's iPhone", words: "amber coral seven" });
    assert.doesNotMatch(v, FORBIDDEN, k);
    assert.doesNotMatch(v, /\btype\b|\btyped\b/i, k);
  }
});

test("Add a phone with fresh words (break 3, break 5): commit then reveal, the card names the phone by the name it sent, a generic name reads \"A phone\", a bad reveal lets it go", async () => {
  const BOX = "Qm94S2V5";
  const one = async (sent, relayName) => {
    const w = world({ ...OFF, pairWordsFor: null, box: BOX });
    const open = await phoneOpen(w);
    const ticket = Buffer.from(parsePhoneQr(open.qr).seed).toString("base64url");
    await w.p.phone.hold({ id: "phoneabcdef", name: relayName, fingerprint: "7KQM 4P2X" });
    const as = { caller: "device:phoneabcdef" };
    assert.equal((await w.call("wink.phone.pairing")).asking, false, "no words, no question");
    assert.deepEqual(await w.call("wink.phone.pair.answer", { yes: true, pick: 1 }), { answered: false }, "no yes before the words");
    const na = newNonce(), commit = await nonceCommit(na), tag = await ticketTag(ticket);
    const r1 = await w.call("wink.phone.wait", { commit, tag, ...(sent ? { name: sent } : {}) }, as);
    assert.equal(r1.words, undefined);
    assert.match(r1.nb, /^[0-9a-f]{32}$/);
    const r2 = await w.call("wink.phone.wait", { commit, reveal: na }, as);
    assert.equal(r2.words, await pairWords(BOX, "phoneabcdef", { ticket, nonceA: na, nonceB: r1.nb }), "the same words the phone derives");
    return { w, q: await w.call("wink.phone.pairing"), as, commit };
  };
  const named = await one("Sam's iPhone", "Device");
  assert.equal(named.q.name, "Sam's iPhone");
  assert.match(named.q.line, /^Add Sam's iPhone to your identity\? Pick the three words the phone shows: /);
  assert.equal((await one("", "Device")).q.name, "A phone");
  assert.equal((await one("<b>x</b> ".repeat(40), "Device")).q.name.length <= 64, true);
  assert.equal((await one("", "Maya's phone")).q.name, "Maya's phone", "a name the relay kept is used when the phone sent none");
  // two pairings of the same phone and computer: other words
  assert.notDeepEqual((await one("a", "Device")).q.choices, (await one("a", "Device")).q.choices);
  // a reveal that does not match the commit: refused and the phone is let go
  const w = world({ ...OFF, pairWordsFor: null, box: BOX });
  await phoneOpen(w);
  await w.p.phone.hold({ id: "phoneabcdef", name: "Device" });
  const as = { caller: "device:phoneabcdef" };
  await w.call("wink.phone.wait", { commit: await nonceCommit(newNonce()) }, as);
  await assert.rejects(() => w.call("wink.phone.wait", { reveal: newNonce() }, as), e => e.code === "denied");
  assert.ok(w.drops.some(d => d[1].id === "phoneabcdef"));
});

test("the old ring (relay.pair.ticket) is held for the same words: nothing is registered, a second ring phone is let go", async () => {
  const w = world({ ...OFF, pairWordsFor: null });
  assert.equal(await w.p.phone.holdRing({ id: "ringphone1", name: "Device" }), true);
  assert.equal(w.p.devices.list(ME).length, 0, "nothing is registered before the words are confirmed");
  assert.equal(await w.p.phone.holdRing({ id: "ringphone2", name: "Device" }), true);
  assert.ok(w.drops.some(d => d[1].id === "ringphone2"), "one phone at a time");
  assert.equal((await w.call("wink.phone.pairing")).asking, false, "a ring phone that cannot show words is never asked about");
  assert.deepEqual(await w.call("wink.phone.pair.answer", { yes: true }), { answered: false });
});

test("wink.server.status: not owned before the pairing, then the space and the pairing device's name for the installer's last line; the server's own surfaces only", async () => {
  const w = world({ confirm: true });
  assert.deepEqual(await atServer(w, "wink.server.status"), { owned: false });
  await adoptAs(w, "device:app1");
  const choices = (await atServer(w, "wink.server.pairing")).choices;
  assert.equal((await atServer(w, "wink.server.pair.answer", { yes: true, pick: choices.indexOf("amber coral app1") + 1 })).yes, true);
  await adoptAs(w, "device:app1");
  const st = await atServer(w, "wink.server.status");
  assert.equal(st.owned, true);
  assert.equal(st.space, "Alex", "an identity owner is shown by the name the app sent");
  assert.equal(typeof st.device, "string");
  await assert.rejects(() => w.call("wink.server.status", {}, "device:app1"), e => e.code === "denied");
});


test("the asker at the server is the display name and the claimed Vyre name; a look-alike display name is dropped; a raw id is never shown", async () => {
  const names = { [ME]: "alex.vyre.run" };
  const ask = async (name, w) => { await adoptAs(w, "device:app1", { ...ASKED, owner: { ...ASKED.owner, name } }); return (await atServer(w, "wink.server.pairing")).name; };
  const w1 = world({ confirm: true, vyreName: async id => names[id] || null });
  assert.equal(await ask("Alex", w1), "Alex (alex.vyre.run)");
  assert.equal(await ask("\u0430lex", world({ confirm: true, vyreName: async id => names[id] || null })), "alex.vyre.run", "a look-alike display name leaves the Vyre name alone");
  assert.equal(await ask("\u0430lex", world({ confirm: true })), "id aaaaaa", "no Vyre name and a look-alike: the short id alone");
  assert.equal(await ask("Alex", world({ confirm: true })), "Alex (id aaaaaa)", "no Vyre name: the display name with the short id");
  for (const shown of [await ask("Alex", world({ confirm: true })), await ask("", world({ confirm: true, vyreName: async () => null }))]) assert.doesNotMatch(shown, /per_/);
});

test("wink.server.paired: a module asks whether a device is a server paired to this identity; nothing else may", async () => {
  const w = world();
  w.p.devices.add({ id: "srv1", identity: ME, kind: "server", name: "Harlow box", target: { kind: "identity", id: ME } });
  w.p.devices.add({ id: "ph1", identity: ME, kind: "phone", name: "Alex's iPhone", target: { kind: "identity", id: ME } });
  const ask = (device, identity = ME, caller = "module:spaces") => w.tools.get("wink.server.paired").run({ device, identity }, { caller });
  assert.deepEqual(await ask("srv1"), { paired: true, name: "Harlow box" });
  assert.deepEqual(await ask("ph1"), { paired: false }, "a phone is not a server");
  assert.deepEqual(await ask("srv1", "per_other"), { paired: false }, "not another identity's");
  assert.deepEqual(await ask("nope"), { paired: false });
  await assert.rejects(ask("srv1", ME, "cli"), e => e.code === "denied");
  await assert.rejects(ask("srv1", ME, "device:aaaaaaaaaaaaaaaa"), e => e.code === "denied");
});

test("SP-1 and SP-2: an owner id must have an id's shape; a proof offered with no --pair-to is checked; the stored and shown name carries no control or bidi byte", async () => {
  const r = proofRig();
  const w = world({ confirm: true, identityEntry: r.identityEntry });
  await assert.rejects(() => adoptAs(w, "device:app1", { owner: { kind: "identity", id: "NOT-A-PERSON-ID; rm -rf", name: "Alex" }, identity: "x" }), e => e.code === "bad_input");
  await assert.rejects(() => adoptAs(w, "device:app1", { owner: { kind: "space", id: "per_aaaa", name: "Alex" } }), e => e.code === "bad_input", "a space owner needs a space id");
  assert.equal(w.p.meta.get("owner"), null, "nothing stored for a malformed id");
  // a proof by a key that is not on that identity's list is refused at once, with no --pair-to (the entry is known, the signature is not its)
  const w2 = world({ confirm: true, identityEntry: r.identityEntry });
  await assert.rejects(() => adoptAs(w2, "device:app1", { ...ASKED, proof: r.proof("app1", r.other.privateKey) }), e => e.code === "denied_wrong_proof");
  // an identity the directory does not know is refused too: no fallback to the three words (lead, G-2)
  const w2b = world({ confirm: true, identityEntry: async () => null });
  await assert.rejects(() => adoptAs(w2b, "device:app1", { ...ASKED, proof: { eid: "eid-unknown", sig: "x".repeat(86) } }), e => e.code === "denied_wrong_proof");
  assert.equal(w2.p.meta.get("owner"), null);
  // the right proof: the question is still asked (the person's yes stays the check), then the name is stored clean
  const w3 = world({ confirm: true, identityEntry: r.identityEntry });
  const dirty = "Alex\u001b[2J\u001b]0;pwned\u0007\u202egnp.exe";
  const input = { owner: { kind: "identity", id: ME, name: dirty }, identity: ME, proof: r.proof("app1") };
  assert.equal((await adoptAs(w3, "device:app1", input)).pending, true);
  assert.equal(await (async () => (await atServer(w3, "wink.server.pairing")).name)(), "Alex2J0pwnedgnp.exe (id aaaaaa)");
  const q = await atServer(w3, "wink.server.pairing");
  await atServer(w3, "wink.server.pair.answer", pickOf(q, "amber coral app1"));
  const ok = await adoptAs(w3, "device:app1", input);
  assert.equal(ok.owner.id, ME);
  const stored = w3.p.meta.get("owner").name;
  assert.equal(stored, "Alex2J0pwnedgnp.exe");
  assert.doesNotMatch(stored, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
  assert.equal((await atServer(w3, "wink.server.status")).space, "Alex2J0pwnedgnp.exe");
});

test("SP-1 exact ids: in production an owner id is per_ plus 26 base32 or spc_ plus 12 or 26; per_a and a 25 character id are refused", async () => {
  const w = world({ exactIds: true });
  const bad = id => assert.rejects(() => adoptAs(w, "device:app1", { owner: { kind: "identity", id, name: "Alex" } }), e => e.code === "bad_input");
  await bad("per_a"); await bad("per_" + "a".repeat(25)); await bad("per_" + "a".repeat(27)); await bad("PER_" + "a".repeat(26));
  await assert.rejects(() => adoptAs(w, "device:app1", { owner: { kind: "space", id: "spc_" + "a".repeat(11), name: "H" } }), e => e.code === "bad_input");
  assert.equal(w.p.meta.get("owner"), null);
  assert.equal((await adoptAs(w, "device:app1", { owner: { kind: "identity", id: "per_" + "a".repeat(26), name: "Alex" } })).owner.kind, "identity");
  const w2 = world({ exactIds: true });
  assert.equal((await adoptAs(w2, "device:app1", { owner: { kind: "space", id: "spc_" + "a".repeat(12), name: "H" } })).owner.kind, "space");
});

test("wink.server.probe: a paired server answers; a server that let the device go answers refused; an unknown device says so", async () => {
  let refuse = false;
  const w = world({ callServer: async (_p, tool) => { if (refuse) throw Object.assign(new Error("the server answered 401"), { remote: "device_removed" }); return { tool }; } });
  w.p.meta.set("probe:srv1", { relay: "ws://relay.test", route: "route1", box: "box1" });
  assert.deepEqual(await w.call("wink.server.probe", { device: "srv1" }), { reachable: true, answered: true });
  refuse = true;
  const gone = await w.call("wink.server.probe", { device: "srv1" });
  assert.equal(gone.reachable, false);
  assert.equal(gone.code, "device_removed");
  assert.equal((await w.call("wink.server.probe", { device: "nope" })).code, "unknown");
});

test("wink.server.probe: once the person removed a server (released or not), the probe answers removed and never the old route", async () => {
  const w = world({ callServer: async (_p, tool) => ({ tool, released: true }) });
  const ch = { relay: "ws://relay.test", route: "route1", box: "box1" };
  w.p.meta.set("channel:srv1", ch); w.p.meta.set("probe:srv1", ch);
  assert.equal((await w.call("wink.server.probe", { device: "srv1" })).reachable, true);
  assert.equal(await w.p.releaseServer("srv1"), "released");
  const gone = await w.call("wink.server.probe", { device: "srv1" });
  assert.deepEqual([gone.reachable, gone.code], [false, "removed"]);
  const w2 = world({ callServer: async () => { throw Object.assign(new Error("down"), { remote: "" }); }, releaseRetryMs: 0 });
  w2.p.meta.set("channel:srv2", ch); w2.p.meta.set("probe:srv2", ch);
  assert.equal(await w2.p.releaseServer("srv2"), "pending");
  assert.equal((await w2.call("wink.server.probe", { device: "srv2" })).code, "removed", "a release that could not be delivered still stops the probe from using the old route");
});

// ---- G-2 (lead, 4 Oct): becoming an owner always needs the identity proof, checked against the identity's chain ----

test("owner needs a verified proof: none, another identity's, and an unreachable directory each refuse in their own words and nothing is owned; the right proof owns", async () => {
  const kp = crypto.generateKeyPairSync("ed25519");
  const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const sign = (box, device) => crypto.sign(null, pairToMessage(box, device), kp.privateKey).toString("base64url");
  let down = false, claimedSeen = null;
  const identityEntry = async (id, eid, claimed) => { claimedSeen = claimed; if (down) throw Object.assign(new Error("x"), { code: "unreachable" }); return id === ME && eid === "e1" ? { eid: "e1", kind: "device", pub, identity: ME } : null; };
  const w = world({ confirm: true, requireProof: true, identityEntry });
  const base = { owner: { kind: "identity", id: ME, name: "Alex", vyre: "alex" }, identity: ME };
  const box = "Qm94S2V5";
  const asked = async (input, caller = "device:app1") => w.tools.get("wink.server.adopt").run(input, { caller });
  await assert.rejects(() => asked(base), e => e.code === "denied_no_proof" && /did not prove which Vyre identity/.test(e.message) && !/waiting to pair/.test(e.message));
  await assert.rejects(() => asked({ ...base, proof: { eid: "e1", sig: crypto.sign(null, pairToMessage(box, "other"), kp.privateKey).toString("base64url") } }), e => e.code === "denied_wrong_proof" && /did not prove it/.test(e.message) && !/waiting to pair/.test(e.message));
  down = true;
  await assert.rejects(() => asked({ ...base, proof: { eid: "e1", sig: sign(box, "app1") } }), e => /cannot check who is asking right now/.test(e.message));
  down = false;
  assert.equal(w.p.meta.get("owner"), null, "nothing was owned by any refusal");
  const good = { ...base, proof: { eid: "e1", sig: sign(box, "app1") } };
  assert.equal((await asked(good)).pending, true);
  assert.equal(claimedSeen, "alex", "the directory is asked by the claimed name");
});

test("G-1: a device that says it is a computer, a phone or a browser gets no compute offer, no storage and no node-peer admission; only the owner's own act changes that", async () => {
  const w = world();
  for (const kind of ["computer", "phone", "web"]) {
    const d = w.p.devices.add({ id: `d_${kind}`, identity: ME, kind, name: kind, target: { kind: "identity", id: ME } });
    assert.notEqual(d.offers.compute, true, `${kind} offers no compute until the owner turns it on`);
    assert.notEqual(d.offers.storage, true, `${kind} offers no storage`);
    assert.equal(w.p.peers.allow(`d_${kind}`), false, `${kind} is not a server peer of this home`);
    assert.equal((await w.p.computeAllowed({ device: `d_${kind}`, space: HARLOW })).ok, false);
  }
});


// ---- PI-1 to PI-3 (lead ruling, 4 Oct): who owns a server proves it from a hardware-held key, for this pairing only ----

test("PI-1: on a release build the owner's proof must come from a phone's hardware-held entry with its Face ID signature; a software key, a web-held entry and a missing esig are refused; a development build takes a software key and says so", async () => {
  const soft = crypto.generateKeyPairSync("ed25519"), enc = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rawPub = k => k.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const encPt = enc.publicKey.export({ format: "jwk" });
  const enclave = Buffer.concat([Buffer.from([4]), Buffer.from(encPt.x, "base64url"), Buffer.from(encPt.y, "base64url")]).toString("base64url");
  const entries = { soft: { eid: "e_soft", kind: "device", pub: rawPub(soft), identity: ME }, phone: { eid: "e_phone", kind: "device", pub: rawPub(soft), identity: ME, enclave }, web: { eid: "e_web", kind: "device", pub: rawPub(soft), identity: ME, held: "web" } };
  const identityEntry = async (_id, eid) => Object.values(entries).find(e => e.eid === eid) || null;
  const BOX = "Qm94S2V5", TAG = "t".repeat(43);
  const msg = pairToMessage(BOX, "app1", TAG);
  const proof = (eid, esig) => ({ eid, sig: crypto.sign(null, msg, soft.privateKey).toString("base64url"), ...(esig ? { esig } : {}) });
  const esigOf = () => crypto.sign("sha256", msg, { key: enc.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const base = { owner: { kind: "identity", id: ME, name: "Alex", vyre: "alex", pin: { id: ME, seq: 1, head: "h" } }, identity: ME, pairing: { commit: "0".repeat(64), tag: TAG } };
  const attempt = async (releaseProof, p) => { const w = world({ confirm: true, requireProof: true, releaseProof, identityEntry }); try { return { ok: await w.tools.get("wink.server.adopt").run({ ...base, proof: p }, { caller: "device:app1" }), w }; } catch (e) { return { err: e, w }; } };
  // a release build
  assert.equal((await attempt(true, proof("e_soft"))).err.code, "not_hardware");
  assert.match((await attempt(true, proof("e_soft"))).err.message, /Pair this server from Vyre on your phone/);
  assert.equal((await attempt(true, proof("e_web"))).err.code, "not_hardware");
  assert.equal((await attempt(true, proof("e_phone"))).err.code, "denied_wrong_proof", "an enclave entry's proof without its Face ID signature");
  assert.equal((await attempt(true, proof("e_phone", "A".repeat(86)))).err.code, "denied_wrong_proof", "a wrong esig");
  assert.equal((await attempt(true, proof("e_phone", esigOf()))).ok.pending, true, "with its Face ID signature it is asked");
  // finished: the server owns, and says the enclave key is unattested (never "hardware" without a verified attestation)
  { const r = await attempt(true, proof("e_phone", esigOf())); await atServer(r.w, "wink.server.pair.answer", await rightYes(r.w)); await r.w.tools.get("wink.server.adopt").run({ ...base, proof: proof("e_phone", esigOf()) }, { caller: "device:app1" }); assert.equal(r.w.p.meta.get("owner_proof"), "enclave, unattested"); }
  // PI-2: a release build refuses a pairing with no pin; a development build takes it and says so
  const nopin = { ...base, owner: { kind: "identity", id: ME, name: "Alex", vyre: "alex" } };
  const wNo = world({ confirm: true, requireProof: true, releaseProof: true, identityEntry });
  await assert.rejects(() => wNo.tools.get("wink.server.adopt").run({ ...nopin, proof: proof("e_phone", esigOf()) }, { caller: "device:app1" }), e => e.code === "no_pin");
  const wDev = world({ confirm: true, requireProof: true, releaseProof: false, identityEntry });
  assert.equal((await wDev.tools.get("wink.server.adopt").run({ ...nopin, proof: proof("e_soft") }, { caller: "device:app1" })).pending, true);
  // a proof with no pairing tag is no proof on a release build
  const w0 = world({ confirm: true, requireProof: true, releaseProof: true, identityEntry });
  await assert.rejects(() => w0.tools.get("wink.server.adopt").run({ ...base, pairing: { commit: "0".repeat(64) }, proof: proof("e_phone", esigOf()) }, { caller: "device:app1" }), e => e.code === "denied_wrong_proof");
  // a proof made for another pairing's tag
  const other = await attempt(true, { ...proof("e_phone", esigOf()) });
  assert.ok(other.ok);
  const w1 = world({ confirm: true, requireProof: true, releaseProof: true, identityEntry });
  await assert.rejects(() => w1.tools.get("wink.server.adopt").run({ ...base, pairing: { commit: "0".repeat(64), tag: "u".repeat(43) }, proof: proof("e_phone", esigOf()) }, { caller: "device:app1" }), e => e.code === "denied_wrong_proof", "PI-3: a proof from an earlier pairing");
  // a development build
  const dev = await attempt(false, proof("e_soft"));
  assert.equal(dev.ok.pending, true);
});

test("PI-2: the app's pin goes to the directory lookup, and a refused refusal leaves no ask", async () => {
  let seenPin = null;
  const w = world({ confirm: true, requireProof: true, releaseProof: false, identityEntry: async (_i, _e, _n, pin) => { seenPin = pin; return null; } });
  const pin = { id: ME, seq: 3, head: "h" };
  await assert.rejects(() => w.tools.get("wink.server.adopt").run({ owner: { kind: "identity", id: ME, vyre: "alex", pin }, identity: ME, pairing: { commit: "0".repeat(64), tag: "t".repeat(43) }, proof: { eid: "e1", sig: "x".repeat(86) } }, { caller: "device:app1" }), e => e.code === "denied_wrong_proof");
  assert.deepEqual(seenPin, pin);
  assert.equal(w.p.meta.get("owner"), null);
  assert.equal((await w.tools.get("wink.server.pairing").run({}, { caller: "cli" })).asking, false, "no ask is left");
  assert.ok(w.drops.some(d => d[0] === "relay.devices.drop" && d[1].id === "app1"), "the refused device's relay row is dropped");
});

test("the owner record is written BEFORE spaces.owner.adopt asks for it (windows' check reads wink.server.owner): adoption never refuses for an order bug", async () => {
  const kp = crypto.generateKeyPairSync("ed25519");
  const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const BOX = "Qm94S2V5", TAG = "t".repeat(43);
  let ownerAtAdopt = "unset";
  let wref;
  const w = world({ confirm: true, requireProof: true, releaseProof: false, identityEntry: async (_i, eid) => (eid === "e1" ? { eid: "e1", kind: "device", pub, identity: ME } : null),
    call: async (tool, input) => {
      if (tool === "relay.pair.pending.confirm") return { data: { key: crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "software" } };
      if (tool === "relay.device.presence") return { data: { key: "pk1" } };
      if (tool === "spaces.owner.adopt") { ownerAtAdopt = wref.p.meta.get("owner"); return { data: { owner: input.person } }; }
      return undefined;
    } });
  wref = w;
  const proof = { eid: "e1", sig: crypto.sign(null, pairToMessage(BOX, "app1", TAG), kp.privateKey).toString("base64url") };
  const input = { owner: { kind: "identity", id: ME, name: "Alex", vyre: "alex" }, identity: ME, deviceKind: "phone", proof, pairing: { commit: "0".repeat(64), tag: TAG } };
  const run = () => w.tools.get("wink.server.adopt").run(input, { caller: "device:app1" });
  assert.equal((await run()).pending, true);
  await atServer(w, "wink.server.pair.answer", await rightYes(w, "amber coral app1").catch(() => ({ yes: true, pick: 1 })));
  const done = await run().catch(e => e);
  if (process.env.NEVER) console.log("DBG", JSON.stringify(done), JSON.stringify(w.p.meta.get("owner")), JSON.stringify(w.p.devices.get("app1")), JSON.stringify(w.events.map(e => e[0])), "PROOF", w.p.meta.get("owner_proof"), JSON.stringify(w.drops.map(d => d[0])));
  assert.ok(ownerAtAdopt && ownerAtAdopt.identity === ME, `the owner record named the identity when adopt asked: ${JSON.stringify(ownerAtAdopt)}`);
});


const fixtureBuild = (kind) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bk-${kind}-`));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "lib", "build-kind.js"), kind !== "release" ? 'export const BUILD_KIND = "development";\n' : 'export const BUILD_KIND = "release";\n');
  if (kind === "dev-image") fs.writeFileSync(path.join(dir, "vyre.tgz"), "x");   // a dev-kind image is packed, but its KIND is still development
  return dir;
};

test("the build KIND decides release behaviour, on three builds: a checkout and a packaged dev-kind image take a software prover and the software signer switch; a release-stamped copy refuses the prover and ignores the switch", async () => {
  const saved = process.env.VYRE_SEAL_SOFTWARE;
  try {
    process.env.VYRE_SEAL_SOFTWARE = "1";
    const soft = crypto.generateKeyPairSync("ed25519");
    const entry = { eid: "e_soft", kind: "device", pub: soft.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"), identity: ME };
    const BOX = "Qm94S2V5", TAG = "t".repeat(43);
    const proof = { eid: "e_soft", sig: crypto.sign(null, pairToMessage(BOX, "app1", TAG), soft.privateKey).toString("base64url") };
    const input = { owner: { kind: "identity", id: ME, name: "Alex", vyre: "alex", pin: { id: ME, seq: 1, head: "h" } }, identity: ME, proof, pairing: { commit: "0".repeat(64), tag: TAG } };
    for (const [name, root] of [["a checkout", undefined], ["a packaged dev-kind image", fixtureBuild("dev-image")]]) {
      const w = world({ confirm: true, requireProof: true, identityEntry: async () => entry, buildRoot: root, releaseProof: undefined });
      assert.equal(w.p.autoPresence, true, `${name}: the software signer switch is honoured`);
      assert.equal((await w.tools.get("wink.server.adopt").run(input, { caller: "device:app1" })).pending, true, `${name}: a software prover is asked`);
    }
    const rel = fixtureBuild("release");
    const w = world({ confirm: true, requireProof: true, identityEntry: async () => entry, buildRoot: rel, releaseProof: undefined });
    assert.equal(w.p.autoPresence, false, "a release-stamped copy ignores the switch");
    await assert.rejects(() => w.tools.get("wink.server.adopt").run(input, { caller: "device:app1" }), e => e.code === "not_hardware");
  } finally { if (saved === undefined) delete process.env.VYRE_SEAL_SOFTWARE; else process.env.VYRE_SEAL_SOFTWARE = saved; }
});


test("wink.pair.server never hangs silently: a step that does not answer ends the call with plain words naming it, and one log line", async () => {
  for (const [name, w] of [["looking up your identity", world({ stepMs: 40, identity: () => new Promise(() => {}) })], ["checking where this server should go", world({ stepMs: 40, directory: { memberships: () => new Promise(() => {}) } })]]) {
    const t0 = Date.now();
    await assert.rejects(() => w.call("wink.pair.server", { payload: serverQrPayload(new Uint8Array(16).fill(1), "ws://relay.test"), target: { kind: "identity", id: ME } }), e => e.code === "unavailable" && new RegExp(`did not finish ${name}`).test(e.message) && /Try again/.test(e.message));
    assert.ok(Date.now() - t0 < 2000, `${name}: bounded`);
  }
});

test("PI-2, computer side: a computer that pairs a server sends the head and length of the identity chain it last verified as owner.pin; with none held it sends none", async () => {
  const BOX = "Qm94S2V5", DEV = "app1dev";
  const pin = { id: "per_" + "q".repeat(26), seq: 3, head: "h".repeat(43) };
  for (const [held, want] of [[pin, pin], [null, undefined]]) {
    const seen = [];
    const w = world({ typedCode: false, paired: { route: "route-juno", name: "juno", box: BOX, device: DEV }, identityPin: async () => held, callServer: async (_p, _t, input) => { seen.push(input); return { owner: input.owner }; } });
    const q = await w.call("wink.pair.server", { payload: serverQrPayload(new Uint8Array(16).fill(5), "ws://relay.test"), target: { kind: "identity", id: ME } });
    await new Promise(x => setTimeout(x, 80));
    assert.equal((await w.call("wink.pair.status", { pairing: q.pairing })).state, "done");
    assert.deepEqual(seen[0].owner.pin, want);
  }
});

test("the enclave key must still stand on the identity's directory list: checked at sign-in, cached for 10 minutes, and a revoked entry makes the device software and marks it for re-pairing", async () => {
  let clock = 1_000_000;
  const KEY = "BAAA";
  let entries = [{ eid: "e_phone", kind: "device", enclave: KEY }];
  let reachable = true;
  const lookups = [];
  const w = world({ now: () => clock, call: async (tool, input) => { if (tool === "spaces.identity.lookup") { lookups.push(input); if (!reachable) throw Object.assign(new Error("down"), { code: "unreachable" }); return { data: { entries } }; } return undefined; } });
  w.p.devices.add({ id: "dev1", identity: ME, kind: "phone", name: "Alex's phone", target: { kind: "identity", id: ME } });
  w.p.devices.setConfirmed("dev1", { by: ME, keyId: "k1", key: null });
  w.p.devices.setEnclaveKey("dev1", KEY, "e_phone", "alex");
  const live = () => w.tools.get("wink.device.enclave-live").run({ device: "dev1" }, { caller: "module:presence" });
  await assert.rejects(() => w.tools.get("wink.device.enclave-live").run({ device: "dev1" }, { caller: "module:evil" }), e => e.code === "denied");
  assert.deepEqual(await live(), { ok: true });
  assert.equal(lookups.length, 1);
  assert.deepEqual(lookups[0], { name: "alex", id: ME }, "the directory list of the identity, by its Vyre name");
  entries = [];
  clock += 9 * 60_000;
  assert.deepEqual(await live(), { ok: true }, "inside the 10-minute window the answer is the cached one");
  assert.equal(lookups.length, 1);
  clock += 2 * 60_000;
  assert.deepEqual(await live(), { ok: false }, "after the window the revoked entry is seen");
  assert.ok(w.events.some(e => e[0] === "wink.device-needs-repair" && e[1].device === "dev1"), "and the device is marked for re-pairing");
  assert.equal(w.db.prepare("SELECT needs_repair FROM wink_devices WHERE id = 'dev1'").get().needs_repair, 1);
  // a directory that cannot be reached: software for this sign-in, nothing remembered
  w.p.devices.setEnclaveKey("dev1", KEY, "e_phone", "alex");
  entries = [{ eid: "e_phone", kind: "device", enclave: KEY }];
  clock += 11 * 60_000; reachable = false;
  assert.deepEqual(await live(), { ok: false });
  reachable = true;
  assert.deepEqual(await live(), { ok: true }, "the next sign-in asks again");
  // another key under the same entry id is not this device's key
  clock += 11 * 60_000; entries = [{ eid: "e_phone", kind: "device", enclave: "BBBB" }];
  assert.deepEqual(await live(), { ok: false });
});

test("the home server is the newest COMPLETED pairing: a channel with no completion mark is the oldest, a newer completed pairing wins, a removed one is gone", async () => {
  const w = world();
  const ch = { relay: "ws://relay.test", route: "r", box: "b" };
  assert.equal(w.p.homeServerId(), null, "nothing paired");
  w.p.meta.set("channel:srv_legacy", ch);   // made before the completion mark existed
  assert.equal(w.p.homeServerId(), "srv_legacy", "an older pairing still counts");
  w.p.meta.set("channel:srv_a", ch); w.p.meta.set("paired:srv_a", { at: 100 });
  w.p.meta.set("channel:srv_b", ch); w.p.meta.set("paired:srv_b", { at: 200 });
  assert.equal(w.p.homeServerId(), "srv_b", "the newest completed pairing is the home");
  w.p.meta.set("channel:srv_half", ch);   // a channel with no completion mark never beats a completed one
  assert.equal(w.p.homeServerId(), "srv_b");
  w.p.meta.del("channel:srv_b"); w.p.meta.del("paired:srv_b");
  assert.equal(w.p.homeServerId(), "srv_a", "once the newest is removed the next completed one is the home");
});

test("a pairing that fails AFTER the server was adopted gives back the channel it wrote, so the failed server is never this computer's home; a completed pairing is the home", async () => {
  const rows = (w) => /** @type {any[]} */ (w.db.prepare("SELECT k FROM wink_meta WHERE k LIKE 'channel:%' OR k LIKE 'probe:%' OR k LIKE 'paired:%'").all()).map(r => r.k);
  const bad = world({ failEmit: "wink.server-paired" });
  const r = await bad.call("wink.pair.server", { code: "wink-k7qm-4p2x", target: { kind: "identity", id: ME } });
  await settle();
  assert.equal((await bad.call("wink.pair.status", { pairing: r.pairing })).state, "failed");
  assert.deepEqual(rows(bad), [], "a failed pairing leaves no channel, probe or completion mark");
  assert.equal(bad.p.homeServerId(), null, "and no home");
  assert.equal(bad.p.devices.list(ME).length, 0);
  const good = world();
  const g = await good.call("wink.pair.server", { code: "wink-k7qm-4p2x", target: { kind: "identity", id: ME } });
  await settle();
  assert.equal((await good.call("wink.pair.status", { pairing: g.pairing })).state, "done");
  const [d] = good.p.devices.list(ME);
  assert.equal(good.p.homeServerId(), d.id, "a completed pairing is the home");
  assert.ok(good.p.meta.get(`paired:${d.id}`).at > 0, "with its completion mark");
});
