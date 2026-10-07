// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../store/index.js";
import { createStorageDevices, registerStorageTools, MIGRATIONS } from "./index.js";
import { storageGrants } from "./grants.js";
import { storageCard, size } from "./cards.js";
import { FORBIDDEN } from "../cards.js";
import { fakeS3 } from "./testing/fake-s3.js";

const SPACE = "spc_abcdefghijkl";
const SECRET = "Zx9-very-secret-value-42";
const ACCESS = "AKFAKE1ACCESS";
const SELF = { kind: "person", id: "per_alexalexalexalexalexalexal", space: SPACE };

/** A world: a store, a fake vault, grants, a fake bucket and fake scanners. */
async function world(t, o = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  migrate(db, "wink-storage", MIGRATIONS);
  const events = [], logs = [];
  const ctx = { store: { db }, events: { emit: (type, payload) => events.push({ type, payload }) }, log: m => logs.push(m), config: { name: "Alex's Mac" }, tools: new Map(), tool(name, def) { this.tools.set(name, def); } };
  const items = new Map();
  const vault = {
    put: async ({ name, fields, description }) => { if (o.vaultFails) throw new Error("vault locked"); items.set(name, { fields, description }); },
    fetch: async (name, field) => { const i = items.get(name); if (!i) throw new Error("no item"); return i.fields[field]; },
    remove: async name => { items.delete(name); },
  };
  const bucket = await fakeS3({ bucket: "harlow-backup", accessKey: ACCESS, secretKey: SECRET });
  t.after(bucket.close);
  let clock = 5_000_000;
  const reachState = { tcp: true, path: true };
  const candidates = [{ name: "Office drive", kind: "smb", host: "nas.local", share: "Files", size: 2e12 }, { name: "Spare disk", kind: "usb-disk", path: "/Volumes/Spare" }];
  const admins = new Set([SPACE]);
  const s = createStorageDevices({
    ctx, vault, grants: storageGrants({ ctx, space: () => SPACE, now: () => clock }), space: () => SPACE, now: () => clock,
    scanners: [{ name: "fake", scan: async () => ({ found: candidates }) }], from: () => "Alex's Mac mini",
    reach: { tcp: async () => reachState.tcp, path: () => reachState.path },
    admin: { self: async () => SELF, isAdmin: async (p, sp) => p === SELF.id && admins.has(sp), nameOf: async ow => (ow.kind === "space" ? "Harlow Legal" : "Personal") },
  });
  const pairArgs = { kind: "s3", endpoint: bucket.endpoint, bucket: "harlow-backup", region: "us-east-1", accessKey: ACCESS, secretKey: SECRET, capacity: 1.5e12, owner: `space:${SPACE}`, residency: "US only" };
  return { s, db, events, logs, vault, items, bucket, ctx, reachState, admins, pairArgs, tick: ms => { clock += ms; } };
}
/** Everything the world wrote anywhere, as one string. */
function everything(w, ...results) {
  const rows = ["wink_storage_devices", "wink_storage_grants", "_migrations"].map(n => JSON.stringify(w.db.prepare(`SELECT * FROM ${n}`).all()));
  return [...rows, JSON.stringify(w.events), JSON.stringify(w.logs), ...results.map(r => JSON.stringify(r))].join("\n");
}

test("pairing a bucket: tried first, saved in the vault only, a device with a storage offer and a grant", async t => {
  const w = await world(t);
  const r = await w.s.pair(w.pairArgs);
  assert.equal(r.device.kind, "s3");
  assert.deepEqual(r.device.storage.class, ["cold", "backup"]);
  assert.equal(r.device.storage.capacity, 1.5e12);
  assert.equal(r.device.storage.residency, "US only");
  assert.equal(r.device.ciphertextOnly, true);
  assert.equal(r.card.allows.startsWith("Lets Harlow Legal keep encrypted copies here, up to 1.5 TB."), true);
  assert.ok(!FORBIDDEN.test(Object.values(r.card).join(" ")), "card words stay clear of the forbidden ones");
  assert.ok(!/—|§/.test(JSON.stringify(r.card)));
  // the vault has it, nothing else does
  const [name, item] = [...w.items.entries()][0];
  assert.deepEqual(item.fields, { accessKey: ACCESS, secretKey: SECRET });
  const row = w.db.prepare("SELECT * FROM wink_storage_devices").get();
  assert.equal(row.vault_ref, `vault://${name}`);
  const all = everything(w, r, w.s.offers(), await w.s.status());
  assert.ok(!all.includes(SECRET), "the secret appears nowhere outside the vault");
  assert.ok(!all.includes(ACCESS), "nor does the access ID");
  assert.ok(!JSON.stringify(w.s.offers()).includes("vault://"), "a person's offer list carries no reference");
  // events and the grant
  assert.deepEqual(w.events.filter(e => e.type.startsWith("storage.")).map(e => e.type), ["storage.paired"]);
  const grant = JSON.parse(w.db.prepare("SELECT body FROM wink_storage_grants").get().body);
  assert.equal(grant.subject.actor.kind, "device");
  assert.equal(grant.source, "wink:W3");
  assert.deepEqual(grant.actions, ["storage.hold"]);
  assert.ok(grant.resource.prefix.startsWith(`vyre://${SPACE}/storage/`));
});

