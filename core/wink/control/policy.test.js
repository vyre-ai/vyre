// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { SCRATCH } from "../../../test/scratch.mjs";
import { compilePolicy, applyPolicy, aliasFor } from "./policy.js";

/** @param {Partial<import("./policy.js").Row> & { id: string }} r */
const row = r => ({ kind: "device", bound: true, ...r });
const base = {
  hubPort: 7444, jobPort: 7555, prefix: "100.97.143.0/24", tags: ["tag:wink-hub", "tag:wink-device"],
  rows: [
    row({ id: "hub", kind: "hub", ip: "100.97.143.1" }),
    row({ id: "phone", ip: "100.97.143.2" }),
    row({ id: "laptop", ip: "100.97.143.3" }),
    row({ id: "gpu", kind: "compute", ip: "100.97.143.9" }),
    row({ id: "stray", ip: "100.97.143.50", bound: false }),
  ],
};

/** Evaluate the compiled acls like Headscale does: src alias, dst alias:port. */
function reaches(policy, src, dst, port) {
  const ip = n => (policy.hosts[aliasFor(n)] || "").replace("/32", "");
  if (!policy.hosts[aliasFor(src)] || !policy.hosts[aliasFor(dst)]) return false;
  return policy.acls.some(r => r.action === "accept" && r.src.includes(aliasFor(src)) && r.dst.includes(`${aliasFor(dst)}:${port}`) && ip(src) !== "");
}

test("policy: devices reach the hub's Vyre port and nothing else", () => {
  const { policy } = compilePolicy(base);
  assert.ok(reaches(policy, "phone", "hub", 7444));
  assert.ok(reaches(policy, "laptop", "hub", 7444));
  assert.ok(!reaches(policy, "phone", "hub", 22));
  assert.ok(!reaches(policy, "phone", "gpu", 7555));
  assert.ok(reaches(policy, "hub", "gpu", 7555), "the hub reaches a compute node on the job port");
  assert.ok(!reaches(policy, "hub", "gpu", 22));
  assert.ok(!reaches(policy, "hub", "phone", 7444), "no hub to device rule");
  assert.ok(!reaches(policy, "gpu", "hub", 7444), "compute nodes reach nothing");
});

test("policy: two devices never reach each other", () => {
  const { policy } = compilePolicy(base);
  for (const port of [7444, 7555, 22, 1]) {
    assert.ok(!reaches(policy, "phone", "laptop", port));
    assert.ok(!reaches(policy, "laptop", "phone", port));
  }
});

test("policy: an unbound node gets no rule and no name (EC-7)", () => {
  const { policy, text, skipped } = compilePolicy(base);
  assert.ok(!text.includes("100.97.143.50"));
  assert.ok(!text.includes(aliasFor("stray")));
  assert.ok(!reaches(policy, "stray", "hub", 7444));
  assert.deepEqual(skipped.find(s => s.id === "stray"), { id: "stray", reason: "unbound" });
  // not even as the hub: an unbound hub row yields no device rules at all
  const noHub = compilePolicy({ ...base, rows: base.rows.map(r => (r.id === "hub" ? { ...r, bound: false } : r)) });
  assert.deepEqual(noHub.policy.acls, []);
});

test("policy: bound without an address, or outside the prefix, gets nothing", () => {
  const { policy, skipped } = compilePolicy({ ...base, rows: [...base.rows, row({ id: "a" }), row({ id: "b", ip: "100.97.200.2" })] });
  assert.ok(!reaches(policy, "a", "hub", 7444) && !reaches(policy, "b", "hub", 7444));
  assert.deepEqual(skipped.filter(s => s.id === "a" || s.id === "b").map(s => s.reason).sort(), ["no-address", "outside-prefix"]);
});

test("policy: no role comes from a tag, a name or a kind-looking string", () => {
  // A device row that carries the hub's tag, and a node key that reads like a hub, is still a device.
  const rows = [row({ id: "hub", kind: "hub", ip: "100.97.143.1" }), row({ id: "evil", ip: "100.97.143.7", tags: ["tag:wink-hub"], stableId: "hub", nodeKey: "nodekey:hub" })];
  const { policy, text } = compilePolicy({ ...base, rows });
  assert.ok(reaches(policy, "evil", "hub", 7444));
  assert.ok(!reaches(policy, "hub", "evil", 7555) && !reaches(policy, "hub", "evil", 7444));
  assert.ok(!/"src": \[\s*"tag:/.test(text) && !/"dst": \[\s*"tag:/.test(text), "no rule names a tag");
  assert.ok(!text.includes("autogroup"));
  assert.deepEqual(policy.ssh, []);
  assert.deepEqual(Object.keys(policy.tagOwners), ["tag:wink-device", "tag:wink-hub"]);
});

test("policy: a pair needs a grant that names both ends and one port", () => {
  const { policy } = compilePolicy({ ...base, grants: [{ src: "phone", dst: "laptop", port: 8123 }, { src: "phone", dst: "stray", port: 1 }, { src: "phone", dst: "phone", port: 2 }] });
  assert.ok(reaches(policy, "phone", "laptop", 8123));
  assert.ok(!reaches(policy, "laptop", "phone", 8123), "a grant is one way");
  assert.ok(!reaches(policy, "phone", "laptop", 8124));
  assert.ok(!reaches(policy, "phone", "stray", 1), "an unbound end voids the grant");
});

test("policy: same inputs, same bytes, whatever the row order", () => {
  const a = compilePolicy(base).text;
  const b = compilePolicy({ ...base, rows: [...base.rows].reverse(), tags: [...base.tags].reverse() }).text;
  assert.equal(a, b);
  assert.equal(compilePolicy(base).text, a);
  JSON.parse(a);
});

test("policy: bad input throws", () => {
  assert.throws(() => compilePolicy({ ...base, hubPort: 0 }));
  assert.throws(() => compilePolicy({ ...base, tags: ["hub"] }));
  assert.throws(() => compilePolicy({ ...base, rows: [row({ id: "a b", ip: "100.97.143.5" }), row({ id: "a-b", ip: "100.97.143.6" })] }), /alias/);
  assert.deepEqual(compilePolicy({ hubPort: 1, jobPort: 2, rows: [] }).policy.acls, []);
});

test("applyPolicy: writes 0600 atomically, signals only on change, refuses non-JSON", () => {
  const dir = mkdtempSync(path.join(SCRATCH, "w-"));
  try {
    const f = path.join(dir, "policy.hujson");
    /** @type {[number, string][]} */ const sent = [];
    const io = { kill: (/** @type {number} */ p, /** @type {string} */ s) => { sent.push([p, s]); } };
    const text = compilePolicy(base).text;
    let r = applyPolicy(f, 4242, text, io);
    assert.deepEqual([r.changed, r.signalled], [true, true]);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    r = applyPolicy(f, 4242, text, io);
    assert.deepEqual([r.changed, r.signalled], [false, false]);
    assert.throws(() => applyPolicy(f, 4242, "{ not json", io));
    assert.equal(fs.readFileSync(f, "utf8"), text, "a bad policy never replaces a good one");
    assert.deepEqual(sent, [[4242, "SIGHUP"]]);
    assert.deepEqual(fs.readdirSync(dir), ["policy.hujson"], "no temp file left");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
