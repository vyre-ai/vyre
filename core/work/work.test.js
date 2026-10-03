// The work module over the REAL gateway and tasks of the kernel (not the fake): the tools it registers, what a caller sees, and that nothing runs without a kernel-built chain.
import test from "node:test";
import assert from "node:assert/strict";
import mod from "./index.js";
import manifest from "./module.json" with { type: "json" };
import { createGateway } from "../../kernel/gateway/index.js";
import { createTasks, TASK_ACTIONS } from "../../kernel/tasks/tasks.js";
import { createPresence } from "../../kernel/tasks/presence.js";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { createEventLog } from "../../kernel/core/events.js";
import { createChainBuilder } from "../../kernel/core/chain.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock, is_person: () => true });
const actor = (kind, id) => ({ kind, id, space: SPACE });
let n = 0;
const G = (a, actions) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: a }, actions, action_set_version: 9, resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, issuer: actor("person", OWNER), source: "test", status: "active", created_at: 0 });
const MATTER = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "stage", kind: "stage", label: "Stage", options: ["intake", "open"] }], stages: [{ name: "intake" }, { name: "open" }] };
const SEND = { action: "email.send", resource_type: "message", risk: "outward.send", label: "send an email", gloss: "Sends an email from the firm." };

async function boot({ wired = true } = {}) {
  const grants = [G(actor("person", OWNER), ["records.*", "records.define", "events.read", "tasks.*", "email.send"])];
  const members = new Set([`person:${OWNER}`, "service:tasks"]);
  const log = createEventLog({ space: SPACE, clock });
  const gw = createGateway({ space: SPACE, store: createMemoryStore({ clock }), log, chains, clock, actions: [SEND, ...TASK_ACTIONS], grants: { forSubject: a => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: () => undefined }, members: { has: a => members.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true });
  const tasks = createTasks({ space: SPACE, authorizer: { authorize: gw.authorize }, log, presence: createPresence({ clock }), chains, clock, members: { has: a => members.has(`${a.kind}:${a.id}`) }, approver: () => actor("person", OWNER) });
  const owner = chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct" });
  await gw.records.define(owner, { add_types: [MATTER] });
  const kernel = { space: SPACE, authorize: gw.authorize, records: gw.records, ask: tasks, events: gw.events, definitions: async () => [MATTER], actions: () => [SEND], chainFor: () => owner };
  const tools = {};
  await mod.start({ tool: (name, def) => { tools[name] = def; }, store: {}, ...(wired ? { kernel } : {}) });
  return { tools, call: (name, input = {}) => tools[name].run(input, { caller: "deck" }) };
}

test("every tool in the manifest is registered, and the other way round", async () => {
  const { tools } = await boot();
  assert.deepEqual(Object.keys(tools).sort(), manifest.does.tools.map(t => t.name).sort());
  for (const t of manifest.does.tools) assert.ok(t.reach, `${t.name} declares its reach`);
});

test("with no kernel wired, every tool answers unavailable and nothing is built", async () => {
  const { tools, call } = await boot({ wired: false });
  for (const name of Object.keys(tools)) await assert.rejects(() => call(name, { project: "vyre://x/y/z", question: "q", query: "q", record: "vyre://x/y/z", text: "t", id: "1", source: "s", proof: {}, tool: "t", role: { name: "r" } }), { code: "unavailable" }, name);
});

test("native.tools lists the Space's own nouns and the outward act; native.call returns a component, never raw JSON", async () => {
  const { call } = await boot();
  const { tools } = await call("native.tools");
  const names = tools.map(t => t.name);
  assert.ok(names.includes("matters.find") && names.includes("matters.move_stage") && names.includes("email.send") && names.includes("tasks.assign"));
  const made = await call("native.call", { tool: "matters.create", input: { data: { title: "Jane Doe", stage: "intake" } } });
  assert.equal(made.result.ok, true);
  assert.ok(made.component && made.component.kind, JSON.stringify(made.component));
  const found = await call("native.call", { tool: "matters.find", input: { where: { title: "Jane Doe" } } });
  assert.equal(found.result.records.length, 1);
});

test("a person's own outward act asks for their presence, never runs, and an unknown tool is not_found", async () => {
  const { call } = await boot();
  const out = await call("native.call", { tool: "email.send", input: { summary: "Welcome email for Jane Doe" } });
  assert.equal(out.result.needs_presence.action, "email.send");
  assert.equal((await call("native.call", { tool: "matters.nope", input: {} })).result.error.code, "not_found");
});
