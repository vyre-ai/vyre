import test from "node:test";
import assert from "node:assert/strict";
import { createRig } from "../../test/kernel-rig.js";
import { CONTACT } from "../conformance/suite.js";

test("seal.put: the roles that can write a record carry it; a temp member does not unless a grant of theirs names it; an assistant's chain is not the person's", async () => {
  const rig = await createRig({ people: { per_mem: "member", per_man: "manager", per_adm: "admin" }, agents: ["juno"], defs: [CONTACT] });
  await rig.addTemp("per_tmp", [`vyre://${rig.space}/contact/*`]);
  const c = await rig.create("contact", { name: "Jane", age: 40 });
  const ask = (chain) => rig.k.gateway.authorize({ chain, action: "seal.put", resource: c.urn });
  for (const who of ["per_alex", "per_adm", "per_man", "per_mem"]) assert.equal((await ask(rig.person(who))).effect, "allow", `${who} may seal a value into a record`);
  assert.notEqual((await ask(rig.person("per_tmp"))).effect, "allow", "a temp member does not, by role");
  assert.notEqual((await ask(rig.assistant("per_mem", "juno"))).effect, "allow", "an assistant acting for a member holds no seal.put of its own");
  // a grant that names it gives it to the temp member
  await rig.grantTo(rig.actor("person", "per_tmp"), ["seal.put"], `vyre://${rig.space}/contact/*`);
  assert.equal((await ask(rig.person("per_tmp"))).effect, "allow", "where a grant of theirs names it");
});
