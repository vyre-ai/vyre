// @ts-check
// canonical.js, ids.js and the store's page cursor no longer use node:crypto or Buffer (so the same files run on a phone and in a browser). Everything signed or hashed depends on their bytes, so this holds the
// new code to the old: each result is compared with what node:crypto and Buffer give for the same input, over text, unicode, empty, bytes and big ones.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { canonical, sha256, hmac, sameMac } from "./canonical.js";
import { mintUuid, mintId, isUuid, timeOf } from "./ids.js";
import { encodeCursor, page } from "../store/query.js";

const inputs = ["", "a", "Dana Reyes owes 4,200", "café ☃ \u{1F600}", "x".repeat(10_000), JSON.stringify({ b: 1, a: [1, 2, { z: null }] })];

test("sha256 and hmac give the bytes node:crypto gives, for text and for bytes", () => {
  for (const s of inputs) {
    assert.equal(sha256(s), createHash("sha256").update(s).digest("base64url"));
    assert.equal(sha256(Buffer.from(s)), createHash("sha256").update(s).digest("base64url"), "a Buffer is bytes");
    assert.equal(sha256(new Uint8Array(Buffer.from(s))), createHash("sha256").update(s).digest("base64url"));
    for (const key of ["k", "a longer key with é", "x".repeat(200)]) assert.equal(hmac(key, s), createHmac("sha256", key).update(s).digest("base64url"));
    const kb = randomBytes(32);
    assert.equal(hmac(kb, s), createHmac("sha256", kb).update(s).digest("base64url"), "a key as bytes");
  }
  assert.equal(sha256(canonical({ b: 2, a: [1, "x"] })), createHash("sha256").update('{"a":[1,"x"],"b":2}').digest("base64url"));
});

test("sameMac agrees with timingSafeEqual on equal, different and unequal-length strings", () => {
  const a = hmac("k", "m"), b = hmac("k", "n");
  const ref = (x, y) => { const p = Buffer.from(x), q = Buffer.from(y); return p.length === q.length && timingSafeEqual(p, q); };
  for (const [x, y] of [[a, a], [a, b], [a, a.slice(1)], ["", ""], ["", "a"], ["é", "é"], ["é", "é"]]) assert.equal(sameMac(x, y), ref(x, y));
});

/** The old mintUuid, with Buffer. */
function oldMint(now, rand) {
  const r = rand(10), b = Buffer.alloc(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x40 | (r[0] & 0x0f); b[7] = r[1]; b[8] = 0x80 | (r[2] & 0x3f);
  for (let i = 3; i < 10; i++) b[9 + i - 3] = r[i];
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

test("mintUuid writes the same bytes as before: time, version, variant and the random rest", () => {
  for (const now of [0, 1, 255, 256, 65_535, 1_700_000_000_000, 2 ** 32, 2 ** 32 + 12345, 2 ** 48 - 1]) {
    const r = randomBytes(10);
    const got = mintUuid(now, () => r), want = oldMint(now, () => r);
    assert.equal(got, want);
    assert.ok(isUuid(got));
    assert.equal(timeOf(`dec_${got}`), now);
  }
  assert.match(mintId("evt", 1_700_000_000_000), /^evt_[0-9a-f]{8}-/);
  assert.throws(() => mintUuid(2 ** 48), RangeError);
  assert.throws(() => mintUuid(-1), RangeError);
});

test("the page cursor is the same base64url text as before and pages the same", () => {
  const rows = [{ id: "a", fields: { n: 1 } }, { id: "b", fields: { n: 2 } }, { id: "c", fields: { n: 2 } }, { id: "d", fields: { n: 3 } }];
  const sort = [{ field: "n", dir: "asc" }];
  const c = encodeCursor(rows[1], sort);
  assert.equal(c, Buffer.from(JSON.stringify([2, "b"])).toString("base64url"));
  const first = /** @type {any} */ (page(rows, { sort, page: { limit: 2 } }));
  assert.equal(first.rows.map((/** @type {any} */ r) => r.id).join(), "a,b");
  assert.equal(first.next_cursor, Buffer.from(JSON.stringify([2, "b"])).toString("base64url"));
  const second = /** @type {any} */ (page(rows, { sort, page: { limit: 2, cursor: first.next_cursor } }));
  assert.equal(second.rows.map((/** @type {any} */ r) => r.id).join(), "c,d");
  assert.deepEqual(page(rows, { sort, page: { limit: 2, cursor: "!!not a cursor" } }), { error: "invalid cursor" });
});
