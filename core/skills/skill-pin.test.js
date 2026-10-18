// @ts-check
// A task pins a Space skill (tasks v2): skills.pin answers with the hash of the whole SKILL.md and the "- [ ]" lines under its "## Checklist" heading, as the person asking, on a REAL vyred with the kernel on. A skill
// the person may not use answers exactly like one that is not there; a malformed checklist is refused; only the kernel's callInSpace path runs it. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { createMemberTools } from "../work/member-tools.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const skill = (/** @type {string} */ name, /** @type {string} */ tail) => `---\nname: ${name}\ndescription: Use this when the person asks about ${name}, which is a checked thing\n---\nDo it well.\n${tail}`;

test("skills.pin: hash and checklist for a skill the person may use; the same answer for one she may not; a malformed checklist is refused", { timeout: 90_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, space = d.kernel.id.space;
  const facts = (/** @type {string} */ person) => ({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await d.kernel.gateway.grants.setRole(ownerChain, { person, role: "member" }, { presence: proof() });
  const svc = createMemberTools({ space, kernel: d.kernel, registry: d.registry }).skills;
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts(facts(person));
  const make = async (/** @type {string} */ name, /** @type {string} */ tail) => { const dr = await svc.draft(chainOf(ANA), { name, level: "personal", body: skill(name, tail) }); await svc.approve(chainOf(ANA), { name, level: "personal", version: dr.version }); };
  const pin = (/** @type {string} */ person, /** @type {string} */ id) => d.registry.callInSpace({ name: "vyred" }, space, { gateway: d.kernel.gateway }, "skills.pin", { id }, chainOf(person));

  await make("ana-check", "\n## Checklist\n- [ ] names the firm\n- [ ] no jargon\n\n## Notes\nbe kind\n");
  const ok = await pin(ANA, "personal/ana-check");
  assert.ok(!ok.error, JSON.stringify(ok));
  assert.deepEqual(ok.data.checklist, ["names the firm", "no jargon"]);
  assert.match(ok.data.hash, /^[0-9a-f]{64}$/);
  assert.equal((await pin(ANA, "personal/ana-check")).data.hash, ok.data.hash, "the same bytes, the same hash");
  await make("ana-check", "\n## Checklist\n- [ ] names the firm\n- [ ] no jargon\n- [ ] kind\n");
  assert.notEqual((await pin(ANA, "personal/ana-check")).data.hash, ok.data.hash, "an edit changes the hash");

  // Ben may not use Ana's personal skill: exactly the words of a skill that is not there
  const ben = await pin(BEN, "personal/ana-check"), gone = await pin(BEN, "personal/ana-check-nope");
  assert.equal(ben.error.code, "not_found");
  assert.equal(ben.error.message.replace("ana-check", "X"), gone.error.message.replace("ana-check-nope", "X"));

  await make("no-list", "\nJust prose.\n");
  assert.deepEqual((await pin(ANA, "personal/no-list")).data.checklist, [], "no Checklist heading, no items");
  await make("bad-list", "\n## Checklist\n- [ ] fine\nand some prose\n");
  assert.equal((await pin(ANA, "personal/bad-list")).error.code, "bad_input");
  await make("empty-list", "\n## Checklist\n\n## Next\nx\n");
  assert.equal((await pin(ANA, "personal/empty-list")).error.code, "bad_input");

  // "Space skills only" (a template's stage pins for everyone who works its tasks): Vyre's own skill passes, a personal one answers exactly like a skill that is not there
  const pinOnly = (/** @type {string} */ person, /** @type {string} */ id) => d.registry.callInSpace({ name: "vyred" }, space, { gateway: d.kernel.gateway }, "skills.pin", { id, space_only: true }, chainOf(person));
  assert.ok(!(await pinOnly(ANA, "vyre/use-the-vault")).error, "a Vyre skill is a Space skill");
  const own = await pinOnly(ANA, "personal/ana-check"), nope = await pinOnly(ANA, "personal/ana-check-nope");
  assert.equal(own.error.code, "not_found");
  assert.equal(own.error.message.replace("ana-check", "X"), nope.error.message.replace("ana-check-nope", "X"));

  // only the kernel's path runs it: a plain registry call carries no proven chain
  const bare = await d.registry.call("skills.pin", { id: "personal/ana-check" }, "module:vyred");
  assert.equal(bare.error.code, "not_found");

  // the pin and the agent maker are set once by the daemon: no handle a module is given carries either, and a second set is refused
  const handle = /** @type {any} */ (d.kernel).kernelFor ? d.kernel.kernelFor({ name: "probe" }) : {};
  for (const k of ["setSkillPin", "setAgentMaker"]) assert.equal(k in handle, false, `${k} is not on a module's handle`);
  assert.throws(() => /** @type {any} */ (d.kernel).setSkillPin(async () => null), /set once/);
});
