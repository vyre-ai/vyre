// @ts-check
// Home Space plus a hosted team Space on one vyred: personal skills follow the identity kernel in the team Space, space skills win on name, members cannot read another person's personal library.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { canonical } from "../kernel/core/canonical.js";
import { createMemberTools } from "../core/work/member-tools.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const used = new Set();
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const skill = (/** @type {string} */ name, /** @type {string} */ about) => `---\nname: ${name}\ndescription: ${about}\n---\n\n# ${name}\n\nBody.\n`;
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";

test("browse on a team Space: space skill wins on name, personal stays private, member sees browse not owner secrets", { timeout: 180_000 }, async (t) => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const home = d.kernel.id.space;
  const firm = await d.kernel.spaces.host({ owner, name: "firmdev" });
  const team = firm.space;
  assert.notEqual(team, home);
  const ownerTeamChain = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "relay" });
  await firm.gateway.grants.setRole(ownerTeamChain, { person: ANA, role: "member" }, { presence: { op: "stand-in", fields: {}, n: "m1" } });
  const door = createMemberTools({ space: team, kernel: firm, registry: d.registry }).skills;
  const as = (/** @type {string} */ person, /** @type {string} */ call, /** @type {any} */ input = {}) => {
    const chain = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
    return door[call](chain, input);
  };
  const draftApprove = async (/** @type {string} */ person, /** @type {any} */ body) => {
    const dft = await as(person, "draft", body);
    return as(person, "approve", { name: body.name, level: body.level, version: dft.version });
  };
  await draftApprove(owner, { name: "house-style", level: "space", body: skill("house-style", "Space wording for everyone in this Space.") });
  await draftApprove(owner, { name: "house-style", level: "personal", body: skill("house-style", "My own wording that must not override the Space skill.") });
  await draftApprove(owner, { name: "owner-secret", level: "personal", body: skill("owner-secret", "Only the owner carries this across Spaces.") });
  const browse = await as(owner, "browse", { level: "space" });
  assert.ok(browse.skills.some((/** @type {any} */ s) => s.id === "space/house-style" && (s.harnesses || []).includes("codex")), "browse lists harness chips");
  const findInTeam = await door.browse(ownerTeamChain, { level: "space" });
  assert.ok(findInTeam.skills.some((/** @type {any} */ s) => s.id === "space/house-style" && s.name === "house-style"));
  const anaBrowse = await as(ANA, "browse", { level: "personal" });
  assert.ok(!JSON.stringify(anaBrowse).includes("owner-secret"), "another member never sees the owner's personal skill in browse");
  await draftApprove(ANA, { name: "ana-cross", level: "personal", body: skill("ana-cross", "Ana personal across team Spaces.") });
  const anaList = await as(ANA, "list", {});
  assert.ok(anaList.skills.some((/** @type {any} */ s) => s.id === "personal/ana-cross"));
  assert.ok(!anaList.skills.some((/** @type {any} */ s) => s.id === "personal/owner-secret"));
  const ownerPersonal = await as(owner, "browse", { level: "personal" });
  assert.ok(ownerPersonal.skills.some((/** @type {any} */ s) => s.id === "personal/owner-secret"), "the owner's personal skill drafted in the team Space is visible to them there (identity kernel)");
});
