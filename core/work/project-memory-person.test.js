// @ts-check
// The work module's answer to "may this person use the project's memory" (work.project.may-read, which memory.prompt and the switchboard ask for a person's thread), on a vyred with the kernel on: The owner and an admin: yes. A member on the project's team and its owner: yes. A member who is not on it: the prompt of a chat with no project.
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

test("work.project.may-read: owner, admin and the project's team may; a member who is not on it may not; only memory and the switchboard may ask", { timeout: 150_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, SPACE = K.id.space;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const [p, role] of [[ANA, "member"], [BEN, "member"], [ADM, "admin"]]) await K.gateway.grants.setRole(ownerChain, { person: p, role }, { presence: proof() });
  const R = K.gateway.records;
  await R.create(ownerChain, "project", { name: "Owners matter", slug: "owners-matter", status: "active", memory_scope: "project:owners-matter", owner: person(OWNER, SPACE) });
  // memory.prompt and the switchboard ask the work module this: the real tool, as the memory module asks it (the registry's gate keeps a first-party module's label for those two callers alone)
  const may = async (/** @type {string} */ who, project = "owners-matter") => { const def = /** @type {any} */ (d.registry).tools.get("work.project.may-read"); assert.ok(def, "work.project.may-read is registered"); return (await def.run({ project, person: who }, { caller: "module:memory" })).ok; };
  const stranger = d.registry.tools.get("work.project.may-read");
  await assert.rejects(() => stranger.run({ project: "owners-matter", person: ANA }, { caller: "cli" }), /Vyre asks this itself when it prepares a chat/, "nobody else may ask");
  assert.equal(await may(OWNER), true, "the Space's owner");
  assert.equal(await may(ADM), true, "an admin");
  assert.equal(await may(ANA), false, "a member who is not on the project");
  assert.equal(await may("-"), false, "a thread with nobody to judge (the placeholder person)");
  assert.equal(await may(ANA, "no-such-project"), true, "a name that matches no project has nothing to protect");
  // seated on the team, she does; Ben, still off it, does not
  await R.create(ownerChain, "team-member", { name: "ana", actor: person(ANA, SPACE), kind: "person", project: { urn: `vyre://${SPACE}/project/${(await R.query(ownerChain, "project", { filter: { field: "slug", op: "eq", value: "owners-matter" }, page: { limit: 1 } })).rows[0].id}` } });
  assert.equal(await may(ANA), true, "on the team: she may");
  assert.equal(await may(BEN), false, "another member still may not");
  // removed from the team, she may not again
  const seat = (await R.query(ownerChain, "team-member", { filter: { field: "kind", op: "eq", value: "person" }, page: { limit: 20 } })).rows.find((/** @type {any} */ r) => r.data.name === "ana");
  await R.remove(ownerChain, "team-member", seat.id, seat.version);
  assert.equal(await may(ANA), false, "removed from the team: she may not any more");
  // work.team.doing keeps a follower (a log subscription) per caller and project: only for a record she can read, never for a made-up address
  const anaToken = (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: "d-ana", person: ANA, path: "relay" }), {})).token;
  const real = (await R.query(ownerChain, "project", { filter: { field: "slug", op: "eq", value: "owners-matter" }, page: { limit: 1 } })).rows[0];
  const madeUp = await d.registry.call("work.team.doing", { project: `vyre://${SPACE}/project/00000000-0000-4000-8000-00000000dead` }, "cli", { token: anaToken });
  assert.equal(madeUp.error && madeUp.error.code, "not_found", "a made-up project address starts no follower: " + JSON.stringify(madeUp).slice(0, 160));
  const ok = await d.registry.call("work.team.doing", { project: real.urn }, "cli", { token: anaToken });
  assert.ok(!ok.error && ok.data && ok.data.lines, "an existing project does: " + JSON.stringify(ok).slice(0, 160));
  // a member's own memory tools asked for the owner's project room (the room argument) are refused: personal memory is read only by its person
  const benToken = (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "relay" }), {})).token;
  for (const tool of ["memory.relevant", "memory.facts", "memory.context"]) {
    const r = await d.registry.call(tool, { text: "plan", room: "owners-matter", project: "owners-matter" }, "cli", { token: benToken });
    assert.ok(r.error || !r.data || (Array.isArray(r.data) && r.data.length === 0) || (r.data && Object.values(r.data).every((/** @type {any} */ v) => !v || (Array.isArray(v) && !v.length))), `${tool} for the owner's project room is refused or empty for a member: ` + JSON.stringify(r).slice(0, 200));
  }
  assert.equal(await may(BEN, "ben-own"), true, "(no such project yet)");
});
