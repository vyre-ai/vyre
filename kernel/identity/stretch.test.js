// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { argon2id, STRETCH, STRETCH_SALT } from "./stretch.js";

// Vectors made by Node's native Argon2id (24.15) with the salt below, one lane. The pure JS must give the same bytes on every Node.
const VECTORS = [
  { memoryKiB: 8, passes: 1, secret: "a", tag: "9e479e4512a05da9" },
  { memoryKiB: 64, passes: 2, secret: "vyre test secret", tag: "2135d5e12c4cfc27" },
  { memoryKiB: 256, passes: 3, secret: "x".repeat(200), tag: "4c1a8780a71e64f4" },
];

test("stretch: the parameters are the stated ones", () => {
  assert.deepEqual({ ...STRETCH }, { memoryKiB: 19456, passes: 2, lanes: 1, tagLength: 32 });
  assert.equal(STRETCH_SALT, "vyre-recovery-code-v1");
});

test("stretch: the pure Argon2id matches the native vectors, and the native one when there is one", () => {
  for (const v of VECTORS) {
    const pure = argon2id(v.secret, STRETCH_SALT, { memoryKiB: v.memoryKiB, passes: v.passes, pure: true });
    assert.equal(pure.length, 32);
    assert.ok(pure.toString("hex").startsWith(v.tag), `${v.memoryKiB} KiB, ${v.passes} passes`);
    assert.equal(argon2id(v.secret, STRETCH_SALT, { memoryKiB: v.memoryKiB, passes: v.passes }).toString("hex"), pure.toString("hex"));
  }
});

test("stretch: the full-size parameters give one answer with the native and the pure code", () => {
  const a = argon2id("code\npassword", STRETCH_SALT, STRETCH).toString("hex");
  assert.equal(a.slice(0, 16), "6a8a30625a4eb5d7");
  assert.equal(argon2id("code\npassword", STRETCH_SALT, { ...STRETCH, pure: true }).toString("hex"), a);
});

test("stretch: the secret and the salt both change the key", () => {
  const p = { memoryKiB: 64, passes: 1 };
  assert.notEqual(argon2id("a", "salt-one-xx", p).toString("hex"), argon2id("b", "salt-one-xx", p).toString("hex"));
  assert.notEqual(argon2id("a", "salt-one-xx", p).toString("hex"), argon2id("a", "salt-two-xx", p).toString("hex"));
});

// The verifier and the stretch are the root of trust for devices, spaces and recovery: a change to either is caught here and goes through the
// reviewer's gate, which then updates these hashes. Imports are limited to node:crypto.
const PINNED = JSON.parse(fs.readFileSync(new URL("./PINNED.json", import.meta.url), "utf8"));
test("identity files are pinned and import nothing but node:crypto", () => {
  for (const [file, hash] of Object.entries(PINNED)) {
    const text = fs.readFileSync(new URL(`./${file}`, import.meta.url));
    assert.equal(crypto.createHash("sha256").update(text).digest("hex"), hash, `${file} changed: it needs the reviewer's gate, then a new pin`);
    const imports = [...text.toString().matchAll(/^\s*import[^;]*from\s+"([^"]+)"/gm)].map(m => m[1]);
    assert.ok(imports.every(i => i === "node:crypto"), `${file} imports ${imports.join(", ")}`);
  }
});
