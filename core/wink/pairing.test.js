// @ts-check
// Pairing: devices belong to the identity, never to a space (DESIGN-wink.md sections 3, 4 and 7). A fake ctx (in-memory store, a tool
// table, an event list), a fake directory (who administers what) and fake typing ports: no relay, no kernel, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createPairing, MIGRATIONS, PEER_MIGRATIONS, POLL_MS, KIND_OFFERS, parseQr, qrPayload } from "./pairing.js";
import { FORBIDDEN, words } from "./cards.js";
import { createChainBuilder } from "../../kernel/core/chain.js";
import { createOffersPort } from "../../kernel/remote/offers-port.js";

const ME = "per_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const HARLOW = "spc_harlowharlo";   // admin
// The kernel-built chain of the proven caller (the device owner): the offers port takes the member for the member side from it, never from an argument.
const chains = createChainBuilder({ space: HARLOW, owner: ME, owner_uid: 1, key: Buffer.alloc(32, 5), is_person: () => true });
const NORTHWIND = "spc_northwindbk"; // member only

/** A fake of the kernel gateway's grants offers: offer, unoffer, active (the same shape as kernel/grants/index.js). */
function fakeOffers() {
  const recs = new Map();
  let n = 0;
  return {
    recs,
    async offer(chain, o) { const rec = { id: `of_${++n}`, ...o, status: "active" }; recs.set(rec.id, rec); return rec; },
    async unoffer(chain, id) { recs.set(id, { ...recs.get(id), status: "revoked" }); },
    find(at) { return [...recs.values()].find(r => r.status === "active" && r.side === at.side && r.member === at.member && r.device === at.device); },
    active(q) {
      const live = r => r.status === "active" && r.member === q.member && r.device === q.device && (!r.device_key || r.device_key === q.device_key);
      return { spaceAllows: [...recs.values()].some(r => live(r) && r.side === "space_allows"), memberAccepts: [...recs.values()].some(r => live(r) && r.side === "member_accepts") };
    },
  };
}

