// @ts-check
// A fresh owner's chat with the Assistant starts. The first-run Assistant is made by the onboarding module's call, which carries no person, so agents.create leaves it without a place in the Space (becomeActor); a thread
// started with it lists it as a chat's assistant, which the kernel allows only for an actor of the Space. Real daemon, kernel on. Run on a test box, never on a Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start, callerFacts } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { holdersOf, createRing } from "../../lib/chat-keys.js";
import { newDeviceKey } from "../../lib/keywrap.js";
import { toB64u, fromB64u } from "../../lib/databox.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a thread with the Assistant starts, and starting it does not make a member's own agent an actor of the Space", { timeout: 240_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await K.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: proof() });
  const tok = async (/** @type {string} */ p) => (p === OWNER ? { kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) } : { token: (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: `d-${p}`, person: p, path: "relay" }), {})).token });
  const as = async (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await tok(who));
  // what first-run does: the module makes the Assistant, with no person on the call
  const made = await d.registry.call("agents.create", { name: "juno", kind: "assistant", projects: "*" }, "module:onboard", {});
  assert.ok(!made.error, JSON.stringify(made.error));
  // and a member's own agent, made the same way, which the Space has not accepted
  const other = await d.registry.call("agents.create", { name: "kit", kind: "agent" }, "module:onboard", {});
  assert.ok(!other.error, JSON.stringify(other.error));
  const dev = newDeviceKey(), agree = toB64u(Uint8Array.from([4, ...fromB64u(dev.publicJwk.x), ...fromB64u(dev.publicJwk.y)]));
  let n = 0;
  const ring = () => { const id = `chat_00000000-0000-4000-8000-0000000002${String(++n).padStart(2, "0")}`; return { id, ring: createRing(id, holdersOf([{ device: "dev_a", agree }])).doc }; };
  const first = await as(OWNER, "work.agent.thread.new", { agent: "juno", title: "hello", ...ring() });
  assert.ok(!first.error, `the Assistant's thread starts: ${JSON.stringify(first.error)}`);
  const again = await as(OWNER, "work.agent.thread.new", { agent: "juno", title: "second", ...ring() });
  assert.ok(!again.error, JSON.stringify(again.error));
  const listed = await as(OWNER, "work.agent.threads", { agent: "juno" });
  assert.equal(listed.data.threads.length, 2, "both threads are the Assistant's");
  // the exception is the Assistant and the built-in agents only: an agent nobody accepted is still refused
  const refused = await as(OWNER, "work.agent.thread.new", { agent: "kit", title: "x", ...ring() });
  assert.match(String(refused.error && refused.error.message), /belongs to the Space/);
});
