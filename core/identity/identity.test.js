// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, migrate as migrateDb } from "../store/index.js";
import identity from "./index.js";
import { fileIdentityStore } from "../spaces/identity.js";
import { forgetAll, identityHeld } from "../../kernel/identity/holder.js";
import { readMaster } from "../../kernel/identity/master.js";
import { vouch } from "../../lib/github-verified.js";

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
  // A login and an id typed into the tool have no receipt from GitHub and link nothing, whoever types them.
  for (const caller of ["cli", "mcp", "mcp:agent:kit", "module:onboard"]) {
    await assert.rejects(() => tools.get("identity.github.link").run({ login: "mallory", subject: "gh_66666" }, { caller }), (e) => e.code === "github_unverified", caller);
  }
  assert.equal(readMaster(root).github, null);
  vouch("alex-studio", "gh_12345");
  await tools.get("identity.github.link").run({ login: "alex-studio", subject: "gh_12345" }, { caller: "cli" });
  assert.equal(readMaster(root).github.login, "alex-studio");
  await assert.rejects(() => tools.get("identity.github.link").run({ login: "alex-studio", subject: "gh_12345" }, { caller: "cli" }), (e) => e.code === "github_unverified", "a receipt is spent once");
  await tools.get("identity.lock").run({}, { caller: "cli" });
  forgetAll();
  db.close();
});
