// @ts-check
// vault.import.preview and vault.import against a real vault in a temp home (ADR 0028,
// decision 1): duplicates by origin and username, conflicts skipped or updated as a new
// version, a token bound to the file, and no value in anything returned, audited or emitted.
// Every value here is a made-up sample.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recorded } from "./testing.js";

const sample = label => `sample-${label}-${crypto.randomBytes(8).toString("hex")}`;

test("import preview: same, conflict and rename, the token refuses a changed file, update keeps history, no value leaks", async t => {
  const { tmp, db, events, run } = await recorded(t);
  const pwNorthwind = sample("northwind"), pwHarlow = sample("harlow"), pwHarlowNew = sample("harlow-new"), pwKit = sample("kit"), pwLater = sample("later");
  const all = [pwNorthwind, pwHarlow, pwHarlowNew, pwKit, pwLater];

  await run("vault.put", { name: "northwind-bakery", kind: "login", fields: { username: "alex@northwind.test", password: pwNorthwind }, url: "https://orders.northwind.test/login" });
  await run("vault.put", { name: "harlow-legal", kind: "login", fields: { username: "juno", password: pwHarlow, totp: "JBSWY3DPEHPK3PXP" }, url: "https://portal.harlow.test" });

  const file = path.join(tmp, "Passwords.csv");
  const csv = "Title,URL,Username,Password,Notes,OTPAuth\n" +
    `Northwind Bakery,https://orders.northwind.test/account,ALEX@northwind.test,${pwNorthwind},,\n` +
    `Harlow Legal,https://portal.harlow.test/,juno,${pwHarlowNew},,\n` +
    `Harlow Legal,https://portal.harlow.test/,kit,${pwKit},,\n`;
  fs.writeFileSync(file, csv);

  const preview = await run("vault.import.preview", { file });
  assert.equal(preview.format, "apple-csv");
  assert.deepEqual(preview.counts, { login: 3, note: 0, card: 0, secret: 0, "api-key": 0, "env-set": 0 });
  assert.deepEqual(preview.same, ["northwind-bakery"]);
  assert.deepEqual(preview.conflicts, [{ name: "harlow-legal", existing: "harlow-legal" }]);
  // The kit row's name from the parser is "harlow-legal-kit"; nothing was taken, so no rename.
  assert.deepEqual(preview.add, ["harlow-legal-kit"]);
  assert.deepEqual(preview.renamed, []);
  assert.equal(typeof preview.token, "string");
  assert.ok(preview.token.length >= 40);
  // The token is not a hash of the file.
  assert.notEqual(preview.token, crypto.createHash("sha256").update(csv).digest("base64url"));
  assert.ok(!crypto.createHash("sha256").update(csv).digest("hex").startsWith(preview.token.slice(0, 8)));
  // The same file previews to the same token.
  assert.equal((await run("vault.import.preview", { file })).token, preview.token);

  // The file changes after the preview: the import is refused and nothing is added.
  fs.writeFileSync(file, csv + `Later,https://later.northwind.test,kit,${pwLater},,\n`);
  await assert.rejects(run("vault.import", { file, token: preview.token }), /the file changed since the preview; preview it again/);
  assert.equal((await run("vault.list", {})).items.length, 2);
  fs.writeFileSync(file, csv);

  // Default: the conflict is skipped.
  const skipped = await run("vault.import", { file, token: preview.token });
  assert.deepEqual(skipped.added, ["harlow-legal-kit"]);
  assert.deepEqual(skipped.updated, []);
  assert.deepEqual(skipped.same, ["northwind-bakery"]);
  assert.deepEqual(skipped.conflicts, ["harlow-legal"]);
  assert.deepEqual(skipped.duplicate, ["northwind-bakery", "harlow-legal"]);
  assert.match(skipped.advice, /Delete .*Passwords\.csv now/);
  assert.equal((await run("vault.history", { name: "harlow-legal" })).entries.length, 1);

  // Previewed again, the kit row is now the same, and a new row for another site is added.
  fs.writeFileSync(file, csv + `Harlow Legal Kit,https://files.harlow.test,kit,${pwLater},,\n`);
  const again = await run("vault.import.preview", { file });
  assert.deepEqual(again.same, ["northwind-bakery", "harlow-legal-kit"]);
  assert.deepEqual(again.conflicts, [{ name: "harlow-legal", existing: "harlow-legal" }]);
  assert.deepEqual(again.add, ["harlow-legal-kit-kit"]);
  fs.writeFileSync(file, csv);

  // update: the conflicting login gets a new version under its existing name, history keeps the old one.
  const token = (await run("vault.import.preview", { file })).token;
  const updated = await run("vault.import", { file, token, conflicts: "update" });
  assert.deepEqual(updated.updated, ["harlow-legal"]);
  assert.deepEqual(updated.conflicts, []);
  assert.deepEqual(updated.added, []);
  const hist = await run("vault.history", { name: "harlow-legal" });
  assert.equal(hist.entries.length, 2);
  assert.ok(hist.entries[0].changed.includes("password"));
  assert.equal(hist.passwords.length, 1);
  assert.equal((await run("vault.list", {})).items.find(i => i.name === "harlow-legal").fields.includes("totp"), true, "fields the file lacks are kept");
  // Now the file matches: a fresh preview finds nothing to do.
  const done = await run("vault.import.preview", { file });
  assert.deepEqual(done.add, []);
  assert.deepEqual(done.conflicts, []);
  assert.equal(done.same.length, 3);

  await assert.rejects(run("vault.import", { file, conflicts: "overwrite" }), /skip.*update/);

  // No sample password in anything returned, audited or emitted.
  const audit = db.prepare("SELECT * FROM vault_audit").all();
  assert.ok(audit.some(r => r.action === "import" && /1 added/.test(String(r.why))));
  assert.ok(audit.some(r => r.action === "import-preview"));
  for (const r of audit.filter(r => String(r.action).startsWith("import"))) assert.ok(!String(r.why).includes("Passwords.csv"), "the audit row carries counts only");
  const seen = JSON.stringify([preview, again, done, skipped, updated, audit, events, await run("vault.list", {}), await run("vault.audit", {})]);
  for (const v of all) assert.ok(!seen.includes(v), "a sample password leaked");
});

