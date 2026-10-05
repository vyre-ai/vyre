// @ts-check
// The identity home: the person's identity memory kept as ciphertext on a space server. An admin or root there cannot read it; the person's own assistant can, after the person's phone says
// yes; and moving it to the person's own server keeps it, unread on the way.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tempHome } from "../../../test/helpers.js";
import { newDeviceKey, newKey, seal, open, wrapForDevice, unwrapWithDevice, wrapWithCode, unwrapWithCode } from "../../../lib/keywrap.js";
import { IdentityHome, FileBackend, Lease, approveUnlock, Phone, newServerKey, signAsk, askSignedBy } from "./home.js";

const SNAP = { v: 1, tables: { memory_me_facts: [{ id: "f1", subj: "me", rel: "lives_in", obj: "place:Lisbon" }, { id: "f2", subj: "me", rel: "uses", obj: "tool:Postgres" }] }, state: { assistant: "prefers short emails" } };
const SECRETS = ["Lisbon", "Postgres", "prefers short emails", "lives_in", "memory_me_facts"];

/** Every byte a server holds for this identity, as text. */
const everything = (dir) => { const out = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(fs.readFileSync(p, "utf8")); } }; walk(dir); return out.join("\n"); };

function world(t) {
  const root = tempHome(t);
  let at = 1_000_000;
  const now = () => at;
  const server = new FileBackend(path.join(root, "space-server"), "the Space's server");
  const phone = newDeviceKey();
  const laptop = newDeviceKey();
  const home = new IdentityHome({ id: "ident_alex", backend: server, now });
  return { root, server, phone, laptop, home, now, tick: ms => { at += ms; } };
}

test("crypto: a box opens only under its key and its binding; a wrap opens only for the device or the code it was made for", () => {
  const key = newKey();
  const box = seal("hello", key, "a/1");
  assert.equal(open(box, key, "a/1").toString(), "hello");
  assert.throws(() => open(box, newKey(), "a/1"), { code: "cannot_open" });
  assert.throws(() => open(box, key, "a/2"), { code: "cannot_open" }, "moved to another place it does not open");
  const dev = newDeviceKey(), other = newDeviceKey();
  const w = wrapForDevice(key, dev.publicJwk, "wrap");
  assert.deepEqual(unwrapWithDevice(w, dev.privateJwk, "wrap"), key);
  assert.throws(() => unwrapWithDevice(w, other.privateJwk, "wrap"), { code: "cannot_open" });
  assert.throws(() => unwrapWithDevice(w, dev.privateJwk, "other"), { code: "cannot_open" });
  const c = wrapWithCode(key, "four words and more", "code");
  assert.deepEqual(unwrapWithCode(c, "four words and more", "code"), key);
  assert.throws(() => unwrapWithCode(c, "four words", "code"), { code: "cannot_open" });
});

test("an admin or root on the space server cannot read the identity memory: only ciphertext and wrapped keys are there, and nothing they can do with them opens it", t => {
  const w = world(t);
  const lease = w.home.create({ devices: [{ label: "phone", publicJwk: w.phone.publicJwk }], recoveryCode: "four words and more", snapshot: SNAP });
  assert.equal(w.home.save(lease, SNAP), 2);
  // Everything the server holds, read raw as the admin and as root would: no fact, no relation, no table name.
  const raw = everything(w.server.dir);
  for (const s of SECRETS) assert.ok(!raw.includes(s), `${s} is readable on the server`);
  assert.ok(raw.includes("wrapped") && raw.includes("sha256"), "what is there is the manifest and the box");
  const m = w.home.manifest();
  // They hold the wrapped keys and the public keys. A wrap opens only with a private key they do not have: not another device's, not a made-up one.
  const admin = newDeviceKey();
  const mine = m.wraps.find(x => x.kind === "device");
  assert.throws(() => unwrapWithDevice(mine.wrapped, admin.privateJwk, `vyre-identity-home/ident_alex/wrap:${mine.fp}`), { code: "cannot_open" });
  // They can try keys on the snapshot: a random key, the manifest's hashes as a key, a key from a copy of the wrap's own bytes.
  const snap = JSON.parse(fs.readFileSync(path.join(w.server.dir, "identity", "ident_alex", "snap-2.json"), "utf8"));
  for (const k of [newKey(), crypto.createHash("sha256").update(raw).digest(), Buffer.alloc(32), Buffer.from(mine.wrapped.ct, "base64url").subarray(0, 32)]) assert.throws(() => open(snap, k, "vyre-identity-home/ident_alex/snap:2"), { code: "cannot_open" });
  // They can write: a manifest that wraps a key of their own for their own device. The person's device has no wrap there, and a key that is not the memory's key opens nothing.
  const theirKey = newKey();
  fs.writeFileSync(path.join(w.server.dir, "identity", "ident_alex", "manifest.json"), JSON.stringify({ ...m, wraps: [{ kind: "device", fp: "x", wrapped: wrapForDevice(theirKey, admin.publicJwk, "x") }] }));
  const ask = w.home.beginUnlock();
  assert.throws(() => approveUnlock(w.phone, ask.ask), { code: "unknown_key" }, "the person's phone finds no key of theirs and gives nothing");
  assert.throws(() => w.home.load(new Lease(theirKey, "ident_alex", w.now() + 1000, w.now)), { code: "cannot_open" }, "and a key that is not the memory's own opens nothing");
  // A snapshot they swap in from another place (or an old revision) does not open under this one's binding.
  fs.writeFileSync(path.join(w.server.dir, "identity", "ident_alex", "manifest.json"), JSON.stringify(m));
  fs.writeFileSync(path.join(w.server.dir, "identity", "ident_alex", "snap-2.json"), JSON.stringify(seal(JSON.stringify(SNAP), newKey(), "vyre-identity-home/ident_alex/snap:2")));
  assert.throws(() => w.home.load(lease), { code: "corrupt" });
});

