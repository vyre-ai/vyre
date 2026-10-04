// @ts-check
// vyre-core phase 1b (ADR 0040): with core installed, vyred's presence checks a key-based proof
// against core's keys, never its own presence_keys (which a model's shell can write on a Mac),
// and refuses to enroll or remove a key itself.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startCore } from "./server.js";
import { readCoreConfig, coreLink } from "../../lib/vyre-core-client.js";
import { Presence, inputHash } from "../presence/index.js";
import { open } from "../store/index.js";
import { SCRATCH } from "../../test/scratch.mjs";

const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const APPROVE = { tool: "gate.approve", input: { id: "a1" } };

function deviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const proof = (id, tool = APPROVE.tool, input = APPROVE.input) => {
    const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    return { method: "device", key: id, ts, nonce, sig };
  };
  return { pub, proof };
}

async function world(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vl-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, "c.sock");
  const c = await startCore({ socket, dataDir: path.join(dir, "core"), ownerUid: uid, peerCred: async () => ({ pid: process.pid, uid }) });
  t.after(() => c.close());
  // vyred's own store: the person's uid can write it, a model's shell included.
  const db = open(path.join(dir, "vyred", "vyre.db"));
  t.after(() => db.close());
  const vyred = new Presence({ db, role: "local", touchid: null, writeTty: () => {}, who: async () => [], env: {}, core: coreLink({ socket, uid }) });
  return { c, db, vyred, socket, dir };
}

test("vyre-core link: core.json is trusted only when root owns it and its folder, and nobody else can write them", () => {
  const f = "/Library/Application Support/Vyre/core.json";
  const st = (o) => /** @type {any} */ ({ isFile: () => !o.dir, isDirectory: () => Boolean(o.dir), uid: o.uid ?? 0, mode: o.mode ?? 0o644 });
  const io = (file, dir, text = JSON.stringify({ socket: "/var/run/vyre/vyre-core.sock", uid: 280 }), up = {}) => ({
    lstat: p => (p === f ? st(file) : p === path.dirname(f) ? st({ dir: true, ...dir }) : st({ dir: true, mode: 0o755, ...(up[p] || {}) })), read: () => text });
  assert.deepEqual(readCoreConfig(f, io({}, { mode: 0o755 })), { socket: "/var/run/vyre/vyre-core.sock", uid: 280 });
  assert.equal(readCoreConfig(f, io({ uid: 501 }, { mode: 0o755 })), null, "owned by the person");
  assert.equal(readCoreConfig(f, io({ mode: 0o666 }, { mode: 0o755 })), null, "writable by others");
  assert.equal(readCoreConfig(f, io({}, { mode: 0o777 })), null, "in a folder others can write");
  assert.equal(readCoreConfig(f, io({}, { uid: 501, mode: 0o755 })), null, "in the person's folder");
  assert.equal(readCoreConfig(f, io({}, { mode: 0o755 }, undefined, { "/Library/Application Support": { uid: 501 } })), null, "under a folder the person owns");
  assert.equal(readCoreConfig(f, io({}, { mode: 0o755 }, undefined, { "/Library": { mode: 0o777 } })), null, "under a folder others can write");
  assert.equal(readCoreConfig(f, io({}, { mode: 0o755 }, "{")), null, "not JSON");
  assert.equal(readCoreConfig(f, io({}, { mode: 0o755 }, JSON.stringify({ socket: "rel.sock", uid: 280 }))), null, "a relative socket");
  assert.equal(readCoreConfig(f, io({}, { mode: 0o755 }, JSON.stringify({ socket: "/x.sock", uid: 0 }))), null, "core as root");
  assert.equal(readCoreConfig(path.join(SCRATCH, "no-such-core.json")), null);
});

test("vyre-core link: vyred checks a key's proof against core's keys, never its own presence_keys", async t => {
  const { c, db, vyred } = await world(t);
  const phone = deviceKey();
  const id = c.presence.enroll({ kind: "device", name: "alex-phone", public_key: phone.pub, alg: -7 }).id;
  assert.deepEqual(await vyred.verify({ ...APPROVE, caller: "cli", proof: phone.proof(id) }), { ok: true, method: "device", keyId: id });
  // Signed for another call: core says no, and so does vyred.
  const other = await vyred.verify({ tool: "gate.approve", input: { id: "b2" }, caller: "cli", proof: phone.proof(id) });
  assert.equal(other.ok, false);

  // What a model's shell can do on a Mac: put its own key into vyred's db, then sign with it.
  const planted = deviceKey();
  const fid = crypto.createHash("sha256").update(Buffer.from(planted.pub, "base64url")).digest("base64url").slice(0, 22);
  db.prepare("INSERT INTO presence_keys (id, kind, name, public_key, alg, sign_count, created) VALUES (?,?,?,?,?,0,?)").run(fid, "device", "planted", planted.pub, -7, Date.now());
  const r = await vyred.verify({ ...APPROVE, caller: "cli", proof: planted.proof(fid) });
  assert.equal(r.ok, false, "a key only vyred's db knows proves nothing");
  assert.match(String(r.message), /not enrolled/);

  // The methods on offer are core's keys, not vyred's.
  assert.ok((await vyred.methods()).includes("device"));
  assert.deepEqual((await vyred.coreLink?.keys())?.map(k => k.id), [id]);
});

test("vyre-core link: vyred won't enroll, remove or mint a code itself, and passkey challenges are core's", async t => {
  const { vyred } = await world(t);
  assert.throws(() => vyred.enroll({ kind: "device", name: "x", public_key: deviceKey().pub, alg: -7 }), e => /** @type {any} */ (e).code === "core_owned");
  assert.throws(() => vyred.remove("x"), e => /** @type {any} */ (e).code === "core_owned");
  assert.throws(() => vyred.mintCode(), e => /** @type {any} */ (e).code === "core_owned");
  // No passkey in core: core's own answer, not a challenge vyred made up.
  const ch = await vyred.challenge({ ...APPROVE, method: "passkey" });
  assert.equal(ch.error && ch.error.code, "bad_input");
  assert.match(ch.error.message, /no passkey is enrolled/);
});

test("vyre-core link: a proof is never handed to a socket that isn't core's", async t => {
  const { c, socket, db } = await world(t);
  const phone = deviceKey();
  const id = c.presence.enroll({ kind: "device", name: "alex-phone", public_key: phone.pub, alg: -7 }).id;
  // core's uid as the installer recorded it is not the socket's owner: someone else's socket.
  const squatted = new Presence({ db, role: "local", touchid: null, writeTty: () => {}, who: async () => [], env: {}, core: coreLink({ socket, uid: uid + 1 }) });
  const r = await squatted.verify({ ...APPROVE, caller: "cli", proof: phone.proof(id) });
  assert.equal(r.ok, false);
  assert.match(String(r.message), /belongs to uid/);
  // And a core that's down refuses, never falls back to vyred's own keys.
  await c.close();
  const down = new Presence({ db, role: "local", touchid: null, writeTty: () => {}, who: async () => [], env: {}, core: coreLink({ socket, uid }) });
  assert.equal((await down.verify({ ...APPROVE, caller: "cli", proof: phone.proof(id) })).ok, false);
});
