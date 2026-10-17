// @ts-check
// A member's held items through the real registry with the kernel: what a member's agent asks to send is the member's own item. The member sees and answers it; the owner, an admin and another member do not
// (they are told there is no such item); the owner's own items stay the owner's; a revoke wins at release.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, writeModule, present } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "bcdefghijklmnopqrstuvwxyza", CY = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

const COURIER = `export default { async start(ctx) {
  const got = [];
  ctx.tool("courier.release", { internal: true, run: (input, { caller }) => { got.push({ id: input.id, caller }); return { posted: true }; } });
  ctx.tool("courier.got", { run: () => got });
  const r = await ctx.call("gate.offer", { name: "courier:board", tool: "courier.release", content: { text: "string" } });
  if (r.error) throw new Error(r.error.message);
  return {};
} };`;

/** @param {import("node:test").TestContext} t */
async function rig(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box" }));
  writeModule(path.join(root, "modules"), "courier", { requires: ["gate"], does: { tools: ["courier.release", "courier.got"] } }, COURIER);
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null }, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  for (const p of [BEN, CY]) await K.gateway.grants.setRole(chain(OWNER), { person: p, role: "member" }, { presence: proof() });
  const ownerTok = (await K.surfaces.open(chain(OWNER), {})).token;
  const uid = (await d.registry.call("agents.create", { name: "juno", kind: "agent" }, "cli", { token: ownerTok })).data.uid;
  const as = async (/** @type {string} */ person, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "deck", { token: (await K.surfaces.open(chain(person), {})).token });
  const agentOf = async (/** @type {string} */ person, /** @type {string} */ tool, /** @type {any} */ input = {}) =>
    d.registry.call(tool, input, "mcp:agent:juno", { token: (await K.surfaces.open(chain(person), { agent: uid, session: "s-j-" + person.slice(4, 8), thread: "t-j-" + person.slice(4, 8) })).token, thread: "t-j-" + person.slice(4, 8), agent: "juno" });
  return { d, K, OWNER, as, agentOf };
}
const ASK = { kind: "send", via: "courier:board", to: "#northwind", content: { summary: "Weekly update", text: "Ovens are in." } };

test("a member's agent's send is the member's own item: the member sees and approves it, nobody else does", { timeout: 120_000 }, async t => {
  const { d, OWNER, as, agentOf } = await rig(t);
  const held = await agentOf(BEN, "gate.request", ASK);
  assert.ok(held.data && held.data.id, JSON.stringify(held));
  const id = held.data.id;
  assert.equal((await as(BEN, "gate.get", { id })).data.requester, BEN, "the requester is the person on the verified chain");
  assert.deepEqual((await as(BEN, "gate.held")).data.map((/** @type {any} */ i) => i.id), [id], "Ben sees it");
  // the owner, another member and a call with no person see nothing and are told there is no such item
  assert.deepEqual((await as(OWNER, "gate.held")).data, [], "the owner's list does not hold a member's item");
  assert.deepEqual((await as(CY, "gate.held")).data, []);
  for (const who of [OWNER, CY]) for (const tool of ["gate.get", "gate.approve", "gate.revise", "gate.reject"]) {
    const r = await as(who, tool, { id, ...(tool === "gate.revise" ? { edited: { text: "x" } } : {}) });
    assert.equal(r.error && r.error.code, "not_found", `${who === OWNER ? "owner" : "Cy"} ${tool}: ${JSON.stringify(r).slice(0, 160)}`);
  }
  assert.equal((await d.registry.call("gate.get", { id }, "local")).error?.code, "not_found", "a call with no person on its chain gets nothing of it");
  assert.deepEqual((await d.registry.call("courier.got", {}, "local")).data, [], "nothing was released");
  // the member approves it; it goes to the sender as module:gate
  const sent = await as(BEN, "gate.approve", { id });
  assert.equal(sent.data && sent.data.state, "sent", JSON.stringify(sent));
  assert.equal((await d.registry.call("courier.got", {}, "local")).data.length, 1);
});

