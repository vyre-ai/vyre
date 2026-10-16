// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { ownerWideRead, chainPerson, isStaffPerson, memberThreadAllowSet } from "./member-scope.js";

const K = (owner = "p-owner") => ({
  owner,
  space: "spc_home",
  canonicalPerson: (id) => String(id),
  membership: async (person) => {
    if (person === "p-owner") return { role: "owner", member: true };
    if (person === "p-admin") return { role: "admin", member: true };
    if (person === "p-alice") return { role: "member", member: true };
    return { role: "guest", member: false };
  },
  chain: async (meta) => {
    if (!meta?.token) throw new Error("no chain");
    if (meta.token === "owner") return { hops: [{ actor: { kind: "person", id: "p-owner" } }, { actor: { kind: "agent", id: "assistant" } }] };
    if (meta.token === "alice") return { hops: [{ actor: { kind: "person", id: "p-alice" } }, { actor: { kind: "agent", id: "assistant" } }] };
    return { hops: [{ actor: { kind: "person", id: "p-alice" } }] };
  },
});

test("ownerWideRead: cli alone is owner-wide only without a member token", async () => {
  const kernel = K();
  assert.equal(await ownerWideRead(kernel, {}, "cli"), true);
  assert.equal(await ownerWideRead(kernel, { token: "alice" }, "cli"), false);
  assert.equal(await ownerWideRead(null, {}, "cli"), true);
  assert.equal(await ownerWideRead(null, { token: "t" }, "cli"), false);
});

test("isStaffPerson: owner and admin are staff; members are not", async () => {
  const kernel = K();
  assert.equal(await isStaffPerson(kernel, "p-owner"), true);
  assert.equal(await isStaffPerson(kernel, "p-admin"), true);
  assert.equal(await isStaffPerson(kernel, "p-alice"), false);
});

test("chainPerson: one person hop from kernel chain", async () => {
  const kernel = K();
  assert.equal(await chainPerson(kernel, { token: "alice" }), "p-alice");
  assert.equal(await chainPerson(kernel, {}), null);
});

test("memberThreadAllowSet: members get a set; staff gets null", async () => {
  const kernel = K();
  const ctx = { call: async (tool) => (tool === "threads.recall-sessions" ? { data: { sessions: ["thr-carol"] } } : { error: { code: "no_such_tool" } }) };
  const allow = await memberThreadAllowSet(ctx, kernel, { token: "alice" });
  assert.ok(allow instanceof Set && allow.has("thr-carol"));
  assert.equal(await memberThreadAllowSet(ctx, kernel, { token: "owner" }), null);
});
