// @ts-check
// The Space's owner is in their own team's chats (0.3.3 G04): a stream call that names the team's Space runs in that Space under the owner's chain there, the member door's own entry. Real vyred, real hosted Space.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const OWNER = "per_" + "abcdefghijklmnopqrstuvwxyz", ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("the owner reads and speaks in a member's team chat from their own app; a stranger and a chat of another Space get nothing", { timeout: 90_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const firm = await d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });
  const facts = (/** @type {string} */ person) => ({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay", session: "s" });
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await firm.gateway.grants.setRole(owner, { person: ANA, role: "member" }, { presence: proof() });
  const svc = /** @type {any} */ (d.registry.modules.get("work")).handle.peerService({ space: firm.space, kernel: firm.kernel, registry: d.registry });
  const made = await svc.create(firm.kernel.chains.fromFacts(facts(ANA)), { title: "Huddle", people: [OWNER] });
  await svc.send(firm.kernel.chains.fromFacts(facts(ANA)), { chat: made.chat, text: "hello owner" });
  const token = (await firm.surfaces.open(owner, {})).token;   // the owner's own session in the Space, as their app holds it
  const asOwner = (/** @type {string} */ tool, /** @type {any} */ input, tok = token) => d.registry.call(tool, input, "deck", { token: tok });
  const seen = await asOwner("stream.catchup", { chat: made.chat, space: firm.space });
  assert.ok(!seen.error, JSON.stringify(seen));
  assert.match(JSON.stringify(seen.data), /hello owner/, "the owner reads what the member said");
  const sent = await asOwner("stream.send", { chat: made.chat, text: "hello Ana", space: firm.space });
  assert.ok(!sent.error, JSON.stringify(sent));
  assert.match(JSON.stringify(await svc.catchup(firm.kernel.chains.fromFacts(facts(ANA)), { chat: made.chat })), /hello Ana/, "and Ana reads what the owner said");
  assert.ok((await asOwner("stream.catchup", { chat: made.chat, space: firm.space }, "forged.token")).error, "a call with no session of the Space gets nothing");
  assert.ok((await asOwner("stream.catchup", { chat: made.chat, space: "spc_zzzzzzzzzzzz" })).error, "a Space this home does not host is refused");
});
