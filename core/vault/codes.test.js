// @ts-check
// The authenticator (ADR 0028): Google Authenticator exports in several parts, otpauth URIs,
// current and next codes, and no seed in anything returned, audited or emitted.
// Every seed here is made at run time.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { recorded } from "./testing.js";
import { readMigration, gather, base32Encode } from "./otpmigration.js";
import { totp } from "./totp.js";

// A minimal protobuf writer for Google Authenticator's MigrationPayload, as its export makes it.
const varint = n => { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const field = (f, wire, body) => Buffer.concat([varint((f << 3) | wire), wire === 2 ? Buffer.concat([varint(body.length), body]) : varint(body)]);
const otp = ({ secret, name, issuer, algorithm = 1, digits = 1, type = 2 }) => Buffer.concat([
  field(1, 2, secret), field(2, 2, Buffer.from(name)), ...(issuer ? [field(3, 2, Buffer.from(issuer))] : []),
  field(4, 0, algorithm), field(5, 0, digits), field(6, 0, type)]);
const migration = (accounts, { size = 1, index = 0, id = 7 } = {}) => {
  const body = Buffer.concat([...accounts.map(a => field(1, 2, otp(a))), field(2, 0, 1), field(3, 0, size), field(4, 0, index), field(5, 0, id)]);
  return `otpauth-migration://offline?data=${encodeURIComponent(body.toString("base64"))}`;
};
const seed = () => crypto.randomBytes(20);

test("otpmigration: reads a payload, names from issuer and label, HOTP and MD5 skipped by name", () => {
  const a = seed(), b = seed();
  const p = readMigration(migration([
    { secret: a, name: "Harlow Legal:alex@harlow.test", issuer: "Harlow Legal" },
    { secret: b, name: "kit", issuer: "Northwind", algorithm: 2, digits: 2 },
    { secret: seed(), name: "old-token", issuer: "Northwind VPN", type: 1 },
    { secret: seed(), name: "legacy", issuer: "Harlow Intranet", algorithm: 4 },
  ]));
  assert.deepEqual(p.batch, { id: 7, index: 0, size: 1 });
  assert.deepEqual(p.accounts.map(x => [x.issuer, x.account]), [["Harlow Legal", "alex@harlow.test"], ["Northwind", "kit"]]);
  const u = new URL(p.accounts[1].uri);
  assert.equal(u.searchParams.get("secret"), base32Encode(b));
  assert.equal(u.searchParams.get("algorithm"), "SHA256");
  assert.equal(u.searchParams.get("digits"), "8");
  // The URI makes the same codes as the raw seed would.
  assert.equal(totp(p.accounts[0].uri, { at: 1_800_000_000_000 }).code, totp(base32Encode(a), { at: 1_800_000_000_000 }).code);
  assert.deepEqual(p.skipped, ["Northwind VPN old-token: counter-based (HOTP) codes are not supported", "Harlow Intranet legacy: MD5 codes are not supported"]);
  assert.throws(() => readMigration("otpauth-migration://offline?data="), /no data/);
  assert.throws(() => readMigration("https://example.com"), /not a Google Authenticator export/);
  assert.throws(() => readMigration("otpauth-migration://offline?data=" + Buffer.from([0x0a, 0x50]).toString("base64")), /ends early/);
});

test("otpmigration: a split export waits for every part, in any order, repeats allowed", () => {
  const p1 = migration([{ secret: seed(), name: "alex", issuer: "Harlow Legal" }], { size: 3, index: 0, id: 42 });
  const p2 = migration([{ secret: seed(), name: "kit", issuer: "Northwind" }], { size: 3, index: 1, id: 42 });
  const p3 = migration([{ secret: seed(), name: "juno", issuer: "Northwind" }], { size: 3, index: 2, id: 42 });
  assert.deepEqual(gather([p2, p1]).missing, [{ batch: 42, parts: [3], of: 3 }]);
  assert.equal(gather([p2, p1]).accounts.length, 0);
  const all = gather([p3, p1, p2, p1, `otpauth://totp/GitHub:alex?secret=${base32Encode(seed())}&issuer=GitHub`]);
  assert.deepEqual(all.missing, []);
  // Plain URIs first, then each batch in part order.
  assert.deepEqual(all.accounts.map(a => `${a.issuer}/${a.account}`), ["GitHub/alex", "Harlow Legal/alex", "Northwind/kit", "Northwind/juno"]);
  assert.deepEqual(gather(["nonsense"]).skipped, ["code 1: not an otpauth-migration:// address"]);
});

test("vault.codes.import and vault.codes: preview, incomplete, same seed twice, current and next, no seed leaks", async t => {
  const { run, db, events } = await recorded(t);
  const s1 = seed(), s2 = seed(), s3 = seed();
  const parts = [
    migration([{ secret: s1, name: "Harlow Legal:alex@harlow.test", issuer: "Harlow Legal" }], { size: 2, index: 0, id: 9 }),
    migration([{ secret: s2, name: "kit", issuer: "Northwind" }], { size: 2, index: 1, id: 9 }),
  ];
  await assert.rejects(run("vault.codes.import", { uris: [parts[1]] }), /scan part 1 of 2 too/);
  const pre = await run("vault.codes.import", { uris: [parts[1]], preview: true });
  assert.deepEqual(pre.missing, [{ batch: 9, parts: [1], of: 2 }]);

  // A login already holds s2's seed: it is the same account, not a new one.
  await run("vault.put", { name: "northwind-orders", kind: "login", fields: { username: "kit", password: "sample-" + crypto.randomBytes(6).toString("hex"), totp: base32Encode(s2) } });
  const preview = await run("vault.codes.import", { uris: parts, preview: true });
  assert.deepEqual(preview.add, ["harlow-legal-alex-harlow-test"]);
  assert.deepEqual(preview.same, ["northwind-orders"]);
  assert.equal((await run("vault.list", {})).items.length, 1, "preview stores nothing");

  const done = await run("vault.codes.import", { uris: [...parts, `otpauth://totp/GitHub:alex?secret=${base32Encode(s3)}&issuer=GitHub`] });
  assert.deepEqual(done.added.sort(), ["github-alex", "harlow-legal-alex-harlow-test"]);
  const item = (await run("vault.list", {})).items.find(i => i.name === "harlow-legal-alex-harlow-test");
  assert.equal(item.kind, "authenticator");
  assert.equal(item.details.issuer, "Harlow Legal");
  // Scanning again finds them all here already.
  assert.deepEqual((await run("vault.codes.import", { uris: parts, preview: true })).add, []);

  const now = Date.now();
  const listed = await run("vault.codes", {});
  const by = Object.fromEntries(listed.codes.map(c => [c.name, c]));
  assert.deepEqual(Object.keys(by).sort(), ["github-alex", "harlow-legal-alex-harlow-test", "northwind-orders"]);
  const h = by["harlow-legal-alex-harlow-test"];
  assert.equal(h.issuer, "Harlow Legal");
  assert.equal(h.period, 30);
  assert.ok(h.remaining >= 1 && h.remaining <= 30);
  assert.equal(h.code, totp(base32Encode(s1), { at: listed.at }).code);
  assert.equal(h.next, totp(base32Encode(s1), { at: listed.at + h.remaining * 1000 }).code);
  assert.ok(Math.abs(listed.at - now) < 5000);
  assert.deepEqual((await run("vault.codes", { names: ["github-alex"] })).codes.map(c => c.name), ["github-alex"]);
  const one = await run("vault.totp", { name: "github-alex" });
  assert.match(one.next, /^\d{6}$/);

  const said = JSON.stringify([pre, preview, done, listed, events, db.prepare("SELECT * FROM vault_audit").all(), await run("vault.list", {})]);
  for (const s of [s1, s2, s3]) {
    assert.ok(!said.includes(base32Encode(s)), "a seed leaked");
    assert.ok(!said.includes(s.toString("base64")), "a seed leaked");
  }
});
