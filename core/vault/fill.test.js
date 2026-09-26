// @ts-check
// fill tests: a real Vault in a temp folder with the file keystore, the fill listener on a real
// port, and every door it has: pairing, the Origin rule, unlock and its lockout, match, fill and
// its phishing guard, sessions that end, revoked devices, the Touch ID pick-up, and the promise
// that no value, token or passphrase lands in an audit row. All logins here are fictional.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Fill, FILL_MIGRATION, FILL_TOOLS, serveFill } from "./fill.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PASSWORD = `fixture-pw-${crypto.randomBytes(12).toString("hex")}`;
const UNLOCK = `fixture-unlock-${crypto.randomBytes(8).toString("hex")}`;
const SEED = "JBSWY3DPEHPK3PXP";

async function setup(t, { now } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-fill-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const events = [];
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }) });
  await vault.put({ name: "example-mail", kind: "login", description: "fictional mail login", url: "https://mail.example.com/login",
    fields: { username: "someone@example.com", password: PASSWORD, totp: SEED } }, "cli");
  await vault.put({ name: "other-site", kind: "login", url: "https://other.example.org", fields: { username: "u2", password: "fixture-other" } }, "cli");
  const clock = { t: Date.now() };
  const fill = new Fill({ vault, now: now || (() => clock.t) });
  const srv = await serveFill({ host: "127.0.0.1", port: 0, fill });
  t.after(async () => { await srv.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  /** @param {string} route @param {any} [body] @param {Record<string,string>} [headers] */
  const call = async (route, body, headers = {}) => {
    const [method, name] = route.split(" ");
    const res = await fetch(`${srv.url}/v1/fill/${name}`, {
      method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const pairNew = async (name = "test browser") => {
    const { code } = fill.code({ name });
    const r = await call("POST pair", { code, name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  };
  return { tmp, db, vault, fill, srv, call, pairNew, clock, events };
}

const bearer = token => ({ authorization: `Bearer ${token}` });

test("FILL_MIGRATION creates only vault_ tables and FILL_TOOLS name real methods", () => {
  for (const m of FILL_MIGRATION.matchAll(/CREATE TABLE (\w+)/g)) assert.ok(m[1].startsWith("vault_"), m[1]);
  const names = FILL_TOOLS.map(x => x.name);
  assert.deepEqual(names.sort(), ["vault.device.code", "vault.device.revoke", "vault.device.unlock", "vault.devices", "vault.unlock-passphrase"]);
  assert.ok(!names.some(n => /fill/.test(n)), "there is no fill tool");
  for (const x of FILL_TOOLS) assert.equal(typeof Fill.prototype[x.method], "function", x.method);
  for (const n of ["vault.device.code", "vault.device.unlock", "vault.unlock-passphrase"]) {
    assert.deepEqual(FILL_TOOLS.find(x => x.name === n)?.callers, ["cli", "local"]);
  }
});

test("pairing: a code works once, a used, expired or unknown code fails", async t => {
  const { fill, call, clock } = await setup(t);
  const c = fill.code({ name: "laptop chrome" });
  assert.match(c.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
  const r = await call("POST pair", { code: c.display.toLowerCase(), name: "ignored" });
  assert.equal(r.status, 200);
  assert.match(r.body.data.device, /^d_/);
  assert.equal(r.body.data.name, "laptop chrome");
  assert.equal(Buffer.from(r.body.data.token, "base64url").length, 32);

  const again = await call("POST pair", { code: c.code, name: "second" });
  assert.equal(again.status, 403);
  assert.equal(again.body.error.code, "bad_code");

  const old = fill.code({});
  clock.t += 5 * 60_000 + 1;
  const late = await call("POST pair", { code: old.code, name: "late" });
  assert.equal(late.status, 403);
  assert.match(late.body.error.message, /expired/);

  const none = await call("POST pair", { code: "ZZZZZZZZ" });
  assert.equal(none.status, 403);

  // Codes are stored hashed, never as typed.
  const rows = fill.db.prepare("SELECT code_hash FROM vault_pairing").all();
  assert.ok(rows.every(x => !String(x.code_hash).includes(c.code)));
});

test("a web page Origin is refused; the extension Origin gets CORS for itself only", async t => {
  const { call, pairNew } = await setup(t);
  const { token } = await pairNew();
  const page = await call("GET status", null, { ...bearer(token), origin: "https://mail.example.com" });
  assert.equal(page.status, 403);
  assert.equal(page.body.error.code, "origin_refused");
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  const nul = await call("POST match", { url: "https://mail.example.com" }, { ...bearer(token), origin: "null" });
  assert.equal(nul.status, 403);

  const ext = await call("GET status", null, { ...bearer(token), origin: EXT });
  assert.equal(ext.status, 200);
  assert.equal(ext.headers.get("access-control-allow-origin"), EXT);
  const moz = await call("GET status", null, { ...bearer(token), origin: "moz-extension://0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" });
  assert.equal(moz.status, 200);
});

test("OPTIONS preflight answers the extension and refuses a page", async t => {
  const { srv } = await setup(t);
  const ok = await fetch(`${srv.url}/v1/fill/fill`, { method: "OPTIONS", headers: { origin: EXT, "access-control-request-method": "POST", "access-control-request-headers": "authorization, x-vyre-session, content-type" } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), EXT);
  assert.match(String(ok.headers.get("access-control-allow-headers")), /x-vyre-session/);
  const bad = await fetch(`${srv.url}/v1/fill/fill`, { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "POST" } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("no token, wrong route, wrong method and an oversized body are refused", async t => {
  const { call, srv } = await setup(t);
  assert.equal((await call("GET status")).status, 401);
  assert.equal((await call("GET status", null, bearer("x".repeat(43)))).status, 401);
  assert.equal((await fetch(`${srv.url}/v1/fill/nope`)).status, 404);
  assert.equal((await fetch(`${srv.url}/v1/relay`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${srv.url}/v1/fill/fill`)).status, 405);
  const big = await fetch(`${srv.url}/v1/fill/pair`, { method: "POST", body: "x".repeat(70 * 1024) }).catch(e => e);
  assert.ok(big instanceof Error || big.status === 413);
});

test("unlock: wrong passphrase, then right; match; fill for the right origin with a TOTP code", async t => {
  const { fill, call, pairNew } = await setup(t);
  const { token } = await pairNew();
  const notSet = await call("POST unlock", { passphrase: UNLOCK }, bearer(token));
  assert.equal(notSet.status, 409);
  assert.equal(notSet.body.error.code, "not_set");
  await assert.rejects(fill.setUnlockPassphrase({ passphrase: "short" }), /at least 8/);
  await fill.setUnlockPassphrase({ passphrase: UNLOCK });

  const wrong = await call("POST unlock", { passphrase: "not-the-passphrase" }, bearer(token));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, "bad_passphrase");
  const right = await call("POST unlock", { passphrase: UNLOCK }, bearer(token));
  assert.equal(right.status, 200);
  const { session, expires } = right.body.data;
  assert.ok(session && expires > Date.now());

  const m = await call("POST match", { url: "https://mail.example.com/inbox?x=1" }, bearer(token));
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.data.logins, [{ name: "example-mail", description: "fictional mail login", url: "https://mail.example.com/login" }]);
  assert.ok(!JSON.stringify(m.body).includes("someone@example.com"), "match carries no username");

  const f = await call("POST fill", { name: "example-mail", url: "https://mail.example.com/login" }, { ...bearer(token), "x-vyre-session": session });
  assert.equal(f.status, 200);
  assert.equal(f.body.data.username, "someone@example.com");
  assert.equal(f.body.data.password, PASSWORD);
  assert.match(f.body.data.totp, /^\d{6}$/);

  const st = await call("GET status", null, { ...bearer(token), "x-vyre-session": session });
  assert.equal(st.body.data.unlocked, true);
  const locked = await call("POST lock", {}, bearer(token));
  assert.equal(locked.body.data.sessionsEnded, 1);
  const after = await call("POST fill", { name: "example-mail", url: "https://mail.example.com/" }, { ...bearer(token), "x-vyre-session": session });
  assert.equal(after.status, 401);
});

test("fill is refused for a lookalike origin, another scheme or port, and another login", async t => {
  const { fill, call, pairNew } = await setup(t);
  const { token } = await pairNew();
  await fill.setUnlockPassphrase({ passphrase: UNLOCK });
  const { session } = (await call("POST unlock", { passphrase: UNLOCK }, bearer(token))).body.data;
  const h = { ...bearer(token), "x-vyre-session": session };
  for (const url of ["https://mail.example.com.evil.test/login", "https://evil.test/mail.example.com", "http://mail.example.com/", "https://mail.example.com:8443/", "https://example.com/", "javascript:alert(1)"]) {
    const r = await call("POST fill", { name: "example-mail", url }, h);
    assert.notEqual(r.status, 200, url);
    assert.ok(!JSON.stringify(r.body).includes(PASSWORD), url);
    const mm = await call("POST match", { url }, bearer(token));
    assert.deepEqual(mm.body.data.logins, [], url);
  }
  const cross = await call("POST fill", { name: "other-site", url: "https://mail.example.com/" }, h);
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error.code, "wrong_origin");
});

test("fill needs a session, and an idle or over-age session ends", async t => {
  const { fill, call, pairNew, clock } = await setup(t);
  const { token } = await pairNew();
  await fill.setUnlockPassphrase({ passphrase: UNLOCK });
  const url = "https://mail.example.com/";
  const none = await call("POST fill", { name: "example-mail", url }, bearer(token));
  assert.equal(none.status, 401);
  assert.equal(none.body.error.code, "session_required");
  const bogus = await call("POST fill", { name: "example-mail", url }, { ...bearer(token), "x-vyre-session": "A".repeat(43) });
  assert.equal(bogus.body.error.code, "session_expired");

  let { session } = (await call("POST unlock", { passphrase: UNLOCK }, bearer(token))).body.data;
  clock.t += 10 * 60_000 + 1;
  const idle = await call("POST fill", { name: "example-mail", url }, { ...bearer(token), "x-vyre-session": session });
  assert.equal(idle.status, 401);
  assert.equal(idle.body.error.code, "session_expired");

  // Kept busy, a session still ends at twelve hours.
  ({ session } = (await call("POST unlock", { passphrase: UNLOCK }, bearer(token))).body.data);
  for (let i = 0; i < 12 * 7; i++) {
    clock.t += 9 * 60_000;
    const r = await call("POST fill", { name: "example-mail", url }, { ...bearer(token), "x-vyre-session": session });
    if (r.status !== 200) { assert.equal(r.body.error.code, "session_expired"); assert.equal(i, 79, "ended at twelve hours"); return; }
  }
  assert.fail("the session outlived its hard cap");
});

test("a session belongs to its device only", async t => {
  const { fill, call, pairNew } = await setup(t);
  const a = await pairNew("a");
  const b = await pairNew("b");
  await fill.setUnlockPassphrase({ passphrase: UNLOCK });
  const { session } = (await call("POST unlock", { passphrase: UNLOCK }, bearer(a.token))).body.data;
  const r = await call("POST fill", { name: "example-mail", url: "https://mail.example.com/" }, { ...bearer(b.token), "x-vyre-session": session });
  assert.equal(r.status, 401);
});

test("five wrong passphrases lock a device out, even from the right one; other devices are unaffected", async t => {
  const { fill, call, pairNew, clock } = await setup(t);
  const a = await pairNew("a");
  const b = await pairNew("b");
  await fill.setUnlockPassphrase({ passphrase: UNLOCK });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await call("POST unlock", { passphrase: `wrong-${i}-guess` }, bearer(a.token))).body.error.code);
  assert.deepEqual(codes, ["bad_passphrase", "bad_passphrase", "bad_passphrase", "bad_passphrase", "locked_out"]);
  const right = await call("POST unlock", { passphrase: UNLOCK }, bearer(a.token));
  assert.equal(right.status, 429);
  assert.equal(right.body.error.code, "locked_out");
  assert.equal((await call("POST unlock", { passphrase: UNLOCK }, bearer(b.token))).status, 200);
  clock.t += 15 * 60_000 + 1;
  assert.equal((await call("POST unlock", { passphrase: UNLOCK }, bearer(a.token))).status, 200);
});

test("the vault passphrase is accepted through the callback when the keystore is passphrase", async t => {
  const { vault, pairNew } = await setup(t);
  const { token } = await pairNew();
  // The same vault seen as a passphrase keystore; the callback stands in for the keystore check.
  const asPassphrase = Object.create(vault, { kind: { value: "passphrase" } });
  const f2 = new Fill({ vault: asPassphrase, verifyVaultPassphrase: async p => p === "fixture-vault-passphrase" });
  assert.equal((await f2.handle("GET status", null, bearer(token))).body.data.canUnlock, true);
  const bad = await f2.handle("POST unlock", { passphrase: "nope-nope-nope" }, bearer(token));
  assert.equal(bad.status, 401);
  const good = await f2.handle("POST unlock", { passphrase: "fixture-vault-passphrase" }, bearer(token));
  assert.equal(good.status, 200);
});

test("a revoked device is refused at once, sessions and all", async t => {
  const { fill, call, pairNew } = await setup(t);
  const { device, token } = await pairNew();
  await fill.setUnlockPassphrase({ passphrase: UNLOCK });
  const { session } = (await call("POST unlock", { passphrase: UNLOCK }, bearer(token))).body.data;
  assert.equal(fill.devices().devices[0].sessions, 1);
  const r = fill.revokeDevice({ id: device });
  assert.equal(r.revoked, true);
  assert.equal(r.sessionsEnded, 1);
  for (const route of ["GET status", "POST match", "POST fill", "POST unlock"]) {
    const x = await call(route, route === "GET status" ? null : { name: "example-mail", url: "https://mail.example.com/", passphrase: UNLOCK }, { ...bearer(token), "x-vyre-session": session });
    assert.equal(x.status, 401, route);
    assert.equal(x.body.error.code, "revoked", route);
  }
  assert.ok(fill.devices().devices[0].revoked);
  assert.throws(() => fill.unlockDevice({ device }), /revoked/);
});

test("Touch ID style: unlockDevice opens a session the extension picks up once through status", async t => {
  const { fill, call, pairNew } = await setup(t);
  const { device, token } = await pairNew();
  const before = await call("GET status", null, bearer(token));
  assert.equal(before.body.data.unlocked, false);
  const u = fill.unlockDevice({ device }, "local");
  assert.deepEqual(Object.keys(u).sort(), ["expires", "ok"]);
  const first = await call("GET status", null, { ...bearer(token), origin: EXT });
  assert.equal(first.body.data.unlocked, true);
  const session = first.body.data.session;
  assert.ok(session);
  const second = await call("GET status", null, bearer(token));
  assert.equal(second.body.data.session, undefined, "the token is handed over once");
  assert.equal(second.body.data.unlocked, false);
  const withIt = await call("GET status", null, { ...bearer(token), "x-vyre-session": session });
  assert.equal(withIt.body.data.unlocked, true);
  const f = await call("POST fill", { name: "example-mail", url: "https://mail.example.com/" }, { ...bearer(token), "x-vyre-session": session });
  assert.equal(f.status, 200);
  assert.throws(() => fill.unlockDevice({ device: "d_nobody" }), /no paired device/);
});

test("no password, token, session, code or passphrase appears in audit rows, events or tables", async t => {
  const { fill, call, db, events } = await setup(t);
  const c = fill.code({ name: "scan" });
  const { device, token } = (await call("POST pair", { code: c.code, name: "scan" })).body.data;
  await fill.setUnlockPassphrase({ passphrase: UNLOCK });
  await call("POST unlock", { passphrase: "wrong-guess-here" }, bearer(token));
  const { session } = (await call("POST unlock", { passphrase: UNLOCK }, bearer(token))).body.data;
  await call("POST fill", { name: "example-mail", url: "https://mail.example.com/" }, { ...bearer(token), "x-vyre-session": session });
  await call("POST fill", { name: "example-mail", url: "https://mail.example.com.evil.test/" }, { ...bearer(token), "x-vyre-session": session });
  fill.unlockDevice({ device });
  await call("POST lock", {}, bearer(token));
  fill.revokeDevice({ id: device });

  const audit = db.prepare("SELECT * FROM vault_audit").all();
  const actions = audit.map(r => `${r.action}:${r.ok}`);
  for (const want of ["pair:1", "unlock:0", "unlock:1", "fill:1", "fill:0", "device-revoke:1"]) assert.ok(actions.includes(want), want);
  assert.ok(audit.filter(r => ["pair", "unlock", "fill"].includes(String(r.action)) && r.ok).every(r => r.who === `device:${device}:scan`));

  const secrets = [PASSWORD, token, session, c.code, UNLOCK, "someone@example.com", SEED];
  const everything = JSON.stringify({ audit, events,
    tables: ["vault_devices", "vault_sessions", "vault_meta", "vault_pairing", "vault_items"].map(n => db.prepare(`SELECT * FROM ${n}`).all()) });
  for (const s of secrets) assert.ok(!everything.includes(s), "a secret leaked into the database or events");
});

test("the extension manifest parses, is MV3 and keeps its permissions narrow", () => {
  const dir = path.join(HERE, "..", "..", "modules", "vault-extension");
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ["activeTab", "scripting", "storage"]);
  assert.deepEqual(m.host_permissions, ["http://127.0.0.1/*"]);
  assert.ok(!m.content_scripts, "no content script runs on pages unasked");
  assert.match(m.content_security_policy.extension_pages, /script-src 'self'/);
  assert.doesNotMatch(m.content_security_policy.extension_pages, /unsafe-|https?:\/\/\*[^.]/);
  for (const f of ["popup.html", "popup.js", "background.js", "fill.js", "README.md"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
  assert.doesNotMatch(bg, /storage\.local\.set\([^)]*session/i, "the session token never goes to storage.local");
  for (const f of ["popup.js", "background.js", "fill.js"]) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), "utf8"), /\beval\(|new Function\(/, f);
});

test("the vault's own migrations include the fill tables", () => {
  assert.ok(MIGRATIONS.includes(FILL_MIGRATION));
});
