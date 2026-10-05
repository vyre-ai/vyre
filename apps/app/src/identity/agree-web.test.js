import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";

// A browser has no shell and no native module: its agreement key is the page's own WebCrypto key in IndexedDB (src/crypto/agree-key.ts). This file is its own process so that module's one cached key is made here.
// A minimal IndexedDB stand-in: one object store, kept in memory (a CryptoKey is stored as is).
const rows = new Map();
globalThis.indexedDB = {
  open() {
    const r = {};
    queueMicrotask(() => {
      r.result = { createObjectStore() {}, transaction: () => {
        const t = {};
        t.objectStore = () => ({
          get: (k) => { const q = {}; queueMicrotask(() => { q.result = rows.get(k); q.onsuccess?.(); }); return q; },
          put: (v, k) => { rows.set(k, v); queueMicrotask(() => t.oncomplete?.()); },
        });
        return t;
      } };
      r.onupgradeneeded?.();
      r.onsuccess?.();
    });
    return r;
  },
};
const b64u = (b) => Buffer.from(b).toString("base64url");
const { agree, agreePublic } = await import("./agree.ts");

test("a browser publishes its WebCrypto agreement point, and agree opens a peer's wrap with the same key", async () => {
  delete globalThis.window;
  const pt = await agreePublic(true);
  assert.ok(pt, "a browser has an agreement point");
  const mine = Buffer.from(pt, "base64url");
  assert.equal(mine.length, 65);
  assert.equal(mine[0], 4);
  assert.equal(await agreePublic(true), pt, "the same key every time");
  const peer = createECDH("prime256v1"); peer.generateKeys();
  const secret = await agree(b64u(peer.getPublicKey()));
  assert.deepEqual(Buffer.from(secret), peer.computeSecret(mine), "the published key is the one that opens chats");
});

import { readFileSync } from "node:fs";
test("a browser's claim and recovery put that point on the entry as agree (the callers read agreePublic, claim.js and restore.ts write it)", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const install = read("../real/install.ts");
  assert.match(install, /const agreeKey = \(await agreePublic\(true\)\) \?\? undefined;/);
  assert.match(install, /\.\.\.\(agreeKey \? \{ agree: agreeKey \} : \{\}\)/, "claim gets it, with or without a Mac");
  assert.match(read("./claim.js"), /\.\.\.\(o\.agree \? \{ agree: o\.agree \} : \{\}\)/);
  const keys = read("../keys/index.ts");
  assert.match(keys, /if \(!macKeyAvailable\(\)\) \{ const agree = \(await agreePublic\(true\)\)/, "recovery in a browser carries it too");
});
