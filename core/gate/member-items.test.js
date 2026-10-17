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
  // A member's agent reaches the Gate through a module's tool (mail.send, microsoft.mail.send ...), which files the request in the agent's own turn: the door keeps gate.request itself to the owner, and a module call is not at
  // the door. The courier stands in for that module with the agent's token, so the Gate sees the same verified chain.
  const agentOf = async (/** @type {string} */ person, /** @type {string} */ tool, /** @type {any} */ input = {}) =>
    d.registry.call(tool, input, tool === "gate.request" ? "module:courier" : "mcp:agent:juno", { token: (await K.surfaces.open(chain(person), { agent: uid, session: "s-j-" + person.slice(4, 8), thread: "t-j-" + person.slice(4, 8) })).token, thread: "t-j-" + person.slice(4, 8), agent: "juno" });
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

const ADA = "per_" + "defghijklmnopqrstuvwxyzabc";

test("the Gate's events for a member's item carry no destination, preview or reason, so the bus an admin reads shows none of what a member asked to send; the owner's own items keep theirs", { timeout: 120_000 }, async t => {
  const { d, as, agentOf, OWNER } = await rig(t);
  const bens = (await agentOf(BEN, "gate.request", ASK)).data.id;
  await as(BEN, "gate.reject", { id: bens, reason: "Weekly update is wrong" });
  const mine = (await as(OWNER, "gate.request", ASK)).data.id;
  const events = d.registry.deps.events.since(0, { limit: 5000 }).filter((/** @type {any} */ e) => /^gate\./.test(e.type));
  const of = (/** @type {string} */ id) => events.filter((/** @type {any} */ e) => e.payload && e.payload.id === id);
  assert.ok(of(bens).length >= 2, "Ben's item raised held and rejected");
  for (const e of of(bens)) {
    const text = JSON.stringify(e.payload).toLowerCase();
    for (const word of ["northwind", "weekly update", "ovens", "is wrong"]) assert.ok(!text.includes(word), `${e.type} carries ${word}`);
    assert.equal(e.payload.requester, BEN);
  }
  const heldMine = of(mine).find((/** @type {any} */ e) => e.type === "gate.held");
  assert.deepEqual(heldMine.payload.to, ["#northwind"], "the owner's own item keeps its destination in its event");
});

test("a member who leaves takes their held items with them: they are rejected, and the owner's and another member's are untouched", { timeout: 120_000 }, async t => {
  const { d, as, agentOf, OWNER } = await rig(t);
  const bens = (await agentOf(BEN, "gate.request", ASK)).data.id, cys = (await agentOf(CY, "gate.request", ASK)).data.id, mine = (await as(OWNER, "gate.request", ASK)).data.id;
  d.registry.deps.events.emit("member.removed", { person: BEN });
  const state = (/** @type {string} */ id) => d.registry.deps.db.prepare("SELECT state, error FROM gate_items WHERE id = ?").get(id);
  assert.deepEqual({ ...state(bens) }, { state: "rejected", error: "the member left" });
  assert.equal(state(cys).state, "held"); assert.equal(state(mine).state, "held");
});

test("every Gate path, for each kind of caller: the requester, another member, an admin, the owner, a call with no person, a module, and an item with no requester", { timeout: 180_000 }, async t => {
  const { d, K, OWNER, as, agentOf } = await rig(t);
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  await K.gateway.grants.setRole(dev(OWNER), { person: ADA, role: "admin" }, { presence: proof() });
  const memberItem = async () => (await agentOf(BEN, "gate.request", ASK)).data.id;
  const legacyItem = async () => { const id = (await as(OWNER, "gate.request", ASK)).data.id; d.registry.deps.db.prepare("UPDATE gate_items SET requester = NULL WHERE id = ?").run(id); return id; };
  const noPerson = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "local");
  const asModule = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "module:courier");
  const paths = [["gate.get", (/** @type {string} */ id) => ({ id })], ["gate.revise", (/** @type {string} */ id) => ({ id, edited: { text: "x" } })], ["gate.reject", (/** @type {string} */ id) => ({ id })]];
  // a member's item
  for (const [tool, input] of paths) {
    const id = await memberItem();
    for (const [who, call] of /** @type {[string, (t: string, i: any) => Promise<any>][]} */ ([["owner", (tl, i) => as(OWNER, tl, i)], ["admin", (tl, i) => as(ADA, tl, i)], ["Cy", (tl, i) => as(CY, tl, i)], ["no person", noPerson], ["module", asModule]]))
      assert.equal((await call(/** @type {string} */ (tool), /** @type {Function} */ (input)(id))).error?.code, "not_found", `${who} ${tool} on a member's item`);
    assert.ok(!(await as(BEN, /** @type {string} */ (tool), /** @type {Function} */ (input)(id))).error, `the requester ${tool}`);
  }
  // held, with the count
  const ben1 = await memberItem(), legacy = await legacyItem();
  const ids = async (/** @type {Promise<any>} */ p) => ((await p).data || []).map((/** @type {any} */ i) => i.id).sort();
  assert.deepEqual(await ids(as(BEN, "gate.held")), [ben1]);
  assert.deepEqual(await ids(as(CY, "gate.held")), []);
  assert.deepEqual(await ids(as(OWNER, "gate.held")).then(l => l.includes(ben1)), false);
  assert.ok((await ids(as(OWNER, "gate.held"))).includes(legacy), "the owner lists the older item"); assert.ok((await ids(as(ADA, "gate.held"))).includes(legacy), "an admin lists it");
  assert.ok(!(await ids(as(ADA, "gate.held"))).includes(ben1), "an admin does not list a member's item");
  assert.deepEqual(await ids(noPerson("gate.held", {})), [], "a call with no person lists nothing");
  assert.ok((await ids(asModule("gate.held", {}))).includes(legacy) && !(await ids(asModule("gate.held", {}))).includes(ben1), "a module sees the older item as before, never a member's");
  // an item with no requester: owner and admin handle it; a member and a call with no person do not; a module does as before
  for (const [tool, input] of paths) {
    for (const [who, call, ok] of /** @type {[string, (t: string, i: any) => Promise<any>, boolean][]} */ ([["Ben", (tl, i) => as(BEN, tl, i), false], ["no person", noPerson, false], ["owner", (tl, i) => as(OWNER, tl, i), true], ["admin", (tl, i) => as(ADA, tl, i), true], ["module", asModule, true]])) {
      const id = await legacyItem();
      const r = await call(/** @type {string} */ (tool), /** @type {Function} */ (input)(id));
      if (ok) assert.ok(!r.error, `${who} ${tool} on an older item: ${JSON.stringify(r.error)}`); else assert.equal(r.error?.code, "not_found", `${who} ${tool} on an older item`);
    }
  }
  for (const [who, call] of /** @type {[string, (t: string, i: any) => Promise<any>][]} */ ([["Ben", (tl, i) => as(BEN, tl, i)], ["no person", noPerson]])) assert.equal((await call("gate.approve", { id: legacy })).error?.code, "not_found", `${who} approve on an older item`);
});
