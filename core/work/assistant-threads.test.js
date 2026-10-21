// @ts-check
// The assistant's pinned chat lists nobody, and the threads started with the assistant by name are the same agent's. work.agent.threads lists all three, newest first, and work.chat.summary counts the same three on one row.
// Real daemon, kernel on. Run on a test box, never on a Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start, callerFacts } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { holdersOf, createRing } from "../../lib/chat-keys.js";
import { newDeviceKey } from "../../lib/keywrap.js";
import { toB64u, fromB64u } from "../../lib/databox.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("the assistant's pinned chat plus two more threads are three, and the summary agrees", { timeout: 240_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const cli = () => ({ kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) });
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await d.registry.call(tool, input, "cli", cli()); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const made = await d.registry.call("agents.create", { name: "juno", kind: "assistant", model: "opus", projects: "*" }, "module:onboard", {});
  assert.ok(!made.error, JSON.stringify(made.error));
  await ok("agents.create", { name: "kit", kind: "agent", model: "haiku" });
  const dev = newDeviceKey(), agree = toB64u(Uint8Array.from([4, ...fromB64u(dev.publicJwk.x), ...fromB64u(dev.publicJwk.y)]));
  let n = 0;
  const ring = () => { const id = `chat_00000000-0000-4000-8000-0000000003${String(++n).padStart(2, "0")}`; return { id, ring: createRing(id, holdersOf([{ device: "dev_a", agree }])).doc }; };
  const pinned = await ok("work.chat.create", { title: "Assistant", agents: [], ...ring() });
  await ok("work.chat.pin", { kind: "assistant", chat: pinned.chat });
  await new Promise(r => setTimeout(r, 1100));
  await ok("work.agent.thread.new", { agent: "juno", title: "first thread", ...ring() });
  await new Promise(r => setTimeout(r, 1100));
  await ok("work.agent.thread.new", { agent: "juno", title: "second thread", ...ring() });
  await ok("work.agent.thread.new", { agent: "kit", title: "kit only", ...ring() });

  const listed = await ok("work.agent.threads", { agent: "juno" });
  assert.equal(listed.count, 3, "the pinned chat and the two threads");
  assert.deepEqual(listed.threads.map((/** @type {any} */ x) => x.title), ["second thread", "first thread", "New thread"]);
  assert.ok(listed.threads.some((/** @type {any} */ x) => x.thread === pinned.chat), "the pinned chat is one of them");
  const byModel = await ok("work.agent.threads", { agent: "opus" });
  assert.equal(byModel.count, 3, "the model alias names the same agent");
  const row = (await ok("agents.list")).find((/** @type {any} */ a) => a.name === "juno");
  assert.ok(row && row.uid, "the assistant has an id");
  assert.equal((await ok("work.agent.threads", { agent: row.uid })).count, 3, "the agent id names the same threads");
  assert.deepEqual((await ok("work.agent.threads", { agent: "kit" })).threads.map((/** @type {any} */ x) => x.title), ["kit only"]);

  const sum = await ok("work.chat.summary");
  const asst = sum.pinned.find((/** @type {any} */ r) => r.agent === "juno" || r.name === "juno");
  assert.ok(asst, "the assistant is the pinned row");
  assert.equal(asst.threads, 3, "the summary counts the same three");
  assert.equal(asst.latest.title, "second thread");
  assert.equal(asst.items.length, 3, "each thread is there to search");
  assert.equal(sum.agents.some((/** @type {any} */ r) => r.name === "juno"), false, "the assistant is not also an agents row");
  assert.deepEqual(sum.agents.filter((/** @type {any} */ r) => r.name === "kit").map((/** @type {any} */ r) => r.threads), [1]);
});
