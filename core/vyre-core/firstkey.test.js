// @ts-check
// A Mac server's first key (firstkey.js, ADR 0040): core takes ONE key without a proof, and only the key the install line named, within the hour, from a process outside every Claude session,
// and only when the installer made this core a server's. Every later key needs a proof from an enrolled key, which core's own rule already says.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startCore, openStore } from "./server.js";
import { armFirstKey, fingerprintOf, FIRST_KEY_TTL } from "./firstkey.js";
import { setupFingerprint, setupCode, parseSetupCode } from "../relay/wire.js";
import { coreTool } from "../../lib/vyre-core-client.js";
import { inputHash } from "../presence/index.js";
import { SCRATCH } from "../../test/scratch.mjs";

const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const key = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }); return { pub: publicKey.export({ format: "der", type: "spki" }), priv: privateKey }; };
const b64 = (/** @type {Buffer} */ b) => b.toString("base64url");

/** A server's core with the first key armed for `armed` (a key), the way `main.js code --first-key-fp` leaves it. */
async function world(t, { armed, server = true, notModel = true, now }) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "fk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, "data");
  if (armed) { const { db } = openStore(dataDir); armFirstKey(db, fingerprintOf(b64(armed.pub)) || "", now ? now() : Date.now()); db.close(); }
  const socket = path.join(dir, "c.sock");
  const c = await startCore({ socket, dataDir, ownerUid: uid, version: "test", dev: true, server, notModel: () => notModel, ...(now ? { now } : {}) });
  t.after(() => c.close());
  c.presence.softwareOk = () => true;
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ header) => coreTool(tool, input, { socket, coreUid: uid, ...(header ? { presence: header } : {}) });
  return { c, call };
}
const enrolBody = (/** @type {Buffer} */ pub, extra = {}) => ({ kind: "device", name: "the test Mac", public_key: b64(pub), alg: -7, ...extra });

test("the fingerprint is the setup code's own: the same 16 bytes wire.js puts in the code", () => {
  const k = key();
  assert.equal(fingerprintOf(b64(k.pub)), setupFingerprint(k.pub).toString("hex"));
  const code = setupCode(crypto.randomBytes(16), k.pub);
  assert.equal(parseSetupCode(code)?.fp.toString("hex"), fingerprintOf(b64(k.pub)), "what the installer reads out of the install line is what core compares");
  assert.equal(fingerprintOf("nope"), null);
  assert.equal(fingerprintOf(b64(Buffer.alloc(91))), null);
});

test("a server's core takes the first key once: the named key, with no proof, and then no more", async t => {
  const app = key(), other = key();
  const { call, c } = await world(t, { armed: app });
  assert.equal((await call("presence.enroll.first", enrolBody(other.pub))).error?.message, "that key is not the one the install line named");
  assert.equal(c.presence.keys().length, 0);
  const ok = await call("presence.enroll.first", enrolBody(app.pub));
  assert.ok(ok.data && ok.data.kind === "device", JSON.stringify(ok));
  assert.equal(c.presence.keys().length, 1);
  // spent: the same key again, or any other, is refused
  assert.match((await call("presence.enroll.first", enrolBody(app.pub))).error?.message || "", /already has a key/);
  assert.match((await call("presence.enroll.first", enrolBody(other.pub))).error?.message || "", /already has a key/);
});

