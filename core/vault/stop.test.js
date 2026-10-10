// @ts-check
// Stopping the vault settles what its timers started and writes nothing after. A sync the vault
// starts 200 ms after it starts used to make a key and an identity even with no shared vaults,
// and when that timer fired after a test had removed its home, it put vault/ back: a leaked temp
// home holding only vault/key, vault/state.json, vault/vaults/agents.json and items/identity.json.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { tempHome, present } from "../../test/helpers.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  return { root, d };
}

test("vault stop: a home removed and then stopped, as tempHome's cleanup does, stays removed", async t => {
  const { root, d } = await boot(t);
  fs.rmSync(root, { recursive: true, force: true });
  await d.stop();
  await sleep(500);
  assert.equal(fs.existsSync(root), false, `something wrote into the home after the vault stopped: ${fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).join(", ") : ""}`);
});

test("vault stop: with no shared vaults, the start-up sync makes no key", async t => {
  const { root, d } = await boot(t);
  t.after(() => d.stop());
  await sleep(500);
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false, "no key until something needs one");
  assert.equal(fs.existsSync(path.join(root, "vault", "items", "identity.json")), false);
});

test("vault stop: a waiting sync never runs, a running one is awaited, and no key is made after", async t => {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  t.after(() => { try { db.close(); } catch {} });
  const vault = new Vault({ db, dir: path.join(root, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  const ran = [];
  vault.later(async () => { ran.push("soon"); await sleep(300); ran.push("soon done"); }, 10);
  vault.later(async () => { ran.push("late"); }, 5_000);
  await sleep(50);
  await vault.stop();
  assert.deepEqual(ran, ["soon", "soon done"], "stop waited for the running one and cancelled the waiting one");
  await assert.rejects(vault.key(), /the vault is stopping/);
  vault.later(async () => { ran.push("after"); }, 1);
  await sleep(50);
  assert.deepEqual(ran, ["soon", "soon done"]);
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false);
});

test("vault stop: the connector list asks for no key when there is no api-credential item, so a home with none gets none", async t => {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  t.after(() => { try { db.close(); } catch {} });
  const vault = new Vault({ db, dir: path.join(root, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  assert.deepEqual(await vault.apiCredentialNames(), []);
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false, "asking which connectors there are made no key");
  await vault.stop();
});
