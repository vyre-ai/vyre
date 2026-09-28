// @ts-check
// vyre-core phase 2a (ADR 0040, docs/work/vyre-core-plan.md): the vault's store in core. An item
// anyone puts is unverified until the person says so; grants and releases are core's; a plain
// value leaves only for the Capsule core signed, with a proof or a session bound to that process.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startCore } from "./server.js";
import { UNVERIFIED_MAX } from "./vault.js";
import { coreTool } from "../../lib/vyre-core-client.js";
import { inputHash } from "../presence/index.js";
import { TEST_KDF } from "../vault/testing.js";
import { SCRATCH } from "../../test/scratch.mjs";

const uid = typeof process.getuid === "function" ? process.getuid() : 0;

/** A core whose "is this the Capsule" and "which process" answers the test sets. */
async function core(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vv-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = { capsule: true, key: "4242@Mon" };
  const socket = path.join(dir, "c.sock");
  const c = await startCore({ socket, dataDir: path.join(dir, "data"), ownerUid: uid, testKdf: TEST_KDF,
    peerCred: async () => ({ pid: process.pid, uid }), capsuleFrom: async () => at.capsule, peerKey: () => at.key });
  t.after(() => c.close());
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyId = c.presence.enroll({ kind: "device", name: "alex-phone", public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 }).id;
  /** A device proof over one call. */
  const proof = (tool, input) => {
    const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    return `device key=${keyId} ts=${ts} nonce=${nonce} sig=${sig}`;
  };
  /** A call, with a proof when asked for. */
  const call = (tool, input, { proved = false, presence } = {}) => coreTool(tool, input, { socket, coreUid: uid, presence: presence ?? (proved ? proof(tool, input) : undefined) });
  return { c, at, call, proof };
}

const BANK = { name: "bank", kind: "login", fields: { username: "alex", password: "sourdough-1042" }, url: "https://bank.example" };

test("vyre-core vault: a put from anyone is unverified: never offered to fill, marked, and not grantable until verified", async t => {
  const { call } = await core(t);
  const put = await call("vault.put", BANK);
  assert.ok(!put.error, JSON.stringify(put.error));
  assert.equal(put.data.unverified, true);
  const list = (await call("vault.list", {})).data;
  assert.equal(list.items.find(i => i.name === "bank").unverified, true);
  assert.deepEqual((await call("vault.match", { url: "https://bank.example/login" })).data.logins, [], "an unverified login is never offered to fill");
  const g = await call("vault.grant", { name: "bank", module: "mail" }, { proved: true });
  assert.equal(g.error && g.error.code, "unverified");
  // Overwriting it needs a proof, as with any existing item.
  assert.equal((await call("vault.put", { ...BANK, fields: { username: "alex", password: "swapped" } })).error.code, "presence_required");
  // The person verifies it; then it fills and can be granted.
  assert.equal((await call("vault.verify", { name: "bank" })).status, 401, "verifying needs a proof");
  assert.deepEqual((await call("vault.verify", { name: "bank" }, { proved: true })).data, { verified: "bank" });
  assert.equal((await call("vault.match", { url: "https://bank.example/login" })).data.logins.length, 1);
  assert.ok(!(await call("vault.grant", { name: "bank", module: "mail" }, { proved: true })).error);
});

test("vyre-core vault: a module gets a value only under a grant core holds, and revoking is instant", async t => {
  const { call } = await core(t);
  assert.equal((await call("vault.put", { name: "orders-imap", kind: "secret", fields: { value: "imap-pass-1042" } }, { proved: true })).data.unverified, undefined);
  const none = await call("vault.release", { name: "orders-imap", module: "mail" });
  assert.match(String(none.error && none.error.message), /not granted to mail/);
  assert.equal((await call("vault.grant", { name: "orders-imap", module: "mail" })).status, 401, "a grant needs a proof");
  assert.ok(!(await call("vault.grant", { name: "orders-imap", module: "mail" }, { proved: true })).error);
  assert.deepEqual((await call("vault.release", { name: "orders-imap", module: "mail" })).data, { value: "imap-pass-1042" });
  assert.match(String((await call("vault.release", { name: "orders-imap", module: "google" })).error.message), /not granted to google/);
  // Revoking takes access away, so it needs no proof and works at once.
  assert.deepEqual((await call("vault.revoke", { name: "orders-imap", module: "mail" })).data, { revoked: 1 });
  assert.match(String((await call("vault.release", { name: "orders-imap", module: "mail" })).error.message), /not granted/);
  // Deleting needs a proof.
  assert.equal((await call("vault.delete", { name: "orders-imap" })).status, 401);
  assert.deepEqual((await call("vault.delete", { name: "orders-imap" }, { proved: true })).data, { deleted: "orders-imap" });
});

test("vyre-core vault: a value leaves only for the Capsule, with a proof or a session bound to that Capsule process", async t => {
  const { call, at } = await core(t);
  await call("vault.put", { ...BANK, fields: { ...BANK.fields, totp: "JBSWY3DPEHPK3PXP" } }, { proved: true });
  // Not the Capsule: refused, proof or not.
  at.capsule = false;
  const notCapsule = await call("vault.reveal", { name: "bank", field: "password" }, { proved: true });
  assert.equal(notCapsule.status, 403);
  assert.equal(notCapsule.error.code, "not_capsule");
  assert.equal((await call("presence.session.open", {}, { proved: true })).error.code, "not_capsule");
  at.capsule = true;
  assert.equal((await call("vault.reveal", { name: "bank", field: "password" })).status, 401, "the Capsule still needs a proof");
  assert.deepEqual((await call("vault.reveal", { name: "bank", field: "password" }, { proved: true })).data, { name: "bank", field: "password", value: "sourdough-1042" });
  const code = await call("vault.totp", { name: "bank" }, { proved: true });
  assert.match(String(code.data && code.data.code), /^\d{6}$/);

  // A session, bound to this Capsule process.
  const s = (await call("presence.session.open", {}, { proved: true })).data;
  const session = `session id=${s.session} secret=${s.secret}`;
  assert.equal((await call("vault.reveal", { name: "bank", field: "username" }, { presence: session })).data.value, "alex");
  at.key = "5151@Tue";
  assert.match(String((await call("vault.reveal", { name: "bank", field: "username" }, { presence: session })).error.message), /another device/, "the same secret from another process proves nothing");
  at.key = "4242@Mon";
  // A reprompt item takes its own proof every time.
  await call("vault.put", { name: "card", kind: "secret", fields: { value: "4111" }, reprompt: true }, { proved: true });
  assert.equal((await call("vault.reveal", { name: "card" }, { presence: session })).status, 401);
});

test("vyre-core vault: unverified puts are capped per peer, so nothing can fill core's db with them", async t => {
  const { call } = await core(t);
  for (let i = 0; i < UNVERIFIED_MAX.perPeer; i++) assert.ok(!(await call("vault.put", { name: `junk-${i}`, kind: "secret", fields: { value: "x" } })).error, `put ${i}`);
  const over = await call("vault.put", { name: "one-more", kind: "secret", fields: { value: "x" } });
  assert.equal(over.error && over.error.code, "too_many_unverified");
  // The person's own verified put is never capped.
  assert.ok(!(await call("vault.put", { name: "mine", kind: "secret", fields: { value: "y" } }, { proved: true })).error);
});
