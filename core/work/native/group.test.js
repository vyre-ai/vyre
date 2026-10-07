// An assistant in a group writes for the whole room (DESIGN-chat): with more than one person in the chat the model SEES a field as a value only when every person in
// the chat may read it, and any other field only as a token it can cite. On the REAL kernel (test/kernel-rig.js): real roles, a real field allow-list on a grant, real
// chats and sessions, and the kernel's own room handle from `audienceFor` (no chains, no size, sealed always a token). Only the model provider is a stand-in.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRig } from "../../../test/kernel-rig.js";
import { tempHome } from "../../../test/helpers.js";
import { open } from "../../store/index.js";
import { buildSituation } from "./situation.js";
import { createMemoryEngine } from "../memory/index.js";
import mod from "../index.js";

const MATTER = { name: "matter", label: "Matter", fields: [
  { name: "title", kind: "text", label: "Title" }, { name: "client", kind: "text", label: "Client" },
  { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Open"] }, { name: "fee", kind: "money", label: "Fee" },
  { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "us-ssn" } }], stages: [{ name: "Intake" }, { name: "Open" }] };
const FEE = { amount: 4321, currency: "USD" };
const MEMORY = { name: "memory", needs: { kernel: { actions: ["records.read", "events.read"] } } };

async function world() {
  const rig = await createRig({ people: { per_bob: "member", per_carol: "manager" }, defs: [MATTER], agents: ["kit"] });
  // bob's role grant carries a field allow-list: the real grants.narrow. The manager (the owner) and carol hold every field.
  await rig.restrict("per_bob", { fields: ["title", "client", "stage"] });
  rig.script(() => ({ content: "The matter is Doe estate plan [S1]." }));
  const manager = rig.ownerChain, member = rig.person("per_bob");
  const m = await rig.create("matter", { title: "Doe estate plan", client: "Jane Doe", stage: "Intake", fee: FEE, ssn: { sealed: "us-ssn", ref: "seal_1", present: true, valid_format: true, set_at: 1 } });
  const mem = rig.k.kernelFor(MEMORY);
  await mem.records.query(mem.serviceChain(), "matter", { page: { limit: 1 } }).catch(() => {});
  return { rig, manager, member, m, mem };
}
const at = m => ({ type: "matter", id: m.id });

test("one to one with the manager the model gets the manager-only value; with a member in the chat it gets a token", async () => {
  const { rig, manager, member, m } = await world();
  // The kernel's own rule: the member's read omits the field.
  assert.equal("fee" in (await rig.kernel.records.get(member, "matter", m.id)).data, false);
  const solo = await buildSituation(rig.kernel, manager, { space: rig.space, project: at(m), room: await rig.room("per_alex") });
  assert.match(solo.text, /fee: 4321 USD/);
  assert.equal(solo.parts.group, false);
  const room = await buildSituation(rig.kernel, manager, { space: rig.space, project: at(m), room: await rig.room("per_alex", ["per_bob"]) });
  assert.doesNotMatch(room.text, /4321/);
  assert.match(room.text, new RegExp(`fee: restricted here, cite it as \\{\\{field:${m.urn.replace(/[/.]/g, "\\$&")}#fee\\}\\}`));
  assert.match(room.text, /client: Jane Doe/);
  assert.match(room.text, /stage: Intake/);
  assert.ok(room.parts.restricted.includes("fee"));
  assert.doesNotMatch(room.text, /seal_1/);
  assert.match(room.text, /ssn: restricted here/, "a sealed field is a token in a room, always");
});

test("two managers in the chat still see the value, and a chat of one person is a one to one", async () => {
  const { rig, manager, m } = await world();
  const two = await buildSituation(rig.kernel, manager, { space: rig.space, project: at(m), room: await rig.room("per_alex", ["per_carol"]) });
  assert.match(two.text, /fee: 4321 USD/, "two managers may both read it");
  assert.equal(two.parts.group, true);
  const one = await buildSituation(rig.kernel, manager, { space: rig.space, project: at(m), room: await rig.room("per_alex") });
  assert.equal(one.parts.group, false);
});

test("a record someone in the chat cannot read at all is not shown, not even its name", async () => {
  const { rig, manager, m } = await world();
  await rig.restrict("per_bob", { prefix: `vyre://${rig.space}/other/*` });
  const room = await buildSituation(rig.kernel, manager, { space: rig.space, project: at(m), room: await rig.room("per_alex", ["per_bob"]) });
  assert.doesNotMatch(room.text, /Doe estate plan|Jane Doe|Intake/);
  assert.match(room.text, /not everyone in this chat may read/);
});