test("pairing: a login that does not work is never saved, and the reason is plain", async t => {
  const w = await world(t);
  await assert.rejects(w.s.pair({ ...w.pairArgs, secretKey: "wrong-wrong-wrong" }), e => { assert.equal(e.code, "probe_failed"); assert.match(e.message, /rejected the secret/); assert.ok(!e.message.includes("wrong-wrong")); return true; });
  await assert.rejects(w.s.pair({ ...w.pairArgs, bucket: "no-such" }), /no bucket with that name/);
  await assert.rejects(w.s.pair({ ...w.pairArgs, endpoint: "http://example.com" }), /not encrypted/);
  await assert.rejects(w.s.pair({ ...w.pairArgs, capacity: undefined }), /how much room/);
  await assert.rejects(w.s.pair({ ...w.pairArgs, kind: "ftp" }), /Kind is s3/);
  await assert.rejects(w.s.pair({ ...w.pairArgs, classes: ["hot"] }), /cold, backup and working/);
  assert.equal(w.items.size, 0);
  assert.equal(w.db.prepare("SELECT count(*) AS n FROM wink_storage_devices").get().n, 0);
  assert.equal(w.events.length, 0);
});

test("pairing: when the vault or the grant fails, nothing is left behind", async t => {
  const w = await world(t, { vaultFails: true });
  await assert.rejects(w.s.pair(w.pairArgs), /vault locked/);
  assert.equal(w.db.prepare("SELECT count(*) AS n FROM wink_storage_devices").get().n, 0);
  const w2 = await world(t);
  w2.s = createStorageDevices({ ctx: w2.ctx, vault: { put: async o => { w2.items.set(o.name, o); }, fetch: async () => "", remove: async n => { w2.items.delete(n); } }, space: () => SPACE,
    grants: { create: async () => { throw new Error("grant refused"); }, revoke: async () => {} }, admin: { self: async () => SELF, isAdmin: async () => true, nameOf: async () => "x" }, scanners: [] });
  await assert.rejects(w2.s.pair(w2.pairArgs), /grant refused/);
  assert.equal(w2.items.size, 0, "the saved login is taken back out of the vault");
});

test("owner: yourself by default, a space only if you administer it, never another person", async t => {
  const w = await world(t);
  const mine = await w.s.pair({ ...w.pairArgs, owner: undefined });
  assert.deepEqual(mine.device.owner, { kind: "person", id: SELF.id });
  assert.match(mine.card.allows, /^Lets Personal keep encrypted copies/);
  w.admins.clear();
  await assert.rejects(w.s.pair(w.pairArgs), e => e.code === "denied" && /not an admin/.test(e.message));
  await assert.rejects(w.s.pair({ ...w.pairArgs, owner: { kind: "person", id: "per_someoneelse" } }), /yourself or to a space/);
  await assert.rejects(w.s.pair({ ...w.pairArgs, owner: "banana" }), /Name the space/);
  assert.equal(w.s.offers({ owner: { kind: "person", id: SELF.id } }).length, 1);
  assert.equal(w.s.offers({ owner: { kind: "space", id: SPACE } }).length, 0);
});

