// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "../vault/vault.js";
import { installHeldKey } from "../vault/master-root.js";
import identity from "./index.js";
import spaces from "../spaces/index.js";
import { fileIdentityStore, newKeyPair } from "../spaces/identity.js";
import { spaceFiles } from "../spaces/host.js";
import { createMaster, TEST_KDF, unlockMaster } from "../../kernel/identity/master.js";
import { newRecoveryCode } from "../../kernel/identity/code.js";
import { clearPersonal, forgetAll, holdPersonal } from "../../kernel/identity/holder.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_TEST_MASTER_KDF = "cheap";

test("identity.vault.install opens the running vault from the held key and returns only public keys", async (t) => {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  t.after(() => { forgetAll(); try { db.close(); } catch { /* closed */ } });
  const vault = new Vault({ db, dir: path.join(root, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  await vault.put({ name: "northwind", kind: "secret", fields: { value: "bake-2" } }, "cli");
  const raw = Buffer.from(fs.readFileSync(path.join(root, "vault", "key"), "utf8").trim(), "hex");
  const openVk = vault.vk;
  const store = fileIdentityStore(path.join(root, "spaces"));
  const madeId = await store.generate();
  store.setName("alex");
  const st = store.status();
  const idPath = path.join(root, "spaces", "identity.json");
  const idFile = JSON.parse(fs.readFileSync(idPath, "utf8"));
  const recovery = newRecoveryCode();
  createMaster({
    root, username: "alex", id: st.id, password: "correct horse battery", recoveryCode: recovery,
    privateKeyB64: idFile.privateKey, agreePrivateB64: idFile.agreePrivate || null,
    vaultKey: Buffer.from(raw), kdf: TEST_KDF, identityFile: idPath,
  });
  fs.writeFileSync(path.join(root, "vault", "key"), `${raw.toString("hex")}\n`, { mode: 0o600 });
  const files = spaceFiles(path.join(root, "spaces"));
  const kp = newKeyPair();
  await files.keys.hold("spc_juniper", kp.privateKey);

  const tools = new Map();
  /** @type {string[]} */
  const calls = [];
  await identity.start({
    paths: { root },
    store: { db, migrate(steps) { migrate(db, "identity", steps); } },
    tool(name, def) { tools.set(name, def); },
    call: async (name, input) => {
      calls.push(name);
      if (name === "vault.master.install") return { data: await installHeldKey(vault) };
      if (name === "spaces.identity.self") return { data: { id: st.id, name: "alex" } };
      if (name === "spaces.identity.device") return { data: { deviceId: st.eid, deviceKey: st.publicKey } };
      if (name === "spaces.identity.published-key") {
        let k = null;
        try { k = files.keys.load(String(input.space || "")); } catch { k = null; }
        if (!k || !k.publicKey) return { error: { code: "not_found", message: "This space has no published key on this device yet." } };
        return { data: { space: String(input.space), pub: k.publicKey } };
      }
      return { error: { code: "failed", message: "not used" } };
    },
  });

  await assert.rejects(
    () => tools.get("identity.vault.install").run({ password: "correct horse battery", space: "spc_juniper" }, { caller: "mcp" }),
    (e) => /** @type {any} */ (e).code === "secret_refused",
  );
  assert.equal(calls.length, 0, "a password from an agent never reaches the vault");
  const cli = await tools.get("identity.vault.install").run({ space: "spc_juniper", key: raw.toString("hex") }, { caller: "cli" });
  assert.deepEqual(Object.keys(cli).sort(), ["deviceKey", "id", "installed", "plaintext", "space"]);
  assert.equal(cli.installed, true);
  assert.equal(cli.plaintext, false);
  assert.equal(cli.id, st.id);
  assert.equal(cli.deviceKey, st.publicKey);
  assert.deepEqual(cli.space, { id: "spc_juniper", pub: kp.publicKey });
  assert.equal(JSON.stringify(cli).includes(raw.toString("hex")), false);
  assert.equal(JSON.stringify(cli).includes(idFile.privateKey), false);
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false);
  assert.equal(vault.vk, openVk);
  const row = /** @type {any} */ (vault.db.prepare("SELECT * FROM vault_items WHERE name = ?").get("northwind"));
  assert.equal((await vault.open(row)).fields.value, "bake-2");
  assert.ok(calls.includes("vault.master.install"));
  assert.ok(calls.includes("spaces.identity.published-key"));
  const none = await tools.get("identity.vault.install").run({}, { caller: "mcp" });
  assert.equal(none.space, null);
  assert.equal(none.deviceKey, st.publicKey);
  assert.equal(JSON.stringify(none).includes(raw.toString("hex")), false);
  await assert.rejects(
    () => tools.get("identity.vault.install").run({ space: "spc_missing" }, { caller: "cli" }),
    (e) => /** @type {any} */ (e).code === "not_found",
  );
  await tools.get("identity.lock").run({}, { caller: "cli" });
  const confirmed = await tools.get("identity.unlock").run({ recovery, confirm: true }, { caller: "cli" });
  assert.equal(confirmed.unlocked, true);
  await assert.rejects(
    () => tools.get("identity.vault.install").run({}, { caller: "cli" }),
    (e) => /** @type {any} */ (e).code === "locked" && /Unlock this identity/.test(/** @type {any} */ (e).message),
  );
  unlockMaster({ root, password: "correct horse battery", identityFile: idPath });
  clearPersonal();
  holdPersonal(crypto.randomBytes(32));
  fs.writeFileSync(path.join(root, "vault", "key"), `${"cd".repeat(32)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => tools.get("identity.vault.install").run({}, { caller: "cli" }),
    (e) => /** @type {any} */ (e).code === "locked",
  );
  assert.equal(vault.vk, openVk);
  assert.equal(fs.readFileSync(path.join(root, "vault", "key"), "utf8").trim(), "cd".repeat(32));
  assert.equal(madeId.id, st.id);
});

test("spaces.identity.published-key returns the space root public key and nothing private", async (t) => {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db"));
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  const tools = new Map();
  const started = await spaces.start({
    paths: { root },
    config: { names: { directory: "http://127.0.0.1:1" } },
    store: { db, migrate(steps) { migrate(db, "spaces", steps); } },
    events: { emit() {} },
    log: { warn() {}, info() {} },
    tool(name, def) { tools.set(name, def); },
    call: async () => ({ error: { code: "failed", message: "not used" } }),
  });
  t.after(() => started.stop());
  const files = spaceFiles(path.join(root, "spaces"));
  const kp = newKeyPair();
  await files.keys.hold("spc_juniper", kp.privateKey);
  const pub = await tools.get("spaces.identity.published-key").run({ space: "spc_juniper" });
  assert.deepEqual(pub, { space: "spc_juniper", pub: kp.publicKey });
  assert.equal("sign" in pub, false);
  assert.equal(JSON.stringify(pub).includes(kp.privateKey), false);
  await assert.rejects(
    () => tools.get("spaces.identity.published-key").run({ space: "spc_missing" }),
    (e) => /** @type {any} */ (e).code === "not_found",
  );
  await assert.rejects(
    () => tools.get("spaces.identity.published-key").run({ space: "not-a-space" }),
    (e) => /** @type {any} */ (e).code === "not_found",
  );
});
