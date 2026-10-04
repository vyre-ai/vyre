// @ts-check
// fill-save tests: the /v1/fill/otp and /v1/fill/save HTTP contract, on a real listener over a
// real Vault in a temp folder with the file keystore. All logins are fictional; every password is
// a canary that must never come back in a response, an audit row or an event.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Fill, serveFill } from "./fill.js";
import { SCRATCH } from "../../test/scratch.mjs";

const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const canary = () => `fixture-canary-${crypto.randomBytes(12).toString("hex")}`;
const SEED = "JBSWY3DPEHPK3PXP";

async function setup(t) {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-fillsave-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const events = [];
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }) });
  const first = canary();
  await vault.put({ name: "example-mail", kind: "login", url: "https://mail.example.com/login", fields: { username: "alex@example.com", password: first, totp: SEED } }, "cli");
  const fill = new Fill({ vault });
  const srv = await serveFill({ host: "127.0.0.1", port: 0, fill });
  t.after(async () => { await srv.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (route, body, headers = {}) => {
    const res = await fetch(`${srv.url}/v1/fill/${route}`, { method: "POST", headers: { "content-type": "application/json", origin: EXT, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const { code } = fill.code({ name: "test browser" });
  const paired = (await call("pair", { code })).body.data;
  await fill.setUnlockPassphrase({ passphrase: "a long unlock passphrase" });
  const session = (await call("unlock", { passphrase: "a long unlock passphrase" }, { authorization: `Bearer ${paired.token}` })).body.data.session;
  const device = { authorization: `Bearer ${paired.token}` };
  const both = { ...device, "x-vyre-session": session };
  return { vault, fill, call, device, both, events, first };
}

test("otp: a code for the page's exact origin, with a device and a session", async t => {
  const { call, device, both } = await setup(t);
  const r = await call("otp", { name: "example-mail", url: "https://mail.example.com/2fa?x=1" }, both);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.data.code, /^\d{6}$/);
  assert.equal(r.body.data.period, 30);
  assert.ok(r.body.data.remaining > 0 && r.body.data.remaining <= 30);

  const evil = await call("otp", { name: "example-mail", url: "https://mail.example.com.evil.test" }, both);
  assert.equal(evil.body.error?.code, "wrong_origin", JSON.stringify(evil));
  assert.equal((await call("otp", { name: "example-mail", url: "https://mail.example.com" }, device)).body.error.code, "session_required");
  assert.equal((await call("otp", { name: "example-mail", url: "https://mail.example.com" }, {})).status, 401);
  assert.equal((await call("otp", { name: "nope", url: "https://mail.example.com" }, both)).status, 404);
});

test("save: a new login gets hosts = the exact origin and a name from the host; nothing comes back", async t => {
  const { vault, call, both } = await setup(t);
  const pw = canary();
  const r = await call("save", { url: "https://shop.example.org:8443/signin?next=/", username: "dana@example.org", password: pw }, both);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { name: "shop.example.org", created: true, updated: false });
  const row = vault.row("shop.example.org");
  assert.deepEqual(JSON.parse(row.hosts), ["https://shop.example.org:8443"]);
  assert.equal((await vault.fields(row)).password, pw);

  // A second account on the same site is a second item.
  const r2 = await call("save", { url: "https://shop.example.org:8443/", username: "alex@example.org", password: canary() }, both);
  assert.deepEqual(r2.body.data, { name: "shop.example.org-2", created: true, updated: false });
});

test("save: a changed password updates the login and keeps the old one in its sealed history, five at most", async t => {
  const { vault, call, both, first } = await setup(t);
  const same = await call("save", { url: "https://mail.example.com/", username: "alex@example.com", password: first }, both);
  assert.deepEqual(same.body.data, { name: "example-mail", created: false, updated: false });

  const seen = [first];
  for (let i = 0; i < 7; i++) {
    const pw = canary();
    seen.push(pw);
    const r = await call("save", { url: "https://mail.example.com/settings", username: "alex@example.com", password: pw }, both);
    assert.deepEqual(r.body.data, { name: "example-mail", created: false, updated: true });
  }
  const f = await vault.fields(vault.row("example-mail"));
  assert.equal(f.password, seen.at(-1));
  assert.equal(f.totp, SEED, "other fields stay");
  const history = JSON.parse(f.history);
  assert.equal(history.length, 5);
  assert.deepEqual(history.map(h => h.password), seen.slice(-6, -1).reverse());
  assert.ok(!(await vault.list()).items.some(i => JSON.stringify(i).includes(seen[0])));

  // Update on change, by name: only on one of the login's own origins.
  const named = await call("save", { name: "example-mail", url: "https://mail.example.com", password: canary() }, both);
  assert.equal(named.body.data.updated, true);
  assert.equal((await call("save", { name: "example-mail", url: "https://other.example.net", password: canary() }, both)).body.error.code, "wrong_origin");
});

test("save: needs a device and a session and a password", async t => {
  const { call, device, both } = await setup(t);
  assert.equal((await call("save", { url: "https://a.example.com", password: canary() }, {})).status, 401);
  assert.equal((await call("save", { url: "https://a.example.com", password: canary() }, device)).body.error.code, "session_required");
  assert.equal((await call("save", { url: "https://a.example.com", password: canary() }, { ...device, "x-vyre-session": "x".repeat(43) })).body.error.code, "session_expired");
  assert.equal((await call("save", { url: "https://a.example.com" }, both)).body.error.code, "bad_input");
  assert.equal((await call("save", { url: "ftp://a.example.com", password: canary() }, both)).body.error.code, "bad_input");
  const page = await call("save", { url: "https://a.example.com", password: canary() }, { ...both, origin: "https://a.example.com" });
  assert.equal(page.body.error.code, "origin_refused", "a web page never reaches save");
});

test("no password from save or otp appears in a response, an audit row or an event", async t => {
  const { vault, call, both, events, first } = await setup(t);
  const pws = [first];
  const texts = [];
  for (let i = 0; i < 3; i++) {
    const pw = canary(); pws.push(pw);
    texts.push(JSON.stringify(await call("save", { url: "https://mail.example.com", username: "alex@example.com", password: pw }, both)));
    texts.push(JSON.stringify(await call("save", { url: "https://new.example.com", username: `u${i}`, password: pw }, both)));
  }
  texts.push(JSON.stringify(await call("save", { name: "example-mail", url: "https://wrong.example.com", password: pws[1] }, both)));
  texts.push(JSON.stringify(await call("otp", { name: "example-mail", url: "https://mail.example.com" }, both)));
  texts.push(JSON.stringify(vault.auditTrail({ limit: 1000 })), JSON.stringify(events), JSON.stringify(vault.list()));
  for (const pw of pws) for (const [i, text] of texts.entries()) assert.ok(!text.includes(pw), `a password appeared in output ${i}`);
});