test("discovery pick: card words, size limits, a drive that is not answering, a login goes to the vault", async t => {
  const w = await world(t);
  const d = await w.s.discover();
  assert.equal(d.candidates.length, 2);
  assert.equal(d.candidates[0].label, "Office drive (2 TB), seen from Alex's Mac mini");
  const [office, spare] = d.candidates;
  const card = await w.s.card({ candidate: office.id, owner: `space:${SPACE}`, capacity: 1.5e12 });
  assert.equal(card.who, "Office drive, seen from Alex's Mac mini");
  assert.match(card.allows, /Lets Harlow Legal keep encrypted copies here, up to 1.5 TB/);
  await assert.rejects(w.s.pick({ candidate: office.id, capacity: 3e12 }), /about 2 TB/);
  await assert.rejects(w.s.pick({ candidate: spare.id }), /how much room/);
  await assert.rejects(w.s.pick({ candidate: "cand_gone", capacity: 1e9 }), /Search again/);
  w.reachState.tcp = false;
  await assert.rejects(w.s.pick({ candidate: office.id, capacity: 1e12 }), /nas.local did not answer/);
  w.reachState.tcp = true;
  const r = await w.s.pick({ candidate: office.id, owner: `space:${SPACE}`, capacity: 1.5e12, username: "alex", password: "nas-pass-77" });
  assert.equal(r.device.kind, "smb");
  assert.equal(r.device.seenFrom, "Alex's Mac mini");
  assert.ok(!everything(w, r, w.s.offers()).includes("nas-pass-77"));
  assert.equal([...w.items.values()][0].fields.password, "nas-pass-77");
  const usb = await w.s.pick({ candidate: spare.id, capacity: 5e11, classes: ["backup"] });
  assert.equal(usb.device.kind, "usb-disk");
  assert.equal(w.items.size, 1, "a disk with no login saves nothing in the vault");
});

test("the pool engine seam: credentials by reference need the owner, and stop when the device is removed", async t => {
  const w = await world(t);
  await w.s.pair(w.pairArgs);
  const [offer] = w.s.poolOffers();
  assert.match(offer.credentialRef, /^vault:\/\/wink-storage-sto_/);
  assert.equal(offer.location.bucket, "harlow-backup");
  const c = await w.s.getCredentials(offer.credentialRef, { by: SELF });
  assert.equal(c.secretKey, SECRET);
  await assert.rejects(w.s.getCredentials(offer.credentialRef, { by: { kind: "person", id: "per_other" } }), e => e.code === "denied");
  await assert.rejects(w.s.getCredentials(offer.credentialRef, { by: { kind: "device", id: SELF.id } }), e => e.code === "denied");
  await assert.rejects(w.s.getCredentials(offer.credentialRef, {}), e => e.code === "denied");
  await assert.rejects(w.s.getCredentials("vault://nothing", { by: SELF }), e => e.code === "not_found");
  w.s.setUsed(offer.id, 123456);
  assert.equal(w.s.offers()[0].storage.used, 123456);
  await w.s.remove({ id: offer.id });
  await assert.rejects(w.s.getCredentials(offer.credentialRef, { by: SELF }), e => e.code === "not_found");
});

test("remove now: the grant is revoked, the saved login is deleted, one event; remove with drain records intent and waits for the pool engine", async t => {
  const w = await world(t);
  const a = await w.s.pair(w.pairArgs);
  const b = await w.s.pair({ ...w.pairArgs, name: "Second bucket" });
  const r = await w.s.remove({ id: a.device.id });
  assert.equal(r.removed, true);
  assert.equal(w.items.size, 1);
  assert.deepEqual(w.s.offers().map(o => o.id), [b.device.id]);
  const gone = w.events.filter(e => e.type === "storage.removed");
  assert.deepEqual(gone[0].payload, { id: a.device.id, kind: "s3", name: a.device.name, owner: { kind: "space", id: SPACE }, drain: false, final: true });
  assert.equal(w.events.filter(e => e.type === "grant.revoked").length, 1);

  const d = await w.s.remove({ id: b.device.id, drain: true });
  assert.equal(d.removed, false);
  assert.equal(d.draining, true);
  assert.match(d.prompt, /copies everything off it first/);
  assert.equal(w.s.offers()[0].state, "draining");
  assert.deepEqual(w.s.drainRequests().map(o => o.id), [b.device.id]);
  assert.equal(w.items.size, 1, "still needed while the pool engine copies off");
  await w.s.remove({ id: b.device.id, drain: true });
  assert.equal(w.events.filter(e => e.type === "storage.removed").length, 2, "asking twice is one intent");
  await w.s.completeDrain(b.device.id);
  assert.equal(w.s.offers().length, 0);
  assert.equal(w.items.size, 0);
  assert.equal(w.events.filter(e => e.type === "storage.removed").at(-1).payload.final, true);
  await assert.rejects(w.s.remove({ id: b.device.id }), /No such storage/);
  await assert.rejects(w.s.completeDrain(a.device.id), /No such storage/);
});

