import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as N from "../../../../kernel/identity/space-login.js";
import { acceptKdf, bundleHash, deriveLogin, loginMessage, registerMessage, LOGIN_KDF, KDF_FLOOR, KDF_CEIL } from "./login-web.js";

const FAST = { memoryKiB: 64, passes: 2, lanes: 1, tagLength: 32 };

test("the page's costs are the server module's", () => {
  assert.deepEqual({ ...LOGIN_KDF }, { ...N.LOGIN_KDF });
  assert.deepEqual({ ...KDF_FLOOR }, { ...N.KDF_FLOOR });
  assert.deepEqual({ ...KDF_CEIL }, { ...N.KDF_CEIL });
});

test("the KDF a server may ask for: the same answer as the module on a table of good and hostile settings", () => {
  const good = [{ memoryKiB: 19456, passes: 2, lanes: 1, tagLength: 32 }, { memoryKiB: 65536, passes: 3, lanes: 1, tagLength: 32 }, { memoryKiB: 262144, passes: 6, lanes: 1, tagLength: 32 }];
  const hostile = [null, {}, { memoryKiB: 8, passes: 1, lanes: 1, tagLength: 32 }, { memoryKiB: 19455, passes: 2, lanes: 1, tagLength: 32 }, { memoryKiB: 19456, passes: 1, lanes: 1, tagLength: 32 }, { memoryKiB: 262145, passes: 3, lanes: 1, tagLength: 32 },
    { memoryKiB: 65536, passes: 7, lanes: 1, tagLength: 32 }, { memoryKiB: 65536, passes: 3, lanes: 4, tagLength: 32 }, { memoryKiB: 65536, passes: 3, lanes: 1, tagLength: 16 }, { memoryKiB: "65536", passes: 3, lanes: 1, tagLength: 32 }];
  for (const k of good) assert.deepEqual(acceptKdf(k), N.acceptKdf(k));
  for (const k of hostile) { assert.throws(() => acceptKdf(k), (e) => e.code === "bad_kdf"); assert.throws(() => N.acceptKdf(k), (e) => e.code === "bad_kdf"); }
});

test("the page derives the same K, login key and signature as kernel/identity/space-login.js", async () => {
  const salt = crypto.randomBytes(16);
  const mine = await deriveLogin("correct horse battery staple", salt, FAST);
  const node = N.deriveLogin("correct horse battery staple", salt, { ...FAST, pure: true });
  assert.equal(Buffer.from(mine.K).toString("hex"), Buffer.from(node.K).toString("hex"));
  assert.equal(mine.loginPub, node.loginPub);
  const msg = loginMessage("juniper", "alex", "chal");
  assert.equal(Buffer.from(msg).toString(), Buffer.from(N.loginMessage("juniper", "alex", "chal")).toString());
  assert.equal(mine.sign(msg), node.sign(msg), "Ed25519 is deterministic: the same seed signs the same bytes the same way");
  assert.equal(Buffer.from(registerMessage("s", "u", "pub", "h", 5)).toString(), Buffer.from(N.registerMessage("s", "u", "pub", "h", 5)).toString());
  const bundle = { v: 1, username: "alex", kdf: { salt: "x" } };
  assert.equal(bundleHash(bundle), N.bundleHash(bundle));
  mine.close();
  assert.equal(Buffer.from(mine.K).every((b) => b === 0), true, "K is zeroed after use");
});
