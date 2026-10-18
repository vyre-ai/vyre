// @ts-check
// Agents are persistent and each has many threads. A thread is a chat of one person and one agent. work.agent.thread.new makes another chat with the same agent and leaves the old ones alone; work.agent.threads
// lists the caller's own, newest first; a chat with another person or another agent in it is not a thread with this agent; another member sees none of them. Real daemon, kernel on. Run on a test box, never on a Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { holdersOf, createRing } from "../../lib/chat-keys.js";
import { newDeviceKey } from "../../lib/keywrap.js";
import { toB64u, fromB64u } from "../../lib/databox.js";
import { threadRow } from "./threads.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a thread row says live, needs you or idle, and needs you wins", () => {
  const rec = { data: { chat: "chat_1", title: "", agents: ["juno"], started: "2026-10-18T01:00:00Z", last_active: "2026-10-18T02:00:00Z" } };
  assert.equal(threadRow(rec, [], 0).state, "idle");
  assert.equal(threadRow(rec, [{ live: true, needs: 0 }], 0).state, "live");
  assert.equal(threadRow(rec, [{ live: true, needs: 2 }], 3).state, "needs_you");
  assert.equal(threadRow(rec, [], 0).title, "New thread", "an untitled thread has a plain name");
  assert.deepEqual(threadRow({ data: { ...rec.data, forked_from: { thread: "chat_0", message: "m1" } } }, [], 0).forked_from, { thread: "chat_0", message: "m1" });
  assert.equal(threadRow(rec, [{ last_line: "hello", last: 5 }], 0).last_line, "hello");
});

test("two threads with one agent, newest first; a group chat, another agent's chat and another member's view are not threads with it", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await K.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: proof() });
  const tok = async (/** @type {string} */ p) => ({ token: (await K.surfaces.open(p === OWNER ? ownerChain : K.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: p, path: "direct", session: "sb" }), {})).token });
  const as = async (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await tok(who));
  const ok = async (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await as(who, tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  for (const name of ["juno", "kit"]) await ok(OWNER, "agents.create", { name, kind: "agent" });
  const dev = newDeviceKey(), agree = toB64u(Uint8Array.from([4, ...fromB64u(dev.publicJwk.x), ...fromB64u(dev.publicJwk.y)]));
  let n = 0;
  const ring = () => { const id = `chat_00000000-0000-4000-8000-0000000000${String(++n).padStart(2, "0")}`; return { id, ring: createRing(id, holdersOf([{ device: "dev_a", agree }])).doc }; };
  const newThread = (/** @type {string} */ agent, /** @type {string} */ title) => ok(OWNER, "work.agent.thread.new", { agent, title, ...ring() });

  assert.deepEqual((await ok(OWNER, "work.agent.threads", { agent: "juno" })).threads, [], "no threads yet");
  const first = await newThread("juno", "first thread");
  await new Promise(r => setTimeout(r, 1100));
  const second = await newThread("juno", "second thread");
  assert.notEqual(first.thread, second.thread, "/new makes another chat");
  // another agent's thread, and a chat with a person in it too: neither is a thread with juno
  await newThread("kit", "kit's thread");
  await ok(OWNER, "work.chat.create", { title: "with ben", people: [BEN], agents: ["juno"], ...ring() });

  const listed = await ok(OWNER, "work.agent.threads", { agent: "juno" });
  assert.deepEqual(listed.threads.map((/** @type {any} */ x) => x.title), ["second thread", "first thread"], "newest first");
  assert.equal(listed.count, 2);
  assert.ok(listed.threads.every((/** @type {any} */ x) => x.state === "idle" && x.forked_from === null && x.agent), "idle, not forked, with its agent");
  assert.deepEqual((await ok(OWNER, "work.agent.threads", { agent: "kit" })).threads.map((/** @type {any} */ x) => x.title), ["kit's thread"]);
  // an old thread is still there and still its own chat, untouched by the new one
  const got = await ok(OWNER, "work.chat.get", { chat: first.thread });
  assert.equal(got.chat.title, "first thread");
  // paging: only older than the newest
  const page = await ok(OWNER, "work.agent.threads", { agent: "juno", before: listed.threads[0].last_active });
  assert.deepEqual(page.threads.map((/** @type {any} */ x) => x.title), ["first thread"]);
  assert.equal((await ok(OWNER, "work.agent.threads", { agent: "juno", limit: 1 })).threads.length, 1);
  // another member sees none of the owner's threads
  assert.deepEqual((await ok(BEN, "work.agent.threads", { agent: "juno" })).threads.map((/** @type {any} */ x) => x.title), [], "a member sees only her own");
  // a call that is no person's own is refused
  assert.ok((await d.registry.call("work.agent.threads", { agent: "juno" }, "mcp", {})).error, "a call with no person has no threads");
});
