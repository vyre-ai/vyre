// @ts-check
// Two small encodings were written many times: base32 and canonical JSON (consolidation inventory item 7). base32 is lib/bytes.js; canonical JSON is kernel/core/canonical.js. This test holds every
// remaining copy to them on a corpus, and fails when a source file outside a short, reasoned list writes either one again.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { base32 } from "../lib/bytes.js";
import { base32 as base32Bytes } from "../relay/client/bytes.js";
import { base32 as wireBase32 } from "../core/relay/wire.js";
import { base32 as rulesBase32 } from "../core/names/rules.js";
import { base32 as grantsBase32 } from "../core/wink/grants.js";
import { base32 as vaultBase32, canonical as vaultCanonical } from "../core/vault/crypto.js";
import { base32 as workerBase32 } from "../names/worker/index.js";
import { base32 as relayWorkerBase32 } from "../relay/worker/index.js";
import { canonical } from "../kernel/core/canonical.js";
import { canonical as wireCanonical } from "../kernel/seal/wire.js";
import { canonical as chainCanonical } from "../kernel/identity/chain.js";
import { canonical as flowsCanonical } from "../kernel/flows/schema.js";
import { canonical as publishCanonical } from "../lib/publish/util.js";
import { canonical as linkCanonical } from "../core/link/assert.js";
import { canonical as companionCanonical } from "../core/link/companion.js";
import { canonical as payloadCanonical } from "../apps/app/src/real/payload-hash.js";
import { canonical as signerCanonical } from "../apps/app/modules/vyre-signer/presence-proof.js";
import { canonical as presenceCanonical } from "../core/presence/index.js";
import { findInSource } from "./source-files.js";

test("every base32 is lib/bytes.js's, in lower case, or its capitals", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6, 10, 16, 20, 32, 33]) {
    const b = crypto.randomBytes(n);
    const want = base32(b);
    assert.match(want, /^[a-z2-7]*$/);
    assert.equal(base32Bytes(b), want, `relay/client copy, ${n}`);
    assert.equal(wireBase32(b), want, `relay wire, ${n}`);
    assert.equal(rulesBase32(b), want, `names rules, ${n}`);
    assert.equal(grantsBase32(b, 12), want.slice(0, 12), `wink grants, ${n}`);
    assert.equal(vaultBase32(b), want.toUpperCase(), `vault, ${n}`);
    assert.equal(workerBase32(b), want, `names worker (another runtime), ${n}`);
    assert.equal(relayWorkerBase32(b), want, `relay worker (another runtime), ${n}`);
  }
  assert.equal(base32(Buffer.from("foobar")), "mzxw6ytboi", "RFC 4648 vector, lower case, no padding");
});

/** Plain JSON values the signature-bearing paths hash. */
const CORPUS = [
  null, true, false, 0, -1, 1.5, 1e21, "", "plain", "ünï code \"quoted\" \\ back\nslash",
  [], [1, [2, [3]]], [null, 1, "a"], {}, { b: 1, a: 2 }, { a: { d: [1, { z: 1, y: 2 }], c: null }, "é": "x", "a b": 1 },
  { op: "send", space: "spc_abc", fields: { to: ["a@b.c"], body: "hi", n: 3, ok: true } },
  { a: [undefined, 1], b: undefined },
];
const UNDEFINED_ENTRY = CORPUS[CORPUS.length - 1];

test("every canonical JSON gives the kernel's bytes on plain JSON", () => {
  for (const v of CORPUS) {
    const want = canonical(v);
    assert.equal(JSON.parse(want) !== undefined, true);
    // The sealing protocol's reference form (kernel/seal/wire.js) writes an undefined array entry as nothing; no JSON the protocol carries has one, so that one entry is not asked of it.
    const copies = { wireCanonical, chainCanonical, flowsCanonical, publishCanonical, linkCanonical, companionCanonical, payloadCanonical, signerCanonical, vaultCanonical };
    for (const [name, fn] of Object.entries(copies)) {
      if (name === "wireCanonical" && v === UNDEFINED_ENTRY) continue;
      assert.equal(/** @type {any} */ (fn)(v), want, `${name}: ${want}`);
    }
  }
  // The presence input hash (server and phone) skips functions and toJSON values by design; on plain JSON it is the same bytes.
  for (const v of CORPUS) assert.equal(presenceCanonical(v), canonical(v), `presence: ${canonical(v)}`);
  assert.throws(() => canonical(new Date(0)), /plain objects/, "the kernel refuses what could encode as {}");
});

const ALLOWED = new Map([
  ["lib/bytes.js", "the one base32"],
  ["relay/client/bytes.js", "generated from lib/bytes.js (scripts/sync-copies.mjs)"],
  ["names/worker/index.js", "a Cloudflare Worker: another runtime; the corpus above holds it to lib/bytes.js"],
  ["relay/worker/index.js", "a Cloudflare Worker: another runtime; the corpus above holds it to lib/bytes.js"],
  ["relay/client/code.js", "the pairing code's own alphabet (Crockford-style, 32 symbols with no I, L, O or U)"],
  ["kernel/core/canonical.js", "the one canonical JSON"],
  ["kernel/seal/wire.js", "the sealing protocol's reference form, which the sealing process, the kernel and the signers agree on byte for byte; the corpus above holds every other copy to it"],
  ["core/presence/index.js", "the presence input hash, which skips functions and toJSON values by design; apps/app/src/auth/person.ts is its phone half and core/wink/devicekey.js its software-key half (corpus above)"],
  ["apps/app/src/auth/person.ts", "the phone half of the presence input hash (core/presence/index.js)"],
  ["core/wink/devicekey.js", "the software-key half of the presence input hash (core/presence/index.js)"],
  ["relay/app/manifest.js", "the relay's served browser app is its own bundle and cannot import the kernel"],
  ["lib/said/resolve.js", "not JSON: normalises a recipient (lower case, phone digits)"],
  ["core/work/project-move.js", "a replacer-based stable stringify over move state that can hold bytes; the hashes already stored were made with it"],
  ["lib/spaces/upgrade.js", "a replacer-based stable stringify over upgrade state that can hold bytes; the hashes already stored were made with it"],
  ["core/wink/storage/s3.js", "an AWS signature's canonical request, a different thing"],
  ["core/modules/index.js", "a Map named canonical"],
  ["kernel/identity/chain.d.ts", "the type of the canonical it exports"],
  ["kernel/identity/chain.js", "a pinned root-of-trust file (kernel/identity/PINNED.json): it imports nothing but node:crypto and changes only through the reviewer's gate; the corpus above holds its canonical to the kernel's"],
]);
const PATTERNS = [/bits\s*\+=\s*8/, /^(?!.*kernelCanonical).*(?:function\s+canonical\s*\(|const\s+canonical\s*=\s*(?:\(?\s*[\w/*@{}.\s]*\)?\s*=>|\())/];

test("no other source file writes a base32 loop or a canonical JSON of its own", () => {
  assert.deepEqual(findInSource(PATTERNS, ALLOWED), [], "base32 is lib/bytes.js; canonical JSON is kernel/core/canonical.js");
});
