// @ts-check
// One persistent chat per person for the assistant and for @Engineer (R031-94), on a REAL vyred: the pin is the one chat, a second is refused and names the first, the Engineer's is for an owner or an admin only and
// must be a chat with the engineer agent, and the Chats list marks the pinned ones.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const used = new Set();
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("the assistant's and the Engineer's chats are one each per person: pinned, kept the same chat, refused twice, the Engineer's for an owner or an admin only", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => d.stop());
  const space = d.kernel.id.space, owner = d.kernel.id.owner, grants = d.kernel.gateway.grants;
  const BOB = "per_" + "b".repeat(26);
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  await grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: proof("grants.role", { person: BOB, role: "member" }, `vyre://${space}/member/${BOB}`) });
  const bobChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" });
  const as = async (/** @type {any} */ c) => ({ token: (await d.kernel.surfaces.open(c, {})).token });
  const call = async (/** @type {any} */ c, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await as(c));
  const engineer = { kind: "agent", id: "engineer", space };
  await grants.addActor(ownerChain, engineer, { presence: proof("grants.role", { actor: engineer }, `vyre://${space}/member/engineer`) });

  // the assistant: none yet, then one; the same chat when asked again; a second is refused and names the first
  assert.deepEqual((await call(ownerChain, "work.chat.persistent", { kind: "assistant" })).data, { kind: "assistant", chat: null, allowed: true });
  const a1 = await grants.chats.create(ownerChain, {}), a2 = await grants.chats.create(ownerChain, {});
  await until(async () => (await d.kernel.gateway.records.query(ownerChain, "chat-record", { filter: { field: "chat", op: "eq", value: a2.id }, page: { limit: 1 } })).rows[0], "the chat records");
  assert.equal((await call(ownerChain, "work.chat.pin", { kind: "assistant", chat: a1.id })).data.existing, false);
  assert.equal((await call(ownerChain, "work.chat.pin", { kind: "assistant", chat: a1.id })).data.existing, true, "pinning the same chat again is the same");
  // vyred asks which chat is the pinned assistant before it gives a session the assistant's authority; a person's CLI call may not
  assert.deepEqual((await d.registry.call("work.chat.pinned", { person: owner, chat: a1.id }, "module:vyred")).data, { kind: "assistant" });
  assert.deepEqual((await d.registry.call("work.chat.pinned", { person: owner, chat: a2.id }, "module:vyred")).data, { kind: null });
  assert.ok((await call(ownerChain, "work.chat.pinned", { person: owner, chat: a1.id })).error, "not callable by a person");
  const twice = await call(ownerChain, "work.chat.pin", { kind: "assistant", chat: a2.id });
  assert.equal(twice.error.code, "exists"); assert.match(twice.error.message, new RegExp(a1.id));
  assert.equal((await call(ownerChain, "work.chat.persistent", { kind: "assistant" })).data.chat, a1.id);
  const rows = (await call(ownerChain, "work.chat.list", {})).data.chats;
  assert.deepEqual([rows.find((/** @type {any} */ r) => r.chat === a1.id).pinned, rows.find((/** @type {any} */ r) => r.chat === a2.id).pinned], ["assistant", undefined]);
  assert.equal((await call(bobChain, "work.chat.pin", { kind: "assistant", chat: a1.id })).error.code, "not_found", "nobody pins another person's chat");

  // the Engineer: an owner or an admin, and only a chat with the engineer agent
  assert.equal((await call(bobChain, "work.chat.persistent", { kind: "engineer" })).data.allowed, false, "a member may not");
  const bobEng = await grants.chats.create(bobChain, { assistants: ["engineer"] });
  await until(async () => (await d.kernel.gateway.records.query(ownerChain, "chat-record", { filter: { field: "chat", op: "eq", value: bobEng.id }, page: { limit: 1 } })).rows[0], "bob's chat record");
  assert.equal((await call(bobChain, "work.chat.pin", { kind: "engineer", chat: bobEng.id })).error.code, "not_allowed");
  assert.equal((await call(ownerChain, "work.chat.persistent", { kind: "engineer" })).data.allowed, true);
  assert.equal((await call(ownerChain, "work.chat.pin", { kind: "engineer", chat: a2.id })).error.code, "bad_input", "a chat without the engineer is not the Engineer's");
  const e1 = await grants.chats.create(ownerChain, { assistants: ["engineer"] });
  await until(async () => (await d.kernel.gateway.records.query(ownerChain, "chat-record", { filter: { field: "chat", op: "eq", value: e1.id }, page: { limit: 1 } })).rows[0], "the engineer chat record");
  assert.equal((await call(ownerChain, "work.chat.pin", { kind: "engineer", chat: e1.id })).data.existing, false);
  assert.equal((await call(ownerChain, "work.chat.persistent", { kind: "engineer" })).data.chat, e1.id);
  // still exactly one of each, whatever is asked
  for (let i = 0; i < 5; i++) await call(ownerChain, "work.chat.pin", { kind: "assistant", chat: a1.id });
  const pins = d.registry.deps ? null : null; void pins;
  assert.deepEqual([(await call(ownerChain, "work.chat.persistent", { kind: "assistant" })).data.chat, (await call(ownerChain, "work.chat.persistent", { kind: "engineer" })).data.chat], [a1.id, e1.id]);
});