test("the person's own assistant reads it once the phone answers, and nothing times out and asks again; a stranger's phone, another request's answer or the wrong secret open nothing", t => {
  const w = world(t);
  w.home.create({ devices: [{ publicJwk: w.phone.publicJwk }], snapshot: SNAP }).lock();
  const { ask, secret } = w.home.beginUnlock();
  const answer = approveUnlock(w.phone, ask);
  const lease = w.home.finishUnlock(ask, secret, answer);
  assert.deepEqual(w.home.load(lease).tables, SNAP.tables);
  assert.deepEqual(w.home.load(lease).state, SNAP.state);
  assert.equal(w.home.save(lease, { ...SNAP, state: { assistant: "prefers short emails", pm: "async standups" } }), 2);
  assert.equal(w.home.load(lease).state.pm, "async standups");
  assert.ok(!everything(w.server.dir).includes("async standups"));
  // No lease timer: a day later it is still open (the person is not asked again).
  w.tick(24 * 60 * 60_000);
  assert.equal(lease.open, true);
  assert.equal(w.home.load(lease).state.pm, "async standups");
  // Locked, it is closed.
  lease.lock();
  assert.throws(() => w.home.load(lease), { code: "locked" });
  const stranger = newDeviceKey();
  assert.throws(() => approveUnlock(stranger, ask), { code: "unknown_key" });
  const other = w.home.beginUnlock();
  assert.throws(() => w.home.finishUnlock(ask, secret, approveUnlock(w.phone, other.ask)), { code: "cannot_open" });
  assert.throws(() => w.home.finishUnlock(ask, other.secret, answer), { code: "cannot_open" });
  // A second device is added by an unlocked session, and then unlocks on its own.
  const fresh = w.home.beginUnlock();
  const l1 = w.home.finishUnlock(fresh.ask, fresh.secret, approveUnlock(w.phone, fresh.ask));
  w.home.addDevice(l1, { label: "laptop", publicJwk: w.laptop.publicJwk });
  const again = w.home.beginUnlock();
  assert.deepEqual(w.home.load(w.home.finishUnlock(again.ask, again.secret, approveUnlock(w.laptop, again.ask))).state.pm, "async standups");
});

test("on the person's own device the device key unwraps with no prompt", t => {
  const w = world(t);
  w.home.create({ devices: [{ publicJwk: w.phone.publicJwk }, { publicJwk: w.laptop.publicJwk }], snapshot: SNAP }).lock();
  assert.deepEqual(w.home.load(w.home.unlockWithDevice(w.laptop)).tables, SNAP.tables);
  assert.throws(() => w.home.unlockWithDevice(newDeviceKey()), { code: "unknown_key" });
});

