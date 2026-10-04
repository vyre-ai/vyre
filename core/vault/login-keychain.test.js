// @ts-check
// The login keychain belongs to ~/.vyre. A dev world, demo or stress run points VYRE_HOME at a
// temp folder and runs a real vyred outside node --test, where the test guard does not apply;
// one of those left vyre-vault items in the person's login keychain and raised dialogs on their
// Mac. Here a vyred runs the same way (NODE_TEST_CONTEXT removed) with a fake `security` first
// on PATH that records every call, and the vault must use the file keystore and never call it.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import * as config from "../config/index.js";
import { isRealHome, realHome, dialogsAllowed } from "../config/dialogs.js";

const REPO = path.resolve(import.meta.dirname, "..", "..");

/** A folder of fake `security` and `osascript` that append their argv to calls.log and fail. */
function fakeBins(dir) {
  const bin = path.join(dir, "fakebin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, "calls.log");
  for (const name of ["security", "osascript"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  }
  return { bin, log };
}

/** The environment of a dev world: no test context, the fakes first on PATH. */
function worldEnv(home, bin) {
  const env = { ...process.env, VYRE_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.NODE_TEST_CONTEXT; delete env.VYRE_TEST_DIALOGS; delete env.VYRE_NO_DIALOGS;
  return env;
}

const calls = log => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");

test("dialogs: a VYRE_HOME other than ~/.vyre never raises one", () => {
  assert.equal(dialogsAllowed({ VYRE_HOME: "/tmp/vy-deck-x" }), false);
  assert.equal(dialogsAllowed({ VYRE_HOME: realHome() }), true);
  assert.equal(dialogsAllowed({}), true, "no VYRE_HOME is ~/.vyre");
  assert.equal(isRealHome(realHome()), true);
  assert.equal(isRealHome("/tmp/vy-deck-x"), false);
});

test("dialogs: VYRE_ALLOW_DIALOGS=1 opens a custom home, never under tests, and VYRE_NO_DIALOGS wins", () => {
  const custom = { VYRE_HOME: "/Users/alex/vyre-home", VYRE_ALLOW_DIALOGS: "1" };
  assert.equal(dialogsAllowed(custom), true, "a deliberate custom home may raise one");
  assert.equal(dialogsAllowed({ ...custom, NODE_TEST_CONTEXT: "child" }), false, "never under tests");
  assert.equal(dialogsAllowed({ ...custom, VYRE_NO_DIALOGS: "1" }), false, "VYRE_NO_DIALOGS wins");
  assert.equal(dialogsAllowed({ VYRE_HOME: "/Users/alex/vyre-home", VYRE_ALLOW_DIALOGS: "yes" }), false, "only the exact value 1");
});

test("a temp home's vyred outside tests keeps its vault key in a file and never runs security", { timeout: 60_000 }, async t => {
  const home = tempHome(t);
  const { bin, log } = fakeBins(home);
  const p = config.ensure(home);
  fs.writeFileSync(p.config, JSON.stringify({ transcripts: [], roots: [], recall: { vectors: false, download: false }, modules: { disable: ["capsule", "hands"] } }));
  const out = fs.openSync(path.join(p.logs, "vyred.out"), "a");
  // vyred-present is the daemon stress-drive runs (a person at every call), which made a key in
  // the login keychain before this fix. Its keystore does not depend on VYRE_NO_DIALOGS.
  const child = spawn(process.execPath, [path.join(REPO, "test", "fixtures", "vyred-present.js")], { env: worldEnv(home, bin), stdio: ["ignore", out, out] });
  t.after(() => { try { child.kill("SIGTERM"); } catch {} });
  const { ping } = await import("../daemon/index.js");
  const { call } = await import("../daemon/client.js");
  for (let i = 0; i < 150 && !(await ping(p.socket)); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(await ping(p.socket), "vyred came up");

  const put = await call("vault.put", { name: "northwind-ads", kind: "api-key", fields: { value: "fixture-value" } }, { root: home, caller: "cli" });
  assert.ok(!put.error, JSON.stringify(put.error));
  assert.ok(fs.existsSync(path.join(p.vault, "key")), "the key is in the file keystore");
  const helpers = path.join(p.vault, "helpers");
  const built = fs.existsSync(helpers) ? fs.readdirSync(helpers).filter(n => n.startsWith("vyre-vault-keychain")) : [];
  assert.deepEqual(built, [], "no keychain helper was built");
  assert.equal(calls(log), "", "nothing ran security or osascript");
});

test("a temp home that asks for the keychain keystore is refused, not written to the login keychain", { timeout: 30_000 }, async t => {
  const home = tempHome(t);
  const { bin, log } = fakeBins(home);
  const script = `
    const { DatabaseSync } = await import("node:sqlite");
    const { Vault } = await import(${JSON.stringify(path.join(REPO, "core", "vault", "vault.js"))});
    const { dialogsAllowed } = await import(${JSON.stringify(path.join(REPO, "core", "config", "dialogs.js"))});
    const db = new DatabaseSync(":memory:");
    const make = vault => new Vault({ db, dir: ${JSON.stringify(path.join(home, "vault"))}, config: { vault }, emit: () => {} });
    const asked = make({ keystore: "keychain" });
    let refused = "";
    try { await asked.key(); } catch (e) { refused = e.message; }
    console.log(JSON.stringify({ dialogs: dialogsAllowed(), defaultKind: make({}).kind, optIn: make({ keychain: true }).kind, refused }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: worldEnv(home, bin), encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  assert.equal(o.dialogs, false, "dialogs are off for a temp home");
  assert.equal(o.defaultKind, "file", "a temp home defaults to the file keystore");
  if (process.platform === "darwin") assert.equal(o.optIn, "keychain", "vault.keychain: true opts in");
  assert.match(o.refused, /login keychain is only for ~\/\.vyre/);
  assert.equal(calls(log), "", "nothing ran security");
});

test("every dev world and demo script passes VYRE_NO_DIALOGS and the file keystore", () => {
  for (const f of ["deck/test/world.js", "deck/test/vault-shots.js"]) {
    const src = fs.readFileSync(path.join(REPO, f), "utf8");
    assert.match(src, /VYRE_NO_DIALOGS: "1"/, `${f} sets VYRE_NO_DIALOGS`);
    assert.match(src, /keystore: "file"/, `${f} uses the file keystore`);
  }
  const present = fs.readFileSync(path.join(REPO, "test/fixtures/vyred-present.js"), "utf8");
  assert.match(present, /VYRE_NO_DIALOGS = "1"/);
  const check = fs.readFileSync(path.join(REPO, "scripts/release-check.sh"), "utf8");
  assert.match(check, /VYRE_NO_DIALOGS=1/);
  assert.match(check, /"keystore":"file"/);
});
