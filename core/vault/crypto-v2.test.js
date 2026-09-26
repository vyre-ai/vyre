// @ts-check
// Crypto v2 (ADR 0006 decision 1): item versions and item keys, meta sealed with the item, MACed
// rows, ECIES v2, the account unlock key and the Secret Key, the personal vault, and the
// migration of a v1 home. The v1 home is built at test time with a copy of the seal code from
// commit ebd38ec, so no file in the repo holds a key. Every login and value here is fictional.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS, PERSONAL, AGENTS } from "./vault.js";
import {
  newIdentity, sealFor, openFrom, clampKdf, clampScrypt, formatSecretKey, parseSecretKey, wrapKey, unwrapKey,
  sealItemV2, openItemV2, newVaultKey, ARGON2,
} from "./crypto.js";
import { readSealed, writeSealed } from "./store.js";

/** A cheap Argon2id for tests only; the Vault accepts it only because the constructor is told to. */
const TEST_KDF = { kdf: "argon2id", m: 256, t: 1, p: 1 };
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const PASSWORD = fake("password");

function home(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-v2-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

/** A Vault on a home, as the module makes it, with the file keystore. */
function vaultOn(t, tmp, { testKdf = TEST_KDF } = {}) {
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const events = [];
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), testKdf });
  t.after(() => { try { db.close(); } catch {} });
  return { db, vault, events };
}

const auditRows = db => db.prepare("SELECT * FROM vault_audit ORDER BY id").all();

test("rollback: an older sealed file put back does not open", async t => {
  const { vault } = vaultOn(t, home(t));
  await vault.put({ name: "billing-key", kind: "api-key", fields: { value: fake("v1") } }, "cli");
  const r1 = vault.row("billing-key");
  const old = readSealed(vault.dir, r1.id);
  const now = fake("v2");
  await vault.put({ name: "billing-key", kind: "api-key", fields: { value: now } }, "cli");
  assert.equal(vault.row("billing-key").ver, 2);
  assert.equal((await vault.fields(vault.row("billing-key"))).value, now);
  writeSealed(vault.dir, r1.id, old);
  await assert.rejects(vault.fields(vault.row("billing-key")), /replaced or is an older version/);
  // Winding the row's version back too fails its MAC, so the row is ignored.
  vault.db.prepare("UPDATE vault_items SET ver = 1 WHERE name = 'billing-key'").run();
  assert.equal(vault.row("billing-key"), undefined);
});

test("swapped files: one item's sealed file in another's slot does not open", async t => {
  const { vault } = vaultOn(t, home(t));
  await vault.put({ name: "alpha", kind: "secret", fields: { value: fake("a") } }, "cli");
  await vault.put({ name: "beta", kind: "secret", fields: { value: fake("b") } }, "cli");
  const a = vault.row("alpha"), b = vault.row("beta");
  const sa = readSealed(vault.dir, a.id), sb = readSealed(vault.dir, b.id);
  writeSealed(vault.dir, a.id, sb);
  writeSealed(vault.dir, b.id, sa);
  await assert.rejects(vault.fields(a), /does not open/);
  await assert.rejects(vault.fields(b), /does not open/);
});

test("meta: hosts changed in vyre.db are refused, whether or not the row's MAC was redone", async t => {
  const { vault, db } = vaultOn(t, home(t));
  await vault.put({ name: "mail-login", kind: "login", url: "https://mail.example.com", fields: { username: "alex@example.com", password: fake("pw") } }, "cli");
  const id = vault.row("mail-login").id;
  // A module writing vyre.db cannot compute the MAC: the row is ignored and audited once.
  db.prepare("UPDATE vault_items SET hosts = ? WHERE id = ?").run(JSON.stringify(["https://evil.acme.test"]), id);
  assert.equal(vault.row("mail-login"), undefined);
  assert.equal(vault.list().items.length, 0);
  assert.deepEqual(vault.match({ url: "https://evil.acme.test/login" }).logins, []);
  vault.row("mail-login");
  const flagged = auditRows(db).filter(r => r.action === "tamper");
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].name, "mail-login");
  // Even with a valid MAC (a stolen MAC key, or a bug), the sealed meta disagrees and open refuses.
  vault.sign("vault_items", id);
  await assert.rejects(vault.fields(vault.row("mail-login")), /do not match its sealed copy/);
  assert.ok(auditRows(db).some(r => r.action === "open" && r.ok === 0 && /do not match/.test(r.why)));
});