test("on a shared server the person says yes once: the phone then answers that server's requests by itself, after a restart too, until it is revoked; only that server, only signed", t => {
  const w = world(t);
  w.home.create({ devices: [{ publicJwk: w.phone.publicJwk }], snapshot: SNAP }).lock();
  const phone = new Phone(w.phone);
  const server = { name: "the Space's server", ...newServerKey() };
  const other = { name: "another server", ...newServerKey() };
  // Not granted yet: the phone does not answer, and says why.
  assert.throws(() => phone.answer(w.home.beginUnlock(server).ask), { code: "needs_yes" });
  // The one yes.
  const fp = phone.grant(server.publicJwk);
  w.home.addGrant({ server: server.name, fp });
  assert.deepEqual(w.home.grants().map(g => g.server), ["the Space's server"]);
  w.home.save(w.home.unlockWithDevice(w.phone), SNAP);
  assert.deepEqual(w.home.grants().map(g => g.server), ["the Space's server"], "a new revision keeps the grants");
  const open = () => { const { ask, secret } = w.home.beginUnlock(server); return w.home.finishUnlock(ask, secret, phone.answer(ask)); };
  assert.deepEqual(w.home.load(open()).tables, SNAP.tables);
  // A restart is the same request again, answered the same way, with no prompt.
  assert.deepEqual(w.home.load(open()).tables, SNAP.tables);
  // Another server's request, an unsigned one, and a request someone altered are not answered.
  assert.throws(() => phone.answer(w.home.beginUnlock(other).ask), { code: "needs_yes" });
  const { ask } = w.home.beginUnlock(server);
  assert.throws(() => phone.answer({ ...ask, sig: undefined }), { code: "bad_signature" });
  assert.throws(() => phone.answer({ ...ask, sessionPub: newDeviceKey().publicJwk }), { code: "bad_signature" }, "a request carrying someone else's key is not the one the server signed");
  assert.equal(askSignedBy(ask, server.publicJwk), true);
  assert.equal(askSignedBy(ask, other.publicJwk), false);
  // Revoked from the phone: nothing is answered again.
  assert.equal(phone.revoke(fp), true);
  w.home.removeGrant();
  assert.deepEqual(w.home.grants(), []);
  assert.throws(() => phone.answer(w.home.beginUnlock(server).ask), { code: "needs_yes" });
});

test("the recovery code unlocks it on the person's own device, and only the right code", t => {
  const w = world(t);
  w.home.create({ devices: [{ publicJwk: w.phone.publicJwk }], recoveryCode: "four words and more", snapshot: SNAP }).lock();
  assert.deepEqual(w.home.load(w.home.unlockWithCode("four words and more")).tables, SNAP.tables);
  assert.throws(() => w.home.unlockWithCode("four words"), { code: "cannot_open" });
  const none = world(t);
  none.home.create({ devices: [{ publicJwk: none.phone.publicJwk }], snapshot: SNAP }).lock();
  assert.throws(() => none.home.unlockWithCode("anything"), { code: "not_found" });
});

test("moving the home to the person's own server keeps it: the same ciphertext arrives, still unlocks with the same phone, and the old server keeps only a marker", t => {
  const w = world(t);
  const lease = w.home.create({ devices: [{ publicJwk: w.phone.publicJwk }], recoveryCode: "four words and more", snapshot: SNAP });
  w.home.save(lease, SNAP);
  const own = new FileBackend(path.join(w.root, "my-own-tiny-server"), "my server");
  const before = JSON.parse(fs.readFileSync(path.join(w.server.dir, "identity", "ident_alex", "snap-2.json"), "utf8"));
  const r = w.home.move(own);
  assert.deepEqual(r, { moved: 1, to: "my server" });
  // The old server: a marker and nothing else. Admins there read where it went, never what it held.
  assert.deepEqual(fs.readdirSync(path.join(w.server.dir, "identity", "ident_alex")), ["moved.json"]);
  assert.equal(w.home.exists(), false);
  assert.equal(w.home.movedTo(), "my server");
  assert.throws(() => w.home.beginUnlock(), { code: "not_found" });
  // The new one holds the very same ciphertext, none of it readable, and the same phone opens it.
  const there = new IdentityHome({ id: "ident_alex", backend: own, now: w.now });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(own.dir, "identity", "ident_alex", "snap-2.json"), "utf8")), before);
  for (const s of SECRETS) assert.ok(!everything(own.dir).includes(s), s);
  const { ask, secret } = there.beginUnlock();
  const l = there.finishUnlock(ask, secret, approveUnlock(w.phone, ask));
  assert.deepEqual(there.load(l).tables, SNAP.tables);
  assert.deepEqual(there.load(there.unlockWithCode("four words and more")).state, SNAP.state, "and the recovery code too");
  assert.equal(there.save(l, SNAP), 3, "it carries on there");
  // It does not move onto a server that already holds one, and a damaged object stops a move before anything changes.
  assert.throws(() => there.move(own), { code: "exists" });
});

test("a move checks every object against the manifest: a damaged one stops it with nothing moved or removed", t => {
  const w = world(t);
  w.home.create({ devices: [{ publicJwk: w.phone.publicJwk }], snapshot: SNAP }).lock();
  const file = path.join(w.server.dir, "identity", "ident_alex", "snap-1.json");
  fs.appendFileSync(file, " ");
  const to = new FileBackend(path.join(w.root, "dest"));
  assert.throws(() => w.home.move(to), { code: "corrupt" });
  assert.ok(w.home.exists(), "still here");
  assert.deepEqual(to.list("identity/ident_alex"), []);
});

test("names are checked: a backend never reaches outside its folder", t => {
  const w = world(t);
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "a//b", "a b"]) assert.throws(() => w.server.get(bad), { code: "bad_input" }, bad);
  assert.throws(() => new IdentityHome({ id: "../x", backend: w.server }), { code: "bad_input" });
});
