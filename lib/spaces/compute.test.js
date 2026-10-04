// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMembers, memoryStore } from "./members.js";
import { createCompute, memoryComputeStore, termsHash, COMPUTE_TERMS_DEFAULT } from "./compute.js";

const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 86_400_000;
const ALEX = "per_" + "a".repeat(26), KIT = "per_" + "k".repeat(26), JUNO = "per_" + "j".repeat(26), BO = "per_" + "b".repeat(26);

async function world() {
  const clock = { t: T0 };
  const now = () => clock.t;
  const events = [];
  const members = createMembers({ space: "spc_harlow", store: memoryStore(), now, emit: () => {}, verifyPresence: () => true });
  await members.bootstrapOwner(ALEX);
  await members.addMember({ actor: ALEX, person: KIT, role: "member" });
  await members.addMember({ actor: ALEX, person: JUNO, role: "admin", presence: { method: "test" } }).catch(() => members.addMember({ actor: ALEX, person: JUNO, role: "admin" }));
  await members.addMember({ actor: ALEX, person: BO, role: "temp", scope: ["vyre://harlow/project/bakery-case"], expires: T0 + 3 * DAY });
  const compute = createCompute({ space: "spc_harlow", members, store: memoryComputeStore(), now, emit: (t, p) => events.push([t, p]) });
  return { clock, compute, events };
}

test("compute: nothing runs until the space allows and the member accepts, and the member must accept the terms they were shown", async () => {
  const w = await world();
  const own = { actor: KIT, session: { owner: KIT }, machine: { owner: KIT } };
  assert.equal((await w.compute.mayRun(own)).reason, "space_not_allowed");
  await assert.rejects(w.compute.acceptMember({ person: KIT, enabled: true, terms: "x" }), e => e.code === "not_allowed");
  const allowed = await w.compute.allowSpace({ actor: ALEX, enabled: true });
  assert.deepEqual(allowed.terms, COMPUTE_TERMS_DEFAULT);
  assert.equal((await w.compute.mayRun(own)).reason, "member_not_accepted", "the space alone is not enough");
  await assert.rejects(w.compute.acceptMember({ person: KIT, enabled: true, terms: "not-the-hash" }), e => e.code === "terms_changed");
  await w.compute.acceptMember({ person: KIT, enabled: true, terms: allowed.hash });
  assert.deepEqual(await w.compute.mayRun(own), { allow: true, reason: "both_agreed", terms: COMPUTE_TERMS_DEFAULT });
  assert.equal(allowed.hash, termsHash(COMPUTE_TERMS_DEFAULT));
  assert.deepEqual(w.events.map(e => e[0]), ["compute.space-allowed", "compute.member-accepted"]);
});

test("compute: it covers only the member's own sessions on the member's own computer; an admin cannot reach in", async () => {
  const w = await world();
  const { hash } = await w.compute.allowSpace({ actor: ALEX, enabled: true });
  await w.compute.acceptMember({ person: KIT, enabled: true, terms: hash });
  await w.compute.acceptMember({ person: ALEX, enabled: true, terms: hash });
  // the owner starts a session on kit's computer, kit's session on alex's, a service for kit: all refused
  for (const a of [
    { actor: ALEX, session: { owner: ALEX }, machine: { owner: KIT } },
    { actor: ALEX, session: { owner: KIT }, machine: { owner: KIT } },
    { actor: KIT, session: { owner: ALEX }, machine: { owner: KIT } },
    { actor: KIT, session: { owner: KIT }, machine: { owner: ALEX } },
    { actor: "service:scheduler", session: { owner: KIT }, machine: { owner: KIT } },
  ]) assert.equal((await w.compute.mayRun(a)).reason, "not_own", JSON.stringify(a));
  assert.equal((await w.compute.mayRun({ actor: ALEX, session: { owner: ALEX }, machine: { owner: ALEX } })).allow, true);
  // the session limit
  assert.equal((await w.compute.mayRun({ actor: KIT, session: { owner: KIT, running: 2 }, machine: { owner: KIT } })).reason, "at_limit");
});

test("compute: only an owner or admin allows; only the member accepts; a temp guest cannot lend a computer", async () => {
  const w = await world();
  await assert.rejects(w.compute.allowSpace({ actor: KIT, enabled: true }), e => e.code === "forbidden");
  await assert.rejects(w.compute.allowSpace({ actor: BO, enabled: true }), e => e.code === "forbidden");
  const { hash } = await w.compute.allowSpace({ actor: JUNO, enabled: true });
  await assert.rejects(w.compute.acceptMember({ person: BO, enabled: true, terms: hash }), e => e.code === "forbidden");
  await assert.rejects(w.compute.acceptMember({ person: "per_" + "z".repeat(26), enabled: true, terms: hash }), e => e.code === "not_a_member");
  await assert.rejects(w.compute.allowSpace({ actor: ALEX, enabled: true, terms: { maxSessions: 0 } }), e => e.code === "bad_input");
});

test("compute: either side ends it at once, and new terms need a new acceptance", async () => {
  const w = await world();
  const own = { actor: KIT, session: { owner: KIT }, machine: { owner: KIT } };
  const first = await w.compute.allowSpace({ actor: ALEX, enabled: true });
  await w.compute.acceptMember({ person: KIT, enabled: true, terms: first.hash });
  assert.equal((await w.compute.mayRun(own)).allow, true);
  // the space changes its terms: kit must look again
  const second = await w.compute.allowSpace({ actor: ALEX, enabled: true, terms: { maxSessions: 4 } });
  assert.notEqual(second.hash, first.hash);
  assert.equal((await w.compute.mayRun(own)).reason, "terms_changed");
  const st = await w.compute.status({ person: KIT });
  assert.deepEqual([st.spaceAllows, st.memberAccepted, st.acceptedCurrentTerms, st.active], [true, true, false, false]);
  assert.match(st.needs, /new ones/);
  await w.compute.acceptMember({ person: KIT, enabled: true, terms: second.hash });
  assert.equal((await w.compute.mayRun(own)).allow, true);
  // the member stops
  await w.compute.acceptMember({ person: KIT, enabled: false });
  assert.equal((await w.compute.mayRun(own)).reason, "member_not_accepted");
  // the member accepts again; the space stops
  await w.compute.acceptMember({ person: KIT, enabled: true, terms: second.hash });
  await w.compute.allowSpace({ actor: ALEX, enabled: false });
  assert.equal((await w.compute.mayRun(own)).reason, "space_not_allowed");
  await assert.rejects(w.compute.acceptMember({ person: KIT, enabled: true, terms: second.hash }), e => e.code === "not_allowed");
});

test("compute: a member who is removed or whose access ended can no longer lend", async () => {
  const w = await world();
  const { hash } = await w.compute.allowSpace({ actor: ALEX, enabled: true });
  await w.compute.acceptMember({ person: KIT, enabled: true, terms: hash });
  const own = { actor: KIT, session: { owner: KIT }, machine: { owner: KIT } };
  assert.equal((await w.compute.mayRun(own)).allow, true);
  const gone = await createCompute({ space: "spc_harlow", members: { get: async () => null }, store: memoryComputeStore(), now: () => w.clock.t });
  assert.equal((await gone.mayRun(own)).reason, "space_not_allowed");
});
