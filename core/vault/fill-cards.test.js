// @ts-check
// Cards and addresses through the fill listener: listed with a device token alone, filled with a
// live session, a card (reprompt by default) only within 60 seconds of the proof, the wrong kind
// refused, and no card number, code, holder or street in any audit row.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Fill, serveFill } from "./fill.js";
import { normalExpiry } from "./fill-cards.js";
import { SCRATCH } from "../../test/scratch.mjs";

// Standard test numbers, put together here rather than written out whole.
const VISA = ["4111", "1111", "1111", "1111"].join("");
const MC = ["5555", "5555", "5555", "4444"].join("");
const CVV = String(700 + 37);

/** The words of audit rows (not the time or the random device id, where three digits can turn up by chance). */
const words = rows => rows.map(r => [r.action, r.name, r.why, r.origin, r.surface].join(" ")).join("\n");

async function setup(t) {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-cards-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  await vault.key();
  let clock = Date.now();
  const fill = new Fill({ vault, now: () => clock });
  const srv = await serveFill({ host: "127.0.0.1", port: 0, fill });
  t.after(async () => { await srv.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (name, body, headers = {}, method = "POST") => {
    const res = await fetch(`${srv.url}/v1/fill/${name}`, { method, headers: { "content-type": "application/json", ...headers }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  const paired = (await call("pair", { code: fill.code({ name: "test browser" }).code }, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" })).body.data;
  const auth = { authorization: `Bearer ${paired.token}` };
  /** A fresh proof (Touch ID through the Capsule), collected on the next status call, as the extension does. */
  const unlock = async () => {
    fill.unlockDevice({ device: paired.device });
    return { ...auth, "x-vyre-session": (await call("status", null, auth, "GET")).body.data.session };
  };
  await vault.put({ name: "northwind-bakery-visa", kind: "card", description: "Northwind Bakery Visa",
    fields: { holder: "Alex Harlow", number: VISA, expiry: "7/2029", cvv: CVV, pin: "4321" } }, "cli");
  await vault.put({ name: "harlow-legal-mc", kind: "card", description: "Harlow Legal Mastercard", reprompt: false,
    fields: { holder: "Juno Harlow", number: MC, expiry: "2031-01" } }, "cli");
  await vault.put({ name: "harlow-legal-office", kind: "address", description: "Harlow Legal office",
    fields: { name: "Juno Harlow", company: "Harlow Legal", line1: "12 Quay Street", line2: "Suite 4", city: "Harlow", region: "Essex", postal: "CM20 1AA", country: "GB", email: "juno@harlow.test" } }, "cli");
  await vault.put({ name: "harlow-mail", kind: "login", url: "https://mail.harlow.test", fields: { username: "alex@harlow.test", password: "fixture-password" } }, "cli");
  return { db, call, auth, unlock, advance: ms => { clock += ms; } };
}

test("cards: listed anywhere with a device token, filled with a fresh proof, reprompt after 60 s", async t => {
  const { db, call, auth, unlock, advance } = await setup(t);

  const list = await call("cards", { url: "https://shop.northwind.test/checkout?step=2" }, auth);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.data, {
    cards: [{ name: "harlow-legal-mc", description: "Harlow Legal Mastercard" }, { name: "northwind-bakery-visa", description: "Northwind Bakery Visa" }],
    addresses: [{ name: "harlow-legal-office", description: "Harlow Legal office" }],
  });
  assert.deepEqual((await call("cards", { url: "https://harlow.test/" }, auth)).body.data, list.body.data, "not tied to a site");
  assert.equal((await call("cards", { url: "https://harlow.test/" }, {})).body.error.code, "unauthorized");

  // No session: refused.
  assert.equal((await call("card.fill", { url: "https://shop.northwind.test/", name: "northwind-bakery-visa" }, auth)).body.error.code, "session_required");

  const h = await unlock();
  const got = await call("card.fill", { url: "https://shop.northwind.test/pay", name: "northwind-bakery-visa" }, h);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.deepEqual(got.body.data, { holder: "Alex Harlow", number: VISA, expiry: "07/29", exp_month: "07", exp_year: "2029", cvv: CVV });
  assert.ok(!("pin" in got.body.data), "a PIN never leaves for a page");

  // 61 seconds on, the same session still fills a card that does not ask every time, not one that does.
  advance(61_000);
  const stale = await call("card.fill", { url: "https://shop.northwind.test/pay", name: "northwind-bakery-visa" }, h);
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.body.error, { code: "reprompt", message: "this card asks every time: unlock again" });
  const mc = await call("card.fill", { url: "https://shop.northwind.test/pay", name: "harlow-legal-mc" }, h);
  assert.deepEqual(mc.body.data, { holder: "Juno Harlow", number: MC, expiry: "01/31", exp_month: "01", exp_year: "2031" });
  // A fresh proof fills it again.
  assert.equal((await call("card.fill", { url: "https://shop.northwind.test/pay", name: "northwind-bakery-visa" }, await unlock())).status, 200);

  // Wrong kind, unknown name, not a web page.
  assert.equal((await call("card.fill", { url: "https://shop.northwind.test/", name: "harlow-legal-office" }, h)).body.error.code, "not_found");
  assert.equal((await call("card.fill", { url: "https://shop.northwind.test/", name: "harlow-mail" }, h)).body.error.code, "not_found");
  assert.equal((await call("address.fill", { url: "https://shop.northwind.test/", name: "northwind-bakery-visa" }, h)).body.error.code, "not_found");
  assert.equal((await call("card.fill", { url: "file:///etc/hosts", name: "harlow-legal-mc" }, h)).body.error.code, "bad_input");
  assert.equal((await call("card.fill", { url: "https://shop.northwind.test/" }, h)).body.error.code, "bad_input");

  const audit = /** @type {any[]} */ (db.prepare("SELECT * FROM vault_audit").all());
  const rows = words(audit);
  assert.ok(audit.some(r => /fill-card/.test(JSON.stringify(r)) && /https:\/\/shop\.northwind\.test/.test(JSON.stringify(r))));
  assert.ok(audit.some(r => /fill-cards/.test(JSON.stringify(r))));
  assert.ok(!rows.includes("checkout?step"), "the origin only, never the path");
  for (const v of [VISA, MC, CVV, "4321", "Alex Harlow", "07/29"]) assert.ok(!rows.includes(v), `no ${v.length}-character value in the audit`);
});

test("addresses: the fields present, with a live session; no value in the audit", async t => {
  const { db, call, auth, unlock, advance } = await setup(t);
  assert.equal((await call("address.fill", { url: "https://harlow.test/", name: "harlow-legal-office" }, auth)).body.error.code, "session_required");
  const h = await unlock();
  advance(5 * 60_000); // an address does not ask every time: the fill window covers it
  const a = await call("address.fill", { url: "https://order.northwind.test/ship", name: "harlow-legal-office" }, h);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(a.body.data, { name: "Juno Harlow", company: "Harlow Legal", line1: "12 Quay Street", line2: "Suite 4", city: "Harlow", region: "Essex", postal: "CM20 1AA", country: "GB", email: "juno@harlow.test" });
  advance(30 * 60_000);
  assert.equal((await call("address.fill", { url: "https://order.northwind.test/", name: "harlow-legal-office" }, h)).body.error.code, "session_expired");
  const rows = words(/** @type {any[]} */ (db.prepare("SELECT * FROM vault_audit").all()));
  assert.match(rows, /fill-address/);
  for (const v of ["12 Quay Street", "CM20 1AA", "juno@harlow.test", "Suite 4"]) assert.ok(!rows.includes(v), v);
});

test("expiry: the ways people write it, to MM/YY with month and year apart", () => {
  for (const [v, want] of [["12/29", "12/29"], ["7/2029", "07/29"], ["07-29", "07/29"], ["1229", "12/29"], ["122029", "12/29"], ["2029-12", "12/29"], ["12 / 29", "12/29"]])
    assert.equal(normalExpiry(v)?.expiry, want, v);
  assert.deepEqual(normalExpiry("3/31"), { expiry: "03/31", exp_month: "03", exp_year: "2031" });
  for (const v of ["13/29", "0/29", "soon", "", "12/2"]) assert.equal(normalExpiry(v), null, v);
});
