// @ts-check
// An item in a named vault stays there through the ordinary paths: putting it again, editing it, and rotating its value re-sign the row with the vault link in it, and the row still passes its check;
// a link set or cleared behind the vault's back fails it, so the item is not found under either address.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { SCRATCH } from "../../test/scratch.mjs";

async function mk(/** @type {import("node:test").TestContext} */ t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-named-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await v.put({ name: "stripe", kind: "api-key", fields: { value: "sk-one-0001" } }, "cli");
  const row = () => /** @type {any} */ (db.prepare("SELECT * FROM vault_items WHERE name = 'stripe'").get());
  const place = (/** @type {string | null} */ vid) => { db.prepare("UPDATE vault_items SET named = ? WHERE name = 'stripe'").run(vid); v.sign("vault_items", row().id); };
  return { v, db, row, place };
}

test("an item moved into a named vault stays there when it is put again, and the row still passes its check", async t => {
  const { v, row, place } = await mk(t);
  place("vault_acme");
  assert.equal(v.row("stripe")?.named, "vault_acme", "signed with the link: found");
  await v.put({ name: "stripe", kind: "api-key", fields: { value: "sk-two-0002" } }, "cli");
  assert.equal(row().named, "vault_acme", "a second put keeps the vault");
  assert.equal(v.row("stripe")?.named, "vault_acme", "and the row still passes");
});

test("a link set, changed or cleared behind the vault's back fails the row's check", async t => {
  const { v, db, place } = await mk(t);
  db.prepare("UPDATE vault_items SET named = 'vault_evil' WHERE name = 'stripe'").run();
  assert.equal(v.row("stripe"), undefined, "a link added to a row that was signed without one is refused");
  db.prepare("UPDATE vault_items SET named = NULL WHERE name = 'stripe'").run();
  assert.ok(v.row("stripe"), "back to how it was signed: found again");
  place("vault_acme");
  db.prepare("UPDATE vault_items SET named = 'vault_other' WHERE name = 'stripe'").run();
  assert.equal(v.row("stripe"), undefined, "a link changed to another vault is refused");
  db.prepare("UPDATE vault_items SET named = NULL WHERE name = 'stripe'").run();
  assert.equal(v.row("stripe"), undefined, "a link cleared is refused");
});
