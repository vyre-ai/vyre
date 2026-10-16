// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, migrate as migrateDb } from "../store/index.js";
import identity from "./index.js";
import devices from "../devices/index.js";
import { fileIdentityStore } from "../spaces/identity.js";
import { forgetAll, identityHeld } from "../../kernel/identity/holder.js";
import { readMaster } from "../../kernel/identity/master.js";
import { dialLive } from "../devices/live.js";

process.env.VYRE_TEST_MASTER_KDF = "cheap";

test("an agent cannot supply the master password, and a migration strips the plaintext key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-idmod-"));
  const db = open(path.join(root, "vyre.db"));
  const tools = new Map();
  const ctx = {
    paths: { root },
    store: { db, migrate(steps) { migrateDb(db, "identity", steps); } },
    tool(name, def) { tools.set(name, def); },
    call: async () => ({ error: { code: "failed", message: "not used" } }),
  };
  await identity.start(ctx);
  const store = fileIdentityStore(path.join(root, "spaces"));
  await store.generate();
  store.setName("alex");
  await assert.rejects(() => tools.get("identity.migrate").run({ password: "correct horse battery" }, { caller: "mcp" }), (e) => e.code === "secret_refused");
  await assert.rejects(() => tools.get("identity.migrate").run({ password: "correct horse battery" }, { caller: "module:onboard", origin: "mcp" }), (e) => e.code === "secret_refused");
  assert.equal(identityHeld(path.join(root, "spaces", "identity.json")), false);
  const made = await tools.get("identity.migrate").run({ password: "correct horse battery" }, { caller: "module:onboard", origin: "cli" });
  assert.equal(made.recoveryKey.replace(/-/g, "").length, 26);
  const file = JSON.parse(fs.readFileSync(path.join(root, "spaces", "identity.json"), "utf8"));
  assert.equal(file.privateKey, undefined);
  assert.equal(file.sealed, true);
  await tools.get("identity.lock").run({}, { caller: "cli" });
  await assert.rejects(() => store.sign(Buffer.from("x")), (e) => e.code === "locked");
  await tools.get("identity.unlock").run({ password: "correct horse battery" }, { caller: "cli" });
  assert.equal((await store.sign(Buffer.from("x"))).length, 64);
  await tools.get("identity.github.link").run({ login: "alex-studio", subject: "gh_12345" }, { caller: "cli" });
  await tools.get("identity.lock").run({}, { caller: "cli" });
  const devTools = new Map();
  const dctx = {
    paths: { root },
    store: { db, migrate(steps) { migrateDb(db, "devices", steps); } },
    tool(name, def) { devTools.set(name, def); },
    dialServer: async () => ({ device: "aaaaaaaaaaaaaaaa", live: true }),
  };
  await devices.start(dctx);
  await assert.rejects(() => devTools.get("devices.signin").run({ server: "https://juniper.vyre.run", github: { login: "alex-studio", subject: "gh_12345" } }, { caller: "cli" }), (e) => e.code === "person_enters");
  assert.equal(identityHeld(path.join(root, "spaces", "identity.json")), false, "GitHub alone does not unwrap");
  const signed = await devTools.get("devices.signin").run({ server: "https://juniper.vyre.run", password: "correct horse battery", github: { login: "alex-studio", subject: "gh_12345" } }, { caller: "cli" });
  assert.equal(signed.ok, true);
  assert.equal(signed.unlocked, true);
  assert.equal(signed.live, true);
  assert.equal(signed.device, "aaaaaaaaaaaaaaaa");
  assert.equal(signed.carry.recoveryWrap, undefined);
  assert.equal(JSON.stringify(signed).includes(readMaster(root).recoveryWrap.ct), false);
  assert.equal(signed.username, "alex");
  forgetAll();
  db.close();
});

test("signing in does not succeed when this computer cannot find the space server", async () => {
  await assert.rejects(() => dialLive({ paths: { root: path.join(os.tmpdir(), "vyre-no-such-dial") }, config: {} }, { server: "https://juniper.vyre.run", username: "alex" }), (e) => e.code === "unreachable");
});
