// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keystore, defaultKind, accountFor, keychainWriteCommand } from "./keys.js";

/** @param {import("node:test").TestContext} t */
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-vault-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("keys: default keystore is the keychain on macOS, a file elsewhere", () => {
  assert.equal(defaultKind("darwin"), "keychain");
  assert.equal(defaultKind("linux"), "file");
});

test("keys: the keychain account is 16 hex chars of the resolved folder", () => {
  assert.match(accountFor("/a/b"), /^[0-9a-f]{16}$/);
  assert.equal(accountFor("/a/b"), accountFor("/a/./b"));
  assert.notEqual(accountFor("/a/b"), accountFor("/a/c"));
});

test("keys: the keychain write puts the key on stdin, never on argv", () => {
  const hex = crypto.randomBytes(32).toString("hex");
  const { argv, stdin } = keychainWriteCommand({ account: "acct", hex, keychain: "/tmp/x.keychain-db" });
  assert.deepEqual(argv, ["-i"]);
  for (const a of argv) assert.ok(!a.includes(hex), "the key is on argv");
  assert.ok(stdin.includes(hex));
  assert.ok(stdin.trimEnd().endsWith('"/tmp/x.keychain-db"'), "the keychain is not the trailing argument");
});

test("keys: file keystore round-trips and refuses a second create", async t => {
  const dir = path.join(tmp(t), "vault");
  const ks = keystore({ dir, kind: "file" });
  assert.equal(await ks.exists(), false);
  assert.equal(await ks.load(), null);
  const mk = await ks.create();
  assert.equal(mk.length, 32);
  assert.equal(await ks.exists(), true);
  assert.deepEqual(await ks.load(), mk);
  assert.equal(fs.statSync(path.join(dir, "key")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  await assert.rejects(ks.create(), /already exists/);
  await ks.destroy();
  assert.equal(await ks.exists(), false);
});

test("keys: file keystore refuses a key others can read", async t => {
  const dir = tmp(t);
  const ks = keystore({ dir, kind: "file" });
  await ks.create();
  fs.chmodSync(path.join(dir, "key"), 0o644);
  await assert.rejects(ks.load(), /can be read by other users/);
});

test("keys: passphrase keystore is locked without one and refuses a wrong one", async t => {
  const dir = tmp(t);
  const ks = keystore({ dir, kind: "passphrase" });
  await assert.rejects(ks.create(), /needs a passphrase/);
  const mk = await ks.create({ passphrase: "correct horse" });
  assert.equal(fs.statSync(path.join(dir, "key.wrapped")).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(dir, "key.wrapped"), "utf8").includes(mk.toString("hex")));
  assert.equal(await ks.load(), null);
  assert.deepEqual(await ks.load({ passphrase: "correct horse" }), mk);
  await assert.rejects(ks.load({ passphrase: "wrong" }), /does not open this vault/);
  await assert.rejects(ks.create({ passphrase: "x" }), /already exists/);
});

test("keys: unknown keystore kind is refused", () => {
  // @ts-expect-error testing a bad kind
  assert.throws(() => keystore({ dir: "/nowhere", kind: "cloud" }), /unknown vault keystore/);
});

test("keys: keychain keystore round-trips in a temporary keychain", { skip: process.platform !== "darwin" && "macOS only" }, async t => {
  // Not tmp(t): the keychain has to be deleted before its folder is, in one hook.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-vault-"));
  const keychain = path.join(dir, "t.keychain-db");
  const pw = crypto.randomBytes(16).toString("hex");
  const listKeychains = () => execFileSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" });
  const parse = s => s.split("\n").map(l => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const before = listKeychains();
  execFileSync("security", ["create-keychain", "-p", pw, keychain]);
  t.after(() => {
    try { execFileSync("security", ["delete-keychain", keychain], { stdio: "pipe" }); } catch {}
    if (listKeychains() !== before) execFileSync("security", ["list-keychains", "-d", "user", "-s", ...parse(before)]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  if (listKeychains() !== before) execFileSync("security", ["list-keychains", "-d", "user", "-s", ...parse(before)]);
  execFileSync("security", ["unlock-keychain", "-p", pw, keychain]);

  const ks = keystore({ dir: path.join(dir, "vault"), kind: "keychain", keychain });
  assert.equal(await ks.exists(), false);
  assert.equal(await ks.load(), null);
  const mk = await ks.create();
  assert.equal(mk.length, 32);
  assert.equal(await ks.exists(), true);
  assert.deepEqual(await ks.load(), mk);
  await assert.rejects(ks.create(), /already has a key/);
  // A second vault folder gets its own entry.
  const other = keystore({ dir: path.join(dir, "vault2"), kind: "keychain", keychain });
  assert.equal(await other.load(), null);
  await ks.destroy();
  assert.equal(await ks.exists(), false);
  await ks.destroy();
  assert.equal(listKeychains(), before, "the keychain search list changed");
});
