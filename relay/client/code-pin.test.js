// @ts-check
// The vendored noble bundle must be exactly the one the pins file names (a changed byte fails here).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const dir = new URL("./vendor/", import.meta.url);
test("vendor: noble-ristretto255.js matches vendor/PINS.json", () => {
  const pins = JSON.parse(readFileSync(new URL("PINS.json", dir), "utf8"));
  const sum = createHash("sha256").update(readFileSync(new URL(pins.file, dir))).digest("hex");
  assert.equal(sum, pins.sha256);
  assert.equal(pins.sources.length, 2);
  assert.ok(pins.sources.every(/** @param {any} s */ s => /^sha512-/.test(s.integrity) && /^\d+\.\d+\.\d+$/.test(s.version)));
});