test("MAC: forged grant, pass and device rows are ignored and audited", async t => {
  const tmp = home(t);
  const { vault, db } = vaultOn(t, tmp);
  const value = fake("token");
  await vault.put({ name: "api-token", kind: "api-key", fields: { value } }, "cli");
  db.prepare("INSERT INTO vault_grants (id, item, module, watcher, status, by, at) VALUES ('g_forged','api-token','sneak','','active','cli',1)").run();
  await assert.rejects(vault.release({ name: "api-token" }, "module:sneak"), /not granted to sneak/);
  assert.ok(auditRows(db).some(r => r.action === "tamper" && /vault_grants row g_forged/.test(r.why)));
  // A real grant still works, and a grant row whose status was flipped is ignored.
  await vault.grant({ name: "api-token", module: "probe" }, "mcp");
  db.prepare("UPDATE vault_grants SET status='active' WHERE module='probe'").run();
  await assert.rejects(vault.release({ name: "api-token" }, "module:probe"), /not granted to probe/);
  db.prepare("INSERT INTO vault_passes (id, holder, holder_sign, holder_box, items, mode, status, by, created) VALUES ('p_forged','dana','k','k','[\"api-token\"]','relayed','active','cli',1)").run();
  assert.equal(vault.passes().passes.length, 0);
  const refused = await vault.onRelay({ pass: "p_forged", item: "api-token" });
  assert.equal(refused.status, 403);
  db.prepare("INSERT INTO vault_devices (id, name, token_hash, created) VALUES ('d_forged','evil',?,1)").run(crypto.createHash("sha256").update("x".repeat(43)).digest("hex"));
  const { Fill } = await import("./fill.js");
  const fill = new Fill({ vault });
  assert.equal((await fill.handle("GET status", {}, { authorization: `Bearer ${"x".repeat(43)}` })).status, 401);
  assert.equal(fill.devices().devices.length, 0);
  for (const r of auditRows(db)) assert.ok(!JSON.stringify(r).includes(value));
});

test("ECIES v2: bound to the recipient and purpose, v1 still opens, all-zero shared secret refused", () => {
  const alex = newIdentity(), dana = newIdentity();
  const secret = { fields: { value: fake("shared") } };
  const sealed = sealFor(dana.box.public, secret, "vyre:pass:v1:p1:item", "pass");
  assert.equal(sealed.v, 2);
  assert.deepEqual(openFrom(dana.box.private, sealed, "vyre:pass:v1:p1:item", "pass"), secret);
  assert.throws(() => openFrom(alex.box.private, sealed, "vyre:pass:v1:p1:item", "pass"));
  assert.throws(() => openFrom(dana.box.private, sealed, "vyre:pass:v1:p1:other", "pass"));
  assert.throws(() => openFrom(dana.box.private, sealed, "vyre:pass:v1:p1:item", "vault"), /this purpose/);
  // Downgrading the label to v1 does not open a v2 body.
  assert.throws(() => openFrom(dana.box.private, { ...sealed, v: 1 }, "vyre:pass:v1:p1:item", "pass"));
  // A v1 seal (the code from ebd38ec) still opens, so old tickets can be accepted.
  const v1 = sealForV1(dana.box.public, secret, "vyre:pass:v1:p1:item");
  assert.deepEqual(openFrom(dana.box.private, v1, "vyre:pass:v1:p1:item", "pass"), secret);
  // A low-order public key (u = 0) gives an all-zero secret: refused, by node or by us.
  const prefix = Buffer.from(alex.box.public, "base64").subarray(0, 12);
  const zero = Buffer.concat([prefix, Buffer.alloc(32)]).toString("base64");
  assert.throws(() => sealFor(zero, secret, "x"));
});

test("KDF parameters are clamped; a tampered file cannot weaken them", () => {
  assert.deepEqual(clampKdf({ kdf: "argon2id", ...ARGON2 }), { kdf: "argon2id", ...ARGON2 });
  for (const bad of [{ m: 32768, t: 3, p: 4 }, { m: 65536, t: 2, p: 4 }, { m: 65536, t: 3, p: 0 }, { m: "x", t: 3, p: 1 }]) {
    assert.throws(() => clampKdf({ kdf: "argon2id", ...bad }), /outside what this vault allows/, JSON.stringify(bad));
  }
  assert.deepEqual(clampKdf({ kdf: "scrypt", N: 1 << 17, r: 8, p: 1 }), { kdf: "scrypt", N: 1 << 17, r: 8, p: 1 });
  for (const bad of [{ N: 1 << 16, r: 8, p: 1 }, { N: 1 << 21, r: 8, p: 1 }, { N: (1 << 17) + 1, r: 8, p: 1 }, { N: 1 << 17, r: 4, p: 1 }, { N: 1 << 17, r: 8, p: 5 }]) {
    assert.throws(() => clampKdf({ kdf: "scrypt", ...bad }), /outside/, JSON.stringify(bad));
  }
  assert.throws(() => clampKdf({ kdf: "pbkdf2" }), /unknown/);
  // Only an explicit test flag goes lower.
  assert.deepEqual(clampKdf(TEST_KDF, { test: true }), TEST_KDF);
  assert.throws(() => clampKdf(TEST_KDF), /outside/);
  // The passphrase keystore's wrapped key is clamped the same way.
  const cheap = wrapKey("correct horse battery", crypto.randomBytes(32), { N: 1 << 10, r: 8, p: 1 });
  assert.throws(() => unwrapKey("correct horse battery", cheap), /outside/);
  assert.throws(() => clampScrypt({ N: 1 << 10, r: 8, p: 1 }), /outside/);
});

