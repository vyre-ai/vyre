import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deviceKey } from "./devicekey.js";

test("a computer's device key: made once, kept 0600, offered as P-256 SPKI alg -7, and its signature verifies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-"));
  const file = path.join(dir, "k.json");
  const a = deviceKey(file), b = deviceKey(file);
  assert.equal(a.presenceKey.public_key, b.presenceKey.public_key, "the same key on the next start");
  assert.equal(a.presenceKey.alg, -7);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const pub = crypto.createPublicKey({ key: Buffer.from(a.presenceKey.public_key, "base64url"), format: "der", type: "spki" });
  assert.ok(crypto.verify("sha256", Buffer.from("paired-start\nx\ny"), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(a.sign("paired-start\nx\ny"), "base64url")));
  fs.rmSync(dir, { recursive: true, force: true });
});
