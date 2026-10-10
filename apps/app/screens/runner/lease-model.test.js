// The lease lines on a space's timeline (link's lease.borrowed, lease.issued, lease.refused on the space's log): one quiet line each, in words, newest first.
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { leaseRows, leaseWhy } from "./lease-model.js";

const NOW = 1_700_000_000_000;
const ev = (type, data, ago) => ({ type, seq: 1, time: NOW - ago, data, subject: "vyre://spc_x/lease/d1" });

test("lease lines: a borrow, a key and a refusal read as plain lines with the computer's name and the limit, newest first", () => {
  const names = (id) => ({ d1: "Dana's MacBook" }[id] ?? "");
  const rows = leaseRows([
    ev("lease.refused", { member: "m", device: "d1", why: "no_lend" }, 3_600_000),
    ev("lease.issued", { member: "m", device: "d1", limit: "provider" }, 120_000),
    ev("lease.borrowed", { thread: "t", device: "d1", limit: "internet" }, 60_000),
    ev("project.created", {}, 10),
  ], names, NOW);
  assert.deepEqual(rows.map((r) => r.title), ["A chat borrowed Dana's MacBook", "Dana's MacBook was given its key", "Dana's MacBook was refused its key"]);
  assert.equal(rows[0].subtitle, "1m ago · It can reach the internet.");
  assert.equal(rows[1].subtitle, "2m ago · It can reach the AI provider and nothing else.");
  assert.equal(rows[2].subtitle, "1h ago · Lending to this space was switched off.");
  assert.equal(rows[0].icon, "laptop");
});

test("lease lines: a computer the list does not name is one of your computers, never an id, and an unknown reason says nothing", () => {
  const rows = leaseRows([ev("lease.borrowed", { device: "d9", limit: null }, 1000)], () => "", NOW);
  assert.equal(rows[0].title, "A chat borrowed one of your computers");
  assert.equal(rows[0].subtitle, "just now");
  assert.equal(leaseWhy("something-new"), "");
  assert.equal(leaseWhy("another_computer"), "It asked from another computer.");
  assert.deepEqual(leaseRows(null, () => "", NOW), []);
});