function world(o = {}) {
  const db = new DatabaseSync(":memory:");
  for (const m of [...MIGRATIONS, ...PEER_MIGRATIONS]) db.exec(m);
  /** @type {Map<string, any>} */
  const tools = new Map();
  const events = /** @type {any[]} */ ([]);
  const ctx = { store: { db }, config: { name: "alex" }, log() {}, events: { emit: (n, d) => events.push([n, d]) }, tool: (n, def) => tools.set(n, def) };
  const typed = /** @type {any[]} */ ([]);
  const finishes = /** @type {any[]} */ ([]);
  const directory = o.directory || { memberships: async id => id === ME ? [{ space: HARLOW, name: "Harlow Legal", role: "admin" }, { space: NORTHWIND, name: "Northwind Bakery", role: "member" }] : [] };
  const ports = {
    callServer: o.callServer || (async (paired, tool, input) => ({ owner: input.owner })),
    typist: async a => { typed.push(a); return o.typistFails ? { ok: false, reason: o.typistFails } : { ok: true, ack: "WINK-AB12-CD34", seed: new Uint8Array(16), route: "rt" }; },
    finish: async a => { finishes.push(a); return { ok: true, paired: { route: "route-juno", name: "juno" } }; },
  };
  // the real offers port (kernel/remote/offers-port.js) over a fake of the kernel gateway's grants.offers: one store, the kernel's
  const offers = fakeOffers();
  const port = o.offers || createOffersPort({ space: HARLOW, grants: { offers }, chain: async () => chains.fromFacts({ kind: "device", device_key_id: "d-me", person: ME, path: "direct" }), proofFrom: () => ({}) });
  const p = createPairing({
    ctx, now: o.now || (() => 1_000_000), identity: async () => ME, space: async () => HARLOW, directory, ports,
    openCode: async flow => ({ offer: `wo_${flow}`, code: "WINK-ZZZZ-ZZZZ", expires: 1 }), ack: async () => ({ ok: true }),
    owner: () => {}, relayUrl: async () => "ws://relay.test", keyFile: o.keyFile, spaceNow: () => HARLOW,
    ...(o.noOffers ? {} : { offers: port }),
  });
  p.tools();
  const call = (name, input = {}, meta = {}) => tools.get(name).run(input, { caller: "device:x", ...meta });
  const fails = async (name, input, code) => { await assert.rejects(() => call(name, input), e => (code ? e.code === code : true) && (e.message || "")); };
  return { p, call, events, typed, finishes, db, tools, fails, offers };
}
const refused = e => ["denied", "presence_required"].includes(e.code);
const settle = () => new Promise(r => setTimeout(r, 10));

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
  assert.deepEqual(r.target, { kind: "identity", id: ME, label: "alex" }, "the answer names who it is");
  const open = await w.call("wink.phone.open", {});
  assert.equal(open.offer, "wo_W1");
  assert.equal(parseQr(open.qr)?.code, "WINK-ZZZZ-ZZZZ");
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
  // this home does not host Northwind: the kernel's port says so, and nothing is made
  await assert.rejects(() => w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: NORTHWIND, side: "member" }), e => e.code === "unavailable");
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
  assert.equal(tool.presence.when(), false, "no presence for the first adoption");
  await adopt({ owner: { kind: "space", id: HARLOW }, identity: ME, peerSecret: "A".repeat(43) }, "device:home1");
  assert.equal(tool.presence.when(), true, "presence once there is an owner");
  assert.deepEqual(w.p.meta.get("owner"), { kind: "space", id: HARLOW, identity: ME });
  assert.equal(w.p.devices.get("self").identity, ME);
  // another paired device, with or without presence, cannot take over
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: "per_evil" } }, "device:other"), e => e.code === "presence_required");
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: "per_evil" } }, "device:other", true), e => e.code === "denied");
  // the adopter itself cannot re-target to a space without presence
  await assert.rejects(() => adopt({ owner: { kind: "space", id: NORTHWIND }, identity: ME }, "device:home1"), e => e.code === "presence_required");
  assert.deepEqual(w.p.meta.get("owner"), { kind: "space", id: HARLOW, identity: ME }, "nothing moved");
  // with the owner's presence the adopter may change it, and so may a screen on this box
  await adopt({ owner: { kind: "identity", id: ME } }, "device:home1", true);
  await adopt({ owner: { kind: "space", id: HARLOW }, identity: ME }, "cli", true);
  assert.equal(w.p.meta.get("adopter"), "device:home1", "the adopter stays the first caller");
});

test("W-4: a local (cli) adoption is recorded, and a paired device cannot adopt again afterwards", async () => {
  const w = world();
  const adopt = (input, caller, presence) => w.tools.get("wink.server.adopt").run(input, { caller, ...(presence ? { presence: { method: "passkey" } } : {}) });
  await adopt({ owner: { kind: "identity", id: ME } }, "cli");
  assert.equal(w.p.meta.get("adopter"), "cli");
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: "per_evil" } }, "device:other"), e => e.code === "presence_required");
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: "per_evil" } }, "device:other", true), e => e.code === "denied");
  assert.deepEqual(w.p.meta.get("owner"), { kind: "identity", id: ME, identity: ME });
});