test("Secret Key: format, checksum and parsing", () => {
  const bytes = crypto.randomBytes(16);
  const sk = formatSecretKey("ABCDEF", bytes);
  assert.match(sk, /^V2-ABCDEF-[A-Z2-7]{26}-[A-Z2-7]{2}$/);
  const back = parseSecretKey(` ${sk.toLowerCase().replace(/-/g, " - ")} `);
  assert.equal(back.acct, "ABCDEF");
  assert.ok(back.bytes.equals(bytes));
  // One changed character in the key is caught by the check characters.
  const body = sk.split("-")[2];
  const typo = sk.replace(body, (body[0] === "A" ? "B" : "A") + body.slice(1));
  assert.throws(() => parseSecretKey(typo), /typo/);
  assert.throws(() => parseSecretKey("V2-ABCDEF-SHORT"), /not a Vyre Secret Key/);
  assert.throws(() => parseSecretKey(sk.replace("ABCDEF", "ABCDEG")), /typo/);
});

test("account: password rules, wrong password, and the personal vault while locked", async t => {
  const { vault, db, events } = vaultOn(t, home(t));
  const pw = fake("mailpw"), seed = "JBSWY3DPEHPK3PXP", key = fake("apikey");
  // Before an account, everything is in the agent vault.
  await vault.put({ name: "mail-login", kind: "login", url: "https://mail.example.com", fields: { username: "alex@example.com", password: pw, totp: seed } }, "cli");
  await vault.put({ name: "api-key", kind: "api-key", fields: { value: key } }, "cli");
  assert.equal(vault.row("mail-login").vault, AGENTS);
  assert.equal(vault.list().personal, "none");

  await assert.rejects(vault.createAccount({ password: "short" }), /at least 12/);
  const made = await vault.createAccount({ password: PASSWORD });
  assert.match(made.secretKey, /^V2-[A-Z2-7]{6}-/);
  assert.equal(made.moved, 1);
  assert.equal(await vault.secretKey(), made.secretKey);
  await assert.rejects(vault.createAccount({ password: PASSWORD }), /already has an account/);
  assert.equal(vault.row("mail-login").vault, PERSONAL);
  assert.equal(vault.row("api-key").vault, AGENTS);
  assert.equal((await vault.fields(vault.row("mail-login"))).password, pw);

  vault.lockAccount();
  assert.equal(vault.list().personal, "locked");
  await assert.rejects(vault.fields(vault.row("mail-login")), e => /** @type {any} */ (e).code === "locked");
  await assert.rejects(vault.code({ name: "mail-login" }, "cli"), e => /** @type {any} */ (e).code === "locked");
  await assert.rejects(vault.inject({ items: [{ name: "mail-login" }] }, "cli", n => n), e => /** @type {any} */ (e).code === "locked");
  await assert.rejects(vault.put({ name: "card-1", kind: "card", fields: { number: "4111111111111111" } }, "cli"), e => /** @type {any} */ (e).code === "locked");
  // The agent vault keeps working for agents.
  assert.equal((await vault.fields(vault.row("api-key"))).value, key);

  await assert.rejects(vault.unlockAccount({ password: fake("wrong") }), /does not open your personal vault/);
  assert.ok(auditRows(db).some(r => r.action === "account-unlock" && r.ok === 0));
  assert.deepEqual(await vault.unlockAccount({ password: PASSWORD }), { unlocked: true, acct: made.acct, method: "password" });
  assert.equal((await vault.fields(vault.row("mail-login"))).totp, seed);
  // A card defaults to re-prompt, sealed in its meta.
  await vault.put({ name: "card-1", kind: "card", fields: { number: "4111111111111111" } }, "cli");
  assert.equal(vault.meta(vault.row("card-1")).reprompt, true);

  // Granting a personal login to a module moves it to the agent vault, so the module can use it while locked.
  await vault.grant({ name: "mail-login", module: "mail" }, "cli");
  assert.equal(vault.row("mail-login").vault, AGENTS);
  vault.lockAccount();
  assert.equal((await vault.release({ name: "mail-login" }, "module:mail")).value, pw);
  // From Claude a grant waits and moves nothing until approved.
  await vault.unlockAccount({ password: PASSWORD });
  await vault.put({ name: "shop-login", kind: "login", fields: { username: "dana", password: fake("shop") } }, "cli");
  const pending = (await vault.grant({ name: "shop-login", module: "mail" }, "mcp")).grant;
  assert.equal(vault.row("shop-login").vault, PERSONAL);
  await vault.approve({ id: pending.id }, "cli");
  assert.equal(vault.row("shop-login").vault, AGENTS);

  // No password, Secret Key or value in audit rows, events, the listing or the account file.
  const seen = JSON.stringify([auditRows(db), events, vault.list(), fs.readFileSync(path.join(vault.dir, "account.json"), "utf8")]);
  for (const s of [PASSWORD, made.secretKey, pw, key, seed]) assert.ok(!seen.includes(s), "leaked a secret");
});

