// @ts-check
// The Engineer is one Space chat: exactly the people who may use it (owners and admins), made once with a device's ring, the gap reported for a device to apply, nothing for a member without access, and the
// chat_eng_ ids reserved to work.engineer.chat. Real daemon, kernel on. Run on a test box, never on a Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start, callerFacts } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { holdersOf, createRing } from "../../lib/chat-keys.js";
import { newDeviceKey } from "../../lib/keywrap.js";
import { toB64u, fromB64u } from "../../lib/databox.js";
import { engineerChatId } from "./threads.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", CY = "per_" + "defghijklmnopqrstuvwxyzabc", DEE = "per_" + "efghijklmnopqrstuvwxyzabcd";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("the Engineer chat has exactly the Engineer-access set; a member without access gets nothing; the prefix is reserved", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await K.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: proof() });
  await K.gateway.grants.setRole(ownerChain, { person: CY, role: "admin" }, { presence: proof() });
  const tok = async (/** @type {string} */ p) => (p === OWNER ? { kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) } : { token: (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s-" + p.slice(4, 8) }))).token });
  const as = async (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await tok(who));
  const ok = async (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await as(who, tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const dev = newDeviceKey(), agree = toB64u(Uint8Array.from([4, ...fromB64u(dev.publicJwk.x), ...fromB64u(dev.publicJwk.y)]));
  const id = engineerChatId(K.id.space), made = createRing(id, holdersOf([{ device: "dev_a", agree }]));

  // end to end: no ring, nothing made, and the answer names the id
  const need = await ok(OWNER, "work.engineer.chat");
  assert.deepEqual([need.chat, need.needs_ring, need.id], [null, true, id]);
  // a member without access learns nothing, before or after
  assert.equal((await as(BEN, "work.engineer.chat")).error?.code, "not_found");
  // the reserved prefix is refused on the other create paths
  for (const [tool, input] of /** @type {[string, any][]} */ ([["work.chat.create", { title: "x" }], ["work.chat.thread.new", { people: [BEN], title: "x" }], ["work.agent.thread.new", { agent: "engineer", title: "x" }], ["work.thread.fork", { thread: "chat_nothing", message: "m1" }]])) {
    assert.equal((await as(OWNER, tool, { ...input, id, ring: made.doc })).error?.code, "bad_input", `${tool} refuses the reserved id`);
  }
  const first = await ok(OWNER, "work.engineer.chat", { ring: made.doc });
  assert.equal(first.chat, id);
  assert.deepEqual([...first.people].sort(), [OWNER, CY].sort(), "owners and admins only");
  assert.deepEqual([first.missing, first.extra], [[], []]);
  assert.equal((await as(BEN, "work.engineer.chat")).error?.code, "not_found", "still nothing for a member");
  assert.ok((await as(BEN, "work.chat.get", { chat: id })).error, "and the chat is closed to her");
  assert.equal((await ok(CY, "work.engineer.chat")).chat, id, "an admin finds the same chat");
  // a new admin is a gap until a device applies it
  await K.gateway.grants.setRole(ownerChain, { person: DEE, role: "admin" }, { presence: proof() });
  const gap = await ok(CY, "work.engineer.chat");
  assert.deepEqual([gap.missing, gap.extra], [[DEE], []]);
  // a demoted admin is still in the chat until a device removes her: she shows in `extra`, and the tool removes nobody
  await K.gateway.grants.setRole(ownerChain, { person: CY, role: "member" }, { presence: proof() });
  const after = await ok(OWNER, "work.engineer.chat");
  assert.deepEqual([after.missing, after.extra], [[DEE], [CY]]);
  assert.ok(after.people.includes(CY), "and she is still a person of the chat");
});
