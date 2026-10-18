// @ts-check
// Adding people to a chat of several people takes every thread of it, one ring per thread from the device: a thread without its ring is left as it is and returned, the call can be repeated, a project's chat and
// a thread with an agent are refused, a person outside the chat finds nothing, and a person added has no AI key of anyone's lent to them. Real daemon, kernel on. Run on a test box, never on a Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start, callerFacts } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { holdersOf, createRing, addHolders } from "../../lib/chat-keys.js";
import { newDeviceKey, fingerprint } from "../../lib/keywrap.js";
import { toB64u, fromB64u } from "../../lib/databox.js";
import { askerOver } from "../switchboard/asker-account.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", CY = "per_" + "defghijklmnopqrstuvwxyzabc", DEE = "per_" + "efghijklmnopqrstuvwxyzabcd";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a group's threads all take the new people, a thread without a ring waits, and nothing else changes", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const p of [BEN, CY, DEE]) await K.gateway.grants.setRole(ownerChain, { person: p, role: "member" }, { presence: proof() });
  const tok = async (/** @type {string} */ p) => (p === OWNER ? { kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) } : { token: (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s-" + p.slice(4, 8) }))).token });
  const as = async (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await tok(who));
  const ok = async (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await as(who, tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  await ok(OWNER, "agents.create", { name: "juno", kind: "agent" });
  const dev = newDeviceKey(), agree = toB64u(Uint8Array.from([4, ...fromB64u(dev.publicJwk.x), ...fromB64u(dev.publicJwk.y)]));
  let n = 0;
  /** @type {Map<string, any>} */ const made = new Map();
  const ring = () => { const id = `chat_00000000-0000-4000-8000-0000000001${String(++n).padStart(2, "0")}`; const r = createRing(id, holdersOf([{ device: "dev_a", agree }])); made.set(id, r); return { id, ring: r.doc }; };
  const nd = newDeviceKey();
  const grow = (/** @type {string} */ thread) => addHolders(made.get(thread).doc, made.get(thread).keys, { add: { [fingerprint(nd.publicJwk)]: nd.publicJwk } });

  const g1 = await ok(OWNER, "work.chat.thread.new", { people: [BEN], title: "g1", ...ring() });
  const g2 = await ok(OWNER, "work.chat.thread.new", { people: [BEN], title: "g2", ...ring() });
  assert.equal(g1.chat, g2.chat);
  // only one thread's ring: that thread takes Cy, the other waits and is returned
  const half = await ok(OWNER, "work.chat.add-people", { chat: g1.chat, people: [CY], rings: { [g1.thread]: grow(g1.thread) } });
  assert.deepEqual([half.changed, half.missing_rings, half.done], [[g1.thread], [g2.thread], false]);
  assert.ok(!(await as(CY, "work.chat.get", { chat: g1.thread })).error, "Cy reads the thread that took her");
  assert.ok((await as(CY, "work.chat.get", { chat: g2.thread })).error, "and not the one that waits");
  // repeated with the other ring: it finishes, and the new chat holds both threads
  const rest = await ok(OWNER, "work.chat.add-people", { chat: g2.thread, people: [CY], rings: { [g2.thread]: grow(g2.thread) } });
  assert.deepEqual([rest.changed, rest.done], [[g2.thread], true]);
  const both = await ok(OWNER, "work.chat.threads", { people: [BEN, CY] });
  assert.equal(both.count, 2, "both threads are threads of the chat of me, Ben and Cy");
  assert.equal(both.chat, rest.chat);
  // a person outside the chat finds nothing; nothing to add and a thread with an agent are refused
  assert.equal((await as(DEE, "work.chat.add-people", { chat: g1.chat, people: [DEE], rings: {} })).error?.code, "not_found");
  assert.equal((await as(OWNER, "work.chat.add-people", { chat: rest.chat, people: [CY], rings: {} })).error?.code, "bad_input");
  const solo = await ok(OWNER, "work.agent.thread.new", { agent: "juno", title: "solo", ...ring() });
  assert.equal((await as(OWNER, "work.chat.add-people", { chat: solo.thread, people: [DEE], rings: {} })).error?.code, "bad_input");
  // a person who is not in the chat cannot add people to it, even when she holds a ring
  assert.equal((await as(DEE, "work.chat.add-people", { chat: g2.thread, people: [BEN], rings: { [g2.thread]: grow(g2.thread) } })).error?.code, "not_found");
});

test("a person added to a chat is given no AI key: a thread that runs on another person's sign-in refuses her turn", async () => {
  const sb = { record: () => ({ provider: "claude", account: "bens" }), deps: { owner: () => "per_owner" }, accountFor: async (/** @type {any} */ q) => { if (q.account) throw new Error("no such account"); return null; }, canon: (/** @type {string} */ p) => p };
  await assert.rejects(askerOver(/** @type {any} */ (sb), "t", { asker: CY }), (/** @type {any} */ e) => e.code === "account_required" && /sign-in of your own/.test(e.message));
});