test("a later key needs a proof from an enrolled key, over the exact enrolment input", async t => {
  const app = key(), phone = key();
  const { call, c } = await world(t, { armed: app });
  const first = await call("presence.enroll.first", enrolBody(app.pub));
  const id = first.data.id;
  const body = enrolBody(phone.pub, { name: "phone" });
  assert.equal((await call("presence.enroll", body)).error?.code, "presence_required", "no proof, no key");
  const proof = (/** @type {any} */ input, /** @type {crypto.KeyObject} */ priv) => {
    const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\npresence.enroll\n${inputHash(input)}\n${ts}\n${nonce}`), { key: priv, dsaEncoding: "der" }).toString("base64url");
    return `device key=${id} ts=${ts} nonce=${nonce} sig=${sig}`;
  };
  const wrong = await call("presence.enroll", { ...body, name: "changed" }, proof(body, app.priv));
  assert.ok(wrong.error, "a proof for other input does not carry: " + JSON.stringify(wrong));
  const stranger = key();
  assert.ok((await call("presence.enroll", body, proof(body, stranger.priv))).error, "a key core does not have proves nothing");
  const ok = await call("presence.enroll", body, proof(body, app.priv));
  assert.ok(ok.data, JSON.stringify(ok));
  assert.equal(c.presence.keys().length, 2);
});

test("not a server's core, a model's process, a late call, a bad key: all refused, and nothing is spent by a refusal", async t => {
  const app = key();
  let clock = Date.now();
  const w = await world(t, { armed: app, server: false });
  assert.equal((await w.call("presence.enroll.first", enrolBody(app.pub))).error?.code, "not_server");
  const m = await world(t, { armed: app, notModel: false });
  assert.equal((await m.call("presence.enroll.first", enrolBody(app.pub))).error?.code, "not_person_side");
  assert.equal(m.c.presence.keys().length, 0);
  const none = await world(t, {});
  assert.match((await none.call("presence.enroll.first", enrolBody(app.pub))).error?.message || "", /no first key is waiting/);
  const late = await world(t, { armed: app, now: () => clock });
  clock += FIRST_KEY_TTL + 1000;
  assert.match((await late.call("presence.enroll.first", enrolBody(app.pub))).error?.message || "", /hour is over/);
  const ok = await world(t, { armed: app });
  assert.equal((await ok.call("presence.enroll.first", { ...enrolBody(app.pub), kind: "capsule" })).error?.code, "bad_input", "the first key is a device key, never a Capsule's");
  assert.equal((await ok.call("presence.enroll.first", { ...enrolBody(app.pub), alg: -257 })).error?.code, "bad_input");
  assert.equal((await ok.call("presence.enroll.first", { ...enrolBody(app.pub), public_key: "not a key" })).error?.code, "bad_input");
  assert.ok((await ok.call("presence.enroll.first", enrolBody(app.pub))).data, "the refusals above spent nothing");
});

test("arming a fingerprint is for 32 hex characters only", () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "fk-"));
  try {
    const { db } = openStore(path.join(dir, "data"));
    assert.throws(() => armFirstKey(db, "short"), /32 hex/);
    assert.throws(() => armFirstKey(db, "G".repeat(32)), /32 hex/);
    armFirstKey(db, "ab".repeat(16));
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The Capsule key's hand-over: the setup key (software, core's only key) signs the enrolment of the app's Secure Enclave key once; core enrols it as a `capsule` key and removes the setup key.
const handOver = (/** @type {any} */ id, /** @type {crypto.KeyObject} */ priv, /** @type {any} */ body, { ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url") } = {}) => {
  const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\npresence.enroll\n${inputHash(body)}\n${ts}\n${nonce}`), { key: priv, dsaEncoding: "der" }).toString("base64url");
  return `device key=${id} ts=${ts} nonce=${nonce} sig=${sig}`;
};

