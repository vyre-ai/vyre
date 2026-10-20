// A Vault field's name is case-insensitive (lib/env-name.js): a run asking for ghl_api_key gets GHL_API_KEY, byte-exact; an older item with two spellings of one name gives
// neither until the person renames one; vault.list says which Shared folder an item is in. Names and flags only: no value is in a listing.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { envName } from "./cli-io.js";
import { SCRATCH } from "../../test/scratch.mjs";

async function mk(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-fieldcase-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "juniper-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return v;
}

test("a field asked for in another case is found by its one form, and handed over byte-exact", async (t) => {
  const v = await mk(t);
  await v.put({ name: "GHL-Sales", kind: "env-set", fields: { GHL_API_KEY: "pit-1234 ", GHL_LOCATION_ID: "loc9" } }, "cli");
  const { env } = await v.inject({ items: [{ name: "GHL-Sales", field: "ghl_api_key", env: "KEY" }, { name: "GHL-Sales", field: "Ghl-Location-Id", env: "LOC" }] }, "cli", envName);
  assert.equal(env.KEY, "pit-1234 ", "the trailing space is the value's own");
  assert.equal(env.LOC, "loc9");
  const all = await v.inject({ items: [{ name: "GHL-Sales" }] }, "cli", envName);
  assert.deepEqual(Object.keys(all.env).sort(), ["GHL_API_KEY", "GHL_LOCATION_ID"], "an env-set gives every field under its own name");
});

test("an older item with two spellings of one name gives neither: the person renames one first", async (t) => {
  const v = await mk(t);
  await v.put({ name: "old-set", kind: "env-set", fields: { API_KEY: "a", api_key: "b" } }, "cli");
  const exact = await v.inject({ items: [{ name: "old-set", field: "api_key", env: "X" }] }, "cli", envName);
  assert.equal(exact.env.X, "b", "an exact name still answers");
  await assert.rejects(() => v.inject({ items: [{ name: "old-set", field: "Api-Key", env: "X" }] }, "cli", envName), /has no field Api-Key/);
});

test("vault.list says an item's Shared folder, never a value", async (t) => {
  const v = await mk(t);
  await v.put({ name: "Twilio", kind: "env-set", fields: { TWILIO_ACCOUNT_SID: "AC00", TWILIO_AUTH_TOKEN: "tok-secret-0000" } }, "cli");
  await v.put({ name: "GHL-Sales", kind: "env-set", fields: { GHL_API_KEY: "k" } }, "cli");
  const row = v.row("Twilio");
  v.db.prepare("UPDATE vault_items SET named = ? WHERE name = ?").run("vault_team", "Twilio");
  v.sign("vault_items", row.id);
  const items = v.list().items;
  const tw = items.find((i) => i.name === "Twilio"), ghl = items.find((i) => i.name === "GHL-Sales");
  assert.equal(tw.folder, "vault_team");
  assert.equal(ghl.folder, undefined, "an item in no folder is Mine for the owner");
  assert.ok(!JSON.stringify(items).includes("tok-secret-0000"));
});
