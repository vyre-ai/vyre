// @ts-check
// `vyre vault account ...` end to end: a real vyred in a temp home, the password typed through
// piped stdin as a person would at the hidden prompt, Touch ID through the fake enclave helper
// (no dialog), and the Secret Key printed once and never written to a file in the home.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { upPresent } from "./helpers.js";
import { writeFakes } from "../core/vault/mac/fakes.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(REPO, "bin", "vyre");

function spawnIt(args, env, input) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("close", code => resolve({ code, out, err, all: out + err }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}
const vyre = (home, args, input) => spawnIt(args, { ...process.env, VYRE_HOME: home, NO_COLOR: "1" }, input);

/** Every file under a folder, as bytes. */
function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else if (e.isFile()) out.push([p, fs.readFileSync(p)]);
  }
  return out;
}

test("vault cli: account create, status, lock, unlock with the password and with Touch ID", async t => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-test-"));
  const fakes = writeFakes(path.join(h, "..", path.basename(h) + "-fakes"));
  t.after(async () => { await vyre(h, ["down"]); fs.rmSync(h, { recursive: true, force: true }); fs.rmSync(path.join(h, "..", path.basename(h) + "-fakes"), { recursive: true, force: true }); });
  fs.writeFileSync(path.join(h, "config.json"), JSON.stringify({ name: "owner-box", vault: { keystore: "file", testHelpers: { enclave: fakes.helpers.enclave } } }));
  assert.equal((await upPresent(h)).code, 0);
  const pw = `fixture-pw-${crypto.randomBytes(10).toString("hex")}`;
  const mail = `fixture-mail-${crypto.randomBytes(10).toString("hex")}`;
  assert.equal((await vyre(h, ["vault", "put", "mail", "--kind", "login", "--username", "alex@example.com"], mail)).code, 0);

  assert.match((await vyre(h, ["vault", "account", "status"])).out, /no account password yet/);
  const mismatch = await vyre(h, ["vault", "account", "create"], `${pw}\nsomething-else-entirely\n`);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.all, /did not match/);
  const short = await vyre(h, ["vault", "account", "create"], "short\nshort\n");
  assert.notEqual(short.code, 0);
  assert.match(short.all, /at least 12/);

  const made = await vyre(h, ["vault", "account", "create"], `${pw}\n${pw}\n`);
  assert.equal(made.code, 0, made.all);
  const sk = /Secret Key\s+(V2-[A-Z2-7-]+)/.exec(made.out)?.[1];
  assert.ok(sk, made.out);
  assert.match(made.out, /write this down or run vyre vault kit now/);
  assert.match(made.out, /1 item moved/);
  assert.ok(!made.all.includes(pw));

  const status = await vyre(h, ["vault", "account", "status", "--json"]);
  assert.deepEqual(JSON.parse(status.out.trim()).data, { account: true, unlocked: true, touchid: false, acct: sk.split("-")[1] });

  assert.equal((await vyre(h, ["vault", "account", "lock"])).code, 0);
  const locked = await vyre(h, ["vault", "read", "vault://mail/password"]);
  assert.equal(locked.code, 4, locked.all);
  assert.ok(!locked.all.includes(mail));

  const wrong = await vyre(h, ["vault", "account", "unlock", "--json"], "fixture-not-the-password\n");
  assert.equal(wrong.code, 1);
  assert.match(JSON.parse(wrong.out.trim()).error.message, /does not open/);
  const opened = await vyre(h, ["vault", "account", "unlock"], `${pw}\n`);
  assert.equal(opened.code, 0, opened.all);

  const tid = await vyre(h, ["vault", "account", "unlock", "--touchid"]);
  assert.match(tid.all, /not set up on this Mac/);
  const enrolled = await vyre(h, ["vault", "account", "enroll-touchid"], `${pw}\n`);
  assert.equal(enrolled.code, 0, enrolled.all);
  assert.equal((await vyre(h, ["vault", "account", "lock"])).code, 0);
  const viaTouch = await vyre(h, ["vault", "account", "unlock", "--touchid"]);
  assert.equal(viaTouch.code, 0, viaTouch.all);
  assert.match(viaTouch.out, /with Touch ID/);
  assert.match((await vyre(h, ["vault", "account", "status"])).out, /Touch ID\s+on/);

  // The Secret Key is in the home's secret-key file only (the file keystore's place for it),
  // and the password nowhere.
  for (const [file, bytes] of filesUnder(h)) {
    assert.ok(!bytes.includes(Buffer.from(pw)), `the password is in ${path.relative(h, file)}`);
    if (path.basename(file) !== "secret-key") assert.ok(!bytes.includes(Buffer.from(sk)), `the Secret Key is in ${path.relative(h, file)}`);
  }
});