test("import preview: a rename within the batch and against the vault", async t => {
  const { tmp, run } = await recorded(t);
  await run("vault.put", { name: "northwind-bakery", kind: "note", fields: { text: "sample note" } });
  const file = path.join(tmp, "export.csv");
  fs.writeFileSync(file, "Title,URL,Username,Password,Notes,OTPAuth\n" +
    `Northwind Bakery,https://orders.northwind.test,alex,${sample("a")},,\n` +
    `Northwind Bakery 2,https://shop.northwind.test,alex,${sample("b")},,\n`);
  const p = await run("vault.import.preview", { file });
  assert.deepEqual(p.renamed, [{ from: "northwind-bakery", to: "northwind-bakery-3" }]);
  assert.deepEqual(p.add, ["northwind-bakery-3", "northwind-bakery-2"]);
  const r = await run("vault.import", { file, token: p.token });
  assert.deepEqual(r.added, ["northwind-bakery-3", "northwind-bakery-2"]);
  assert.deepEqual(r.renamed, p.renamed);
});

test("import preview: a locked personal vault is refused with the unlock words", async t => {
  const { tmp, run } = await recorded(t);
  await run("vault.put", { name: "northwind-bakery", kind: "login", fields: { username: "alex", password: sample("pw") }, url: "https://orders.northwind.test" });
  await run("vault.account.create", { password: sample("account-password") });
  await run("vault.account.lock", {});
  const file = path.join(tmp, "export.csv");
  fs.writeFileSync(file, `Title,URL,Username,Password,Notes,OTPAuth\nKit,https://kit.northwind.test,kit,${sample("c")},,\n`);
  await assert.rejects(run("vault.import.preview", { file }), e => /** @type {any} */ (e).code === "locked" && /vyre vault account unlock/.test(e.message));
  await assert.rejects(run("vault.import", { file }), /locked/);
});
