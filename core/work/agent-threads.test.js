// @ts-check
// Agents are persistent and each has many threads. A thread is a chat of one person and one agent. work.agent.thread.new makes another chat with the same agent and leaves the old ones alone; work.agent.threads
// lists the caller's own, newest first; a chat with another person or another agent in it is not a thread with this agent; another member sees none of them. Real daemon, kernel on. Run on a test box, never on a Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start, callerFacts } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { holdersOf, createRing } from "../../lib/chat-keys.js";
import { newDeviceKey } from "../../lib/keywrap.js";
import { toB64u, fromB64u } from "../../lib/databox.js";
import { threadRow } from "./threads.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", CY = "per_" + "defghijklmnopqrstuvwxyzabc";
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
  await K.gateway.grants.setRole(ownerChain, { person: CY, role: "member" }, { presence: proof() });
  // the owner acts directly, as the CLI does (a chat is started by a person acting directly); Ben is a member with a session of his own
  const tok = async (/** @type {string} */ p) => (p === OWNER ? { kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) } : { token: (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: p, path: "direct", session: "sb" }), {})).token });
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

  // the chat list as one summary: one row per agent with its thread count, the group and the person chat apart
  await ok(OWNER, "work.chat.create", { title: "ben dm", people: [BEN], ...ring() });
  const sum = await ok(OWNER, "work.chat.summary");
  assert.deepEqual(sum.agents.map((/** @type {any} */ r) => [r.name, r.threads]).sort(), [["juno", 2], ["kit", 1]], "one row per agent, with its thread count");
  const juno = sum.agents.find((/** @type {any} */ r) => r.name === "juno");
  assert.equal(juno.kind, "agent");
  assert.equal(juno.latest.title, "second thread", "the latest thread");
  assert.equal(juno.live, null, "no thread is live");
  assert.equal(juno.needs_you, false);
  // one chat per set of people: "ben dm" and "with ben" are two threads of the one chat of me and Ben
  assert.equal(sum.groups.length, 0, "no group yet");
  assert.deepEqual(sum.people.map((/** @type {any} */ r) => [r.kind, r.person, r.threads]), [["person", BEN, 2]], "the chat of me and Ben has its two threads");
  assert.equal(sum.people[0].agents, 1, "and juno is in one of them");
  assert.deepEqual([sum.pinned, sum.flows], [[], []]);
  // Ben's summary has only what he is in: the group and the dm, and none of the owner's agent threads
  const bens = await ok(BEN, "work.chat.summary");
  assert.deepEqual([bens.agents.length, bens.groups.length, bens.people.length], [0, 0, 1], "a member's list is her own chats");
  assert.equal(bens.people[0].person, OWNER);
  assert.equal(bens.people[0].threads, 2);
  assert.ok((await d.registry.call("work.chat.summary", {}, "mcp", {})).error, "a call with no person has no list");

  // where a chat lives is derived: only me is Personal; anyone else in it makes it a Space chat; a chat shared with Ben is in Ben's list although it sits in the owner's Personal project
  assert.equal(juno.place, "personal", "an agent thread of mine is Personal");
  assert.equal(sum.people[0].place, "space");
  assert.deepEqual(sum.people[0].faces.people.map((/** @type {any} */ f) => f.id).sort(), [OWNER, BEN].sort(), "the faces are the people, with ids");
  assert.deepEqual(sum.people[0].faces.agents.map((/** @type {any} */ f) => f.name), ["juno"], "and the agents, by name");
  assert.ok(sum.people[0].faces.people.every((/** @type {any} */ f) => "name" in f), "each face has a name field");
  const benList = (await ok(BEN, "work.chat.list")).chats;
  assert.deepEqual(benList.map((/** @type {any} */ r) => r.title).sort(), ["ben dm", "with ben"], "Ben sees the threads he is in (the group threads come later in this test)");
  assert.ok(benList.every((/** @type {any} */ r) => r.place === "space" && Array.isArray(r.faces.people)), "and they are Space chats");
  // a group is a set of three: /new in it makes another thread in the same chat, whatever order the people are named in
  const g1 = await ok(OWNER, "work.chat.thread.new", { people: [BEN, CY], title: "g1", ...ring() });
  await new Promise(r => setTimeout(r, 1100));
  const g2 = await ok(OWNER, "work.chat.thread.new", { people: [CY, BEN], title: "g2", ...ring() });
  assert.notEqual(g1.thread, g2.thread);
  assert.equal(g1.chat, g2.chat, "the same people are the same chat");
  const grp = await ok(OWNER, "work.chat.threads", { chat: g1.chat });
  assert.deepEqual([grp.kind, grp.count, grp.place, grp.people.length], ["group", 2, "space", 3]);
  assert.deepEqual(grp.threads.map((/** @type {any} */ x) => x.title), ["g2", "g1"], "newest first");
  assert.equal((await ok(OWNER, "work.chat.threads", { chat: g2.thread })).chat, g1.chat, "a thread id names its chat");
  assert.deepEqual((await ok(CY, "work.chat.threads", { chat: g1.chat })).threads.map((/** @type {any} */ x) => x.title), ["g2", "g1"], "everyone in the group sees all its threads");
  const dm = await ok(OWNER, "work.chat.threads", { people: [BEN] });
  assert.deepEqual([dm.exists, dm.kind, dm.count], [true, "person", 2], "the chat of exactly me and Ben, by its people");
  assert.equal((await ok(OWNER, "work.chat.threads", { people: [CY] })).exists, false, "no chat of me and Cy yet");
  assert.equal((await as(CY, "work.chat.threads", { chat: first.thread })).error?.code, "not_found", "a thread Cy is not in is not found");
  assert.deepEqual((await ok(OWNER, "work.chat.summary")).groups.map((/** @type {any} */ r) => [r.threads, r.people]), [[2, 3]], "the group is one row with its two threads");
  const ownerList = (await ok(OWNER, "work.chat.list")).chats;
  assert.ok(ownerList.every((/** @type {any} */ r, /** @type {number} */ i, /** @type {any[]} */ all) => i === 0 || String(all[i - 1].last_active) >= String(r.last_active)), "newest first");
  assert.deepEqual(ownerList.filter((/** @type {any} */ r) => r.place === "personal").map((/** @type {any} */ r) => r.title).sort(), ["first thread", "kit's thread", "second thread"]);
});

