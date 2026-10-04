// @ts-check
// lib/avatar-seed: fixed vectors (the same table ADR 0043 carries for the Capsule's Swift port),
// checked against an independent BigInt FNV-1a here, not only against the function itself.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { projectBytes, fnv1a32, BASIS_A, BASIS_B, PREFIX } from "./index.js";

/** seed -> the 8 bytes as hex. Non-ASCII rows pin UTF-16 code units (é one unit, the emoji two). */
export const VECTORS = [
  ["harlow-legal", "ee53a80eb372fa43"],
  ["northwind", "3b03f25e73bb44e5"],
  ["9d0e4c1a-5b2f-4c1e-9a0b-3f2d1c0b9a88", "3298bd291db714fc"],
  ["", "b9de60c138d8b8f0"],
  ["café-menu", "3a3a125825ad9923"],
  ["🍞 bakery", "3607ac119874645a"],
];

const hex = (/** @type {number[]} */ b) => b.map(x => x.toString(16).padStart(2, "0")).join("");

test("projectBytes: the fixed vectors", () => {
  for (const [seed, want] of VECTORS) assert.equal(hex(projectBytes(seed)), want, JSON.stringify(seed));
});

test("projectBytes agrees with an independent BigInt FNV-1a 32", () => {
  const ref = (/** @type {string} */ s, /** @type {number} */ basis) => {
    let h = BigInt(basis);
    for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 16777619n) % 4294967296n; }
    return Number(h);
  };
  assert.equal(BASIS_B, 0xdacd7450);
  for (const seed of ["harlow-legal", "kit", "a".repeat(200), "Northwind Bakery"]) {
    const s = PREFIX + seed;
    assert.equal(fnv1a32(s, BASIS_A), ref(s, BASIS_A));
    assert.equal(fnv1a32(s, BASIS_B), ref(s, BASIS_B));
  }
});

test("projectBytes: 8 bytes, stable, and a missing seed is the empty seed", () => {
  assert.equal(projectBytes("northwind").length, 8);
  assert.deepEqual(projectBytes("northwind"), projectBytes("northwind"));
  assert.deepEqual(projectBytes(/** @type {any} */ (null)), projectBytes(""));
});

import { entityBytes } from "./index.js";

test("entityBytes: project is exactly projectBytes; agent and teammate use their own prefix", () => {
  for (const [seed] of VECTORS) assert.deepEqual(entityBytes("project", seed), projectBytes(seed));
  // Fixed vectors for the Swift and Expo ports (prefix "vyre:<family>:v1:").
  assert.equal(hex(entityBytes("agent", "juno")), AGENT_JUNO);
  assert.equal(hex(entityBytes("teammate", "reviewer-northwind")), TEAMMATE_RN);
  assert.notDeepEqual(entityBytes("agent", "northwind"), projectBytes("northwind"), "families never share bytes");
});
const AGENT_JUNO = "f5f1ceeb125b790a", TEAMMATE_RN = "0f562459be6203c2";

test("entityBytes agrees with an independent BigInt FNV-1a 32 for the other families", () => {
  const ref = (/** @type {string} */ s, /** @type {bigint} */ basis) => {
    let h = basis;
    for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 16777619n) % 4294967296n; }
    return h;
  };
  for (const [family, seed] of [["agent", "juno"], ["teammate", "reviewer-northwind"]]) {
    const str = `vyre:${family}:v1:${seed}`;
    const want = (ref(str, 0x811c9dc5n) << 32n | ref(str, 0xdacd7450n)).toString(16).padStart(16, "0");
    assert.equal(hex(entityBytes(family, seed)), want, family);
  }
});
