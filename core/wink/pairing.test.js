// @ts-check
// Pairing: devices belong to the identity, never to a space (DESIGN-wink.md sections 3, 4 and 7). A fake ctx (in-memory store, a tool
// table, an event list), a fake directory (who administers what) and fake typing ports: no relay, no kernel, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createPairing, MIGRATIONS, KIND_OFFERS, parseQr, qrPayload } from "./pairing.js";
import { FORBIDDEN, words } from "./cards.js";

const ME = "per_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const HARLOW = "spc_harlowharlo";   // admin
const NORTHWIND = "spc_northwindbk"; // member only

function world(o = {}) {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  /** @type {Map<string, any>} */
  const tools = new Map();
  const events = /** @type {any[]} */ ([]);
  const ctx = { store: { db }, config: { name: "alex" }, log() {}, events: { emit: (n, d) => events.push([n, d]) }, tool: (n, def) => tools.set(n, def) };
  const typed = /** @type {any[]} */ ([]);
  const finishes = /** @type {any[]} */ ([]);
  const directory = { memberships: async id => id === ME ? [{ space: HARLOW, name: "Harlow Legal", role: "admin" }, { space: NORTHWIND, name: "Northwind Bakery", role: "member" }] : [] };
  const ports = {
    typist: async a => { typed.push(a); return o.typistFails ? { ok: false, reason: o.typistFails } : { ok: true, ack: "WINK-AB12-CD34", seed: new Uint8Array(16), route: "rt" }; },
    finish: async a => { finishes.push(a); return { ok: true, paired: { route: "route-juno", name: "juno" } }; },
  };
  const p = createPairing({
    ctx, now: () => 1_000_000, identity: async () => ME, space: async () => HARLOW, directory, ports,
    openCode: async flow => ({ offer: `wo_${flow}`, code: "WINK-ZZZZ-ZZZZ", expires: 1 }), ack: async () => ({ ok: true }),
    owner: () => {}, relayUrl: async () => "ws://relay.test",
  });
  p.tools();
  const call = (name, input = {}) => tools.get(name).run(input, { caller: "device:x" });
  const fails = async (name, input, code) => { await assert.rejects(() => call(name, input), e => (code ? e.code === code : true) && (e.message || "")); };
  return { p, call, events, typed, finishes, db, tools, fails };
}
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
  for (const [reason, code, re] of [["refused", "refused", /not a Vyre code/], ["offline", "unavailable", /Can't connect/], ["busy", "refused", /Too many tries/]]) {
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
  assert.deepEqual(r.target, { kind: "identity", id: ME });
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
  await w.call("wink.offer.set", { device: "pc", offer: "compute", on: true, space: NORTHWIND, side: "member" });
  assert.equal((await w.p.computeAllowed({ device: "pc", space: NORTHWIND })).ok, false);
  // not a member at all
  w.p.compute.set("spc_nobodyshere1", "pc", "space", true); w.p.compute.set("spc_nobodyshere1", "pc", "member", true);
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
