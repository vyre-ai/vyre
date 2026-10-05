import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMemberStorage, sha256 } from "./member-storage.js";
import { SCRATCH } from "../../test/scratch.mjs";

const SP = "spc_aaaaaaaaaaaa", ME = "per_" + "a".repeat(26), YOU = "per_" + "b".repeat(26);
const fresh = () => createMemberStorage({ dir: fs.mkdtempSync(path.join(SCRATCH, "mstore-")) });

test("member storage: put, get, list and delete keep each member's objects apart", () => {
  const s = fresh();
  assert.equal(s.get(SP, ME, "personal/a.bin"), null);
  assert.deepEqual(s.put(SP, ME, "personal/a.bin", Buffer.from("one")), { sha256: sha256("one") });
  s.put(SP, ME, "personal/b.bin", "two");
  s.put(SP, YOU, "personal/a.bin", "yours");
  assert.equal(s.get(SP, ME, "personal/a.bin").data.toString(), "one");
  assert.equal(s.get(SP, YOU, "personal/a.bin").data.toString(), "yours", "another member's object of the same name is another object");
  assert.deepEqual(s.list(SP, ME, "personal").sort(), ["personal/a.bin", "personal/b.bin"]);
  s.delete(SP, ME, "personal/a.bin");
  assert.equal(s.get(SP, ME, "personal/a.bin"), null);
  assert.equal(s.get(SP, YOU, "personal/a.bin").data.toString(), "yours");
  for (const bad of ["../x", "a//b", "/abs", "a/../b", "", "a b"]) assert.throws(() => s.put(SP, ME, bad, "x"), { code: "bad_input" }, bad);
});

test("putIf lands only on the sha256 the writer last saw; null means not there yet", () => {
  const s = fresh();
  assert.equal(s.putIf(SP, ME, "o", "v1", null).ok, true, "created when absent");
  assert.deepEqual(s.putIf(SP, ME, "o", "v2", null), { ok: false, sha256: sha256("v1") }, "null is refused once it exists, and names what is there");
  assert.equal(s.putIf(SP, ME, "o", "v2", sha256("v1")).ok, true);
  assert.deepEqual(s.putIf(SP, ME, "o", "v3", sha256("v1")), { ok: false, sha256: sha256("v2") }, "a stale writer is refused");
  assert.equal(s.get(SP, ME, "o").data.toString(), "v2", "the refused write changed nothing");
  assert.throws(() => s.putIf(SP, ME, "o", "x", "not-a-hash"), { code: "bad_input" });
});

test("race: many writers that all saw the same version, only one wins, and the object is one writer's bytes whole", async () => {
  const s = fresh();
  s.put(SP, ME, "o", "base");
  const seen = sha256("base");
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => Promise.resolve().then(() => s.putIf(SP, ME, "o", `writer-${i}`.padEnd(2000, "x"), seen))));
  assert.equal(results.filter(r => r.ok).length, 1, "exactly one compare-and-set succeeds");
  const now = s.get(SP, ME, "o");
  assert.match(now.data.toString(), /^writer-\d+x+$/);
  assert.equal(now.data.length, 2000);
  assert.equal(now.sha256, results.find(r => r.ok).sha256);
  assert.ok(results.filter(r => !r.ok).every(r => r.sha256 === now.sha256), "every loser is told what is there now");
  // a chain of writers each seeing the last one's hash all land, in order
  let have = now.sha256;
  for (let i = 0; i < 5; i++) { const r = s.putIf(SP, ME, "o", `next-${i}`, have); assert.equal(r.ok, true); have = r.sha256; }
  // creation race: many create with null, one wins
  const created = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => s.putIf(SP, ME, "new", `c${i}`, null))));
  assert.equal(created.filter(r => r.ok).length, 1);
});

test("the owner's cap refuses a write once the member's bytes reach it; reads and deletes still work; the cap is per member", () => {
  const s = fresh();
  assert.deepEqual(s.usage(SP, ME), { used: 0, cap: 1024 ** 3 });
  s.setCap(SP, ME, 100);
  s.put(SP, ME, "a", Buffer.alloc(100));
  assert.throws(() => s.put(SP, ME, "b", "x"), { code: "over_cap" });
  assert.throws(() => s.putIf(SP, ME, "b", "x", null), { code: "over_cap" });
  assert.equal(s.get(SP, ME, "a").data.length, 100, "reads are never refused");
  s.put(SP, YOU, "a", Buffer.alloc(100));
  s.delete(SP, ME, "a");
  s.put(SP, ME, "c", "fits again");
  s.setCap(SP, "*", 0);
  s.setCap(SP, ME, 0);
  s.put(SP, ME, "d", Buffer.alloc(5000));
  assert.deepEqual(s.usage(SP, YOU).cap, 0, "0 means no cap, for everyone by default");
  assert.throws(() => s.setCap(SP, ME, -1), { code: "bad_input" });
});
