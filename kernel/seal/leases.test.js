// @ts-check
// Key leases (DESIGN-local-runner section 3): an hour, renewed while access holds, never issued after a revoke, keys that change after a revoke.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startSealer } from "./client.js";
import { Leases, LEASE_MS } from "./leases.js";
import { leasedUse } from "./uses.js";
import { SealStore } from "./store.js";
import { person, withAgent, signer, tmp, enrolDevice } from "./testing.js";
import crypto from "node:crypto";

const code = p => p.then(() => null, e => e.code), SP = "spc_testspace0001";
const mk = () => { let t = 5_000_000; const dir = tmp("lease"), store = new SealStore(dir, Buffer.alloc(32, 4)), L = new Leases(store, () => t); return { L, dir, store, tick: ms => { t += ms; }, reopen: () => new Leases(store, () => t) }; };

test("a lease gives a stable key per Space and device, an hour long, and different keys for another device or Space", () => {
  const { L } = mk(), a = L.issue({ space: SP, device: "dev_mac", allowed: true }), b = L.issue({ space: SP, device: "dev_mac", allowed: true });
  assert.equal(a.ttlMs, LEASE_MS); assert.equal(Buffer.from(a.key, "base64").length, 32); assert.equal(a.key, b.key, "the workspace reopens with the same key"); assert.notEqual(a.id, b.id);
  assert.notEqual(L.issue({ space: SP, device: "dev_pc", allowed: true }).key, a.key); assert.notEqual(L.issue({ space: "spc_other", device: "dev_mac", allowed: true }).key, a.key);
});

test("renewal needs access to hold; losing it revokes at once, and nothing is issued again, across a restart", () => {
  const { L, reopen, tick } = mk(), a = L.issue({ space: SP, device: "dev_mac", allowed: true });
  tick(LEASE_MS / 2); assert.deepEqual(L.renew({ id: a.id, allowed: true }), { ttlMs: LEASE_MS });
  assert.deepEqual(L.renew({ id: a.id, allowed: false }), { revoked: true });
  assert.deepEqual(L.issue({ space: SP, device: "dev_mac", allowed: true }), { revoked: true }, "never issued after a revoke, even if the kernel now says yes");
  assert.deepEqual(reopen().issue({ space: SP, device: "dev_mac", allowed: true }), { revoked: true }, "the revoke survives a restart");
  assert.equal(L.issue({ space: SP, device: "dev_pc", allowed: true }).id.startsWith("lease_"), true, "another device is unaffected");
  assert.deepEqual(L.issue({ space: SP, device: "dev_new", allowed: false }), { revoked: true }, "no grant, no key, and it counts as revoked");
});

test("a lease that runs out is not renewed, and the key after a reinstatement is not the old one", () => {
  const { L, tick } = mk(), a = L.issue({ space: SP, device: "dev_mac", allowed: true });
  tick(LEASE_MS + 1); assert.throws(() => L.renew({ id: a.id, allowed: true }), { code: "lease_expired" });
  assert.throws(() => L.renew({ id: "lease_nope", allowed: true }), { code: "unknown_lease" });
  const b = L.issue({ space: SP, device: "dev_mac", allowed: true }); L.revoke({ space: SP, device: "dev_mac" }); L.reinstate({ space: SP, device: "dev_mac" });
  const c = L.issue({ space: SP, device: "dev_mac", allowed: true }); assert.notEqual(c.key, b.key, "a key copied before the revoke opens nothing now");
});

test("check is for a live, unrevoked lease only", () => {
  const { L, tick } = mk(), a = L.issue({ space: SP, device: "dev_mac", allowed: true });
  assert.deepEqual(L.check({ id: a.id }), { space: SP, device: "dev_mac" });
  L.revoke({ space: SP, device: "dev_mac" }); assert.throws(() => L.check({ id: a.id }), { code: "no_lease" });
  const b = L.issue({ space: SP, device: "dev_pc", allowed: true }); tick(LEASE_MS + 1); assert.throws(() => L.check({ id: b.id }), { code: "no_lease" });
});

test("the sealing process: only a person asks, reinstating needs presence, no key or secret is in the folder", async t => {
  const dir = tmp("leasep"), s = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true }), alex = signer("per_alex");
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await enrolDevice(s, alex); const ch = person();
  assert.equal(await code(s.lease.issue({ chain: withAgent(), space: SP, device: "d1", allowed: true })), "human_only", "a model cannot ask for a key");
  const a = await s.lease.issue({ chain: ch, space: SP, device: "d1", allowed: true }); assert.equal(Buffer.from(a.key, "base64").length, 32);
  assert.equal((await s.lease.check({ chain: ch, id: a.id })).device, "d1");
  assert.deepEqual(await s.lease.renew({ chain: ch, id: a.id, allowed: false }), { revoked: true });
  assert.equal(await code(s.lease.check({ chain: ch, id: a.id })), "no_lease");
  assert.deepEqual(await s.lease.issue({ chain: ch, space: SP, device: "d1", allowed: true }), { revoked: true });
  assert.equal(await code(s.lease.reinstate({ chain: ch, device: "d1" })), "needs_presence");
  assert.equal((await s.lease.reinstate({ chain: ch, device: "d1", proof: alex.proof(ch, "lease.reinstate", { device: "d1" }) })).reinstated, true);
  const b = await s.lease.issue({ chain: ch, space: SP, device: "d1", allowed: true }); assert.notEqual(b.key, a.key);
  for (const f of fs.readdirSync(dir, { recursive: true })) { const p = `${dir}/${f}`; if (fs.statSync(p).isFile() && !p.endsWith("master.key")) assert.equal(fs.readFileSync(p).includes(Buffer.from(b.key, "base64").toString("hex")) || fs.readFileSync(p).includes(b.key), false); }
});

test("vault use at the point of use: needs a live lease, resolves per request, caches nothing, emits no value", async () => {
  const { L } = mk(), a = L.issue({ space: SP, device: "dev_mac", allowed: true }), events = []; let calls = 0;
  const use = leasedUse({ chain: null, leaseOf: s => (s === "sess1" ? a.id : null), check: async ({ id }) => L.check({ id }), resolve: async ({ ref }) => { calls++; return `secret-for-${ref}`; }, emit: e => events.push(e) });
  assert.equal(await use({ ref: "gmail", session: "sess1", route: "/gmail" }), "secret-for-gmail"); await use({ ref: "gmail", session: "sess1", route: "/gmail" }); assert.equal(calls, 2);
  assert.equal(JSON.stringify(events).includes("secret-for"), false);
  assert.equal(await code(use({ ref: "gmail", session: "other", route: "/gmail" })), "no_lease");
  L.revoke({ space: SP, device: "dev_mac" }); assert.equal(await code(use({ ref: "gmail", session: "sess1", route: "/gmail" })), "no_lease");
});
