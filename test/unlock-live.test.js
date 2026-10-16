// @ts-check
// The lock screen's tools on a real daemon, through the production path, as the app calls them (apps/app/screens/unlock/real.js): an identity made on the device is locked after a restart
// until its master password (or its recovery key) opens it; a wrong password is refused with the code the screen words; Lock now forgets the keys; a model's call cannot unlock.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_TEST_MASTER_KDF = "cheap";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const PASSWORD = "correct horse battery";
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

async function directory() {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((res, rej) => { child.stdout.on("data", (d) => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", (c) => rej(new Error(`the stand-in exited early (${c})`))); });
  return { base: `http://127.0.0.1:${port}`, close: () => child.kill("SIGTERM") };
}

test("an identity is locked after a restart, the wrong password is refused, and the right one or the recovery key opens it", { timeout: 120000 }, async (t) => {
  const dir = await directory();
  t.after(() => dir.close());
  let stop = async () => {};
  const root = tempHome(t, { stop: () => stop() });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ machine: "server", name: "unlock-box", transcripts: [], vault: { keystore: "file" }, names: { directory: dir.base }, modules: { disable: ["recall", "memory", "learn"] } }));
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "walk\n");
  const boot = async () => {
    const d = await start({ root, kernel: true, log: () => {} });
    stop = () => d.stop();
    return d;
  };
  let d = await boot();
  const call = (/** @type {string} */ tool, input = {}) => d.registry.call(tool, input, "cli");

  const made = await call("identity.create", { username: "alex", password: PASSWORD });
  assert.ok(!made.error, JSON.stringify(made.error));
  const recoveryKey = made.data.recoveryKey;
  assert.ok(recoveryKey, "the person's own call is shown the recovery key once");
  assert.equal((await call("identity.status")).data.unlocked, true, "just made, it is open");

  // Lock now: the keys are forgotten and the screen's next read says locked.
  assert.equal((await call("identity.lock")).data.locked, true);
  const locked = await call("identity.status");
  assert.deepEqual([locked.data.exists, locked.data.unlocked, locked.data.needsMigration], [true, false, false]);

  // A restart is the same: the identity is there and shut.
  await stop();
  d = await boot();
  const after = await call("identity.status");
  assert.deepEqual([after.data.exists, after.data.unlocked, after.data.username], [true, false, "alex"]);

  const wrong = await call("identity.unlock", { password: "not the password at all" });
  assert.equal(wrong.error && wrong.error.code, "bad_password", JSON.stringify(wrong));
  assert.equal((await call("identity.status")).data.unlocked, false, "a refused password opens nothing");

  const opened = await call("identity.unlock", { password: PASSWORD });
  assert.ok(!opened.error, JSON.stringify(opened.error));
  assert.equal(opened.data.unlocked, true);
  assert.equal((await call("identity.status")).data.unlocked, true);
  const vault = await call("identity.vault.install", {});
  assert.ok(!vault.error, `the vault takes the unlocked key: ${JSON.stringify(vault.error)}`);

  // The recovery key opens it as well, from locked.
  await call("identity.lock");
  const badKey = await call("identity.unlock", { recovery: "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA" });
  assert.ok(badKey.error, "a key that is not this identity's is refused");
  const byKey = await call("identity.unlock", { recovery: recoveryKey });
  assert.ok(!byKey.error, JSON.stringify(byKey.error));
  assert.equal((await call("identity.status")).data.unlocked, true);
});

test("a model cannot supply the password that unlocks", { timeout: 120000 }, async (t) => {
  const dir = await directory();
  t.after(() => dir.close());
  let stop = async () => {};
  const root = tempHome(t, { stop: () => stop() });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ machine: "server", name: "model-box", transcripts: [], vault: { keystore: "file" }, names: { directory: dir.base }, modules: { disable: ["recall", "memory", "learn"] } }));
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "walk\n");
  const d = await start({ root, kernel: true, log: () => {} });
  stop = () => d.stop();
  const person = await d.registry.call("identity.create", { username: "blair", password: PASSWORD }, "cli");
  assert.ok(!person.error, JSON.stringify(person.error));
  await d.registry.call("identity.lock", {}, "cli");
  const asModel = await d.registry.call("identity.unlock", { password: PASSWORD }, "mcp");
  assert.ok(asModel.error, "a model's call is refused");
  assert.equal((await d.registry.call("identity.status", {}, "cli")).data.unlocked, false, "and nothing was opened");
});
