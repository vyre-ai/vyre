// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { sideOf, listed, cleanKinds } from "./relationship.js";

const A = "vyre://juniper/contact/a", B = "vyre://juniper/contact/b", C = "vyre://juniper/organization/c";

test("a row reads from either end", () => {
  const row = { id: "r1", data: { from_record: A, to_record: B, kind: "Parent" } };
  assert.deepEqual(sideOf(A, row), { direction: "from", other: B });
  assert.deepEqual(sideOf(B, row), { direction: "to", other: A });
});

test("the list names the other end and orders by start date, newest first", () => {
  const rows = [
    { id: "r1", data: { from_record: A, to_record: B, kind: "Parent", since: "2010-01-01" } },
    { id: "r2", data: { from_record: C, to_record: A, kind: "Employer", since: "2020-05-01", note: "full time" } },
    { id: "r3", data: { from_record: A, to_record: C, kind: "Referrer" } },
  ];
  const l = listed(A, rows);
  assert.deepEqual(l.map((x) => x.id), ["r2", "r1", "r3"]);
  assert.deepEqual(l[0], { id: "r2", direction: "to", other: C, kind: "Employer", since: "2020-05-01", until: null, note: "full time" });
});

test("kinds are trimmed, deduplicated in any case and bounded", () => {
  assert.deepEqual(cleanKinds([" Spouse ", "spouse", "", "Parent"]), ["Spouse", "Parent"]);
  assert.throws(() => cleanKinds([]), /at least one kind/);
  assert.throws(() => cleanKinds(["", "  "]), /at least one kind/);
  assert.throws(() => cleanKinds(["x".repeat(41)]), /up to 40/);
  assert.throws(() => cleanKinds(Array.from({ length: 61 }, (_, i) => `k${i}`)), /at most 60/);
});