test("W-7: a second add under a known id cannot change identity, kind or owner; the self row has its own path", () => {
  const w = world();
  const add = (o) => w.p.devices.add({ id: "d1", identity: ME, kind: "phone", name: "kit", target: { kind: "identity", id: ME }, ...o });
  add({});
  assert.throws(() => add({ identity: "per_evil" }), e => e.code === "denied");
  assert.throws(() => add({ kind: "server" }), e => e.code === "denied");
  assert.throws(() => add({ target: { kind: "space", id: HARLOW } }), e => e.code === "denied");
  assert.deepEqual([w.p.devices.get("d1").identity, w.p.devices.get("d1").kind, w.p.devices.get("d1").owner], [ME, "phone", { kind: "identity", id: ME }]);
  assert.equal(add({ name: "kit 2" }).name, "kit 2", "the same device may refresh its name");
  w.p.devices.remove("d1");
  assert.equal(add({}).removed, false, "a removed device pairs again");
  assert.throws(() => add({ identity: "per_evil" }), e => e.code === "denied", "never under another identity");
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
  assert.equal(w.db.prepare("SELECT name FROM sqlite_master WHERE name = 'wink_compute'").get(), undefined, "no second store");
  offers.set(HARLOW, "pc", "space", false);
  assert.equal((await w.p.computeAllowed({ device: "pc", space: HARLOW })).ok, false, "a withdrawal in the kernel store reaches wink at once");
  w.p.devices.remove("pc");
  assert.equal(store.size, 1, "removing the device leaves the kernel's store to the kernel");
});

test("W-5: compute offers live only in the kernel's offers: no second store here, and a withdrawal there is the answer here", async () => {
  const w = world();
  assert.equal(w.db.prepare("SELECT name FROM sqlite_master WHERE name = 'wink_compute'").get(), undefined, "the second store is dropped by the migrations");
  assert.equal(typeof w.p.compute, "undefined", "no local read of the offers");
  w.p.devices.add({ id: "pc", identity: ME, kind: "computer", name: "Alex's Mac", target: { kind: "identity", id: ME } });
  await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true });
  await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: HARLOW, side: "space" });
  await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: HARLOW, side: "member" });
  assert.equal((await w.p.computeAllowed({ device: "pc", space: HARLOW })).ok, true);
  assert.deepEqual([...w.offers.recs.values()].map(r => [r.side, r.member, r.device]), [["space_allows", ME, "pc"], ["member_accepts", ME, "pc"]], "both sides were made in the kernel");
  // the kernel withdraws it on its own (a role change, a removal): this module follows, it keeps no copy
  for (const [id, r] of w.offers.recs) w.offers.recs.set(id, { ...r, status: "revoked" });
  assert.equal((await w.p.computeAllowed({ device: "pc", space: HARLOW })).ok, false);
  // a box with no kernel gateway says so plainly and never keeps a local answer
  const n = world({ noOffers: true });
  n.p.devices.add({ id: "pc", identity: ME, kind: "computer", name: "Mac", target: { kind: "identity", id: ME } });
  await n.call("wink.offer.set", { device: "pc", offer: "compute", on: true });
  await assert.rejects(() => n.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: HARLOW, side: "space" }), e => e.code === "unavailable");
  assert.match((await n.p.computeAllowed({ device: "pc", space: HARLOW })).reason, /no kernel/);
});

test("W-5: an old database that still has wink_compute migrates (the table is dropped, nothing reads it)", () => {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  db.prepare("INSERT INTO wink_compute (space, device, space_allows, member_accepts, updated) VALUES ('s', 'd', 1, 1, 1)").run();
  for (const m of PEER_MIGRATIONS) db.exec(m);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'wink_compute'").get(), undefined);
});

test("W-7: a second add under the same device id cannot change its identity, kind or owner; a removed device may pair again as itself", () => {
  const w = world();
  const add = (d) => w.p.devices.add({ name: "x", ...d });
  add({ id: "d1", identity: ME, kind: "phone", target: { kind: "identity", id: ME } });
  assert.throws(() => add({ id: "d1", identity: "per_evil", kind: "server", target: { kind: "space", id: HARLOW } }), e => e.code === "denied");
  assert.throws(() => add({ id: "d1", identity: "per_evil", kind: "phone", target: { kind: "identity", id: "per_evil" } }), e => e.code === "denied");
  assert.throws(() => add({ id: "d1", identity: ME, kind: "server", target: { kind: "identity", id: ME } }), e => e.code === "denied");
  assert.throws(() => add({ id: "d1", identity: ME, kind: "phone", target: { kind: "space", id: HARLOW } }), e => e.code === "denied");
  const d = w.p.devices.get("d1");
  assert.deepEqual([d.identity, d.kind, d.owner], [ME, "phone", { kind: "identity", id: ME }]);
  assert.equal(add({ id: "d1", identity: ME, kind: "phone", target: { kind: "identity", id: ME } }).id, "d1", "the same pairing again is a no-op");
  w.p.devices.remove("d1");
  assert.throws(() => add({ id: "d1", identity: "per_evil", kind: "phone", target: { kind: "identity", id: "per_evil" } }), e => e.code === "denied", "a removed row is still that identity's");
  assert.equal(add({ id: "d1", identity: ME, kind: "phone", target: { kind: "identity", id: ME } }).removed, false);
  // adopt's own row has its own path and rewrites only itself
  w.p.devices.setSelf({ identity: ME, target: { kind: "identity", id: ME } });
  w.p.devices.setSelf({ identity: ME, target: { kind: "space", id: HARLOW } });
  assert.deepEqual(w.p.devices.get("self").owner, { kind: "space", id: HARLOW });
});

