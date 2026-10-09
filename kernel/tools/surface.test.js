import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createToolSurface, noun } from "./surface.js";
import { createGateway } from "../gateway/index.js";
import { createTasks, TASK_ACTIONS } from "../tasks/tasks.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock, is_person: () => true });
const actor = (kind, id) => ({ kind, id, space: SPACE });
const person = who => chains.fromFacts({ kind: "device", device_key_id: `d-${who}`, person: who, path: "direct" });
const agent = name => chains.fromFacts({ kind: "agent_session", agent: name, session: "s", thread: "t", vouched: true });
let n = 0;
const G = (a, actions, prefix = `vyre://${SPACE}/*/*`) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: a }, actions, action_set_version: 9, resource: { prefix }, conditions: {}, issuer: actor("person", OWNER), source: "test", status: "active", created_at: 0 });

const MATTER = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "stage", kind: "stage", label: "Stage", options: ["intake", "open"] }, { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "ssn" } }], stages: [{ name: "intake" }, { name: "open" }] };
const SEND = { action: "email.send", resource_type: "message", risk: "outward.send", label: "send an email", gloss: "Sends an email from the firm." };

async function rig({ grants = [], defs = [MATTER] } = {}) {
  const all = [G(actor("person", OWNER), ["records.*", "records.define", "events.read", "tasks.*", "email.send"]), ...grants];
  const members = new Set([`person:${OWNER}`, "agent:intake", "agent:rogue", "service:tasks"]);
  const log = createEventLog({ space: SPACE, clock });
  const actions = [...TASK_ACTIONS, SEND];
  const store = createMemoryStore({ clock });
  const gw = createGateway({ space: SPACE, store, log, chains, clock, actions: [SEND, ...TASK_ACTIONS], grants: { forSubject: a => all.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: () => undefined }, members: { has: a => members.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true, verifyPresence: () => true });
  const tasks = createTasks({ space: SPACE, authorizer: { authorize: gw.authorize }, log, presence: { check: async () => "no_proof" }, chains, clock, members: { has: a => members.has(`${a.kind}:${a.id}`) }, approver: () => actor("person", OWNER) });
  const kernel = { authorize: gw.authorize, records: gw.records, ask: tasks };
  const current = [...defs];
  await gw.records.define(person(OWNER), { add_types: defs });
  const surface = createToolSurface({ kernel, space: SPACE, types: () => current, actions: () => actions });
  return { surface, kernel, current, gw };
}

test("tools are generated from the definitions: a bakery sees orders.*, an estate firm matters.*", async () => {
  const r = await rig();
  const names = (await r.surface.list(person(OWNER))).map(t => t.name);
  assert.deepEqual(names.filter(x => x.startsWith("matters.")), ["matters.create", "matters.find", "matters.move_stage", "matters.update"]);
  assert.ok(names.includes("tasks.assign") && names.includes("email.send"));
  const bakery = await rig({ defs: [{ name: "order", label: "Order", fields: [{ name: "item", kind: "text", label: "Item" }] }] });
  const b = (await bakery.surface.list(person(OWNER))).map(t => t.name);
  assert.ok(b.includes("orders.find") && !b.some(x => x.startsWith("matters.")));
  assert.equal(noun("case-file"), "case_files");
});

test("adding a type changes the list on the next turn", async () => {
  const r = await rig();
  r.current.push({ name: "invoice", label: "Invoice", fields: [{ name: "n", kind: "text", label: "N" }] });
  await r.gw.records.define(person(OWNER), { add_types: [r.current.at(-1)] });
  assert.ok((await r.surface.list(person(OWNER))).some(t => t.name === "invoices.find"));
});

test("the list is cut by the chain's grants: a reader never sees a write tool, and an unlisted call looks like it does not exist", async () => {
  const r = await rig({ grants: [G(actor("agent", "intake"), ["records.read"])] });
  const c = agent("intake");
  const asAgent = await r.surface.list(c);
  const names = asAgent.map(t => t.name);
  assert.deepEqual(names.filter(x => x.startsWith("matters.")), ["matters.find"]);
  assert.ok(!names.includes("tasks.assign") && !names.includes("email.send"));
  assert.deepEqual(await r.surface.call(c, "matters.update", { id: "x", patch: {} }), { error: { code: "not_found", message: "no such tool" } });
  assert.deepEqual(await r.surface.call(agent("rogue"), "matters.find", {}), { error: { code: "not_found", message: "no such tool" } }, "no grant at all");
});

test("a find returns records and a sealed field is only a reference, never a value; the schema never names a sealed field", async () => {
  const r = await rig();
  const o = person(OWNER);
  const made = await r.surface.call(o, "matters.create", { data: { title: "Jane Doe", stage: "intake" } });
  assert.equal(made.ok, true);
  const found = await r.surface.call(o, "matters.find", { where: { title: "Jane Doe" } });
  assert.equal(found.records.length, 1);
  const spec = (await r.surface.list(o)).find(t => t.name === "matters.update");
  assert.ok(!JSON.stringify(spec).includes("ssn"));
  const moved = await r.surface.call(o, "matters.move_stage", { id: made.record.id, stage: "open" });
  assert.equal(moved.record.data.stage, "open");
});

test("an outward act is held, not an error: a task with the approver as checker, and nothing sent", async () => {
  const r = await rig({ grants: [G(actor("agent", "intake"), ["records.read", "tasks.*", "email.send"])] });
  const c = chains.fromFacts({ kind: "agent_session", agent: "intake", session: "s", thread: "t", vouched: true });
  const out = await r.surface.call(c, "email.send", { summary: "Welcome email for Jane Doe" });
  assert.ok(out.held, JSON.stringify(out));
  assert.match(out.held.task, /./);
  assert.equal(out.held.approver.length > 0, true);
  assert.match(out.held.summary, /Welcome email for Jane Doe/);
});

test("a bad call is a structured error, never a throw", async () => {
  const r = await rig();
  const out = await r.surface.call(person(OWNER), "matters.update", { id: "00000000-0000-4000-8000-000000000000", patch: { title: "x" } });
  assert.equal(out.error.code, "not_found");
  await assert.rejects(() => r.surface.list({}), { code: "bad_input" });
});

test("a person's own outward act needs their presence, not a task they would check themselves", async () => {
  const r = await rig();
  const out = await r.surface.call(person(OWNER), "email.send", { summary: "x" });
  assert.equal(out.needs_presence.action, "email.send");
  assert.equal(out.held, undefined);
});

test("T-1 and T-2: a duplicate tool name is dropped, and the schema names only the fields the chain's grant allows", async () => {
  const dup = { ...SEND, action: "matters.update", resource_type: "message" };
  const r = await rig({ grants: [G(actor("agent", "intake"), ["records.read"], `vyre://${SPACE}/matter/*`)] });
  const surf = createToolSurface({ kernel: r.kernel, space: SPACE, types: () => r.current, actions: () => [SEND, dup] });
  const names = (await surf.list(person(OWNER))).map(t => t.name);
  assert.equal(names.filter(n => n === "matters.update").length, 1, "the outward action does not shadow the record tool");
  assert.equal((await surf.list(person(OWNER))).find(t => t.name === "matters.update").risk, "write");
  // a field allow-list hides names too
  const limited = G(actor("agent", "intake"), ["records.read"], `vyre://${SPACE}/matter/*`);
  limited.resource = { prefix: `vyre://${SPACE}/matter/*`, fields: ["title"] };
  const r2 = await rig({ grants: [limited] });
  const find = (await r2.surface.list(agent("intake"))).find(t => t.name === "matters.find");
  assert.match(find.schema.properties.where.description, /Fields: title\./);
  assert.ok(!/stage/.test(find.schema.properties.where.description));
});

test("a find says when there is more and how to get it, says when a limit was cut, and takes a sort for the first few", async () => {
  const r = await rig();
  const p = person(OWNER);
  for (const title of ["delta", "alpha", "charlie", "bravo"]) await r.kernel.records.create(p, "matter", { title });
  const two = await r.surface.call(p, "matters.find", { limit: 2 });
  assert.equal(two.records.length, 2);
  assert.equal(two.more, true);
  assert.equal(typeof two.next_cursor, "string");
  const rest = await r.surface.call(p, "matters.find", { limit: 2, cursor: two.next_cursor });
  assert.equal(rest.records.length, 2);
  assert.equal(rest.more, undefined);
  const first = await r.surface.call(p, "matters.find", { limit: 1, sort: [{ field: "title", dir: "asc" }] });
  assert.equal(first.records[0].data.title, "alpha");
  assert.equal((await r.surface.call(p, "matters.find", { limit: 500 })).capped_at, 50);
});

test("the task type's create tool points a to-do at planner_add, so a short catalog does not send a model to it", async () => {
  const r = await rig({ defs: [{ name: "task", label: "Task", fields: [{ name: "title", kind: "text", label: "Title" }] }, MATTER] });
  const tools = await r.surface.list(person(OWNER));
  assert.match(tools.find(t => t.name === "tasks.create").description, /planner_add/);
  assert.match(tools.find(t => t.name === "matters.create").description, /^Add a Matter\.$/);
});
