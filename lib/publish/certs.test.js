// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { ensureSpaceCert, certNames } from "./certs.js";
import { tempHome } from "../../test/helpers.js";

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const selfSigned = (/** @type {string} */ dir) => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-subj", "/CN=harlow.vyre.run", "-days", "90"], { stdio: "ignore" });
  return { cert: fs.readFileSync(path.join(dir, "c.pem"), "utf8"), key: fs.readFileSync(path.join(dir, "k.pem"), "utf8") };
};

test("the Space's certificate is made by DNS-01 through signed directory acts: the CAA pin comes before the order, only the space's own challenge label is written, and it is cleared", { skip: !hasOpenssl }, async t => {
  const dir = tempHome(t);
  const made = selfSigned(dir);
  /** @type {string[]} */ const calls = [];
  const client = {
    acme: async (/** @type {string} */ n, /** @type {string} */ tok, /** @type {any} */ signer) => { calls.push(`acme ${n} ${tok} by ${signer.by}`); },
    acmeClear: async (/** @type {string} */ n, /** @type {any} */ signer) => { calls.push(`clear ${n} by ${signer.by}`); },
    caa: async (/** @type {string} */ n, /** @type {string} */ uri, /** @type {any} */ signer) => { calls.push(`caa ${n} ${uri} by ${signer.by}`); },
  };
  const signer = { by: "entry1", sign: async () => new Uint8Array(64) };
  /** @type {any} */ let seen;
  const issue = async (/** @type {any} */ o) => {
    seen = o;
    calls.push("account");
    await o.onAccount("https://acme.test/acct/42");
    calls.push("order");
    await o.dns.set("_acme-challenge.harlow.vyre.run", "a".repeat(43));
    await assert.rejects(() => o.dns.set("_acme-challenge.alex.vyre.run", "b".repeat(43)), /not for this space/);
    await assert.rejects(() => o.dns.set("_acme-challenge.www.harlow.vyre.run", "b".repeat(43)), /not for this space/);
    await o.dns.clear();
    return { ...made, expires: Date.now() + 90 * 86400000, accountUri: "https://acme.test/acct/42" };
  };
  const certs = path.join(dir, "certs");
  const r = await ensureSpaceCert({ name: "harlow.vyre.run", certsDir: certs, signer, client, issue: /** @type {any} */ (issue), directory: "https://acme.test/directory" });
  assert.equal(r.renewed, true);
  assert.deepEqual(seen.names, certNames("harlow.vyre.run"));
  assert.deepEqual(seen.names, ["harlow.vyre.run", "*.harlow.vyre.run"]);
  assert.deepEqual(calls, ["account", "caa harlow.vyre.run https://acme.test/acct/42 by entry1", "order", `acme harlow.vyre.run ${"a".repeat(43)} by entry1`, "clear harlow.vyre.run by entry1"], "the pin is set before the order; one challenge; cleared");
  assert.ok(fs.existsSync(path.join(certs, "edge.crt")) && fs.existsSync(path.join(certs, "edge.key")));
  assert.equal(fs.statSync(path.join(certs, "edge.key")).mode & 0o077, 0, "the key is private");
  // a second call with a good certificate does nothing; a different space name issues again
  calls.length = 0;
  assert.equal((await ensureSpaceCert({ name: "harlow.vyre.run", certsDir: certs, signer, client, issue: /** @type {any} */ (issue), directory: "https://acme.test/directory" })).renewed, false);
  assert.deepEqual(calls, []);
  const again = async () => ({ ...made, expires: Date.now() + 90 * 86400000, accountUri: "https://acme.test/acct/42" });
  assert.equal((await ensureSpaceCert({ name: "northwind.vyre.run", certsDir: certs, signer, client, issue: /** @type {any} */ (again), directory: "https://acme.test/directory" })).renewed, true);
  void crypto;
});
