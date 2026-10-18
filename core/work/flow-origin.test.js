// @ts-check
// "How it was made": a draft Flow made from a chat (flows.from-chat with the chat) remembers that chat, and the Flow's threads show it to a person who is in the chat. A chat the maker is not in is not kept.
// Real daemon, kernel on. Run on a test box, never on a Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start, callerFacts } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a Flow drafted from a chat has a 'How it was made' thread for those in that chat only", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await K.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: proof() });
  const call = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) });
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await call(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  await K.gateway.records.define(ownerChain, { add_types: [{ name: "dossier", label: "Dossier", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Engagement"] }], stages: [{ name: "Intake" }, { name: "Engagement" }] }] });
  const mine = await K.gateway.grants.chats.create(ownerChain, {});
  const bens = await K.gateway.grants.chats.create(K.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "direct", session: "s-ben" }), {});
  const calls = [{ tool: "work_call", input: { tool: "dossiers.create", input: { data: { name: "Rivera" } } } }];
  const a = await ok("flows.from-chat", { name: "Open a dossier", calls, chat: mine.id });
  assert.ok(a.ok, JSON.stringify(a));
  const threads = await ok("work.flow.threads", { flow: a.id });
  assert.deepEqual([threads.made.kind, threads.made.chat, threads.made.title], ["made", mine.id, "How it was made"]);
  // a draft made with no chat, or naming a chat the maker is not in, has none
  const b = await ok("flows.from-chat", { name: "Open another dossier", calls });
  assert.equal((await ok("work.flow.threads", { flow: b.id })).made, undefined);
  const c = await ok("flows.from-chat", { name: "Open a third dossier", calls, chat: bens.id });
  assert.equal((await ok("work.flow.threads", { flow: c.id })).made, undefined, "a chat the maker is not in is not kept");
  // only the flows module may keep an origin
  assert.ok((await call("work.flow.origin", { flow: a.id, chat: bens.id })).error, "no person keeps one by hand");
});