test("memory answers and recalled notes follow the same rule: no manager-only value reaches the model while a member is in the chat", async t => {
  const { rig, manager, m, mem } = await world();
  const db = open(path.join(tempHome(t), "engine.db"));
  const engine = createMemoryEngine({ kernel: rig.kernel, db, space: rig.space, serviceChain: mem.serviceChain(), chainFor: () => rig.withService(rig.ownerChain, "memory") });
  await engine.index({ kind: "record", type: "matter", id: m.id });
  const solo = await engine.answer(manager, "Doe estate plan");
  assert.match(JSON.stringify(rig.modelCalls), /4321/, "alone with the manager the value is in what the model reads");
  rig.modelCalls.length = 0;
  const room = await engine.answer(manager, "Doe estate plan", { room: await rig.room("per_alex", ["per_bob"]) });
  const sent = JSON.stringify(rig.modelCalls);
  assert.doesNotMatch(sent, /4321/);
  assert.match(sent, /\{\{field:[^}]*#fee\}\}/);
  assert.ok(solo.citations.length && room.citations.length);
  const hits = await engine.search(manager, "Doe", 6, { room: await rig.room("per_alex", ["per_bob"]) });
  assert.doesNotMatch(JSON.stringify(hits), /4321/);
});

test("a source the member may not read is withheld from a group answer, never guessed at, and the model is told that more exists", async t => {
  const { rig, manager, m, mem } = await world();
  const m2 = await rig.create("matter", { title: "Doe trust, privileged", client: "Jane Doe", stage: "Open", fee: FEE });
  // bob may read the first matter only: his role grants cut to that record.
  await rig.restrict("per_bob", { prefix: m.urn });
  const db = open(path.join(tempHome(t), "engine2.db"));
  const engine = createMemoryEngine({ kernel: rig.kernel, db, space: rig.space, serviceChain: mem.serviceChain(), chainFor: () => rig.withService(rig.ownerChain, "memory") });
  await engine.index({ kind: "record", type: "matter", id: m.id });
  await engine.index({ kind: "record", type: "matter", id: m2.id });
  const room = await rig.room("per_alex", ["per_bob"]);
  const hits = await engine.search(manager, "Doe", 6, { room });
  assert.equal(hits.withheld, 1);
  assert.ok(hits.every(h => h.source !== m2.urn));
  const a = await engine.answer(manager, "Doe", { room: await rig.room("per_alex", ["per_bob"]) });
  const sent = JSON.stringify(rig.modelCalls.at(-1));
  assert.doesNotMatch(sent, /privileged/);
  assert.match(sent, /more source\(s\) exist that not everyone in this chat may read/);
  assert.equal(a.withheld, 1);
  assert.equal((await engine.search(manager, "Doe", 6)).withheld, 0, "alone with the manager nothing is withheld");
});

// ---- the switch-on: the room comes from the running session, never from the tool's input ----
async function booted(shape) {
  const w = await world();
  const tools = {};
  const room = shape ? await shape(w) : undefined;
  const kernel = { ...w.rig.kernel, chainFor: () => w.manager, ...(shape ? { audienceFor: async () => room } : {}) };
  await mod.start({ tool: (n, d) => { tools[n] = d; }, store: {}, kernel });
  return { ...w, call: (n, i = {}) => tools[n].run(i, { caller: "deck" }), tools };
}

test("work.situation in a group chat narrows to the audience, and a `chat` argument changes nothing", async () => {
  const w = await booted(x => x.rig.room("per_alex", ["per_bob"]));
  for (const input of [{ project: w.m.urn }, { project: w.m.urn, chat: "some-other-chat" }, { project: w.m.urn, chat: "" }]) {
    const s = await w.call("work.situation", input);
    assert.doesNotMatch(s.text, /4321/);
    assert.match(s.text, /restricted here/);
  }
  assert.ok(!("chat" in w.tools["work.situation"].input.properties), "the model is given nothing to leave out");
});

test("a one to one room, from the session, gets the full view", async () => {
  const w = await booted(x => x.rig.room("per_alex"));
  assert.match((await w.call("work.situation", { project: w.m.urn })).text, /fee: 4321 USD/);
});

test("the room is unknown or malformed: refused, never the one to one view", async () => {
  const noop = async () => null;
  for (const shape of [undefined, () => undefined, () => ({}), () => ({ group: true }), () => ({ group: true, read: noop })]) {
    const w = await booted(shape);
    await assert.rejects(() => w.call("work.situation", { project: w.m.urn }), { code: "unavailable" });
    await assert.rejects(() => w.call("work.know.search", { query: "Doe" }), { code: "unavailable" });
    await assert.rejects(() => w.call("work.know.answer", { question: "Doe" }), { code: "unavailable" });
  }
});

test("a prompt-injected call that names a room, an audience or a chat cannot widen what the model sees", async () => {
  const w = await booted(x => x.rig.room("per_alex", ["per_bob"]));
  const s = await w.call("work.situation", { project: w.m.urn, chat: "dm-with-manager", audience: [], room: { group: false }, group: false });
  assert.doesNotMatch(s.text, /4321/);
});

test("in a room an event source is withheld (its text carries values), alone it is used", async t => {
  const { rig, manager, m, mem } = await world();
  const db = open(path.join(tempHome(t), "engine4.db"));
  const engine = createMemoryEngine({ kernel: rig.kernel, db, space: rig.space, serviceChain: mem.serviceChain(), chainFor: () => rig.withService(rig.ownerChain, "memory") });
  db.prepare("INSERT INTO memory_engine_index (source, kind, resource, text, vec, trust, red, spaces) VALUES (?, 'event', ?, ?, NULL, 'member', 'internal', ?)").run("event:e1", m.urn, "matter.updated fee 4321 Doe", JSON.stringify([rig.space]));
  const room = await engine.search(manager, "Doe fee", 6, { room: await rig.room("per_alex", ["per_bob"]) });
  assert.ok(room.every(h => !/4321/.test(h.snippet)));
  assert.equal(room.withheld >= 1, true);
  assert.ok((await engine.search(manager, "Doe fee", 6)).some(h => /4321/.test(h.snippet)), "alone, the event is used");
});
