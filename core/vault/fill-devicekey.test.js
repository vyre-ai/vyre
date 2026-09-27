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
  const bad = await call("pair", { code: fill.code({ name: "x", phone: true }).code, key: "not-a-key-" + "a".repeat(40) }, EXT);
  assert.equal(bad.body.error.code, "bad_input");
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const r2 = await call("pair", { code: fill.code({ name: "x", phone: true }).code, key: rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64url") }, EXT);
  assert.equal(r2.body.error.code, "bad_input", "only P-256");

  // A browser's code does not take a key: only a code made for a phone does.
  const browserCode = await call("pair", { code: fill.code({ name: "chrome" }).code, key: spki }, EXT);
  assert.equal(browserCode.body.error.code, "bad_code");
  assert.match(browserCode.body.error.message, /for a browser/);
  // The phone sends no Origin: allowed with a key, refused without one.
  assert.equal((await call("pair", { code: fill.code({ name: "p", phone: true }).code })).body.error.code, "origin_required");
  const paired = await call("pair", { code: fill.code({ name: "alex's Pixel 8", phone: true }).code, name: "alex's Pixel 8", key: spki });
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

  // A native app: only a login that lists the package and its certificate is offered and filled.
  const sha = "ab".repeat(32);
  const app = `android://sh.northwind.orders@${sha}`;
  await vault.put({ name: "northwind-orders", kind: "login", url: "https://orders.northwind.test", apps: [`android:sh.northwind.orders@${sha}`], fields: { username: "kit", password: "sample-" + crypto.randomBytes(6).toString("hex") } }, "cli");
  await vault.put({ name: "harlow-portal", kind: "login", url: "https://portal.harlow.test", fields: { username: "juno", password: "sample-" + crypto.randomBytes(6).toString("hex") } }, "cli");
  db.prepare("DELETE FROM vault_device_keys").run();
  const again = await call("pair", { code: fill.code({ name: "pixel", phone: true }).code, key: spki });
  const a2 = { authorization: `Bearer ${again.body.data.token}` };
  const c4 = (await call("challenge", {}, a2)).body.data;
  const s4 = (await call("unlock", { signature: sign(phone.privateKey, c4.message) }, a2)).body.data.session;
  const m = await call("match", { url: app }, a2);
  assert.deepEqual(m.body.data.logins.map(l => l.name), ["northwind-orders"]);
  assert.deepEqual((await call("match", { url: `android://sh.northwind.orders@${"cd".repeat(32)}` }, a2)).body.data.logins, [], "another certificate is another app");
  const filled = await call("fill", { name: "northwind-orders", url: app }, { ...a2, "x-vyre-session": s4 });
  assert.equal(filled.body.data.username, "kit");
  assert.equal((await call("fill", { name: "harlow-portal", url: app }, { ...a2, "x-vyre-session": s4 })).body.error.code, "wrong_origin");

  // The OS autofill store's list: sites and usernames, never a password; needs the session.
  assert.equal((await call("identities", {}, a2)).body.error.code, "session_required");
  const ids = (await call("identities", {}, { ...a2, "x-vyre-session": s4 })).body.data;
  assert.equal(ids.users, "usernames");
  const nw = ids.identities.find(i => i.name === "northwind-orders");
  assert.deepEqual([nw.user, nw.sites, nw.apps], ["kit", ["https://orders.northwind.test"], [`android:sh.northwind.orders@${sha}`]]);
  assert.ok(!JSON.stringify(ids).includes("sample-"), "no password");
  fill.identities = "names";
  assert.equal((await call("identities", {}, { ...a2, "x-vyre-session": s4 })).body.data.identities.find(i => i.name === "northwind-orders").user, "northwind-orders");

  const audit = JSON.stringify(db.prepare("SELECT * FROM vault_audit").all());
  assert.ok(!audit.includes(c1.challenge));
  assert.match(audit, /device key/);
});