test("W-4: adoption happens once, the adopter is recorded for every caller kind, and any change needs the owner's presence or the space's admin claim", async () => {
  const w = world();
  const adopt = (input, caller, extra = {}) => w.tools.get("wink.server.adopt").run(input, { caller, ...extra });
  const retarget = (input, caller, extra = {}) => w.tools.get("wink.server.retarget").run(input, { caller, ...extra });
  // first caller works
  await adopt({ owner: { kind: "identity", id: ME }, identity: ME, peerSecret: "A".repeat(43) }, "device:home1");
  assert.deepEqual(w.p.meta.get("owner"), { kind: "identity", id: ME, identity: ME });
  assert.equal(w.p.meta.get("adopter"), "device:home1");
  assert.equal(w.p.devices.get("self").identity, ME);
  // the same adopter re-targets to a space it does not administer: refused (probe 3a)
  await assert.rejects(() => adopt({ owner: { kind: "space", id: NORTHWIND }, identity: ME }, "device:home1"), refused);
  assert.deepEqual(w.p.meta.get("owner"), { kind: "identity", id: ME, identity: ME });
  // a different device naming another identity: refused
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: "per_evil" } }, "device:other"), refused);
  // repeating the same owner changes nothing and is fine
  await adopt({ owner: { kind: "identity", id: ME }, identity: ME }, "device:home1");
  await adopt({ owner: { kind: "identity", id: ME }, identity: ME }, "cli");
  assert.equal(w.p.meta.get("adopter"), "device:home1", "a repeat does not take the adopter's place");
  // a changed peer secret is a change too
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: ME }, identity: ME, peerSecret: "B".repeat(43) }, "device:other"), refused);
  assert.equal(w.p.meta.get("peer_secret"), "A".repeat(43));
  // the space's admin claim (the directory port: ME administers Harlow) lets it move
  await adopt({ owner: { kind: "space", id: HARLOW }, identity: ME }, "device:home1", { presence: { method: "touchid" } });
  assert.deepEqual(w.p.meta.get("owner"), { kind: "space", id: HARLOW, identity: ME });
  // the owner's own screen: presence, or nothing
  await assert.rejects(() => retarget({ owner: { kind: "identity", id: ME } }, "cli"), e => e.code === "presence_required");
  await retarget({ owner: { kind: "identity", id: ME } }, "cli", { presence: { method: "touchid" } });
  assert.deepEqual(w.p.meta.get("owner"), { kind: "identity", id: ME, identity: ME });
  assert.equal(w.tools.get("wink.server.retarget").presence.summary !== undefined, true, "the registry asks for presence");
});

test("W-4: after a cli adoption a different device cannot adopt again (probe 3b)", async () => {
  const w = world();
  const adopt = (input, caller) => w.tools.get("wink.server.adopt").run(input, { caller });
  await adopt({ owner: { kind: "identity", id: ME }, identity: ME }, "cli");
  assert.equal(w.p.meta.get("adopter"), "cli");
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: "per_evil" }, identity: "per_evil" }, "device:other"), refused);
  assert.equal(w.p.meta.get("owner").identity, ME);
  assert.equal(w.p.devices.get("self").identity, ME);
});