test("reachability: unreachable is announced once on the way down, status never looks twice inside a minute, an expired offer says so", async t => {
  const w = await world(t);
  const a = await w.s.pair({ ...w.pairArgs, expires: 5_000_000 + 10 * 86_400_000 });
  const usb = (await w.s.discover()).candidates.find(c => c.kind === "usb-disk");
  const u = await w.s.pick({ candidate: usb.id, capacity: 1e11 });
  w.bucket.seen.length = 0;
  await w.s.probeAll();
  assert.equal(w.bucket.seen.length, 1);
  w.bucket.setDown(true);
  w.reachState.path = false;
  await w.s.probeAll();
  await w.s.probeAll();
  const down = w.events.filter(e => e.type === "storage.unreachable");
  assert.equal(down.length, 2, "one per device, not one per look");
  assert.match(down.find(e => e.payload.id === a.device.id).payload.reason, /busy|problem/);
  assert.ok(!everything(w).includes(SECRET));
  const before = w.bucket.seen.length;
  const st = await w.s.status({ id: a.device.id });
  assert.equal(st.devices[0].state, "unreachable");
  assert.equal(w.bucket.seen.length, before, "status inside a minute reuses the last look");
  w.bucket.setDown(false); w.reachState.path = true;
  w.tick(61_000);
  assert.equal((await w.s.status({ id: a.device.id })).devices[0].state, "online");
  w.tick(11 * 86_400_000);
  assert.equal(w.s.offers().find(o => o.id === a.device.id).state, "expired");
  await assert.rejects(w.s.status({ id: "sto_nope" }), /No such storage/);
  assert.ok(u);
});

test("tools: owner surfaces only, results carry no secret, presence words are the card", async t => {
  const w = await world(t);
  registerStorageTools(w.ctx, w.s, "wink.storage");
  assert.deepEqual([...w.ctx.tools.keys()].sort(), ["wink.storage.card", "wink.storage.discover", "wink.storage.offers", "wink.storage.pair", "wink.storage.pick", "wink.storage.remove", "wink.storage.status"]);
  const call = (name, input, caller = "cli") => w.ctx.tools.get(`wink.storage.${name}`).run(input, { caller });
  await assert.rejects(call("pair", w.pairArgs, "agent:juno"), e => e.code === "denied");
  await assert.rejects(call("offers", {}, "tailnet-guest:x"), e => e.code === "denied");
  const paired = await call("pair", w.pairArgs);
  const out = [paired, await call("offers", {}), await call("status", {}), await call("discover", {}), await call("card", { bucket: "b", capacity: 1e12 })];
  assert.ok(!everything(w, ...out).includes(SECRET));
  assert.match(await w.ctx.tools.get("wink.storage.pair").presence.summary(w.pairArgs), /^Lets Harlow Legal keep encrypted copies here, up to 1.5 TB/);
  assert.match((await call("remove", { id: paired.device.id, drain: true })).prompt, /copies everything off/);
  assert.equal(w.ctx.tools.get("wink.storage.remove").presence.summary({ drain: true }) instanceof Promise, true);
});

test("card words: sizes people say, no forbidden words, no em dash, no section sign", () => {
  assert.equal(size(1.5e12), "1.5 TB");
  assert.equal(size(2e12), "2 TB");
  assert.equal(size(300e9), "300 GB");
  assert.equal(size(0), "an unstated amount");
  for (const how of ["discovery", "credentials"]) for (const classes of [["cold", "backup"], ["backup"], ["cold", "backup", "working"]]) {
    const c = storageCard({ how: /** @type {any} */ (how), name: "Office drive", owner: "Harlow Legal", capacity: 1.5e12, seenFrom: "Alex's Mac mini", classes, residency: "office", days: 30 });
    const text = Object.values(c).join(" ");
    assert.ok(!FORBIDDEN.test(text), text);
    assert.ok(!/—|§/.test(text));
    assert.match(c.allows, /keep encrypted copies here, up to 1.5 TB/);
  }
});
