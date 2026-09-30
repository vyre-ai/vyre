// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { csr } from "./csr.js";
import { SCRATCH } from "../../test/scratch.mjs";

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

const key = () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;

test("csr: DER starts as a SEQUENCE and carries every name", () => {
  const der = csr(["box1.example.test", "alt.example.test"], key());
  assert.equal(der[0], 0x30);
  const s = der.toString("latin1");
  assert.ok(s.includes("box1.example.test"));
  assert.ok(s.includes("alt.example.test"));
});

test("csr: openssl parses it, verifies the signature and sees the SANs", { skip: !hasOpenssl && "openssl is not on PATH" }, t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-csr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "req.der");
  fs.writeFileSync(file, csr(["box1.example.test", "alt.example.test"], key()));
  const out = execFileSync("openssl", ["req", "-inform", "DER", "-in", file, "-noout", "-text", "-verify"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /CN\s*=\s*box1\.example\.test/);
  assert.match(out, /DNS:box1\.example\.test, DNS:alt\.example\.test/);
  assert.match(out, /ecdsa-with-SHA256/);
});

test("csr: a long first name leaves the subject empty but keeps the SAN", { skip: !hasOpenssl && "openssl is not on PATH" }, t => {
  const long = "a".repeat(60) + ".example.test";
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-csr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "req.der");
  fs.writeFileSync(file, csr([long], key()));
  const out = execFileSync("openssl", ["req", "-inform", "DER", "-in", file, "-noout", "-text", "-verify"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(out.includes("DNS:" + long));
});

test("csr: refuses no names, junk names and non-EC keys", () => {
  assert.throws(() => csr([], key()), /at least one/);
  assert.throws(() => csr(["bad name"], key()), /not a DNS name/);
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
  assert.throws(() => csr(["a.example.test"], rsa), /EC key/);
});
