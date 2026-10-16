import test from "node:test";
import assert from "node:assert/strict";
import { countMacSessions, memberMayRunOnComputer, offersGrant } from "./runner-consent.js";
import { createCompute, memoryComputeStore, COMPUTE_TERMS_DEFAULT } from "./spaces/compute.js";

test("runner-consent: offersGrant and mac session counting", () => {
  assert.equal(offersGrant({ spaceAllows: true, memberAccepts: true }), true);
  assert.equal(offersGrant({ spaceAllows: true, memberAccepts: false }), false);
  const rows = [{ where: "mac", person: "p1", device: "d1", session: "s1" }, { where: "mac", person: "p1", device: "d1", session: "s2" }, { where: "server", person: "p1", device: "d1", session: "s3" }];
  assert.equal(countMacSessions(rows, "p1", "d1"), 2);
  assert.equal(countMacSessions(rows, "p1", "d1", "s1"), 1);
});

test("runner-consent: memberMayRunOnComputer enforces offers and maxSessions", async () => {
  const ALEX = "per_alex", store = memoryComputeStore();
  const members = { get: async () => ({ role: "owner" }) };
  const compute = createCompute({ space: "spc_test", members, store, now: () => 1 });
  await compute.allowSpace({ actor: ALEX, enabled: true });
  await compute.acceptMember({ person: ALEX, enabled: true, terms: (await compute.status({ person: ALEX })).hash });
  const offers = { active: () => ({ spaceAllows: true, memberAccepts: true }) };
  const ok = await memberMayRunOnComputer({ offers, compute, person: ALEX, device: "dev1", rows: [] });
  assert.equal(ok.allow, true);
  const rows = [{ where: "mac", person: ALEX, device: "dev1", session: "a" }, { where: "mac", person: ALEX, device: "dev1", session: "b" }];
  const at = await memberMayRunOnComputer({ offers, compute, person: ALEX, device: "dev1", rows });
  assert.equal(at.allow, false);
  assert.equal(at.code, "at_limit");
  assert.equal((await compute.status({ person: ALEX })).terms.maxSessions, COMPUTE_TERMS_DEFAULT.maxSessions);
});
