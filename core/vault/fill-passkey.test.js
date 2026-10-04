// @ts-check
// Passkeys through the fill listener (ADR 0028, decision 7): make one on a site, sign in with it,
// the relying party's own checks pass, a lookalike origin and a locked session are refused, two
// accounts ask which, and no private key, challenge or user handle reaches an audit row.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Fill, serveFill } from "./fill.js";
import { challenge } from "./fill-passkey.js";
import { SCRATCH } from "../../test/scratch.mjs";

const UNLOCK = `fixture-unlock-${crypto.randomBytes(8).toString("hex")}`;
const b64u = b => Buffer.from(b).toString("base64url");

async function setup(t) {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-passkey-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  await vault.key();
  const fill = new Fill({ vault });
  const srv = await serveFill({ host: "127.0.0.1", port: 0, fill });
  t.after(async () => { await srv.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (name, body, headers = {}) => {
    const res = await fetch(`${srv.url}/v1/fill/${name}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const { code } = fill.code({ name: "test browser" });
  const paired = await call("pair", { code }, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });
  await fill.setUnlockPassphrase({ passphrase: UNLOCK });
  const auth = { authorization: `Bearer ${paired.body.data.token}` };
  const { session } = (await call("unlock", { passphrase: UNLOCK }, auth)).body.data;
  return { db, call, auth, h: { ...auth, "x-vyre-session": session } };
}

/** What a relying party checks on a sign-in (WebAuthn Level 3, 7.2), from the SPKI it stored. */
function verify({ spki, rpId, origin, challenge: ch, response }) {
  const r = response.response;
  const cd = JSON.parse(Buffer.from(r.clientDataJSON, "base64url").toString("utf8"));
  assert.deepEqual([cd.type, cd.challenge, cd.origin], ["webauthn.get", ch, origin]);
  const auth = Buffer.from(r.authenticatorData, "base64url");
  assert.deepEqual(auth.subarray(0, 32), crypto.createHash("sha256").update(rpId).digest());
  assert.equal(auth[32] & 0x05, 0x05, "user present and verified");
  const key = crypto.createPublicKey({ key: Buffer.from(spki, "base64url"), format: "der", type: "spki" });
  const signed = Buffer.concat([auth, crypto.createHash("sha256").update(Buffer.from(r.clientDataJSON, "base64url")).digest()]);
  return crypto.verify("sha256", signed, { key, dsaEncoding: "der" }, Buffer.from(r.signature, "base64url"));
}

test("passkeys: create on a site, sign in with it, the site's checks pass; lookalikes and no session refused", async t => {
  const { db, call, auth, h } = await setup(t);
  const userId = b64u(crypto.randomBytes(16));
  const ch1 = challenge();
  const made = await call("passkey.create", { url: "https://login.harlow.test/signup", rpId: "harlow.test", challenge: ch1,
    user: { id: userId, name: "alex@harlow.test", displayName: "Alex" }, algs: [-7, -257] }, h);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.data.name, "harlow-test-alex-harlow-test");
  const res = made.body.data.response;
  const spki = res.response.publicKey;

  // Listed for the site (and its parent rpId), with only a device token.
  const listed = await call("passkeys", { url: "https://harlow.test/", rpId: "harlow.test" }, auth);
  assert.deepEqual(listed.body.data.passkeys.map(p => [p.id, p.name]), [[res.id, "harlow-test-alex-harlow-test"]]);
  assert.deepEqual((await call("passkeys", { url: "https://harlow.test.northwind.test/", rpId: "harlow.test" }, auth)).body.data.passkeys, []);

  const ch2 = challenge();
  const got = await call("passkey.get", { url: "https://harlow.test/login", rpId: "harlow.test", challenge: ch2, allow: [res.id] }, h);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.data.response.response.userHandle, userId);
  assert.equal(verify({ spki, rpId: "harlow.test", origin: "https://harlow.test", challenge: ch2, response: got.body.data.response }), true);

  // A lookalike claiming the rpId, http, and no session: refused.
  const phish = await call("passkey.get", { url: "https://harlow-test.northwind.test/", rpId: "harlow.test", challenge: challenge() }, h);
  assert.equal(phish.body.error.code, "SecurityError");
  assert.equal((await call("passkey.get", { url: "http://harlow.test/", rpId: "harlow.test", challenge: challenge() }, h)).body.error.code, "SecurityError");
  assert.equal((await call("passkey.get", { url: "https://harlow.test/", rpId: "harlow.test", challenge: challenge() }, auth)).body.error.code, "session_required");
  // excludeCredentials: the same account again is refused as the spec says.
  const again = await call("passkey.create", { url: "https://harlow.test/", rpId: "harlow.test", challenge: challenge(),
    user: { id: userId, name: "alex@harlow.test", displayName: "Alex" }, algs: [-7], exclude: [res.id] }, h);
  assert.equal(again.body.error.code, "InvalidStateError");
  assert.equal((await call("passkey.create", { url: "https://harlow.test/", rpId: "harlow.test", challenge: challenge(),
    user: { id: userId, name: "a", displayName: "a" }, algs: [-257] }, h)).body.error.code, "NotSupportedError");

  // A second account: the extension is asked which, then signs with the one picked.
  const other = await call("passkey.create", { url: "https://harlow.test/", rpId: "harlow.test", challenge: challenge(),
    user: { id: b64u(crypto.randomBytes(16)), name: "juno@harlow.test", displayName: "Juno" }, algs: [-7] }, h);
  const choose = await call("passkey.get", { url: "https://harlow.test/", rpId: "harlow.test", challenge: challenge() }, h);
  assert.deepEqual(choose.body.data.choose.map(c => c.description).sort(), ["alex@harlow.test · harlow.test", "juno@harlow.test · harlow.test"]);
  const ch3 = challenge();
  const picked = await call("passkey.get", { url: "https://harlow.test/", rpId: "harlow.test", challenge: ch3, id: other.body.data.response.id }, h);
  assert.equal(verify({ spki: other.body.data.response.response.publicKey, rpId: "harlow.test", origin: "https://harlow.test", challenge: ch3, response: picked.body.data.response }), true);

  const audit = JSON.stringify(db.prepare("SELECT * FROM vault_audit").all());
  assert.match(audit, /passkey-create/);
  assert.match(audit, /passkey-get/);
  for (const secret of [ch1, ch2, ch3, userId]) assert.ok(!audit.includes(secret));
  assert.ok(!/PRIVATE KEY/.test(audit));
});

test("passkeys for iOS, macOS and Credential Manager: register and assert over the platform's clientDataHash", async t => {
  const { call, h, auth } = await setup(t);
  const hash1 = crypto.createHash("sha256").update("platform client data 1").digest("base64url");
  const reg = await call("passkey.register", { rpId: "northwind.test", clientDataHash: hash1,
    user: { id: b64u(crypto.randomBytes(16)), name: "kit@northwind.test", displayName: "Kit" }, algs: [-7] }, h);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.ok(reg.body.data.attestationObject && reg.body.data.credentialId);
  // The platform builds its own client data; the vault signs authenticatorData || its hash.
  const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: challenge(), origin: "https://northwind.test" }));
  const hash2 = crypto.createHash("sha256").update(cd).digest();
  const a = await call("passkey.assert", { rpId: "northwind.test", clientDataHash: hash2.toString("base64url"), credential: reg.body.data.credentialId }, h);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const key = crypto.createPublicKey({ key: Buffer.from(reg.body.data.publicKey, "base64url"), format: "der", type: "spki" });
  const authData = Buffer.from(a.body.data.authenticatorData, "base64url");
  assert.deepEqual(authData.subarray(0, 32), crypto.createHash("sha256").update("northwind.test").digest());
  assert.equal(crypto.verify("sha256", Buffer.concat([authData, hash2]), { key, dsaEncoding: "der" }, Buffer.from(a.body.data.signature, "base64url")), true);
  // Refusals: a hash that is not 32 bytes, an unknown credential, no session.
  assert.equal((await call("passkey.assert", { rpId: "northwind.test", clientDataHash: "abc", credential: reg.body.data.credentialId }, h)).body.error.code, "TypeError");
  assert.equal((await call("passkey.assert", { rpId: "northwind.test", clientDataHash: hash2.toString("base64url"), credential: "AAAAAAAAAAAAAAAAAAAAAA" }, h)).body.error.code, "NotAllowedError");
  assert.equal((await call("passkey.assert", { rpId: "northwind.test", clientDataHash: hash2.toString("base64url"), credential: reg.body.data.credentialId }, auth)).body.error.code, "session_required");
  // identities lists the passkey with its user handle, and logins with a seed say so.
  const ids = (await call("identities", {}, h)).body.data.identities;
  const pk = ids.find(i => i.kind === "passkey");
  assert.equal(pk.rp, "northwind.test");
  assert.ok(pk.userHandle);
});
