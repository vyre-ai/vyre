// The ledger match for memory.sealscan (SD-3): candidates, the pass over held text with a stand-in for the sealing process's yes or no, and the tool on a real daemon is in the daemon test.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { candidates, ledgerScan } from "./sealed.js";

test("candidates: tokens with a digit and 6 or more characters; ids, urls, paths, dates and hashes are not offered", () => {
  assert.deepEqual(candidates("the case number is 2024-CV-00417 and member M-5589120, call 5"), ["2024-CV-00417", "M-5589120"]);
  assert.deepEqual(candidates("see https://x.test/a1b2c3d4 and vyre://spc_a/matter/m_1 and /tmp/a123456 and 2026-10-04T10:00:00Z at 10:45 id per_abc12345"), []);
  assert.deepEqual(candidates("550e8400-e29b-41d4-a716-446655440000 and deadbeefdeadbeefdeadbeefdeadbeef"), []);
  assert.deepEqual(candidates("no digits here at all"), []);
  assert.deepEqual(candidates(null), []);
});

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE memory_writes (id INTEGER PRIMARY KEY, text TEXT); CREATE TABLE memory_taught (id INTEGER PRIMARY KEY, fact TEXT)");
  d.prepare("INSERT INTO memory_writes (text) VALUES (?)").run("Client file CV-884201 is in the blue folder");
  d.prepare("INSERT INTO memory_writes (text) VALUES (?)").run("Nothing to see, order 7788990 shipped");
  d.prepare("INSERT INTO memory_taught (fact) VALUES (?)").run("Their member number is CV-884201 again");
  return d;
}

test("ledgerScan: reports rows by table and column, never a value; a no is remembered so a second run asks only what is new; the cap and a rate limit stop it cleanly", async () => {
  const d = db(), asked = [];
  const match = async v => { asked.push(v); return v === "CV-884201"; };
  const r = await ledgerScan(d, match);
  assert.deepEqual(r.matched.sort((a, b) => a.table.localeCompare(b.table)), [{ table: "memory_taught", column: "fact", rows: 1 }, { table: "memory_writes", column: "text", rows: 1 }]);
  assert.equal(r.calls, 2, "the same candidate is asked once per pass");
  assert.equal(r.stopped, null);
  assert.equal(JSON.stringify(r).includes("884201"), false, "no value in the result");
  assert.equal(JSON.stringify(d.prepare("SELECT * FROM memory_sealscan_no").all()).includes("7788990"), false, "no raw value stored");
  asked.length = 0;
  const again = await ledgerScan(d, match);
  assert.deepEqual(asked, ["CV-884201"], "a no is skipped, a hit is asked again");
  assert.equal(again.matched.length, 2, "rows stay reported, not doubled");

  const d2 = db(), few = await ledgerScan(d2, async () => false, { max: 1 });
  assert.equal(few.calls, 1); assert.equal(few.stopped, "max"); assert.ok(few.remaining >= 1);

  const d3 = db(), lim = await ledgerScan(d3, async () => { throw Object.assign(new Error("slow down"), { code: "rate_limited" }); });
  assert.equal(lim.stopped, "rate_limited"); assert.equal(lim.calls, 0);
  const none = await ledgerScan(db(), async () => { throw Object.assign(new Error("no"), { code: "first_party_only" }); });
  assert.equal(none.stopped, "first_party_only");
});
