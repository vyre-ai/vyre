// @ts-check
// shared vault tests, in one process: the manifest chain, invites, two members writing, merges
// and conflicts, read-only members, removal with a new key and rotation flags, and what a peer
// refuses. Each vault is a real Vault in a temp home; sync goes straight to the home's handler.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { verifyChain, signManifest, signRecord, signReceipt } from "./shared.js";
import { openFrom, openItemV2, keyObject, canonical } from "./crypto.js";
import { fingerprint } from "./share.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

/** @type {Map<string, any>} */
const HOMES = new Map();

function mk(t, name) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-shared-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const events = [], logs = [];
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name, vault: { keystore: "file" } }, emit: (type, payload) => events.push({ type, payload }), log: m => logs.push(m) });
  v.relayUrl = `http://127.0.0.1:1/${name}`;
  HOMES.set(v.relayUrl, v);
  v.shared.post = async (url, env) => (await HOMES.get(url).shared.onSync(env)).body;
  t.after(() => { HOMES.delete(v.relayUrl); db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { v, db, events, logs, home };
}

/** `a` pins and verifies `b`'s card under `as`. */
async function know(a, b, as) {
  const c = await b.v.card();
  await a.v.share.addPerson({ card: c.card, name: as }, "cli");
  a.v.share.verifyPerson({ name: as, fingerprint: c.fingerprint }, "cli");
}

const value = async (x, name, field = "value") => (await x.v.fields(x.v.mustRow(name)))[field];

test("the manifest chain: tampering, a non-admin signer, and removing someone without a new key all break it", async t => {
  const a = mk(t, "alex"), d = mk(t, "dana");
  const ia = await a.v.identity(), id = await d.v.identity();
  const alex = { name: "alex", sign: ia.sign.public, box: ia.box.public, role: "owner" };
  const dana = { name: "dana", sign: id.sign.public, box: id.box.public, role: "member" };
  const h = m => crypto.createHash("sha256").update(canonical(m)).digest("base64url");
  const g = signManifest({ v: 1, vault: "vX", name: "team", seq: 1, prev: "", kv: 1, members: [alex], by: alex.sign, at: 1 }, ia.sign.private);
  const two = signManifest({ v: 1, vault: "vX", name: "team", seq: 2, prev: h(g), kv: 1, members: [alex, dana], by: alex.sign, at: 2 }, ia.sign.private);
  assert.equal(verifyChain([g, two]).seq, 2);
  assert.throws(() => verifyChain([{ ...g, name: "other" }]), /not signed/);
  assert.throws(() => verifyChain([g, { ...two, prev: "x" }]), /does not follow|not signed/);
  const byDana = signManifest({ v: 1, vault: "vX", name: "team", seq: 3, prev: h(two), kv: 1, members: [alex, { ...dana, role: "admin" }], by: dana.sign, at: 3 }, id.sign.private);
  assert.throws(() => verifyChain([g, two, byDana]), /not an admin/);
  const quiet = signManifest({ v: 1, vault: "vX", name: "team", seq: 3, prev: h(two), kv: 1, members: [alex], by: alex.sign, at: 3 }, ia.sign.private);
  assert.throws(() => verifyChain([g, two, quiet]), /without a new key/);
  const newOwner = signManifest({ v: 1, vault: "vX", name: "team", seq: 3, prev: h(two), kv: 1, members: [{ ...alex, role: "admin" }, { ...dana, role: "owner" }], by: alex.sign, at: 3 }, ia.sign.private);
  assert.throws(() => verifyChain([g, two, newOwner]), /changed the owner/);
});

test("invite, accept, both write, merge, conflict, read-only, remove with a new key", async t => {
  const a = mk(t, "alex"), d = mk(t, "dana"), s = mk(t, "sam");
  await know(a, d, "dana"); await know(a, s, "sam");
  await a.v.shared.create({ name: "team" }, "cli");
  const token = fake("token");
  await a.v.shared.put({ vault: "team", name: "api-token", kind: "api-key", fields: { value: token }, hosts: ["https://api.example.com"] }, "cli");

  // Only a verified person can be invited.
  const x = mk(t, "xavi");
  await a.v.share.addPerson({ card: (await x.v.card()).card, name: "xavi" }, "cli");
  await assert.rejects(a.v.shared.invite({ vault: "team", person: "xavi" }, "cli"), /not verified/);

  const inv = await a.v.shared.invite({ vault: "team", person: "dana" }, "cli");
  assert.ok(!inv.invite.includes(token));
  await assert.rejects(s.v.shared.accept({ invite: inv.invite }, "cli"), /made for another Vyre/);
  const joined = await d.v.shared.accept({ invite: inv.invite }, "cli");
  assert.equal(joined.vault.role, "member");
  assert.equal(await value(d, "team/api-token"), token, "dana opens what alex wrote");
  assert.ok(a.events.some(e => e.type === "vault.member-added"));

  // Dana writes; alex sees it.
  const dbpw = fake("db");
  await d.v.shared.put({ vault: "team", name: "db-login", kind: "login", fields: { username: "svc", password: dbpw } }, "cli");
  assert.equal(await value(a, "team/db-login", "password"), dbpw);

  // Both edit db-login from the same base. Different fields merge.
  await a.v.shared.put({ vault: "team", name: "db-login", fields: { username: "svc2", password: dbpw } }, "cli");
  const merged = await d.v.shared.put({ vault: "team", name: "db-login", fields: { username: "svc", password: dbpw + "-new" } }, "cli");
  assert.equal(merged.merged, true);
  await a.v.shared.sync({}, "cli");
  assert.deepEqual(await a.v.fields(a.v.mustRow("team/db-login")), { username: "svc2", password: dbpw + "-new" });

  // The same field: the home's version stays, dana's is kept as a conflict revision.
  await a.v.shared.put({ vault: "team", name: "api-token", fields: { value: token + "-a" } }, "cli");
  const c = await d.v.shared.put({ vault: "team", name: "api-token", fields: { value: token + "-d" } }, "cli");
  assert.equal(c.conflict, true);
  assert.ok(d.events.some(e => e.type === "vault.sync-conflicted" && e.payload.name === "team/api-token"));
  assert.equal(await value(d, "team/api-token"), token + "-a");
  assert.equal(d.v.shared.list().vaults[0].conflicts, 1);

  // Read-only sam reads but cannot write.
  const invS = await a.v.shared.invite({ vault: "team", person: "sam", role: "read-only" }, "cli");
  await s.v.shared.accept({ invite: invS.invite }, "cli");
  assert.equal(await value(s, "team/api-token"), token + "-a");
  await assert.rejects(s.v.shared.put({ vault: "team", name: "api-token", fields: { value: "x" } }, "cli"), /not write/);

  // Remove dana: a new key, every item flagged, dana's replica gone.
  const oldWrap = JSON.parse(/** @type {any} */ (d.db.prepare("SELECT wrap FROM vault_shared_wraps WHERE kv = 1").get()).wrap);
  const di = await d.v.identity();
  const oldVk = keyObject(Buffer.from(openFrom(di.box.private, oldWrap, `vyre:vk:v2:shared:${joined.vault.id}:1:${fingerprint({ sign: di.sign.public, box: di.box.public })}`, "vk").vk, "base64"));
  const gone = await a.v.shared.remove({ vault: "team", person: "dana" }, "cli");
  assert.equal(gone.kv, 2);
  assert.deepEqual(gone.rotate.sort(), ["team/api-token", "team/db-login"]);
  assert.ok(a.events.some(e => e.type === "vault.member-removed") && a.events.some(e => e.type === "vault.key-rotated"));
  assert.ok(a.v.list().items.filter(i => i.name.startsWith("team/")).every(i => i.rotate), "everything dana could read is flagged");
  const fresh = fake("fresh");
  await a.v.shared.put({ vault: "team", name: "new-key", fields: { value: fresh } }, "cli");
  const rec = a.v.shared.byName(joined.vault.id, "new-key").rec;
  const at = { vault: `shared:${joined.vault.id}`, id: rec.id, ver: rec.ver, name: "team/new-key" };
  assert.throws(() => openItemV2(oldVk, { ...at, kv: 2 }, rec.sealed), "the old key does not open a new item");
  assert.throws(() => openItemV2(oldVk, { ...at, kv: 1 }, { ...rec.sealed, kv: 1 }), "nor pretending it is old");
  assert.equal(await value(s, "team/new-key").catch(async () => { await s.v.shared.sync({}, "cli"); return value(s, "team/new-key"); }), fresh, "sam, still a member, gets the new key");

  await d.v.shared.sync({}, "cli");
  assert.equal(d.v.shared.row("team").role, "removed");
  assert.equal(d.v.list().items.filter(i => i.name.startsWith("team/")).length, 0);
  const env = await d.v.shared.call({ id: joined.vault.id, home: a.v.relayUrl }, "pull", { since: 0 });
  assert.match(env.error.message, /not a member/);

  // Putting the item again clears its rotation flag.
  await a.v.shared.put({ vault: "team", name: "api-token", fields: { value: fake("rotated") } }, "cli");
  assert.equal(a.v.list().items.find(i => i.name === "team/api-token").rotate, false);

  // Nothing any vault said out loud carries a value.
  for (const who of [a, d, s]) {
    const said = JSON.stringify({ events: who.events, logs: who.logs, audit: who.db.prepare("SELECT * FROM vault_audit").all(), list: who.v.list(), vaults: who.v.shared.list() });
    for (const val of [token, dbpw, fresh]) assert.ok(!said.includes(val), "a value leaked");
  }
});

test("a peer ignores a record whose author could not write, even with the owner's receipt", async t => {
  const a = mk(t, "alex"), s = mk(t, "sam");
  await know(a, s, "sam");
  const made = await a.v.shared.create({ name: "ops" }, "cli");
  await a.v.shared.put({ vault: "ops", name: "one", fields: { value: fake("1") } }, "cli");
  await s.v.shared.accept({ invite: (await a.v.shared.invite({ vault: "ops", person: "sam", role: "read-only" }, "cli")).invite }, "cli");
  // Sam signs a record and a broken home logs it anyway, with a valid owner receipt.
  const id = made.vault.id, ia = await a.v.identity(), is = await s.v.identity();
  const m = a.v.shared.manifest(id);
  const good = a.v.shared.byName(id, "one").rec;
  const rec = signRecord({ ...good, sig: undefined, name: "sneaky", id: "sneaky-id", parent: 0, author: is.sign.public, mseq: m.seq }, is.sign.private);
  delete rec.sig; const signed = signRecord(rec, is.sign.private);
  const rev = 99;
  a.db.prepare("INSERT INTO vault_shared_records (vault, rev, id, body, receipt) VALUES (?,?,?,?,?)").run(id, rev, signed.id, JSON.stringify(signed),
    JSON.stringify(signReceipt({ vault: id, rev, hash: crypto.createHash("sha256").update(canonical(signed)).digest("base64url"), mseq: m.seq }, ia.sign.private)));
  const r = await s.v.shared.sync({}, "cli");
  assert.equal(r.synced[0].ignored, 1);
  assert.ok(!s.v.list().items.some(i => i.name === "ops/sneaky"));
});

test("offboard removes a person from every shared vault it administers and merges the rotate lists", async t => {
  const a = mk(t, "alex"), d = mk(t, "dana");
  await know(a, d, "dana");
  await a.v.shared.create({ name: "team" }, "cli");
  await a.v.shared.put({ vault: "team", name: "api-token", fields: { value: fake("t") } }, "cli");
  await d.v.shared.accept({ invite: (await a.v.shared.invite({ vault: "team", person: "dana" }, "cli")).invite }, "cli");
  const off = await a.v.offboard({ person: "dana" }, "cli");
  assert.deepEqual(off.vaults, ["team"]);
  assert.deepEqual(off.rotate, ["team/api-token"]);
  assert.equal(a.v.shared.manifest(a.v.shared.row("team").id).members.length, 1);
});

test("deleting a shared item: a signed tombstone; a stale delete is refused; the name can be used again", async t => {
  const a = mk(t, "alex"), d = mk(t, "dana"), s = mk(t, "sam");
  await know(a, d, "dana"); await know(a, s, "sam");
  const made = await a.v.shared.create({ name: "team" }, "cli");
  await a.v.shared.put({ vault: "team", name: "old-key", fields: { value: fake("old") } }, "cli");
  await a.v.shared.put({ vault: "team", name: "busy", fields: { value: fake("b") } }, "cli");
  await d.v.shared.accept({ invite: (await a.v.shared.invite({ vault: "team", person: "dana" }, "cli")).invite }, "cli");
  await s.v.shared.accept({ invite: (await a.v.shared.invite({ vault: "team", person: "sam", role: "read-only" }, "cli")).invite }, "cli");

  await assert.rejects(s.v.shared.deleteItem({ vault: "team", name: "old-key" }, "cli"), /not delete/);
  const gone = await d.v.shared.deleteItem({ vault: "team", name: "old-key" }, "cli");
  assert.equal(gone.deleted, "team/old-key");
  assert.ok(!a.v.list().items.some(i => i.name === "team/old-key"), "the home dropped it");
  await s.v.shared.sync({}, "cli");
  assert.ok(!s.v.list().items.some(i => i.name === "team/old-key"), "a peer dropped it");
  const tomb = [...a.v.shared.current(made.vault.id).values()].find(x => x.rec.deleted);
  assert.equal(tomb.rec.sealed, null);
  assert.equal(tomb.rec.author, (await d.v.identity()).sign.public, "the tombstone is signed by who deleted");

  // Dana deletes "busy" from a stale view: alex changed it first. Nothing is deleted.
  await a.v.shared.put({ vault: "team", name: "busy", fields: { value: fake("b2") } }, "cli");
  await assert.rejects(d.v.shared.deleteItem({ vault: "team", name: "busy" }, "cli"), /changed since you last synced/);
  assert.ok(a.v.list().items.some(i => i.name === "team/busy"));

  const again = fake("again");
  await a.v.shared.put({ vault: "team", name: "old-key", fields: { value: again } }, "cli");
  await d.v.shared.sync({}, "cli");
  assert.equal(await value(d, "team/old-key"), again);
  // Rotation re-wraps living items only.
  const r = await a.v.shared.remove({ vault: "team", person: "sam" }, "cli");
  assert.deepEqual(r.rotate.sort(), ["team/busy", "team/old-key"]);
});

test("event-driven pull: the home pokes members after a write; only the home may poke; the timer is ten minutes", async t => {
  const a = mk(t, "alex"), d = mk(t, "dana");
  await know(a, d, "dana");
  await a.v.shared.create({ name: "team" }, "cli");
  await d.v.shared.accept({ invite: (await a.v.shared.invite({ vault: "team", person: "dana" }, "cli")).invite }, "cli");
  const v = fake("poked");
  await a.v.shared.put({ vault: "team", name: "poked", fields: { value: v } }, "cli");
  const end = Date.now() + 5000;
  while (!d.v.list().items.some(i => i.name === "team/poked") && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  assert.equal(await value(d, "team/poked"), v, "dana pulled without being asked");

  // A poke signed by someone other than the home is refused.
  const { syncEnvelope } = await import("./relay.js");
  const di = await d.v.identity();
  const id = d.v.shared.row("team").id;
  const forged = syncEnvelope({ vault: id, op: "poke", body: {}, from: di.sign.public, privDer: di.sign.private, aud: d.v.relayUrl });
  assert.equal((await d.v.shared.onSync(forged)).status, 403);

  const seen = [];
  const real = globalThis.setInterval;
  globalThis.setInterval = /** @type {any} */ ((fn, ms) => { seen.push(ms); return real(fn, ms); });
  try { d.v.devices.start(); } finally { globalThis.setInterval = real; }
  d.v.devices.stop();
  assert.ok(seen.length && seen.every(ms => ms >= 10 * 60_000), `timers: ${seen}`);
});