test("account: the full-cost KDF is the default, and a stored cheap cost is refused without the test flag", async t => {
  const tmp = home(t);
  const { vault } = vaultOn(t, tmp);
  assert.equal(vault.kdfParams().kdf, typeof (/** @type {any} */ (crypto)).argon2Sync === "function" ? "argon2id" : "scrypt");
  vault.testKdf = null;
  assert.deepEqual(vault.kdfParams(), typeof (/** @type {any} */ (crypto)).argon2Sync === "function" ? { kdf: "argon2id", ...ARGON2 } : { kdf: "scrypt", N: 1 << 17, r: 8, p: 1 });
  vault.testKdf = TEST_KDF;
  await vault.createAccount({ password: PASSWORD });
  vault.lockAccount();
  vault.testKdf = null;
  await assert.rejects(vault.unlockAccount({ password: PASSWORD }), /outside what this vault allows/);
});

// ---- the v1 home, made by the original code ---------------------------------------------

/** The v1 seal from commit ebd38ec, copied here so the fixture is made the way that code made it. */
function sealItemV1(mk, id, name, fields) {
  const key = Buffer.from(crypto.hkdfSync("sha256", mk, Buffer.from(String(id)), "vyre vault item v1", 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(`vyre:item:v1:${id}:${name}`));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(fields))), c.final()]);
  return { v: 1, alg: "A256GCM", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

/** The v1 sealFor from commit ebd38ec. */
function sealForV1(boxPubDer, value, aad) {
  const eph = crypto.generateKeyPairSync("x25519");
  const epk = eph.publicKey.export({ format: "der", type: "spki" });
  const pub = crypto.createPublicKey({ key: Buffer.from(boxPubDer, "base64"), format: "der", type: "spki" });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, epk, "vyre pass seal v1", 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(value))), c.final()]);
  return { v: 1, epk: epk.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

/** A home as the v1 code left it: v1 schema, a key file, v1 item files, a v1 identity, a grant and a device. */
function v1Home(t) {
  const tmp = home(t);
  const dir = path.join(tmp, "vault");
  fs.mkdirSync(path.join(dir, "items"), { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const mk = crypto.randomBytes(32);
  fs.writeFileSync(path.join(dir, "key"), mk.toString("hex") + "\n", { mode: 0o600 });
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS.slice(0, 3));
  const items = {
    "mail-login": { kind: "login", url: "https://mail.example.com", hosts: ["https://mail.example.com"], fields: { username: "alex@example.com", password: fake("mail") } },
    "api-token": { kind: "api-key", url: null, hosts: ["https://api.acme.test"], fields: { value: fake("api") } },
  };
  for (const [name, it] of Object.entries(items)) {
    const id = crypto.randomBytes(9).toString("base64url");
    fs.writeFileSync(path.join(dir, "items", id + ".json"), JSON.stringify(sealItemV1(mk, id, name, it.fields)), { mode: 0o600 });
    db.prepare("INSERT INTO vault_items (id, name, kind, description, fields, url, hosts, origin, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, name, it.kind, "", JSON.stringify(Object.keys(it.fields)), it.url, JSON.stringify(it.hosts), null, 1, 1);
  }
  const identity = newIdentity();
  fs.writeFileSync(path.join(dir, "items", "identity.json"), JSON.stringify(sealItemV1(mk, "identity", "identity", identity)), { mode: 0o600 });
  db.prepare("INSERT INTO vault_grants (id, item, module, watcher, status, by, at) VALUES ('g_1','api-token','probe','','active','cli',1)").run();
  db.prepare("INSERT INTO vault_devices (id, name, token_hash, created) VALUES ('d_1','laptop chrome',?,1)").run("a".repeat(64));
  db.close();
  mk.fill(0);
  return { tmp, dir, items, identity };
}

test("migration: a v1 home from the original code is re-sealed as v2, and an old file put back is refused", async t => {
  const { tmp, dir, items, identity } = v1Home(t);
  const v1Files = Object.fromEntries(fs.readdirSync(path.join(dir, "items")).map(f => [f, fs.readFileSync(path.join(dir, "items", f), "utf8")]));

  // A crash in the middle: the rows update fails once. Nothing is lost, and the next start finishes.
  {
    const { vault, db } = vaultOn(t, tmp);
    const real = vault.tx.bind(vault);
    vault.tx = () => { throw new Error("simulated crash"); };
    await assert.rejects(vault.key(), /simulated crash/);
    vault.tx = real;
    db.close();
    for (const f of Object.keys(v1Files)) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "items", f), "utf8")).v, 1, f);
  }
  const { vault, db } = vaultOn(t, tmp);
  await vault.key(); // index.js does this at start for a home that has a key
  for (const [name, it] of Object.entries(items)) {
    const r = vault.row(name);
    assert.ok(r, name);
    assert.equal(r.ver, 1);
    assert.equal(r.vault, AGENTS);
    assert.ok(r.mac);
    assert.deepEqual(await vault.fields(r), it.fields);
    assert.equal(readSealed(dir, r.id).v, 2);
  }
  assert.deepEqual(await vault.identity(), identity);
  assert.equal(readSealed(dir, "identity").v, 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, "items")).filter(f => f.includes("__next")), []);
  // Pre-existing grant and device rows were signed at upgrade and still count.
  assert.equal((await vault.release({ name: "api-token" }, "module:probe")).value, items["api-token"].fields.value);
  assert.ok(vault.rowOk("vault_devices", db.prepare("SELECT * FROM vault_devices WHERE id='d_1'").get()));

  // Idempotent: a second start changes nothing.
  const before = fs.readdirSync(path.join(dir, "items")).map(f => fs.readFileSync(path.join(dir, "items", f), "utf8")).sort();
  db.close();
  const again = vaultOn(t, tmp);
  await again.vault.key();
  assert.deepEqual(fs.readdirSync(path.join(dir, "items")).map(f => fs.readFileSync(path.join(dir, "items", f), "utf8")).sort(), before);

  // The old v1 file put back is not migrated again: it is refused.
  const mailId = again.vault.row("mail-login").id;
  const v2mail = fs.readFileSync(path.join(dir, "items", mailId + ".json"), "utf8");
  fs.writeFileSync(path.join(dir, "items", mailId + ".json"), v1Files[mailId + ".json"], { mode: 0o600 });
  again.vault.lock();
  await again.vault.key();
  await assert.rejects(again.vault.fields(again.vault.row("mail-login")), /older version/);

  // Once an account exists and is unlocked, the login moves into the personal vault.
  fs.writeFileSync(path.join(dir, "items", mailId + ".json"), v2mail, { mode: 0o600 });
  await again.vault.createAccount({ password: PASSWORD });
  assert.equal(again.vault.row("mail-login").vault, PERSONAL);
  assert.equal(again.vault.row("api-token").vault, AGENTS, "granted, so it stays with agents");
  assert.deepEqual(await again.vault.fields(again.vault.row("mail-login")), items["mail-login"].fields);
});

test("item seal v2 binds vault, key version, id, version and name", () => {
  const vk = newVaultKey();
  const at = { vault: AGENTS, kv: 1, id: "it1", ver: 3, name: "github" };
  const body = { meta: { kind: "secret" }, fields: { value: fake("v") } };
  const sealed = sealItemV2(vk, at, body);
  assert.deepEqual(openItemV2(vk, at, sealed), body);
  for (const change of [{ vault: PERSONAL }, { kv: 2 }, { id: "it2" }, { ver: 2 }, { name: "gitlab" }]) {
    assert.throws(() => openItemV2(vk, { ...at, ...change }, { ...sealed, ...("vault" in change ? { vault: change.vault } : {}), ...("ver" in change ? { ver: change.ver } : {}), ...("kv" in change ? { kv: change.kv } : {}) }), JSON.stringify(change));
  }
  assert.throws(() => openItemV2(newVaultKey(), at, sealed));
});