test("the owner's own items and older items stay the owner's: a member never sees them, and the owner still does", { timeout: 120_000 }, async t => {
  const { as, OWNER } = await rig(t);
  const mine = await as(OWNER, "gate.request", ASK);
  assert.ok(mine.data && mine.data.id, JSON.stringify(mine));
  assert.equal((await as(OWNER, "gate.get", { id: mine.data.id })).data.requester, OWNER);
  assert.deepEqual((await as(OWNER, "gate.held")).data.map((/** @type {any} */ i) => i.id), [mine.data.id]);
  assert.deepEqual((await as(BEN, "gate.held")).data, [], "a member does not see the owner's items");
  assert.equal((await as(BEN, "gate.get", { id: mine.data.id })).error?.code, "not_found");
  assert.equal((await as(BEN, "gate.approve", { id: mine.data.id })).error?.code, "not_found");
});

test("two members who ask for the same thing hold two items, each their own", { timeout: 120_000 }, async t => {
  const { as, agentOf } = await rig(t);
  const a = (await agentOf(BEN, "gate.request", ASK)).data.id, b = (await agentOf(CY, "gate.request", ASK)).data.id;
  assert.notEqual(a, b);
  assert.deepEqual((await as(BEN, "gate.held")).data.map((/** @type {any} */ i) => i.id), [a]);
  assert.deepEqual((await as(CY, "gate.held")).data.map((/** @type {any} */ i) => i.id), [b]);
  assert.equal((await as(BEN, "gate.reject", { id: b })).error?.code, "not_found", "Ben cannot discard Cy's item");
});

test("a call with no person on its chain, or a member, gets nothing of the owner's items on any of the five tools; the owner's own surfaces still handle them", { timeout: 180_000 }, async t => {
  const { d, K, OWNER, as } = await rig(t);
  const mk = async () => (await as(OWNER, "gate.request", ASK)).data.id;
  const id = await mk();
  const five = (/** @type {string} */ i) => [["gate.get", { id: i }], ["gate.approve", { id: i }], ["gate.revise", { id: i, edited: { text: "x" } }], ["gate.reject", { id: i }]];
  // (a) a non-module call with no person (no token: the registry gives it no verified person) and a member: not_found, and nothing listed
  for (const [tool, input] of five(id)) {
    assert.equal((await d.registry.call(tool, input, "local")).error?.code, "not_found", `no person: ${tool}`);
    assert.equal((await as(BEN, tool, input)).error?.code, "not_found", `member: ${tool}`);
  }
  assert.deepEqual((await d.registry.call("gate.held", {}, "local")).data, [], "no person: nothing listed");
  assert.deepEqual((await as(BEN, "gate.held")).data, [], "a member: nothing listed");
  // (b) the presence line is one fixed sentence: the same for the owner's item and for an id that does not exist, and none of the item's words
  const line = await d.registry.tools.get("gate.approve").presence.summary({ id });
  assert.equal(line, await d.registry.tools.get("gate.approve").presence.summary({ id: "ffffffffffffffffff" }));
  for (const word of ["Weekly update", "Ovens", "northwind", "courier"]) assert.ok(!line.toLowerCase().includes(word.toLowerCase()), word);
  // (c) the owner's own surfaces (cli, deck, local, each with the owner's verified token) still see, approve and reject the owner's own items
  for (const caller of ["cli", "deck", "local"]) {
    const token = (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: "d-own", person: OWNER, path: "direct", session: "s" }), {})).token;
    const one = await mk();
    assert.equal((await d.registry.call("gate.get", { id: one }, caller, { token })).data?.id, one, `${caller} gets`);
    assert.ok((await d.registry.call("gate.held", {}, caller, { token })).data.some((/** @type {any} */ i) => i.id === one), `${caller} lists`);
    assert.equal((await d.registry.call("gate.reject", { id: one }, caller, { token })).data?.state, "rejected", `${caller} rejects`);
  }
  const sent = await as(OWNER, "gate.approve", { id });
  assert.equal(sent.data?.state, "sent", "the owner approves their own item: " + JSON.stringify(sent));
});
