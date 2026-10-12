// @ts-check
// A person's thread gets a project's memory only if she may use the project: through the real memory.prompt and the real work module on a vyred with the kernel on, asked as the switchboard asks it for a
// thread (person: true, the project, and whose thread it is). The owner and an admin: yes. A member on the project's team and its owner: yes. A member who is not on it: the prompt of a chat with no project.
// SHIM(presence) `kernelPresence` accepts any proof, as the other real-daemon suites do. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ADM = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const person = (/** @type {string} */ id, /** @type {string} */ space) => ({ actor: { kind: "person", id, space } });

test("memory.prompt for a person's thread in a project: owner, admin, the project's owner and team get its room; a member who is not on it gets none", { timeout: 150_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, SPACE = K.id.space;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const [p, role] of [[ANA, "member"], [BEN, "member"], [ADM, "admin"]]) await K.gateway.grants.setRole(ownerChain, { person: p, role }, { presence: proof() });
  const R = K.gateway.records;
  await R.create(ownerChain, "project", { name: "Owners matter", slug: "owners-matter", status: "active", memory_scope: "project:owners-matter", owner: person(OWNER, SPACE) });
  const ask = (/** @type {string | null} */ who) => d.registry.call("memory.prompt", { prompt: "what is the plan", first: true, thread: "t1", person: true, project: "owners-matter", ...(who ? { for_person: who } : {}) }, "module:switchboard", { firstParty: true });
  const text = async (/** @type {string | null} */ who) => { const r = await ask(who); assert.ok(!r.error, JSON.stringify(r.error)); return String(r.data.text); };
  const withProject = await text(OWNER);
  assert.match(withProject, /in this project/, "control: the owner's thread in the project gets its room line: " + withProject.slice(0, 200));
  assert.match(await text(ADM), /in this project/, "an admin does");
  const without = await text(ANA);
  assert.ok(!/in this project/.test(without), "a member who is not on the project gets none of it: " + without.slice(0, 200));
  assert.ok(!/in this project/.test(await text("-")), "a thread with nobody to judge (the placeholder person) gets none");
  // seated on the team, she does; Ben, still off it, does not
  await R.create(ownerChain, "team-member", { name: "ana", actor: person(ANA, SPACE), kind: "person", project: { urn: `vyre://${SPACE}/project/${(await R.query(ownerChain, "project", { filter: { field: "slug", op: "eq", value: "owners-matter" }, page: { limit: 1 } })).rows[0].id}` } });
  assert.match(await text(ANA), /in this project/, "on the team: she gets it");
  assert.ok(!/in this project/.test(await text(BEN)), "another member still does not");
});