test("the setup key hands its place to the Capsule key once: core ends with one key, a capsule one, and that key proves at hardware strength", async t => {
  const page = key(), enclave = key();
  // a release-kind core: a software proof is refused for presence acts, a capsule proof is not
  const w = await world(t, { armed: page });
  w.c.presence.softwareOk = () => false;
  const first = (await w.call("presence.enroll.first", enrolBody(page.pub, { name: "setup page" }))).data;
  const body = { kind: "capsule", name: "the test Mac", public_key: b64(enclave.pub), alg: -7 };
  const bad = (/** @type {any} */ over, h = handOver(first.id, page.priv, { ...body, ...over })) => w.call("presence.enroll.capsule", { ...body, proof: h });
  // a proof for other input, from another key, stale, or missing
  assert.match((await bad({}, handOver(first.id, page.priv, { ...body, name: "other" }))).error?.message || "", /does not check out/);
  assert.match((await bad({}, handOver(first.id, key().priv, body))).error?.message || "", /does not check out/);
  assert.match((await bad({}, handOver(first.id, page.priv, body, { ts: String(Date.now() - 10 * 60_000) }))).error?.message || "", /too old/);
  assert.match((await bad({}, handOver("dk_other", page.priv, body))).error?.message || "", /not from the setup key/);
  assert.equal((await w.call("presence.enroll.capsule", body)).error?.code, "presence_required");
  assert.equal((await w.call("presence.enroll.capsule", { ...body, kind: "device", proof: handOver(first.id, page.priv, body) })).error?.code, "bad_input");
  assert.equal(w.c.presence.keys().length, 1, "no refusal changed anything");
  const ok = await w.call("presence.enroll.capsule", { ...body, proof: handOver(first.id, page.priv, body) });
  assert.ok(ok.data && ok.data.kind === "capsule", JSON.stringify(ok));
  const keys = w.c.presence.keys();
  assert.deepEqual(keys.map((/** @type {any} */ k) => k.kind), ["capsule"], "the setup key is gone");
  // once
  assert.match((await w.call("presence.enroll.capsule", { ...body, proof: handOver(first.id, page.priv, body) })).error?.message || "", /only key|already taken|no longer/);
  // the Capsule key now proves a presence act on a release core: hardware strength, no software refusal
  const next = enrolBody(key().pub, { name: "phone" });
  const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
  const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\npresence.enroll\n${inputHash(next)}\n${ts}\n${nonce}`), { key: enclave.priv, dsaEncoding: "der" }).toString("base64url");
  const later = await w.call("presence.enroll", next, `capsule key=${ok.data.id} ts=${ts} nonce=${nonce} sig=${sig}`);
  assert.ok(later.data, "a later key is enrolled by the Capsule key's proof: " + JSON.stringify(later));
  // and the setup key's own software proof would have been refused
  assert.equal(w.c.presence.keys().length, 2);
});

test("the hand-over is refused outside its window: not a server, a model's process, no first key yet, an hour late, or another key present", async t => {
  const page = key(), enclave = key();
  const body = { kind: "capsule", name: "m", public_key: b64(enclave.pub), alg: -7 };
  const withProof = (/** @type {any} */ id) => ({ ...body, proof: handOver(id, page.priv, body) });
  const a = await world(t, { armed: page, server: false });
  assert.equal((await a.call("presence.enroll.capsule", withProof("x"))).error?.code, "not_server");
  const b = await world(t, { armed: page, notModel: false });
  assert.equal((await b.call("presence.enroll.capsule", withProof("x"))).error?.code, "not_person_side");
  const c = await world(t, { armed: page });
  assert.match((await c.call("presence.enroll.capsule", withProof("x"))).error?.message || "", /no first key has been taken/);
  let clock = Date.now();
  const d = await world(t, { armed: page, now: () => clock });
  const first = (await d.call("presence.enroll.first", enrolBody(page.pub))).data;
  clock += FIRST_KEY_TTL + 60_000;
  assert.match((await d.call("presence.enroll.capsule", { ...body, proof: handOver(first.id, page.priv, body, { ts: String(clock) }) })).error?.message || "", /hour of the first key is over/);
  const e = await world(t, { armed: page });
  const f1 = (await e.call("presence.enroll.first", enrolBody(page.pub))).data;
  e.c.presence.enroll({ kind: "device", name: "extra", public_key: b64(key().pub), alg: -7 });
  assert.match((await e.call("presence.enroll.capsule", { ...body, proof: handOver(f1.id, page.priv, body) })).error?.message || "", /no longer vyre-core's only key/);
});