test("a Flow's runs are its threads, and the chat list has one row per Flow with runs", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel;
  const cli = () => ({ kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) });
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await d.registry.call(tool, input, "cli", cli()); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  assert.deepEqual((await ok("work.chat.summary")).flows, [], "no Flow has run");
  assert.deepEqual((await ok("work.flow.threads", { flow: "nothing" })).threads, [], "a Flow with no runs has no threads");
  const flow = { format: 1, name: "census_flow", label: "Census", authorship: "human", trigger: { on: "manual" }, steps: [] };
  const def = await ok("flows.define", { flow });
  await ok("flows.approve", { id: def.id, version: def.version, hash: def.hash });
  const started = await ok("flows.start", { id: def.id });
  const runId = started.run || started.id;
  assert.ok(runId, JSON.stringify(started));
  await new Promise(r => setTimeout(r, 1500));
  const threads = (await ok("work.flow.threads", { flow: def.id })).threads;
  assert.equal(threads.length, 1);
  assert.deepEqual([threads[0].kind, threads[0].id, threads[0].flow], ["run", runId, def.id]);
  assert.ok(["live", "idle", "needs_you"].includes(threads[0].state));
  const rows = (await ok("work.chat.summary")).flows;
  assert.deepEqual(rows.map((/** @type {any} */ r) => [r.kind, r.flow, r.runs]), [["flow", def.id, 1]]);
  assert.equal(rows[0].latest.id, runId);
  assert.ok((await d.registry.call("work.flow.threads", { flow: def.id }, "mcp", {})).error, "a call with no person reads none");
});