test("peer admission: a paired server of this space or identity only; the node key the host proved binds, and no other key gets the secret", async () => {
  const w = world();
  const add = (id, kind, target) => w.p.devices.add({ id, identity: ME, kind, name: id, target });
  add("srvMe", "server", { kind: "identity", id: ME });
  add("srvHarlow", "server", { kind: "space", id: HARLOW });
  add("srvElse", "server", { kind: "space", id: NORTHWIND });
  add("phone1", "phone", { kind: "identity", id: ME });
  assert.deepEqual(["srvMe", "srvHarlow", "srvElse", "phone1", "ghost"].map(d => w.p.peers.allow(d)), [true, true, false, false, false]);
  const call = async (t, input) => (await w.tools.get(t).run(input, { caller: "module:relay" }));
  assert.equal((await call("wink.peer.allow", { device: "srvHarlow" })).allow, true);
  assert.equal(w.p.peers.shared("phone1", "nodekey:a"), null);
  const NK = "nodekey:" + "aa".repeat(32), EVIL = "nodekey:" + "ee".repeat(32);
  const served = [];
  const serve = w.p.peers.serve(async (c, t) => { served.push([c, t]); return "ok"; });
  // an unproven claim notes nothing that binds: the secret is offered, the row stays unbound
  assert.equal(w.p.peers.shared("srvMe", NK, "stable1").toString("base64url"), w.p.peers.secretFor("srvMe"));
  assert.equal(w.p.devices.get("srvMe").nodeKey, null);
  // a call with no proof (the relay path) binds nothing
  await serve("device:srvMe", "x", {});
  assert.equal(w.p.devices.get("srvMe").nodeKey, null);
  // the host reports the key it proved: that key binds, with the noted stable id
  await serve("device:srvMe", "x", {}, { nodeKey: NK, stableId: "" });
  assert.equal(w.p.devices.get("srvMe").nodeKey, NK);
  assert.equal(w.p.devices.get("srvMe").stableId, "stable1");
  assert.ok(w.events.some(e => e[0] === "wink.peer-bound"));
  // bound: only that key, and a later proof cannot rebind
  assert.equal(w.p.peers.shared("srvMe", EVIL), null);
  assert.ok(w.p.peers.shared("srvMe", NK));
  await serve("device:srvMe", "x", {}, { nodeKey: EVIL });
  assert.equal(w.p.devices.get("srvMe").nodeKey, NK);
  // W-4b: an unproven claim binds nothing, and cannot lock the real server out
  w.p.peers.shared("srvHarlow", EVIL, "stableX");
  await serve("device:srvHarlow", "x", {});
  assert.equal(w.p.devices.get("srvHarlow").nodeKey, null, "a call with no proven key binds nothing");
  w.p.peers.shared("srvHarlow", NK, "stableY");
  await serve("device:srvHarlow", "x", {}, { nodeKey: "nodekey:" + "cc".repeat(32) });
  assert.equal(w.p.devices.get("srvHarlow").nodeKey, null, "a proven key nobody claimed binds nothing");
  w.p.peers.shared("srvHarlow", EVIL, "stableX");
  await serve("device:srvHarlow", "x", {}, { nodeKey: NK });
  assert.equal(w.p.devices.get("srvHarlow").nodeKey, NK, "the key that proved itself binds, whatever else was claimed");
  assert.equal(w.p.peers.shared("srvHarlow", EVIL), null);
  // the module tool says the same, and a removed server is out
  assert.equal((await call("wink.peer.shared", { device: "srvMe", nodeKey: EVIL })).secret, null);
  assert.ok((await call("wink.peer.shared", { device: "srvMe", nodeKey: NK })).secret);
  w.p.devices.remove("srvMe");
  assert.equal(w.p.peers.allow("srvMe"), false);
});

