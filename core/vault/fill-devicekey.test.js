// @ts-check
// A phone opens a fill window with its device key (ADR 0028, decision 5): paired with a P-256
// public key, it signs a one-time challenge after its own biometric prompt. A wrong key, a reused
// or late challenge, and a browser without a key are refused; failures count toward the lockout.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Fill, serveFill } from "./fill.js";
import { SCRATCH } from "../../test/scratch.mjs";

test("fill: device-key unlock, one challenge, one use, 60 seconds; wrong keys and keyless devices refused", async t => {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-devkey-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  await vault.key();
  const clock = { t: Date.now() };
  const fill = new Fill({ vault, now: () => clock.t });
  const srv = await serveFill({ host: "127.0.0.1", port: 0, fill });
  t.after(async () => { await srv.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (name, body, headers = {}) => {
    const res = await fetch(`${srv.url}/v1/fill/${name}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const EXT = { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" };

  const phone = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = /** @type {Buffer} */ (phone.publicKey.export({ format: "der", type: "spki" })).toString("base64url");
  const bad = await call("pair", { code: fill.code({ name: "x" }).code, key: "not-a-key-" + "a".repeat(40) }, EXT);
  assert.equal(bad.body.error.code, "bad_input");
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const r2 = await call("pair", { code: fill.code({ name: "x" }).code, key: rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64url") }, EXT);
  assert.equal(r2.body.error.code, "bad_input", "only P-256");

  const paired = await call("pair", { code: fill.code({ name: "alex's Pixel 8" }).code, name: "alex's Pixel 8", key: spki }, EXT);
  assert.equal(paired.status, 200, JSON.stringify(paired.body));
  const auth = { authorization: `Bearer ${paired.body.data.token}` };
  const sign = (key, msg) => crypto.sign("sha256", Buffer.from(msg), { key, dsaEncoding: "der" }).toString("base64url");

  // The right key over the challenge opens a window.
  const c1 = (await call("challenge", {}, auth)).body.data;
  assert.equal(c1.message, `vyre:fill-unlock:v1:${c1.challenge}`);
  const u = await call("unlock", { signature: sign(phone.privateKey, c1.message) }, auth);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.ok(u.body.data.session);
  // The same challenge again: refused (single use).
  assert.equal((await call("unlock", { signature: sign(phone.privateKey, c1.message) }, auth)).body.error.code, "bad_signature");
  // Another key: refused.
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const c2 = (await call("challenge", {}, auth)).body.data;
  assert.equal((await call("unlock", { signature: sign(other.privateKey, c2.message) }, auth)).body.error.code, "bad_signature");
  // Late: past 60 seconds.
  const c3 = (await call("challenge", {}, auth)).body.data;
  clock.t += 61_000;
  assert.equal((await call("unlock", { signature: sign(phone.privateKey, c3.message) }, auth)).body.error.code, "bad_signature");
  // A browser without a key gets no challenge.
  const browser = await call("pair", { code: fill.code({ name: "chrome" }).code }, EXT);
  assert.equal((await call("challenge", {}, { authorization: `Bearer ${browser.body.data.token}` })).body.error.code, "no_key");
  // A key row a module rewrote fails its MAC and is not trusted.
  db.prepare("UPDATE vault_device_keys SET key = ?").run(other.publicKey.export({ format: "der", type: "spki" }).toString("base64url"));
  assert.equal((await call("challenge", {}, auth)).body.error.code, "no_key");

  const audit = JSON.stringify(db.prepare("SELECT * FROM vault_audit").all());
  assert.ok(!audit.includes(c1.challenge));
  assert.match(audit, /device key/);
});
