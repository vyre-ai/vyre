// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import "../../scripts/mac-test-guard.mjs";

test("outbox chips JSON round-trips the shape threads.send expects", () => {
  const chips = [{ kind: "record", id: "vyre://acme/matter/m1", name: "Northwind" }];
  const raw = JSON.stringify(chips);
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed, chips);
  const mentions = [...parsed, { kind: "account", id: "codex" }];
  assert.equal(mentions.length, 2);
  assert.equal(mentions[0].kind, "record");
});
