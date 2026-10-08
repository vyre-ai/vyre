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
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ header) => coreTool(tool, input, { socket, ...(header ? { presence: header } : {}) });
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
  assert.equal((await call("presence.enroll", { ...body, name: "changed" }, proof(body, app.priv))).error?.code, "presence_required", "a proof for other input does not carry");
  const stranger = key();
  assert.equal((await call("presence.enroll", body, proof(body, stranger.priv))).error?.code, "presence_required", "a key core does not have proves nothing");
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