test("W-4b: a claim that no call proves lapses after a minute", async () => {
  let t = 1_000_000;
  const w = world({ now: () => t });
  w.p.devices.add({ id: "srvA", identity: ME, kind: "server", name: "a", target: { kind: "identity", id: ME } });
  const NK = "nodekey:" + "aa".repeat(32);
  w.p.peers.shared("srvA", NK);
  t += 61_000;
  await w.p.peers.serve(async () => "ok")("device:srvA", "x", {}, { nodeKey: NK });
  assert.equal(w.p.devices.get("srvA").nodeKey, null);
});

test("node-key hijack (probe 4): an unproven shared(device, ATTACKERKEY) then the real server's call binds the real key, never the attacker's", async () => {
  const w = world();
  w.p.devices.add({ id: "srv1", identity: ME, kind: "server", name: "srv1", target: { kind: "identity", id: ME } });
  const REAL = "nodekey:" + "11".repeat(32);
  w.p.peers.shared("srv1", "nodekey:ATTACKERKEY");
  const serve = w.p.peers.serve(async () => "ok");
  w.p.peers.shared("srv1", REAL);
  await serve("device:srv1", "x", {}, { nodeKey: REAL, stableId: "real" });
  assert.equal(w.p.devices.get("srv1").nodeKey, REAL);
  assert.equal(w.p.devices.get("srv1").stableId, "real");
  assert.ok(w.p.peers.shared("srv1", REAL), "the real server is not locked out");
  assert.equal(w.p.peers.shared("srv1", "nodekey:ATTACKERKEY"), null);
});

test("node-key notes expire: a stale note supplies no stable id and never binds", async () => {
  let t = 1_000_000;
  const w = world();
  // a second pairing with a moving clock
  const { createPairing } = await import("./pairing.js");
  const p = createPairing({ ctx: { store: { db: w.db }, config: {}, log() {}, events: { emit() {} }, tool() {} }, now: () => t, identity: async () => ME, space: async () => HARLOW, directory: { memberships: async () => [] }, ports: {}, openCode: async () => ({}), ack: async () => ({ ok: true }), owner: () => {}, relayUrl: async () => "", spaceNow: () => HARLOW });
  p.devices.add({ id: "srv1", identity: ME, kind: "server", name: "srv1", target: { kind: "identity", id: ME } });
  const NK = "nodekey:" + "22".repeat(32);
  p.peers.shared("srv1", NK, "stale-id");
  t += 61_000;
  await p.peers.serve(async () => "ok")("device:srv1", "x", {}, { nodeKey: NK, stableId: "" });
  assert.equal(p.devices.get("srv1").nodeKey, null, "a lapsed claim binds nothing (the gate's rule: only a noted claim for the proven key binds)");
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
  assert.match(st.reason, /already belongs to Personal/);
  assert.match(st.reason, /wink\.remove/);
  assert.match(st.reason, /wink\.server\.retarget/);
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
    ports: { typist: async a => { const r = await a.fetch("http://relay.test/v1/wink/code"); return { ok: false, reason: r.status === 200 ? "ok" : "refused" }; } },
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
  await assert.rejects(() => adopt({ owner: { kind: "identity", id: ME }, identity: ME }), e => refused(e) && /belongs to Harlow Legal/.test(e.message) && /wink\.remove/.test(e.message) && /wink\.server\.retarget/.test(e.message));
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
  const h = await srv.tools.get("wink.server.handover").run({}, { caller: "module:platform" });
  assert.equal(h.handover.authKey, SECRET);
  assert.equal(h.handover.peerSecret, sent.peerSecret);
  await assert.rejects(() => srv.tools.get("wink.server.handover").run({}, { caller: "device:app" }), e => e.code === "denied");
  assert.ok(!JSON.stringify(srv.events).includes(SECRET));
  const dump = JSON.stringify([...srv.tools.keys()]) + JSON.stringify(srv.p.devices.list(ME));
  assert.ok(!dump.includes(SECRET), "not in the device rows");
});
