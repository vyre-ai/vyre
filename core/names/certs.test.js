// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { load, save, accountKey } from "./certs.js";
import { tempHome } from "../../test/helpers.js";

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

function selfSigned(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-certs-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-subj", "/CN=box1.example.test", "-days", String(days)], { stdio: "ignore" });
    return { cert: fs.readFileSync(path.join(dir, "c.pem"), "utf8"), key: fs.readFileSync(path.join(dir, "k.pem"), "utf8") };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const mode = p => fs.statSync(p).mode & 0o777;

test("certs: load is null when nothing is stored", t => {
  const dir = path.join(tempHome(t), "certs");
  assert.equal(load(dir, "box1.example.test"), null);
});

test("certs: save then load round-trips at 0600 with no temp files left", { skip: !hasOpenssl && "openssl is needed to make a certificate" }, t => {
  const dir = path.join(tempHome(t), "certs");
  const pair = selfSigned(90);
  save(dir, "box1.example.test", pair);
  const got = load(dir, "box1.example.test");
  assert.equal(got?.cert, pair.cert);
  assert.equal(got?.key, pair.key);
  assert.ok(Math.abs((got?.expires || 0) - (Date.now() + 90 * 86400000)) < 2 * 86400000);
  assert.equal(mode(path.join(dir, "box1.example.test.crt")), 0o600);
  assert.equal(mode(path.join(dir, "box1.example.test.key")), 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["box1.example.test.crt", "box1.example.test.key"]);
  const next = selfSigned(30);
  save(dir, "box1.example.test", next);
  assert.equal(load(dir, "box1.example.test")?.cert, next.cert, "a renewal replaces the old certificate");
});

test("certs: refuses names that would escape the folder, and non-certificates", t => {
  const dir = path.join(tempHome(t), "certs");
  assert.throws(() => load(dir, "../etc"), /not a certificate name/);
  assert.throws(() => save(dir, "a/b", { cert: "x", key: "y" }), /not a certificate name|no certificate/);
  assert.throws(() => save(dir, "box1", { cert: "not a cert", key: "y" }), /no certificate/);
  assert.equal(fs.existsSync(path.join(dir, "box1.key")), false);
});

test("certs: accountKey creates once at 0600 and then reuses, per directory", t => {
  const dir = path.join(tempHome(t), "certs");
  const a = accountKey(dir, "staging");
  assert.equal(crypto.createPrivateKey(a).asymmetricKeyType, "ec");
  assert.equal(mode(path.join(dir, "acme-staging.key")), 0o600);
  assert.equal(accountKey(dir, "staging"), a);
  assert.notEqual(accountKey(dir, "production"), a);
  // @ts-expect-error an unknown directory
  assert.throws(() => accountKey(dir, "other"), /unknown ACME directory/);
});
